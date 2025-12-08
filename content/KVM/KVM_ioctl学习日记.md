---
title: KVM_ioctl学习日记
categories: KVM
date: 2025-10-05T16:42:00
tags:
  - KVM
  - Linux
---
如其他的ioctl一样，用户态程序调用：`ioctl`->`sys_ioctl`(系统调用层)->`vfs_ioctl()`（VFS层）->`kvm_dev_ioctl()`
## create_vm

接下来对`kvm_dev_ioctl()`的注册的行为进行分析：
1. `kvm_dev_ioctl_create_vm(unsigned long type)`
```C++
fd = get_unused_fd_flags(O_CLOEXEC);
    if (fd < 0)
        return fd;
```
获取一个没有用过的fd。
2. 接下来fd name传递给`kvm_create_vm`
```C++
struct kvm *kvm = kvm_arch_alloc_vm();
```
这个用于创建一个KVM对象并分配相应内存。这个KVM结构体包含了所有的虚拟机状态，例如vCPU、内存、设备。同时作为句柄，后续的所有操作基于这个kvm对象
3. `KVM_MMU_LOCK_INIT(kvm)`用于初始化内存管理单元(MMU)的锁。
	1. 虚拟机需要管理客户机的物理地址到宿主机的物理地址的映射(GPA->HPA)
	2. 多个vCPU可能访问同一个页表，需要锁保护
4. 增加当前用户进程下的进程内存管理结构体计数（保证引用计数不为0），并同样的赋值给结构体kvm。
```C++
    mmgrab(current->mm);
    kvm->mm = current->mm;
   ```
5. `kvm_eventfd_init(kvm)`
用于虚拟机写入特定I/O端口时通知用户态或是用户态写入`eventfd`时向虚拟机注入中断。
6. 接下里初始化各种同步锁
```C++
    mutex_init(&kvm->lock);
    mutex_init(&kvm->irq_lock);
    mutex_init(&kvm->slots_lock);
    mutex_init(&kvm->slots_arch_lock);
    spin_lock_init(&kvm->mn_invalidate_lock);
```
因为可能：
- 多个 vCPU 并发运行
- 用户态可能并发调用 ioctl
- 内核 MMU notifier 回调可能异步触发

7. 可睡眠的RCU同步机制初始化[[SRCU]]
```C++
	if (init_srcu_struct(&kvm->srcu))
	    goto out_err_no_srcu;
    if (init_srcu_struct(&kvm->irq_srcu))
        goto out_err_no_irq_srcu;
 ```
 RCU是读者无锁，写者复制，通过等待一个宽限期来确保旧数据可以被安全地释放。


8. `r = kvm_init_irq_routing(kvm)`中断路由的初始化，可以开新的一篇来笔记记录
9. 内存双插槽系统的初始化
```C++
    for (i = 0; i < kvm_arch_nr_memslot_as_ids(kvm); i++) {
        for (j = 0; j < 2; j++) {
            slots = &kvm->__memslots[i][j];
            atomic_long_set(&slots->last_used_slot, (unsigned long)NULL);

            slots->hva_tree = RB_ROOT_CACHED;
            slots->gfn_tree = RB_ROOT;
            hash_init(slots->id_hash);
            slots->node_idx = j;
            /* Generations must be different for each address space. */
            slots->generation = i;
        }
        rcu_assign_pointer(kvm->memslots[i], &kvm->__memslots[i][0]);
    }
```
KVM 中有两种截然不同的内存操作路径：
1. **快速路径 (Fast Path)**：vCPU 运行时发生缺页异常（page fault），KVM 需要**极快地**查询内存插槽，将客户机物理地址（GPA）转换为主机虚拟地址（HVA）。这个操作每秒可能发生成千上万次，**性能是第一要求**。
2. **慢速路径 (Slow Path)**：管理员通过 QEMU management 接口**动态地修改虚拟机的内存布局**，比如内存热插拔（hotplug/unplug）。这个操作不频繁，但**过程比较复杂**，需要修改多个数据结构
内存插槽存储的是元数据页表。通过一槽执行快速路径的读，同时拷贝另一个槽进行写修改。最后`rcu_assign_pointer()`(rcu机制的安全指针赋值)切换`kvm->memslots`到另一插槽，这一过程是原子的、快速的。从而完成无缝修改



