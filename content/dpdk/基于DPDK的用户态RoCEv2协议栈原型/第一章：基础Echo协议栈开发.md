---
title: 第一章：基础Echo协议栈开发
date: 2025-12-16T20:38:00
tags:
  - dpdk
  - net
  - RDMA
categories:
  - dpdk
  - 基于DPDK的用户态RoCEv2协议栈原型
---
# ARP包回显处理
## 什么是arp包
在计算机网络中，可能教学考试的内容主要是tcp、udp、ipv4等协议，而对ARP则是一笔带过。
但是这个是网络中非常基础的Layer 2协议。
`ether_type`变量是以太网帧头中的最后两个字节，它的作用非常简单：**告知接收方，数据帧里装的是什么上层协议**
常见的`ether_type`值有如下几种：
- `0x0806`：**(RTE_ETHER_TYPE_ARP)**: **ARP 协议**。这个是用来询问MAC地址的（可以理解为一个广播的问路消息，也是这一章节的所实现的）
- **`0x0800` (RTE_ETHER_TYPE_IPV4)**: **IPv4 协议**。这是最常见的包，里面装着 IP 头、TCP/UDP 头以及相应的业务数据（比如 SSH、网页、视频流）。
- **`0x86DD` (RTE_ETHER_TYPE_IPV6)**: **IPv6 协议**。下一代 IP 协议。
- **`0x8100` (RTE_ETHER_TYPE_VLAN)**: **VLAN 标记**。表示这个包带了 VLAN ID。

**ARP (Address Resolution Protocol)** 的核心作用是：**把 IP 地址（逻辑地址）翻译成 MAC 地址（物理地址）。**

**为什么需要翻译呢？**
- IP 地址在更底层中的网络相当于一种简称，方便人类和软件记忆
- MAC 地址则是交换机和网卡锁使用的具体地址。
当Host想给Guest发送UDP包时，Host知道虚拟机的IP是`192.168.122.200`，但是不知道虚拟机的网卡MAC地址是多少。不知道MAC地址，数据包就封装不起来。
所以ARP Request就会在局域网内进行广播，期待询问`192.168.122.200`是哪一台主机。这就需要我们Host的DPDK程序可以接收到ARP包后回传自己的MAC地址。

所以如果需要处理UDP协议栈，需要先处理好ARP请求，否则host会认为完了过不通，不会发出后续的UDP包。

## ARP协议实现
由于这里是初始阶段，所以首先构造DPDK程序的基础设计
DPDK的程序的基础框架
```C
int main(int argc, char *argv[]) {
	//初始化EAL
	int ret = rte_eal_init(argc, argv);
	//初始化可用port数量（并不是socket中的port）
	nb_ports = rte_eth_dev_count_avail();
	//创建mbuf_pool
	mbuf_pool = rte_pktmbuf_pool_create("MBUF_POOL", NUM_MBUFS * nb_ports, MBUF_CACHE_SIZE, 0, RTE_MBUF_DEFAULT_BUF_SIZE, rte_socket_id());
	//构造好rx，tx queue并绑定到对应的port上，之后启动对应port的设备
	port_init(port_id, mbuf_pool)；
	while(1) {
		//接收网络包数据
		 const uint16_t nb_rx = rte_eth_rx_burst(port_id, 0, bufs, BURST_SIZE)
		 for(int i=0; i< nb_rx; i++) {
			 //接受数据，并根据类型来处理。
			 struct rte_ether_hdr * eth_hdr = rte_pktmbuf_mtod(bufs[i], struct rte_ether_hdr *);
                    uint16_t eth_type = rte_be_to_cpu_16(eth_hdr->ether_type);
	        //例如ARP的话实现可以增加如下类型判断
	        if (eth_type == RTE_ETHER_TYPE_ARP) {
                        handle_arp(bufs[i], eth_hdr);
			}
			else {
				rte_pktmbuf_free(bufs[i]);
			}
		}
	}
}
```

