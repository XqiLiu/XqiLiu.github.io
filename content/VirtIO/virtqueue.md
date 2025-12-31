---
title: virtqueue
categories: VirtIO
date: 2025-10-24T15:15:00
---
每个virtqueue由三个物理上连续的部分组成：
1. 描述符表（Descriptor Table）
2. 可用环（Available Ring）
3. 已用环（Used Ring）

# virtiov1.0
## Descriptor Table
描述符表是**驱动程序**用于设备的**缓冲区**。是一个大数组，数组里的每一项是`struct virtq_desc`。

```C
struct virtq_desc { 
	/* Address (guest-physical). */ 
	le64 addr; 
	/* Length. */ 
	le32 len; 
	/* This marks a buffer as continuing via the next field. */ 
	
	/* The flags as indicated above. */ 
	le16 flags; 
	/* Next field if flags & NEXT */ 
	le16 next;
	}
```
- `addr`是一个物理地址，缓冲区可以通过next链接起来。每个描述符对应一个缓冲区，这个缓冲区只能是只读或只写的。但是描述符链可以有多个描述符。
- `len`是缓冲区的长度
- `flags`**非常重要**，有两个关键标志位：
	- `VIRTQ_DESC_F_NEXT` (1): 表示这个描述符“链接”到下一个描述符，形成一个“链”。 这就是实现**分散-收集 (Scatter-Gather) I/O** 的方式（例如，一个网络包的“包头”和“包体”可以放在两个不同的缓冲区中，用这个标志链接起来）。
	- `VIRTQ_DESC_F_WRITE` (2): 表示这个缓冲区是“设备可写”的（如网卡**接收**缓冲区）。如果没设置，则缓冲区是“设备可读”的（如网卡**发送**缓冲区）。

## Available Ring
可用环是**驱动**用来为它的设备提供可用缓冲区（链）通知的。他的结构是这个样子的：
```C
struct virtq_avail { 
#define VIRTQ_AVAIL_F_NO_INTERRUPT 1 
	le16 flags; 
	le16 idx; 
	le16 ring[ /* Queue Size */ ]; 
	le16 used_event; /* Only if VIRTIO_F_EVENT_IDX */ 
};

```
这里的`idx`指示驱动程序将下一个描述符条目放在环中的位置，idx从0开始增长。
工作流程：
- 驱动在“描述符表”里准备好一个描述符（或一个描述符链）。
- 驱动把这个链的**第一个描述符的索引 (id)** 写入到 `avail->ring[]` 数组中。
- 驱动更新 `avail->idx` 计数器，让设备可以看到这个新条目。
所有权：驱动写入，设备读取。
**中断抑制：**
`used_event`可以提供一种不可靠的通知机制，来告知设备在驱动缓冲区时不希望中断（interrupt），但由于与设备不是同步的，所以不可靠，但可以作为一种有效的优化手段。
## Used Ring
已用环是**设备**在使用完缓冲区后返回缓冲区（buffers）的地方，只能被设备写，被驱动读。设计结构如下：
```C
struct virtq_used { 
#define VIRTQ_USED_F_NO_NOTIFY 1 
	le16 flags; 
	le16 idx; 
	struct virtq_used_elem ring[ /* Queue Size */]; 
	le16 avail_event; /* Only if VIRTIO_F_EVENT_IDX */ 
};
```
工作流程：
- 设备处理完一个缓冲区
- 设备把这个缓冲链的第一个描述符的索引（id）写入到used->ring[]数组中。
- 设备同时会写入`len`，表示它往这个缓冲区里实际写了多少字节。
- 设备更新used->idx计数器
- 设备向驱动发送一个中断来通知驱动。

所有权： 设备写入，驱动读取。
通知抑制：
可以在`used->flags`中设置`VIRTQ_USED_F_NO_NOTIFY`来告诉驱动，当完成缓冲区的使用不要**Kick**（notify）设备。