AI总结:
```
┌─────────────────────────────────────────────────────────┐
│              用户态 (QEMU/libvirt)                       │
├─────────────────────────────────────────────────────────┤
│  kvm_fd = open("/dev/kvm", O_RDWR)                     │
│  vm_fd = ioctl(kvm_fd, KVM_CREATE_VM, 0)               │
│  vcpu_fd = ioctl(vm_fd, KVM_CREATE_VCPU, 0)            │
│  ioctl(vcpu_fd, KVM_RUN, 0)                            │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│                    内核 VFS 层                           │
├─────────────────────────────────────────────────────────┤
│  sys_ioctl(fd, cmd, arg)                               │
│      ↓                                                  │
│  file = fget(fd)                                       │
│  file->f_op->unlocked_ioctl(file, cmd, arg)           │
└─────────────────────────────────────────────────────────┘
                         ↓
        ┌────────────────┴────────────────┐
        ↓                ↓                 ↓
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  kvm_fd      │  │   vm_fd      │  │  vcpu_fd     │
├──────────────┤  ├──────────────┤  ├──────────────┤
│ kvm_chardev  │  │  kvm_vm_fops │  │ kvm_vcpu_fops│
│    _ops      │  │              │  │              │
├──────────────┤  ├──────────────┤  ├──────────────┤
│ kvm_dev      │  │  kvm_vm      │  │  kvm_vcpu    │
│   _ioctl     │  │    _ioctl    │  │    _ioctl    │
└──────────────┘  └──────────────┘  └──────────────┘
      ↓                  ↓                  ↓
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ 系统级操作   │  │ 虚拟机级操作 │  │ vCPU级操作   │
├──────────────┤  ├──────────────┤  ├──────────────┤
│ • 获取版本   │  │ • 创建vCPU   │  │ • 运行vCPU   │
│ • 创建VM     │  │ • 设置内存   │  │ • 读写寄存器 │
│ • 检查扩展   │  │ • 创建设备   │  │ • 设置CPUID  │
│             │  │ • 中断路由   │  │ • 调试       │
└──────────────┘  └──────────────┘  └──────────────┘

```

## KVM_CREATE_VCPU
该函数在`kvm_vm_ioctl()`中。
1. `kvm_vcpu_init(vcpu, kvm, id)`
该函数中，值得注意的行为是注册了一个notifier。它为 vCPU 注册了一个**抢占通知器**。这意味着，当宿主机调度器决定要抢占（暂停）这个 vCPU 所在的内核线程时，会先通过 `kvm_preempt_ops` 里的函数**通知 KVM**。这给了 KVM 一个机会，在 vCPU 线程被暂停前，做一些必要的清理或状态保存工作。
2. `kvm_arch_vcpu_create`
除开前面的大量初始化，这个函数真正地创建了一个vcpu。
	1. `gpc`和`pv_time`
		半虚拟化是为了让Guest OS意识到自己正在运行在虚拟环境中。paravirtual Time机制是半虚拟化思想在时间同步上的体现，具体机制包括
		- **共享内存**：KVM 在宿主机内存中分配一小块内存页。
		- **KVM 写入**：KVM/Host 会持续地将**准确的、稳定的**时间信息（比如当前的纳秒时间戳、稳定的 TSC 频率等）写入这块共享内存。
		- **Guest 读取**：Guest OS（如果加载了对应的 `kvm_clock` 驱动）不再完全依赖自己不靠谱的 TSC，而是直接**通过内存读取**这块共享区域，从而以极低的开销获得准确的时间。
	    gpc就是kvm_vcpu内部用于管理pv_time的数据结构。
	2.`kvm_mmu_create`
		这个是cpu创建的核心工作之一。创建mmu操作在内存初始化包括如下：
		- 初始化PTE列表描述符，管理PTE（页表项）的反向映射链表， 用于追踪哪些影子页表指向同一个HPA
		- 初始化MMU header缓存
		- 初始化影子页面缓存，即分配影子页表页面，用于存储实际的页表数据。
		第二部分用于准备嵌套虚拟化
		```
		    vcpu->arch.mmu = &vcpu->arch.root_mmu;
		    vcpu->arch.walk_mmu = &vcpu->arch.root_mmu;
		```
		这一部分在大多数情况下是指向root_mmu的指针就好，但是留了`guest_mmu`作为嵌套式虚拟化的接口。
		随后调用了内部辅助函数接口：
		`static int __kvm_mmu_create(struct kvm_vcpu *vcpu, struct kvm_mmu *mmu)`
		用于进行创建单个MMU
		该函数内部对MMU的根系统hpa等内容进行了标准的invalid初始化。
		检查是否需要启用tpa（仅有32位系统需要在这里提前处理，其余情况推迟处理）
    综上，目前MMU的架构概览可以总结为：
```c++
	struct kvm_vcpu {
    struct kvm_vcpu_arch {
        // 主要的 MMU 上下文
        struct kvm_mmu *mmu;        // 当前使用的 MMU
        struct kvm_mmu *walk_mmu;   // 页表遍历用的 MMU
        // 两个 MMU 实例
        struct kvm_mmu root_mmu;    // 正常模式
        struct kvm_mmu guest_mmu;   // 嵌套虚拟化（L2 客户机）
        
        // MMU 缓存
        struct kvm_mmu_memory_cache mmu_pte_list_desc_cache;
        struct kvm_mmu_memory_cache mmu_page_header_cache;
        struct kvm_mmu_memory_cache mmu_shadow_page_cache;
    } arch;
};
```
影子页表的机制已经几乎不适用了，几乎所有的cpu都支持硬件虚拟化加速，走EPT/NPT

