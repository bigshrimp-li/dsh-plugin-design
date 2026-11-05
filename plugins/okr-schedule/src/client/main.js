import { $, B, I, esc, iso, monthShift, options, shift, uid } from './common.js';
import { api as request } from './api.js';
import { calendarBounds, createCalendarUI } from './calendar.js';
import { createEventDialog } from './event-dialog.js';
import { createShell } from './shell.js';
import { createSpaceUI } from './space.js';
import { createAssistantUI } from './assistant.js';

async function api(...args) {
  const data = await request(...args);
  if (data?.documentWarning) {
    ui.documentWarning = data.documentWarning;
    toast(data.documentWarning);
  }
  if (args[0] === 'calendar.export') ui.documentWarning = null;
  return data;
}
const today = () => iso(new Date());
const db = { spaces: [], events: [], draft: null };
const ui = {
  view: 'calendar',
  sid: '',
  date: today(),
  cal: 'month',
  shown: new Set(),
  zoom: 1,
  chatWidth: 306,
  chat: innerWidth >= 1010,
  krView: 'pending',
  filters: Object.create(null),
  pending: Object.create(null),
  modal: null,
  fit: 'wide',
  warnings: [],
};
const ctx = { db, ui, api, today, refresh, render, openModal, closeModal, openDelete, goSpace, toast };
const shell = createShell(ctx);
Object.assign(ctx, shell);
const calendar = createCalendarUI(ctx);
const eventDialog = createEventDialog(ctx);
Object.assign(ctx, { openNewEvent: eventDialog.openNewEvent, openEvent: eventDialog.openEvent });
ctx.spaceUI = createSpaceUI(ctx);
ctx.assistantUI = createAssistantUI(ctx);

let generation = 0,
  initialized = false,
  toastTimer,
  modalOpener;
const goal = (id) => db.spaces.find((s) => s.id === id);
const overlay = () => ['small', 'narrow'].includes(ui.fit);

function toast(text) {
  const element = $('#toast');
  element.textContent = text;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 4000);
}
function showError(error) {
  const message = error?.message || '操作未完成';
  const field = $('#dialog-error');
  if (field) field.textContent = message;
  else toast(message);
}
function tellHost(type, oid) {
  parent.postMessage({ type, oid }, location.origin);
}
function warningText(problem) {
  if (typeof problem === 'string') return problem;
  const name = goal(problem?.objectiveId)?.name || problem?.objectiveId;
  return [name, problem?.message || problem?.error?.message || problem?.reason || '该空间的部分安排未能读取']
    .filter(Boolean)
    .join(' · ');
}

