---
title: kvm_enter_guest学习笔记
categories:
  - KVM
tags:
  - KVM
---
kvm_enter_guest是一个很长的函数。还是一个有大量分发的函数。所以可以把该函数分为4阶段来进行分析：
1. 进入Guest前的最后准备
2. 进入Guest内部和退出循环
3. 退出Guest后的善后处理
4. 分发退出事件。

而各个阶段之间的临界点就是如下代码块：

```C++
for (;;) {
	// ...
	exit_fastpath = kvm_x86_call(vcpu_run)(vcpu,
						   req_immediate_exit);
	if (likely(exit_fastpath != EXIT_FASTPATH_REENTER_GUEST))
		break;
	// ...
    }
```
在这个代码段之前的工作都算是1阶段——即最后准备工作。
## 准备阶段（VM-Entry之前）
此阶段代码调用大量的如下的模式：
```C++
// 检查待办事项 "KVM_REQ_XXX"
if (kvm_check_request(KVM_REQ_XXX, vcpu))
    do_something(); // 执行这个待办事项
```
在这里就像依次check To-do list，进行事无巨细的检查。
其中较为关键的待办事项如下：
1. TLB缓存刷新确认
```C++
        if (kvm_check_request(KVM_REQ_TLB_FLUSH, vcpu))
            kvm_vcpu_flush_tlb_all(vcpu);
```
其他 CPU 上的 KVM 模块修改了页表，请求这个 vCPU **刷新它的 TLB** (地址翻译缓存)。这是保证 MMU 一致性的关键

