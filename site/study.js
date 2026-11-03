/* 背词：首页（门户）、巩固模式、浏览、周总结，以及学习记录和复习卡片的读写。
   复习规则在 srs.js；这里只负责数据进出和页面。依赖 app.js 里的工具（$、esc、S、BOOK、播放等）。

   同步数据（都走 sync.js；导出备份文件里的字段说明在 backup.js 的 FIELDS，改下面的字段时一起改）：
     learn:<课id>:g<词群号> = 学的日期 YYYY-MM-DD（取消记 0）
     srs:<词> = {a 学习日, s 已过站数, d 到期日, l 忘记次数, r 最近评分, n 复习次数, v 记进熟练度的次数, t 最近复习日,
                h 最近 6 次第一遍结果, q 答对过的最难题型, z 斩, p 学习新词整群过关的日期（手动勾的词群没有）, cf 易混词,
                k 课id, g 词群号, f 火苗, o 词条序号, life 生命周期, recall 新回忆等级/跨天证据/首次结果, skills 各专项成绩, attempts 已计分标识}（取消记 0）
     log:<日期> = {g, m, f 当天评分次数, dv 当天复习的到期词数, mv 其中首次复习的词数（保留历史统计，不再豁免每日预算）, recall 新回忆计数, tasks 分今日复习/旧晚间/自由回忆, skills 专项计数, dailyBase 新调度前当日计数基线}
     plan:<日期> = 当日固定词单与预算；task:<日期>:<life> = 首次及补测；migration:state = 校准阶段与旧卡清单
     evening:<日期> = 晚间独立任务（items 按卡片 life 保存首次及补测，finished 完成，skipped 跳过）；browse:<日期> = 被动浏览
     drill:<范围> = 巩固做到一半的进度（同一天有效，做完记 0），字段见 progSave
     set:<名字> = 设置（app.js 的 DEFAULTS）；这里用到学习新词、复习的几项：learnStages learnSize autoSay autoEx autoNext slowMode quizListen quizSpell roundSize drillMode drillOrder practiceType
     （学习新词页的词群速览 = 右下角「群」打开课文页同款浮层，见 lpSrc；速览本身不存学习数据）
     vocab:<原形> = 生词本：{w 原形, x 点到的写法, m 释义, p 音标, k 出处课id, e 出处词条（空 = 没有例句，如扩展词）,
                at 加入日期, o 加入时刻, bk 书中位置 [课id, 词条序号, 是否扩展词], ph 1 = 例句里标出的词组（w 是词组原形，x 是句中写法、拆开的用「 … 」连）} + 复习卡字段 a s d l r n t（移出记 0）。
                加入当天算学习日，复习规则和书上的词一样（原形含空格的按词组卡出题，见 srs.js isPhrase）；这个词所在的词群记为学过时，它从生词本「毕业」（记 0），以书上的卡为准 */
