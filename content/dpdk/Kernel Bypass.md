---
categories:
  - dpdk
title: Kernel Bypass
date: 2025-12-01T18:03:00
tags:
  - Bypass
  - dpdk
---
**传统路径**：网卡 -> 硬件中断 -> 内核驱动 -> Linux网络协议栈（IP/TCP）-> Socket 接口 -> 用户态程序。
- 性能分析：只要数据经过内核，就需要**Context Switch**和内存拷贝。

**DPDK路径**：采用了Kenel Bypass：网卡->**DPDK应用程序**（用户态）
- 性能分析：
	- DPDK通过VFIO/UIO等方法直接接管了网卡的数据。通过DMA的方式直接得到数据而不需要copy数据（指的是不需要CPU参与的copy）
	- 绕过了内核协议栈到用户态程序的`copy_to_user`这一跨用户-内核态的数据拷贝。因为DPDK本身就是用户态应用程序，直接传递数据指针，利用共享内存就可以传输数据。
	- 本质上是zero-copy的实现，这是DPDK的高性能原因之一。