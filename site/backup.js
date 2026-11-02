/* 导出 / 导入备份（纯函数，不碰页面和存储；浏览器里是全局 Backup，Node 里 require 进来跑单元测试）

   备份文件 = {app: "cet4-vocab", v: 1, at 导出时刻, origin 网址, 说明, d: Sync.dump()}，d 的格式同 sync.js：{键: [值, 修改时间]}。
   云同步 token 不在 d 里（sync.js 单独存），所以文件里也没有。
   文件长相（Backup.text 生成，「导出」和覆盖导入前自动下载的「导入前」备份都走它）：还是一份 JSON，只是排得方便人直接打开看——
     外层 app、v、at、origin、说明、d 每个字段一行；「说明」是中文的（导出时间、来自、每类条数、怎么导入、字段含义），每项一行，导入时忽略；
     d 每条记录一行（键和值同一行），按下面的类别顺序排，每类里没删的在前、已删除（值为 0，只有已会 / 学习记录和复习卡 / 生词本这三类算）的在后，各自按键名排。
   格式没变，所以新旧备份（旧的是一整行、没有说明）parse 都认，导入代码不用区分。

   导入按键前缀分类，可勾选类别：
     已会 known: / 设置 set: / 学习记录和复习卡 learn: srs: log:（三者绑在一起，拆开会对不上）/ 生词本 vocab: /
     阅读位置 last、lw:、pos: / 界面状态 vpGeo、peekTab、listFold、listHide、sideOff、learnPeek / 其他（认不出的键，以后新增的）
     drill:（练习断点）并入学习记录，只恢复同一学习日的有效断点；晚间任务 evening:、每日计划 plan:、分词完成 task: 和迁移阶段 migration: 也在学习记录中。
   两种方式：
     merge 合并 = 每个键取时间较新的（规则同 sync.js 的 merge），永远不会把本机更新的记录改回去
     overwrite 覆盖 = 勾选类别里文件有的键写入文件的值、时间记 now；文件里没有、本机有的：
       已会 / 学习记录和复习卡 / 生词本记 0（墓碑）；设置恢复成默认值（不记 0，有的设置合法值就是 0，比如 roundSize）；
       阅读位置、界面状态、其他不动。值已经和目标一样的键跳过 */
