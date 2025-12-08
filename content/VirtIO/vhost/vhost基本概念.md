---
categories:
  - KVM
  - vhost
title: vhost基本概念
---
virtio-net可以认为是Virtio协议中的前端实现；vhost则是协议中的后端实现。
vhost-net运行在Host端（无论是内核态还是用户态）。
# vhost的核心价值
在vhost之前，也是存在Virtio的后端设计的，即QEMU Virtio。
- QEMU：数据包从Guest-> KVM(trap)->QEMU（用户态）->写入Tap设备->内核。路径太长，**上下文切换太多**。
- vhost-net：**进行了控制面与数据面的分离**
	- 控制面：QEMU同样负责初始化设备，分配内存，通过ioctl告诉内核vhost驱动Guest的内存布局和VRing地址。之后就将相关任务交付给vhost。
	- 数据面：内核里有一个`vhost-$pid`的线程，直接在内核态读取Guest内存，写入Tap/Tun设备，完全绕过了QMEU。

 

# 重要数据结构
## struct vhost_dev
vhost_dev是vhost设备的抽象。
需要关注内存映射表mem以及vq指针`vqs`

## vhost_virtqueue
这个是Vring在Host内核态的代表。
需要关注avail，uesd，desc三个指针
```C
	vring_desc_t __user *desc;
	vring_avail_t __user *avail;
	vring_used_t __user *used;
```
[[virtqueue]]
