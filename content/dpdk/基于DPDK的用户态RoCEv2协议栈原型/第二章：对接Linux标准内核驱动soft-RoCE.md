---
title: 第二章：RMDA协议功能实现
categories:
  - dpdk
  - 基于DPDK的用户态RoCEv2协议栈原型
tags:
  - dpdk
  - RDMA
  - net
  - Bypass
date: 2025-12-17T15:30:00
---
# 模拟真正的设备内存
## RoCEv2协议echo实现的修改适配
我们虚拟一个内存机制，来模拟它是GPU显存或者DPU的内存：
```C
uint8_t *g_device_memory = NULL;
#define MEM_SIZE (10 * 1024 * 1024) // 10MB
#define BASE_VA  0x100000           // 假设 Host 认为这块内存从 0x100000 开始
```
同时对着块内存，需要在`EAL`初始化后立即也进行初始化
```C
void init_memory() {
    g_device_memory = rte_malloc("device_memory", MEM_SIZE, 4096);
    if (!g_device_memory) {
        rte_exit(EXIT_FAILURE, "Cannot allocate device memory\n");
    }
    memset(g_device_memory, 0, MEM_SIZE); // 清零
}
```

接下来实现修改RoCEv2的WRITE和READ操作：

```C
//这里是Write操作，算好偏移量后填入到虚拟的设别内存中
else if (opcode == IB_OPCODE_RC_RDMA_WRITE_ONLY) {
	uint64_t va = rte_be_to_cpu_64(reth->va);
	uint32_t r_key = rte_be_to_cpu_32(reth->r_key);
	uint32_t mda_len = rte_be_to_cpu_32(reth->mda_len);
	if (va < BASE_VA || va + mda_len > BASE_VA + MEM_SIZE) {
		printf("    [Error] Invalid VA range: 0x%016lx (len %d)\n", va, mda_len);
		rte_pktmbuf_free(mbuf);
		return;
	}
	uint64_t offset = va - BASE_VA;
	uint8_t *local_ptr = g_device_memory + offset;
	//用于检验网络数据的
	uint8_t *payload_ptr = (uint8_t *)(reth + 1); 
	//关键步骤：存储数据
	rte_memcpy(local_ptr, payload_ptr, mda_len); 
}
```

