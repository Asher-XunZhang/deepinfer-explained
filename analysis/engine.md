# DeepInfer 引擎、调度与请求生命周期：源码交接

源码固定于 `553741557a57df44a46fb3ab72b6aafeaf945337`。所有路径均相对 `deepseek-ai/DeepInfer`，可用 `https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/<path>#L<line>` 构造永久链接。本文件来自静态源码阅读，没有运行 GPU/NPU 推理或性能测试。算例明确是缩小的教学模型，不能展示为测量结果。

## 先建立整机视图

一个请求不属于单一“神奇算法”：入口把文本变成 token；`LLMEngine` 串起生命周期；C++ `Scheduler` 决定本轮谁上设备、算多少；`Worker` 组织异步执行与同步点；`ModelRunner` 准备张量、执行模型、采样；模型层通过内部 KV/state 张量保存历史；结果再回到调度器记账。

### 可直接绘图的调用链

```text
LLM._add_request                       复制参数 → 分配 request_id → 编码/复用 token IDs
  → LLMEngine.add_request              创建 Sequence，请求入队
    → Scheduler.add_sequence           waiting 队列

LLM._run_engine 循环
  → LLMEngine.step
    → Scheduler.schedule
      → _schedule_prefill 或 _schedule_decode
      → SequenceMetadata + SchedulerOutputs
    → Worker.execute_model_step
      → ModelRunner.execute_main_model  准备输入 → graph replay / model(...)
      → 上一轮 post_process             ZOS 时在当前 forward 下发后处理
      → ModelRunner.execute_sample      model.sample(...)
      → pre_sampler_sync                回收和结束处理的安全位置
      → 当前轮立即处理或延后             prefill 立即；ZOS decode 延至下一轮
    → LLMEngine.post_process
      → process_MTPInfo
      → Scheduler.process_outputs       提交 token，更新 KV 计数，判断停止
      → build_request_outputs
  → 没有 unfinished 时 flush_inflight_reqs
```

证据：`deepinfer/entrypoints/llm.py:144-166`（`_add_request`）、`:168-186`（`_run_engine`）；`deepinfer/engine/llm_engine.py:594-630`（`add_request`）、`:881-905` 与 `:951-975`（`step`/`_execute_model_async_step`）、`:717-761`（`_process_model_outputs`）；`deepinfer/worker/worker.py:89-189`（`execute_model_step`）；`deepinfer/worker/model_runner.py:308-367`（forward/sample）。

入口顺序必须按源码画：`_add_request` 先 deepcopy `SamplingParams`、分配 `request_id`，之后才在没有 `prompt_token_ids` 时调用 tokenizer，最后转为 int32 数组（`deepinfer/entrypoints/llm.py:151-157`）。不要把“编码完成”画成分配请求身份的前提。

### 对象不是同一层的替代名字

| 对象 | 初学者理解 | 保存/输出什么 | 精确依据 |
| --- | --- | --- | --- |
| `Sequence` | 一张持续更新的请求档案 | 已提交 token、请求身份、KV 表、MTP 信息、状态 | `csrc/engine/sequence.hpp:275-320` |
| `SequenceMetadata` | 本轮执行单 | q/k 长度、block table、state ID、sampling 参数；多项借用 Sequence 数据 | `csrc/engine/sequence.hpp:325-385` |
| `SchedulerOutputs` | 本轮排班结果 | scheduled/finished/ignored、prompt_run、token 预算、clone 列表 | `csrc/engine/scheduler.hpp:45-76` |
| `WorkerStepState` | 尚待收尾的一轮执行 | metadata、采样输出、完成 event | `deepinfer/worker/zos_status.py:9-20` |
| `BlockManager` | 空闲槽位与引用计数账本 | 物理 block ID 的分配/归还；不保存 KV 字节 | `csrc/engine/block_manager.hpp:27-116`、`:119-186` |
| `CacheEngine` / `GPUCacheInterface` | 真正的设备内存及按层视图 | `gpu_blocks`、`gpu_states`、ca/ica/SWA 视图 | `deepinfer/worker/cache_engine.py:206-218`、`:918-966` |

