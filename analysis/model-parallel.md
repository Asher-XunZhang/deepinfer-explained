# DeepInfer 模型、注意力与并行：给初学者的源码材料

分析版本：`deepseek-ai/DeepInfer@553741557a57df44a46fb3ab72b6aafeaf945337`。本材料基于本地源码只读检查；没有执行 GPU/NPU 推理、性能测试或质量评测。下面的数字算例均为教学模型，不是 V4.1 Flash 的实际模型配置或测量结果。

所有 `path:line` 均相对 DeepInfer 根目录。网页源码链接应固定为 `https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/<path>#L<line>`，不要链接滚动的 `main`。

## 阅读主线与证据边界

先看“一批 token 怎样经过模型”，再展开某一层的注意力和 MoE，最后看多张卡如何分工。性能是各机制旁边的一条解释线，不能替代完整调用关系。

这里的公开版本提供离线推理；README 明确把完整 KV cache 系统、VE/Prefill/Decode 分离部署、DP 副本之间的负载均衡列为本次发行未包含的完整服务组件。`doc/inference_deployment_qa.md` 描述的是 DeepSeek 的生产系统，不能把其中所有服务方框画成当前仓库已经实现的模块。

- 公开范围：`README.md:3`、`README.md:38`。
- 公开能力：Attention DP / balanced CP、MoE EP + EPLB：`README.md:12`。
- 生产部署当时不使用 TP/CP：`doc/inference_deployment_qa.md:45`、`:53`。这与公开代码支持 CP 不矛盾，是“实现能力”和“生产选择”两个事实。
- 生产 KV cache 和负载均衡尚未完整开源：`doc/inference_deployment_qa.md:21`。
- 文档中的吞吐、GPU-hour 收益、EP64 配置和 kernel 性能差距都是官方生产/测量叙述，不是本分析复现结果，也不是 MFU 测量。

### 总图的节点与箭头

```text
InputMetadata(input_ids、positions、各缓存地址、mask)
  │
  ├─ embed_tokens ── hidden_states
  │                    │
  │              [层 0 … 层 N-1]
  │                    │
  │          HC/残差混合 + attention norm
  │                    │
  │               V4Attention
  │          ┌─────────┼──────────┐
  │          Q       SWA KV    主 KV 压缩 / 复用
  │          │         │          ├─ Index-K / MQA 打分 / Top-k
  │          └─────────┴──────────┴─ FlashMLA ─ 输出投影
  │                    │
  │             HC/残差混合 + FFN norm
  │                    │
  │               DeepseekMoE
  │             gate → expert → combine
  │                    │
  │          输出 norm / head / sampler（另页展开）
  │
  └─ 每层有对应的 KVCache 视图
       CrossLayerRuntime 在本次 forward 的各层之间传共享值
```

实线表示张量经过的计算；虚线表示地址、索引、统计或控制。缓存和 `CrossLayerRuntime` 要画成旁路存储，不能误画成“每个 token 都要再经过的神经网络层”。Engram 仅在配置指定的层插入；DSpark/DFlash 的目标层特征从主干旁路提取，不是每层必经的额外主干。

## 机制 1：模型层到底执行什么

**解决的问题。** 模型 checkpoint 的模块和权重需要变成适合推理的执行顺序。对初学者先回答：每层的注意力负责读上下文，MoE 负责变换当前 token 表示；HC 负责主干信息的混合，不负责挑选专家。

**输入输出。** 输入为 token ID、位置、缓存映射与已有缓存；中间状态是每个 token 的 hidden vector；模型 forward 输出归一化 hidden states，再交给预测和采样路径。

| 模块 | 职责 | 入口证据 |
| --- | --- | --- |
| `DeepseekModel` | 建 embedding 和 decoder layers；依序调用各层；创建一次跨层运行时；输出归一化 | `deepinfer/model_executor/models/deepseek.py:59`、`:92`、`:154`、`:165`、`:190`、`:239` |
| `DeepseekDecoderLayer` | norm/HC → attention → norm/HC → MoE；保留 residual；可插入 Engram 和 DFlash 特征采集 | `deepinfer/model_executor/models/decoder_layer.py:97`、`:111`、`:143`、`:155`、`:162`、`:169` |
| `HCLayerMixin` | 混合多路 residual trunk；把上一子层的 post 与下一子层的 pre、RMSNorm 和可选 FP8 cast 合并 | `deepinfer/model_executor/models/v4_modules/hc.py:119`、`:141`、`:164`、`:174` |
| HF 配置转换 | 根据 `compress_ratios` 为每层选纯 SWA 或 packed KV attention；从 checkpoint 取得专家数、Top-k、共享来源 | `deepinfer/hugging_face/config.py:68`、`:99`、`:111`、`:146`、`:164` |

