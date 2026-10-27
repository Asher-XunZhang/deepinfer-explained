# 生产系统、缓存恢复与性能图：补充教学依据

核验日期：2026-10-27；上游固定为 `553741557a57df44a46fb3ab72b6aafeaf945337`。本文沿用[可靠性核验](review-production-notes.md)的证据等级。本仓没有运行 GPU 实验；官方生产描述不能冒充公开引擎默认执行轨迹。

## 1. 一次请求跨过哪些边界

读者问题：为什么有推理引擎还需要路由、编码和缓存服务？引擎内部批次调度并不决定整个集群的资源去向。

- Recipe 负责 API 协议与模型 token 序列之间的编码/解码，是独立开源项目。Entrypoint 承担入口及缓存匹配/路由相关工作；VE 处理图片嵌入，P 处理提示词，D 持续生成。无图片请求无需经过 VE。这里的 VE/P/D 是生产部署角色，不是请求必经的三个 Python 类。
- 入口 LB 选实例/rank；引擎 Scheduler 选本轮序列、chunk 和 token 预算；EPLB 决定专家的物理放置及副本。三者处理不同对象，不能画成一个调度器。
- 官方的缓存 matching 先查询元数据，命中长度必须在路由前得到，这段不能隐藏。fetch 是独立进程把 Block KV 从 3FS 拉到主机共享内存；swap-in 在引擎进程内按层搬到 HBM，目标是与 forward 重叠。不是匹配、拉取、搬入都自动免费；更不能把所有箭头叫网络流。
- 公开代码提供核心计算、调度、缓存布局和若干扩展点。`init_pd_split`、`do_save_kvcache` 等虚函数不是完整外部服务实现；`should_copy_state` 基类返回 False。