画图时给“调度决策”“实际计算”“存储/引用”三类边不同图例。点机制必须同时高亮相关模块，点模块也应显示它参与哪些机制。

## 机制 1：长 prompt 如何分轮，又何时开始输出

**一句话**：prefill 处理输入历史；每个 chunk 都执行 sampling，但只有最后一个 prefill chunk 才提交首个输出 token，非最后 chunk 的采样结果被丢弃；之后 decode 持续提交新 token。一个 `step()` 不是“一整个请求”，也不保证“一轮只产一个 token”。

**源码事实**：

- 新请求经 `Scheduler.add_sequence` 进入 `waiting`，普通文本的 `schedulable` 默认为真。依据：`csrc/engine/scheduler.hpp:135-141`；`csrc/engine/pybind_sequence.cpp:25-36`（`make_sequence_init`）。
- prefill 从队头挑选；`get_len() - cache.num_tokens` 是尚需处理的 prompt 长度，不能用 q 与 cache 相减。`max_num_batched_tokens` 是全批总预算，`max_num_batched_tokens - num_batched_tokens` 才是本批剩余预算；本轮 q 由尚需处理长度、剩余预算和其它约束决定。请求数、累计 K 长度、block/state 容量也限制准入；CP 要求 `cp_align` 对齐，多模态切块不能任意切入 image pad 区。依据：`csrc/engine/scheduler.hpp:372`、`:440-511`；`csrc/engine/scheduler.hpp:90` 定义 `cp_align`。
- 未完成的 chunk 保持 `WAITING`，最后 chunk 被排入时标为 `RUNNING`；结果处理后，未完成 chunk 放回 waiting 队头，完成者进入 running。依据：`csrc/engine/scheduler.hpp:504-545`、`:937-953`、`:1011-1019`。
- 非最后 prefill chunk 将 metadata 的 `last_output_token` 置为 -1，供 sampler 跳过 **SO 状态更新**，不是关闭 sampling 的总开关。每个 prefill chunk 仍选末行进行 sampling；只有 `process_outputs` 判断 prompt 已覆盖完时才提交输出，未完成 chunk 的结果不进入输出历史。依据：`csrc/engine/sequence.hpp:386-387`；`deepinfer/model_executor/layers/sampler.py:339-340`、`:597-607`；`csrc/engine/prepare_sample.cpp:173-174`、`:197-198`；`csrc/engine/scheduler.hpp:937-940`、`:1011-1019`。
- decode 接受的 draft 前缀加一个 main token 被依次提交，遇停止条件即停；不能把所有草稿都画成已被用户看到。依据：`csrc/engine/scheduler.hpp:955-999`（`process_outputs`）。

**交互算例**：固定纯文本、CP=1、无 draft、资源充足、chunked_prefill 开启、全批总预算 4 且本请求可用满该预算，prompt 长 10。只跟踪该请求的有效 prefill 轮：`q=4,k=4 → q=4,k=8 → q=2,k=10`。前两轮执行 sampling 但不提交 token，第三轮提交第 1 个输出。第三轮后 `len=11`、`cache.num_tokens=10`：刚采样出的最后 token 尚未 forward。下一次 decode `q=1,k=11`，处理它并生成下一个输出；完成后已提交输出 2 个，`len=12`、`cache.num_tokens=11`。每个状态都应满足 `get_len() = prompt_len + get_output_len()`。真实全局轮间可能穿插别人的 decode；图上必须写“只显示此请求有进展的轮次”。