```C
else if (opcode == IB_OPCODE_RC_RDMA_READ_REQUEST) {
	printf("(RC RDMA Read Request)\n");
	struct ib_reth * reth = (struct ib_reth *)(bth + 1);
	uint32_t read_len = rte_be_to_cpu_32(reth->mda_len);
	uint64_t read_va = rte_be_to_cpu_64(reth->va);
	if (read_va <BASE_VA || read_va + read_len > BASE_VA + MEM_SIZE) {
		printf("    [Error] Invalid Read VA range: 0x%016lx (len %d)\n", read_va, read_len);
		rte_pktmbuf_free(mbuf);
		return;
	}
	uint64_t offset = read_va - BASE_VA;
	uint8_t *local_ptr = g_device_memory + offset;
	// 接下来就是构造READ Response包
	bth->opcode = IB_OPCODE_RC_RDMA_READ_RESPONSE_ONLY; // 0x10
	//构造AETH，覆盖掉原来的RETH
	struct ib_aeth *aeth = (struct ib_aeth *)(aeth + 1);//注意到这里有一个小bug，用于后续展示debug示例
	aeth->syndrome_msn = rte_cpu_to_be_32(AETH_ACK_COMMON << 24);
	//填充数据
	uint8_t *resp_data_ptr = (uint8_t *)(aeth + 1);
	rte_memcpy(resp_data_ptr, local_ptr, read_len);
```
## 使用tcpdump进行debug示例
首先我们在Host机器上启用tcpdump来检测virbr0网卡（设备网卡绑定到uio/vfio驱动后的设备号）的4791端口（RDMA专用端口）
```shell
sudo tcpdump -i virbr0 -vvv -e -X udp port 4791
```
我们后续会采用soft-RoCE来产生真正的RoCEv2报文，但是目前实现的协议栈不支持完整的兼容，所以接下来我们使用如下的python程序来模拟发出一对RDMA `Write`和`Read` 请求消息，并进行比对：
```python
#!/usr/bin/env python3
from scapy.all import *
import struct
import time

# 配置
GUEST_IP = "192.168.122.200" # 根据自己的Guest中运行的DPDK程序拦截的IP来填写
HOST_IFACE = "virbr0"
GUEST_MAC = "52:54:00:66:86:73" # 填写 Guest MAC
TARGET_VA = 0x100000
R_KEY     = 0x99887766
TEST_DATA = b"Hello DPDK Memory!" # 18 bytes
DATA_LEN  = len(TEST_DATA)

def send_write():
    print(f"[1] Writing '{TEST_DATA.decode()}' to 0x{TARGET_VA:x}...")
    # 构造 WRITE 包 (参考之前的脚本)
    bth = struct.pack('!BBHII', 0x0A, 0, 0xFFFF, 0x123456, 1000) # Opcode 0x0A
    reth = struct.pack('!QII', TARGET_VA, R_KEY, DATA_LEN)
    pkt = Ether(dst=GUEST_MAC) / IP(dst=GUEST_IP) / UDP(dport=4791, sport=33333) / \
          Raw(load=bth + reth + TEST_DATA)
    
    # WRITE 通常没有回包(除非设了Solicited)，这里为了简单我们假设DPDK回了ACK
    # 或者是 Unsignaled Write，我们只管发
    sendp(pkt, iface=HOST_IFACE, verbose=0)
    time.sleep(0.5) # 等一下 DPDK 处理

def send_read():
    print(f"[2] Reading {DATA_LEN} bytes from 0x{TARGET_VA:x}...")
    # 构造 READ 包
    bth = struct.pack('!BBHII', 0x0C, 0, 0xFFFF, 0x123456, 2000) # Opcode 0x0C
    reth = struct.pack('!QII', TARGET_VA, R_KEY, DATA_LEN)
    pkt = Ether(dst=GUEST_MAC) / IP(dst=GUEST_IP) / UDP(dport=4791, sport=33333) / \
          Raw(load=bth + reth)

    # 发送并等待 READ RESPONSE (Opcode 0x10)
    ans = srp1(pkt, iface=HOST_IFACE, timeout=2, verbose=0, filter="udp and src port 4791")
    
    if ans:
        raw = bytes(ans[UDP].payload)
        # BTH(12) + AETH(4) = 16 字节头部
        if len(raw) > 16:
            recv_data = raw[16:]
            print(f"[3] Received Data: {recv_data}")
            if recv_data == TEST_DATA:
                print(">>> SUCCESS: Memory Verify Passed! <<<")
            else:
                print(f">>> FAIL: Expected {TEST_DATA}, got {recv_data} <<<")
        else:
            print("Error: Payload too short")
    else:
        print("Error: No response for READ")

if __name__ == "__main__":
    send_write()
    send_read()
```
我们的初次测试结果为：
![](测试rw_host.png)
可以看出来发生了错误，消息前后并不一致。此时也可以观测我们端口上发送的消息。虽然我们可以通过该程序的输入输出直接判断出我我们所受到的包在文本头有一段多余的信息。但是这并不是普遍做法。我们可以分析tcpdump来进行网络包分析：
![](tcpdump_debug.png)
可以看到这里有四段相互发送的消息
1. 这个是Host向Guest的DPDK程序发送的`Write Request`，消息完全正确
```
hugepages-Inspiron-3020-S.33333 > 192.168.122.200.4791: [udp sum ok] UDP, length 46
	0x0000:  4500 004a 0001 0000 4011 0488 c0a8 7a01  E..J....@.....z.
	0x0010:  c0a8 7ac8 8235 12b7 0036 863d 0a00 ffff  ..z..5...6.=....
	0x0020:  0012 3456 0000 03e8 0000 0000 0010 0000  ..4V............
	0x0030:  9988 7766 0000 0012 4865 6c6c 6f20 4450  ..wf....Hello.DP
	0x0040:  444b 204d 656d 6f72 7921                 DK.Memory!
```
2. 这个Guest向Host回复ACK
```
192.168.122.200.4791 > hugepages-Inspiron-3020-S.33333: [udp sum ok] UDP, length 46
	0x0000:  4500 004a 0001 0000 4011 0488 c0a8 7ac8  E..J....@.....z.
	0x0010:  c0a8 7a01 12b7 8235 0036 7f3d 1100 ffff  ..z....5.6.=....
	0x0020:  0012 3456 0000 03e8 0000 0000 0010 0000  ..4V............
	0x0030:  9988 7766 0000 0012 4865 6c6c 6f20 4450  ..wf....Hello.DP
	0x0040:  444b 204d 656d 6f72 7921                 DK.Memory!
```
这一段就出现了问题，在`0x0010`处的`1100 ffff`表明Opcode 0x11是正确的。但是消息包后续依然带着Payload“Hello DPDK Memory”。ACK包不应该带着数据负荷。这说明程序中的ACK处理逻辑在长度方面并没有完成截断。
3. 这一段是Host继续重新向Guest发送`Read Request`
```
hugepages-Inspiron-3020-S.33333 > 192.168.122.200.4791: [udp sum ok] UDP, length 28
	0x0000:  4500 0038 0001 0000 4011 049a c0a8 7a01  E..8....@.....z.
	0x0010:  c0a8 7ac8 8235 12b7 0024 9b55 0c00 ffff  ..z..5...$.U....
	0x0020:  0012 3456 0000 07d0 0000 0000 0010 0000  ..4V............
	0x0030:  9988 7766 0000 0012                      ..wf....
```

