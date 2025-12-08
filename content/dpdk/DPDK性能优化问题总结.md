---
title: DPDK性能优化问题总结
categories:
  - dpdk
date: 2025-12-04T14:39:00
tags:
  - NUMA
  - dpdk
---
# DPDK的内存性能优化
1. **采用了HugePage**s[[DPDK的内存管理：Mbuf和Mempool#物理层：Hugepages 对比 4KB页]] 
	 - **优化点**：使用 2MB 或 1GB 的内存页，而不是 4KB。
	- **收益**：大幅减少页表项，降低 **TLB Miss**（转换后备缓冲器缺失）的概率。
2. **无锁环形队列与Per-Core Caceh**[[DPDK的内存管理：Mbuf和Mempool#并发层：Per-Core Cache 对比 锁竞争]]
	- **优化点**：将线程绑定到固定的 CPU 核心（`lcore`），并隔离该核心（Isolcpus）。同时Mempool 在每个核都有私有缓存。
	- **收益**：消除了**线程调度 (Context Switch)** 带来的开销，保证 CPU Cache 不会被其他进程冲刷掉；99% 的内存申请/释放不需要去访问全局队列，实现了**零竞争**。
3. Mbuf 结构优化[[DPDK的内存管理：Mbuf和Mempool#Mbuf结构设计]]
	- **优化点**：正如我们讨论的，将常用字段塞进前 64 字节，数据紧挨着结构体。
	- **收益**：极致的 **Cache Locality**，减少 Cache Miss。
# DPDK架构层优化设计
1. **Kernel Bypass设计**[[Kernel Bypass]]
	- **优化点**：跳过了Linux内核协议栈，直接在用户态接管网卡
	- **收益**：消除了**System Call**和内核态到用户态的数据拷贝（copy_to_user）的开销
2. **独占与绑定**
	- **优化点**：将线程绑定到固定的 CPU 核心（`lcore`），并隔离该核心（Isolcpus）。
	- **收益**：消除了**线程调度 (Context Switch)** 带来的开销，保证 CPU Cache 不会被其他进程冲刷掉。
3. **NUMA感知**
	- **优化点**：网卡插在哪个 CPU 插槽，就用那个 CPU 的核去处理，内存也从那个 CPU 的本地内存条分配。
	- **收益**：消除了跨 QPI 总线访问远程内存的延迟（本地内存访问通常比远程快 20-30%）

# I/O模型层
1. **PMD轮询模式**
2. **批量处理（Burst）**