**反例/自测**：把 chunked_prefill 关闭时，无 chunk 模式的 prompt 长度上限为 `min(max_model_len,max_num_batched_tokens)`（`csrc/engine/scheduler.hpp:112`）。因此本算例的新请求长 10、全批总预算 4，会被置为 `FINISHED_IGNORED` 并移出 waiting，不是一直留队等待，也不会产生 4/4/2（`csrc/engine/scheduler.hpp:374-384`）。另一个不同情形是总预算 12、合法 prompt 长 10，但本批已用 8、只剩 4：无 chunk 时该请求本轮暂缓，留待之后排班（`csrc/engine/scheduler.hpp:470-506`）。交互必须把“超过总预算导致长度不合法”和“本批剩余预算不足”分开。

**性能补充**：chunk 与 batch 预算决定一轮暴露多少模型工作，有助于组织可容纳的 prefill 批，并在不同 step 间安排 prefill 与 decode；当前版本禁止同一批混合两种步型（`csrc/engine/prepare_sample.cpp:61`）。更多 chunk 也增加轮次和调度开销。prefill 的大量 query 行与 decode 的小 query 集合不是同一工作形态，不能用同一个“批大小越大越快”按钮解释。验证应固定请求集合、长度、并行布局，比较有效 token/step、TTFT、decode 间隔、step 时长及 MFU 口径；本页面不给收益百分比。

## 机制 2：多个 Attention DP rank 为什么要选同一种步型

**一句话**：NORMAL 引擎在一个 DP 组中协调本轮做 prefill 还是 decode；局部有新请求不等于它能立刻独自切换步型。

**源码事实**：

- `PROMPT` 引擎只走 prefill，`COMPLETION` 只走 decode；`NORMAL` 用 ALL/ANY 尝试点投票。依据：`csrc/engine/scheduler.hpp:288-318`（`_schedule`）。
- `want` 同时要求 cache 使用率不超过水位、队头有可调度 prefill。ALL 要所有 rank 都想做；ANY 任一 rank 想做便可触发；两种尝试点重合按 ANY。依据：`csrc/engine/scheduler.hpp:308-318`，队头判定 `:270-273`。
- 只有第一次投票通过才进行本地 prefill 排班和第二次投票：若实际谁也排不出 prefill，则回到 decode；若别的 rank 排出了 prefill，本 rank 可以产生空 prefill 结果维持步型一致。第一次投票失败直接返回 decode，不存在“第二次投了 false”。依据：`csrc/engine/scheduler.hpp:320-340`。
- 空排班不是完全不执行：Worker 会构造 placeholder 并调用主模型。依据：`deepinfer/worker/worker.py:120-127`；placeholder 的 block table 为 `[0]`，见 `deepinfer/worker/model_runner.py:386-403`。

**交互算例**：两个 rank，`want=[true,false]`。ALL 尝试 → 两者 decode。ANY 尝试且 rank0 实际排出请求 → rank0 prefill、rank1 placeholder prefill。若 rank0 slot 已满导致也排不出来 → 第二次投票让两者 decode。让用户切换“有请求”“实际能入批”两个独立开关，看到第一轮投票和第二轮投票不能合并。

**易错点**：不是每轮都投票；不在 ALL/ANY 尝试点时直接 decode，两次投票都不发生（`csrc/engine/scheduler.hpp:308-312`）。交互的圆点、rank 卡、旁白都应统一标“未执行”，不能一边写跳过、一边演示参与归约。不要把“ANY 兜底”写成无条件固定 TTFT 保证，因为可调度性、容量和多模态准备仍是条件。

**性能补充**：ALL 尽量减少其他 rank 陪跑空 prefill，ANY 给局部请求推进机会；代价是协调通信与空陪跑，存在吞吐/等待时间权衡。验证需同时看各 rank 的真实 token、placeholder 占比、等待时间与全组 step 时间，仅看单 rank GPU busy 无法证明有效工作增加。

## 机制 3：KV 空间紧张时，decode 如何选择和抢占

**一句话**：正在生成也可能被抢占；这份实现优先排短输出请求，在空间不足时优先从较长输出一侧选 victim。

**源码事实**：

