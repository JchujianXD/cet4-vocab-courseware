"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const SRS = require("../site/srs.js"), Recall = require("../site/recall.js"), Video = require("../site/video.js");
const day = "2026-10-31", yesterday = SRS.add(day, -1);
const read = file => fs.readFileSync(path.join(__dirname, "../site", file), "utf8");
const json = file => JSON.parse(read(file));
const copy = value => JSON.parse(JSON.stringify(value));
const studySource = read("study.js");
// 加载真正的课文点击处理器，与学习页监听器一起测试同一次冒泡；不复制处理逻辑。
const app = read("app.js");
const courseClicks = app.slice(app.indexOf('document.addEventListener("click", e => {', app.indexOf("/* ---------- 其他点击")), app.indexOf("/* ---------- 设置页"));

function harness(hash = "#/drill/due", saved = {}) {
  const data = new Map(Object.entries(copy(saved))), plays = [], speech = [], listeners = new Map();
  const ids = new Map(), handlers = {};
  let generation = 0, studyDay = day;
  const view = {
    _html: "", get innerHTML() { return this._html; }, set innerHTML(html) { this._html = html; generation++; },
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener(type, fn) { handlers[type] = fn; },
  };
  ids.set("#studyView", view);
  const $ = selector => {
    if (!ids.has(selector)) ids.set(selector, {style: {}, textContent: "", focus() {}});
    return ids.get(selector);
  };
  const Sync = {
    get: (key, fallback) => data.has(key) ? data.get(key) : fallback,
    set: (key, value) => data.set(key, copy(value)),
    setMany: pairs => pairs.forEach(([key, value]) => data.set(key, copy(value))),
    entries: prefix => [...data].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value]),
  };
  for (const [lid, word] of [["u07-l01", "specific"], ["u08-l01", "dose"]]) {
    const lesson = json(`data/lessons/${lid}.json`), group = lesson.groups.find(g => g.entries.some(e => e.word === word));
    const entry = group.entries.find(e => e.word === word);
    if (!data.has("srs:" + word)) data.set("srs:" + word, {...SRS.freshCard(yesterday, word),
      ...(hash === "#/drill/more" ? {a: SRS.add(day, -10), s: 2, n: 2, v: 2, t: yesterday, r: "g", h: "gg", d: day} : {}),
      k: lid, g: group.no, o: entry.no, f: entry.freq});
    data.set(`learn:${lid}:g${group.no}`, day);
  }
  const context = vm.createContext({
    SRS: {...SRS, today: () => studyDay}, Recall, Video, Sync, URLSearchParams, setTimeout, clearTimeout,
    location: {hash}, document: {title: "测试", addEventListener(type, fn, capture) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push({fn, capture: !!capture});
    }},
    $, $$: () => [], known: new Set(), pop: {style: {}, contains: () => false},
    BOOK: json("data/book.json"), store: {get: (key, fallback) => fallback},
    S: {examDate: "2026-12-12", voice: "ava", rate: 1, roundSize: 25, dailyCap: Sync.get("set:dailyCap",80), dailyMinutes: Sync.get("set:dailyMinutes",20), quizListen: true, quizSpell: true, autoSay: false, autoEx: false},
    fetchJSON: async file => json(file),
    esc: text => String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
    plainMean: text => text.replace(/<[^>]*>/g, ""), meanHTML: text => text,
    sentenceHTML: en => `<div class="sent">${en}</div>`, noteOf: () => null, Sent: {anBlock: () => ""},
    videoHTML: (video, no) => Video.options(video, no).length ? '<a data-vi="0">视频</a>' : "",
    pickVoice: rec => rec && rec.ava, rate: () => 1,
    playFile: key => plays.push(key), speakTTS: word => speech.push(word), speak: word => speech.push(word),
    readSent: (root, en) => speech.push(en), stopAll: () => {}, stopMarathon: () => {},
    peekOpen: () => false, closePeek: () => {}, scrollBack: () => {}, toast: () => {},
  });
  vm.runInContext(studySource + "\nglobalThis.Study = Study;", context);
  vm.runInContext(courseClicks, context);
  const h = {
    data, plays, speech, context,
    setDay: d => studyDay = d,
    async navigate(hash) { context.location.hash = hash; await context.Study.render(hash); await new Promise(setImmediate); return h; },
    get html() { return view.innerHTML; },
    word: () => view.innerHTML.match(/class="dword"[^>]*>([^<]+)</)?.[1],
    progress: () => data.get("drill:" + (hash.includes("practice=") ? `practice:${hash.split("practice=")[1]}:${hash.split("/")[2].split("?")[0]}` : hash.split("/")[2]))?.rc,
    async render() { await context.Study.render(hash); await new Promise(setImmediate); assert.doesNotMatch(view.innerHTML, /加载失败/); return h; },
    click(dataset = {}, video = false) {
      const born = generation;
      const target = {
        dataset, classList: {contains: () => false},
        closest(selector) {
          if (selector === "#studyView a[data-vi]") return video && born === generation ? target : null;
          for (const part of selector.split(",")) {
            if (part.startsWith("#") && dataset.id === part.slice(1)) return target;
            if (part === ".study" && born === generation) return view;
            const attr = part.match(/^\[data-([\w-]+)\]$/)?.[1]?.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            if (attr && attr in dataset) return target;
          }
          return null;
        },
      };
      const event = {target, composedPath: () => [target, view], preventDefault() {}};
      for (const listener of listeners.get("click") || []) if (listener.capture) listener.fn(event);
      handlers.click(event);
      for (const listener of listeners.get("click") || []) if (!listener.capture) listener.fn(event);
    },
    key(key) { for (const {fn} of listeners.get("keydown") || []) fn({key, target: {closest: () => null}, preventDefault() {}}); },
  };
  return h;
}

