/* DeepInfer model page — three continuous teaching traces, vanilla JS. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
  const smooth = (p) => { p = clamp(p); return p * p * (3 - 2 * p); };
  const seg = (t, a, b) => smooth((t - a) / (b - a || 1));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const labs = [];

  function center(el, stage) {
    if (!el) return null;
    const a = el.getBoundingClientRect();
    const b = stage.getBoundingClientRect();
    return { x: a.left - b.left + a.width / 2, y: a.top - b.top + a.height / 2 };
  }

  function makeFlight(layer, text, cls = '') {
    const el = document.createElement('span');
    el.className = 'mdl-flight ' + cls;
    el.textContent = text;
    el.setAttribute('aria-hidden', 'true');
    layer.appendChild(el);
    return el;
  }

  function placeFlight(el, stage, fromEl, toEl, p, opacity = 1) {
    if (!el) return;
    if (p <= 0 || p >= 1) { el.style.opacity = '0'; return; }
    const a = center(fromEl, stage);
    const b = center(toEl, stage);
    if (!a || !b) { el.style.opacity = '0'; return; }
    el.style.opacity = String(opacity);
    el.style.transform = `translate(${a.x + (b.x - a.x) * p}px, ${a.y + (b.y - a.y) * p}px) translate(-50%, -50%)`;
  }

  function placePoly(el, stage, points, p, opacity = 1) {
    if (!el || !points.length) return;
    if (p <= 0 || p >= 1) { el.style.opacity = '0'; return; }
    const n = points.length - 1;
    const z = clamp(p) * n;
    const i = Math.min(n - 1, Math.floor(z));
    const q = z - i;
    const a = points[i], b = points[i + 1] || a;
    el.style.opacity = String(opacity);
    el.style.transform = `translate(${a.x + (b.x - a.x) * q}px, ${a.y + (b.y - a.y) * q}px) translate(-50%, -50%)`;
  }

  class Lab {
    constructor(root, spec) {
      this.root = root;
      this.spec = spec;
      this.canvas = $('[data-canvas]', root);
      this.flights = $('[data-flights]', root);
      this.steps = $('[data-steps]', root);
      this.beat = $('[data-beat]', root);
      this.playBtn = $('[data-act="play"]', root);
      this.stateEl = spec.stateEl ? $(spec.stateEl, root) : null;
      this.events = spec.events.slice();
      this.t = reducedMotion ? 1 : 0;
      this.playing = false;
      this.raf = 0;
      this.last = 0;
      this.lastPhase = '';
      this.bind();
      this.buildSteps();
      if (spec.init) spec.init(this);
      this.render();
      this.sync();
      labs.push(this);
      if (this.playBtn && reducedMotion) {
        this.playBtn.hidden = true;
        const note = document.createElement('span');
        note.className = 'lab-beat';
        note.textContent = '减少动态：显示完成态，用上一步/下一步查看';
        this.beat.parentNode.insertBefore(note, this.beat);
      }
    }

    bind() {
      const self = this;
      if (this.playBtn) this.playBtn.addEventListener('click', () => self.playing ? self.pause() : self.play());
      const prev = $('[data-act="prev"]', this.root);
      const next = $('[data-act="next"]', this.root);
      const reset = $('[data-act="reset"]', this.root);
      if (prev) prev.addEventListener('click', () => self.step(-1));
      if (next) next.addEventListener('click', () => self.step(1));
      if (reset) reset.addEventListener('click', () => self.reset());
      document.addEventListener('visibilitychange', () => { if (document.hidden) self.pause(); });
      let resizeFrame = 0;
      window.addEventListener('resize', () => {
        if (resizeFrame) return;
        resizeFrame = window.requestAnimationFrame(() => {
          resizeFrame = 0;
          if (!self.playing) self.render();
        });
      });
    }

    buildSteps() {
      if (!this.steps) return;
      this.steps.innerHTML = '';
      this.events.forEach((event, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'lab-step';
        b.textContent = `${String(i + 1).padStart(2, '0')} ${event.label}`;
        b.addEventListener('click', () => { this.pause(); this.seek(event.at); });
        this.steps.appendChild(b);
      });
    }

    setEvents(events) {
      this.events = events.slice();
      this.buildSteps();
      this.sync();
    }

    currentIndex() {
      let idx = 0;
      this.events.forEach((event, i) => { if (this.t + 1e-4 >= event.at) idx = i; });
      return idx;
    }

    sync() {
      const idx = this.currentIndex();
      const event = this.events[idx] || this.events[0];
      if (this.steps) {
        $$('.lab-step', this.steps).forEach((b, i) => {
          b.classList.toggle('is-active', i === idx);
          b.setAttribute('aria-current', i === idx ? 'step' : 'false');
        });
      }
      if (this.beat) this.beat.textContent = `事件 ${String(idx + 1).padStart(2, '0')} / ${String(this.events.length).padStart(2, '0')} · ${event.label}`;
      if (this.playBtn) {
        this.playBtn.textContent = this.playing ? '暂停' : (this.t >= 1 ? '重播' : '播放');
        this.playBtn.setAttribute('aria-pressed', String(this.playing));
      }
      if (this.stateEl && this.spec.stateFor) {
        const phase = this.spec.stateFor(this, this.t);
        if (phase !== this.lastPhase) { this.stateEl.textContent = phase; this.lastPhase = phase; }
      }
    }

    render() {
      this.spec.render(this, clamp(this.t));
      this.sync();
    }

    seek(t) {
      this.t = clamp(t);
      this.render();
    }

    play() {
      if (reducedMotion) { this.step(1); return; }
      if (this.t >= 1) this.t = 0;
      this.playing = true;
      this.last = 0;
      this.sync();
      const tick = (now) => {
        if (!this.playing) return;
        if (!this.last) this.last = now;
        this.t = clamp(this.t + (now - this.last) / this.spec.duration);
        this.last = now;
        this.render();
        if (this.t >= 1) { this.pause(); return; }
        this.raf = window.requestAnimationFrame(tick);
      };
      this.raf = window.requestAnimationFrame(tick);
    }

    pause() {
      this.playing = false;
      if (this.raf) window.cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.last = 0;
      this.sync();
    }

    reset() {
      this.pause();
      this.t = reducedMotion ? 1 : 0;
      if (this.spec.reset) this.spec.reset(this);
      this.render();
    }

    retime() {
      this.pause();
      this.t = reducedMotion ? 1 : 0;
      this.render();
    }

    step(dir) {
      this.pause();
      if (dir > 0) {
        const next = this.events.find((event) => event.at > this.t + 1e-3);
        this.t = next ? next.at : 1;
      } else {
        const prev = this.events.slice().reverse().find((event) => event.at < this.t - 1e-3);
        this.t = prev ? prev.at : 0;
      }
      this.render();
    }
  }

  /* ---------- structure atlas ---------- */
  const LAYER = {
    kv: [2, 8, 14, 20],
    index: [2, 8, 14, 20, 24, 28, 32, 36],
    engram: [1, 14],
    candidate: 20,
    predict: [37, 38, 39]
  };

  function kvSource(id) {
    let source = null;
    LAYER.kv.forEach((s) => { if (s <= id) source = s; });
    return source;
  }
  // LAYER.index is the index-module / Top-k source list, not the index-K list.
  // This checkpoint has no independent index_k_source_layer_ids, so index-K
  // follows the main-KV source and 20-39 all reuse layer 20's index-K.
  function indexModuleSource(id) {
    if (id < LAYER.index[0]) return null;
    let source = null;
    LAYER.index.forEach((s) => { if (s <= id) source = s; });
    return source;
  }
  function indexKSource(id) {
    return id < LAYER.kv[0] ? null : kvSource(id);
  }
  function topkSource(id) {
    if (id < LAYER.index[0]) return null;
    let source = LAYER.index[0];
    LAYER.index.forEach((s) => { if (s <= id) source = s; });
    return source;
  }
  function topkSegmentEnd(id) {
    let end = 39;
    LAYER.index.forEach((s) => { if (s > id) end = Math.min(end, s - 1); });
    return end;
  }

  function layerInfo(id) {
    const cell = $(`.layer-cell[data-layer="${id}"]`);
    const ratio = cell ? Number(cell.dataset.ratio) : 0;
    return {
      id, ratio,
      consumer: id >= 20,
      kv: kvSource(id),
      indexK: indexKSource(id),
      indexModule: indexModuleSource(id),
      topk: topkSource(id),
      candidate: id >= 20 ? LAYER.candidate : null,
      engram: LAYER.engram.includes(id),
      predict: LAYER.predict.includes(id)
    };
  }

  const atlas = $('[data-layer-atlas]');
  const inspector = $('[data-layer-inspector]');
  if (atlas && inspector) {
    const select = (id) => {
      $$('.layer-cell', atlas).forEach((cell) => {
        const on = Number(cell.dataset.layer) === id;
        cell.classList.toggle('is-current', on);
        cell.setAttribute('aria-pressed', String(on));
      });
      const d = layerInfo(id);
      const roles = [];
      if (d.consumer) roles.push('YOCO consumer');
      if (d.kv === id) roles.push('主 KV 源');
      if (d.indexK === id) roles.push('index-K 源');
      if (d.indexModule === id) roles.push('index/Top-k 源');
      if (d.candidate === id) roles.push('候选块源');
      if (d.engram) roles.push('Engram 注入');
      if (d.predict) roles.push('预测目标层');
      if (!roles.length) roles.push(d.ratio === 0 ? '纯 SWA 层' : '共享段 consumer');
      const ratioText = d.ratio === 0
        ? '0：纯 SWA，不进入 packed 主 KV 分支'
        : d.ratio === 2
          ? '2：通道内 softmax 两 token 合成，主 KV 条目约减半'
          : '1：不做时间维 2:1 合成，但仍在稀疏/压缩分支';
      const kvText = id < 2 ? '不参加 packed 主 KV；只有局部窗口' : d.kv === id ? '本层产生；后续段按映射 alias 复用' : `来自 layer ${d.kv}；不复制整层 cache`;
      const ikText = id < 2 ? '无跨层 index-K' : d.indexK === id ? '本层产生；index-K 跟随主 KV 源，后续段复用' : `来自 layer ${d.indexK}；共享 key（此 checkpoint 跟随主 KV 源）`;
      const topkText = d.topk == null
        ? '无 packed index 路径；本层没有跨层 Top-k 共享'
        : d.topk === id
          ? (id === 20
            ? '本层对全合法位置评分并选 Top-k；21–23 共享。候选块随后产生，不反向限制本层 Top-k'
            : `本层重新打分并选 Top-k；${id + 1}–${topkSegmentEnd(id)} 共享`)
          : `共享 layer ${d.topk} 的 Top-k；最终 Q 仍来自本层`;
      const candText = id === 20
        ? '本层评分后产生 B0/B3；不限制本层的 12 个合法位置'
        : d.candidate === null
          ? '不参与候选块选择'
          : '来自 layer 20；后续 index 只在这 4 个候选位置内评分';
      const note = id === 20
        ? '20 先对全合法位置评分，再从分数产生候选块 B0/B3，并从全量分数选 Top-k。点 24：KV/index-K 仍来自 20，候选块也来自 20；24 只在候选内重新打分。点 26：直接共享 24 的 Top-k。'
        : id === 24
          ? '24 是新的 index/Top-k 源：主 KV/index-K 从 20 来，候选块也来自 20；它只在候选内重新打分，因此 Top-k 可以不同；25–27 再共享 24 的结果。'
          : id === 26
            ? '26 不重算索引：直接共享 24 的 Top-k；index-K 仍来自 20；26 自己的 Q 仍要投影并读取 KV。'
            : id === 2 || id === 8 || id === 14
              ? `这一层是新的 index/Top-k 源：${id}–${topkSegmentEnd(id)} 共享本层 Top-k；index-K 跟随主 KV 源。`
              : `这一层的共享来源与插入点按左边映射显示；SWA 始终是本层独立状态。`;
      inspector.innerHTML = `
        <div class="layer-inspector__head"><div><span class="micro-label">SELECTED LAYER</span><h4>layer ${id}</h4></div><span class="tag tag--sim">${d.consumer ? 'consumer 半区' : 'prefill 半区'}</span></div>
        <p class="layer-inspector__roles">${roles.join(' · ')}</p>
        <dl class="layer-inspector__facts">
          <div><dt>ratio</dt><dd>${ratioText}</dd></div>
          <div><dt>主 KV</dt><dd>${kvText}</dd></div>
          <div><dt>index-K</dt><dd>${ikText}</dd></div>
          <div><dt>Top-k</dt><dd>${topkText}</dd></div>
          <div><dt>候选块</dt><dd>${candText}</dd></div>
          <div><dt>Engram / 预测</dt><dd>${d.engram ? 'Engram 注入（HC post → attention pre）' : '无 Engram'}${d.predict ? '；预测目标层（旁路）' : ''}</dd></div>
        </dl>
        <p class="layer-inspector__note">${note}</p>
        <a class="srcline" href="https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/blob/1bae0e1088993b9b82de08f59de5be5a34e42170/config.json#L106-L127" target="_blank" rel="noopener noreferrer">config.json:106–127 ↗</a>`;
    };
    $$('.layer-cell', atlas).forEach((cell) => {
      cell.addEventListener('click', () => select(Number(cell.dataset.layer)));
    });
    select(20);
  }

  /* ---------- parallel board ---------- */
  const parBoard = $('[data-par-board]');
  if (parBoard) {
    const data = {
      dp: {
        caption: 'DP 视图：同一 CP 坐标跨副本；请求 A/B 可以不同。点位不变，只换分组。',
        groups: '<span>DP 组 <b>[0,2]</b></span><span>DP 组 <b>[1,3]</b></span><span>CP 组仍为 [0,1] / [2,3]</span>',
        bodies: [
          ['请求 A · prefill', 'CP 坐标 0'],
          ['请求 A · prefill', 'CP 坐标 1'],
          ['请求 B · prefill', 'CP 坐标 0'],
          ['请求 B · prefill', 'CP 坐标 1']
        ],
        notes: ['DP0', 'DP0', 'DP1', 'DP1']
      },
      cp: {
        caption: 'CP 视图：同一请求的 8 个 query 被镜像切成两半；all-gather 所需 KV 后计算，末尾逆重排恢复 0–7。',
        groups: '<span>CP 组 <b>[0,1]</b> · 请求 A</span><span>CP 组 <b>[2,3]</b> · 请求 B</span><span>同一个 EP 组仍覆盖 4 卡</span>',
        bodies: [
          ['0', '1', '6', '7'],
          ['2', '3', '4', '5'],
          ['0', '1', '6', '7'],
          ['2', '3', '4', '5']
        ],
        notes: ['A · mirror 前段', 'A · mirror 后段', 'B · mirror 前段', 'B · mirror 后段']
      },
      ep: {
        caption: 'EP 视图：routed expert 的 physical slot 分到各 rank；shared expert 不在 routed Top-k 计数里。',
        groups: '<span>EP 组 <b>[0,1,2,3]</b> · 全 4 卡</span><span>每 rank physical slot 数相同</span><span>EPLB 副本在固定预算内重排</span>',
        bodies: [
          ['E0–E95', '96 slots'],
          ['E96–E191', '96 slots'],
          ['E192–E287', '96 slots'],
          ['E288–E383', '96 slots']
        ],
        notes: ['routed slots', 'routed slots', 'routed slots', 'routed slots']
      }
    };
    const render = (view) => {
      parBoard.dataset.view = view;
      $$('[data-par-view]', parBoard).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.parView === view)));
      const d = data[view];
      $$('[data-par-body]', parBoard).forEach((body, i) => {
        body.innerHTML = d.bodies[i].map((t) => `<span class="par-chip ${view === 'cp' ? (i % 2 === 0 ? 'par-chip--a' : 'par-chip--b') : view === 'ep' ? 'par-chip--exp' : (i < 2 ? 'par-chip--a' : 'par-chip--b')}">${t}</span>`).join('');
      });
      $$('[data-par-note]', parBoard).forEach((el, i) => { el.textContent = d.notes[i]; });
      $('[data-par-groups]', parBoard).innerHTML = d.groups;
      $('[data-par-caption]', parBoard).textContent = d.caption;
    };
    $$('[data-par-view]', parBoard).forEach((b) => b.addEventListener('click', () => render(b.dataset.parView)));
    render('dp');
  }

  /* ---------- attention lab ---------- */
  const attnRoot = $('[data-lab="attn"]');
  if (attnRoot) {
    const SCORES = {
      20: [0.20, 0.90, 0.10, 0.70, 0.50, 0.30, 0.35, 0.85, 0.60, 0.40, 0.75, 0.05],
      24: [0.15, 0.80, 0.10, 0.65, 0.40, 0.30, 0.45, 0.90, 0.55, 0.35, 0.60, 0.10]
    };
    const LAYER_DATA = {
      20: {
        topk: [1, 7, 10], rescore: true, scan: 'all', candidateAt: .4,
        source: 'L20 本层', badge: 'layer 20 · 产生',
        role: '20：先对全部 12 个合法位置评分，再产生候选块 B0/B3，并从全量分数选 Top-k。',
        candNote: '全量评分 → 后产候选'
      },
      24: {
        topk: [1, 6, 7], rescore: true, scan: 'candidate', candidateAt: 0,
        source: 'L24 重新打分', badge: 'layer 24 · 重算',
        role: '24：主 KV/index-K 来自 20；候选块 B0/B3 也来自 20；只在这 4 个候选位置内重新打分。',
        candNote: '候选 ← L20；评分 ← L24'
      },
      26: {
        topk: [1, 6, 7], rescore: false, scan: 'none', candidateAt: 0,
        source: 'L24 共享', badge: 'layer 26 · 共享',
        role: '26：共享 24 的 Top-k，不重算索引；最终 attention Q 仍由 26 投影。',
        candNote: '候选 ← L20；Top-k ← L24'
      }
    };
    const candidates = [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11]];
    const candSet = [0, 3];
    const canvas = $('[data-canvas]', attnRoot);
    const candGrid = $('[data-attn-candidates]', attnRoot);
    const kvGrid = $('[data-attn-kv]', attnRoot);
    const topkList = $('[data-attn-topk]', attnRoot);
    const flights = $('[data-flights]', attnRoot);

    candidates.forEach((pair, bi) => {
      const block = document.createElement('div');
      block.className = 'cand-block';
      block.dataset.block = String(bi);
      block.innerHTML = `<div class="cand-block__head"><span>B${bi} · 块${bi}</span><b>${candSet.includes(bi) ? '候选' : '—'}</b></div><div class="cand-scores"></div>`;
      const scoreWrap = $('.cand-scores', block);
      pair.forEach((pos) => {
        const row = document.createElement('div');
        row.className = 'cand-score';
        row.dataset.pos = String(pos);
        row.innerHTML = `<span>C${pos}</span><i></i><em>0.00</em>`;
        scoreWrap.appendChild(row);
      });
      candGrid.appendChild(block);
    });
    for (let i = 0; i < 12; i += 1) {
      const cell = document.createElement('span');
      cell.className = 'kv-cell';
      cell.dataset.kvIndex = String(i);
      cell.textContent = `C${i}`;
      kvGrid.appendChild(cell);
    }

    const sourceStack = $('.attn-source-stack', attnRoot);
    const topkSrc = document.createElement('div');
    topkSrc.className = 'mdl-node';
    topkSrc.dataset.attnTopksrc = '';
    topkSrc.innerHTML = '<span>SHARED INDEX</span><strong>L24 Top-k</strong><small>不重新打分，仍用本层 Q 读</small>';
    topkSrc.hidden = true;
    sourceStack.appendChild(topkSrc);

    let layer = 20;
    let data = LAYER_DATA[layer];
    const topkAnchor = $('.topk-box', attnRoot);
    const qFlight = makeFlight(flights, 'Q', 'mdl-flight--q');
    const scanFlight = makeFlight(flights, 'score', 'mdl-flight--q');
    const reuseFlight = makeFlight(flights, 'L24 Top-k', 'mdl-flight--reuse');
    const readFlights = [0, 1, 7, 9, 10, 11].map((pos) => makeFlight(flights, pos >= 9 ? `K${pos}` : `C${pos}`, pos >= 9 ? '' : 'mdl-flight--kv'));

    const applyLayer = (lab) => {
      data = LAYER_DATA[layer];
      $('[data-attn-badge]', attnRoot).textContent = data.badge;
      $('[data-attn-role]', attnRoot).textContent = data.role;
      $('[data-attn-layer-label]', attnRoot).textContent = `L${layer}`;
      $('[data-attn-cand-note]', attnRoot).textContent = data.candNote;
      $('[data-attn-topk-note]', attnRoot).textContent = data.rescore ? (layer === 20 ? '全量分数选' : '候选内重算') : '共享 L24';
      $('[data-attn-topk-source]', attnRoot).textContent = data.source;
      topkSrc.hidden = layer !== 26;
      $$('.cand-block', candGrid).forEach((block) => {
        const on = candSet.includes(Number(block.dataset.block));
        block.classList.remove('is-cand');
        block.classList.toggle('is-cand', on && layer === 24);
        block.classList.toggle('is-out', layer === 24 ? !on : layer === 26);
        block.querySelector('.cand-block__head b').textContent = layer === 26
          ? (on ? '共享候选' : '—')
          : layer === 24
            ? (on ? '候选' : '—')
            : (on ? '候选位置' : '合法位置');
      });
      const vals = layer === 26 ? SCORES[24] : SCORES[layer];
      $$('.cand-score', candGrid).forEach((row) => {
        const pos = Number(row.dataset.pos);
        row.querySelector('i').style.width = `${Math.round(vals[pos] * 100)}%`;
        row.querySelector('em').textContent = vals[pos].toFixed(2);
        row.classList.toggle('is-scored', layer !== 26);
      });
      topkList.innerHTML = data.topk.map((pos) => `<span class="mdl-chip">位置 ${pos}</span>`).join('');
      $$('.kv-cell', kvGrid).forEach((cell) => {
        cell.classList.toggle('is-picked', data.topk.includes(Number(cell.dataset.kvIndex)));
        cell.classList.toggle('is-source', Number(cell.dataset.kvIndex) < 12);
      });
      $('[data-attn-indexq-note]', attnRoot).textContent = data.rescore ? '本层打分' : '本层不重算索引';
      const ikStrong = $('[data-attn-ik] strong', attnRoot);
      const ikSmall = $('[data-attn-ik] small', attnRoot);
      if (ikStrong && ikSmall) {
        const producesIk = layer === 20;
        ikStrong.textContent = producesIk ? '本层产生' : '来源 L20';
        ikSmall.textContent = producesIk
          ? 'index-K 跟随主 KV 源；20–39 复用 key'
          : layer === 24
            ? '共享 key；Top-k 由本层在候选内重算'
            : '共享 key；Top-k 共享 L24，本层不重新评分';
      }
      scanFlight.textContent = data.scan === 'all' ? '全量评分' : '候选评分';
      readFlights.forEach((flight, i) => {
        if (i < 3) {
          flight.textContent = `C${data.topk[i]}`;
          flight.className = 'mdl-flight mdl-flight--kv';
        } else {
          flight.textContent = `K${9 + i - 3}`;
          flight.className = 'mdl-flight';
        }
      });
      $$('[data-attn-layer]', attnRoot).forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.attnLayer) === layer)));
      const events = layer === 20
        ? [{ at: 0, label: 'Q 投影' }, { at: .16, label: '全合法位置评分' }, { at: .4, label: '产生候选块 B0/B3' }, { at: .62, label: '全量分数选 Top-k' }, { at: .82, label: '读取 KV' }, { at: 1, label: '本层输出' }]
        : layer === 24
          ? [{ at: 0, label: 'Q 投影' }, { at: .16, label: '候选块来自 L20' }, { at: .38, label: '候选内重评分' }, { at: .62, label: 'Top-k' }, { at: .82, label: '读取 KV' }, { at: 1, label: '本层输出' }]
          : [{ at: 0, label: 'Q 投影' }, { at: .22, label: '共享 Top-k' }, { at: .58, label: '读取 KV' }, { at: .82, label: '本层输出' }, { at: 1, label: '完成' }];
      lab.setEvents(events);
    };

    const lab = new Lab(attnRoot, {
      duration: 9200,
      stateEl: '[data-attn-state]',
      events: [{ at: 0, label: 'Q 投影' }, { at: .16, label: '全合法位置评分' }, { at: .4, label: '产生候选块 B0/B3' }, { at: .62, label: '全量分数选 Top-k' }, { at: .82, label: '读取 KV' }, { at: 1, label: '本层输出' }],
      init(l) { applyLayer(l); },
      stateFor(l, t) {
        if (t < .16) return `Q 从本层 hidden 投影；${data.rescore ? 'index-Q 也已就位。' : '索引选择直接沿用 L24。'}`;
        if (layer === 20) {
          if (t < .4) return '扫描全部 12 个合法位置并逐位置打分；此时还没有候选块，候选不能反向限制本层 Top-k。';
          if (t < .62) return '分数就绪后产生候选块 B0/B3，供后续 index 层缩小范围；本层仍从全量分数选 Top-k。';
          if (t < .82) return `Top-k 从全量分数选出位置 ${data.topk.join('、')}（按位置排序）；它们只是索引，接下来才读主 KV 内容。`;
        } else if (layer === 24) {
          if (t < .38) return '候选块 B0/B3 来自 L20；本层只在这 4 个候选位置内用本层 index-Q/weights 重新打分。';
          if (t < .62) return '候选内分数 C0=0.15、C1=0.80、C6=0.45、C7=0.90；按分数选 Top-k，候选外的 C3 不参与。';
          if (t < .82) return `Top-k 选出位置 ${data.topk.join('、')}；候选约束来自 L20，分数来自本层。`;
        } else {
          if (t < .58) return '不重算索引；直接共享 L24 的 Top-k 1、6、7。';
          if (t < .82) return 'Top-k 位置 1、6、7 已就位；本层不运行 indexer 评分，只读这些位置。';
        }
        if (t < 1) return '读取选中的主 KV 摘要和本层 SWA；当前层 Q 参与核心 attention，输出回本层残差。';
        return `完成：${data.source}；主 KV/index-K 的来源没有被本层 attention 输出替换。`;
      },
      render(l, t) {
        const qOn = t > .02;
        $('[data-attn-q]', attnRoot).classList.toggle('is-live', qOn && t < .82);
        $('[data-attn-indexq]', attnRoot).classList.toggle('is-muted', !data.rescore);
        $('[data-attn-hidden]', attnRoot).classList.toggle('is-done', t > .1);
        placeFlight(qFlight, canvas, $('[data-attn-hidden]', attnRoot), $('[data-attn-q]', attnRoot), seg(t, .02, .15));
        if (data.rescore) {
          if (layer === 20) {
            const ready = t >= data.candidateAt;
            $$('.cand-block', candGrid).forEach((block) => {
              const on = candSet.includes(Number(block.dataset.block));
              block.classList.toggle('is-cand', on && ready);
              block.querySelector('.cand-block__head b').textContent = on && ready ? '候选' : (on ? '候选位置' : '合法位置');
            });
          }
          const blocks = layer === 20 ? $$('.cand-block', candGrid) : $$('.cand-block.is-cand', candGrid);
          const pts = blocks.map((b) => center(b, canvas)).filter(Boolean);
          placePoly(scanFlight, canvas, pts, seg(t, layer === 20 ? .16 : .2, .36), .95);
          const scoreOn = t >= .36;
          $$('.cand-score', candGrid).forEach((row) => {
            const pos = Number(row.dataset.pos);
            const active = layer === 20 || candSet.includes(Math.floor(pos / 2));
            row.style.opacity = active ? String(seg(t, .36, .54)) : '0.22';
            row.querySelector('i').style.opacity = active ? String(seg(t, .36, .54)) : '0.2';
          });
          $('[data-attn-candidates]', attnRoot).classList.toggle('is-scored', scoreOn);
        } else {
          scanFlight.style.opacity = '0';
          placeFlight(reuseFlight, canvas, topkSrc, topkAnchor, seg(t, .22, .5));
        }
        const topOn = data.rescore ? t >= .62 : t >= .55;
        topkList.style.opacity = topOn ? '1' : '0.25';
        $$('.kv-cell', kvGrid).forEach((cell) => {
          const picked = data.topk.includes(Number(cell.dataset.kvIndex));
          cell.style.opacity = picked ? String(topOn ? 1 : .35) : '0.3';
        });
        const readT = data.rescore ? .82 : .58;
        const p = seg(t, readT, .96);
        const kvEls = data.topk.map((pos) => $(`.kv-cell[data-kv-index="${pos}"]`, kvGrid));
        const swaEls = [9, 10, 11].map((pos) => $$('.swa-grid .mdl-chip', attnRoot)[pos - 9]);
        const targets = kvEls.concat(swaEls);
        readFlights.forEach((flight, i) => {
          const src = targets[i];
          const local = clamp(p * 1.15 - i * .05);
          placeFlight(flight, canvas, src, $('[data-attn-read]', attnRoot), local, .95);
        });
        $('[data-attn-read]', attnRoot).classList.toggle('is-live', t >= readT && t < 1);
        $('[data-attn-out]', attnRoot).classList.toggle('is-done', t >= .96);
      },
      reset() { scanFlight.style.opacity = '0'; reuseFlight.style.opacity = '0'; readFlights.forEach((f) => { f.style.opacity = '0'; }); }
    });

    $$('[data-attn-layer]', attnRoot).forEach((button) => {
      button.addEventListener('click', () => {
        layer = Number(button.dataset.attnLayer);
        applyLayer(lab);
        lab.retime();
      });
    });
  }

  /* ---------- YOCO lab ---------- */
  const yocoRoot = $('[data-lab="yoco"]');
  if (yocoRoot) {
    const N = 12, W = 4, B = 2, MIN_KEEP = W + B;
    let mode = 'compact';
    let keep = 8;
    const axis = $('[data-yoco-axis]', yocoRoot);
    const kvWrap = $('[data-yoco-kv]', yocoRoot);
    const queryWrap = $('[data-yoco-query]', yocoRoot);
    const barWrap = $('[data-yoco-bars]', yocoRoot);
    const head = $('[data-yoco-head]', yocoRoot);
    for (let i = 0; i < N; i += 1) {
      const a = document.createElement('span');
      a.className = 'yoco-token';
      a.textContent = i;
      axis.appendChild(a);
      const kv = document.createElement('span');
      kv.className = 'yoco-cell';
      kv.dataset.yocoKv = String(i);
      kv.textContent = i;
      kvWrap.appendChild(kv);
      const q = document.createElement('span');
      q.className = 'yoco-cell';
      q.dataset.yocoQ = String(i);
      q.textContent = i;
      queryWrap.appendChild(q);
    }

    const keepStart = () => mode === 'off' ? 0 : N - keep;
    const rowSet = () => mode === 'compact'
      ? Array.from({ length: keep }, (_, i) => keepStart() + i)
      : Array.from({ length: N }, (_, i) => i);

    // One interval function for all modes: [lo, end). Mask/compact clamp the
    // lower bound into [0, pos+1], so an early row can become empty (∅).
    const visibleRange = (pos) => {
      const start = keepStart();
      const rawLo = mode === 'off' ? pos - W + 1 : Math.max(pos - W + 1, start);
      const lo = Math.min(Math.max(0, rawLo), pos + 1);
      const end = Math.min(N, pos + 1);
      return { lo, end, empty: end <= lo };
    };
    const rangeText = (range) => range.empty ? '∅' : `[${range.lo},${range.end})`;

    const eventsForMode = () => mode === 'compact'
      ? [{ at: 0, label: '边界 20 分叉' }, { at: .18, label: 'full 支路写 KV' }, { at: .4, label: 'compact 裁行' }, { at: .55, label: '重放保留后缀' }, { at: .86, label: '交给 decode' }]
      : mode === 'mask'
        ? [{ at: 0, label: '普通 full 前向' }, { at: .18, label: '12 行 query 都算' }, { at: .42, label: '裁 SWA 可见域' }, { at: .66, label: '空可见域 = ∅' }, { at: .88, label: '交给 decode' }]
        : [{ at: 0, label: '普通 full 前向' }, { at: .18, label: '12 行 query + SWA' }, { at: .42, label: '照常写主 KV/index-K' }, { at: .66, label: '本层 attention 完成' }, { at: .88, label: '交给 decode' }];

    const buildRows = () => {
      barWrap.innerHTML = '';
      rowSet().forEach((pos) => {
        const range = visibleRange(pos);
        const row = document.createElement('div');
        row.className = 'yoco-bar';
        row.dataset.yocoBar = String(pos);
        row.innerHTML = `<span>pos ${pos}</span><span class="yoco-bar__track"><i style="left:${(range.lo / N) * 100}%;width:${(range.empty ? 0 : (range.end - range.lo) / N * 100)}%"></i></span><span class="${range.empty ? 'is-empty' : ''}">${rangeText(range)}</span>`;
        barWrap.appendChild(row);
      });
      $('[data-yoco-start]', yocoRoot).textContent = String(keepStart());
    };

    const apply = () => {
      const start = keepStart();
      const rows = rowSet();
      const compact = mode === 'compact';
      $('[data-yoco-badge]', yocoRoot).textContent = compact ? `compact · keep ${keep}` : mode === 'mask' ? `mask · keep ${keep} · 仅可见域` : 'off · 全量';
      $('[data-yoco-keep-out]', yocoRoot).textContent = String(keep);
      $('[data-yoco-q-count]', yocoRoot).textContent = String(rows.length);
      $('[data-yoco-kv-count]', yocoRoot).textContent = String(N);
      $('[data-yoco-query-note]', yocoRoot).textContent = compact ? `只算保留行 ${start}–11（${rows.length} 行）` : mode === 'mask' ? '12 行都算；只裁 SWA 可见域' : '不截断；12 行 query 都算';
      $('[data-yoco-full-head]', yocoRoot).textContent = compact ? 'FULL 支路 · full-hidden/metadata 专门写入' : 'FULL / KV · 普通 full 前向';
      $('[data-yoco-query-head]', yocoRoot).textContent = compact ? 'CONSUMER 支路 · query / 后续 norm + MLP' : 'QUERY 行 · 12 行完整计算';
      $('[data-yoco-full-note]', yocoRoot).textContent = compact ? 'compact 专用：主 KV / index-K 0–11 全部写入并保留' : '普通 full 前向：主 KV / index-K 0–11 照常写入并保留';
      $('[data-yoco-mode-note]', yocoRoot).textContent = compact ? 'compact：建立边界；裁 consumer 后缀行' : mode === 'mask' ? 'mask：不建 compact 边界；只裁 SWA 可见域' : 'off：普通 full 前向；不裁行、不重放';
      $('[data-yoco-vis-head]', yocoRoot).textContent = compact ? 'SWA replay 可见域（半开区间）' : mode === 'mask' ? 'SWA 可见域（半开区间）' : 'SWA 因果窗口（半开区间）';
      $('[data-yoco-vis-note]', yocoRoot).textContent = mode === 'off' ? 'W=4 · 普通因果窗口' : `W=4 · 保留起点 ${start}`;
      $('[data-yoco-approx]', yocoRoot).textContent = compact
        ? 'approx：compact 与 mask 共用截断 SWA 可见域，相对不截断路径可能有数值差异'
        : mode === 'mask'
          ? 'approx：mask 与 compact 共用截断 SWA 可见域，相对 off 可能有差异；不减 query 行'
          : '路径：off 不截断，作为 full SWA 对照';
      $$('[data-yoco-q]', queryWrap).forEach((cell) => {
        const pos = Number(cell.dataset.yocoQ);
        cell.classList.toggle('is-query', rows.includes(pos));
        cell.classList.toggle('is-cut', false);
        cell.style.opacity = rows.includes(pos) ? '1' : '.3';
        cell.style.borderStyle = rows.includes(pos) ? 'solid' : 'dashed';
      });
      $$('[data-yoco-kv]', kvWrap).forEach((cell) => { cell.classList.remove('is-kv'); });
      $$('[data-yoco-mode]', yocoRoot).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.yocoMode === mode)));
      buildRows();
    };

    const lab = new Lab(yocoRoot, {
      duration: 8600,
      stateEl: '[data-yoco-state]',
      events: eventsForMode(),
      init() { apply(); },
      stateFor(l, t) {
        if (mode === 'off') {
          if (t < .18) return 'off：普通 full 前向；layer 20 仍是主 KV/index-K 源，但没有 compact 专用分叉。';
          if (t < .42) return '12 行 query 都按普通 SWA 计算；没有 consumer 重排，也没有专门的 full-hidden 支路。';
          if (t < .66) return '主 KV/index-K 按常规路径写入并保留 0–11；不经过 _store_yoco_full_kv。';
          if (t < .88) return '本层 attention 用完整 SWA 窗口计算；不需要 bounded replay。';
          return 'off 完成：query/KV 行数都不减，交给 decode；没有后缀重放近似。';
        }
        if (mode === 'mask') {
          if (t < .18) return 'mask：普通 full 前向；不建立 compact 边界，也不走专门的 full-hidden/metadata 支路。';
          if (t < .42) return '12 行 query 都保留并计算；与 off 的区别只在 SWA 可见域。';
          if (t < .66) return `保留矩形之外的行可见域为空 ∅；矩形内用 [max(pos-W+1, ${keepStart()}), pos+1) 计算。`;
          if (t < .88) return '空可见域不产生 KV 读取；行数仍为 12，不减少后续 norm/MLP 的行。';
          return 'mask 完成：主 KV/index-K 完整保留，交给 decode；12 行都保留，但 SWA 可见域被截断，相对 off 可能有数值差异。';
        }
        if (t < .18) return 'layer 20 同时是 consumer 起点和 full KV/index-K 源；compact 边界从这里建立。';
        if (t < .4) return 'full hidden 沿 _store_yoco_full_kv 专门路径写入 0–11 的主 KV/index-K；这条支路只由 compact 触发。';
        if (t < .55) return `compact 把 consumer query/后续 norm/MLP 裁到保留行 ${keepStart()}–11；主 KV 仍完整。`;
        if (t < .86) return '按 W=4 重放保留后缀的 SWA；每个位置可见 [max(pos-W+1, 保留起点), pos+1)，空域记 ∅。';
        return '重建后的 SWA ring 交给 decode；主 KV/index-K 仍在缓存。bounded replay 对 full SWA 有近似，不是严格等价。';
      },
      render(l, t) {
        const rows = rowSet();
        $$('[data-yoco-kv]', kvWrap).forEach((cell, i) => {
          cell.classList.toggle('is-kv', t >= .18 + (i / N) * .2);
        });
        if (t >= .4) {
          $$('[data-yoco-q]', queryWrap).forEach((cell) => {
            const pos = Number(cell.dataset.yocoQ);
            cell.classList.toggle('is-cut', mode === 'compact' && !rows.includes(pos));
          });
        }
        const walk = mode !== 'off';
        const walkP = mode === 'compact' ? seg(t, .55, .84) : seg(t, .42, .8);
        const idx = Math.floor(walkP * rows.length);
        const current = rows[Math.min(rows.length - 1, Math.max(0, idx))];
        $$('[data-yoco-q]', queryWrap).forEach((cell) => {
          cell.classList.toggle('is-current', walk && t >= (mode === 'compact' ? .55 : .42) && t < (mode === 'compact' ? .87 : .84) && Number(cell.dataset.yocoQ) === current);
        });
        if (walk && t >= (mode === 'compact' ? .55 : .42) && t < (mode === 'compact' ? .88 : .85)) {
          head.style.opacity = '1';
          head.style.left = `${(current / N) * 100}%`;
        } else {
          head.style.opacity = mode === 'compact' && t >= .88 ? '1' : '0';
          if (mode === 'compact' && t >= .88) head.style.left = '100%';
        }
        $$('[data-yoco-bar]', barWrap).forEach((bar) => {
          const pos = Number(bar.dataset.yocoBar);
          bar.style.opacity = walk && pos === current && t < .88 ? '1' : (t >= .4 ? '1' : '.5');
        });
        const ring = Array.from({ length: W }, (_, i) => N - W + i);
        if (mode === 'compact') {
          $('[data-yoco-ring]', yocoRoot).textContent = t >= .88 ? `SWA ring 已填：${ring.join('、')}` : 'SWA ring 待重放：—';
        } else if (mode === 'mask') {
          $('[data-yoco-ring]', yocoRoot).textContent = t >= .88 ? 'SWA 可见域已应用：无需重放' : 'SWA 可见域待应用：—';
        } else {
          $('[data-yoco-ring]', yocoRoot).textContent = t >= .88 ? 'SWA 随 full 前向就绪：无需重放' : 'SWA 随 full 前向计算：—';
        }
        $('[data-yoco-q-count]', yocoRoot).textContent = String(rows.length);
        $('[data-yoco-start]', yocoRoot).textContent = String(keepStart());
      },
      reset() {
        head.style.opacity = '0';
        $$('[data-yoco-kv]', kvWrap).forEach((c) => c.classList.remove('is-kv'));
      }
    });

    $$('[data-yoco-mode]', yocoRoot).forEach((button) => {
      button.addEventListener('click', () => {
        mode = button.dataset.yocoMode;
        apply();
        lab.setEvents(eventsForMode());
        lab.retime();
      });
    });
    const keepInput = $('[data-yoco-keep]', yocoRoot);
    keepInput.addEventListener('input', () => {
      keep = Number(keepInput.value);
      if (keep < MIN_KEEP) keep = MIN_KEEP;
      apply();
      lab.retime();
    });
    // start from a clean static state; init() already applied classes
    $$('[data-yoco-kv]', kvWrap).forEach((c) => c.classList.remove('is-kv'));
    $('[data-yoco-q-count]', yocoRoot).textContent = String(keep);
  }

  /* ---------- MoE lab ---------- */
  const moeRoot = $('[data-lab="moe"]');
  if (moeRoot) {
    const PLAN = {
      A: [{ e: 0, w: .70 }, { e: 3, w: .30 }],
      B: [{ e: 1, w: .55 }, { e: 2, w: .45 }]
    };
    const EXPERT = {
      0: { rank: 0, slot: 'P0' }, 1: { rank: 0, slot: 'P1' },
      2: { rank: 1, slot: 'P2' }, 3: { rank: 1, slot: 'P3' }
    };
    let mega = false;
    const canvas = $('[data-canvas]', moeRoot);
    const flights = $('[data-flights]', moeRoot);
    const dispatchFlights = [];
    const combineFlights = [];
    const megaFlights = [];
    const sharedFlights = [];
    Object.entries(PLAN).forEach(([tok, picks]) => {
      picks.forEach(({ e, w }) => {
        dispatchFlights.push({ el: makeFlight(flights, `${tok}→E${e} · ${w.toFixed(2)}`), tok, e, w });
        combineFlights.push({ el: makeFlight(flights, `${w.toFixed(2)}·f${e}(${tok})`, 'mdl-flight--kv'), tok, e, w });
      });
      megaFlights.push({ el: makeFlight(flights, `${tok}→Mega 融合`, 'mdl-flight--reuse'), tok });
      sharedFlights.push({ el: makeFlight(flights, `+S(${tok}) · bias`, 'mdl-flight--shared'), tok });
    });

    const tokenEl = (tok) => $(`[data-moe-token="${tok}"]`, moeRoot);
    const expertEl = (e) => $(`[data-moe-expert="${e}"]`, moeRoot);
    const outEl = (tok) => $(`[data-moe-out="${tok}"]`, moeRoot);
    const sharedEl = $('.moe-shared', moeRoot);

    const gateHTML = (tok) => PLAN[tok].map(({ e, w }) => `<span class="mdl-chip">E${e} · ${w.toFixed(2)}</span>`).join('');
    $('[data-moe-gate="A"]', moeRoot).innerHTML = gateHTML('A');
    $('[data-moe-gate="B"]', moeRoot).innerHTML = gateHTML('B');

    const explicitEvents = [
      { at: 0, label: 'gate 选择' },
      { at: .2, label: 'dispatch' },
      { at: .44, label: 'expert 计算' },
      { at: .58, label: 'shared 分支就绪' },
      { at: .7, label: 'combine 汇合' },
      { at: .88, label: '原序输出' }
    ];
    const megaEvents = [
      { at: 0, label: 'gate 写 buffer' },
      { at: .22, label: '融合 dispatch' },
      { at: .46, label: 'grouped expert' },
      { at: .68, label: '融合 combine + shared' },
      { at: .88, label: '原序输出' }
    ];

    const lab = new Lab(moeRoot, {
      duration: 9000,
      stateEl: '[data-moe-state]',
      events: explicitEvents,
      stateFor(l, t) {
        if (mega) {
          if (t < .22) return 'Mega：gate 选 logical experts 和权重，结果写入 symmetric buffer；不再走单独的 dispatch/combine 调用。';
          if (t < .46) return 'dispatch 与 grouped expert 计算在同一条 Mega 融合路径中推进；shared 也在这条路径内处理。';
          if (t < .68) return '专家计算与 shared 汇合都进入融合 combine；shared 不是 combine 之后的独立后处理阶段。';
          if (t < .88) return '结果按 buffer 中的原 token 身份与顺序回到 A′/B′；语义不变，不重复计算同一组输出。';
          return '完成：Mega 是替代路径；shared 已在融合中汇合，没有额外的 shared 后处理。';
        }
        if (t < .2) return 'gate 给每个 token 选 routed logical experts 和权重；shared 不在这个 Top-k 计数里。';
        if (t < .44) return 'dispatch 把同一 token 的 hidden 拆送专家所在 rank，并携带原 token 身份与权重。';
        if (t < .58) return '专家在各自 EP rank 做 SwiGLU；EPLB 的 logical→physical map 已在 gate 之后解析。';
        if (t < .7) return 'shared_forward 先算好 shared_out 并保持就绪；它作为 combine 的 bias 输入，不是 combine 之后另起阶段。';
        if (t < .88) return 'combine 按 handle 把 routed 加权结果汇合，并同时加入已就绪的 shared_out；两路都完成后才写回 A′/B′。';
        return '完成：A′/B′ 保持原 token 身份与顺序；shared 已在 combine 中汇合。Mega 若开启会走融合替代路径，不重复计算。';
      },
      render(l, t) {
        canvas.classList.toggle('is-mega', mega);
        $('[data-moe-badge]', moeRoot).textContent = mega ? 'Mega 条件路径 · EP2' : '显式路径 · EP2';
        $('[data-moe-shared-note]', moeRoot).textContent = mega ? 'shared 已并入 Mega 融合路径 · 不单独后处理' : '每 token 共同路径 · 不计入 routed Top-k';
        $$('.moe-gate .mdl-chip', moeRoot).forEach((chip) => { chip.style.opacity = t > .06 ? '1' : '.25'; });
        const dispatchP = seg(t, .2, .44);
        const combineP = seg(t, .7, .84);
        const sharedP = seg(t, .55, .69);
        const gateDone = t >= .06;
        ['A', 'B'].forEach((tok) => {
          tokenEl(tok).classList.toggle('is-live', gateDone && t < .72);
          outEl(tok).classList.toggle('is-live', t >= .84);
        });
        Object.keys(EXPERT).forEach((key) => {
          const e = Number(key);
          const incoming = Object.values(PLAN).flat().filter((p) => p.e === e);
          const inP = incoming.reduce((m, p) => Math.max(m, seg(t, .22 + (p.w > .5 ? 0 : .04), .44)), 0);
          const el = expertEl(e);
          el.classList.toggle('is-in', !mega && inP > .85);
          el.classList.toggle('is-compute', !mega && t >= .44 && t < .7);
          el.classList.toggle('is-out', !mega && t >= .7);
        });
        dispatchFlights.forEach((f) => {
          const p = mega ? 0 : seg(t, .22 + (f.w > .5 ? 0 : .04), .44);
          placeFlight(f.el, canvas, tokenEl(f.tok), expertEl(f.e), p, .95);
        });
        combineFlights.forEach((f) => {
          const p = mega ? 0 : combineP;
          placeFlight(f.el, canvas, expertEl(f.e), outEl(f.tok), p, .95);
        });
        const megaBox = $('.moe-mega', moeRoot);
        megaFlights.forEach((f, i) => {
          const p = mega ? seg(t, .24 + i * .03, .82) : 0;
          if (mega) {
            const pts = [center(tokenEl(f.tok), canvas), center(megaBox, canvas), center(outEl(f.tok), canvas)].filter(Boolean);
            placePoly(f.el, canvas, pts, p, .95);
          } else {
            placeFlight(f.el, canvas, tokenEl(f.tok), outEl(f.tok), 0, .95);
          }
        });
        sharedFlights.forEach((f) => {
          const p = mega ? 0 : seg(t, .55 + (f.tok === 'B' ? .02 : 0), .69);
          placeFlight(f.el, canvas, sharedEl, outEl(f.tok), p, .95);
        });
        sharedEl.classList.toggle('is-live', !mega && t >= .55 && t < .74);
        $$('[data-moe-mega]', moeRoot).forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.moeMega === '1') === mega)));
      },
      reset() {
        [dispatchFlights, combineFlights, megaFlights, sharedFlights].forEach((list) => list.forEach((f) => { f.el.style.opacity = '0'; }));
      }
    });

    $$('[data-moe-mega]', moeRoot).forEach((button) => {
      button.addEventListener('click', () => {
        mega = button.dataset.moeMega === '1';
        lab.setEvents(mega ? megaEvents : explicitEvents);
        lab.retime();
      });
    });
  }
})();