- `running` 按 `output_len` 降序排序，循环从尾端选请求、空间不足时从头端挑 victim；处理完 C 并不代表本轮结束，还必须继续处理剩余 running。循环结束有 `l == r` 断言，不能留未处理请求排在 running；随后 scheduled 按总长度降序再整理给后续计算。依据：`csrc/engine/scheduler.hpp:622-652`（`_schedule_decode`）。
- **源码注释差异**：`:556-557` 说“抢占 output 最短”，但 `:624-632` 的比较器与两端索引实现相反。网页以实现为准，引用这些代码，不转述旧注释。
- 若 `stop_preempted_request` 开启，或 SO 已启动不支持重算，抢占会终止；否则清空滚动 cache/inflight/MTP 状态，将请求放 waiting 队头，释放占用，之后走重算。依据：`csrc/engine/scheduler.hpp:766-788`；`csrc/engine/sequence.hpp:307-310`（`reset_for_recompute`）。
- COMPLETION 没有 prefill 重算通道，构造时禁止 `COMPLETION && !stop_preempted_request`。依据：`csrc/engine/scheduler.hpp:101-104`。
- ZOS 下已经发出的旧轮可能稍后才回来；若请求已被抢占重算并处于 WAITING，这轮输出被丢弃，不能重复提交 token 或推进 KV。依据：`csrc/engine/scheduler.hpp:917-924`。

**交互算例**：A/B/C 输出长度分别 12/5/1；排序为 `[A,B,C]`。明确假设 A 独占 3 块、B/C 本轮各需新增 1 块、可用请求槽位足够。初始无空块时：选 C → 抢占 A 释放 3 块 → C 用 1 块入 scheduled → 继续处理 B，B 用 1 块入 scheduled → 剩余 1 空块。初始有 1 空块时：C 直接用 1 块入 scheduled → 继续处理 B，已无空块 → 抢占 A 释放 3 块 → B 用 1 块入 scheduled → 剩余 2 空块。不能把“C 无需抢占”写成“整轮无需抢占”。若只演示 C 的首段循环，应明确标注“首个候选的处理”，不呈现为完整调度结果。

切换停止/重算模式，观察 A 变 `FINISHED_PREEMPTED` 或回 `WAITING`。重算模式必须保留已提交 token 历史，清的是运行 cache 状态；不要动画成删掉用户已经看到的文本。释放 A 后，图上应同步更新其 block_table 所有权，不能继续把已归还块显示为 A 的当前占用；`free_seq_nolock` 清空 block_table（`csrc/engine/scheduler.hpp:738-744`）。

**性能补充**：抢占可使剩余请求继续推进，但重算消耗额外计算、终止请求影响完成率；这不是“免费释放显存”或必然提高有效 MFU。验证需比较完成请求的吞吐、重算 token/时间、抢占数、尾延迟；计算很忙而重复工作很多是反例。

## 机制 4：block table 把逻辑历史映射到物理 KV 池

**一句话**：请求有自己的逻辑 token 顺序，物理 KV 可以放在不连续的 block 中；CPU 账本管理编号，设备 tensor 真正存字节。

**源码事实**：

- `Blocks` 用 free list 和 ref_count 分配、pin、归还；block 0 保留不用，引用数降到 0 才重新进入 free list。依据：`csrc/engine/block_manager.hpp:27-35`、`:82-102`。
- `can_allocate_nolock` 区分 `OK/LATER/NEVER`：暂时没空闲与请求永远放不下不是一种结果。依据：`csrc/engine/block_manager.hpp:128-135`。
- 每个 Sequence 的 cache 含 `block_table`、`num_tokens`、`state_id`；需求 block 数考虑已提交长度、在途 token 和 draft 长度。依据：`csrc/engine/sequence.hpp:200-227`、`:291-297`。
- GPU 内存分成 `gpu_blocks` 与 `gpu_states`；ca/ica 分页缓存和每请求 SWA/compression state 不是同一个池。依据：`deepinfer/worker/cache_engine.py:206-218`、`:937-965`。独立 CPU block/state manager 都使用 `BlockManager`，因此两池的 0 号都保留，不能把 `state_id=0` 分给真实请求。依据：`deepinfer/engine/llm_engine.py:265-266`；`csrc/engine/block_manager.hpp:27-35`、`:207-213`。
- 读取分页范围时，逻辑 token 位置除以 block_size 得逻辑页索引，经 block_table 找物理 block，余数是页内偏移。依据：`csrc/engine/input_metadata/block_load_plan.cpp:23-34`（`append_paged_range`）。

