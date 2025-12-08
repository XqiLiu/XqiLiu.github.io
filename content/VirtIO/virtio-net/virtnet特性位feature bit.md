---
title: virtnet特性位feature bit
tags:
  - net
  - virtio
  - feature_bit
categories:
  - VirtIO
  - virtio-net
date:
---

# VIRTIO_NET_F_MQ
代表Multi-Queue，多队列
特性启用时，允许一个virtio-net的虚拟网卡（vNIC）向Guest OS暴露多个接收和发送队列。

**解决的问题：**
在此特性之前，一个虚拟网卡只能有一个接收队列和一个发送队列。
当存在多个vCPU的虚拟机中会出现严重的性能瓶颈。
- **单一的vCPU瓶颈**：所有的网络数据包都必须由单个vCPU来处理。
- **无法扩展**：即使你给虚拟机分配了 8 个 vCPU，当网络I/O非常高时（例如万兆网络），你可能会发现只有 1 个 vCPU 处于 100% 满载状态，而其他 7 个 vCPU 却很空闲。这导致虚拟机的总网络吞吐量受限于单个 vCPU 的处理能力。

**MQ如何工作的：**
1. 暴露多队列：虚拟网卡向虚拟机显示多个队列
2. 负载分散：Guest OS可以利用这些对俄，将网络处理的负载分散到多个vCPU上。
	- RX：类似于物理网卡的RSS技术，可以将不同的网络流哈希到不同的RX队列上，每个队列再由不同的vCPU处理。
	- TX：布胡同的应用程序可以从不同的vCPU将数据包推送到不同的TX队列中，实现并行发送。

**主要优势**：
- 提高吞吐量，降低延迟，提升CPU效率。

# Hardware Offload：VIRTIO_NET_F_CSUM


# VIRTIO_NET_F_MRG_RXBUF

# VIRTIO_NET_F_MRG_RXBUF