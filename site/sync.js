/* 云同步：进度存在自己 GitHub 账号的一个 Secret Gist 里，不需要服务器。
   本地优先：先写本机，再在后台推送；打开页面、切回页面时拉取合并。
   每个键存 [值, 修改时间]，合并时按键取较新的一份，两台设备各改各的也不会互相覆盖。
   plan: 当日词单取首份，task: 合并不可变首次与补测（显式备份覆盖用恢复批次优先）；其他键沿用取新。
   dump() / load(pairs) 给导出 / 导入备份用（规则在 backup.js）：dump 返回全部进度的拷贝，load 按给定的时间一次写入一批；
   云同步 token（cfg）不经过这两个函数 */
"use strict";
const Sync = (() => {
  const P = "lx:sync:", FILE = "cet4-progress.json", API = "https://api.github.com";
  const DELAY = 3000, LAZY_DELAY = 20000, MIN_GAP = 10000;   // GitHub 限制创建内容的频率，两次写入至少隔 10 秒
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /* 旧版只存在本机的数据，第一次运行时搬进来，时间记 0（任何一端改过的都比它新） */
  function migrate() {
    const d = {};
    for (const w of ls.get("lx:known", [])) d["known:" + w] = [1, 0];
    for (const [k, v] of Object.entries(ls.get("lx:settings", {}))) d["set:" + k] = [v, 0];
    const last = ls.get("lx:last", null); if (last) d.last = [last, 0];
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith("lx:lw:")) d[k.slice(3)] = [ls.get(k), 0]; } } catch {}
    return d;
  }
  let doc = ls.get(P + "doc", null);
  if (!doc) { doc = migrate(); ls.set(P + "doc", doc); }
  const upgrade = d => typeof SRS !== "undefined" ? SRS.upgradeDoc(d) : d;
  doc = upgrade(doc);                              // 兼容升级不改变原修改时间，不能用本机迁移时间压过云端成果
  ls.set(P + "doc", doc);
  const save = () => ls.set(P + "doc", doc);

  let cfg = ls.get(P + "cfg", null);   // {token, gist}，只存本机，不同步
  const status = {state: cfg ? "idle" : "off", msg: "", at: ls.get(P + "at", 0)};
  const changeFns = [], statusFns = [];
  const setStatus = (state, msg = "") => { status.state = state; status.msg = msg; statusFns.forEach(f => f(status)); };

  /* ---------- 本地读写 ---------- */
  function get(k, d) { return k in doc ? doc[k][0] : d; }
  function set(k, v, lazy) {
    if (k in doc && same(doc[k][0], v)) return;
    doc[k] = [v, Date.now()]; doc = upgrade(doc); save();
    schedule(lazy ? LAZY_DELAY : DELAY);
  }
  /* 一次写一批（比如记录一个词群的几十个词），只存一次本地、只排一次推送 */
  function setMany(pairs) {
    const t = Date.now(); let n = 0;
    for (const [k, v] of pairs) { if (k in doc && same(doc[k][0], v)) continue; doc[k] = [v, t]; n++; }
    if (n) { doc = upgrade(doc); save(); schedule(DELAY); }
  }
  /* 导出：全部进度的深拷贝（不含 token） */
  const dump = () => JSON.parse(JSON.stringify(doc));
  /* 导入：一次写入 [键, [值, 时间]]，保留给定的时间；值变了的键通知 on(changed)，只存一次本地、只排一次推送；返回写入条数 */
  function load(pairs) {
    const changed = []; let n = 0;
    for (const [k, p] of pairs) {
      const l = doc[k];
      if (l && same(l, p)) continue;
      if (!l || !same(l[0], p[0])) changed.push(k);
      doc[k] = [p[0], p[1]]; n++;
    }
    if (!n) return 0;
    doc = upgrade(doc); save();
    if (changed.length) changeFns.forEach(f => f(changed));
    schedule(DELAY);
    return n;
  }
  const entries = prefix => Object.keys(doc).filter(k => k.startsWith(prefix)).map(k => [k.slice(prefix.length), doc[k][0]]);

  /* ---------- 合并：按键取较新的；时间相同按值排序，保证各端结果一致 ---------- */
  const newer = (a, b) => a[1] > b[1] || (a[1] === b[1] && JSON.stringify(a[0]) > JSON.stringify(b[0]));
  function merge(remote) {
    remote = upgrade(remote);
    const changed = [];
    for (const [k, r] of Object.entries(remote)) {
      const l = doc[k];
      const merged = typeof SRS !== "undefined" ? SRS.mergeStudyRecord(k, l, r) : !l || newer(r, l) ? r : l;
      if (l && same(l, merged)) continue;
      if (!l || !same(l[0], merged[0])) changed.push(k);
      doc[k] = merged;
    }
    doc = upgrade(doc);
    return changed;
  }
  const differs = remote => Object.keys(doc).some(k => !remote[k] || !same(remote[k], doc[k]));

  /* ---------- GitHub 接口 ---------- */
  async function api(path, opt = {}) {
    const r = await fetch(API + path, {...opt, cache: "no-store", headers: {
      Accept: "application/vnd.github+json", Authorization: "Bearer " + cfg.token,
      ...(opt.body ? {"Content-Type": "application/json"} : {})}});
    if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
    return r.json();
  }
  const errText = e =>
    e.status === 401 ? "token 无效或已过期，请重新粘贴" :
    e.status === 403 || e.status === 404 ? "token 没有 Gist 读写权限" :
    e.status === 422 ? "GitHub 拒绝了这次写入" :
    e.status === 429 || (e.status >= 500) ? "GitHub 暂时不可用，稍后自动重试" :
    e.status ? "同步失败（" + e.message + "）" : "网络不通，联网后自动重试";

  /* 在账号里找进度 Gist，没有就新建一个 Secret Gist */
  async function locate() {
    for (let page = 1; page <= 10; page++) {
      const list = await api(`/gists?per_page=100&page=${page}`);
      const g = list.find(g => g.files && g.files[FILE]);
      if (g) return g.id;
      if (list.length < 100) break;
    }
    const g = await api("/gists", {method: "POST", body: JSON.stringify({
      description: "四级词汇课件 · 学习进度（自动同步，请勿手改）", public: false,
      files: {[FILE]: {content: JSON.stringify({v: 1, d: {}})}}})});
    return g.id;
  }
  async function readRemote() {
    let g;
    try { g = await api("/gists/" + cfg.gist); }
    catch (e) { if (e.status !== 404) throw e; cfg.gist = await locate(); ls.set(P + "cfg", cfg); g = await api("/gists/" + cfg.gist); }   // Gist 被删了：重新找或新建
    const f = g.files[FILE];
    if (!f) return {};
    const text = f.truncated ? await fetch(f.raw_url, {cache: "no-store"}).then(r => r.text()) : f.content;
    try { return JSON.parse(text).d || {}; } catch { return {}; }
  }
  let lastWrite = 0;
  async function write() {
    lastWrite = Date.now();
    await api("/gists/" + cfg.gist, {method: "PATCH", body: JSON.stringify({files: {[FILE]: {content: JSON.stringify({v: 1, d: doc})}}})});
  }

  /* ---------- 同步：拉取 → 合并 → 有差异才推送；同一时间只跑一个 ---------- */
  let running = null, again = false;
  function sync() {
    if (!cfg) return Promise.resolve();
    if (running) { again = true; return running; }
    running = (async () => {
      setStatus("syncing");
      try {
        const remote = await readRemote();
        const changed = merge(remote);
        if (changed.length) { save(); changeFns.forEach(f => f(changed)); }
        if (differs(remote)) await write();
        status.at = Date.now(); ls.set(P + "at", status.at);
        setStatus("ok");
      } catch (e) { setStatus("error", errText(e)); }
    })().finally(() => { running = null; if (again) { again = false; sync(); } });
    return running;
  }
  let timer = null, due = Infinity;
  function schedule(delay) {
    if (!cfg) return;
    const at = Math.max(Date.now() + delay, lastWrite + MIN_GAP);
    if (timer && at >= due) return;
    clearTimeout(timer); due = at;
    timer = setTimeout(() => { timer = null; due = Infinity; sync(); }, at - Date.now());
  }
  const now = () => { clearTimeout(timer); timer = null; due = Infinity; return sync(); };

  /* 切回页面、联网时拉取；切走页面时把没推的推出去 */
  let started = false;
  function start() {
    if (!started) {
      started = true;
      document.addEventListener("visibilitychange", () => { if (cfg) now(); });
      addEventListener("online", () => { if (cfg) now(); });
    }
    return now();
  }

  /* ---------- 连接 / 断开 ---------- */
  async function connect(token) {
    const prev = cfg;
    cfg = {token: token.trim()};
    try { cfg.gist = await locate(); }
    catch (e) { cfg = prev; throw new Error(errText(e)); }
    ls.set(P + "cfg", cfg);
    await start();
    if (status.state === "error") throw new Error(status.msg);
  }
  function disconnect() { cfg = null; clearTimeout(timer); timer = null; ls.del(P + "cfg"); setStatus("off"); }

  return {
    get, set, setMany, entries, dump, load, start, connect, disconnect, syncNow: now,
    on: f => changeFns.push(f), onStatus: f => statusFns.push(f),
    get status() { return status; }, get connected() { return !!cfg; },
  };
})();