## KVM_RUN
kvm的三层io设计中最后一层`kvm_vcpu_ioctl`中的第一个case。这是kvm执行逻辑的关键。
```c++
case KVM_RUN: {
        struct pid *oldpid;
        r = -EINVAL;
        if (arg)
            goto out;
        oldpid = rcu_access_pointer(vcpu->pid);
        if (unlikely(oldpid != task_pid(current))) {
            /* The thread running this VCPU changed. */
            struct pid *newpid;
            r = kvm_arch_vcpu_run_pid_change(vcpu);
            if (r)
                break;

            newpid = get_task_pid(current, PIDTYPE_PID);
            rcu_assign_pointer(vcpu->pid, newpid);
            if (oldpid)
                synchronize_rcu();
            put_pid(oldpid);
        }
        vcpu->wants_to_run = !READ_ONCE(vcpu->run->immediate_exit__unsafe);
        r = kvm_arch_vcpu_ioctl_run(vcpu);
        vcpu->wants_to_run = false;
  
        trace_kvm_userspace_exit(vcpu->run->exit_reason, r);
        break;
    }
```
这一段代码首先是对于pid的验证，都是通过rcu安全读写更新的的。
之后进行了一个原子的读READ_ONCE vcpu->run这一共享内存区域。
核心功能在`kvm_arch_vcpu_ioctl_run`函数内部：
1. `vcpu_load`
	这一函数负责加载vcpu到物理cpu上的函数。代码如下
	```C++
	void vcpu_load(struct kvm_vcpu *vcpu)

{
    int cpu = get_cpu();

    __this_cpu_write(kvm_running_vcpu, vcpu);
    preempt_notifier_register(&vcpu->preempt_notifier);
    kvm_arch_vcpu_load(vcpu, cpu);
    put_cpu();

}
	```
- `get_cpu`和`put_cpu`是一对用于获取当前执行的cpu id号的函数，并能保证在两函数调用之间不会切换为其他的cpu执行，从而保证了操作的原子性。
- ` __this_cpu_write(kvm_running_vcpu, vcpu)`这一操作中的`kvm_ruinning_vcpu`是全局定义的per-CPU变量，每个物理CPU都有自己独一无二的副本。通过它将当前的vcpu和这个物理CPU副本进行构建映射关系。当内核中其他部分（中断处理或是VM-Exit）需要快速知道当前物理CPU上运行哪个vCPU，读者这个per-CPU变量就可以立即获得。
- `preempt_notifier_register(&vcpu->preempt_notifier)`这个函数注册了一个抢占通知器。为vCPU创建保护机制。如果CPU上运行着这个vCPU，但如果内核调度器需要抢占
2. CR8机制：[[APIC中断虚拟化]] 
3. 核心函数`static int vcpu_run(struct kvm_vcpu *vcpu)`
	这个函数的是绝对核心的函数。是vCPU自己的**内核态执行循环**
	简单来说，这个函数是一个**状态机**，它决定了vCPU应该是运行还是睡眠。并且处理哪些不需要返回到用户空间（QEMU）的轻量级VM-Exit。
	**核心机制：内核态执行循环**
	- vcpu_run中的内核循环执行`for(;;)`提示了不是所有的VM-Exit都会返回给QEMU。KVM会尽最大的努力在内核态就**内部处理**掉VM-Exit，然后立即再次进入Guest。而不是返回到QEMU 。
	这个循环的逻辑是：
	1. 检查vCPU是否是应该运行？（`kvm_vcpu_running(vcpu)`）
		- `true`（运行态）：调用`vcpu_enter_guest(vcpu)`。这是vCPU的**热路径**。vCPU在Guest模式下运行，直到发生了VM-Exit。[[kvm_enter_guest学习笔记]]
		- `false`：vCPU不想运行（例如Guest OS执行了`HLT`停机指令）。此时调用`vcpu_block(vcpu)`，让 vCPU 线程进入**可中断睡眠**，释放物理 CPU。
	2. 处理返回值`r`
		- `r<=0`：发生了必须由用户空间(QEMU)处理的事件。或者一个错误。此时break并把控制权交给上一层的ioctl函数（`kvm_arch_vcpu_ioctl_run`），最终会返回给QEMU。
		- `r>0`：则继续高性能执行。这意味着`vcpu_enter_guest`内部完成了VM-Exit的发生和处理，并且不需要QEMU来进入。
	3. 循环体内部进行一些轻量级的事件处理的收尾工作，为下一次的`vcpu_enter_guest` 做准备。
		- `kvm_inject_pending_timer_irqs(vcpu)`：检查是否有虚拟时钟中断到期了？如果有，在这里注入，准备在下一次 VM-Entry 时传递给 Guest。
		- `kvm_xen_...`：处理 Xen的事件。
		- `KVM_EXIT_IRQ_WINDOW_OPEN`：这是一个特殊的退出请求。[IRQ Window Exit](IRQ%20Window%20Exit.md)
## 