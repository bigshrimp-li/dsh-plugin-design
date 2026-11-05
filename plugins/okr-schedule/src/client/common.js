const $ = (s) => document.querySelector(s),
  $$ = (s) => Array.from(document.querySelectorAll(s));
const esc = (x) =>
  String(x ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const clone = (x) => JSON.parse(JSON.stringify(x));
const uid = (p) =>
  p +
  '-' +
  (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2));
const pal = ['#0e7490', '#c2410c', '#7c3aed', '#0f766e', '#be185d'];
const oldSwatches = ['#a1e6c0', '#f1b181', '#b4b2fa', '#79cbd7', '#e7a7b8'];
function inkFor(space) {
  const color = space?.color || pal[0],
    legacy = ['#225f43', '#8b471e', '#59488d', '#176475', '#8c405e'];
  const index = legacy.indexOf(color);
  if (index >= 0) return pal[index];
  const oldIndex = oldSwatches.indexOf(color);
  return oldIndex >= 0 ? pal[oldIndex] : /^#[0-9a-f]{6}$/i.test(color) ? color : pal[0];
}
const paths = {
  orbit:
    '<circle cx="12" cy="12" r="3"/><ellipse cx="12" cy="12" rx="10" ry="4.8" transform="rotate(-35 12 12)"/><path d="M7 4.3a9 9 0 0 1 11.9 12.5"/>',
  calendar:
    '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 10h18m-14 4h3m3 0h3"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  left: '<path d="m14 6-6 6 6 6"/>',
  right: '<path d="m10 6 6 6-6 6"/>',
  exit: '<path d="M10 5H5v14h5m-1-7h12m-4-4 4 4-4 4"/>',
  route:
    '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 6h7a3 3 0 0 1 0 6h-4a3 3 0 0 0 0 6h7"/>',
  ai: '<path d="m12 2 2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4zM19 2v4m-2-2h4"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  up: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  filter: '<path d="M3 5h18l-7 8v5l-4 2v-7z"/>',
  book: '<path d="M3 5c4-2 6-1 9 1 3-2 5-3 9-1v14c-4-2-6-1-9 1-3-2-5-3-9-1zM12 6v14"/>',
  run: '<path d="m3 16 5-8 4 7 4-11 5 12M3 20h18"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  file: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8zm-9 9 9 5 9-5m-18 5 9 5 9-5"/>',
  chat: '<path d="M4 4h16v13H9l-5 4zM8 9h8m-8 4h5"/>',
  lens: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
};
const icon = (k) =>
  `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24">${paths[k] || paths.target}</svg>`;
const mark = () => `<span class="logomark">${icon('orbit')}</span>`;
const B = (a, t, cl = 'btn', v = '', extra = '') =>
  `<button type="button" class="${cl}" data-act="${a}" data-v="${esc(v)}" ${extra}>${t}</button>`;
const I = (a, k, title, v = '') =>
  B(a, icon(k), 'iconbtn', v, `title="${esc(title)}" aria-label="${esc(title)}"`);
const options = (pairs, selected) =>
  pairs
    .map(([v, l]) => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(l)}</option>`)
    .join('');
const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const dateObj = (s) => new Date(s + 'T12:00:00'),
  pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function shift(s, n) {
  const d = dateObj(s);
  d.setDate(d.getDate() + n);
  return iso(d);
}
function monthShift(s, n) {
  const d = dateObj(s),
    day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return iso(d);
}
const dow = (s) => (dateObj(s).getDay() + 6) % 7,
  monday = (s) => shift(s, -dow(s)),
  md = (s) => `${Number(s.slice(5, 7))}月${Number(s.slice(8))}日`;
const minutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3)),
  byTime = (a, b) => (a.date + ' ' + a.time).localeCompare(b.date + ' ' + b.time);
const weekOf = (s) => {
  const th = dateObj(shift(monday(s), 3)),
    first = new Date(th.getFullYear(), 0, 4, 12);
  return Math.round((dateObj(monday(s)) - dateObj(monday(iso(first)))) / 604800000) + 1;
};
const groupOpts = [
  ['kind', '事项类型'],
  ['month', '月'],
  ['week', '周'],
  ['date', '日期'],
  ['status', '执行状态'],
  ['none', '不分组'],
];
const metricOpts = [
  ['count', '事项数'],
  ['minutes', '计划时长'],
  ['rate', '完成率'],
  ['cash', '收入与支出金额'],
];
const styleOpts = [
  ['list', '明细列表'],
  ['cards', '汇总卡片'],
];
const rangeOpts = [
  ['all', '全部日期'],
  ['week', '选中周'],
  ['month', '选中月'],
  ['thisWeek', '本周'],
  ['thisMonth', '本月'],
  ['upcoming', '今天起'],
];
const flowOpts = [
  ['all', '全部收支'],
  ['expense', '支出'],
  ['income', '收入'],
];
const newFilters = () => ({ query: '', kind: 'all', status: 'all', range: 'all', flow: 'all' });
const layoutDefault = () => ({
  group: 'kind',
  metric: 'count',
  style: 'list',
  dense: false,
  highlight: false,
  filters: newFilters(),
});
const availableMetrics = (g) => metricOpts.filter(([id]) => id !== 'cash' || g.bookkeeping);
const stateName = (s) => (s === 'done' ? '已完成' : '待执行');
const krNames = { pending: '待实现', expired: '已过期', achieved: '已实现' };
function krGroup(k, TODAY = iso(new Date())) {
  if (k.achievedOn) return 'achieved';
  return k.to && k.to < TODAY ? 'expired' : 'pending';
}
function krPeriod(k, TODAY = iso(new Date())) {
  if (k.achievedOn) return '已手动标记 · ' + k.achievedOn;
  if (!k.to || !k.from) return '期限待补';
  if (k.to < TODAY) return '已过期';
  if (k.from > TODAY) return '未开始';
  return k.to === TODAY ? '今天截止' : '有效期内';
}
function label(opts, k) {
  return opts.find((x) => x[0] === k)?.[1] || k;
}
function empty(msg) {
  return `<div class="empty">${esc(msg)}</div>`;
}
function validDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(dateObj(s).valueOf()) && iso(dateObj(s)) === s;
}

export {
  $,
  $$,
  esc,
  clone,
  uid,
  pal,
  inkFor,
  icon,
  mark,
  B,
  I,
  options,
  days,
  dateObj,
  pad,
  iso,
  shift,
  monthShift,
  dow,
  monday,
  md,
  minutes,
  byTime,
  weekOf,
  groupOpts,
  metricOpts,
  styleOpts,
  rangeOpts,
  flowOpts,
  newFilters,
  layoutDefault,
  availableMetrics,
  stateName,
  krNames,
  krGroup,
  krPeriod,
  label,
  empty,
  validDate,
};
