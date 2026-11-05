import { $, esc, uid, icon, B, I, options, inkFor, shift } from './common.js';

const examples = [
  ['创建摄影练习空间，四周掌握构图，周六 10:00 外拍，按类型分组', '摄影练习'],
  ['创建英语自学空间，四周掌握 120 个新词，八周听懂日常对话，周六 19:30 学单词', '英语自学'],
  ['创建记账空间，按月用卡片展示消费和收入，周六 19:30 核账', '日常记账'],
];
const actionLabels = {
  preview: '查看事项区预览',
  feedback: '核对反馈草稿',
  policy: '在创造模式核对规则',
  adjust: '调整目标',
  create: '创建空间',
  space: '进入目标空间',
  delete: '查看删除流程',
};
function bucket(data) {
  return data.sessions?.length
    ? data
    : { active: 'initial', sessions: [{ id: 'initial', name: '会话 1', messages: [], input: '' }] };
}
export function createAssistantUI(ctx) {
  const { ui, db, api, render, toast } = ctx;
  const cache = new Map(),
    loads = new Map(),
    busy = new Set(),
    inputTimers = new Map(),
    saving = new Map(),
    epoch = new Map();
  function scope() {
    return ui.view === 'space' ? ui.sid : ui.view === 'creator' ? db.draft?.id : 'global';
  }
  function owner(s) {
    return s === 'global' ? null : s;
  }
  function group(s = scope()) {
    if (!cache.has(s)) cache.set(s, bucket({}));
    return cache.get(s);
  }
  function current(s = scope()) {
    const g = group(s);
    return g.sessions.find((v) => v.id === g.active) || g.sessions[0];
  }
  function merge(s, data) {
    // Input is edited locally while requests are in flight. Never replace newer typing.
    const next = bucket(data),
      prev = cache.get(s);
    for (const row of next.sessions) {
      const key = s + '|' + row.id;
      if (inputTimers.has(key) || saving.has(key))
        row.input = prev?.sessions?.find((c) => c.id === row.id)?.input ?? row.input;
    }
    cache.set(s, next);
  }
  // Only unacknowledged keystrokes live in tab storage. Once the Host saves
  // the input, SQLite is the sole source. A fast reload can restore the last key.
  const draftPrefix = 'okr.calendar.assistant.pending.';
  function pendingInput(key, value) {
    try {
      if (value === undefined) return sessionStorage.getItem(draftPrefix + key);
      if (value === null) sessionStorage.removeItem(draftPrefix + key);
      else sessionStorage.setItem(draftPrefix + key, value);
    } catch {
      /* Host persistence still works if browser storage is disabled. */
    }
    return null;
  }
  const ready = new Set();
  async function load(force = false) {
    if (ui.view === 'creator') return;
    const s = scope(),
      generation = epoch.get(s) || 0;
    if (ready.has(s) && !force) return;
    if (loads.has(s)) return loads.get(s);
    const run = api('assistant.list', {}, owner(s))
      .then((data) => {
        if ((epoch.get(s) || 0) !== generation) return;
        merge(s, data);
        for (const session of group(s).sessions) {
          const key = s + '|' + session.id,
            unsaved = pendingInput(key);
          if (unsaved !== null && !inputTimers.has(key) && !saving.has(key)) {
            session.input = unsaved;
            saveInput(s, session);
          }
        }
        ready.add(s);
        if (s === scope()) render();
      })
      .catch((e) => {
        if (s === scope()) toast(e.message);
      })
      .finally(() => loads.delete(s));
    loads.set(s, run);
    return run;
  }
  function invalidate(oid) {
    if (!oid) {
      ready.clear();
      cache.clear();
      return;
    }
    epoch.set(oid, (epoch.get(oid) || 0) + 1);
    ready.delete(oid);
    for (const row of cache.get(oid)?.sessions || []) pendingInput(oid + '|' + row.id, null);
    cache.delete(oid);
    for (const [key, t] of inputTimers)
      if (key.startsWith(oid + '|')) {
        clearTimeout(t);
        inputTimers.delete(key);
      }
  }
  function viewMessage(m) {
    if (!m.covered?.length && !m.refs?.length) return m;
    const ids = new Set(db.spaces.map((s) => s.id));
    if (m.covered?.some((id) => !ids.has(id)) || m.refs?.some((r) => r && !ids.has(r.oid)))
      return {
        ...m,
        text: '部分来源已失效，请重新查询。',
        refs: (m.refs || []).map((r) => (r && ids.has(r.oid) ? r : null)),
        action: null,
      };
    return m;
  }
  function message(original) {
    const m = viewMessage(original),
      user = m.role === 'user';
    const links = (m.refs || [])
      .map((r, index) =>
        r
          ? B(
              'assistant-ref',
              icon(r.kind === 'k' ? 'target' : 'calendar') +
                '<span class="source-text"><b>' +
                esc(r.title) +
                '</b><small>' +
                esc(r.detail) +
                '</small></span>' +
                icon('right'),
              'source',
              m.id,
              'data-index="' + index + '"',
            )
          : null,
      )
      .filter(Boolean);
    const sources = links.length
      ? '<section class="msg-sources" aria-label="这条答复引用的记录"><span class="source-label">引用记录</span>' +
        links.slice(0, 2).join('') +
        (links.length > 2
          ? '<details class="source-more"><summary>展开其余 ' +
            (links.length - 2) +
            ' 条</summary>' +
            links.slice(2).join('') +
            '</details>'
          : '') +
        '</section>'
      : '';
    const action = m.action,
      preview = action?.kind === 'preview';
    const actionAvailable =
      action &&
      (!preview || (ui.pending?.[ui.sid]?.id === m.id && ui.pending[ui.sid].sessionId === current().id));
    return (
      '<article class="msg ' +
      (user ? 'user' : '') +
      '"><div class="author">' +
      (user ? '你' : m.role === 'status' ? '服务状态' : icon('ai') + ' 助手') +
      '</div><div class="bubble">' +
      esc(m.text) +
      '</div>' +
      sources +
      (actionAvailable
        ? '<div class="msg-actions">' +
          B('assistant-action', actionLabels[action.kind], 'btn small soft', m.id) +
          '</div>'
        : '') +
      '</article>'
    );
  }
  function starters() {
    if (ui.view !== 'space')
      return db.spaces.length && db.events.length
        ? [ui.date === ctx.today() ? '今天做什么' : '选中日有哪些安排', '查看本周安排']
        : [];
    const g = db.spaces.find((g) => g.id === ui.sid),
      rows = db.events.filter((e) => e.oid === ui.sid),
      questions = [];
    if (g?.bookkeeping && rows.some((e) => e.status === 'done' && e.posting))
      questions.push('本月收入和支出各多少');
    else if (g?.ks?.length) questions.push('查看目标进展');
    if (rows.some((e) => e.status === 'plan' && e.date >= ctx.today() && e.date <= shift(ctx.today(), 6)))
      questions.push('未来 7 天待执行事项');
    return questions;
  }
  function compose(creator, c, prompt) {
    const waiting = busy.has(creator ? c.id : scope() + '|' + c.id);
    let suggestions = '';
    if (!c.messages.length) {
      if (creator && !c.goal && c.mode !== 'edit')
        suggestions =
          '<div class="compose-starters" ' +
          (c.input ? 'hidden' : '') +
          '><label class="example-select">目标示例<select id="creator-example" aria-label="填写目标示例">' +
          options([['', '选择示例填入…'], ...examples], '') +
          '</select></label></div>';
      else if (!creator) {
        const qs = starters();
        if (qs.length)
          suggestions =
            '<div class="compose-starters" ' +
            (c.input ? 'hidden' : '') +
            '><span class="starter-label">可以问</span><div class="prompts">' +
            qs
              .map((q) =>
                B('assistant-suggestion', esc(q), 'prompt', q, 'aria-label="发送问题：' + esc(q) + '"'),
              )
              .join('') +
            '</div></div>';
      }
    }
    return (
      '<form class="compose" data-compose="' +
      (creator ? 'creator' : 'assistant') +
      '">' +
      suggestions +
      '<div class="inputwrap"><textarea id="' +
      (creator ? 'studio-input' : 'assistant-input') +
      '" aria-label="' +
      (creator ? '创造模式消息' : '助手消息') +
      '" placeholder="' +
      esc(prompt) +
      '" maxlength="8000">' +
      esc(c.input || '') +
      '</textarea><div class="inputfoot"><span>' +
      (waiting ? '正在处理…' : 'Enter 发送 · Shift+Enter 换行') +
      '</span><button type="submit" class="send" aria-label="' +
      (creator ? '发送给创造助手' : '发送给助手') +
      '" ' +
      (!c.input?.trim() || waiting ? 'disabled' : '') +
      '>' +
      icon('up') +
      '</button></div></div></form>'
    );
  }
  function panel() {
    if (!ui.chat) return '<aside class="assistant" hidden></aside>';
    const local = ui.view === 'space',
      g = db.spaces.find((s) => s.id === ui.sid),
      s = group(),
      c = current(),
      title = local ? '空间助手' : '日程助手';
    return (
      '<aside class="assistant" aria-label="' +
      title +
      '"><div class="splitter" role="separator" aria-label="拖动调整助手宽度" aria-orientation="vertical" aria-valuemin="200" aria-valuemax="540" aria-valuenow="' +
      Number(ui.chatWidth) +
      '" tabindex="0"></div><header class="chathead"><div class="row"><span class="ai-icon">' +
      icon('ai') +
      '</span><div class="grow"><h2>' +
      title +
      '</h2><span class="scope"><i class="dot" style="--c:' +
      inkFor(local ? g : null) +
      '"></i>' +
      (local ? '仅当前空间 · ' + esc(g?.name) : '全局 · 全部目标') +
      '</span></div>' +
      I('chat-toggle', 'panel', '收起聊天侧栏') +
      '</div><div class="sessions"><select id="session" aria-label="切换聊天会话">' +
      options(
        s.sessions.map((c) => [c.id, c.name]),
        c.id,
      ) +
      '</select>' +
      I('assistant-new', 'add', '新建聊天会话') +
      '</div></header><div class="chat-scroll" id="chatlog" aria-live="polite">' +
      c.messages.map(message).join('') +
      '</div>' +
      compose(
        false,
        c,
        local
          ? '询问「' + (g?.name || '当前空间') + '」的记录或视图…'
          : db.spaces.length
            ? '询问日程安排…'
            : '先从顶栏创建一个目标空间…',
      ) +
      '</aside>'
    );
  }
  function creatorChat() {
    const d = db.draft;
    if (!d) return '';
    return (
      '<div class="subhead row">' +
      icon('ai') +
      ' 创造助手</div><div class="dialog-chat" id="studiolog" aria-live="polite">' +
      d.messages.map(message).join('') +
      '</div>' +
      compose(
        true,
        d,
        d.mode === 'edit'
          ? '想调整「' + d.goal.name + '」的哪一项？'
          : d.messages.length
            ? '继续修改方案…'
            : '想建立什么目标？准备何时开始？',
      )
    );
  }
  function saveInput(s, session, immediate = false) {
    const k = s + '|' + session.id;
    clearTimeout(inputTimers.get(k));
    inputTimers.delete(k);
    const doSave = () => {
      inputTimers.delete(k);
      const value = session.input,
        before = saving.get(k);
      const pending = Promise.resolve(before)
        .catch(() => {})
        .then(() => api('assistant.input', { sessionId: session.id, text: value }, owner(s)))
        .then(() => {
          if (pendingInput(k) === value) pendingInput(k, null);
        })
        .catch((e) => {
          if (scope() === s) toast(e.message);
        })
        .finally(() => {
          if (saving.get(k) === pending) saving.delete(k);
        });
      saving.set(k, pending);
      return pending;
    };
    if (immediate) return doSave();
    inputTimers.set(k, setTimeout(doSave, 200));
  }
  function onInput(el) {
    if (!['assistant-input', 'studio-input'].includes(el.id)) return false;
    const creator = el.id === 'studio-input',
      c = creator ? db.draft : current();
    c.input = el.value;
    const form = el.closest('form'),
      start = form?.querySelector('.compose-starters');
    if (start) start.hidden = Boolean(el.value);
    const button = form?.querySelector('[type=submit]');
    if (button) button.disabled = !el.value.trim() || busy.has(creator ? c.id : scope() + '|' + c.id);
    if (creator) ctx.spaceUI.flushDraft();
    else {
      pendingInput(scope() + '|' + c.id, c.input);
      saveInput(scope(), c);
    }
    return true;
  }
  function formContext() {
    return {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      selectedDate: ui.date,
      checked: [...(ui.shown || [])],
      filters: ui.pending?.[ui.sid]?.filters || ui.filters?.[ui.sid],
    };
  }
  function bottom(id) {
    const log = $(id);
    if (log) log.scrollTop = log.scrollHeight;
  }
  async function send(value, kId = null) {
    const question = String(value || '').trim();
    if (!question) return;
    const s = scope(),
      context = formContext();
    if (ui.view === 'creator') {
      const d = db.draft;
      if (!d || busy.has(d.id)) return;
      busy.add(d.id);
      const revision = d.revision,
        history = d.messages.slice(),
        user = { role: 'user', text: question, id: uid('msg') };
      d.messages.push(user);
      d.input = '';
      ctx.spaceUI.flushDraft();
      render();
      bottom('#studiolog');
      try {
        const r = await api(
          'assistant.send',
          {
            ...context,
            text: question,
            draft: { id: d.id, revision, goal: d.goal, events: d.events, messages: history },
          },
          d.baseGoal?.id || null,
        );
        if (db.draft !== d) return;
        if (r.proposal && (revision !== d.revision || !ctx.spaceUI.replaceDraft(r.proposal, revision)))
          d.messages.push({
            role: 'status',
            error: true,
            text: '草稿已有手工修改，本轮方案未应用。请核对后再发送。',
          });
        else d.messages.push(r.message);
      } catch (e) {
        if (db.draft === d) d.messages.push({ role: 'status', error: true, text: e.message });
      } finally {
        busy.delete(d.id);
        if (db.draft === d) {
          ctx.spaceUI.flushDraft();
          if (scope() === s) {
            render();
            bottom('#studiolog');
          }
        }
      }
      return;
    }
    const c = current(s),
      key = s + '|' + c.id,
      generation = epoch.get(s) || 0;
    if (busy.has(key)) return;
    busy.add(key);
    try {
      clearTimeout(inputTimers.get(key));
      inputTimers.delete(key);
      pendingInput(key, null);
      await saving.get(key);
      const messageId = uid('msg');
      c.messages.push({ role: 'user', id: messageId, text: question });
      c.input = '';
      render();
      bottom('#chatlog');
      if (scope() === s && !ui.modal) $('#assistant-input')?.focus();
      const result = await api(
        'assistant.send',
        { ...context, text: question, sessionId: c.id, kId, messageId },
        owner(s),
      );
      if ((epoch.get(s) || 0) !== generation) return;
      merge(s, result);
      const m = result.message;
      if (scope() === s && current(s).id === c.id && m?.action?.kind === 'preview') {
        ctx.spaceUI.previewFromAssistant(m.action, m.id);
        if (ui.pending[s]) ui.pending[s].sessionId = c.id;
      }
      if (scope() === s && current(s).id === c.id && kId && m?.action?.kind === 'feedback')
        ctx.spaceUI.openFeedback(kId, m.action.text);
    } catch (e) {
      toast(e.message);
      await load(true);
    } finally {
      busy.delete(key);
      if (scope() === s) {
        const inputFocused = document.activeElement?.id === 'assistant-input';
        render();
        if (inputFocused && !ui.modal) $('#assistant-input')?.focus();
        bottom('#chatlog');
      }
    }
  }
  function onSubmit(form) {
    if (!form?.matches?.('form[data-compose]')) return false;
    void send(form.querySelector('textarea').value);
    return true;
  }
  function onKeyDown(e) {
    const el = e.target;
    if (
      !['assistant-input', 'studio-input'].includes(el.id) ||
      e.key !== 'Enter' ||
      e.shiftKey ||
      e.isComposing ||
      e.keyCode === 229
    )
      return false;
    e.preventDefault();
    void send(el.value);
    return true;
  }
  async function changeSession(cmd, id) {
    const s = scope(),
      c = current(s),
      key = s + '|' + c.id;
    if (inputTimers.has(key)) await saveInput(s, c, true);
    await saving.get(key);
    const updated = await api('assistant.' + cmd, { sessionId: id }, owner(s));
    merge(s, updated);
    if (ui.pending?.[s]?.sessionId && ui.pending[s].sessionId !== updated.active) delete ui.pending[s];
    render();
    bottom('#chatlog');
  }
  function onChange(el) {
    if (el.id === 'session') {
      void changeSession('select', el.value).catch((e) => toast(e.message));
      return true;
    }
    if (el.id === 'creator-example') {
      const input = $('#studio-input');
      if (input) {
        input.value = el.value;
        onInput(input);
        input.focus();
      }
      return true;
    }
    return false;
  }
  async function dispatch(a, v, el) {
    if (a === 'assistant-new') {
      await changeSession('new');
      return true;
    }
    if (a === 'assistant-suggestion') {
      if (!current().messages.length && !current().input) await send(v);
      return true;
    }
    if (!['assistant-action', 'assistant-ref'].includes(a)) return false;
    const s = scope(),
      session = current(s),
      m = session.messages.find((m) => m.id === v);
    if (!m) return true;
    if (a === 'assistant-ref') {
      const index = Number(el.dataset.index);
      try {
        const result = await api(
          'assistant.reference',
          { sessionId: session.id, messageId: v, ref: m.refs[index] },
          owner(s),
        );
        if (scope() !== s || current(s).id !== session.id) return true;
        if (result.kind === 'k') {
          const k = db.spaces.find((g) => g.id === s)?.ks?.find((k) => k.id === result.record.id);
          if (k) Object.assign(k, result.record);
          ctx.spaceUI.openK(result.record.id);
        } else await ctx.openEvent(result.record);
      } catch (e) {
        if (e.code === 'REFERENCE_GONE') {
          m.refs[index] = null;
          m.text = '部分来源已失效，请重新查询。';
          m.action = null;
        }
        render();
        toast(e.message);
      }
      return true;
    }
    const act = m.action;
    if (!act) return true;
    if (['policy', 'feedback'].includes(act.kind)) {
      const latest = await api('calendar.space', {}, s);
      if (scope() !== s || current(s).id !== session.id) return true;
      if (
        (act.revision != null && act.revision !== latest.goal.revision) ||
        (act.dataRevision != null && act.dataRevision !== latest.goal.dataRevision)
      ) {
        toast('空间已更新，请重新提问后核对最新草稿。');
        return true;
      }
    }
    if (act.kind === 'preview') {
      if (ui.pending?.[s]?.id === m.id) $('.preview-note')?.scrollIntoView({ block: 'center' });
    }
    if (act.kind === 'policy') await ctx.spaceUI.startCreate(s, false, act.text);
    if (act.kind === 'adjust') await ctx.spaceUI.startCreate(s);
    if (act.kind === 'feedback') ctx.spaceUI.openFeedback(act.kId, act.text);
    if (act.kind === 'create') await ctx.spaceUI.startCreate();
    if (['delete', 'space'].includes(act.kind)) {
      if (act.kind === 'delete') await ctx.openDelete(act.oid);
      else if (act.oid) await ctx.goSpace(act.oid);
      else ctx.openModal('choose');
    }
    return true;
  }
  async function startFeedback(kId) {
    const goal = db.spaces.find((g) => g.id === ui.sid),
      k = goal?.ks?.find((k) => k.id === kId);
    if (!k) return;
    ui.chat = true;
    await load();
    render();
    await send('根据同期已完成事项，为「' + k.name + '」起草阶段反馈。', kId);
  }
  return {
    panel,
    creatorChat,
    dispatch,
    onInput,
    onChange,
    onKeyDown,
    onSubmit,
    load,
    invalidate,
    startFeedback,
  };
}