**构造容器与执行适配器要分两行画。** `V41Builder.build_model` 先组织 embedding、N 个 `MoeDecoderBlockHC`、预测头和可选 DFlash heads（`deepinfer/model_executor/models/v4_modules/builder.py:93`）。`MoeDecoderBlockHC` 主要提供稳定的 HF 权重路径，包含 attention 参数、norm1/norm2、`FusedExperts`、mHC 参数和可选 Engram embedding（`deepinfer/model_executor/models/v4_modules/hc_blocks.py:66`）；`HFModelParameters` 将其放在参数树中，另有 vision 参数树（`deepinfer/model_executor/models/v4_modules/containers.py:37`）。随后 runtime 的 `DeepseekDecoderLayer` 将这些参数适配成 `V4Attention` 和 `DeepseekMoE`（`deepinfer/model_executor/models/decoder_layer.py:85`）。因此“容器中存在一个模块”与“forward 实际调用某个 kernel”是两层事实。

**Engram 的位置与作用。** 它是基于 token n-gram 的稀疏查表补充：先由 `DeepseekModel.forward` 计算 n-gram hashes 并发起 fetch（`deepinfer/model_executor/models/deepseek.py:177`），`EngramRuntime.fetch` 从分片表取 embedding（`deepinfer/model_executor/models/v4_modules/engram.py:214`），`Engram.forward` 做融合 KV projection 和 gate，将结果混入 HC trunk（同文件`:107`、`:139`）。执行位置是上一子层 HC post 之后、当前 attention pre 之前的 intervention hook（`deepinfer/model_executor/models/decoder_layer.py:111`；`deepinfer/model_executor/models/v4_modules/hc.py:182`）。它不是 KV cache，也不是 routed expert；表分片使用单独的 Engram parallel group（`deepinfer/model_executor/models/v4_modules/engram.py:79`）。入门示意可用“相邻 2 个 token→hash→查表向量→gate 注入主干”，但实际 n-gram 长度与多头表参数来自配置，hash 碰撞/表查找不应被讲成检索外部文档。

**教学算例。** 用 3 个 token、2 层的小模型展示，当前 token 的方块在 attention 后改变颜色，在 MoE 后改变数值。旁边残差线保留上一状态，汇合点显示“混合信息”。实际模型层数、维度、专家数由加载的 checkpoint 配置决定，不能把 2 层或手绘的 4 路主干当作固定事实。

**性能因果。** 前一子层 post、下一子层 pre、norm、cast 原本需要多次读写同一 hidden，融合减少中间张量搬运和 kernel 启动。`hc.py:182` 说明融合范围；`:195` 的前置条件满足时才走 `_mega_mhc`。Engram 的 trunk intervention 会阻止该处 mega fusion（`:184`）。这是源码支持的优化方向，不能据此给出加速百分比。

**验证方法。** 从 trace 确认实际走了哪些融合 kernel，统计每层的 norm/HC 时间和临时张量流量；固定 checkpoint、batch、token 长度和 dtype。只比较函数数目不足以证明更快。

**容易误读。** `n_prefill_layer` 是零基边界，运行条件是 `layer_idx >= n_prefill_layer` 才是 YOCO consumer（`deepinfer/model_executor/models/v4_modules/yoco.py:19`）。`hugging_face/config.py:159` 的文字注释与返回首个 ratio==1 的 index 及上述边界有表述冲突，应以执行条件说明边界，不把该注释直接翻译成层数示意。

**交互建议。** 点击一层后展开成 4 个主步骤；再点击 attention/MoE 才进入下一层细节。节点常驻显示“输入 → 操作 → 输出”，右侧提供对应文件与函数。

## 机制 2：主 KV 压缩与 SWA 是两条不同的记忆路径

**解决的问题。** 长上下文的 KV 占用和读取成本大。主 KV 路径将一组 token 的表示合成更少的条目；SWA 路径保留最近窗口的局部 KV。模型可以同时利用压缩的长程信息和最近窗口。

**输入输出与模块分工。**

1. `V4Attention._init_compressor_and_indexer` 按输入来源融合投影；C2 有 gate score 和 latent 两部分，C1 不增加 gate 投影（`deepinfer/model_executor/models/v4_modules/attn.py:308`、`:328`、`:345`）。
2. `Compressor.forward_pre_norm`：C1 直接使用 BF16 投影；C2 把 FP32 投影分成 score/latent，再调用 prefill/decode 压缩 kernel（`deepinfer/model_executor/models/v4_modules/compress.py:82`）。
3. 压缩 kernel 按每个通道对组内 score 做 softmax，再用权重求 latent 加权和；不完整组的 score/latent 通过 state cache 跨步保留（`deepinfer/model_executor/layers/tilelang_ops/cuda/compress.py:97`、`:120`、`:146`、`:227`、`:278`）。
4. `Compressor.forward_store_kv_cache` 做 norm、RoPE、格式转换、写主缓存，同时可留下 norm 后/RoPE 前的 KV 给 indexer（`deepinfer/model_executor/models/v4_modules/compress.py:131`）。
5. `V4Attention._prepare_swa_kv` 处理局部窗口 KV；decode 将 SWA cache 作为主输入、压缩 cache 作为 extra 输入交给 attention backend（`deepinfer/model_executor/models/v4_modules/attn.py:402`、`:628`）。

