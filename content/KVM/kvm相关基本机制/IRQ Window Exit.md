---
title: IRQ Window Exit
categories:
  - KVM
  - kvm相关基本机制
date: 2025-11-06T12:03:00
tags:
  - Irq
  - Linux
  - KVM
---
IRQ Window Exit是Intel和AMD提供的硬件加速机制，为了解决如下问题：

QEMU（模拟的设备，例如网卡）想要向vCPU注入一个设备中断（IRQ），但是vCPU（Guest OS）当前关闭了中断，那么KVM不能强行注入中断，因为会违反了OS的逻辑（真实的CPU也是这么做的），从而导致OS崩溃。

所以KVM必须也得等待Guest OS重新执行`STI`指令重新打开中断的那一刻，测可以安全地注入IRQ。

这一过程如果是真实地硬件，那么可以由硬件自动机制（[[Linux中断处理#APIC]]）来实现。但是在KVM中就需要用软件机制来实现，`IRQ windows Exit`正是一个硬件辅助功能（VM-Exit）

**这一机制的工作流程如下：**
- **QEMU请求投递：** QEMU有一个网卡中断要发送。它通知KVM有一个IRQ要给vCPU。（这就是在 `vcpu_run` 中看到的 `dm_request_for_irq_injection(vcpu)`)）
- **KVM检查状态：** KVM在准备运行vCPU。检查vCPU的状态，发现`EFLAGS.IF == 0`[[kvm_enter_guest学习笔记#准备阶段（VM-Entry之前）]]
- **KVM设置硬件陷阱：** KVM知道现在不能插入中断。于是**配置硬件（VMCS）**，在“VM-Execution Controls”中**启用一个标志位**，这个标志位的意思是：
	- 监视vCPU，当`EFLAGS.IF`标志为1时，触发VM-Exit通知。
	- 这就是在 `vcpu_enter_guest` 中看到的 `kvm_x86_call(enable_irq_window)(vcpu);`
- **Guest高速运行：** KVM调用`VMLAUNCH`，vCPU在Guest模式下运行，成千上万条指令期间都不会发生VM-Exit。
- **Guets允许中断：** vCPU的临界区代码执行完毕，他执行了STI指令来开启中断。
- **硬件触发VM-Exit：** 物理CPU的监控系统（上述的KVM设置硬件陷阱）**立即检测到这个动作**。就在`STI`指令即将完成、中断窗口（IRQ Windows）打开的一瞬间，硬件自动触发了一次**VM-Exit**。
- **KVM捕获退出：** `vcpu_enter_guest`从`VMLAUNCH`返回。KVM见擦汗VMCS中的退出原因，发现是`VM_EXIT_REASON_IRQ_WINDOW`。
- **KVM通知QEMU：** KVM知道vCPU准备接收中断了，于是不再继续运行Guest，而是`break`内部循环，设置`vcpu->run->exit_reason = KVM_EXIT_IRQ_WINDOW_OPEN`，然后返回到用户空间的 QEMU。
- **QEMU 投递中断**： QEMU 看到这个退出原因，就知道“窗口已打开”。它现在可以安全地调用 `KVM_INTERRUPT` ioctl 来注入那个挂起的网卡中断了。

**总结：**
`IRQ Window Exit` 不是一个软件轮询，而是一个硬件特性。它允许 vCPU 在**关闭中断**时以**零开销**（Zero-Overhead）的方式全速运行，同时保证 KVM（和 QEMU）能够在 vCPU **重新开启中断**的**确切时刻**被“唤醒”，从而以 100% 的正确性投递挂起的设备中断。

这个硬件特性最重要的就是在模拟中断屏蔽机制时，不需要轮询是否执行了`STI`，而是靠着硬件通知机制来高速运行。