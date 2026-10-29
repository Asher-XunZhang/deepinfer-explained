# 生产边界学习文档：可靠性核验与补充价值

核验日期：2026-10-27。对象为用户提供的《DeepInfer 专用推理引擎与生产系统边界学习文档》，该文件 SHA-256 为 `941804da4f2270bd6b518a1dd68707b1e0e36aff69c4ceb96ea9c92492fc64d8`。其第三方入口是 [kaiyuan / InfraTech《DeepInfer框架分析笔记》](https://mp.weixin.qq.com/s/-f6g4J3FMqR59YN2E-Ofrg)。本次读取学习文档全文及七张配图，没有重新提取公众号全文，也未独立核验公众号发布时间元数据。

对照基线为 `deepseek-ai/DeepInfer@553741557a57df44a46fb3ab72b6aafeaf945337`，与本站一致。审阅时线上七个 HTML 页面与本地站点版本 `1e1b480ca4fc01436dd21e0e947555b73920591c` 的字节一致。

## 结论及证据等级

关键机制分析可作为本站补充材料，特别值得参考的是对象拆分、生命周期、条件与出口、参数语义和反例分析。可靠性有明确范围：源码可确认的行为、官方生产描述/估算、教学归纳不是同一种证据。下表是重点机制核验，不是对文章每句话、每个性能点或生产系统的独立认证；未构建引擎或运行 GPU 测试。

所有源码链接固定到上述提交。

| 核验项 | 结果与使用边界 | 一手依据 |
| --- | --- | --- |
| 引擎与生产服务边界 | 发布提供离线推理及核心能力；完整外部 KV 服务、VE/P/D 分离、跨 DP 副本 LB 未随该版本完整提供。Recipe 是另一个项目，不能归为永远未开源。 | [README:38–42][readme-scope]；[Q&A:19–35][qa-scope]；[LLMEngine:800–822][hooks] 的虚扩展点 |
| 文本入口与异步尾部 | `LLM._add_request` 会将文本编码；上层入口不只接收 token IDs。主循环无 unfinished 请求时仍调用 `flush_inflight_reqs`。 | [llm.py:144–186][llm] |
| 三种引擎角色 | NORMAL/PROMPT/COMPLETION 的职责与默认 ZOS 可由枚举确认；COMPLETION 不允许抢占后走 Prefill 重算，构造函数会拒绝该组合。 | [engine_type.py][types]；[scheduler.hpp:98–104][scheduler] |
| ZOS 的 N/N−1 顺序 | 当前 forward 后处理上一轮，再按需等待长度回传、修正采样元数据并执行当前 sample；Prefill/非 ZOS 当场处理，ZOS Decode 延后。方法调用顺序不等于硬件 trace。 | [worker.py:113–189][worker] |
| StateBlock 分区 | stored/dropped 是保存范围；P→D 需要两部分，跨请求保存取相应前缀。`state_size_to_disk` 来自 stored SWA 的 inference 布局，不能由名字推出存储介质。 | [cache_engine.py:221–240][state-layout]、[L265–306][state-size] |
| 生产中的 Block KV 与 SWA | 主 KV/indexer K 放独立 3FS，跨请求 SWA 放产出机主机内存，目录记录位置。可确认官方这样描述；外部目录、查找和搬运服务不是本文独立验证过的实现。 | [Q&A:129–177][qa-storage] |
| 命中与两类有界重放 | 官方分别说明 SWA 缺失时恢复 encoder 状态，以及 consumer/decoder 后缀重放；Block KV 复用不等于完整状态可直接续算。重放为近似，不是全量上下文逐位等价。 | [Q&A:179–191][qa-replay]；[YOCO 可见域代码][yoco] |
| 128 / 134 / 140 | 文档区分方向正确。134 对应官方所述 128+6 配置，不是所有运行配置的常量，更不是整个物理 StateBlock ring 的长度；源码还可能增加 extra-state。140 是 README 推荐保留值。 | [cache_engine.py:88–109][ring]；[environ.py:135–139][backtrack]、[L194–201][yoco-env]；[README:25][readme-yoco] |
| DSpark 与连续前缀 | 预算分配使用置信度累积乘积及排名选择；CUDA 路径通过两两比较计 rank，参考实现用排序。不能把离散高分候选直接当输出。CPU 总预算与设备侧长度重算需配合采样前元数据校正。 | [CUDA kernel:26–81][varlen-cuda]；[参考实现][varlen]；[worker.py:146–158][worker-correct]；[Q&A:262–264][qa-varlen] |
| 官方 DSpark 收益表 | 文档转述的并发 16 时 −1.5%、并发 60 时 +5.4% 与官方表一致。这是特定 EP64/DP64 数据上的估算，不是本站实测或普遍收益。 | [Q&A:245–256][qa-gains] |
| benchmark 与接受率折算 | 满接受记账采用 `1+nextn`；固定长度图用 `τ=1+nextn×a`，变长路径被作图函数明确拒绝。每 GPU 吞吐还要包含请求数和 CP，不能把满接受吞吐直接乘草稿接受率。 | [benchmark.py:397–408][benchmark]；[plot_pareto.py:58–68][plot] |
| 配图与模型顺序 | 学习文档对原组件图的纠偏成立：Engram 通过 `hc_post_intervention` 进入 `attn_norm_forward`，不能按图读成 MoE 后统一追加。3D 截图只适合定位，不能替代层数、来源及调用证据。 | [decoder_layer.py:111–145][layer] |

七张配图已查看。性能图中 EP64/DP64 的 384+64 experts 与 EP8/DP8 的 384+32 experts 同时改变了并行规模和冗余专家数量，因此只能比较这两套配置，不能隔离 EP 的单独贡献。Prefill 图横轴是单次 step 时延，不是完整 TTFT。原组件图需要采用学习文档的纠偏，不能直接移入本站作为执行图。

教学算例的算术也可成立：`2048−134=1914`；若对齐命中为 1792，退一块为 1664，重放区间为 `[1664,1792)`。这仍是省略短输入/空命中边界的生产策略示例，不是可直接执行的缓存查找算法。固定 `SPS=100, requests=60, nextn=3, CP=1` 时，满接受记账为 24,000，按 `a=0.75` 折算为 19,500；两者都不是本次测量。

## 对现有 Pages 的实际增量

| 优先级 | 补充内容 | 当前覆盖与适合接入的位置 |
| --- | --- | --- |
| 优先 | 一条生产请求经过 Recipe、Entrypoint、VE/P/D 和外部缓存；区分入口路由、Scheduler、EPLB 三种控制权 | 总览已有发布边界，尚缺外层请求/状态路径；补到总览，并连接已有内部模块图。 |
| 优先 | Block KV、stored SWA、dropped state 的保存、交接与失效关系 | 运行时/静态图谱已有块地址和引用；补足跨请求生命周期，不能只新增存储设备名。 |
| 优先 | Block KV 命中但 SWA 缺失的恢复；与 decoder/consumer 后缀重放分开；解释 128/134/140 | 模型页已有 YOCO 与 compact+140，缺少两类重放的统一定位和参数来源；连接运行时与模型页。 |
| 其次 | 官方性能图的坐标、配置、并发取舍和多变量归因；DSpark 在不同工作点的收益/退化 | 性能页已有 MFU 与 τ 公式，不必重复；补充如何读真实官方图和估算表，保留来源与口径。 |
| 其次 | 引擎角色合法组合，以及请求结束后仍需 flush 的尾部 | 请求页/运行时页已有基本调用链和 ZOS；用角色条件和收尾案例补强。 |
| 教学组织 | 现象 → 对象/模块 → 条件 → 证据；配套反例和自测 | 文档第 10 节的方法可跨章节采用，不需要再做一套重复课程。 |

ZOS 基本顺序、DP/EP/EPLB 基础、YOCO 三模式、结构化输出、确定性条件和 τ 公式在本站已有覆盖。作者对框架演化版本、未开放原因等未确认推测不采用；经营规模、收入或内部服务指标不拿来证明本站机制的性能。

本记录的初次核验只确认可采纳材料与分析方法，对应规则已写入根目录 `AGENTS.md`。2026-10-27 后续按用户要求实施为 [生产恢复章节](../production.html)：请求与缓存路径、StateBlock 生命周期、两类重放、角色与 flush、官方图读法及 DSpark 工作点；具体教学依据见 [production-mechanisms.md](production-mechanisms.md)，验收范围见 [verification.md](verification.md)。

## 2026-10-29：直接阅读原文后的增量复核

**结论：这不是一篇新的材料来源。** 用户此次提供的链接，正是上述学习文档的原文。其核心内容已进入本站；有价值的后续补充主要在集群负载均衡和部署规模，不需要再建一套缓存恢复、ZOS 或 DSpark 课程。

本轮按 ai-infra-wiki 的第三方资料规则执行：直接读取原文及重要配图，再检查旧资料、固定源码与现有页面；将可支持的补充选题和未公开实现分开。此次只更新核验记录，未撰写候选专题正文，未修改或发布前端。

### 阅读与比对范围

- 原文：《DeepInfer框架分析笔记》，kaiyuan / InfraTech。页面元数据 `ct=1793014200` 对应 2026-10-26 19:30（Asia/Shanghai），本轮读取日期为 2026-10-29。
- 已直接提取 `js_content` 全文，读到第 13 节、结语及参考文献；正文 9 张图片中，7 张为技术图，另外 2 张为关注引导和二维码。
- 七张技术图的 URL 与 ai-infra-wiki 已有来源记录一致，本地图片 SHA-256 与其清单一致，并逐张阅读。模型组件图仍有执行顺序误导，不能直接复用为源码图；两张性能图必须保留配置和指标口径。未重新下载或向本站复制第三方图片。
- 源码仍固定为 `553741557a57df44a46fb3ab72b6aafeaf945337`，只读且工作区干净。没有重新定义上游最新版本，也没有 GPU 实测。
- 站点基线为 `29de3ad9b389600195cca13bec85ee157ef8d560`。本轮下载比较了线上八个 HTML 页面及 `assets/production.js`，均与本地字节一致。因此下列判断针对当前已发布内容，不只针对旧分析稿。

### 已覆盖的内容：保持现状

| 原文主线 | 当前页面 | 复核结论 |
| --- | --- | --- |
| 模块分层、请求进入引擎、分块和投票 | [总览](../index.html)、[请求调度](../scheduling.html#req) | 已有模块职责、对象流转、源码摘录和边界，原文目录表没有提供更深的增量。 |
| ZOS、在途结果、最终 flush、角色限制 | [运行时](../runtime.html)、[角色与收尾](../production.html#roles) | 当前内容已解释 N/N−1、COMPLETION 重算限制和最后一轮，保留。 |
| Block KV / SWA、stored / dropped、两类重放 | [状态生命周期](../production.html#state)、[恢复](../production.html#replay) | 已区分复用块与重建状态、近似恢复以及 128/134/140；比直接转述原文更明确。 |
| CED/YOCO、MoE、Mega MoE、EPLB | [模型与并行](../model.html#parallel)、[分析依据](model-parallel.md) | 现有页面包含完整返回路径、融合条件和专家副本映射，不需要重复增加概览动画。 |
| DSpark、结构化输出、确定性 | [输出机制](../sampling.html) | 已有机制和源码边界；原文不足以证明新的数值或质量结论。 |
| Pareto 图与接受率换算 | [官方图读法](../production.html#points)、[性能口径](../performance.html#evidence) | 已保留低并发负收益及多变量对照限制，不能换成笼统“吞吐提升”结论。 |

### 有实际增量的补充候选

以下是选题与证据评估，尚未作为站点实现。每项应连接现有页面，而不是复制其正文。

| 优先级 / 候选标题 | 核心问题、相对现状的增量 | 事实依据与边界 | 建议位置与表达任务 |
| --- | --- | --- | --- |
| 优先：从前缀命中到选卡——Prefill / Decode 负载均衡 | 现在只解释入口 LB 管实例/rank，未展开如何估计各 rank 的负载。补充 Prefill 四档上下文分桶、compute-quota、组间拉取、组内分配，以及 Decode 同时观察请求数和 KV 总长；说明共享缓存为什么能减轻前缀亲和对路由的约束。 | 原文第 13 节；[官方 Q&A:107–119][qa-routing]、[缓存共享前提:129–141][qa-shared-cache]。分桶边界为 <16K / 16–64K / 64–256K / ≥256K。成本模型与时间预算是官方生产描述；公开 Scheduler 可确认的是 token 预算等约束，不能把二者合成已公开的完整算法。 | 扩展 `production.html#path`，与 `scheduling.html#chunk` 互链；教学材料放 `analysis/production-mechanisms.md`。需要让读者辨认“总长度 / 新算长度 / 已有前缀”及“请求数 / KV 总长”各自回答什么，例子不伪造成本系数或路由最优性。 |
| 优先：P/D 实例与 GPU 的资源账 | 原文的部署规模与现有 Wide-EP 图之间缺少桥梁。解释 P 小 EP、D 大 EP、实例数与卡数的区别，防止把“1P+1D”理解为“两张卡”或把 P:D 卡数比当实例比。 | 原文第 5、13 节；[官方 Q&A:45–67][qa-topology]。P 为 EP2–8，D 为 EP64–128；官方给出约 1:1 的 GPU 比例与 64 P GPU + 64 D GPU 的高效起点。这是该生产快照的配置依据，不是所有硬件、流量的最小可运行规模或性能承诺。 | 在 `production.html#path` 附近补资源示意，并连接 `model.html#parallel`。先用静态表区分 GPU、rank、实例与组；具体生产配比仍须硬件及负载验证，不把上轮服务化报告的试点建议改称官方配置。 |
| 其次：EPLB 为什么看历史，而不每步搬权重 | 现有静态图已解释搬什么、何时切 map；可补统计窗口和重排周期为什么是两个不同参数，以及响应速度、统计噪声、搬运成本的取舍。该内容已在分析稿中，尚未充分呈现在页面。 | 原文第 5 节；[分析稿](model-parallel.md#机制-7eplb-复制热专家搬权重改映射)、[官方参数:95–103][qa-eplb-settings]、[执行条件:146–165][eplb-period]。官方 P 窗口/周期为 100/1000 step，D 为 1000/10000 step；不得写成所有模式的源码默认值。 | 补在 `model.html#parallel` 已有 EPLB 图旁，分析依据继续维护于 `analysis/model-parallel.md`。宜用统计窗与重排时点的简洁时间线，先解释机制；不需要再做一套专家搬运动画。 |

第一个候选最能补齐“缓存命中 → 负载估计 → 请求去向 → 单步预算”的因果链；第二个能澄清部署单位；第三个适合小幅增补。没有必要仅因阅读了原文再创建一篇全量框架综述。

### 原文中不能原样采用的判断

| 表述或图示 | 核验后的处理 |
| --- | --- |
| 前文将 Recipe 列入未开源组件，后文又提到其独立仓库 | 本轮确认 [官方 Recipe 仓库](https://github.com/deepseek-ai/deepseek-recipe) 公开可访问。本站继续标为独立项目；“不在 DeepInfer 仓内”不等于未开源。 |
| 末段称本仓 `LLM` 只接收已分好的 token | [文本入口:153–157][llm] 明确保留 `tokenizer.encode(prompt)`；本站已有文本/IDs 两条路径，不跟随原文改窄。 |
| 组件图把 Engram 排在 MoE 后 | [实际调用:111–145][layer] 将 Engram 作为 `attn_norm_forward` 的干预 hook；原图不作为执行顺序证据。 |
| 将 SWA 窗口约写成 134，或把有界重放理解为与层数完全无关 | 窗口、回退余量和保留后缀分别解释；[ring 计算][ring] 是窗口加回退。官方问答本身也使用了“与层数无关”的简写，但[模型前向:190–215][model-layer-loop]仍逐层执行；应限定为控制重放长度及恢复依赖范围，不能推出运行耗时不受层数影响。 |
| 猜测基于 vLLM 的具体历史版本、未开放原因，以及专用框架维护一定更容易 | 缺少可验证依据或统一比较尺度，不纳入源码事实。生产营收、集群规模也不用于证明某个引擎机制的独立收益。 |

本轮未发现需要立即改写已发布机制结论的新证据。真正值得推进的是上述补充选题；其公开实现缺口应继续保留，不能以教学可视化补出一个不存在的生产调度器。

### 2026-10-29：经用户授权后的实施结果

上述三个候选已补入现有章节：[Prefill / Decode 生产路由](../production.html#route)、[P/D 实例与 GPU 资源账](../production.html#pools)、[EPLB 统计窗口与重排周期](../model.html#eplb-cycle-title)。相关分析同步维护于 `production-mechanisms.md` 第 6、7 节及 `model-parallel.md` 机制 7。采用静态分档、对照表与时间线，保留原有交互，不复制文章图片或完整引擎源码。

验收特别区分了新 suffix 与本轮 q、请求数与累计 KV、实例数与 GPU 数，以及统计更新次数与重排动作次数。官方参数代入源码产生的 EPLB 冷启动时点属于条件化推导；部署比例不升级为所有硬件的推荐配比。具体页面、源码链接与浏览器核验见[发布核验记录](verification.md)。上面的“候选”与“尚未实现”保留为实施前评估记录。

[qa-routing]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/doc/inference_deployment_qa.md#L107-L119
[qa-shared-cache]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/doc/inference_deployment_qa.md#L129-L141
[qa-topology]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/doc/inference_deployment_qa.md#L45-L67
[qa-eplb-settings]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/doc/inference_deployment_qa.md#L95-L103
[eplb-period]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/model_executor/eplb/__init__.py#L146-L165
[model-layer-loop]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/model_executor/models/deepseek.py#L190-L215

[readme-scope]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/README.md#L38-L42
[qa-scope]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/doc/inference_deployment_qa.md#L19-L35
[hooks]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/engine/llm_engine.py#L800-L822
[llm]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/entrypoints/llm.py#L144-L186
[types]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/engine/engine_type.py
[scheduler]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/csrc/engine/scheduler.hpp#L98-L104
[worker]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/worker/worker.py#L113-L189
[state-layout]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/worker/cache_engine.py#L221-L240
[state-size]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/worker/cache_engine.py#L265-L306
[qa-storage]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/doc/inference_deployment_qa.md#L129-L177
[qa-replay]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/doc/inference_deployment_qa.md#L179-L191
[yoco]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/csrc/engine/input_metadata/prepare_tensor_input_v4.cpp#L149-L167
[ring]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/worker/cache_engine.py#L88-L109
[backtrack]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/environ.py#L135-L139
[yoco-env]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/environ.py#L194-L201
[readme-yoco]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/README.md#L25
[varlen]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/model_executor/layers/tilelang_ops/schedule_mtp_varlen.py#L20-L97
[varlen-cuda]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/model_executor/layers/tilelang_ops/cuda/schedule_mtp_varlen.py#L26-L81
[worker-correct]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/worker/worker.py#L146-L158
[qa-varlen]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/doc/inference_deployment_qa.md#L262-L264
[qa-gains]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/doc/inference_deployment_qa.md#L245-L256
[benchmark]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/examples/benchmark.py#L397-L408
[plot]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/examples/sweep/plot_pareto.py#L58-L68
[layer]: https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/model_executor/models/decoder_layer.py#L111-L145