**玩具算例。** 两个 scalar latent 是 2 和 6，score 是 0 和 ln(3)，softmax 权重为 1/4 和 3/4，得到压缩值 5。真实实现对各通道分别计算权重，向量、norm、RoPE、量化都未在此 scalar 模型展示。8 个 token 的 C2 路径形成最多 4 个完整压缩条目；SWA 另外保留最近 W 个局部条目。

**性能因果。** 压缩降低主 cache 条目数，能减少容量和后续读取压力；量化进一步影响每条目的字节数。代价是投影、softmax 加权、state cache 管理、量化/解量化，以及模型层面的近似表达。不能把 C2 直接标成“整层快 2 倍”或“总 KV 只剩一半”：还有 SWA、index-K、scale、对齐、跨层共享等空间和计算项。

**验证方法。** 分别记录主 KV、SWA、index-K、state cache 和 scale 的实际分配字节；用 trace 拆分 compression、cache load/store 和 attention 时间。模型架构中的压缩比例不是随意切换而保证同一语义的性能开关。

**边界。** 此 SHA 的 `Compressor.__init__` 只接受 C1/C2，并明确拒绝 compression overlap 与 APE（`deepinfer/model_executor/models/v4_modules/compress.py:73`）。不要混入其他 DeepSeek 版本的压缩比或架构。`ratio==0` 在配置转换中选择纯 SWA，不能传给 Compressor 当作“0 倍压缩”。

**交互建议。** 同屏双轨：上轨原 token→两两加权→主 KV；下轨窗口随当前位置滑动。用不同形状区分“原 token 的局部 KV”和“压缩条目”，避免让用户以为压缩条目还是原 token。

## 机制 3：稀疏索引先选位置，注意力再读内容；跨层还能复用

**解决的问题。** 压缩后的长上下文仍可能很大，不能每层每次都为所有远程 KV 做完整 attention。Indexer 做较便宜的评分，挑选 Top-k；后续 attention 只使用选中的主 KV 和局部窗口。

**调用与输入输出。**

| 阶段 | 输入 → 输出 | 负责模块 |
| --- | --- | --- |
| Index-K 投影 | norm 后、RoPE 前的主 KV → index-K | `deepinfer/model_executor/models/v4_modules/compress.py:32` `KProject`；`deepinfer/model_executor/models/v4_modules/index_attn.py:133` `store_index_kv` |
| Indexer 评分 | index-Q、index-K、head weights → 每候选位置的评分 | `deepinfer/model_executor/models/v4_modules/index_attn.py:56` `MQA`；`:284` `_compute_prefill_p_sum`，调用 DeepGEMM |
| 选位置 | scores → Top-k int32 索引，缺位为 -1 | `deepinfer/model_executor/models/v4_modules/index_attn.py:327` `_topk_prefill`、`:456` `_topk_decode`；调用 DeepSelect |
| 地址转换 | decode 的序列内逻辑索引 → cache 物理槽位 | `deepinfer/model_executor/models/v4_modules/index_attn.py:506` |
| 真正 attention | query + SWA KV + Top-k 主 KV → context vector | `deepinfer/model_executor/models/v4_modules/attn.py:589`、`:628`；`deepinfer/model_executor/layers/attention_backend.py:26`、`:77` |

MQA 的评分形式是 `relu(q @ k) * weights` 的多头加权结果；这是用于选位置的评分，不是最终 attention 的概率。此实现的 indexer Q/K 使用 FP4（E2M1 + UE8M0 scale），weights 和 p_sum 使用 BF16（`deepinfer/model_executor/models/v4_modules/index_attn.py:85`）。

**跨层复用是独立的一层优化。** `SharedLayerTopology` 的来源配置与 `CrossLayerRuntime` 不应合成一个笼统“共享 KV”方框。源码区分主 KV、index-K、Top-k 结果、候选块、prefill 已加载的主 KV 张量、prefill 已加载的 index-K 张量；各自可有不同的 source layer（`deepinfer/model_executor/models/v4_modules/cross_layer.py:277`）。`hugging_face/config.py:68` 从 checkpoint 的 source layer IDs 生成映射。候选来源层可先选块，后续 index source 只在候选块里计算 scores，再选具体 Top-k（`index_attn.py:97`、`:204`、`:284`）。

