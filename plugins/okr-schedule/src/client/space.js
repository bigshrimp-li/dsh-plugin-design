import {
  $, B, clone, empty, esc, flowOpts, icon, inkFor, krGroup, krNames, krPeriod, label, newFilters,
  options, pad, uid, validDate
} from './common.js';
import { createCreator } from './creator.js';
import { filterControls, layoutControls, layoutOf, matchEvents, renderGroups, viewDescription } from './space-view.js';

const haveFilter = (left, right) => Object.keys(newFilters()).some(k => left[k] !== right[k]);
const orders = { pending: '最早截止在前', expired: '最近过期在前', achieved: '最近标记在前' };
const emptyGroups = { pending: '暂无待实现的过程目标。', expired: '暂无已过期的过程目标。', achieved: '暂无手动标记为已实现的过程目标。' };

export function groupGoals(ks, today) {
  const groups = { pending: [], expired: [], achieved: [] };
  ks.forEach((k, i) => groups[krGroup(k, today)].push({ k, number: i + 1 }));
  for (const [name, rows] of Object.entries(groups)) {
    const key = name === 'achieved' ? 'achievedOn' : 'to';
    rows.sort((a, b) => (name === 'pending' ? 1 : -1) *
      String(a.k[key] || '').localeCompare(String(b.k[key] || '')) || a.number - b.number);
  }
  return groups;
}

function renderKr(goal, today, group) {
  const groups = groupGoals(goal.ks, today), rows = groups[group];
  const tabs = Object.keys(groups).map(name => B('kr-view',
    `${krNames[name]} <b>${groups[name].length}</b>`, 'kr-view ' + name, name,
    `aria-controls="kr-list" aria-pressed="${name === group}"`));
  const jump = rows.length >= 4 ? `<select id="kr-jump" class="kr-select" aria-label="跳到本组过程目标">
    ${options([['','跳到某个 K…'], ...rows.map(({ k, number }) => [k.id, 'K' + pad(number) + ' · ' + k.name])], '')}</select>` : '';
  return `<section class="box spacebox kr-panel"><div class="boxhead">${icon('target')}<h2>过程目标与反馈</h2>
    <span class="grow"></span><span class="micro">每个 K 对应一个 R</span></div>
    <div class="kr-toolbar"><div class="kr-views" role="group" aria-label="按过程目标状态查看">${tabs.join('')}</div>${jump}</div>
    <div id="kr-list" class="kr-list" data-space="${esc(goal.id)}" data-view="${group}" role="region" tabindex="0"
      aria-label="${krNames[group]}的过程目标与反馈">${rows.map(({ k, number }) => {
        const action = k.achievedOn ? '撤销已实现' : '标记已实现';
        return `<article class="krrow" tabindex="-1" data-kid="${esc(k.id)}" aria-label="K${pad(number)} ${esc(k.name)}">
          <div><span class="over">K${pad(number)} · 过程目标</span><h3>${esc(k.name)}</h3><p>${esc(k.standard)}</p>
          <small class="micro mono period"><time>${esc(k.from)}</time> → <time>${esc(k.to)}</time> · ${esc(krPeriod(k, today))}</small>
          ${B('kr-achieve', action, 'minilink achieve', k.id, `aria-label="${esc(action + '：' + k.name)}"`)}</div>
          <div class="rside"><span class="over">R${pad(number)} · 阶段反馈</span><p>${esc(k.r || '待反馈')}</p>
          ${B('feedback', '填写 / AI 起草 ↗', 'minilink', k.id, `aria-label="${esc('填写或起草反馈：' + k.name)}"`)}</div></article>`;
      }).join('') || empty(emptyGroups[group])}</div>
    ${rows.length ? `<div class="kr-foot"><span>${orders[group]} · 共 ${rows.length} 项</span><span class="kr-scroll-hint">↕ 上下滚动查看更多</span></div>` : ''}</section>`;
}

function paymentForm(today, goalName) {
  return `<p>${esc(goalName)}</p><div class="formgrid">
    <label class="field full">账目名称<input id="pay-title" maxlength="80" placeholder="例如：买菜"></label>
    <label class="field">收支方向<select id="pay-flow">${options(flowOpts.filter(([key]) => key !== 'all'), 'expense')}</select></label>
    <label class="field">金额<input id="pay-amount" inputmode="decimal" placeholder="0.00"></label>
    <label class="field">币种<input id="pay-currency" value="CNY" maxlength="3" aria-label="币种代码"></label>
    <label class="field">类别<input id="pay-category" placeholder="其他"></label>
    <label class="field">发生日期<input id="pay-date" type="date" max="${today}" value="${today}"></label>
    <label class="field">时间<input id="pay-time" type="time" value="12:00"></label>
    <label class="field full">实际情况<textarea id="pay-note" rows="2"></textarea></label></div>`;
}

