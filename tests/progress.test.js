"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), crypto = require("node:crypto");
const S = require("../site/srs.js"), B = require("../site/backup.js");
const plain = x => JSON.parse(JSON.stringify(x));
function syncHarness(initial, remote = {}) {
  const storage = {"lx:sync:doc": JSON.stringify(initial), "lx:sync:cfg": JSON.stringify({token: "模拟凭据", gist: "fake"})};
  const calls = [], timers = [], listeners = {};
  const ctx = vm.createContext({SRS: S, JSON, Date, localStorage: {
    getItem: k => storage[k] ?? null, setItem: (k, v) => storage[k] = v, removeItem: k => delete storage[k],
  }, setTimeout: f => (timers.push(f), timers.length), clearTimeout() {}, document: {addEventListener: (k, f) => listeners[k] = f}, addEventListener() {},
  fetch: async (url, opt) => {
    calls.push({url, opt});
    if (opt.method === "PATCH") remote = JSON.parse(JSON.parse(opt.body).files["cet4-progress.json"].content).d;
    return {ok: true, json: async () => ({files: {"cet4-progress.json": {content: JSON.stringify({v: 1, d: remote})}}})};
  }});
  vm.runInContext(fs.readFileSync(require.resolve("../site/sync.js"), "utf8") + "\nthis.Sync=Sync", ctx);
  return {sync: ctx.Sync, storage, calls, remote: () => remote};
}
test("同步升级保持原时间、等级及旧字段；导出重入、合并和删除都不复活旧证据", async () => {
  const old = {...S.newCard("2026-10-20"), s: 3, h: "gg", n: 2, v: 2};
  const initial = {"srs:word": [old, 123], "set:dailyCap": [120, 122]};
  const h = syncHarness(initial, initial), upgraded = plain(h.sync.dump());
  assert.equal(upgraded["srs:word"][1], 123); assert.equal(S.level(upgraded["srs:word"][0]), 3);
  for (const [k, v] of Object.entries(old)) assert.deepEqual(upgraded["srs:word"][0][k], v);
  await h.sync.start(); assert.deepEqual(plain(h.remote()), upgraded);
  const file = B.parse(B.text(h.sync.dump(), Date.now(), "isolated"));
  assert.deepEqual(B.plan(h.sync.dump(), file.d, B.CATS.map(c => c.id), "merge", Date.now()), []);
  const card = h.sync.get("srs:word"), next = S.rateRecall(card, "failed", "2026-10-28", {id: "same-attempt"});
  h.sync.setMany([["srs:word", next], ["log:2026-10-28", {f: 1}], ["drill:due", {d: "2026-10-28", rated: {word: "f"}}]]);
  await h.sync.syncNow(); const reloaded = syncHarness(h.sync.dump(), h.remote()); await reloaded.sync.start();
  const saved = reloaded.sync.get("srs:word"); assert.equal(S.rateRecall(saved, "failed", "2026-10-28", {id: "same-attempt"}), saved);
  reloaded.sync.load([["srs:word", [0, Date.now() + 100]]]); await reloaded.sync.syncNow();
  assert.equal(reloaded.sync.get("srs:word"), 0);
  assert.equal(reloaded.sync.get("set:dailyCap"), 120);
});
test("云端更新字段完整保留，专项与回忆嵌入同一卡片，墓碑赢过旧卡", async () => {
  const c = S.freshCard("2026-10-27", "life"), n = S.rateSkill(c, "spell", "f", "2026-10-28", {id: "spell"});
  const remote = {"srs:word": [n, 200], "srs:deleted": [0, 300], "evening:2026-10-28": [{finished: false, skipped: true, items: {}}, 200]};
  const h = syncHarness({"srs:word": [c, 100], "srs:deleted": [c, 100]}, remote); await h.sync.start();
  assert.equal(h.sync.get("srs:word").skills.spell.f, 1);
  assert.equal(h.sync.get("srs:word").d, c.d); assert.equal(h.sync.get("srs:deleted"), 0);
  assert.equal(h.sync.get("evening:2026-10-28").skipped, true);
});
test("缺字段旧卡可重复升级，不把旧 h/q 成绩补造为独立证据", () => {
  for (const c of [{a: "2026-10-01", s: 0, d: "2026-10-02"}, {a: "2026-10-01", s: 4, d: "2026-11-01", n: 4, r: "g", h: "gggg", q: 3}]) {
    const n = S.upgradeCard(c, "srs:test", 1);
    assert.equal(n.recall.level, S.legacyLevel(c)); assert.equal(n.recall.days, 0);
    assert.deepEqual(n.recall.history, []); assert.deepEqual(S.upgradeCard(n), n);
  }
});
const sample = process.env.CET4_BACKUP_SAMPLE || "C:/Users/Owen_W/Downloads/cet4-backup-2026-10-28.json";
test("真实只读样本：289 张有效卡，21/197/71；每张日期、原记录与时间保持，原文件哈希不变", {skip: !fs.existsSync(sample)}, () => {
  const data = fs.readFileSync(sample), hash = crypto.createHash("sha256").update(data).digest("hex");
  const source = JSON.parse(data.toString("utf8").replace(/^\uFEFF/, "")).d, upgraded = S.upgradeDoc(source);
  const known = new Set(Object.entries(source).filter(([k, [v]]) => k.startsWith("known:") && v).map(([k]) => k.slice(6)));
  const active = Object.entries(upgraded).filter(([k, [v]]) => v && (k.startsWith("srs:") && !known.has(k.slice(4)) || k.startsWith("vocab:") && !known.has(k.slice(6)) && !source["srs:" + k.slice(6)]?.[0]));
  const levels = [0, 0, 0, 0, 0, 0]; for (const [, [c]] of active) levels[S.level(c)]++;
  assert.equal(active.length, 289); assert.deepEqual(levels, [0, 21, 197, 71, 0, 0]);
  for (const [k, [v, time]] of Object.entries(source)) {
    assert.equal(upgraded[k][1], time);
    if (/^(srs|vocab):/.test(k) && v) {
      assert.equal(upgraded[k][0].d, v.d);
      for (const [field, value] of Object.entries(v)) assert.deepEqual(upgraded[k][0][field], value);
      assert.equal(upgraded[k][0].recall.days, 0);
    } else assert.deepEqual(upgraded[k][0], v);
  }
  assert.deepEqual(S.upgradeDoc(upgraded), upgraded);
  const file = B.parse(B.text(upgraded, Date.now(), "isolated")); assert.deepEqual(file.d, upgraded);
  assert.deepEqual(B.plan(upgraded, file.d, B.CATS.map(c => c.id), "merge", Date.now()), []);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(sample)).digest("hex"), hash);
});

