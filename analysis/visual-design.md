# 图形选择与参考案例

本站按读者的问题选择表达形式。以下是从优秀原创图解中提炼的设计方法，不是学习效果实验或性能测量。核验日期：2026-10-26。

## 本站采用的表达

| 学习问题 | 本站的表达 | 读者可以直接追踪的内容 |
| --- | --- | --- |
| KV 在哪里，哪些对象共享它？ | `atlas.html#kv` 静态剖面 | 序列位置 → 逻辑页 → block table → 物理块与槽；引用与未写入容量分开 |
| 哪些层生产、复用或重新计算？ | `atlas.html#layers` 来源对照 | 同一个 consumer 对应的 KV、index-K、TopK 来源 |
| YOCO 三种模式到底改了什么？ | `atlas.html#yoco` 同坐标矩阵 | SWA 可见域、query 行数、仍保留的完整 KV；不把 SWA 空集当作全部 attention key 空集 |
| 改调度条件会怎样？ | 调度页的静态全流程与参数控件 | 预算、want/fit、空闲块变化后，条件、分支、结果和块账本统一重算 |
| 数据何时交接，谁在等待？ | 请求流转、异步执行和草稿验证的连续动画 | 同一对象在模块间移动，暂停能观察中间态，继续不重新开始 |
| 谁路由请求，缓存从哪里来？ | `production.html#path` 静态流程与来源分支 | 请求控制流与缓存数据供应分开；3FS Block KV、主机 stored SWA 分别进入设备；图片由 P 调度 VE |
| Block KV 命中，为何还要重放？ | `production.html#replay` 同一 token 轴的双轨条件对照 | 第一轨仍复用全部命中 Block KV；第二轨只表示 SWA 重建位置，可用时为零，缺失时是命中区内的尾部子区 |
| 性能收益能否迁移到另一个并发？ | `production.html#points` 坐标解释与六组离散条形 | 官方配置、单位、接受率口径与正负收益同时保留，不连接成可预测的插值曲线 |

静态图默认就提供完整解释；参数交互回答具体的条件问题；连续动画补充时间关系。播放速度是教学节奏，不能作为 GPU 时序、吞吐或 MFU 的测量依据。

2026-10-27 的生产恢复增补以静态图和条件交互为主。恢复实验的图条表示逻辑 token 位置和重建工作，不能当作实际 SWA 物理存储布局：可用 SWA 不代表整个命中前缀都保存了 SWA；“复用 1792 + 新 suffix 256”与“其中 128 需要 SWA 重建”是重叠的工作范围，不应相加为输入长度。生产组件边框的证据等级与箭头的数据/控制含义分别解释。原官方性能图保留固定来源入口，本站依据明确数值表原创重绘 DSpark 条形，不从图像像素推定精确点值。

## 原创参考与迁移边界

- [Raph Levien：Rust container cheat sheet](https://docs.google.com/presentation/d/1q-c7UAyrUlM-eZyTo1pd8SZ0qwA_wYxmPZVOQkoDmH4/edit)：共享图例，区分对象、指针、分配和容量。借鉴到 KV 的逻辑/物理剖面。2017 年的历史图不能证明当前 Rust ABI，也不能证明 DeepInfer 的字节布局。
- [Jay Alammar：The Illustrated Transformer](https://jalammar.github.io/illustrated-transformer/)：从整体到局部保留模块身份。借鉴到引擎总览、模型层和 attention 分支；本站结构和维度仍取自固定目标源码。
- [Amit Patel：Diagram structure](https://www.redblobgames.com/making-of/diagram-structure/)：控件、输入、算法、输出和图形之间有明确依赖。借鉴到调度预算和投票条件；控件改变输入，图和解释来自同一结果。
- [Edward Yang：PyTorch internals](https://blog.ezyang.com/2019/05/pytorch-internals/)：区分逻辑视图、索引和共享存储。借鉴到 block table 与物理 KV；不套用文章年代的内部接口。
- [NVIDIA：NCCL Collective Operations](https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/usage/collectives.html)：固定 rank 排列，保持数据来源与去向可追踪。借鉴到并行数据分布；等长通信示例不代表 DeepEP 的变长路由或物理网络路径。
- [Simon Boehm：CUDA Matmul Worklog](https://siboehm.com/articles/22/CUDA-MMM)：同坐标网格清晰区分有效区、边界和不足区。借鉴到 YOCO 模式对照及 padding；原文硬件测量不能迁移成本站收益结论。

本站自行绘制目标机制，未复制这些参考中的图像素材。可复用的方法、来源和验收标准同时整理进本机 `deepseek-harness-frontend` Skill，后续交接按问题选取，不要求所有图使用同一布局或都增加动画。
