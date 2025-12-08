---
title: vhost的通信机制：ioeventfd和irqfd
categories:
  - VirtIO
  - vhost
tags:
  - virtio
  - VM-Exit
---
# 概述：
- Guest对Host的Kick：Guest发包了，写一个寄存器，触发VMExit，KVM捕捉到后，通过`ioeventfd`直接唤醒内核里的vhost线程。
- Host->Guest的Call流程：vhost线程收包完成，通过`irqfd`注入一个中断给Guest。

Qemu 分配一个`eventfd`并将其注册到 vhost 和 KVM，以实现通知绕过。vhost 的 $pid 内核线程会轮询该 `eventfd`，当客户机写入特定地址时，KVM 会向其中写入数据。此机制称为 **ioeventfd**。
这样，对特定客户机内存地址的简单读/写操作无需经过耗时的 QEMU 进程唤醒，可以直接路由到 vhost 工作线程。此外，它还具有异步的优势，无需停止 vCPU（因此无需立即进行上下文切换）。

另一方面，qemu 会分配另一个 `eventfd`，并将其注册到 KVM 和 vhost，以便直接注入 vCPU 中断。这种机制称为**irqfd**，
它允许宿主机中的任何进程通过写入该 `eventfd` 向虚拟机注入 vCPU 中断，并具有相同的优势（异步、无需立即切换上下文等）。

# 对比：
- **ioeventfd**可以看作是KVM在监听Guest写内存
- **irqfd**则是KVM在通过另一个`eventfd`得知vhost或其他Host线程处理完数据后写`eventfd`时，主动查到对应中断绑定表，执行**注入中断**。[[注入中断]]

| 特性         | ioeventfd                                       | irqfd                                     |
| ---------- | ----------------------------------------------- | ----------------------------------------- |
| **方向**     | **Guest $\rightarrow$ Host** (Kick)             | Host->Guest(interrupt)                    |
| **目的**     | 通知Host：“已有数据，去读取”                               | 通知Guest：“已有数据，去读取”或者“数据处理完了，回收内存”         |
| **触发者**    | Guest 写 **PIO/MMIO 内存地址**                       | Host (vhost/QEMU) 写 **eventfd 文件**        |
| **KVM的行为** | 拦截 VM Exit $\rightarrow$ **写 eventfd** 唤醒 vhost | 监听 eventfd $\rightarrow$ 修改 VMCS **注入中断** |
| **底层核心**   | `poll` / `epoll` (等待事件)                         | `injection` (修改 CPU 执行流)                  |

# 问题：
vhost 既然在内核里，为什么不直接调用 KVM 的函数 `kvm_set_irq()` 注入中断呢？为什么要多绕一个 `eventfd`？

原因有两个：

1. **解耦与通用性：** `irqfd` 提供了一个通用的**文件接口**。
    
    - 如果是 **vhost**（内核线程），它写文件。
        
    - 如果是 **QEMU**（用户进程），它也可以写文件。
        
    - 如果是 **VFIO**（直通设备驱动），它也可以写文件。 KVM 不需要知道谁在发中断，它只管守着这个文件描述符。这让架构非常灵活。
        
2. **异步与性能：** 如果 vhost 直接调用 KVM 的函数，它可能需要获取复杂的锁（Lock），如果 vCPU 正在忙或者锁被占用，vhost 线程就会被卡住（Block）。 用 `irqfd` 的话，vhost 只需要 `write` 一下就跑，剩下的脏活累活（注入中断、等待锁、踢 vCPU）由 KVM 的工作线程异步去处理，**vhost 的网络吞吐量就不会被阻塞。**