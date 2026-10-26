# 入口、采样与服务边界

## 整站覆盖与阅读路径

目标是完整源码教学：总览→请求生命周期→调度→内存→模型计算→并行通信→采样→边界与测量。按需提供机制索引、术语和源码反查。建议覆盖至少以下独立问题（可自主分组，不强制页数/布局）：

1. 全局模块地图：Python 入口/LLMEngine/C++ Scheduler/Worker/ModelRunner/model layers/kernel。点模块后看其服务的机制、输入输出、关键函数；点机制反查多个模块。
2. 一个请求从 prompt/token IDs 到返回 token 的生命周期。
3. Prefill/Decode、chunk、batch 的区别与预算。
4. ZOS 异步调度：CPU/GPU 时间关系，依赖保持。
5. paged KV、SWA state、预留/写入/释放。
6. V4.1 模型层与 CED/YOCO、mHC/Engram 等配套对象的位置（不能把所有文件讲成核心性能开关）。
7. 压缩稀疏 attention、indexer 选择与 FlashMLA。
8. MoE routing→dispatch→expert compute→combine，EP/EPLB。
9. DP/CP/EP 切分的对象、通信载荷和生产/开源差别。
10. kernels、low precision、CUDA Graph 与硬件适配。
11. DSpark 草稿/验证/接受/重采样、confidence 分配验证预算。
12. 普通采样与结构化输出状态机。
13. 模型配置/权重加载、视觉路径、启动拓扑。
14. 公开引擎与生产服务边界；MFU/观测与验证路线；术语/源码导航。

正文足够支撑理解，交互帮助解释独特因果，不要求每段都做动画。关键机制至少应有可控制的状态/条件演示；不同机制不套同一种移动卡片。禁止只有按钮切换说明文字就称为机制可视化。

## 离线入口

`examples/offline_inference.py:25-34` 计算 dp/cp/ep 与 world_size 关系；`examples/_launch.py:15-50` 按节点 RANK/WORLD_SIZE spawn 对应 DP 进程。这里 RANK 是节点 rank 的示例语义，不能混同每个 GPU 的 global rank。

`deepinfer/entrypoints/llm.py:90-142` 的 LLM.generate 批量加入请求，再运行引擎；`_add_request:144` tokenize，复制 SamplingParams；`_run_engine:168` 循环 step，随后 flush_inflight_reqs，clone输出并按 request_id 归并。prompt 是文本，token ID 是离散编号，KV 是中间张量，不应画成同一个对象。

LLMEngine 负责协调，不是 GPU kernel：初始化 155，workers 368，cache 416，add_request 472，step 860，flush 977，post_process 984；Worker/ModelRunner 是执行边界，C++ Scheduler 是批次与资源决策边界，pybind 把二者接起来。

## 采样与 DSpark

`deepinfer/model_executor/layers/sampler.py:56-93` 的文档和执行体说明：hidden states→logits→sampling processors→token；prefill 取末位，decode 开启 MTP 时先验证上轮草稿再准备下一轮。`Sampler.forward:114`；`_verification:411`；`get_accept_result` 调用 471；`finalize_verification` 519。

`deepinfer/model_executor/layers/sampler_utils.py:113` 的 `process_sampling` 处理 temperature/top-p/top-k/log-softmax，输入含 seq_seeds 和 sample_positions。`deepinfer/sampling_params.py:44-79` 定义每请求种子。README 的可复现要求是 NVIDIA 上 batch_invariant=1、MTP_varlen=0、固定 seq_seed；不能说“给同一随机种子即可无条件跨一切batch/设备复现”。

DSpark：草稿生成不等于最终输出；目标模型验证后只保留连续接受前缀，首拒绝处 residual 分布重采样，全接受时补一个正常采样 token。简单图可用草稿 [A,B,C]，接受 [A,B]、C拒绝并重采样 D；这仅展示结果分支，不能把接受算法误画成字符串相同检查。