**玩具算例。** 4 个压缩条目的评分为 `[0.2, 0.9, 0.1, 0.7]`，Top-2 选择逻辑位置 1 和 3。另有 SWA 局部条目 5、6、7。图里最终有 2 个“主 KV 摘要”加 3 个“局部 KV”，不是 5 个原 token。下一层若共享 Top-k，就复用 1、3；若仅共享 index-K，则仍要重新用自己的 Q 评分。候选块可用“先选书架，再选书”作辅助类比，但要保留真实索引图。

**性能因果。** Top-k 减少完整 attention 的 KV 读取与点积；候选块减少 indexer 自身评分范围；跨层复用减少重复投影、索引计算和 cache unpack/load。新增代价是 indexer、Top-k、地址转换、候选缓存和共享生命周期管理。短上下文时新增工作的相对占比可能更大，实际盈亏必须测量。

**验证方法。** 固定模型/输入/batch，分开观察 `index logits`、`top-k`、`core attention` 时间、实际 Top-k 长度、候选覆盖和 cache 读取量。若修改模型稀疏选择还需质量评测，不能只比较速度。共享关闭的研究实验需保证合法且同语义的实现，不能把配置强行删掉当作等价基线。

**容易误读。** backend 传 `causal=False`（`deepinfer/model_executor/layers/attention_backend.py:133`）不意味着可以偷看未来：可见性已由前面构造的索引限定。索引 Top-k 和 MoE gate Top-k 是两套不同对象：前者选 KV 位置，后者选专家。

**交互建议。** “打分→选择→地址转换→读取”四步可单步播放；切换“独立计算/共享 index-K/共享 Top-k”时点亮具体被复用的数据，不能只让连线变色。

## 机制 4：YOCO consumer 的 bounded replay 为何能只跑后缀

**解决的问题。** Prefill 中，consumer 层需要为后续 decode 建好局部状态，但没必要让整段长 prompt 在这些层做所有 query/MLP 工作。实现保留有界后缀，重建 SWA；完整上下文的主 KV/Index-K 仍由专门路径准备。

**调用顺序。**

1. C++ `update_yoco_prompt_v4` 校验 `keep_tokens >= window_size + max_backtracking_tokens`；`fill_yoco_truncation_metadata` 生成保留行及 SWA 可见范围（`csrc/engine/input_metadata/prepare_tensor_input_v4.cpp:203`、`:349`）。
2. `DeepseekModel.forward` 在 `n_prefill_layer` 边界切换 compact metadata，并保留 full metadata（`deepinfer/model_executor/models/deepseek.py:190`）。
3. `DeepseekDecoderLayer.forward` 调 `compact_yoco_boundary`，分别得到 full 和 compact 路径需要的 hidden/residual（`deepinfer/model_executor/models/decoder_layer.py:134`）。
4. `V4Attention._store_yoco_full_kv` 使用 full hidden 写入完整主 KV 和 index-K；后面的 query 路径不重复写它们（`deepinfer/model_executor/models/v4_modules/attn.py:672`、`:769`）。
5. compact query 和 hidden 继续经过 consumer attention、norm 和 MoE；CP 模式在边界重新分配保留行（`deepinfer/model_executor/input_metadata/yoco.py:94`、`:130`）。

**输入输出。** 输入是 full prompt 的 hidden/metadata，以及 window、backtracking 和 keep 长度；输出是 full context 的主缓存，以及为最后一段 query 计算出的 consumer 状态和输出。`get_mask_view` 只改 SWA 可见域，仍保留全行计算；`get_consumer_view` 真正减行。两种模式共享可见性语义，但不能说两者都省同样的算力（`deepinfer/model_executor/input_metadata/yoco.py:1`、`:86`、`:94`）。

**玩具算例。** 12 个 token，位置 0…11，窗口 W=4，最大回退 B=2，保留 K=6。边界前处理全部 12 行，consumer 主要路径只保留 6…11；主 KV 支路仍准备完整 0…11 的信息。位置 6 的 replay SWA 只能看 6，位置 8 能看 6…8，位置 11 能看 8…11。真实可见下界还受 `swa_valid_start` 限制。

可见域公式（半开区间）来自 `yoco_swa_visibility`：`[max(pos-W+1, L-K, valid_start, 0), pos+1)`，再对空范围做 clamp（`prepare_tensor_input_v4.cpp:149`）。在 chunked prefill 中，即使一个 chunk 完全落在保留区间以前，compact 仍留最后一个 placeholder row；不能画成“每个早期 chunk 一行都不执行”（同文件`:222`）。

**性能因果。** 对长 prompt，consumer 的 query、后续 norm 和 MoE 行数减少；主 KV 更新并未消失。收益有边界转换/gather、full KV 分支和跨 CP 重分配成本。减少重算可提高每秒输出，但“必做 FLOPs 减少”与“硬件 FLOPs 利用率提高”不是同一件事。