export function createSpaceUI(ctx) {
  const { ui, db, api, toast, render, openModal, closeModal } = ctx;
  const current = () => db.spaces.find(s => s.id === ui.sid);
  const ownEvents = () => db.events.filter(e => e.oid === ui.sid);
  const creator = createCreator(ctx);
  ui.filters ||= {}; ui.pending ||= {}; ui.krView ||= 'pending';

  function activeLayout(g = current()) {
    const base = layoutOf(g), p = ui.pending[g.id];
    return { ...base, ...p?.layout, filters: { ...(p?.filters || ui.filters[g.id] || base.filters) } };
  }
  function previewFromAssistant(proposal = {}, previewId = uid('preview')) {
    const g = current();
    if (ui.view !== 'space' || !g) return;
    const before = activeLayout(g), patch = proposal.layout || {};
    const filters = { ...before.filters, ...patch.filters, ...proposal.filters };
    const layout = { ...before, ...patch, filters };
    const old = ui.pending[g.id];
    const rules = !!(old?.rules || proposal.saveFilters || Object.keys(proposal.filters || {}).length || haveFilter(filters, before.filters)
      || layout.group !== before.group || layout.metric !== before.metric);
    ui.pending[g.id] = { id: previewId, layout, filters, rules, revision: old?.revision ?? g.revision };
    render();
    return previewId;
  }
  function openFeedback(kid, draftText) {
    const g = current(), k = g?.ks.find(k => k.id === kid);
    if (!k || ui.view !== 'space') return;
    openModal('feedback', { kid, oid: g.id, value: draftText ?? k.r ?? '', expectedRevision: k.rRevision });
  }
  function openK(kid) {
    const g = current(), k = g?.ks.find(k => k.id === kid);
    if (ui.view !== 'space' || !k) return;
    openModal('kr-source', { kid, oid: g.id });
  }
  function spacePage() {
    const g = current();
    if (!g) return empty('找不到这个空间。');
    const l = activeLayout(g), saved = layoutOf(g), events = ownEvents();
    const matches = matchEvents(events, l.filters, ui.date, ctx.today());
    const p = ui.pending[g.id];
    const notice = p ? `<div class="preview-note" tabindex="-1">事项区预览 · ${esc(viewDescription(l, l.filters))} · ${matches.length} 项匹配
      ${B('apply-layout', p.rules ? '保存为默认' : '应用排版', 'btn small soft')}${B('cancel-layout', '放弃', 'btn small ghost')}</div>` : '';
    const changed = haveFilter(l.filters, saved.filters);
    return `<div class="pagehead"><div class="grow"><div class="over">WORKSPACE / OBJECTIVE</div><h1>目标空间</h1></div>
      ${ctx.headButtons()}</div><section class="spacehead" style="--c:${inkFor(g)}"><div class="between">
      <span class="over">OBJECTIVE${g.code ? ' / ' + esc(g.code) : ''}</span><span class="tag">${g.archivedAt ? '已归档' : '正式空间'}</span></div>
      <h1>${esc(g.name)}</h1><p>${esc(g.about)}</p><div class="actions">
      ${B('choose-space', icon('grid') + '切换空间', 'btn small ghost')}${B('adjust', '调整目标', 'btn small ghost', g.id, g.archivedAt ? 'disabled' : '')}
      ${B('delete-space', '删除空间', 'btn small danger ghost', g.id)}${B('files', icon('file') + '空间资料', 'btn small ghost')}</div></section>
      ${renderKr(g, ctx.today(), ui.krView)}${notice}
      <section class="box spacebox ${l.dense ? 'dense' : ''}"><div class="boxhead">${icon('calendar')}<h2>空间事项</h2>
      <span class="grow"></span><div class="space-actions">${B('rules', '视图规则', 'btn small ghost')}
      ${g.bookkeeping && !g.archivedAt ? B('log-payment', '记一笔', 'btn small soft') : ''}${B('new-event', '＋ 事项', 'btn small', g.id, g.archivedAt ? 'disabled' : '')}</div></div>
      <div class="filters">${filterControls(g, events, l.filters)}
      ${haveFilter(l.filters, newFilters()) ? B('clear-filter', '清除筛选', 'btn small ghost') : ''}
      ${changed && !p ? B('preview-default', '设为默认…', 'btn small soft') + B('restore-default', '恢复默认', 'btn small ghost') : ''}</div>
      <div class="calfoot"><span>${esc(viewDescription(l, l.filters))}</span><span>${matches.length} 项匹配</span></div>
      ${renderGroups(matches, l, g)}</section>`;
  }

  function modal(type, m = {}) {
    const g = current();
    switch (type) {
      case 'rules': return {
        title: '事项区的聚合与排版', body: '<div class="formgrid">' + layoutControls(g, activeLayout(g)) + '</div>',
        actions: B('preview-rule', '预览当前空间', 'btn primary')
      };
      case 'payment': return {
        title: '记一笔已发生的收支', body: paymentForm(ctx.today(), g.name),
        actions: B('close', '取消', 'btn ghost') + B('save-payment', '确认入账', 'btn primary')
      };
      case 'feedback':
      case 'kr-source': {
        const k = g?.ks.find(k => k.id === m.kid);
        if (!k || g.id !== m.oid) return { title: '来源已失效', body: '', actions: B('close', '关闭') };
        const meta = `<p><b>${esc(k.name)}</b> · ${esc(k.from)} 至 ${esc(k.to)}</p><p>${esc(k.standard)}</p>`;
        if (type === 'kr-source') return { title: k.name, body: meta + `<p>阶段反馈 R · ${esc(k.r || '待反馈')}</p>`, actions: B('close', '返回会话', 'btn primary') };
        return {
          title: '阶段反馈', body: meta + `<label class="field">本 K 的唯一 R<textarea id="r-text" rows="4" placeholder="写下对这个过程目标的评价">${esc(m.value)}</textarea></label>`,
          actions: B('r-draft', icon('ai') + 'AI 起草', 'btn soft') + B('r-save', '确认保存反馈', 'btn primary', '', m.value?.trim() ? '' : 'disabled')
        };
      }
      case 'files': return {
        title: '空间资料', body: `<p class="mono" style="overflow-wrap:anywhere">~/.dsh_okr/${esc(g.id)}/</p>
          <p><b>space.sqlite</b>　正式记录、事项区排版和已确认规则</p>
          <p><b>空间概览.md</b>　目标、反馈和执行记录的阅读稿</p>
          <p><b>AGENTS.md</b>　已确认的空间专属规则</p><p style="white-space:pre-wrap">${esc(g.assistantRule || '尚无专属规则')}</p>`,
        actions: B('export-file', '导出 AGENTS.md', 'btn ghost', 'AGENTS.md') + B('export-file', '导出空间概览.md', 'btn primary', '空间概览.md')
      };
      default: return creator.modal(type, m);
    }
  }
  async function savePayment(g) {
    const value = id => $('#' + id).value.trim();
    const title = value('pay-title'), date = value('pay-date'), time = value('pay-time');
    const currency = value('pay-currency').toUpperCase(), amount = value('pay-amount');
    if (!title || !validDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
      throw new Error('请填写账目名称、有效的发生日期和时间。');
    if (date > ctx.today()) throw new Error('发生日期应为今天或更早。');
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0)
      throw new Error('请输入正金额，整数最多九位，小数最多两位。');
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error('请输入三个字母的币种代码，例如 CNY。');
    const m = ui.modal;
    const event = { oid: g.id, title, date, time, kind: value('pay-category') || '其他', duration: 0,
      status: 'done', note: value('pay-note'), measure: '', posting: {
        flow: value('pay-flow'), currency, cents: Math.round(Number(amount) * 100)
      } };
    await api('calendar.ledger.save', { event, requestId: m.requestId, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }, g.id);
    if (ui.modal === m) closeModal();
    await ctx.refresh();
    toast('已入账，可在对应月份核对。');
  }
  function setFilter(key, value) {
    const g = current(), p = ui.pending[g.id];
    if (p) { p.filters[key] = value; p.rules = true; }
    else ui.filters[g.id] = { ...activeLayout(g).filters, [key]: value };
  }
  function onInput(el, event) {
    if (el.id === 'r-text' && ui.modal?.type === 'feedback') {
      ui.modal.value = el.value;
      $('[data-act="r-save"]').disabled = !el.value.trim();
      return true;
    }
    if (el.dataset.df) return creator.setField(el);
    if (el.dataset.sfilter === 'query' && !event?.isComposing) {
      const position = el.selectionStart;
      setFilter('query', el.value);
      render();
      const next = $('[data-sfilter="query"]');
      next.focus({ preventScroll: true });
      if (position != null) next.setSelectionRange(position, position);
      return true;
    }
    return false;
  }
  function onChange(el) {
    if (el.dataset.df) {
      creator.setField(el);
      if (el.matches('select,input[type=checkbox]') || el.dataset.df.startsWith('filter-')) render();
      return true;
    }
    if (el.dataset.sfilter) { setFilter(el.dataset.sfilter, el.value); render(); return true; }
    if (el.id === 'kr-jump' && el.value) {
      const list = $('#kr-list'), row = [...list.children].find(r => r.dataset.kid === el.value);
      if (row) { list.scrollTop = row.offsetTop; row.focus({ preventScroll: true }); }
      el.value = '';
      return true;
    }
    return false;
  }
  function onKeyDown(e) {
    if (!e.target.matches('#kr-list,.krrow') || e.ctrlKey || e.metaKey || e.altKey) return false;
    const list = e.target.closest('#kr-list'), page = Math.max(40, list.clientHeight - 36);
    const delta = { ArrowDown: 36, ArrowUp: -36, PageDown: page, PageUp: -page, End: list.scrollHeight, Home: -list.scrollHeight }[e.key];
    if (delta === undefined || list.scrollHeight <= list.clientHeight) return false;
    e.preventDefault(); list.scrollTop += delta; return true;
  }
  async function dispatch(action, value, el) {
    const g = current();
    switch (action) {
      case 'adjust': await creator.startCreate(g.id); break;
      case 'kr-view':
        ui.krView = value; render(); $('#kr-list').scrollTop = 0;
        $('.kr-view[aria-pressed="true"]')?.focus({ preventScroll: true }); break;
      case 'kr-achieve': {
        const k = g.ks.find(k => k.id === value);
        if (!k) break;
        await api('calendar.achievement.save', { kid: k.id, achieved: !k.achievedOn, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, expectedRevision: k.revision }, g.id);
        await ctx.refresh();
        const latest = current()?.ks.find(row => row.id === value);
        if (latest) toast('「' + latest.name + '」已移入「' + krNames[krGroup(latest, ctx.today())] + '」。');
        break;
      }
      case 'feedback': openFeedback(value); break;
      case 'r-draft': {
        const kid = ui.modal.kid;
        closeModal();
        await ctx.assistantUI.startFeedback(kid);
        break;
      }
      case 'r-save': {
        const m = ui.modal, r = m.value.trim();
        if (!r) { toast('请填写实际反馈。'); break; }
        await api('calendar.feedback.save', { kid: m.kid, r, expectedRevision: m.expectedRevision }, m.oid);
        if (ui.modal === m) closeModal();
        await ctx.refresh();
        toast('已更新此 K 的阶段反馈。');
        break;
      }
      case 'rules': openModal('rules'); break;
      case 'preview-rule': {
        const layout = Object.fromEntries(['group','metric','style','dense','highlight'].map(key => {
          const field = $('#rule-' + key);
          return [key, field.type === 'checkbox' ? field.checked : field.value];
        }));
        closeModal(); previewFromAssistant({ layout }); break;
      }
      case 'preview-default': previewFromAssistant({ saveFilters: true }); break;
      case 'cancel-layout': delete ui.pending[g.id]; render(); break;
      case 'restore-default': delete ui.pending[g.id]; delete ui.filters[g.id]; render(); break;
      case 'clear-filter': {
        const p = ui.pending[g.id];
        if (p) { p.filters = newFilters(); p.rules = true; }
        else ui.filters[g.id] = newFilters();
        render(); break;
      }
      case 'apply-layout': {
        const p = ui.pending[g.id];
        if (!p) break;
        const layout = { ...p.layout, filters: p.rules ? p.filters : layoutOf(g).filters };
        await api('calendar.layout.save', { layout, styleOnly: !p.rules, expectedRevision: p.revision }, g.id);
        if (p.rules) ui.filters[g.id] = clone(p.filters);
        delete ui.pending[g.id];
        await ctx.refresh();
        toast(p.rules ? '已保存本空间的默认事项规则。' : '已应用事项区排版。'); break;
      }
      case 'log-payment': openModal('payment', { oid: g.id, requestId: uid('payment') }); break;
      case 'save-payment': await savePayment(g); break;
      case 'space-event': {
        const e = ownEvents().find(row => row.id === value && row.date === el.dataset.date &&
          (row.occurrenceKey || '') === el.dataset.occurrence);
        if (e) await ctx.openEvent(e);
        break;
      }
      case 'files': openModal('files', { oid: g.id }); break;
      case 'export-file': {
        const { filename, content } = await api('calendar.export', { filename: value }, g.id);
        const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url; link.download = filename; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        break;
      }
      default: return creator.dispatch(action, value);
    }
    return true;
  }
  function reconcileDraft() {
    const d = db.draft;
    if (d?.mode === 'edit' && !db.spaces.some(g => g.id === d.baseGoal?.id)) creator.dropDraft();
  }
  return { ...creator, spacePage, modal, dispatch, onInput, onChange, onKeyDown, openK, openFeedback, previewFromAssistant,
    activeLayout, reconcileDraft, dropDeleted: oid => creator.dropDraft(oid) };
}
