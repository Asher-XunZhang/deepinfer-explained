/* DeepInfer 剖面 — production page: overlaid Block KV / SWA replay lab.
   One dependency-free control. The page remains complete without JS. */
(() => {
  'use strict';

  const root = document.querySelector('[data-rp]');
  if (!root) return;

  const DEFAULT_L = 2048;
  const DEFAULT_HIT = 1792;
  const GRAIN = 128;
  const MARGIN = 134;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const lButtons = Array.from(root.querySelectorAll('[data-rp-l]'));
  const slider = root.querySelector('[data-rp-hit]');
  const hitOut = root.querySelector('[data-rp-hit-out]');
  const maxOut = root.querySelector('[data-rp-max]');
  const maxNote = root.querySelector('[data-rp-max-note]');
  const currentOut = root.querySelector('[data-rp-current]');
  const currentNote = root.querySelector('[data-rp-current-note]');
  const plotLabel = root.querySelector('[data-rp-label]');
  const note = root.querySelector('[data-rp-note]');
  const live = root.querySelector('[data-rp-live]');
  const reset = root.querySelector('[data-rp-reset]');
  const empty = root.querySelector('[data-rp-empty]');

  const states = {};
  ['available', 'missing'].forEach((name) => {
    const box = root.querySelector(`[data-rp-state="${name}"]`);
    states[name] = {
      box,
      badge: box.querySelector('[data-rp-badge]'),
      summary: box.querySelector('[data-rp-summary]'),
      plot: box.querySelector('[data-rp-plot]'),
      reuse: box.querySelector('[data-rp-seg="reuse"]'),
      suffix: box.querySelector('[data-rp-seg="suffix"]'),
      swaBar: box.querySelector('[data-rp-swa-bar]'),
      swaFill: box.querySelector('[data-rp-swa-fill]'),
      swaZero: box.querySelector('[data-rp-swa-zero]'),
      swaKey: box.querySelector('[data-rp-swa-key]'),
      ranges: box.querySelector('[data-rp-ranges]'),
      accounting: box.querySelector('[data-rp-accounting]'),
      reuseNum: box.querySelector('[data-rp-num="reuse"]'),
      replayNum: box.querySelector('[data-rp-num="replay"]'),
      suffixNum: box.querySelector('[data-rp-num="suffix"]')
    };
  });

  let currentL = DEFAULT_L;
  let currentHit = DEFAULT_HIT;

  const fmt = (n) => new Intl.NumberFormat('zh-CN').format(n);
  const range = (from, to) => `[${fmt(from)}, ${fmt(to)})`;

  function maxAlignedFor(L) {
    return Math.max(0, Math.floor(Math.max(0, L - MARGIN) / GRAIN) * GRAIN);
  }

  function place(el, from, to, L) {
    if (!el) return;
    const start = Math.max(0, Math.min(L, from));
    const end = Math.max(start, Math.min(L, to));
    el.style.left = `${(start / L) * 100}%`;
    el.style.width = `${((end - start) / L) * 100}%`;
    el.hidden = end <= start;
  }

  function setStateClass(swaBar, mode) {
    swaBar.classList.remove('is-available', 'is-missing', 'is-empty');
    swaBar.classList.add(`is-${mode}`);
  }

  function renderAvailable(L, hit, suffix) {
    const state = states.available;
    place(state.reuse, 0, hit, L);
    place(state.suffix, hit, L, L);
    place(state.swaFill, 0, 0, L);
    setStateClass(state.swaBar, hit > 0 ? 'available' : 'empty');
    state.swaZero.hidden = false;
    state.swaZero.textContent = hit > 0
      ? '0 个需重建位置（第二轨为空）'
      : '空命中 · 0 个需重建位置';

    state.badge.textContent = hit > 0
      ? `L1 ${fmt(hit)} · 无需重建`
      : 'L1 0 · 空命中';
    state.summary.textContent = hit > 0
      ? `Block KV 复用 ${range(0, hit)}；匹配到可用 stored SWA，因此第二轨的重建位置为 0；新 suffix 为 ${range(hit, L)}，共 ${fmt(suffix)}。`
      : `Block KV 空命中：没有可复用的前缀；第二轨的重建位置也为 0，完整处理 ${fmt(L)} 个 prompt 位置。`;
    state.swaKey.textContent = hit > 0 ? '0（SWA 可用）' : '0（空命中）';
    state.ranges.textContent = hit > 0
      ? `复用 ${range(0, hit)} · SWA 重建 0（第二轨为空） · 新算 ${range(hit, L)}`
      : `空命中 · 不复用前缀 · 完整处理 ${range(0, L)}`;
    state.reuseNum.textContent = fmt(hit);
    state.replayNum.textContent = '0';
    state.suffixNum.textContent = fmt(suffix);
    state.accounting.textContent = `块账：复用 ${fmt(hit)} + 新 suffix ${fmt(suffix)} = L ${fmt(L)}；SWA 重建 0（第二轨为空），不另占 token。`;
    state.plot.setAttribute('aria-label', hit > 0
      ? `L=${fmt(L)}，L1=${fmt(hit)}。第一轨 Block KV 整段复用 ${range(0, hit)}，新 suffix ${range(hit, L)}；第二轨只画需重建的 SWA 位置，SWA 可用时为 0，不表示整段 SWA 已保存。`
      : `L=${fmt(L)}，Block KV 空命中。没有复用前缀，完整处理 ${fmt(L)} 个 prompt 位置；第二轨的 SWA 重建位置为 0。`);
  }

  function renderMissing(L, hit, replay, suffix) {
    const state = states.missing;
    const replayStart = hit - replay;

    place(state.reuse, 0, hit, L);
    place(state.suffix, hit, L, L);
    place(state.swaFill, replayStart, hit, L);
    setStateClass(state.swaBar, hit > 0 ? 'missing' : 'empty');
    state.swaZero.hidden = hit > 0;
    state.swaZero.textContent = '空命中 · 0 个需重建位置';

    state.badge.textContent = hit > 0
      ? `L1 ${fmt(hit)} · 重建 ${fmt(replay)}`
      : 'L1 0 · 空命中';
    state.summary.textContent = hit > 0
      ? `Block KV 仍复用整段 ${range(0, hit)}；第二轨只在命中区末尾 ${range(replayStart, hit)} 标出 ${fmt(replay)} 个 encoder SWA 重建位置；新 suffix 仍为 ${fmt(suffix)}。`
      : `Block KV 空命中：没有可重建的 SWA 子区；完整处理 ${fmt(L)} 个 prompt 位置。`;
    state.swaKey.textContent = hit > 0 ? `末尾 ${fmt(replay)}（SWA 缺失）` : '0（空命中）';
    state.ranges.textContent = hit > 0
      ? `复用 ${range(0, hit)} · SWA 重建 ${range(replayStart, hit)}（第二轨仅末尾） · 新算 ${range(hit, L)}`
      : `空命中 · 不复用前缀 · 完整处理 ${range(0, L)}`;
    state.reuseNum.textContent = fmt(hit);
    state.replayNum.textContent = fmt(replay);
    state.suffixNum.textContent = fmt(suffix);
    state.accounting.textContent = hit > 0
      ? `块账：复用 ${fmt(hit)} + 新 suffix ${fmt(suffix)} = L ${fmt(L)}；SWA 重建 ${fmt(replay)} 只在第二轨末尾，且已含在 Block KV 命中区内，不另加。`
      : `块账：复用 0 + 完整 prompt ${fmt(L)} = L ${fmt(L)}；第二轨为 0，不产生负位置。`;
    state.plot.setAttribute('aria-label', hit > 0
      ? `L=${fmt(L)}，L1=${fmt(hit)}。第一轨 Block KV 整段复用 ${range(0, hit)}，新 suffix ${range(hit, L)}；第二轨只在命中区末尾 ${range(replayStart, hit)} 标出 ${fmt(replay)} 个 SWA 重建位置，物理 SWA 窗口仅在尾部，不是整段。`
      : `L=${fmt(L)}，Block KV 空命中。没有复用前缀，完整处理 ${fmt(L)} 个 prompt 位置；第二轨的 SWA 重建位置为 0。`);
  }

  function render(L, hit) {
    currentL = L;
    const maxAligned = maxAlignedFor(L);
    const alignedHit = Math.max(0, Math.min(Math.round(hit / GRAIN) * GRAIN, maxAligned));
    const replay = alignedHit > 0 ? Math.min(GRAIN, alignedHit) : 0;
    const suffix = L - alignedHit;
    currentHit = alignedHit;

    slider.max = String(maxAligned);
    slider.value = String(alignedHit);
    slider.disabled = maxAligned === 0;
    slider.setAttribute('aria-valuetext', `${fmt(alignedHit)} 个 token；当前对齐上限 ${fmt(maxAligned)}`);
    hitOut.textContent = fmt(alignedHit);
    maxOut.textContent = fmt(maxAligned);
    maxNote.textContent = maxAligned > 0
      ? `L − 134 = ${fmt(L - MARGIN)}；向下对齐 → ${fmt(maxAligned)}`
      : `L − 134 < 0；命中上限按 0 处理`;
    currentOut.textContent = fmt(alignedHit);
    currentNote.textContent = alignedHit > 0
      ? `滑块可选 0–${fmt(maxAligned)}；空命中不执行子区重建`
      : '空命中；没有可复用的命中窗口';
    plotLabel.textContent = `当前 L=${fmt(L)} · L1=${fmt(alignedHit)}`;

    lButtons.forEach((button) => {
      const active = Number(button.dataset.rpL) === L;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });

    renderAvailable(L, alignedHit, suffix);
    renderMissing(L, alignedHit, replay, suffix);

    if (maxAligned === 0) {
      note.textContent = `L=${fmt(L)}，L − 134 < 0：命中上限按 0。空命中不生成 SWA 重建位置，也不产生负位置。`;
      note.classList.add('is-warn');
      live.textContent = `L=${fmt(L)}，Block KV 空命中：第二轨为 0，不生成 SWA 重建位置；完整处理 ${fmt(L)} 个 prompt 位置。`;
    } else if (alignedHit === 0) {
      note.textContent = `L − 134 = ${fmt(L - MARGIN)}；向下对齐上限 ${fmt(maxAligned)}。当前选择空命中：没有 Block KV 命中，第二轨为 0，完整处理 ${fmt(L)} 个 prompt 位置。`;
      note.classList.add('is-warn');
      live.textContent = `L=${fmt(L)}，Block KV 空命中：没有可复用的前缀，第二轨的 SWA 重建位置为 0；完整处理 ${fmt(L)} 个 prompt 位置。`;
    } else {
      const replayStart = alignedHit - replay;
      note.textContent = `L − 134 = ${fmt(L - MARGIN)}；向下对齐上限 ${fmt(maxAligned)}，当前 L1=${fmt(alignedHit)}。Block KV 复用 ${range(0, alignedHit)}，suffix ${range(alignedHit, L)}；第二轨只显示 SWA 重建位置，缺失时才在末尾 ${range(replayStart, alignedHit)} 标出 ${fmt(replay)}。`;
      note.classList.remove('is-warn');
      live.textContent = `L=${fmt(L)}，L1=${fmt(alignedHit)}。Block KV 复用整段 ${range(0, alignedHit)}；新 suffix 为 ${range(alignedHit, L)}，共 ${fmt(suffix)}。第二轨只画需重建位置：SWA 可用时为 0；缺失时只在末尾 ${range(replayStart, alignedHit)} 标 ${fmt(replay)}，物理窗口仅在尾部。`;
    }
  }

  lButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const nextL = Number(button.dataset.rpL);
      render(nextL, maxAlignedFor(nextL));
    });
  });

  slider.addEventListener('input', () => {
    render(currentL, Number(slider.value));
  });

  empty.addEventListener('click', () => {
    render(currentL, 0);
  });

  reset.addEventListener('click', () => {
    render(DEFAULT_L, DEFAULT_HIT);
  });

  if (reducedMotion.matches) {
    root.classList.add('rp-reduced-motion');
  }

  render(DEFAULT_L, DEFAULT_HIT);
})();
