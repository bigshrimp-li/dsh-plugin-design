import {
  B, byTime, empty, esc, flowOpts, groupOpts, icon, inkFor, label, layoutDefault, md,
  metricOpts, monday, newFilters, options, rangeOpts, shift, stateName, styleOpts
} from './common.js';

const statusOptions = [['all', '全部状态'], ['plan', '待执行'], ['done', '已完成']];
export const layoutOf = goal => ({
  ...layoutDefault(), ...goal?.layout, filters: { ...newFilters(), ...goal?.layout?.filters }
});

export function eligiblePosting(event) {
  const p = event.posting;
  return event.status === 'done' && p && /^[A-Z]{3}$/.test(p.currency)
    && Number.isSafeInteger(p.cents) && p.cents > 0 && ['income', 'expense'].includes(p.flow);
}

export function matchEvents(events, filters, selectedDate, today) {
  const rangeBase = ['week', 'month'].includes(filters.range) ? selectedDate : today;
  const start = monday(rangeBase), end = shift(start, 6);
  const query = filters.query.trim().toLocaleLowerCase();
  return events.filter(e => {
    if (filters.kind !== 'all' && filters.kind !== e.kind) return false;
    if (filters.status !== 'all' && filters.status !== e.status) return false;
    if (filters.flow !== 'all' && (!eligiblePosting(e) || filters.flow !== e.posting.flow)) return false;
    if (filters.range === 'upcoming' && e.date < today) return false;
    if (['week', 'thisWeek'].includes(filters.range) && (e.date < start || e.date > end)) return false;
    if (['month', 'thisMonth'].includes(filters.range) && e.date.slice(0, 7) !== rangeBase.slice(0, 7)) return false;
    return [e.title, e.kind, e.note, e.measure].some(value => String(value || '').toLocaleLowerCase().includes(query));
  }).sort(byTime);
}

export function viewDescription(layout, filters) {
  const conditions = [filters.query, filters.kind !== 'all' && filters.kind,
    filters.status !== 'all' && stateName(filters.status),
    filters.range !== 'all' && label(rangeOpts, filters.range),
    filters.flow !== 'all' && label(flowOpts, filters.flow)].filter(Boolean);
  return [conditions.join('、') || '全部事项', label(groupOpts, layout.group),
    label(metricOpts, layout.metric), label(styleOpts, layout.style)].join(' · ');
}

export function aggregateLabel(rows, metric) {
  if (metric === 'minutes') return rows.reduce((total, e) => total + Number(e.duration || 0), 0) + ' 分钟';
  if (metric === 'rate') return rows.length
    ? Math.round(rows.filter(e => e.status === 'done').length * 100 / rows.length) + '% 完成' : '暂无样本';
  return rows.length + ' 项';
}

function groupKey(e, group) {
  switch (group) {
    case 'date': return e.date;
    case 'week': return monday(e.date) + ' 当周';
    case 'month': return e.date.slice(0, 7);
    case 'status': return stateName(e.status);
    case 'none': return '全部事项';
    default: return e.kind || '其他';
  }
}

function amount(cents) {
  const exact = BigInt(cents);
  return (exact / 100n).toLocaleString('zh-CN') + '.' + String(exact % 100n).padStart(2, '0');
}
const currencyLabel = code => code === 'CNY' ? '人民币 · CNY' : code;
const money = (code, cents) => (code === 'CNY' ? '¥' : code + ' ') + amount(cents);