- 注意 `0x0020` 行的最后 4 字节 `0000 0000` 和 `0x0030` 行的前 4 字节 `0010 0000`。
- 拼起来是 `00000000 00100000` -> **Target VA = 0x100000**。
- 紧接着是 `9988 7766` (RKey)。
这里是正确的
4. 最后是Guest答复给Host的读取请求中的数据报文内容
```
192.168.122.200.4791 > hugepages-Inspiron-3020-S.33333: [udp sum ok] UDP, length 28
	0x0000:  4500 0038 0001 0000 4011 049a c0a8 7ac8  E..8....@.....z.
	0x0010:  c0a8 7a01 12b7 8235 0024 9755 1000 ffff  ..z....5.$.U....
	0x0020:  0012 3456 0000 07d0 0000 0000 0010 0000  ..4V............
	0x0030:  9988 7766 0000 0012 0000 0000 4865       ..wf........He
```

`0x0010`处的`1000 ffff`意味着Opcode为0x10，正是READ RESPONSE。没有问题。
Host 申请读 **18 字节**。 Tcpdump 显示 UDP Payload 长度是 **28 字节**。
- Header = BTH(12) + AETH(4) = 16 字节。
- Data = 28 - 16 = **12 字节**。
- 长度错误，Host需要18字节，但是回复只有12字节。
查看内容，发现`0x0020`后半部分的内容和之前的回复中的RETH部分完全一直，所以明白了READ Response报文并没有取代`RETH`为`AETH`，而是在`RETH`后面增加了额外的报头，所以错误。故而修改两处bug：
```C
struct ib_aeth *aeth = (struct ib_aeth *)(reth + 1);//错！
struct ib_aeth *aeth = (struct ib_aeth *)(bth + 1);//对！
```
同时在Write的分支中增加对于长度阶段的逻辑：
```C
else if (opcode == IB_OPCODE_RC_RDMA_WRITE_ONLY) {
	//...
	//填写AETH并修改opcode
	struct ib_aeth *aeth = (struct ib_aeth *)(bth + 1);
	aeth->syndrome_msn = rte_cpu_to_be_32(AETH_ACK_COMMON << 24);
	bth->opcode = IB_OPCODE_RC_ACK;
	// 调整包长度
	uint16_t ack_len = sizeof(struct ib_bth) + sizeof(struct ib_aeth);
	mbuf->data_len = ack_len + sizeof(struct rte_ether_hdr) + sizeof(struct rte_ipv4_hdr) + sizeof(struct rte_udp_hdr);
	mbuf->pkt_len = mbuf->data_len;
	//修正 UDP 头部长度, UDP 头里的长度字段必须反映新的 Payload 长度
	udp_hdr->dgram_len = rte_cpu_to_be_16(sizeof(struct rte_udp_hdr) + ack_len);
	//...
}
```
修正后程序正确运行。
# 协议头与字段的标准化
之前都是为了发送长得像RoCES的UDP包，现在我们现在按照IB规范修正了头部字段
## BTH部分重构
- **OpCode修正**：区分了 `RC_RDMA_WRITE_ONLY` (0x0A) 和 `RC_ACK` (0x11)，以及 `READ_REQUEST` (0x0C) 和 `READ_RESPONSE` (0x10)
- **P_Key (Partition Key)**：从默认的 0 修正为 `0xFFFF`（默认分区），这是标准 IB 网络通信的基础。
- **Solicited/SE 标志位清理**：在发送 ACK 时，显式清除了请求包中残留的 `Solicited Event` 和 `Signaled` 标志，防止接收端状态机混淆。

