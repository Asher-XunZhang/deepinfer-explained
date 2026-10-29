# 教学材料索引

固定源码： [deepseek-ai/DeepInfer@553741557a57df44a46fb3ab72b6aafeaf945337](https://github.com/deepseek-ai/DeepInfer/tree/553741557a57df44a46fb3ab72b6aafeaf945337)。读取日期：2026-10-26。

目标是让初学者从宏观架构走到单独机制，回答“哪些模块在为哪种机制工作，它们传递什么，为什么需要这一步”。性能/MFU 是贯穿机制的一个维度，不是全部内容。源码分析不是 GPU 实测。

- `engine.md`：请求、调度、ZOS、内存、生命周期、graph。
- `model-parallel.md`：模型计算、压缩稀疏注意力、SWA/YOCO、DP/CP/EP、MoE/EPLB、kernel。
- `sampling-and-scope.md`：采样/DSpark/结构化输出、入口、视觉、发布边界、学习覆盖。
- `mfu.md`：本仓的精确 MFU 口径、算例与验证路径。
- `code-excerpts.md`：可直接嵌入教学内容的短源码摘录和解释，保留原始行段与许可归属。
- `model-structure.md`：官方轻量模型配置的结构拆解（独立子任务补充），配置原件与manifest在 `references/model-config/`。

代码锚点均相对于上游，不是本站。将 `path:line` 变成 `https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/path#Lline`。每个机制页面应能从可视化模块直接到对应源码，而不只在页尾堆参考链接。

用户澄清：网页内容中可以展示相关短源码摘录，并结合图形解释；禁止的是把完整 DeepInfer 源码文件/目录复制进此仓。保留摘录的 Apache-2.0 来源归属、路径、函数、行号和固定链接。官方轻量模型结构配置另存 references/model-config，属于明确授权的结构资料，不含权重。

官方概念与设计说明：
- [固定版本 README](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/README.md)
- [固定版本生产部署 Q&A](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/doc/inference_deployment_qa.md)：生产整体服务的说明，不表示所有模块已开源。
- [DeepSeek V4.1 Flash 发布说明](https://deepseek.com/en/news/deepseek-v4-1-flash/)：CED 架构与 KV 压缩的官方动机，2026-09-10。

实现说明与注释冲突时以执行代码为准，并在深入阅读中交代，不让初学者背冲突细节。

## 图形表达

[可视化设计说明](visual-design.md) 记录静态、交互与连续动画的选择，以及原创参考和迁移边界。

[发布核验记录](verification.md) 列出源码、模型参考、浏览器和仓库范围的检查及未覆盖证据。

[生产边界学习文档核验](review-production-notes.md) 记录 2026-10-27 的可靠性结论、固定源码依据和对现有 Pages 的补充价值；相关分析方法已纳入根目录 `AGENTS.md`。

[生产机制补充依据](production-mechanisms.md) 沿请求路径、状态生命周期、两类有界重放、角色与异步收尾、官方性能工作点展开，提供教学内容的对象定义、算例和固定源码锚点。2026-10-29 补充第 6、7 节：生产 Prefill/Decode 路由与公开 Scheduler 的边界，以及 P/D 实例、rank、GPU 的资源账；[模型与并行](model-parallel.md) 同时补充 EPLB 统计窗口、重排周期与冷启动条件。
