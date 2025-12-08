---
title: KVM_RUN共享页（struct kvm_run
categories:
  - KVM
  - kvm相关基本机制
date: 2025-11-17T17:21:00
---
# 简介
该结构体本质上是**KVM内核模块**与**用户空间VMM**（如QEMU）之间进行高速、低延迟通信的共享内存区域。
- **QEMU (用户空间)**：在公告板上写下 "请开始运行，顺便，这是你（vCPU）需要更新的寄存器信息"（例如设置 `kvm_dirty_regs`）。
    
- **KVM (内核空间)**：接管 vCPU，开始运行。
    
- **vCPU (客户机)**：运行...直到遇到一个它自己无法处理的事情（如 I/O 操作），触发 **VM-Exit**。
    
- **KVM (内核空间)**：捕获 VM-Exit，暂停 vCPU，然后在公告板上写下 "运行暂停！原因：“I/O 操作”，详情：“端口 0x3f8, 写入数据 'A'"。
    
- **QEMU (用户空间)**：`KVM_RUN` 调用返回，QEMU 立刻查看公告板，"哦，原来是 I/O。我来模拟一下向 0x3f8 端口写 'A'"。
    
- 模拟完成后，QEMU 擦掉公告板，再次调用 `KVM_RUN`，循环往复。
# 作用
虚拟化环境中， [[VM-Exit]]发生的极其频繁（每秒成千上万次频率）。VM-Exit意味着控制权从Guest交还给Host。
如果每次VM-Exit，用户空间的QEMU都需要通过`read()`/`write()`等系统调用来从内核获取vCPU退出的原因和数据，将会产生巨大开销。
# 原理
核心机制是`mmap()`系统调用和`struct kvm_run`结构体。
1 .建立共享：`mmap()`
1. 当 QEMU 创建一个 vCPU 时，它会通过 `KVM_CREATE_VCPU` ioctl 获得一个代表该 vCPU 的文件描述符（`vcpu_fd`）。
2. 紧接着，QEMU 会对这个 `vcpu_fd` 调用 `mmap()`。
3. KVM 内核模块会响应这个 `mmap()`，在内核中分配一个（或多个）内存页，用于 `struct kvm_run` 结构体，并将这块**物理内存**映射到 QEMU 进程的**虚拟地址空间**中。
**结果**：QEMU（用户空间）和 KVM（内核空间）同时拥有了指向**同一块物理内存**的指针。
2 .使用共享页通信
这块共享内存就是具体的结构体`kvm_run`，包含了vCPU运行所需要的元数据
- `__u32 exit_reason`
	- 这是最重要的字段，内核用它来告诉QEMU为什么vCPU停止运行了（例如 `KVM_EXIT_IO`, `KVM_EXIT_MMIO`, `KVM_EXIT_INTR`）。
	- 一个巨大的`union`结构：
		- - 这个联合体根据 `exit_reason` 的不同而有不同的含义，实现了内存的复用。
		- `struct kvm_io io;`：如果 `exit_reason` 是 `KVM_EXIT_IO`，这个结构里会包含 I/O 端口、数据大小、读写方向等。
		- `struct kvm_mmio mmio;`：如果 `exit_reason` 是 `KVM_EXIT_MMIO`，这里会包含 MMIO 的物理地址、数据、长度等。
		- `struct kvm_exception ex;`：用于注入异常。
		- ... 以及其他各种退出原因的结构体。
	- `__u64 cr8`
		- 这是在QEMU调用KVM_RUN之前，用来传入数据给内核的例子，告诉内核vCPU的中断优先级（[[APIC中断虚拟化]]）应该是多少。
# 总结：KVM_RUN 的完整生命周期

1. **QEMU (写者)**：在调用 `KVM_RUN` 之前，向 `kvm_run` 共享页写入“请求”数据（如 `kvm_dirty_regs`, `cr8`）。
2. **QEMU (调用者)**：调用 `ioctl(vcpu_fd, KVM_RUN, ...)`，线程在内核中阻塞。
3. **KVM (读者)**：在 `kvm_arch_vcpu_ioctl_run` 中，读取 `kvm_run` 共享页中的“请求”（如 `sync_regs(vcpu)`，`kvm_set_cr8(...)`）。
4. **KVM (运行者)**：调用 `vcpu_run()`，进入 Guest 模式，vCPU 开始执行指令。
5. **(VM-Exit)**：Guest 执行敏感操作，触发 VM-Exit，返回到 KVM。
6. **KVM (写者)**：将 `exit_reason` 和退出数据（如 `kvm_run->io`）填入**同一个** `kvm_run` 共享页。
7. **KVM (返回者)**：`ioctl` 调用返回，QEMU 线程被唤醒。
8. **QEMU (读者)**：立即查看 `kvm_run` 共享页，读取 `exit_reason`，模拟硬件操作。
9. **循环**：QEMU 处理完毕，回到第 1 步，再次调用 `KVM_RUN`。

这个**零拷贝**（Zero-Copy）的共享内存机制，是 KVM 能够实现高性能虚拟化的基石。