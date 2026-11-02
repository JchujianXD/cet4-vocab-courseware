/* 滚动复习规则（纯函数，不碰页面和存储；浏览器里是全局 SRS，Node 里 require 进来跑单元测试）

   2026-11-02：日常任务统一走 makeDailyPlan / dailyStatus，所有主任务共用张数和时间预算；
   词单当天固定，补测最多五次、不重复评分；晚间不再必做，新词始终自选。
   新规则及数据兼容见 docs/plans/2026-11-02-daily-learning.md。下面旧队列和上限说明仅用于兼容。

   2026-10-28 日常复习已改主动回忆，当前规则见 rateRecall 上方及 docs/plans/2026-10-28-active-recall.md。
   旧卡等级先快照保留；下面 g/m/f、q 与自动题型的说明用于旧成绩兼容及原有新学流程，不再用于日常回忆评分。

   一句话：学完次日复习，之后每次从「这次复习的日子」往后数：隔 3 天 → 隔 7 天 → 按熟练度拉开（2026-10-21 改，见 docs/plans/2026-10-21-lighter-review.md）。
   每张卡记 学习日 a、已过站数 s、到期日 d；间隔从复习那天算，所以哪天没做、晚做几天，后面的站整体往后顺，不会第二天又到期。
     学完 → 次日（newCard，s=0）
     第 1 次复习后（s=1）→ 隔 3 天；第 2 次后（s=2）→ 隔 7 天
     第 3 次起（s≥3）→ 按熟练度：0～1 级 7 天、2 级 10 天、3 级 14 天、4 级 21 天、5 级 30 天
     隔 7 天及以上的按词错开 −1 / 0 / +1 天（spread），同一天学的一批词不会总挤在同一天到期
   以前是「次日 → 本周日 → 上周今天 → 上上周的周日」，按学习日和周日排：周日一跳过就压到周一，补做后下一站又常常是第二天。
   记得 → 进下一站；模糊 → 也进下一站（算过关但费劲：打断连对、不升题型，s≥3 时熟练度落到 2 级即 10 天）；忘了 → 从今天重新开始。
   选中易混干扰项（混淆，opt.hold）其实是答错：记 m，站数不变，2 天后再来。2026-10-15 前模糊也是这样，见 docs/plans/2026-10-15-fuzzy-pass.md。
   还没到期就复习（途中看、睡前、周总结多刷）：记得 / 模糊不改计划也不记进熟练度，忘了照样重来。
   考前封顶：12-05 前复习、到期日又晚于 12-09 的，改到 12-05～12-09 之间，按词分散到各天；窗口里及之后复习的不封顶。

   早上复习的顺序和每天上限（2026-10-20 改，见 docs/plans/2026-10-20-morning-review.md；站点和间隔不变）：
     必做（isMust）= 到期且还没做过第一次复习（s=0：昨天学的、昨天忘的、之前拖下没做第一次的）：全部排最前，不占每天上限；
     其余按计划间隔从短到长分 5 段（band：s=1 / s=2 或 s≥3 且熟练度≤2 / s≥3 且 3 级 / 4 级 / 5 级），
       段内拖过的先、熟练度低的先；每天上限只管这部分，做不完的老词往后排（同样拖一天，新的掉得多、老的几乎不掉）。
     今天的总复习量 L（还到期的 + 今天已做的到期复习）分三档（loadTier）：≤ 上限一半 照常学新 / ≤ 上限 学新最多 1 群 / > 上限 不学新词；
     forecast 估积压第几天清完（必做全做、其余每天最多上限个，不算以后新学的）。

   熟练度（level，0～5）：每轮只记第一遍作答，h 存最近 6 次（g 记得 / m 模糊 / f 忘了），
   q 是第一遍答对过的最难题型（0 看词选义 / 1 听音选义 / 2 例句挖空、看中文选英文 / 3 拼写），z=1 是手动「斩」。
   n 是总作答轮数（含提前复习），v 是记进熟练度的轮数（到期复习 + 忘了）；熟练度和出题只看 v，提前复习不会让题型跳级。
   连对 = h 末尾连续 g 的个数；从上往下命中即止：
     z=1 → 5；h 末位 f，或忘过≥2 次且连对<2 → 1；还没正式复习过（v=0）→ 0；
     s≥4 且连对≥4 且 q≥3 → 5；s≥4 且连对≥3 且 q≥2 → 4；s≥3 且连对≥2 → 3；其他 → 2
   出题：题型 = min(熟练度对应题型, q+1)，每次最多升一级；5 级只做快速抽查。
   关掉的题型（设置里关掉听音 / 拼写，opt.off 传题型编号）：出题遇到关掉的，换成梯子上往上数第一个没关的，往上没有就往下找
     （听音关掉 → 看词选义答对过就直接出例句题；拼写关掉 → 最高到例句题 / 看义选词）；
     熟练度对关掉的题型不作要求：拼写关掉时 5 级只要 s≥4 且连对≥4（同词组卡）；听音关掉不影响（4 级本来就看例句题）。
   判模糊的时限可乘一个倍数（设置「想得久算模糊」：宽松 1.5 / 标准 1 / 严格 0.75 / 关掉 0 = 不按时间判模糊）。
   词组卡（生词本里原形含空格的，或 ph=1 的例句词组，见 isPhrase）：只出看词组选义（MEAN）和翻卡（5 级的快速抽查 QUICK），
     不出听音、例句、拼写；熟练度不看 q（拼写题出不了，否则到不了 4、5 级）：s≥4 且连对≥4 → 5；s≥4 且连对≥3 → 4，其余同上。
   日期都用本地日期字符串 YYYY-MM-DD，一天从凌晨 4 点开始算 */