## **AETH (Ack Extended Transport Header) 实现**
- **Syndrome 规范化**：将 Syndrome 字段严格设置为 `ACK` (0x00)，修复了之前可能发送非法 Syndrome (如 0x1F) 导致 rxe 直接丢包的问题。
- **MSN (Message Sequence Number) 流控**：引入了 MSN 计数器，确保每个 ACK/Response 的 MSN 递增，满足可靠连接 (RC) 的序列号检查机制。
```C
if (opcode == IB_OPCODE_RC_SEND_ONLY || opcode == IB_OPCODE_RC_RDMA_WRITE_ONLY) {
    // 1. 显式重置 BTH 头部，避免继承请求包中的 Solicited/SE 等标志位
    // 这是一个常见的坑，如果直接复用请求包的 BTH，rxe 会因为标志位混乱而丢包
    bth->opcode = IB_OPCODE_RC_ACK; // 0x11
    bth->solicited_se = 0;          // 必须清零
    bth->partition_key = rte_cpu_to_be_16(0xffff); // 标准 P_Key

    // 2. 填入 Host 端的 QP 号 (通过握手获得)
    const uint32_t dest_qp_field = rte_cpu_to_be_32(g_host_qp_num & 0xFFFFFF);
    *(uint32_t *)bth->rsvd_destqp = dest_qp_field;

    // 3. 构造 AETH (Ack Extended Transport Header)
    // Syndrome = 0 (ACK), MSN 必须递增以通过序列号检查
    struct ib_aeth *aeth = (struct ib_aeth *)(bth + 1);
    const uint32_t msn = roce_next_msn(); 
    // AETH_ACK_COMMON 为 0x00
    aeth->syndrome_msn = rte_cpu_to_be_32((AETH_ACK_COMMON << 24) | (msn & 0xFFFFFF));

    // 4. 设置 ACK PSN (通常等于请求的 PSN)
    const uint32_t req_psn = get_psn(bth);
    const uint32_t ack_psn_field = rte_cpu_to_be_32(req_psn & 0xFFFFFF);
    *(uint32_t *)bth->ack_psn = ack_psn_field;
}
```

## 连接状态与QP管理（CM）
为了解决“DPDK 端不知道 Host 端 QP 号”这一核心难题，我们实现了一套带外 (Out-of-Band) 握手机制：
- **动态 QP 交换机制**：
    - 放弃了硬编码 QP 号（如 `0x123456`）。
    - 设计了基于 UDP (端口 4792) 的控制平面协议。
    - **流程**：Client 启动时发送自身 QP 号 -> DPDK 接收并记录 -> DPDK 回复自身 QP 号 -> Client 接收并完成 QP 状态机迁移 (RTR)。
    - 这使得 Client 和 Server 可以动态启动，无需重新编译代码来修改 QP 号。
- **Dest QP 修正**：在回复 ACK 和 Read Response 时，正确填入了 Host 端的 QP 号（从握手阶段获取），而不是填 0 或错误的 QP，这是 rxe 能识别报文的第一道门槛。

```C
// 定义一个专用的控制端口 (如 4792) 用于交换元数据
#define ROCE_CTRL_PORT 4792

if (dst_port == ROCE_CTRL_PORT) {
    if (data_len >= 4) {
        // 1. 解析 Host 发来的 QP 号
        const uint8_t *payload = (const uint8_t *)(udp_hdr + 1);
        const uint32_t qpn = rte_be_to_cpu_32(*(const uint32_t *)payload);
        g_host_qp_num = qpn; // 保存 Host QP，后续发包都用这个
        printf("[CTRL] Host QP set to %u (0x%x)\n", g_host_qp_num, g_host_qp_num);

        // 2. 立即回复 DPDK 自身的 QP 号 (g_guest_qp_num)
        // 这样 Host 端 Client 也能自动完成 modify_qp_to_rtr
        *(uint32_t *)(udp_hdr + 1) = rte_cpu_to_be_32(g_guest_qp_num);
        
        // 3. 交换 IP/MAC 并回发 UDP 包 (代码略: swap_mac/ip logic...)
        rte_eth_tx_burst(port_id, 0, &mbuf, 1);
        return;
    }
}
```
## 数据完整性校验 (Integrity Checks)
这是调试最深入的部分，也是 Soft-RoCE 最严格的地方：

- **ICRC (Invariant CRC) 计算**：
    - 实现了符合 RoCEv2 标准的 ICRC 算法。
    - **伪首部构造**：包含了 IP 头、UDP 头以及 IB BTH/AETH/Payload。
    - **字段掩码**：在计算 CRC 前，正确地将 IP TTL/TOS、UDP Checksum、BTH Resv 等易变字段置零（Masking），防止中间网络设备修改导致校验失败。