test('两台设备离线答同一词：首次事件、卡片排期和日志收敛，额外专项与原时间保留', async () => {
  const day='2026-11-02', base=S.freshCard('2026-11-01','shared'), id=S.dailyAttempt(day,base.life);
  function device(result,at,stamp) {
    const card=S.rateRecall(base,result,day,{id,at}), schedule={...Object.fromEntries(Object.entries(card).filter(([k])=>['a','s','d','l','r','n','t','h','v','z'].includes(k))),recall:{level:card.recall.level,days:card.recall.days,day:card.recall.day,result:card.recall.result}};
    return {'srs:word':[S.rateSkill(card,'spell','g',day,{id:'skill-'+at}),stamp],
      [S.taskKey(day,base.life)]:[{d:day,life:base.life,word:'word',first:{result,at,due:true,must:true,counted:true,task:'due',hints:[],schedule},retryWanted:result==='failed'},stamp],
      ['log:'+day]:[{g:4,m:0,f:0,dv:4,mv:0,dailyBase:{g:4,m:0,f:0,dv:4,mv:0,recall:{},tasks:{}}},stamp]};
  }
  const A=device('failed',100,150), B=device('independent',200,250);
  for(const [local,remote] of [[A,B],[B,A]]) {
    const h=syncHarness(local,remote);await h.sync.start();
    const c=h.sync.get('srs:word'), first=h.sync.get(S.taskKey(day,base.life)).first, lg=h.sync.get('log:'+day);
    assert.equal(first.result,'failed');assert.equal(c.recall.result,'failed');assert.equal(c.r,'f');assert.equal(c.s,0);assert.equal(c.d,'2026-11-03');
    assert.equal(lg.f,1);assert.equal(lg.g,4);assert.equal(lg.dv,5);assert.equal(c.skills.spell.g,1);
    assert.equal(h.sync.dump()['srs:word'][1],250);
    assert.deepEqual(plain(h.sync.dump()),plain(h.remote()));
    assert.deepEqual(S.upgradeDoc(plain(h.sync.dump())),plain(h.sync.dump()));
    const chopped=S.chop(c,day,'word');h.sync.set('srs:word',chopped);assert.equal(h.sync.get('srs:word').z,1);assert.equal(h.sync.get('srs:word').d,chopped.d);
    const shifted=S.shift(c,3);h.sync.set('srs:word',shifted);assert.equal(h.sync.get('srs:word').d,shifted.d);
  }
});

test('离线并发首次评分校正时保留评分后整体顺延，不覆盖用户后续日期调整', async () => {
  const day='2026-11-02', c=S.freshCard('2026-11-01','shared-shift'), id=S.dailyAttempt(day,c.life);
  const early=S.rateRecall(c,'failed',day,{id,at:100});
  const late=S.rateRecall(c,'independent',day,{id,at:200}), shifted=S.shift(late,3);
  const schedule={a:early.a,s:early.s,d:early.d,l:early.l,r:early.r,n:early.n,t:early.t,h:early.h,v:early.v,z:early.z,recall:{level:early.recall.level,days:early.recall.days,day:early.recall.day,result:early.recall.result}};
  const h=syncHarness({'srs:word':[shifted,300]}, {[S.taskKey(day,c.life)]:[{d:day,life:c.life,word:'word',first:{result:'failed',at:100,due:true,schedule}},100]});
  await h.sync.start();const saved=h.sync.get('srs:word');
  assert.equal(saved.recall.result,'failed');assert.equal(saved.a,S.add(early.a,3));assert.equal(saved.d,S.add(early.d,3));
  assert.equal(h.sync.dump()['srs:word'][1],300);assert.deepEqual(S.upgradeDoc(h.sync.dump()),plain(h.sync.dump()));
});