其中的`port_init`实现可以参考，具体围绕检查合法性、全局配置、调整描述数量、配置RX/TX队列、启动设备的步骤，不再赘述：
```C
static inline int port_init(uint16_t port, struct rte_mempool *mbuf_pool) {
    struct rte_eth_conf port_conf = {
        .rxmode = {
            .max_lro_pkt_size = RTE_ETHER_MAX_LEN,
        }
    };
    uint16_t nb_rxd = RX_RING_SIZE;
    uint16_t nb_txd = TX_RING_SIZE;
    const uint16_t rx_rings = 1, tx_rings = 1;
    int retval;
    struct rte_eth_dev_info dev_info;
    struct rte_eth_txconf tx_conf;
    if (!rte_eth_dev_is_valid_port(port))
        return -1;
    retval = rte_eth_dev_info_get(port, &dev_info);
    if (retval != 0)
        return retval;
    
    if (dev_info.tx_offload_capa & RTE_ETH_TX_OFFLOAD_MBUF_FAST_FREE)
        port_conf.txmode.offloads |= RTE_ETH_TX_OFFLOAD_MBUF_FAST_FREE;
    
    retval = rte_eth_dev_configure(port, 1, 1, &port_conf);
    if (retval != 0)
        return retval;
    retval = rte_eth_dev_adjust_nb_rx_tx_desc(port, &nb_rxd, &nb_txd);
    if (retval != 0)
        return retval;
    for (int q = 0; q < rx_rings; q++) {
        retval = rte_eth_rx_queue_setup(port, q, nb_rxd,rte_eth_dev_socket_id(port_id), NULL, mbuf_pool);
        if (retval != 0)
            return retval;
    }
    tx_conf = dev_info.default_txconf;
    tx_conf.offloads =     port_conf.txmode.offloads;
    for (int q = 0; q < tx_rings; q++) {
        retval = rte_eth_tx_queue_setup(port, q, nb_txd,
                                        rte_eth_dev_socket_id(port), &tx_conf);
        if (retval != 0)
            return retval; 
        }
    retval = rte_eth_dev_start(port);
    if (retval != 0)
        return retval;
    rte_eth_promiscuous_enable(port);
    return 0;
    
}
```
接下来是handle_arp的程序开发：
```C
void handle_arp(struct rte_mbuf *mbuf, struct rte_ether_hdr *eth_hdr) {
    struct rte_arp_hdr *arp_hdr;
    // ARP的包刚好是在以太帧后面，所以指针+1来跳过一个以太帧的大小就是arp的数据。
    arp_hdr = (struct rte_arp_hdr *)(eth_hdr + 1);
    if (rte_be_to_cpu_16(arp_hdr->arp_opcode) != RTE_ARP_OP_REQUEST) {
        rte_pktmbuf_free(mbuf);
        return;
    }

    if (arp_hdr->arp_data.arp_tip != my_ip) {
        rte_pktmbuf_free(mbuf);
        return;
    }
    printf("Received ARP request for our IP. Sending ARP reply.\n");
    //这里开始包装要发送的arp reply
    arp_hdr->arp_opcode = rte_cpu_to_be_16(RTE_ARP_OP_REPLY);
	//标注的echo恢复处理，交换src_addr和dst_addr，首先是需要交换arp帧头的收发地址
    rte_ether_addr_copy(&arp_hdr->arp_data.arp_sha, &arp_hdr->arp_data.arp_tha);
    arp_hdr->arp_data.arp_tip = arp_hdr->arp_data.arp_sip;
    rte_ether_addr_copy(&mac_addr, &arp_hdr->arp_data.arp_sha);
    arp_hdr->arp_data.arp_sip = my_ip;
    //再来一遍，这是给交换器用的，用户看不到，所以需要再继续修改以太帧的收发地址
    rte_ether_addr_copy(&eth_hdr->src_addr, &eth_hdr->dst_addr);
    rte_ether_addr_copy(&mac_addr, &eth_hdr->src_addr);
    uint16_t nb_tx = rte_eth_tx_burst(port_id, 0, &mbuf, 1);
    if (nb_tx < 1) {
        rte_pktmbuf_free(mbuf);
        printf("Failed to send ARP reply\n");
    } else {
        // rte_eth_tx_burst 成功发送后，mbuf 已经被网卡使用，不能再 free 了
        printf("ARP reply sent\n");
    }
}
```
# ICMP层处理
## ICMP协议是什么
**全称**：Internet Control Message Protocol（互联网控制消息协议），**不传输用户数据**，而是用于**报告错误**和**诊断网络状况**。
ICMP是3层协议，但是ICMP的发出也是需要寄生于同层的ipv4协议里。
所以虽然ICMP是3层协议，但是和UDP都是类似于，并列的处于ipv4内部的发送处理。

