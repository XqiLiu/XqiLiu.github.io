---
categories:
  - dpdk
  - 基于DPDK的用户态RoCEv2协议栈原型
date: 2025-12-23T20:11:00
title: 第三章：实现一个Verbs Client
tags:
  - RDMA
---
我们可以借助这一章节，来系统学习一下RDMA Verbs的使用编程。
# RoCEv2的代码流程
RoCEV2的代码流程可以说是非常固定的：
1. 打开RDMA设备
2. 获取设备上下文
3. 资源分配：对获取到的`context`，创建PD、CQ、QP和注册MR
4. 连接建立：不同于TCP的`connect()`,rdma需要手动把QP的状态从**RESET**推到**INIT**，再到**RTR**，最后到**RTS**
5. 发送数据
6. 检查结果

# 使用libibverbs的Client程序设计

## 基础初始化
```C
struct resources {
    struct ibv_context *ctx;
    struct ibv_pd *pd;
    struct ibv_mr *mr;
    struct ibv_comp_channel *comp_chan;
    struct ibv_cq *cq;
    struct ibv_qp *qp;
    char *buf;
};
int main (){
	struct resources res;
	// 1. 获取设备
	int num_devices = 0;
	struct ibv_device **dev_list = ibv_get_device_list(&num_devices);
	struct ibv_device *ib_dev = find_device_by_name(dev_list, DEV_NAME);
	
	// 2. 打开设备获取上下文
    res.ctx = ibv_open_device(ib_dev);

    
    /* 创建完成通道，在任务完成时，软件有两种办法获知
    1. 轮询：程序循环不断地检查CQ，延迟低，占用100%CPU
    2. 事件通知，即本实现方式。通道本质封装了一个FD，之后可以使用poll、select、epoll等系统调用来监听这个通道。
    */
    res.comp_chan = ibv_create_comp_channel(res.ctx);
}
```
这一段就基本完成了设备等一系列工作。接下来下一段就开始涉及到了资源分配的事情。这里需要一些关于RDMA的基础知识，就不在此介绍，可以参考[RDMA技术](RDMA技术.md)
```C
int main() {
	// 创建 PD
	res.pd = ibv_alloc_pd(res.ctx);
	 /* 
		 创建完成通道，在任务完成时，软件有两种办法获知：
	    1. 轮询：程序循环不断地检查CQ，延迟低，占用100%CPU
	    2. 事件通知，即本实现方式。通道本质封装了一个FD，之后可以使用poll、select、epoll等系统调用来监听这个通道。
    */
    res.comp_chan = ibv_create_comp_channel(res.ctx);
    
    // 注册内存（MR）
    res.buf = malloc(DATA_SIZE);
    res.mr = ibv_reg_mr(res.pd, res.buf, DATA_SIZE, IBV_ACCESS_LOCAL_WRITE);
    // 创建 CQ & QP
    res.cq = ibv_create_cq(res.ctx, 10, NULL, res.comp_chan, 0);
    
    /*
	    这是创建Queue Pair的做法，需要填一个很长的结构体
    */
    struct ibv_qp_init_attr qp_init_attr;
    memset(&qp_init_attr, 0, sizeof(qp_init_attr));
    qp_init_attr.send_cq = res.cq;
    qp_init_attr.recv_cq = res.cq;// 发送和接收共用一个 CQ
    qp_init_attr.qp_type = IBV_QPT_RC; // Reliable Connected
    qp_init_attr.cap.max_send_wr = 10;// 发送队列最大深度
    qp_init_attr.cap.max_recv_wr = 10;// 接收队列最大深度
    qp_init_attr.cap.max_send_sge = 1;// Scatter/Gather 条目数
    qp_init_attr.cap.max_recv_sge = 1;
    res.qp = ibv_create_qp(res.pd, &qp_init_attr);
} 
```
自此就完成了全部需要注册的内容。
接下来开始学习RoCEv2的关键内容，即连接建立（也就是状态转换）
注意，在进行连接之前，必须通过其他方式，让双方交换信息，例如UDP、TCP等方式来交换GID、LID、QP Number等。
这里我们省略对于UDP的控制面流程，假设已经取到了对方的qp_num
```C
//init修改QP状态
int modify_qp_to_init(struct ibv_qp *qp) {
    struct ibv_qp_attr attr = {
        .qp_state = IBV_QPS_INIT,
        .pkey_index = 0,
        .port_num = 1, // 物理端口号
        .qp_access_flags = IBV_ACCESS_LOCAL_WRITE | IBV_ACCESS_REMOTE_READ | IBV_ACCESS_REMOTE_WRITE
    };
    // 掩码告诉驱动我们要修改哪些字段
    flags = IBV_QP_STATE | IBV_QP_PKEY_INDEX | IBV_QP_PORT | IBV_QP_ACCESS_FLAGS;
    return ibv_modify_qp(qp, &attr, flags);
}
//将 QP 迁移到 RTR (Ready to Receive)、
//在这里必须知道对方的信息
//RoCEv2必须填写AH（Address Handle）属性
int modify_qp_to_rtr(struct ibv_qp *qp, uint32_t guest_qp_num) {
	//GID实际上就是IP地址，这是之前UDP实现获取到的
	//先进性格式转换，GID是128位的IPv6格式，对于IPv4地址先进行转换
	snprintf(gid_str, sizeof(gid_str), "::ffff:%s", SERVER_IP);
	//使用标准的网络函数将字符串格式的 IP 转换为 `union ibv_gid` 结构体，这个 `dgid` 随后会被填入地址向量中
	inet_pton(AF_INET6, gid_str, &dgid)
	struct ibv_qp_attr attr = {
        .qp_state = IBV_QPS_RTR,
        .path_mtu = IBV_MTU_1024,
        .dest_qp_num = guest_qp_num,
        .rq_psn = 0, // Packet Sequence Number
        .max_dest_rd_atomic = 1,
        .min_rnr_timer = 12,
        .ah_attr = {
            .is_global = 1, // RoCEv2 必须是 Global
            .grh.dgid = remote_gid, // 对方的 GID (也就是 IP)
            .grh.sgid_index = 1,    // 本机的 GID index (对应网卡 IP)
            .grh.hop_limit = 1,
            .port_num = 1
        }
    };
    int flags = IBV_QP_STATE | IBV_QP_AV | IBV_QP_PATH_MTU | IBV_QP_DEST_QPN | 
                IBV_QP_RQ_PSN | IBV_QP_MAX_DEST_RD_ATOMIC | IBV_QP_MIN_RNR_TIMER; 
    return ibv_modify_qp(qp, &attr, flags);
}

int modify_qp_to_rts(struct ibv_qp *qp) {
	struct ibv_qp_attr attr = {
        .qp_state = IBV_QPS_RTS,
        .timeout = 14,
        .retry_cnt = 7,
        .rnr_retry = 7,
        .sq_psn = 0,
        .max_rd_atomic = 1
    };
    flags = IBV_QP_STATE | IBV_QP_TIMEOUT | IBV_QP_RETRY_CNT |
            IBV_QP_RNR_RETRY | IBV_QP_SQ_PSN | IBV_QP_MAX_QP_RD_ATOMIC;
    return ibv_modify_qp(qp, &attr, flags);
}
int main() {
	//...
	//状态机迁移 (RESET -> INIT -> RTR -> RTS)
	modify_qp_to_init(res.qp);
	modify_qp_to_rtr(res.qp, guest_qp_num);
	modify_qp_to_rts(res.qp);
	//...
}
```
这里即利用了之前的带外通信交换的QP Number和GID等信息，才能进行状态转换。连接建立，也就是双方都达到了RTS状态。
## 发送数据及接收
接下来就开始到了正式的工作代码，即发送数据：
```C
int main() {
	struct ibv_sge sge;
	sge.addr = (uintptr_t)buf;
	sge.length = 100; // 发送 100 字节
	sge.lkey = mr->lkey; // 钥匙
	
	// 定义发送请求 (Work Request)
	struct ibv_send_wr wr;
	memset(&wr, 0, sizeof(wr));
	wr.wr_id = 1; // 给这个操作起个 ID，方便在 CQ 里识别
	wr.sg_list = &sge;
	wr.num_sge = 1;
	wr.opcode = IBV_WR_SEND; // 操作类型：发送
	wr.send_flags = IBV_SEND_SIGNALED; // 告诉硬件：完成后在 CQ 产生一个完成条目
	struct ibv_send_wr *bad_wr;
	if (ibv_post_send(qp, &wr, &bad_wr)) {
	    fprintf(stderr, "Error posting send.\n");
	}
}
```
发出去不代表成功了，还需要去 CQ 里查结果。这里就有很多种方法来，这个取决于用户的设计模式。可以采用polling的方法，那么就一直使用一个循环来轮询就好，也可以用poll/epoll来实现一个事件驱动的CQ检查。例如：
```C
// 轮询 loop
do {
    // 尝试取出 1 个完成条目
    num_comp = ibv_poll_cq(cq, 1, &wc);
} while (num_comp == 0);
```
或者是实现的poll模式：
```C
pfd.fd = res.comp_chan->fd;
pfd.events = POLLIN;
for (int i = 0; i < pr; i++) {
	int pr = poll(&pfd, 1, timeout_ms);
	struct ibv_cq *ev_cq = NULL;
	void *ev_ctx = NULL;
	ibv_req_notify_cq(ev_cq, 0);
	//从channel中读取这个事件，清除中断状态
	ibv_get_cq_event(res.comp_chan, &ev_cq, &ev_ctx);
	ibv_ack_cq_events(ev_cq, 1);// 必须 ACK
	//重新 Arm CQ (为了下一次通知)
	ibv_req_notify_cq(ev_cq, 0);
	// 注意：因为中断可能有延迟，可能一次积压了好几个包，所以要循环读
	while (ibv_poll_cq(ev_cq, 1, &wc) > 0) {
		// 处理业务逻辑
		printf("Got packet! Opcode: %d\n", wc.opcode);
	}
}
```
这两种方法的选则，可以如下方式来：
- **高性能计算/AI训练/高频交易**：**必须用 Busy Polling (`while(1)`)**。用epoll的中断开销是不可接受的
- **存储网关/普通网络服务**：可以用 **Epoll**。如果你的应用大部分时间在空闲等待，不想让 CPU 空转烧电，就用 Epoll。
还有一个**折中方案 (Adaptive Polling)**： 先死循环轮询 50 微秒，如果没有数据，再切换成 Epoll 睡眠。这样既能抓住密集的流量，又能在空闲时省电。很多成熟的商业系统（如 SPDK）都是这么做的。



