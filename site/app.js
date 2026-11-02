/* 四级词汇课件：数据全部来自 data/，本文件只负责渲染和交互 */
"use strict";
const $ = s => document.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));

/* ---------- 存储：读写都走 sync.js（本机优先，连上 GitHub 后自动多端同步） ---------- */
const store = {get: Sync.get, set: Sync.set};
const known = new Set();
function loadKnown() { known.clear(); for (const [w, on] of Sync.entries("known:")) if (on) known.add(w); }
const setKnown = (w, on) => { on ? known.add(w) : known.delete(w); Sync.set("known:" + w, on ? 1 : 0); };
loadKnown();

/* ---------- 设置：集中存放，设置页修改，全站生效 ---------- */
const VOICE_NAMES = {ava: "Ava", andrew: "Andrew", sonia: "Sonia", ryan: "Ryan"};
const VOICE_DESC = {ava: "美式 · 女声", andrew: "美式 · 男声", sonia: "英式 · 女声", ryan: "英式 · 男声"};
const DEFAULTS = {voice: "ava", rate: 1, mask: false, hideKnown: false, scope: "group", withZh: true, loop: false, theme: "auto",
  examDate: "2026-12-12", dailyCap: 50, dailyMinutes: 20, autoSay: true, drillOrder: "course", drillMode: "quiz", phLine: true, videoPrefer: "精讲带背", videoWebfull: true,
  /* 学习新词、复习（study.js 用，默认值 = 加设置之前的行为）：learnStages 每个新词过几关（1 看词选义 / 2 + 听音选义 / 3 + 拼写）；
     learnSize 一次学多少（1 / 2 群，15 = 至少 15 词）；autoEx 学新词词卡读完单词接着读例句；autoNext 答对（记得）后 1.5 秒自动下一题；
     slowMode 想得久算模糊（loose ×1.5 / std / strict ×0.75 / off 不按时间）；quizListen、quizSpell 出不出听音、拼写题；roundSize 今天到期每轮最多几个（0 = 不限） */
  learnStages: 2, learnSize: 1, autoEx: false, autoNext: false, slowMode: "std", quizListen: true, quizSpell: true, roundSize: 25, practiceType: "meaning"};
const NUM_SETS = ["rate", "dailyCap", "dailyMinutes", "learnStages", "learnSize", "roundSize"];   // 设置页按钮上的值是字符串，这几个存成数字
const S = {...DEFAULTS};
const loadSettings = () => Object.assign(S, DEFAULTS, Object.fromEntries(Sync.entries("set:")));
function setS(k, v) {
  S[k] = v; Sync.set("set:" + k, v); applySettings();
  if (k === "videoPrefer" && L) renderLesson();   // 视频按钮按偏好重画（复习页每次进入都会重画）
  if (k === "videoWebfull") $$("a[data-vi], a.vpout").forEach(a => { a.href = Video.webfull(a.href, v); });
}
loadSettings();
const darkMQ = matchMedia("(prefers-color-scheme: dark)");
function applySettings() {
  document.body.classList.toggle("mask", S.mask);
  document.body.classList.toggle("hideKnown", S.hideKnown);
  document.body.classList.toggle("noPhLine", !S.phLine);   // 例句词组下划线（点词组照样能查）
  if (S.theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = S.theme;
  /* 组件库 Web Awesome 的深浅色跟着本站主题走 */
  document.documentElement.classList.toggle("wa-dark", S.theme === "dark" || (S.theme === "auto" && darkMQ.matches));
  $("#maskFab").classList.toggle("on", S.mask);
}
darkMQ.addEventListener("change", applySettings);

/* ---------- 状态 ---------- */
let BOOK = null, L = null, GLOSS = {}, NOTES = {sents: {}}, AUD = {w: {}, s: {}, z: {}, voices: []};   // NOTES：例句词组与语法解析（书外补充）
let VIDEO = null;   // 本课的讲解视频跳转数据（data/video，规则见 video.js），没有这一课的数据就是 null
const WORDMAP = new Map();   // 本课词条/扩展词 → {word, senses, no, ext}
/* no-cache：每次向服务器确认，重新生成数据后不会读到旧缓存 */
const fetchJSON = url => fetch(url, {cache: "no-cache"}).then(r => { if (!r.ok) throw new Error(url + " " + r.status); return r.json(); });

/* ---------- 文本工具 ---------- */
const meanHTML = m => esc(m).replace(/\[\[(.+?)\]\]/g, "<u>$1</u>");
const plainMean = m => m.replace(/\[\[|\]\]/g, "");
const sensesText = ss => ss.map(s => `${s.pos} ${plainMean(s.mean)}`).join("　");

const lemmaCandidates = Vocab.candidates;   // 词形变化的候选原形（vocab.js）
const findWord = (w, map = WORDMAP) => { for (const k of lemmaCandidates(w.toLowerCase())) if (map.has(k)) return map.get(k); return null; };

/* 例句切成可点的单词，重点词（可能是多词短语）加 key 样式；note = 这句的 notes（词组标注、语法解析），见 sent.js */
const sentenceHTML = (en, keys, note, hi) => Sent.html(en, keys, note, hi);
const noteOf = (notes, en) => (notes && notes.sents && notes.sents[en]) || null;

/* ---------- 讲解视频按钮：课文页词头、复习卡背面、列表页共用 ----------
   data = 这一课的视频数据，no = 词条号（video.js 的 noOf 取）；这个词没有可用的视频就返回空串，调用的地方不用判断。
   一个和 🔊 一样的圆形播放图标，点了在页面里播第一个可用的视频（openVideo），别的视频在播放窗里换；
   时间点是推算的（approx，可能差几秒）按钮长得一样，只在悬停提示和播放窗下拉框里标「约」。sm = 列表页小一号；word = 播放窗标题上显示的词。
   链接本身仍是 B 站地址：Ctrl / Shift / 中键点照旧在新标签页打开 */
const PLAY_ICON = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 1.2v9.6L10.5 6z"/></svg>';
function videoHTML(data, no, sm, word = "") {
  const vs = Video.options(data, no, S.videoPrefer);
  if (!vs.length) return "";
  const v = vs[0], tip = `看老师讲解${v.approx ? "（时间点是推算的，可能差几秒）" : ""} · ${v.label}${vs.length > 1 ? `，播放窗里可换另外 ${vs.length - 1} 个视频` : ""}`;
  return `<a class="vbtn${sm ? " sm" : ""}" href="${esc(Video.webfull(v.url, S.videoWebfull))}" target="_blank" rel="noopener" data-vi="0" data-vs="${esc(JSON.stringify(vs))}" data-vw="${esc(word)}" title="${esc(tip)}" aria-label="讲解视频">${PLAY_ICON}</a>`;
}

/* ---------- 讲解视频页内播放：B 站嵌入播放器，电脑上是画中画式浮窗，手机贴在底部；不离开页面，看完 ✕ 掉接着背 ----------
   没登录 B 站时嵌入播放器只有 360p，窗口里留一个「B 站 ↗」去 B 站看高清 */
let vp = null;   // 播放窗，没开时是 null
/* 电脑端浮窗的 iframe 加 sandbox 且不给 allow-popups：B 站外链播放器点画面默认「开 B 站 + 暂停」，拦掉 window.open 后只剩暂停。
   手机端不加（手机上贴底播放器行为不同，且视频只改电脑端）。副作用：播放器里的「进入哔哩哔哩」、推荐视频等链接点不动 */
const SANDBOX = ' sandbox="allow-scripts allow-same-origin allow-presentation"';
function openVideo(vs, i, word) {
  const v = vs[i];
  if (!v) return;
  stopAll();   // 课件自己的朗读先停，免得两边一起出声
  const fresh = !vp;
  if (fresh) { vp = document.createElement("div"); vp.id = "vplayer"; document.body.append(vp); }
  vp.innerHTML = `<div class="vphead" title="拖动移动，双击恢复默认大小和位置"><b>${esc(word)}</b>
      <select class="vpsel" title="换个视频看">${vs.map((o, j) => `<option value="${j}"${j === i ? " selected" : ""}>${esc(o.label)}${o.approx ? "（约）" : ""}</option>`).join("")}</select>
      <a class="vpout" href="${esc(Video.webfull(v.url, S.videoWebfull))}" target="_blank" rel="noopener" title="${vpNarrow() ? "去 B 站看（登录后能看高清）" : "在 B 站分屏标签里看（登录后能看高清），同时关掉这个浮窗"}">B 站 ↗</a>
      <button class="vpx" title="关闭（Esc）">✕</button></div>
    <div class="vpbox"><iframe src="${esc(Video.embed(v))}"${vpNarrow() ? "" : SANDBOX} allow="autoplay; fullscreen; picture-in-picture" allowfullscreen scrolling="no"></iframe></div>
    ${["nw", "ne", "sw", "se"].map(c => `<i class="vpr" data-c="${c}" title="拖动缩放"></i>`).join("")}`;
  vp._vs = vs; vp._w = word;
  if (fresh) vpPlace(store.get("vpGeo", null));
  document.body.classList.add("vp-open");
}

/* 播放窗的位置和大小（只在电脑上，手机交给 CSS 贴底）：拖标题栏移动，拖四个角缩放，画面保持 16:9；
   整个窗口始终留在屏幕里，宽 280～1100px。g = {r, b, w}：离右边、下边的距离和宽度——按右下角记，
   换个屏幕大小也还在原来那个角落。拖完记下来（vpGeo，走 Sync 同步），下次打开还在那儿；双击标题栏恢复默认 */
const VP_MIN = 280, VP_MAX = 1100, VP_DEF = {r: 16, b: 16, w: 460};
const vpNarrow = () => matchMedia("(max-width:600px)").matches;
const vpHead = () => vp.querySelector(".vphead").offsetHeight + 2;   // 标题栏 + 上下边框
function vpPlace(g) {
  if (!vp) return;
  if (vpNarrow()) { vp.style.cssText = ""; vp._g = null; return; }
  g = g || VP_DEF;
  const W = document.documentElement.clientWidth, H = document.documentElement.clientHeight, hd = vpHead();   // 不含滚动条
  const w = Math.round(Math.max(VP_MIN, Math.min(g.w, VP_MAX, W, (H - hd) * 16 / 9)));
  const h = Math.round(w * 9 / 16) + hd;
  const r = Math.round(Math.max(0, Math.min(g.r, W - w))), b = Math.round(Math.max(0, Math.min(g.b, H - h)));
  Object.assign(vp.style, {width: w + "px", right: r + "px", bottom: b + "px"});
  vp._g = {r, b, w};
}
addEventListener("resize", () => vp && vpPlace(vp._g || store.get("vpGeo", null)));
document.addEventListener("pointerdown", e => {
  if (!vp || e.button || vpNarrow() || !vp.contains(e.target)) return;
  const corner = e.target.closest(".vpr");
  if (!corner && (!e.target.closest(".vphead") || e.target.closest("select, a, button"))) return;
  e.preventDefault();
  const g0 = {...vp._g}, x0 = e.clientX, y0 = e.clientY, W = document.documentElement.clientWidth, H = document.documentElement.clientHeight, hd = vpHead();
  const left0 = W - g0.r - g0.w, top0 = H - g0.b - (Math.round(g0.w * 9 / 16) + hd);
  const c = corner && corner.dataset.c, sx = c && c.includes("e") ? 1 : -1, sy = c && c.includes("s") ? 1 : -1;
  const el = corner || e.target.closest(".vphead");
  el.setPointerCapture(e.pointerId);
  document.body.classList.add("vp-drag");   // 拖的时候播放器的 iframe 不接鼠标，不然一进画面就拖不动了
  const move = ev => {
    const dx = ev.clientX - x0, dy = ev.clientY - y0;
    if (!c) { vpPlace({w: g0.w, r: g0.r - dx, b: g0.b - dy}); return; }
    /* 缩放：对角固定不动，哪个方向拖得多就按哪个方向算宽度 */
    const dw = Math.abs(dx) >= Math.abs(dy) * 16 / 9 ? sx * dx : sy * dy * 16 / 9;
    const maxW = Math.min(sx > 0 ? W - left0 : W - g0.r, ((sy > 0 ? H - top0 : H - g0.b) - hd) * 16 / 9);
    const w = Math.max(VP_MIN, Math.min(g0.w + dw, maxW, VP_MAX)), h = Math.round(w * 9 / 16) + hd;
    vpPlace({w, r: sx > 0 ? W - left0 - w : g0.r, b: sy > 0 ? H - top0 - h : g0.b});
  };
  const up = () => {
    el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up);
    document.body.classList.remove("vp-drag");
    if (vp && vp._g) store.set("vpGeo", vp._g, true);
  };
  el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
});
document.addEventListener("dblclick", e => {
  if (!vp || vpNarrow() || !e.target.closest || !e.target.closest(".vphead") || e.target.closest("select, a, button")) return;
  vpPlace(VP_DEF); store.set("vpGeo", vp._g, true);
});
function closeVideo() { if (vp) { vp.remove(); vp = null; } document.body.classList.remove("vp-open"); }

