# MFU：看清统计口径再谈效率

## 精确定义（源码事实）

`csrc/engine/flops_estimator.hpp:13-27` 定义 FP8-equivalent 主模型运算估算。GEMM 系数已包括乘加两次 FLOP：FP4=1、FP8=2、BF16=4、TF32/FP32=8。这是等价记账系数，不能当作硬件真正执行的指令数；FP4 存储不自动意味着 FP4×FP4 计算（同文件 86、213）。

估算覆盖主要 contractions（张量收缩运算），排除 draft / padding / replicas（草稿、填充、冗余副本），省略 norm/activation 小算术，vision 尚为 TODO。调度 q/k 未扣除 acceptance/ZOS 后续修正，不能将分子称为“最终被接受的所有 token 的实测 FLOPs”。`calc_flops` 在 39-44 返回 attention 和 total，total 已含 attention，不可相加两次。

`deepinfer/engine/stats_logger.py:203-209`：首条样本只作窗口起点，MFU = (Σ后续步骤估算 TFLOPs / 首尾样本时间差) / model_parallel_size / tflops_limit。分母时间不延长到 now。其 throughput 函数 195-201 则延伸到 now，二者窗口不同。

`deepinfer/engine/llm_engine.py:304`：tflops_limit = get_bf16_tflops_limit() × 2（FP8-equivalent 峰值）。`deep_cluster/hardware/device.py:151-156` 是仓内硬编码设备参考值，不是本机检测或测量峰值。跨精度、跨硬件比较必须先统一口径。`deepinfer/config.py:171-173` 中 model_parallel_size 等于 context_parallel_size；日志分子是该引擎的排班工作量，不能再按全局 EP/world_size 重复除卡数。

## 初学者的三个分开

- GPU busy：设备有工作，不保证 Tensor Core 做了很多有用矩阵乘。
- MFU：按约定主模型工作量，除以时间与所计设备峰值。
- 吞吐/延迟：用户每秒收到多少有效 token，首 token 多久、相邻 token 多久。降低必做工作可能提高吞吐而不提高 MFU；推测解码多做草稿计算也不该直接计进此仓主模型分子。

## 可交互算例（明确纯教学）

假设每设备 FP8 等价峰值 100 TFLOP/s，本引擎 model_parallel_size=CP=4（不是全局 world_size 或 EP）；分子是此引擎排班工作量。窗口三个样本 (t=0,F=10)、(t=1,F=80)、(t=2,F=120)，首样本排除，MFU=(80+120)/(2-0)/4/100=25%。固定工作量和峰值，减少 CPU 空闲导致时间从 2s 变为 1.6s，示例 MFU=31.25%；这不是 DeepInfer 实测提升。若改成减少主模型工作量，必须同时更新分子，不能固定分子伪造收益。数字仅说明公式。

另一种可视化：固定一次请求的时间账单，展示计算、内存等待、通信等待、CPU 空档。时间线以假设单位表示，不是硬件 trace；重叠的区域不能重复计入总时间。实际模型的 bottleneck 由形状、batch、序列长度、硬件、互联共同决定。

## 机制到性能的因果，不是数值保证

| 机制 | 减少/改善什么 | 代价与条件 | 验证观察 |
| --- | --- | --- | --- |
| ZOS | CPU 调度、后处理造成的 GPU 空档 | 跨步数据依赖和资源延迟释放更复杂 | CPU/GPU trace，step 空隙 |
| Batch/EP | 专家拿到更多 token，权重复用、矩阵形状改善 | 排队延迟、通信和负载偏斜 | 每专家 token 数、GEMM 时长、TBT |
| EPLB | 最慢 rank 造成的等待 | 冗余权重显存、重排成本 | rank 分布、max/mean 负载 |
| 融合/低精度 | 中间写回、kernel launch、字节量 | 精度/量化与硬件支持 | kernel trace、HBM bytes、误差/质量 |
| 压缩/稀疏/YOCO | 必须读取和计算的历史量 | 索引/压缩成本、近似边界 | attention 时长、KV bytes、质量 |
| DSpark | 按接受预期分配验证预算 | 草稿开销、接受率、曲线校准 | accepted/verified length、端到端 TPS |
| PD 分离/外部缓存 | 生产资源分配和重复 prefill | 通信、存储和路由基础设施 | TTFT/TBT/命中率；非本次开源复现 |

## 真正验证路线

固定源码 SHA、模型 checkpoint、设备/峰值口径、精度、EP/DP/CP、输入/输出长度、并发、缓存命中率与采样参数。`examples/benchmark.py` 可配置采集 trace；`examples/sweep/run_sweep.sh:71-76` 强制 PROFILE=0，本身不采 trace。`examples/sweep/plot_pareto.py:58-67` 用传入接受率换算 τ=1+nextn×a，并拒绝 mtp_varlen=1；这部分是基于实测步速的换算，不是实测有效输出吞吐。`examples/benchmark.py:165` 强制 load balance、299 使用随机 token，不能代替真实任务质量和线上路由/服务验证。每次只改变一个机制，并同时报告 MFU、吞吐、TTFT/TBT、质量或接受率；吞吐不能代替精度校验。此站提供测量计划，不宣称已经执行 GPU/NPU 基准。README 图是官方提供的特定配置结果，不能当作本站实测或泛化到任何机器。
