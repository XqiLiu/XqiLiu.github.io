---
title: APIC中断虚拟化
categories:
  - KVM
  - kvm相关基本机制
tags:
  - Irq
  - Linux
  - KVM
date: 2025-11-04T20:01:00
---
# 虚拟化的挑战：
[Linux中断处理](Linux中断处理.md)guest操作系统不知道自己运行在虚拟机里。他会像在物理机上一样，频繁读写CR8来管理中断。在早期的虚拟化中，每一次对CR8的访问都会导致VM-Exit，CPU控制权交还给KVM，KVM再去模拟对vAPIC的访问。这个开销是极其巨大的。
# KVM虚拟APIC的两种模式
KVM提供了两种APIC虚拟化
## 模式一： 用户空间模拟（Split IRQChip）

这是古老、慢但兼容性最好的模式。
- 工作方式： KVM 内核模块只负责最基础的evCPU运行，而将整个APIC的模拟工作（LAPIC和IO-APIC）外包给用户空间的QEMU。
- **`!lapic_in_kernel(vcpu)`**：这个表达式在这种模式下为 **`true`** (LAPIC **不在**内核里)。
- CR8 管理：
	1. 当 Guest 写入CR8， 触发VM-Exit。
	2. KVM捕获退出，但他自己不知道如何处理，所以将推出原因`KVM_EXIT_SET_CR8` 写入 `kvm_run` 共享页，然后返回到 QEMU。
	3. QEMU 检查 `kvm_run`，发现 Guest 要设置 CR8。QEMU 在自己的软件模拟 APIC 中更新这个值。
	4. QEMU 再次调用 `KVM_RUN`。在调用前，它会将这个新的 CR8 值写入 `kvm_run->cr8`。
	5. KVM准备再次运行vCPU，它看到了`!lapic_in_kernel(vcpu)`为true，于是它从 `kvm_run->cr8` 读出 QEMU 提供的“正确”值，并通过 `kvm_set_cr8()` 将其设置回 vCPU 的硬件上下文中。

## 模式二： 内核/硬件加速（In-Kernel LAPIC/APICv）

这是现代的、高性能的模式。它依赖于CPU硬件的虚拟化支持（intel APICv或AMD AVIC）。
- **`!lapic_in_kernel(vcpu)`**：这个表达式在这种模式下为 **`false`** (LAPIC **在**内核里)。
- CR8管理：
	1. CPU 硬件支持“**TPR 影子**”(TPR Shadowing)。
	2. 当 Guest 写入 `CR8` 时，**不再触发 VM-Exit**。
	3. CPU 硬件会直接将这个值写入一个特殊的、由 KVM 控制的内存区域（VMCS 中的 "Virtual-APIC Page"）。
	4. 硬件会**自动**使用这个“影子”值来屏蔽中断，整个过程 KVM 和 QEMU **零参与、零开销**。
	5. **这就是你的代码中 `if` 语句不执行的路径**：因为 `!lapic_in_kernel` 为 `false`，KVM **跳过**了 `kvm_set_cr8()`。这是因为它知道 vCPU 的 CR8 状态已经由硬件自动维护了，绝对是最新的，根本不需要 QEMU 那个（可能已经过时的）值来同步。