---
categories:
  - VirtIO
  - virtio-net
tags:
  - virtio
  - net
title: virtnet的初始化工作
---

作为一个`dirver`。初始构造工作肯定是看`probe`。我们来看`virtnet_probe`的工作，probe在初期的工作是大量比对上一章节的特性位并做出设置。在此不再赘述。核心代码：
```C
static int virtnet_probe(struct virtio_device *vdev) {
	err = init_vqs(vi);
}

static int init_vqs(struct virtnet_info *vi)
{
	int ret;

	/* Allocate send & receive queues */
	ret = virtnet_alloc_queues(vi);
	if (ret)
		goto err;

	ret = virtnet_find_vqs(vi);
	if (ret)
		goto err_free;

	cpus_read_lock();
	virtnet_set_affinity(vi);
	cpus_read_unlock();

	return 0;

err_free:
	virtnet_free_queues(vi);
err:
	return ret;
}
```


# init_vqs
首先解析的就是`init_vqs`，它是用来初始化virtqueue的，也是这一套工作机制的核心。其中virtnet_alloc_queues是在软件层面进行做出的准备工作，给自己的驱动分配好NAPI [[NAPI]]和内存，并没有真正的去和Host（QEMU）去申请出共享内存（Vring）。


```C
static int virtnet_alloc_queues(struct virtnet_info *vi)
{
	int i;

	if (vi->has_cvq) {
		vi->ctrl = kzalloc(sizeof(*vi->ctrl), GFP_KERNEL);
	} 
	vi->sq = kcalloc(vi->max_queue_pairs, sizeof(*vi->sq), GFP_KERNEL);
	vi->rq = kcalloc(vi->max_queue_pairs, sizeof(*vi->rq), GFP_KERNEL);

	INIT_DELAYED_WORK(&vi->refill, refill_work);
	for (i = 0; i < vi->max_queue_pairs; i++) {
		vi->rq[i].pages = NULL;
		netif_napi_add_weight(vi->dev, &vi->rq[i].napi, virtnet_poll,
				      napi_weight);
		netif_napi_add_tx_weight(vi->dev, &vi->sq[i].napi,
					 virtnet_poll_tx,
					 napi_tx ? napi_weight : 0);
	}
	return 0;
	return -ENOMEM;
```
这段代码留下了核心工作，分配send_queue和receive_queue的结构体初始化，并且申请和了NAPI，为每个队列都注册了轮询机制Poll。[[virtnet网络包发包]][[Virtnet收包过程]]。
这里的NAPI既有rq（RX），又有sq（TX），是因为在发包的过程中也会有设备的回执，来让驱动回收内存[[virtnet网络包发包]]。在收包的过程中就是处理网卡的批量入站流量[[Virtnet收包过程]]。

# 绑定virtqueue与Guest的内存队列rx、tx
第二步的核心代码就是将刚才初始化的结构体和virtqueue进行绑定：
```C
static int virtnet_find_vqs(struct virtnet_info *vi)
{	
	vqs_info = kcalloc(total_vqs, sizeof(*vqs_info), GFP_KERNEL);
	
	/* Allocate/initialize parameters for send/receive virtqueues */
	for (i = 0; i < vi->max_queue_pairs; i++) {
		vqs_info[rxq2vq(i)].callback = skb_recv_done;
		vqs_info[txq2vq(i)].callback = skb_xmit_done;
		sprintf(vi->rq[i].name, "input.%u", i);
		sprintf(vi->sq[i].name, "output.%u", i);
		vqs_info[rxq2vq(i)].name = vi->rq[i].name;
		vqs_info[txq2vq(i)].name = vi->sq[i].name;
		if (ctx)
			vqs_info[rxq2vq(i)].ctx = true;
	}

	ret = virtio_find_vqs(vi->vdev, total_vqs, vqs, vqs_info, NULL);
	
	for (i = 0; i < vi->max_queue_pairs; i++) {
	vi->rq[i].vq = vqs[rxq2vq(i)];
	vi->rq[i].min_buf_len = mergeable_min_buf_len(vi, vi->rq[i].vq);
	vi->sq[i].vq = vqs[txq2vq(i)];
	}
	/* run here: ret == 0. */

	return ret;
}
```
这里注册了两个重要的回调函数`skb_recv_done`和`skb_xmit_done`
`skb_recv_done`（RX回调）
- 当Host往RX队列里塞了数据包，并处罚中断时，这个函数就会被调用。
- 工作内容：唤醒之前注册的NAPI（`virtqueue_napi_schedule`）。
`skb_xmit_done` (TX 回调)
- 当Host处理完了队列里的包，并触发中断时，这个函数会被调用。
- 工作内容：唤醒TX NAPI，去回收内存。

这一段代码接下来的最重要的内容就是`virtio_find_vqs`
```C
int virtio_find_vqs(struct virtio_device *vdev, unsigned int nvqs,
		    struct virtqueue *vqs[],
		    struct virtqueue_info vqs_info[],
		    struct irq_affinity *desc)
{
	return vdev->config->find_vqs(vdev, nvqs, vqs, vqs_info, desc);
}
```
这一段代码：
1. Guest驱动通过了PCI总线（某些设备可能是MMIO）告诉了HOST（QEMU）：启用对应的virtqueue
2. HOST在自己的内存空间为这些virtqueue分配资源
3. HOST将这些队列的物理覅之映射给Guest
4. 最终底层会返回一组初始化好的struct virtquque * 指针,填入vqs数组中

跳出该函数回到上层,接下来的for循环
```C
	for (i = 0; i < vi->max_queue_pairs; i++) {
		vi->rq[i].vq = vqs[rxq2vq(i)];
		vi->rq[i].min_buf_len = mergeable_min_buf_len(vi, vi->rq[i].vq);
		vi->sq[i].vq = vqs[txq2vq(i)];
	}
```
这一部分代码在将上一步填入vqs的virtqueue的指针,挂载到驱动自己的sq和rq上去。

到这里为止，经过了通用网络层 (virtnet_probe)->驱动软件层 (virtnet_alloc_queues)->Virtio 协议适配层 (virtnet_find_vqs)->抽象接口层 (virtio_find_vqs)->PCI 传输策略层 (vp_find_vqs)->硬件资源实现层 (vp_find_vqs_msix)
根据功能协商，处理完软件层面的内存分配，申请创建好virtqueue的物理队列。建立起链接。最后向Linux内核申请具体的中断向量号，吧队列对的内存地址，分配到的中断号，通过PCI寄存器写入硬件，从而建立起了Guest和Host之间的**共享内存通道（Virtqueue）** 和 **通知机制**。