# 使用librdmacm的Client程序设计
我们在上一步的实现中，需要处理大量的寻址、握手与信息交换、状态机流转的步骤。这一部分可以采用`librdmacm`库来实现简单的维护。具体如下：
下例我们以 https://github.com/animeshtrivedi/rdma-example 所展示的例子来进行学习
这份代码封装的较好，以封装的顺序为脉络进行讲解：
```C
int main() {
	client_prepare_connection(&server_sockaddr);
	client_pre_post_recv_buffer();
	client_connect_to_server();
	client_xchange_metadata_with_server();
	client_remote_memory_ops();
	client_disconnect_and_clean();
}
```
注意，librdmacm和libibverbs中的流程顺序并不是完全的一一对应，但是所做的工作是完全一致的。
## 准备连接
我们首先来看`client_prepare_connection(&server_sockaddr)`内部的工作，由于示例程序中的设计方式是处理为线性同步，个人觉得不够优美，在此展示异步实现方案。
这个函数内部处理的流程可以对应为：
1. 打开设备
2. 获取上下文
3. 资源分配（部分）
4. 连接建立（准备阶段）

 ```C
 static int client_prepare_connection(struct sockaddr_in *s_addr)
{
	 // 1. 初始化
    cm_event_channel = rdma_create_event_channel();
    ret = rdma_create_id(cm_event_channel, &cm_client_id, 
			NULL,
			RDMA_PS_TCP);
	/* 这是第一个行为，解析IP，这个函数会瞬间返回
	 * 真正的结果会在 event loop中等待。*/
	ret = rdma_resolve_addr(cm_client_id, NULL, (struct sockaddr*) s_addr, 2000);
     
     // 接下来就是事件循环
    while (rdma_get_cm_event(cm_event_channel, &cm_event) == 0) {
	    switch (cm_event->event) {
		    case RDMA_CM_EVENT_ADDR_RESOLVED:
				//此时有了GID，但是还缺路由路径
				/*这个ack不是网络协议层面的ACK，它是库层面的资源回收函数，
				相当于free()*/
				rdma_ack_cm_event(cm_event);
				//触发第二部
				rdma_resolve_route(cm_client_id, 2000);
				break;
			case RDMA_CM_EVENT_ROUTE_RESOLVED:
				/* 此时路径已经连通，需要搭建硬件资源，
				* 具体内容就是:
				* PD -> CQ -> QP -> MR*/
				// 同理，需要释放资源
				rdma_ack_cm_event(cm_event);
				pd = ibv_alloc_pd(cm_client_id->verbs);
				io_completion_channel = 
					ibv_create_comp_channel(cm_client_id->verbs);
					client_cq = ibv_create_cq(cm_client_id->verbs 
					/* which device*/, 
					CQ_CAPACITY /* maximum capacity*/, 
					NULL /* user context, not used here */,
					io_completion_channel 
					/* which IO completion channel */, 
					0 /* signaling vector, not used here*/);
				//这里有qp_init_attr属性的配置，篇幅较长省略
				ret = rdma_create_qp(cm_client_id 
					/* which connection id */,
			       pd /* which protection domain*/,
			       &qp_init_attr /* Initial attributes */);
			    client_qp = cm_client_id->qp
			    /*在事件循环中，这里其实可以触发rdma_connect来完成发起握手了，
			      但在这个代码结构下还是直接返回，交给下一个函数来处理了*/
				return 0;
	    }
    }
      
 }
 ```
 这里的流程可以总结一下：
 - **打开设备 & 获取上下文**：在 `rdma_resolve_addr` 内部完成。它根据目标 IP 自动找到对应的 RDMA 网卡并绑定，之后你就可以通过 `cm_client_id->verbs` 直接拿到设备上下文。