**交互算例**：教学 block_size=4，逻辑 token 位置从 0 开始，A 的 block_table=`[7,2,9]`。token 5 → `5/4=1` → `block_table[1]=2` → 页内偏移 1。A 占据 10 个历史 token，尾块只有 2 个已用槽；另一个请求用不同映射。若画独立 state 池，可用 A→state 1、B→state 2，state 0 标为保留。高亮逻辑位置、页表项、物理位置三段，避免把 token ID（词表编号）与 token position 混为一谈。

**必须保留的边界**：教学图的 4 token/block 是缩小算例，真实 V4.1 布局还包括压缩比例、量化数据+scale、多层和 state；不能用统一的“每个 token 两块 K/V 数组”覆盖真实布局。`CacheEngine.get_cache_block_size` 明确 block_size 表示压缩前 token 数（`deepinfer/worker/cache_engine.py:969-977`）。

**性能补充**：分页和复用让有限缓存承载并发并避免每请求必须占连续大块；但更多 KV 不是更多算力，state 容量也可能卡住准入；小块有元数据/映射代价。验证看实际可并发请求、block/state 使用率、预占余量、抢占和延迟，不能把 cache usage 高等同 MFU 高。

## 机制 5：ZOS 把 CPU 工作放进设备执行的时间窗

**一句话**：异步调度减少 CPU/GPU 互相等候的机会，真实 token 依赖仍然存在；“zero-overhead”是名称，不是已测开销为零。

**源码事实**：

- `Worker.execute_model_step` 先执行 `_correct_seqlens_qk` 准备 remap 与输入修正，再下发当前 forward → 处理上一轮 → 修正 sampling metadata → 下发当前 sample → pre_sampler_sync → 记录 sample event。不能把 remap 画成当前 forward 下发后才准备。依据：`deepinfer/worker/worker.py:113-168`。
- ZOS decode 把当前 `WorkerStepState` 存入 `prev_step_state`，下一轮处理。prefill 或关闭 ZOS 时，则在当前 sample 与 event record **之后**立刻 `_post_process_step(curr_step_state)` 并清空 prev；不能画成先后处理当前结果、后采样。稳定的 non-ZOS 路径下一轮 `prev=None`，`_correct_seqlens_qk` 直接返回，没有跨轮 remap/D2H 修正。依据：`deepinfer/worker/worker.py:182-200`。
- `_post_process_step` 先同步该轮 `sample_end_evt`，再做 CPU 后处理。`execute_main_model` 与 `execute_sample` 下发区使用 `forbid_cuda_sync()`。依据：`deepinfer/worker/worker.py:248-271`；`deepinfer/worker/model_runner.py:319-329`、`:348-365`。
- ZOS 有上一轮状态且 batch 有交集时，CPU 账本滞后一轮；当前 batch 与上一 batch 按 seq_id 建 remap，重排与新加入请求都得到正确映射，不能按列表行号盲接。没有交集时返回无修正。依据：`csrc/engine/zos.cpp:142-195`（`prepare_zos_inputs`）；`deepinfer/worker/worker.py:198-213`。
- 对重叠请求，GPU 从上一轮采样和 draft 输出构造本轮输入；`nextn>0` 时根据 accepted 数修正 k，开启 MTP varlen 时另根据 confidence 调整 q。这里的 D2H 仅在 `DEEPINFER_ENABLE_MTP_VARLEN` 开启时，把修正后的 `seqlens_q` 拷回 CPU，CPU 在 sampling metadata 更新前同步该 event；不能把它说成所有 ZOS 都要回传 accepted 数。依据：`deepinfer/worker/worker.py:218-244`、`:146-152`。
- `prepare_token_inputs` 在 overlap 时只从 CPU 填 fresh 行；已匹配行来自上一轮 GPU 输出。依据：`csrc/engine/zos.cpp:84-112`。

