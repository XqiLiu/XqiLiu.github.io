---
categories:
  - VirtIO
  - virtio-net
title: virtnet网络包发包
date: 2025-11-24T15:10:00
tags:
  - net
  - virtio
---
这一部分总的来讲，我们最好带着一个问题来分析研究：
 **Guest 里的 virtio-net 驱动是如何把一个 sk_buff (Linux 的网络包) 拆解，并“挂”到 virtqueue 上的？**

我们通过注册在`netdev_ops`
```C
dev->netdev_ops = &virtnet_netdev;

static const struct net_device_ops virtnet_netdev = {
    .ndo_open      = virtnet_open,
    .ndo_stop      = virtnet_close,
    .ndo_start_xmit = start_xmit,  // <--- 就是它！
    // ...
};
```
中的`start_xmit`函数来开始追踪一次网络发包流程。

这里的重要的结构体`sk_buff *skb` [[virtnet中重要的结构体#sk_buff]] 代表了一个网络包，此时这个包还处于Guest的内存里（毕竟我们目前是处于virtnet中）。

代码的开始
```C
static netdev_tx_t start_xmit(struct sk_buff *skb, struct net_device *dev) {
	int qnum = skb_get_queue_mapping(skb);
}
```
此时的qnum就是内核根据包的特性，选择包走哪一个sq(send queue)。

接下来的核心操作就是在函数`xmit_skb`上
```C
err = xmit_skb(sq, skb, !use_napi);
```
# xmit_skb
这一个函数可以总结为做了三件事

**Can push？**
这一部分是因为virtio的协议规定了，发送任何数据包之前，都必须先发送一个virtio_net_hdr。在这里对于这个头存放位置做了一个简单的优化。
```C
can_push = vi->any_header_sg &&
		!((unsigned long)skb->data & (__alignof__(*hdr) - 1)) &&
		!skb_header_cloned(skb) && skb_headroom(skb) >= hdr_len;
```
通过判断skb_headroom（skb在数据包最前面预留的空间）的尺寸和hdr_len的尺寸对比，以及是否能对其，来判断是否可以吧hdr的指针指向skb->data的前面位置或是备用区。
- 为什么hdr_len是不固定的呢，因为长度取决于probe阶段协议。有10、12、20字节或更多的常见配置长度。

**Scatter-Gather**
这一步是根据第一步的布局，把零散的内存块记录到Scatter-Gather List（变量sq->sg）里
```C
sg_init_table(sq->sg, skb_shinfo(skb)->nr_frags + (can_push ? 1 : 2));
```
操作系统里的一个网络包skb，在逻辑上是一个整体。但在物理内存，他可能是碎的，如果是copy到一块新的内存里，太慢了。所以采用SG List告诉硬件应该去哪里找skg。
sg_init_table也是一个常用的通用函数，初始化了一个sg。
接下来
```C
	sg_init_table(sq->sg, skb_shinfo(skb)->nr_frags + (can_push ? 1 : 2));
	if (can_push) {
		__skb_push(skb, hdr_len);
		num_sg = skb_to_sgvec(skb, sq->sg, 0, skb->len);
		if (unlikely(num_sg < 0))
			return num_sg;
		/* Pull header back to avoid skew in tx bytes calculations. */
		__skb_pull(skb, hdr_len);
	} else {
		sg_set_buf(sq->sg, hdr, hdr_len);
		num_sg = skb_to_sgvec(skb, sq->sg + 1, 0, skb->len);
		if (unlikely(num_sg < 0))
			return num_sg;
		num_sg++;
	}
```
这里有两个分支：
- 分支A：
	`can_push = true`，那么就把virtio hdr卸载headroom里。这个SG可以少一个条目。
- 分支B：
	否则，只能在旁边再找一个小内存`Virtio Header`来存放virtio hdr。
这算是一个小优化。

**将数据写到virtqueue**
```C
return virtqueue_add_outbuf(sq->vq, sq->sg, num_sg,
				    skb_to_ptr(skb, orphan), GFP_ATOMIC);
```
这个函数就是关键的工作，将上述设生成的`sg`写入到`Vring`中。
这一步也是把数据从driver的这一软件形态转换传输到硬件协议形态（device）

这里的`virtqueue_add_outbuf`继续向下查看实现，可以发现一个分支：
```C
static inline int virtqueue_add(struct virtqueue *_vq,
				struct scatterlist *sgs[],
				unsigned int total_sg,
				unsigned int out_sgs,
				unsigned int in_sgs,
				void *data,
				void *ctx,
				gfp_t gfp)
{
	struct vring_virtqueue *vq = to_vvq(_vq);

	return vq->packed_ring ? virtqueue_add_packed(_vq, sgs, total_sg,
					out_sgs, in_sgs, data, ctx, gfp) :
				 virtqueue_add_split(_vq, sgs, total_sg,
					out_sgs, in_sgs, data, ctx, gfp);
}
```
这里是virtio的从v1.0到v1.1的核心变革。[[virtqueue#virtiov1.1]]
如果是传统v1.0版本，则是不支持packed_ring。否则是支持packed_ring模式从而提供了缓存命中率，提升了性能。
接下来还是简单以v1.0作为讨论基础，介绍一下他的执行工作：
1. 判断SG的列表长度和virtqueue的配置，来选择hi用indirect mode还是direct mode。
	- 如果是indirect，是因为`total_sg`较大，驱动会通过kmalloc分配一块独立的非连续内存来存放这一组描述符表。。这样该操作仅会消耗1个描述符。见笑了主环的随便化，提高主环的能容纳的请求总数。
	- 直接模式就是直接小号`total_sg`个主环描述符。
2. 构造描述符链表，把OS的物理内存地址填入Virtio硬件定义的vring_desc结构体中，并建立链表关系。
	- 遍历
	- 
	- 输入的sgs，针对每一个segment都执行：
		1. DMA映射，获取该片段的物理地址和长度
		2. 填充描述符，填写到vring_desc
		3. 设置标志位，来区分是indirect的描述符；还是说这是一个发送队列或接收队列；抑或是说这是一并不是数据的终点，还有Next。
		4. 链接索引，只想下一个空闲描述符的索引。
3. 保存驱动的上下文。建立Ring索引和操作系统数据结构之间的映射，从而可以在请求完成时进行资源回收。
	- virtqueue为了一个名为`desc_state`的私有数组，仅驱动可见
		- 保存Cookie，将传入的data指针（发包流程中的skb的指针）保存在`desc_state[head]`中，其中head是本次请求所占用的第一个描述符的索引。
		- 更新空闲指针
		- 减少空闲指针技术
		- Host的通知请求完成时，驱动只知道归还的索引ID，必须通过查询`desc_state[head]`才能找回原始的skb并释放内存完成GC。
4. 发布到Avail Ring，将构建好的描述符链的头缩i你写入共享内存，并通知设备有新请求待处理。
	- 计算avail ring的当前位置，把链表索引（`head`）写入`vring->avail->ring[idx]`。此时数据已经写入设备，但设备尚未看见。
	- 使用内存屏障，强制保证上述所有对描述符表和avial->ring的写操作，在执行更新idex之前，必须已经完成并对其他核心可见。防止乱序执行，导致设备读取到未初始化的描述符。
	- 更新索引，设备（Host）扫描avail ring的游标 `vring->avail->idx` 加 1。只有`idx`增加时，设备才知道有新的请求。

# **kick**
最后一步就是驱动kick设备了。
```C
	kick = use_napi ? __netdev_tx_sent_queue(txq, skb->len, xmit_more) :
			  !xmit_more || netif_xmit_stopped(txq);
	if (kick) {
		if (virtqueue_kick_prepare(sq->vq) && virtqueue_notify(sq->vq)) {
			u64_stats_update_begin(&sq->stats.syncp);
			u64_stats_inc(&sq->stats.kicks);
			u64_stats_update_end(&sq->stats.syncp);
		}
	}
```

这里的kick参数分为两种情况：
- 由NAPI控制：
	- `!xmit_more`: 这是内核协议栈传下来的一个暗示。
		- **True**：意思是当前是最后一个包，必须kick，否则消息就无法传达到Host了。
		- **False**：当前不是最后一个包，可以先不kick。
	- `netif_xmit_stopped`: 队列被暂停了（可能满了）。这时候必须 Kick，要求 Host 处理后腾出空间。
- 由NAPI控制
	- BQL（Byte Queue Limits）：`__netdev_tx_sent_queue`是Linux内核的一种高级流控算法。它不只是看有没有下一个包，还要根据**字节数**来算。
	- 逻辑：计算当前堆积在队列里的字节数是否超过了一个动态阈值。如果没超过，即时没有下一个包，也可能推迟kick，试图凑出更多的包。

当确定需要kick之后，就开始执行真正的kick。这里有两个函数：
```C
if (virtqueue_kick_prepare(sq->vq) && virtqueue_notify(sq->vq))
```
第一个`virtqueue_kick_prepare(sq->vq)`内部使用了一个virtio v1.0引入的高级特性`VIRTIO_RING_F_EVENT_IDX`。它更加智能实现了一种**定量通知**
- 原理：Host不再挂禁止kick的标记位，而是在共享内存的特定位置写下（await_event）写下一个**数字索引号**，来指示Guest在idx大于等于该数字索引号的时候再kick
- 在内部需要使用内存屏障来保证不出现死锁，Host以为没有消息，Guest以为Host是等待消息便不去通知。从而造成网络丢包。


# 总结
一个完整的virtio-net的发包流程，可以总结为如下
- **入口**：Guest 协议栈调用 `start_xmit`，此时数据在 `sk_buff` 中。
- **准备头部**：驱动检查 Headroom（`can_push`）。若空间充足，将 `virtio_net_hdr` 直接写入 `skb` 头部以获得连续内存；否则在 SG List 中单独映射一个头部。
- **内存映射 (DMA Mapping)**：将 `skb` 中的逻辑地址转换为 Host 可见的**物理地址**，并整理成 Scatter-Gather List (SG List)。
- **填充描述符 (Virtqueue Add)**：
    - 根据 SG List 长度，决定使用 **Direct**（直接填充主环）还是 **Indirect**（外挂描述符表）模式。
    - 将物理地址填入 Descriptor Table，并设置 `NEXT` 标志链接各片段。
- **保存上下文**：将 `skb` 指针保存在驱动私有的 `desc_state` 数组中，以便后续 Host 处理完后，Guest 能找回并释放该 `skb`。
- **发布 (Publish)**：将链头索引写入 **Available Ring**，并执行**内存屏障**，确保描述符写操作对 Host 可见。
- **通知 (Kick)**
    - 首先利用 Linux 内核的 **xmit_more/BQL** 机制进行本地批量提交。
    - 若必须提交，再检查 Virtio 的 **Event Index / No_Notify** 标志。只有在 Host 明确需要通知时，才写寄存器触发 VM-Exit。