test("回忆自动读词，手动读音不计提示；评分后直接进入下一词", async () => {
  const h = await harness().render(), word = h.word();
  const audio = json("data/audio/u07-l01.json");
  assert.deepEqual(h.plays, [audio.w[word].ava]);
  h.click({say: "1"});
  assert.deepEqual(h.plays, [audio.w[word].ava, audio.w[word].ava]);
  assert.deepEqual(h.speech, []);
  assert.deepEqual(h.progress().current.hints, []);
  assert.match(h.html, /data-sayx="specifically"[\s\S]*?class="dext-mean"/);
  h.click({sayx: "specifically"});
  assert.equal(h.plays.at(-1), audio.w.specifically.ava);
  h.click({recallReveal: "1"});
  h.click({sayx: "specifically"});
  assert.equal(h.plays.at(-1), audio.w.specifically.ava);
  h.click({recallRate: "independent"});
  assert.equal(h.progress().first[word].result, "independent");
  assert.notEqual(h.word(), word);
  assert.equal(h.plays.length, 5);
  assert.deepEqual(h.speech, []);
});

test("早间、晚间、自由回忆共用卡片；揭晓前后保留视频，底部只留揭晓和斩", async () => {
  for (const hash of ["#/drill/due", "#/drill/more", "#/drill/today", "#/drill/all?practice=meaning"]) {
    const h = await harness(hash).render();
    assert.match(h.html, /class="drill recall flipped"/);
    assert.match(h.html, /data-vi="0"/);
    assert.match(h.html, /data-recall-reveal/);
    assert.match(h.html, /data-chop/);
    assert.doesNotMatch(h.html, /data-recall-(?:hint|aux|choice)|class="qopts"|先想主要意思/);
    const head = h.html.match(/<div class="dword"[\s\S]*?<div class="dback">/)[0];
    h.click({recallReveal: "1"});
    assert.equal(h.html.match(/<div class="dword"[\s\S]*?<div class="dback">/)[0], head);
    assert.doesNotMatch(h.html, /核对揭晓前|recall-rubric/);
    assert.equal((h.html.match(/data-recall-rate=/g) || []).length, 3);
  }
});

