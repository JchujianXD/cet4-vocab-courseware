"use strict";
const test = require('node:test'), assert = require('node:assert/strict');
const S = require('../site/srs.js'), R = require('../site/recall.js'), B = require('../site/backup.js');
const day = '2026-11-02';
function item(i, kind = 'legacy') {
  let c = kind === 'legacy' ? S.upgradeCard({...S.newCard('2026-10-01'), s: 3, n: 4, h: 'gggg', d: day}, 'srs:w'+i, i) : S.freshCard('2026-11-01', 'life'+i);
  if (kind === 'relearn') c = S.rateRecall(c, 'failed', '2026-11-01', {id:'y'+i});
  return {word:'w'+i, card:c, order:i};
}
test('总预算约束所有队列和首次复习；输入不变、词单可复现且不重复', () => {
  const items = Array.from({length:300}, (_,i)=>item(i, i%3===0?'legacy':i%3===1?'relearn':'new'));
  items.push(items[0]); const before = JSON.stringify(items);
  const p = S.makeDailyPlan(items, day);
  assert.ok(p.items.length <= 50 && p.items.length > 0); assert.equal(new Set(p.items.map(x=>x.word)).size, p.items.length);
  assert.equal(S.makeDailyPlan(Array.from({length:80},(_,i)=>item(i,"new")),day).items.length,50);
  assert.deepEqual(new Set(p.items.map(x=>x.kind)), new Set(['calibrate','relearn','review']));
  assert.ok((p.items.length+p.budget.retryLimit)*p.budget.seconds <= 20*60);
  assert.deepEqual(S.makeDailyPlan(items,day),p); assert.equal(JSON.stringify(items),before);
  const weak = items.map(x=>({...x,card:{...x.card,recall:{...x.card.recall,history:[{day:'2026-11-01',result:'failed'}]}}}));
  assert.ok(S.makeDailyPlan(weak,day).budget.limit < 50);
  assert.equal(S.makeDailyPlan(items,day,{cap:12}).items.length,12);
  assert.equal(S.makeDailyPlan(items,day,{cap:12,credited:12}).items.length,0);
});
test('队列不足会让出容量；未到期校准不改变原排期、旧成绩或同步时间', () => {
  const old = item(1), original = {...old.card,d:'2026-12-01'}; old.card=original;
  const doc = {'srs:w1':[original,123], 'srs:gone':[0,124]};
  assert.deepEqual(S.upgradeDoc(doc),doc);
  const p = S.makeDailyPlan([old,...Array.from({length:60},(_,i)=>item(i+2,'new'))],day,{cap:10});
  assert.equal(p.items.length,10); assert.ok(p.items.some(x=>x.kind==='calibrate'));
  assert.equal(old.card.d,'2026-12-01'); assert.equal(old.card.recall.days,0);
  const graded = S.rateRecall(old.card,'independent',day,{id:'calibrate'});
  assert.equal(graded.d,original.d); assert.equal(graded.s,original.s); assert.equal(graded.recall.days,0);
  assert.equal(S.level(graded),S.level(original));
});
test('迁移按校准覆盖、近七日独立表现和负担建议退出；新词无必做条件', () => {
  const items = Array.from({length:10},(_,i)=>item(i));
  const state = S.migrationState(items,day);
  assert.equal(state.mode,'active'); assert.equal(S.migrationStatus(items,day,state).ready,false);
  const graded = items.map((x,i)=>({...x,card:i===9?x.card:S.rateRecall(x.card,'independent',day,{id:'r'+i})}));
  const st = S.migrationStatus(graded,day,state);
  assert.equal(st.calibrated,9); assert.equal(st.ready,true);
  assert.equal(S.migrationStatus(graded,day,{...state,mode:'normal'}).active,false);
  assert.equal(S.migrationState([item(1,'new')],day).mode,'normal');
  assert.equal(S.migrationState(items,S.add(day,60),state),state);
});
test('固定计划完成后积压不会再变成未完成；补测计负担，删除/重建不继承成绩', () => {
  const items=[item(1),item(2)], p=S.makeDailyPlan(items,day), records={};
  for(const x of items) records[x.card.life]={first:{result:'failed'},retryWanted:true};
  let s=S.dailyStatus(p,items,records); assert.equal(s.completed,2); assert.equal(s.finished,false);
  for(const x of items) records[x.card.life].retry={result:'independent'};
  s=S.dailyStatus(p,[...items,...Array.from({length:80},(_,i)=>item(i+3))],records);
  assert.equal(s.finished,true); assert.equal(s.total,2); assert.equal(s.workload,4);
  const rebuilt={...items[0],card:S.freshCard(day,'replacement')};
  assert.equal(S.dailyStatus(p,[rebuilt],{}).finished,true);
  assert.equal(S.makeDailyPlan([rebuilt],day).items.length,0);
});
test('计划与完成合并可交换、幂等，晚到旧快照不能清除首次或补测；墓碑不复活', () => {
  const items=[item(1)], p=S.makeDailyPlan(items,day,{id:'A',created:1}), q=S.makeDailyPlan(items,day,{id:'B',created:2});
  assert.deepEqual(S.mergeStudyRecord('plan:'+day,[p,1],[q,20]),[p,1]);
  assert.deepEqual(S.mergeStudyRecord('plan:'+day,[q,20],[p,1]),[p,1]);
  const a=[{life:'life',first:{result:'failed',at:1},retryWanted:true},1];
  const b=[{life:'life',first:{result:'failed',at:1},retry:{result:'independent',at:2},retryWanted:true},2];
  const merged=S.mergeStudyRecord('task:x',a,b);
  assert.deepEqual(merged,S.mergeStudyRecord('task:x',b,a));
  assert.deepEqual(merged,S.mergeStudyRecord('task:x',merged,a));
  assert.deepEqual(S.mergeStudyRecord('task:x',merged,[0,3]),[0,3]);
});
test('备份对新状态分类并保持同步合并规则；跨日只忽略断点，历史任务和晚间保留', () => {
  const p=S.makeDailyPlan([item(1)],day,{id:'A',created:1});
  const q={...p,id:'B',created:2}, t=S.taskKey(day,'life');
  const local={['plan:'+day]:[p,1], [t]:[{life:'life',first:{result:'failed',at:1},retry:{result:'independent',at:2},retryWanted:true},2]};
  const remote={['plan:'+day]:[q,20], [t]:[{life:'life',first:{result:'failed',at:1}},30], 'migration:state':[S.migrationState([item(1)],day),1], 'evening:2026-11-01':[{finished:true},1], 'drill:due':[{d:'2026-11-01',w:['w1']},1]};
  assert.equal(B.catOf('plan:'+day),'study'); assert.equal(B.catOf(t),'study'); assert.equal(B.catOf('migration:state'),'study');
  const out=Object.fromEntries(B.plan(local,remote,['study'],'merge',new Date(2026,10,2,12).getTime()));
  assert.equal(out['plan:'+day],undefined); assert.ok(out[t][0].retry);
  assert.ok(out['evening:2026-11-01']); assert.ok(out['migration:state']); assert.equal(out['drill:due'],undefined);
  const restored=B.parse(B.text({...local,...out},Date.now(),'test')); assert.deepEqual(restored.d,{...local,...out});
});
test('恢复当日分词结果不重放主任务，旧快照不能复活已完成补测，提示状态保留', () => {
  const items=[item(1),item(2)], s=R.create(items,day,'plan');
  s.current.hints=['video']; s.current.revealed=true;
  let n=R.restoreDaily(s,{}); assert.deepEqual(n.current,s.current);
  n=R.restoreDaily(s,{w1:{first:{result:'failed'},retryWanted:true}});
  assert.equal(n.current.w,'w2'); assert.ok(n.queue.some(q=>q.w==='w1'&&q.retry));
  n=R.restoreDaily(n,{w1:{first:{result:'failed'},retryWanted:true,retry:{result:'independent'}}});
  assert.ok(!n.queue.some(q=>q.w==='w1')); assert.equal(n.first.w1.result,'failed');
});