/* ---------- B 站分屏标签（只电脑端，说明见 docs/plans/2026-10-19-video-split.md）----------
   用固定窗口名 cet4-bili 在普通新标签里开 B 站视频页（不加 noopener，才拿得到引用），用户自己把标签拖成左右分屏。
   分屏状态下所有 ▶ 都 window.open(url, 同一个名字)，让那个标签重新加载跳过去；标签被关掉就自动退出，这一下照旧开浮窗。
   状态只在当前页面内存里，刷新后再点一次「B站」按钮，同名窗口会被接管，不会多开 */
const SPLIT_NAME = "cet4-bili";
let splitWin = null;   // 分屏状态：分屏标签的引用，没在分屏是 null
function splitSet(w) { splitWin = w; $("#splitFab").classList.toggle("on", !!w); }
/* 分屏状态是否有效（只电脑端）；标签已被关掉就退出分屏 */
function splitCheck() {
  if (!splitWin) return false;
  if (vpNarrow() || splitWin.closed) { splitSet(null); return false; }
  return true;
}
function splitGo(v) {
  if (!v) return false;
  const w = window.open(Video.webfull(v.url, S.videoWebfull), SPLIT_NAME);
  if (!w) return false;   // 被浏览器拦了
  splitSet(w); closeVideo();
  return true;
}
$("#splitFab").onclick = () => {
  if (splitCheck()) { splitSet(null); return; }   // 再点一次退出分屏状态，B 站标签不关
  const sec = L && currentGroup(), card = sec && readingCard(sec), a = card && card.querySelector("a[data-vi]");
  if (!a) { toast("这个词没有可用的讲解视频"); return; }
  if (!splitGo(JSON.parse(a.dataset.vs)[0])) toast("浏览器拦住了新标签页，请允许本站弹出窗口");
};
document.addEventListener("click", e => {
  const t = e.target; if (!t.closest) return;
  const a = t.closest("a[data-vi]");
  if (a) {
    if (e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;   // 想在新标签页开的照旧
    const host = a.closest("[data-vs]");
    e.preventDefault(); e.stopPropagation();   // 也不让复习卡、列表行的点击处理收到
    if (splitCheck()) { splitGo(JSON.parse(host.dataset.vs)[+a.dataset.vi]); return; }   // 分屏状态：让右边的标签跳过去，不开浮窗
    openVideo(JSON.parse(host.dataset.vs), +a.dataset.vi, host.dataset.vw);
    return;
  }
  if (vp && t.closest(".vpx")) closeVideo();
  /* 电脑端浮窗标题栏的「B 站 ↗」：改在分屏标签里开同一个视频和秒数，并关掉浮窗 */
  if (vp && !vpNarrow() && t.closest(".vpout") && !(e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)) {
    e.preventDefault();
    const v = vp._vs[+vp.querySelector(".vpsel").value];
    if (!splitGo(v)) window.open(Video.webfull(v.url, S.videoWebfull), "_blank");   // 分屏标签被拦就退回普通新标签
  }
}, true);
document.addEventListener("change", e => { if (vp && e.target.classList.contains("vpsel")) openVideo(vp._vs, +e.target.value, vp._w); });
/* Esc 先关播放窗（在捕获阶段截住，复习页的 Esc 不会同时触发） */
addEventListener("keydown", e => { if (e.key === "Escape" && vp) { closeVideo(); e.preventDefault(); e.stopImmediatePropagation(); } }, true);

/* ---------- 音频：预生成 mp3 优先，缺失时退回浏览器语音 ---------- */
const player = new Audio();
player.preservesPitch = true;
const synth = window.speechSynthesis;
let sysVoice = null;
function pickSysVoice() {
  if (!synth) return;
  const vs = synth.getVoices().filter(v => /^en/i.test(v.lang));
  sysVoice = vs.find(v => /natural|online/i.test(v.name) && /en-US/.test(v.lang)) || vs.find(v => /en-US/.test(v.lang)) || vs[0];
}
if (synth) { pickSysVoice(); synth.onvoiceschanged = pickSysVoice; }
/* 音频放在单独的音频站（清单里的 base）。本地开发（http）用本机 8766 端口的 audio-store，
   这样新生成、还没推送的音频也能直接试听 */
const audioBase = (aud = AUD) => location.protocol === "http:" ? `http://${location.hostname}:8766/` : (aud.base || "data/audio/");
const audioURL = (key, aud) => `${audioBase(aud)}files/${key}.mp3`;
const rate = () => +S.rate;
/* 选中的声音本课没生成时，退回本课第一种 */
const pickVoice = rec => rec && (rec[S.voice] || Object.values(rec)[0]);

function stopAll() { player.pause(); player.ontimeupdate = player.onended = player.onerror = null; synth && synth.cancel(); $$(".sent .w.reading").forEach(s => s.classList.remove("reading")); }   // 读到一半被打断的例句也去掉高亮
/* aud：用哪一课的音频清单，默认当前课（巩固模式会播别的课的词） */
function playFile(key, onEnd, r = rate(), aud) {
  stopAll();
  player.src = audioURL(key, aud); player.playbackRate = r;
  player.onended = () => onEnd && onEnd();
  player.onerror = () => onEnd && onEnd();
  player.play().catch(() => onEnd && onEnd());
}
function speakTTS(text, lang, onEnd) {
  stopAll();
  if (!synth) { onEnd && onEnd(); return; }
  const u = new SpeechSynthesisUtterance(text);
  if (lang === "en" && sysVoice) { u.voice = sysVoice; u.lang = sysVoice.lang; } else u.lang = lang === "zh" ? "zh-CN" : "en-US";
  u.rate = lang === "en" ? (rate() < 1 ? 0.7 : 0.95) : 1;
  u.onend = u.onerror = () => onEnd && onEnd();
  synth.speak(u);
}
function speak(text, onEnd) {
  const w = AUD.w[text] || AUD.w[text.toLowerCase()];
  const key = pickVoice(w);
  key ? playFile(key, onEnd) : speakTTS(text, "en", onEnd);
}
function speakZh(text, onEnd) {
  const key = AUD.z[text];
  key ? playFile(key, onEnd, 1) : speakTTS(plainMean(text), "zh", onEnd);
}
function playSentence(card, onEnd, r = rate()) { readSent(card, entryOf(card).ex.en, onEnd, r); }
/* 读 root 里 .sent 的那句例句（原文 en）并逐词高亮；aud：句子所在那课的音频清单（复习、巩固会读别的课的句子） */
function readSent(root, en, onEnd, r = rate(), aud = AUD) {
  const spans = $$(".sent .w", root);
  const clear = () => spans.forEach(s => s.classList.remove("reading"));
  const rec = pickVoice(aud.s[en]);
  if (!rec) { speakTTS(en, "en", onEnd); return; }
  /* 语音的逐词时间点按顺序对到句中单词，用于朗读高亮 */
  const norm = x => x.toLowerCase().replace(/[^a-z']/g, "");
  let j = 0;
  const marks = rec.m.map(([t, w]) => {
    let k = j; while (k < spans.length && norm(spans[k].textContent) !== norm(w)) k++;
    if (k < spans.length) j = k + 1;
    return [t, k < spans.length ? k : Math.min(j, spans.length - 1)];
  });
  playFile(rec.f, () => { clear(); onEnd && onEnd(); }, r, aud);
  player.ontimeupdate = () => { const m = marks.filter(m => m[0] <= player.currentTime).pop(); clear(); m && spans[m[1]] && spans[m[1]].classList.add("reading"); };
}

/* ---------- 目录抽屉 ---------- */
function lessonProgress(les) {
  if (!les.ready || les.id !== (L && L.id)) {
    const words = store.get("lw:" + les.id, null);
    if (!words) return "";
    const n = words.filter(w => known.has(w)).length;
    return `<span class="prog${n === words.length ? " done" : ""}">${n}/${words.length}</span>`;
  }
  const words = allEntries().map(e => e.word);
  const n = words.filter(w => known.has(w)).length;
  return `<span class="prog${n === words.length ? " done" : ""}">${n}/${words.length}</span>`;
}
function renderDrawer() {
  let h = `<h2>${esc(BOOK.title)}</h2>`;
  for (const p of BOOK.parts) {
    h += `<div class="part">PART 0${p.no} · ${esc(p.title)}</div>`;
    for (const u of p.units) {
      const cur = L && u.lessons.some(l => l.id === L.id);
      const ready = u.lessons.filter(l => l.ready).length;
      h += `<details${cur ? " open" : ""}><summary>Unit ${u.no}<small>${u.words ? u.words + " 词 · " : ""}${ready}/${u.lessons.length} 课</small></summary>`;
      for (const l of u.lessons) {
        const isCur = L && l.id === L.id;
        h += `<a class="les${isCur ? " cur" : ""}${l.ready ? "" : " off"}" href="#/${l.id}">Lesson ${l.no}` +
             `<span>${l.ready ? lessonProgress(l) : `<span class="prog">p${l.page} · 未生成</span>`}</span></a>`;
        if (isCur) for (const g of l.groups) h += `<a class="grp" href="#/${l.id}/g${g.no}">词以群记 ${g.no} ${esc(g.title)}</a>`;
      }
      h += `</details>`;
    }
  }
  $("#drawer").innerHTML = h;
}
const openDrawer = v => { $("#drawer").classList.toggle("open", v); $("#scrim").classList.toggle("open", v); };
/* 宽屏时侧边栏常驻，☰ 改为收起 / 展开，状态记住；窄屏仍是抽屉。
   巩固页（#/drill…）里默认收起，☰ 只临时展开、不改记住的状态，离开巩固页恢复 */
const wide = matchMedia("(min-width:1180px)");
let drillSide = false;   // 巩固页里临时展开了侧边栏
const inDrill = () => /^#\/drill/.test(location.hash);
const applySide = () => document.body.classList.toggle("sideOff", inDrill() ? !drillSide : !!store.get("sideOff", false));
$("#menuBtn").onclick = () => {
  if (!wide.matches) { openDrawer(true); return; }
  if (inDrill()) drillSide = !drillSide; else store.set("sideOff", !store.get("sideOff", false));
  applySide();
};
applySide();
$("#scrim").onclick = () => openDrawer(false);
$("#drawer").addEventListener("click", e => { if (e.target.closest("a")) openDrawer(false); });

/* ---------- 思维导图 ---------- */
/* map：这一群所在那课的词条查表（词 → {ext, entry…}），课文页传 WORDMAP，学习新词页传那课缓存里的 map */
function mapHTML(node, root, map = WORDMAP) {
  if (root) return `<div class="mm"><span class="node root">${esc(node.w)}</span>${node.children ? `<ul>${node.children.map(c => mapHTML(c, false, map)).join("")}</ul>` : ""}</div>`;
  const hit = map.get(node.w);
  const cls = hit ? (hit.ext ? "ext" : "entry") + (!hit.ext && known.has(node.w) ? " known" : "") : "ext";
  return `<li${node.rel ? ` class="has-rel"` : ""}>${node.rel ? `<span class="rel r-${node.rel}">${esc(node.rel)}</span>` : ""}` +
         `<button class="node ${cls}" data-goto="${esc(node.w)}">${esc(node.w)}</button>` +
         `${node.children ? `<ul>${node.children.map(c => mapHTML(c, false, map)).join("")}</ul>` : ""}</li>`;
}

/* 手机版导图：单线串联的关系写在同一行（A → 相关 B → 形近 C），只在分叉处换行缩进 */
function nodeChip(node, map = WORDMAP) {
  const hit = map.get(node.w);
  const cls = hit ? (hit.ext ? "ext" : "entry") + (!hit.ext && known.has(node.w) ? " known" : "") : "ext";
  return `${node.rel ? `<span class="rel r-${esc(node.rel)}">${esc(node.rel)}</span>` : ""}<button class="node ${cls}" data-goto="${esc(node.w)}">${esc(node.w)}</button>`;
}
function mapCompactLine(node, map = WORDMAP) {
  let h = nodeChip(node, map), cur = node;
  while (cur.children && cur.children.length === 1) { cur = cur.children[0]; h += `<span class="mseg"><span class="arr">→</span>${nodeChip(cur, map)}</span>`; }
  const kids = cur.children && cur.children.length > 1 ? `<ul>${cur.children.map(c => `<li>${mapCompactLine(c, map)}</li>`).join("")}</ul>` : "";
  return `<span class="line">${h}</span>${kids}`;
}
const mapCompact = (root, map = WORDMAP) => `<ul class="mmc">${(root.children || []).map(c => `<li>${mapCompactLine(c, map)}</li>`).join("")}</ul>`;

/* ---------- 词卡 ---------- */
const allEntries = () => L.groups.flatMap(g => g.entries);
const entryOf = card => WORDMAP.get(card.dataset.word).entry;
const flames = n => "🔥".repeat(n) + `<i>${"🔥".repeat(3 - n)}</i>`;

function cardHTML(e) {
  const multi = e.prons.length > 1;
  const senses = e.prons.map(p => p.senses.map((s, i) =>
    `<div class="sense">${multi && i === 0 ? `<span class="ipa">${esc(p.ipa)}</span>` : ""}<span class="pos">${esc(s.pos)}</span>${meanHTML(s.mean)}</div>`).join("")).join("");
  const ex = e.ex ? `<div class="ex${e.ex.type === "真" ? " zt" : ""}">
      <div class="exlab">${e.ex.type === "真" ? `真题 ${e.ex.year}` : "例句"}</div>
      <div class="sent">${sentenceHTML(e.ex.en, e.ex.key, noteOf(NOTES, e.ex.en))}</div>
      <div class="zh">${esc(e.ex.zh)}</div>${Sent.anBlock(noteOf(NOTES, e.ex.en), e.ex.zh, e.ex.en, e.ex.key)}
      <div class="ops"><button class="play">▶ 播放例句</button><button class="play" data-slow="1">🐢 慢速</button></div>
    </div>` : "";
  const exts = e.ext && e.ext.length ? `<div class="exts">${e.ext.map(x => `<div class="extrow" data-ext="${esc(x.word)}">
      <span class="tag">扩</span><b>${esc(x.word)}</b>${x.alt ? `<span class="ipa">/${esc(x.alt)}</span>` : ""}
      <span class="ipa">${esc(x.ipa)}</span><button class="spk sm" data-say="${esc(x.word)}" title="读">🔊</button>
      <span class="xm">${x.senses.map(s => `<span class="pos">${esc(s.pos)}</span>${meanHTML(s.mean)}`).join("　")}</span></div>`).join("")}</div>` : "";
  return `<article class="card${known.has(e.word) ? " known" : ""}" id="w-${esc(e.word)}" data-word="${esc(e.word)}">
    <div class="head">
      <span class="no">${String(e.no).padStart(2, "0")}</span><span class="word">${esc(e.word)}</span>
      ${e.prons.length === 1 ? `<span class="ipa">${esc(e.prons[0].ipa)}</span>` : ""}
      <button class="spk" data-say="${esc(e.word)}" title="读单词">🔊</button>${videoHTML(VIDEO, e.no, false, e.word)}
      <span class="freq" title="考频 ${e.freq}/3">${flames(e.freq)}</span>
      <button class="knowBtn">${known.has(e.word) ? "✓ 已会" : "标为已会"}</button>
    </div>
    <div class="senses">${senses}</div>
    ${e.tip ? `<div class="tip"><span class="tag ${esc(e.tip.type)}">${esc(e.tip.type)}</span>${esc(e.tip.text)}</div>` : ""}
    ${e.root ? `<div class="tip root"><span class="tag 构词">词根</span>${esc(e.root)}<span class="src add">补充</span></div>` : ""}
    ${ex}${exts}
  </article>`;
}

function renderLesson() {
  const [a, b] = L.pages;
  $("#crumb").textContent = matchMedia("(max-width:600px)").matches ? `U${L.unit} · L${L.lesson}` : `Unit ${L.unit} · Lesson ${L.lesson}`;   // 手机顶栏放不下全称
  document.title = `U${L.unit} L${L.lesson} · 四级词汇`;
  $("#lessonHead").innerHTML = `<h1>Unit ${L.unit} · Lesson ${L.lesson}</h1>
    <p>${allEntries().length} 词 · ${L.groups.length} 个词群 · 书 p${a}–${b} · <span id="lessonProg"></span></p>
    <div class="chips">${L.groups.map(g => `<a href="#/${L.id}/g${g.no}">词以群记 ${g.no} ${esc(g.title)}</a>`).join("")}</div>
    <a class="pickBtn" href="#/log/${L.id}">📝 学习记录</a>`;
  $("#groups").innerHTML = L.groups.map(g => `<section class="group" id="g${g.no}" data-g="${g.no}">
      <div class="ghead"><span class="gno">词以群记 ${g.no}</span><span class="gtitle">${esc(g.title)}</span><span class="learned" data-learned="${g.no}"></span>
        ${BOOK.hasPages ? `<button class="src-btn" data-pages="${g.pages[0]}-${g.pages[1]}">📖 看原书</button>` : ""}</div>
      <div class="mapbox">${mapHTML(g.map, true)}${mapCompact(g.map)}</div>
      ${g.entries.map(cardHTML).join("")}
    </section>`).join("");
  updateProgress();
  paintLearned();
}

/* ---------- 学习记录：词群标题旁标出哪天学过；勾选在首页「学新」和记录页（study.js） ---------- */
function paintLearned() {
  for (const g of L.groups) {
    const d = Study.learnDate(L.id, g.no), el = $(`[data-learned="${g.no}"]`);
    if (el) { el.textContent = d ? `✓ ${+d.slice(5, 7)}/${+d.slice(8)} 学过` : ""; el.title = d ? `${d} 记为学过` : ""; }
  }
}
function updateProgress() {
  const words = allEntries().map(e => e.word);
  const n = words.filter(w => known.has(w)).length;
  const el = $("#lessonProg"); if (el) el.textContent = `已会 ${n}/${words.length}`;
  store.set("lw:" + L.id, words);
  renderDrawer();
}

/* ---------- 加载一课 ---------- */
async function loadLesson(id) {
  if (L && L.id === id) return;
  stopMarathon();
  const [les, gl, au, rt, nt, vd] = await Promise.all([
    fetchJSON(`data/lessons/${id}.json`),
    fetchJSON(`data/gloss/${id}.json`).catch(() => ({words: {}})),
    fetchJSON(`data/audio/${id}.json`).catch(() => ({w: {}, s: {}, z: {}, m: {}, voices: []})),
    fetchJSON(`data/roots/${id}.json`).catch(() => ({words: {}})),
    fetchJSON(`data/notes/${id}.json`).catch(() => ({sents: {}})),
    fetchJSON(`data/video/${id}.json`).catch(() => null),   // 讲解视频跳转：没有这一课的数据就不显示按钮
  ]);
  L = les; GLOSS = gl.words || {}; AUD = au; NOTES = {sents: nt.sents || {}}; VIDEO = vd;
  for (const g of L.groups) for (const e of g.entries) e.root = rt.words?.[e.word];   // 词根法（书外补充）
  WORDMAP.clear();
  for (const g of L.groups) for (const e of g.entries) {
    WORDMAP.set(e.word, {word: e.word, senses: e.prons.flatMap(p => p.senses), ipa: e.prons.map(p => p.ipa).join(" "), no: e.no, entry: e, ext: false});
    for (const x of e.ext || []) if (!WORDMAP.has(x.word)) WORDMAP.set(x.word, {word: x.word, senses: x.senses, ipa: x.ipa, no: e.no, entry: e, ext: true});
  }
  renderLesson();
}

/* ---------- 路由：#/ 首页、#/drill…、#/list/…、#/week…（study.js）；#/u07-l01、#/u07-l01/g2、#/u07-l01/w/margin、
   #/u07-l01/learn（旧地址，转到记录页）、#/settings ---------- */
let prevHash = "#/";   // 设置页「返回」回到哪
let curHash = location.hash;   // 当前显示的页面
const viewY = new Map();       // 每个页面（按地址）离开时滚到哪，回来时接着看
/* 滚回之前的位置：页面内容可能还没撑开（组件升级、异步加载），够不着就隔一会儿再试，最多约 1 秒 */
function scrollBack(y, h = location.hash) {
  let n = 0;
  (function go() {
    if (location.hash !== h) return;
    scrollTo(0, y);
    if (scrollY < y - 2 && ++n < 40) setTimeout(go, 25);
  })();
}
async function route() {
  const ready = BOOK.parts.flatMap(p => p.units.flatMap(u => u.lessons)).filter(l => l.ready);
  if (!ready.length) { $("#groups").innerHTML = `<p class="empty">还没有生成任何课。</p>`; return; }
  const last = ready.some(l => l.id === store.get("last")) ? store.get("last") : ready[0].id;
  const h = location.hash, isSettings = h === "#/settings", isStudy = !isSettings && Study.isStudy(h);
  if (h !== curHash) viewY.set(curHash, scrollY);
  curHash = h;
  closePeek(); drillSide = false; applySide();
  if ((isSettings || isStudy) && !$("#lessonView").hidden && L) lessonScroll = {id: L.id, h: prevHash, y: scrollY};   // 离开课文前记住读到哪
  if (!isSettings) prevHash = h || "#/";
  $("#lessonView").hidden = isSettings || isStudy; $("#fabs").hidden = isSettings || isStudy;
  $("#settingsView").hidden = !isSettings; $("#studyView").hidden = !isStudy;
  $("#homeBtn").classList.toggle("on", isStudy && !/^#\/(drill|list|week|log)/.test(h));
  $("#setBtn").classList.toggle("on", isSettings); $("#setBtn").title = $("#setBtn").ariaLabel = isSettings ? "返回" : "设置";
  if (isStudy) { stopMarathon(); pop.style.display = "none"; Study.render(h, viewY.get(h) || 0); renderDrawer(); return; }
  if (isSettings) {
    stopMarathon(); pop.style.display = "none";
    if (!L) await loadLesson(last);   // 设置页试听要用到本课音频
    renderSettings(); scrollBack(viewY.get(h) || 0);
    $("#crumb").textContent = "设置"; document.title = "设置 · 四级词汇";
    return;
  }
  const m = h.match(/^#\/(u\d\d-l\d\d)(?:\/(g\d+|w\/.+|learn|cont))?$/);
  const id = m && ready.some(l => l.id === m[1]) ? m[1] : last;
  const reuse = L && L.id === id;
  await loadLesson(id);
  store.set("last", id);
  if (reuse) renderLesson();   // 从设置页返回时重画，标题和进度跟上
  const t = m && m[2];
  if (t === "learn") { location.replace("#/log/" + id); return; }
  if (t === "cont") {   // 首页「继续」：回到上次读到的那个词群的开头（标题 + 导图），不直接跳到那个词；地址换成词群锚点
    // 读到的词群已经勾为学过（比如跟着电子书和视频学完再勾的），就去最后一个勾过的词群的下一群
    const card = document.getElementById("w-" + store.get("pos:" + id, "")), nx = Sync.entries("learn:").some(([, d]) => d) && Study.nextGroups(1)[0];
    let sec = card && card.closest(".group");
    if (nx && nx.lid === id && (!sec || +sec.dataset.g < nx.no)) sec = document.getElementById("g" + nx.no);
    const to = `#/${id}${sec ? "/" + sec.id : ""}`;
    history.replaceState(null, "", to); curHash = prevHash = to;
    sec ? sec.scrollIntoView() : scrollTo(0, 0);
    lessonScroll = null;
    return;
  }
  // 从设置 / 首页回来，回到离开时的位置；地址带词群、词的锚点，只有新点开（不是原来那个地址）才跳过去
  const back = lessonScroll && lessonScroll.id === id && (!t || lessonScroll.h === h);
  if (back) scrollBack(lessonScroll.y);
  else if (t && t[0] === "g") document.getElementById(t)?.scrollIntoView();
  else if (t) gotoWord(decodeURIComponent(t.slice(2)));
  else restorePos(id);
  lessonScroll = null;
}
let lessonScroll = null;

/* ---------- 阅读位置：滚动停下后记下本课读到哪个词，下次打开（或换设备）接着读 ---------- */
let posReady = false;   // 首次同步完成前不记，免得本机的旧位置盖掉别的设备更新的位置
history.scrollRestoration = "manual";   // 刷新后由 restorePos 定位，不让浏览器自己恢复的滚动位置抢在后面
function restorePos(id) {
  const w = store.get("pos:" + id, "");
  const card = w && document.getElementById("w-" + w);
  card ? card.scrollIntoView({block: "start"}) : scrollTo(0, 0);
}
let posTimer = null;
addEventListener("scroll", () => {
  clearTimeout(posTimer);
  posTimer = setTimeout(() => {
    if (!posReady || !L || $("#lessonView").hidden) return;
    const card = scrollY < 120 ? null : $$(".card").find(c => c.getBoundingClientRect().bottom > 70);   // 顶栏 52px 下第一张露出来的卡
    store.set("pos:" + L.id, card ? card.dataset.word : "", true);
  }, 500);
}, {passive: true});
function gotoWord(w) {
  const hit = WORDMAP.get(w); if (!hit) return;
  const card = document.getElementById("w-" + hit.entry.word);
  const target = hit.ext ? card.querySelector(`[data-ext="${CSS.escape(w)}"]`) || card : card;
  target.scrollIntoView({behavior: "smooth", block: "center"});
  card.classList.add("flash"); setTimeout(() => card.classList.remove("flash"), 1400);
}

/* ---------- 查词浮层 ---------- */
const pop = $("#pop");
function showPop(html, rect) {
  pop.innerHTML = html; pop.style.display = "block"; pop.rect = {left: rect.left + scrollX, bottom: rect.bottom + scrollY};
  placePop();
}
/* 放在点到的位置下面、不超出右边；内容变了（生词本按钮填上字）再放一次。先放到最左边再量宽度，免得贴着右边被挤窄、量出来偏小 */
function placePop() {
  const r = pop.rect; if (!r) return;
  pop.style.left = "0px";
  const x = Math.min(r.left, scrollX + document.documentElement.clientWidth - pop.offsetWidth - 8);
  pop.style.left = Math.max(8, x) + "px"; pop.style.top = (r.bottom + 6) + "px";
}
/* ---------- 生词本：查到的词 → 存什么（原形、释义、音标、书中位置）；src = 例句所在的词条 ---------- */
const lesShort = lid => `U${+lid.slice(1, 3)} L${+lid.slice(5, 7)}`;
const bookAt = w => (Object.hasOwn(BOOK.search, w) ? BOOK.search[w] : null);   // 书中位置 [课id, 词条序号, 是否扩展词]
function vocabTarget(q, src, c) {
  const b = !q.includes(" ") && findWord(q, c.map);     // 本课词条 / 扩展词
  const g = c.gloss[q] || "";
  const w = b ? b.word : Vocab.lemma(q, g, bookAt);
  const {p, m} = Vocab.parse(g, w !== q);
  return {w, x: q, m: b ? sensesText(b.senses) : m, p: b ? b.ipa : w === q ? p : "", k: c.lid, e: src || "", bk: bookAt(w)};
}
/* 浮层底部的按钮：加入 / 移出；书上已在复习的词改为「记一次忘了」 */
function vocabButton(v) {
  const el = $("#popVocab"), note = $("#popVn"); if (!el) return;
  if (v.bk && !v.bk[2] && Sync.get("srs:" + v.w, 0)) {
    el.classList.remove("on"); el.disabled = false; el.textContent = "记一次忘了";
    note.textContent = `${v.w} 已在复习中（书中 ${lesShort(v.bk[0])}）；记忘了就明天再来，并进难词本`;
    el.onclick = () => { Study.forgetBook(v.w); el.disabled = true; el.textContent = "✓ 已记，明天再复习"; };
    placePop(); return;
  }
  const cur = Study.vocabGet(v.w);
  el.classList.toggle("on", !!cur);
  el.textContent = cur ? "✓ 生词本 · 移出" : "＋ 生词本";
  note.textContent = cur ? `${+cur.at.slice(5, 7)}/${+cur.at.slice(8)} 加入的生词${v.w !== v.x ? `：${v.w}` : ""}` : v.w !== v.x ? `加入生词本：${v.w}` : "";
  el.onclick = () => { cur ? Study.removeVocab(v.w) : Study.addVocab(v); vocabButton(v); };
  placePop();
}

/* 查词用哪课的数据：课文页是本课；首页巩固里的例句带 data-lid，用那课的（study.js 读来缓存） */
const curCtx = () => ({lid: L.id, gloss: GLOSS, map: WORDMAP, aud: AUD, notes: NOTES});
/* 「析」里的英文块（.snip）属于它所在例句块里的那句 .sent：查词上下文、出处、整句原文都按那句算 */
const SENT = ".sent,.snip";
const hostOf = el => { const sn = el.closest && el.closest(".snip"); return (sn && sn.closest(".ex") && sn.closest(".ex").querySelector(".sent")) || el; };
const ctxOf = el => { const s = hostOf(el).closest && hostOf(el).closest("[data-lid]"); return s ? Study.lookupCtx(s.dataset.lid) : Promise.resolve(curCtx()); };
function speakIn(text, c) {
  if (c.aud === AUD) { speak(text); return; }
  const key = pickVoice(c.aud.w[text] || c.aud.w[text.toLowerCase()]);
  key ? playFile(key, null, rate(), c.aud) : speakTTS(text, "en");
}
/* 点到例句里的词（el）或选中一段：查词 + 读出来 */
async function lookupAt(el, text, rect) {
  const c = await ctxOf(el);
  lookup(text, rect, srcOf(el), c); speakIn(text, c);
}

const BOOKTAG = n => `<span class="src">书中 #${n}</span>`, ADD = `<span class="src add">补充</span>`;
/* 一个词的释义（浮层里的一行）：本课词条 / 扩展词用书上的，其他用逐词释义；都没有返回 null */
function wordInfo(w, c) {
  const b = findWord(w, c.map);
  if (b) return `<b>${esc(b.word)}</b> <span class="ipa">${esc(b.ipa)}</span> ${esc(sensesText(b.senses))}${BOOKTAG(b.no)}`;
  for (const k of lemmaCandidates(w)) if (c.gloss[k]) return `<b>${esc(w)}</b> ${esc(c.gloss[k])}${ADD}`;
  return null;
}
async function lookup(text, rect, src, c = curCtx()) {
  const GLOSS = c.gloss;
  const q = text.toLowerCase().replace(/[^a-z' ]/g, " ").replace(/\s+/g, " ").trim();
  if (!q) return;
  const line = (w, body, src) => `<div class="pm"><b>${esc(w)}</b> ${body}${src}</div>`;
  let html, needOnline = false;
  const one = w => { const h = wordInfo(w, c); return h && `<div class="pm">${h}</div>`; };
  if (GLOSS[q]) html = `<div><span class="pw">${esc(text)}</span>${ADD}</div><div class="pm">${esc(GLOSS[q])}</div>`;
  else if (!q.includes(" ")) {
    html = one(q) || line(q, "查询中…", ""); needOnline = !one(q);
  } else html = `<div><span class="pw">${esc(text)}</span></div>` + q.split(" ").map(w => one(w) || line(w, "—", "")).join("");
  showPop(html + `<div class="ops"><button id="popSay">🔊 再读一遍</button><button id="popVocab" class="pvb"></button></div><div class="pn" id="popVn"></div>`, rect);
  $("#popSay").onclick = () => speakIn(q, c);
  vocabButton(vocabTarget(q, src, c));
  if (needOnline) {
    try {
      const j = await fetchJSON("https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(q));
      const m = j[0].meanings.slice(0, 2).map(x => `<i>${x.partOfSpeech}</i> ${esc(x.definitions[0].definition)}`).join("<br>");
      pop.querySelector(".pm").innerHTML = `<b>${esc(q)}</b> ${m}<div class="pn">英文词典在线释义（本地未收录）</div>`;
    } catch { pop.querySelector(".pm").innerHTML = `<b>${esc(q)}</b> 本地未收录，在线查询失败`; }
    placePop();
  }
}

/* ---------- 原书查看 ---------- */
function openPages(a, b) {
  const imgs = []; for (let p = a; p <= b; p++) imgs.push(`<img loading="lazy" src="data/pages/p${p}.jpg" alt="第 ${p} 页">`);
  $("#viewerTitle").textContent = `原书 p${a}${b > a ? "–" + b : ""}`;
  $("#viewerBody").innerHTML = imgs.join(""); $("#viewer").hidden = false;
}
$("#viewerClose").onclick = () => { $("#viewer").hidden = true; };

/* ---------- 例句点词：课文页、首页复习卡背面、生词「遇见」的 .sent，以及「析」里的英文块 .snip，都走这一个处理函数 ----------
   单击词组 → 词组浮层（下面一行小字是点到的词），读词组；单击词组外的词 → 查这个词并朗读；
   双击单词 / 手机长按选中一个词 → 只查这个词；划选几个词 → 和哪个词组重叠的字最多就显示哪个，对不上就逐词查。
   双击会先来两次 click：点在词组上的单击等 DBL_MS 确认不是双击再弹，双击直接查词，不会先闪词组、读两遍；
   词组外的词单击立刻查，第二击不再处理。
   出题卡片还没作答（.locked）时例句不响应，点击照常交给卡片（翻卡）。
   在捕获阶段处理并停止传播，study.js 的卡片监听和下面的 document 监听都不会再收到这次点击 */
const srcOf = el => { const h = hostOf(el), s = h.closest && h.closest(".card,[data-src]"); return s ? s.dataset.word || s.dataset.src || "" : ""; };   // 例句属于哪个词条
/* 「析」：展开 / 收起这句的语法解析 */
function toggleAn(b) {
  const an = b.parentElement.querySelector(".an"); if (!an) return;
  an.hidden = !an.hidden; b.classList.toggle("on", !an.hidden);
}
const DBL_MS = 260;
let phTimer = 0, lastSel = {k: "", t: 0, s: null};
/* node 里 offset 处在这句里是第几个字符 */
function charAt(sent, node, offset) { const r = document.createRange(); r.setStart(sent, 0); r.setEnd(node, offset); return r.toString().length; }
/* 选区落在这句里的部分：{text, a, b, rect}；没选或不在这句里返回 null */
function selIn(sent) {
  const s = getSelection();
  if (!s.rangeCount || !s.toString().trim()) return null;
  const r = s.getRangeAt(0), inS = sent.contains(r.startContainer), inE = sent.contains(r.endContainer);
  if (!inS && !inE) return null;
  const a = inS ? charAt(sent, r.startContainer, r.startOffset) : 0, b = inE ? charAt(sent, r.endContainer, r.endOffset) : sent.textContent.length;
  const text = sent.textContent.slice(a, b).trim();
  return text ? {text, a, b, rect: r.getBoundingClientRect()} : null;
}
/* 词组浮层：上面词组（原形、释义、补充），w 是点到的词（划选时没有），下面一行小字是它的释义；读词组原形 */
async function phraseAt(sent, id, w) {
  const c = await ctxOf(sent);
  if (!sent.isConnected) return;
  const en = hostOf(sent).textContent, list = (noteOf(c.notes, en) || {}).ph || [], P = list[id];   // sent 可能是「析」里的英文块，词组按整句找
  const rect = (w || sent.querySelector(`.ph[data-ph="${id}"]`) || sent).getBoundingClientRect();
  if (!P) { if (w) { lookup(w.textContent, rect, srcOf(sent), c); speakIn(w.textContent, c); } return; }
  const x = Sent.locate(en, list).filter(s => s.id === id).map(s => en.slice(s.s, s.e)).join(" … ");
  const wq = w && w.textContent.toLowerCase().replace(/[^a-z']/g, "");
  showPop(`<div><span class="pw">${esc(P.b)}</span>${ADD}</div><div class="pm">${esc(P.m)}</div>
    ${w ? `<div class="pwl">${wordInfo(wq, c) || `<b>${esc(w.textContent)}</b> 本地未收录`}</div>` : ""}
    <div class="ops"><button id="popSay">🔊 再读一遍</button><button id="popVocab" class="pvb"></button></div><div class="pn" id="popVn"></div>`, rect);
  /* 词组音频按原形生成（清单 p，… 读 something），这一课还没生成就退回浏览器语音 */
  const say = () => { stopAll(); const key = pickVoice((c.aud.p || {})[P.b]); key ? playFile(key, null, rate(), c.aud) : speakTTS(Sent.spoken(P.b), "en"); };
  $("#popSay").onclick = say;
  vocabButton({w: P.b, x, m: P.m, p: "", k: c.lid, e: srcOf(sent), bk: bookAt(P.b), ph: 1});   // 生词本：原形、句中写法、释义快照，ph 标明是词组
  say();
}
/* 划选：一个词只查这个词；几个词按重叠挑词组，对不上走逐词查。
   同一个选区短时间内只处理一次（手机上 touchend 和 click 可能都看到它） */
function onSelect(sent, sel) {
  const k = `${sel.a}:${sel.b}:${sel.text}`, now = Date.now();
  if (lastSel.k === k && lastSel.s === sent && now - lastSel.t < 800) return;
  lastSel = {k, t: now, s: sent};
  stopMarathon();
  if (!/\s/.test(sel.text)) { lookupAt(sent, sel.text, sel.rect); return; }
  const segs = $$(".ph", sent).map(p => { const s = charAt(sent, p, 0); return {s, e: s + p.textContent.length, id: +p.dataset.ph}; });
  const id = Sent.best(segs, sel.a, sel.b);
  id >= 0 ? phraseAt(sent, id, null) : lookupAt(sent, sel.text, sel.rect);
}
/* 这次点击落在哪句例句上：点在句子里；或者从句子里开始划选、松手在句子外（click 落在共同的外层上） */
function sentOf(t) {
  const sent = t.closest(SENT); if (sent) return sent;
  const s = getSelection(); if (!s.rangeCount || !s.toString().trim()) return null;
  const n = s.getRangeAt(0).startContainer, el = (n.nodeType === 1 ? n : n.parentElement).closest(SENT);
  return el && t.contains(el) ? el : null;
}
function sentClick(e) {
  const t = e.target; if (!t.closest || pop.contains(t)) return;
  const ab = t.closest(".anBtn");
  if (ab && !ab.closest(".locked")) { e.stopPropagation(); toggleAn(ab); return; }
  const sent = sentOf(t);
  if (!sent || sent.closest(".locked")) return;
  e.stopPropagation();
  const w = t.closest(".w"), ph = t.closest(".ph");
  if (e.detail >= 2) {                               // 双击的第二击：词组里的词改查单词；词组外的词第一击已经查过
    if (e.detail === 2 && w && ph) { clearTimeout(phTimer); phTimer = 0; stopMarathon(); lookupAt(w, w.textContent, w.getBoundingClientRect()); }
    return;
  }
  const sel = selIn(sent);
  if (sel) { onSelect(sent, sel); return; }
  clearTimeout(phTimer); phTimer = 0;
  if (!w && !ph) { pop.style.display = "none"; return; }
  stopMarathon();
  if (!ph) { lookupAt(w, w.textContent, w.getBoundingClientRect()); return; }
  phTimer = setTimeout(() => { phTimer = 0; phraseAt(sent, +ph.dataset.ph, w); }, DBL_MS);
}
document.addEventListener("click", sentClick, true);
/* 手机长按选词、拖动选区：松手后看选区（长按不会触发 click） */
document.addEventListener("touchend", e => {
  const t = e.target;
  setTimeout(() => {
    const sent = t.closest && t.closest(SENT);
    if (!sent || !sent.isConnected || sent.closest(".locked")) return;
    const sel = selIn(sent); if (sel) onSelect(sent, sel);
  }, 300);
});

/* ---------- 其他点击 ---------- */
document.addEventListener("click", e => {
  const t = e.target;
  // 学习卡会在本次点击内重画；原按钮已脱离 DOM 时，closest 找不到 .study。
  // 事件原始路径仍含 studyView，不能再把内部 data-say 标记当课文内容朗读。
  const inStudy = e.composedPath().includes($("#studyView"));
  if (inStudy && !pop.contains(t)) pop.style.display = "none";
  if (inStudy || t.closest(".top,.drawer,.fabs,.settings,.viewer,.study,.peek")) { if (!t.closest(".search")) $("#qres").style.display = "none"; return; }
  if (t.dataset.say || t.classList.contains("play")) stopMarathon();
  if (t.dataset.say) { speak(t.dataset.say); return; }
  if (t.classList.contains("play")) { playSentence(t.closest(".card"), null, t.dataset.slow ? 0.75 : rate()); return; }
  if (t.dataset.goto) { gotoWord(t.dataset.goto); return; }
  if (t.dataset.pages) { const [a, b] = t.dataset.pages.split("-").map(Number); openPages(a, b); return; }
  if (t.classList.contains("knowBtn")) {
    const card = t.closest(".card"), w = card.dataset.word;
    setKnown(w, !known.has(w));
    card.classList.toggle("known", known.has(w)); t.textContent = known.has(w) ? "✓ 已会" : "标为已会";
    $$(`.node[data-goto="${CSS.escape(w)}"]`).forEach(n => n.classList.toggle("known", known.has(w)));
    updateProgress(); return;
  }
  const masked = t.closest(".mask .sense,.mask .zh,.mask .tip,.mask .xm");
  if (masked) {
    // 词卡里只分两块：单词意思（释义、记忆法、扩展词）一起开，例句译文单独开
    const card = masked.closest(".card"), on = !masked.classList.contains("show");
    const group = card && !masked.classList.contains("zh") ? $$(".sense,.tip,.xm", card) : [masked];
    group.forEach(x => x.classList.toggle("show", on)); return;
  }
  if (pop.contains(t)) return;
  pop.style.display = "none";
});

/* ---------- 设置页 ---------- */
const seg = (key, opts) => `<div class="seg">${opts.map(([v, label]) =>
  `<button data-set="${key}" data-val="${v}" class="${String(S[key]) === String(v) ? "on" : ""}">${label}</button>`).join("")}</div>`;
const sw = (key, title, desc) => `<label class="row sw"><span><b>${title}</b><small>${desc}</small></span>
  <input type="checkbox" data-set="${key}"${S[key] ? " checked" : ""}><i></i></label>`;
function renderSettings() {
  const outIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/></svg>';
  // 新增配套脚本只需追加一项，统一沿用设置页的紧凑行布局。
  const scripts = [
    {name: "网页全屏脚本", desc: "课件讲解自动铺满网页，普通 B 站视频保持原布局", file: "bilibili-webfull.user.js"},
    {name: "小窗净化脚本", desc: "隐藏视频小窗里的推荐和引流，保留播放控件", file: "bilibili-clean-player.user.js"},
  ];
  const have = L ? AUD.voices || [] : Object.keys(VOICE_NAMES);
  const sample = L ? allEntries()[0].word : "hello";
  const back = prevHash, bm = back.match(/^#\/u(\d\d)-l(\d\d)/);
  $("#settingsView").innerHTML = `
    <a class="back" href="${back}">← 返回${bm ? ` Unit ${+bm[1]} · Lesson ${+bm[2]}` : Study.isStudy(back) && !/^#\/(drill|list|week|log)/.test(back) ? "首页" : ""}</a>
    <h1>设置</h1>
    <section class="panel"><h2>发音</h2>
      <div class="voices">${Object.keys(VOICE_NAMES).map(v => `
        <button class="voice${S.voice === v ? " on" : ""}" data-set="voice" data-val="${v}"${have.includes(v) ? "" : " disabled"}>
          <b>${VOICE_NAMES[v]}</b><small>${have.includes(v) ? VOICE_DESC[v] : "本课未生成"}</small>
          ${L ? `<span class="try" data-try="${v}" title="试听">🔊</span>` : ""}</button>`).join("")}</div>
      <div class="row"><span><b>语速</b><small>单词、例句都按这个速度播放；例句旁的 🐢 始终是慢速</small></span>
        ${seg("rate", [[0.75, "慢"], [0.9, "较慢"], [1, "常速"]])}</div>
      ${sw("autoSay", "新词卡与看词题自动读音", "今日回忆、听音和拼写题始终读词；手动读音不计提示") }
      ${L ? `<p class="hint">试听词：${esc(sample)}</p>` : ""}
    </section>
    <section class="panel"><h2>今日学习</h2>
      <div class="row"><span><b>考试日期</b><small>用于首页倒计时和考前复习安排</small></span><input type="date" data-set="examDate" value="${esc(S.examDate)}"></div>
      <div class="row"><span><b>每日推荐词数上限</b><small>到期复习、遗忘重学和旧词校准共用上限；实际推荐量还会受时间预算与近期表现影响，次日生效</small></span>
        ${seg("dailyCap", [[25, "25"], [50, "50"], [60, "60"], [80, "80"], [120, "120"], [200, "200"]])}</div>
      <div class="row"><span><b>每日时间预算</b><small>含主任务和最多 5 次同日补测；按预计用时推荐词数，不会计时催促。下一学习日生效</small></span>
        ${seg("dailyMinutes", [[10, "10 分钟"], [20, "20 分钟"], [30, "30 分钟"]])}</div>
      <div class="row"><span><b>每轮学习词数</b><small>只拆分今日计划，不增加总量；“不限”表示整份计划一轮做完，下一轮生效</small></span>
        ${seg("roundSize", [[15, "15"], [25, "25"], [40, "40"], [0, "不限"]])}</div>
      <p class="note">主动回忆由你自评，困难词当轮补测；新词学习不计入每日完成条件。</p>
    </section>
    <section class="panel"><h2>学习新词</h2>
      <div class="row"><span><b>每个新词过几关</b><small>先看词卡，再依次练词义、听音、拼写；题型按下方开关调整</small></span>
        ${seg("learnStages", [[1, "1 关"], [2, "2 关"], [3, "3 关"]])}</div>
      <div class="row"><span><b>一次学多少</b><small>按完整词群取词，不拆最后一群；过关后自动记为已学，下一次开始学新词时生效</small></span>
        ${seg("learnSize", [[1, "1 群"], [2, "2 群"], [15, "至少 15 词"]])}</div>
      ${sw("quizListen", "新词听音关卡", "关闭后，第 2 关改为看义选词")}
      ${sw("quizSpell", "新词拼写关卡", "关闭后，第 3 关改为看义选词；若与上一关重复且有例句，则改为语境填空")}
      ${sw("autoEx", "新词词卡自动读例句", "看新词卡时播放例句；开启自动读词后会接着读") }
    </section>
    <section class="panel"><h2>课文阅读</h2>
      ${sw("mask", "背诵模式", "遮住释义、记忆法和译文；点单词意思一次全开，例句译文单独点开。课文页右下角「遮」也能随手切换")}
      ${sw("hideKnown", "隐藏已会", "标为「已会」的词卡不显示，磨耳朵也跳过它们")}
      ${sw("phLine", "例句词组下划线", "例句里标出的词组（书外补充）画虚线；关掉只是不画线，点词组照样显示词组释义")}
      <div class="row"><span><b>讲解视频优先用</b><small>词卡上 ▶ 先播哪一种：精讲带背每课一段（约 1 小时，到 U8）；全程班每单元一段（约 4 小时，U1–U10 都有）。选的这种没有这个词就用另一种，播放窗里也随时能换</small></span>
        ${seg("videoPrefer", [["精讲带背", "精讲带背"], ["全程班", "全程班"]])}</div>
    </section>
    <section class="panel"><h2>课件配套脚本</h2>
      ${sw("videoWebfull", "B 站网页全屏", "从课件跳转时自动铺满网页，按 Esc 退出；需先安装下方脚本")}
      ${scripts.map(s => `<div class="row script-row"><span><b>${s.name}</b><small>${s.desc}</small></span>
        <a class="script-install" href="tools/${s.file}" target="_blank" rel="noopener" aria-label="安装${s.name}">安装 ${outIcon}</a></div>`).join("")}
      <div class="script-help">
        <p>使用前需先安装并启用 <a href="https://www.tampermonkey.net/" target="_blank" rel="noopener">篡改猴扩展 ${outIcon}</a>，安装脚本后重新打开 B 站视频。</p>
        <details><summary>安装链接只显示源码？</summary><p>在油猴中添加新脚本，粘贴全部源码并保存。</p></details>
      </div>
    </section>
    <section class="panel"><h2>自由练习</h2>
      <div class="row"><span><label for="settingsPractice"><b>默认练习类型</b></label><small>自由抽查进入时使用；今日学习始终采用词义回忆</small></span>
        <select id="settingsPractice" data-set="practiceType">${[["meaning", "词义回忆"], ["recognition", "看词选义"], ["reverse", "看义选词"], ["listen", "听音"], ["spell", "拼写"], ["context", "语境"]].map(([v, label]) => `<option value="${v}"${S.practiceType === v ? " selected" : ""}>${label}</option>`).join("")}</select></div>
      <div class="row"><span><b>抽查顺序</b><small>只影响自由练习；今日学习按计划排序，新词按课件顺序</small></span>
        ${seg("drillOrder", [["course", "课件顺序"], ["alpha", "字母顺序"], ["freq", "重要性"], ["random", "随机"]])}</div>
      ${sw("autoNext", "答对后自动下一题", "用于新词闯关和自由练习的选择、拼写题；答对停留 1.5 秒，点击或按键可暂停。主动回忆评分后直接继续")}
      <div class="row"><span><b>选择题判分速度</b><small>用于新词闯关与自由选择题；超时答对记为模糊，不影响主动回忆自评</small></span>
        ${seg("slowMode", [["loose", "宽松"], ["std", "标准"], ["strict", "严格"], ["off", "关掉"]])}</div>
    </section>
    <section class="panel"><h2>磨耳朵</h2>
      <div class="row"><span><b>播放范围</b><small>从右下角 🎧 开始</small></span>${seg("scope", [["group", "当前词群"], ["lesson", "整课"]])}</div>
      ${sw("withZh", "读中文", "单词后读释义，例句后读译文")}
      ${sw("loop", "循环播放", "播完从头再来")}
    </section>
    <section class="panel"><h2>外观</h2>
      <div class="row"><span><b>主题</b><small>自动跟随系统深浅色</small></span>${seg("theme", [["auto", "自动"], ["light", "浅色"], ["dark", "深色"]])}</div>
    </section>
    <section class="panel"><h2>数据</h2>
      <div class="row"><span><b>「已会」记录</b><small>共 ${known.size} 个词${Sync.connected ? "，已开启云同步，清空会同步到所有设备" : "，只存在这台设备的浏览器里"}</small></span>
        <button class="danger" id="clearKnown"${known.size ? "" : " disabled"}>清空</button></div>
      <div class="row"><span><b>导出备份</b><small>把这台设备上的设置和学习记录存成一个文件（不含云同步 token）</small></span>
        <button id="bkExport">导出</button></div>
      <div class="row"><span><b>导入备份</b><small>选之前导出的文件，先看内容再确认，可以只导其中几类</small></span>
        <button id="bkImport">导入…</button><input type="file" id="bkFile" accept=".json,application/json" hidden></div>
      ${bkPreview()}
      <p class="hint">数据存在这个浏览器里，每个网址各存一份（本地版和线上版分开）；网页打不开那个位置。导出的文件在浏览器的下载文件夹，下载栏里点「在文件夹中显示」能找到。</p>
    </section>
    <section class="panel" id="syncPanel"></section>`;
  renderSyncPanel();
}

/* ---------- 设置页：导出 / 导入备份（分类和合并 / 覆盖规则在 backup.js） ---------- */
let bkPending = null;   // 选好文件、等确认的导入：{name, at, origin, d, n 每类条数, cats 勾选的类别, mode}
function bkDownload(suffix) {
  const now = Date.now(), body = Backup.text(Sync.dump(), now, location.origin);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], {type: "application/json"}));
  a.download = `cet4-backup-${Backup.day(now)}${suffix}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
function bkPreview() {
  const p = bkPending; if (!p) return "";
  const cats = Backup.CATS.filter(c => c.id !== "other" || p.n.other);
  return `<div class="bkprev">
    <p class="bkmeta"><b>${esc(p.name)}</b><br>导出于 ${p.at ? esc(new Date(p.at).toLocaleString()) : "未知时间"} · 来自 ${p.origin ? esc(p.origin) + (p.origin === location.origin ? "（就是这个网址）" : "") : "未知网址"}</p>
    <div class="bkcats">${cats.map(c => `<label><input type="checkbox" data-bk-cat="${c.id}"${p.cats.includes(c.id) ? " checked" : ""}>${c.name}<small>${p.n[c.id]} 条</small></label>`).join("")}</div>
    <div class="bkmode">${[["merge", "合并", "每条取较新的一份，不会把这台设备更新的记录改回去"],
      ["overwrite", "覆盖", "勾选的几类改成和文件一样：文件里没有的清掉，设置恢复默认；写入前先自动导出一份当前数据"]].map(([v, t, d]) =>
      `<label><input type="radio" name="bkMode" value="${v}"${p.mode === v ? " checked" : ""}><span><b>${t}</b><small>${d}</small></span></label>`).join("")}</div>
    <div class="bkacts"><button id="bkCancel">取消</button><button class="on" id="bkGo"${p.cats.length ? "" : " disabled"}>确认导入</button></div>
  </div>`;
}
function bkRead(file) {
  file.text().then(text => {
    const f = Backup.parse(text);
    if (!f) { bkPending = null; renderSettings(); toast("不是本站导出的备份文件，没有改动任何数据"); return; }
    bkPending = {name: file.name, ...f, n: Backup.summary(f.d), cats: Backup.CATS.map(c => c.id), mode: "merge"};
    renderSettings();
    const el = $(".bkprev"); if (el) el.scrollIntoView({block: "nearest"});
  }, () => toast("读不了这个文件"));
}
async function bkGo() {
  const p = bkPending; if (!p || !p.cats.length) return;
  /* 开着云同步时先拉一次：按最新的数据算计划，覆盖才不会被云端更新的值或只在云端的键改回去 */
  if (Sync.connected) { toast("先和云端同步一次…"); try { await Sync.syncNow(); } catch {} }
  if (p.mode === "overwrite") bkDownload("-导入前");
  const n = Sync.load(Backup.plan(Sync.dump(), p.d, p.cats, p.mode, Date.now(), DEFAULTS));
  bkPending = null;
  alert(n ? `已导入 ${n} 条` : "没有需要导入的内容（这台设备上已经一样或更新）");
  setTimeout(() => location.reload(), 800);   // 稍等再刷新，让「导入前」那份下载先开始
}

/* ---------- 设置页：云同步 ---------- */
const TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";
function ago(t) {
  const s = (Date.now() - t) / 1000;
  return s < 60 ? "刚刚" : s < 3600 ? `${Math.floor(s / 60)} 分钟前` : s < 86400 ? `${Math.floor(s / 3600)} 小时前` : new Date(t).toLocaleString();
}
function renderSyncPanel() {
  const el = $("#syncPanel"); if (!el) return;
  const st = Sync.status;
  if (!Sync.connected) {
    el.innerHTML = `<h2>云同步</h2>
      <div class="row"><span><b>多端同步进度</b><small>「已会」、设置、上次读到的位置存进你自己 GitHub 账号的一个私密 Gist，电脑、手机打开就自动接上</small></span></div>
      <ol class="steps">
        <li>打开 <a href="${TOKEN_URL}" target="_blank" rel="noopener">GitHub 新建 token</a>（fine-grained token）</li>
        <li>名字随意，有效期选最长；Repository access 选 <b>Public repositories</b>；Permissions 里只把 <b>Gists</b> 设为 <b>Read and write</b>，其余都不动</li>
        <li>生成后复制，粘贴到下面点「连接」。每台设备粘贴一次即可</li>
      </ol>
      <div class="tokenrow"><input id="syncToken" type="password" placeholder="github_pat_…" autocomplete="off" spellcheck="false">
        <button id="syncConnect">连接</button></div>
      ${st.msg ? `<p class="syncmsg err">${esc(st.msg)}</p>` : ""}`;
    return;
  }
  const text = st.state === "syncing" ? "同步中…" : st.state === "error" ? esc(st.msg) : st.at ? `已同步 · ${ago(st.at)}` : "等待同步";
  el.innerHTML = `<h2>云同步</h2>
    <div class="row"><span><b>已开启</b><small class="syncstate ${st.state}">${text}</small></span>
      <button id="syncNow"${st.state === "syncing" ? " disabled" : ""}>立即同步</button></div>
    <div class="row"><span><b>断开这台设备</b><small>只删除本机保存的 token，云端进度和其他设备不受影响</small></span>
      <button class="danger" id="syncOff">断开</button></div>`;
}
Sync.onStatus(() => { if (location.hash === "#/settings") renderSyncPanel(); });
/* 设置页再点 ⚙ 直接返回，和页面里的「← 返回」去同一个地方 */
$("#setBtn").addEventListener("click", e => {
  if (location.hash !== "#/settings") return;
  e.preventDefault();
  location.hash = $("#settingsView .back").getAttribute("href");
});
$("#settingsView").addEventListener("click", e => {
  const t = e.target;
  const tryBtn = t.closest("[data-try]");
  if (tryBtn) {
    e.preventDefault();
    const w = L ? allEntries()[0].word : null, rec = w && AUD.w[w] && AUD.w[w][tryBtn.dataset.try];
    rec ? playFile(rec) : speakTTS("hello", "en");
    return;
  }
  const b = t.closest("button[data-set]");
  if (b) { const k = b.dataset.set, v = b.dataset.val; setS(k, NUM_SETS.includes(k) ? +v : v); renderSettings(); if (k === "voice" && L) speak(allEntries()[0].word); return; }
  if (t.id === "clearKnown" && confirm(`清空 ${known.size} 个「已会」记录？`)) { [...known].forEach(w => setKnown(w, false)); renderSettings(); }
  if (t.id === "bkExport") bkDownload("");
  if (t.id === "bkImport") $("#bkFile").click();
  if (t.id === "bkCancel") { bkPending = null; renderSettings(); }
  if (t.id === "bkGo") bkGo();
  if (t.id === "syncNow") Sync.syncNow();
  if (t.id === "syncOff" && confirm("断开后这台设备不再同步，确定？")) { Sync.disconnect(); renderSettings(); }
  if (t.id === "syncConnect") {
    const token = $("#syncToken").value.trim();
    if (!token) { $("#syncToken").focus(); return; }
    t.disabled = true; t.textContent = "连接中…";
    Sync.connect(token).then(() => { posReady = true; renderSettings(); toast("云同步已开启"); })
      .catch(err => { renderSyncPanel(); const m = document.createElement("p"); m.className = "syncmsg err"; m.textContent = err.message; $("#syncPanel").append(m); });
  }
});
$("#settingsView").addEventListener("change", e => {
  const t = e.target;
  if (t.id === "bkFile") { if (t.files[0]) bkRead(t.files[0]); t.value = ""; return; }
  if (t.dataset.bkCat && bkPending) {
    bkPending.cats = Backup.CATS.map(c => c.id).filter(c => c === t.dataset.bkCat ? t.checked : bkPending.cats.includes(c));
    $("#bkGo").disabled = !bkPending.cats.length; return;
  }
  if (t.name === "bkMode" && bkPending) { bkPending.mode = t.value; return; }
  if (t.type === "checkbox" && t.dataset.set) setS(t.dataset.set, t.checked);
  else if (t.dataset.set && t.value) setS(t.dataset.set, t.value);
});

/* ---------- 右下角快捷按钮 ---------- */
$("#maskFab").onclick = () => { setS("mask", !S.mask); $$(".show").forEach(x => x.classList.remove("show")); };

/* ---------- 磨耳朵：单词×2 → 释义 → 例句 → 译文 → 扩展词 ---------- */
let runId = 0;
function stopMarathon() {
  runId++; stopAll();
  $("#playAll").classList.remove("on"); $("#playAll").textContent = "🎧";
  $$(".now,.now-part").forEach(x => x.classList.remove("now", "now-part"));
}
function currentGroup() {
  const gs = $$(".group"); let cur = gs[0];
  for (const g of gs) if (g.getBoundingClientRect().top < innerHeight * 0.4) cur = g;
  return cur;
}
function buildSteps() {
  const zh = S.withZh, steps = [];
  const scope = S.scope === "group" ? $$(".card", currentGroup()) : $$(".card");
  for (const card of scope) {
    if (card.offsetParent === null) continue;   // 被「隐藏已会」藏起来的跳过
    const e = entryOf(card), q = s => card.querySelector(s);
    steps.push({card, el: q(".word"), run: f => speak(e.word, f), gap: 400});
    steps.push({card, el: q(".word"), run: f => speak(e.word, f)});
    const meaning = w => (AUD.m && AUD.m[w]) || sensesText(WORDMAP.get(w).senses);
    if (zh) steps.push({card, el: q(".senses"), run: f => speakZh(meaning(e.word), f)});
    if (e.ex) {
      steps.push({card, el: q(".sent"), run: f => playSentence(card, f), gap: 800});
      if (zh) steps.push({card, el: q(".zh"), run: f => speakZh(e.ex.zh, f)});
    }
    $$(".extrow", card).forEach(row => {
      const x = WORDMAP.get(row.dataset.ext);
      steps.push({card, el: row, run: f => speak(x.word, f), gap: zh ? 300 : 600});
      if (zh) steps.push({card, el: row, run: f => speakZh(meaning(x.word), f)});
    });
    steps[steps.length - 1].gap = 1300;
  }
  return steps;
}
$("#playAll").onclick = function () {
  if (this.classList.contains("on")) { stopMarathon(); return; }
  stopMarathon();
  const my = runId, steps = buildSteps(); let i = 0;
  if (!steps.length) return;
  this.classList.add("on"); this.textContent = "⏹";
  const next = () => {
    if (my !== runId) return;
    if (i >= steps.length) { if (S.loop) i = 0; else { stopMarathon(); return; } }
    const st = steps[i++];
    $$(".now,.now-part").forEach(x => x.classList.remove("now", "now-part"));
    st.card.classList.add("now"); st.el && st.el.classList.add("now-part");
    st.card.scrollIntoView({behavior: "smooth", block: "center"});
    st.run(() => { if (my === runId) setTimeout(next, st.gap || 600); });
  };
  next();
};

/* ---------- 词群速览：右下角「群」或按 M。本群导图 + 词表，点词原地展开、读一遍，不滚动课文 ---------- */
const peek = $("#peek");
const peekOpen = () => peek.classList.contains("open");
/* 读到哪张卡：屏幕上方 40% 处的那张（和磨耳朵判断当前词群的办法一样） */
function readingCard(sec) {
  const cs = $$(".card", sec).filter(c => c.offsetParent !== null);
  let cur = cs[0];
  for (const c of cs) if (c.getBoundingClientRect().top < innerHeight * 0.4) cur = c;
  return cur;
}
/* 词表里的一行：序号 · 单词 · 音标 · 释义；展开后是记忆法、扩展词和「跳到」 */
const peekRow = (e, cls = "", mark = "", go = true) => `<li class="pk${cls}${known.has(e.word) ? " known" : ""}" data-pk="${esc(e.word)}">
    <div class="pkh"><span class="no">${String(e.no).padStart(2, "0")}</span><b>${esc(e.word)}</b><span class="ipa">${esc(e.prons.map(p => p.ipa).join(" "))}</span>${mark}</div>
    <div class="pkm">${e.prons.flatMap(p => p.senses).map(s => `<span class="pos">${esc(s.pos)}</span>${meanHTML(s.mean)}`).join("　")}</div>
    <div class="pkx">${e.tip ? `<div class="tip"><span class="tag ${esc(e.tip.type)}">${esc(e.tip.type)}</span>${esc(e.tip.text)}</div>` : ""}
      ${e.ext && e.ext.length ? `<div class="pkext">${e.ext.map(x => `<span data-pkext="${esc(x.word)}"><span class="tag">扩</span><b>${esc(x.word)}</b> ${x.senses.map(s => `${esc(s.pos)} ${meanHTML(s.mean)}`).join("；")}</span>`).join("")}</div>` : ""}
      ${go ? `<button class="pkgo" data-pkgo="${esc(e.word)}">跳到这张卡 ↓</button>` : ""}</div></li>`;
/* src：别的页面借这个浮层用（学习新词）：{g 词群, map 词条查表, rows 词表各行 HTML, tab 词表标签后缀, masked 遮住释义（点了只读音）, say(w) 读音}；课文页不传 */
let peekSrc = null;
function openPeek(src = null) {
  let g, map, rows, tab, note;
  if (src) ({g, map, rows, tab} = src), note = src.masked ? "这题答完再看释义；现在点词只读音" : "点一行展开记忆法、读一遍";
  else {
    const sec = L && currentGroup(); if (!sec) return;
    g = L.groups.find(x => x.no === +sec.dataset.g); map = WORDMAP;
    const here = readingCard(sec), hi = here ? g.entries.findIndex(e => e.word === here.dataset.word) : -1;
    rows = g.entries.map((e, i) => peekRow(e, i < hi ? " read" : i === hi ? " here" : "", i === hi ? `<span class="pkhere">▸ 读到这</span>` : "")).join("");
    tab = hi >= 0 ? ` · 读到 ${hi + 1}/${g.entries.length}` : "";
    note = `${S.mask ? "背诵模式：点一行看释义" : "点一行展开记忆法、读一遍"}；课文不会动，「跳到这张卡」才过去`;
  }
  peekSrc = src;
  peek.classList.toggle("lmask", !!(src && src.masked));
  peek.innerHTML = `<div class="pkbar"><b>词以群记 ${g.no}</b><span>${esc(g.title)}</span><button class="icon" id="peekClose" aria-label="关闭" title="关闭（Esc）">✕</button></div>
    <div class="pktabs seg"><button data-pktab="map">导图</button><button data-pktab="list">词表${tab}</button></div>
    <div class="pkbody">
      <div class="pkpane" data-pane="map"><div class="mapbox pkmap">${mapHTML(g.map, true, map)}${mapCompact(g.map, map)}</div>
        <p class="pknote">${src && src.masked ? "这题答完再看释义；现在点词只读音" : `点导图里的词，下面显示它的释义${src ? "" : "；课文不会动"}`}</p></div>
      <div class="pkpane" data-pane="list"><p class="pknote">${note}</p>
        <ol class="pklist">${rows}</ol></div></div>
    <ol class="pkfoot" hidden></ol>`;
  peek.classList.add("open"); $("#peekScrim").classList.add("open"); (src ? $("#lpFab") : $("#peekFab"))?.classList.add("on");
  setPeekTab(store.get("peekTab", "list"));
  /* 词表长、读到的那行在下面看不见时，滚到它，让前面读过的几行露出来 */
  const h = peek.querySelector(".pk.here"), body = peek.querySelector(".pkbody");
  if (h && h.offsetTop + h.offsetHeight > body.clientHeight) body.scrollTop = h.offsetTop - body.clientHeight * 0.6;
}
function setPeekTab(v) {
  store.set("peekTab", v);
  $$("[data-pktab]", peek).forEach(b => b.classList.toggle("on", b.dataset.pktab === v));
  $$(".pkpane", peek).forEach(p => { p.hidden = p.dataset.pane !== v; });
  if (v !== "map") { peek.querySelector(".pkfoot").hidden = true; return; }
  /* 树形导图在浮层里放不下，换成手机版的紧凑导图（导图显示出来才量得到宽度） */
  const box = peek.querySelector(".pkmap"), mm = box.querySelector(".mm");
  if (mm && mm.offsetParent !== null && mm.offsetWidth > box.clientWidth - 20) box.classList.add("compact");
}
/* 导图里点的词：底部显示它所在词条的释义（扩展词就标出那一行），读一遍 */
const peekSay = w => { if (peekSrc) peekSrc.say(w); else { stopMarathon(); speak(w); } };
function peekFoot(w) {
  const hit = (peekSrc ? peekSrc.map : WORDMAP).get(w); if (!hit) return;
  if (peekSrc && peekSrc.masked) { peekSay(w); return; }
  const foot = peek.querySelector(".pkfoot");
  foot.innerHTML = peekRow(hit.entry, " open", "", !peekSrc); foot.hidden = false;
  if (hit.ext) foot.querySelector(`[data-pkext="${CSS.escape(w)}"]`)?.classList.add("hit");
  peekSay(w);
}
function closePeek() {
  if (!peekOpen()) return;
  peek.classList.remove("open"); $("#peekScrim").classList.remove("open"); $("#peekFab").classList.remove("on"); $("#lpFab")?.classList.remove("on");
}
const togglePeek = () => (peekOpen() ? closePeek() : openPeek());
$("#peekFab").onclick = togglePeek;
$("#peekScrim").onclick = closePeek;
peek.addEventListener("click", e => {
  const t = e.target;
  if (t.closest("#peekClose")) { closePeek(); return; }
  const go = t.closest("[data-pkgo]"); if (go) { closePeek(); gotoWord(go.dataset.pkgo); return; }
  const tab = t.closest("[data-pktab]"); if (tab) { setPeekTab(tab.dataset.pktab); return; }
  const node = t.closest("[data-goto]"); if (node) { peekFoot(node.dataset.goto); return; }
  if (t.closest(".pkfoot")) return;
  const row = t.closest(".pk");
  if (!row) return;
  if (peekSrc && peekSrc.masked) { peekSay(row.dataset.pk); return; }
  const open = !row.classList.contains("open"); row.classList.toggle("open", open); if (open) peekSay(row.dataset.pk);
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && peekOpen()) { closePeek(); e.stopImmediatePropagation(); return; }   // 不让巩固页的 Esc 同时生效
  if ((e.key === "m" || e.key === "M") && !e.ctrlKey && !e.metaKey && !e.altKey && !$("#lessonView").hidden &&
      !(e.target.closest && e.target.closest("input,select,textarea"))) togglePeek();
});

/* ---------- 搜索 ---------- */
const qres = $("#qres");
$("#q").addEventListener("input", () => {
  const q = $("#q").value.trim().toLowerCase();
  if (!q) { qres.style.display = "none"; return; }
  const hits = Object.entries(BOOK.search).filter(([w]) => w.startsWith(q)).slice(0, 30);
  qres.innerHTML = hits.length ? hits.map(([w, [lid, no, ext]]) => {
    const [, u, l] = lid.match(/u(\d+)-l(\d+)/);
    return `<a href="#/${lid}/w/${encodeURIComponent(w)}">${esc(w)} <small>U${+u} L${+l} #${no}${ext ? " 扩展" : ""}</small></a>`;
  }).join("") : `<a><small>已生成的课里没有「${esc(q)}」</small></a>`;
  qres.style.display = "block";
});
$("#q").addEventListener("keydown", e => { if (e.key === "Enter") { const a = qres.querySelector("a[href]"); if (a) { location.hash = a.getAttribute("href"); qres.style.display = "none"; } } });
qres.addEventListener("click", () => { qres.style.display = "none"; $("#q").blur(); });

/* ---------- 别的设备的改动同步过来：刷新已会和设置；别处读到了更新的位置就跟过去 ---------- */
function toast(msg) {
  const el = $("#toast"); el.textContent = msg; el.classList.add("on");
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("on"), 3000);
}
Sync.on(changed => {
  loadKnown(); loadSettings(); applySettings(); applySide();
  if (!BOOK) return;
  const ready = BOOK.parts.flatMap(p => p.units.flatMap(u => u.lessons)).filter(l => l.ready);
  const last = store.get("last");
  const moved = ready.some(l => l.id === last) && (changed.includes("last") || changed.includes("pos:" + last));
  if (location.hash === "#/settings") { renderSettings(); renderDrawer(); return; }
  if (!$("#studyView").hidden) { Study.refresh(); return; }   // 首页、巩固不跟着别处的阅读位置跳
  if (moved) {
    const [, u, l] = last.match(/u(\d+)-l(\d+)/);
    toast(`已接上其他设备的进度：Unit ${+u} · Lesson ${+l}`);
    if (L && L.id === last) { renderLesson(); restorePos(last); }
    else location.hash = "#/" + last;
  } else if (L) { const y = scrollY; renderLesson(); scrollTo(0, y); }
});

/* ---------- 启动 ---------- */
applySettings();
window.addEventListener("hashchange", route);
fetchJSON("data/book.json").then(b => { BOOK = b; renderDrawer(); return route(); })
  .then(() => Sync.start()).then(() => { posReady = true; })
  .catch(err => { $("#groups").innerHTML = `<p class="empty">数据加载失败：${esc(err.message)}<br>请用本地服务器打开（见 README），不要直接双击 HTML。</p>`; });