**验证方法。** 仓库已有 `examples/yoco/README.md` 和 `examples/yoco/run_yoco_equiv_l2.sh`；在相同截断语义下比较 mask/compact 的输出一致性和实际处理行数，再用 profiler 看 consumer 时间。这里没有执行这些 GPU 验证。bounded replay 对全量 SWA 是近似重建；mask/compact 之间一致不等于与不截断推理完全等价（生产 Q&A 对近似的说明：`doc/inference_deployment_qa.md:183`）。

**配置边界。** README 为默认 V4.1 设置建议 `compact + keep_tokens=140`（`README.md:25`）；不能把生产 Q&A 中“最近 128 token”的叙述直接覆盖这个公开配置。公开环境变量默认是 `off`，不是默认启用（`deepinfer/environ.py:195`）。

**交互建议。** 水平 token 轴与垂直层轴同屏，明确画 full KV 支路；拖动 keep/window/backtracking 只模拟合法教学参数。必须显示被裁剪区域、实际保留行、完整 KV 支路和 decode 会用的 SWA ring。

## 机制 5：DP、CP、EP 是同一批 GPU 的不同分工视图

**解决的问题。** Attention 可让不同副本处理不同请求；一个长 prompt 的 query 工作可以分给多卡；MoE 的专家权重和工作也可以分给多卡。这三种划分不是三个依次执行的“模型层”。

| 名称 | 分什么 | 本仓库的落点 |
| --- | --- | --- |
| DP | 不同请求/批次的 attention 工作 | `deepinfer/model_executor/parallel_utils/parallel_state.py:91` 创建同 CP 坐标的 DP 组 |
| CP | 同一序列的 query token 工作，prefill 使用镜像/zigzag 分片 | `deepinfer/model_executor/models/deepseek.py:168`；`deepinfer/model_executor/layers/tilelang_ops/cuda/prepare_cp_mirror.py:73`、`:103` |
| EP | routed expert 的物理槽位及 token 的专家计算 | `deepinfer/model_executor/parallel_utils/parallel_state.py:101`；`deepinfer/model_executor/models/v4_modules/mlp.py:192` |

**精确 4 卡玩具拓扑。** 取 DP=2、CP=2、EP=4、ENP=1：rank `[0,1]` 和 `[2,3]` 是两个 CP 组；`[0,2]` 和 `[1,3]` 是 DP 组；`[0,1,2,3]` 是一个 EP 组。这直接来自 `ParallelProcessGroup.create_process_groups` 的 reshape，不是按名称猜出来的（`parallel_state.py:70`）。

**balanced CP 算例。** 8 个 query、CP=2，切为 4 个等长块 `[0,1] [2,3] [4,5] [6,7]`；rank 0 取首尾 `[0,1,6,7]`，rank 1 取中间 `[2,3,4,5]`。用“位置 i 的普通因果 attention 读 i+1 个 key”的教学成本估计，两卡各为 18；连续切半则为 10 和 26。实际稀疏/窗口 attention 的成本不同，示例解释 zigzag 意图，不保证真实时间完全相等。

**通信路径。** `CPManager.all_gather` 汇集 rank 的 token 轴分片（`deepinfer/model_executor/parallel_utils/cp.py:42`）。Attention 先发 compressor 投影的 all-gather，再做 Q 投影来重叠通信和计算（`deepinfer/model_executor/models/v4_modules/attn.py:782`）；SWA KV 也有 all-gather（`:449`）。模型末尾 gather hidden 并按 reverse index 恢复顺序（`deepinfer/model_executor/models/deepseek.py:241`）。CPU CP 对象广播使用共享内存 `MessageQueue`；设备组使用平台 NCCL/HCCL，另有 Gloo CPU 组（`parallel_state.py:17`、`:82`、`:94`、`:122`）。

**性能因果。** CP 分摊长 prompt 的查询计算并缓解因果位置造成的不均衡，代价是 all-gather、重排、padding 和等待；EP 把多个 attention rank 的 token 汇到对应专家，有机会形成更有效的 expert GEMM batch，代价是 dispatch/combine 通信和专家负载不均。DP/EP 组合让 attention 和 expert 采用不同粒度的并行。生产 Q&A 描述 prefill 较小 EP/DP、decode Wide-EP，是针对 HBM、带宽和吞吐的部署选择，不是所有规模都单调更快的定理（`doc/inference_deployment_qa.md:47`、`:49`、`:57`）。

**验证方法。** 固定总 GPU 数、总请求分布、输入长度和 SLO，记录每 rank token/expert 分布、collective 用时及重叠比例。对比拓扑时同时给全局吞吐、每用户 TPS/延迟和每 GPU 指标。单卡 busy 或 NCCL 活跃不等于有效模型计算增加。

**交互建议。** 同一 4 卡棋盘提供 DP/CP/EP 三个切换，GPU 位置不动，只改变分组与数据路由；同时保留“这一次分的是请求、query 位置还是专家”的说明。

## 机制 6：MoE gate → dispatch → expert → combine，以及 Mega MoE