## ICMP协议层的实现
我们可以在main函数中的循环中增加一个判断逻辑
```C
	
	if (eth_type == RTE_ETHER_TYPE_ARP) {
		handle_arp(bufs[i], eth_hdr);
	}
	//这个是我们新增的一层判断：判断是否是IPV4
	else if (eth_type == RTE_ETHER_TYPE_IPV4) {
		handle_ipv4(bufs[i], eth_hdr);
	}
	else {
		rte_pktmbuf_free(bufs[i]);
	}
```
因为ICMP我们是放在ipv4中处理，所以我们进一步优先实现handle_ipv4的处理：
```C
void handle_ipv4(struct rte_mbuf *mbuf, struct rte_ether_hdr *eth_hdr) {
    struct rte_ipv4_hdr * ipv4_hdr;
    //同样是相似的地址偏移处理方法，偏移以太帧的长度
    ipv4_hdr = (struct rte_ipv4_hdr *) (eth_hdr + 1);
    //判断目标IP是否是当前的ip，否则搁置不处理。
    if (ipv4_hdr->dst_addr != my_ip) {
        rte_pktmbuf_free(mbuf);
        return;
    }
    //我们在这里处理icmp，包装一层handle_icmp，以后的udp等协议则是新增一个分支
    if (ipv4_hdr->next_proto_id == IPPROTO_ICMP) {
        handle_icmp(mbuf, ipv4_hdr);
    }
    else {
    //注意，当不处理消息时，一定要释放mbuf。
        rte_pktmbuf_free(mbuf);
        return;
    }
}    
```

这里就是ICMP协议的真正的处理方法，与ARP类似，我们这里只处理`ping`命令的回复。所以交换收发的以太帧地址和ipv4地址。但是这里需要主力ICMP校验和需要重新计算，具体如下代码：
```C
void handle_icmp(struct rte_mbuf *mbuf, struct rte_ipv4_hdr *ipv4_hdr) {
	//ICMP的地址在ipv4帧头后面，所以偏移ipv4帧头距离即可
    struct rte_icmp_hdr * icmp_hdr =  (struct rte_icmp_hdr *) (ipv4_hdr +1);
    //这里我们只处理Echo  Request，所以其余类型先抛弃。后续封装为多个分支即可
    if (icmp_hdr->icmp_type != RTE_IP_ICMP_ECHO_REQUEST) {
        rte_pktmbuf_free(mbuf);
        return;
    }
    printf("ICMP Echo Request received! Pinging back...\n");

    icmp_hdr->icmp_type = RTE_IP_ICMP_ECHO_REPLY;
    // 重新计算ICMP的校验和
    icmp_hdr->icmp_cksum = 0;
    icmp_hdr->icmp_cksum = checksum(icmp_hdr,mbuf->pkt_len - sizeof(struct rte_ether_hdr) - sizeof(struct rte_ipv4_hdr));
    
    uint32_t temp_ip = ipv4_hdr->src_addr;
    ipv4_hdr->src_addr = ipv4_hdr->dst_addr;
    ipv4_hdr->dst_addr = temp_ip;
    //重新计算ip校验和
    ipv4_hdr->hdr_checksum = 0;
    ipv4_hdr->hdr_checksum = rte_ipv4_cksum(ipv4_hdr);

    struct rte_ether_hdr*  eth_hdr = rte_pktmbuf_mtod(mbuf, struct rte_ether_hdr*);
    rte_ether_addr_copy(&eth_hdr->src_addr, &eth_hdr->dst_addr);
    rte_ether_addr_copy(&mac_addr, &eth_hdr->src_addr);

    uint16_t nb_tx = rte_eth_tx_burst(port_id, 0, &mbuf, 1);
    if (nb_tx < 1) {
        rte_pktmbuf_free(mbuf);
        printf("Failed to send ICMP Echo Reply\n");
    }
```
## ICMP协议实现效果：
现在的的dpdk程序就可以正常的ping通：
Host侧：
![](dpdk_ping.png)
Guest(DPDK)侧：
![](dpdk_guest_ping.png)

# UDP消息echo处理
## UDP协议是什么
UDP协议是绝大多数的计算机专业人都耳熟能详的协议，也是RoCEv2区别于其它RDMA协议的关键差异之一：即RoCEv2中引入了IP和UDP协议，使得RDMA流量可以**跨越路由器**（三层协议），从而支持超大规模的数据中心网络。