2. NMI注入检查
```C++
if (kvm_check_request(KVM_REQ_NMI, vcpu))
            process_nmi(vcpu);
```
有“不可屏蔽中断”(NMI) 需要在 vCPU 恢复运行时**立即注入**。[[Linux中断处理#NMI]]

3. 三重错误检查
```C++
if (kvm_check_request(KVM_REQ_TRIPLE_FAULT, vcpu)) {
	vcpu->run->exit_reason = KVM_EXIT_SHUTDOWN;
	vcpu->mmio_needed = 0;
	r = 0;
	goto out;
}
```
vCPU发生了无法恢复的致命错误“三重错误”后，终止循环返回给QEMU，告诉QEMU“这台虚拟机挂了”。
## 最后准备
当上述的待办事项处理完后,就到了准备进入Guest模式的最后准备工作。这里每一步都很重要：
1. `kvm_mmu_reload(vcpu)`: **加载 Guest 的页表** (即 `CR3` 寄存器)。
2. `preempt_disable()`: **关闭宿主机内核抢占**。
3. `local_irq_disable()`: **关闭宿主机物理中断**。
4. `smp_store_release(&vcpu->mode, IN_GUEST_MODE)`: **“宣布进入”**。
    - **这是整段代码中最关键的锁之一！** 它是一个内存屏障，用来告诉**所有其他物理 CPU**：“这个 vCPU 线程现在正式进入 Guest 模式了。你们如果想修改 KVM 状态，必须等它出来。”
5. `kvm_vcpu_srcu_read_unlock(vcpu)`: **释放 SRCU 锁**。
6. `sync_pir_to_irr` / `switch_fpu_return` / `set_debugreg`: **加载最后的硬件状态**，如 APICv 中断状态、FPU 状态、调试寄存器等。

## 进入运行Guest
代码块
```C++
for (;;) {
	
	exit_fastpath = kvm_x86_call(vcpu_run)(vcpu,
						   req_immediate_exit);	
	++vcpu->stat.exits;
}
```
这就是关键关键的进入vCPU_run以及退出的内容了。
这里的vcpu_run调用的其实是`vmx.c`的`vmx_vcpu_run`函数。这个函数的行为如下：
1. 安全检查
	```C++
if (unlikely(vmx->emulation_required)) {
	vmx->fail = 0;

	vmx->exit_reason.full = EXIT_REASON_INVALID_STATE;
	vmx->exit_reason.failed_vmentry = 1;
	kvm_register_mark_available(vcpu, VCPU_EXREG_EXIT_INFO_1);
	vmx->exit_qualification = ENTRY_FAIL_DEFAULT;
	kvm_register_mark_available(vcpu, VCPU_EXREG_EXIT_INFO_2);
	vmx->exit_intr_info = 0;
	return EXIT_FASTPATH_NONE;

    }
	```
	这里是在检查是否vCPU处于`emulation_required`（无效状态），若是则会填入无效状态的VM-Exit（伪装的），然后返回值告知vcpu_enter_cpu转入vmx_handle_exit来进行处理。
2. 同步Guest状态
```C++
if (kvm_register_is_dirty(vcpu, VCPU_REGS_RSP))
        vmcs_writel(GUEST_RSP, vcpu->arch.regs[VCPU_REGS_RSP]);
    if (kvm_register_is_dirty(vcpu, VCPU_REGS_RIP))
        vmcs_writel(GUEST_RIP, vcpu->arch.regs[VCPU_REGS_RIP]);
```
用了脏位标志，很明显这个就是一种惰性同步。最后一刻将register的信息写入到VMCS上[[VMCS#Guest-State Area]]

3. 同步Host状态
```C++
    if (kvm_register_is_dirty(vcpu, VCPU_REGS_RSP))
        vmcs_writel(GUEST_RSP, vcpu->arch.regs[VCPU_REGS_RSP]);
    if (kvm_register_is_dirty(vcpu, VCPU_REGS_RIP))
        vmcs_writel(GUEST_RIP, vcpu->arch.regs[VCPU_REGS_RIP]);
    vcpu->arch.regs_dirty = 0;
```
必须要在VMENTRY之前更新**HOST**的`CR3`。因为KVM（HOST内核）自己也可能被调度！

否则可能发生反例：
例如：
- 当vcpu_enter_guest做准备时，KMV线程呗宿主机调度器卡攻占了，切换到了另一个进程，另一进程有自己的CR3。
- - 那么一旦切换回KVM后。他可能在一个与之前不同的CR3上下文中运行（x86下的PCID变化）。
- 如果KVM没有重新读取当前的`CR3`并更新`HOST_CR3`字段，那么当VM-Exit发生时，PCU硬件会自动加载一个错误的`HOST_CR3`.

4. 接下来开始正式调用
```C++
/* The actual VMENTER/EXIT is in the .noinstr.text section. */

    vmx_vcpu_enter_exit(vcpu, __vmx_vcpu_run_flags(vmx));
```
来进入VMENTER。
vmx_vcpu_enter_exit` 是一个**内联汇编**（`asm volatile`）函数。
[[vmx_vcpu_enter_exit]]
它会查看 `__vmx_vcpu_run_flags` 的值（这个值是根据 `vmx->loaded_vmcs->launched` 标志位计算的）。
- **第一次运行**：`launched = 0`，汇编执行 **`VMLAUNCH`**。
- **后续运行**：`launched = 1`，汇编执行 **`VMRESUME`**。
# VMEXIT后的处理
1. 恢复Host状态
```C++
    if (vcpu->arch.host_debugctl)
        update_debugctlmsr(vcpu->arch.host_debugctl);
```
退出了Guest后第一时间恢复Host状态。
2. 如果VMENTRY失败进行处理，否则设置相关标志位：
```C++
	if (unlikely(vmx->exit_reason.failed_vmentry))
		return EXIT_FASTPATH_NONE;
	
	vmx->loaded_vmcs->launched = 1;
```
launched标志位设置完成后，下一次KVM 再调用 `vmx_vcpu_run` 时，`__vmx_vcpu_run_flags` 就会告诉汇编代码去执行 `VMRESUME` 而不是 `VMLAUNCH`。
3. Fastpath处理
```C++
	vmx_recover_nmi_blocking(vmx);
	vmx_complete_interrupts(vmx);
	
	return vmx_exit_handlers_fastpath(vcpu, force_immediate_exit);
```
在返回给`vmx_handle_exit`前，KVM会做最后一次检查来尝试：是否可以提前不退出KVM就**处理VM-Exit**。
`vmx_exit_handlers_fastpath`是一个小型的switch，里面嵌套了更多层的快速处理路径
- 对于嵌套虚拟化，除了处理某些VMX preemption timer退出可以处理，其余都是慢速路径   
- Guest试图写入一个MSR，调用嵌套的快速处理函数
- Guest OS（vCPU）执行了HLT指令，意味着Guest OS空闲了，此时会嵌套调用`handle_fastpath_hlt(vcpu)`，最后将vCPU的状态设置为`KVM_MP_STATE_HALTED`。
	- 这个函数并不会返回`EXIT_FASTPATH_EXIT_USERSPACE`（退回到了QEMU）而是通知vcpu_run决定执行后，根据vCPU状态时HALTED而执行block操作，此时才是vCPU真正睡眠。