**解决的问题。** 每个 token 只需要部分 routed experts；专家分散在 EP ranks 上，token 必须被送到正确专家，计算后再回到原 token。

**输入输出。** 输入 `[token, hidden]` 和有效 token mask；gate 产生每 token 的 Top-k 专家与权重；输出仍是原 token 顺序的 `[token, hidden]`。shared expert 在逻辑上为 token 提供额外共同路径，不属于 routed Top-k 计数。

| 阶段 | 谁做什么 | 证据 |
| --- | --- | --- |
| gate | 先选择模型的 logical routed expert，经 EPLB map 选择可用 physical slot；输出专家 ID/权重 | `deepinfer/model_executor/models/v4_modules/mlp.py:196`、`:359` |
| dispatch | DeepEP 将 hidden 和 routing 信息送到专家所在 rank，展开为专家所需的 token rows，累计 expert count | 同文件`:461` |
| routed compute | 第一次 grouped GEMM → SwiGLU（包含 routing weights）→ 第二次 grouped GEMM | 同文件`:406` |
| shared compute | shared up projection → SwiGLU → down projection | 同文件`:513` |
| combine | DeepEP 按 dispatch handle 汇回并合并结果，shared output 作为 bias 加入 | 同文件`:493`、`:600` |
| Mega MoE | gate 把选择结果写入 symmetric buffer；融合 expert 路径，支持融合 shared weights | 同文件`:528` |

此模型 gate 的配置检查是 `topk_method=noaux_tc`、`norm_topk_prob=True`、`scoring_func=sqrtsoftplus`（`mlp.py:164`）。不能拿常见“softmax gate”示意当作此实现的精确公式。

**玩具算例。** 有 4 个 logical experts，EP=2，每卡先放 2 个。token A 选 E0/E3，权重 0.7/0.3；A 的表示分别送至两张卡，得到 `0.7*f0(A)+0.3*f3(A)`，加上 shared 分支输出。token B 可能选择完全不同的专家。例子把 routed scaling factor 设为 1，只展示数据流；真实 scale 和 top-k 来自 checkpoint。

**Mega MoE 不能画成总会使用。** `use_mega_moe` 同时检查平台、运算 dtype 组合以及 EP 组是否在 scale-up/NVL domain 内（`mlp.py:184`）；满足时直接走 `mega_moe_forward`，否则显式走 DeepEP dispatch + grouped compute + combine（`:565`）。普通路径的分阶段图用于解释语义，实际 fused kernel 不必一一对应那些 CPU 调用或独立中间 buffer。

**性能因果。** EP 汇聚来自不同 attention rank 的 expert token，提高单次专家矩阵计算的工作量，减少小 GEMM 的浪费；低精度减少权重/激活字节；Mega MoE 将通信与专家计算组成更紧凑的路径，减少中间 materialization、启动和同步开销。代价包括 symmetric buffer、布局转换、拓扑限制、通信资源与计算资源的竞争。没有 trace 和数值测量，不能从“fused”推导固定 MFU 或固定倍数提升。

**验证方法。** 从实际路径和 kernel 名确认是否用 Mega MoE；记录 dispatch、expert GEMM、shared、combine 的时间/重叠，或 fused kernel 的端到端时间；报告每专家 token 数和 dtype。若比较 fused/unfused，需相同权重、输入、routing、数值标准、EP 拓扑；只拿两张不同硬件/不同 batch 的 trace 不构成因果验证。

**交互建议。** 每个 token 显示“逻辑专家→物理卡→返回合并”的完整往返。提供“展开语义”和“实际融合调用”视图，避免把 Mega MoE 理解成一种新专家结构。

## 机制 7：EPLB 复制热专家，搬权重，改映射

**解决的问题。** 即使每张卡有相同数量专家，也可能有一张卡的专家很热门。整个 EP 步骤容易被最忙卡拖住。EPLB 根据历史 token 统计调整专家副本的位置。

**输入输出。** 输入是历史每步、每层、每专家的 token 数，以及固定 physical slot 容量；输出是 logical↔physical 映射、每 logical expert 的副本数和与之对应的新权重布局。

1. `DeepseekMoE.dispatch` 或 mega kernel 累计 local physical expert count（`deepinfer/model_executor/models/v4_modules/mlp.py:474`、`:555`）。
2. `DeepseekForCausalLM.sample` 每步调用 `ExpertLoadBalancer.step`（`deepinfer/model_executor/models/deepseek.py:402`）；统计窗口和重排周期来自环境配置（`deepinfer/model_executor/eplb/__init__.py:102`、`:131`）。
3. `_rearrange_experts` 将 physical counts 聚合回 logical experts，EP all-reduce 汇总全局统计（`deepinfer/model_executor/eplb/__init__.py:223`、`:234`）。
4. `rebalance_experts_global` 为热点 logical expert 贪心分配冗余副本，再贪心放置到各 rank，目标围绕历史每步最忙 rank 的负载（`deepinfer/model_executor/eplb/policy.py:73`、`:105`、`:125`；具体目标`:43`）。
5. shuffle 实际搬权重，再更新三张映射表；scale-up GPU 可用 symmetric memory/IPC 路径，否则用另一 shuffle 路径（`deepinfer/model_executor/eplb/__init__.py:195`、`:261`、`:276`）。