export function renderGroups(rows, layout, goal, { draft = false } = {}) {
  if (!rows.length) return empty('没有符合条件的事项。');
  const cash = layout.metric === 'cash';
  const eligible = cash ? rows.filter(eligiblePosting) : rows;
  if (!eligible.length) return empty('暂无可汇总的已入账事项。' + rows.length + ' 项计划或缺少合格金额。');
  const groups = new Map();
  for (const e of eligible) {
    const title = groupKey(e, layout.group), code = cash ? e.posting.currency : '';
    const key = JSON.stringify([title, code]);
    if (!groups.has(key)) groups.set(key, { title, code, items: [] });
    groups.get(key).items.push(e);
  }
  const sorted = [...groups.values()];
  if (layout.group === 'month') sorted.sort((a, b) => b.title.localeCompare(a.title) || a.code.localeCompare(b.code));
  function line(e) {
    const measured = e.measure || e.note || '';
    const title = layout.highlight && measured ? measured + ' · ' + e.title : e.title;
    const info = [e.date && md(e.date), e.kind, !layout.highlight && e.measure,
      eligiblePosting(e) && (label(flowOpts, e.posting.flow) + ' ' + money(e.posting.currency, e.posting.cents))].filter(Boolean).join(' · ');
    if (draft) return `<div class="draft-ledger-line">${esc(e.date)} ${esc(e.time)} · ${esc(title || '未命名事项')} · ${esc(info)}</div>`;
    return B('space-event', `<i class="dot"></i><time>${esc(e.time)}</time><span class="grow"><strong>${esc(title)}</strong>
      <small>${esc(info)}</small></span><span class="state ${e.status === 'done' ? 'done' : ''}">${esc(stateName(e.status))}</span>${icon('right')}`,
      'erow', e.id, `style="--c:${inkFor(goal)}" data-occurrence="${esc(e.occurrenceKey || '')}" data-date="${esc(e.date)}"`);
  }
  const html = sorted.map(({ title, code, items }) => {
    if (!cash) return `<section class="view-group"><div class="group-title"><b>${esc(title)}</b>
      <span>${aggregateLabel(items, layout.metric)}</span></div>${items.map(line).join('')}</section>`;
    const flows = layout.filters.flow === 'all' ? ['expense', 'income'] : [layout.filters.flow];
    return `<section class="view-group cash-group"><div class="group-title"><b>${esc(title)}</b>
      <span>${esc(currencyLabel(code))} · ${items.length} 笔已入账</span></div><div class="cash-pair">${flows.map(flow => {
        const list = items.filter(e => e.posting.flow === flow);
        const total = list.reduce((sum, e) => sum + BigInt(e.posting.cents), 0n);
        return `<details class="cash-flow"><summary><span>${label(flowOpts, flow)} · ${list.length} 笔</span>
          <strong>${money(code, total)}</strong></summary>${list.map(line).join('') || empty('此组没有已入账明细。')}</details>`;
      }).join('')}</div></section>`;
  }).join('');
  const omitted = rows.length - eligible.length;
  return `<div class="view-groups ${layout.style === 'cards' ? 'cards' : ''}">${html}</div>` +
    (omitted ? `<div class="calfoot">${omitted} 项未参与金额合计（计划或缺少合格入账数据）</div>` : '');
}

export function filterControls(goal, events, filters, draft = false) {
  const kinds = new Set(events.map(e => e.kind).filter(Boolean));
  if (filters.kind !== 'all') kinds.add(filters.kind);
  const data = key => draft ? `data-df="filter-${key}"` : `data-sfilter="${key}"`;
  const select = (key, title, pairs) => {
    const html = `<select ${data(key)} aria-label="${title}">${options(pairs, filters[key])}</select>`;
    return draft ? `<label class="field">${title}${html}</label>` : html;
  };
  const search = `<input ${data('query')} type="search" aria-label="搜索事项" placeholder="搜索事项…" value="${esc(filters.query)}">`;
  return [
    draft ? `<label class="field">事项关键词${search}</label>` : `<div class="filter-search">${icon('lens')}${search}</div>`,
    select('kind', '事项类型', [['all', '全部类型'], ...Array.from(kinds, k => [k, k])]),
    select('status', '事项状态', statusOptions), select('range', '日期范围', rangeOpts),
    goal.bookkeeping ? select('flow', '收支方向', flowOpts) : ''
  ].join('');
}

export function layoutControls(goal, layout, draft = false) {
  const data = key => draft ? `data-df="layout-${key}"` : `id="rule-${key}"`;
  const select = (key, title, pairs) => `<label class="field">${title}<select ${data(key)} aria-label="${title}">${options(pairs, layout[key])}</select></label>`;
  const checkbox = (key, title) => `<label class="field-check"><input type="checkbox" ${data(key)} ${layout[key] ? 'checked' : ''}> ${title}</label>`;
  return [
    select('group', '分组', groupOpts), select('metric', '统计口径', metricOpts.filter(([id]) => id !== 'cash' || goal.bookkeeping)),
    select('style', '展示方式', styleOpts), checkbox('dense', '紧凑排列'), checkbox('highlight', '首行突出执行结果')
  ].join('');
}
