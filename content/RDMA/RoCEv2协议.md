---
date: 2025-12-16T17:28:00
categories:
  - RDMA
tags:
  - RDMA
  - Bypass
  - net
title: RoCEv2协议
---
# 为什么RoCEv2选择UDP
这是RoCEv2的聪明设计，为了**ECMP**
- **问题**:传统的网络流如果是同一个五元组，通常会走同一条物理链路。如果该条链路堵塞，其他路即便是空闲也对该网络流无用。
- **ECMP（Equal-Cost Multi-Path）**，即等价多路径路由。RoCEv2协议中，发送端会根据数据流的不同，计算一个hash值放入**UDP的源端口**。交换机看到不同的UDP源端口，就会把数据包分发到不同的物理路径上。
- 这样的做法实现了负载均衡和短款利用率最大化

# 无损网络
- RDMA协议最初是为Infiniband设计的，它假设完了过是**绝对可靠**、**不会丢包**的。但是以太网本质是尽力而为（Best effort），丢包是常事。
- RoCEv2如果发生了丢包，重传机制非常慢（Go-back-N），会导致性能雪崩，所以必须要把以太网改造成”无损网络“
## 关键机制
1. **PFC（Priority-based Flow Control）**

2. **ECN（Explicit Congetion Notification）**