**玩具算例。** 3 个 logical experts 的历史负载 `[12,4,4]`，2 张 GPU 各放 2 个 physical experts，总共 4 个槽，副本预算始终为 1。假设原副本给了 E1，理想均分后 E1a/E1b 各负载 2；布局为卡 0 放 E0+E1a、卡 1 放 E1b+E2，负载是 14/6。重排将副本预算改给 E0，每副本理想负载变成 `[6,6,4,4]`，再把 E0a+E1 放卡 0、E0b+E2 放卡 1，变成 10/10。重排没有新增物理槽位，也没有新增模型专家。实际算法看多步向量，不只看合计；路由也不保证每个新 batch 正好均分，此例是解释固定容量下的热点重分配。

**性能因果。** 热专家的副本摊薄热点，权重重排降低 rank 间差异，从而减少同步等待并让各卡更均匀地做有效 expert 工作。代价是额外权重显存、统计归并、shuffle 时间和基于历史预测未来的误差；重排过频或热点快速变化会影响收益。

**容易误读。** EPLB 不改变模型定义的 logical expert 数，也不是重新训练专家或把一个 token 无限制复制给所有副本。每卡 physical slot 数相同不等于负载相同。`moe_load_balance_ratio` 是 token 计数构造的负载代理，不是直接测得的计算时间比或 MFU（`deepinfer/model_executor/eplb/__init__.py:167`）。

**配置边界。** 生产 Q&A 的 prefill 100-step 窗口/1000-step 重排与 decode 1000/10000 等参数仅作官方部署例子（`doc/inference_deployment_qa.md:95`）；公开源码默认/实际配置必须另行读取。物理槽位总数需整除 EP size，`resolve_num_extra_experts` 会做补齐（`deepinfer/model_executor/eplb/__init__.py:21`）。

**验证方法。** 保留逐步 token 分布、rank latency、shuffle 耗时/频率和额外 HBM；用相同请求重放比较“关闭重排/固定布局/启用重排”，看端到端收益能否覆盖搬权重成本。不能只展示重排后某一步的漂亮柱状图。

**交互建议。** 左边 logical expert 固定不变，右边 physical slots 可移动/复制；上方显示 histogram，点击“重排”后同时改变权重位置和 map。把复制成本和等待减少分开显示。

## 机制 8：哪个库真正执行矩阵、注意力、Top-k 和通信

**解决的问题。** Python/C++ 引擎主要组织张量、缓存和执行顺序；高性能计算需要映射到硬件 kernel。初学者需要从机制点回到具体函数和供应库，而不是记一串项目名字。

| 引擎中的工作 | 直接调用 / 模块 | 下层实现与来源 |
| --- | --- | --- |
| 常规 BF16/FP8 linear | `deepinfer/model_executor/layers/linear.py:27`、`:140`、`:165` | DeepGEMM `bf16_gemm_nt`、`fp8_fp4_gemm_nt` |
| MoE grouped GEMM / Mega MoE | `deepinfer/model_executor/models/v4_modules/mlp.py:109`、`:254`、`:549` | DeepGEMM grouped GEMM、`fp8_fp4_mega_moe` / `bf16_mega_moe` |
| Sparse indexer logits | `deepinfer/model_executor/models/v4_modules/index_attn.py:284`、`:421` | DeepGEMM MQA / sparse MQA logits |
| 稀疏 Top-k | `deepinfer/model_executor/models/v4_modules/index_attn.py:12`、`:494` | DeepSelect `topk` |
| 核心 attention | `deepinfer/model_executor/layers/attention_backend.py:26`、`:77` | FlashMLA sparse prefill / KV-cache decode；可选 norm/RoPE/attention/cast 融合 |
| EP dispatch/combine | `deepinfer/model_executor/models/v4_modules/mlp.py:461`、`:493` | DeepEP `EPBuffer` |
| CP all-gather | `deepinfer/model_executor/parallel_utils/cp.py:16`、`:42` | DeepEP `BucketBuffer` / `BucketSession` |
| gate、量化、SwiGLU 等 | `deepinfer/model_executor/models/v4_modules/mlp.py:18`、`:436`；`deepinfer/model_executor/layers/linear.py:150` | TileKernels（另有 GPU mega gate 分支） |
| 压缩、cache gather/store、索引拼接、metadata、sampling 辅助 | `deepinfer/model_executor/layers/tilelang_ops/` | 本仓库 TileLang kernels，由 `tilelang_ops/ops.py:15` 选择 CUDA/Ascend 后端 |

