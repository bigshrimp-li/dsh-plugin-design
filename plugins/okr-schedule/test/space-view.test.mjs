import test from 'node:test';
import assert from 'node:assert/strict';
import { krGroup, krPeriod, layoutDefault, newFilters } from '../src/client/common.js';
import { groupGoals } from '../src/client/space.js';
import { aggregateLabel, matchEvents, renderGroups } from '../src/client/space-view.js';
import { isValidDraft, overlaps } from '../src/client/creator.js';

const day = '2026-11-05';
const event = (id, date, minutes, status = 'plan') => ({
  id, title:id, date, time:'19:30', duration:minutes, status, kind:'词汇',
  note:status === 'done' ? '独立复测' : '', measure:id === '复测' ? '实测16词' : ''
});

test('the local day, cutoff, achievement and stored R determine three exclusive K groups', () => {
  const k = { id:'K1', name:'词汇', from:'2026-11-01', to:day, r:'同一份反馈' };
  assert.equal(krPeriod(k,day),'今天截止');
  assert.equal(krGroup(k,day),'pending');
  assert.equal(krGroup(k,'2026-11-06'),'expired');
  const early = {...k, id:'K0', achievedOn:'2026-11-03'};
  const late = {...k, id:'K2', achievedOn:'2026-11-07'};
  const groups = groupGoals([early,late,k],'2026-11-08');
  assert.deepEqual(groups.achieved.map(x => x.k.id),['K2','K0']);
  assert.equal(groups.expired[0].k.r,'同一份反馈');
  assert.equal(groups.pending.length,0);
});

test('selected week is Monday to Sunday; current week, relative dates, and all intersecting filters re-evaluate', () => {
  const events = [
    event('新词','2026-11-04',20,'done'),event('复测',day,15,'done'),event('巩固','2026-11-08',20),
    event('下周','2026-11-09',10),event('上月','2026-10-31',10),{...event('听力',day,10),kind:'听力'}
  ];
  const date = '2026-11-12';
  const selected = { ...newFilters(), kind:'词汇',range:'week' };
  const week = matchEvents(events,selected,day,date);
  assert.equal(aggregateLabel(week,'minutes'),'55 分钟'); assert.equal(aggregateLabel(week,'rate'),'67% 完成');
  const done = matchEvents(events,{...selected,status:'done',query:'独立复测'},day,date);
  assert.equal(aggregateLabel(done,'minutes'),'35 分钟');
  assert.deepEqual(matchEvents(events,{...selected,query:'16词'},day,date).map(e => e.title),['复测']);
  assert.deepEqual(matchEvents(events,{...selected,range:'thisWeek'},day,date).map(e=>e.title),['下周']);
  assert.equal(matchEvents(events,{...selected,range:'month'},'2026-10-30',date).length,1);
  assert.equal(matchEvents(events,{...selected,range:'thisMonth'},'2026-10-30',date).length,4);
  assert.equal(matchEvents(events,{...selected,range:'upcoming'},day,date).length,0);
  assert.equal(matchEvents(events,{...selected,range:'all',query:'听力'},day,date).length,0);
  const keyGroups = { kind:1,date:3,week:1,month:1,status:2,none:1 };
  for (const [group, count] of Object.entries(keyGroups)) {
    const html = renderGroups(week,{...layoutDefault(),group},{ color:'#0e7490' });
    assert.equal((html.match(/class="group-title"/g)||[]).length,count);
    assert.equal((html.match(/data-act="space-event"/g)||[]).length,week.length);
  }
});

test('draft validation and half-open overlap include the following day', () => {
  const e = {...event('事项',day,60), time:'23:40'};
  assert.equal(overlaps(e,[{...e,date:'2026-11-06',time:'00:39'}]),true);
  assert.equal(overlaps(e,[{...e,date:'2026-11-06',time:'00:40'}]),false);
  const goal={ id:'draft',name:'目标',about:'',ks:[{name:'标准',standard:'实测',from:day,to:day}],layout:layoutDefault() };
  assert.equal(isValidDraft({goal,mode:'new',events:[e]}),true);
  assert.equal(isValidDraft({goal:{...goal,name:'甲'.repeat(41)},mode:'new',events:[e]}),false);
  assert.equal(isValidDraft({goal,mode:'new',events:[e,{...e,title:''}]}),false);
  assert.equal(isValidDraft({goal,mode:'edit',baseGoal:goal,events:[],baseEvents:[]}),true);
  assert.equal(isValidDraft({goal:{...goal,ks:[{...goal.ks[0],standard:'新标准'}]},mode:'edit',baseGoal:goal,events:[],baseEvents:[]}),false);
});
