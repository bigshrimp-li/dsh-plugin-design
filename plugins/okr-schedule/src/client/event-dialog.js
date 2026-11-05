import { $, B, days, dow, esc, inkFor, options, stateName, uid, validDate } from './common.js';

export function createEventDialog(ctx) {
  const { ui, db } = ctx;
  function openNewEvent(oid) {
    const writable = db.spaces.filter((s) => s.migrated !== false && !s.archivedAt);
    if (oid && !writable.some((s) => s.id === oid)) throw new Error('当前空间只读，无法添加事项。');
    const initial = oid || writable.find((s) => ui.shown.has(s.id))?.id || writable[0]?.id;
    ctx.openModal('new-event', {
      oid: initial,
      locked: Boolean(oid),
      requestId: uid('web'),
      id: uid('event'),
    });
  }
  async function openEvent(record) {
    const { view, sid, modal } = ui;
    const scope = record.oid;
    if (record.legacy || db.spaces.find((s) => s.id === scope)?.migrated === false) {
      return ctx.openModal('event', { event: record, readOnly: true });
    }
    const { event } = await ctx.api(
      'calendar.event.get',
      { id: record.id, occurrenceKey: record.occurrenceKey, date: record.date },
      scope,
    );
    if (ui.view !== view || ui.sid !== sid || ui.modal !== modal) return;
    if (!event) throw new Error('这条事项已不可用');
    ctx.openModal('event', { event, requestId: uid('web') });
  }
  function modal(type, m) {
    const cancel = B('close', '取消', 'btn ghost');
    if (type === 'new-event') {
      const writable = db.spaces.filter((s) => s.migrated !== false && !s.archivedAt);
      if (!writable.length)
        return {
          title: '添加日程事项',
          body: '先创建一个可用的目标空间。',
          actions: B('create', '创建空间', 'btn primary'),
        };
      return {
        title: '添加日程事项',
        body:
          '<div class="formgrid"><label class="field full">所属 O<select id="ev-oid" ' +
          (m.locked ? 'disabled' : '') +
          '>' +
          options(
            writable.map((s) => [s.id, ctx.spaceLabel(s)]),
            m.oid,
          ) +
          '</select></label>' +
          '<label class="field full">事项名称<input id="ev-title" maxlength="80" placeholder="例如：词汇复测"></label>' +
          '<label class="field">日期<input id="ev-date" type="date" value="' +
          esc(ui.date) +
          '"></label>' +
          '<label class="field">开始时间<input id="ev-time" type="time" value="19:30"></label>' +
          '<label class="field">类型<input id="ev-kind" value="实践"></label>' +
          '<label class="field">计划时长（分钟）<input id="ev-duration" type="number" min="1" max="1440" value="30"></label></div>',
        actions: cancel + B('add-event-save', '保存事项', 'btn primary'),
      };
    }
    if (type !== 'event') return;
    const e = m.event,
      s = db.spaces.find((s) => s.id === e.oid);
    const schedule = [
      e.date,
      validDate(e.date) ? days[dow(e.date)] : '',
      e.time || '时间未记录',
      e.posting ? '实际发生' : e.duration ? e.duration + ' 分钟' : '时长未记录',
    ]
      .filter(Boolean)
      .map(esc)
      .join(' · ');
    if (m.readOnly)
      return {
        title: e.title,
        body:
          '<p>' +
          esc(s?.name) +
          '</p><p>' +
          schedule +
          '</p><p>' +
          esc(e.kind) +
          ' · ' +
          stateName(e.status) +
          '</p><p>旧空间的执行情况可在记录工作台核对。</p>',
        actions: B('close', '关闭', 'btn ghost') + B('legacy', '打开记录工作台', 'btn primary', s.id),
      };
    const amount = e.posting
      ? '<div class="formgrid"><label class="field">方向<select id="ev-flow">' +
        options(
          [
            ['expense', '支出'],
            ['income', '收入'],
          ],
          e.posting.flow,
        ) +
        '</select></label>' +
        '<label class="field">金额（' +
        esc(e.posting.currency) +
        '）<input id="ev-amount" inputmode="decimal" value="' +
        esc((e.posting.cents / 100).toFixed(2)) +
        '"></label></div>'
      : '';
    return {
      title: e.title,
      body:
        '<span class="tag" style="color:' +
        inkFor(s) +
        '">' +
        esc(s?.name) +
        '</span><dl class="detail-meta"><dt>安排</dt><dd>' +
        schedule +
        '</dd><dt>类型 / 状态</dt><dd>' +
        esc(e.kind) +
        ' · ' +
        stateName(e.status) +
        '</dd></dl>' +
        amount +
        '<label class="field">实际情况<textarea id="event-note" rows="3" placeholder="写下这一次做了什么">' +
        esc(e.note) +
        '</textarea></label><label class="field">实测结果<input id="event-measure" value="' +
        esc(e.measure) +
        '"></label>',
      actions:
        B('space', '打开所属空间', 'btn ghost', e.oid) +
        B(
          'save-event',
          e.status === 'done' ? '保存执行记录' : '完成并保存',
          'btn primary',
          '',
          s?.archivedAt ? 'disabled' : '',
        ),
    };
  }
  async function dispatch(action) {
    const m = ui.modal;
    if (action === 'add-event-save' && m?.type === 'new-event') {
      const event = {
        id: m.id,
        oid: m.locked ? m.oid : $('#ev-oid').value,
        title: $('#ev-title').value.trim(),
        date: $('#ev-date').value,
        time: $('#ev-time').value,
        duration: Number($('#ev-duration').value),
        kind: $('#ev-kind').value.trim() || '实践',
      };
      if (!event.title || event.title.length > 80) throw new Error('事项名称须为 1 至 80 个字符。');
      if (!validDate(event.date)) throw new Error('请填写有效日期。');
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(event.time)) throw new Error('请填写有效的开始时间。');
      if (!Number.isInteger(event.duration) || event.duration < 1 || event.duration > 1440)
        throw new Error('计划时长须为 1 至 1440 的整数分钟。');
      await ctx.api('calendar.event.save', { event, requestId: m.requestId }, event.oid);
      ui.date = event.date;
      ui.shown.add(event.oid);
    } else if (action === 'save-event' && m?.type === 'event') {
      const event = {
        ...m.event,
        note: $('#event-note').value.trim(),
        measure: $('#event-measure').value.trim(),
        status: 'done',
      };
      if (event.posting) {
        const value = $('#ev-amount').value.trim();
        if (!/^\d{1,9}(\.\d{1,2})?$/.test(value) || Number(value) <= 0)
          throw new Error('请输入正金额，最多九位整数、两位小数。');
        const [integer, decimal = ''] = value.split('.');
        event.posting = {
          ...event.posting,
          flow: $('#ev-flow').value,
          cents: Number(integer) * 100 + Number(decimal.padEnd(2, '0')),
        };
      }
      await ctx.api('calendar.execution.save', { event, requestId: m.requestId }, event.oid);
    } else return false;
    ctx.closeModal();
    await ctx.refresh();
    ctx.toast(action === 'save-event' ? '已保存本次执行记录' : '事项已排入日程');
    return true;
  }
  return { modal, dispatch, openNewEvent, openEvent };
}
