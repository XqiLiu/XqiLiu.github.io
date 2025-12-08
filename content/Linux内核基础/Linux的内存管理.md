---
title: Linux的内存管理
categories:
  - Linux内核基础
tags:
  - Linux
  - memory
  - NUMA
---
# Buddy System
Linux目前底层的物理内存管理还是使用的**伙伴系统**，防止**外部碎片**。
- 工作原理：
	- 将内存按$2^n$个页面（Pages）的大小进行分组（Order 0 到Order 11，即1到1024页）
		- 当申请1个页时，查看Order 0链表。
		- 申请4个页时，查看Order 2链表。
		- 如果目标链表为空，会向高阶链表借一块，将其一分为二，一块用于提供给分配申请，一块存入低阶链表。
		- 释放时，它会检查物理地址连续的伙伴空间是否空闲，如果空闲则合并成更大的块。
# Slab分配器
如果一个很小字节来存放一个结构体，就找Buddy系统要4KB内存页，太过于浪费（内部碎片），所以引入了第二层管理：**Slab分配器**。
- 职责：从Buddy System申请整页内存，切碎后提供给内核其它模块。
- 目前现状：
	- **Slab**：最早的实现，机制复杂，元数据开销大
	- **Slub**：现在的默认实现。是Slab的改进版本，去掉了复杂的队列管理，性能更好，对CPU缓存更友好。目前大多数的服务器发行版默认使用Slub。
	- **Slob**：嵌入式系统下的极简版。
在传统的Slab哲学，初始化一个对象的可能比分配内存更贵：
- slab释放内存时，并不一定把内存还给Buddy，而是把它标记为“空闲”，但保持其初始化状态。下次再申请时，直接用从而省去了初始化开销。（现代Slub实现中为了性能简化了这一步）

- **Slub (The Unqueued Slab)**：**现在的默认设置**（绝大多数发行版都在用）。
    - 它最大的改进是**去掉了复杂的队列管理**。
    - **复用 `struct page`**：Slub 非常激进地复用了 `struct page` 结构体中的字段来做链表指针（freelist），大大减少了额外的元数据开销。这是非常硬核的优化。

- **kmalloc**的实现
	- `kmalloc`并不是基于Buddy的，而是基于Slub的。
	- 内核预先创建了一系列通用的Slab Cache，大小以此类推`kmalloc-8`, `kmalloc-16`, `kmalloc-32` ... `kmalloc-1024`。
	- 当调配用了`kmalloc(50)`，内核会找最近的`kmalloc-64` 的池子挖一块分配。这只会有较小的浪费。
# NUMA
## UMA
在早期的SMP时代，所有的CPU通过一条总线访问同一块内存（Uniform Memory Access）
随着CPU核心越来越多，共享的内存总线带宽不够。解决办法就是采用**分治**的策略：
- 内存切分，分给不同的CPU插槽（Socket）
- CPU访问自己插槽的内存（Local Access）极快，访问隔壁插槽（Remote Access）较慢，这就是**NUMA**。

## Linux内核中的NUMA抽象：Node
- **物理概念映射**：Linux将CPU和其直连的内存条组成一个逻辑单元，称为Node。
- **核心结构体**：`struct pglist_data`（简称为`pgdat`）
	- 在UMA时代，全系统只有一个`pgdat`队列。
	- NUMA时代，系统有`N`个`pgdat`队列，通过链表连在一起。
- NUMA是比`Buddy System`更高的层级：
  Node(pgdat)->Zones(DMA)->Buddy(Free Lists)->Page
	- 上一章所提到的Buddy系统，其实是存在每一个Node里的。每个Node都有自己独立的Buddy System链表和锁。这意味着CPU A申请本地内存时，不需要竞争CPU B的锁，提高了并行性。

## 内存分配策略
这是内核决策的部分。当一个进程申请`malloc`时，内核该去哪个Node拿内存。
- **Default（默认策略）**：Local Allocation
	- CPU在所处的Node上运行，就在该Node的Buddy系统申请内存
	- 这一策略保证了访存速度,但是可能内存使用不均进而OOM或频繁Swap,即时总内存还是充足的。
- **Zonelist（备用列表）**：
	- 每个Node都有一个`Zonelist`，用于规定当当前Node的内存使用完后，下一个找谁借。
	- 通常是按“距离”排序的（通过 ACPI 表获取的 SLIT 信息）。
- **MPOL_BIND (绑定)**：强制进程只能使用特定的 Node。
- **MPOL_INTERLEAVE (交织)**：轮询分配（Page 1 在 Node 0，Page 2 在 Node 1...）。这对数据库或高带宽计算非常有用，可以利用所有内存控制器的带宽。

## 