test("回忆视频记为提示并可续做，独立四选一不出现主动回忆评分", async () => {
  let h = await harness().render();
  h.click({}, true);
  assert.deepEqual(h.progress().current.hints, ["video"]);
  h = await harness("#/drill/due", Object.fromEntries(h.data)).render();
  h.click({recallReveal: "1"});
  assert.match(h.html, /data-recall-rate="hinted"/);
  assert.doesNotMatch(h.html, /data-recall-rate="independent"/);
  h = await harness("#/drill/all?practice=recognition").render();
  assert.match(h.html, /class="qopts"/);
  assert.equal((h.html.match(/data-opt="[0-3]"/g) || []).length, 4);
  assert.doesNotMatch(h.html, /data-recall-/);
});

test("旧四选一断点只保留提示/失败证据，不再恢复混合题或数字键选项", async () => {
  let h = await harness().render();
  const saved = h.data.get("drill:due");
  saved.rc.current.aux = {opts: ["甲", "乙", "丙", "丁"], ans: 0};
  saved.rc.current.hints = ["choice"];
  h = await harness("#/drill/due", Object.fromEntries(h.data)).render();
  assert.doesNotMatch(h.html, /data-recall-choice|class="qopts"/);
  h.key("1");
  assert.equal(h.progress().current.revealed, false);
  h.click({recallReveal: "1"});
  assert.match(h.html, /data-recall-rate="hinted"/);
});

test("新学和独立听音、拼写、看义选词不受回忆卡修复影响，点击与 R 都读当前词", async () => {
  for (const hash of ["#/drill/learn", "#/drill/all?practice=listen", "#/drill/all?practice=spell", "#/drill/all?practice=reverse"]) {
    const h = await harness(hash).render();
    assert.doesNotMatch(h.html, /data-recall-/);
    const start = h.plays.length;
    h.click({say: "1"}); h.key("R");
    assert.equal(h.plays.length, start + 2);
    assert.equal(h.plays.at(-1), h.plays.at(-2));
    assert.notEqual(h.plays.at(-1), undefined);
    assert.deepEqual(h.speech, []);
    if (hash.endsWith("learn")) assert.match(h.html, /data-studied/);
    else if (hash.includes("spell")) assert.match(h.html, /id="spell"/);
    else assert.match(h.html, /class="qopts"/);
  }
});


