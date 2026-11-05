const DAY = 86_400_000;
const iso = (time) => new Date(time).toISOString().slice(0, 10);
const stamp = (day) => Date.parse(day + 'T00:00:00Z');
export function validDay(day) {
  return (
    typeof day === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(stamp(day)) &&
    iso(stamp(day)) === day
  );
}
const shift = (day, n) => iso(stamp(day) + n * DAY);
const monday = (day) => shift(day, -((new Date(stamp(day)).getUTCDay() + 6) % 7));
function month(day, offset = 0) {
  const date = new Date(stamp(day.slice(0, 7) + '-01'));
  const from = iso(date.setUTCMonth(date.getUTCMonth() + offset));
  return { from, to: iso(date.setUTCMonth(date.getUTCMonth() + 1) - DAY) };
}
export function period(question, today, selected, previous) {
  const day = /选中|所选/.test(question) && validDay(selected) ? selected : today;
  const dates = question.match(/\d{4}-\d{2}-\d{2}/g)?.filter(validDay);
  if (dates?.length) return { from: dates[0], to: dates[1] || dates[0] };
  const named = question.match(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月(?:\s*(\d{1,2})\s*[日号])?/);
  if (named) {
    const full =
      (named[1] || today.slice(0, 4)) +
      '-' +
      named[2].padStart(2, '0') +
      '-' +
      (named[3] || '01').padStart(2, '0');
    if (validDay(full)) return named[3] ? { from: full, to: full } : month(full);
  }
  if (/本月|这个月|当月|上月|上个月|下月|下个月|选中月|所选月/.test(question))
    return month(day, /上个?月/.test(question) ? -1 : /下个?月/.test(question) ? 1 : 0);
  if (/未来\s*[7七]\s*天/.test(question)) return { from: today, to: shift(today, 6) };
  if (/[本这上下]周|这星期|选中周|所选周/.test(question)) {
    const from = shift(monday(day), /上周/.test(question) ? -7 : /下周/.test(question) ? 7 : 0);
    return { from, to: shift(from, 6) };
  }
  if (/明天|昨天|今天|选中日|所选日/.test(question)) {
    const date = shift(day, /明天/.test(question) ? 1 : /昨天/.test(question) ? -1 : 0);
    return { from: date, to: date };
  }
  return previous || null;
}
export function pageFilter(events, filters, today, selected) {
  const f = filters || {};
  const query = String(f.query || '')
    .trim()
    .toLocaleLowerCase();
  const range = {
    month: month(selected),
    week: period('选中周', today, selected),
    thisMonth: month(today),
    thisWeek: period('本周', today, selected),
  }[f.range];
  return events.filter(
    (e) =>
      (!range || (e.date >= range.from && e.date <= range.to)) &&
      (f.range !== 'upcoming' || e.date >= today) &&
      ['kind', 'status'].every((k) => !f[k] || f[k] === 'all' || f[k] === e[k]) &&
      (!f.flow || f.flow === 'all' || (positiveAmount(e) && e.posting.flow === f.flow)) &&
      [e.title, e.kind, e.note, e.measure].some((value) =>
        String(value || '')
          .toLocaleLowerCase()
          .includes(query),
      ),
  );
}
// A request can mention the visible controls without using them to select records.
// Bind scope once for both the preloaded evidence and later model tool calls.
function eventQueryScope(question) {
  const text = question.replace(/\s+/g, '');
  const allCategories =
    /(?:不限(?:制)?|不分)(?:事项)?(?:类别|分类|类型)|(?:所有|全部)(?:类别|分类|类型)/u.test(text);
  const ignoreView =
    /(?:忽略|跳过|不按|不沿用|不用|不受)(?:当前|现有|页面|任何|已有|本页|的)*(?:视图|过滤|筛选)/u.test(text);
  const inView = /(?:当前|此|本)(?:视图|筛选|预览)|页面上|本页/u.test(text);
  const viewTotal =
    /(?:当前视图|当前筛选|当前预览|本页)(?:里|内|中|下|的|面)*(?:全部|所有|总)(?:支出|收入|收支|金额|账目|消费|交易)/u.test(
      text,
    );
  const monthTotal =
    /(?:月|月份)(?:的|份)*(?:全部|所有|总)(?:已入账的?)?(?:支出|收入|收支|金额|账目|消费|交易)|全月(?:支出|收入|收支|账目|消费|交易|合计|总额)/u.test(
      text,
    );
  const usePage = inView && !ignoreView && !allCategories && (viewTotal || !monthTotal);
  return {
    usePage,
    unfiltered: ignoreView || allCategories || (monthTotal && !usePage),
    allCategories: allCategories || viewTotal || monthTotal,
  };
}
function bounded(range) {
  return (
    range &&
    validDay(range.from) &&
    validDay(range.to) &&
    range.to >= range.from &&
    stamp(range.to) - stamp(range.from) < 366 * DAY
  );
}
function positiveAmount(event) {
  return (
    event.status === 'done' &&
    /^[A-Z]{3}$/.test(event.posting?.currency || '') &&
    ['income', 'expense'].includes(event.posting.flow) &&
    Number.isSafeInteger(event.posting.cents) &&
    event.posting.cents > 0
  );
}
function occurrenceRef(e, goal) {
  return {
    kind: 'event',
    oid: goal.id,
    id: e.id,
    date: e.date,
    title: e.title,
    detail: [e.date + (e.time ? ' ' + e.time : ''), goal.name].join(' · '),
  };
}
export function makeEvidence({
  read,
  binding,
  scene,
  today,
  selected,
  checked,
  currentFilters,
  question,
  previousRange,
  catalog,
  snapshot,
  excludeIds = [],
}) {
  const refs = new Map(),
    covered = new Set();
  let lastRange = null;
  const inferred = period(question, today, selected, previousRange);
  const scope = eventQueryScope(question);
  const register = (ref) => {
    const key = JSON.stringify([ref.oid, ref.kind, ref.id, ref.date]);
    if (!refs.has(key)) refs.set(key, { ...ref, token: 'ref' + (refs.size + 1) });
    return refs.get(key).token;
  };
  const global = scene === 'calendar';
  const draft = scene === 'new' || scene === 'edit';
  async function query(args = {}) {
    if (
      !args ||
      typeof args !== 'object' ||
      Object.keys(args).some(
        (k) =>
          ![
            'kind',
            'from',
            'to',
            'name',
            'objectiveId',
            'keypoint',
            'category',
            'flow',
            'offset',
            'time',
            'duration',
          ].includes(k),
      )
    )
      return { error: 'FORBIDDEN' };
    const kind = args.kind;
    if (!global && args.objectiveId && args.objectiveId !== binding.objectiveId)
      return { error: 'FORBIDDEN' };
    const requested = args.from || args.to ? { from: args.from, to: args.to || args.from } : inferred;
    if (requested && !bounded(requested)) return { error: 'INVALID_DATE_RANGE' };
    if (draft) {
      if (
        kind !== 'overlap' ||
        !validDay(args.from) ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(args.time || '') ||
        !Number.isInteger(args.duration) ||
        args.duration < 1 ||
        args.duration > 1440
      )
        return { error: 'FORBIDDEN' };
      const minutes = (time) => +time.slice(0, 2) * 60 + +time.slice(3, 5);
      const start = stamp(args.from) / 60000 + minutes(args.time);
      const result = await read(
        'calendar.busy',
        { dates: [shift(args.from, -1), args.from, shift(args.from, 1)], excludeIds },
        binding,
      );
      const overlaps = result.slots.flatMap((e) => {
        const at = stamp(e.date) / 60000 + minutes(e.time || '00:00');
        if (at >= start + args.duration || at + e.duration <= start) return [];
        return [{ date: e.date, time: e.time, duration: e.duration }];
      });
      return { scope: '冲突时段', overlaps, complete: !result.errors?.length };
    }
    if (global) {
      if (!['directory', 'schedule'].includes(kind)) return { error: 'FORBIDDEN' };
      const suffixMatches = catalog.spaces.filter(
        (s) => question.includes(s.id) || (s.id.length >= 8 && question.includes(s.id.slice(-8))),
      );
      const quoted = question.match(/[「“]([^」”]{1,60})[」”](?:这个)?(?:目标|空间)?/);
      const direct = catalog.spaces.filter((s) => question.includes(s.name));
      const subject = question
        .replace(/^(?:请|帮我|只看|查看|查询|看看|查查|今天|本周|这个月|明天|本月)+/g, '')
        .match(
          /^([\p{L}\p{N}]{2,30}?)(?:这个)?(?:目标|空间)?(?:今天|明天|本周|本月|的安排|的日程|有哪些安排)/u,
        )?.[1];
      const name = quoted?.[1] || (args.name && question.includes(args.name) ? args.name : '') || subject;
      const named = suffixMatches.length
        ? suffixMatches
        : direct.length
          ? direct
          : name
            ? catalog.spaces.filter((s) => s.name.includes(name))
            : [];
      if ((quoted || args.name) && !named.length && kind === 'schedule')
        return { error: 'NOT_FOUND', message: '未找到所指的可见目标，请按目录名称和标识选择。' };
      let spaces = /勾选|选中的目标/.test(question)
        ? catalog.spaces.filter((s) => checked.includes(s.id))
        : named.length
          ? named
          : catalog.spaces;
      if (args.objectiveId) {
        if (!spaces.some((s) => s.id === args.objectiveId) || !question.includes(args.objectiveId.slice(-8)))
          return { error: '请按名称和标识尾码确认目标' };
        spaces = spaces.filter((s) => s.id === args.objectiveId);
      }
      if (
        kind === 'directory' ||
        (named.length > 1 &&
          (new Set(spaces.map((s) => s.name)).size !== spaces.length || (!direct.length && !!name)))
      ) {
        if (kind === 'directory') spaces.forEach((s) => covered.add(s.id));
        return {
          scope: '可见目标',
          choose: kind !== 'directory',
          spaces: spaces.map(({ id, name }) => ({ id, name })),
          complete: !catalog.errors?.length,
        };
      }
      const r = inferred || requested || { from: today, to: today };
      lastRange = r;
      const result = spaces.length
        ? await read(
            'calendar.range',
            { ...r, objectiveIds: spaces.map((s) => s.id) },
            { trusted: true, global: true },
          )
        : { events: [], errors: [] };
      const byId = new Map(spaces.map((s) => [s.id, s]));
      const rows = result.events.filter(
        (e) => byId.has(e.oid) && (!/待执行|未完成/.test(question) || e.status === 'plan'),
      );
      spaces.forEach((s) => covered.add(s.id));
      const offset = Math.max(0, Number.isSafeInteger(args.offset) ? args.offset : 0);
      return {
        scope: '正式安排',
        range: r,
        complete: !catalog.errors?.length && !result.errors?.length,
        omittedSpaces: new Set(
          [...(result.errors || []), ...(catalog.errors || [])].map((e) => e.objectiveId).filter(Boolean),
        ).size,
        total: rows.length,
        done: rows.filter((e) => e.status === 'done').length,
        offset,
        hasMore: offset + 80 < rows.length,
        rows: rows.slice(offset, offset + 80).map((e) => ({
          ref: register(occurrenceRef(e, byId.get(e.oid))),
          objective: byId.get(e.oid).name,
          date: e.date,
          time: e.time,
          title: e.title,
          status: e.status,
        })),
      };
    }
    const { goal, events, warnings = [] } = snapshot;
    const ks = goal.ks || [];
    if (kind === 'goals')
      return {
        scope: goal.id,
        keypoints: ks.map((k) => ({
          ref: register({ kind: 'k', oid: goal.id, id: k.id, title: k.name, detail: goal.name + ' · K/R' }),
          id: k.id,
          name: k.name,
          standard: k.standard,
          from: k.from,
          to: k.to,
          feedback: k.r || null,
          achievedOn: k.achievedOn || null,
          kind: k.kind,
        })),
      };
    if (!['events', 'ledger', 'feedback'].includes(kind)) return { error: 'FORBIDDEN' };
    let rows = events,
      range = inferred || requested,
      omitted = 0;
    const visibleView = scope.usePage;
    if (range && !visibleView && kind === 'events') {
      const result = await read('calendar.range', range, binding);
      rows = result.events;
      omitted = result.errors?.length || 0;
    }
    if (kind === 'feedback') {
      const k = ks.find((k) => k.id === args.keypoint);
      if (!k) return { error: '先选择本空间的 K' };
      range = { from: k.from, to: k.to };
      rows = rows.filter(
        (e) => e.status === 'done' && (e.note || e.measure) && (!k.kind || e.kind === k.kind),
      );
    }
    if (visibleView) {
      rows = pageFilter(rows, currentFilters, today, selected);
    }
    if (range) rows = rows.filter((e) => e.date >= range.from && e.date <= range.to);
    if (/未来\s*[7七]\s*天.*待执行|待执行事项/.test(question)) rows = rows.filter((e) => e.status === 'plan');
    // A stale category from the visible controls must never narrow an explicitly
    // complete total. A separate named-category query can still narrow that metric.
    const category =
      !scope.allCategories &&
      typeof args.category === 'string' &&
      (!scope.unfiltered || question.includes(args.category))
        ? args.category
        : null;
    if (category) rows = rows.filter((e) => e.kind === category);
    let missingAmounts = 0;
    const amounts = {};
    if (kind === 'ledger') {
      // A completed transaction with a missing amount is unknown. A scheduled
      // reconciliation reminder is an activity and does not contribute an amount.
      rows = rows.filter(
        (e) =>
          e.status === 'done' &&
          (e.posting || /交易|账目|收入|支出|消费|餐饮|交通|工资/.test(e.kind)) &&
          (!args.flow || !e.posting?.flow || e.posting.flow === args.flow),
      );
      missingAmounts = rows.filter((e) => !positiveAmount(e)).length;
      rows = rows.filter(positiveAmount);
      for (const { posting: p } of rows) {
        const totals = (amounts[p.currency] ||= { income: 0, expense: 0 });
        totals[p.flow] += p.cents;
      }
    }
    const offset = Math.max(0, Number.isSafeInteger(args.offset) ? args.offset : 0);
    const complete = !warnings.length && !omitted && !missingAmounts;
    const summary = {
      scope: goal.id,
      selection: visibleView ? '当前视图内的匹配记录' : '整个空间内的匹配记录，不套用页面筛选',
      category: category || (visibleView ? currentFilters?.kind : null) || 'all',
      range: range || '全部匹配日期',
      complete,
      missingAmounts,
      warningCount: warnings.length + omitted,
      ...(kind === 'ledger'
        ? {
            currencyBasis: '原币种分别统计；没有汇率，不作汇率换算，不跨币种合计。',
            flow: args.flow || 'all',
          }
        : {}),
      unit: kind === 'ledger' ? '各币种最小单位（分），不同币种分列' : '计划时长：分钟；实际取 measure/note',
      total: rows.length,
      planMinutes: rows.reduce((n, e) => n + (e.duration || 0), 0),
      completedPlanMinutes: rows
        .filter((e) => e.status === 'done')
        .reduce((n, e) => n + (e.duration || 0), 0),
      amounts,
    };
    return {
      ...summary,
      offset,
      hasMore: offset + 80 < rows.length,
      rows: rows.slice(offset, offset + 80).map((e) => ({
        ref: register(occurrenceRef(e, goal)),
        title: e.title,
        date: e.date,
        time: e.time,
        kind: e.kind,
        plannedMinutes: e.duration,
        status: e.status,
        ...(e.status === 'done' ? { actual: e.measure, note: e.note, posting: e.posting } : {}),
      })),
    };
  }
  let verified = false,
    incomplete = false,
    ledgerResult = null;
  return {
    query: async (args) => {
      const result = await query(args);
      if (!result.error) verified = true;
      if (result.currencyBasis && !ledgerResult) ledgerResult = result;
      if (result.complete === false) incomplete = true;
      return result;
    },
    refs,
    covered,
    get range() {
      return lastRange;
    },
    get ledgerResult() {
      return ledgerResult;
    },
    get verified() {
      return verified;
    },
    get incomplete() {
      return incomplete;
    },
  };
}
