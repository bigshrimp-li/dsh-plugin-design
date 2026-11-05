import { $, B, clone, empty, esc, icon, layoutDefault, shift, uid, validDate } from './common.js';
import { filterControls, layoutControls, layoutOf, matchEvents, renderGroups, viewDescription } from './space-view.js';

const draftKey = 'okr-schedule:calendar-creation-mode:draft:v1';
function same(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
}

function goalPlan(goal) {
  return [goal.name, goal.about, goal.ks.map(k => [k.id, k.name, k.standard, k.from, k.to])];
}

export function isValidDraft(draft) {
  const g = draft?.goal;
  if (!g?.name?.trim() || [...g.name.trim()].length > 40 || !Array.isArray(g.ks)) return false;
  const onlyConfig = draft.mode === 'edit' && draft.baseGoal && same(goalPlan(g), goalPlan(draft.baseGoal))
    && same(draft.events, draft.baseEvents);
  if (!onlyConfig && (!g.ks.length || !draft.events.length)) return false;
  return (onlyConfig || g.ks.every(k => k.name.trim() && k.standard.trim() && validDate(k.from)
    && validDate(k.to) && k.from <= k.to)) && draft.events.every(e => e.title.trim() && validDate(e.date)
    && /^([01]\d|2[0-3]):[0-5]\d$/.test(e.time) && Number.isInteger(e.duration) && e.duration > 0 && e.duration <= 1440);
}

function minuteStamp(e) {
  // A UTC-based civil-day index avoids changing the wall-clock overlap test at DST transitions.
  return Date.parse(e.date + 'T' + e.time + ':00Z') / 60000;
}

export function overlaps(row, others) {
  const start = minuteStamp(row);
  return others.some(e => e !== row && e.duration > 0 && row.duration > 0 &&
    minuteStamp(e) < start + row.duration && start < minuteStamp(e) + e.duration);
}

const field = (label, key, value, type = 'text', attrs = '') =>
  `<label class="field">${label}<input type="${type}" data-df="${key}" value="${esc(value ?? '')}" ${attrs}></label>`;

function renderDraftGoal(d, today, selectedDate, confirmedGoal) {
  const g = d.goal, l = layoutOf(g), rows = matchEvents(d.events, l.filters, selectedDate, today);
  return `<div class="draft-form">
    <section class="formbox"><h3>目标 O</h3><div class="formgrid">
      ${field('空间名称', 'name', g.name, 'text', 'maxlength="40" required')}
      ${field('目标说明', 'about', g.about)}
      <label class="field-check"><input type="checkbox" data-df="bookkeeping" ${g.bookkeeping ? 'checked' : ''}> 记账空间</label>
    </div></section>
    <section class="formbox"><div class="between"><h3>过程目标的有效期与配对 R</h3>${B('add-k', '＋ K', 'btn small ghost')}</div>
      ${g.ks.map((k, i) => {
        const index = `data-i="${i}"`;
        return `<div class="subform"><div class="formgrid">
          ${field('过程目标', 'k-name', k.name, 'text', index)}
          ${field('达标标准', 'k-standard', k.standard, 'text', index)}
          ${field('开始日期', 'k-from', k.from, 'date', index)}
          ${field('截止日期', 'k-to', k.to, 'date', index)}
          </div><small class="micro">${k.achievedOn ? '已实现 · ' + esc(k.achievedOn) + ' · ' : ''}配对反馈 R · ${esc(k.r || '待反馈')}</small></div>`;
      }).join('')}</section>
    <section class="formbox"><h3>事项区展示方案</h3><div class="formgrid">
      ${layoutControls(g, l, true)}${filterControls(g, d.events, l.filters, true)}</div>
      <div class="subform ${l.dense ? 'dense' : ''}"><h3>事项区预览 · ${rows.length} 项匹配</h3>
        ${renderGroups(rows, l, g, { draft: true })}</div></section>
    <section class="formbox"><label class="field"><h3>空间助手规则</h3>
      <textarea data-df="assistantRule" rows="4" placeholder="以后优先查看什么、如何提问或复盘">${esc(g.assistantRule || '')}</textarea></label>
      ${d.baseGoal ? `<details><summary>查看当前已确认的规则</summary><p style="white-space:pre-wrap">${esc(confirmedGoal?.assistantRule || '尚无专属规则')}</p></details>` : ''}
    </section></div>`;
}