**交互算例**：上轮 batch `[A,B]`，本轮 `[B,C,A]`，remap 应为 `[1,-1,0]`。先准备 remap，GPU 从前一轮输出取 B/A，CPU 提供 C 的 fresh 输入，再下发当前 forward 并处理旧结果。区分“CPU 已提交”与“GPU 已开始/完成”：即使 CPU 已提交当前 forward，GPU 仍按 stream 顺序等待上一轮采样数据；记录当前 sample event 也不等于 event 已完成。关闭 ZOS 后改画当轮 forward→sample→event record→event synchronize→post-process，全部请求从已更新的 CPU 状态准备下一轮，隐藏跨轮 remap 卡片。时间块只表达先后/可重叠，不按假造毫秒或固定百分比缩放。

**反例/自测**：“CPU 还没拿到 A 的最后 token，能直接用旧 token 跑下一轮吗？”不能；需要 remap 与 GPU 输入更新。“prefill 结果也总延后一轮？”不是，这条路径 prefill 当轮处理。

**性能补充**：瓶颈若是 CPU 排班/下发/后处理形成的空隙，此流水有机会隐藏部分 CPU 时间；代价是跨轮状态、在途资源、修正和同步更复杂。若瓶颈在模型算子或通信，隐藏 CPU 并不自动缩短那些阶段。验证固定 workload 比较开关、CPU launch 间隙、device forward/sample event、吞吐/延迟与 MFU，同时核对结果正确性。

## 机制 6：CUDA Graph 复用执行图，但必须适配实际 token 行数

**一句话**：decode 可以重放预先捕获的模型执行图，少走重复下发路径；图有固定档位，真实工作与 padding 需要分开看。

**源码事实**：

- 主模型 graph 使用条件：非 prompt、未强制 eager、已捕获 graph；PROMPT 引擎不启用这一 runner。依据：`deepinfer/worker/model_runner.py:72-79`、`:171-198`。
- `build_graph_batch_sizes` 建 2 次幂小档加固定间隔档；`select(total_q)` 通过 bisect_left 选择不小于实际 q 行数的最小档，超最大档报错。依据：`deepinfer/worker/cuda_graph_runner.py:41-51`、`:143-148`。
- 输入补 `graph_size-total_q` 个 placeholder，依据：`deepinfer/worker/model_runner.py:184-191`；实际 `num_reqs` 另存给 sampler，依据：`deepinfer/worker/model_runner.py:164-168`。不能把图档位当真实请求数。重放由 `deepinfer/worker/model_runner.py:326-327` 调用 runner，后者在 `deepinfer/worker/cuda_graph_runner.py:150-154` 执行 `graph.replay()`。
- capture 为不同档位预热、捕获，持有 buffer 与 graph memory pool。依据：`deepinfer/worker/cuda_graph_runner.py:82-141`。

**交互算例**：假设教学图档为 `[1,2,4,8]`，A 本轮 q=2、B 本轮 q=3，则 `total_q=5`，选 8 档并补 3 行。页面同时显示“2 个请求 / 5 个真实 query 行 / 8 行图档位”；这三者不能共用一个 batch size 数字。A/B 的 q 可能包含待验证 draft，不全是最终输出。