- **资源分配**：函数内显式调用了 `ibv_alloc_pd`、`ibv_create_cq` 和 `rdma_create_qp`。
- **注意**：在 `libverbs` 中你需要手动枚举设备，而这里 `librdmacm` 帮你自动选好了。

## 用于连接的资源分配
这里在调用connect之前先完成注册一个很小的MR内存，用于接收第一次握手交换的信息，所以调用了`client_pre_post_recv_buffer()`
```C
static int client_pre_post_recv_buffer()
{
	int ret = -1;
	//注册一块很小的结构体，用来接收服务器发来的第一条元数据
	server_metadata_mr = rdma_buffer_register(pd,
			&server_metadata_attr,
			sizeof(server_metadata_attr),
			(IBV_ACCESS_LOCAL_WRITE));
	//...
	//把它挂到接受队列里
	ret = ibv_post_recv(client_qp /* which QP */,
		      &server_recv_wr /* receive work request*/,
		      &bad_server_recv_wr /* error WRs */);
	return 0;
}
```
这只用于第一次握手交换信息。建立连接后，双方都不知道对方的内存地址和RKey，所以标准动作是：
- **连接前**：双方都先 `post_recv` 一个小的结构体 Buffer。
- **连接后**：双方立刻把自己的大内存地址和 RKey `SEND` 给对方。
- **收到后**：双方拿到地址，之后的通信就可以全部改用 `RDMA WRITE/READ` 这种高效模式了。

