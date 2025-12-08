---
title: dpdk示例程序进化之路
categories:
  - dpdk
date: 2025-12-04T15:32:00
tags:
  - dpdk
---
只看原理的实现，会对 DPDK 的用途不够了解。对于 DPDK 的重要设计的优越性也没有更加清晰的认识。所以需要阅读源码中提供的 example 来进一步学习，同时也可以见证 DPDK 的应用程序从基础框架走向复杂丰富的设计过程。
本文的流程是如下四个经典examples：
**Helloword** -> **Basicfwd** -> **l2fwd** -> **l3fwd**
# Helloword：环境的接管与多核启动
计算机的传统，任何的编程语言第一句都是Helloword。在DPDK中，打印这样的一行字要做很多事情。

它的核心任务是：**EAL 初始化与多核启动**。

普通的 C 程序是从 `main` 函数开始单线程执行的。而 DPDK 的 HelloWorld 展示了 DPDK 如何通过 **EAL (Environment Abstraction Layer)** 接管 Linux 的资源。

- **关键代码**：
```C
ret = rte_eal_init(argc, argv); // 初始化环境，接管大页内存、PCI设备等
rte_eal_remote_launch(lcore_hello, NULL, lcore_id); // 在其他物理核上启动线程
	```
- **意义**：  
    它告诉我们，DPDK 程序不仅仅是一个运行在 OS 上的进程，它更像是一个**轻量级的操作系统**。它绕过了 OS 的调度，直接将代码绑定在物理 CPU 核心上运行。这是DPDK高性能的第一步：**独占资源，拒绝上下文切换**。
# Basicfwd：数据转发基础
 
HelloWorld 跑通了环境，但还没有触及 DPDK 最关键的任务——收发包。`skeleton/basicfwd` 是最纯粹的转发模型，它剥离了所有花哨的功能，只保留了最核心的 I/O 循环。

它的核心任务是：**建立最基础的收发包循环**。
**实现逻辑**：  
它展示了 DPDK 程序的标准结构：
1. **Mempool 创建**：为数据包准备内存池。
2. **Port 初始化**：配置网卡队列。
3. **While(1) 循环**：死循环轮询。
```C
/* Basicfwd 的核心逻辑 */
while (1) {
    // 1. 收包
    nb_rx = rte_eth_rx_burst(port, 0, bufs, BURST_SIZE);
    if (nb_rx == 0) continue;

    // 2. 发包 (直接透传)
    nb_tx = rte_eth_tx_burst(port ^ 1, 0, bufs, nb_rx);
    
    // 3. 释放没发出去的包
    if (unlikely(nb_tx < nb_rx)) {
        // free mbufs...
    }
}
```
这一模型是教学用具，存在较大的不完善，是**不可用**的：
1. **性能短板**：它采用“收多少，发多少”的策略。如果总线上一瞬间只来了一个包，它就立刻调用 `tx_burst` 发送一个包。频繁的 PCIe 事务和寄存器操作会极大地浪费 CPU 周期。
2. **功能缺失**：没有 MAC 地址修改（导致二层网络不通），没有统计信息，没有多核负载均衡。
# l2fwd

2fwd 可以算是工业级应用的雏形它在 Basicfwd 的基础上，引入了**批处理（Batching）**、**多核并发**和**可观测性**，解决了性能和扩展性问题。

它的核心任务是：**完全利用硬件性能，提供完整功能。**

1. **性能优化**：为Burst建立Buffer
这是 l2fwd 最重要的改进。针对 Basicfwd “收一个发一个”的低效，l2fwd 引入了 **TX Buffer** 机制。

- 逻辑对比：
    - **Basicfwd**: 收 32 个 -> 处理 -> 发 32 次（最坏情况）。
    - **l2fwd**: 收 32 个 -> 处理 -> **放入软件缓冲区** -> 缓冲区满（32个）或超时 -> **一次性**发给网卡。
- 关键代码：
```C
// 不再直接调用 tx_burst，而是放入 buffer
rte_eth_tx_buffer(dst_port, 0, buffer, m);
```
通过**软件层面的聚合**，减少了与硬件交互的频率。

2. **架构优化**：多核负载均衡
Basicfwd 通常只用一个核干活。而 l2fwd 展示了如何利用多核。

- 它引入了 `qconf` (Queue Configuration) 概念。
- 在启动时，它会计算每个 CPU 核心应该负责哪些网口。
- 这意味着吞吐量可以随着 CPU 核心数的增加而线性增长。