- **UDP/IP Checksum**：虽然 IPv4 允许 UDP Checksum 为 0，但为了最大程度兼容，我们尝试了重新计算 IP 和 UDP 的校验和。
```C
static uint32_t roce_v2_icrc_ipv4(...) {
    // ... 拷贝数据到 scratch buffer ...

    // 关键步骤：Masking (掩码处理)
    // 根据 IB 规范，计算 ICRC 时，IP 头和 UDP 头的某些字段必须视为全 1
    struct rte_ipv4_hdr *ip = (struct rte_ipv4_hdr *)scratch;
    ip->type_of_service = 0xff; // TOS 置全1
    ip->time_to_live = 0xff;    // TTL 置全1
    ip->hdr_checksum = 0xffff;  // Checksum 置全1

    struct rte_udp_hdr *udp = (struct rte_udp_hdr *)(scratch + ip_hdr_len);
    udp->dgram_cksum = 0xffff;  // UDP Checksum 置全1

    // BTH 中的 Resv 字段和 ECN 标志位也需要处理
    if (udp_payload_len >= sizeof(struct ib_bth)) {
        struct ib_bth *bth = (struct ib_bth *)(scratch + ...);
        bth->rsvd_destqp[0] = 0xff; // Resv 字段置全1
    }

    // 计算 CRC32
    uint32_t crc = rte_hash_crc(scratch, bytes_to_crc, 0xffffffff);
    return ~crc; // 取反
}
```
### 4. 字节序与内存模型 (Endianness & Memory)

- **大端序 (Big-Endian) 适配**：所有 IB 协议头字段（如 QP Num, PSN, R_Key, VA）都严格转换为网络字节序（Big-Endian），修复了之前直接发送主机字节序导致解析错误的问题。
- **Scatter/Gather (S/G) 模拟**：在处理 RDMA Read 时，实现了从本地内存缓冲区 `rte_memcpy` 数据到 mbuf 的过程，模拟了硬件 DMA 的行为。
```C
else if (opcode == IB_OPCODE_RC_RDMA_READ_REQUEST) {
    struct ib_reth *reth = (struct ib_reth *)(bth + 1);
    
    // 1. 字节序转换：网络大端 -> 主机小端
    uint64_t read_va = rte_be_to_cpu_64(reth->va);
    uint32_t read_len = rte_be_to_cpu_32(reth->mda_len);
    uint32_t r_key = rte_be_to_cpu_32(reth->r_key);

    // 2. 地址安全检查 (模拟 MR 检查)
    if (read_va < BASE_VA || read_va + read_len > BASE_VA + MEM_SIZE) {
        // Error handling...
        return;
    }

    // 3. 计算本地偏移并获取数据指针
    uint64_t offset = read_va - BASE_VA;
    uint8_t *local_ptr = g_device_memory + offset;

    // 4. 构造 Read Response 并填充数据 (模拟 DMA)
    // 将 BTH 转换为 Response 类型
    bth->opcode = IB_OPCODE_RC_RDMA_READ_RESPONSE_ONLY; 
    
    // 内存拷贝：从 DPDK 内存 -> mbuf payload
    uint8_t *resp_data_ptr = (uint8_t *)(aeth +else if (opcode == IB_OPCODE_RC_RDMA_READ_REQUEST) {
    struct ib_reth *reth = (struct ib_reth *)(bth + 1);
    
    // 1. 字节序转换：网络大端 -> 主机小端
    uint64_t read_va = rte_be_to_cpu_64(reth->va);
    uint32_t read_len = rte_be_to_cpu_32(reth->mda_len);
    uint32_t r_key = rte_be_to_cpu_32(reth->r_key);

    // 2. 地址安全检查 (模拟 MR 检查)
    if (read_va < BASE_VA || read_va + read_len > BASE_VA + MEM_SIZE) {
        // Error handling...
        return;
    }

    // 3. 计算本地偏移并获取数据指针
    uint64_t offset = read_va - BASE_VA;
    uint8_t *local_ptr = g_device_memory + offset;

    // 4. 构造 Read Response 并填充数据 (模拟 DMA)
    // 将 BTH 转换为 Response 类型
    bth->opcode = IB_OPCODE_RC_RDMA_READ_RESPONSE_ONLY; 
    
    // 内存拷贝：从 DPDK 内存 -> mbuf payload
    uint8_t *resp_data_ptr = (uint8_t *)(aeth +
```