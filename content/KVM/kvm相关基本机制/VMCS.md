---
title: VMCS
categories:
  - KVM
date: 2025-10-28T13:13:00
---
VMCS是用于intel硬件虚拟化(VT-x)的核心。

直观上的理解，可以认为每一个vCPU都有一个对应的内存数据结构，这是一个“任务交接单”。当Host（KVM）要把CPU的控制权交给Guest是，它会填写这张单子，然后执行`VM Resume`指令，CPU硬件读取这张单子，以此设定Guest的运行状态。

这是一个硬件定义的、KVM必须在内存中创建和填充的内存数据结构，用于完整的封装和定义一个vCPU的所有状态和控制行为。
对VMCS的写操作（`VMWRITE`操作）是一项高延迟的微码操作，远慢于常规的内存写入。

CPU硬件通过`VMPTRLD` 指令将一个 VMCS 加载为“当前” VMCS。此后`VMLAUNCH` 和 `VMRESUME` 指令将**完全依赖**此 VMCS 中的信息来执行 VMENTRY；而 `VMEXIT` 发生时，CPU 硬件也会**自动将**退出信息写回此 VMCS。

VMCS在功能上主要分为以下的几个区域：
# Guest-State Area(客户机状态区)
- 用途：定义了`VMENTRY`时vCPU必须加载的上下文。
- 字段示例：`GUEST_RIP`, `GUEST_RSP`, `GUEST_RFLAGS`, `GUEST_CR0`, `GUEST_CR3`, `GUEST_CR4`, `GUEST_ES_SELECTOR`， `GUEST_CS_SELECTOR`, `GUEST_IDTR_BASE` 等。
- 与KVM的交互：vmx_cpu_run中脏位检查后VMWRITE的主要目标区域。[[kvm_enter_guest学习笔记#进入运行Guest]]

# Host-State Area (宿主机状态区)
- 用途：定义了VMEXIT发生时，宿主机（KVM）将恢复执行的最小上下文。
- 字段示例：`HOST_RIP` (VMEXIT 后的返回地址), `HOST_RSP` (KVM 的栈顶), `HOST_CR3` (KVM 的页表基址), `HOST_CS_SELECTOR` 等。
- 与 KVM的交互：`vmx_vcpu_run` 中 `if (unlikely(cr3 != vmx->loaded_vmcs->host_state.cr3))` 这段代码，就是在 VMENTRY 前确保 VMCS 中的**宿主机着陆页表 (`HOST_CR3`)** 必须是**最新**的，以防止宿主机 KVM 线程在被调度后，因 `CR3`（和 PCID）变更而导致 VMEXIT 时“着陆”到错误的地址空间，引发宿主机崩溃。

# VM-Execution Control Fields（执行控制区）
**用途**：一系列位掩码，用于精确控制哪些Guest操作不需要VM-Exit（硬件处理），哪些必须VM-EXit（KVM截获）。
**字段示例**：`Pin-Based Controls` (NMI 退出), `Processor-Based Controls` (如 `CPUID_EXITING` 使 `CPUID` 指令退出, `INTERRUPT_WINDOW_EXITING` 即 `IRQ Window` 机制的硬件开关, `USE_IO_BITMAPS` 使能 I/O 截获)。

# 嵌套虚拟化下的VMCS
物理CPU只认一个激活的VMCS，当启用了嵌套虚拟化时，VMCS的触发流程发生一些变化。
这个VMCS的触发设置流程如下：
1. 阶段一：L1准备启动L2
	1. L1以为自己是物理机，在内存中准备了一块数据，它叫它为`vmcs01`（在L0看来是`vmcs12`，下面为了区分，统一在L0角度来称呼VMCS）
	2. L1在`vmcs12`（内存）里设置“`CPUID_EXITING = 1`”，这样L2执行`CPUID`时就会退出
	3. L1执行`VMLAUNCH`指令（以为它在启动自己的VM）
2. 阶段二：`VMLAUNCH`陷阱（L1->L0退出）
	1. L1只是L0的一个vCPU。在L0启动L1之前，就已经在L0自己的物理VMCS（`vmcs01`）里设置了“当L1执行`VMLAUNCH`时，触发VM-Exit”
	2. 所以L1执行`VMLAUNCH`时会触发一次L1->L0的VM-Exit。
3. 阶段三：L0处理VMCS合并
	1. L0被触发醒来，发现了L1vCPU试图执行VMLAUNCH，此时就知道L1试图启动L2。
	2. L0在**软件里**去读取L1的`vmcs12`的那块内存，发现L1想要L2在`CPUID`时退出
	3. L0修改他自己的**物理VMCS**（vmcs01），把`vmcs12`里的状态合并到L0的物理`vmcs01`。
	4. 关键的是，L0会在物理`vmcs01`中也设置为“`CPUID_EXITING = 1`”（无论是L0自己想要截获，或是L0知道L1想要截获，都需要）
4. 阶段四：L0替代L1启动L2
	1. L0做完了合并后，自己执行`VMRESUME`指令（使用L0的物理VMCS）
	2. **物理CPU硬件现在直接运行L2的代码**
	3. L1此时还是睡眠（`KVM_MP_STATE_HALTED`），并不知情。
5. 阶段五：L2的`CPUID`退出
	1. L2执行了`CPUID`指令，**物理CPU会检查当前激活的VMCS**即vmcs01（vmcs12已经合并到这里了）。
	2. 硬件触发VM-Exit（因为`CPUID_EXITING = 1`），物理CPU硬件的VM-Exit目标一定是L0（KVM）。L0检查原因知道是L2返回的。
6. 阶段六：L0反射退出给L1。
	1. 这个就是`nested_vmx_reflect_vmexit`[[vmx_handle_exit学习记录#嵌套虚拟化处理]]
	2. L0醒来后，在软件层面决定CPUID是否发送给L1，从而修改`vmcs12`的推出信息区。
	3. 于是L0唤醒vCPU
