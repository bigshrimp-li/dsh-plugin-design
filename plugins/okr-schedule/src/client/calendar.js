import {
  B,
  I,
  byTime,
  dateObj,
  days,
  dow,
  empty,
  esc,
  icon,
  inkFor,
  md,
  minutes,
  monday,
  monthShift,
  pad,
  shift,
  stateName,
  weekOf,
} from './common.js';

export function calendarBounds(date, mode) {
  if (mode === 'day') return { from: date, to: date };
  if (mode === 'week') return { from: monday(date), to: shift(monday(date), 6) };
  const first = date.slice(0, 7) + '-01';
  const last = shift(monthShift(first, 1), -1);
  return { from: monday(first), to: shift(monday(last), 6) };
}

// A lane is reused only after the previous event's visible block ends.
function assignLanes(events) {
  const result = [];
  let cluster = [],
    ends = [];
  function flush() {
    for (const row of cluster) result.push({ ...row, lanes: ends.length });
    cluster = [];
    ends = [];
  }
  for (const event of events) {
    const start = minutes(event.time);
    if (ends.length && start >= Math.max(...ends)) flush();
    let lane = ends.findIndex((end) => end <= start);
    if (lane < 0) lane = ends.length;
    ends[lane] = start + Math.max(24, event.duration || 1);
    cluster.push({ event, lane });
  }
  flush();
  return result;
}

