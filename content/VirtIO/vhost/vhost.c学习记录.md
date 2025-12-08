---
title: vhost.c学习记录
categories:
  - VirtIO
  - vhost
---
# vhost_get_vq_desc
vhost中很重要的一个问题就是，怎么把代码里拿到的guest地址GPA转化为一个Host能用的指针呢。
关键的函数就在：
```C
int vhost_get_vq_desc(struct vhost_virtqueue *vq,
		      struct iovec iov[], unsigned int iov_size,
		      unsigned int *out_num, unsigned int *in_num,
		      struct vhost_log *log, unsigned int *log_num)
```
代码首先进行一个idx比较，从而可以刷新当前vq中的最新的avail_idx，进而开始工作/退出
```C
	if (vq->avail_idx == vq->last_avail_idx) {
		ret = vhost_get_avail_idx(vq);
		if (unlikely(ret < 0))
			return ret;
		if (!ret)
			return vq->num;
	}
```

最重要的函数核心便是循环内部
```C
do {
ret = translate_desc(vq, vhost64_to_cpu(vq, desc.addr),
				     vhost32_to_cpu(vq, desc.len), iov + iov_count,
				     iov_size - iov_count, access);
} while ((i = next_desc(vq, &desc)) != -1);

```
这其中的translate_desc就是完成的GPA->HVA地址的转换。
这个地址的转化核心逻辑很简单，但依赖于map（Todo）
```C
_iov->iov_base = (void __user *)(unsigned long)
				 (map->addr + addr - map->start);
```
这里还需要处理**跨页**、**权限检查**、**缺页**等情况：
1. 查找映射关系：
```C
map = vhost_iotlb_itree_first(umem, addr, last);
```
`umem`存储了虚拟机内存布局的映射表，函数在红黑树中查找包含`addr`的内存区域`map`
2.  填充iovec（HVA）：
```C
_iov = iov + ret;
		size = map->size - addr + map->start;
		_iov->iov_len = min((u64)len - s, size);
		_iov->iov_base = (void __user *)(unsigned long)
				 (map->addr + addr - map->start);
```
`iovec` 是标准的散驱/聚集（Scatter/Gather）数组结构。


值得注意的是，为什么需要`vhost_iotlb`？
```C
struct vhost_iotlb *umem = dev->iotlb ? dev->iotlb : dev->umem;
```
这个对应了vhost的两种工作模式：
1. 无vIOMMU（Passthrough/Lagacy）：使用`dev->umem`。
	- QMEU启动时，把整个虚拟机（Guest）的内存布局通过`VHOST_SET_MEM_TABLE` 这个ioctl 发送给 vhost。
	- 这种映射是静态的覆盖了整个Guest内存。
2. 有vIOMMU：使用dev->iotlb。
	- Guest看到的不是GPA，而是IOVA（I/O Vritual Address）
	- vhost初始时可能没有映射，当Guest发起DMA时，vhost查表失败后（返回了`-EAGAIN`），通过`vhost_iotlb_miss` 通知 QEMU。QEMU 查询 vIOMMU 页表后，通过 `VHOST_IOTLB_UPDATE` ioctl 将新的映射下发给 vhost。

**总结：**
`vhost`实现GPA转HVA的黑犀牛在于维护了一颗区间树
当需要转换时：
- **查树**：用 GPA 在树中找到对应的内存段结构体 `map`。 
- **偏移**：算出 GPA 在该段内的偏移量。
- **叠加**：将偏移量加到该段预存的 Host 起始地址（HVA）上。
- **拼接**：如果 GPA 区域跨越了多个 Host 内存段，就循环多次，生成一个 `iovec` 数组来描述这块不连续的内存

# handle_rx
vhost作为后端，handle receive本质上就是在处理前端virtnet的rx。可以对比[[virtnet网络包发包#xmit_skb]]来分析学习。
