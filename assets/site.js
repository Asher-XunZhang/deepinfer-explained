/* DeepInfer 剖面 — checkpoint interactions. No dependencies. */
(() => {
  'use strict';

  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const $ = (sel, root = document) => root.querySelector(sel);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const commit = '553741557a57df44a46fb3ab72b6aafeaf945337';
  const src = (path) => `https://github.com/deepseek-ai/DeepInfer/blob/${commit}/${path}`;

  /* ---------- hero trace ---------- */
  const steps = [
    {
      stage: '入口', title: '文本先变成 token IDs', input: '用户文本、采样参数',
      action: 'tokenizer 编码；复制每请求采样参数；创建请求身份',
      output: '整数 token 序列，不是 KV，也不是文本片段',
      source: src('deepinfer/entrypoints/llm.py#L144-L166'), label: 'llm.py:144–166'
    },
    {
      stage: '入队', title: '请求成为一张持续更新的档案', input: 'token IDs、采样参数、到达时间',
      action: 'LLMEngine 创建 Sequence；加入 Scheduler waiting 队列',
      output: '等待调度的 Sequence，含 token 与 cache 账本',
      source: src('deepinfer/engine/llm_engine.py#L471-L630'), label: 'llm_engine.py:471–630'
    },
    {
      stage: '排班', title: '本轮谁上设备、各算多少', input: 'waiting / running、token 预算、cache 容量',
      action: 'C++ Scheduler 选择 prefill 或 decode，产出本轮执行单',
      output: 'SchedulerOutputs + SequenceMetadata（q/k、block table 等）',
      source: src('csrc/engine/scheduler.hpp#L288-L345'), label: 'scheduler.hpp:288–345'
    },
    {
      stage: '下发', title: 'Worker 组织这一轮的异步顺序', input: '执行单、上一轮在途状态',
      action: '先下发当前 forward；处理上一轮后再 sample；记录 event',
      output: '模型输出、采样输出；ZOS 时旧轮后处理延后',
      source: src('deepinfer/worker/worker.py#L113-L189'), label: 'worker.py:113–189'
    },
    {
      stage: '计算', title: 'cache 与 kernel 接住这轮张量', input: 'hidden / token 行、block table、设备 cache',
      action: '模型层读取分页 KV、执行 attention 与 MoE；Sampler 得下一 token',
      output: '候选 token、logits 处理结果、新写入的 cache',
      source: src('deepinfer/worker/model_runner.py#L171-L214'), label: 'model_runner.py:171–214'
    },
    {
      stage: '提交', title: '只提交真正被接受的 token', input: '采样输出、accepted 信息、SO 状态',
      action: 'scheduler.process_outputs 提交 token、更新 KV 计数、判断停止',
      output: 'RequestOutput；未结束请求进入下一轮',
      source: src('csrc/engine/scheduler.hpp#L872-L1003'), label: 'scheduler.hpp:872–1003'
    }
  ];

  const traceRoot = $('[data-trace]');
  if (traceRoot) {
    const dots = $$('[data-trace-go]', traceRoot);
    const count = $('[data-trace-count]', traceRoot);
    const stageEl = $('[data-trace-stage]', traceRoot);
    const titleEl = $('[data-trace-title]', traceRoot);
    const inputEl = $('[data-trace-input]', traceRoot);
    const actionEl = $('[data-trace-action]', traceRoot);
    const outputEl = $('[data-trace-output]', traceRoot);
    const sourceEl = $('[data-trace-source]', traceRoot);
    const playBtn = $('[data-trace-play]', traceRoot);
    const prevBtn = $('[data-trace-prev]', traceRoot);
    const nextBtn = $('[data-trace-next]', traceRoot);
    const resetBtn = $('[data-trace-reset]', traceRoot);
    let current = 0;
    let timer = null;

    function render(index) {
      current = (index + steps.length) % steps.length;
      const step = steps[current];
      count.textContent = `${String(current + 1).padStart(2, '0')} / ${String(steps.length).padStart(2, '0')}`;
      stageEl.textContent = step.stage;
      titleEl.textContent = step.title;
      inputEl.textContent = step.input;
      actionEl.textContent = step.action;
      outputEl.textContent = step.output;
      sourceEl.href = step.source;
      sourceEl.textContent = step.label + ' ↗';
      dots.forEach((dot, i) => {
        const active = i === current;
        dot.classList.toggle('is-active', active);
        dot.setAttribute('aria-pressed', String(active));
      });
    }
    function stop() {
      if (timer) window.clearInterval(timer);
      timer = null;
      playBtn.textContent = '播放';
      playBtn.setAttribute('aria-pressed', 'false');
    }
    function start() {
      if (reducedMotion.matches) {
        playBtn.textContent = '已用步进';
        window.setTimeout(stop, 900);
        return;
      }
      timer = window.setInterval(() => render(current + 1), 2400);
      playBtn.textContent = '暂停';
      playBtn.setAttribute('aria-pressed', 'true');
    }
    dots.forEach((dot) => dot.addEventListener('click', () => { stop(); render(Number(dot.dataset.traceGo)); }));
    prevBtn.addEventListener('click', () => { stop(); render(current - 1); });
    nextBtn.addEventListener('click', () => { stop(); render(current + 1); });
    resetBtn.addEventListener('click', () => { stop(); render(0); });
    playBtn.addEventListener('click', () => timer ? stop() : start());
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
    render(0);
  }

  /* ---------- architecture data ---------- */
  const modules = {
    llm: {
      name: 'LLM', layer: '入口 · Python', role: '把文本或 token IDs 变成请求，再驱动引擎 step 循环。',
      input: 'prompt 文本或 token IDs、SamplingParams', output: 'RequestOutput；过程中不持有设备 KV',
      mechanisms: ['lifecycle', 'chunk', 'zos'],
      sources: [['llm.py:90–186', 'deepinfer/entrypoints/llm.py#L90-L186']]
    },
    engine: {
      name: 'LLMEngine', layer: '协调层 · Python', role: '协调请求对象、调度器、Worker、缓存和输出后处理；不是 GPU kernel。',
      input: '请求对象、SchedulerOutputs、worker 回调', output: '每步 RequestOutput、调度统计',
      mechanisms: ['lifecycle', 'paged', 'zos', 'moe'],
      sources: [['llm_engine.py:860–909', 'deepinfer/engine/llm_engine.py#L860-L909']]
    },
    scheduler: {
      name: 'Scheduler', layer: '决策 · C++', role: '决定本步 batch、token 预算、prefill/decode 步型、抢占与结束资源处理。',
      input: 'waiting/running、cache 水位、block/state 容量', output: 'SchedulerOutputs、SequenceMetadata',
      mechanisms: ['lifecycle', 'chunk', 'vote', 'paged', 'zos', 'graph'],
      sources: [['scheduler.hpp:288–345', 'csrc/engine/scheduler.hpp#L288-L345'], ['scheduler.hpp:622–660', 'csrc/engine/scheduler.hpp#L622-L660']]
    },
    ledger: {
      name: 'Sequence · BlockManager', layer: '状态账本 · C++/CPU', role: 'Sequence 保存请求 token/状态；BlockManager 用引用计数管理物理块编号。',
      input: '逻辑 token 长度、已提交长度、在途/draft、空闲块', output: 'block_table、state_id、分配/释放结果',
      mechanisms: ['chunk', 'paged', 'zos'],
      sources: [['sequence.hpp:200–227', 'csrc/engine/sequence.hpp#L200-L227'], ['block_manager.hpp:27–116', 'csrc/engine/block_manager.hpp#L27-L116']]
    },
    worker: {
      name: 'Worker', layer: '执行 · Python', role: '组织 forward、旧轮后处理、sample 与同步点；ZOS 在这里形成跨轮流水。',
      input: 'SequenceMetadata、scheduler outputs、device cache', output: '采样输出、完成 event、RequestOutput 指针',
      mechanisms: ['lifecycle', 'zos', 'graph', 'parallel'],
      sources: [['worker.py:113–189', 'deepinfer/worker/worker.py#L113-L189'], ['worker.py:191–272', 'deepinfer/worker/worker.py#L191-L272']]
    },
    runner: {
      name: 'ModelRunner', layer: '执行适配 · Python', role: '准备输入张量、选择 eager / CUDA Graph、执行主模型与采样；图档只补 pad 行。',
      input: 'SequenceMetadata、total_q、cache', output: '模型输出、SamplerOutput、graph_size',
      mechanisms: ['lifecycle', 'chunk', 'zos', 'graph', 'parallel'],
      sources: [['model_runner.py:171–214', 'deepinfer/worker/model_runner.py#L171-L214'], ['cuda_graph_runner.py:143–154', 'deepinfer/worker/cuda_graph_runner.py#L143-L154']]
    },
    sampler: {
      name: 'Sampler', layer: '采样 · Python/kernel', role: 'hidden states → logits → processors → token；开启 MTP 时验证上一轮草稿。',
      input: '模型 hidden、采样参数、SO mask、MTP 状态', output: 'sampled / verified token，下一轮草稿',
      mechanisms: ['lifecycle', 'zos'],
      sources: [['sampler.py:56–93', 'deepinfer/model_executor/layers/sampler.py#L56-L93']]
    },
    model: {
      name: 'V4.1 模型层', layer: '计算 · Python + kernels', role: 'embedding 和 decoder layers：attention 读取上下文，MoE 变换当前 hidden。',
      input: 'input IDs、位置、KV/state 地址、跨层运行时', output: '归一化 hidden states，再进入采样',
      mechanisms: ['chunk', 'paged', 'zos', 'graph', 'moe', 'parallel'],
      sources: [['deepseek.py:154–248', 'deepinfer/model_executor/models/deepseek.py#L154-L248'], ['decoder_layer.py:97–175', 'deepinfer/model_executor/models/decoder_layer.py#L97-L175']]
    },
    cache: {
      name: 'CacheEngine', layer: '设备内存 · GPU', role: '真正分配 gpu_blocks 与 gpu_states，并提供按层 cache 视图；账本不保存 KV 字节。',
      input: 'block/state 容量、模型 cache 布局', output: '分页 KV block 张量、SWA/压缩 state 张量',
      mechanisms: ['paged', 'chunk', 'zos', 'graph', 'moe'],
      sources: [['cache_engine.py:918–966', 'deepinfer/worker/cache_engine.py#L918-L966'], ['block_load_plan.cpp:23–34', 'csrc/engine/input_metadata/block_load_plan.cpp#L23-L34']]
    },
    kernels: {
      name: '计算 / 通信 Kernel', layer: '后端 · CUDA/NPU', role: '执行 GEMM、attention、Top-k、dispatch/combine 与 all-gather 等实际工作。',
      input: '布局/对齐后的张量、索引、通信句柄', output: '计算结果、跨卡收集/专家结果、通信完成事件',
      mechanisms: ['moe', 'parallel', 'graph', 'paged'],
      sources: [['linear.py:27–165', 'deepinfer/model_executor/layers/linear.py#L27-L165'], ['mlp.py:406–511', 'deepinfer/model_executor/models/v4_modules/mlp.py#L406-L511']]
    }
  };

  const mechanisms = {
    lifecycle: {
      name: '请求生命周期', summary: '一个请求从文本变成 token，进入 waiting 队列，被一轮轮调度、执行、采样，最终把已提交 token 返回给入口。',
      path: ['LLM', 'LLMEngine', 'Scheduler', 'Worker', 'ModelRunner', 'Sampler'],
      decide: 'Scheduler 选择本轮 prefill / decode 批次；LLMEngine 驱动每一步。', execute: 'Worker、ModelRunner、模型与 kernel；KV 由 CacheEngine 承载。',
      cost: '每轮多花在调度、下发、缓存搬运上的时间，未必能隐藏模型本身的计算。',
      modules: Object.keys(modules),
      sources: [['llm.py:90–186', 'deepinfer/entrypoints/llm.py#L90-L186'], ['llm_engine.py:860–909', 'deepinfer/engine/llm_engine.py#L860-L909'], ['worker.py:113–189', 'deepinfer/worker/worker.py#L113-L189']]
    },
    chunk: {
      name: '分块 prefill', summary: '长 prompt 不必一轮塞进设备：调度器按本轮 token 预算切 chunk。只有最后一个 prefill chunk 产出第一个输出 token。',
      path: ['Scheduler', 'Sequence', 'Worker', 'Model'],
      decide: '本轮可排多少 q 行；受 max_num_batched_tokens、序列长度、block/state 容量和 CP 对齐等约束。',
      execute: '未完成 chunk 保持 WAITING；非最后 chunk 的 last_output_token 为 -1，采样不产出答案。',
      cost: '把一大块工作拆小可帮助组批，但增加轮次、调度与 launch 次数；“批更大”不自动更快。',
      modules: ['llm', 'engine', 'scheduler', 'ledger', 'worker', 'runner', 'model', 'cache'],
      sources: [['scheduler.hpp:460–545', 'csrc/engine/scheduler.hpp#L460-L545'], ['sequence.hpp:386–387', 'csrc/engine/sequence.hpp#L386-L387']]
    },
    vote: {
      name: 'DP 步型投票', summary: 'NORMAL 引擎在 DP 组内统一本轮做 prefill 还是 decode。首个 rank 有请求，不等于它能独自切换步型。',
      path: ['Scheduler', 'DP all-reduce', 'Worker 空 prefill'],
      decide: 'ALL 点要求全员想做；ANY 点任一 rank 可触发；首个投票后还有第二轮确认“是否真的排出 prefill”。',
      execute: '某 rank 没排出请求但组内确有 prefill 时，本 rank 以 placeholder 空 prefill 维持步型一致。',
      cost: 'ANY 减少孤立请求等待，但可能让其他 rank 空陪跑；ALL 少陪跑，但等待更久。',
      modules: ['scheduler', 'worker', 'runner', 'parallel'],
      sources: [['scheduler.hpp:308–340', 'csrc/engine/scheduler.hpp#L308-L340'], ['worker.py:120–127', 'deepinfer/worker/worker.py#L120-L127']]
    },
    paged: {
      name: '分页 KV', summary: '逻辑 token 历史按 block table 映射到不连续的物理块；CPU 账本分配编号，设备张量才真正存字节。',
      path: ['Sequence 逻辑历史', 'BlockManager 账本', 'block_table', 'CacheEngine', 'kernel'],
      decide: '准入与每轮扩块看容量；引用计数到 0 才把块放回 free list。',
      execute: '读 token 位置时：pos / block_size 取逻辑页，查 table 得物理块，pos % block_size 得页内偏移。',
      cost: '分页提升复用与并发容量，但仍受 state/cache 容量限制；缓存占用高不等于 MFU 高。',
      modules: ['engine', 'scheduler', 'ledger', 'model', 'cache', 'kernels'],
      sources: [['block_manager.hpp:82–116', 'csrc/engine/block_manager.hpp#L82-L116'], ['block_load_plan.cpp:23–34', 'csrc/engine/input_metadata/block_load_plan.cpp#L23-L34'], ['cache_engine.py:918–966', 'deepinfer/worker/cache_engine.py#L918-L966']]
    },
    zos: {
      name: 'ZOS 异步', summary: 'ZOS 重叠 CPU 调度/后处理与设备执行，但不取消跨轮依赖：当前 batch 可能要等上一轮采样结果。',
      path: ['Scheduler 当前批', 'Worker 下发 forward', 'CPU 处理上一轮', 'Sample', 'pre_sampler_sync'],
      decide: 'decode 后处理可延到下一步；prefill 或关闭 ZOS 时当轮处理。',
      execute: '按 seq_id 构造 remap，取上一轮 GPU 输出；新请求的 fresh 行由 CPU 填入，不能按列表行号盲接。',
      cost: '可隐藏部分 CPU 空档；跨步状态、在途资源、修正与同步更复杂，模型或通信瓶颈不会因此自动变快。',
      modules: ['llm', 'engine', 'scheduler', 'ledger', 'worker', 'runner', 'sampler', 'model', 'cache'],
      sources: [['worker.py:143–189', 'deepinfer/worker/worker.py#L143-L189'], ['zos.cpp:142–195', 'csrc/engine/zos.cpp#L142-L195'], ['worker.py:248–271', 'deepinfer/worker/worker.py#L248-L271']]
    },
    graph: {
      name: 'CUDA Graph', summary: 'decode 可重放捕获好的执行图；图档按真实 q 行数向上取桶，补 placeholder，但真实请求数要另存给采样。',
      path: ['total_q', 'CUDAGraphRunner.select', 'graph bucket + padding', 'replay', 'sampler 去 pad'],
      decide: '图档由 build_graph_batch_sizes 预先决定；select 选不小于真实 q 的最小档，超过最大档报错。',
      execute: '重放固定执行图；padding 行不做有效模型 token，真实 num_reqs 与 sampler 对齐。',
      cost: '可能减少 launch/CPU 控制开销；代价是捕获、常驻显存与 padding 工作，图档不等于请求数。',
      modules: ['scheduler', 'worker', 'runner', 'model', 'cache', 'kernels'],
      sources: [['model_runner.py:182–191', 'deepinfer/worker/model_runner.py#L182-L191'], ['cuda_graph_runner.py:41–51', 'deepinfer/worker/cuda_graph_runner.py#L41-L51'], ['cuda_graph_runner.py:143–154', 'deepinfer/worker/cuda_graph_runner.py#L143-L154']]
    },
    moe: {
      name: 'MoE / EPLB', summary: 'gate 选逻辑专家，EPLB 映射到物理槽，DeepEP 把 token 发到对应 rank，计算后按 handle 汇回并加 shared 分支。',
      path: ['MoE gate', 'EPLB 映射', 'dispatch', 'grouped expert GEMM', 'combine'],
      decide: 'gate 产生每 token 的 Top-k 专家与权重；EPLB 基于历史热点决定副本与物理布局。',
      execute: '专家可能在不同卡；输出必须回到原 token 顺序。Mega MoE 是否使用受 dtype 与 EP 是否在 NVL 域限制。',
      cost: '汇聚 token 可改善专家矩阵形状，但通信、负载不均与副本显存都是成本；不能从“融合”推导固定收益。',
      modules: ['engine', 'scheduler', 'model', 'cache', 'kernels', 'worker'],
      sources: [['mlp.py:160–214', 'deepinfer/model_executor/models/v4_modules/mlp.py#L160-L214'], ['mlp.py:406–511', 'deepinfer/model_executor/models/v4_modules/mlp.py#L406-L511'], ['eplb/policy.py:73–140', 'deepinfer/model_executor/eplb/policy.py#L73-L140']]
    },
    parallel: {
      name: 'DP / CP / EP', summary: '同一组 GPU 的三种分工视图：DP 分不同请求的 attention，CP 分同一序列 query 行，EP 分 routed experts。',
      path: ['4 张 GPU', 'DP / CP / EP 分组', 'all-gather / dispatch', '局部计算', '恢复原序'],
      decide: '进程组 reshape 决定 rank 分组；生产部署的并行选择是配置与资源决策。',
      execute: '长 prompt 的 CP 走镜像/zigzag 分片；模型末尾 all-gather hidden 并按 reverse index 恢复顺序。',
      cost: 'CP 可缓解因果负载不均，但支付 all-gather、重排、padding 和等待；公开代码支持 CP，生产当时不使用 CP。',
      modules: ['scheduler', 'worker', 'runner', 'model', 'kernels'],
      sources: [['parallel_state.py:70–118', 'deepinfer/model_executor/parallel_utils/parallel_state.py#L70-L118'], ['cp.py:42–51', 'deepinfer/model_executor/parallel_utils/cp.py#L42-L51'], ['deepseek.py:168–169', 'deepinfer/model_executor/models/deepseek.py#L168-L169']]
    }
  };

  function linkMarkup(list) {
    return list.map(([label, path]) => `<a class="srcline" href="${src(path)}" target="_blank" rel="noopener noreferrer">${label} <span aria-hidden="true">↗</span></a>`).join('');
  }

  /* Every mechanism/module readout keeps a direct route into the chapter
     where that mechanism is actually explained. */
  const chapterTargets = {
    mechanism: {
      lifecycle: ['运行时与异步', 'runtime.html#life'],
      chunk: ['请求与调度', 'scheduling.html#chunk'],
      vote: ['请求与调度', 'scheduling.html#vote'],
      paged: ['运行时与异步', 'runtime.html#kv'],
      zos: ['运行时与异步', 'runtime.html#zos'],
      graph: ['运行时与异步', 'runtime.html#graph'],
      moe: ['模型与注意力', 'model.html#parallel'],
      parallel: ['模型与注意力', 'model.html#parallel']
    },
    module: {
      llm: ['请求与调度', 'scheduling.html#req'],
      engine: ['请求与调度', 'scheduling.html#req'],
      scheduler: ['请求与调度', 'scheduling.html#req'],
      ledger: ['运行时与异步', 'runtime.html#kv'],
      worker: ['运行时与异步', 'runtime.html#zos'],
      runner: ['运行时与异步', 'runtime.html#graph'],
      sampler: ['采样与结构', 'sampling.html#sample'],
      model: ['模型与注意力', 'model.html#structure'],
      cache: ['运行时与异步', 'runtime.html#kv'],
      kernels: ['模型与注意力', 'model.html#parallel']
    }
  };

  function chapterMarkup(chapter) {
    if (!chapter) return '';
    return `<a class="readout-chapter" href="${chapter[1]}">进入：${chapter[0]} <span aria-hidden="true">→</span></a>`;
  }

  const atlas = $('[data-atlas]');
  if (atlas) {
    const mechPills = $$('.mech-pill');
    const nodes = $$('.node[data-module]', atlas);
    const readout = $('.atlas-readout', atlas);
    const title = $('[data-readout-title]', atlas);
    const mode = $('[data-readout-mode]', atlas);
    const summary = $('[data-readout-summary]', atlas);
    const path = $('[data-readout-path]', atlas);
    const decide = $('[data-readout-decide]', atlas);
    const execute = $('[data-readout-execute]', atlas);
    const cost = $('[data-readout-cost]', atlas);
    const links = $('[data-readout-links]', atlas);
    let selectedModule = null;
    let activeMech = 'lifecycle';

    function renderMechanism(id) {
      const mech = mechanisms[id];
      if (!mech) return;
      activeMech = id;
      selectedModule = null;
      mode.textContent = '机制视图';
      title.textContent = mech.name;
      summary.textContent = mech.summary;
      path.innerHTML = mech.path.map(p => `<span>${p}</span>`).join('<i aria-hidden="true">→</i>');
      decide.textContent = mech.decide;
      execute.textContent = mech.execute;
      cost.textContent = mech.cost;
      links.innerHTML = chapterMarkup(chapterTargets.mechanism[id]) + linkMarkup(mech.sources);
      mechPills.forEach(pill => {
        const on = pill.dataset.mech === id;
        pill.classList.toggle('is-active', on);
        pill.setAttribute('aria-pressed', String(on));
      });
      const lit = new Set(mech.modules);
      nodes.forEach(node => {
        const on = lit.has(node.dataset.module);
        node.classList.toggle('is-lit', on);
        node.classList.remove('is-selected');
        node.setAttribute('aria-pressed', 'false');
      });
    }

    function renderModule(id) {
      const mod = modules[id];
      if (!mod) return;
      selectedModule = id;
      activeMech = null;
      mode.textContent = '模块视图';
      title.textContent = mod.name;
      summary.textContent = mod.role;
      path.innerHTML = `<span>${mod.layer}</span>`;
      decide.textContent = '输入：' + mod.input;
      execute.textContent = '输出：' + mod.output;
      cost.textContent = '服务机制：' + mod.mechanisms.map(m => mechanisms[m].name).join(' · ');
      links.innerHTML = chapterMarkup(chapterTargets.module[id]) + linkMarkup(mod.sources);
      mechPills.forEach(pill => { pill.classList.remove('is-active'); pill.setAttribute('aria-pressed', 'false'); });
      const related = new Set(mod.mechanisms.flatMap(m => mechanisms[m].modules));
      nodes.forEach(node => {
        node.classList.toggle('is-lit', node.dataset.module === id || related.has(node.dataset.module));
        node.classList.toggle('is-selected', node.dataset.module === id);
        node.setAttribute('aria-pressed', String(node.dataset.module === id));
      });
    }

    mechPills.forEach(pill => pill.addEventListener('click', () => renderMechanism(pill.dataset.mech)));
    nodes.forEach(node => node.addEventListener('click', () => {
      if (selectedModule === node.dataset.module) renderMechanism(activeMech || 'lifecycle');
      else renderModule(node.dataset.module);
    }));
    renderMechanism('lifecycle');
  }

  /* keep selected module when clicking a source link */
  $$('.source-card, .srcline').forEach(a => a.addEventListener('click', e => e.stopPropagation()));
})();