证据：[Q&A:19–39](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/doc/inference_deployment_qa.md#L19-L39)、[Q&A:107–123](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/doc/inference_deployment_qa.md#L107-L123)、[Q&A:129–159](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/doc/inference_deployment_qa.md#L129-L159)、[llm_engine.py:800–822](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/engine/llm_engine.py#L800-L822)。

## 2. 命中 Block KV，不等于所有状态都齐了

读者问题：为什么已有长前缀还要重放？可跨请求复用的 Block KV 与继续计算依赖的滑动窗口状态是不同对象。

| 对象 | 请求执行期间 | P→D 交接 | 跨请求保存（官方描述） |
| --- | --- | --- | --- |
| Block KV：main KV + indexer K | 分页 HBM | 转移相关 KV | 独立 3FS；不受某台计算机的 SWA 副本丢失直接影响 |
| stored SWA | StateBlock 的 stored 区 | 与 dropped 一起交接 | 产出机主机内存；Entrypoint 分片内存目录记录位置，可远端拉回 |
| consumer SWA、压缩边界累加器 | StateBlock 的 dropped 区；执行仍需要 | 同样必须交接 | 不随 stored SWA 保存；consumer 依赖重放，压缩边界对齐使累加器无跨保存边界依赖 |

stored/dropped 是保存范围，不是磁盘/内存二分。不要把 `state_size_to_disk` 字面名译成 SWA 已上磁盘。保存副本、正在使用的 HBM state 和 P→D 传输是三个不同生命周期。

官方 SWA 保存条件：只在 128 token 的倍数挂接。Prefill 只保存最后一个 chunk，末尾保留一个 token 后向下对齐；不足一个完整 128 单位则不保存。Decode 跨 128 边界时设备内复制到独立 replica 区，结束时保存最近完成的副本。主机副本缺失不意味着 Block KV 也缺失。

证据：[cache_engine.py:221–306](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/worker/cache_engine.py#L221-L306)、[Q&A:129–177](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/doc/inference_deployment_qa.md#L129-L177)。实际布局字段的计算与生产外部保存策略分开标注。

## 3. 两类重放：原因、对象和出口不能混淆

| 机制 | 触发/目的 | 哪些计算被重用 | 哪些状态重建 | 结果去哪 |
| --- | --- | --- | --- | --- |
| encoder SWA 缺失恢复 | Block KV 命中，但相应 SWA 不可用 | 已命中的 Block KV 原样复用，不重算、不覆盖 | 回退一个 128 窗口，重放前缀尾段，与新 suffix 一起前向 | 恢复继续处理需要的 encoder SWA |
| decoder/consumer 有界重放 | CED/YOCO 路径只在 encoder 层完整 Prefill，需要给 Decode 准备 consumer SWA | consumer 的 Block KV 来自 encoder hidden 的投影 | 只处理提示词末尾有限后缀，不跑全长 consumer Prefill | 给 Decode 使用；consumer SWA 不进跨请求前缀存储 |

官方说明的最小 128 重放区内，位置 i 的 SWA 只看 `[max(s,i−127), i]`，s 为重放起点。这是近似恢复。保留前缀 Block KV 不代表所有 attention 输入被截断；缩窄的是 SWA 可见域。具体公开实现的 off/mask/compact 见已有模型页与图谱，不重复为新机制。

教学算例（固定生产策略示例，不是通用缓存查询实现）：输入 L=2048，官方所述 134 余量给最大命中上限 1914；在此前提下假设实际 Block KV 命中 L1=1792。

- 匹配范围内有可用 SWA：无需 encoder 缺失恢复，命中取 1792；后续 suffix 长 256。不能据此说 consumer 也完全不重放。
- 没有可用 SWA：调度命中回退到 1664；`[1664,1792)` 的 128 tokens 只重建 encoder SWA，原 Block KV 仍复用；`[1792,2048)` 是新 suffix。不能画成 384 tokens 全部重新写 Block KV。
- 输入短、Block KV 未命中或不足一块不套用上述减法；教学控件若覆盖这些输入，必须显式处理空命中而不能产出负位置。

**128 / 134 / 140**：128 同时出现在 SWA 窗口和保存/查询粒度，仍需分清含义；官方 134=128+6 对应回退余量的特定配置。代码 inference ring=`window+MAX_BACKTRACKING`，物理 kvstore ring 还可能叠加 extra-state；140 是 README 的 consumer Prefill 推荐保留长度，不是 134 的新名字，也不是复制长度通用常数。默认 nextn=5、max backtracking 至少 nextn+1；保留长度需满足窗口+回退约束。

证据：[Q&A:179–191](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/doc/inference_deployment_qa.md#L179-L191)、[可见域计算](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/csrc/engine/input_metadata/prepare_tensor_input_v4.cpp#L149-L167)、[keep 条件](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/csrc/engine/input_metadata/prepare_tensor_input_v4.cpp#L349-L359)、[ring 大小](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/worker/cache_engine.py#L88-L109)、[配置](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/environ.py#L135-L139)、[README 推荐](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/README.md#L25)。

## 4. 角色约束与最后一次异步收尾

NORMAL 处理 prompt+completion；PROMPT 只处理 prompt；COMPLETION 只处理 completion。默认 ZOS 为 NORMAL/COMPLETION 开、PROMPT 关；不能把默认值说成不能配置。COMPLETION 没有 Prefill 通道，所以 `stop_preempted_request=false` 在构造 Scheduler 时被拒绝；不是先等显存不足才偷偷切换到 Prefill。

ZOS 当前轮 forward 后，处理上一轮结果，再修正长度元数据并 sample 当前轮；因此“没有待调度请求”与“结果都已交付”不同。`LLM._run_engine` 在 unfinished=False 时走 `flush_inflight_reqs` 后再退出。教学收尾例可追踪最后一个 token 从 sample 完成、在途 state、post-process 到 RequestOutput；不可把普通轮的当前 sample 先画在上一轮 post-process 前。

证据：[engine_type.py](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/engine/engine_type.py)、[scheduler.hpp:98–104](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/csrc/engine/scheduler.hpp#L98-L104)、[入口收尾](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/entrypoints/llm.py#L174-L186)、[worker.py:113–189](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/worker/worker.py#L113-L189)。

## 5. 读官方图，而不是把工作点叫普遍加速比

读者问题：为什么单用户速度与每卡吞吐可能朝不同方向变化？批量增加能改善资源使用，也增加每步工作；不同指标回答不同问题。已有 MFU/τ 公式保留，此处增加具体图的读法。

- [Prefill 原图](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/doc/images/prefill_pareto.png)：横轴 `ms/prefill step`，不是 TTFT；纵轴非缓存输入 tokens/s/GPU；点标注是每 DP rank 的 batch tokens。条件 EP4DP4、384+32 experts、context=131072、decoder replay keep=140。不要从图片像素编造精确数据点。
- [Wide-EP Decode 原图](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/doc/images/wide_ep_decode_pareto.png)：横轴每用户 tokens/s，纵轴每 GPU tokens/s，点标注每 rank 并发请求数。共同条件 context=131072、固定 nextn=3、a=75%、τ=3.25；对照是 EP64DP64/384+64 experts 与 EP8DP8/384+32 experts，两因素同时变了，不能声称隔离了 EP 贡献。
- 满接受 benchmark `SPS×requests×(1+nextn)/CP`；固定长度作图 `SPS×requests×τ/CP`。教学 SPS=100、requests=60、nextn=3、a=.75、CP=1 时分别为24000和19500。固定图的 τ 算法明确拒绝 VARLEN=1；不能二次折算。

官方 DSpark 表（EP64/DP64 benchmark 推算，非本站实测）：

| 并发 seqs/rank | fixed-5 验证长度 | 动态验证长度 | fixed 接受长度 | 动态接受长度 | fixed tok/s/rank | 动态 tok/s/rank | 官方收益 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 16 | 5 | 4.44 | 3.32 | 3.24 | 4891 | 4816 | −1.5% |
| 32 | 5 | 3.65 | 3.25 | 3.17 | 8964 | 9111 | +1.6% |
| 48 | 5 | 3.94 | 3.30 | 3.26 | 12032 | 12467 | +3.6% |
| 60 | 5 | 3.58 | 3.30 | 3.21 | 13730 | 14466 | +5.4% |
| 72 | 5 | 3.24 | 3.29 | 3.12 | 14962 | 15961 | +6.7% |
| 96 | 5 | 3.24 | 3.30 | 3.15 | 16817 | 18660 | +11.0% |

由表可见少验 token 不保证更高吞吐，接受长度也略变。可以切换真实离散工作点，不对未提供并发做插值预测，不将相关变化证明为唯一因果。不要把 nextn=3 的固定长度图与 fixed-5 的 DSpark 表合并成同一实验。

证据：[Q&A:245–264](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/doc/inference_deployment_qa.md#L245-L264)、[benchmark](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/examples/benchmark.py#L397-L408)、[固定长度坐标](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/examples/sweep/plot_pareto.py#L58-L75)。

## 教学验收

读者在默认画面应能认出对象与各自用途，预测 SWA 可用/缺失后重放范围如何变化；区分两类重放、三种控制权和三个参数；从 16 与 60 的工作点说明为什么收益必须带条件。文字、图形、交互状态和源码锚点必须一致。静态图、条件交互和连续动画按问题选择，不因新增内容强制增加动效。允许有必要的短源码摘录，不复制上游源码文件或权重，不移入未经许可的第三方图像。