"use strict";
const SRS = (() => {
  const DAY = 86400000, CUTOFF_H = 4;
  const EXAM = "2026-12-12";                          // 考试日；换六级只改这里
  const H_LEN = 6;
  /* 选择题答对但超过这个时限算模糊（毫秒），按题型：听音从读音第一次播完算起，其余从出题算起；词组卡按看词选义 */
  const SLOW_MS = {mean: 8000, listen: 8000, reverse: 10000, cloze: 15000};
  const STEP_DAYS = [3, 7];                           // 第 1、2 次复习后隔几天（学完到第 1 次复习是次日，见 newCard）
  const LV_DAYS = [7, 7, 10, 14, 21, 30];             // 第 3 次复习起（s≥3）各熟练度的间隔
  const TYPE = {MEAN: 0, LISTEN: 1, CONTEXT: 2, SPELL: 3, QUICK: 4};
  const pad = n => String(n).padStart(2, "0");
  const toNum = s => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d) / DAY; };
  const toStr = n => { const t = new Date(n * DAY); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
  const add = (s, n) => toStr(toNum(s) + n);
  const diff = (a, b) => toNum(a) - toNum(b);        // a - b，天数
  const dow = s => new Date(toNum(s) * DAY).getUTCDay();   // 0=周日 … 6=周六
  const hash = s => { let h = 5381; for (const ch of String(s)) h = (h * 33 + ch.charCodeAt(0)) >>> 0; return h; };

  /* 今天：凌晨 4 点前还算前一天 */
  function today(now = Date.now()) {
    const t = new Date(now - CUTOFF_H * 3600000);
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  }
  const monday = s => add(s, -((dow(s) + 6) % 7));   // 所在周的周一（周一到周日算一周）

  /* 进到第 s 站（s≥1）后隔几天；s≥3 按熟练度 lv（不传按 4 级，即 21 天） */
  const stationGap = (s, lv = 4) => (s <= STEP_DAYS.length ? STEP_DAYS[s - 1] : LV_DAYS[lv]);
  /* 错开：隔 7 天及以上的，按词和复习日在 −1 / 0 / +1 天里取一个（同一个词同一天复习结果一样） */
  const spread = (gap, key, t) => (gap >= 7 ? gap + (hash(`${key}|${t}`) % 3) - 1 : gap);
  /* 从复习日 t 进到第 s 站后的到期日 */
  const stationDue = (s, t, lv = 4, key = "") => add(t, spread(stationGap(s, lv), key, t));

  /* 考前封顶：窗口（考前 7 天～考前 3 天）开始前复习、算出的到期日又晚于窗口的，按 key 分散到窗口各天；
     在窗口里或之后复习的不管（刚见过） */
  function examCap(d, t, key, exam = EXAM) {
    const lo = add(exam, -7), end = add(exam, -3);
    if (d <= end || t >= lo) return d;
    return add(lo, hash(key) % (diff(end, lo) + 1));
  }

  /* 熟练度 */
  const hist = c => c.h ?? (c.n ? c.r || "" : "");   // 旧卡没有 h：用最近一次评分顶上
  const reviews = c => c.v ?? hist(c).length;       // 记进熟练度的轮数；旧卡没有 v：h 每轮记一次，用它的长度顶上
  function streak(c) { const h = hist(c); let k = 0; while (k < h.length && h[h.length - 1 - k] === "g") k++; return k; }
  /* 词组卡：生词本里原形含空格的（包括以前从逐词释义划选加进来的短语），或标了 ph 的例句词组 */
  const isPhrase = c => !!(c && (c.ph || /\s/.test(c.w || "")));
  /* 关掉的题型：opt.off 是题型编号的数组（如 [TYPE.LISTEN, TYPE.SPELL]），不传就是都开着 */
  const offOf = opt => new Set(opt.off || []);
  /* opt.phrase：按词组卡算（不传就看卡片自己）；opt.off：关掉的题型 */
  function legacyLevel(c, opt = {}) {
    if (c.z) return 5;
    const h = hist(c), k = streak(c), ph = opt.phrase ?? isPhrase(c), q = ph ? 3 : c.q || 0;   // 词组卡不看 q
    if (h.endsWith("f") || ((c.l || 0) >= 2 && k < 2)) return 1;
    if (!reviews(c)) return 0;
    if (c.s >= 4 && k >= 4 && (q >= 3 || offOf(opt).has(TYPE.SPELL))) return 5;   // 拼写关掉：5 级不要求拼对过
    if (c.s >= 4 && k >= 3 && q >= 2) return 4;
    if (c.s >= 3 && k >= 2) return 3;
    return 2;
  }

  /* 2026-10-28：词义等级与专项能力分开。旧卡只追加等级快照，不回算旧成绩为主动回忆。
     独立到期成功进站；费劲用标准间隔的 70%；提示保持站数、两天后；失败次日重来。
     跨天独立证据：熟悉 s≥3/2 天，掌握 s≥4/3 天，牢记 s≥5/4 天。
     提前成功、同日再答和补测不增加稳定证据。完整方案见 2026-10-28-active-recall.md。 */
  function level(c, opt = {}) { return c.z ? 5 : c.recall?.v === 1 && Number.isInteger(c.recall.level) ? c.recall.level : legacyLevel(c, opt); }
  function upgradeCard(c, key = "", stamp = 0, opt = {}) {
    if (!c || typeof c !== "object" || typeof c.d !== "string" || c.recall?.v === 1) return c;
    return {...c, life: c.life || `${key}|${stamp}`, recall: {v: 1, level: legacyLevel(c, opt), days: 0, day: "", result: "", history: []}, skills: c.skills || {}, attempts: c.attempts || []};
  }
  /* 同步时间保持原样；只对有效卡升级。可在载入、导入和合并后重复调用。 */
  function upgradeDoc(doc) {
    const off = [...(doc["set:quizListen"]?.[0] === false ? [TYPE.LISTEN] : []), ...(doc["set:quizSpell"]?.[0] === false ? [TYPE.SPELL] : [])];
    const upgraded = Object.fromEntries(Object.entries(doc).map(([k, p]) => {
      if (!/^(srs|vocab):/.test(k)) return [k, p];
      let c = upgradeCard(p[0], k, p[1], {off});
      // 两端离线答了同一主任务：以合并后的首次事件还原同一次评分的排期。
      // 只校正当前最后一次正式评分；较晚学习日、人工重学、墓碑与新生命周期不回滚。
      const last = c?.recall?.history?.at(-1), event = last && doc[taskKey(last.day, c.life)]?.[0], first = event?.first;
      if (first?.schedule && !c.z && event.life === c.life && event.d === last.day && last.id === dailyAttempt(last.day, c.life)
          && (last.result !== first.result || last.at !== first.at)) {
        const fields = Object.fromEntries(Object.entries(first.schedule).filter(([k]) => ["a", "s", "d", "l", "r", "n", "t", "h", "v", "z"].includes(k)));
        const recall = Object.fromEntries(Object.entries(first.schedule.recall || {}).filter(([k]) => ["level", "days", "day", "result"].includes(k)));
        // 保留评分之后的整体顺延，包括仍运行旧版 shift 的设备；两日期同量变化才视作顺延。
        const baseline = c.recall.schedule, canShift = baseline?.id === last.id && [c.a, c.d, baseline.a, baseline.d].every(d => typeof d === "string");
        const delta = canShift ? diff(c.a, baseline.a) : 0;
        const shifted = canShift && diff(c.d, baseline.d) === delta ? delta : 0;
        const schedule = {id: last.id, a: fields.a, d: fields.d};
        if (shifted) { fields.a = add(fields.a, shifted); fields.d = add(fields.d, shifted); }
        const record = {id: last.id, day: last.day, due: first.due ?? last.due, result: first.result, hints: first.hints || [], at: first.at};
        c = {...c, ...fields, recall: {...c.recall, ...recall, schedule,
          results: {...c.recall.results, [last.id]: {result: first.result, hints: first.hints || [], at: first.at}},
          history: c.recall.history.map(h => h.id === last.id ? record : h)}};
      }
      return [k, [c, p[1]]];
    }));
    // 新版日志 = 原有当日基线 + 去重后的分词首次事件。并发设备答同一词也只计一次。
    // 旧日志、专项成绩以及日志原同步时间均保留。
    const byDay = new Map();
    for (const [k, [v]] of Object.entries(upgraded)) if (k.startsWith("task:") && v?.first?.counted) {
      if (!byDay.has(v.d)) byDay.set(v.d, []);
      byDay.get(v.d).push(v.first);
    }
    for (const [day, records] of byDay) {
      const p = upgraded["log:" + day]; if (!p?.[0]?.dailyBase) continue;
      const log = {...p[0], ...JSON.parse(JSON.stringify(p[0].dailyBase))};
      for (const first of records) {
        const r = recallGrade(first.result), task = first.task || "free";
        log[r] = (log[r] || 0) + 1;
        if (first.due) log.dv = (log.dv || 0) + 1;
        if (first.must) log.mv = (log.mv || 0) + 1;
        log.recall = {...log.recall, [first.result]: (log.recall?.[first.result] || 0) + 1};
        log.tasks = {...log.tasks, [task]: {...log.tasks?.[task], [first.result]: (log.tasks?.[task]?.[first.result] || 0) + 1}};
      }
      upgraded["log:" + day] = [log, p[1]];
    }
    return upgraded;
  }
  const freshCard = (date, life) => {
    const c = upgradeCard(newCard(date), life, 0);
    return {...c, recall: {...c.recall, origin: "new"}};
  };
  const recallResult = (correct, hinted = false, effort = false) => !correct ? "failed" : hinted ? "hinted" : effort ? "effort" : "independent";
  const recallGrade = result => result === "failed" ? "f" : result === "hinted" ? "m" : "g";
  function rateRecallRaw(card, result, t, opt = {}) {
    if (!["independent", "effort", "hinted", "failed"].includes(result)) throw new Error("无效的回忆结果");
    const c = upgradeCard(card, opt.key), id = opt.id;
    if (id && (c.attempts || []).includes(id)) return card;
    const due = isDue(c, t), r = recallGrade(result), old = c.recall;
    const evidence = due && old.day !== t && (result === "independent" || result === "effort");
    const days = r === "g" ? (old.days || 0) + (evidence ? 1 : 0) : 0;
    const rec = {...old, days, day: due ? t : old.day, result,
      results: id ? {...old.results, [id]: {result, hints: opt.hints || [], ...(opt.at ? {at: opt.at} : {})}} : old.results || {},
      history: [...(old.history || []), {id, day: t, result, hints: opt.hints || [], due, ...(opt.at ? {at: opt.at} : {})}].slice(-H_LEN)};
    let n = {...c, recall: rec, attempts: id ? [...(c.attempts || []), id] : c.attempts || [], r, n: (c.n || 0) + 1, t};
    if (r !== "g") {
      rec.level = r === "f" ? 1 : 2;
      const formal = due || r === "f";
      n = {...n, z: 0, h: formal ? (hist(c) + r).slice(-H_LEN) : hist(c), v: reviews(c) + (formal ? 1 : 0)};
      if (r === "f") return {...n, a: t, s: 0, d: add(t, 1), l: (c.l || 0) + 1};
      const check = add(t, 2);
      return {...n, d: due ? examCap(check, t, opt.key || "", opt.exam) : c.d < check ? c.d : check};
    }
    if (!evidence) return n;                         // 提前或同日再答：不推进，也不覆盖首次失败的等级
    const s = (c.s || 0) + 1;
    const earned = s >= 5 && days >= 4 ? 5 : s >= 4 && days >= 3 ? 4 : s >= 3 && days >= 2 ? 3 : 2;
    rec.level = Math.max(level(c), earned);
    n = {...n, s, h: (hist(c) + r).slice(-H_LEN), v: reviews(c) + 1};
    let gap = stationGap(s, level(n));
    if (result === "effort") gap = Math.max(1, Math.floor(gap * 0.7));
    return {...n, d: examCap(add(t, spread(gap, opt.key || "", t)), t, opt.key || "", opt.exam)};
  }
  function rateRecall(card, result, t, opt = {}) {
    const next = rateRecallRaw(card, result, t, opt);
    if (next === card || typeof opt.id !== "string" || !opt.id.startsWith("daily:")) return next;
    return {...next, recall: {...next.recall, schedule: {id: opt.id, a: next.a, d: next.d}}};
  }
  function rateSkill(card, ability, r, t, opt = {}) {
    if (!["recognition", "listen", "spell", "context"].includes(ability)) throw new Error("无效的专项类型");
    const c = upgradeCard(card, opt.key), id = opt.id;
    if (id && (c.attempts || []).includes(id)) return card;
    const old = c.skills?.[ability] || {n: 0, g: 0, m: 0, f: 0};
    return {...c, attempts: id ? [...(c.attempts || []), id] : c.attempts || [],
      skills: {...c.skills, [ability]: {...old, n: (old.n || 0) + 1, [r]: (old[r] || 0) + 1, t, r}}};
  }

  /* 出什么题：2 级在看词选义 / 听音选义间按正式复习次数轮换；词组卡只有看词组选义和 5 级的快速抽查（翻卡）。
     opt.off：关掉的题型，换成梯子（看词选义 → 听音 → 例句 → 拼写）上往上第一个没关的，往上没有就往下找；看词选义关不掉 */
  function pickType(c, opt = {}) {
    const ph = opt.phrase ?? isPhrase(c), off = offOf(opt), lv = level(c, {phrase: ph, off: opt.off});
    if (lv === 5) return TYPE.QUICK;
    if (ph) return TYPE.MEAN;
    const want = lv <= 1 ? TYPE.MEAN : lv === 2 ? reviews(c) % 2 : lv === 3 ? TYPE.CONTEXT : TYPE.SPELL;
    const ty = Math.min(want, (c.q || 0) + 1);
    if (ty === TYPE.MEAN || !off.has(ty)) return ty;
    const ladder = [TYPE.MEAN, TYPE.LISTEN, TYPE.CONTEXT, TYPE.SPELL].filter(x => x === TYPE.MEAN || !off.has(x));
    return ladder.find(x => x > ty) ?? ladder.filter(x => x < ty).pop();
  }

  /* 判分：选择题看对错和用时（kind 是题型 mean / listen / reverse / cloze，时限见 SLOW_MS）；拼写全对 g、错一个字母 m。
     opt.slow：时限的倍数（默认 1；0 = 不按时间判模糊，只看对错） */
  const gradeChoice = (ok, ms, kind = "mean", opt = {}) => {
    const k = opt.slow ?? 1;
    return !ok ? "f" : k > 0 && ms > (SLOW_MS[kind] || SLOW_MS.mean) * k ? "m" : "g";
  };
  function editDist(a, b) {
    let prev = Array.from({length: b.length + 1}, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  }
  function gradeSpell(input, answer) {
    const d = editDist(input.trim().toLowerCase(), answer.trim().toLowerCase());
    return d === 0 ? "g" : d === 1 ? "m" : "f";
  }

  /* 记为某天学的：新卡次日到期 */
  const newCard = date => ({a: date, s: 0, d: add(date, 1), l: 0, r: "", n: 0, h: ""});
  const isDue = (c, t) => c.d <= t;

  /* 打分：g 记得 / m 模糊 / f 忘了。返回新卡，不改原卡；t 记下最近一次复习的日期。
     opt.type：这次的题型（第一遍答对时更新 q）；opt.key：考前封顶时用来分散日期，一般传单词；opt.exam：考试日（默认 EXAM）；
     opt.hold：选中易混干扰项（混淆），r 传 m，站数不变、2 天后再来；opt.off：关掉的题型（算 s≥3 的间隔时熟练度按它放宽） */
  function rate(c, r, t, opt = {}) {
    const key = opt.key ?? `${c.k}|${c.g}|${c.o}|${c.w}`;
    const n = {...c, r, n: (c.n || 0) + 1, t};
    const h = (hist(c) + r).slice(-H_LEN), v = reviews(c) + 1;
    if (r === "f") return {...n, a: t, s: 0, d: add(t, 1), l: (c.l || 0) + 1, h, v, z: 0};
    if (!isDue(c, t)) return n;                     // 提前复习：不改计划，也不记进熟练度（v 不加）
    const q = r === "g" && opt.type >= 0 && opt.type <= TYPE.SPELL ? Math.max(c.q || 0, opt.type) : c.q || 0;
    if (opt.hold) return {...n, h, v, q, d: examCap(add(t, 2), t, key, opt.exam || EXAM)};
    const s = c.s + 1, nc = {...n, h, v, q, s};       // 记得、模糊都进下一站；模糊靠 h 打断连对来降熟练度
    return {...nc, d: examCap(stationDue(s, t, level(nc, {off: opt.off}), key), t, key, opt.exam || EXAM)};
  }

  /* 斩：直接 5 级，30 天后（或考前窗口）抽查；抽查答错照常重来并清掉 z */
  const chop = (c, t, key = c.w || "", exam = EXAM) => ({...c, z: 1, s: Math.max(c.s, 4), d: examCap(add(t, LV_DAYS[5]), t, key, exam)});

  /* 难词本：最近一次是忘了，或忘过不止一次，或还有没分清的易混词（cf） */
  const isHard = c => c.r === "f" || c.recall?.level === 1 || c.recall?.result === "hinted" || (c.l || 0) >= 2 || !!(c.cf && c.cf.length);

  /* 今天到期的：拖得最久的先来，同一天到期的火苗多的先来，再按课本顺序（首页数数、找拖得最久的用；出题顺序见 queue） */
  function dueList(items, t) {
    return items.filter(x => isDue(x.card, t))
      .sort((x, y) => (x.card.d < y.card.d ? -1 : x.card.d > y.card.d ? 1 : 0) || (y.freq || 0) - (x.freq || 0) || (x.order || 0) - (y.order || 0));
  }

  /* 可复现的随机数（seed 相同结果相同，方便测试） */
  function rng(seed) {
    let a = hash(seed);
    return () => { a = (a + 0x6D2B79F5) >>> 0; let x = Math.imul(a ^ (a >>> 15), 1 | a); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  }

  /* 乱序，并尽量让同组（groupOf 相同）的不相邻 */
  function shuffleSpread(list, groupOf, seed = "") {
    const a = list.slice(), rand = rng(seed);
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    const left = new Map(), out = [];                 // 每次从和上一个不同组的里，挑剩得最多的那组（同组按乱序先后）
    for (const x of a) left.set(groupOf(x), (left.get(groupOf(x)) || 0) + 1);
    while (a.length) {
      const last = out.length ? groupOf(out[out.length - 1]) : undefined;
      let i = -1;
      a.forEach((x, k) => { const g = groupOf(x); if (g !== last && (i < 0 || left.get(g) > left.get(groupOf(a[i])))) i = k; });
      if (i < 0) i = 0;                               // 只剩同一组：只好相邻
      left.set(groupOf(a[i]), left.get(groupOf(a[i])) - 1);
      out.push(a.splice(i, 1)[0]);
    }
    return out;
  }

  /* 形近：编辑距离很小，或者前 4 个字母相同（较长的词）；出干扰项、排顺序都用 */
  function similar(a, b) {
    a = a.toLowerCase(); b = b.toLowerCase();
    if (a === b) return false;
    return editDist(a, b) <= Math.max(1, Math.floor(Math.min(a.length, b.length) / 4)) || (a.length >= 5 && b.length >= 5 && a.slice(0, 4) === b.slice(0, 4));
  }
  /* 选择题干扰项：释义拆成义项词（去掉词性、括号里的补充），比较有没有共同义项 */
  const POS_RE = /\b[a-z]+\.(?:\s*&\s*[a-z]+\.)*/gi;
  const senseKeys = text => new Set(String(text).replace(/\[\[|\]\]/g, "").replace(POS_RE, " ")
    .replace(/（[^）]*）|\([^)]*\)/g, "").split(/[，；,;、\s]+/).filter(Boolean));
  const posSet = text => new Set((String(text).match(/\b[a-z]+\./gi) || []).map(p => p.toLowerCase()));
  /* 候选干扰项的性质（t、c 是 {word, mean}，mean 是带词性的释义文本）：
     "bad"  有共同义项，选了也不算错，不能用（elect 的「选择」和 select 的「选择」）
     "pos"  形近、有共同义项、但词性完全不同：考词性辨析（injury n. / injure v.）
     "near" 形近或同词群：容易混，每题最多放 1 个（"pos" 也占这个名额）
     null   普通干扰项 */
  function distractorTag(t, c, sameGroup = false) {
    const ka = senseKeys(t.mean), kb = senseKeys(c.mean), sim = similar(t.word, c.word);
    if ([...kb].some(k => ka.has(k))) {
      const pa = posSet(t.mean), pb = posSet(c.mean);
      return sim && pa.size && pb.size && ![...pb].some(p => pa.has(p)) ? "pos" : "bad";
    }
    return sim || sameGroup ? "near" : null;
  }
  /* 卡片上的混淆词 cf：最近混淆的在前，最多 3 个；带着它答对就删掉 */
  const confAdd = (cf, w) => [w, ...(cf || []).filter(x => x !== w)].slice(0, 3);
  const confDrop = (cf, w) => (cf || []).filter(x => x !== w);
  /* 把不同组的形近词挪到一起（adapt 后面紧跟 adopt），对比着记；同组的不动（书上按词根成群，同群形近是常态） */
  function pairSimilar(list, groupOf) {
    const out = [], used = new Set();
    list.forEach((x, i) => {
      if (used.has(i)) return;
      used.add(i); out.push(x);
      const j = list.findIndex((y, k) => !used.has(k) && groupOf(y) !== groupOf(x) && similar(x.word, y.word));
      if (j >= 0) { used.add(j); out.push(list[j]); }
    });
    return out;
  }

  /* 必做：到期、还没做过第一次复习（s=0）——新学的、生词本新加的、忘了从头再来的、之前拖下没做第一次复习的。
     这几种都只记了 1 天左右，拖一天损失最大：排最前、不占每天上限 */
  const isMust = (c, t) => isDue(c, t) && !(c.s > 0);
  /* 到期的词算哪一类（早上复习结束页按类型统计用，要在评分前定）：
     必做 → new 昨天学的（学习日 ≥ 昨天、没忘过）/ lapse 昨天忘的（学习日 ≥ 昨天、忘过）/ late 补第一次复习（学习日早于昨天）；
     其余 → over 拖过期 / due 今天到期；没到期的返回 null */
  function mustKind(c, t) {
    if (!isDue(c, t)) return null;
    if (!isMust(c, t)) return c.d < t ? "over" : "due";
    return c.a < add(t, -1) ? "late" : (c.l || 0) >= 1 ? "lapse" : "new";
  }
  /* 非必做的按计划间隔分段，间隔短的段在前（同样拖一天，间隔短的忘得多）：
     1 段 s=1（隔 3 天）；2 段 s=2，或 s≥3 且熟练度≤2（7～10 天）；3 / 4 / 5 段 s≥3 且熟练度 3 / 4 / 5（14 / 21 / 30 天）
     （2026-10-21 前的老卡 s=3 是「上上周的周日」那站，到期后照样按这里分段） */
  function band(c, opt = {}) {
    if (!(c.s > 1)) return 1;
    if (c.s === 2) return 2;
    const lv = level(c, opt);
    return lv <= 2 ? 2 : lv;
  }

  /* 本轮出题顺序：必做全部在前（熟练度低的先）；其余按 band 分段、间隔短的段在前，段内拖过的先、熟练度低的先；
     同一小段里，正式复习不到 3 次的按课本顺序（保留词群联想），3 次及以上的乱序、同词群不相邻、不同词群的形近词相邻 */
  function queue(items, t, seed = t, opt = {}) {   // opt.off：关掉的题型（熟练度按它算）
    const grp = x => `${x.card.k}|${x.card.g}`, off = {off: opt.off}, segs = new Map();
    for (const x of items) {
      const c = x.card;
      if (!isDue(c, t)) continue;
      const k = isMust(c, t) ? [0, 0, level(c, off)] : [band(c, off), c.d < t ? 0 : 1, level(c, off)];   // [段（0 = 必做）, 今天到期, 熟练度]
      const id = k.join("|");
      if (!segs.has(id)) segs.set(id, {k, list: []});
      segs.get(id).list.push(x);
    }
    const out = [];
    for (const {k, list} of [...segs.values()].sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2])) {
      out.push(...list.filter(x => reviews(x.card) < 3).sort((x, y) => (x.order || 0) - (y.order || 0)));
      out.push(...pairSimilar(shuffleSpread(list.filter(x => reviews(x.card) >= 3), grp, `${seed}|${k.join("|")}`), grp));
    }
    return out;
  }

  /* 今天的复习量分三档，线跟着每天上限走：easy ≤ 上限一半 照常学新 / busy ≤ 上限 学新最多 1 群 / heavy > 上限 不学新词。
     L = 今天的总复习量 = 现在还到期的（含必做）+ 今天已做的到期复习数，一天里基本不变 */
  const loadTier = (L, cap) => (L <= cap / 2 ? "easy" : L <= cap ? "busy" : "heavy");

  /* 积压预计第几天清完（今天 = 第 1 天）：从今天起逐天把当天到期的放进池子，必做当天全做，其余每天最多做 cap 个（今天只剩 left 个），
     池子清空那天是第几天；今天没有到期的返回 0。不算以后新学的词，也不算复习后重新排进来的 */
  function forecast(cards, t, cap, left = cap) {
    const list = cards.filter(c => c && c.d).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    if (!list.length || list[0].d > t) return 0;
    cap = Math.max(1, cap);
    let i = 0, rest = 0, d = t;
    for (let day = 1; day <= 3650; day++, d = add(d, 1)) {
      for (; i < list.length && list[i].d <= d; i++) if (!isMust(list[i], d)) rest++;
      rest -= Math.min(rest, day === 1 ? Math.max(0, left) : cap);
      if (!rest) return day;
    }
    return Infinity;
  }

  /* 请假顺延：学习日和到期日一起后移，整条路线不变 */
  const shift = (c, n) => ({...c, a: add(c.a, n), d: add(c.d, n)});

  /* 2026-11-02：统一每日计划。以下只选择任务，评分仍唯一走 rateRecall。
     所有队列共用张数和预计用时预算（补测预留最多五次）；计划当天固定，4 点换日。
     plan 是不可变词单；task 按学习日及 life 分键，保存首次与补测，不能靠日志总数重算完成。
     旧四选一不作校准证据；结构升级不改卡片、排期或业务时间。 */
  const recalled = c => !!c.z || !!c.recall?.result || !!c.recall?.history?.length;
  const needsCalibration = c => c.recall?.origin !== "new" && !recalled(c);
  const dailyAttempt = (day, life) => `daily:${day}:${life}:first`;
  const taskKey = (day, life) => `task:${day}:${encodeURIComponent(life)}`;
  function firstToday(c, day) {
    return c.recall?.history?.find(h => h.day === day) || null;
  }
  function migrationState(items, day, old) {
    const legacy = items.filter(x => x.card.recall?.origin !== "new");
    if (old?.v === 1 && ["active", "normal"].includes(old.mode) && Array.isArray(old.cohort)) {
      if (old.ended) return old; // 用户已经退出，后续零星旧词由统一调度吸收。
      const added = legacy.filter(x => !old.cohort.some(ref => ref.life === x.card.life));
      const mode = legacy.some(x => needsCalibration(x.card)) ? "active" : old.mode;
      if (!added.length && mode === old.mode) return old;
      return {...old, mode, cohort: [...old.cohort, ...added.map(x => ({word: x.word, life: x.card.life}))]};
    }
    const cohort = legacy.map(x => ({word: x.word, life: x.card.life}));
    return {v: 1, mode: legacy.some(x => needsCalibration(x.card)) ? "active" : "normal", started: day, cohort};
  }
  function migrationStatus(items, day, state, budget = 50) {
    const live = new Map(items.map(x => [x.card.life, x]));
    const cohort = (state?.cohort || []).map(x => live.get(x.life)).filter(Boolean);
    const remaining = cohort.filter(x => !recalled(x.card)).length;
    const lives = new Set(cohort.map(x => x.card.life));
    const recent = items.flatMap(x => (x.card.recall?.history || []).filter(h => h.due || lives.has(x.card.life)))
      .filter(h => h.day >= add(day, -6) && h.day <= day);
    const success = recent.filter(h => h.result === "independent" || h.result === "effort").length;
    const ratio = recent.length ? success / recent.length : 0;
    const load = items.filter(x => isDue(x.card, day) && !needsCalibration(x.card)).length;
    const calibrated = cohort.length - remaining, coverage = cohort.length ? calibrated / cohort.length : 1;
    const ready = !cohort.length || coverage >= .9 && recent.length >= Math.min(8, cohort.length) && ratio >= .7 && load <= budget;
    return {active: state?.mode === "active", total: cohort.length, calibrated, remaining, coverage, ratio, load, ready};
  }
  function dailyBudget(items, day, opt = {}) {
    const minutes = Math.max(5, Math.min(60, +opt.minutes || 20)), cap = Math.max(1, Math.min(200, +opt.cap || 50));
    const recent = items.flatMap(x => x.card.recall?.history || []).filter(h => h.day >= add(day, -6) && h.day <= day);
    const weak = recent.filter(h => h.result === "failed" || h.result === "hinted").length;
    const seconds = 20 + (recent.length ? Math.round(20 * weak / recent.length) : 0);
    const slots = Math.max(1, Math.floor(minutes * 60 / seconds));
    const retryLimit = Math.min(5, Math.floor(slots / 6));
    return {minutes, cap, seconds, retryLimit, limit: Math.min(cap, slots - retryLimit)};
  }
  function makeDailyPlan(items, day, opt = {}) {
    const budget = dailyBudget(items, day, opt), seen = new Set(), queues = {relearn: [], review: [], calibrate: []};
    for (const x of items) {
      const c = x.card;
      if (seen.has(x.word) || c.z && !isDue(c, day) || firstToday(c, day)) continue;
      seen.add(x.word);
      const kind = needsCalibration(c) ? "calibrate" : !isDue(c, day) ? "" : c.recall?.result === "failed" || c.recall?.result === "hinted" || c.r === "f" ? "relearn" : "review";
      if (kind) queues[kind].push({...x, kind});
    }
    const urgency = x => Math.max(0, diff(day, x.card.d)) / Math.max(1, stationGap(Math.max(1, x.card.s), level(x.card))) + (x.kind === "relearn" ? 3 : x.kind === "review" ? 2 : 1);
    for (const q of Object.values(queues)) q.sort((a, b) => urgency(b) - urgency(a) || (a.order || 0) - (b.order || 0) || a.word.localeCompare(b.word));
    const credited = Math.max(0, Math.floor(+opt.credited || 0)), selected = [], used = {relearn: 0, review: 0, calibrate: 0};
    const available = Object.values(queues).reduce((n, q) => n + q.length, 0);
    // 按各队列的紧迫度动态分配；空队列立即让出容量，不设必须凑齐的固定比例。
    while (selected.length < Math.max(0, budget.limit - credited)) {
      const kind = Object.keys(queues).filter(k => queues[k].length).sort((a, b) => urgency(queues[b][0]) / (used[b] + 1) - urgency(queues[a][0]) / (used[a] + 1))[0];
      if (!kind) break;
      const x = queues[kind].shift(); used[kind]++;
      selected.push({word: x.word, life: x.card.life, kind});
    }
    return {v: 1, d: day, id: opt.id || day, created: opt.created || 0, budget, credited, available, items: selected};
  }
  function dailyStatus(plan, items, records = {}) {
    const live = new Map(items.map(x => [x.word, x])), rows = (plan?.items || []).map(ref => {
      const x = live.get(ref.word), retired = !x || x.card.life !== ref.life;
      const record = records[ref.life]?.first ? records[ref.life] : !retired && firstToday(x.card, plan.d) ? {first: firstToday(x.card, plan.d)} : {};
      return {...ref, x: retired ? null : x, record, done: retired || !!record.first, pendingRetry: !retired && !!record.retryWanted && !record.retry};
    });
    // 离线设备可能已完成另一份词单：这些真实主任务抵扣本计划，不能在同步后再加一轮。
    const plannedLives = new Set(rows.map(row => row.life));
    const external = Object.entries(records).filter(([life, r]) => !plannedLives.has(life) && r.first?.planned && r.d === plan?.d)
      .map(([life, record]) => {
        const x = live.get(record.word), valid = x?.card.life === life;
        return {word: record.word, life, kind: record.first.kind || "review", x: valid ? x : null, record, done: true, external: true};
      });
    let credit = external.length;
    for (const row of rows.slice().reverse()) if (credit && !row.done) { row.done = true; row.waived = true; row.x = null; credit--; }
    rows.push(...external);
    const reserved = rows.filter(x => x.record.retryWanted && ["failed", "hinted"].includes(x.record.first?.result))
      .sort((a, b) => (a.record.first.at || 0) - (b.record.first.at || 0) || a.word.localeCompare(b.word)).slice(0, plan?.budget?.retryLimit ?? 5);
    for (const row of rows) {
      row.record = {...row.record, retryWanted: reserved.includes(row)};
      row.pendingRetry = !!row.x && row.record.retryWanted && !row.record.retry;
    }
    const total = (plan?.items.length || 0) + (plan?.credited || 0);
    const actual = rows.filter(x => x.done && !x.waived).length + (plan?.credited || 0), completed = Math.min(total, actual);
    const retries = rows.filter(x => x.record.retry).length, pendingRetries = rows.filter(x => x.pendingRetry).length;
    return {rows, completed, total, retries, pendingRetries, todo: rows.filter(x => !x.done || x.pendingRetry).length,
      finished: completed === total && !pendingRetries, workload: actual + retries};
  }
  /* 只有新计划键使用不可变首份规则；完成键合并首次和补测，避免旧断点覆盖新完成。
     其他键继续原逐键取新协议，墓碑仍取较新值；导入覆盖仍可显式替换。 */
  function mergeStudyRecord(key, a, b) {
    if (!a) return b;
    if (!b) return a;
    const newer = a[1] > b[1] || a[1] === b[1] && JSON.stringify(a[0]) > JSON.stringify(b[0]);
    if (!a[0] || !b[0]) return newer ? a : b;
    if (/^(plan|task):/.test(key) && (a[0].reset || 0) !== (b[0].reset || 0)) return (a[0].reset || 0) > (b[0].reset || 0) ? a : b;
    if (key.startsWith("plan:") && a[0].v === 1 && b[0].v === 1) {
      const rank = p => `${String(p.created || 0).padStart(16, "0")}|${p.id}|${JSON.stringify(p)}`;
      return rank(a[0]) <= rank(b[0]) ? a : b;
    }
    if (key.startsWith("task:") && a[0].life === b[0].life) {
      const pick = (x, y) => !x ? y : !y ? x : (x.at || 0) < (y.at || 0) || (x.at || 0) === (y.at || 0) && JSON.stringify(x) <= JSON.stringify(y) ? x : y;
      const base = newer ? a[0] : b[0], first = pick(a[0].first, b[0].first), retry = pick(a[0].retry, b[0].retry);
      return [{...base, first, ...(retry ? {retry} : {}), retryWanted: ["failed", "hinted"].includes(first?.result) && !!(a[0].retryWanted || b[0].retryWanted)}, Math.max(a[1], b[1])];
    }
    return newer ? a : b;
  }

  return {EXAM, TYPE, today, reviews, add, diff, dow, monday, stationGap, spread, stationDue, examCap, newCard, isDue,
    rate, rateRecall, rateSkill, recallResult, recallGrade, legacyLevel, upgradeCard, upgradeDoc, freshCard, chop, isHard, dueList, isPhrase, level, streak, pickType, gradeChoice, gradeSpell, editDist, similar, senseKeys, posSet, distractorTag, confAdd, confDrop, shuffleSpread, pairSimilar,
    isMust, mustKind, band, queue, loadTier, forecast, shift,
    recalled, needsCalibration, dailyAttempt, taskKey, firstToday, migrationState, migrationStatus, dailyBudget, makeDailyPlan, dailyStatus, mergeStudyRecord};
})();
if (typeof module === "object" && module.exports) module.exports = SRS;
