---
title: vhost-user基本概念
categories:
  - dpdk
date: 2025-11-30T10:21:00
tags:
  - dpdk
  - virtio
---
阅读本文，需要已经初步掌握了KVM的基本工作方、virtnet的基本工作原理、vhost的基本工作原理.
vhost-user是DPDK技术下所实现，采用vhost协议的一个用户态库。
为了了解其性能提升方法。这里可以按照性能优化路径先分解一下：
# 性能优化迭代
## virtnet-QEMU模式：
这是基本模拟的方式。路径最长，流程是：
- Guest -> virtnet -> VM-Exit -> KVM（处理不了IO）-> QEMU（用户态模拟）-> Host Kernel(TAP) -> send
这一模式下，virtnet作为Virtio模型的前端，QEMU的软件模拟作为了Virtio模型的后端。

很明显这一流程上下文切换次数太多，数据拷贝次数太多。

## vhost-net（内核卸载）模式：
这一模式做了优化，将QEMU作为Virtio后端的职责offload到了内核态的内核模块vhost。这里的工作模式是：
- Guest -> virtnet -> VM-Exit -> KVM(发现寄存器绑定了ioeventfd，不用唤醒QEMU) -> vhost-net -> TAP
- Guest依然会触发VM-Exit，KVM依然会捕获它。但KVM只需要利用`ioeventfd`[[通信机制：ioeventfd和irqfd]]机制通知一下，就可以返回Guest了。
- 真正搬运数据的是内核里的`vhost-$pid`线程，他绕过了QEMU用户态。
这就减少了一部分系统调用和对应的上下文开销。

## vhost-user(OVS-DPDK)模式:
这一模式下利用DPDK进一步提升了性能。vhost-user是DPDK底层的一个用户态库。此时的工作模式变成了：
- Guest -> virtnet -> vhost-user -> send
- 可以发现，vhost-user完全不需要发送VM-Exit，完全不需要kick，更不用说需要切换到KVM了。
- 这里的vhost-user会开启Polling模式，一直在监督读取vq，并在收到消息后第一时间立即发送，且发送消息**不**需要经过**vhost内核模块**，更重要的是绕过了**整个Host Linux网络协议栈**（没有sk_buff，没有iptables）。

vhost-user之所以能够做到绕过vhost内核模块，原因在于QEMU的virtio设备模型进行了适配融合。
- QEMU模拟了一个virtio设备，该设备会出现在客户机的特定PCI端口上，Guest可以无缝探测和配置该设备。此外，他将ioeventfd映射到QEMU模拟设备的内存映射I/O空间中，并将irqfd映射到其全局系统中断（GSI）。
- 它并不实际实现了virtio的数据路径，而是充当vhost-user协议中的主节点，将此卸载到DPDK中的vhost-user库。
- 所以Guest不会察觉到通知中断都在vhost-user库之间进行转发和接收。因为QEMU并不需要告知Guest他将任务offload了。
- QEMU还需要处理一些发向vhost-user的control virtqueue请求，主要是类似于“修改MAC地址”等杂事。这些低频的指令依然是QEMU接收。但是如果有需要，QEMU会通过Unix Socket再转告给DPDK。


当然，这里还有更复杂的第四种优化方法，也是最后介绍的一种路径：
## virtio-pmd 
在这一模式下，需要集成VFIO[[VFIO]]与IOMMU[[IOMMU]]来进行配合。
在Guest OS内。IOMMU也是物理的，所以有vIOMMU这一概念。
vIOMMU与DPDK的合作下，存在一个问题：
在虚拟机里的网卡驱动以为自己看到了真实的物理内存GPA，但其实那是宿主机的虚拟内存HVA。vIOMMU负责维护这层映射关系：IOVA->GPA->HPA。
所以vIOMMU有如下的特点：
- 它将Guest的IOVA（I/O虚拟地址）转化为GPA，就像IOMMU在HOST所做的一样。然后通过QEMU的内存管理系统将GPA转换为QEMU的HVA
- 像IOMMU一样执行设备隔离。
- 实现I/O TLB API。以便可以从QEMU外部查询映射。

同时注意到vIOMMU与任何的Guest的网络应用程序之间的集成通常通过VFIO驱动程序映射实现。正如前文所提到的。该驱动程序执行设备隔离，并自动地将IOVA到GPA地映射添加到IOMMU。
这里的行为解释也可以参考实验中：
- 启动`testpmd`后，VFIO会使得vIOMMU把网卡的内存区域（IOVA）映射给这个DPDK应用程序，让网卡可以直接写进来（GPA）[[vhost-user实验]]


值得注意的是：DPDK的`Hugepages`采用一个**大**（Hugepages）的**静态内存池**来存储数据包缓存和虚拟队列，因此对于地址翻译转换在使用动态映射时，性能损失大幅降低。

这里引用redhat博客
	https://www.redhat.com/en/blog/journey-vhost-users-realm
中的图：
![[redhat增强架构.png]]
同时在这里引入对于博客讲解的内容的理解：
- GPA的空间是Guest所感知到的物理内存，其实是HVA。所以VQ内存区域被分配时，他最终还是会在Host的物理内存某处。
- 当DPDK的Vring物理内存地址联系上了IOVA，必须将与其关联的Guest的地址GPA一起填入进vIOMMU的TLB表中。
```
	网卡 (设备)
          |
          | 发起访问: "我要读 IOVA 0x9999"
          v
    +-------------+
    |   vIOMMU    | <--- 数据填充
    |-------------|
    | TLB         | 
    | 0x9999 ----> |---- 翻译成功! ----> 是 GPA 0x1000
    +-------------+
          |
          | 访问实际位置
          v
    +-----------------------+
    | Guest 物理内存 (GPA)    |
    | 虚拟队列 (vring)        | <--- 数据在这里 (地址 0x1000)
    +-----------------------+
```
- QEMU的内存管理系统能够感知GPA在其进程的HVA中的位置，所以能够转化GPA->HVA（QEMU）
- vhost-user库尝试访问没有对应转换的IOVA时，会通过辅助unix套接字发送IOTLB未命中消息。
- IOTLB API 接收请求并查找地址，首先将 IOVA 转换为 GPA，最后将 GPA 转换为 HVA。然后，它通过主 Unix Socket将转换后的地址发送回 vhost-user 库。
- 最后，vhost-user 库还需要进行最后一次转换。由于它将 qemu 的内存映射到了自己的内存中，因此它必须将 qemu 的 HVA 转换为自己的 HVA（两个进程的VA不一致），才能访问共享内存。
- 这里的QEMU下有一个vhost-user模块，是负责转发Guest的控制需求，通过Unix Socket和DPDK App沟通。因为Guest只能知道QEMU模拟出来的设备，所以需要这样一个组件作为中间代理。它只负责控制面，不管数据。