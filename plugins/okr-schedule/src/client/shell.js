import { $, B, days, dow, esc, icon, inkFor, mark, md, options, pad } from './common.js';

export function createShell(ctx) {
  const { ui, db } = ctx;
  const spaceLabel = (s) =>
    db.spaces.filter((other) => s.name === other.name).length > 1 ? s.name + ' · ' + s.id.slice(-8) : s.name;
  function top(studio = false) {
    const navigation = studio
      ? ''
      : '<nav class="topnav" aria-label="插件页面">' +
        B('calendar', icon('calendar') + '日程', 'navbtn ' + (ui.view === 'calendar' ? 'active' : '')) +
        B('space', icon('grid') + '空间', 'navbtn ' + (ui.view === 'space' ? 'active' : ''), ui.sid) +
        '</nav>';
    const zoom = options(
      [0.8, 0.9, 1, 1.1, 1.25].map((x) => [String(x), Math.round(x * 100) + '%']),
      String(ui.zoom),
    );
    return (
      '<header class="top">' +
      B('host', icon('exit') + '返回 DSH', 'exit') +
      '<span class="topline"></span><span class="brand">' +
      mark() +
      '<span class="desk-name">' +
      (studio ? '创造模式' : '目标日程') +
      '</span></span>' +
      navigation +
      '<span class="spacer"></span><select class="scale" id="scale" aria-label="插件显示比例">' +
      zoom +
      '</select>' +
      (studio
        ? B('creator-back', '关闭创造模式', 'btn ghost')
        : B('create', icon('add') + '创建空间', 'btn primary')) +
      '</header>'
    );
  }
  function goalRows() {
    return db.spaces
      .map(
        (s) =>
          '<div class="rail-item ' +
          (ui.view === 'space' && ui.sid === s.id ? 'on-space' : '') +
          '" style="--c:' +
          inkFor(s) +
          '"><label><input type="checkbox" data-filter-goal="' +
          esc(s.id) +
          '" aria-label="在日历中显示' +
          esc(s.name) +
          '" ' +
          (ui.shown.has(s.id) ? 'checked' : '') +
          '></label>' +
          B(
            'space',
            '<span>' + esc(spaceLabel(s)) + '</span>' + icon('right'),
            'goal-open',
            s.id,
            'aria-label="打开空间 ' + esc(s.name) + '"',
          ) +
          '</div>',
      )
      .join('');
  }
  function headButtons() {
    return (
      '<div class="row">' +
      (ui.view === 'calendar' && db.spaces.length
        ? B('delete-global', '删除空间', 'btn danger ghost mobile-only')
        : '') +
      B('goals', icon('filter') + '目标', 'btn mobile-filter') +
      B('chat-toggle', icon('panel') + (ui.chat ? '收起助手' : '打开助手'), 'btn ghost') +
      '</div>'
    );
  }
  function shell(content) {
    const today = ctx.today();
    const rail =
      '<aside class="rail" aria-label="目标与筛选"><div class="rail-pad">' +
      B(
        'today',
        '<span class="over">' +
          today.slice(0, 7) +
          '</span><span class="big-day">' +
          today.slice(8) +
          '</span><small>' +
          md(today) +
          ' · ' +
          days[dow(today)] +
          '</small>',
        'date-card',
      ) +
      '</div><div><div class="between rail-pad"><strong class="rail-label">目标空间</strong><span class="micro mono">' +
      pad(db.spaces.length) +
      '</span></div><div class="rail-list">' +
      goalRows() +
      '</div><div class="rail-pad wrap">' +
      B('all-goals', '全选', 'minilink') +
      B('no-goals', '清空', 'minilink') +
      (ui.view === 'calendar' && db.spaces.length
        ? B('delete-global', '删除空间', 'minilink del-link')
        : '') +
      '</div></div><div class="rail-foot">' +
      B('legacy', '记录与 Bot 工作台 ↗', 'legacy-link') +
      '</div></aside>';
    const mobile =
      '<nav class="mobile-pages">' +
      B('calendar', icon('calendar') + '日程', 'navbtn') +
      B('choose-space', icon('grid') + '目标空间', 'navbtn') +
      '<span class="grow"></span>' +
      B('legacy', '记录与 Bot', 'minilink') +
      '</nav>';
    return (
      '<div class="shell">' +
      top() +
      mobile +
      '<div class="bodygrid ' +
      (ui.chat ? '' : 'chat-off') +
      '">' +
      rail +
      '<main class="mainpane" id="mainpane"><div class="maininner">' +
      content +
      '</div></main>' +
      (ui.chat ? ctx.assistantUI.panel() : '') +
      '</div></div>'
    );
  }
  function sizeUI() {
    const surface = $('#surface'),
      w = innerWidth / ui.zoom,
      h = innerHeight / ui.zoom;
    surface.style.zoom = ui.zoom;
    surface.style.width = w + 'px';
    surface.style.height = h + 'px';
    surface.style.setProperty(
      '--kr-height',
      Math.round(Math.max(164, Math.min(334, h * (w < 735 ? 0.43 : 0.34)))) + 'px',
    );
    ui.fit = w < 735 ? 'small' : w < 1010 ? 'narrow' : w < 1210 ? 'mid' : 'wide';
    surface.dataset.fit = ui.fit;
    const overlay = ['small', 'narrow'].includes(ui.fit);
    const maximum = Math.max(210, Math.min(540, w - (overlay ? 24 : ui.fit === 'mid' ? 560 : 628)));
    const width = Math.min(maximum, Math.max(225, ui.chatWidth));
    surface.style.setProperty('--assistant', width + 'px');
    const splitter = $('.splitter');
    if (splitter) {
      splitter.setAttribute('aria-valuenow', Math.round(width));
      splitter.setAttribute('aria-valuemax', Math.round(maximum));
    }
    const list = $('#kr-list');
    if (list)
      list.nextElementSibling?.classList.toggle('overflow', list.scrollHeight > list.clientHeight + 1);
  }
  return { top, goalRows, headButtons, shell, sizeUI, spaceLabel };
}