**低精度教学例。** 只看数值 payload，1024 个 BF16 值占 2048 字节，FP8 占 1024 字节，FP4 packed payload 占 512 字节；真实内存还有 scale、对齐、布局、padding。减少字节可以改善 bandwidth-bound 阶段，并不自动等于相同比例的速度，也不代表所有算子都用最低位宽。此 MoE 支持的组合检查是 `fp8xfp4`、`fp8xfp8`、`bf16xbf16`（`mlp.py:177`）；indexer FP4 与主 KV 格式不能混成“整模型 FP4”。

**融合教学例。** “norm→RoPE→quantize→store”四个操作如果分别写回中间张量，需要多次读写和调度；`Compressor.forward_store_kv_cache` 的 fused call 让这一条变换链合在一起（`deepinfer/model_executor/models/v4_modules/compress.py:148`）。示意可用同一张量从内存搬出/写回次数对比，不能给虚构的毫秒数。

**平台映射。** `scripts/build_vendor.sh:7` 明确 NVIDIA 构建 DeepSelect/FlashMLA/DeepEP/DeepGEMM；Ascend 使用 DeepEP-Ascend/DeepGEMM-Ascend，并给 DeepSelect/FlashMLA 设置 ASCEND build target。`deepinfer/platform.py:55` 和 `:86` 选择 CUDA/NCCL 或 ASC/HCCL。README 当前支持硬件是 SM100 与 Ascend 950（`README.md:33`）；不能把“有 CUDA 目录”扩大成对任意 NVIDIA GPU 的支持承诺。

**性能因果。** 低精度改变单次搬运的字节和可用矩阵指令；布局/对齐让 kernel 更有效地访问和分块；融合减少中间流量与 launch；通信库管理跨卡 token 移动。代价包括 cast/scale 开销、数值误差和校验、平台特定的布局与能力限制。

**验证方法。** 先在 trace 中核实实际 kernel 和 dtype，再对对应 GEMM shape 看矩阵执行效率，对 cache-heavy 段看实际带宽，对通信段看链路/等待。不要根据 `nvidia-smi` 的 GPU utilization、算子名字含 FP8、或源码 import 了 DeepGEMM 就推断 MFU 已经很高。

**交互建议。** “机制→引擎入口→kernel API→供应库”四列映射可按机制筛选；不同颜色标计算、搬运、选择和控制。每个库在图上必须贴一项具体工作。

## 性能因果的统一表达

每张机制卡增加一行“它主要改什么”，供读者理解性能，而不把整站变成宣传图：

| 机制 | 主要影响 | 容易被漏掉的成本 | 必须观察的证据 |
| --- | --- | --- | --- |
| 压缩 / 稀疏 attention | 减少 KV 容量、读取范围及部分计算 | indexer、Top-k、压缩与 state | KV 字节、分段 kernel 时间、质量 |
| YOCO bounded replay | 减少 consumer 重算行数 | full KV 分支、compact/gather、近似 | mask/compact 校验、实际行数、consumer trace |
| EP / CP | 分摊工作或汇聚有效 batch | collective、padding、straggler | 每 rank workload、通信重叠、端到端延迟 |
| EPLB | 减少最忙 rank 拖累 | 副本 HBM、统计、shuffle | 逐步分布、等待、重排时间 |
| 低精度与融合 | 减少搬运，提升可利用矩阵吞吐，减少 launch | scale/cast、数值约束、布局 | dtype/shape/带宽/执行时间 |

必须区分两件事：“同样工作做得更有效”和“为生成结果少做一些工作”。前者可能改善特定口径的 MFU；后者可能提高吞吐但减少计算量。站点应把实际估计口径、硬件峰值口径、有效 token 与 speculative/replay/padding 的计数交给单独的性能页说明，不在这 8 张机制卡填入未经测量的 MFU 百分比。

## 前端最小验收清单

- 总图上每个机制都能点回“谁调用谁、传什么、结果去哪”，不能只有文件列表。
- 模型层序、cache 旁路、跨层共享、多卡分组必须使用不同视觉语法。
- 例子可单步、重置；所有示例数字标“教学模型”。非 CUDA 环境的动画不能标成真实推理 trace。
- SWA、主 KV、index-K、Top-k 索引、expert ID 需要清晰区分，尤其两种 Top-k 不能同名混用。
- YOCO 动画必须保留 full KV 路径，且说明 replay 近似；CP 动画必须保留恢复原顺序步骤；MoE 动画必须包括返回合并。
- 生产系统图使用独立区域或清晰证据标签，不能让用户误认为 `README.md:38` 的未包含服务已经在公开 engine 中。
- 性能收益使用“瓶颈→代码动作→预期影响→成本→如何验证”表述，不填伪造测量值。