test("今日计划跨轮固定，补测只计实际负担，刷新与自由练习不重复正式评分", async () => {
  let h = await harness("#/drill/due", {"set:dailyCap":2}).render();
  const plan=h.data.get("plan:"+day), first=h.word();
  h.click({recallReveal:"1"}); h.click({recallRate:"failed"});
  assert.equal(h.data.get("log:"+day).f,1);
  h=await harness("#/drill/due",Object.fromEntries(h.data)).render();
  let n=0;
  while(h.word() && n++<10) {h.click({recallReveal:"1"});h.click({recallRate:"independent"});}
  assert.ok(n<10); assert.match(h.html,/今日计划已完成/);
  assert.equal(h.data.get("log:"+day).f,1); assert.equal(h.data.get("log:"+day).g,1);
  const saved=h.data.get("srs:"+first); assert.equal(saved.recall.result,"failed"); assert.equal(saved.s,0);
  assert.equal(h.data.get(SRS.taskKey(day,saved.life)).retry.result,"independent");
  await h.navigate("#/"); assert.match(h.html,/今日计划已完成/); assert.doesNotMatch(h.html,/晚间巩固|早上复习|途中看/);
  assert.deepEqual(h.data.get("plan:"+day),plan);
  const log=copy(h.data.get("log:"+day));
  h=await harness("#/drill/all?practice=meaning",Object.fromEntries(h.data)).render();
  for(let i=0;i<2;i++){h.click({recallReveal:"1"});h.click({recallRate:"independent"});}
  assert.deepEqual(h.data.get("log:"+day),log);
  assert.equal(h.data.get("srs:"+first).recall.result,"failed");
});
test("日限额包含未做首次复习的词，完成不会被剩余积压或新词改成未完成", async () => {
  const saved={}, lesson=json('data/lessons/u07-l01.json');
  for(const g of lesson.groups)for(const e of g.entries)saved['srs:'+e.word]={...SRS.freshCard(yesterday,e.word),k:lesson.id,g:g.no,o:e.no,f:e.freq};
  saved['set:dailyCap']=3;
  const h=await harness('#/',saved).render();h.context.S.dailyCap=80;
  // 首页已经生成的当日计划固定，修改设置不会临时换词或增量。
  const p=copy(h.data.get('plan:'+day)); await h.navigate('#/');assert.deepEqual(h.data.get('plan:'+day),p);
  assert.ok(p.items.length<=50);assert.ok(p.items.length< Object.keys(saved).length);
  await h.navigate('#/drill/due');
  let count=0;
  while(count++<80){
    if(h.word()){h.click({recallReveal:'1'});h.click({recallRate:'independent'});}
    else if(h.html.includes('id="nextRound"')){h.click({id:'nextRound'});await new Promise(setImmediate);}
    else break;
  }
  assert.ok(count<80);await h.navigate('#/');assert.match(h.html,/今日计划已完成/);assert.match(h.html,/今天可以安心结束/);
  assert.ok([...h.data].filter(([k,c])=>k.startsWith('srs:')&&c.d<=day).length>0);
});
test("跨凌晨四点评分不会写入错误学习日，显示返回首页提示", async () => {
  const h=await harness().render();h.click({recallReveal:'1'});h.setDay(SRS.add(day,1));h.click({recallRate:'independent'});
  assert.match(h.html,/已进入新的学习日/);assert.equal(h.data.get('log:'+day),undefined);assert.equal(h.data.get('log:'+SRS.add(day,1)),undefined);
});
test("旧晚间记录保留兼容，但不作为首页完成条件；已达到条件可退出迁移", async () => {
  const night={finished:true,items:{old:{word:'old',first:'independent'}}};
  const saved={['evening:'+yesterday]:night};
  let h=await harness('#/',saved).render();assert.deepEqual(h.data.get('evening:'+yesterday),night);
  assert.doesNotMatch(h.html,/晚间巩固|今天跳过/);
  const cohort=['specific','dose'].map(w=>({word:w,life:h.data.get('srs:'+w).life}));
  for(const w of ['specific','dose'])h.data.set('srs:'+w,SRS.rateRecall(h.data.get('srs:'+w),'independent',day,{id:w}));
  h.data.set('migration:state',{v:1,mode:'active',started:yesterday,cohort});
  await h.navigate('#/');assert.match(h.html,/data-migration-exit/);h.click({migrationExit:'1'});
  assert.equal(h.data.get('migration:state').mode,'normal');assert.doesNotMatch(h.html,/data-migration-exit|旧词已校准/);
  assert.deepEqual(h.data.get('evening:'+yesterday),night);
});

test('同步另一份词单已完成的主任务抵扣推荐量，外部未完成补测能继续而不重复计分', async () => {
  const dose={...SRS.freshCard(yesterday,'dose'),k:'u08-l01',g:1,o:1,f:1};
  const graded=SRS.rateRecall(dose,'failed',day,{id:SRS.dailyAttempt(day,dose.life),at:100});
  const saved={['srs:dose']:graded,['plan:'+day]:{v:1,d:day,id:'canonical',created:1,credited:0,items:[{word:'specific',life:'specific|0',kind:'review'}],budget:{limit:1,cap:1,minutes:20,seconds:20,retryLimit:5}},
    [SRS.taskKey(day,dose.life)]:{d:day,word:'dose',life:dose.life,first:{result:'failed',planned:true,at:100},retryWanted:true}};
  const h=await harness('#/drill/due',saved).render();assert.equal(h.word(),'dose');assert.equal(h.progress().current.retry,true);
  h.click({recallReveal:'1'});h.click({recallRate:'independent'});
  assert.match(h.html,/今日计划已完成/);assert.equal(h.data.get('srs:dose').recall.result,'failed');assert.equal(h.data.get('log:'+day),undefined);
  await h.navigate('#/');assert.match(h.html,/今日计划已完成/);
});