async function refresh() {
  const version = ++generation;
  const { view, sid, date, cal } = ui;
  // The catalog contains public metadata only. Load private facts for the open O.
  let catalog,
    range = { events: [], errors: [] },
    local;
  try {
    if (view === 'calendar') {
      [catalog, range] = await Promise.all([
        api('calendar.catalog'),
        api('calendar.range', calendarBounds(date, cal)),
      ]);
    } else {
      catalog = await api('calendar.catalog');
    }
    if (view === 'space' && catalog.spaces.some((g) => g.id === sid && g.migrated !== false))
      local = await api('calendar.space', {}, sid);
  } catch (error) {
    if (version !== generation) return;
    ui.warnings = ['读取失败，当前显示的数据可能不完整。' + error.message];
    render();
    throw error;
  }
  if (version !== generation) return;
  const oldIds = new Set(db.spaces.map((s) => s.id));
  db.spaces = catalog.spaces;
  db.pendingDeletes = catalog.pendingDeletes || [];
  if (local?.goal) db.spaces = db.spaces.map((s) => (s.id === local.goal.id ? { ...s, ...local.goal } : s));
  for (const space of db.spaces) if (!initialized || !oldIds.has(space.id)) ui.shown.add(space.id);
  for (const oid of ui.shown) if (!goal(oid)) ui.shown.delete(oid);
  if (!goal(ui.sid)) {
    ui.sid = db.spaces[0]?.id || '';
    if (view === 'space') ui.view = 'calendar';
  }
  db.events = local ? local.events : range.events;
  ui.warnings = [
    ...new Set(
      [...(catalog.errors || []), ...(range.errors || []), ...(local?.warnings || [])].map(warningText),
    ),
  ];
  if (!(catalog.errors || []).length) ctx.spaceUI.reconcileDraft?.();
  initialized = true;
  $('#app').removeAttribute('aria-busy');
  render();
}
async function loadAssistant() {
  if (ui.chat || ui.view === 'creator') await ctx.assistantUI.load();
}
async function goCalendar() {
  closeModal();
  ui.view = 'calendar';
  await refresh();
  await loadAssistant();
}
async function goSpace(oid) {
  closeModal();
  const space = goal(oid) || db.spaces[0];
  if (!space) {
    openModal('choose');
    return;
  }
  if (space.migrated === false) {
    openModal('legacy', { oid: space.id });
    return;
  }
  ui.sid = space.id;
  ui.krView = 'pending';
  ui.view = 'space';
  delete ui.filters[ui.sid];
  delete ui.pending[ui.sid];
  if (overlay()) ui.chat = false;
  await refresh();
  $('#mainpane')?.scrollTo(0, 0);
  await loadAssistant();
}
function render(opts = {}) {
  const elements = ['#mainpane', '#kr-list', '#chatlog', '.draftpane', '#studiolog'];
  const scrolls = elements.map((selector) => $(selector)?.scrollTop || 0);
  shell.sizeUI();
  const warnings = [...ui.warnings, ...(ui.documentWarning ? [ui.documentWarning] : [])];
  const warning = warnings.length
    ? '<div class="warning" role="alert">' +
      esc(warnings.join('；')) +
      ' ' +
      B('refresh', '重新读取', 'minilink') +
      '</div>'
    : '';
  const cleanup =
    ui.view === 'calendar'
      ? (db.pendingDeletes || [])
          .map(
            (entry) =>
              '<div class="warning">「' +
              esc(entry.name || entry.id) +
              '」还有本地文件或索引待清理。 ' +
              B('retry-delete', '继续清理', 'btn small', entry.id) +
              '</div>',
          )
          .join('')
      : '';
  const hasLocal = goal(ui.sid)?.ks;
  const body =
    ui.view === 'creator'
      ? ctx.spaceUI.creatorPage()
      : shell.shell(
          warning + cleanup + (ui.view === 'space' && hasLocal ? ctx.spaceUI.spacePage() : calendar.page()),
        );
  $('#app').innerHTML = body;
  // Open forms own their DOM and in-progress input. An assistant refresh must not erase either.
  if (!ui.modal) drawModal();
  shell.sizeUI();
  elements.forEach((selector, i) => {
    const el = $(selector);
    if (!el) return;
    el.scrollTop = opts.top
      ? 0
      : (selector === '#chatlog' && opts.chatEnd) || (selector === '#studiolog' && opts.chatEnd)
        ? el.scrollHeight
        : scrolls[i];
  });
}
function openModal(type, details = {}) {
  if (!ui.modal) modalOpener = document.activeElement;
  ui.modal = { ...details, type };
  drawModal();
  $('.modal')?.focus();
}
function closeModal() {
  ui.modal = null;
  drawModal();
  if (modalOpener?.isConnected) modalOpener.focus({ preventScroll: true });
  modalOpener = null;
}
function openDelete(oid = '') {
  openModal('delete', { oid: oid || '', locked: !!oid, requestId: uid('web') });
  if (oid) return loadImpact(ui.modal, oid);
}
async function loadImpact(modal, oid) {
  modal.oid = oid;
  delete modal.impact;
  drawModal();
  if (!oid) return;
  const snapshot = await api('calendar.space', {}, oid);
  if (ui.modal !== modal || modal.oid !== oid) return;

  modal.impact = {
    ks: snapshot.goal.ks.length,
    events: goal(oid)?.eventCount ?? new Set(snapshot.events.map((e) => e.id)).size,
    chats: snapshot.sessionCount,
  };
  drawModal();
}
function modalContent(m) {
  const cancel = B('close', '取消', 'btn ghost');
  if (m.type === 'choose')
    return {
      title: '打开目标空间',
      body: db.spaces
        .map((s) =>
          B(
            'space',
            '<b>' +
              esc(shell.spaceLabel(s)) +
              '</b><small>' +
              (s.migrated === false
                ? '旧空间 · 查看与迁移'
                : (s.kCount ?? s.ks?.length ?? 0) + ' 个 K · ' + (s.eventCount ?? 0) + ' 项安排') +
              '</small>',
            'menu-entry',
            s.id,
          ),
        )
        .join(''),
      actions: B('create', '创建空间', 'btn primary'),
    };
  if (m.type === 'goals')
    return {
      title: '选择显示的目标',
      body: shell.goalRows() + B('all-goals', '全选', 'btn small') + B('no-goals', '清空', 'btn small'),
      actions: B('close', '完成', 'btn primary'),
    };
  if (m.type === 'legacy')
    return {
      title: shell.spaceLabel(goal(m.oid)),
      body: '旧空间可在记录工作台查看。迁移前请先检查原文件和备份。',
      actions: cancel + B('legacy', '打开记录工作台', 'btn primary', m.oid),
    };
  if (m.type === 'retry-delete') {
    const entry = db.pendingDeletes?.find((item) => item.id === m.oid);
    if (!entry) return;
    return {
      title: '继续清理已删除空间',
      body:
        '上次删除「' +
        esc(entry.name || entry.id) +
        '」后，部分文件或索引仍待清理。空间标识为 ' +
        esc(entry.id) +
        '。',
      actions: cancel + B('confirm-delete', '确认继续清理', 'btn danger'),
    };
  }
  if (m.type === 'delete') {
    const choices = db.spaces.filter((s) => s.migrated !== false);
    const select = m.locked
      ? ''
      : '<label class="field">要删除的空间<select id="delete-target">' +
        options([['', '请选择一个空间'], ...choices.map((s) => [s.id, shell.spaceLabel(s)])], m.oid) +
        '</select></label>';
    const impact = m.impact
      ? '<p>将删除 <strong>' +
        esc(shell.spaceLabel(goal(m.oid))) +
        '</strong>，包括 ' +
        m.impact.ks +
        ' 对 K/R、' +
        m.impact.events +
        ' 件事项、' +
        m.impact.chats +
        ' 个空间会话，以及配置、关联草稿和本地目录。已导出的副本保留。</p>'
      : m.oid
        ? '正在核对影响范围…'
        : '';
    return {
      title: '删除整个空间',
      body: select + impact,
      actions: cancel + B('confirm-delete', '确认删除整个空间', 'btn danger', '', m.impact ? '' : 'disabled'),
    };
  }
  return eventDialog.modal(m.type, m) || ctx.spaceUI.modal?.(m.type, m) || ctx.assistantUI.modal?.(m.type, m);
}
function drawModal() {
  const root = $('#layers'),
    m = ui.modal;
  $('#app').inert = !!m;
  if (!m) {
    root.replaceChildren();
    return;
  }
  const content = modalContent(m);
  if (!content) {
    ui.modal = null;
    drawModal();
    return;
  }
  root.innerHTML =
    '<div class="shade"><section class="modal" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div class="dialoghead"><h2 id="dialog-title">' +
    esc(content.title) +
    '</h2>' +
    I('close', 'close', '关闭') +
    '</div><div class="modalbody">' +
    (content.body || '') +
    '</div><div id="dialog-error" role="alert" class="field-error"></div><div class="actions">' +
    (content.actions || '') +
    '</div></section></div>';
}
async function dispatch(action, value, el) {
  switch (action) {
    case 'host':
      return tellHost('okr-return-to-dsh');
    case 'legacy':
      return tellHost('okr-open-workbench', value || null);
    case 'calendar':
      return goCalendar();
    case 'space':
      return goSpace(value || ui.sid);
    case 'choose-space':
      return openModal('choose');
    case 'goals':
      return openModal('goals');
    case 'close':
      return closeModal();
    case 'refresh':
      return refresh();
    case 'create':
      closeModal();
      return ctx.spaceUI.startCreate();
    case 'adjust':
      return ctx.spaceUI.startCreate(ui.sid);
    case 'chat-toggle':
      ui.chat = !ui.chat;
      render({ chatEnd: true });
      return loadAssistant();
    case 'today':
      ui.date = today();
      return refresh();
    case 'prev':
    case 'next': {
      const n = action === 'prev' ? -1 : 1;
      ui.date = ui.cal === 'month' ? monthShift(ui.date, n) : shift(ui.date, n * (ui.cal === 'week' ? 7 : 1));
      return refresh();
    }
    case 'select-date':
      ui.date = value;
      return refresh();
    case 'go-day':
      ui.date = value;
      ui.cal = 'day';
      return refresh();
    case 'cal-mode':
      ui.cal = value;
      return refresh();
    case 'all-goals':
    case 'no-goals':
      ui.shown = new Set(action === 'all-goals' ? db.spaces.map((s) => s.id) : []);
      render();
      if (ui.modal) drawModal();
      return;
    case 'retry-delete':
      return openModal('retry-delete', { oid: value, requestId: uid('web') });
    case 'delete-global':
      return openDelete();
    case 'delete-space':
      return openDelete(value || ui.sid);
    case 'confirm-delete': {
      const m = ui.modal;
      if (
        !(
          (m?.type === 'delete' && m.impact) ||
          (m?.type === 'retry-delete' && db.pendingDeletes?.some((entry) => entry.id === m.oid))
        )
      )
        return;
      await api('calendar.delete', { confirm: true, requestId: m.requestId }, m.oid);
      ctx.spaceUI.dropDeleted?.(m.oid);
      ctx.assistantUI.invalidate?.(m.oid);
      delete ui.filters[m.oid];
      delete ui.pending[m.oid];
      await goCalendar();
      toast('已删除整个空间');
      return;
    }
    case 'new-event':
      return eventDialog.openNewEvent(ui.view === 'space' ? ui.sid : null);
    case 'event': {
      const matches = db.events.filter(
        (e) =>
          e.id === value &&
          (!el.dataset.oid || e.oid === el.dataset.oid) &&
          (!el.dataset.date || e.date === el.dataset.date),
      );
      const event = matches.find((e) => e.occurrenceKey === el.dataset.occurrence) || matches[0];
      if (!event) throw new Error('这条事项当前不可用。');
      return eventDialog.openEvent(event);
    }
    default:
      if (await eventDialog.dispatch(action)) return;
      if (await ctx.spaceUI.dispatch(action, value, el)) return;
      await ctx.assistantUI.dispatch(action, value, el);
  }
}
function run(work) {
  Promise.resolve().then(work).catch(showError);
}
document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-act]');
  if (el && !el.disabled) {
    const action = el.dataset.act;
    if (el.dataset.working) return;
    el.dataset.working = '1';
    run(() => dispatch(action, el.dataset.v, el).finally(() => delete el.dataset.working));
  } else if (event.target.matches('.shade')) closeModal();
  else if (event.target.closest('[data-cell]'))
    run(() => dispatch('select-date', event.target.closest('[data-cell]').dataset.cell));
});
document.addEventListener('change', (e) =>
  run(async () => {
    const el = e.target;
    if (el.id === 'scale') {
      const wasOverlay = overlay();
      ui.zoom = Number(el.value);
      shell.sizeUI();
      if (!wasOverlay && overlay()) ui.chat = false;
      render();
      return;
    }
    if (el.id === 'delete-target') return loadImpact(ui.modal, el.value);
    if (el.hasAttribute('data-filter-goal')) {
      const oid = el.dataset.filterGoal;
      if (el.checked) ui.shown.add(oid);
      else ui.shown.delete(oid);
      render();
      return;
    }
    await ctx.spaceUI.onChange?.(el);
    await ctx.assistantUI.onChange?.(el);
  }),
);
document.addEventListener('input', (e) =>
  run(async () => {
    await ctx.spaceUI.onInput?.(e.target, e);
    await ctx.assistantUI.onInput?.(e.target);
  }),
);
document.addEventListener('submit', (e) => {
  e.preventDefault();
  run(() => ctx.assistantUI.onSubmit?.(e.target));
});
document.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Escape') {
    if (ui.modal) {
      e.preventDefault();
      closeModal();
    } else if (ui.view === 'creator') run(() => dispatch('creator-back'));
    else if (ui.chat && overlay()) run(() => dispatch('chat-toggle'));
    return;
  }
  if (ui.modal && e.key === 'Tab') {
    const targets = [
      ...$('.modal').querySelectorAll(
        'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)',
      ),
    ];
    if (
      targets.length &&
      ((e.shiftKey && [$('.modal'), targets[0]].includes(document.activeElement)) ||
        (!e.shiftKey && document.activeElement === targets.at(-1)))
    ) {
      e.preventDefault();
      (e.shiftKey ? targets.at(-1) : targets[0]).focus();
    }
  }
  if (e.target.matches('.splitter') && ['ArrowLeft', 'ArrowRight'].includes(e.key)) {
    e.preventDefault();
    ui.chatWidth = Math.max(225, Math.min(540, ui.chatWidth + (e.key === 'ArrowLeft' ? 20 : -20)));
    shell.sizeUI();
  }
  ctx.spaceUI.onKeyDown?.(e);
  ctx.assistantUI.onKeyDown?.(e);
});
let drag = null;
document.addEventListener('pointerdown', (e) => {
  const splitter = e.target.closest('.splitter');
  if (!splitter) return;
  drag = { x: e.clientX, width: $('.assistant').getBoundingClientRect().width / ui.zoom, id: e.pointerId };
  splitter.setPointerCapture(e.pointerId);
  e.preventDefault();
});
document.addEventListener('pointermove', (e) => {
  if (drag?.id === e.pointerId) {
    ui.chatWidth = Math.max(225, Math.min(540, drag.width + (drag.x - e.clientX) / ui.zoom));
    shell.sizeUI();
  }
});
for (const name of ['pointerup', 'pointercancel'])
  document.addEventListener(name, () => {
    drag = null;
  });
let lastLocalDay = today();
function checkDay() {
  const day = today();
  if (lastLocalDay !== day) {
    lastLocalDay = day;
    render();
  }
}
window.addEventListener('focus', checkDay);
setInterval(checkDay, 60000);
window.addEventListener('resize', () => {
  const previous = overlay();
  shell.sizeUI();
  if (!previous && overlay() && ui.chat) {
    ui.chat = false;
    render();
  }
});
run(async () => {
  await refresh();
  await loadAssistant();
});