## Interrupt and Notify 
结合上述的中断移植：**Interrupt**是设备到驱动的打断，**Notify**是驱动到设备的打断。
- Notify是在驱动的`avail->idx`更新后，告知设备有新工作
- Interrupt是设备在`used->idx`更新后，通知去驱动回收缓冲区。
所以上述中两个动作都设置了抑制特性。
**`VIRTIO_F_EVENT_IDX` (进阶)：** 这是一个更高级的特性 ，它启用了 `avail_event` 和 `used_event` 字段 。这允许驱动说“_直到_ `used->idx` 达到 100 时才中断我”，或者设备说“_直到_ `avail->idx` 达到 50 时才踢我”。 这是现代 `vhost` 实现高性能的关键。

## 高性能分析
Vring的高性能原因就是因为virtqueue本身是一个无锁的高性能队列。
 Virtqueue本质上是一个SPSC模型（单生产者单消费者）
 对于Avail Ring来说，**Guest只管“写”**，**Host只管“读”**。他们不会同时去竞争读取同一个位置来处理任务。
 Guest的角度来看：
 1. 看上次的idx来判断写到哪里，而不需要读`avail->idx`来得知。
 2. 把新请求填入idx+1的位置
 3. 把idx改写，这一过程只需要维护自己idx状态，而不需要“消费”（读取`avail ring`）对方的数据
 4. 通知对方，Guest通知Host往往采用`ioeventfd`[[通信机制：ioeventfd和irqfd]]
 
 Host的角度来看：
 
 5. Host读取`avail->idx`，发现比上次自己记录的`last_avail_idx`，得知有新请求。
 6. Host根据描述符读取并处理数据
 7. 处理完后，将描述符所你填入Used Ring
 8. Host更新`used->idx`
 9. 通知对方，Host通知Guest往往采用`irqfd`
 
 接下来回到了Guest：
 
 1. Guest收到终端，读取`used->idx`
 2. Guest 维护一个本地的 `last_used_idx`，它读取共享内存的 `used->idx`，对比自己的 `last_used_idx`，算出有多少请求处理完了，然后释放内存，回调上层应用
# virtio v1.1
在virtqueue v1.0版本中有两个较大的缺陷：
- Descriptor Table、Available Ring、Used Ring三者是独立存储的，并且三者都需要进行不停的读写。这会导致Cache Miss高，对于高性能网卡来说，性能浪费严重。
- 对于PCIe总线通信的设备，Split VQ需要多次PCIe读取才能获取完整的请求信息，不够紧凑。
针对于这两点缺陷，**Packed Virtqueues**引入革命性的变化：**将原来分散的三个内存区域合并为一个紧凑的环形数组**。
## v1.1执行流程概述
我们目前已经有了v1.0的基础，最好的学习方式便是对比v1.0的split模式：
**在Guest的角度出发：**
1. v1.0：
	- 确定写在哪里，需要查看Guest（驱动）自己本地维护递增`idx`
	- 将消息填入Desc表，同时写avail Ring，也就是将`Desc`中的Index填入
	- 更新共享内存的`avail->idx`，用于通知对方（这里需要内存屏障保证先在`desc`写好内容再更新avail中的索引）
2. v1.1：
	- 确定写在哪里，依靠Guest维护一个本地指针`next_off`
	- 直接在`Descriptor_Ring[next_off]`填入数据（这里也会把特定的翻转标记位填入到这个数据结构中）。
	- 不需要更新任何`idx`标记，因为填数据的时候就已经算作是更新了
二者在完成填写工作后，通知的方式都是一样的，通过`Kick`，即`ioeventfd`[[通信机制：ioeventfd和irqfd]]通知。

**在Host的角度出发：**
1. v1.0
	- 读avail->idx，跟自己的`last_avail_idx`做比较
	- **跳跃**读取Desc表（这个就是split比起pakced的一个劣势，Cache Missed几乎一定会发发生）
	- 将写回的结果依然写入空闲的Desc表项，并把idx写入到`Used Ring`。
	- 更新`Used->idx`
2. v1.1
	- Host去看`Descriptor_Ring[host_next_off]` 这个位置的描述符。
		- 去检查`Flags.AVAIL = = Device_Wrap_Counter`：来判断是否是新数据，否则等待睡觉
	- **直接读**取Descriptor（放一起了）
	- **原地覆写**，并设置标志位
	- 同样不需要更新任何idx。