2. **业务优化**：引入了二层逻辑
Basicfwd 只是把包从 A 扔到 B，不修改内容。l2fwd 模拟了真实的交换机行为：
- 修改源 MAC：改为发送端口的 MAC。
- 修改目的 MAC：改为预设的对端 MAC。
- 定时统计：利用定时器周期性打印 PPS 和丢包率。

# l3fwd
 l3相比于l2复杂度高出较多。l2是个玩具级别的交换机实现。l3fwd则是是一个较为完整的三层转发示例，同时也是DPDK官方用来测试CPU和网卡极限吞吐量的基准程序。
 读者阅读该处代码，需要确保已经完成阅读过上几个章节中的源码，且对DPDK程序的设计流程有一个初步的概念。
 从代码量上看，l3fwd 相比 l2fwd 膨胀了许多，这会让初学者感到不适应。其核心变化主要集中在：**更复杂的查表逻辑**和**更极致的流水线优化（性能）**
 
## 核心差异：查表逻辑
l2fwd只需要查MAC地址表，而l3fwd模拟了真实路由器的行为，需要处理IP协议头。为了应对不同的业务场景，l3fwd提供了两种互斥的查找模式：**LPM**和**EM**。
### LPM工作流程
这是l3fwd的默认模式，对应标准的IP路由查找。
- **原理**：基于目的 IP 地址，在路由表中寻找“匹配长度最长”的条目。例如，`192.168.1.1` 应该匹配 `192.168.1.0/24` 而不是 `192.0.0.0/8`。
- **DPDK 的优化**：传统的二叉树（Trie）查找太慢，DPDK 的 `rte_lpm` 库采用了一种 **"空间换时间"** 的算法（DIR-24-8）。
    - 它将 32位 IP 地址分为前 24 位和后 8 位。
    - 绝大多数查找只需要访问 **1 次** 内存即可定位下一跳，极少数需要 2 次。这保证了极其稳定的查找性能。
核心逻辑流：
```C
main();
  ⬇
rte_eal_mp_remote_launch(l3fwd_lkp.main_loop, NULL, CALL_MAIN);
//这里的main_loop预先在setup_l3fwd_lookup_tables()中设置
  ⬇
lpm_main_loop(__rte_unused void *dummy)
//在这内部处理收包逻辑后，进行lpm的算法转发
  ⬇
l3fwd_lpm_no_opt_send_packets(nb_rx, pkts_burst,portid, qconf)
//这里是负责处理预取来提高cache命中的
  ⬇
l3fwd_lpm_simple_forward(struct rte_mbuf *m, uint16_t portid,struct lcore_conf *qconf) 
//这里是负责真正的lpm IP路由计算的
  ⬇
send_single_packet(struct lcore_conf *qconf, struct rte_mbuf *m, uint16_t port)
//负责软件层面进行发包前的聚集。
```
### EM工作模式
LPM（最长前缀匹配）是路由器的工作模式。EM是防火墙和复杂均衡器的工作模式。
EM关注五元组（5-tuple）的精确匹配：
1. Source IP
2. Destination IP
3. Soruce Port
4. Destination Port
5. Protocol e.g. TCP/UDP
五元组中任何一个Bit不一样，就会被视为两个完全不同的Flow，从而转发到其它地方去。

EM底层数据结构采用的是Hash表。而不是像LPM的表一样。

**EM的查找流程**：
1. **提取特征**：CPU 从包里读出五元组数据。
    
2. **计算指纹 (Hash)**：把这堆数据喂给一个哈希函数，算出一个Hash Value。
3. **定位桶 (Bucket)**：用这个整数去 Hash 表里找对应的 Hash Value。
4. **比对 (Compare)**：
    - 如果Value是空的 -> **Miss** (查不到，可能是新流)。
    - 如果Value有意义 -> **Hit** (查到了，拿走里面存的 Port ID)。
    - _注意：Hash 可能会冲突（碰撞），所以找到坑位后，必须把原始的五元组再拿出来逐位对比一下，确保万无一失。

```C
static inline uint16_t
em_get_ipv4_dst_port(void *ipv4_hdr, uint16_t portid, void *lookup_struct)
{
	//...
	/*
	 * Get 5 tuple: dst port, src port, dst IP address,
	 * src IP address and protocol.
	 */
	key.xmm = em_mask_key(ipv4_hdr, mask0.x);

	/* Find destination port */
	ret = rte_hash_lookup(ipv4_l3fwd_lookup_struct, (const void *)&key);
	return (ret < 0) ? portid : ipv4_l3fwd_out_if[ret];
}
```

核心逻辑流与LPM的流是类似的，只是`l3fwd_lkp.main_loop`中的指针做出了调整。