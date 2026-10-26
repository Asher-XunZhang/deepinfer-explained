/* DeepInfer 剖面 — sampling, DSpark, structured output, MFU.
   No dependencies. All timelines are deterministic and seekable. */
(() => {
  'use strict';

  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const smooth = (v) => { const t = clamp01(v); return t * t * (3 - 2 * t); };
  const mix = (a, b, t) => a + (b - a) * clamp01(t);
  const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;

  const MATH = {
    softmax(logits, temperature) {
      const t = Math.max(0.05, Number(temperature) || 1);
      const ex = logits.map((z) => Math.exp(z / t));
      const sum = ex.reduce((a, b) => a + b, 0);
      return ex.map((v) => v / sum);
    },
    topP(probs, threshold) {
      const order = probs.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v || a.i - b.i);
      const keep = [];
      let mass = 0;
      for (const item of order) {
        keep.push(item.i);
        mass += item.v;
        if (mass >= threshold - 1e-9) break;
      }
      const renorm = probs.map((v, i) => (keep.includes(i) ? v / mass : 0));
      return { keep, mass, renorm };
    },
    draw(probs, u) {
      let c = 0;
      for (let i = 0; i < probs.length; i += 1) {
        c += probs[i];
        if (u < c) return i;
      }
      return probs.length - 1;
    },
    allocate(confs, totalQ) {
      const extra = Math.max(0, totalQ - confs.length);
      const rows = [];
      confs.forEach((cs, s) => {
        let p = 1;
        cs.forEach((c, i) => {
          p *= Math.min(0.99, Math.max(0.1, c));
          rows.push({ s, i, value: p, rank: -1 });
        });
      });
      const sorted = [...rows].sort((a, b) => b.value - a.value || a.s - b.s || a.i - b.i);
      sorted.forEach((r, rank) => { r.rank = rank; });
      const wins = confs.map(() => 0);
      sorted.forEach((r) => { if (r.rank < extra) wins[r.s] += 1; });
      return { extra, rows, sorted, wins, seqlens: confs.map((_, s) => 1 + wins[s]) };
    },
    mfu(workTflops, seconds, cp, peak = 100) {
      if (!(seconds > 0) || !(cp > 0)) return 0;
      return workTflops / seconds / cp / peak;
    },
    tau(nextn, acceptance) { return 1 + nextn * acceptance; }
  };
  if (typeof window !== 'undefined') window.DeepInferOutputMath = Object.freeze(MATH);
  if (typeof document === 'undefined') return;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const setText = (node, value) => { if (node && node.textContent !== value) node.textContent = value; };
  const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  function mountTimeline(root, opts) {
    if (!root) return null;
    const play = $('[data-play]', root);
    const prev = $('[data-prev]', root);
    const next = $('[data-next]', root);
    const reset = $('[data-reset]', root);
    const scrub = $('[data-scrub]', root);
    const steps = $('[data-steps]', root);
    const count = $('[data-count]', root);
    const phaseLabel = $('[data-phase]', root);
    const time = $('[data-time]', root);
    const motionNote = $('[data-motion-note]', root);
    let reduced = reducedQuery.matches;
    let progress = reduced ? 1 : 0;
    let playing = false;
    let raf = 0;
    let lastTs = 0;
    let active = -1;
    let lastCount = '';

    const list = () => opts.phases();
    const indexAt = (p) => {
      const ps = list();
      for (let i = 0; i < ps.length; i += 1) if (p < ps[i].start - 1e-9) return Math.max(0, i - 1);
      return ps.length - 1;
    };
    const syncPlay = () => {
      if (!play) return;
      if (reduced) {
        play.disabled = true;
        setText(play, '静态总览');
        play.setAttribute('aria-pressed', 'false');
        return;
      }
      play.disabled = false;
      let label = '播放';
      if (playing) label = '暂停';
      else if (progress >= 0.999) label = '重播';
      else if (progress > 0.0001) label = '继续';
      setText(play, label);
      play.setAttribute('aria-pressed', String(playing));
    };
    const paint = () => {
      const ps = list();
      const idx = indexAt(progress);
      opts.render(progress, idx, ps);
      if (count) {
        const text = `${String(Math.round(progress * 100)).padStart(2, '0')}%`;
        if (text !== lastCount) { count.textContent = text; count.setAttribute('aria-label', `动画进度 ${text}`); lastCount = text; }
      }
      setText(phaseLabel, ps[idx].label);
      if (time) setText(time, `${(progress * opts.duration / 1000).toFixed(1)}s / ${(opts.duration / 1000).toFixed(1)}s`);
      if (scrub) {
        const v = String(Math.round(progress * 1000));
        if (scrub.value !== v) scrub.value = v;
        scrub.setAttribute('aria-valuetext', `${ps[idx].label}，${Math.round(progress * 100)}%`);
      }
      if (idx !== active) {
        active = idx;
        $$('[data-jump]', steps || root).forEach((btn, i) => {
          const on = i === idx;
          btn.classList.toggle('is-active', on);
          btn.setAttribute('aria-pressed', String(on));
        });
      }
      if (prev) prev.disabled = progress <= 0.0001;
      if (next) next.disabled = progress >= 0.9999;
      syncPlay();
    };
    const pause = () => {
      if (!playing) return;
      playing = false;
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0; lastTs = 0; syncPlay();
    };
    const seek = (value) => {
      if (playing) pause();
      progress = clamp01(value);
      paint();
    };
    const start = () => {
      if (reduced) return;
      if (progress >= 0.999) progress = 0;
      playing = true; lastTs = 0; paint();
      raf = window.requestAnimationFrame(tick);
    };
    const tick = (ts) => {
      if (!playing) return;
      if (!lastTs) lastTs = ts;
      const dt = Math.min(ts - lastTs, 80);
      lastTs = ts;
      progress += dt / opts.duration;
      if (progress >= 1) { progress = 1; playing = false; raf = 0; lastTs = 0; paint(); return; }
      paint();
      raf = window.requestAnimationFrame(tick);
    };
    const buildSteps = () => {
      if (!steps) return;
      steps.innerHTML = list().map((p) => `<button type="button" class="lab-step" data-jump="${p.start}" aria-pressed="false">${p.label}</button>`).join('');
      $$('[data-jump]', steps).forEach((btn) => btn.addEventListener('click', () => seek(Number(btn.dataset.jump))));
      active = -1;
    };
    const go = (dir) => {
      const ps = list();
      const idx = indexAt(progress);
      if (dir > 0) seek(idx >= ps.length - 1 ? 1 : ps[idx + 1].start);
      else if (progress > ps[idx].start + 0.0005) seek(ps[idx].start);
      else seek(idx <= 0 ? 0 : ps[idx - 1].start);
    };
    if (play) play.addEventListener('click', () => (playing ? pause() : start()));
    if (prev) prev.addEventListener('click', () => go(-1));
    if (next) next.addEventListener('click', () => go(1));
    if (reset) reset.addEventListener('click', () => seek(0));
    if (scrub) scrub.addEventListener('input', () => seek(Number(scrub.value) / 1000));
    document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
    const onReduced = () => {
      reduced = reducedQuery.matches;
      if (reduced) { pause(); progress = 1; }
      root.classList.toggle('is-reduced', reduced);
      if (motionNote) motionNote.hidden = !reduced;
      paint();
    };
    if (typeof reducedQuery.addEventListener === 'function') reducedQuery.addEventListener('change', onReduced);
    else if (typeof reducedQuery.addListener === 'function') reducedQuery.addListener(onReduced);
    buildSteps();
    if (reduced) {
      progress = 1;
      if (motionNote) motionNote.hidden = false;
      root.classList.add('is-reduced');
    }
    paint();
    return {
      paint,
      pause,
      reset: () => seek(0),
      refresh: () => { buildSteps(); paint(); },
      setProgress: (p) => { progress = clamp01(p); paint(); },
      get progress() { return progress; }
    };
  }

  /* ---------------- sampling ---------------- */
  function initSample() {
    const root = $('[data-lab="sample"]');
    if (!root) return;
    const Z = [2.4, 1.8, 0.7, -0.4, -1.2];
    const IDS = ['A', 'B', 'C', 'D', 'E'];
    const TOP_P = 0.9;
    const U = 0.93;
    let temperature = 1.0;
    let data = null;
    let tl = null;
    const cands = $$('[data-sx-token]', root).map((el) => ({
      el, bar: $('[data-sx-bar]', el), val: $('[data-sx-val]', el), tag: $('[data-sx-tag]', el)
    }));
    const segs = IDS.map((id) => ({
      el: $(`[data-sx-seg="${id}"]`, root),
      keep: $(`[data-sx-seg="${id}"] b`, root)
    }));
    const refs = {
      fill: $('[data-sx-fill]', root), stops: $$('[data-sx-stop]', root),
      proj: $('[data-sx-proj]', root), hiddenNote: $('[data-sx-hidden-note]', root),
      mode: $('[data-sx-mode]', root), foot: $('[data-sx-board-foot]', root),
      mass: $('[data-sx-mass]', root), keep: $('[data-sx-keep]', root),
      needle: $('[data-sx-needle]', root), final: $('[data-sx-final]', root), cdf: $('[data-sx-cdf]', root),
      pick: $('[data-sx-pick]', root), live: $('[data-live]', root),
      tempBtns: $$('[data-temp]', root)
    };
    const phases = () => [
      { label: 'hidden', start: 0 }, { label: 'logits', start: 0.14 },
      { label: 'z / T', start: 0.30 }, { label: 'softmax', start: 0.48 },
      { label: 'top-p', start: 0.62 }, { label: '抽一个', start: 0.78 },
      { label: 'token', start: 0.90 }
    ];
    function recalc() {
      const raw = MATH.softmax(Z, temperature);
      const top = MATH.topP(raw, TOP_P);
      data = { raw, top, rawPick: MATH.draw(raw, U), pick: MATH.draw(top.renorm, U) };
      refs.tempBtns.forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.temp) === temperature)));
    }
    function sampleNarrative(p) {
      if (p < 0.14) return '入口：只有采样位置上的 hidden states。候选还没有 logits，也没有概率。';
      if (p < 0.30) return 'logits：同一组候选得到实数分数。它们有正有负，但还不是概率，也不要求总和为 1。';
      if (p < 0.48) return `temperature=${temperature.toFixed(1)}：logit 被除以 T。T 越大分布越平，越小越尖锐；这只是缩放，不改变候选身份。`;
      if (p < 0.62) return `softmax：把 z/T 变成总和为 1 的候选概率。当前最高是 ${IDS[data.raw.indexOf(Math.max(...data.raw))]}，但它仍可能不被抽中。`;
      if (p < 0.78) return `top-p=0.90：按概率从高到低保留累计刚达到阈值的最小集合；保留 ${data.top.keep.length}/5，质量 ${(data.top.mass * 100).toFixed(1)}%。被排除候选归零后重新归一化，同一个 u 的落点可能改变。`;
      if (p < 0.90) return `抽一个：固定 u=0.93 在剩余区间上落点。mask 前若直接抽会落 ${IDS[data.rawPick]}；重归一化后落 ${IDS[data.pick]}。采样不是取最大概率。`;
      return `输出：${IDS[data.pick]} 作为这一采样位置的 token 交给后续流程。它不是一个字符串片段，也不是整段答案；随机源、seed 与 batch 条件另见“可复现条件”。`;
    }
    recalc();
    tl = mountTimeline(root, {
      duration: 9000,
      phases,
      render(p) {
        const logitT = smooth((p - 0.12) / 0.16);
        const tempT = smooth((p - 0.30) / 0.18);
        const softT = smooth((p - 0.48) / 0.14);
        const maskT = smooth((p - 0.62) / 0.16);
        const uT = smooth((p - 0.78) / 0.10);
        const emitT = smooth((p - 0.90) / 0.08);
        const adj = Z.map((z) => z / temperature);
        const rawH = Z.map((z) => 0.10 + 0.90 * (z - Math.min(...Z)) / (Math.max(...Z) - Math.min(...Z)));
        const adjH = adj.map((z) => 0.10 + 0.90 * (z - Math.min(...adj)) / (Math.max(...adj) - Math.min(...adj)));
        const maxP = Math.max(...data.raw);
        const widths = data.raw.map((v, i) => mix(v, data.top.renorm[i], maskT));
        refs.fill.style.width = `${p * 100}%`;
        refs.cdf.style.opacity = String(mix(0.12, 1, smooth((p - 0.44) / 0.10)));
        refs.proj.style.setProperty('--proj', smooth((p - 0.08) / 0.12).toFixed(3));
        refs.stops.forEach((s, i) => s.classList.toggle('is-active', i === Math.min(6, Math.floor(p * 7))));
        setText(refs.hiddenNote, p < 0.30 ? 'hidden → lm_head：采样位置上的向量被投影成候选分数。' : 'hidden 已投影；后面只改候选分数与概率，不再改 hidden。');
        setText(refs.mode, p < 0.30 ? 'logit z' : p < 0.48 ? 'z / T' : p < 0.62 ? 'p = softmax' : 'mask + 重归一');
        setText(refs.foot, p < 0.30 ? '同一张候选卡贯穿后续所有步骤；字母是教学占位，不是真实词表 token。' : p < 0.62 ? 'softmax 只改变数值表现，不改变候选身份；总和必须回到 1。' : '被 top-p 排除的候选不再占质量；保留候选概率放大，总和仍为 1。');
        cands.forEach((c, i) => {
          const blocked = !data.top.keep.includes(i);
          const h = mix(mix(mix(0, rawH[i], logitT), adjH[i], tempT), 0.06 + 0.94 * data.raw[i] / maxP, softT);
          const finalH = blocked ? 0.03 : 0.06 + 0.94 * data.top.renorm[i] / Math.max(...data.top.renorm);
          const hh = mix(h, finalH, maskT);
          c.bar.style.height = `${Math.max(2, hh * 100)}%`;
          const val = p < 0.15 ? '—' : p < 0.30 ? Z[i].toFixed(2) : p < 0.48 ? (Z[i] / temperature).toFixed(2) : p < 0.62 ? pct(data.raw[i]) : pct(mix(data.raw[i], data.top.renorm[i], maskT));
          setText(c.val, val);
          const tag = p < 0.30 ? 'logit' : p < 0.48 ? 'z/T' : p < 0.62 ? 'p' : blocked ? 'masked' : 'p′';
          setText(c.tag, tag);
          c.el.classList.toggle('is-blocked', blocked && maskT > 0.5);
          c.el.classList.toggle('is-picked', p >= 0.90 && i === data.pick);
        });
        segs.forEach((s, i) => {
          s.el.style.width = `${Math.max(0, widths[i]) * 100}%`;
          s.el.classList.toggle('is-masked', !data.top.keep.includes(i) && maskT > 0.5);
          s.el.classList.toggle('is-picked', p >= 0.78 && i === data.pick);
        });
        setText(refs.mass, p < 0.62 ? '质量 100%' : `保留质量 ${(data.top.mass * 100).toFixed(1)}% → 100%`);
        setText(refs.keep, p < 0.62 ? 'top-p 0.90 · 保留 —' : `top-p 0.90 · 保留 ${data.top.keep.length}/5`);
        const needleAt = U * uT;
        refs.needle.style.left = `${needleAt * 100}%`;
        refs.needle.style.opacity = uT > 0 ? '1' : '0';
        setText(refs.final, emitT > 0.2 ? IDS[data.pick] : '等待');
        refs.final.classList.toggle('is-filled', emitT > 0.2);
        refs.pick.style.opacity = emitT > 0.05 && emitT < 0.99 ? '1' : '0';
        refs.pick.textContent = IDS[data.pick];
        const start = widths.slice(0, data.pick).reduce((a, b) => a + b, 0);
        const center = start + widths[data.pick] / 2;
        refs.pick.style.left = `${mix(center * 100, 50, emitT)}%`;
        refs.pick.style.top = `${mix(46, 84, emitT)}%`;
        setText(refs.live, `${phases()[Math.min(6, Math.floor(p * 7))].label}｜${sampleNarrative(p)}`);
      }
    });
    refs.tempBtns.forEach((btn) => btn.addEventListener('click', () => {
      temperature = Number(btn.dataset.temp);
      tl.pause();
      recalc();
      tl.setProgress(reducedQuery.matches ? 1 : 0);
    }));
  }

  /* ---------------- DSpark ---------------- */
  function initDspark() {
    const root = $('[data-lab="dspark"]');
    if (!root) return;
    let branch = 'partial';
    let tl = null;
    const cards = ['A', 'B', 'C', 'D'].map((id) => ({
      id, el: $(`[data-ds-card="${id}"]`, root),
      status: $(`[data-ds-card="${id}"] [data-ds-status]`, root),
      stamp: $(`[data-ds-card="${id}"] [data-ds-stamp]`, root)
    }));
    const refs = {
      beam: $('[data-ds-beam]', root), residual: $('[data-ds-residual]', root),
      commit: $('[data-ds-commit]', root), live: $('[data-live]', root),
      branchBtns: $$('[data-branch]', root)
    };
    const phases = () => branch === 'all' ? [
      { label: '草稿', start: 0 }, { label: '进入目标', start: 0.20 },
      { label: '验证 A', start: 0.34 }, { label: '验证 B', start: 0.44 },
      { label: '验证 C', start: 0.54 }, { label: '补采', start: 0.66 },
      { label: '提交', start: 0.84 }
    ] : [
      { label: '草稿', start: 0 }, { label: '进入目标', start: 0.20 },
      { label: '验证 A', start: 0.34 }, { label: '验证 B', start: 0.44 },
      { label: '拒绝 C', start: 0.54 }, { label: 'residual → D', start: 0.66 },
      { label: '提交', start: 0.84 }
    ];
    const P = {
      draft: { A: [18, 18], B: [38, 18], C: [58, 18] },
      verify: { A: [28, 43], B: [48, 43], C: [68, 43] },
      out: { A: [12, 80], B: [30, 80], C: [48, 80], D: [64, 80] },
      reject: { C: [86, 58] },
      source: { D: [72, 43] }
    };
    const pos = (id, p) => {
      // D 不是草稿/验证卡：partial 时它在首拒绝位置由 residual 采样生成，
      // all 时它是在末尾正常补采的 token。两条分支都从 source 移到 out。
      if (id === 'D') {
        const start = 0.66;
        const o = P.out.D;
        if (p < start) return [P.source.D[0], P.source.D[1]];
        const r = smooth((p - start) / 0.16);
        return [mix(P.source.D[0], o[0], r), mix(P.source.D[1], o[1], r)];
      }
      let a = P.draft[id], b = P.verify[id], t = smooth((p - 0.18) / 0.12);
      let x = mix(a[0], b[0], t), y = mix(a[1], b[1], t);
      const acceptedAt = id === 'A' ? 0.36 : id === 'B' ? 0.46 : 0.58;
      if (p >= acceptedAt) {
        if (id === 'C' && branch === 'partial' && p < 0.66) {
          const r = smooth((p - acceptedAt) / 0.12);
          const rej = P.reject.C;
          x = mix(b[0], rej[0], r); y = mix(b[1], rej[1], r);
        } else if (id === 'C' && branch === 'partial') {
          x = P.reject.C[0]; y = P.reject.C[1];
        } else {
          const o = P.out[id];
          const r = smooth((p - acceptedAt) / 0.14);
          x = mix(b[0], o[0], r); y = mix(b[1], o[1], r);
        }
      }
      return [x, y];
    };
    const narrative = (p) => {
      if (p < 0.20) return '草稿模型提出 A/B/C。它们只是候选草稿，不是已提交 token，也没有被目标模型验证。';
      if (p < 0.34) return '同一组 A/B/C 卡被送入目标模型验证区；验证计算本身也要花目标模型的工作。';
      if (p < 0.44) return `A ${branch === 'partial' || branch === 'all' ? '通过验证' : '验证'}，进入连续接受前缀。✓ 只表示接受结果，不是字符串比较。`;
      if (p < 0.54) return 'B 通过验证，连续前缀扩展到 A/B。草稿 C 仍在目标验证区，尚未提交。';
      if (branch === 'partial') {
        if (p < 0.66) return 'C 在第一个拒绝位置失败。它不能进入输出，后面的草稿位置也全部作废；C 被移到拒绝区。';
        if (p < 0.84) return '目标模型在首拒绝位置用 residual 分布重新采样，生成新对象 D。D 不是把 C 改写，也不是字符串替换。';
        return '提交 A/B/D；C 留在拒绝区。草稿与验证的成本都已发生，不能把这一步直接当成加速。';
      }
      if (p < 0.66) return 'C 也通过验证，连续前缀达到 A/B/C；目标模型仍不能直接结束本轮。';
      if (p < 0.84) return '全接受后，目标模型在末尾补一个正常采样 token D。它不是 residual 替换，而是下一位置的正常输出。';
      return '提交 A/B/C/D。全接受少了一次首拒绝重采样，但仍付出目标模型补采与草稿验证的成本。';
    };
    tl = mountTimeline(root, {
      duration: 10000,
      phases,
      render(p) {
        const all = branch === 'all';
        cards.forEach((c) => {
          const [x, y] = pos(c.id, p);
          c.el.style.left = `${x}%`; c.el.style.top = `${y}%`;
          const accepted = c.id === 'A' ? p >= 0.36 : c.id === 'B' ? p >= 0.46 : c.id === 'C' ? p >= 0.58 : false;
          const rejected = c.id === 'C' && !all && p >= 0.58;
          c.el.classList.toggle('is-accepted', accepted && !rejected);
          c.el.classList.toggle('is-rejected', rejected);
          c.el.classList.toggle('is-new', c.id === 'D' && p >= 0.66);
          c.el.style.opacity = c.id === 'D' ? (p < 0.64 ? '0' : '1') : '1';
          let status = 'draft';
          if (c.id === 'D') status = p < 0.66 ? '新对象' : all ? '补采' : 'residual';
          else if (rejected) status = '首拒绝';
          else if (accepted) status = '接受';
          setText(c.status, status);
          let stamp = '';
          if (c.id === 'D' && p >= 0.84) stamp = '提交';
          else if (rejected) stamp = '×';
          else if (accepted) stamp = '✓';
          setText(c.stamp, stamp);
        });
        refs.beam.style.opacity = p >= 0.30 && p < 0.64 ? '1' : '0';
        const bx = p < 0.46 ? mix(28, 48, smooth((p - 0.30) / 0.16)) : mix(48, 68, smooth((p - 0.46) / 0.16));
        refs.beam.style.left = `${bx}%`;
        refs.residual.style.opacity = (!all && p >= 0.58 && p < 0.86) ? '1' : '0';
        const count = !all ? (p >= 0.84 ? 3 : p >= 0.46 ? 2 : p >= 0.36 ? 1 : 0) : (p >= 0.84 ? 4 : p >= 0.58 ? 3 : p >= 0.46 ? 2 : p >= 0.36 ? 1 : 0);
        // 0.84 之前只是验证中已接受的前缀，不能写成“已提交”；正式提交才计入 token。
        setText(refs.commit, p >= 0.84
          ? `R0 · 已提交 ${count} token`
          : count ? `R0 · 已接受 ${count} token · 未提交` : 'R0 · 尚未接受 · 未提交');
        setText(refs.live, `${phases()[Math.min(phases().length - 1, Math.floor(p * phases().length))].label}｜${narrative(p)}`);
      }
    });
    refs.branchBtns.forEach((btn) => btn.addEventListener('click', () => {
      branch = btn.dataset.branch;
      refs.branchBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.branch === branch)));
      tl.pause();
      tl.refresh();
      tl.setProgress(reducedQuery.matches ? 1 : 0);
    }));
    tl.paint();
  }

  /* ---------------- confidence budget ---------------- */
  function initBudget() {
    const root = $('[data-lab="budget"]');
    if (!root) return;
    const totalInput = $('[data-bd-totalq]', root);
    const confs = [[0.9, 0.8, 0.5], [0.6, 0.5, 0.5]];
    const defaults = [[0.9, 0.8, 0.5], [0.6, 0.5, 0.5]];
    const refs = {
      totalOut: $('[data-bd-totalq-out]', root), extra: $('[data-bd-extra]', root),
      count: $('[data-bd-count]', root), live: $('[data-bd-live]', root), why: $('[data-bd-why]', root)
    };
    function draw() {
      const total = Number(totalInput.value);
      const result = MATH.allocate(confs, total);
      setText(refs.totalOut, String(total));
      setText(refs.extra, String(result.extra));
      setText(refs.count, `${total} → [${result.seqlens.join(',')}]`);
      confs.forEach((cs, s) => {
        cs.forEach((v, i) => {
          const out = $(`[data-bd-conf-out="${s}-${i}"]`, root);
          setText(out, v.toFixed(2));
          const r = result.rows.find((x) => x.s === s && x.i === i);
          const chain = $(`[data-bd-chain="${s}"]`, root);
          chain.innerHTML = cs.map((_, j) => {
            const row = result.rows.find((x) => x.s === s && x.i === j);
            return `<span class="${result.sorted.slice(0, result.extra).includes(row) ? 'is-win' : ''}"><small>p${j + 1}</small><b>${row.value.toFixed(3)}</b><em>#${row.rank + 1}</em></span>`;
          }).join('');
        });
        setText($(`[data-bd-win="${s}"]`, root), String(result.wins[s]));
        setText($(`[data-bd-seqlen="${s}"]`, root), String(result.seqlens[s]));
        setText($(`[data-bd-result="${s}"]`, root), String(result.seqlens[s]));
        const card = $(`[data-bd-req="${s}"]`, root);
        card.classList.toggle('is-admitted', result.seqlens[s] > 1);
      });
      const rankWrap = $('[data-bd-ranks]', root);
      rankWrap.innerHTML = result.sorted.map((r, rank) => `<span class="bd-rank ${rank < result.extra ? 'is-win' : ''}"><b>R${r.s + 1}·p${r.i + 1}</b><span>${r.value.toFixed(3)}</span><em>#${rank + 1}</em></span>`).join('');
      const selected = result.sorted.slice(0, result.extra);
      const labels = selected.map((r) => `R${r.s + 1}·p${r.i + 1}=${r.value.toFixed(3)}`).join('、');
      setText($('[data-bd-selected-label]', root), result.extra ? `前 ${result.extra} 名入选额外预算` : '没有额外预算');
      setText(refs.why, result.extra
        ? `前 ${result.extra} 个前缀信号是 ${labels}；各请求按入选个数得到额外预算，所以是 [${result.seqlens.join(',')}]。`
        : `total_q=${total} 只够 ${confs.length} 个基础 query，没有额外预算，所以是 [${result.seqlens.join(',')}]。`);
      setText(refs.live, `total_q=${total}，2 个基础 query，额外预算 ${result.extra}；分配 [${result.seqlens.join(',')}]。`);
    }
    $$('[data-bd-conf]', root).forEach((input) => {
      input.addEventListener('input', () => {
        const [s, i] = input.dataset.bdConf.split('-').map(Number);
        confs[s][i] = Number(input.value);
        draw();
      });
    });
    totalInput.addEventListener('input', draw);
    $('[data-bd-reset]', root).addEventListener('click', () => {
      totalInput.value = '5';
      confs.forEach((cs, s) => cs.forEach((v, i) => {
        cs[i] = defaults[s][i];
        const input = $(`[data-bd-conf="${s}-${i}"]`, root);
        input.value = String(defaults[s][i]);
      }));
      draw();
    });
    draw();
  }

  /* ---------------- structured output ---------------- */
  function initSO() {
    const root = $('[data-lab="so"]');
    if (!root) return;
    const trigger = $('[data-so-trigger]', root);
    const cutoff = $('[data-so-cutoff]', root);
    const raw = [0.50, 0.30, 0.15, 0.05];
    const ids = ['true', 'hello', 'false', 'null'];
    const legal = ['true', 'false'];
    let tl = null;
    const cands = ids.map((id) => ({
      id, el: $(`[data-so-token="${id}"]`, root),
      p: $(`[data-so-token="${id}"] [data-so-p]`, root),
      bar: $(`[data-so-token="${id}"] [data-so-bar]`, root),
      mask: $(`[data-so-token="${id}"] [data-so-mask]`, root)
    }));
    const segs = ids.map((id) => $(`[data-so-seg="${id}"]`, root));
    const refs = {
      compileFill: $('[data-so-compile-fill]', root), grammar: $('[data-so-grammar]', root),
      gate: $('[data-so-gate]', root), scan: $('[data-so-scan]', root),
      needle: $('[data-so-needle]', root), keep: $('[data-so-keep]', root),
      state: $('[data-so-state]', root), stateNote: $('[data-so-state-note]', root),
      slot: $('[data-so-slot]', root), close: $('[data-so-close]', root),
      outNote: $('[data-so-out-note]', root), pick: $('[data-so-picked]', root),
      live: $('[data-live]', root), trigger, cutoff
    };
    const phases = () => [
      { label: '编译', start: 0 }, { label: '触发', start: 0.20 },
      { label: '合法 mask', start: 0.32 }, { label: '重归一 + 抽样', start: 0.50 },
      { label: '状态推进', start: 0.72 }, { label: '收尾', start: 0.84 }
    ];
    const narrative = (p) => {
      if (p < 0.20) return 'schema 交给编译器，在本地线程池里编译成 grammar；还没有应用任何 mask。';
      if (!trigger.checked) return 'trigger 尚未生效：不应用合法 mask。固定 u=0.70 在未约束候选上落 hello；这一步不保证合法 JSON。';
      if (p < 0.32) return 'grammar 编译完成，trigger 打开约束。下一步只允许 schema 当前状态接受的续写。';
      if (p < 0.50) return '扫描候选卡并应用 mask：hello / null 被置 0，true / false 保留；被排除候选不再占概率质量。';
      if (p < 0.72) return '合法候选重新归一化。固定 u=0.70 从 mask 前的 hello 改落 true；采样不是取字符串，也不是事后修补。';
      if (cutoff.checked) return '长度截止先于右花括号：输出停在 true，结构不完整；语法约束不能阻止外部停止条件。';
      if (p < 0.84) return 'true 已写入输出，自动机推进到期待右花括号的状态；下一步只允许 }。';
      if (!trigger.checked) return '约束未激活，输出停在 hello，不能保证 schema 语法；这不是“内容为真”的问题，而是结构没有被保证。';
      return '采样 } 后输出 { "ok": true }，语法完整。正常完成只保证结构，不保证字段内容的业务真实性。';
    };
    tl = mountTimeline(root, {
      duration: 10000,
      phases,
      render(p) {
        const compile = smooth((p - 0.04) / 0.16);
        const maskT = trigger.checked ? smooth((p - 0.32) / 0.18) : 0;
        const uT = smooth((p - 0.56) / 0.08);
        const transferT = smooth((p - 0.64) / 0.10);
        const advanceT = smooth((p - 0.72) / 0.10);
        const closeT = smooth((p - 0.82) / 0.08);
        const chosen = trigger.checked ? 'true' : 'hello';
        const blocked = ids.map((id) => trigger.checked && !legal.includes(id) && maskT > 0.35);
        const probs = raw.map((src, i) => {
          const target = trigger.checked && !legal.includes(ids[i]) ? 0 : trigger.checked ? src / 0.65 : src;
          return mix(src, target, maskT);
        });
        refs.compileFill.style.width = `${compile * 100}%`;
        setText(refs.grammar, p >= 0.20 ? 'strict JSON / boolean' : compile > 0.1 ? '编译中…' : '等待编译');
        setText(refs.gate, !trigger.checked ? '未触发 · 不应用 mask' : p < 0.32 ? '等待 trigger' : p < 0.50 ? '扫描候选 / 置 0' : '合法集合已应用');
        refs.scan.style.display = trigger.checked && p >= 0.30 && p < 0.52 ? 'block' : 'none';
        refs.scan.style.left = `${smooth((p - 0.32) / 0.18) * 100}%`;
        cands.forEach((c, i) => {
          const prob = probs[i];
          c.bar.style.height = `${Math.min(100, Math.max(2, prob * 200))}%`;
          setText(c.p, prob.toFixed(2));
          let mask = '—';
          if (trigger.checked && p >= 0.32) mask = legal.includes(c.id) ? '1' : '0';
          setText(c.mask, mask);
          c.el.classList.toggle('is-blocked', blocked[i]);
          c.el.classList.toggle('is-picked', p >= 0.56 && c.id === chosen);
        });
        segs.forEach((seg, i) => {
          seg.style.width = `${probs[i] * 100}%`;
          seg.classList.toggle('is-blocked', blocked[i]);
          seg.classList.toggle('is-picked', p >= 0.56 && ids[i] === chosen);
        });
        refs.needle.style.left = `${0.70 * uT * 100}%`;
        refs.needle.style.opacity = uT > 0 ? '1' : '0';
        setText(refs.keep, !trigger.checked ? '未约束 · 质量 100%' : '保留 true/false · 重归一 100%');
        let state = 'WAIT / 未编译';
        if (p >= 0.20) state = trigger.checked ? 'EXPECT_VALUE' : 'UNCONSTRAINED';
        if (trigger.checked && p >= 0.72) state = 'EXPECT_END';
        if (trigger.checked && cutoff.checked && p >= 0.72) state = 'CUTOFF';
        if (trigger.checked && !cutoff.checked && p >= 0.90) state = 'COMPLETE';
        setText(refs.state, state);
        setText(refs.stateNote, trigger.checked ? 'mask 由当前状态决定；采样后推进' : '没有 mask；语法不保证');
        setText(refs.slot, p >= 0.64 ? chosen : '?');
        const closed = trigger.checked && !cutoff.checked && closeT > 0;
        refs.close.hidden = !closed;
        refs.slot.classList.toggle('is-illegal', !trigger.checked && p >= 0.64);
        setText(refs.outNote, cutoff.checked ? (p >= 0.72 ? '长度截止：结构停在值之后' : '等待采样') : !trigger.checked ? (p >= 0.64 ? '约束未激活：不保证合法' : '尚未采样') : (closed ? '语法完整；内容不保证正确' : '等待收尾'));
        const showPick = p >= 0.64 && p < 0.84;
        refs.pick.hidden = !showPick;
        if (showPick) {
          refs.pick.textContent = chosen;
          const row = chosen === 'true' ? 0 : 1;
          refs.pick.style.left = `${mix(35, 82, transferT)}%`;
          refs.pick.style.top = `${mix(24 + row * 18, 76, transferT)}%`;
        }
        setText(refs.live, `${phases()[Math.min(5, Math.floor(p * 6))].label}｜${narrative(p)}`);
      }
    });
    [trigger, cutoff].forEach((input) => input.addEventListener('change', () => { tl.pause(); tl.setProgress(reducedQuery.matches ? 1 : 0); }));
    tl.paint();
  }

  /* ---------------- MFU calculator ---------------- */
  function initMFU() {
    const root = $('[data-lab="mfu"]');
    if (!root) return;
    const work = $('[data-pf-work]', root);
    const time = $('[data-pf-time]', root);
    const cpBtns = $$('[data-pf-cp]', root);
    let cp = 4;
    const refs = {
      workOut: $('[data-pf-work-out]', root), timeOut: $('[data-pf-time-out]', root),
      mfu: $('[data-pf-mfu]', root), count: $('[data-pf-count]', root),
      sub: $('[data-pf-sub]', root), num: $('[data-pf-num]', root),
      den: $('[data-pf-den]', root), mp: $('[data-pf-mp]', root),
      live: $('[data-pf-live]', root), note: $('[data-pf-window-note]', root),
      f0: $('[data-pf-f0]', root), f1: $('[data-pf-f1]', root), f2: $('[data-pf-f2]', root),
      dt: $('[data-pf-dt-label]', root)
    };
    function draw() {
      const w = Number(work.value), dt = Number(time.value);
      const scale = w / 200;
      const f0 = 10 * scale, f1 = 80 * scale, f2 = 120 * scale;
      const value = MATH.mfu(w, dt, cp, 100);
      refs.workOut.textContent = `${w.toFixed(0)}`;
      refs.timeOut.textContent = dt.toFixed(2);
      refs.mfu.textContent = pct(value, 2);
      refs.count.textContent = pct(value, 2);
      refs.sub.textContent = `${w.toFixed(0)} ÷ ${dt.toFixed(2)} ÷ ${cp} ÷ 100`;
      refs.num.textContent = `${w.toFixed(0)} TFLOPs`;
      refs.den.textContent = `${dt.toFixed(2)} s`;
      refs.mp.textContent = String(cp);
      refs.f0.textContent = `F₀=${f0.toFixed(1)}`;
      refs.f1.textContent = `F₁=${f1.toFixed(1)}`;
      refs.f2.textContent = `F₂=${f2.toFixed(1)}`;
      refs.dt.textContent = `Δt = ${dt.toFixed(2)} s`;
      refs.note.textContent = `首样本 F₀=${f0.toFixed(1)} 不计；分母 t₂ − t₀ = ${dt.toFixed(2)} s`;
      refs.live.textContent = `假设：${w.toFixed(0)} TFLOPs / ${dt.toFixed(2)} s / CP=${cp} / 100 TFLOP/s = ${pct(value, 2)}。`;
      cpBtns.forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.pfCp) === cp)));
    }
    work.addEventListener('input', draw);
    time.addEventListener('input', draw);
    cpBtns.forEach((b) => b.addEventListener('click', () => { cp = Number(b.dataset.pfCp); draw(); }));
    $('[data-pf-reset]', root).addEventListener('click', () => {
      work.value = '200'; time.value = '2.0'; cp = 4; draw();
    });
    draw();
  }

  /* ---------------- acceptance conversion ---------------- */
  function initTau() {
    const root = $('[data-lab="tau"]');
    if (!root) return;
    const acc = $('[data-tau-acc]', root);
    const nextnBtns = $$('[data-tau-nextn]', root);
    let nextn = 2;
    const refs = {
      accOut: $('[data-tau-acc-out]', root), result: $('[data-tau-result]', root),
      sub: $('[data-tau-sub]', root)
    };
    function draw() {
      const a = Number(acc.value) / 100;
      const tau = MATH.tau(nextn, a);
      refs.accOut.textContent = `${acc.value}%`;
      refs.result.textContent = tau.toFixed(2);
      refs.sub.textContent = `1 + ${nextn} × ${a.toFixed(2)} = ${tau.toFixed(2)}`;
      nextnBtns.forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.tauNextn) === nextn)));
    }
    acc.addEventListener('input', draw);
    nextnBtns.forEach((b) => b.addEventListener('click', () => { nextn = Number(b.dataset.tauNextn); draw(); }));
    draw();
  }

  initSample();
  initDspark();
  initBudget();
  initSO();
  initMFU();
  initTau();
})();