**性能补充**：可能减少 launch/CPU 控制开销；代价是预热/捕获时间、常驻内存与 padding 工作。档位很稀、批很小或主耗时是大算子/通信时，收益可能被抵消。验证 graph/eager 使用相同输入与配置，拆开 warmup 与稳态，记录 real_q/graph_size、device 时间、请求结果和 MFU。不要为获得更高 GPU busy 而把 padding 算成有效模型 token。

## 机制 7：结束、取消和“资源可复用”不是同一瞬间

**一句话**：请求状态先说明它不再生成，资源仍要在生命周期约定的时间点归还；异步流水让这一区分尤其重要。

**源码事实**：

- 正常停止包括 EOS、总长度超 max_model_len、输出达 max_tokens。依据：`csrc/engine/scheduler.hpp:1035-1051`（`_check_stop`）；终态原因枚举在 `csrc/engine/sequence.hpp:30-61`。
- `abort_sequence` 扫 running/waiting 并标 `FINISHED_ABORTED`，没有在该函数中立刻释放 KV block。依据：`csrc/engine/scheduler.hpp:144-162`；Python abort 另处理多模态 pool handle（`deepinfer/engine/llm_engine.py:651-655`）。
- 后续 decode 调度清理 finished/ignored；`pre_sampler_sync` 对 NORMAL/COMPLETION 的 finished 调用 `finalize_seq → scheduler.free_seq`。依据：`csrc/engine/scheduler.hpp:562-577`、`:752-762`；`deepinfer/engine/llm_engine.py:804-806`、`:830-846`。
- `free_seq_nolock` 归还 MTP slot、state block 与 KV blocks；block free 是减引用计数，只有到 0 才可重新分配。依据：`csrc/engine/scheduler.hpp:738-749`；`csrc/engine/block_manager.hpp:95-102`。
- 普通在途 `SequenceMetadata` 借用 `Sequence.cache.block_table`，不会因为“有上一轮结果”就给每个 KV block/state 增加一次 BlockManager 引用。显式 `fork_seq` 才为共享 KV 和 state 调用 pin。依据：`csrc/engine/sequence.hpp:349`、`:374-385`；`csrc/engine/scheduler.hpp:1087-1113`。不要把 Python/metadata 对象引用与 BlockManager 的 ref_count 混为同一种计数。
- `DeferredRelease` 将 SequenceMetadata 和 RequestOutput 回收到下一次 `pre_sampler_sync` 的各自对象池；这两项不是 KV/state 的 unpin。只有 `clone_unpins_to_release` 分支会同步 clone event 并执行 block/state unpin。依据：`deepinfer/engine/llm_engine.py:89-116`。clone 在 step 调度后发起，并明确在**当前 step** 的 `pre_sampler_sync` 释放源引用；该回调先 `deferred_release.release()`，随后才对 finished 请求调用 `finalize_seq`。依据：`deepinfer/engine/llm_engine.py:889-905`、`:830-846`。不能画成所有请求都先 free_seq、下一轮再统一 clone unpin。
- `step()` 返回的 RequestOutput 由 pool 管理，跨 step 保留要 clone；离线入口确实 clone，并在队列空时 flush 在途轮。依据：`deepinfer/engine/llm_engine.py:860-870`；`deepinfer/entrypoints/llm.py:177-185`。

**交互算例**：用三盏灯显示“生成结束”“执行收尾”“资源回池”。普通独占资源从 ref_count=1 开始，取消只改终态，到安全收尾的 free_seq 才 1→0；不要因 ZOS 在途就自动改成 2。另设显式共享场景：A 与 fork B 共享一个无需复制的历史完整块 7，pin 后 ref_count=2，A 结束归还后 2→1，B 之后也归还才 1→0。state 的 clone 与共享 KV 各自跟踪，不能假定每个资源总是同数、同步归零。若展示 clone，单独画 clone 提交→记录 event→本 step 的 pre_sampler_sync 等 event 并 unpin 源。另设“保留输出”卡片：metadata/输出对象池延后回收，借用 RequestOutput 跨 step 要 clone；这不是给 KV 加一份引用。

