"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const S = require("../site/srs.js"), R = require("../site/recall.js"), B = require("../site/backup.js");
const day = "2026-10-28", fresh = () => S.freshCard("2026-10-27", "test");
const items = n => Array.from({length: n}, (_, i) => ({word: "word" + i, card: {...fresh(), life: "life" + i}}));
function answer(s, result) { s.current.revealed = true; return R.next(R.answer(s, result)); }

test("保存独立快照，后续展开与揭晓不能原地改掉已存文档而漏写", () => {
  const s = R.hint(R.create(items(1), day, "task"), "memory"), saved = R.snapshot(s);
  s.current.layer = 1; s.current.revealed = true;
  assert.equal(saved.rc.current.layer, 0); assert.equal(saved.rc.current.revealed, false);
  assert.notDeepEqual(R.snapshot(s), saved);
  const reloaded = R.create(items(1), day, "other", R.snapshot(s).rc);
  assert.equal(reloaded.current.layer, 1); assert.equal(reloaded.current.revealed, true);
});

test("提示永久保存；直接揭晓不算提示；四选一错不能自评成功", () => {
  let s = R.create(items(2), day, "one");
  s = R.hint(s, "audio"); s = R.hint(s, "memory"); s = R.hint(s, "audio");
  s = R.create(items(2), day, "other", JSON.parse(JSON.stringify(s)));
  assert.deepEqual(s.current.hints, ["audio", "memory"]);
  s.current.revealed = true; s = R.answer(s, "independent");
  assert.equal(s.first.word0.result, "hinted");
  assert.deepEqual(R.answer(s, "failed"), s);         // 双击不能覆盖首次
  s = R.next(s); s.current.revealed = true; s.current.choiceWrong = true;
  s = R.answer(s, "hinted"); assert.equal(s.first.word1.result, "failed");
});
test("补测隔三个其他词，每词最多一次、全轮最多五张，全部失败也能结束", () => {
  let s = R.create(items(9), day, "task"); s = answer(s, "failed");
  assert.deepEqual(s.queue.slice(0, 4).map(q => q.w), ["word1", "word2", "word3", "word0"]);
  let n = 1;
  while (s.current) { assert.ok(++n <= 14); s = answer(s, "failed"); }
  const result = R.summary(s);
  assert.equal(n, 14); assert.equal(result.completed, 9); assert.equal(result.retries, 5);
  assert.equal(result.strengthen.length, 9); assert.ok(result.finished);
});
test("补测独立成功不覆盖首次失败；单词很少时队列仍有限", () => {
  let s = answer(R.create(items(1), day, "task"), "failed");
  assert.deepEqual(s.current.hints, []); assert.equal(s.current.revealed, false);
  s = answer(s, "independent");
  assert.equal(s.first.word0.result, "failed"); assert.equal(R.summary(s).retrySuccess, 1);
  assert.deepEqual(R.summary(s).strengthen, []);
});
test("卡片生命周期改变或删除，断点不能继承旧结果；旧选择成绩保留原义", () => {
  let s = answer(R.create(items(2), day, "a"), "independent");
  const changed = items(2); changed[0].card.life = "reborn";
  s = R.create(changed, day, "b", s);
  assert.equal(s.first.word0, undefined); assert.ok(s.queue.some(q => q.w === "word0"));
  s = R.create(items(2), day, "legacy", {rated: {word0: "g"}, done: ["word0"]});
  assert.equal(R.summary(s).legacy, 1); assert.equal(R.summary(s).independent, 0);
});
test("旧版未完成失败词继续有限补测，不把旧成绩或补测成功追认为首次独立回忆", () => {
  let s = R.create(items(1), day, "legacy", {rated: {word0: "f"}, done: []});
  assert.equal(s.current.retry, true); assert.equal(s.added, 1);
  s = answer(s, "independent");
  assert.equal(R.summary(s).legacy, 1); assert.equal(R.summary(s).independent, 0);
  assert.equal(R.summary(s).retrySuccess, 1); assert.ok(R.summary(s).finished);
});
test("晚间独立完成、跳过、追加词，不从白天答题日期推断", () => {
  const a = items(2); a.forEach(x => x.card.t = day);
  assert.equal(R.nightStats(a, {}).done, 0);
  const record = {items: {life0: {first: "failed"}, life1: {first: "hinted"}}, finished: true};
  assert.ok(R.nightStats(a, record).finished);
  assert.ok(!R.nightStats(a, {...record, skipped: true}).finished);
  assert.equal(R.nightStats(items(3), record).pending, 1);
});
test("到期独立进站；费劲间隔保守；提示降为认识且不进站；失败次日", () => {
  const c = fresh();
  const g = S.rateRecall(c, "independent", day, {id: "g", key: "word"});
  assert.equal(g.s, 1); assert.equal(g.d, "2026-10-31");
  assert.equal(S.rateRecall(c, "effort", day, {id: "e"}).d, "2026-10-30");
  const h = S.rateRecall({...c, s: 4, recall: {...c.recall, level: 4}}, "hinted", day, {id: "h"});
  assert.equal(h.s, 4); assert.equal(h.d, "2026-10-30"); assert.equal(S.level(h), 2);
  const f = S.rateRecall(c, "failed", day, {id: "f"});
  assert.equal(f.s, 0); assert.equal(f.d, "2026-10-29"); assert.equal(S.level(f), 1);
});
test("历史等级不因缺新证据清零，独立成功不降级；各专项错误不改变词义", () => {
  const old = {...S.newCard("2026-10-20"), s: 3, h: "gg", n: 2, v: 2};
  let c = S.upgradeCard(old, "srs:word", 123);
  assert.equal(S.level(c), 3); assert.deepEqual(S.upgradeCard(c), c);
  c = S.rateRecall(c, "independent", day, {id: "one"}); assert.equal(S.level(c), 3);
  for (const ability of ["listen", "spell", "context", "recognition"]) {
    const n = S.rateSkill(c, ability, "f", day, {id: ability});
    for (const key of ["a", "s", "d", "l", "r", "n", "h", "v", "recall"]) assert.deepEqual(n[key], c[key]);
    assert.equal(n.skills[ability].f, 1); assert.equal(S.rateSkill(n, ability, "f", day, {id: ability}), n);
  }
});
test("升级不再依赖拼写/例句；跨天累计才能到牢记，同日提前成功不升级", () => {
  let c = fresh(); const levels = [];
  for (let i = 0; i < 5; i++) {
    const d = c.d; c = S.rateRecall(c, "independent", d, {id: "day" + i, key: "test"});
    levels.push(S.level(c));
    const again = S.rateRecall(c, "independent", d, {id: "again" + i});
    assert.equal(again.s, c.s); assert.equal(again.d, c.d); assert.equal(again.recall.days, c.recall.days);
  }
  assert.deepEqual(levels, [2, 2, 3, 4, 5]); assert.equal(c.q, undefined);
});
test("提前提示不延后已排日期；提前遗忘仍次日；重复作答幂等", () => {
  let c = {...fresh(), d: "2026-11-04"};
  const g = S.rateRecall(c, "independent", day, {id: "early"});
  assert.equal(g.d, c.d); assert.equal(S.level(g), S.level(c));
  const h = S.rateRecall(c, "hinted", day, {id: "hint"}); assert.equal(h.d, "2026-10-30");
  assert.equal(h.v, S.reviews(c)); assert.equal(h.h, c.h); // 提前提示不增加正式复习次数
  const close = S.rateRecall({...c, d: "2026-10-29"}, "hinted", day); assert.equal(close.d, "2026-10-29");
  const f = S.rateRecall(c, "failed", day, {id: "fail"});
  assert.equal(S.rateRecall(f, "failed", day, {id: "fail"}), f); assert.equal(f.l, 1);
  assert.equal(S.rateRecall(f, "independent", day, {id: "fail"}), f);
  assert.equal(f.recall.results.fail.result, "failed");
  const sameDay = S.rateRecall(f, "independent", day, {id: "after"});
  assert.equal(S.level(sameDay), 1); assert.equal(sameDay.d, "2026-10-29");
});

