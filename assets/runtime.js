/* DeepInfer 剖面 — runtime unit: paged KV, lifecycle, ZOS, graph. Dependency-free. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (value) => String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
  const fmt = (number) => String(number).padStart(2, '0');
  const text = (root, selector, value) => { const node = $(selector, root); if (node) node.textContent = value; };
  const setPressed = (buttons, activeButton) => buttons.forEach((button) => button.setAttribute('aria-pressed', String(button === activeButton)));
  const clamp01 = (value) => Math.min(1, Math.max(0, value));
  const ease = (value) => 1 - ((1 - value) * (1 - value));

  function mountMotion(root, spec) {
    const rail = $('[data-steps]', root);
    const count = $('[data-count]', root);
    const prev = $('[data-prev]', root);
    const next = $('[data-next]', root);
    const reset = $('[data-reset]', root);
    const play = $('[data-play]', root);
    const scrub = $('[data-scrub]', root);
    const phaseOut = $('[data-motion-phase]', root);
    const pctOut = $('[data-motion-pct]', root);
    const note = $('[data-motion-note]', root);
    const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const duration = spec.duration || 24000;
    let labels = spec.labels.slice();
    let progress = 0;
    let playing = false;
    let raf = 0;
    let lastTs = 0;
    let reduced = reducedQuery.matches;
    let activePhase = -1;

    function phaseAt(value) {
      for (let i = labels.length - 1; i >= 0; i -= 1) {
        if (value >= labels[i].start - 0.00001) return i;
      }
      return 0;
    }

    function setPlayLabel() {
      if (!play) return;
      if (reduced) {
        play.disabled = true;
        play.textContent = '静态总览';
        play.setAttribute('aria-pressed', 'false');
        return;
      }
      play.disabled = false;
      let label = '播放';
      if (playing) label = '暂停';
      else if (progress >= 0.999) label = '重播';
      else if (progress > 0.0001) label = '继续';
      play.textContent = label;
      play.setAttribute('aria-pressed', String(playing));
    }

    function buildRail() {
      if (!rail) return;
      rail.innerHTML = labels.map((label, i) =>
        `<button type="button" class="lab-step" data-jump="${label.start}" data-i="${i}" aria-pressed="false" aria-label="${esc(label.label)}，跳到该阶段开头">${esc(label.label)}</button>`
      ).join('');
      $$('[data-jump]', rail).forEach((button) => {
        button.addEventListener('click', () => seek(Number(button.dataset.jump)));
      });
      activePhase = -1;
    }

    function sync() {
      const phase = phaseAt(progress);
      if (count) count.textContent = `${fmt(phase + 1)} / ${fmt(labels.length)}`;
      if (phaseOut) phaseOut.textContent = labels[phase].label;
      if (pctOut) pctOut.textContent = `${Math.round(progress * 100)}%`;
      if (scrub && document.activeElement !== scrub) scrub.value = String(Math.round(progress * 1000));
      if (scrub) {
        const valueText = `${labels[phase].label}，${Math.round(progress * 100)}%`;
        if (scrub.getAttribute('aria-valuetext') !== valueText) scrub.setAttribute('aria-valuetext', valueText);
      }
      if (phase !== activePhase) {
        activePhase = phase;
        $$('[data-jump]', rail || document.createElement('div')).forEach((button, i) => {
          const on = i === phase;
          button.classList.toggle('is-active', on);
          button.setAttribute('aria-pressed', String(on));
        });
      }
      if (prev) prev.disabled = progress <= 0.0001;
      if (next) next.disabled = progress >= 0.9999;
      setPlayLabel();
    }

    function render() {
      spec.render(progress);
      sync();
    }

    function pause() {
      if (!playing) return;
      playing = false;
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
      lastTs = 0;
      setPlayLabel();
    }

    function tick(timestamp) {
      if (!playing) return;
      if (!lastTs) lastTs = timestamp;
      const delta = Math.min(timestamp - lastTs, 100);
      lastTs = timestamp;
      progress = Math.min(1, progress + (delta / duration));
      if (progress >= 1) {
        progress = 1;
        playing = false;
        raf = 0;
        lastTs = 0;
        render();
        return;
      }
      render();
      raf = window.requestAnimationFrame(tick);
    }

    function playNow() {
      if (reduced) return;
      if (progress >= 0.999) progress = 0;
      playing = true;
      lastTs = 0;
      setPlayLabel();
      render();
      raf = window.requestAnimationFrame(tick);
    }

    function seek(value) {
      if (playing) pause();
      progress = clamp01(Number(value) || 0);
      render();
    }

    function movePhase(direction) {
      const phase = phaseAt(progress);
      if (direction < 0) seek(phase <= 0 ? 0 : labels[phase - 1].start);
      else seek(phase >= labels.length - 1 ? 1 : labels[phase + 1].start);
    }

    function setLabels(nextLabels) {
      labels = nextLabels.slice();
      buildRail();
      render();
    }

    if (play) play.addEventListener('click', () => { if (playing) pause(); else playNow(); });
    if (prev) prev.addEventListener('click', () => movePhase(-1));
    if (next) next.addEventListener('click', () => movePhase(1));
    if (reset) reset.addEventListener('click', () => seek(0));
    if (scrub) scrub.addEventListener('input', () => seek(Number(scrub.value) / 1000));
    document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

    function syncReduced() {
      reduced = reducedQuery.matches;
      if (note) note.hidden = !reduced;
      if (reduced) {
        pause();
        progress = 0;
        if (play) play.disabled = true;
      }
      render();
    }
    if (typeof reducedQuery.addEventListener === 'function') reducedQuery.addEventListener('change', syncReduced);
    else if (typeof reducedQuery.addListener === 'function') reducedQuery.addListener(syncReduced);

    buildRail();
    if (note) note.hidden = !reduced;
    render();
    return {
      seek,
      pause,
      setLabels,
      refresh: render,
      getProgress: () => progress
    };
  }

  /* ------------------------------------------------------------
     M04 — logical token to physical block, plus separate state pool
     ------------------------------------------------------------ */
  const addrLab = $('[data-lab="addr"]');
  if (addrLab) {
    const blockSize = 4;
    const requests = {
      A: { tokens: 10, table: [7, 2, 9], state: 1 },
      B: { tokens: 8, table: [4, 8], state: 2 }
    };
    const pool = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const posInput = $('[data-addr-pos]', addrLab);
    let requestId = 'A';
    let position = 5;

    function ownerOf(block) {
      if (requests.A.table.includes(block)) return 'A';
      if (requests.B.table.includes(block)) return 'B';
      return '';
    }

    function renderAddr() {
      const request = requests[requestId];
      position = Math.max(0, Math.min(position, request.tokens - 1));
      const page = Math.floor(position / blockSize);
      const block = request.table[page];
      const offset = position % blockSize;
      const pageCount = Math.ceil(request.tokens / blockSize);
      const waste = (blockSize - (request.tokens % blockSize)) % blockSize;

      if (posInput) {
        posInput.max = String(request.tokens - 1);
        posInput.setAttribute('aria-valuemax', String(request.tokens - 1));
        posInput.value = String(position);
      }
      text(addrLab, '[data-addr-pos-out]', String(position));
      text(addrLab, '[data-addr-count]', `${requestId} · 位置 ${fmt(position)}`);
      text(addrLab, '[data-addr-page]', String(page));
      text(addrLab, '[data-addr-page-eq]', `⌊${position} / ${blockSize}⌋ = ${page}`);
      text(addrLab, '[data-addr-block]', block === undefined ? '—' : String(block));
      text(addrLab, '[data-addr-block-eq]', `block_table[${page}] = ${block === undefined ? '—' : block}`);
      text(addrLab, '[data-addr-offset]', String(offset));
      text(addrLab, '[data-addr-offset-eq]', `${position} % ${blockSize} = ${offset}`);
      text(addrLab, '[data-addr-pool-count]', `${request.table.length} 块属于 ${requestId}`);
      text(addrLab, '[data-addr-field="req"]', requestId);
      text(addrLab, '[data-addr-field="table"]', `[${request.table.join(', ')}]`);
      text(addrLab, '[data-addr-field="tokens"]', String(request.tokens));
      text(addrLab, '[data-addr-field="state"]', String(request.state));
      text(addrLab, '[data-addr-field="phys"]', block === undefined ? '未分配' : `block ${block} + offset ${offset}`);
      text(addrLab, '[data-addr-field="waste"]', `${waste} 个槽`);

      const pages = $('[data-addr-pages]', addrLab);
      if (pages) {
        pages.innerHTML = Array.from({ length: pageCount }, (_, pageIndex) => {
          const cells = Array.from({ length: blockSize }, (_, slot) => {
            const tokenPosition = pageIndex * blockSize + slot;
            const filled = tokenPosition < request.tokens;
            const current = tokenPosition === position;
            const label = filled ? `token 位置 ${tokenPosition}${current ? '，当前' : ''}` : '空槽';
            return `<span class="pos-cell${filled ? ' is-filled' : ''}${current ? ' is-current' : ''}" aria-label="${label}">${filled ? tokenPosition : '·'}</span>`;
          }).join('');
          return `<div class="logical-page" aria-label="逻辑页 ${pageIndex} 映射物理块 ${request.table[pageIndex]}"><span class="logical-page__no">L${pageIndex}</span><div class="logical-page__cells">${cells}</div><span class="logical-page__map">→ b${request.table[pageIndex]}</span></div>`;
        }).join('');
      }

      const poolNode = $('[data-addr-pool]', addrLab);
      if (poolNode) {
        poolNode.innerHTML = pool.map((id) => {
          const owner = ownerOf(id);
          const isCurrentOwner = owner === requestId;
          const role = id === 0 ? '保留' : owner || '空闲';
          const classes = ['phys-block'];
          if (id === 0) classes.push('is-reserved');
          if (owner === 'A') classes.push('is-a');
          if (owner === 'B') classes.push('is-b');
          if (isCurrentOwner) classes.push('is-hit');
          return `<div class="${classes.join(' ')}" title="物理块 ${id}：${role}"><b>${id}</b>${role}</div>`;
        }).join('');
      }

      const statesNode = $('[data-addr-states]', addrLab);
      if (statesNode) {
        statesNode.innerHTML = [0, 1, 2, 3].map((stateId) => {
          if (stateId === 0) return '<div class="state-slot is-free"><b>state 0</b>保留</div>';
          const owner = requests.A.state === stateId ? 'A' : requests.B.state === stateId ? 'B' : '';
          const current = owner === requestId;
          const classes = ['state-slot'];
          if (!owner) classes.push('is-free');
          if (current) classes.push('is-req');
          return `<div class="${classes.join(' ')}"><b>state ${stateId}</b>${owner ? `请求 ${owner}` : 'free'}</div>`;
        }).join('');
      }

      const live = `请求 ${requestId} 的 token 位置 ${position}：${position} / ${blockSize} 得逻辑页 ${page}，查 block_table[${page}] 得物理块 ${block}，页内偏移 ${offset}；state ${request.state} 在独立 state 池中（state 0 保留）。`;
      text(addrLab, '[data-addr-live]', live);

      const buttons = $$('[data-addr-req]', addrLab);
      setPressed(buttons, buttons.find((button) => button.dataset.addrReq === requestId));
      const prevPosition = $('[data-addr-prev]', addrLab);
      const nextPosition = $('[data-addr-next]', addrLab);
      if (prevPosition) prevPosition.disabled = position === 0;
      if (nextPosition) nextPosition.disabled = position === request.tokens - 1;
    }

    $$('[data-addr-req]', addrLab).forEach((button) => {
      button.addEventListener('click', () => {
        requestId = button.dataset.addrReq;
        position = Math.min(position, requests[requestId].tokens - 1);
        renderAddr();
      });
    });
    if (posInput) posInput.addEventListener('input', () => { position = Number(posInput.value); renderAddr(); });
    const prevPosition = $('[data-addr-prev]', addrLab);
    const nextPosition = $('[data-addr-next]', addrLab);
    const resetPosition = $('[data-addr-reset]', addrLab);
    if (prevPosition) prevPosition.addEventListener('click', () => { position -= 1; renderAddr(); });
    if (nextPosition) nextPosition.addEventListener('click', () => { position += 1; renderAddr(); });
    if (resetPosition) resetPosition.addEventListener('click', () => { requestId = 'A'; position = 5; renderAddr(); });

    renderAddr();
  }

  /* ------------------------------------------------------------
     M05 — terminal state, close-out, explicit refs, object pools
     ------------------------------------------------------------ */
  const lifeLab = $('[data-lab="life"]');
  if (lifeLab) {
    const forkToggle = $('[data-life-fork]', lifeLab);
    const refsNode = $('[data-life-refs]', lifeLab);
    const logNode = $('[data-life-log]', lifeLab);
    let fork = Boolean(forkToggle && forkToggle.checked);

    const LIFE_LABELS = [
      { label: '运行中', start: 0 },
      { label: '取消终态', start: 0.20 },
      { label: 'pre_sampler_sync', start: 0.38 },
      { label: '引用归零', start: 0.72 }
    ];

    function ownerChip(key, label, sub, extra = '') {
      return `<span class="owner ${extra}" data-life-owner="${key}" style="--out:0">${label}<small>${sub}</small></span>`;
    }

    function lifeRow(id, title, sub, chips, packets, badge) {
      return `<div class="res-row" data-life-row="${id}">
        <div class="res-row__label"><b>${title}</b><small>${sub}</small></div>
        <div class="res-row__track">${chips}<span class="free-bin" data-life-free="${id}">free</span>${packets}</div>
        <span class="ref-badge" data-life-ref="${id}">${badge}</span>
      </div>`;
    }

    function buildLifeRows() {
      if (!refsNode) return;
      refsNode.classList.add('res-list');
      refsNode.innerHTML = [
        lifeRow('b7', 'KV b7', '独占 · A', ownerChip('b7-A', 'A', 'owner'), '<span class="ref-packet" data-life-packet="b7">−1</span>', 'ref 1'),
        lifeRow('b2', 'KV b2', '独占 · A', ownerChip('b2-A', 'A', 'owner'), '<span class="ref-packet" data-life-packet="b2">−1</span>', 'ref 1'),
        lifeRow('b9', 'KV b9', '显式 fork 共享',
          ownerChip('b9-A', 'A', 'owner') + ownerChip('b9-P', 'A′', 'fork', 'owner--prime'),
          '<span class="ref-packet" data-life-packet="b9-A">−1</span><span class="ref-packet" data-life-packet="b9-P" style="left:34%">−1</span>', 'ref 2'),
        lifeRow('state', 'state 1', 'A + clone 源 pin',
          ownerChip('state-A', 'A', 'owner') + ownerChip('state-C', 'pin', 'clone', 'owner--clone'),
          '<span class="ref-packet" data-life-packet="state-C" style="left:34%">−1</span><span class="ref-packet" data-life-packet="state-A">−1</span>', 'ref 2'),
        `<div class="res-row res-row--pool" data-life-row="pool">
          <div class="res-row__label"><b>对象池</b><small>metadata / RequestOutput</small></div>
          <div class="res-row__track"><span class="pool-chip" data-life-pool="prev">上一 step</span><span class="pool-chip is-current" data-life-pool="current">本轮</span></div>
          <span class="ref-badge" data-life-ref="pool">prev→0</span>
        </div>`
      ].join('');
    }

    function buildLifeLog() {
      if (!logNode) return;
      logNode.innerHTML = [
        ['run', 'RUNNING', 'R0 生成中；abort 尚未发生。'],
        ['abort', 'ABORT', '只标 FINISHED_ABORTED，free_seq 尚未调用。'],
        ['release', 'PRE_SAMPLER', 'deferred_release.release()：对象池与 clone 源 pin 先收。'],
        ['free', 'FREE_SEQ', 'finalize 后才 free_seq；A 自己的引用归零。'],
        ['prime', 'A′', '另一条 Sequence 自己收尾，才归还 b9 的最后一份。'],
        ['collect', 'NEXT', '本轮 metadata/RequestOutput 下一轮才回对象池。']
      ].map(([key, tag, copy]) => `<div class="life-log__row" data-life-log="${key}"><b>${tag}</b><span>${copy}</span></div>`).join('');
    }

    function setOut(selector, value, root = refsNode) {
      const node = $(selector, root);
      if (node) node.style.setProperty('--out', clamp01(value).toFixed(3));
    }

    function renderLife(progress) {
      const p = progress;
      const abort = p >= 0.20;
      const poolRelease = p >= 0.40;
      const cloneSync = fork && p >= 0.46;
      const freeSeq = p >= 0.55;
      const primeRelease = fork && p >= 0.76;
      const collect = p >= 0.86;
      const outA = freeSeq ? ease(clamp01((p - 0.55) / 0.07)) : 0;
      const outP = primeRelease ? ease(clamp01((p - 0.76) / 0.07)) : 0;
      const outC = cloneSync ? ease(clamp01((p - 0.46) / 0.06)) : 0;
      const outPool = poolRelease ? ease(clamp01((p - 0.40) / 0.07)) : 0;

      setOut('[data-life-owner="b7-A"]', outA);
      setOut('[data-life-owner="b2-A"]', outA);
      setOut('[data-life-owner="b9-A"]', outA);
      setOut('[data-life-owner="b9-P"]', fork ? outP : 1);
      setOut('[data-life-owner="state-A"]', outA);
      setOut('[data-life-owner="state-C"]', fork ? outC : 1);
      setOut('[data-life-packet="b7"]', outA);
      setOut('[data-life-packet="b2"]', outA);
      setOut('[data-life-packet="b9-A"]', outA);
      setOut('[data-life-packet="b9-P"]', fork ? outP : 0);
      setOut('[data-life-packet="state-A"]', outA);
      setOut('[data-life-packet="state-C"]', fork ? outC : 0);
      setOut('[data-life-pool="prev"]', outPool);

      const b7 = freeSeq ? 0 : 1;
      const b2 = freeSeq ? 0 : 1;
      const b9 = fork ? (primeRelease ? 0 : freeSeq ? 1 : 2) : (freeSeq ? 0 : 1);
      const state = fork ? (freeSeq ? 0 : cloneSync ? 1 : 2) : (freeSeq ? 0 : 1);

      text(lifeLab, '[data-life-ref="b7"]', `ref ${b7}`);
      text(lifeLab, '[data-life-ref="b2"]', `ref ${b2}`);
      text(lifeLab, '[data-life-ref="b9"]', `ref ${b9}`);
      text(lifeLab, '[data-life-ref="state"]', `ref ${state}`);
      text(lifeLab, '[data-life-ref="pool"]', collect ? '本轮→下一轮' : 'prev→0');
      const freeB7 = $('[data-life-free="b7"]', lifeLab);
      const freeB2 = $('[data-life-free="b2"]', lifeLab);
      const freeB9 = $('[data-life-free="b9"]', lifeLab);
      const freeState = $('[data-life-free="state"]', lifeLab);
      if (freeB7) freeB7.classList.toggle('is-free', b7 === 0);
      if (freeB2) freeB2.classList.toggle('is-free', b2 === 0);
      if (freeB9) freeB9.classList.toggle('is-free', b9 === 0);
      if (freeState) freeState.classList.toggle('is-free', state === 0);
      const poolCurrent = $('[data-life-pool="current"]', lifeLab);
      if (poolCurrent) poolCurrent.classList.toggle('is-in', collect);

      const endGate = abort ? '已结束' : '仍未结束';
      const finishGate = freeSeq ? '已收尾' : abort ? '等待 pre_sampler_sync' : '未开始';
      const freeGate = freeSeq
        ? (fork && !primeRelease ? 'A 已归零；b9 待 A′' : '引用归零')
        : '引用未归零';
      text(lifeLab, '[data-life-gate="end"]', endGate);
      text(lifeLab, '[data-life-gate="finish"]', finishGate);
      text(lifeLab, '[data-life-gate="free"]', freeGate);
      const endLight = $('[data-life-light="end"]', lifeLab);
      const finishLight = $('[data-life-light="finish"]', lifeLab);
      const freeLight = $('[data-life-light="free"]', lifeLab);
      if (endLight) endLight.classList.toggle('is-on', abort);
      if (finishLight) {
        finishLight.classList.toggle('is-on', freeSeq);
        finishLight.classList.toggle('is-wait', abort && !freeSeq);
      }
      if (freeLight) freeLight.classList.toggle('is-on', freeSeq);

      const status = !abort ? 'RUNNING' : !freeSeq ? 'FINISHED_ABORTED · 等收尾' : 'FINISHED · A 已回池';
      text(lifeLab, '[data-life-status]', `Sequence · ${status}`);
      const badge = $('[data-life-badge]', lifeLab);
      if (badge) {
        badge.textContent = !abort ? '占用中' : !freeSeq ? '引用未清零' : 'A 已回池';
        badge.className = 'badge ' + (!abort ? 'badge--wait' : !freeSeq ? 'badge--signal' : 'badge--ok');
      }
      text(lifeLab, '[data-life-field="reason"]', abort ? 'FINISHED_ABORTED（教学）' : '—');
      text(lifeLab, '[data-life-field="free"]', freeSeq ? '已调用' : abort ? '等待 pre_sampler_sync' : '尚未调用');
      text(lifeLab, '[data-life-field="deferred"]', collect ? '本轮已收集 → 下一轮' : poolRelease ? '上一 step 已回池' : '待下一轮');
      text(lifeLab, '[data-life-field="clone"]', fork ? (cloneSync ? 'event 已同步；源已 unpin' : 'event 已记录，未同步') : '无（未 fork）');
      text(lifeLab, '[data-life-field="refs"]', `${b7} / ${b2} / ${b9}`);
      text(lifeLab, '[data-life-field="state"]', `ref ${state}`);

      let tag;
      let action;
      let src;
      if (p < 0.20) {
        tag = '01 · 运行中';
        action = fork
          ? 'A 正在生成；b7/b2 各 1 份引用。显式 fork 的 A′ 让 b9 与 state 1 暂时各多一份 pin。'
          : 'A 正在生成；普通独占资源 b7/b2/state 1 各 1 份引用。没有 fork，就没有第二份引用。';
        src = 'scheduler.hpp:1035–1051 · sequence.hpp:30–61';
      } else if (p < 0.38) {
        tag = '02 · 取消终态';
        action = 'abort 只把 R0 标成 FINISHED_ABORTED；free_seq 还没调用，引用账本不动。';
        src = 'scheduler.hpp:144–162';
      } else if (p < 0.46) {
        tag = '03 · pre_sampler_sync';
        action = '先 deferred_release.release()：上一 step 的 metadata/RequestOutput 回对象池；clone 源 pin 要等 clone event 同步后再 unpin。';
        src = 'llm_engine.py:830–846 · 67–116';
      } else if (p < 0.55) {
        tag = '03 · pre_sampler_sync';
        action = fork
          ? 'clone event 已同步，state 1 的源 pin 先 2→1；A 自己那份还没归还。'
          : '没有 fork/clone 源 pin；这里只回对象池，不改任何 block/state 引用。';
        src = 'llm_engine.py:889–905 · 100–116';
      } else if (p < 0.72) {
        tag = '03 · pre_sampler_sync';
        action = fork
          ? 'release 之后才 finalize/free_seq：A 的 b7/b2/state 1 引用归零，b9 从 2→1，剩下 A′ 那份。'
          : 'release 之后才 finalize/free_seq：b7、b2、state 1 的 1 份引用直接归零；没有第二次释放。';
        src = 'scheduler.hpp:738–749 · llm_engine.py:830–846';
      } else if (fork && p < 0.76) {
        tag = '04 · A 的引用归零';
        action = 'A 已回池，但 b9 还有 A′ 的 1 份引用；不能把共享历史块分给新请求。';
        src = 'block_manager.hpp:95–102 · scheduler.hpp:752–762';
      } else if (fork && p < 0.86) {
        tag = '04 · A′ 自己收尾';
        action = 'A′ 是另一条 Sequence，它自己的 free_seq 才把 b9 从 1→0；这不是 DeferredRelease 的第二次释放。';
        src = 'scheduler.hpp:738–749';
      } else {
        tag = '04 · 对象池的下一轮';
        action = '本轮 metadata/RequestOutput 被收集，下一轮 pre_sampler_sync 才回对象池；它们不影响 KV/state ref。';
        src = 'llm_engine.py:67–116 · 889–905';
      }
      text(lifeLab, '[data-life-phase]', tag);
      text(lifeLab, '[data-life-action]', action);
      text(lifeLab, '[data-life-src]', src);

      const callout = $('[data-life-callout]', lifeLab);
      if (callout) {
        if (!abort) callout.innerHTML = '<b>还没有结束。</b>abort 尚未发生；free_seq 没走到，引用也没有变化。';
        else if (!poolRelease) callout.innerHTML = '<b>只改终态。</b>请求已结束，但收尾回调还没开始；资源仍在池外。';
        else if (freeSeq) callout.innerHTML = '<b>先 release，后 free_seq。</b>clone 源 pin 与对象池先收；A 自己的引用归零后才能回池。';
        else callout.innerHTML = '<b>收尾回调进行中。</b>对象池/clone 先处理，finalize/free_seq 还没到；不要提前复用。';
      }

      const fill = $('[data-life-fill]', lifeLab);
      const actor = $('[data-life-actor]', lifeLab);
      const left = 8 + p * 82;
      if (fill) fill.style.width = `${left}%`;
      if (actor) actor.style.left = `${left}%`;

      const logOn = { run: true, abort, release: poolRelease, free: freeSeq, prime: primeRelease, collect };
      let lastOn = null;
      $$('[data-life-log]', lifeLab).forEach((row) => {
        const on = Boolean(logOn[row.dataset.lifeLog]);
        row.classList.toggle('is-in', on);
        if (on) lastOn = row;
      });
      $$('[data-life-log]', lifeLab).forEach((row) => row.classList.toggle('is-now', row === lastOn));

      let live;
      if (!abort) live = '运行中：abort 尚未发生；引用账本没有变化。';
      else if (!poolRelease) live = '取消已改终态；pre_sampler_sync 还没开始，free_seq 未调用。';
      else if (!freeSeq) live = 'pre_sampler_sync：先回对象池并同步 clone event；finalize/free_seq 还没到。';
      else if (fork && !primeRelease) live = 'A 的引用已归零；b9 仍由 A′ 持有，A′ 收尾前不能复用这个共享块。';
      else live = '引用已归零；对象池中的本轮 metadata/RequestOutput 下一轮才释放。';
      text(lifeLab, '[data-life-live]', live);
      text(lifeLab, '[data-life-tag]', !abort ? '运行中' : !freeSeq ? '已结束，未回池' : 'A 已回池');
    }

    buildLifeRows();
    buildLifeLog();
    let player;
    if (forkToggle) {
      forkToggle.addEventListener('change', () => {
        fork = forkToggle.checked;
        renderLife(player.getProgress());
      });
    }
    player = mountMotion(lifeLab, { labels: LIFE_LABELS, duration: 26000, render: renderLife });
  }

  /* ------------------------------------------------------------
     M06 — CPU/GPU ZOS process, remap, event dependency
     ------------------------------------------------------------ */
  const zosLab = $('[data-lab="zos"]');
  if (zosLab) {
    const zosToggle = $('[data-zos-on]', zosLab);
    const varlenToggle = $('[data-zos-varlen]', zosLab);
    const relay = $('[data-zos-relay]', zosLab);
    const timeline = $('[data-zos-timeline]', zosLab);
    const playhead = $('[data-zos-playhead]', zosLab);
    const remapPanel = $('[data-zos-remap]', zosLab);
    const remapRows = $('[data-zos-remap-rows]', zosLab);
    const remapNote = $('[data-zos-remap-note]', zosLab);
    const offNote = $('[data-zos-off-note]', zosLab);
    let zosOn = Boolean(zosToggle && zosToggle.checked);
    let varlen = Boolean(varlenToggle && varlenToggle.checked);
    let zosBars = [];
    let relayCoords = [];

    const ON_LABELS = [
      { label: '对账 / 下发修正', start: 0 },
      { label: 'forward / 同步 prev', start: 0.18 },
      { label: '后处理 prev', start: 0.38 },
      { label: '修正与采样', start: 0.50 },
      { label: '记录 / 下一轮', start: 0.74 }
    ];
    const OFF_LABELS = [
      { label: 'forward(current)', start: 0 },
      { label: 'sample(current)', start: 0.34 },
      { label: 'pre_sampler_sync', start: 0.56 },
      { label: '同步事件', start: 0.74 },
      { label: '当轮后处理', start: 0.92 }
    ];

    const ON_BARS = [
      { lane: 'cpu', id: 'remap', s: 0.02, e: 0.14, label: '建 remap', src: 'worker.py:209', tone: 'ok' },
      { lane: 'cpu', id: 'sync-prev', s: 0.20, e: 0.22, label: 'sync prev evt', src: 'worker.py:248', tone: 'ok' },
      { lane: 'cpu', id: 'post', s: 0.22, e: 0.50, label: '后处理 prev', src: 'worker.py:144', tone: 'ok' },
      { lane: 'cpu', id: 'd2h', s: 0.50, e: 0.56, label: 'sync D2H', src: 'worker.py:148', tone: 'hot', varlen: true },
      { lane: 'cpu', id: 'meta', s: 0.56, e: 0.64, label: '修 metadata', src: 'worker.py:150', tone: 'ok' },
      { lane: 'cpu', id: 'release', s: 0.66, e: 0.74, label: 'deferred release', src: 'llm_engine:830', tone: 'ok' },
      { lane: 'cpu', id: 'record', s: 0.74, e: 0.80, label: '记录 current', src: 'worker.py:168', tone: 'hot' },
      { lane: 'gpu', id: 'prev', s: 0.00, e: 0.12, label: 'prev sample', src: '上一 step', tone: 'dim' },
      { lane: 'gpu', id: 'correction', s: 0.12, e: 0.18, label: '修正 remap', src: 'worker.py:214', tone: 'ok' },
      { lane: 'gpu', id: 'forward', s: 0.18, e: 0.54, label: 'forward(current)', src: 'worker.py:120', tone: 'ok' },
      { lane: 'gpu', id: 'sample', s: 0.64, e: 0.82, label: 'sample(current)', src: 'worker.py:156', tone: 'ok' },
      { lane: 'gpu', id: 'event', s: 0.82, e: 0.94, label: 'current evt', src: 'record → 完成', tone: 'wait' },
      { lane: 'event', id: 'prev-evt', s: 0.00, e: 0.12, label: 'prev evt', src: '完成后才放行后继', tone: 'wait' },
      { lane: 'event', id: 'd2h-evt', s: 0.13, e: 0.18, label: 'd2h_evt', src: '仅 varlen', tone: 'hot', varlen: true },
      { lane: 'event', id: 'cur-evt', s: 0.74, e: 0.94, label: 'cur evt', src: 'record ≠ 完成', tone: 'hot' }
    ];
    const OFF_BARS = [
      { lane: 'cpu', id: 'release', s: 0.54, e: 0.62, label: 'deferred release', src: 'llm_engine:830', tone: 'ok' },
      { lane: 'cpu', id: 'record', s: 0.62, e: 0.68, label: '记录 event', src: 'worker.py:168', tone: 'hot' },
      { lane: 'cpu', id: 'sync', s: 0.74, e: 0.80, label: '同步 event', src: 'worker.py:248', tone: 'hot' },
      { lane: 'cpu', id: 'post', s: 0.80, e: 0.94, label: '后处理 current', src: 'worker.py:184', tone: 'ok' },
      { lane: 'cpu', id: 'clear', s: 0.94, e: 1.00, label: 'prev=None', src: 'worker.py:185', tone: 'ok' },
      { lane: 'gpu', id: 'forward', s: 0.02, e: 0.36, label: 'forward(current)', src: 'worker.py:120', tone: 'ok' },
      { lane: 'gpu', id: 'sample', s: 0.42, e: 0.62, label: 'sample(current)', src: 'worker.py:156', tone: 'ok' },
      { lane: 'gpu', id: 'event', s: 0.62, e: 0.80, label: 'current evt', src: 'record → 完成', tone: 'wait' },
      { lane: 'event', id: 'cur-evt', s: 0.62, e: 0.80, label: 'cur evt', src: 'record → 完成', tone: 'hot' }
    ];

    function buildZosTimeline() {
      const bars = zosOn ? ON_BARS : OFF_BARS;
      ['cpu', 'gpu', 'event'].forEach((lane) => {
        const node = $(`[data-zos-lane="${lane}"]`, zosLab);
        if (!node) return;
        node.innerHTML = bars.filter((bar) => bar.lane === lane).map((bar) =>
          `<div class="v-bar" data-bar="${bar.id}" data-tone="${bar.tone}" data-varlen="${bar.varlen ? '1' : '0'}" style="--s:${bar.s};--e:${bar.e}" title="${esc(bar.label)} · ${esc(bar.src)}"><span class="v-bar__fill"></span><span class="v-bar__text"><b>${esc(bar.label)}</b><small>${esc(bar.src)}</small></span></div>`
        ).join('');
      });
      zosBars = $$('.v-bar', timeline).map((node) => ({
        node,
        fill: $('.v-bar__fill', node),
        s: Number(node.style.getPropertyValue('--s')) || 0,
        e: Number(node.style.getPropertyValue('--e')) || 0,
        varlen: node.dataset.varlen === '1'
      }));
      if (playhead) playhead.hidden = false;
    }

    function measureRelay() {
      if (!relay) return;
      const base = relay.getBoundingClientRect();
      relayCoords = ['A', 'B', 'C'].map((name) => {
        const src = $(`[data-zos-src="${name}"]`, relay);
        const dst = $(`[data-zos-dst="${name}"]`, relay);
        const ghost = $(`[data-zos-ghost="${name}"]`, relay);
        if (!src || !dst || !ghost) return null;
        const s = src.getBoundingClientRect();
        const d = dst.getBoundingClientRect();
        const gw = ghost.offsetWidth || 27;
        const gh = ghost.offsetHeight || 27;
        return {
          ghost,
          sx: s.left - base.left + (s.width - gw) / 2,
          sy: s.top - base.top + (s.height - gh) / 2,
          dx: d.left - base.left + (d.width - gw) / 2,
          dy: d.top - base.top + (d.height - gh) / 2
        };
      }).filter(Boolean);
    }

    function eventState(progress) {
      const p = progress;
      if (!zosOn) {
        return {
          prev: '本路径无 prev event',
          current: p < 0.62 ? 'current.sample_end_evt · 未记录' : p < 0.80 ? 'current.sample_end_evt · 已记录，未完成' : 'current.sample_end_evt · 已完成，CPU 正在同步'
        };
      }
      return {
        prev: p < 0.12
          ? 'prev.sample_end_evt · GPU 尚未完成'
          : p < 0.22
            ? 'prev.sample_end_evt · 已完成，CPU 待同步'
            : 'prev.sample_end_evt · 已完成，CPU 已同步',
        current: p < 0.74 ? 'current.sample_end_evt · 未记录' : p < 0.94 ? 'current.sample_end_evt · 已记录，未完成' : 'current.sample_end_evt · 已完成（下一轮再同步）'
      };
    }

    function renderZos(progress) {
      const p = progress;
      const phases = zosOn ? ON_LABELS : OFF_LABELS;
      let phaseIndex = 0;
      for (let i = phases.length - 1; i >= 0; i -= 1) {
        if (p >= phases[i].start - 0.00001) { phaseIndex = i; break; }
      }
      if (relay) {
        relay.classList.toggle('is-off', !zosOn);
        relay.hidden = !zosOn;
      }
      if (offNote) offNote.hidden = zosOn;
      if (remapPanel) remapPanel.classList.toggle('is-off', !zosOn);
      if (remapRows) remapRows.hidden = !zosOn;
      if (remapNote) remapNote.hidden = zosOn;
      if (varlenToggle) varlenToggle.disabled = !zosOn;

      const moveT = ease(clamp01((p - 0.02) / 0.14));
      relayCoords.forEach((coord) => {
        if (!zosOn) {
          coord.ghost.style.opacity = '0';
          return;
        }
        coord.ghost.style.opacity = '1';
        const x = coord.sx + (coord.dx - coord.sx) * moveT;
        const y = coord.sy + (coord.dy - coord.sy) * moveT;
        coord.ghost.style.transform = `translate(${x}px, ${y}px)`;
      });

      if (playhead) playhead.style.top = `${p * 100}%`;
      zosBars.forEach((bar) => {
        const active = p >= bar.s && p < bar.e;
        const done = p >= bar.e;
        bar.node.hidden = bar.varlen && !varlen;
        bar.node.classList.toggle('is-active', active);
        bar.node.classList.toggle('is-done', done);
        const local = clamp01((p - bar.s) / Math.max(0.001, bar.e - bar.s));
        if (bar.fill) bar.fill.style.height = `${done ? 100 : active ? local * 100 : 0}%`;
      });

      const events = eventState(p);
      const prevChip = $('[data-zos-event="prev"]', zosLab);
      const currentChip = $('[data-zos-event="current"]', zosLab);
      if (prevChip) {
        prevChip.textContent = events.prev;
        prevChip.className = 'evt-chip ' + (!zosOn ? '' : p < 0.12 ? 'is-wait' : 'is-done');
      }
      if (currentChip) {
        currentChip.textContent = events.current;
        currentChip.className = 'evt-chip ' + (p < (zosOn ? 0.74 : 0.62) ? '' : p < (zosOn ? 0.94 : 0.80) ? 'is-wait' : 'is-done');
      }

      const field = (name, value) => text(zosLab, `[data-zos-field="${name}"]`, value);
      field('prev', zosOn ? '已保存（上一 step）' : 'None（当轮清空）');
      field('fresh', zosOn ? 'C ← CPU 新输入' : '不适用（无跨轮 remap）');
      field('match', zosOn ? 'B←1 / A←0' : '不适用（prev=None）');
      field('event', zosOn
        ? (p < 0.12 ? 'prev evt（GPU 未完成）' : p < 0.22 ? 'prev evt 完成 · CPU 待同步' : p < 0.74 ? 'prev 完成 · current 未记录' : p < 0.94 ? 'current evt（记录≠完成）' : 'current evt 已完成')
        : (p < 0.62 ? 'current evt（未记录）' : p < 0.80 ? 'current evt（记录≠完成）' : 'current evt（已同步）'));
      field('d2h', zosOn ? (varlen ? 'seqlens_q → CPU（仅 varlen）' : 'None（varlen 关闭）') : '不适用（无 prev）');
      field('ledger', zosOn ? '滞后一轮' : '当轮收口');

      let action;
      let src;
      let desc;
      let callout;
      if (zosOn) {
        if (p < 0.18) {
          action = '先按 seq_id 构造 remap：B←上一轮 slot 1、C←fresh、A←上一轮 slot 0；H2D/修正排进 current stream。prev sample 可能还在 GPU 上，correction/forward 只能排在它之后。';
          src = '_correct_seqlens_qk · worker.py:209–216';
          desc = 'CPU 建 remap 只比较 seq_id；GPU 后继要等同一 stream 上的 prev sample 及其 event。';
          callout = '<b>先修正，后 forward。</b>current forward 读取的 remap 必须先准备好；correction/forward 也不能越过更早的 prev sample event。';
        } else if (p < 0.38) {
          action = 'GPU correction 已执行、current forward 正在跑；这本身就说明同一 stream 上更早的 prev.sample_end_evt 已完成。CPU 提交完 forward 后调用 _post_process_step(prev) 的 synchronize，事件已完成时立即返回。';
          src = 'worker.py:113–123 · 143–145 · 248–271';
          desc = '设备 event 完成 ≠ CPU 已同步：GPU 可以已越过 event，CPU 仍要调用 synchronize。';
          callout = '<b>不要同时画“prev event 未完成”和“依赖它的 forward 已执行”。</b>同一 stream 上后继执行以 event 完成为前提；CPU 是否已同步是另一件事。';
        } else if (p < 0.50) {
          action = 'prev.sample_end_evt 已完成，CPU 正在后处理 prev；GPU current forward 继续执行。这里重叠的是 CPU post-process 与 GPU forward，不是 CPU 跳过事件同步。';
          src = 'worker.py:143–145 · 248–271';
          desc = 'CPU 同步后才能读 prev 输出；设备完成后，GPU 后继 forward 才可能执行。';
          callout = '<b>事件依赖仍在。</b>_post_process_step 读 prev_step_state 前必须 synchronize；但 event 完成可以早于 CPU 的 synchronize 调用。';
        } else if (p < 0.64) {
          action = varlen
            ? 'd2h_evt 已记录；CPU 的 synchronize 返回后，update_metadata_for_sampling_zos 才执行。metadata 完成前不会 execute_sample，所以此刻 GPU sample 还没有下发。'
            : 'varlen 关闭：没有 d2h_evt/同步；CPU 仍先 update_metadata_for_sampling_zos，完成前不会 execute_sample。此刻 GPU sample 还没有下发。';
          src = 'worker.py:146–164';
          desc = varlen ? '同步 D2H → 修 CPU metadata；sample 在这两步之后。' : '无 D2H，但 metadata 完成 → sample 下发的顺序仍在。';
          callout = varlen
            ? '<b>D2H 返回是 metadata 的前置，metadata 完成是 sample 下发的前置。</b>三步不能画成同时穿越。'
            : '<b>不要因为 D2H 消失就让 metadata 与 sample 同起。</b>metadata 仍要先完成。';
        } else if (p < 0.74) {
          action = varlen
            ? 'metadata 更新已完成，CPU 随后 execute_sample，GPU sample 才开始执行；CPU 的 pre_sampler_sync 可以与已经下发的 sample 重叠。'
            : 'metadata 更新已完成，CPU 随后 execute_sample，GPU sample 才开始执行；没有 D2H，但 metadata→sample 的顺序不变。CPU pre_sampler_sync 可与已下发 sample 重叠。';
          src = 'worker.py:150–168 · llm_engine.py:830–846';
          desc = 'sample 已下发；CPU 收口回调与 GPU sample 重叠，对象池先释放，随后记录事件。';
          callout = '<b>先 metadata，后 sample。</b>pre_sampler_sync 只能和已经下发的 GPU sample 重叠，不能提前到 metadata 之前。';
        } else if (p < 0.94) {
          action = 'current.sample_end_evt.record() 只表示事件已排进 stream；CPU 还没有取得当前结果。下一轮 CPU 可以先按 seq_id 构造 remap（不读采样 token），把依赖上一轮输出的修正/forward 按 stream 顺序排好，再在 _post_process_step(prev) 同步 event。';
          src = 'worker.py:168 · 182–189 · 209–216';
          desc = '记录给下一轮；CPU 建 remap 不读 GPU token，事件同步留给 post_process(prev)。';
          callout = '<b>记录不等于完成，但 remap 也不等采样完成。</b>CPU 先建映射/提交依赖，读 prev 结果前仍要 synchronize；GPU 读上一轮输出由 stream 排序。';
        } else {
          action = 'current.sample_end_evt 已完成。下一轮 CPU 仍先按 seq_id 构造 remap（prepare_zos_inputs 只比较 seq_id），把依赖上一轮输出的修正/forward 排进同一 stream；随后才在 _post_process_step(prev) 同步这个 event 并做 CPU 后处理。';
          src = 'worker.py:182–189 · 209–216 · 248–271';
          desc = 'CPU 建映射早于同步；GPU 消费上一轮输出仍受 stream 顺序保护。';
          callout = '<b>CPU 构造 remap ≠ 等待采样结果。</b>“下一轮先等 event 再 remap”会颠倒顺序；事件仍要同步，但同步发生在后处理前，不是 remap 前。';
        }
      } else if (p < 0.34) {
        action = '关闭 ZOS：prev_step_state=None，CPU 不构造跨轮 remap；current forward 直接下发，旧 GPU 行不再被使用。';
        src = 'worker.py:113–127 · 191–200';
        desc = '稳定 non-ZOS 先把 current forward 下发；没有跨步输入。';
        callout = '<b>没有上一轮 GPU 行。</b>这里不是把 ZOS 图删掉几行，而是走另一条稳定路径。';
      } else if (p < 0.56) {
        action = 'sample(current) 在 forward 后执行；没有 prev 需要等待，也没有旧 matched rows 可接。';
        src = 'worker.py:156–168';
        desc = 'forward 与 sample 都在当前轮。';
        callout = '<b>不要复用 ZOS 的 remap 结论。</b>seq_id 仍是身份，但本路径没有跨轮 remap。';
      } else if (p < 0.74) {
        action = 'pre_sampler_sync 先释放上一 step 留在对象池的 metadata/输出；随后 sample_end_evt.record() 记录当前事件，仍然只是 record。';
        src = 'worker.py:162–168 · llm_engine.py:830';
        desc = '对象池释放与事件记录都在当前轮。';
        callout = '<b>先释放对象池，再记录事件。</b>对象池释放不改 block/state ref。';
      } else if (p < 0.92) {
        action = 'CPU 同步 current.sample_end_evt，然后才对 current 结果 post_process；不是先 post_process 再 sample。';
        src = 'worker.py:182–189 · 248–271';
        desc = '当前事件完成，CPU 才能读当前结果。';
        callout = '<b>顺序固定：</b>forward → sample → pre_sampler_sync → record → synchronize → post_process(current)。';
      } else {
        action = '当轮收口完成，prev_step_state 保持 None；下一轮不会再次等待这一轮的 prev sample event。seq_id 仍是请求身份，但跨轮 remap 不执行。';
        src = 'worker.py:182–189';
        desc = '当轮后处理结束；下一轮重新从当前状态开始。';
        callout = '<b>没有“下一轮再等同一 prev event”。</b>这是 non-ZOS 与 ZOS 的关键差别。';
      }
      text(zosLab, '[data-zos-action]', action);
      text(zosLab, '[data-zos-src]', src);
      text(zosLab, '[data-zos-desc]', desc);
      const calloutNode = $('[data-zos-callout]', zosLab);
      if (calloutNode) calloutNode.innerHTML = callout;
      text(zosLab, '[data-zos-mode]', zosOn ? 'ZOS decode · overlap' : 'non-ZOS · current step');
      text(zosLab, '[data-zos-live]', `第 ${phaseIndex + 1} 步（${Math.round(p * 100)}%）：${action}`);
    }

    buildZosTimeline();
    const player = mountMotion(zosLab, { labels: zosOn ? ON_LABELS : OFF_LABELS, duration: 30000, render: renderZos });
    window.requestAnimationFrame(measureRelay);
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => { measureRelay(); renderZos(player.getProgress()); }, 120);
    });
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => measureRelay());
      observer.observe(zosLab);
    }
    if (zosToggle) {
      zosToggle.addEventListener('change', () => {
        zosOn = zosToggle.checked;
        player.pause();
        buildZosTimeline();
        player.setLabels(zosOn ? ON_LABELS : OFF_LABELS);
        player.seek(0);
        window.requestAnimationFrame(measureRelay);
      });
    }
    if (varlenToggle) {
      varlenToggle.addEventListener('change', () => {
        varlen = varlenToggle.checked;
        player.pause();
        renderZos(player.getProgress());
      });
    }
  }

  /* ------------------------------------------------------------
     M07 — graph bucket by total query rows, not request count
     ------------------------------------------------------------ */
  const graphLab = $('[data-lab="graph"]');
  if (graphLab) {
    const buckets = [1, 2, 4, 8];
    const inputA = $('[data-graph-a]', graphLab);
    const inputB = $('[data-graph-b]', graphLab);
    let qA = 2;
    let qB = 3;

    function pickBucket(total) {
      return buckets.find((bucket) => bucket >= total);
    }

    function renderGraph() {
      const total = qA + qB;
      const size = pickBucket(total);
      const overflow = size === undefined;
      const pad = overflow ? 0 : size - total;
      if (inputA) inputA.value = String(qA);
      if (inputB) inputB.value = String(qB);
      text(graphLab, '[data-graph-a-out]', String(qA));
      text(graphLab, '[data-graph-b-out]', String(qB));
      text(graphLab, '[data-graph-count]', `A=${qA} · B=${qB}`);
      text(graphLab, '[data-graph-req]', '2');
      text(graphLab, '[data-graph-real]', String(total));
      text(graphLab, '[data-graph-size]', overflow ? '—' : String(size));
      text(graphLab, '[data-graph-pad]', overflow ? '—' : String(pad));
      text(graphLab, '[data-graph-slot-head]', overflow ? '无可用图档' : `${size} 行 · ${pad} 行 padding`);

      const slots = $('[data-graph-slots]', graphLab);
      if (slots) {
        if (overflow) {
          slots.innerHTML = '<p class="graph-note" style="grid-column:1/-1;margin:0">真实 q 行已超过教学最大档 8；这里不画虚构的第 9 行档位。</p>';
        } else {
          const realRows = [];
          for (let i = 1; i <= qA; i += 1) realRows.push({ label: `A${i}`, cls: 'is-a' });
          for (let i = 1; i <= qB; i += 1) realRows.push({ label: `B${i}`, cls: 'is-b' });
          slots.innerHTML = Array.from({ length: size }, (_, i) => {
            const row = realRows[i];
            if (row) return `<div class="q-slot ${row.cls}" title="真实 query 行 ${row.label}"><b>${row.label}</b>real</div>`;
            return `<div class="q-slot is-pad" title="placeholder 行"><b>P${i - realRows.length + 1}</b>pad</div>`;
          }).join('');
        }
      }

      $$('[data-tier]', graphLab).forEach((tier) => {
        const value = Number(tier.dataset.tier);
        const picked = !overflow && value === size;
        tier.classList.toggle('is-picked', picked);
        tier.classList.toggle('is-error', overflow && value === 8);
      });

      const error = $('[data-graph-error]', graphLab);
      if (error) {
        error.hidden = !overflow;
        error.textContent = overflow ? `total_q=${total} 超过最大档 8。select 会报错；不能把本教学图档当成可覆盖任意长度。` : '';
      }
      text(graphLab, '[data-graph-formula]', overflow
        ? `bisect_left([1,2,4,8], ${total}) 找不到足够档；select 报错。`
        : `bisect_left([1,2,4,8], ${total}) 选到 ${size}；不是按 2 个请求选档。`);
      text(graphLab, '[data-graph-note]', overflow
        ? '真实请求数仍是 2，但本教学图档覆盖不了 8 行以上。不能补一个不存在的档位来“跑通”。'
        : pad > 0
          ? `真实请求数仍是 2；sampler 使用另存的 num_reqs。图档 ${size} 只说明本轮执行 ${size} 行，其中 ${pad} 行是 placeholder。`
          : `本轮真实行刚好填满图档；请求数仍是 2，不能用它反推 graph_size。`);
      text(graphLab, '[data-graph-live]', overflow
        ? `A=${qA}、B=${qB}：total_q=${total}，超过教学最大档 8；本图不补第 9 行档位。`
        : `A=${qA}、B=${qB}：total_q=${total}，选不小于它的最小档 ${size}，补 ${pad} 行 placeholder；请求数仍为 2。`);
    }

    function resetGraph() {
      qA = 2;
      qB = 3;
      renderGraph();
    }
    if (inputA) inputA.addEventListener('input', () => { qA = Number(inputA.value); renderGraph(); });
    if (inputB) inputB.addEventListener('input', () => { qB = Number(inputB.value); renderGraph(); });
    const reset = $('[data-graph-reset]', graphLab);
    const resetBottom = $('[data-graph-reset-bottom]', graphLab);
    if (reset) reset.addEventListener('click', resetGraph);
    if (resetBottom) resetBottom.addEventListener('click', resetGraph);

    renderGraph();
  }
})();
