/* DeepInfer 剖面 — unit 01 mechanics. Dependency-free. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const players = [];

  const fmt = (n) => String(n).padStart(2, '0');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function setClass(node, name, on) {
    if (node) node.classList.toggle(name, on);
  }

  function setBadge(node, text, kind = '') {
    if (!node) return;
    node.textContent = text;
    node.classList.remove('badge--ok', 'badge--wait', 'badge--signal');
    if (kind) node.classList.add('badge--' + kind);
  }

  function mountPlayer(root, initialSteps, render, interval = 2800) {
    const count = $('[data-count]', root);
    const rail = $('[data-steps]', root);
    const prev = $('[data-prev]', root);
    const next = $('[data-next]', root);
    const play = $('[data-play]', root);
    const reset = $('[data-reset]', root);
    let steps = initialSteps.slice();
    let index = 0;
    let timer = null;

    function paintRail() {
      if (!rail) return;
      rail.innerHTML = steps.map((label, i) =>
        `<button type="button" class="lab-step${i === index ? ' is-active' : ''}" data-i="${i}" aria-pressed="${i === index}">${esc(label)}</button>`
      ).join('');
      $$('[data-i]', rail).forEach((btn) => {
        btn.addEventListener('click', () => {
          stop();
          show(Number(btn.dataset.i));
        });
      });
    }

    function syncControls() {
      if (count) count.textContent = `${fmt(index + 1)} / ${fmt(steps.length)}`;
      if (prev) prev.disabled = index === 0;
      if (next) next.disabled = index === steps.length - 1;
      if (rail) {
        $$('[data-i]', rail).forEach((btn) => {
          const on = Number(btn.dataset.i) === index;
          btn.classList.toggle('is-active', on);
          btn.setAttribute('aria-pressed', String(on));
        });
        const active = $(`[data-i="${index}"]`, rail);
        if (active && rail.scrollWidth > rail.clientWidth) {
          active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      }
    }

    function stop() {
      if (timer) window.clearInterval(timer);
      timer = null;
      if (play) {
        play.textContent = '播放';
        play.setAttribute('aria-pressed', 'false');
      }
    }

    function show(n) {
      index = Math.max(0, Math.min(steps.length - 1, n));
      syncControls();
      render(index);
    }

    function start() {
      if (reducedMotion.matches) {
        if (play) play.textContent = '已用步进';
        window.setTimeout(stop, 700);
        return;
      }
      if (index >= steps.length - 1) show(0);
      timer = window.setInterval(() => {
        if (index >= steps.length - 1) {
          stop();
          return;
        }
        show(index + 1);
      }, interval);
      if (play) {
        play.textContent = '暂停';
        play.setAttribute('aria-pressed', 'true');
      }
    }

    function configure(labels) {
      stop();
      steps = labels.slice();
      index = 0;
      paintRail();
      show(0);
    }

    if (prev) prev.addEventListener('click', () => { stop(); show(index - 1); });
    if (next) next.addEventListener('click', () => { stop(); show(index + 1); });
    if (play) play.addEventListener('click', () => (timer ? stop() : start()));
    if (reset) reset.addEventListener('click', () => { stop(); show(0); });

    paintRail();
    show(0);

    const api = { show, stop, configure, get index() { return index; } };
    players.push(api);
    return api;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) players.forEach((p) => p.stop());
  });

  /* ------------------------------------------------------------
     M02 — chunk prefill: static, parameter-driven evidence ledger
     ------------------------------------------------------------ */
  const chunkLab = $('[data-lab="chunk"]');
  if (chunkLab) {
    const prompt = 10;
    const ref = (sel) => $(sel, chunkLab);
    let budget = 4;
    let chunked = true;

    function computeChunk(nextBudget, nextChunked) {
      const promptLimit = nextChunked ? 128 : Math.min(128, nextBudget);
      const blocked = !nextChunked && prompt > promptLimit;
      if (blocked) {
        return { blocked: true, budget: nextBudget, promptLimit, rounds: [], decode: null };
      }
      const rounds = [];
      let cache = 0;
      while (cache < prompt) {
        const q = Math.min(nextBudget, prompt - cache);
        const before = cache;
        cache += q;
        const last = cache >= prompt;
        rounds.push({ q, k: cache, before, cache, len: prompt + (last ? 1 : 0), out: last ? 1 : 0, last });
      }
      return {
        blocked: false,
        budget: nextBudget,
        promptLimit,
        rounds,
        decode: { q: 1, k: prompt + 1, before: prompt, cache: prompt + 1, len: prompt + 2, out: 2 }
      };
    }

    function paintGate(statusEl, copy, tone, label, html) {
      if (!statusEl) return;
      statusEl.textContent = label;
      statusEl.classList.remove('is-run', 'is-skip', 'is-stop');
      statusEl.classList.add('is-' + tone);
      const gate = statusEl.closest('.static-gate');
      if (gate) {
        gate.classList.remove('is-run', 'is-skip', 'is-stop');
        gate.classList.add('is-' + tone);
      }
      if (copy) copy.innerHTML = html;
    }

    function roundMarkup(r, index) {
      return `<li class="chunk-row${r.last ? ' is-first' : ''}">
        <div class="chunk-row__id"><span>PREFILL ${index + 1}</span><small>${r.last ? '末轮 · 首个输出' : '非末轮'}</small></div>
        <div class="chunk-row__cell"><span>本轮 q / k</span><b>q=${r.q} · k=${r.k}</b><small>k = ${r.before} + ${r.q}</small></div>
        <div class="chunk-row__cell"><span>cache</span><b>${r.before} → ${r.cache}</b><small>num_tokens</small></div>
        <div class="chunk-row__cell chunk-row__sample"><span>sampling</span><b class="${r.last ? 'tone-run' : 'tone-skip'}">执行 · ${r.last ? '提交' : '结果丢弃'}</b><small>${r.last ? '覆盖完 prompt，last_output_token 有效' : 'last_output_token=-1 只跳过 SO 更新'}</small></div>
        <div class="chunk-row__cell"><span>已提交输出</span><b>${r.out}</b><small>${r.last ? '首 token' : '仍为 0'}</small></div>
      </li>`;
    }

    function decodeMarkup(d) {
      return `<div class="chunk-decode__tag"><span>下一步</span><b>DECODE</b><small>独立 step</small></div>
        <div class="chunk-row__cell"><span>本轮 q / k</span><b>q=${d.q} · k=${d.k}</b><small>读刚提交的首 token</small></div>
        <div class="chunk-row__cell"><span>cache</span><b>${d.before} → ${d.cache}</b><small>首 token 被 forward</small></div>
        <div class="chunk-row__cell"><span>sampling</span><b class="tone-run">执行 · 提交</b><small>产生第 2 个输出</small></div>
        <div class="chunk-row__cell"><span>已提交输出</span><b>${d.out}</b><small>get_len()=${d.len}</small></div>`;
    }

    function renderChunk() {
      const view = computeChunk(budget, chunked);
      ref('[data-chunk-stamp]').textContent = `预算 ${budget} · chunk ${chunked ? '开' : '关'}`;
      ref('[data-chunk-budget-read]').textContent = `${budget} tokens / 轮`;
      ref('[data-chunk-mode-read]').textContent = chunked ? '开启 · 可跨轮' : '关闭 · 不可跨轮';
      ref('[data-chunk-limit]').textContent = budget;
      ref('[data-chunk-limit-value]').textContent = Math.min(128, budget);

      const gate2Status = ref('[data-chunk-gate2-status]');
      const gate3Status = ref('[data-chunk-gate3-status]');
      if (chunked) {
        paintGate(gate2Status, ref('[data-chunk-gate2-copy]'), 'run', '开 · 可跨轮',
          '开启 chunk：一个 prompt 可以拆到多轮 prefill；每轮最多读入 q = 预算。');
        paintGate(gate3Status, ref('[data-chunk-gate3-copy]'), 'run', '可跨轮',
          `本算例开启 chunk，10 个 token 分 ${view.rounds.length} 轮进入，不受单轮 q=${budget} 的截断。`);
      } else {
        paintGate(gate2Status, ref('[data-chunk-gate2-copy]'), 'stop', '关 · 不可跨轮',
          '关闭 chunk：prompt 不能跨轮，必须一次放得进本轮总预算。');
        paintGate(gate3Status, ref('[data-chunk-gate3-copy]'), 'stop', '拒绝',
          `关闭 chunk：prompt 10 &gt; prompt_limit ${view.promptLimit}，请求不会进入 prefill。`);
      }

      ref('[data-chunk-open]').hidden = view.blocked;
      ref('[data-chunk-rejected]').hidden = !view.blocked;

      if (view.blocked) {
        ref('[data-chunk-rejected-copy]').innerHTML = `prompt 10 &gt; prompt_limit ${view.promptLimit}：完整 prompt 放不进本轮，且关闭 chunk 后不能跨轮，所以请求被忽略。`;
        ref('[data-chunk-rounds]').innerHTML = '';
        ref('[data-chunk-decode]').innerHTML = '';
        ref('[data-chunk-result-cut]').textContent = '无';
        ref('[data-chunk-result-first]').textContent = '不会出现';
        ref('[data-chunk-result-sampling]').textContent = '未执行';
        ref('[data-chunk-result-state]').textContent = '0 / 10';
        ref('[data-chunk-result-next]').textContent = '无';
        ref('[data-chunk-result-status]').textContent = 'FINISHED_IGNORED';
        ref('[data-chunk-result-status]').className = 'tone-stop';
        ref('[data-chunk-result-note]').textContent = '完整 prompt 放不进本轮总预算；请求被标为 FINISHED_IGNORED 并移出 waiting，不是暂缓到下一轮。';
        ref('[data-chunk-why]').textContent = `关闭 chunk 后，prompt 10 超过 prompt_limit ${view.promptLimit}，不能拆轮，也不会出现 4/4/2。只有完整 prompt 合法、但本批剩余预算暂时不足时，才留在 waiting。`;
        ref('[data-live]').textContent = `预算 ${budget}、chunk 关：prompt 10 超过 prompt_limit ${view.promptLimit}，请求被 FINISHED_IGNORED 并移出 waiting，没有首 token。`;
        return;
      }

      ref('[data-chunk-rounds]').innerHTML = view.rounds.map(roundMarkup).join('');
      ref('[data-chunk-decode]').innerHTML = decodeMarkup(view.decode);
      const cut = view.rounds.map((r) => r.q).join(' / ');
      const last = view.rounds[view.rounds.length - 1];
      ref('[data-chunk-result-cut]').textContent = cut;
      ref('[data-chunk-result-first]').textContent = `第 ${view.rounds.length} 轮 · 提交 1 个`;
      ref('[data-chunk-result-sampling]').textContent = `${view.rounds.length} 次执行 · 1 次提交`;
      ref('[data-chunk-result-state]').textContent = '10 / 11';
      ref('[data-chunk-result-next]').textContent = 'decode · q=1, k=11';
      ref('[data-chunk-result-status]').textContent = '继续 decode';
      ref('[data-chunk-result-status]').className = 'tone-run';
      ref('[data-chunk-result-note]').textContent = `前 ${view.rounds.length - 1} 轮 sampling 结果被丢弃；第 ${view.rounds.length} 轮覆盖完 prompt 才提交首 token。首 token 尚未 forward，所以 cache 仍是 10，而 get_len 已是 11。`;
      ref('[data-chunk-why]').textContent = `最后一轮只剩 ${last.q} 个 token，q 取 min(预算 ${budget}, 剩余 ${last.q})=${last.q}；k = 已缓存 ${last.k - last.q} + ${last.q} = ${last.k}。下一 decode 的 q=1 才 forward 刚提交的首 token，并把 cache 推到 11。`;
      ref('[data-live]').textContent = `预算 ${budget}、chunk 开：prefill 切法 ${cut}；第 ${view.rounds.length} 轮提交首个输出，下一 decode 用 q=1、k=11。`;
    }

    const activeBudget = $('[data-chunk-budget][aria-pressed="true"]', chunkLab);
    if (activeBudget) budget = Number(activeBudget.dataset.chunkBudget);
    const toggle = $('[data-chunk-toggle]', chunkLab);
    if (toggle) chunked = toggle.checked;

    $$('[data-chunk-budget]', chunkLab).forEach((btn) => {
      btn.addEventListener('click', () => {
        budget = Number(btn.dataset.chunkBudget);
        $$('[data-chunk-budget]', chunkLab).forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
        renderChunk();
      });
    });
    if (toggle) toggle.addEventListener('change', () => {
      chunked = toggle.checked;
      renderChunk();
    });
    renderChunk();
  }

  /* ------------------------------------------------------------
     M03 — DP ALL / ANY, two votes
     ------------------------------------------------------------ */
  const voteLab = $('[data-lab="vote"]');
  if (voteLab) {
    const voteRanks = [0, 1];
    const voteModeNames = { all: 'ALL', any: 'ANY', none: '非尝试点' };

    /*
     * Pure state: every visible number and sentence comes from this one result.
     * `null` means the stage was never reached; it is deliberately different
     * from a reduction result of false.
     */
    function deriveVote({ mode, want, fit }) {
      const atPoint = mode !== 'none';
      const any = mode === 'any';
      const voteOne = atPoint ? (any ? want.some(Boolean) : want.every(Boolean)) : null;
      const localReached = voteOne === true;
      const localCalled = [false, false];
      const localHit = [false, false];

      if (localReached) {
        voteRanks.forEach((r) => {
          if (want[r]) {
            localCalled[r] = true;
            localHit[r] = fit[r] === true;
          }
        });
      }

      const localCount = localHit.filter(Boolean).length;
      const voteTwo = localReached ? localHit.some(Boolean) : null;
      const prefill = voteTwo === true;
      const results = voteRanks.map((r) => (prefill ? (localHit[r] ? 'real' : 'placeholder') : 'decode'));

      return {
        mode,
        want,
        fit,
        atPoint,
        any,
        voteOne,
        localReached,
        localCalled,
        localHit,
        localCount,
        voteTwo,
        prefill,
        results,
        wantCount: want.filter(Boolean).length,
      };
    }

    function readVoteParams() {
      const pressed = $('[data-vote-mode][aria-pressed="true"]', voteLab);
      return {
        mode: pressed ? pressed.dataset.voteMode : 'any',
        want: voteRanks.map((r) => {
          const input = $('[data-vote-want="' + r + '"]', voteLab);
          return input ? input.checked : false;
        }),
        fit: voteRanks.map((r) => {
          const input = $('[data-vote-fit="' + r + '"]', voteLab);
          return input ? input.checked : false;
        }),
      };
    }

    function setVoteText(selector, text) {
      const node = $(selector, voteLab);
      if (node) node.textContent = text;
    }

    function setVotePill(selector, text, tone) {
      const node = $(selector, voteLab);
      if (!node) return;
      node.textContent = text;
      node.className = 'vote-pill vote-pill--' + tone;
    }

    function setVotePillNode(node, text, tone) {
      if (!node) return;
      node.textContent = text;
      node.className = 'vote-pill vote-pill--' + tone;
    }

    function setVoteVerdict(node, text, tone) {
      if (!node) return;
      node.textContent = text;
      node.className = 'vote-verdict vote-verdict--' + tone;
    }

    function setVoteCall(node, text, tone) {
      if (!node) return;
      node.textContent = text;
      node.className = 'vote-call vote-call--' + tone;
    }

    function setVoteResult(node, text, tone) {
      if (!node) return;
      node.textContent = text;
      node.className = 'vote-result vote-result--' + tone;
    }

    function setVoteStage(name, active) {
      const stage = $('[data-vote-stage="' + name + '"]', voteLab);
      if (!stage) return;
      stage.classList.toggle('is-skipped', !active);
      setVotePillNode(
        $('[data-vote-stage-status]', stage),
        active ? '已执行' : '未执行',
        active ? 'run' : 'skip'
      );
    }

    function rankLabel(indices) {
      return indices.map((r) => 'R' + r).join(' / ');
    }

    function renderVote() {
      const params = readVoteParams();
      const d = deriveVote(params);
      const modeName = voteModeNames[params.mode] || '非尝试点';
      const modeLabel = d.atPoint ? modeName + ' 尝试点' : '非尝试点';
      const falseWant = voteRanks.filter((r) => !d.want[r]);

      voteRanks.forEach((r) => {
        const fitInput = $('[data-vote-fit="' + r + '"]', voteLab);
        const fitToggle = fitInput ? fitInput.closest('.vote-toggle') : null;
        const fitRead = d.localReached && d.want[r];
        const fitEffect = $('[data-vote-fit-effect="' + r + '"]', voteLab);

        setVoteText('[data-vote-want-state="' + r + '"]', String(d.want[r]));
        setVoteText('[data-vote-fit-state="' + r + '"]', String(d.fit[r]));

        let effect = '';
        if (!d.atPoint) effect = '不读取 · 非尝试点';
        else if (!d.voteOne) effect = '不读取 · 票一 false';
        else if (!d.want[r]) effect = '不读取 · want=false';
        else effect = d.fit[r] ? '读取 · 排入有请求' : '读取 · 调用后空手';

        if (fitToggle) fitToggle.classList.toggle('is-muted', !fitRead);
        if (fitEffect) {
          fitEffect.textContent = effect;
          fitEffect.classList.toggle('is-muted', !fitRead);
        }
      });

      let modeNote = '非尝试点：票一、本地排班、票二全不执行；直接 decode。';
      if (d.atPoint) {
        modeNote = d.any
          ? 'ANY：票一取 want₀ OR want₁，任一 want=true 即可通过。'
          : 'ALL：票一取 want₀ AND want₁，只有全员 want=true 才通过。';
      }
      setVoteText('[data-vote-mode-note]', modeNote);
      setVoteText('[data-vote-mode-label]', modeLabel);

      const verdictTone = d.prefill ? 'prefill' : 'decode';
      setVoteVerdict($('[data-vote-verdict]', voteLab), d.prefill ? 'PRE-FILL 组' : 'DECODE 组', verdictTone);
      setVoteVerdict($('[data-vote-exec-verdict]', voteLab), d.prefill ? 'PRE-FILL' : 'DECODE', verdictTone);

      let headline = '票二 true：组内进入 prefill';
      let summary = '';
      if (!d.atPoint) {
        headline = '非尝试点：直接 decode';
        summary = '非尝试点：票一、本地排班、票二全不执行；R0 / R1 直接 decode。';
      } else if (!d.voteOne) {
        headline = '票一 false：止于第一票';
        summary = modeLabel + ' · want ' + d.wantCount + '/2 → 票一 false。本地排班与票二未执行；R0 / R1 直接 decode。';
      } else if (!d.voteTwo) {
        headline = '票二 false：全组回 decode';
        summary = modeLabel + ' · want ' + d.wantCount + '/2 → 票一 true；本地真实请求 0/2 → 票二 false。全组 decode。';
      } else {
        headline = '票二 true：组内进入 prefill';
        const outcomes = voteRanks
          .map((r) => 'R' + r + (d.results[r] === 'real' ? ' 真实 prefill' : ' 空 prefill（placeholder）'))
          .join('；');
        summary = modeLabel + ' · want ' + d.wantCount + '/2 → 票一 true；本地真实请求 ' + d.localCount + '/2 → 票二 true。' + outcomes + '。';
      }
      setVoteText('[data-vote-headline]', headline);
      setVoteText('[data-vote-summary]', summary);

      const firstKpi = $('[data-vote-kpi-first]', voteLab);
      setVotePillNode(firstKpi, d.voteOne === null ? '未执行' : String(d.voteOne), d.voteOne === null ? 'skip' : d.voteOne ? 'true' : 'false');

      const localKpi = $('[data-vote-kpi-local]', voteLab);
      if (localKpi) {
        localKpi.textContent = d.localReached ? d.localCount + ' / 2' : '未执行';
        localKpi.className = 'vote-kpi-value' + (d.localReached ? '' : ' is-skipped');
      }

      const secondKpi = $('[data-vote-kpi-second]', voteLab);
      setVotePillNode(secondKpi, d.voteTwo === null ? '未执行' : String(d.voteTwo), d.voteTwo === null ? 'skip' : d.voteTwo ? 'true' : 'false');

      setVoteStage('gate', true);
      setVoteText('[data-vote-gate-value]', d.atPoint ? modeName + ' 尝试点' : '非尝试点');
      setVoteText('[data-vote-gate-sub]', d.atPoint ? '命中 → 进入票一' : '未命中 → 跳过 01–03');
      setVoteText(
        '[data-vote-gate-note]',
        !d.atPoint
          ? '非尝试点：票一、本地排班、票二全部未执行。'
          : d.any
            ? 'ANY：任一 want=true 即可通过票一。'
            : 'ALL：两个 want 都必须为 true，票一才会通过。'
      );

      setVoteStage('first', d.atPoint);
      setVoteText('[data-vote-first-op]', d.atPoint ? modeName + ' · ' + (d.any ? 'OR' : 'AND') : '—');
      setVotePill(
        '[data-vote-first-outcome]',
        d.voteOne === null ? '未执行' : String(d.voteOne),
        d.voteOne === null ? 'skip' : d.voteOne ? 'true' : 'false'
      );
      voteRanks.forEach((r) => {
        setVoteText(
          '[data-vote-first-row="' + r + '"]',
          d.atPoint ? 'want=' + d.want[r] + ' · 输入 ' + (d.want[r] ? '1' : '0') : '未参与'
        );
      });
      setVoteText(
        '[data-vote-first-note]',
        !d.atPoint
          ? '非尝试点：票一未执行，没有归约输入。'
          : d.voteOne
            ? (d.any ? 'OR 通过：至少一个 want=true。' : 'AND 通过：两个 want 都是 true。') + '票一为 true 才进入本地。'
            : (d.any ? 'OR false：没有任何 want=true。' : 'AND false：至少一个 want=false。') + '后续跳过。'
      );

      setVoteStage('local', d.localReached);
      setVoteText('[data-vote-local-op]', d.localReached ? '按 want' : '—');
      const localCount = $('[data-vote-local-count]', voteLab);
      if (localCount) {
        localCount.textContent = d.localReached ? d.localCount + ' / 2' : '未执行';
        localCount.classList.toggle('is-skipped', !d.localReached);
      }
      voteRanks.forEach((r) => {
        let cond;
        let call;
        let callTone;
        if (!d.localReached) {
          cond = '未执行';
          call = '—';
          callTone = 'skip';
        } else if (!d.want[r]) {
          cond = 'want=false · fit 不读取';
          call = '未调用';
          callTone = 'no-call';
        } else {
          cond = 'want=true · fit=' + d.fit[r];
          call = d.localHit[r] ? '调用 → 有请求' : '调用 → 空手';
          callTone = d.localHit[r] ? 'hit' : 'empty';
        }
        setVoteText('[data-vote-local-cond="' + r + '"]', cond);
        setVoteCall($('[data-vote-local-call="' + r + '"]', voteLab), call, callTone);
      });

      let localNote;
      if (!d.localReached) {
        localNote = !d.atPoint ? '非尝试点：本地排班未执行。' : '票一 false：本地排班未执行。';
      } else {
        const clauses = [];
        if (falseWant.length) {
          clauses.push(rankLabel(falseWant) + ' want=false → 未调用本地，但仍参与票二');
        }
        const empty = voteRanks.filter((r) => d.localCalled[r] && !d.localHit[r]);
        if (empty.length) {
          clauses.push(rankLabel(empty) + ' 已调用但 fit=false → 返回空手');
        }
        if (!clauses.length) {
          clauses.push('want=true 的 rank 都已调用本地，并排出真实请求');
        } else if (falseWant.length) {
          clauses.push('未调用不是排班失败');
        }
        localNote = clauses.join('；') + '。';
      }
      setVoteText('[data-vote-local-note]', localNote);

      setVoteStage('second', d.localReached);
      setVoteText('[data-vote-second-op]', d.localReached ? 'OR' : '—');
      setVotePill(
        '[data-vote-second-outcome]',
        d.voteTwo === null ? '未执行' : String(d.voteTwo),
        d.voteTwo === null ? 'skip' : d.voteTwo ? 'true' : 'false'
      );
      voteRanks.forEach((r) => {
        let row;
        let source;
        if (!d.localReached) {
          row = '未参与';
          source = '票二未执行';
        } else {
          row = '输入 ' + (d.localHit[r] ? '1' : '0') + ' · 参与';
          source = !d.want[r] ? '未调用本地' : d.localHit[r] ? '本地有请求' : '调用后空手';
        }
        setVoteText('[data-vote-second-row="' + r + '"]', row);
        setVoteText('[data-vote-second-src="' + r + '"]', source);
      });

      let secondNote;
      if (!d.localReached) {
        secondNote = !d.atPoint ? '非尝试点：票二未执行，也没有 all-reduce。' : '票一 false：票二未执行。';
      } else {
        const nonCalled = voteRanks.filter((r) => !d.localCalled[r]);
        secondNote = d.voteTwo
          ? 'OR 通过：至少一个输入为 1。'
          : 'OR false：所有输入都是 0，全组回 decode。';
        if (nonCalled.length) {
          secondNote += rankLabel(nonCalled) + ' 未调用本地但参与票二，输入 0' + (d.voteTwo ? '，没有被漏掉。' : '；未调用不是排班失败。');
        } else if (!d.voteTwo) {
          secondNote += '调用后空手也计 0。';
        }
      }
      setVoteText('[data-vote-second-note]', secondNote);

      setVoteStage('exec', true);
      const placeholderRanks = voteRanks.filter((r) => d.results[r] === 'placeholder');
      voteRanks.forEach((r) => {
        const result = $('[data-vote-exec-row="' + r + '"]', voteLab);
        const sub = $('[data-vote-exec-sub="' + r + '"]', voteLab);
        if (d.results[r] === 'real') {
          setVoteResult(result, '真实 prefill', 'real');
          if (sub) sub.textContent = '本地有请求';
        } else if (d.results[r] === 'placeholder') {
          setVoteResult(result, '空 prefill', 'placeholder');
          if (sub) sub.textContent = 'placeholder · block_table=[0]';
        } else {
          setVoteResult(result, 'decode', 'decode');
          if (sub) sub.textContent = '直接 decode';
        }
      });

      let execNote;
      if (d.prefill) {
        execNote = placeholderRanks.length
          ? rankLabel(placeholderRanks) + ' 用 placeholder（block_table=[0]）维持步型；其余 rank 使用真实 metadata。'
          : '票二 true；所有 rank 都有真实请求，不使用 placeholder。';
      } else if (!d.atPoint) {
        execNote = '非尝试点：R0 / R1 直接 decode。';
      } else if (!d.voteOne) {
        execNote = '票一 false：R0 / R1 直接 decode。';
      } else {
        execNote = '票二 false：全组 decode，本轮没有 prompt step。';
      }
      setVoteText('[data-vote-exec-note]', execNote);
    }

    $$('[data-vote-mode]', voteLab).forEach((button) => {
      button.addEventListener('click', () => {
        $$('[data-vote-mode]', voteLab).forEach((candidate) => {
          candidate.setAttribute('aria-pressed', String(candidate === button));
        });
        renderVote();
      });
    });

    voteRanks.forEach((r) => {
      const wantInput = $('[data-vote-want="' + r + '"]', voteLab);
      const fitInput = $('[data-vote-fit="' + r + '"]', voteLab);
      if (wantInput) wantInput.addEventListener('change', renderVote);
      if (fitInput) fitInput.addEventListener('change', renderVote);
    });

    renderVote();
  }