test('先打开空首页再导入旧卡会进入迁移，主动退出后新导入的少量旧卡不重开迁移界面', () => {
  const empty=S.migrationState([],day), restored=S.migrationState([item(1)],day,empty);
  assert.equal(restored.mode,'active');assert.equal(restored.cohort.length,1);
  assert.equal(S.migrationState([item(1),item(2)],day,restored).cohort.length,2);
  const exited={...restored,mode:'normal',ended:day};
  assert.equal(S.migrationState([item(1),item(2)],day,exited),exited);
  assert.ok(S.makeDailyPlan([item(2)],day).items.some(x=>x.kind==='calibrate'));
});

test('显式覆盖备份能替换固定计划和完成记录，旧云端不能反盖恢复批次', () => {
  const p=S.makeDailyPlan([item(1)],day,{created:1,id:'old'}), q=S.makeDailyPlan([item(2)],day,{created:2,id:'restore'});
  const local={['plan:'+day]:[p,1], 'task:test':[{life:'life',first:{result:'failed',at:1}},1]};
  const file={['plan:'+day]:[q,2], 'task:test':[{life:'life',first:{result:'independent',at:2}},2]};
  const out=Object.fromEntries(B.plan(local,file,['study'],'overwrite',100));
  assert.equal(out['plan:'+day][0].id,'restore');assert.equal(out['plan:'+day][0].reset,100);
  assert.deepEqual(S.mergeStudyRecord('plan:'+day,out['plan:'+day],local['plan:'+day]),out['plan:'+day]);
  assert.equal(S.mergeStudyRecord('task:test',out['task:test'],local['task:test'])[0].first.result,'independent');
});

test('离线设备另一份计划的已完成主任务抵扣总预算，并保留待补测，不在同步后加量', () => {
  const items=[item(1),item(2),item(3),item(4)], plan=S.makeDailyPlan(items.slice(0,2),day,{cap:2});
  const records=Object.fromEntries(items.slice(2).map(x=>[x.card.life,{d:day,life:x.card.life,word:x.word,first:{result:'independent',planned:true,at:1}}]));
  let status=S.dailyStatus(plan,items,records);
  assert.equal(status.total,2);assert.equal(status.completed,2);assert.equal(status.finished,true);assert.equal(status.todo,0);assert.equal(status.workload,2);
  records[items[2].card.life].first.result='failed';records[items[2].card.life].retryWanted=true;
  status=S.dailyStatus(plan,items,records);assert.equal(status.completed,2);assert.equal(status.finished,false);assert.equal(status.todo,1);
  assert.equal(status.rows.filter(x=>x.pendingRetry)[0].word,'w3');
});
