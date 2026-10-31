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
  let generation = 0;
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
    SRS: {...SRS, today: () => day}, Recall, Video, Sync, URLSearchParams, setTimeout, clearTimeout,
    location: {hash}, document: {title: "测试", addEventListener(type, fn, capture) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push({fn, capture: !!capture});
    }},
    $, $$: () => [], known: new Set(), pop: {style: {}, contains: () => false},
    BOOK: json("data/book.json"), store: {get: (key, fallback) => fallback},
    S: {examDate: "2026-12-12", voice: "ava", rate: 1, roundSize: 25, dailyCap: 80, quizListen: true, quizSpell: true, autoSay: false, autoEx: false},
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

test("回忆读音重画后，同一次点击不会被课文监听器再读成 one；扩展词在评分后仍可读", async () => {
  const h = await harness().render(), word = h.word();
  const audio = json("data/audio/u07-l01.json");
  h.click({say: "1"});
  assert.deepEqual(h.plays, [audio.w[word].ava]);
  assert.deepEqual(h.speech, []);
  assert.deepEqual(h.progress().current.hints, ["audio"]);
  h.click({recallReveal: "1"});
  h.click({sayx: "specifically"});
  h.click({recallRate: "hinted"});
  h.click({sayx: "specify"});
  assert.deepEqual(h.plays.slice(1), [audio.w.specifically.ava, audio.w.specify.ava]);
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