export function createCalendarUI(ctx) {
  const { ui, db } = ctx;
  const goal = (id) => db.spaces.find((space) => space.id === id);
  function buttonFor(event, content, className, extraStyle = '') {
    const attrs =
      'data-oid="' +
      esc(event.oid) +
      '" data-occurrence="' +
      esc(event.occurrenceKey || '') +
      '" data-date="' +
      esc(event.date) +
      '" style="--c:' +
      inkFor(goal(event.oid)) +
      ';' +
      extraStyle +
      '" title="' +
      esc([event.time, event.title, goal(event.oid)?.name].filter(Boolean).join(' · ')) +
      '"';
    return B('event', content, className, event.id, attrs);
  }
  function monthGrid(events) {
    const month = ui.date.slice(0, 7);
    const { from, to } = calendarBounds(ui.date, 'month');
    const cells = [];
    for (let date = from; date <= to; date = shift(date, 1)) {
      const rows = events.filter((event) => event.date === date);
      const classes = [
        'day',
        date.slice(0, 7) !== month && 'outside',
        dow(date) > 4 && 'weekend',
        date === ui.date && 'selected',
      ]
        .filter(Boolean)
        .join(' ');
      const day = B(
        'select-date',
        Number(date.slice(8)),
        'daynum' + (date === ctx.today() ? ' today' : ''),
        date,
        'aria-label="选择 ' + date + '"',
      );
      const items = rows
        .slice(0, 2)
        .map((event) =>
          buttonFor(
            event,
            '<time>' + esc(event.time) + '</time><span>' + esc(event.title) + '</span>',
            'eventchip',
          ),
        )
        .join('');
      const overflow = rows.length > 2 ? B('go-day', '+' + (rows.length - 2) + ' 项', 'more', date) : '';
      cells.push(
        '<div class="' + classes + '" data-cell="' + date + '">' + day + items + overflow + '</div>',
      );
    }
    return (
      '<div class="weekday">' +
      days.map((d) => '<span>' + d + '</span>').join('') +
      '</div><div class="month-grid">' +
      cells.join('') +
      '</div>'
    );
  }
  function timeGrid(events) {
    const dates = ui.cal === 'day' ? [ui.date] : days.map((_, i) => shift(monday(ui.date), i));
    const rows = events.filter((event) => dates.includes(event.date));
    const scheduled = rows.filter((event) => /^\d\d:\d\d$/.test(event.time));
    const starts = scheduled.map((event) => minutes(event.time));
    const ends = scheduled.map((event) => minutes(event.time) + (event.duration || 1));
    const first = Math.floor(Math.min(420, ...starts) / 60);
    const last = Math.min(24, Math.ceil(Math.max(1260, ...ends) / 60));
    const hours = Array.from(
      { length: last - first },
      (_, i) => '<small style="top:' + (i * 42 + 1) + 'px">' + pad(i + first) + ':00</small>',
    ).join('');
    const tracks = dates.map((date) => {
      const blocks = assignLanes(scheduled.filter((event) => event.date === date)).map(
        ({ event, lane, lanes }) => {
          const start = minutes(event.time);
          const top = (start - first * 60) * 0.7;
          const height = Math.max(17, Math.min(event.duration || 1, 1440 - start) * 0.7 - 1);
          const style = `left:calc(${(lane * 100) / lanes}% + 1px);width:calc(${100 / lanes}% - 2px);top:${top}px;height:${height}px`;
          return buttonFor(
            event,
            '<span>' + esc(event.time) + '</span>' + esc(event.title),
            'block-event',
            style,
          );
        },
      );
      return '<div class="track">' + blocks.join('') + '</div>';
    });
    const header = dates
      .map((date) =>
        B(
          'go-day',
          days[dow(date)] + ' ' + Number(date.slice(8)),
          'time-label' + (date === ui.date ? ' current' : ''),
          date,
        ),
      )
      .join('');
    const untimed = rows
      .filter((event) => !scheduled.includes(event))
      .map((event) => buttonFor(event, esc(event.title) + ' · 时间未记录', 'btn small'))
      .join('');
    return `${untimed}<div class="timescroll" style="--days:${dates.length};--track-h:${(last - first) * 42}px;--time-min:${dates.length === 1 ? 0 : 470}px">
      <div class="time-head"><div></div>${header}</div>
      <div class="time-body"><div class="axis">${hours}</div>${tracks.join('')}</div></div>`;
  }
  function agendaRow(event) {
    const subtitle = [goal(event.oid)?.name, event.kind, event.measure].filter(Boolean).join(' · ');
    const content = `<i class="dot"></i><time>${esc(event.time || '未定')}</time>
      <span class="grow"><strong>${esc(event.title)}</strong><small>${esc(subtitle)}</small></span>
      <span class="state ${event.status === 'done' ? 'done' : ''}">${stateName(event.status)}</span>${icon('right')}`;
    return buttonFor(event, content, 'erow');
  }
  function page() {
    const rows = db.events.filter((event) => ui.shown.has(event.oid)).sort(byTime);
    const day = rows.filter((event) => event.date === ui.date);
    const { from, to } = calendarBounds(ui.date, ui.cal);
    const period =
      ui.cal === 'month'
        ? rows.filter((event) => event.date.slice(0, 7) === ui.date.slice(0, 7))
        : rows.filter((event) => event.date >= from && event.date <= to);
    const date = dateObj(ui.date);
    const titles = {
      month: date.getFullYear() + ' 年 ' + (date.getMonth() + 1) + ' 月',
      week: md(from) + ' — ' + md(to),
      day: md(ui.date) + ' · ' + days[dow(ui.date)],
    };
    const modes = [
      ['month', '月'],
      ['week', '周'],
      ['day', '日'],
    ]
      .map(([mode, name]) =>
        B(
          'cal-mode',
          name,
          ui.cal === mode ? 'active' : '',
          mode,
          'aria-label="' + name + '视图" aria-pressed="' + (ui.cal === mode) + '"',
        ),
      )
      .join('');
    const legend = db.spaces
      .filter((s) => ui.shown.has(s.id))
      .map((s) => '<span><i class="dot" style="--c:' + inkFor(s) + '"></i>' + esc(s.name) + '</span>')
      .join('');
    const partial = ui.warnings.length > 0;
    const none = partial
      ? empty('当前只显示已读取的安排，暂未找到匹配事项。')
      : !db.spaces.length
        ? empty('还没有目标空间。') + B('create', '创建空间', 'btn soft')
        : !ui.shown.size
          ? empty('勾选目标后即可查看相应事项。') + B('goals', '选择目标', 'btn small')
          : empty('所选日期暂无事项。');
    const navigation =
      I('prev', 'left', '上一时段') + B('today', '今天', 'btn small ghost') + I('next', 'right', '下一时段');
    return `<div class="pagehead"><div class="grow">
      <div class="over">WORKSPACE / CALENDAR</div><h1>日程总览</h1>
      <p class="headsub">已选 ${ui.shown.size} 个目标 · 当前视图${partial ? '已读取 ' : ' '}${period.length} 项安排</p>
      </div>${ctx.headButtons()}</div>
      <section class="calpanel"><div class="caltools">
        <div class="grow"><h2>${titles[ui.cal]}</h2></div><span class="arrowset">${navigation}</span>
        <div class="seg" aria-label="日历维度">${modes}</div></div>
        ${ui.cal === 'month' ? monthGrid(rows) : timeGrid(rows)}
        <div class="calfoot"><span class="legend">${legend || '未选择目标'}</span>
          <span class="mono">W${pad(weekOf(ui.date))} · ${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}</span>
        </div></section>
      <section class="agenda"><div class="sectionhead"><span class="over">AGENDA</span>
        <h2>${md(ui.date)}的安排</h2><span class="tag">${day.length} 项</span><span class="grow"></span>
        ${B('new-event', '＋ 添加事项', 'minilink')}</div>
        <div class="box">${day.length ? day.map(agendaRow).join('') : none}</div></section>`;
  }
  return { page };
}