## vring_packed_desc 
Linux内核为了复用代码，将主要的逻辑全部写在同一文件下`virtio_ring`:
```C
//引入的 事件抑制（） 结构体
struct vring_packed_desc_event {
	/* Descriptor Ring Change Event Offset/Wrap Counter. */
	__le16 off_wrap;
	/* Descriptor Ring Change Event Flags. */
	__le16 flags;
};
struct vring_packed_desc {
	/* Buffer Address. */
	__le64 addr;
	/* Buffer Length. */
	__le32 len;
	/* Buffer ID. */
	__le16 id;
	/* The flags depending on descriptor type. */
	__le16 flags;//这个是核心，Avail/Used翻转位就在这里
};
```
在Packed Virtquque中，不再有avail ring和used ring之分了。所需要的数据结构就是非常简洁的。

而pakced模式与split主要的区别需要从使用中进行对比观察才可以更好的了解。所以接下来我们的工作主要是进行行为的对比。
例如[[virtnet网络包发包#xmit_skb]]这一章节中所描述的就是`virtquque_add_split`。主要工作是把数据放入共享内存中并移交所有权。这一行为被解耦的很好。我们来看对比v1.1下的方法`virtqueue_add_packed`：
```C
static inline int virtqueue_add_packed(struct virtqueue *_vq,
				       struct scatterlist *sgs[],
				       unsigned int total_sg,
				       unsigned int out_sgs,
				       unsigned int in_sgs,
				       void *data,
				       void *ctx,
				       gfp_t gfp)
```

我们之前有一个浅显的v1.1的工作概念。这里开篇就展示了有个v1.1和v1.0在之前没有提到过的实现差异：
Packed模式在写入的时候采用的是 **线性平铺** + **状态翻转**，而Split采用的是 **链式跳跃** + **索引管理**
之前从来没有提到过这个线性平铺和链式跳跃的问题：

**Packed VQ的线性平铺：**
- 本质上是一个环形缓冲区（Ring buffer）+ 数组管理
- Cache极其友好，可以顺序预取，硬件实现简单
- 缺点是依赖Indirect Descriptor来处理复杂的Scatter-Gather，否则会有比较严重的碎片问题（但是内存较大的话可以尽可能减小这个代价）
**传统Split VQ的链式跳跃：**
- 本质上是一个内存池（Memory Pool）+ 链表管理
- 完美支持乱序回收，内存利用率高，无碎片
- 缺点就是Cache极其不友好，所以在高性能场景已经被放弃。
### 空闲块的使用
1. 在Split模式下，描述符不是线性使用的，而是散落在Descriptor Table中，通过`next`指针练成一个空闲链表。这也致使了**空间局部性较差**。
	1. 根本原因是Scatter-Gather I/O：网络包或者磁盘写入，本身就是不连续的。既然物理内存本身不连续，那么Desc Table也没必要连续。那么就维护空闲链表来管理碎片化的空位
	2. 核心限制是乱序完成。导致可能没办法线性供给新请求使用顺序较低的desc table。而Virtio诞生于2008年，当时内存比较金贵，所以设计模式都偏向于紧凑设计
2. 在packed模式下，舍弃了这种空闲链表来维护碎片化空位的方式。因为高性能网络下，这种空间局部性差导致的高Cache Miss是更不可接受的。
	1. desc ring中的使用顺序永远是线性递增的，
	2. Packed Ring引入 **ID** 字段。Driver不需要靠Slot索引来判断哪个请求完成了，而是依靠Descrptor里的ID。即时Slot2先完成，Driver可以依然在第一个desc中直接覆写结果并用来回执，只需要填好ID即可
	3. 如果采用Indirect模式，那么2点也可以省略了。

# 问题
1. avail ring是如何进行“所有权”转接给设备的。为什么不在avail ring中的内存，设备是无法读取的。
	- **所有权转移机制**：
	    - 这是基于**共享内存**的软件协议。
	    - 动作：`avail->idx++`（发布索引）。
	    - 原理：**发布即移交**。驱动程序通过逻辑约束，保证发布后不再触碰该缓冲区，直到 Host 归还。
	- **实现方式**：
	    - 全靠**软件读写内存值** + **内存屏障（Memory Barrier）**。
	    - 内存屏障保证了“填好 Desc”发生在“发布 Avail Index”之前，确保 Host 看到索引时，数据已经是准备好的。