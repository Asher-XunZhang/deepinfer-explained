# 官方模型结构参考快照

这里保存 `deepseek-ai/DeepSeek-V4.1-Flash-1017` 官方 Hugging Face 模型仓的三份模型定义，revision 固定为 `1bae0e1088993b9b82de08f59de5be5a34e42170`，读取日期为 2026-10-26（Asia/Shanghai）。它们是分析仓的引用材料，不是 DeepInfer 引擎源码。

| 文件 | 阅读用途 |
| --- | --- |
| [inference/model.py](inference/model.py) | `Transformer` 装配、Attention / Compressor / Indexer、MoE、mHC、Engram 接入、DSpark 预测分支 |
| [inference/engram.py](inference/engram.py) | token 压缩映射、n-gram 哈希布局与状态 |
| [inference/vision.py](inference/vision.py) | 图片 patch embedding、视觉 Transformer 与文本维度对齐 |

原始文件未修改，三份合计 74264 字节。来源 URL、固定 revision、文件大小、Git blob SHA-1、SHA-256 均记录于 [manifest.json](manifest.json)。文件大小和 Git blob 已与官方固定 revision 的文件树核对。本仓自行撰写的分析见 [model-structure.md](../../analysis/model-structure.md)。

阅读时以 [发布配置](../model-config/config.json) 为模型尺寸依据；`model.py` 中的 `ModelArgs` 默认值用于小模型演示，不是此 checkpoint 的层数和维度。

## 这是结构参考，不是可运行推理包

为限定在结构分析范围，下列运行材料没有下载：

- `kernel.py`：`model.py` 导入的 FP8/FP4 GEMM、量化、稀疏注意力、Sinkhorn 算子实现。
- `image_processor.py`：图像标记和图像输入处理；图像媒体也未下载。
- 权重分片、权重索引、tokenizer 词表、权重转换及生成/启动脚本。

源码还依赖外部 `torch`、`numpy`、`sympy`；token 压缩函数内部使用 `tokenizers`，并需要合适的 tokenizer 对象。这里没有安装或执行这些依赖，没有导入模型源码，没有运行推理。官方 `model.py` 对 DSpark 的说明也限定为前向计算，完整 speculative decoding 循环不在该参考文件的实现范围内。

## 授权

上游为 MIT License。完整版权及授权声明保留在 [../model-config/LICENSE](../model-config/LICENSE)，适用于这里的官方文件。分析仓没有改变上游文件的授权。
