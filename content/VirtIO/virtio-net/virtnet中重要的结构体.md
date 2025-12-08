# sk_buff
Socket buffer是Linux网络子系统的核心数据结构。他代表一个网络包。
- 包含了数据（Payload）、协议头（IP/TCP）、元数据（长度、校验和状态）

Linux内核当他申请一块内存存网络包的时，会在真正的数据开始之前，留下一段空间，叫做Headroom。
```
内存低地址 -----------------------------------------> 内存高地址
[  Headroom (空地)  |  Ethernet Header | IP | TCP | Payload  |  Tailroom ]
                    ^
                    |
              skb->data (当前数据起点)
```