test("最早旧卡缺站数、次数、历史时，首次回忆可正常排期", () => {
  const c = S.rateRecall({d: day}, "independent", day, {id: "missing", key: "word"});
  assert.equal(c.s, 1); assert.equal(c.n, 1); assert.equal(c.d, "2026-10-31"); assert.equal(S.level(c), 2);
});
test("备份恢复当日有效断点，忽略跨日、已删/重建卡，不恢复已完成的新学群", () => {
  const now = new Date(2026, 9, 28, 12).getTime(), c = fresh(), doc = {"srs:word0": [c, 1]};
  const rc = R.create([{word: "word0", card: c}], day, "task");
  const progress = {d: day, w: ["word0"], done: [], rated: {}, rc};
  const file = {...doc, "drill:due": [progress, 2]};
  const out = Object.fromEntries(B.plan({}, file, ["study"], "merge", now));
  assert.equal(out["drill:due"][0].rc.id, "task");
  assert.equal(Object.fromEntries(B.plan({"srs:word0": [0, 4]}, file, ["study"], "merge", now))["drill:due"][0], 0);
  assert.equal(B.plan({}, {"drill:due": [{...progress, d: "2026-10-27"}, 2]}, ["study"], "merge", now).length, 0);
  assert.equal(R.validProgress({d: day, g: "u01-l01:g1"}, {"learn:u01-l01:g1": [day, 1]}, day), 0);
  const roundTrip = B.parse(B.text(out, now, "isolated")); assert.deepEqual(roundTrip.d, out);
});

test('补测配额可受每日预算限制，权威首次无需补测时旧断点不再恢复', () => {
  let s=R.create(items(2),day,'daily');
  s.retryLimit=0;s.current.revealed=true;s=R.answer(s,'failed');assert.equal(s.added,0);
  s=R.create(items(2),day,'daily');s.current.revealed=true;s=R.answer(s,'failed');
  s=R.restoreDaily(s,{word0:{first:{result:'independent'},retryWanted:false}});
  assert.ok(!s.queue.some(q=>q.w==='word0'));
});