"use strict";
const Backup = (() => {
  const APP = "cet4-vocab", V = 1;
  const CATS = [
    {id: "known", name: "已会", prefixes: ["known:"], tomb: true},
    {id: "set", name: "设置", prefixes: ["set:"]},
    {id: "study", name: "学习记录和复习卡", prefixes: ["learn:", "srs:", "log:", "evening:", "browse:", "drill:", "plan:", "task:", "migration:"], tomb: true},
    {id: "vocab", name: "生词本", prefixes: ["vocab:"], tomb: true},
    {id: "pos", name: "阅读位置", keys: ["last"], prefixes: ["lw:", "pos:"]},
    {id: "ui", name: "界面状态", keys: ["vpGeo", "peekTab", "listFold", "listHide", "sideOff", "learnPeek"]},
    {id: "other", name: "其他"},
  ];
  const BY_ID = Object.fromEntries(CATS.map(c => [c.id, c]));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const newer = (a, b) => a[1] > b[1] || (a[1] === b[1] && JSON.stringify(a[0]) > JSON.stringify(b[0]));

  /* 键属于哪一类；练习断点与卡片一起归学习记录 */
  function catOf(k) {
    for (const c of CATS) if ((c.keys || []).includes(k) || (c.prefixes || []).some(p => k.startsWith(p))) return c.id;
    return "other";
  }
  const isTomb = (k, v) => v === 0 && !!(BY_ID[catOf(k)] || {}).tomb;   // 只有这几类的 0 是墓碑，设置的 0 是正常值

  /* 每类有几条（不算墓碑，含练习断点） */
  function summary(fileDoc) {
    const n = Object.fromEntries(CATS.map(c => [c.id, 0]));
    for (const [k, [v]] of Object.entries(fileDoc)) { const c = catOf(k); if (c && !isTomb(k, v)) n[c]++; }
    return n;
  }

  /* 要写入的 [键, [值, 时间]] 列表。cats = 勾选的类别 id，defaults = 设置的默认值 {名字: 值}（不带 set: 前缀） */
  function plan(localDoc, fileDoc, cats, mode, now, defaults = {}) {
    const rules = typeof SRS !== "undefined" ? SRS : typeof require === "function" ? require("./srs.js") : null;
    const task = typeof Recall !== "undefined" ? Recall : typeof require === "function" ? require("./recall.js") : null;
    if (rules) { localDoc = rules.upgradeDoc(localDoc); fileDoc = rules.upgradeDoc(fileDoc); }
    const on = new Set(cats), out = [];
    for (const [k, p] of Object.entries(fileDoc)) {
      if (!on.has(catOf(k))) continue;
      if (k.startsWith("drill:") && p[0] && p[0].d !== (rules ? rules.today(now) : day(now))) continue;
      const l = localDoc[k];
      if (mode === "merge") {
        const q = [p[0], Math.min(p[1], now)]; // 将来的时间夹到 now
        const merged = rules ? rules.mergeStudyRecord(k, l, q) : !l || newer(q, l) ? q : l;
        if (!l || !same(l, merged)) out.push([k, merged]);
      }
      else out.push([k, [p[0] && /^(plan|task):/.test(k) ? {...p[0], reset: now} : p[0], now]]); // 显式覆盖新任务记录时开启新恢复批次，旧云端词单不能反盖
    }
    if (mode === "overwrite") for (const [k, l] of Object.entries(localDoc)) {
      if (k in fileDoc) continue;
      const c = catOf(k);
      if (!on.has(c)) continue;
      if (BY_ID[c].tomb) out.push([k, [0, now]]);   // 已经是 0 也写 now，理由同上
      else if (c === "set") {
        const name = k.slice(4);
        if (name in defaults) out.push([k, [defaults[name], now]]);
      }
    }
    if (task && rules) {
      const doc = rules.upgradeDoc({...localDoc, ...Object.fromEntries(out)});
      for (const p of out) if (p[0].startsWith("drill:") && p[1][0]) p[1] = [task.validProgress(p[1][0], doc, rules.today(now)), p[1][1]];
    }
    return out;
  }

  /* 生成备份文件内容（对象；真正写进文件的文字用 text） */
  const make = (d, at, origin) => ({app: APP, v: V, at, origin, d});

  /* 备份文件里「说明 → 字段含义」：d 里各种键的意思。和 study.js 文件头的说明保持一致，改字段时两处一起改 */
  const FIELDS = {
    "learn:<课id>:g<词群号>": "学的日期",
    "srs:<词>": "复习卡：a 学习日、s 已过几站、d 下次复习日、l 忘过几次、r 最近一次结果（g 记得 / m 模糊 / f 忘了）、n 复习次数、"
      + "v 记进熟练度的次数、t 最近复习日、h 最近 6 次第一遍结果、q 答对过的最难题型（0 看词选义 / 1 听音 / 2 例句或看义选词 / 3 拼写）、"
      + "z 斩、p 学新整群过关的日期、cf 易混词、k 课id、g 词群号、f 火苗、o 词条序号；life 卡片生命周期；recall 新回忆等级与跨天证据（不追认旧选择成绩）；skills 分专项成绩；attempts 已计分标识",
    "log:<日期>": "当天评分次数 g / m / f（含旧版评分）、dv 当天复习的到期词数、mv 当天做的必做数；recall 独立/费劲/提示/失败的新回忆计数；tasks 按今日复习/旧晚间/自由回忆分记；skills 专项计数；dailyBase 保留新调度前当日计数基线",
    "vocab:<原形>": "生词本：w 原形、x 点到的写法、m 释义、p 音标、k 出处课、e 出处词条、at 加入日期、o 加入时刻、bk 书中位置、ph 例句词组，另带复习卡字段",
    "known:<词>": "1 已会",
    "set:<名字>": "设置",
    "last": "上次读的课",
    "lw:<课id>、pos:<课id>": "阅读位置",
    [BY_ID.ui.keys.join("、")]: "界面状态",
    "drill:<范围>": "练习断点，只恢复同一学习日且对应卡片/词群仍有效的进度；rc 含提示、首次表现、有限补测及任务标识",
    "evening:<日期>": "晚间独立任务：items 按卡片生命周期保存结果，finished 完成，skipped 跳过；不以白天答题日判断完成",
    "browse:<日期>": "途中浏览记录，不计回忆成功",
    "plan:<日期>": "当日固定推荐词单：items 含单词、生命周期和任务类别；budget 含张数、预计用时及补测预留，credited 为升级前当日已做量；reset 为显式覆盖恢复批次",
    "task:<日期>:<生命周期>": "同一词当天的首次回忆与补测，按生命周期去重；不覆盖首次评分，不重新推进 SRS",
    "migration:state": "记忆校准阶段与旧词生命周期清单，退出只改变模式，不重置卡片",
  };
  const HOWTO = "设置页 → 数据 → 导入…，选这个文件；导入时只读 app、v、d，这段说明会被忽略。"
    + "d 里每条是 [值, 修改时间（毫秒）]；已会、学习记录和复习卡、生词本里值为 0 表示已删除（合并时靠它把删除同步过去），设置里的 0 就是 0。";

  /* 键名比较：数字按大小比（g2 排在 g10 前），其余按字符，不看系统语言 */
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  function byName(a, b) {
    const x = a.split(/(\d+)/), y = b.split(/(\d+)/);   // 奇数位是数字段
    for (let i = 0; i < x.length && i < y.length; i++) {
      const c = i % 2 ? cmp(+x[i], +y[i]) || cmp(x[i], y[i]) : cmp(x[i], y[i]);
      if (c) return c;
    }
    return x.length - y.length;
  }
  /* 在文件里排哪一类，类内先精确键，再按 prefixes 的顺序（learn → srs → log → 晚间/浏览/断点） */
  const slot = k => CATS.findIndex(c => c.id === (catOf(k) || "other"));
  function sub(k) {
    const c = CATS[slot(k)];
    if ((c.keys || []).includes(k)) return 0;
    return (c.prefixes || []).findIndex(p => k.startsWith(p)) + 1;
  }

  /* 本地时间 YYYY-MM-DD HH:MM（备份文件「说明」里的导出时间） */
  const stamp = t => { const x = new Date(t), p = n => String(n).padStart(2, "0"); return `${day(t)} ${p(x.getHours())}:${p(x.getMinutes())}`; };

  /* 生成备份文件的文字：合法 JSON，但排成人看得懂的样子（排版规则见文件开头）。值一律 JSON.stringify，不手拼转义 */
  function text(d, at, origin = "") {
    const q = JSON.stringify, n = summary(d);
    const rows = Object.keys(d)
      .map(k => ({k, c: slot(k), dead: isTomb(k, d[k][0]) ? 1 : 0, s: sub(k)}))
      .sort((a, b) => a.c - b.c || a.dead - b.dead || a.s - b.s || byName(a.k, b.k))
      .map(({k}) => `${q(k)}: [${q(d[k][0]) ?? "null"}, ${q(d[k][1])}]`);
    const join = (lines, indent) => lines.map((l, i) => indent + l + (i < lines.length - 1 ? "," : "")).join("\n");
    const meta = [
      `"导出时间": ${q(stamp(at))}`,
      `"来自": ${q(origin)}`,
      `"每类条数": {${CATS.map(c => `${q(c.name)}: ${n[c.id]}`).join(", ")}}`,
      `"怎么导入": ${q(HOWTO)}`,
      `"字段含义": {\n${join(Object.entries(FIELDS).map(([k, v]) => `${q(k)}: ${q(v)}`), "    ")}\n  }`,
    ];
    const outer = [
      `"app": ${q(APP)}`, `"v": ${V}`, `"at": ${q(at)}`, `"origin": ${q(origin)}`,
      `"说明": {\n${join(meta, "  ")}\n}`,
      `"d": ${rows.length ? `{\n${join(rows, "  ")}\n}` : "{}"}`,
    ];
    return `{\n${outer.join(",\n")}\n}\n`;
  }

  /* 解析备份文件文字：格式不对返回 null */
  function parse(text) {
    let o;
    try { o = JSON.parse(text); } catch { return null; }
    if (!o || typeof o !== "object" || o.app !== APP || o.v !== V) return null;
    const d = o.d;
    if (!d || typeof d !== "object" || Array.isArray(d)) return null;
    if (Object.keys(d).some(k => k === "__proto__" || k === "constructor" || k === "prototype")) return null;
    for (const p of Object.values(d)) if (!Array.isArray(p) || p.length !== 2 || typeof p[1] !== "number" || !isFinite(p[1])) return null;
    return {at: typeof o.at === "number" ? o.at : 0, origin: typeof o.origin === "string" ? o.origin : "", d};
  }

  /* 文件名里的日期：本地时间 YYYY-MM-DD */
  const day = t => { const x = new Date(t); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };

  return {CATS, catOf, summary, plan, make, text, parse, day, stamp};
})();
if (typeof module === "object" && module.exports) module.exports = Backup;
