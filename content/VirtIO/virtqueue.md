---
title: virtqueue
categories: VirtIO
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
已用环是设备在使用完缓冲区后返回缓冲区（buffers）的地方，只能被设备写，被驱动读。设计结构如下：
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
 1. 看一样上次的idx来判断写到哪里，而不需要读`avail->idx`来得知。
 2. 把新请求填入idx+1的位置
 3. 把idx改写，这一过程只需要维护自己ide状态，而不需要“消费”（读取`avail ring`）对方的数据
 4. 通知对方，Guest通知Host往往采用`ioeventfd`[[通信机制：ioeventfd和irqfd]]
 
 Host的角度来看：
 
 5. Host读取`avail->idx`，发现比上次自己记录的`last_avail_idx`，得知有新请求。
 6. Host根据描述符读取并处理数据
 7. 处理完后，将描述符所你填入Used Ring
 8. Host更新`used->idx`
 9. 通知对方，Host通知Guest往往采用`irqfd`

# virtiov1.1



# 问题
1. avail ring是如何进行“所有权”转接给设备的。为什么不在avail ring中的内存，设备是无法读取的。
	- **所有权转移机制**：
	    - 这是基于**共享内存**的软件协议。
	    - 动作：`avail->idx++`（发布索引）。
	    - 原理：**发布即移交**。驱动程序通过逻辑约束，保证发布后不再触碰该缓冲区，直到 Host 归还。
	- **实现方式**：
	    - 全靠**软件读写内存值** + **内存屏障（Memory Barrier）**。
	    - 内存屏障保证了“填好 Desc”发生在“发布 Avail Index”之前，确保 Host 看到索引时，数据已经是准备好的。