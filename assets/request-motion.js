/* DeepInfer 剖面 — M01 request pipeline, continuous playback.
   One request card (R0) is the only identity. It is handed across the
   actual module boundaries: entry -> tokenizer -> Sequence -> waiting.
   The boundary rails carry the same R0 and payload; the modules receive
   the data before the next action starts. */
(() => {
  'use strict';

  const root = document.querySelector('[data-lab="request"]');
  if (!root) return;

  const $ = (sel, ctx = root) => ctx.querySelector(sel);
  const $$ = (sel, ctx = root) => Array.from(ctx.querySelectorAll(sel));
  const clamp01 = (value) => Math.min(1, Math.max(0, value));
  const DURATION = 12000;
  const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  const T = {
    identity: 0.07,
    identityStamp: 0.09,
    identityOn: 0.13,
    identityDone: 0.155,
    encode: 0.20,
    encoded: 0.44,
    sequence: 0.46,
    seqTokens: 0.54,
    cache: 0.55,
    table: 0.58,
    state: 0.61,
    seqFields: 0.62,
    enqueue: 0.76,
    queueArrive: 0.83,
    reserve: 0.88,
    hold: 0.92
  };

  const PHASES = [
    { id: 'arrival', label: '文本', start: 0, end: T.identity, jump: '入口' },
    { id: 'identity', label: '身份', start: T.identity, end: T.encode, jump: '分配 request_id' },
    { id: 'encode', label: '编码', start: T.encode, end: T.sequence, jump: '编码 / 复用' },
    { id: 'sequence', label: 'Sequence', start: T.sequence, end: T.enqueue, jump: 'Sequence 建档' },
    { id: 'enqueue', label: '入队', start: T.enqueue, end: T.hold, jump: '推入 waiting' },
    { id: 'hold', label: '下一 step', start: T.hold, end: 1.0001, jump: '创建结束' }
  ];

  const KINDS = {
    text: {
      ids: [101, 872, 44, 209, 511, 102],
      promptLabel: '入口 / STRING',
      promptTitle: '床前明月光',
      promptNote: '用户可读文本；还不是模型输入。',
      kindNote: '文本路径：调用 tokenizer.encode。',
      tokenLabel: 'TOKENIZER / INT32',
      emptyText: '等待编码',
      traceMeta: 'string'
    },
    ids: {
      ids: [1024, 77, 309, 8],
      promptLabel: '入口 / INT32[]',
      promptTitle: 'prompt_token_ids',
      promptNote: '调用方已给整数 token；入口不再编码。',
      kindNote: 'ID 路径：跳过 encode，只转 int32。',
      tokenLabel: 'INPUT IDS / INT32',
      emptyText: '已有 IDs',
      traceMeta: 'int32[]'
    }
  };

  const refs = {
    count: $('[data-count]'),
    kindNote: $('[data-req-kind-note]'),
    kindButtons: $$('[data-input-kind]'),
    live: $('[data-live]'),
    phaseLabel: $('[data-req-phase-label]'),
    time: $('[data-req-time]'),
    scrub: $('[data-req-scrub]'),
    motionNote: $('[data-req-motion-note]'),
    steps: $('[data-steps]'),
    prev: $('[data-prev]'),
    play: $('[data-play]'),
    next: $('[data-next]'),
    reset: $('[data-reset]'),
    idBadge: $('[data-req-id-badge]'),
    idMeta: $('[data-req-id-meta]'),
    stageState: $('[data-req-stage-state]'),
    dossierHint: $('[data-req-dossier-hint]'),
    promptLabel: $('[data-req-prompt-label]'),
    promptTitle: $('[data-req-prompt-title]'),
    promptNote: $('[data-req-prompt-note]'),
    entryIds: $('[data-req-entry-ids]'),
    stamp: $('[data-req-stamp]'),
    stampId: $('[data-req-stamp-id]'),
    tokenLabel: $('[data-req-token-label]'),
    tokenNote: $('[data-req-token-note]'),
    tokens: $('[data-req-tokens]'),
    tokensEmpty: $('[data-req-tokens-empty]'),
    meter: $('[data-req-meter]'),
    seqId: $('[data-req-seq-id]'),
    seqTokens: $('[data-req-seq-tokens]'),
    seqEmpty: $('[data-req-seq-empty]'),
    seqNote: $('[data-req-seq-note]'),
    queueEmpty: $('[data-req-queue-empty]'),
    queueTicket: $('[data-req-queue-ticket]'),
    queueTokens: $('[data-req-queue-tokens]'),
    queueNote: $('[data-req-queue-note]'),
    nodes: {},
    passes: {},
    links: {},
    fields: {}
  };

  ['prompt', 'tokens', 'sequence', 'queue'].forEach((name) => {
    refs.nodes[name] = $(`[data-req-node="${name}"]`);
  });
  $$('[data-req-pass]').forEach((el) => {
    refs.passes[el.dataset.reqPass] = el;
  });
  $$('[data-req-link]').forEach((el) => {
    const key = el.dataset.reqLink;
    refs.links[key] = {
      el,
      action: $('[data-req-link-label]', el),
      courier: $('[data-req-courier]', el),
      courierId: $('[data-req-courier-id]', el),
      courierMeta: $('[data-req-courier-meta]', el)
    };
  });
  $$('[data-req-field]').forEach((el) => {
    const key = el.dataset.reqField;
    if (!refs.fields[key]) refs.fields[key] = [];
    refs.fields[key].push(el);
  });

  let kind = 'text';
  let progress = 0;
  let playing = false;
  let raf = 0;
  let lastTs = 0;
  let reduced = reducedQuery.matches;
  let tokenChips = [];
  let seqChips = [];
  let queueChips = [];
  let activeChapter = -1;
  let lastPercent = -1;
  let lastTime = '';
  const fieldTimers = new WeakMap();

  function setText(node, value) {
    if (node && node.textContent !== value) node.textContent = value;
  }

  function setField(name, value) {
    const nodes = refs.fields[name];
    if (!nodes) return;
    nodes.forEach((node) => {
      if (node.textContent === value) return;
      node.textContent = value;
      node.classList.add('is-new');
      const timer = fieldTimers.get(node);
      if (timer) window.clearTimeout(timer);
      fieldTimers.set(node, window.setTimeout(() => {
        node.classList.remove('is-new');
      }, 520));
    });
  }

  function setPass(name, value, mode) {
    const node = refs.passes[name];
    if (!node) return;
    setText(node, value);
    node.classList.toggle('is-live', mode === 'live');
    node.classList.toggle('is-done', mode === 'done');
  }

  function phaseIndexAt(value) {
    for (let i = 0; i < PHASES.length; i += 1) {
      if (value < PHASES[i].end) return i;
    }
    return PHASES.length - 1;
  }

  function tokenNode(id, index, options = {}) {
    const node = document.createElement('span');
    node.className = 'token'
      + (options.mini ? ' token--mini' : '')
      + (options.defer ? ' token--defer' : '');
    node.textContent = String(id);
    if (options.defer) node.style.setProperty('--i', String(index));
    return node;
  }

  function setChips(chips, count) {
    chips.forEach((chip, i) => {
      chip.classList.toggle('is-in', i < count);
    });
  }

  function buildTokens() {
    const ids = KINDS[kind].ids;
    const n = ids.length;

    const entryChips = ids.map((id, i) => {
      const node = tokenNode(id, i);
      node.classList.add('is-in');
      return node;
    });
    refs.entryIds.replaceChildren(...entryChips);
    refs.entryIds.hidden = kind !== 'ids';
    refs.entryIds.setAttribute('aria-label', kind === 'ids'
      ? `入口已有的 ${n} 个 token IDs：${ids.join(', ')}`
      : '入口是字符串');

    Array.from(refs.tokens.querySelectorAll('.token')).forEach((node) => node.remove());
    tokenChips = ids.map((id, i) => {
      const node = tokenNode(id, i);
      if (kind === 'ids') node.classList.add('is-provided');
      refs.tokens.append(node);
      return node;
    });
    refs.tokensEmpty.textContent = KINDS[kind].emptyText;
    refs.tokensEmpty.hidden = kind === 'ids';

    Array.from(refs.seqTokens.querySelectorAll('.token')).forEach((node) => node.remove());
    seqChips = ids.map((id, i) => tokenNode(id, i, { defer: true }));
    refs.seqTokens.append(...seqChips);
    refs.seqEmpty.hidden = false;

    queueChips = ids.map((id, i) => tokenNode(id, i, { mini: true, defer: true }));
    refs.queueTokens.replaceChildren(...queueChips);
    refs.queueTokens.setAttribute('aria-label', `waiting 中的 R0，token IDs：${ids.join(', ')}`);

    refs.tokens.setAttribute('aria-label', kind === 'ids'
      ? `已有 ${n} 个 token IDs：${ids.join(', ')}`
      : '等待编码');
  }

  function updateKindCopy() {
    const definition = KINDS[kind];
    const n = definition.ids.length;
    setText(refs.kindNote, definition.kindNote);
    setText(refs.promptLabel, definition.promptLabel);
    setText(refs.promptTitle, definition.promptTitle);
    setText(refs.promptNote, definition.promptNote);
    setText(refs.tokenLabel, definition.tokenLabel);
    setText(refs.stampId, 'R0');
    refs.kindButtons.forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.inputKind === kind));
    });
    root.classList.toggle('is-ids', kind === 'ids');
    refs.tokens.setAttribute('aria-label', kind === 'ids'
      ? `已有 ${n} 个 token IDs：${definition.ids.join(', ')}`
      : '等待编码');
  }

  function buildChapters() {
    if (!refs.steps) return;
    refs.steps.innerHTML = PHASES.map((phase) =>
      `<button type="button" class="lab-step" data-jump="${phase.start}" aria-pressed="false" aria-label="${phase.jump}，跳到该阶段开头">${phase.label}</button>`
    ).join('');
    activeChapter = -1;
    $$('[data-jump]', refs.steps).forEach((button) => {
      button.addEventListener('click', () => {
        seekTo(Number(button.dataset.jump));
      });
    });
  }

  function syncPlayButton() {
    if (!refs.play) return;
    if (reduced) {
      refs.play.disabled = true;
      setText(refs.play, '静态总览');
      refs.play.setAttribute('aria-pressed', 'false');
      return;
    }
    refs.play.disabled = false;
    let label = '播放';
    if (playing) label = '暂停';
    else if (progress >= 0.999) label = '重播';
    else if (progress > 0.0001) label = '继续';
    setText(refs.play, label);
    refs.play.setAttribute('aria-pressed', String(playing));
  }

  function narrative(phaseIndex, p, state) {
    const definition = KINDS[kind];
    const n = definition.ids.length;
    const {
      written,
      stampIn,
      identityOn,
      sequenceStarted,
      seqVisible,
      enqueueStarted,
      ticketIn
    } = state;

    if (phaseIndex === 0) {
      return kind === 'ids'
        ? `入口：拿到 ${n} 个已有 token IDs。还没有 request_id；跳过 encode 也仍要先分配身份、再建档。`
        : '入口：拿到字符串「床前明月光」。还没有 token、request_id 和 KV；字符串不能直接送给模型。';
    }

    if (phaseIndex === 1) {
      if (!stampIn) {
        return '入口先深拷贝 SamplingParams，避免多个请求共享同一份可变采样配置；request_id 尚未分配。';
      }
      if (!identityOn) {
        return 'sampling 已复制；现在从计数器分配 request_id。身份先于编码。';
      }
      return `身份分配完成：request_id=R0。现在才有请求身份；${kind === 'ids' ? '复用已有 IDs' : '文本编码'}随后才开始。`;
    }

    if (phaseIndex === 2) {
      if (kind === 'ids') {
        if (written < n) {
          return `复用路径：跳过 tokenizer.encode，正在把已有 IDs 转成 int32；已处理 ${written}/${n}。Token ID 是词表编号，不是位置。`;
        }
        return `复用完成：直接使用同一组 ${n} 个 token IDs，没有调用 encode。它们将原样写入 R0 的 Sequence。`;
      }
      if (written < n) {
        return `编码中：tokenizer 正在把文本切成整数词表编号，已写出 ${written}/${n}。Token ID 不是位置。`;
      }
      return `编码完成：得到 ${n} 个 int32 token。它们将原样写入同一个 R0 的 Sequence，而不是复制成另一份身份。`;
    }

    if (phaseIndex === 3) {
      if (p < T.seqTokens) {
        return `建档：Sequence R0 正在成形，tokenizer 交出的同一组 ${n} 个 int32 正沿边界写入 input.tokens。`;
      }
      if (p < T.seqFields) {
        return 'input.tokens 已写入。接着初始化 cache.num_tokens=0，block_table 为空，state_id=-1；此时还没有设备上的 KV。';
      }
      return 'Sequence 档案已建立：cache 0、block_table 空、state -1；同一个 R0 仍在 CPU 账本上，等待 add_sequence。';
    }

    if (phaseIndex === 4) {
      if (p < T.queueArrive) {
        return '入队：Scheduler.add_sequence 先把 arrival_time 写进 R0，并把同一个 Sequence 交给 waiting。这里仍是 CPU 账本。';
      }
      if (p < T.reserve) {
        return '为同一个 R0 预留输出 token 容量和 block table 容量；仍没有 GPU forward，也没有新的 KV。';
      }
      return '同一个 R0 已被 push 到 waiting 队列尾部；下一次调度选择才可能让它进入 prefill。';
    }

    return sequenceStarted && enqueueStarted && ticketIn
      ? '创建结束：R0 停在 waiting，cache.num_tokens=0，尚无 GPU forward。下一次 LLMEngine.step() 才可能调度它；一个 step 不等于整个请求。'
      : `创建结束：${n} 个 token 已随 R0 写入 waiting，尚无 GPU forward。下一次 LLMEngine.step() 才可能调度它。`;
  }

  function setLink(key, state) {
    const link = refs.links[key];
    if (!link) return;
    link.el.style.setProperty('--pass', state.pass.toFixed(4));
    link.el.classList.toggle('is-visible', state.visible);
    link.el.classList.toggle('is-active', state.active);
    link.el.classList.toggle('is-done', state.done);
    link.el.classList.toggle('is-starting', state.visible && state.pass <= 0.004);
    link.el.classList.toggle('is-arrived', state.visible && state.pass >= 0.996);
    setText(link.action, state.action);
    setText(link.courierId, state.id);
    setText(link.courierMeta, state.meta);
  }

  function render() {
    const p = progress;
    const phaseIndex = phaseIndexAt(p);
    const phase = PHASES[phaseIndex];
    const definition = KINDS[kind];
    const ids = definition.ids;
    const n = ids.length;

    const stampIn = p >= T.identityStamp;
    const identityOn = p >= T.identityOn;
    const textEncodeT = clamp01((p - T.encode) / (T.encoded - T.encode));
    const reuseT = clamp01((p - T.encode) / 0.14);
    const encodeT = kind === 'ids' ? reuseT : textEncodeT;
    const written = Math.floor(encodeT * n + 1e-9);
    const sequenceStarted = p >= T.sequence;
    const seqReveal = clamp01((p - T.sequence) / (T.seqTokens - T.sequence));
    const seqVisible = sequenceStarted ? Math.min(n, Math.ceil(seqReveal * n)) : 0;
    const seqT = clamp01((p - T.sequence) / (T.enqueue - T.sequence));
    const enqueueStarted = p >= T.enqueue;
    const queueT = clamp01((p - T.enqueue) / (T.hold - T.enqueue));
    const ticketIn = enqueueStarted && p >= T.queueArrive;
    const held = p >= T.hold;
    const visibleTokens = sequenceStarted ? n : written;
    const activeNode = p < T.encode ? 0 : p < T.sequence ? 1 : p < T.enqueue ? 2 : 3;
    const cacheOn = p >= T.cache;
    const tableOn = p >= T.table;
    const stateOn = p >= T.state;
    const arrivalOn = p >= T.queueArrive;
    const reserveOn = p >= T.reserve;
    const meterFill = kind === 'ids' ? reuseT : textEncodeT;

    root.style.setProperty('--req-encode', meterFill.toFixed(4));
    root.dataset.phase = phase.id;

    Object.entries(refs.nodes).forEach(([name, node]) => {
      if (!node) return;
      const index = ['prompt', 'tokens', 'sequence', 'queue'].indexOf(name);
      node.classList.toggle('is-current', index === activeNode);
      node.classList.toggle('is-done', index < activeNode);
    });

    refs.stamp.classList.toggle('is-in', stampIn);
    refs.stamp.classList.toggle('has-id', identityOn);

    setChips(tokenChips, visibleTokens);
    refs.tokensEmpty.hidden = kind === 'ids' || p >= T.encode;
    refs.meter.classList.toggle('is-live', p >= T.encode && p < T.sequence);

    let tokenNote;
    if (sequenceStarted) {
      tokenNote = enqueueStarted ? `同一组 ${n} 个 token 随 R0 入队` : `${n} 个 token 已写入 R0`;
    } else if (kind === 'ids') {
      tokenNote = p < T.encode
        ? `${n} 个已有 ID；${identityOn ? '等待复用' : '等待身份'}`
        : written < n
          ? `复用并转 int32 ${written}/${n}`
          : `${n} 个 int32 token（跳过 encode）`;
    } else if (p < T.encode) {
      tokenNote = '等待编码';
    } else if (written < n) {
      tokenNote = `编码中 ${written}/${n}`;
    } else {
      tokenNote = `${n} 个 int32 token 就绪`;
    }
    setText(refs.tokenNote, tokenNote);

    let tokensAria;
    if (kind === 'ids' && visibleTokens === 0) {
      tokensAria = `已有 ${n} 个 token IDs：${ids.join(', ')}`;
    } else if (visibleTokens >= n) {
      tokensAria = `token IDs：${ids.join(', ')}`;
    } else if (visibleTokens > 0) {
      tokensAria = `已写入 ${visibleTokens} / ${n} 个 token`;
    } else {
      tokensAria = p >= T.encode ? '编码开始，尚未写出 token' : '等待编码';
    }
    if (refs.tokens.getAttribute('aria-label') !== tokensAria) {
      refs.tokens.setAttribute('aria-label', tokensAria);
    }

    setText(refs.seqId, sequenceStarted ? 'R0' : '—');
    setChips(seqChips, seqVisible);
    refs.seqEmpty.hidden = sequenceStarted;
    let seqNote;
    if (!sequenceStarted) seqNote = '尚未建档';
    else if (p < T.seqTokens) seqNote = `正在接收 ${seqVisible}/${n} 个 token`;
    else if (p < T.cache) seqNote = `input.tokens ${n} 个`;
    else if (p < T.enqueue) seqNote = 'cache 0 · block_table 空 · state -1';
    else seqNote = '已入队，仍无 GPU KV';
    setText(refs.seqNote, seqNote);
    let seqAria;
    if (!sequenceStarted) {
      seqAria = 'Sequence 尚未建档';
    } else if (seqVisible >= n) {
      seqAria = `Sequence input.tokens：${ids.join(', ')}`;
    } else {
      seqAria = `Sequence 正在写入 ${seqVisible}/${n} 个 token`;
    }
    if (refs.seqTokens.getAttribute('aria-label') !== seqAria) {
      refs.seqTokens.setAttribute('aria-label', seqAria);
    }

    refs.queueEmpty.hidden = ticketIn;
    refs.queueTicket.classList.toggle('is-in', ticketIn);
    setChips(queueChips, ticketIn ? n : 0);
    let queueNote;
    if (!enqueueStarted) queueNote = '空 · 等待 add_sequence';
    else if (p < T.queueArrive) queueNote = 'Scheduler.add_sequence 写入中…';
    else if (p < T.reserve) queueNote = '预留输出 / block 容量…';
    else if (held) queueNote = 'WAITING · 尚无 forward';
    else queueNote = 'R0 已进入 waiting';
    setText(refs.queueNote, queueNote);

    let status;
    if (!identityOn) status = '尚未创建';
    else if (!sequenceStarted) status = p < T.encode ? '身份已分配 · 待编码' : '身份已分配 · 待建档';
    else if (!enqueueStarted) status = '待入队';
    else if (queueT < 0.55) status = '入队中';
    else if (held) status = 'WAITING · 待 schedule()';
    else status = 'WAITING';

    setField('id', identityOn ? 'R0' : '—');
    setField('len', kind === 'ids'
      ? (sequenceStarted ? `${n} tokens` : `${n} tokens（已有）`)
      : (p < T.encode ? '—' : `${visibleTokens} tokens`));
    setField('sampling', stampIn ? '已复制 ×1' : '—');
    setField('cache', cacheOn ? '0' : '—');
    setField('table', tableOn ? '[]' : '—');
    setField('state', stateOn ? '-1' : '—');
    setField('arrival', arrivalOn ? '已写入' : '—');
    setField('reserve', reserveOn ? '已预留' : '—');
    setField('status', status);

    let passPrompt;
    if (!stampIn) passPrompt = '待分配';
    else if (!identityOn) passPrompt = '复制 sampling';
    else if (p < T.encode) passPrompt = 'R0 已分配';
    else passPrompt = '已交出';
    setPass('prompt', passPrompt, p >= T.encode ? 'done' : identityOn ? 'live' : null);

    let passTokens;
    if (p < T.encode) passTokens = '等待';
    else if (kind === 'ids' && written >= n) passTokens = `${n} int32`;
    else if (written >= n) passTokens = `${n} int32`;
    else passTokens = `${written}/${n}`;
    if (sequenceStarted) passTokens = '已交出';
    setPass('tokens', passTokens, p >= T.sequence ? 'done' : p >= T.encode ? 'live' : null);

    let passSequence;
    if (!sequenceStarted) passSequence = '未建档';
    else if (p < T.seqTokens) passSequence = '接收 tokens';
    else if (p < T.enqueue) passSequence = '待入队';
    else passSequence = '已入队';
    setPass('sequence', passSequence, p >= T.enqueue ? 'done' : sequenceStarted ? 'live' : null);

    let passQueue;
    if (!enqueueStarted) passQueue = '空';
    else if (!ticketIn) passQueue = '接收中';
    else passQueue = 'WAITING';
    setPass('queue', passQueue, held ? 'done' : enqueueStarted ? 'live' : null);

    setText(refs.idBadge, identityOn ? 'R0' : '未分配');
    refs.idBadge.classList.toggle('is-unset', !identityOn);

    let idMeta;
    if (!stampIn) idMeta = `${definition.traceMeta} · 还没有 request_id`;
    else if (!identityOn) idMeta = `${definition.traceMeta} · sampling 已复制`;
    else if (p < T.encode) idMeta = `${n} 个 token 待${kind === 'ids' ? '复用' : '编码'} · request_id 已分配`;
    else if (p < T.sequence) {
      idMeta = kind === 'ids'
        ? `${visibleTokens}/${n} 个 int32 复用中`
        : `${visibleTokens}/${n} 个 int32 编码中`;
    } else if (p < T.enqueue) {
      idMeta = `${n} 个 int32 · input.tokens ${seqVisible >= n ? '已写入' : '写入中'}`;
    } else if (p < T.queueArrive) {
      idMeta = `${n} 个 int32 · 写入 arrival_time`;
    } else if (p < T.reserve) {
      idMeta = `${n} 个 int32 · 预留输出容量`;
    } else {
      idMeta = `${n} 个 int32 · waiting · cache 0`;
    }
    setText(refs.idMeta, idMeta);

    let stageState;
    if (!identityOn) stageState = '入口';
    else if (p < T.encode) stageState = '身份已分配';
    else if (p < T.sequence) stageState = `${kind === 'ids' ? '复用' : '编码'} ${visibleTokens}/${n}`;
    else if (p < T.enqueue) stageState = seqVisible >= n ? 'Sequence 建档' : '接收 tokens';
    else if (p < T.hold) stageState = ticketIn ? '推入 waiting' : '入队中';
    else stageState = 'waiting';
    setText(refs.stageState, stageState);

    let dossierHint;
    if (!identityOn) dossierHint = '尚未创建';
    else if (!sequenceStarted) dossierHint = '身份已分配 · 待建档';
    else if (p < T.enqueue) dossierHint = 'cache 0 · state -1 · 待入队';
    else if (p < T.hold) dossierHint = 'arrival 已写入 · WAITING';
    else dossierHint = 'WAITING · 无 forward';
    setText(refs.dossierHint, dossierHint);

    const pass1 = clamp01((p - 0.13) / 0.05);
    const pass2 = clamp01((p - T.sequence) / (T.seqTokens - T.sequence));
    const pass3 = clamp01((p - T.enqueue) / (T.queueArrive - T.enqueue));

    setLink('to-tokens', {
      pass: pass1,
      visible: p >= T.identityOn,
      active: p >= T.identityOn && p < T.encoded,
      done: p >= T.encoded,
      action: p < T.identity
        ? '分配 R0'
        : p < T.encoded
          ? '入口 → tokenizer'
          : '已交给 tokenizer',
      id: identityOn ? 'R0' : 'req',
      meta: p < T.encoded ? definition.traceMeta : '已编码'
    });

    setLink('to-sequence', {
      pass: pass2,
      visible: sequenceStarted,
      active: sequenceStarted && p < T.seqFields,
      done: p >= T.seqFields,
      action: !sequenceStarted
        ? 'tokenizer → Sequence'
        : p < T.seqTokens
          ? '写入 input.tokens'
          : '已写入 input.tokens',
      id: 'R0',
      meta: seqVisible >= n ? '已写入' : `${seqVisible}/${n} ids`
    });

    setLink('to-waiting', {
      pass: pass3,
      visible: enqueueStarted,
      active: enqueueStarted && p < T.reserve,
      done: p >= T.reserve,
      action: !enqueueStarted
        ? 'Sequence → waiting'
        : p < T.queueArrive
          ? 'push R0'
          : '已进入 waiting',
      id: 'R0',
      meta: ticketIn ? '已入队' : 'Sequence'
    });

    const narrationState = {
      written,
      stampIn,
      identityOn,
      sequenceStarted,
      seqVisible,
      enqueueStarted,
      ticketIn
    };
    setText(refs.live, `${phase.label}｜${narrative(phaseIndex, p, narrationState)}`);

    if (refs.count) {
      const percent = Math.round(p * 100);
      if (percent !== lastPercent) {
        lastPercent = percent;
        refs.count.textContent = `${String(percent).padStart(2, '0')}%`;
        refs.count.setAttribute('aria-label', `动画进度 ${percent}%`);
      }
    }

    if (refs.time) {
      const seconds = (p * DURATION / 1000).toFixed(1);
      const timeText = `${seconds}s / ${(DURATION / 1000).toFixed(1)}s`;
      if (timeText !== lastTime) {
        lastTime = timeText;
        refs.time.textContent = timeText;
      }
    }

    if (refs.scrub) {
      const rangeValue = String(Math.round(p * 1000));
      if (refs.scrub.value !== rangeValue) refs.scrub.value = rangeValue;
      const valueText = `${phase.label}，${Math.round(p * 100)}%`;
      if (refs.scrub.getAttribute('aria-valuetext') !== valueText) {
        refs.scrub.setAttribute('aria-valuetext', valueText);
      }
    }
    setText(refs.phaseLabel, phase.label);

    if (phaseIndex !== activeChapter && refs.steps) {
      activeChapter = phaseIndex;
      $$('[data-jump]', refs.steps).forEach((button, i) => {
        const active = i === phaseIndex;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
      });
    }

    if (refs.prev) refs.prev.disabled = p <= 0.0001;
    if (refs.next) refs.next.disabled = p >= 0.9999;
    syncPlayButton();
  }

  function pause() {
    if (!playing) return;
    playing = false;
    if (raf) window.cancelAnimationFrame(raf);
    raf = 0;
    lastTs = 0;
    root.classList.remove('is-playing');
    syncPlayButton();
  }

  function tick(timestamp) {
    if (!playing) return;
    if (!lastTs) lastTs = timestamp;
    const delta = Math.min(timestamp - lastTs, 100);
    lastTs = timestamp;
    progress += delta / DURATION;
    if (progress >= 1) {
      progress = 1;
      playing = false;
      raf = 0;
      lastTs = 0;
      root.classList.remove('is-playing');
      render();
      return;
    }
    render();
    raf = window.requestAnimationFrame(tick);
  }

  function startPlayback() {
    if (reduced) return;
    if (progress >= 0.999) progress = 0;
    playing = true;
    lastTs = 0;
    root.classList.add('is-playing');
    syncPlayButton();
    render();
    raf = window.requestAnimationFrame(tick);
  }

  function seekTo(value) {
    if (playing) pause();
    progress = clamp01(value);
    render();
  }

  function moveChapter(direction) {
    const index = phaseIndexAt(progress);
    if (direction < 0) {
      seekTo(index <= 0 ? 0 : PHASES[index - 1].start);
    } else {
      seekTo(index >= PHASES.length - 1 ? 1 : PHASES[index + 1].start);
    }
  }

  function setKind(nextKind) {
    if (nextKind === kind) return;
    if (playing) pause();
    kind = nextKind;
    progress = reduced ? 1 : 0;
    updateKindCopy();
    buildTokens();
    render();
  }

  function syncMotionMode() {
    reduced = reducedQuery.matches;
    refs.motionNote.hidden = !reduced;
    root.classList.toggle('is-reduced', reduced);
    if (reduced) {
      if (playing) pause();
      progress = 1;
      render();
    } else {
      syncPlayButton();
      render();
    }
  }

  refs.play.addEventListener('click', () => {
    if (playing) pause();
    else startPlayback();
  });
  refs.prev.addEventListener('click', () => moveChapter(-1));
  refs.next.addEventListener('click', () => moveChapter(1));
  refs.reset.addEventListener('click', () => {
    if (playing) pause();
    progress = 0;
    render();
  });

  refs.scrub.addEventListener('input', () => {
    if (playing) pause();
    progress = Number(refs.scrub.value) / 1000;
    render();
  });

  refs.kindButtons.forEach((button) => {
    button.addEventListener('click', () => setKind(button.dataset.inputKind));
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
  });

  const onReducedChange = () => syncMotionMode();
  if (typeof reducedQuery.addEventListener === 'function') {
    reducedQuery.addEventListener('change', onReducedChange);
  } else if (typeof reducedQuery.addListener === 'function') {
    reducedQuery.addListener(onReducedChange);
  }

  buildChapters();
  updateKindCopy();
  buildTokens();
  if (reduced) {
    progress = 1;
  }
  refs.motionNote.hidden = !reduced;
  root.classList.toggle('is-reduced', reduced);
  render();
})();