(function () {
  const lab = $('[data-lab="preempt"]');
  if (!lab) return;

  const state = { free: 0, mode: 'stop' };
  const poolButtons = $$('[data-preempt-pool]', lab);
  const modeButtons = $$('[data-preempt-mode]', lab);

  const find = (selector) => $(selector, lab);
  const setText = (selector, value) => {
    const node = find(selector);
    if (node) node.textContent = value;
  };
  const setHTML = (selector, value) => {
    const node = find(selector);
    if (node) node.innerHTML = value;
  };
  const setBadge = (selector, label, variant) => {
    const node = find(selector);
    if (!node) return;
    node.textContent = label;
    node.className = 'preempt-badge ' + variant;
  };
  const setPressed = (buttons, dataKey, current) => {
    buttons.forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset[dataKey] === current));
    });
  };
  const chips = (owner, ids) => ids
    .map((id) => '<span class="preempt-chip preempt-chip--' + owner + '">' + id + '</span>')
    .join('');
  const activePath = (key) => {
    const node = find('[data-preempt-path="' + key + '"]');
    if (!node) return;
    const on = key === 'direct' ? state.free === 1 : state.free === 0;
    node.classList.toggle('preempt-path--active', on);
    node.classList.toggle('preempt-path--skipped', !on);
    setBadge(
      '[data-preempt-path-badge="' + key + '"]',
      on ? '本轮生效' : '本轮未执行',
      on ? 'preempt-badge--active' : 'preempt-badge--skip'
    );
  };
  const modeRow = (key) => {
    const direct = state.free === 1;
    const chosen = state.mode === key;
    const executing = !direct && chosen;
    const node = find('[data-preempt-mode-row="' + key + '"]');
    if (node) {
      node.classList.toggle('preempt-mode-row--active', executing);
      node.classList.toggle('preempt-mode-row--skipped', !executing);
    }
    let label = '未选';
    if (direct) label = chosen ? '已配置 · 未执行' : '备选 · 未执行';
    else if (!chosen) label = '未选';
    else label = '本轮执行';
    setBadge(
      '[data-preempt-mode-badge="' + key + '"]',
      label,
      executing ? 'preempt-badge--active' : 'preempt-badge--skip'
    );
  };

  function render() {
    const direct = state.free === 1;
    const victim = !direct;
    const stop = state.mode === 'stop';
    const cExtra = direct ? '#7' : '#12';
    const aAfterBadge = victim ? (stop ? 'FINISHED_PREEMPTED' : 'WAITING') : 'running';
    const aAfterVariant = victim ? (stop ? 'preempt-badge--ended' : 'preempt-badge--wait') : 'preempt-badge--run';

    setPressed(poolButtons, 'preemptPool', String(state.free));
    setPressed(modeButtons, 'preemptMode', state.mode);

    setText('[data-preempt-free-count]', direct ? '1 块' : '0 块');
    setText('[data-preempt-free-note]', direct ? '空闲 #7 可用' : '默认：没有空闲块');
    setBadge(
      '[data-preempt-gate-badge]',
      direct ? '成立 → 直达' : '不成立 → victim',
      direct ? 'preempt-badge--ok' : 'preempt-badge--no'
    );
    setText('[data-preempt-verdict]', direct ? '直达分配' : 'victim 让路');
    setText('[data-preempt-mode-hint]', direct ? '本轮直达，不产生 victim；A 的处置不执行。' : 'victim=A；选中的处置会执行。');
    setHTML(
      '[data-preempt-readout]',
      direct
        ? '空闲 1 块 · 需要 1 块 → <strong>直达分配</strong> · 无 victim'
        : '空闲 0 块 · 需要 1 块 → <strong>victim 让路</strong> · A ' + (stop ? '终止' : '清状态重算')
    );
    setHTML(
      '[data-preempt-param-note]',
      direct
        ? '<strong>C 本轮无需 victim：</strong>空闲 #7 直接给 C。这个条件只限处理 C 的这次迭代；后续处理 B 仍可能空间不足而选中 A。'
        : '<strong>当前无空闲：</strong>C 本轮需要 victim；A 被抢占后退出 running，后续 B 不会再次选中 A。'
    );

    const seqA = find('[data-preempt-seq-item="A"]');
    if (seqA) seqA.classList.toggle('preempt-seq__item--victim', victim);
    setText('[data-preempt-a-role]', direct ? '本轮不动' : '本轮 victim');

    activePath('direct');
    activePath('victim');
    modeRow('stop');
    modeRow('recompute');

    const aRow = find('[data-preempt-ledger-row="A"]');
    if (aRow) aRow.classList.toggle('preempt-table__row--changed', victim);
    setText(
      '[data-preempt-a-action]',
      victim ? '释放 #12/#4/#8 → 空闲池；C 取 #12' : '不动'
    );
    setBadge('[data-preempt-a-after-badge]', aAfterBadge, aAfterVariant);
    setHTML(
      '[data-preempt-a-after-blocks]',
      victim
        ? '<span class="preempt-empty">— 无 KV 块</span>'
        : chips('a', ['#12', '#4', '#8'])
    );
    setText(
      '[data-preempt-a-after-note]',
      victim
        ? (stop ? 'state 17 释放；退出 running，不再生成' : 'state 17 释放；退出 running，等待重算')
        : 'state 17 不变；仍在 running'
    );
    setText(
      '[data-preempt-b-after-note]',
      victim ? 'A 已不在 running；后续 B 不会再次选中 A' : 'A 仍在 running；后续 B 仍可能选中 A'
    );
    setText(
      '[data-preempt-c-action]',
      victim ? '从 A 释放的块中取 #12' : '从空闲池取 #7'
    );
    setHTML(
      '[data-preempt-c-after-blocks]',
      chips('c', ['#6', cExtra])
    );
    setText('[data-preempt-c-after-note]', '本轮被选中；外层循环未结束');

    setHTML(
      '[data-preempt-pool-before]',
      direct
        ? '<div class="preempt-chips">' + chips('free', ['#7']) + '</div><span class="preempt-cellnote">1 块</span>'
        : '<div class="preempt-chips"><span class="preempt-empty">0 块</span></div><span class="preempt-cellnote">当前无空闲</span>'
    );
    setText(
      '[data-preempt-pool-action]',
      victim ? 'A 释放 3 块，C 取走 1 块' : 'C 取走 #7；A 未释放'
    );
    setHTML(
      '[data-preempt-pool-after]',
      direct
        ? '<div class="preempt-chips"><span class="preempt-empty">0 块</span></div><span class="preempt-cellnote">#7 已归 C</span>'
        : '<div class="preempt-chips">' + chips('free', ['#4', '#8']) + '<span class="preempt-cellnote">2 块</span></div><span class="preempt-cellnote">#12 已归 C</span>'
    );

    setText('[data-preempt-balance-before]', direct ? '1' : '0');
    setHTML('[data-preempt-balance-release]', victim ? 'A 释放 <b>3</b>' : 'victim 释放 <b>0</b>');
    setText('[data-preempt-balance-after]', direct ? '0' : '2');
    setText(
      '[data-preempt-balance-note]',
      direct ? 'C 取 #7；A 未释放' : 'C 取 #12；#4 #8 留池'
    );

    setHTML(
      '[data-preempt-result-lead]',
      direct
        ? 'C 直接取 <b>1</b> 个空闲块；A 未让路；空闲池 <b>1 → 0</b>。'
        : (stop
          ? 'A 释放 <b>3</b> 块，C 用 <b>1</b> 块；空闲池 <b>0 → 2</b>。'
          : 'A 回 waiting 队头（重算），释放 <b>3</b> 块；C 用 <b>1</b> 块；空闲池 <b>0 → 2</b>。')
    );
    setText(
      '[data-preempt-result-a]',
      direct
        ? 'A 仍是 running；state 17 与块表 #12/#4/#8 不变；本轮没有处置。'
        : (stop
          ? '终止：FINISHED_PREEMPTED；state 17 释放；退出 running，不再生成。'
          : '清状态重算：WAITING（队头）；state 17 释放；释放 3 个 KV 块；已提交 token 保留，之后重新 prefill。')
    );
    setText(
      '[data-preempt-result-c]',
      '已有 #6；本轮加 ' + cExtra + '；这是 C 的这次迭代，外层 while 尚未结束。'
    );
    setText(
      '[data-preempt-result-next]',
      direct
        ? 'A 仍在 running → 后续处理 B 仍可能选中 A；B 的最终结果不在本图。'
        : 'A 已不在 running → 后续处理 B 不会再次选中 A；B 的最终结果不在本图。'
    );

    const idleFollow = find('[data-preempt-follow="idle"]');
    const preemptedFollow = find('[data-preempt-follow="preempted"]');
    if (idleFollow) idleFollow.classList.toggle('preempt-follow__row--active', direct);
    if (preemptedFollow) preemptedFollow.classList.toggle('preempt-follow__row--active', victim);
  }

  poolButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const next = Number(button.dataset.preemptPool);
      if (next !== 0 && next !== 1) return;
      if (next === state.free) return;
      state.free = next;
      render();
    });
  });

  modeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const next = button.dataset.preemptMode;
      if (next !== 'stop' && next !== 'recompute') return;
      if (next === state.mode) return;
      state.mode = next;
      render();
    });
  });

  render();
})();
})();