"use strict";
const Study = (() => {
  const T = () => SRS.today();
  const newId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const practiceOf = () => { const p = new URLSearchParams(location.hash.split("?")[1] || "").get("practice"); return ["meaning", "recognition", "reverse", "listen", "spell", "context"].includes(p) ? p : ""; };
  const nightKey = () => "evening:" + T();
  const nightRecord = () => { const r = Sync.get(nightKey(), 0); return {d: T(), finished: false, skipped: false, ...r, items: r?.items || {}}; };
  const pad2 = n => String(n).padStart(2, "0");
  const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
  const md = d => `${+d.slice(5, 7)}/${+d.slice(8)}`;
  const lesTitle = k => `U${+k.slice(1, 3)} L${+k.slice(5, 7)}`;
  const ord = c => (+c.k.slice(1, 3)) * 1e6 + (+c.k.slice(5, 7)) * 1e4 + c.g * 100 + c.o;

  /* ---------- 数据 ---------- */
  const learnMarks = () => Sync.entries("learn:").filter(([, d]) => d);          // [["u07-l01:g3", "2026-10-01"], …]
  const learnDate = (k, g) => Sync.get(`learn:${k}:g${g}`, 0) || "";
  const allCards = () => Sync.entries("srs:").filter(([, c]) => c).map(([word, card]) => ({word, card, freq: card.f, order: ord(card)}));
  /* 生词本：火苗记 0，同一天到期时排在书上的词后面；课件顺序里排在所有书上的词之后，按加入先后 */
  const vocabMarks = () => Sync.entries("vocab:").filter(([, v]) => v);
  const vocabGet = w => Sync.get("vocab:" + w, 0) || null;
  const vocabCards = () => vocabMarks().filter(([w]) => !known.has(w) && !Sync.get("srs:" + w, 0))
    .map(([word, card]) => ({word, card, freq: 0, order: 1e13 + (card.o || 0), vocab: true}));
  const liveCards = () => [...allCards().filter(x => !known.has(x.word)), ...vocabCards()];   // 已会的不出现
  const cardKey = x => (x.vocab ? "vocab:" : "srs:") + x.word;
  /* r = {w, x, m, p, k, e, bk}：加入当天算学习日，明天第一次复习 */
  function addVocab(r) {
    const t = T();
    if (known.has(r.w)) setKnown(r.w, false);       // 标过已会又遇到不认识，说明没会
    Sync.set("vocab:" + r.w, {...SRS.freshCard(t, newId()), ...r, at: t, o: Date.now()});
  }
  const removeVocab = w => Sync.set("vocab:" + w, 0);
  /* 书上已在复习的词又不认识了：记一次忘了，明天再来、进难词本 */
  function forgetBook(w) {
    const c = Sync.get("srs:" + w, 0); if (!c) return;
    if (known.has(w)) setKnown(w, false);
    Sync.set("srs:" + w, SRS.rateRecall(c, "failed", T(), {id: newId(), key: w, exam: S.examDate}));
  }
  const logOf = d => Sync.get("log:" + d, null) || {g: 0, m: 0, f: 0, dv: 0};
  const groupInfo = (k, g) => {
    for (const p of BOOK.parts) for (const u of p.units) for (const l of u.lessons) if (l.id === k) return l.groups.find(x => x.no === g);
    return null;
  };

  /* 把某课的几个词群记为 date 那天学的：每个主词条建一张卡（已有卡的词不动）；生词本里的这些词毕业 */
  function markGroups(les, groupNos, date) {
    const pairs = [];
    for (const g of les.groups) {
      if (!groupNos.includes(g.no)) continue;
      pairs.push([`learn:${les.id}:g${g.no}`, date]);
      for (const e of g.entries) {
        const v = vocabGet(e.word);
        if (v && !(v.bk && v.bk[2])) pairs.push(["vocab:" + e.word, 0]);
        if (Sync.get("srs:" + e.word, 0)) continue;
        // 生词毕业只换书中元数据，保留其排期、历史和能力；vocab.p 是音标，不能复制成新学日期。
        const base = v && !(v.bk && v.bk[2]) ? Object.fromEntries(Object.entries(v).filter(([key]) => ["a", "s", "d", "l", "r", "n", "v", "h", "q", "t", "z", "cf", "life", "recall", "skills", "attempts"].includes(key))) : SRS.freshCard(date, newId());
        pairs.push(["srs:" + e.word, {...base, k: les.id, g: g.no, f: e.freq, o: e.no}]);
      }
    }
    Sync.setMany(pairs);
  }
  /* 取消记录：只删这个词群自己建的卡 */
  function unmarkGroups(les, groupNos) {
    const pairs = [];
    for (const g of les.groups) {
      if (!groupNos.includes(g.no)) continue;
      pairs.push([`learn:${les.id}:g${g.no}`, 0]);
      for (const e of g.entries) {
        const c = Sync.get("srs:" + e.word, 0);
        if (c && c.k === les.id && c.g === g.no) pairs.push(["srs:" + e.word, 0]);
      }
    }
    Sync.setMany(pairs);
  }
  /* 按「词群键 → 要不要记」批量保存：新勾的记为 date 那天学的，取消的删掉 */
  async function saveMarks(want, date) {
    const byLes = {};
    for (const [key, on] of want) { const [lid, g] = key.split(":g"); (byLes[lid] = byLes[lid] || {add: [], del: []})[on ? "add" : "del"].push(+g); }
    for (const [lid, {add, del}] of Object.entries(byLes)) {
      const {les} = await getLesson(lid);
      if (add.length) markGroups(les, add, date);
      if (del.length) unmarkGroups(les, del);
    }
  }

  /* 书上所有词群按顺序排开（只算已生成的课） */
  const seq = () => BOOK.parts.flatMap(p => p.units.flatMap(u => u.lessons.filter(l => l.ready)
    .flatMap(l => l.groups.map(g => ({lid: l.id, no: g.no, title: g.title, key: `${l.id}:g${g.no}`})))));
  /* 接下来要学的词群：从记过的最后一个往后数；一个都没记过就从上次读的那课开始 */
  function nextGroups(n) {
    const all = seq(), learned = new Set(learnMarks().map(([k]) => k));
    let start = -1;
    all.forEach((g, i) => { if (learned.has(g.key)) start = i; });
    if (start < 0) { const i = all.findIndex(g => g.lid === store.get("last")); start = i > 0 ? i - 1 : -1; }
    return all.slice(start + 1).filter(g => !learned.has(g.key)).slice(0, n);
  }
  /* 词群的词数要读课文才知道：先空着，读到再填上 */
  const counts = new Map();
  async function fillCounts(lids, then) {
    for (const lid of new Set(lids)) {
      if ([...counts.keys()].some(k => k.startsWith(lid + ":"))) continue;
      try { const {les} = await getLesson(lid); for (const g of les.groups) counts.set(`${lid}:g${g.no}`, g.entries.length); } catch { /* 没网就不显示词数 */ }
    }
    $$("[data-qn]", view()).forEach(el => { const n = counts.get(el.dataset.qn); if (n) el.textContent = n + " 词"; });
    then && then();
  }
  const wordsOf = keys => keys.reduce((a, k) => a + (counts.get(k) || 0), 0);

  /* 某个范围里的卡：按词群的学习日期筛（忘了重来不改词群日期，所以「今天学的」不会混进旧词）；生词按加入日期 */
  function inLearnRange(from, to) {
    const ok = new Set(learnMarks().filter(([, d]) => d >= from && d <= to).map(([k]) => k));
    return liveCards().filter(x => (x.vocab ? x.card.at >= from && x.card.at <= to : ok.has(`${x.card.k}:g${x.card.g}`)));
  }
  const cap = () => +S.dailyCap || 50;
  const roundN = () => +S.roundSize || Infinity;
  const offTypes = () => [...(S.quizListen ? [] : [SRS.TYPE.LISTEN]), ...(S.quizSpell ? [] : [SRS.TYPE.SPELL])];
  const lvOpt = () => ({off: offTypes()});
  const SLOW_K = {loose: 1.5, std: 1, strict: 0.75, off: 0};
  const planKey = () => "plan:" + T();
  const taskRecord = (life, day = T()) => Sync.get(SRS.taskKey(day, life), 0) || {};
  const recallSchedule = c => ({...Object.fromEntries(Object.entries(c).filter(([k]) => ["a", "s", "d", "l", "r", "n", "t", "h", "v", "z"].includes(k))),
    recall: Object.fromEntries(Object.entries(c.recall).filter(([k]) => ["level", "days", "day", "result"].includes(k)))});
  function memoryState() {
    const old = Sync.get("migration:state", 0), state = SRS.migrationState(liveCards(), T(), old);
    if (state !== old) Sync.set("migration:state", state);
    return state;
  }
  function dailyPlan() {
    let p = Sync.get(planKey(), 0);
    if (!p || p.v !== 1 || p.d !== T() || !Array.isArray(p.items) || !Number.isFinite(p.budget?.limit)) {
      memoryState();
      p = {...SRS.makeDailyPlan(liveCards(), T(), {cap: cap(), minutes: S.dailyMinutes, id: newId(), created: Date.now(), credited: logOf(T()).dv || 0}), roundSize: +S.roundSize || 0};
      Sync.set(planKey(), p);
    }
    // 旧计划没有分轮设置，首次读取时固定当前值，保留已有词单及断点。
    if (!Number.isFinite(p.roundSize)) { p = {...p, roundSize: +S.roundSize || 0}; Sync.set(planKey(), p); }
    return p;
  }
  function planStatus() {
    const p = dailyPlan(), records = Object.fromEntries(Sync.entries("task:" + T() + ":").filter(([, r]) => r?.life).map(([, r]) => [r.life, r]));
    return {...SRS.dailyStatus(p, liveCards(), records), plan: p};
  }
  const capLeft = () => Math.max(0, dailyPlan().budget.limit - planStatus().completed);
  const dueAll = () => SRS.dueList(liveCards(), T());
  function dueStat() {
    const due = dueAll(), must = due.filter(x => SRS.isMust(x.card, T())), lg = logOf(T());
    const L = due.length + (lg.dv || 0);
    return {due, must, rest: due.filter(x => !SRS.isMust(x.card, T())), lg, L, tier: SRS.loadTier(L, dailyPlan().budget.limit)};
  }
  const dailyRoundN = () => dailyPlan().roundSize || Infinity;
  const dueRound = () => planStatus().rows.filter(x => !x.done || x.pendingRetry).slice(0, dailyRoundN()).map(x => x.x).filter(Boolean);
  const dueRoundN = () => Math.min(planStatus().todo, dailyRoundN());
  const dueTodo = () => planStatus().todo;
  // 额外复习是自由选择，不追加到今日推荐计划。
  const MORE_N = 25;
  const strengthenRows = status => status.rows.filter(row => !row.waived && ["hinted", "failed"].includes(row.record.first?.result));
  const strengthenRound = () => strengthenRows(planStatus()).map(row => row.x).filter(Boolean);
  const moreRound = () => { const t = T(); return SRS.queue(liveCards(), t, t, lvOpt()).filter(x => !SRS.isMust(x.card, t)).slice(0, MORE_N); };
  const isRound = sc => sc === "due" || sc === "more";   // 按到期复习一轮轮出的范围：词单按 queue 排、接着做只认进度里的词单、结束页按类型统计

  /* 范围：due 今天到期（还有必做时只出必做，见 dueRound；一轮最多 roundN() 个）/ more 多做几个（今天的任务做完后，见 moreRound）/ learn 学习新词（下一个没勾的词群，见 learnItems）/ today / yesterday / week 本周 / lastweek / weeks 本周+上周 / hard / all / vocab 生词本 /
     w:<周一> 那一周 / w2:<周一> 那一周+前一周 / lv:<0～5> 某个熟练度 / uNN 某单元 / uNN-lNN 某课 */
  function scopeInfo(sc) {
    const t = T(), mon = SRS.monday(t);
    let m;
    if (sc === "due") return {title: "今日学习", items: dueRound};
    if (sc === "more") return {title: "多做几个", items: moreRound};
    if (sc === "strengthen") return {title: "自愿巩固", items: strengthenRound};
    if (sc === "learn") return {title: "学习新词", items: () => []};   // 取词见 learnItems
    if (sc === "today") return {title: "今天学的", items: () => inLearnRange(t, t)};
    if (sc === "yesterday") { const y = SRS.add(t, -1); return {title: "昨天学的", items: () => inLearnRange(y, y)}; }
    if (sc === "week") return {title: "本周学的", items: () => inLearnRange(mon, SRS.add(mon, 6))};
    if (sc === "lastweek") return {title: "上周学的", items: () => inLearnRange(SRS.add(mon, -7), SRS.add(mon, -1))};
    if (sc === "weeks") return {title: "本周 + 上周", items: () => inLearnRange(SRS.add(mon, -7), SRS.add(mon, 6))};
    if (sc === "hard") return {title: "难词本", items: () => liveCards().filter(x => SRS.isHard(x.card))};
    if (sc === "all") return {title: "全部已学", items: () => liveCards()};
    if (sc === "vocab") return {title: "生词本", items: () => vocabCards()};
    if ((m = sc.match(/^lv:([0-5])$/))) return {title: "熟练度 · " + LV_NAME[+m[1]], items: () => liveCards().filter(x => SRS.level(x.card, lvOpt()) === +m[1])};
    if ((m = sc.match(/^w(2?):(\d{4}-\d\d-\d\d)$/))) {
      const a = m[1] ? SRS.add(m[2], -7) : m[2];
      return {title: `${md(a)}–${md(SRS.add(m[2], 6))}${m[1] ? "（两周）" : ""}`, items: () => inLearnRange(a, SRS.add(m[2], 6))};
    }
    if ((m = sc.match(/^u(\d\d)(?:-l(\d\d))?$/))) return {title: m[2] ? `Unit ${+m[1]} · Lesson ${+m[2]}` : `Unit ${+m[1]}`, book: sc};
    return null;
  }

  /* ---------- 课文缓存：巩固、浏览要用别的课的释义和音频 ---------- */
  const cache = new Map();
  function getLesson(id) {
    if (!cache.has(id)) cache.set(id, Promise.all([
      fetchJSON(`data/lessons/${id}.json`),
      fetchJSON(`data/audio/${id}.json`).catch(() => ({w: {}, s: {}, z: {}, voices: []})),
      fetchJSON(`data/roots/${id}.json`).catch(() => ({words: {}})),
      fetchJSON(`data/gloss/${id}.json`).catch(() => ({words: {}})),
      fetchJSON(`data/notes/${id}.json`).catch(() => ({sents: {}})),
      fetchJSON(`data/video/${id}.json`).catch(() => null),   // 讲解视频跳转（规则见 video.js），没有这一课的数据就是 null
    ]).then(([les, aud, rt, gl, nt, vd]) => {
      const by = new Map(), ext = new Map(), map = new Map();   // map：查词用，和 app.js 的 WORDMAP 一样
      for (const g of les.groups) for (const e of g.entries) {
        e.root = rt.words?.[e.word]; if (!by.has(e.word)) by.set(e.word, {e, g});
        for (const x of e.ext || []) if (!ext.has(x.word)) ext.set(x.word, {x, e, g});
        map.set(e.word, {word: e.word, senses: e.prons.flatMap(p => p.senses), ipa: e.prons.map(p => p.ipa).join(" "), no: e.no, entry: e, ext: false});
        for (const x of e.ext || []) if (!map.has(x.word)) map.set(x.word, {word: x.word, senses: x.senses, ipa: x.ipa, no: e.no, entry: e, ext: true});
      }
      return {les, aud, by, ext, map, gloss: gl.words || {}, notes: {sents: nt.sents || {}}, video: vd};   // notes：例句词组与语法解析（书外补充）
    }).catch(err => { cache.delete(id); throw err; }));   // 失败的不缓存，下次重试
    return cache.get(id);
  }
  /* 例句点词查义用的那课数据（app.js 的 lookup） */
  const lookupCtx = lid => getLesson(lid).then(x => ({lid, gloss: x.gloss, map: x.map, aud: x.aud, notes: x.notes}));
  /* 卡片列表 → 带上书上的词条内容 */
  async function resolve(items) {
    const ids = new Set();
    for (const x of items) { ids.add(x.card.k); if (x.vocab && x.card.bk) ids.add(x.card.bk[0]); }
    const ls = Object.fromEntries(await Promise.all([...ids].map(async id => [id, await getLesson(id)])));
    return items.map(x => {
      if (x.vocab) return resolveVocab(x, ls);
      const L2 = ls[x.card.k], hit = L2.by.get(x.word);
      return hit && {...x, lid: x.card.k, e: hit.e, grp: hit.g, aud: L2.aud, notes: L2.notes, video: L2.video};
    }).filter(Boolean);
  }
  /* 生词：书上有这个词条就用书上的完整内容，是扩展词就用扩展词的释义，都不是就用逐词释义；
     另带上遇见它的那句例句（src） */
  function resolveVocab(x, ls) {
    const c = x.card, S2 = ls[c.k], B = c.bk && ls[c.bk[0]];
    const hit = c.e && S2 && S2.by.get(c.e);
    const src = hit && hit.e.ex ? {ex: hit.e.ex, lid: c.k, entry: c.e, x: c.x, aud: S2.aud, notes: S2.notes} : null;
    let e, grp = null, aud = S2 ? S2.aud : {w: {}, s: {}}, notes = S2 ? S2.notes : null;
    const main = B && !c.bk[2] && B.by.get(c.w), ext = B && c.bk[2] && B.ext.get(c.w);
    if (main) { e = main.e; grp = main.g; aud = B.aud; notes = B.notes; }
    else if (ext) { e = {word: c.w, prons: [{ipa: ext.x.ipa, senses: ext.x.senses}], freq: 0, extOf: ext.e}; grp = ext.g; aud = B.aud; }
    else e = {word: c.w, prons: [{ipa: c.p || "", senses: Vocab.senses(c.m)}], freq: 0, gloss: true, ph: !!c.ph};   // ph：释义来自例句词组（notes）
    return {...x, lid: c.bk ? c.bk[0] : c.k, e, grp, aud, notes, src, nb: true, video: main || ext ? B.video : null};   // nb：按生词显示（书上范围里的生词仍按词群显示）；video：书上有这个词才有视频
  }
  /* 按书上的课 / 单元取词（包括还没记为学过的；没记过的只能看，不排复习） */
  async function bookItems(sc) {
    const [, u, l] = sc.match(/^u(\d\d)(?:-l(\d\d))?$/);
    const ids = BOOK.parts.flatMap(p => p.units).filter(x => x.no === +u).flatMap(x => x.lessons).filter(x => x.ready && (!l || x.no === +l)).map(x => x.id);
    const out = [];
    for (const id of ids) {
      const L2 = await getLesson(id);
      for (const g of L2.les.groups) for (const e of g.entries) {
        if (known.has(e.word)) continue;
        const c = Sync.get("srs:" + e.word, 0), v = !c && vocabGet(e.word);   // 还没学、但在生词本里的，评分算进生词卡
        out.push({word: e.word, card: c || v || null, vocab: !!v, freq: e.freq, order: (+u) * 1e6 + L2.les.lesson * 1e4 + g.no * 100 + e.no, lid: id, e, grp: g, aud: L2.aud, notes: L2.notes, video: L2.video});
      }
    }
    return out;
  }
  const itemsOf = sc => { const info = scopeInfo(sc); return info.book ? bookItems(info.book) : resolve(info.items()); };
  /* 学习新词：按设置一次学 1 群 / 2 群 / 至少 15 词（learnSize；不够 15 就按书顺序接下一群，最后一群整群带上），
     取下一个没勾的词群（手动勾过的跳过）；今天做到一半、还没勾完的那几群优先接着做（这时不按新的 learnSize 重取）。
     已会的、别的词群里已经有复习卡的词不出；几群里重复的词只出一次（算在前一群）。
     新词由用户自选，学习量始终按 learnSize；首页的复习建议不覆盖用户设置 */
  const learnN = () => +S.learnSize || 1;
  const svKeys = sv => (sv && sv.g ? [].concat(sv.g) : []);   // 进度里的 g：旧版是一个词群键，一次学多群时是数组
  function learnResume() {
    const all = seq();
    return svKeys(progGet("learn")).filter(k => !Sync.get("learn:" + k, 0)).map(k => all.find(x => x.key === k)).filter(Boolean);
  }
  /* 几个词群的名字：同一课的合在一起（U1 L1 第 3、4 群），跨课用 + 连 */
  function grpLabel(gs) {
    const by = [];
    for (const g of gs) { const last = by[by.length - 1]; if (last && last.lid === g.lid) last.nos.push(g.no); else by.push({lid: g.lid, nos: [g.no]}); }
    return by.map(b => `${lesTitle(b.lid)} 第 ${b.nos.join("、")} 群`).join(" + ");
  }
  /* 一次学多群（或接着做的是多群）时，首页、巩固页、结束页显示「下一批」的文字；一次一群返回 "" 照旧显示「下一群」 */
  function nextBatch() {
    const n = learnN(), r = learnResume();
    if (r.length && (n > 1 || r.length > 1)) return grpLabel(r);
    if (n === 1) return "";
    const gs = nextGroups(n === 2 ? 2 : 1);
    return gs.length ? grpLabel(gs) + (n > 2 ? ` 起，至少 ${n} 词` : "") : "";
  }
  async function learnItems() {
    const n = learnN(), resumed = learnResume();
    const gs = resumed.length ? resumed : nextGroups(n > 2 ? 60 : n);   // 至少 n 词：先多拿一些，够数就停
    const parts = [], items = [], seen = new Set();
    for (const g of gs) {
      if (!resumed.length && n > 2 && items.length >= n) break;
      const L2 = await getLesson(g.lid), grp = L2.les.groups.find(x => x.no === g.no);
      const its = grp.entries.filter(e => !known.has(e.word) && !Sync.get("srs:" + e.word, 0) && !seen.has(e.word))
        .map(e => ({word: e.word, card: null, freq: e.freq, order: parts.length * 1e4 + e.no, lid: g.lid, e, grp, aud: L2.aud, notes: L2.notes, video: L2.video, map: L2.map}));   // map：词群速览的导图查表
      for (const x of its) seen.add(x.word);
      parts.push({g, les: L2.les, words: its.map(x => x.word)});
      items.push(...its);
    }
    return {g: parts.length ? parts[0].g : null, gs: parts, items};   // gs：这一轮的每一群 {g 词群, les 课, words 这群要学的词}
  }

  /* ---------- 巩固进度：drill:<范围> = {d 日期, w 这一轮的词单（按出题顺序）, done 本轮已过关的词, st 学习新词每个词 {seen 看过词卡, stage 过了几关, err 错几次},
     rated 第一遍成绩, g 学习新词的词群键（一群是字符串，多群是数组）, mk 今天到期这一轮开始时每个词的类型 {词: SRS.mustKind}（结束页按类型统计；旧进度没有就不统计）}；
     答一个存一个，同一天再进同一范围接着做，日期不是今天就作废；一轮做完记 0 ---------- */
  const progKey = sc => "drill:" + sc;
  const progGet = sc => { const v = Sync.get(progKey(sc), 0); return v && v.d === T() ? v : null; };
  function progSave(extra = []) {
    if (!D || !D.save) return;
    if (D.rc && D.rc.d !== T()) return;
    if (D.rc) {
      // 当前卡随后还会展开提示/揭晓，保存快照，不能和 Sync 文档共用对象导致“值相同”而漏写。
      Sync.setMany([...extra, [progKey(D.progressScope), Recall.snapshot(D.rc, D.mk)]]);
      return;
    }
    const st = {}; for (const [w, s] of D.st) st[w] = {...s};   // 拷一份：D.st 里的对象之后还会改
    Sync.setMany([...extra, [progKey(D.progressScope || D.sc), {d: T(), id: D.attemptId, ...(D.learn ? {} : {w: D.items.map(x => x.word)}), done: [...D.done], st, rated: Object.fromEntries(D.rated), ...(D.lg && D.lg.gs.length ? {g: D.lg.gs.length === 1 ? D.lg.gs[0].g.key : D.lg.gs.map(p => p.g.key)} : {}), ...(D.mk ? {mk: D.mk} : {})}]]);
  }
  const progClear = sc => Sync.set(progKey(sc), 0, true);

  function sortBy(list, how) {
    const a = [...list];
    if (how === "alpha") a.sort((x, y) => x.word.localeCompare(y.word));
    else if (how === "freq") a.sort((x, y) => (y.freq || 0) - (x.freq || 0) || x.order - y.order);
    else if (how === "random") for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    else a.sort((x, y) => x.order - y.order);
    return a;
  }

  /* ---------- 发音（用词所在那课的音频清单） ---------- */
  function sayWord(x, w = x.word, onEnd) {   // w：读这个词的扩展词时传进来；onEnd：读完（出错也算）时调用
    const key = pickVoice(x.aud.w[w] || x.aud.w[w.toLowerCase()]);
    key ? playFile(key, onEnd, rate(), x.aud) : speakTTS(w, "en", onEnd);
  }
  /* src：读生词遇见的那句（在出处那课的音频里），否则读词条自己的例句；和课文页一样逐词高亮（卡片上这两句各在一个 .ex 里） */
  function saySent(x, slow, src) {
    const {ex, aud} = src ? {ex: x.src.ex, aud: x.src.aud} : {ex: x.e.ex, aud: x.aud};
    readSent(view().querySelector(src ? ".ex.meet" : ".ex:not(.meet)"), ex.en, null, slow ? 0.75 : rate(), aud);
  }

  /* ---------- 公共片段 ---------- */
  const view = () => $("#studyView");
  const senseHTML = e => e.prons.map(p => p.senses.map((s, i) =>
    `<div class="dsense">${e.prons.length > 1 && i === 0 ? `<span class="ipa">${esc(p.ipa)}</span>` : ""}<span class="pos">${esc(s.pos)}</span>${meanHTML(s.mean)}</div>`).join("")).join("");
  const ipaOf = e => e.prons.map(p => p.ipa).join(" ");
  /* 讲解视频按钮（app.js 的 videoHTML）：x.video 是词条所在那课的视频数据；扩展词用主词条的号，逐词释义的生词不在书里，没有 */
  const videoOf = (x, mini) => videoHTML(x.video, Video.noOf(x.e), mini, x.word);
  /* 生词：遇见它的那句例句，生词高亮，可朗读 */
  const meetHTML = x => x.src ? `<div class="ex meet"><div class="exlab">遇见 · ${lesTitle(x.src.lid)} ${esc(x.src.entry)} 的例句</div>
    <div class="sent" data-lid="${x.src.lid}" data-src="${esc(x.src.entry)}">${sentenceHTML(x.src.ex.en, x.card.ph ? [] : [x.src.x], noteOf(x.src.notes, x.src.ex.en), x.card.ph ? x.card.w : "")}</div><div class="dzh">${esc(x.src.ex.zh)}</div>${Sent.anBlock(noteOf(x.src.notes, x.src.ex.en), x.src.ex.zh, x.src.ex.en, x.card.ph ? [] : [x.src.x], x.card.ph ? x.card.w : "")}
    <div class="ops"><button data-sent="src">▶ 例句</button><button data-sent="srcslow">🐢 慢速</button></div></div>` : "";
  /* 生词的来历：哪天加的、书上有没有 */
  const vocabMeta = x => `生词 · ${md(x.card.at)} 加入${x.card.bk ? ` · 书中 ${lesTitle(x.card.bk[0])} #${x.card.bk[1]}${x.card.bk[2] ? " 的扩展词" : ""}` : ""}`;
  const fl = n => `<span class="fl" title="考频 ${n}/3">${"🔥".repeat(n)}</span>`;
  const LV_NAME = ["新学", "生疏", "认识", "熟悉", "掌握", "牢记"];
  const lvDot = n => `<span class="lvdot${n ? "" : " hollow"}" style="--c:var(--lv${n})" title="熟练度：${LV_NAME[n]}"></span>`;
  const btn = (href, text, attrs = 'appearance="filled"', size = "small") => `<wa-button size="${size}" href="${href}" ${attrs}>${text}</wa-button>`;   // 工具栏默认小号；结束页整组用中号，链接与操作按钮保持同尺寸
  const loadFail = err => { view().innerHTML = `<p class="empty">加载失败：${esc(err.message)}<br>检查网络后 <a href="javascript:location.reload()">重新加载</a></p>`; };
  const HOME_TITLE = document.title;   // 首页用 index.html 里写给搜索引擎的完整标题
  function setHead(title) { $("#crumb").textContent = title; document.title = title === "首页" ? HOME_TITLE : title + " · 四级词汇"; }

  /* ---------- 首页：一个个板块，按顺序画；以后加功能就往 MODULES 里加一项 ---------- */
  function streak() {
    const days = new Set(Sync.entries("log:").filter(([, v]) => v && (v.g + v.m + v.f) > 0).map(([d]) => d));
    for (const [, d] of learnMarks()) days.add(d);
    for (const [, v] of vocabMarks()) days.add(v.at);
    let t = T(), n = 0;
    if (!days.has(t)) t = SRS.add(t, -1);   // 今天还没学不算断
    while (days.has(t)) { n++; t = SRS.add(t, -1); }
    return n;
  }
  function modHero() {
    const t = T(), left = SRS.diff(S.examDate || "2026-12-12", t), n = streak();
    return `<div class="hero">
      <div><div class="cd">${left > 0 ? `距四级 <b>${left}</b> 天` : left === 0 ? "今天考试，加油！" : "考试已结束"}</div>
        <small>${esc(S.examDate)} · 今天 ${md(t)} 周${WEEK[SRS.dow(t)]}</small></div>
      ${n ? `<div class="streak" title="连续学习天数">🔥 连续 ${n} 天</div>` : ""}</div>`;
  }
  // 首答来自分词记录；已退役或抵扣的词不凭计划进度推算回忆表现。
  function planResults(status) {
    const rows = status.rows.filter(row => !row.waived && row.record.first);
    const count = result => rows.filter(row => row.record.first.result === result).length;
    const mastered = rows.filter(row => row.x && SRS.level(row.x.card, lvOpt()) >= 4).length;
    return {completed: rows.filter(row => !row.external).length, external: rows.filter(row => row.external).length, independent: count("independent") + count("effort"), hinted: count("hinted"), failed: count("failed"),
      strengthen: strengthenRows(status), mastered, accumulating: rows.filter(row => row.x && SRS.level(row.x.card, lvOpt()) < 4).length};
  }
  function modToday() {
    const status = planStatus(), {plan, total, completed, finished, pendingRetries, retries} = status;
    const state = memoryState(), migration = SRS.migrationStatus(liveCards(), T(), state, plan.budget.limit);
    const kinds = {review: "到期复习", relearn: "遗忘重学", calibrate: "旧词校准"};
    const breakdown = Object.entries(kinds).map(([kind, label]) => {
      const n = plan.items.filter(x => x.kind === kind).length;
      return n ? `${label} ${n}` : "";
    }).filter(Boolean).join(" · ");
    const reason = !finished && !migration.active && dueStat().tier === "heavy" ? "今天先巩固旧词，新词不着急。" : "";
    const retryText = pendingRetries ? ` · 还有 ${pendingRetries} 次同日补测` : retries ? ` · 已补测 ${retries} 次` : "";
    const results = planResults(status);
    const progress = `计划内首答 ${results.completed}/${total} 词${retryText}${results.external ? ` · 计划外首答 ${results.external} 词` : ""}`;
    const adjustment = plan.credited || status.rows.some(row => row.waived || !row.x && !row.record.first);
    return `<wa-card class="mod today"><div slot="header" class="mh"><b>今日学习</b><span class="sub">${migration.active ? "旧词记忆校准" : "日常复习"}</span></div>
      <ol class="steps4"><li class="${finished ? "done" : ""}"><span class="dot">${finished ? "✓" : "1"}</span>
        <div class="sd"><b>${finished ? "今日计划已完成" : `今天推荐 ${total} 词`}</b><small>${progress}</small>
          <small>独立想起 ${results.independent} · 提示后想起 ${results.hinted} · 未想起/想错 ${results.failed}</small>
          <small><b>待巩固 ${results.strengthen.length}</b> · 已达到掌握标准 ${results.mastered} · 尚在积累证据 ${results.accumulating}</small>
          ${breakdown ? `<small>${breakdown}</small>` : ""}${adjustment ? `<small>历史抵扣、已退役或抵扣的计划词不计入首答。</small>` : ""}<small>${finished ? "今天可以安心结束，剩余词会自动安排。" : `预算 ${plan.budget.minutes} 分钟 · 可分次完成`}</small></div>
        ${!finished ? btn("#/drill/due", progGet("due") || completed ? "继续学习" : "开始学习", 'variant="brand"') : results.strengthen.some(row => row.x) ? btn("#/drill/strengthen", "继续巩固", 'variant="brand"') : ""}</li></ol>
      ${reason ? `<p class="note">${reason}</p>` : ""}
      ${migration.active ? `<p class="note">旧词已校准 ${migration.calibrated}/${migration.total} · ${migration.ready ? "可以恢复日常学习了。" : "先巩固旧词，新词自选。"}</p>${migration.ready ? `<div class="ops plan-actions"><wa-button size="small" data-migration-exit="1">恢复日常学习</wa-button></div>` : ""}` : ""}</wa-card>`;
  }
  function modFree() {
    const nx = nextGroups(1)[0], last = store.get("last") || nx?.lid;
    const icons = {
      learn: '<path d="M12 5v14M4 5.5C7 4 9 4 12 5.5c3-1.5 5-1.5 8 0v13c-3-1.5-5-1.5-8 0-3-1.5-5-1.5-8 0z"/>',
      book: '<path d="M6 3h13v18H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3ZM3 17h16M8 7h7M8 11h5"/>',
      browse: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 5v14M12 10h5M12 14h3"/>',
      log: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="m8 9 1 1 2-2m-3 7 1 1 2-2m3-5h3m-3 6h3"/>',
    };
    const entry = (href, icon, title) => `<a class="free-entry" href="${href}"><span class="free-entry-top"><svg class="free-entry-icon" viewBox="0 0 24 24" aria-hidden="true">${icons[icon]}</svg></span><b>${title}</b></a>`;
    return `<wa-card class="mod free-learning"><div slot="header" class="mh"><b>自由学习</b><span class="sub">新词自选</span><a href="#/drill">自由抽查 →</a></div>
      <nav class="free-entries" aria-label="自由学习入口">
        ${nx || progGet("learn") ? entry("#/drill/learn", "learn", progGet("learn") ? "继续学新词" : "学习新词") : ""}
        ${last ? entry(`#/${last}/cont`, "book", "打开课件") : ""}${entry("#/list/all", "browse", "浏览已学词")}${entry("#/log", "log", "学习记录")}</nav></wa-card>`;
  }
  /* 最近一次有学习动作的日期（评过分、记过词群、加过生词）：首页判断连续几天没学 */
  function lastActive() {
    let last = "";
    for (const [d, v] of Sync.entries("log:")) if (v && (v.g + v.m + v.f) > 0 && d > last) last = d;
    for (const [, d] of learnMarks()) if (d > last) last = d;
    for (const [, v] of vocabMarks()) if (v.at > last) last = v.at;
    return last;
  }
  function weekCounts(mon) {
    const byGroup = new Map();
    for (const x of allCards()) { const k = `${x.card.k}:g${x.card.g}`; byGroup.set(k, (byGroup.get(k) || 0) + 1); }
    const learned = {};
    for (const [k, d] of learnMarks()) learned[d] = (learned[d] || 0) + (byGroup.get(k) || 0);
    const vocab = {};
    for (const [w, v] of vocabMarks()) (vocab[v.at] = vocab[v.at] || []).push(w);
    return Array.from({length: 7}, (_, i) => { const d = SRS.add(mon, i), lg = logOf(d); return {d, learned: learned[d] || 0, vocab: vocab[d] || [], reviewed: lg.g + lg.m + lg.f}; });
  }
  function modWeek() {
    const t = T(), days = weekCounts(SRS.monday(t));
    const cell = (x, i) => `<a class="day${x.d === t ? " now" : ""}" href="#/week">
      <span class="wd">${WEEK[(i + 1) % 7]}</span><b>${x.learned + x.vocab.length || (x.d > t ? "" : "·")}</b><small>${x.reviewed ? "复 " + x.reviewed : ""}</small></a>`;
    const sum = days.reduce((a, x) => a + x.learned + x.vocab.length, 0);
    return `<wa-card class="mod"><div slot="header" class="mh"><b>本周</b><span class="sub">新学 ${sum} 词</span><a href="#/week">周总结 →</a></div>
      <div class="weekstrip">${days.map(cell).join("")}</div><p class="note">格子里的数字是那天新学的词数（含生词），下面是复习次数</p></wa-card>`;
  }
  function modLinks() {
    const hard = liveCards().filter(x => SRS.isHard(x.card)).length, nv = vocabCards().length;
    return `<div class="mod links">
      <a href="#/week" class="lk"><b>📅 周总结</b><small>本周学了什么、状态如何</small></a>
      <a href="#/list/hard" class="lk"><b>📕 难词本 ${hard ? `<wa-badge pill variant="danger">${hard}</wa-badge>` : ""}</b><small>忘过的词和没分清的易混词</small></a>
      <a href="#/list/vocab" class="lk"><b>📒 生词本 ${nv ? `<wa-badge pill variant="neutral">${nv}</wa-badge>` : ""}</b><small>例句里点生词加进来的</small></a>
      <a href="#/drill" class="lk"><b>🎲 自由抽查</b><small>选范围和顺序随便抽</small></a></div>`;
  }
  function modUnits() {
    const per = {};
    for (const x of allCards()) { const u = +x.card.k.slice(1, 3); per[u] = (per[u] || 0) + 1; }
    const units = BOOK.parts.flatMap(p => p.units);
    return `<wa-card class="mod"><div slot="header" class="mh"><b>课程</b><span class="sub">环里是已经记为学过的词</span></div>
      <div class="units">${units.map(u => { const n = per[u.no] || 0, pct = u.words ? Math.round(n / u.words * 100) : 0, first = u.lessons.find(l => l.ready);
        return `<a class="unit" href="${first ? "#/" + first.id : "#/"}"><wa-progress-ring value="${pct}" style="--size:56px;--track-width:5px;--indicator-width:5px">${n || ""}</wa-progress-ring>
          <span>Unit ${u.no}</span><small>${u.words} 词</small></a>`; }).join("")}</div></wa-card>`;
  }
  /* 熟练度分布：一根分段条 + 图例（带数量），点哪一段就看那一档的词 */
  function modMastery() {
    const cards = liveCards();
    if (!cards.length) return "";
    const n = [0, 0, 0, 0, 0, 0];
    for (const x of cards) n[SRS.level(x.card, lvOpt())]++;
    const order = [1, 2, 3, 4, 5, 0];                   // 生疏在最前，新学放最后
    const seg = i => n[i] ? `<a href="#/list/lv:${i}" style="flex:${n[i]};${i ? `background:var(--lv${i})` : "box-shadow:inset 0 0 0 1.5px var(--lv0)"}" title="${LV_NAME[i]} ${n[i]} 个"></a>` : "";
    return `<wa-card class="mod"><div slot="header" class="mh"><b>熟练度</b><span class="sub">共 ${cards.length} 词 · 掌握以上 ${n[4] + n[5]} 个</span></div>
      <div class="lvbar">${order.map(seg).join("")}</div>
      <div class="lvlegend">${order.map(i => `<a href="#/list/lv:${i}">${lvDot(i)}${LV_NAME[i]} <b>${n[i]}</b></a>`).join("")}</div>
      <p class="note">熟练度随回忆表现更新，点标签查看对应单词。</p></wa-card>`;
  }
  const MODULES = [modHero, modToday, modFree, modMastery, modWeek, modLinks, modUnits];
  const FOOT = `<p class="foot">内容取自《英语四级 · 你还在背单词吗》，仅供个人学习，非官方。· <a href="https://github.com/Owenwoow/cet4-vocab-courseware" target="_blank" rel="noopener">GitHub 项目</a></p>`;

  function renderHome() {
    setHead("首页");
    view().innerHTML = `<div class="home">${MODULES.map(f => f()).join("")}</div>` + FOOT;
    const nx = nextGroups(1)[0];
    if (nx && !counts.has(nx.key)) fillCounts([nx.lid]);   // 「下一群」的词数
  }

  /* ---------- 记录页：像书的目录，Unit → Lesson → 词群，一行一个，勾上就是学过（跳着学、补记、取消用） ---------- */
  let W = null;   // 还没保存的改动：{want: 词群键 → 勾不勾, day}
  function renderLog(focus) {
    setHead("学习记录");
    if (!W) W = {want: new Map(), day: "today"};
    const learned = new Map(learnMarks()), all = seq();
    const fLid = focus || (nextGroups(1)[0] || {}).lid || store.get("last") || (all[0] || {}).lid;
    const fU = fLid ? +fLid.slice(1, 3) : 1;
    const on = key => (W.want.has(key) ? W.want.get(key) : learned.has(key));
    const units = BOOK.parts.flatMap(p => p.units);
    view().innerHTML = `<div class="logv">
      <div class="vh"><h1>学习记录</h1><span class="seg">${[["today", "今天"], ["yesterday", "昨天"]].map(([v, l]) =>
        `<button data-lday="${v}" class="${W.day === v ? "on" : ""}">记为${l}学的</button>`).join("")}</span></div>
      <p class="note">像翻书的目录一样，勾上学过的词群再保存；取消勾选会删掉那个词群的学习记录和复习进度。</p>
      ${units.map(u => {
        const ls = u.lessons.filter(l => l.ready), keys = ls.flatMap(l => l.groups.map(g => `${l.id}:g${g.no}`)), n = keys.filter(k => learned.has(k)).length;
        return `<details class="lunit" data-u="${u.no}"${u.no === fU ? " open" : ""}><summary>Unit ${u.no}<small>已记 ${n}/${keys.length} 个词群</small></summary>
          ${ls.map(l => `<div class="lles" id="log-${l.id}"><div class="llh">Lesson ${l.no}</div>${l.groups.map(g => {
            const key = `${l.id}:g${g.no}`, d = learned.get(key);
            return `<label class="lrec${on(key) ? " on" : ""}"><input type="checkbox" data-g="${key}"${on(key) ? " checked" : ""}>
              <span class="lno">${g.no}</span><span class="gt">${esc(g.title)}</span>
              ${d ? `<span class="ld" title="${d} 记为学过">${md(d)} 学过</span>` : ""}<span class="qn" data-qn="${key}">${counts.has(key) ? counts.get(key) + " 词" : ""}</span></label>`; }).join("")}</div>`).join("")}</details>`; }).join("")}
      <div class="logbar"><span id="logInfo"></span><wa-button size="small" variant="brand" id="logSave">保存</wa-button></div></div>`;
    paintLogBar();
    const open = units.find(u => u.no === fU);
    if (open) fillCounts(open.lessons.filter(l => l.ready).map(l => l.id), paintLogBar);
    if (focus) setTimeout(() => document.getElementById("log-" + focus)?.scrollIntoView({block: "start"}), 0);
  }
  function logDiff() {
    const learned = new Map(learnMarks()), add = [], del = [];
    for (const [k, v] of W.want) { if (v && !learned.has(k)) add.push(k); if (!v && learned.has(k)) del.push(k); }
    return {add, del};
  }
  function paintLogBar() {
    const el = $("#logInfo"); if (!el || !W) return;
    const {add, del} = logDiff(), w = wordsOf(add);
    el.innerHTML = add.length || del.length
      ? `${add.length ? `新勾 <b>${add.length}</b> 个词群${w ? ` · ${w} 词` : ""}` : ""}${add.length && del.length ? "；" : ""}${del.length ? `取消 <b>${del.length}</b> 个` : ""}`
      : "勾上学过的词群";
    $("#logSave").disabled = !add.length && !del.length;
  }

  /* ---------- 浏览（途中看）：紧凑列表，可遮住释义 ---------- */
  async function renderList(sc) {
    if (sc === "today") Sync.set("browse:" + T(), {at: Date.now()});
    const info = scopeInfo(sc);
    if (!info) { location.hash = "#/"; return; }
    setHead(info.title);
    view().innerHTML = `<p class="empty">加载中…</p>`;
    let items;
    const vpage = sc === "vocab";   // 生词本页：新加的在前，带「移出」
    try { items = sortBy(await itemsOf(sc), "course"); if (vpage) items.reverse(); } catch (err) { loadFail(err); return; }
    const hide = !!store.get("listHide", false), fold = !!store.get("listFold", false);
    const lvOf = x => (x.card ? SRS.level(x.card, lvOpt()) : -1);
    const nFold = items.filter(x => lvOf(x) >= 4).length;
    let lastG = "";
    const rows = items.map(x => {
      const gk = x.nb ? "v:" + x.card.at : `${x.lid}:${x.grp.no}`;
      const head = gk === lastG ? "" : `<div class="lgh">${x.nb ? `生词 · ${md(x.card.at)} 加入` : `${lesTitle(x.lid)} · 词以群记 ${x.grp.no} ${esc(x.grp.title)}`}</div>`;
      lastG = gk;
      const bk = x.nb && x.card.bk, w = encodeURIComponent(x.word);
      const from = x.nb ? `<div class="lsrc">${x.src ? `遇见于 <a href="#/${x.src.lid}/w/${encodeURIComponent(x.src.entry)}">${lesTitle(x.src.lid)} ${esc(x.src.entry)}</a> 的例句` : ""}
        ${bk ? `${x.src ? " · " : ""}书中 <a href="#/${bk[0]}/w/${w}">${lesTitle(bk[0])} #${bk[1]}${bk[2] ? " 扩展词" : ""}</a>` : ""}
        ${vpage ? `<button class="vdel" data-vdel="${esc(x.word)}">移出</button>` : ""}</div>` : "";
      const ms = x.e.prons.flatMap(p => p.senses);
      const lv = lvOf(x);
      return `${head}<div class="lrow${lv >= 0 ? " lv" + lv : ""}" data-w="${esc(x.word)}">${lv >= 0 ? lvDot(lv) : ""}<span class="lw" data-say="1">${esc(x.word)}</span><span class="ipa">${esc(ipaOf(x.e))}</span>${fl(x.nb ? x.e.freq || 0 : x.freq)}
        ${x.vocab && !vpage ? `<span class="vt">生词</span>` : ""}${x.card && x.card.l ? `<span class="lapse" title="忘过 ${x.card.l} 次">✗${x.card.l}</span>` : ""}${videoOf(x, true)}
        <div class="lm">${ms.length ? ms.map(s => `<span class="pos">${esc(s.pos)}</span>${meanHTML(s.mean)}`).join("　") : "（没有现成释义，看例句）"}${x.e.gloss ? `<span class="src add">补充</span>` : ""}</div>${from}</div>`;
    }).join("");
    view().innerHTML = `<div class="listv${hide ? " hide" : ""}${fold ? " fold" : ""}">
      <div class="vh"><h1>${esc(info.title)} <small>${items.length} 词</small></h1>
        <div class="ops"><wa-button size="small" appearance="filled" id="listHide">${hide ? "显示释义" : "遮住释义"}</wa-button>
        ${nFold ? `<wa-button size="small" appearance="filled" id="listFold">${fold ? "展开已掌握" : "折叠已掌握"}</wa-button>` : ""}
        ${items.length ? btn(`#/drill/${encodeURIComponent(sc)}`, "巩固模式过一遍", 'variant="brand"') : ""}</div></div>
      ${hide ? `<p class="note">点单词读音，点释义的位置显示释义</p>` : `<p class="note">点单词读音</p>`}
      ${fold && nFold ? `<p class="foldnote">已折叠 ${nFold} 个掌握 / 牢记的词</p>` : ""}
      ${rows || `<p class="empty">这里还没有词。${sc === "today" ? "在「学习记录」里勾上今天学的词群，或者在例句里点生词加进生词本。" : vpage ? "读例句时点不认识的词，在弹出的释义里点「＋ 生词本」。" : ""}</p>`}</div>`;
    view()._items = items;
  }

  /* ---------- 巩固模式：一轮循环到全部答对；学习新词每个词先看一遍词卡，再过 learnStages 关（默认两关：看词选义 + 听音选义，见 learnKind）才算过关 ----------
     题型按熟练度出（SRS.pickType），只记每个词这一轮的第一遍作答；答错的隔 3～5 张再出。
     中途关掉：答一个存一个（进度见 progSave），同一天再进来只剩没过关的，学习新词还记得过到第几关；「从头再来」清掉进度。
     学习新词每一群的词全部过关就把那一群记为今天学的（learnGroupsDone，不等整轮）；答对（记得）后可以 1.5 秒自动下一题（autoNext） */
  let D = null;   // 当前这一轮
  const WINDOW = 8, HIST = 30, AUTO_MS = 1500;      // 学新词同时在背最多 8 个；「上一个」最多回看 30 个；答对后自动下一题停 1.5 秒（复习每轮几个见 roundN）
  const KIND_NO = {mean: 0, listen: 1, cloze: 2, reverse: 2, spell: 3, flip: 4};
  const KIND_NAME = {study: "新词", mean: "看词选义", listen: "听音选义", cloze: "例句填空", reverse: "看义选词", spell: "拼写", flip: "翻卡自评"};
  const ORDERS = [["course", "课件顺序"], ["alpha", "字母顺序"], ["freq", "重要性"], ["random", "随机"]];
  const MODES = [["quiz", "智能出题"], ["flip", "翻卡自评"]];
  const PRACTICES = [["meaning", "词义回忆"], ["recognition", "看词选义"], ["reverse", "看义选词"], ["listen", "听音"], ["spell", "拼写"], ["context", "语境"]];
  function renderPicker() {
    setHead("巩固模式");
    const n = sc => scopeInfo(sc).items().length;
    const nx = nextGroups(1)[0], batch = nx && nextBatch();
    const dueSv = progGet("due"), scopes = [["due", "今日学习", dueSv && dueSv.w ? dueSv.w.length - dueSv.done.length : dueRoundN(dueStat())],["learn", "学习新词", nx ? 1 : 0, batch || (nx ? `${lesTitle(nx.lid)} 第 ${nx.no} 群` : "全部学完")], ["today", "今天学的"], ["yesterday", "昨天学的"], ["week", "本周学的"],
      ["lastweek", "上周学的"], ["weeks", "本周 + 上周"], ["hard", "难词本"], ["vocab", "生词本"], ["all", "全部已学"]];
    const units = BOOK.parts.flatMap(p => p.units);
    view().innerHTML = `<div class="picker">
      <h1>自由抽查</h1><p class="note">词义回忆会按首次回忆调整已学词的排期；选择识别、听音、拼写、语境只记各自成绩，不改变词义熟练度，新词和专项练习均不影响今日计划的完成评价。</p>
      <section class="panel"><h2>练什么</h2>
        <div class="seg">${PRACTICES.map(([v, l]) => `<button data-practice="${v}" class="${(S.practiceType || "meaning") === v ? "on" : ""}">${l}</button>`).join("")}</div>
        <p class="note">「今日学习」使用固定推荐计划，到期、遗忘重学和旧词校准共用每日预算；不随抽查类型改变。「学习新词」按书顺序先看词卡再闯关，可以自由选择，不是每日完成条件。新词关数和一次学习量在设置里调整</p></section>
      <section class="panel"><h2>抽查顺序</h2>
        <div class="seg">${ORDERS.map(([v, l]) => `<button data-order="${v}" class="${S.drillOrder === v ? "on" : ""}">${l}</button>`).join("")}</div>
        <p class="note">建议：当天、次日用课件顺序（借词群联系）；周末、二刷用字母或随机（去掉提示，检验真记住）；冲刺用重要性（🔥🔥🔥 → 🔥）</p></section>
      <section class="panel"><h2>抽哪些词</h2><div class="scopes">
        ${scopes.map(([v, l, c, sub]) => { const k = c ?? n(v); return `<a class="sc${k ? "" : " off"}" href="#/drill/${v}${v === "learn" || v === "due" ? "" : `?practice=${S.practiceType || "meaning"}`}"><b>${l}</b><small>${sub || k + " 词"}</small></a>`; }).join("")}</div>
        <div class="row"><span><b>按书上的范围</b><small>还没记为学过的词也能抽，但不排复习</small></span>
          <select id="bookScope"><option value="">选单元或课…</option>${units.map(u => `<option value="u${pad2(u.no)}">Unit ${u.no}</option>` +
            u.lessons.filter(l => l.ready).map(l => `<option value="${l.id}">　Unit ${u.no} · Lesson ${l.no}</option>`).join("")).join("")}</select></div></section></div>`;
  }

  /* ---------- 出题用的小工具 ---------- */
  const sensesOf = e => e.prons.flatMap(p => p.senses);
  const meanText = e => sensesOf(e).slice(0, 3).map(s => `${s.pos} ${plainMean(s.mean)}`.trim()).join("；");
  const mainPos = e => (sensesOf(e)[0] || {}).pos || "";
  /* 干扰项的候选：这一轮涉及的课里所有书上词条 + 这一轮的词 */
  async function buildPool(items) {
    const pool = new Map();
    for (const id of new Set(items.map(x => x.lid).filter(Boolean))) {
      try { for (const [w, {e, g}] of (await getLesson(id)).by) if (!pool.has(w)) pool.set(w, {e, g}); } catch { /* 没网就只用这一轮的词 */ }
    }
    for (const x of items) if (!pool.has(x.word)) pool.set(x.word, {e: x.e, g: x.grp});
    return [...pool.values()].filter(p => meanText(p.e));
  }
  /* 挑 3 个干扰项（每个带 tag，见 SRS.distractorTag）：和正确答案有共同义项的不要（只差词性的除外）；
     形近 / 同词群 / 词性辨析合计最多 1 个，混淆过的词（卡片 cf、本轮刚混淆的）优先占这个名额；其次同词性（词性辨析的词按同词性算，不然总被同词群挤掉），同分随机 */
  function distractors(x) {
    const me = meanText(x.e), pos = mainPos(x.e), t = {word: x.word, mean: me}, seen = new Set([me]), out = [];
    const cf = new Set([...(D.cf.get(x.word) || []), ...((x.card && x.card.cf) || [])]);
    const cands = D.pool.filter(p => p.e.word.toLowerCase() !== x.word.toLowerCase())
      .map(p => { const m = meanText(p.e); return {e: p.e, m, tag: SRS.distractorTag(t, {word: p.e.word, mean: m}, !!x.grp && p.g === x.grp)}; })
      .filter(c => c.tag !== "bad")
      .map(c => ({...c, s: (c.tag && cf.has(c.e.word) ? 10 : 0) + (c.tag ? 3 : 0) + (c.tag === "pos" || mainPos(c.e) === pos ? 2 : 0) + Math.random() * 1.5}))
      .sort((a, b) => b.s - a.s);
    let near = false;
    for (const c of cands) {
      if (seen.has(c.m) || (c.tag && near)) continue;
      if (c.tag) near = true;
      seen.add(c.m); out.push(c); if (out.length === 3) break;
    }
    return out;
  }
  /* 词组卡：生词本里原形含空格的（含以前从逐词释义划选的短语），或从例句词组加进来的（ph） */
  const isPh = x => !!(x.vocab && x.card && SRS.isPhrase(x.card));
  const fakeEntry = (word, m, ipa = "") => ({word, prons: [{ipa, senses: Vocab.senses(m)}]});
  /* 词组卡的干扰项候选：phs = 这一轮涉及的课的 notes 里所有词组 + 生词本里别的词组；vbs = 生词本里的单词 */
  async function buildPhrasePool(items) {
    const ph = new Map();
    for (const id of new Set(items.flatMap(x => [x.lid, x.card && x.card.k]).filter(Boolean))) {
      try { for (const n of Object.values((await getLesson(id)).notes.sents)) for (const p of n.ph || []) if (p.b && p.m && !ph.has(p.b)) ph.set(p.b, p.m); } catch { /* 没网就少一些候选 */ }
    }
    const vs = vocabMarks();
    for (const [w, v] of vs) if (SRS.isPhrase(v) && v.m && !ph.has(w)) ph.set(w, v.m);
    return {phs: [...ph].map(([b, m]) => fakeEntry(b, m)), vbs: vs.filter(([, v]) => !SRS.isPhrase(v) && v.m).map(([w, v]) => fakeEntry(w, v.m, v.p))};
  }
  /* 看词组选义的 3 个干扰项：先取别的词组的释义，不够从生词释义补，再不够从书上词条补；同一原形、相同释义的不要 */
  function phraseDistractors(x) {
    const me = meanText(x.e), lw = x.word.toLowerCase(), seen = new Set([me]), out = [];
    const take = list => {
      for (const e of shuffle(list.slice())) {
        if (out.length >= 3) return;
        const m = meanText(e);
        if (!m.trim() || seen.has(m) || e.word.toLowerCase() === lw) continue;
        seen.add(m); out.push({e, tag: null});
      }
    };
    take(D.phs); take(D.vbs); take(D.pool.map(p => p.e));
    return out;
  }
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  /* 例句挖空：生词用遇见它的那句，书上的词用词条例句；找不到这个词就返回 null */
  function clozeOf(x) {
    const ex = x.nb && x.src ? x.src.ex : x.e.ex;
    if (!ex) return null;
    const keys = (x.nb && x.src ? [x.src.x] : ex.key && ex.key.length ? ex.key : [x.word]).slice().sort((a, b) => b.length - a.length);
    let en = ex.en; const forms = [];
    for (const k of keys) en = en.replace(new RegExp("(?<![A-Za-z])" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![A-Za-z])", "gi"), hit => { forms.push(hit); return "\u0000"; });
    let i = 0;
    return forms.length ? {html: esc(en).replace(/\u0000/g, '<span class="blank"><span>?</span></span>'), filled: esc(en).replace(/\u0000/g, () => `<mark>${esc(forms[i++])}</mark>`), forms: [...new Set(forms)], full: ex.en, zh: ex.zh} : null;
  }
  /* 这个词这次出什么题 */
  function kindFor(x) {
    if (D.learn && !(D.st.get(x.word) || {}).seen) return "study";   // 学习新词：先看一遍词卡
    if (!meanText(x.e)) return "flip";               // 没有现成释义的生词出不了选择题
    if (D.learn) return learnKind(x, (D.st.get(x.word) || {}).stage || 0);
    if (D.practice) return {recognition: "mean", reverse: "reverse", listen: "listen", spell: "spell", context: "cloze"}[D.practice] || "mean";
    if (D.flip) return "flip";
    if (D.kind.has(x.word)) return D.kind.get(x.word);   // 答错再来：同一种题
    const ty = x.card ? SRS.pickType(x.card, {phrase: isPh(x), off: offTypes()}) : SRS.TYPE.MEAN;   // 词组卡只会是看词组选义或翻卡；关掉的题型 pickType 会换掉
    if (ty === SRS.TYPE.CONTEXT) return clozeOf(x) && SRS.reviews(x.card) % 2 === 0 ? "cloze" : "reverse";
    return ["mean", "listen", null, "spell", "flip"][ty];
  }
  /* 学习新词第 st+1 关出什么：看词选义 → 听音选义（关掉听音题时看义选词）→ 拼写（关掉拼写或含空格的词条用看义选词；听音也关掉时有例句就出例句填空，免得两关一样）；
     词组卡每关都是看词组选义 */
  function learnKind(x, st) {
    if (isPh(x) || st === 0) return "mean";
    if (st === 1) return S.quizListen ? "listen" : "reverse";
    if (S.quizSpell && !/\s/.test(x.word)) return "spell";
    return !S.quizListen && clozeOf(x) ? "cloze" : "reverse";
  }
  function makeQ(x, kind) {
    const q = {x, kind, state: "ask", t0: 0};
    if (kind === "mean" || kind === "listen" || kind === "cloze" || kind === "reverse") {
      const cs = shuffle([{e: x.e, tag: null}, ...(isPh(x) ? phraseDistractors(x) : distractors(x))]);
      q.es = cs.map(c => c.e); q.tags = cs.map(c => c.tag);
      q.ans = q.es.indexOf(x.e);
      q.opts = q.es.map(e => (kind === "mean" || kind === "listen" ? meanText(e) : e.word));
      if (kind === "cloze") q.cloze = clozeOf(x);
    }
    return q;
  }

  async function startDrill(sc, preset) {
    const info = preset ? {title: preset.title} : scopeInfo(sc);
    if (!info) { location.hash = "#/drill"; return; }
    setHead("巩固 · " + info.title);
    view().innerHTML = `<p class="empty">加载中…</p>`;
    const learn = !preset && sc === "learn", hash = location.hash, practice = learn ? "" : practiceOf();
    const daily = sc === "due" && !practice && !preset;
    const plan = daily ? dailyPlan() : null;
    const progressScope = practice ? `practice:${practice}:${sc}` : sc, sv = preset ? null : progGet(progressScope);
    let items, pool = [], pp = {phs: [], vbs: []}, lg = null;
    try {
      if (learn) { lg = await learnItems(); items = lg.items; }
      else {
        items = preset ? preset.items : await itemsOf(sc);
        if (sv && sv.w) {   // 接着做：按上次的词单出（到期的词答完就排到以后、现取会换一批）；别的范围后来新进来的词接在后面
          const pos = new Map(sv.w.map((w, i) => [w, i])), cur = isRound(sc) ? [] : items, have = new Set(cur.map(x => x.word));
          const allowed = x => !daily || planStatus().rows.some(ref => !ref.waived && ref.word === x.word && ref.life === x.card.life);
          const old = [...cur.filter(x => pos.has(x.word) && allowed(x)), ...await resolve(liveCards().filter(x => pos.has(x.word) && !have.has(x.word) && allowed(x)))];
          items = [...old.sort((a, b) => pos.get(a.word) - pos.get(b.word)), ...sortBy(cur.filter(x => !pos.has(x.word)), S.drillOrder)];
        } else if (sv) {   // 旧版进度没存词单   // 上次答错、还没答对的（比如到期的词答错已排到明天，范围里就没有了）接着出
          const have = new Set(items.map(x => x.word));
          const back = liveCards().filter(x => sv.rated?.[x.word] && !(sv.done || []).includes(x.word) && !have.has(x.word));
          if (back.length) items = [...await resolve(back), ...items];
        }
      }
      if (!preset && !isRound(sc) && !(sv && sv.w)) items = sortBy(items, learn ? "course" : S.drillOrder);   // 到期的已按熟练度排好
      if (practice === "context") items = items.filter(x => clozeOf(x));
      pool = await buildPool(items);
      if (items.some(isPh)) pp = await buildPhrasePool(items);
    } catch (err) { loadFail(err); return; }
    if (location.hash !== hash) return;              // 加载期间去了别的页
    const keep = sv && (!learn || (lg.g && lg.gs.every(p => svKeys(sv).includes(p.g.key)))) ? sv : null;   // 学习新词换了一批，旧进度不用
    const done = new Set(keep ? keep.done : []), rest = items.filter(x => !done.has(x.word)), rated = new Map(keep ? Object.entries(keep.rated || {}) : []);
    const res = {g: 0, m: 0, f: 0}; for (const r of rated.values()) res[r]++;
    // 今天到期：这一轮开始时给每个词定类型（评分后 s、d 就变了），接着做沿用进度里的；旧进度没有就不按类型统计
    const mk = daily ? Object.fromEntries(planStatus().rows.map(x => [x.word, x.kind])) : !isRound(sc) || preset ? null : keep ? keep.mk || null : Object.fromEntries(items.filter(x => x.card).map(x => [x.word, SRS.mustKind(x.card, T())]));
    D = {sc, progressScope, practice, daily, extra: sc === "strengthen", plan, attemptId: keep?.id || newId(), mk, title:learn && lg.g ? `学习新词 · ${grpLabel(lg.gs.map(p => p.g))}` : `${info.title}${practice ? " · " + PRACTICES.find(([p]) => p === practice)[1] : ""}`, items, learn, lg, save: !preset, flip: false, pool, ...pp, hash,
      stages: learn ? Math.min(3, Math.max(1, +S.learnStages || 2)) : 0,   // 学习新词每个词过几关（这一轮开始时定下）
      queue: learn ? rest.slice(0, WINDOW) : rest, pending: learn ? rest.slice(WINDOW) : [],
      st: new Map(keep ? Object.entries(keep.st || {}) : []), kind: new Map(), cf: new Map(), rated, done, passed: items.length - rest.length, res, q: null, hist: [], back: 0};
    if (learn && !lg.g) {
      view().innerHTML = `<div class="drill"><p class="empty">Part 01 的词群都记为学过了 🎉</p><p class="empty">${btn("#/", "回首页")} ${btn("#/log", "学习记录")}</p></div>`;
      return;
    }
    if (!learn && (!practice || practice === "meaning")) {
      D.rc = Recall.create(items, T(), newId(), keep?.rc || keep);
      if (daily) {
        const status = planStatus(), records = Object.fromEntries(status.rows.filter(row => items.some(x => x.word === row.word)).map(row => [row.word, row.record]));
        D.rc = Recall.restoreDaily(D.rc, records);
        const reserved = status.rows.filter(x => x.record.retryWanted).length;
        D.rc.added = Object.values(records).filter(r => r.retryWanted).length;
        D.rc.retryLimit = D.rc.added + Math.max(0, plan.budget.retryLimit - reserved);
      }
      if (sc === "today" && !practice && !keep?.rc) {
        const nr = nightRecord(), restored = new Set(), records = {...nr.items};
        for (const x of items) {
          const prev = nr.items[x.card.life];
          if (prev) { restored.add(x.word); D.rc.first[x.word] = {result: prev.first, hints: prev.hints || []}; if (prev.retry) D.rc.retry[x.word] = {result: prev.retry}; }
          else if (D.rc.first[x.word]?.result === "legacy") records[x.card.life] = {word: x.word, first: "legacy", grade: D.rc.first[x.word].grade};
        }
        D.rc.queue = D.rc.queue.filter(q => !restored.has(q.w)); D.rc.current = null; Recall.begin(D.rc);
        progSave([[nightKey(), {...nr, items: records}]]);
      }
      progSave(); nextRecall(); return;
    }
    if (!items.length && !learn) {
      view().innerHTML = `<div class="drill"><p class="empty">「${esc(info.title)}」里没有要抽的词。</p><p class="empty">${btn("#/", "回首页")} ${btn("#/drill", "换个范围")}</p></div>`;
      return;
    }
    if (learn) learnGroupsDone();                    // 没有要学的词的群（都已会）、上次已全部过关还没记的群：先记为学过
    next();                                          // 学习新词这一批的词都已会：直接结束、记为学过
  }
  function next() {
    if (D.rc) { D.rc = Recall.next(D.rc); progSave(); nextRecall(); return; }
    stopAll();                                       // 上一题没读完的词、例句（连同高亮）停掉
    const pq = D.q;
    if (pq && pq.auto) { clearTimeout(pq.auto); pq.auto = null; }
    if (pq && (pq.state === "done" || pq.r || pq.chopped)) { D.hist.push(pq); if (D.hist.length > HIST) D.hist.shift(); }
    D.back = 0;
    if (!D.queue.length) { D.q = null; endDrill(); return; }
    const x = D.queue[0], kind = kindFor(x);
    if (!D.learn) D.kind.set(x.word, kind);
    D.q = makeQ(x, kind);
    if (D.learn) D.q.lst = (D.st.get(x.word) || {}).stage || 0;   // 出题时在第几关（答完 stage 已加一，标签仍按出题时的显示）
    showCard();
  }

  /* 卡片背面：释义、记忆法、词根、例句、扩展词、生词出处（翻卡和答错后都用） */
  const backHTML = x => `<div class="dback">${senseHTML(x.e)}${x.e.gloss ? `<div class="dnote">${x.e.prons[0].senses.length ? "" : "没有现成释义，看例句 · "}<span class="src add">补充</span> ${x.e.ph ? "例句词组释义" : "例句逐词释义"}</div>` : ""}
    ${x.e.extOf ? `<div class="dnote">书上 #${x.e.extOf.no} ${esc(x.e.extOf.word)} 的扩展词</div>` : ""}
    ${x.e.tip ? `<div class="tip"><span class="tag ${esc(x.e.tip.type)}">${esc(x.e.tip.type)}</span>${esc(x.e.tip.text)}</div>` : ""}
    ${x.e.root ? `<div class="tip root"><span class="tag 构词">词根</span>${esc(x.e.root)}<span class="src add">补充</span></div>` : ""}
    ${x.e.ex ? `<div class="ex${x.e.ex.type === "真" ? " zt" : ""}"><div class="exlab">${x.e.ex.type === "真" ? `真题 ${x.e.ex.year}` : "例句"}</div>
      <div class="sent" data-lid="${x.lid}" data-src="${esc(x.e.word)}">${sentenceHTML(x.e.ex.en, x.e.ex.key, noteOf(x.notes, x.e.ex.en))}</div><div class="dzh">${esc(x.e.ex.zh)}</div>${Sent.anBlock(noteOf(x.notes, x.e.ex.en), x.e.ex.zh, x.e.ex.en, x.e.ex.key)}
      <div class="ops"><button data-sent="1">▶ 例句</button><button data-sent="slow">🐢 慢速</button></div></div>` : ""}
    ${x.e.ext && x.e.ext.length ? `<div class="dext">${x.e.ext.map(y => `<div class="dextrow"><span class="tag">扩</span><b data-sayx="${esc(y.word)}">${esc(y.word)}</b>
      <span class="ipa">${esc(y.ipa)}</span><button class="spk sm" data-sayx="${esc(y.word)}" title="读">🔊</button>
      <span class="dext-mean">${y.senses.map(s => `<span class="pos">${esc(s.pos)}</span>${meanHTML(s.mean)}`).join("　")}</span></div>`).join("")}</div>` : ""}
    ${meetHTML(x)}</div>`;
  /* vid：翻开 / 答完以后才在 🔊 旁边放讲解视频按钮（答题前放出来就等于给了答案） */
  const wordHead = (x, vid) => `<div class="dword" data-say="1">${esc(x.word)}</div>
    <div class="dipa"><span class="ipa">${esc(ipaOf(x.e))}</span> <button class="spk" data-say="1" title="读（R）">🔊</button>${vid ? videoOf(x) : ""} ${fl(x.nb ? x.e.freq || 0 : x.freq)}</div>`;

  const RECALL_LABEL = {independent: "独立想起", effort: "独立想起但费劲", hinted: "提示后想起", failed: "未想起或想错", legacy: "旧版选择成绩", chopped: "人工斩词"};
  function nextRecall() {
    stopAll();
    if (D.rc.d !== T()) { D.q = null; view().innerHTML = `<p class="empty">已进入新的学习日，请${btn("#/", "回首页")}重新开始；已记成绩保留。</p>`; return; }
    if (D.daily) {
      const status = planStatus(), rows = status.rows.filter(row => D.rc.w.includes(row.word));
      if (rows.some(row => row.waived)) { startDrill("due"); return; }
      D.rc = Recall.restoreDaily(D.rc, Object.fromEntries(rows.map(row => [row.word, row.record])));
      D.rc.added = rows.filter(row => row.record.retryWanted).length;
      D.rc.retryLimit = D.rc.added + Math.max(0, D.plan.budget.retryLimit - status.rows.filter(row => row.record.retryWanted).length);
    }
    const c = D.rc.current;
    if (!c) { D.q = null; endRecall(); return; }
    const x = D.items.find(x => x.word === c.w);
    if (D.daily && (dailyPlan().id !== D.plan.id || !Sync.get(cardKey(x), 0) || Sync.get(cardKey(x), 0).life !== D.rc.refs[x.word] || known.has(x.word))) {
      startDrill("due"); return;
    }
    if (!c.answered) c.hints = c.hints.filter(h => h !== "audio");
    D.q = {x, kind: "recall", state: c.answered ? "done" : "ask"}; showRecall();
    sayWord(x);
  }
  function showRecall() {
    const q = D.rc.current, x = D.q.x, s = Recall.summary(D.rc);
    // 沿用原词卡，不重排或删掉卡片内容；用原背诵模式的模糊方式遮住答案，点击遮挡处展开。
    const head = `${wordHead(x, true)}${backHTML(x)}`;
    const hints = q.hints.length ? `<p class="hint-used">已使用提示${q.hints.includes("video") ? " · 视频" : ""}，本次不能计为独立想起</p>` : "";
    const kind = D.daily ? D.plan.items.find(ref => ref.word === x.word)?.kind : "";
    const relearn = kind === "relearn" && q.revealed ? `<p class="note">这个词正在重学。可以先看释义、例句和记忆法，重新熟悉后再确认本次表现；困难词会在本轮有限补测。</p>` : "";
    const rate = (r, label, variant) => `<wa-button variant="${variant}" data-recall-rate="${r}">${label}</wa-button>`;
    const controls = q.answered ? `<p class="recall-verdict">${RECALL_LABEL[q.answered]}</p><wa-button variant="brand" data-next="1">继续 <kbd>空格</kbd></wa-button>` : q.revealed
      ? `<div class="recall-ratings">${q.choiceWrong ? "" : q.hints.length ? rate("hinted", "提示后想起", "warning") : rate("independent", "想起了", "success") + rate("effort", "想得费劲", "brand")}${rate("failed", "没想起", "danger")}</div>`
      : `<wa-button variant="brand" data-recall-reveal="1">揭晓 <kbd>空格</kbd></wa-button>${D.extra ? "" : chopBtn(x)}`;
    put(`<div class="drill recall flipped"><div class="dbar"><span>${esc(D.title)}${kind ? " · " + ({review: "到期复习", relearn: "遗忘重学", calibrate: "旧词校准"})[kind] : ""}${q.retry ? " · 补测" : ""}</span><wa-progress-bar value="${s.total ? Math.round(s.completed / s.total * 100) : 0}"></wa-progress-bar><span>已做 ${s.completed}/${s.total} · 补测 ${s.retries}/${D.rc.added}</span><a href="#/" class="dx" title="退出并保存">${D.daily ? "今天到这里" : "✕"}</a></div><div class="dcard${q.revealed ? "" : " locked"}">${head}${hints}${relearn}</div><div class="dops">${controls}</div></div>`);
    {
      const cover = (selector, kind, label) => {
        for (const el of view().querySelectorAll(selector)) {
          el.classList.add("recall-cover"); el.dataset.recallCover = kind;
          el.setAttribute("role", "button"); el.setAttribute("tabindex", "0"); el.setAttribute("aria-label", label);
        }
      };
      if (!q.revealed) cover(".recall .dsense,.recall .dext-mean,.recall .dnote,.recall .tip", "reveal", "点击显示单词意思和记忆法");
      if (!q.zhRevealed) cover(".recall .dzh", "translation", "点击显示例句译文");
    }
  }
  function revealRecall() {
    if (!D.rc.current || D.rc.current.answered) return;
    D.rc.current.revealed = true; stopAll(); progSave(); showRecall();
  }
  function hintRecall(kind) {
    D.rc = Recall.hint(D.rc, kind); progSave();
  }
  function expandRecall(kind) {
    if (kind === "translation") { D.rc.current.zhRevealed = true; progSave(); showRecall(); }
  }
  function chopRecall() {
    if (D.extra) return;
    const q = D.rc.current, x = D.q.x, c = Sync.get(cardKey(x), 0);
    if (D.rc.d !== T()) { nextRecall(); return; }
    if (!q || q.answered || !c || c.life !== D.rc.refs[x.word] || known.has(x.word)) return;
    const u = SRS.chop(c, T(), x.word, S.examDate), pairs = [[cardKey(x), u]];
    D.rc.first[x.word] ||= {result: "chopped", hints: q.hints}; q.answered = "chopped";
    const record = taskRecord(c.life);
    pairs.push([SRS.taskKey(T(), c.life), {...record, d: T(), life: c.life, word: x.word, first: record.first || {result: "chopped", hints: q.hints, at: Date.now()}, ...(q.retry ? {retry: {result: "chopped", at: Date.now()}} : {})}]);
    if (D.sc === "today" && !D.practice) {
      const nr = nightRecord(); pairs.push([nightKey(), {...nr, finished: false, skipped: false, items: {...nr.items, [c.life]: {word: x.word, first: "chopped"}}}]);
    }
    progSave(pairs); next();
  }
  function recallClick(t) {
    const q = D.rc.current;
    if (t.closest("[data-next]")) { if (q.answered) next(); return; }
    // 揭晓和评分后共用同一套播放处理，扩展词也按自己的词匹配音频。
    const sx = t.closest("[data-sayx]");
    if (sx) { sayWord(D.q.x, sx.dataset.sayx); return; }
    if (q.revealed) {
      const sent = t.closest("[data-sent]");
      if (sent) { saySent(D.q.x, /slow/.test(sent.dataset.sent), sent.dataset.sent.startsWith("src")); return; }
      if (t.closest("[data-say]")) { sayWord(D.q.x); return; }
    }
    if (q.answered) return;
    if (t.closest("[data-recall-reveal]")) { revealRecall(); return; }
    const covered = t.closest("[data-recall-cover]");
    if (covered) { covered.dataset.recallCover === "reveal" ? revealRecall() : expandRecall(covered.dataset.recallCover); return; }
    if (t.closest("[data-say]")) { sayWord(D.q.x); return; }
    const rating = t.closest("[data-recall-rate]"); if (rating) { answerRecall(rating.dataset.recallRate); return; }
    if (t.closest("[data-chop]")) { chopRecall(); return; }
    const sentence = t.closest("[data-sent]");
    if (sentence) { saySent(D.q.x, /slow/.test(sentence.dataset.sent), sentence.dataset.sent.startsWith("src")); return; }
  }
  function answerRecall(result) {
    if (D.rc.d !== T()) { nextRecall(); return; }
    if (D.rc.current?.answered || !D.rc.current?.revealed) return;
    const q = D.rc.current, x = D.q.x, key = cardKey(x), c = Sync.get(key, 0), pairs = [];
    if (D.daily && dailyPlan().id !== D.plan.id) { startDrill("due"); return; }
    if (x.card && (!c || c.life !== D.rc.refs[x.word] || known.has(x.word))) { startDrill(D.sc); return; }
    const id = c ? SRS.dailyAttempt(T(), c.life) : `${D.rc.id}:${x.word}:first`;
    const savedTask = c ? taskRecord(c.life) : {}, at = Date.now();
    let schedule = null, taskKind = "free";
    if (D.daily && q.retry && !planStatus().rows.find(row => row.life === c?.life)?.pendingRetry) { nextRecall(); return; }
    // 断点比卡片旧（例如另一端已完成同一题）时，以已落盘的首次结果为准，不能只跳过计数却显示新成绩。
    const recorded = !D.extra && !q.retry && (savedTask.first || (c && SRS.firstToday(c, T())) || c?.recall?.results?.[id]);
    if (recorded) { q.hints = recorded.hints || []; q.choiceWrong = recorded.result === "failed"; result = recorded.result; }
    D.rc = Recall.answer(D.rc, result); result = D.rc.current.answered;
    if (!D.extra && !q.retry && !recorded && c && c.life === D.rc.refs[x.word] && !known.has(x.word)) {
      const next = SRS.rateRecall(c, result, T(), {id, at, hints: q.hints, key: x.word, exam: S.examDate});
      if (next !== c) {
        const lg = {...logOf(T())}, r = SRS.recallGrade(result);
        lg.dailyBase ||= JSON.parse(JSON.stringify({g: lg.g || 0, m: lg.m || 0, f: lg.f || 0, dv: lg.dv || 0, mv: lg.mv || 0, recall: lg.recall || {}, tasks: lg.tasks || {}}));
        lg[r] = (lg[r] || 0) + 1;
        if (SRS.isDue(c, T())) lg.dv = (lg.dv || 0) + 1;
        if (SRS.isMust(c, T())) lg.mv = (lg.mv || 0) + 1;
        lg.recall = {...lg.recall, [result]: (lg.recall?.[result] || 0) + 1};
        const task = !D.practice && isRound(D.sc) ? "due" : D.sc === "today" && !D.practice ? "evening" : "free";
        taskKind = task;
        const oldTask = lg.tasks?.[task] || {};
        lg.tasks = {...lg.tasks, [task]: {...oldTask, [result]: (oldTask[result] || 0) + 1}};
        pairs.push([key, next], ["log:" + T(), lg]); x.card = next;
        schedule = recallSchedule(next);
      }
    }
    if (!D.extra && c && c.life === D.rc.refs[x.word] && !known.has(x.word)) {
      const first = savedTask.first || (recorded ? {...recorded, at: recorded.at || 0} : {result, hints: q.hints, at, due: SRS.isDue(c, T()), must: SRS.isMust(c, T()), task: taskKind, planned: D.daily, kind: D.mk?.[x.word], counted: !!schedule, ...(schedule ? {schedule} : {})});
      const wanted = D.daily && D.rc.queue.some(entry => entry.w === x.word && entry.retry);
      pairs.push([SRS.taskKey(T(), c.life), {...savedTask, d: T(), life: c.life, word: x.word, first,
        retryWanted: !!(savedTask.retryWanted || wanted), ...(q.retry ? {retry: savedTask.retry || {result, at: Date.now()}} : {})}]);
    }
    if (D.sc === "today" && !D.practice && c && c.life === D.rc.refs[x.word] && !known.has(x.word)) {
      const nr = nightRecord(), old = nr.items[c.life] || {};
      pairs.push([nightKey(), {...nr, skipped: false, finished: false, items: {...nr.items, [c.life]: {...old, word: x.word, ...(q.retry ? {retry: result} : {first: result, hints: q.hints})}}}]);
    }
    D.q.state = "done"; progSave(pairs); next();
  }
  function endRecall() {
    const s = Recall.summary(D.rc), pairs = [];
    if (D.sc === "today" && !D.practice) pairs.push([nightKey(), {...nightRecord(), finished: true, skipped: false}]);
    if (D.save) Sync.setMany([...pairs, [progKey(D.progressScope), 0]]);
    const more = D.sc === "due" && !D.practice ? dueTodo(dueStat()) : 0;
    const dailyResults = D.daily ? planResults(planStatus()) : null;
    const types = D.mk ? MK.map(([kind, label]) => {
      const words = D.rc.w.filter(w => D.mk[w] === kind); if (!words.length) return "";
      const records = words.map(w => D.rc.first[w]);
      return `<li><b>${label} ${words.length}</b>：独立 ${records.filter(r => Recall.independent(r?.result)).length} · 提示 ${records.filter(r => r?.result === "hinted").length} · 未想起 ${records.filter(r => r?.result === "failed").length}${records.some(r => r?.result === "legacy") ? "（含旧版成绩）" : ""}</li>`;
    }).join("") : "";
    view().innerHTML = `<div class="drill end"><h1>${D.daily && !more ? "今日计划已完成" : s.total ? "这一轮任务完成" : "暂无待做词"}</h1><div class="tally"><span>完成 <b>${s.completed}/${s.total}</b></span><span class="g">独立想起 <b>${s.independent + s.effort}</b></span><span>其中费劲 <b>${s.effort}</b></span><span class="m">提示后 <b>${s.hinted}</b></span><span class="f">未想起/想错 <b>${s.failed}</b></span>${s.legacy ? `<span>旧版成绩 <b>${s.legacy}</b></span>` : ""}${s.chopped ? `<span>斩 <b>${s.chopped}</b></span>` : ""}</div>${types ? `<ul class="ktally">${types}</ul>` : ""}${dailyResults ? `<p>今日首轮：独立想起 ${dailyResults.independent} · 提示后想起 ${dailyResults.hinted} · 未想起/想错 ${dailyResults.failed} · <b>待巩固 ${dailyResults.strengthen.length}</b> · 已达到掌握标准 ${dailyResults.mastered} · 尚在积累证据 ${dailyResults.accumulating}</p>${dailyResults.strengthen.length ? `<p class="note">今日待巩固：${dailyResults.strengthen.map(row => esc(row.word)).join("、")}</p>` : ""}` : ""}<p>补测 ${s.retries}/${D.rc.added} · 独立想起 ${s.retrySuccess} · 提示后 ${s.retryHinted} · 未想起 ${s.retryFailed} · 待加强 ${s.strengthen.length}</p>${s.strengthen.length ? `<p class="note">待加强：${s.strengthen.map(esc).join("、")}</p>` : ""}<p class="note">${D.extra ? "自愿巩固只供练习，不改变首次成绩、熟练度或复习排期。" : "首次表现已保留。补测不覆盖首次成绩、不推进站点；提示后两天检查，未想起次日检查。未学词只练习，不创建复习卡。"}</p>${D.daily && !more ? `<p class="note">今天可以安心结束。剩余积压会分批安排，新词由你自行选择。</p>` : ""}${more ? `<p class="note">今日计划还剩 ${more} 词</p>` : ""}<div class="ops">${more ? `<wa-button variant="brand" id="nextRound">继续今日计划</wa-button>` : D.daily && dailyResults.strengthen.some(row => row.x) ? btn("#/drill/strengthen", "继续巩固", undefined, "medium") : ""}${btn("#/", "回首页", 'variant="brand"', "medium")}${btn("#/drill", "自由抽查", undefined, "medium")}</div></div>`;
  }

  /* 正在看的那一题：回看时是历史里的，否则是当前题 */
  const curQ = () => (D.back ? D.hist[D.hist.length - D.back] : D.q);
  const RESULT = {g: "✓ 记得", m: "≈ 模糊", f: "✗ 忘了"};
  const RUBRIC = `<p class="rubric">忘了 = 主要意思想不起来或想错｜模糊 = 想了一会儿才想起，或只记得主要意思｜记得 = 很快想起主要意思（次要意思不要求）</p>`;
  /* ---------- 学习新词的词群速览：右下角「群」或按 M，打开和课文页一样的浮层（本群书上导图 + 词表），默认收起 ----------
     显示当前这个词所在的那一群；当前词高亮，已过关打 ✓。题目没答完（选择题没作答、翻卡没翻开）时释义全遮住，点了只读音，免得泄露答案 */
  const lpMasked = q => !D.back && q.kind !== "study" && (q.kind === "flip" ? !q.flipped : q.state === "ask");
  function lpSrc() {
    const q = curQ(), x = q.x, g = x.grp, k = g.entries.findIndex(e => e.word === x.word);
    const rows = g.entries.map(e => {
      const here = e.word === x.word, ok = !here && D.done.has(e.word);
      const mark = here ? `<span class="pkhere">▸ ${q.kind === "study" ? "正在学" : "正在考"}</span>` : ok ? `<span class="pkok">✓</span>` : "";
      return peekRow(e, here ? " here" : "", mark, false);
    }).join("");
    return {g, map: x.map, rows, tab: ` · 第 ${k + 1}/${g.entries.length} 个`, masked: lpMasked(q), say: w => sayWord(x, w)};
  }
  const lpToggle = () => (peekOpen() ? closePeek() : openPeek(lpSrc()));
  /* 写进页面：学习新词加一个「群」按钮；速览开着时（如答对自动下一题）跟着换到新的这一题 */
  function put(html) {
    view().innerHTML = html + (D.learn ? `<div class="fabs"><button class="fab" id="lpFab" title="词群速览：本群导图和词表（M）">群</button></div>` : "");
    if (D.learn && peekOpen()) openPeek(lpSrc());
  }

  function showCard() {
    if (D.rc) { showRecall(); return; }
    const past = D.back > 0, q = curQ(), x = q.x, c = x.card, total = D.items.length;
    const retry = !past && q.state === "ask" && (D.learn ? (D.st.get(x.word) || {}).err : D.rated.has(x.word));
    const stage = D.learn && !past ? (q.kind === "study" ? "先看一遍" : `第 ${(q.lst || 0) + 1}/${D.stages} 关`) : "";
    const restart = D.save && (D.passed || D.rated.size || [...D.st.values()].some(s => s.seen)) ? `<button class="drestart" data-restart="1" title="清掉这一轮的进度，从头再来">从头再来</button>` : "";
    pop.style.display = "none";
    const bar = `<div class="dbar"><span>${esc(D.title)}</span><wa-progress-bar value="${Math.round(D.passed / total * 100)}"></wa-progress-bar>
      <span>${D.learn ? "过关 " : ""}${D.passed}/${total}</span>${restart}<a href="#/" class="dx" title="结束">✕</a></div>`;
    const meta = `<div class="dmeta">${past ? `<b class="pastk">回看 · 上 ${D.back} 个</b> · ` : ""}${x.nb ? vocabMeta(x) : `${lesTitle(x.lid)} · 词群 ${x.grp.no} ${esc(x.grp.title)}`} · <b class="qk">${KIND_NAME[q.kind]}</b>${stage ? ` · ${stage}` : ""}${retry ? ` · <b class="again">再来一次</b>` : ""}${past && q.kind !== "study" ? ` · ${q.chopped ? "已斩" : RESULT[q.r] || ""}` : ""}${c || D.learn ? "" : " · 未记为学过"}</div>`;
    const prevBtn = D.back < D.hist.length ? `<wa-button appearance="outlined" data-prev="1" title="回看上一个词">← 上一个</wa-button>` : "";
    const pastOps = `${prevBtn}<wa-button variant="brand" data-fwd="1">${D.back > 1 ? "下一个 →" : "回到当前 →"} <kbd>空格</kbd></wa-button>`;
    if (q.kind === "study") {                        // 学习新词的词卡：全部摊开，看完再考
      put(`<div class="drill flipped${past ? " past" : ""}">${bar}<div class="dcard">${meta}${wordHead(x, true)}${backHTML(x)}</div>
        <div class="dops">${past ? pastOps : `${prevBtn}<wa-button variant="brand" data-studied="1">继续 <kbd>空格</kbd></wa-button>`}</div></div>`);
      if (!past && !q.said) { q.said = true; studySay(q); }
      return;
    }
    if (q.kind === "flip" || (past && q.state !== "done")) {   // 翻卡；回看时没作答就斩掉的题也按翻卡样子展示
      const open = q.flipped || past;
      put(`<div class="drill${open ? " flipped" : ""}${past ? " past" : ""}">${bar}<div class="dcard${open ? "" : " locked"}">${meta}${wordHead(x, open)}${open ? backHTML(x) : ""}</div>
        <div class="dops">${past ? pastOps : q.flipped
          ? `${prevBtn}<wa-button variant="danger" data-rate="f">忘了 <kbd>1</kbd></wa-button><wa-button variant="warning" data-rate="m">模糊 <kbd>2</kbd></wa-button>
             <wa-button variant="success" data-rate="g">记得 <kbd>3</kbd></wa-button>${chopBtn(x)}${RUBRIC}`
          : `${prevBtn}<wa-button variant="brand" class="flip" data-flip="1">翻开 <kbd>空格</kbd></wa-button>${chopBtn(x)}`}</div></div>`);
      if (!past && !q.flipped && !q.said) { q.said = true; if (S.autoSay) sayWord(x); }
      return;
    }
    const done = q.state === "done", ok = done && q.r !== "f" && !q.conf;
    let body = "";
    if (q.kind === "mean") body = wordHead(x, done);
    else if (q.kind === "listen") body = done ? wordHead(x, true) : `<button class="bigspk" data-say="1" title="再听一遍（R）">🔊</button><p class="note qhint">听发音，选意思 · R 再听</p>`;
    else if (q.kind === "reverse") body = `<div class="qmean">${esc(meanText(x.e))}</div>${done ? wordHead(x, true) : `<p class="note qhint">选出对应的英文</p>`}`;
    else if (q.kind === "cloze") body = `<div class="qsent">${done || q.contextStudy ? q.cloze.filled : q.cloze.html}</div>${done || q.contextStudy ? `<div class="dzh">${esc(q.cloze.zh)}</div><p class="note">本句词形：${q.cloze.forms.map(esc).join("、")} · 原形：${esc(x.word)}</p>${wordHead(x, true)}` : `<p class="note qhint">选出填进空里的词（可能是变形）</p>${D.practice === "context" ? '<button data-context-study="1">学习例句</button><p class="note">学习例句计为使用帮助</p>' : ""}`}`;
    else if (q.kind === "spell") body = `<div class="qmean">${esc(meanText(x.e))}</div>
      ${done ? `<div class="spres ${q.r === "g" ? "ok" : "bad"}">${q.r === "g" ? "✓ 拼对了" : `${q.input ? `你写的：<s>${esc(q.input)}</s>` : "没写"}${q.r === "m" ? " · 差一个字母，算模糊" : ""}`}</div>${wordHead(x, true)}`
        : `<button class="spk" data-say="1" title="再听（R）">🔊</button><div class="spellbox"><input id="spell" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${esc(x.word[0] + " _".repeat(Math.max(0, x.word.length - 1)))}"></div>`}`;
    const verdict = done && q.kind !== "spell" ? `<div class="qverdict ${ok ? "ok" : "bad"}">${q.conf ? confHTML(x, q.conf) : q.r === "g" ? "✓ 答对了" : q.r === "m" ? q.contextStudy ? "✓ 使用完整例句帮助后完成" : "✓ 答对了，但想得有点久（记为模糊）" : q.pick === -1 ? "✗ 不认识" : "✗ 答错了"}</div>` : "";
    const opts = q.opts ? `<div class="qopts">${q.opts.map((o, i) => `<button class="qopt${done && i === q.ans ? " ok" : ""}${done && i === q.pick && i !== q.ans ? " bad" : ""}" data-opt="${i}"${done ? " disabled" : ""}><kbd>${i + 1}</kbd><span>${esc(o)}</span></button>`).join("")}</div>` : "";
    const ops = past ? pastOps : done
      ? `${prevBtn}<wa-button variant="brand" data-next="1">继续 <kbd>空格</kbd></wa-button>`
      : q.kind === "spell" ? `${prevBtn}<wa-button appearance="outlined" data-opt="-1">不会 <kbd>Esc</kbd></wa-button><wa-button variant="brand" data-spell="1">提交 <kbd>Enter</kbd></wa-button>${chopBtn(x)}`
      : `${prevBtn}<wa-button appearance="outlined" data-opt="-1">不认识 <kbd>0</kbd></wa-button>${chopBtn(x)}`;
    put(`<div class="drill quiz${done ? (ok ? " right" : " wrong") : ""}${past ? " past" : ""}">${bar}<div class="dcard${done || past || q.contextStudy ? "" : " locked"}">${meta}${body}${opts}${verdict}${done && q.conf ? cmpHTML(q.conf.e) : ""}${done || q.contextStudy ? backHTML(x) : ""}</div><div class="dops">${ops}</div></div>`);
    if (!done) {
      q.t0 = Date.now();                               // 从回看回来重新计时
      if (!q.said) { q.said = true; if (q.kind === "listen" || q.kind === "spell" || (q.kind === "mean" && S.autoSay)) sayQ(q); }
      if (q.kind === "spell") $("#spell").focus();
    }
  }
  /* 学习新词的词卡：按设置自动读单词（autoSay），读完接着读例句（autoEx；没开自动读单词就直接读例句）；已经翻到别的卡就不读了 */
  function studySay(q) {
    const x = q.x, ex = S.autoEx && x.e.ex ? () => { if (D && D.q === q && !D.back) saySent(x); } : null;
    if (S.autoSay) sayWord(x, x.word, ex || undefined); else if (ex) ex();
  }
  /* 读当前题的词：听音题从第一次读完（出错也算）才开始计时，之后按 R 重听不重新计时 */
  function sayQ(q) {
    if (q.kind !== "listen" || q.heard) { sayWord(q.x); return; }
    sayWord(q.x, q.x.word, () => { if (q.heard) return; q.heard = true; if (q.state === "ask") q.t0 = Date.now(); });
  }
  /* 上一个 / 往回翻到头再往前：只看不改 */
  function goBack() { if (D.back < D.hist.length) { stopAll(); D.back++; showCard(); } }
  function goFwd() { if (D.back > 0) { stopAll(); D.back--; showCard(); } }

  /* 作答：i 是选项序号（-1 = 不认识 / 不会）；拼写传 input */
  function answer(i, input) {
    const q = D.q; if (!q || q.state !== "ask") return;
    const x = q.x, ms = Date.now() - q.t0;
    if (q.kind === "spell") { q.input = input || ""; q.r = i === -1 || !q.input.trim() ? "f" : SRS.gradeSpell(q.input, x.word); }
    else {
      q.pick = i;
      const tag = i >= 0 && i !== q.ans ? q.tags[i] : null;   // 选中易混的干扰项：算混淆，记模糊，不按忘了重来
      if (tag) { q.conf = {tag, e: q.es[i]}; q.r = D.practice ? "f" : "m"; } else q.r = SRS.gradeChoice(i === q.ans, ms, q.kind, {slow: SLOW_K[S.slowMode] ?? 1});
      if (q.contextStudy && q.r === "g") q.r = "m";
    }
    q.state = "done";                                // 答对答错都展开完整卡片，按「继续」再走
    settle(x, q.r, q.kind, !!q.conf);
    if (q.es) noteConf(x, q);
    showCard();
    if (q.r !== "f" && q.kind !== "mean") sayWord(x);
    if (S.autoNext && q.r === "g" && !q.conf) armAuto(q);
  }
  /* 答对后自动下一题：停 AUTO_MS 再走；期间按任意键、点页面就停在这张卡（stopAuto） */
  function armAuto(q) {
    const el = view().querySelector(".drill .qverdict, .drill .spres");
    if (el) el.insertAdjacentHTML("beforeend", `<small class="autonext">${AUTO_MS / 1000} 秒后自动下一题 · 按任意键或点页面停下</small>`);
    q.auto = setTimeout(() => { q.auto = null; if (D && D.q === q && !D.back && location.hash === D.hash) next(); }, AUTO_MS);
  }
  function stopAuto() {
    const q = D && D.q; if (!q || !q.auto) return false;
    clearTimeout(q.auto); q.auto = null;
    const n = view().querySelector(".autonext"); if (n) n.remove();
    return true;
  }
  /* 斩：太简单了，直接升到牢记，30 天后（或考前窗口）抽查一次；算本轮过关，不计入复习次数 */
  const chopBtn = x => (x.card && !x.card.z ? `<wa-button appearance="outlined" data-chop="1" title="太简单，直接标为牢记，一个月后抽查">斩 <kbd>S</kbd></wa-button>` : "");
  function chopCur() {
    const q = D.q, x = q && q.x;
    if (D.back || !x || !x.card || (q.kind !== "flip" && q.state !== "ask")) return;
    const key = cardKey(x), c = Sync.get(key, 0); if (!c) return;
    const t = T(), u = SRS.chop(c, t, x.word, S.examDate);
    Sync.set(key, D.learn ? {...u, p: t} : u); x.card = Sync.get(key);
    q.chopped = true;
    D.res.z = (D.res.z || 0) + 1; D.passed++; D.done.add(x.word); (D.chopped = D.chopped || new Set()).add(x.word); progSave();
    D.queue = D.queue.filter(y => y.word !== x.word);
    if (D.learn && D.pending.length) D.queue.push(D.pending.shift());
    toast(`已斩 ${x.word}：${md(x.card.d)} 抽查`);
    next();
  }
  /* 学习新词：词卡看完，隔几张再考 */
  function studied() {
    const q = D.q; if (!q || q.kind !== "study" || D.back) return;
    const x = q.x, s = D.st.get(x.word) || {stage: 0, err: 0};
    s.seen = 1; D.st.set(x.word, s); q.state = "done";
    D.queue.shift(); reinsert(x); progSave();
    next();
  }
  function rateFlip(r) {
    const q = D.q, x = q.x;
    q.r = r;
    settle(x, r, "flip");
    next();
  }
  /* 记成绩、排队：复习只记第一遍；学新词 D.stages 关都过（或错满 3 次后再对一次）才过关 */
  function settle(x, r, kind, conf = false) {
    const ok = r !== "f" && !conf;                   // 混淆：成绩记模糊，但这一轮还要再答对一次
    D.queue.shift();
    let pairs = [];
    if (!D.rated.has(x.word)) { D.rated.set(x.word, r); D.res[r]++; if (!D.learn) pairs = record(x, r, kind, conf); }
    if (D.learn) {
      const s = D.st.get(x.word) || {stage: 0, err: 0};
      s.skills = {...s.skills};
      if (!s.skills[kind] && KIND_NO[kind] !== undefined && kind !== "flip") s.skills[kind] = r;
      if (ok) s.stage++; else { s.stage = 0; if (!conf) s.err++; }   // 混淆不算错次数
      D.st.set(x.word, s);
      if (ok && (s.stage >= D.stages || s.err >= 3 || kind === "flip")) { D.passed++; D.done.add(x.word); if (D.pending.length) D.queue.push(D.pending.shift()); learnGroupsDone(); }
      else reinsert(x);
    } else if (ok) { D.passed++; D.done.add(x.word); }
    else reinsert(x);
    progSave(pairs);
  }
  /* 对比复习：混淆的词记进卡片 cf，下次出这个词的选择题固定放进干扰项；带着它答对就删掉 */
  function noteConf(x, q) {
    if (D.practice) return;                         // 专项错误不写词义混淆状态
    if (q.conf) D.cf.set(x.word, SRS.confAdd(D.cf.get(x.word), q.conf.e.word));
    const key = cardKey(x), c = Sync.get(key, 0);
    if (!c) return;
    let cf = c.cf || [];
    if (q.conf) cf = SRS.confAdd(cf, q.conf.e.word);
    else if (q.pick === q.ans) for (const e of q.es) cf = SRS.confDrop(cf, e.word);
    if (cf.join() === (c.cf || []).join()) return;
    const u = {...c, cf};
    if (!cf.length) delete u.cf;
    Sync.set(key, u); x.card = u;
  }
  const posText = e => [...SRS.posSet(meanText(e))].join("、") || "?";
  const confHTML = (x, {tag, e}) => (tag === "pos"
    ? `✗ 词性混淆：${esc(x.word)} 是 ${esc(posText(x.e))}，${esc(e.word)} 是 ${esc(posText(e))}`
    : `✗ 近义混淆：你选的 ${esc(e.word)} 是「${esc(meanText(e))}」`) + `<small>${D.practice ? "只记本专项未通过，不改变词义熟练度和排期" : "记为模糊，下次会把两个词放在一起考"}</small>`;
  const cmpHTML = e => `<div class="dcmp"><span class="tag">对比</span><b data-sayx="${esc(e.word)}">${esc(e.word)}</b>
    <span class="ipa">${esc(ipaOf(e))}</span><button class="spk sm" data-sayx="${esc(e.word)}" title="读">🔊</button>
    <span>${sensesOf(e).map(s => `<span class="pos">${esc(s.pos)}</span>${meanHTML(s.mean)}`).join("　")}</span></div>`;
  const reinsert = x => D.queue.splice(Math.min(D.queue.length, 3 + Math.floor(Math.random() * 3)), 0, x);
  function record(x, r, kind, hold = false) {        // hold：混淆，站数不变、2 天后再来
    const key = cardKey(x), c = Sync.get(key, 0);
    if (!c || c.life !== x.card?.life || known.has(x.word)) return [];  // 已删除/重建的卡不能被旧练习写回
    const t = T();
    const ability = ["recognition", "reverse"].includes(D.practice) ? "recognition" : D.practice;
    const id = `${D.attemptId}:${x.word}:skill`, next = SRS.rateSkill(c, ability, r, t, {id, key: x.word});
    if (next === c) return [];
    const lg = {...logOf(t)}; lg.skills = {...lg.skills, [ability]: (lg.skills?.[ability] || 0) + 1};
    x.card = next;
    return [[key, next], ["log:" + t, lg]];
  }
  /* 学习新词一群过关：记为今天学的，每张卡记 p；各关首次成绩归相应专项。
     同轮错误次数只控制原有学习循环，不把听音/拼写/选择识别错误写成词义遗忘。 */
  function finishGroup(part) {
    const {g, les, words} = part, t = T();
    if (Sync.get("learn:" + g.key, 0)) return;       // 已经记过（回到结束页会再调一次）
    markGroups(les, [g.no], t);
    const pairs = [];
    for (const w of words) {
      const key = "srs:" + w, c = Sync.get(key, 0), s = D.st.get(w) || {err: 0};
      if (!c) continue;
      let u = {...c, p: t};
      for (const [kind, r] of Object.entries(s.skills || {})) {
        const ability = kind === "mean" || kind === "reverse" ? "recognition" : kind === "cloze" ? "context" : kind;
        u = SRS.rateSkill(u, ability, r, t, {id: `${D.attemptId}:${w}:learn:${kind}`, key: w});
      }
      pairs.push([key, u]);
    }
    Sync.setMany(pairs);
  }
  /* 这一批里词全部过关的群马上记为学过（不等整轮；中途退出已完成的群照样算）。
     只按书上顺序记前缀：前面的群没过完，后面的群过完了也先不记。否则隔天进度作废后，nextGroups 从最后一个记过的群往后取，前面那群就被跳过；
     两群共有的词只算在前一群，后一群先记还会提前给它建卡 */
  function learnGroupsDone() {
    if (!D || !D.learn || !D.lg) return;
    for (const p of D.lg.gs) { if (!p.words.every(w => D.done.has(w))) break; finishGroup(p); }
  }
  const finishLearn = () => D.lg.gs.forEach(finishGroup);
  /* 当天的评分计数；wasDue 到期复习记进 dv，wasMust 其中的必做再记进 mv（只作历史统计，计划预算不再豁免首次复习） */
  function bump(r, wasDue, wasMust) {
    const d = T(), lg = {...logOf(d)};
    lg[r] = (lg[r] || 0) + 1; if (wasDue) lg.dv = (lg.dv || 0) + 1; if (wasMust) lg.mv = (lg.mv || 0) + 1;
    Sync.set("log:" + d, lg);
  }
  /* 今天到期这一轮的结束页：按这一轮开始时定的类型分行统计（D.mk），没有的类型不显示；没评分就过关的是斩掉的 */
  const MK = [["review", "到期复习"], ["relearn", "遗忘重学"], ["calibrate", "旧词校准"], ["new", "昨天学的"], ["lapse", "昨天忘的"], ["late", "补第一次复习"], ["over", "积压词"], ["due", "今天到期的"]];
  function kindTally() {
    if (!D.mk) return "";
    const rows = MK.map(([k, label]) => {
      const ws = D.items.filter(x => D.mk[x.word] === k), n = {g: 0, m: 0, f: 0, z: 0};
      if (!ws.length) return "";
      for (const x of ws) n[D.rated.get(x.word) || "z"]++;
      return `<li><b>${label} ${ws.length}</b>：<span class="g">记得 ${n.g}</span> · <span class="m">模糊 ${n.m}</span> · <span class="f">忘了 ${n.f}</span>${n.z ? ` · 斩 ${n.z}` : ""}</li>`;
    }).join("");
    return rows ? `<ul class="ktally">${rows}</ul>` : "";
  }
  function endDrill() {
    if (D.rc) { endRecall(); return; }
    const {g, m, f} = D.res;
    if (D.save) progClear(D.progressScope || D.sc);
    if (D.learn) {
      finishLearn();
      const missed = D.items.filter(x => (D.st.get(x.word) || {}).err), gs = D.lg.gs.map(p => p.g), G = gs[0], nx = nextGroups(1)[0], batch = nx && nextBatch();
      const tier = dueStat().tier, few = tier !== "easy";   // 复习偏多 / 积压太多：「接着学」换成不显眼的「仍要再学 1 群」
      const nextBtn = !nx ? `<p class="note">Part 01 的词群全部学完了 🎉</p>`
        : few ? `<wa-button size="medium" appearance="outlined" id="nextGroup">再学一群</wa-button>`
        : `<wa-button size="medium" variant="brand" id="nextGroup">${batch ? "学习下一批" : "学习下一群"}</wa-button>`;
      view().innerHTML = `<div class="drill end"><h1>${gs.length > 1 ? `${gs.length} 个词群` : `第 ${G.no} 群`}过关 🎉</h1>
        <p class="note">${gs.length > 1 ? esc(grpLabel(gs)) : `${lesTitle(G.lid)} · 第 ${G.no} 群「${esc(G.title)}」`}已记为今天学的，明天早上开始复习；今晚睡前巩固还会再测一遍。</p>
        <div class="tally"><span>过关 <b>${D.passed}</b></span><span class="g">一次就过 <b>${D.items.filter(x => !(D.st.get(x.word) || {}).err && !(D.chopped && D.chopped.has(x.word))).length}</b></span><span class="f">错过才过 <b>${missed.length}</b></span>${D.res.z ? `<span>斩 <b>${D.res.z}</b></span>` : ""}</div>
        ${missed.length ? `<p class="note">本轮需要多练的：${missed.map(x => esc(x.word)).join("、")}。成绩分专项保留，不把听音或拼写错误当成词义遗忘。</p>` : ""}
        ${few && nx ? `<p class="note">${tier === "busy" ? "今天复习偏多，学新 1 群就够了" : "今天积压太多，本来先不学新词"}；想多学也可以再学 1 群。</p>` : ""}
        ${nx ? `<p class="note">${!few && batch ? `下一批：${batch}` : `下一群：${lesTitle(nx.lid)} 第 ${nx.no} 群`}</p>` : ""}
        <div class="ops">${few ? "" : nextBtn}
          ${btn("#/", "回首页", nx && !few ? undefined : 'variant="brand"', "medium")} ${btn("#/list/today", "浏览今天的词", undefined, "medium")}${few ? nextBtn : ""}</div></div>`;
      return;
    }
    const again = D.items.filter(x => ["f", "m"].includes(D.rated.get(x.word)));
    const ds = !D.practice && isRound(D.sc) ? dueStat() : null;
    const more = ds && D.sc === "due" ? dueTodo(ds) : 0;
    const extra = ds && !more ? Math.min(MORE_N, ds.rest.length) : 0;   // 今天的任务做完了，还剩积压：可以多做
    view().innerHTML = `<div class="drill end"><h1>这一轮结束 🎉</h1>
      <div class="tally"><span class="g">答对 <b>${g}</b></span><span class="m">需帮助或较慢 <b>${m}</b></span><span class="f">未通过 <b>${f}</b></span>${D.res.z ? `<span>斩 <b>${D.res.z}</b></span>` : ""}</div>
      ${isRound(D.sc) ? kindTally() : ""}
      ${ds && !more ? `<p class="note"><b>✅ 今天的复习任务完成了</b>${ds.rest.length ? `；剩下 ${ds.rest.length} 个已排到明天以后，想多做可以再来 ${extra} 个` : ""}。</p>` : ""}
      <p class="note">本轮为专项练习，成绩只计入对应能力，不改变词义等级、到期日期或早晚任务完成状态。未学词不创建复习卡。</p>
      ${more ? `<p class="note">还有 ${more} 个到期</p>` : ""}${again.length ? `<p class="note">未通过或需帮助：${again.length} 个</p>` : ""}
      <div class="ops">${more ? `<wa-button size="medium" variant="brand" id="nextRound">再来一轮</wa-button>` : extra ? `<wa-button size="medium" appearance="outlined" id="moreRound">多做几个</wa-button>` : ""}
        ${again.length ? `<wa-button size="medium" ${more ? 'appearance="filled"' : 'variant="brand"'} id="redo">再练一遍</wa-button>` : ""}
        ${btn("#/", "回首页", undefined, "medium")} ${btn("#/drill", "换个范围", undefined, "medium")}</div></div>`;
    D.again = again;
  }

  /* ---------- 周总结 ---------- */
  async function renderWeek(mon) {
    const t = T();
    mon = mon ? SRS.monday(mon) : SRS.monday(t);
    const end = SRS.add(mon, 6), days = weekCounts(mon);
    setHead("周总结");
    const marks = learnMarks().filter(([, d]) => d >= mon && d <= end);
    const byDay = {};
    for (const [k, d] of marks) { const [lid, g] = k.split(":g"); (byDay[d] = byDay[d] || []).push({lid, g: +g, info: groupInfo(lid, +g)}); }
    const tot = days.reduce((a, x) => ({learned: a.learned + x.learned, vocab: a.vocab + x.vocab.length, g: a.g + logOf(x.d).g, m: a.m + logOf(x.d).m, f: a.f + logOf(x.d).f}), {learned: 0, vocab: 0, g: 0, m: 0, f: 0});
    const rv = tot.g + tot.m + tot.f, pct = n => rv ? Math.round(n / rv * 100) : 0;
    const recalls = {independent: 0, effort: 0, hinted: 0, failed: 0};
    for (const x of days) for (const k of Object.keys(recalls)) recalls[k] += logOf(x.d).recall?.[k] || 0;
    const recallN = Object.values(recalls).reduce((a, b) => a + b, 0);
    const weekCards = inLearnRange(mon, end);
    const worst = weekCards.filter(x => x.card.l || x.card.r === "f" || x.card.r === "m")
      .sort((a, b) => (b.card.l || 0) - (a.card.l || 0) || (a.card.r === "f" ? -1 : 1)).slice(0, 20);
    const fc = [];
    if (mon === SRS.monday(t)) {                          // 只给本周预告下周
      const live = liveCards();
      for (let i = 1; i <= 7; i++) { const d = SRS.add(t, i); fc.push({d, n: live.filter(x => (i === 1 ? x.card.d <= d : x.card.d === d)).length}); }
    }
    const maxF = Math.max(1, ...fc.map(x => x.n));
    view().innerHTML = `<div class="weekv">
      <div class="vh"><a class="nav" href="#/week/${SRS.add(mon, -7)}">← 上一周</a><h1>${md(mon)}–${md(end)}</h1>
        ${mon < SRS.monday(t) ? `<a class="nav" href="#/week/${SRS.add(mon, 7)}">下一周 →</a>` : `<span class="nav"></span>`}</div>
      <div class="kpis"><div><b>${tot.learned + tot.vocab}</b><small>新学词${tot.vocab ? `（含生词 ${tot.vocab}）` : ""}</small></div><div><b>${marks.length}</b><small>词群</small></div><div><b>${rv}</b><small>复习次数</small></div>
        <div><b>${pct(tot.g)}%</b><small>记得</small></div></div>
      ${rv ? `<div class="ratebar"><span class="g" style="width:${pct(tot.g)}%"></span><span class="m" style="width:${pct(tot.m)}%"></span><span class="f" style="width:${pct(tot.f)}%"></span></div>
        <p class="note">总评分：记得 ${tot.g} · 模糊/提示 ${tot.m} · 忘了 ${tot.f}（含旧版选择成绩，不等同独立回忆）</p>` : ""}
      <p class="note">新回忆：独立 ${recalls.independent + recalls.effort}（其中费劲 ${recalls.effort}）· 提示后 ${recalls.hinted} · 未想起 ${recalls.failed}；旧版评分 ${rv - recallN} 次保留原义。</p>
      <div class="ops">${btn(`#/drill/${encodeURIComponent("w2:" + mon)}`, "开始周复习（本周 + 上周）", 'variant="brand"')} ${btn(`#/list/${encodeURIComponent("w:" + mon)}`, "浏览本周的词")}</div>
      <section class="panel"><h2>每天学了什么</h2>${days.map((x, i) => `<div class="drow${x.d === t ? " now" : ""}"><span class="dd">周${WEEK[(i + 1) % 7]} ${md(x.d)}</span>
        <span class="dg">${(byDay[x.d] || []).map(g => `<a href="#/${g.lid}/g${g.g}">${lesTitle(g.lid)} · ${g.g} ${esc(g.info ? g.info.title : "")}</a>`).join("")}${x.vocab.length ? `<span class="dv">生词：${x.vocab.map(esc).join("、")}</span>` : ""}${(byDay[x.d] || x.vocab.length) ? "" : `<small>${x.d > t ? "" : i === 6 ? "复习日" : "没记录"}</small>`}</span>
        <span class="dn">${x.learned ? x.learned + " 词" : ""}${x.vocab.length ? `${x.learned ? " + " : ""}生词 ${x.vocab.length}` : ""}${x.reviewed ? ` · 复 ${x.reviewed}` : ""}</span></div>`).join("")}</section>
      <section class="panel"><h2>本周最常忘的词</h2>${worst.length ? `<div class="worst">${worst.map(x => `<span data-w="${esc(x.word)}">${esc(x.word)}${x.card.l ? ` <small>✗${x.card.l}</small>` : ""}</span>`).join("")}</div>
        ${btn(`#/list/hard`, "打开难词本")}` : `<p class="note">还没有忘过的词</p>`}</section>
      ${fc.length ? `<section class="panel"><h2>接下来 7 天要复习</h2><div class="fc">${fc.map(x => `<div><span class="bar" style="height:${Math.round(x.n / maxF * 60) + 2}px"></span><b>${x.n}</b><small>${WEEK[SRS.dow(x.d)]}</small></div>`).join("")}</div>
        <p class="note">明天那一格包括之前拖下来没做的；所有复习和旧词校准共用每日预算；积压会分批安排，新词始终自选</p></section>` : ""}</div>`;
  }

  /* ---------- 路由入口：#/、#/drill[/范围]、#/list/范围、#/week[/周一]、#/log[/课id] ---------- */
  function isStudy(h) { return h === "" || h === "#" || h === "#/" || /^#\/(drill|list|week|log)(\/|$)/.test(h); }
  /* y：回到这个页面时接着上次滚到的位置（app.js 按地址记），新打开为 0 */
  async function render(h, y = 0) {
    const m = h.match(/^#\/(drill|list|week|log)(?:\/(.+))?$/);
    if (!m || m[1] !== "log") W = null;   // 离开记录页，没保存的勾选作废
    if (!m) { D = null; renderHome(); scrollBack(y, h); return; }
    const arg = m[2] && decodeURIComponent(m[2].split("?")[0]);
    if (m[1] === "log") { D = null; renderLog(arg); if (!arg || y) scrollBack(y, h); return; }
    if (m[1] === "drill") { if (!arg) { D = null; renderPicker(); } else { y = 0; if (!D || D.hash !== h) startDrill(arg); else if (D.q) showCard(); else endDrill(); } }
    else if (m[1] === "list") { D = null; await renderList(arg); }
    else { D = null; await renderWeek(arg); }
    scrollBack(y, h);   // 加载期间又去了别的页就不动
  }
  /* 别的设备同步过来新数据：首页、周总结重画；正在巩固的不打断 */
  function refresh() {
    const h = location.hash;
    if (/^#\/drill\/./.test(h)) return;
    if (/^#\/(list|log)/.test(h)) return;              // 浏览、记录页不重画，免得滚动位置和没保存的勾选丢掉
    render(h, scrollY);
  }

  /* ---------- 交互 ---------- */
  function drillKey(e) {
    if (!D || !D.q || !/^#\/drill\/./.test(location.hash) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (stopAuto()) { e.preventDefault(); return; }  // 答对后正等着自动下一题：按任意键只是停在这张卡
    const q = D.q;
    if (D.rc) {
      const c = D.rc.current;
      if (e.target.closest?.("input,select,textarea")) return;
      const covered = e.target.closest?.("[data-recall-cover]");
      if (covered && (e.key === " " || e.key === "Enter")) { e.preventDefault(); covered.dataset.recallCover === "reveal" ? revealRecall() : expandRecall(covered.dataset.recallCover); return; }
      if (e.key === "r" || e.key === "R") { sayWord(q.x); }
      else if (e.key === "s" || e.key === "S") chopRecall();
      else if (e.key === " " || e.key === "Enter") { e.preventDefault(); if (c.answered) next(); else if (!c.revealed) revealRecall(); }
      return;
    }
    if (e.target.id === "spell") {                   // 拼写框：Enter 提交、Esc 不会，其余照常打字
      if (e.key === "Enter") { e.preventDefault(); answer(0, e.target.value); }
      else if (e.key === "Escape") answer(-1, "");
      return;
    }
    if (e.target.closest && e.target.closest("input,select,textarea")) return;
    if (D.learn && (e.key === "m" || e.key === "M")) { lpToggle(); return; }
    if (peekOpen()) return;                          // 速览开着时不答题
    if (e.key === "ArrowLeft") { goBack(); return; }
    if (D.back) {                                    // 回看中：只能翻页、听读音
      if (e.key === "ArrowRight" || e.key === " " || e.key === "Enter") { e.preventDefault(); goFwd(); }
      else if (e.key === "r" || e.key === "R") sayWord(curQ().x);
      return;
    }
    if (e.key === "r" || e.key === "R") { sayQ(q); return; }
    if (e.key === "s" || e.key === "S") { chopCur(); return; }
    if (q.kind === "study") { if (e.key === " " || e.key === "Enter") { e.preventDefault(); studied(); } return; }
    if (q.kind === "flip") {
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); if (!q.flipped) { q.flipped = true; showCard(); } return; }
      if (q.flipped && "123".includes(e.key)) rateFlip({1: "f", 2: "m", 3: "g"}[e.key]);
      return;
    }
    if (q.state === "done") { if (e.key === " " || e.key === "Enter") { e.preventDefault(); next(); } return; }
    if (e.key === "0") { answer(-1); return; }
    if (q.opts && /^[1-9]$/.test(e.key) && +e.key <= q.opts.length) answer(+e.key - 1);
  }
  function onClick(e) {
    const t = e.target, v = view();
    if (t.closest("[data-migration-exit]")) {
      const state = memoryState();
      if (SRS.migrationStatus(liveCards(), T(), state, dailyPlan().budget.limit).ready) {
        Sync.set("migration:state", {...state, mode: "normal", ended: T()}); renderHome();
      }
      return;
    }
    if (t.closest("#nightSkip")) { Sync.set(nightKey(), {...nightRecord(), skipped: true, finished: false}); renderHome(); return; }
    if (D && /^#\/drill\/./.test(location.hash)) {
      const q = D.q, x = q && q.x;
      stopAuto();                                    // 点页面：不再自动下一题（点的按钮照常生效）
      if (t.closest("#redo")) { startDrill(D.sc, {title: "再过一遍", items: D.again}); return; }
      if (t.closest("#nextRound")) { startDrill("due"); return; }
      if (t.closest("#moreRound")) { if (location.hash === "#/drill/more") startDrill("more"); else location.hash = "#/drill/more"; return; }
      if (t.closest("#nextGroup")) { scrollTo(0, 0); startDrill("learn"); return; }
      if (D.learn && q && t.closest("#lpFab")) { lpToggle(); return; }
      if (!q) return;
      if (D.rc) { recallClick(t); return; }
      if (t.closest("[data-context-study]")) { q.contextStudy = true; showCard(); return; }
      if (t.closest("[data-restart]")) {
        if (!confirm("从头再来？这一轮的进度清掉，所有词重新出（已经记下的复习成绩不撤销）。")) return;
        progClear(D.progressScope || D.sc); startDrill(D.sc); return;
      }
      if (t.closest("[data-prev]")) { goBack(); return; }
      if (t.closest("[data-fwd]")) { goFwd(); return; }
      if (D.back) {                                  // 回看中：只响应读音和例句
        const px = curQ().x, sx = t.closest("[data-sayx]"), s = t.closest("[data-sent]");
        if (sx) sayWord(px, sx.dataset.sayx); else if (s) saySent(px, /slow/.test(s.dataset.sent), s.dataset.sent.startsWith("src")); else if (t.closest("[data-say]")) sayWord(px);
        return;
      }
      if (q.kind === "flip" && (t.closest("[data-flip]") || (!q.flipped && t.closest(".dcard") && !t.closest("[data-say]")))) { q.flipped = true; showCard(); return; }
      const sx = t.closest("[data-sayx]"); if (sx) { sayWord(x, sx.dataset.sayx); return; }
      const s = t.closest("[data-sent]"); if (s) { const v = s.dataset.sent; saySent(x, /slow/.test(v), v.startsWith("src")); return; }
      if (t.closest("[data-say]")) { sayQ(q); return; }
      const r = t.closest("[data-rate]"); if (r) { rateFlip(r.dataset.rate); return; }
      if (t.closest("[data-chop]")) { chopCur(); return; }
      if (t.closest("[data-studied]")) { studied(); return; }
      const op = t.closest("[data-opt]"); if (op && q.state === "ask") { answer(+op.dataset.opt, ""); return; }
      if (t.closest("[data-spell]")) { answer(0, ($("#spell") || {}).value); return; }
      if (t.closest("[data-next]")) { next(); return; }
    }
    const ld = t.closest("[data-lday]"); if (ld && W) { W.day = ld.dataset.lday; $$("[data-lday]", v).forEach(b => b.classList.toggle("on", b === ld)); return; }
    if (t.closest("#logSave") && W) {
      const {add, del} = logDiff();
      if (!add.length && !del.length) return;
      if (del.length && !confirm(`取消 ${del.length} 个词群的学习记录？这些词的复习进度也会删掉。`)) return;
      const day = W.day === "today" ? T() : SRS.add(T(), -1), label = W.day === "today" ? "今天" : "昨天";
      saveMarks([...add.map(k => [k, true]), ...del.map(k => [k, false])], day).then(() => {
        toast(add.length ? `已记为${label}学的：${add.length} 个词群${del.length ? `，取消 ${del.length} 个` : ""}` : `已取消 ${del.length} 个词群`);
        const y = scrollY; W = null; renderLog(); scrollTo(0, y);
      }).catch(err => toast("保存失败：" + err.message));
      return;
    }
    const o = t.closest("[data-order]"); if (o) { setS("drillOrder", o.dataset.order); renderPicker(); return; }
    const dm = t.closest("[data-dmode]"); if (dm) { setS("drillMode", dm.dataset.dmode); renderPicker(); return; }
    const pr = t.closest("[data-practice]"); if (pr) { setS("practiceType", pr.dataset.practice); renderPicker(); return; }
    if (t.closest("#listHide")) { store.set("listHide", !store.get("listHide", false)); renderList(decodeURIComponent(location.hash.split("/")[2])); return; }
    if (t.closest("#listFold")) { store.set("listFold", !store.get("listFold", false)); renderList(decodeURIComponent(location.hash.split("/")[2])); return; }
    const vd = t.closest("[data-vdel]");
    if (vd) {
      const w = vd.dataset.vdel;
      if (!confirm(`把「${w}」移出生词本？它的复习进度也会删掉。`)) return;
      removeVocab(w); toast(`已移出 ${w}`);
      const y = scrollY; renderList("vocab").then(() => scrollTo(0, y));
      return;
    }
    const row = t.closest(".lrow");
    if (row && v._items) {
      const x = v._items.find(q => q.word === row.dataset.w);
      if (t.closest("[data-say]")) { x && sayWord(x); return; }
      if (t.closest(".lm")) { t.closest(".lm").classList.toggle("show"); return; }
    }
    const lv = t.closest("#leaveBtn");
    if (lv) {
      const n = parseInt(prompt("往后顺延几天？所有词的复习日期整体后移，相当于这几天请假了。", lv.dataset.gap), 10);
      if (n > 0 && n < 60) { Sync.setMany([...allCards(), ...vocabMarks().map(([word, card]) => ({word, card, vocab: true}))].map(x => [cardKey(x), SRS.shift(x.card, n)])); toast(`已整体顺延 ${n} 天`); renderHome(); }
    }
  }
  function onChange(e) {
    const t = e.target;
    if (t.id === "bookScope" && t.value) location.hash = "#/drill/" + t.value + "?practice=" + (S.practiceType || "meaning");
    if (t.dataset.g && W) {
      const learned = !!Sync.get("learn:" + t.dataset.g, 0);
      t.checked === learned ? W.want.delete(t.dataset.g) : W.want.set(t.dataset.g, t.checked);
      t.closest(".lrec").classList.toggle("on", t.checked);
      paintLogBar();
    }
  }
  /* 记录页展开别的单元时再读词数（toggle 事件不冒泡，用捕获） */
  function onToggle(e) {
    const d = e.target; if (!d.matches || !d.matches("details.lunit") || !d.open) return;
    const u = BOOK.parts.flatMap(p => p.units).find(x => x.no === +d.dataset.u);
    if (u) fillCounts(u.lessons.filter(l => l.ready).map(l => l.id), paintLogBar);
  }
  document.addEventListener("keydown", drillKey);
  // 视频由 app.js 的 document 捕获监听器打开并停止冒泡；同层捕获才能记录这次帮助。
  document.addEventListener("click", e => {
    if (D?.rc && !D.rc.current?.revealed && e.target.closest("#studyView a[data-vi]")) {
      hintRecall("video"); showRecall();
    }
  }, true);
  const bind = () => { view().addEventListener("click", onClick); view().addEventListener("change", onChange); view().addEventListener("toggle", onToggle, true); };
  bind();

  return {isStudy, render, refresh, lookupCtx, markGroups, unmarkGroups, learnDate, nextGroups, vocabGet, addVocab, removeVocab, forgetBook};
})();
