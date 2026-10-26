# 来源与许可

本站的分析、图示和教学算例依据固定版本阅读整理；教学算例不代表真实硬件测量结果。

## DeepInfer 源码摘录

网页与 `analysis/code-excerpts.md` 展示少量源码片段，用于解释相应机制。来源为 [DeepSeek-AI / DeepInfer](https://github.com/deepseek-ai/DeepInfer/tree/553741557a57df44a46fb3ab72b6aafeaf945337)，固定 commit `553741557a57df44a46fb3ab72b6aafeaf945337`。原始许可为 [Apache License 2.0](licenses/DeepInfer-Apache-2.0.txt)，原文件中的版权和来源归属仍属于各权利人；部分代码源于 vLLM，摘录处保留相应说明。网页中的省略或教学改写会与原文区别标示。

本仓不包含 DeepInfer 源码树或完整引擎源码文件。链接指向上游，不表示代码在本站执行。

## 官方模型结构参考

`references/model-config/` 与 `references/model-architecture/` 中的六份轻量文件来自 [deepseek-ai/DeepSeek-V4.1-Flash-1017](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/tree/1bae0e1088993b9b82de08f59de5be5a34e42170)，固定 revision `1bae0e1088993b9b82de08f59de5be5a34e42170`，遵循其 [MIT License](references/model-config/LICENSE)。各 manifest 记录原始 URL、Git blob 与 SHA-256，可用 `python3 scripts/verify_provenance.py` 校验。

这些文件是阅读用的官方模型定义与配置快照，不是 DeepInfer 引擎文件，也不是可独立运行的推理包。不包含模型权重、权重索引或 tokenizer 资源。
