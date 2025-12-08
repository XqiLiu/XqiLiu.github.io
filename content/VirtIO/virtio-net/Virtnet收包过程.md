Guest的收包不同于发包过程。发包过程是Guest OS主动进行的。而收包过程则是Guest OS被动的。
# Refill
收包过程中有一个比较反直觉的逻辑：**虽然Guest是被动接收数据的，但是Guest必须提前准备好内存（buffer）**
- 在数据层面：Host生产，Guest消费
- 在内存资源方面：Guest生产Buffer，Host消费Buffer。
这个空闲缓冲区即

1. 在virtnet打开的初始阶段，就完成了这个空闲缓冲区的refill：
```C
static int virtnet_open(struct net_device *dev)
{
//...
	for (i = 0; i < vi->max_queue_pairs; i++) {
		if (i < vi->curr_queue_pairs)
			/* Make sure we have some buffers: if oom use wq. */
			if (!try_fill_recv(vi, &vi->rq[i], GFP_KERNEL))
				schedule_delayed_work(&vi->refill, 0);

		err = virtnet_enable_queue_pair(vi, i);
	}
//...
}
```
这里的`max_queue_pairs`代表着有多少队收包/发包的队列，即多少对virtqueue。这里的`refill`意味着循环地把每一个receive_queue（一个virtqueue）里的每一项desc对应的物理地址都填充好。这里的内存**不能是延迟分配**的，如果网络包到了再进行临时分配，网络数据不允许这么高的延迟，会产生丢包。
这里分配的内存数据也是分散的，不必申请一整块的连续内存。毕竟每一个desc中的物理地址指向的是一块较小的内存块。

2. 在网络每次完成了收包的过程之后，都需要检验一下剩余的空闲缓冲区是否充足，如果空了一半，则立即触发`Refill`
```C
static int virtnet_receive(struct receive_queue *rq, int budget,
			   unsigned int *xdp_xmit)
{
	if (rq->vq->num_free > min((unsigned int)budget, virtqueue_get_vring_size(rq->vq)) / 2) {
		if (!try_fill_recv(vi, rq, GFP_ATOMIC)) {
			spin_lock(&vi->refill_lock);
			if (vi->refill_enabled)
				schedule_delayed_work(&vi->refill, 0);
			spin_unlock(&vi->refill_lock);
		}
	}
}
```
3. 关键动作：
```C
static bool try_fill_recv(struct virtnet_info *vi, struct receive_queue *rq,
			  gfp_t gfp)
{
	int err;

	if (rq->xsk_pool) {
		err = virtnet_add_recvbuf_xsk(vi, rq, rq->xsk_pool, gfp);
		goto kick;
	}

	do {
		if (vi->mergeable_rx_bufs)
			err = add_recvbuf_mergeable(vi, rq, gfp);
		else if (vi->big_packets)
			err = add_recvbuf_big(vi, rq, gfp);
		else
			err = add_recvbuf_small(vi, rq, gfp);

		if (err)
			break;
	} while (rq->vq->num_free);

kick:
	if (virtqueue_kick_prepare(rq->vq) && virtqueue_notify(rq->vq)) {
		unsigned long flags;

		flags = u64_stats_update_begin_irqsave(&rq->stats.syncp);
		u64_stats_inc(&rq->stats.kicks);
		u64_stats_update_end_irqrestore(&rq->stats.syncp, flags);
	}

	return err != -ENOMEM;
}
```
buffer有不同的类型，包括：
- mergeable，现代性能最高的一种，在下文详细展开讲解[[Virtnet收包过程#Mergable RX Buffers]]
- big，较为传统的buffer类型，缺点是不灵活，有时候很小的skb也要深情固定的较大的buffer
- small，现代Virtio中，专门处理的是能塞进一个page的skb

总之，申请buffer的流程可以简单都归类为：
	申请Page->`sg_init_one`->`virqueue_add_inbuf`->Kick Host。
# NAPI机制与中断抑制
如果每次收到一个包，都触发一次中断，CPU则会因为上下文切换和VM-Exit而浪费带昂性能。
这里有一点需要注意，收包和发包都是需要使用NAPI的。其实本质上是因为
发送包时，需要解决回收垃圾消息的批量处理；
收包时，需要解决的是网络数据的批量处理。
状态机可以总结为：

![[NAPI执行流程.png]]

NAPI解决了包数量带来的中断风暴，而不是包大小问题。


# Mergable RX Buffers
这个就是上文提到buffer类型。
Mergable主要是为了解决高效接收大包的问题。
- lagacy Big：预先分配64KB连续内存
- Modern Mergeable：按需分配4KB小页。
在receive_mergeable中的代码。核心逻辑是：
```C
while (--num_buf) {
		buf = virtnet_rq_get_buf(rq, &len, &ctx);
		
		u64_stats_add(&stats->bytes, len);
		page = virt_to_head_page(buf);

		truesize = mergeable_ctx_to_truesize(ctx);
		headroom = mergeable_ctx_to_headroom(ctx);
		tailroom = headroom ? sizeof(struct skb_shared_info) : 0;
		room = SKB_DATA_ALIGN(headroom + tailroom);
		curr_skb  = virtnet_skb_append_frag(head_skb, curr_skb, page,
						    buf, len, truesize);
	}
```
通过这个循环，把分散的Page挂到skb的碎片链表（Frags）上。
Mergebale不会增加终端频率，Host填满一个逻辑包才发送一次中断。开销只是微小的CPU拼装成本来换取高效的内存灵活性。

# Event Index
为了解决NAPI退出（重新开启中断）的一瞬间，存在竞态条件。如果简单的全开/全关中断，则会有性能损耗。
所以提出这一机制：
Guest通知Host ：`avail_event = last_used_idx`。
制定了一个门槛，通知事件累计到了一定数量才会通知。

# 总结
从Guest视角来看，收包过程可以总结如下：
1. Guest预先通过try_fill_revc将空Page的物理地址交给Host（Avail Ring）。
2. Host写入数据，更新Used Ring，触发中断。
3. Guest NAPI被唤醒， 调用`virtnet_poll`
4. `virtqueue_get_buf`取回Page， `receive_mergeable` 组装成skb。
5. `netif_receive_skb`上交协议栈
6. 发现Ring即将空了，再次`try_fill_recv`补充Page。

这其中有几个小问题可以作为补充：
1. 在所有的`receive_small`的内部的开始，都是XDP的代码。这是因为性能优化必须在skb分配之前进行拦截。
2. 在收包函数`virtnet_poll`中会调用`virtnet_poll_cleantx`（清理发包队列），这是一种顺便的优化，利用了CPU缓存热度，防止TX队列没人回收。
3. Host 处理完数据后，Guest 是怎么找回当初那个 `skb` 或 `page` 的？答案就是通过ID查找`desc_state` 数组。这就是**驱动上下文保存**的作用。