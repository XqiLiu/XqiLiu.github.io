---
title: Linux中断处理
categories:
  - Linux内核基础
---
# APIC
在现代x86-64架构中：
**APIC（高级可编程中断控制器）：**
- 这是CPU内部用于管理中断的复杂组件。每个CPU核心都有一个本地APIC（LAPIC）。
**TPR（任务优先级寄存器）**： 
- 这是LAPIC内部的一个8位寄存器。它的作用是设置一个中断”屏蔽阈值“。只有**优先级高于TPR值得硬件中断才会被CPU接受**。
**CR8（控制寄存器8）**：
- 在64位模式下，操作系统不能直接访问APIC得TPR寄存器。作为替代，CPU提供了`CR8`寄存器。**对CR8得读写会被CPU自动转化为对LAPIC地TPR寄存器的读写**。

# NMI
- **NMI (不可屏蔽中断)**：这是一种最高优先级的硬件中断，比如硬件故障、调试器中断等。它**不能**被 Guest OS 用 `CLI` (Clear Interrupts) 指令屏蔽。
## NMI注入
当一个虚拟NMI需要被注入时（例如QEMU想要调试Guest），KVM不能立即注入。因为此时KVM可能会在vCPU处于一个不安全的状态（比如正在处理另一次VM-Exit）时受到这个NMI请求。
此时安全的做法是：先在 `vcpu->requests` 里做好标记（`KVM_REQ_NMI`）。等到
`vcpu_enter_guest` 准备好时，再检查这个待注入的NMI事项，调用`process_nmi(vcpu)`，在 **VM-Entry 的一瞬间**安全、原子地将其注入 Guest。