## 建立连接
这里就接着之前的建立连接准备后，开始正式是建立连接：
```C
static int client_connect_to_server()
{
	// 建立连接
	ret = rdma_connect(cm_client_id, &conn_param);
	//这里是期望RDMA_CM_EVENT_ESTABLISHED事件，需要做成同步等待的方式，、
	//后续若不按照封装脉络来讲解，可以一并封装到while的事件触发循环中。
	process_rdma_cm_event(cm_event_channel, 
			RDMA_CM_EVENT_ESTABLISHED,
			&cm_event);
	//回收资源
	ret = rdma_ack_cm_event(cm_event);
}
```
- 自此就可以当作连接完全完成，之前的QP状态机转换（ **RESET -> INIT -> RTR -> RTS**），全部由`rdma_connect()` 内部自动完成。
- 它还处理了`libverbs`中最麻烦的带外数据交换（交换 QP 号、LID、GID 等），不需要我们自己写 Socket 去传这些信息了。这是我认为`librdmacm`最关键的作用的地方。

## 发送数据
这里的部分就已经是完全的`libibverbs`方式的消息发送了，但是这里依然有学习的价值，因为这里是RDMA编程中经典的一个模式，**通过SEND/RECV通道，来协商RDMA WRITE/READ 钥匙**。
```C
static int client_xchange_metadata_with_server() {
	// 准备Payload
	client_src_mr = rdma_buffer_register(pd,
			src,
			strlen(src),
			(IBV_ACCESS_LOCAL_WRITE|
			 IBV_ACCESS_REMOTE_READ|
			 IBV_ACCESS_REMOTE_WRITE));
	//准备metadata给第一个buffer，写好地址，长度，rkey
	client_metadata_attr.address = (uint64_t) client_src_mr->addr; 
	client_metadata_attr.length = client_src_mr->length; 
	client_metadata_attr.stag.local_stag = client_src_mr->lkey;// 注意：这里通常发 rkey 给对方
	// 上面是控制数据，下面才是数据，它不需要通过SEND发送，
	//而是准备好，等对方READ读或WRITE直接塞进来
	client_metadata_mr = rdma_buffer_register(pd,
			&client_metadata_attr,
			sizeof(client_metadata_attr),
			IBV_ACCESS_LOCAL_WRITE);
	/* now we fill up SGE */
	client_send_sge.addr = (uint64_t) client_metadata_mr->addr;
	client_send_sge.length = (uint32_t) client_metadata_mr->length;
	client_send_sge.lkey = client_metadata_mr->lkey;		
	//准备好数据流后，把对应的信息也填好后发送
	bzero(&client_send_wr, sizeof(client_send_wr));
	client_send_wr.sg_list = &client_send_sge;
	client_send_wr.num_sge = 1;
	client_send_wr.opcode = IBV_WR_SEND;
	client_send_wr.send_flags = IBV_SEND_SIGNALED;
	ret = ibv_post_send(client_qp, 
		       &client_send_wr,
	       &bad_client_send_wr);
	//之后都一样了，用不同模式读取CQ
}
```
支持就完成了一个标准RDMA client工作流程。
这里看起来有点绕，有许多变量，所以做出额外总结解释：
- **准备数据源 (Payload)**: `[大块数据内存 (Src)]` -> (提取地址/Key) -> `[metadata_attr 结构体]`
- **授权网卡访问 (Registration)**: `[metadata_attr 结构体]` -> `ibv_reg_mr()` -> `[client_metadata_mr (网卡句柄)]`
- **填写硬件指针 (SGE)**: `client_send_sge.addr` = `&metadata_attr` `client_send_sge.length` = `sizeof(metadata_attr)` `client_send_sge.lkey` = `client_metadata_mr->lkey` (这是网卡读 `metadata_attr` 的钥匙)
- **填写任务单 (WR)**: `client_send_wr.opcode` = `SEND` `client_send_wr.sg_list` = `&client_send_sge` (指向上面填好的指针)
- **提交任务**: `ibv_post_send(qp, &client_send_wr)` -> 网卡开始工作