这里再复习一下UDP的关键特性：
- **无连接 (Connectionless)：** 发送数据前不需要建立连接（没有三次握手）。
- **不可靠 (Unreliable)：** 它不保证数据包一定到达，也不保证顺序。丢了就丢了，UDP 协议本身不管重传。
- **低开销 (Low Overhead)：** 头部非常短，只有 8 个字节（相比 TCP 的 20+ 字节），处理速度极快。
- **面向报文：** 保留报文边界，应用层给多少，它就发多少，不进行拆分或合并。


## UDP协议层的实现：
UDP处理和ICMP处理都复用ipv4的处理路径，所以只需新增一个分支逻辑走向`handle_udp(mbuf, ipv4_hdr)`
```C
void handle_udp(struct rte_mbuf* mbuf, struct rte_ipv4_hdr* ipv4_hdr) {
	//头部偏移逻辑类似于ICMP
    struct rte_udp_hdr* udp_hdr = (struct rte_udp_hdr*) (ipv4_hdr + 1);
    //交换udp协议的收发地址
    uint16_t temp_port = udp_hdr->src_port;
    udp_hdr->src_port = udp_hdr->dst_port;
    udp_hdr->dst_port = temp_port;
	//交换ipv4的收发地址
    uint32_t tmep_ip = ipv4_hdr->src_addr;
    ipv4_hdr->src_addr = ipv4_hdr->dst_addr;
    ipv4_hdr->dst_addr = tmep_ip;
	//udp的checksum类似于ICMP，依然需要重新计算，且提供了API
    udp_hdr->dgram_cksum = 0;
    udp_hdr->dgram_cksum = rte_ipv4_udptcp_cksum(ipv4_hdr, udp_hdr);
	//交换以太帧的收发地址
    struct rte_ether_hdr* eth_hdr = rte_pktmbuf_mtod(mbuf, struct rte_ether_hdr*);
    rte_ether_addr_copy(&eth_hdr->src_addr, &eth_hdr->dst_addr);
    rte_ether_addr_copy(&mac_addr, &eth_hdr->src_addr);
	//最后不要忘记将数据发送
    rte_eth_tx_burst(port_id, 0, &mbuf, 1);
    printf("UDP packet echoed back!\n");
}
```

## udp协议实现实验效果
Host侧
![](dpdk_udp_host.png)
Guest（DPDK）侧
![](dpdk_udp_guest.png)
效果符合预期。

# RoCEv2的echo处理
## RoCEv2协议是什么
RoCEv2协议的具体内容可以看博客[RoCEv2协议](RoCEv2协议.md)
简单的说可以认为本质上，RoCEv2将InfiniBand的包封装了UDP/IP包里。
### 1.协议包的结构如下：
- Ethernet Header：以太网帧头
- IP Header：包含源IP和目的IP
- UDP Header：
	- Destnation Port：**固定为4791**
	- Source Port：取决于**ECMP**
- InfinaBand Header（BTH）：包含RDMA操作的具体指令（Read、Write、Send等）
- Payload：真正的数据

其中根据网络包的类型，还会有扩展头`RETH`（RDMA WRITE用于告诉对方写到哪个地址的16 Bytes）和`AETH`（ACK确认回包告知对方回复确认的4 Bytes），或者没有数据包（SEND请求没有数据包）

同时还需要注意到需要依赖于**PFC(Priority-based Flow Control)** 和**ECN (Explicit Congestion Notification)** 机制来完成网络的拥塞控制。（但是具体的PFC的实现较为负责，则搁置不考虑）



## RoCEv2协议实现
### SEND_ONLY实现
这里我们定义ib_bth结构体：
```C
struct ib_bth {
    uint8_t opcode;        // Opcode
    uint8_t solicited_se;  // Solicited (1bit) + SE (1bit) + MigReq (1bit) + Pad (2bits) + TVer (4bits)
    uint16_t partition_key;// Partition Key
    uint8_t rsvd_destqp[4];// Reserved (8bits) + Destination QP (24bits)
    uint8_t ack_psn[4];    // Acknowledge Request (1bit) + Reserved (7bits) + PSN (24bits)
} __attribute__((__packed__));
```

接下来在UDP中增加一个端口判断分支：
```C
    if (dst_port == ROCE_UDP_PORT) { 
        handle_roce(mbuf, udp_hdr);
    }
```

