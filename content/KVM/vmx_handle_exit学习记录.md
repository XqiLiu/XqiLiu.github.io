---
title: vmx_handle_exit学习记录
tags:
  - VM-Exit
categories:
  - KVM
date: 2025-09-29T00:00:00
---
`vmx_handle_exit`的内部逻辑是`__vmx_handle_exit`。他是相当于一个总分发室。负责处理`vmx->exit_reason`

# 进行PML缓冲区刷新
``` C++
	if (enable_pml && !is_guest_mode(vcpu))
		vmx_flush_pml_buffer(vcpu);
```
- `PML`是Intel EPT里的一个硬件功能，它能自动记录Guest到底写了那些内存页
- CPU会把这些脏页记录缓冲在自己内部，如果刚从Guest中退出，缓冲区里可能还有没同步到内存的数据。
- 这个操作会让QEMU用户空间调用KVM_GET_DIRTY_LOG时，能够立即拿到新的脏页信息。
# 嵌套虚拟化处理
```C++
if (is_guest_mode(vcpu))
```
这一部分是检查是不是从L2 Guest中退出的（Guest运行的VM）
如果是真，那么KVM处理的就是L2->L1的退出。
解析来的处理主要是3件事：
1. 强制标记VMCS脏页
	```C++
	nested_mark_vmcs12_pages_dirty(vcpu);
	```
	- 原因：L1会给KVM(L0)一些内存也的物理地址(例如虚拟APIC页，vmcs12)。CPU在运行L2时，可能会直接写入这些页.
	- 问题：这种硬件加速的写入会绕过KVM(L0)用来跟踪脏页的EPT写保护[[EPT]]
	- 方法：KVM(L0)只能通过L2退出时，强制地将全部的~~内存页~~元数据页标记为dirty，确保L1在获取L2的脏页信息不会出错。
2. 当L2状态无效时，插入一个三重错误
	```C++
	if (vmx->emulation_required) {
		nested_vmx_vmexit(vcpu, EXIT_REASON_TRIPLE_FAULT, 0, 0);
		return 1;
	}
	```
	 - `emulation_required`标志位会告诉KVM（L0），L2 Guest现在的状态是无效的
	 - KVM(L0)无法运行L2.真实的CPU遇到无法恢复的错误时，会触发三重错误然后重启。KVM(L0)会模拟三重错误。
	 - L1会看到（虽然是L0的缘故）L2的虚拟机发生了三重错误，于是处理（重启）
	 - `return 1`时返回给vcpu_run，意思是vcpu_run继续循环执行，不用退回到QEMU。
3. 反射VM-Exit
	```C++
	if (nested_vmx_reflect_vmexit(vcpu))
		return 1;
	```
	- L2 Guest执行了`CPUID`指令
	- KVM（L0）捕获了这个VM-Exit。
	- KVM（L0）必须决定：这个`CPUID`退出，L1（Guest hypervisor）需不需要知道这个消息。
	- `nested_vmx_reflect_vmexit(vcpu)`会又条件的将这个VM-Exit反射给L1，并在为真时返回`true`，并告诉vcpu_run当前的错误已在内核处理，继续循环。
	- 结果：L1以为是L2 Guest触发了`CPUID`退出，然后L1就去模拟`CPUID`并恢复L2运行。
	- 值得注意的是， L1和L2都不会意识到L0做了处理。[[VMCS#嵌套虚拟化下的VMCS]]
# 错误情况处理
在这里，返回值有两种情况：
`return 0;`的含义就是慢速路径：KVM内核无法处理，或者严重错误，必须交由用户空间QEMU去处理。
`return 1;`的含义就是快速路径：KVM内核自己处理完成，不需要返回QEMU。直接vcpu_run的通用循环快速继续。
1. 首先处理L1但硬件无法执行的情况，那么就采用软件模拟的方法来进行。
	```C++
	if (vmx->emulation_required)
        return handle_invalid_guest_state(vcpu);
	```

2. 慢速路径中最糟糕的例子：VMENTRY失败。
	```C++
	if (exit_reason.failed_vmentry) {
        dump_vmcs(vcpu);
        vcpu->run->exit_reason = KVM_EXIT_FAIL_ENTRY;
        vcpu->run->fail_entry.hardware_entry_failure_reason
            = exit_reason.full;
        vcpu->run->fail_entry.cpu = vcpu->arch.last_vmentry_cpu;
	return 0;
    }
	```
	KVM在执行VMLAUNCCH，但是CPU硬件在LAUNCH前对KVM填写的VMCS罪行了最后一次预检发现了致命的配置错误后，触发该错误处理。
	- `dump_vmcs(vcpu)`这是用于将VMCS全部内容打印到内核日志
	- `vcpu->run->exit_reason = KVM_EXIT_FAIL_ENTRY`这个数据结构复杂告知QEMU启动失败。
	- `vcpu->run->fail_entry.hardware_entry_failure_reason = exit_reason.full;`：把 CPU 硬件报告的“失败原因码”原封不动地发给 QEMU
	- 慢速路径返回
3. CPU执行VMLAUNCH时发生了失败
	```C++
	if (unlikely(vmx->fail)) {
	// ...
		vcpu->run->fail_entry.hardware_entry_failure_reason
		= vmcs_read32(VM_INSTRUCTION_ERROR);
	return 0;
	}
	```
	**注意区别！** 这种失败的原因，CPU **不会**写在 `VM_EXIT_REASON` 里，而是写在一个**专门的**“指令错误”字段（`VM_INSTRUCTION_ERROR`）。KVM 从这个字段读取原因码，发给 QEMU。
4.接下来的代码描述了一种特殊情况的处理 
	`vectoring_info`是VMCS中的一个字段，如果`VALID_MASK` 位是 `1`，就意味着这次VM-Exit发生时，CPU正在尝试向Guest交付一个事件。
	接下来代码开始交代一系列处理的“白名单”，即KVM自己能处理的事件的名单进行排查。当白名单中没有当前的错误处理 。KVM将所有相关的报错调试信息进行打包返回。
	其实这个处理本质上是一个KVM开发者发现的无限循环的**致命陷阱**：
	这个无限循环本质上是由于`vectoring_info`是一个VMCS中VM-Exit信息区的一个字段。这个区域是硬件写入的，KVM只能读取。从而如果在KVM内部处理后，不能改变这个标志位，从而进入死循环，但更本质的讲：
	**KVM 可以模拟_架构_（Architecture）状态，但不能模拟_微架构_（Micro-architecture）状态。**
	**架构状态（KVM 可控）**：`RAX` 寄存器、`CR3` 寄存器、`RIP` 指针、内存中的值。KVM 可以随意读写它们（通过 `vcpu->arch.regs` 或模拟指令），因为它们是被**x86 架构明确定义**的。
	**微架构状态（KVM 不可控）**：CPU 内部的“中断交付管线”处于什么阶段、分支预测器里有什么数据、`L1` 缓存里有什么。这些是**CPU 厂商的内部实现**，没有暴露给 KVM 的清除接口。
	