**性能补充**：及时而有顺序的复用减轻重复分配与同步，但延迟释放会暂占资源；过早回收会破坏结果，不能拿正确性换取表面空闲率。验证看 event/引用关系、资源峰值、完成后的池余额；本分析未做运行时泄漏测试。

## 机制 8：内部 KV 管理与“完整缓存服务”必须画出边界

**一句话**：开源版有推理所必需的内部 KV/state 内存管理；README 同时明确完整服务所需的 KV cache system、分离部署和副本负载均衡不包含在此发布中。

**源码事实**：

- README 将发布定位为 offline inference；完整推理服务缺少 KV cache system、VE/Prefill/Decode disaggregation、prefill/decode 的 DP 副本负载均衡。依据：`README.md:3`、`:38-42`。
- 基类中 `init_pd_split`、save_kvcache、发送已处理 prompt 是虚扩展点；看到方法名不能认定已经实现可运行的集群缓存服务。依据：`deepinfer/engine/llm_engine.py:800-849`。
- `KvCacheState.set_num_tokens` 支持外部注入命中基线，block/state 布局含落盘与 PE→CE 搬运约定；这说明预留/复用协议边界，不能证明独立缓存后端已提供。依据：`csrc/engine/sequence.hpp:210-214`；`deepinfer/worker/cache_engine.py:221-240`。
- `_schedule_prefill` 中 `prefix_caching_hit` 这个局部变量，甚至在 block_table 为空的新请求分支也被设为 true；单看名字不能作为前缀命中缓存系统证据。依据：`csrc/engine/scheduler.hpp:372-375`、`:398-399`。

**交互表现**：实线框为仓库已实现的 Sequence/block table/cache tensor/模型执行；虚线框为需要外接的缓存服务、负载均衡与跨引擎部署。点击虚线框显示 README 原文出处及已有扩展点。不要画“新请求自动查询全局 RadixTree → 命中远端缓存”作为开源默认行为。

**性能补充**：内部资源管理能支撑批调度；完整跨请求缓存服务可能减少重复 prefill，但本仓库公开边界不允许把那类系统收益直接归因给现成实现。相关效果需要额外实现、部署与命中率测量。更少重复工作、更多完成 token 与 MFU 数值之间也不是简单单调关系。

## 实现前的事实核对与性能表达

每页至少同时回答：遇到了什么问题、哪个模块做决定、哪个模块实际计算/搬运、数据或状态怎么变化、条件不满足怎么办。交互应允许单步、复位、调整一个变量，并在画面旁始终显示源码路径与证据等级。

可作为所有页面统一脚注的性能边界：这里的性能作用是源码支持的因果解释，不是本机测量。DeepInfer 自带 MFU 是主模型 FP8-equivalent FLOPs 的估算吞吐比，不能等同 GPU busy、显存使用率或 token/s；详细计量见 `csrc/engine/flops_estimator.hpp:13-27` 与 `deepinfer/engine/stats_logger.py:203-209`，主页面另行展开。每次改变 query、padding、重算或 draft 配置，都要检查 MFU 分子是否同时改变。

另一个必须避免的旧注释：`LLMEngine._init_cache` 文档 `deepinfer/engine/llm_engine.py:426-428` 说取各 worker 最小 block 数；实际 `WorkerBase.profile_num_available_blocks` 在 `deepinfer/worker/base.py:264-266` 做 `SUM / world_size` 再向偶数取整。若网页讲容量初始化，按代码描述；不要用旧 docstring 推断异构 rank 的容量安全保证。

建议的教学验收：读者应能指出“token 5 到哪个物理块”“为什么本次 ALL 不做 prefill”“为什么当前批可以先 forward 再处理旧轮”“为什么取消不等于任意时刻立即重用所有块”“为什么 graph 8 不代表 8 个请求”“为什么内部 KV 页池不等于完整前缀缓存服务”。若交互只展示彩色块移动却无法回答这些问题，仍不算机制讲清楚。
