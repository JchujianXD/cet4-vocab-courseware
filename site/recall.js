/* 主动回忆任务状态（纯函数）。只管理提示、首次表现、有限补测与晚间任务，不计算排期。
   卡片规则在 srs.js；所有持久化由 study.js 通过 Sync 批量提交。 */
"use strict";
const Recall = (() => {
  const copy = s => JSON.parse(JSON.stringify(s));
  const independent = r => r === "independent" || r === "effort";
  function create(items, day, id, old) {
    const refs = Object.fromEntries(items.map(x => [x.word, x.card?.life || ""]));
    if (old?.v === 2 && old.d === day) {
      const s = copy(old), valid = w => w in refs && refs[w] === old.refs[w];
      s.w = s.w.filter(valid); s.refs = Object.fromEntries(s.w.map(w => [w, refs[w]]));
      s.queue = s.queue.filter(q => valid(q.w));
      s.first = Object.fromEntries(Object.entries(s.first).filter(([w]) => valid(w)));
      s.retry = Object.fromEntries(Object.entries(s.retry).filter(([w]) => valid(w)));
      if (s.current && !valid(s.current.w)) s.current = null;
      for (const x of items) if (!(x.word in s.refs)) { s.w.push(x.word); s.refs[x.word] = refs[x.word]; s.queue.push({w: x.word, retry: false}); }
      return begin(s);
    }
    const s = {v: 2, d: day, id, w: items.map(x => x.word), refs, first: {}, retry: {}, added: 0, queue: [], current: null};
    for (const x of items) {
      const r = old?.rated?.[x.word];
      if (r) s.first[x.word] = {result: "legacy", grade: r, hints: []};
      if (!old?.done?.includes(x.word)) {
        if (r) { if (s.added < 5) { s.added++; s.queue.push({w: x.word, retry: true}); } }
        else s.queue.push({w: x.word, retry: false});
      }
    }
    return begin(s);
  }
  function begin(s) {
    if (!s.current && s.queue.length) s.current = {...s.queue[0], hints: [], layer: 0, revealed: false};
    return s;
  }
  function hint(state, kind) {
    const s = copy(state), q = s.current;
    if (!q || q.answered) return s;
    if (!q.hints.includes(kind)) q.hints.push(kind);
    return s;
  }
  function answer(state, result) {
    const s = copy(state), q = s.current;
    if (!q || q.answered || !q.revealed) return s;
    if (q.hints.length && independent(result)) result = "hinted";
    if (q.choiceWrong) result = "failed";
    const record = {result, hints: q.hints.slice()};
    if (q.retry) s.retry[q.w] = record;
    else {
      s.first[q.w] = record;
      if (!independent(result) && s.added < (s.retryLimit ?? 5)) {
        s.added++;
        s.queue.splice(Math.min(s.queue.length, 4), 0, {w: q.w, retry: true});
      }
    }
    q.answered = result;
    return s;
  }
  function next(state) {
    const s = copy(state);
    if (s.current?.answered) { s.queue.shift(); s.current = null; }
    return begin(s);
  }
  function summary(s) {
    const counts = {independent: 0, effort: 0, hinted: 0, failed: 0, legacy: 0, chopped: 0};
    for (const r of Object.values(s.first)) counts[r.result]++;
    const difficult = s.w.filter(w => ["hinted", "failed"].includes(s.first[w]?.result) || s.first[w]?.result === "legacy" && s.first[w].grade !== "g");
    return {...counts, total: s.w.length, completed: Object.keys(s.first).length, retries: Object.keys(s.retry).length,
      retrySuccess: Object.values(s.retry).filter(r => independent(r.result)).length,
      retryHinted: Object.values(s.retry).filter(r => r.result === "hinted").length,
      retryFailed: Object.values(s.retry).filter(r => r.result === "failed").length,
      strengthen: difficult.filter(w => !independent(s.retry[w]?.result)), finished: !s.queue.length};
  }
  function nightStats(items, record) {
    const done = items.filter(x => record?.items?.[x.card.life]);
    return {total: items.length, done: done.length, pending: items.length - done.length,
      finished: !!items.length && done.length === items.length && !!record?.finished && !record?.skipped,
      skipped: !!record?.skipped};
  }
  /* 当日分词完成记录比断点更可靠：补回同步/导入后的成绩，不重放正式评分。
     保留尚未作答的当前题（含提示和揭晓），已完成的补测不能被旧断点复活。 */
  function restoreDaily(state, records) {
    const s = copy(state);
    for (const w of s.w) {
      const r = records[w]; if (!r?.first) continue;
      s.first[w] = {result: r.first.result, hints: r.first.hints || []};
      s.queue = s.queue.filter(q => q.w !== w || q.retry && r.retryWanted && !r.retry);
      if (r.retry) s.retry[w] = {result: r.retry.result};
      else if (r.retryWanted && !s.queue.some(q => q.w === w && q.retry)) s.queue.push({w, retry: true});
    }
    if (s.current && (!s.queue[0] || s.current.w !== s.queue[0].w || s.current.retry !== s.queue[0].retry || s.current.answered)) s.current = null;
    return begin(s);
  }
  function snapshot(s, mk) {
    return {d: s.d, w: s.w.slice(), done: Object.keys(s.first), rated: {}, rc: copy(s), ...(mk ? {mk: {...mk}} : {})};
  }
  /* 导入/同步后的断点，只恢复当日且卡片生命周期仍匹配的词。新学按词群检查。 */
  function validProgress(v, doc, day) {
    if (!v || v.d !== day) return 0;
    if (v.g) {
      const gs = [].concat(v.g).filter(g => !doc["learn:" + g]?.[0]);
      return gs.length ? {...v, g: Array.isArray(v.g) ? gs : gs[0]} : 0;
    }
    const valid = w => {
      if (doc["known:" + w]?.[0]) return false;
      const c = doc["srs:" + w]?.[0] || doc["vocab:" + w]?.[0];
      return !!c && (!v.rc?.refs?.[w] || c.life === v.rc.refs[w]);
    };
    if (!v.w) return v;                            // 最早的断点无词单，恢复时由当前有效范围解析
    const w = v.w.filter(valid);
    if (!w.length) return 0;
    const result = {...v, w, done: (v.done || []).filter(valid), rated: Object.fromEntries(Object.entries(v.rated || {}).filter(([w]) => valid(w)))};
    if (v.rc) result.rc = create(w.map(word => ({word, card: doc["srs:" + word]?.[0] || doc["vocab:" + word]?.[0]})), day, v.rc.id, v.rc);
    return result;
  }
  return {create, begin, hint, answer, next, summary, nightStats, restoreDaily, snapshot, validProgress, independent};
})();
if (typeof module === "object" && module.exports) module.exports = Recall;