进入到`handle_roce`中，对于opcode的分支中实现SEND_ONLY的分支流程：
```C
if (opcode == IB_OPCODE_RC_SEND_ONLY) {
        //这里处理为返回一个ACK包
        bth->opcode = IB_OPCODE_RC_ACK;
        struct ib_aeth * aeth = (struct ib_aeth *)(bth + 1);
        //真正的连接是查表的, 规范做法是根据 DestQP 查上下文找到 SourceQP，这里先不动 DestQP 字段，假装是一样的
        aeth->syndrome_msn = rte_cpu_to_be_32(AETH_ACK_COMMON << 24);
        uint16_t new_udp_data_len = sizeof(struct ib_bth) + sizeof(struct ib_aeth);
        uint16_t new_pkt_len = sizeof(struct rte_ether_hdr) + sizeof(struct rte_ipv4_hdr) + sizeof(struct rte_udp_hdr) + new_udp_data_len;

        mbuf->pkt_len = new_pkt_len;
        mbuf->data_len = new_pkt_len;
          
        udp_hdr->dgram_len = rte_cpu_to_be_16(sizeof(struct rte_udp_hdr) + new_udp_data_len);
        //接下来是仿照之前的UDP中实现的交换地址操作后回传消息
}
```
### SEND_ONLY实验效果
Guest端收包
![](dpdk_roce_send_guest.png)Host端发包并收到ACK
![](dpdk_roce_send_host.png)
### WRITE_ONLY实现
这里我们定义RETH：
```C
struct ib_reth {
    uint64_t va; //目标的VA
    uint32_t r_key; //RDMA key
    uint32_t mda_len; //数据长度
} __attribute__((__packed__));
```
之后在`handle_roce`中实现新的分支：
```C
else if (opcode == IB_OPCODE_RC_RDMA_WRITE_ONLY) {
	printf("(RC RDMA Write Only)\n");
	struct ib_reth* reth = (struct ib_reth*)(bth + 1);
	uint64_t va = rte_be_to_cpu_64(reth->va);
	uint32_t r_key = rte_be_to_cpu_32(reth->r_key);
	uint32_t mda_len = rte_be_to_cpu_32(reth->mda_len);
	//用于检验网络数据的
	printf("    [Write Request]\n");
	printf("    Target VA   : 0x%016lx\n", va);
	printf("    R_Key       : 0x%08x\n", r_key);
	printf("    Length      : %d bytes\n", mda_len);
	uint8_t *payload_ptr = (uint8_t *)(reth + 1); 
	//打印前几个字节的数据
	printf("    Data Preview: %02X %02X %02X ...\n", 
	   payload_ptr[0], payload_ptr[1], payload_ptr[2]);
	//以下是echo交换数据头代码，不重复展示
}
```
后续再实现真正的功能，本章节只是为了构建基础框架，所以选择只输入和回显

### WRITE_ONLY实现效果
Guest输出结果
![](dpdk_roce_write_guest.png)
Host输出结果：
![](dpdk_roce_write_host.png)

### READ_ONLY实现
增加新的判断分支

```C
 else if (opcode == IB_OPCODE_RC_RDMA_READ_REQUEST) {
	printf("(RC RDMA Read Request)\n");
	struct ib_reth * reth = (struct ib_reth *)(bth + 1);
	uint32_t read_len = rte_be_to_cpu_32(reth->mda_len);
	// 接下来就是构造READ Response包
	 bth->opcode = IB_OPCODE_RC_RDMA_READ_RESPONSE_ONLY; // 0x10
	 struct ib_aeth *aeth = (struct ib_aeth *)(reth + 1);
	aeth->syndrome_msn = rte_cpu_to_be_32(AETH_ACK_COMMON << 24);
	         //填充数据
	uint8_t *data_ptr = (uint8_t *)(aeth + 1);
	//todo 执行memcpy从内存读数据，这
	memset(data_ptr, 0xAA, read_len);
	//调整包长度
	uint16_t new_udp_payload_len = sizeof(struct ib_bth) + sizeof(struct ib_aeth) + read_len;
	uint16_t new_total_len = sizeof(struct rte_ether_hdr) + sizeof(struct rte_ipv4_hdr) + sizeof(struct rte_udp_hdr) + new_udp_payload_len;
	// 目前只处理单个包
	if (new_total_len > 1500) {
		printf("Error: Read length too large for simple echo!\n");
		return; 
	}              
	mbuf->pkt_len = new_total_len;
	mbuf->data_len = new_total_len;
	//接下来是echo的标准处理流程不再赘述
}
```

### READ_ONLY实现效果
Guest端输出：
![](dpdk_roce_read_Guest.png)
Host端输出：
![](dpdk_roce_read_host.png)

至此完成了全部的Echo框架设计。