function renderDraftEvents(d, busy) {
  return `<section class="formbox"><div class="between"><h3>拟排事项 · ${d.events.length}</h3>
    ${B('add-draft-event', '＋ 一项', 'btn small ghost')}</div>${d.events.map((e, i) => {
      const index = `data-i="${i}"`;
      return `<div class="subform"><div class="formgrid">
        ${field('事项名称', 'e-title', e.title, 'text', index)}${field('类型', 'e-kind', e.kind, 'text', index)}
        ${field('日期', 'e-date', e.date, 'date', index)}${field('开始时间', 'e-time', e.time, 'time', index)}
        ${field('计划时长（分钟）', 'e-duration', e.duration, 'number', index + ' min="1" max="1440"')}</div>
        <div class="between"><span class="micro">归属 O · ${esc(d.goal.name)}</span>${B('rm-draft-event', '移除此项', 'minilink', i)}</div>
        ${overlaps(e, [...busy, ...d.events]) ? '<p class="micro" style="color:var(--amber)">与其他拟排或已排事项重叠，可改期或保留。</p>' : ''}
      </div>`;
    }).join('') || empty('添加一件有日期的事项。')}</section>`;
}

export function createCreator(ctx) {
  const { db, ui, api, render, toast, openModal, closeModal } = ctx;
  let storageError = false, committing = false, entering = 0;
  let confirmedGoal = null;
  let occupied = [], busyKey = '', busyEpoch = 0, busyTimer;
  try {
    const value = JSON.parse(localStorage.getItem(draftKey));
    if (value?.id && ['new', 'edit'].includes(value.mode) && Array.isArray(value.events)) db.draft = value;
  } catch { storageError = true; }

  function flushDraft() {
    try {
      if (db.draft) localStorage.setItem(draftKey, JSON.stringify(db.draft));
      else localStorage.removeItem(draftKey);
      storageError = false;
    } catch {
      storageError = true;
      toast('无法暂存草稿。请在当前窗口完成编辑。');
    }
  }
  function touchDraft() {
    if (!db.draft) return;
    db.draft.revision++;
    db.draft.dirty = true;
    flushDraft();
  }
  function dropDraft(oid) {
    if (oid && (db.draft?.mode !== 'edit' || db.draft.baseGoal?.id !== oid)) return;
    db.draft = null;
    flushDraft();
  }
  function replaceDraft(proposal, expectedVersion) {
    const d = db.draft;
    if (!d || (expectedVersion != null && d.revision !== expectedVersion)) return false;
    const goal = clone(proposal.goal);
    if (!goal || !Array.isArray(goal.ks) || !Array.isArray(proposal.events)) return false;
    goal.id = d.baseGoal?.id || d.id;
    goal.layout = layoutOf(goal);
    d.goal = goal;
    d.events = clone(proposal.events).map(e => ({ ...e, oid: goal.id }));
    touchDraft();
    updateBusy();
    render();
    return true;
  }
  async function startCreate(oid = null, replace = false, policy = '') {
    const turn = ++entering;
    const original = db.draft;
    const mode = oid ? 'edit' : 'new';
    const different = original && (original.mode !== mode || (oid && original.baseGoal?.id !== oid));
    if (different && !replace && (original.dirty || original.input || original.messages.length)) {
      openModal('switch-draft', { target: oid, policy });
      return;
    }
    const snapshot = oid ? await api('calendar.space', {}, oid) : null;
    if (turn !== entering) return;
    confirmedGoal = snapshot?.goal || null;
    let d = original;
    if (!original || different) {
      const baseGoal = confirmedGoal;
      const baseEvents = (snapshot?.events || []).filter(e => e.status === 'plan' && e.date >= ctx.today() && !e.readOnly);
      d = { id: uid('draft'), mode, revision: 0, input: '', messages: [], dirty: false, goal: clone(baseGoal),
        events: clone(baseEvents), baseGoal, baseEvents };
    }
    if (d.goal) d.goal.layout = layoutOf(d.goal);
    db.draft = d;
    if (policy && d.goal) {
      d.goal.assistantRule = policy;
      touchDraft();
    }
    ui.creatorBack = ui.view === 'space' ? 'space' : 'calendar';
    ui.creatorSid = ui.sid;
    ui.view = 'creator'; ui.studioTab = 'chat'; ui.draftView = 'space';
    closeModal();
    flushDraft(); updateBusy(); render();
    await ctx.assistantUI?.load();
  }

  function updateBusy() {
    const d = db.draft;
    if (!d || ui.view !== 'creator') return;
    const touchedDays = new Set();
    for (const event of d.events) {
      if (!validDate(event.date)) continue;
      touchedDays.add(event.date);
      const start = minuteStamp(event);
      if (Number.isFinite(start) && Number.isInteger(event.duration) && event.duration > 0 && event.duration <= 1440) {
        touchedDays.add(new Date((start + event.duration - 1) * 60000).toISOString().slice(0, 10));
      }
    }
    const days = [...touchedDays].sort();
    const key = [d.id, ...days].join('/');
    if (key === busyKey) return;
    busyKey = key; occupied = []; ui.busyWarning = '';
    const epoch = ++busyEpoch;
    clearTimeout(busyTimer);
    if (!days.length) return;
    busyTimer = setTimeout(async () => {
      try {
        // Query only the days touched by proposed rows, including overnight spill.
        const data = await api('calendar.busy', {
          dates: days, excludeIds: (d.baseEvents || []).map(e => e.id)
        }, d.baseGoal?.id || null);
        if (epoch !== busyEpoch || db.draft !== d) return;
        occupied = data.slots || [];
        if (data.errors?.length) ui.busyWarning = '部分空间的占用时段暂不可用。';
      } catch {
        if (epoch !== busyEpoch || db.draft !== d) return;
        ui.busyWarning = '正式日程的占用时段暂不可用。';
      }
      // Keep an in-progress field (including IME input) mounted while the query resolves.
      updateOverlapHints();
    }, 100);
  }
  function updateOverlapHints() {
    if (ui.view !== 'creator' || ui.draftView !== 'events') return;
    const events = db.draft?.events || [];
    document.querySelectorAll('.draftpane .subform').forEach((node, index) => {
      const row = events[index];
      let hint = node.querySelector('p.micro');
      if (row && overlaps(row, [...occupied, ...events])) {
        if (!hint) { hint = document.createElement('p'); hint.className = 'micro'; hint.style.color = 'var(--amber)'; node.append(hint); }
        hint.textContent = '与其他拟排或已排事项重叠，可改期或保留。';
      } else hint?.remove();
    });
    const warning = $('#busy-warning');
    if (warning) warning.textContent = ui.busyWarning || '';
  }

  function back() {
    const returnSpace = ui.creatorBack === 'space' && db.spaces.some(g => g.id === ui.creatorSid);
    ui.view = returnSpace ? 'space' : 'calendar';
    if (returnSpace) ui.sid = ui.creatorSid;
    ui.modal = null;
    render();
    ctx.assistantUI?.load();
  }
  async function commit() {
    const d = db.draft;
    if (!isValidDraft(d) || committing) return;
    committing = true;
    const button = $('[data-act="commit-draft"]');
    if (button) button.disabled = true;
    try {
      if (d.baseGoal) {
        const fresh = (await api('calendar.space', {}, d.baseGoal.id)).goal;
        confirmedGoal = fresh;
        const conflicts = ['assistantRule', 'layout'].filter(key => !same(d.baseGoal[key], fresh[key])
          && !same(d.baseGoal[key], d.goal[key]) && !same(fresh[key], d.goal[key]));
        if (conflicts.length) {
          openModal('confirm-conflict', { fresh, conflicts });
          return;
        }
      }
      const { objectiveId } = await api('calendar.confirm', {
        draft: { id: d.id, timezone: d.baseGoal?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone, goal: d.goal, events: d.events, baseGoal: d.baseGoal, baseEvents: d.baseEvents },
        confirm: true, requestId: d.id + '-' + d.revision
      }, d.baseGoal?.id || null);
      if (!objectiveId) throw Error('没有收到正式空间标识，草稿已保留。');
      dropDraft();
      ui.view = 'calendar'; ui.modal = null;
      await ctx.refresh();
      ui.shown?.add(objectiveId);
      await ctx.goSpace(objectiveId);
      toast(d.mode === 'edit' ? '方案已应用到原空间。' : '已创建空间，首批事项已进入日历。');
    } finally {
      committing = false;
      if (button?.isConnected) button.disabled = !isValidDraft(db.draft);
    }
  }

  function creatorPage() {
    const d = db.draft;
    if (!d) return '';
    const edit = d.mode === 'edit', verb = edit ? '确定应用' : '确定创建';
    const tabs = (action, pairs, selected, css) => pairs.map(([key, text]) => B(action, text, css(key === selected), key)).join('');
    return `<div class="creator">${ctx.top(true)}
      <div class="creator-heading"><div class="over">CREATOR / ${edit ? 'REVISE' : 'NEW SPACE'}</div>
      <h1>${edit ? '调整目标方案' : '创建一个目标空间'}</h1><p>每轮对话只更新方案草稿。核对预览后，点击「${verb}」才生效。</p></div>
      <div class="studio-nav">${tabs('studio-tab', [['chat','创造对话'], ['plan','方案预览']], ui.studioTab, on => 'btn small ' + (on ? 'soft' : ''))}</div>
      <div class="studio" data-tab="${ui.studioTab}"><section class="studio-chat">${ctx.assistantUI?.creatorChat() || ''}</section>
      <section class="draftpane"><div class="sectionhead"><h2>方案预览</h2><span class="tag">仅草稿 · v${d.revision}</span><span class="grow"></span>
      ${d.goal ? `<div class="seg">${tabs('draft-view', [['space','空间'], ['events','日程']], ui.draftView, on => on ? 'active' : '')}</div>` : ''}</div>
      ${!d.goal ? `<div class="draft-empty"><p>发送目标后，可在这里核对并编辑方案。</p>${B('manual-draft', '手工填写方案', 'btn small ghost')}</div>`
        : ui.draftView === 'space' ? renderDraftGoal(d, ctx.today(), ui.date, confirmedGoal)
        : renderDraftEvents(d, occupied) + '<p id="busy-warning" class="micro">' + esc(ui.busyWarning || '') + '</p>'}</section></div>
      <div class="creator-foot"><span class="micro">${storageError ? '草稿仅保留在当前窗口' : '草稿已暂存在本机'}</span>${B('discard-draft', '放弃草稿', 'btn ghost')}
      ${B('commit-draft', verb, 'btn primary', '', isValidDraft(d) && !committing ? '' : 'disabled')}</div></div>`;
  }
  function modal(type, m) {
    if (type === 'switch-draft') return {
      title: '处理当前草稿', body: `<p>当前暂存「${esc(db.draft?.goal?.name || '未命名目标')}」的草稿。</p>`,
      actions: B('close', '取消', 'btn ghost') + B('resume-draft', '继续原草稿', 'btn soft') + B('replace-draft', '放弃并切换', 'btn danger')
    };
    if (type === 'confirm-conflict') return {
      title: '已确认的方案有更新',
      body: m.conflicts.map(key => {
        const show = value => {
          if (key === 'assistantRule') return esc(value || '尚无专属规则');
          const layout = layoutOf({ layout: value });
          return esc([viewDescription(layout, layout.filters), layout.dense ? '紧凑排列' : '标准间距',
            layout.highlight ? '首行突出执行结果' : '首行展示事项名称'].join(' · '));
        };
        return `<h3>${key === 'layout' ? '事项区展示方案' : '空间助手规则'}</h3>
          <p>当前生效</p><pre>${show(m.fresh[key])}</pre><p>待提交草稿</p><pre>${show(db.draft.goal[key])}</pre>`;
      }).join(''),
      actions: B('close', '继续编辑', 'btn ghost') + B('review-conflict', '已核对，使用草稿', 'btn primary')
    };
  }
  function setField(el) {
    const key = el.dataset.df, d = db.draft;
    if (!key || !d?.goal) return false;
    const g = d.goal, i = +el.dataset.i;
    const value = el.type === 'checkbox' ? el.checked : key === 'e-duration' ? Number(el.value) : el.value;
    let target = g, prop = key;
    const parts = key.split('-');
    if (parts.length > 1) {
      prop = parts[1];
      target = { k: g.ks[i], e: d.events[i], filter: g.layout.filters, layout: g.layout }[parts[0]];
    }
    if (!target || Object.is(target[prop], value)) return true;
    target[prop] = value;
    if (key === 'bookkeeping' && !value) {
      if (g.layout.metric === 'cash') g.layout.metric = 'count';
      g.layout.filters.flow = 'all';
    }
    touchDraft(); updateBusy(); updateOverlapHints();
    const button = $('[data-act="commit-draft"]');
    if (button) button.disabled = !isValidDraft(d) || committing;
    const version = $('.draftpane .sectionhead .tag');
    if (version) version.textContent = '仅草稿 · v' + d.revision;
    return true;
  }
  async function dispatch(action, value) {
    const d = db.draft;
    switch (action) {
      case 'resume-draft': await startCreate(d.baseGoal?.id); break;
      case 'replace-draft': await startCreate(ui.modal.target, true, ui.modal.policy); break;
      case 'creator-back': flushDraft(); back(); break;
      case 'discard-draft': dropDraft(); back(); toast('草稿已放弃。'); break;
      case 'review-conflict': {
        for (const key of ui.modal.conflicts) d.baseGoal[key] = clone(ui.modal.fresh[key]);
        d.baseGoal.revision = ui.modal.fresh.revision;
        flushDraft(); closeModal(); await commit(); break;
      }
      case 'commit-draft': await commit(); break;
      case 'studio-tab': ui.studioTab = value; render(); break;
      case 'draft-view': ui.draftView = value; updateBusy(); render(); break;
      case 'manual-draft':
        d.goal = { id: d.id, name: '', about: '', ks: [], layout: layoutDefault(), assistantRule: '先核对本空间的达标标准和执行记录，区分计划与实际。引用相关事项，证据不足时先询问。', bookkeeping: false };
        touchDraft(); render(); break;
      case 'add-k':
        d.goal.ks.push({ id: uid('k'), name: '', standard: '', from: ctx.today(), to: shift(ctx.today(), 27), r: '' });
        touchDraft(); render(); break;
      case 'add-draft-event':
        d.events.push({ id: uid('event'), oid: d.goal.id, title: '', kind: '实践', time: '19:30', duration: 30,
          date: shift(d.events.at(-1)?.date || ctx.today(), 1), status: 'plan', note: '', measure: '' });
        touchDraft(); updateBusy(); render(); break;
      case 'rm-draft-event': d.events.splice(Number(value), 1); touchDraft(); updateBusy(); render(); break;
      default: return false;
    }
    return true;
  }
  return { startCreate, creatorPage, flushDraft, touchDraft, replaceDraft, dropDraft, setField, modal, dispatch };
}
