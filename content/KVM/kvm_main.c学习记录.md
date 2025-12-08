---
title: kvm_main.c学习记录
categories:
  - KVM
tags:
  - KVM
date: 2025-10-03T19:28:00
---
1. 首先在全局入口处的` kvm_init` 对每个`cpu`都尝试获得了专属的变量地址
```c++
	    for_each_possible_cpu(cpu) {
        if (!alloc_cpumask_var_node(&per_cpu(cpu_kick_mask, cpu),
                        GFP_KERNEL, cpu_to_node(cpu))) {
            r = -ENOMEM;
            goto err_cpu_kick_mask;
        }
    }	
```

这里有`per_cpu` 为每一个CPU核心创建一个独立的变量副本，防止多core之间的竞争
2. 同时函数`cpu_to_node`涉及到了`NUMA`的知识。


```C++
    kvm_chardev_ops.owner = module;

    kvm_vm_fops.owner = module;

    kvm_vcpu_fops.owner = module;

    kvm_device_fops.owner = module;

  

    kvm_preempt_ops.sched_in = kvm_sched_in;

    kvm_preempt_ops.sched_out = kvm_sched_out;
```
这一部分代码的设计是较为通用的内核模块写法。用于竞态计数，防止计数不为0时rmmod内核模块以至于kernel panic
3. 最后的注册mics设备（杂项块设备），给用户提供`/dev/kvm`