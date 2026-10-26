# DeepSeek V4.1 Flash 1017：从模型配置找到 DeepInfer 的实现位置

本页固定模型 `deepseek-ai/DeepSeek-V4.1-Flash-1017@1bae0e1088993b9b82de08f59de5be5a34e42170`，与本次 DeepInfer 的默认 checkpoint 一致。主干是 **40 层、每个 token 的隐藏向量宽度 5120**，另有 3 个多 token 预测层和一个视觉编码器。它不是“43 个同样的主干层”。

配置回答“模型由什么组成、每部分多大”；引擎源码回答“怎样调度、搬运和计算这些部分”。MFU 是观察这些设计的一个角度，配置本身不能证明吞吐、MFU 或加速倍数。本页未运行模型或 GPU 基准。

## 先看一条数据路径

教学简图：文本 token → embedding → 40 层主干 → 输出头 → 下一个 token。主干的每层包含注意力、MoE 和 mHC 相关操作；第 1、14 层还接入 Engram。图片先经过视觉编码和投影，转换成能并入文本流的特征；多 token 预测分支利用主干信息提出候选，再由推理流程验证。这里的箭头表示职责关系，不表示所有分支在每个请求中都一定执行。

源码装配依据：[V41Builder.build_model](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/model_executor/models/v4_modules/builder.py#L93-L130) 依次创建 embedding、主干 block、主输出头与 DFlash 预测模块；[_build_block](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/model_executor/models/v4_modules/builder.py#L45-L74) 按层挂入 Engram 和共享拓扑。

本页所有层号都从 **0** 开始；“第 1 层”指代码中的 `layer_id=1`，即按自然数计数的第二层。

## 配置参数与直观含义

| 部分 | 固定配置值 | 初学者如何理解 |
| --- | --- | --- |
| 文本主干 | `num_hidden_layers=40`，`hidden_size=5120` | 40 次逐层加工；每个位置的主表示是 5120 维 |
| 词表 | `vocab_size=129280` | token ID 对应的词表规模，不是 Engram 的哈希表规模 |
| 注意力 | `num_attention_heads=64`，`num_key_value_heads=1`，`head_dim=512` | 64 个 query 头使用共享 KV 表示；不能把 `64×512` 当成主干 hidden size |
| 注意力投影 | `q_lora_rank=1280`，`o_groups=8`，`o_lora_rank=1024` | query 和输出投影采用分阶段、分组结构；这些 rank 是网络结构参数，不表示下载了 LoRA 微调适配器 |
| 位置编码 | `qk_rope_head_dim=64`，`rope_theta=10000` | 每头 512 维中有 64 维用于旋转位置编码 |
| 局部窗口 | `sliding_window=128` | 注意力存在覆盖近邻 token 的局部窗口分支 |
| 上下文上限 | `max_position_embeddings=1048576` | 配置声明的上限是 1,048,576；实际可运行长度还取决于显存和部署设置 |
| 长上下文位置扩展 | YaRN，`factor=16`，原始长度 `65536` | 配置记录如何扩展位置编码范围；不代表速度提升 16 倍 |
| 主干 MoE | 384 个路由专家，token 选择 6 个，另有 1 个共享专家；专家中间维度 2304 | 每个 token 只交给部分专家加工，路由选择和共享专家是不同路径 |
| 路由 | `sqrtsoftplus`，`noaux_tc`，归一化 top-k 权重，缩放 1.5 | 这些字段决定专家评分与选中结果如何组合 |
| mHC | `hc_mult=4`，Sinkhorn 迭代 20，`hc_eps=1e-6` | 残差通路有 4 份并通过混合连接交换信息；不是把 40 层变成 160 层 |
| Engram | 层 `[1,14]`，最大 n-gram 长度 4，8 个头、每头 256 维 | 在指定层根据相邻 token 组合查询额外记忆表示 |
| 多 token 预测 | `num_nextn_predict_layers=3`，`dspark_block_size=5` | 3 个预测层与块大小是不同概念；不能据此断言每轮一定接受 5 个 token |
| 预测分支 MoE | 128 个路由专家，token 选择 3 个 | 预测分支比主干使用更小的专家配置 |
| 视觉编码器 | 32 层，hidden size 1024，16 头，中间维度 2816 | 视觉输入有独立编码网络，随后投影到文本主干宽度 |
| 视觉切块与压缩 | patch size 14，downsample ratio 3，最多 1024 image tokens | 图片切块、下采样后转换成视觉 token；不是每张图片固定 1024 个 token |

参数直接依据：[官方 config.json](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/blob/1bae0e1088993b9b82de08f59de5be5a34e42170/config.json)。本仓保留[原始结构配置](../references/model-config/config.json)和命名更贴近官方最小推理实现的[inference/config.json](../references/model-config/inference/config.json)。

## 从模型定义读到具体模块

本仓还保留同一 revision 的三份官方模型定义。它们来自 **Hugging Face 模型仓**，用于理解模型结构；DeepInfer 的运行时实现则通过固定 commit 的外部源码链接对照。

| 想理解什么 | 官方模型定义入口 | DeepInfer 对应入口 |
| --- | --- | --- |
| 模型怎样装配 | [model.py](../references/model-architecture/inference/model.py)：`Transformer`、`Block`、`ModelArgs` | `V41Builder`、`DeepseekModel` |
| 注意力怎样分支 | 同文件：`Attention`、`Compressor`、`Indexer`、`select_candidate_blocks` | `v4_modules/attn.py`、`compress.py`、`index_attn.py`、`cross_layer.py` |
| token 怎样选专家 | 同文件：`Gate`、`Expert`、`MoE` | `v4_modules/moe.py` 以及引擎的分发、合并和负载均衡代码 |
| Engram 记忆从哪来 | [engram.py](../references/model-architecture/inference/engram.py)：`EngramLayout`、`NgramHashState`；model.py：`ParallelEngramEmbedding`、`Engram` | `engram_metadata.py`、`engram_parameters.py`、`engram.py` |
| mHC 怎样包住子层 | model.py：`Block` 的混合与残差处理 | `hc.py`、`mhc_ops.py`、`mhc_modeling.py` |
| 预测分支怎样组成 | model.py：`DSparkAttention`、`DSparkBlock`、`DSparkMarkovHead`、`DSparkConfidenceHead` | `models/mtp/dflash.py` |
| 图片怎样转成主干特征 | [vision.py](../references/model-architecture/inference/vision.py)：`PatchEmbed`、`ViT`、`Aligner` | `models/vision_encoder/` 与 `deepseek_vl.py` |

**不要用 `ModelArgs` 的默认值描述发布模型。** 官方 [model.py:45–48](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/blob/1bae0e1088993b9b82de08f59de5be5a34e42170/inference/model.py#L45) 明确说明这些默认值是演示用的小模型；例如默认 `n_layers=5`、`dim=1024`，本次发布配置实际是 40 层、5120 维。源码说明计算结构，配置给出这个 checkpoint 的真实尺寸。

这三份快照不是完整可运行推理包。它们仍引用未下载的 `kernel.py`、`image_processor.py`，还需要模型权重、tokenizer、运行环境和依赖包。官方参考代码也说明 DSpark 只实现前向计算，完整 speculative decoding 循环不在其范围内；不能据此推断 DeepInfer 的完整调度行为。保存范围及依赖说明见 [model-architecture/README.md](../references/model-architecture/README.md)。

## 注意力：局部窗口、稀疏选择和跨层共享分开看

这三个机制解决不同问题。局部窗口让当前 token 读取最近的一段上下文；稀疏索引从更远的历史中选择位置；跨层共享让多个层复用某个来源层产生的 KV 或索引结果。不能把它们都画成一个“缓存压缩”方框。

`compress_ratios` 的前 40 项对应主干，最后 3 项对应预测层：

| 主干层号 | `compress_ratios` | 稀疏/压缩分支 KV 来源层 | 稀疏索引结果来源层 | 其他标记 |
| --- | --- | --- | --- | --- |
| 0–1 | 0 | 不参加下列共享段 | 不参加下列共享段 | 局部窗口层；Engram 在 1 |
| 2–7 | 2 | 2 | 2 | 2 是该共享段的生产层 |
| 8–13 | 2 | 8 | 8 | 8 是该共享段的生产层 |
| 14–19 | 2 | 14 | 14 | Engram 在 14 |
| 20–23 | 1 | 20 | 20 | 20 产生候选块；YOCO consumer 区间从 20 开始 |
| 24–27 | 1 | 20 | 24 | 重新选择索引，继续复用 20 的 KV |
| 28–31 | 1 | 20 | 28 | 同上 |
| 32–35 | 1 | 20 | 32 | 同上 |
| 36–39 | 1 | 20 | 36 | 主干的最后一个索引共享段 |

`ratio=0` 被 DeepInfer 解析成局部窗口规格；正值进入稀疏/压缩分支，`ratio=1` 仍在该分支，只是不做 2:1 的时间维压缩。因此“后 20 层 ratio=1”不等于“后 20 层改回全量稠密注意力”。每个共享段还保留各层的局部窗口处理，表中 KV 来源专指共享的稀疏/压缩分支。

这一映射不是按名称猜测：[`_source_map` 与 `_shared_layer_cfg`](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/hugging_face/config.py#L62-L85) 将每一层映射到前方最近的来源层；[`_win_spec` / `_compress_spec` / `_build_attn_module_list`](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/hugging_face/config.py#L99-L161) 定义 ratio 的解释。配置缺少独立的 `index_k_source_layer_ids`，当前解析器让 index-K 来源沿用 KV 来源；**index-K 共享与 index-topk 结果共享是两张不同的映射**。

稀疏索引自身有 32 个头、每头 128 维，`index_topk=512`。第 20 层还提供候选块筛选：最多 2048 块、每块 8 个位置，后续索引阶段在这些候选块内选择。`2048×8=16384` 是该配置的候选容量推导，**不是最终注意力固定读取 16384 个 token**；有效位置数量会受到实际序列长度、掩码和运行路径影响。源码语义见 [SharedLayerTopology](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/model_executor/models/v4_modules/cross_layer.py#L35-L53)。

## CED / YOCO：结构共享为减少后半段 prefill 工作创造条件

配置可直接确认：KV 来源层为 `[2,8,14,20]`，第 20–39 层共享来源层 20 的稀疏分支 KV；索引结果按更细的段共享。DeepInfer 由第一个 `ratio=1` 的位置得到 `n_prefill_layer=20`，实际 [`is_yoco_consumer_layer`](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/model_executor/models/v4_modules/yoco.py#L14-L21) 判定 consumer 区间为 `[20,40)`。

可视化应把主干画成 0–19 与 20–39 两段，并将第 20 层同时标为 consumer 边界、KV 来源和候选块来源。配置解析函数的说明注释对边界有歧义，此处采用实际谓词的含义。不要因某层是“KV 来源”就把它自动划入 encoder 区段。

官方部署文档将 CED 与 decoder SWA bounded replay 联系起来，说明后半段可以只重放有限后缀来准备局部窗口状态；这是建立在结构上的**运行时策略**，不能仅凭配置文件认定已经开启，也不能把官方部署环境中的收益当成本次实测。对应引擎入口为 [`yoco.py`](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/model_executor/models/v4_modules/yoco.py#L55-L115) 和 [官方部署说明](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/doc/inference_deployment_qa.md#L184-L187)。

## Engram、mHC 和预测分支怎样接上主干

Engram 的 `engram_vocab_size=16000000` 与模型词表 129280 不是同一概念；配置另记录 `engram_compressed_vocab_size=99092` 和两个 `engram_num_embeddings` 值 `384006168 / 384016682`。这些是结构字段，不能直接视为总参数量或显存字节数。DeepInfer 的解析器由 `max_ngram_size=4` 构造 2、3、4-gram 三组，每组 8 个头、每头 256 维；依据 [Engram 配置转换](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/hugging_face/config.py#L195-L214)。实际运行还需要同仓 tokenizer 来做压缩映射，本分析仓只保存结构配置，未获取词表。

mHC 可先理解为“让多份残差表示经过受约束的混合，再提供给注意力和 MoE”。配置给出 4 路和 20 次 Sinkhorn 迭代；源码实现还包含推理时的融合路径，把归一化、矩阵乘、混合、Sinkhorn 和应用混合合并到较少的算子入口。应把“模型采用 mHC”与“引擎怎样降低 mHC 的执行开销”分成两层。实现依据：[mhc_modeling.py](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/model_executor/models/v4_modules/mhc_modeling.py#L72-L140)。

预测分支字段以 `dspark_*` 命名，DeepInfer 内部构造成 `dflash_cfg`。它关联主干层 `[37,38,39]`，Markov rank 为 256，块大小为 5；配置中 3 个预测层、3 个主干目标层、3 个激活专家只是数值恰好相同，含义各不相同。具体转换见 [`_build_dflash_cfg`](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/hugging_face/config.py#L177-L192)，构建见 [builder.py](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/model_executor/models/v4_modules/builder.py#L108-L125)。本页不推定接受率或有效加速比。

## 量化字段不要混为一种精度

顶层 `dtype=bfloat16`，量化字段同时声明 FP8、动态 activation scheme、32×32 weight block、`scale_fmt=ue8m0`，专家为 FP4。它们描述不同类型张量/算子的处理方式，不能把整个模型统一称为“全 BF16”或“全 FP4”。DeepInfer 对这些格式有显式校验：[config.py](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/hugging_face/config.py#L253-L264)。

稀疏 KV 精度是另一个选项。本模型配置没有显式 `use_fp4_sparse_kv`；在本次固定的 DeepInfer 版本中，解析器为该字段采用 `True` 默认值。应将其标为**引擎默认行为**，而不是 HF 配置直接写明的事实。证据：[config.py:301–306](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/deepinfer/hugging_face/config.py#L301-L306)。

## 这些结构与效率的关系：可解释的方向，未测量的结果

| 结构或引擎机制 | 能解释的效率方向 | 仍需测量或核验 |
| --- | --- | --- |
| MoE 部分专家激活 | 减少每个 token 要执行的专家计算 | 专家间负载差异、分发通信和实际设备利用率 |
| KV 跨层共享 | 减少重复 KV 生产与存储 | 实际缓存布局、读流量以及完整请求延迟 |
| 稀疏索引与候选块 | 减少远距离注意力读取的候选范围 | 索引成本、序列长度、有效 top-k 和内核效率 |
| YOCO 后缀重放 | 在配置与路径适用时减少后半段 prefill 工作 | 是否启用、保留后缀长度、数值/质量边界和真实耗时 |
| FP8 / FP4 | 降低部分张量的存储或计算成本 | 量化转换开销、硬件支持、各算子的实际瓶颈 |
| mHC 算子融合 | 减少小算子启动与中间读写 | 调用路径是否选中融合实现以及端到端收益 |
| 多 token 预测 | 增加一次验证中可能接受的 token 数量 | 接受率、草稿成本与验证成本 |

“少做计算”不自动等于“MFU 数值更高”。定义 MFU 时必须交代有效 FLOPs 如何统计、硬件峰值采用哪种精度、测量窗口是 prefill 还是 decode、批量与长度是什么。这里提供结构和实现线索，无法仅凭配置证明 DeepSeek V4.1 Flash 在任何部署都能达到某个 MFU。

## 保存范围与复核

读取日期：2026-10-26（Asia/Shanghai）。上游 DeepInfer revision：`553741557a57df44a46fb3ab72b6aafeaf945337`。默认模型选择依据：[examples/_config.py](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/examples/_config.py#L32)。

本次下载 allowlist 为两组：`model-config/` 中的 `config.json`、`inference/config.json` 和 `LICENSE`，合计 6377 字节；`model-architecture/` 中的 `inference/model.py`、`inference/engram.py`、`inference/vision.py`，合计 74264 字节。总计 **6 个上游文件、80641 字节**。各文件已逐一与固定 revision 的官方文件树核对大小和 Git blob SHA-1，并计算 SHA-256；见[配置 manifest](../references/model-config/manifest.json)和[模型定义 manifest](../references/model-architecture/manifest.json)。

未下载权重、权重索引、tokenizer 词表、媒体、底层 `kernel.py` 或生成脚本，没有运行 `snapshot_download`，也没有把 DeepInfer 源文件复制到本分析仓。官方模型定义保留原始字节，未导入执行；各文件使用的 MIT 授权保存在 [LICENSE](../references/model-config/LICENSE)。
