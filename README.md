# DeepInfer 剖面

面向初学者的中文源码教学站：从宏观架构走到单个机制，说明哪些模块负责什么、数据怎样传递、执行顺序为什么成立。性能与 MFU 是贯穿课程的补充视角。

[在线阅读](https://asher-xunzhang.github.io/deepinfer-explained/) · [固定上游版本](https://github.com/deepseek-ai/DeepInfer/tree/553741557a57df44a46fb3ab72b6aafeaf945337)

## 阅读路线

1. `index.html`：整机剖面、模块与机制的对应关系、调用链。
2. `scheduling.html`：请求建档、分块 Prefill、DP 投票、内存不足时的抢占。
3. `runtime.html`：分页 KV 地址、引用和释放、ZOS 异步、CUDA Graph。
4. `model.html`：Flash 模型结构、稀疏/压缩注意力、YOCO、MoE、EPLB、并行与 kernel。
5. `sampling.html`：采样、DSpark、动态草稿预算、结构化输出。
6. `performance.html`：MFU 口径与交互算例、性能验证路径、公开代码与生产系统的边界。

7. `atlas.html`：KV 内存布局、跨层复用来源与 YOCO 的 SWA 可见域静态对照。

结构和布局用完整静态图呈现；参数对照用轻量交互；有时间依赖的机制提供连续播放、暂停和回看。运动时间和小尺寸数据是教学示意，不是硬件 trace；网站保留无脚本正文与源码链接。本仓没有 GPU 推理或性能实测数据。

图形选择及六个原创参考见 [可视化设计说明](analysis/visual-design.md)。

## 来源与仓库边界

- DeepInfer 固定 commit：`553741557a57df44a46fb3ab72b6aafeaf945337`，阅读日期 2026-10-26。
- 网页中包含必要的短源码摘录、解释与固定行号链接；**不收录完整 DeepInfer 引擎源码文件或源码树**。
- 官方模型参考为 `deepseek-ai/DeepSeek-V4.1-Flash-1017`，固定 revision `1bae0e1088993b9b82de08f59de5be5a34e42170`。`references/` 只收录配置、模型结构定义和许可，**没有权重、权重索引或 tokenizer 资源**。这些阅读资料不是可独立运行的模型包。
- `analysis/` 保存源码分析、机制证据和示例推导；`references/` 的 manifest 记录上游 URL、Git blob 与 SHA-256。
- 来源及许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。源码事实、官方部署描述、教学简化和待验证推断在页面中分别标注。

## 本地阅读与校验

静态 HTML/CSS/JavaScript，无构建步骤、无外部运行时依赖。路径兼容 GitHub Pages 项目子目录。

```bash
python3 -m http.server 8000
# 打开 http://127.0.0.1:8000/
node scripts/check.mjs
python3 scripts/verify_provenance.py
```

Codex 负责源码分析、事实核验与发布；本机 DeepSeek Harness 负责前端设计、动画实现及返修。