`csrc/engine/mtp_varlen.hpp:150-266`：用历史 confidence 与 decode 性能曲线选 total_q，保留每序列一个基础 query，按预期收益分配额外验证；无曲线退回全 draft。考虑 ZOS 的 schedule_cnt/process_cnt，CPU 新一轮看不到最新结果。`deepinfer/model_executor/layers/tilelang_ops/schedule_mtp_varlen.py:36-98` 的参考实现：按 remap 取 confidence，对每序列做累积乘积，再全局排序选 extra_budget=total_q-num_seqs。其前缀概率不递增，因此保持前缀选择；同分按 flat index。

玩具预算：R1 confidence [.9,.8,.5]→前缀 [.9,.72,.36]，R2 [.6,.5,.5]→[.6,.3,.15]。两个请求各有1个基础 query，total_q=5意味着额外3个验证，选 .9,.72,.6，R1分2、R2分1，seqlen_q=[3,2]。改变预算/置信度会改变分配；不要把高confidence当成必接受，也不要拿示例算吞吐提升。

## 结构化输出

为什么需要：概率采样可能产生不合法JSON/语法，事后修补不能保证解码每步合法。输入 schema→编译 grammar→维护当前自动机状态→合法词表 mask→采样→推进状态。

`deepinfer/structure_output/compiler.py:54-71` 支持 json(strict)/regex/ebnf。`deepinfer/structure_output/so_matcher_builder.py:58-95` 在本地线程池编译，拒绝 serialized grammar；`submit:97` 与 `pump:109-120` 编好后才交回引擎入调度。**官方 Q&A 的专门 SO 机器是生产描述，当前公开 offline 是本地线程池，不能混画。**

`deepinfer/structure_output/matcher.py:58` XGrammarMatcher 保存状态、trigger 与回退；`deepinfer/model_executor/layers/sampler.py:302` 构造每步 bitmask，188/437 在采样前应用。MTP 有多步mask、试探推进/rollback，不只是最后清理字符串。

玩具 schema 要求字段 ok 为 boolean，输出示例为 `{ "ok": true }`：当前位置冒号后只允许 true/false，屏蔽词“hello”，重新归一化再采样。明确真实 tokenizer 的 token 可跨多个字符，图中逐字是教学简化。改变合法集合必须更新候选概率。此机制约束激活区域的合法续写，正常完成时满足语法；trigger 前可不受约束，长度截止或取消仍可能得到不完整 JSON（matcher.py:121-153；scheduler.hpp:1035-1051）。不保证内容正确；有编译/mask成本，不应列为无条件提高MFU。

## 视觉、配置与支持边界

`deepinfer/ve/multimodal_processor.py:29,93,105,164,248,281` 管理多模态预处理 worker、共享内存和回填；`deepinfer/ve/processor/image_processor.py:245,282` 处理任意分辨率图像；模型 `deepinfer/model_executor/models/vision_encoder/` 与 `deepinfer/model_executor/models/deepseek_vl.py` 把图像表征接入文本侧。画面要区分图片→patch→embedding 与文本 token IDs，不宣称每个模块都在同进程。

配置来自 `deepinfer/hugging_face/config.py` 与 `deepinfer/model_config_loader.py`；权重逻辑在 `deepinfer/hugging_face/loading.py`、`deepinfer/hugging_face/weights.py`；平台在 `deepinfer/platform.py` 与 `deep_cluster/hardware/`。低精度存储和计算精度应分开；支持 Linux、NVIDIA SM100/CUDA13 或 Ascend950/CANN9.2 是该版本README范围，不意味可以在本Mac跑模型。

`README.md:38-42`：完整KV cache服务、VE/Prefill/Decode分离服务、跨DP副本LB未包含。`deepinfer/engine/llm_engine.py:801-851` 保留 init_pd_split/do_save_kvcache/send_processed_prompts 等扩展钩子，不能以存在名字判断完整生产系统已经实现。本站展示生产外层是为了认清边界，不将其作为已复现功能。

性能解释：DSpark将验证算力投向预期更高的候选，但同时支付草稿和调度成本；结构化输出、视觉和加载帮助完整功能/冷启动，不是都直接提高稳态MFU。每机制应让读者看见适用条件与代价。
