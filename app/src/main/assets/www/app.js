// ===== 围棋教练 App 主逻辑 =====
"use strict";
const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem("gc_" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("gc_" + k, JSON.stringify(v)); } catch (e) {} }
};

// ---------- 配置 ----------
const DEF = { base: "http://121.37.208.141:8317/v1", key: "", model: "deepseek-v4.1-flash" };   // Key 不写进代码，在 App 菜单里填
const cfg = Object.assign({ mode: "ai", size: 9, hcp: 0, visits: 60, tts: false, levelMode: "auto" }, DEF, store.get("cfg", {}));
for (const k of ["base", "model"]) if (!cfg[k]) cfg[k] = DEF[k];
const saveCfg = () => store.set("cfg", cfg);

const RANKS = [];
for (let k = 20; k >= 1; k--) RANKS.push("rank_" + k + "k");
for (let d = 1; d <= 9; d++) RANKS.push("rank_" + d + "d");
const rankName = r => r.endsWith("k") ? r.slice(5, -1) + " 级" : "业余 " + r.slice(5, -1) + " 段";
const levels = store.get("levels", {});            // { "9": {idx, w, l} }
function levelOf(N) { if (!levels[N]) levels[N] = { idx: RANKS.indexOf("rank_13k"), w: 0, l: 0 }; return levels[N]; }

// ---------- 原生桥（App 内）/ 测试替身（浏览器内） ----------
const cbs = {}; let cbSeq = 0;
window.__nativeCb = (id, payload) => { const f = cbs[id]; delete cbs[id]; if (f) f(payload); };
function nativeCall(fn, ...args) {
  return new Promise(res => { const id = "c" + (++cbSeq); cbs[id] = res; window.Native[fn](...args, id); });
}
const hasNative = () => !!window.Native;

async function engineRaw(query) {
  let txt;
  if (hasNative()) txt = await nativeCall("analyze", JSON.stringify(query));
  else if (window.TEST_ENGINE) txt = await (await fetch(window.TEST_ENGINE, { method: "POST", body: JSON.stringify(query) })).text();
  else throw new Error("没有引擎");
  const j = JSON.parse(txt);
  if (j && j.error) throw new Error(j.error);
  return j;
}

async function httpPost(url, headers, body) {
  if (hasNative()) {
    const r = JSON.parse(await nativeCall("http", url, JSON.stringify(headers), body));
    if (!r.status) throw new Error(r.error || "网络不通");
    return { status: r.status, text: r.body };
  }
  const res = await fetch(url, { method: "POST", headers, body });
  return { status: res.status, text: await res.text() };
}

// ---------- 引擎状态 ----------
let engineState = { ready: false, backend: "", text: "引擎准备中…" };
window.__engineStatus = s => { try { engineState = JSON.parse(s); } catch (e) {} showEngine(); };
function showEngine() {
  const bar = $("engineBar");
  if (!hasNative() && !window.TEST_ENGINE) { bar.hidden = false; bar.textContent = "（浏览器预览：没有本地引擎）"; return; }
  if (window.TEST_ENGINE) { engineState = { ready: true, backend: "测试", text: "测试引擎" }; }
  bar.hidden = engineState.ready;
  bar.textContent = engineState.text;
  $("engineInfo").textContent = engineState.ready ? `已就绪 · ${engineState.backend === "GPU" ? "GPU 加速" : engineState.backend === "CPU" ? "CPU（较慢）" : engineState.backend}` : engineState.text;
}
if (hasNative()) { try { window.__engineStatus(window.Native.engineStatus()); } catch (e) {} }

// ---------- 对局状态 ----------
let go, st, epoch = 0, busy = false, cards = [], hints = [], cache = new Map(), cardSeq = 0;

function newState(mode, N, hcp) {
  go = makeGo(N);
  const s = {
    mode, N, hcp, board: new Array(N * N).fill(EMPTY), toMove: B, prev: null, last: null, passes: 0,
    caps: { 1: 0, 2: 0 }, komi: hcp ? 0.5 : (N === 9 ? 7 : 7.5), seq: [], snaps: [], over: false,
    hcpStones: hcp ? go.handicap(hcp) : [], stats: { B: {}, W: {} }, notes: [], lastWr: null, aiLowCount: 0,
    rank: RANKS[levelOf(N).idx], started: Date.now()
  };
  for (const n of s.hcpStones) s.board[go.parse(n)] = B;
  if (hcp) s.toMove = W;
  return s;
}

const LABEL = () => st.mode === "ai" ? { B: "学生的黑棋", W: "老师的白棋" } : { B: "黑方", W: "白方" };
const WHO = c => st.mode === "ai" ? (c === B ? "你" : "老师") : (c === B ? "黑方" : "白方");

function saveGame() {
  const { snaps, ...rest } = st;
  store.set("game", { ...rest, cards: cards.slice(0, 6) });
}

function snapshot() { return JSON.stringify({ board: st.board, toMove: st.toMove, prev: st.prev, last: st.last, passes: st.passes, caps: st.caps, seq: st.seq, stats: st.stats, notes: st.notes }); }

function apply(c, p) {
  const before = st.board.slice();
  const r = go.tryPlay(st, c, p);
  if (!r.ok) return r;
  st.snaps.push(snapshot());
  st.prev = before.join("");
  st.board = r.board; st.caps[c] += r.captured.length;
  st.last = p; st.seq.push([colorName(c), go.name(p)]);
  st.passes = p < 0 ? st.passes + 1 : 0;
  st.toMove = opp(c);
  r.before = before;
  return r;
}

// ---------- 分析与缓存 ----------
function posQuery(seq, rank) {
  return {
    moves: seq, initialStones: st.hcpStones.map(s => ["B", s]), rules: "chinese", komi: st.komi,
    boardXSize: st.N, boardYSize: st.N, analyzeTurns: [seq.length], maxVisits: +cfg.visits || 60,
    includePolicy: true,
    overrideSettings: { humanSLProfile: rank, ignorePreRootHistory: false, rootNumSymmetriesToSample: 2 }
  };
}
function summarize(r) {
  const N = st.N, root = r.rootInfo || {};
  const moves = (r.moveInfos || []).slice().sort((a, b) => a.order - b.order).map(m => ({
    move: m.move, wr: m.winrate, lead: m.scoreLead, visits: m.visits, pv: (m.pv || []).slice(0, 8)
  }));
  return { wr: root.winrate, lead: root.scoreLead, moves, human: r.humanPolicy || null, N };
}
function analyzePos(seq, rank) {
  const key = JSON.stringify([seq, st.hcpStones, st.komi, st.N, rank || st.rank, cfg.visits]);
  if (!cache.has(key)) {
    const pr = engineRaw(posQuery(seq, rank || st.rank)).then(a => summarize(a[0]));
    pr.catch(() => cache.delete(key));
    cache.set(key, pr);
    if (cache.size > 80) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}

// 从人类棋风模型的概率里抽一手（最像这个段位的人）
function sampleHuman(a) {
  const N = st.N, legalPts = [];
  const top = a.moves[0] && a.moves[0].move;
  if (top === "pass") return -1;
  if (!a.human) return a.moves.length ? go.parse(a.moves[0].move) : -1;
  let total = 0;
  for (let i = 0; i < N * N; i++) {
    const p = a.human[i];
    if (p > 0.001 && go.legal(st, st.toMove, i)) { legalPts.push([i, p]); total += p; }
  }
  if (!legalPts.length) return -1;
  let r = Math.random() * total;
  for (const [i, p] of legalPts) { r -= p; if (r <= 0) return i; }
  return legalPts[legalPts.length - 1][0];
}

// ---------- 招式等级 ----------
const TIERS = {
  god: { name: "神之一手", cls: "t-god", card: "c-god", good: true, rank: 4 },
  myo: { name: "妙手", cls: "t-myo", card: "c-myo", good: true, rank: 3 },
  tesuji: { name: "手筋", cls: "t-tesuji", card: "c-tesuji", good: true, rank: 2 },
  good: { name: "好棋", cls: "t-good", card: "", good: true, rank: 1 },
  plain: { name: "", cls: "", card: "", rank: 0 },
  slow: { name: "缓手", cls: "t-slow", card: "", bad: true, rank: -1 },
  vulgar: { name: "俗手", cls: "t-vulgar", card: "", bad: true, rank: -2 },
  bad: { name: "恶手", cls: "t-bad", card: "c-bad", bad: true, rank: -3 },
  lose: { name: "败着", cls: "t-lose", card: "c-lose", bad: true, rank: -4 }
};

function classify(before, after, p, c) {
  const N = st.N, sign = c === B ? 1 : -1, mv = go.name(p);
  const scale = N === 9 ? 0.8 : N === 13 ? 0.9 : 1;
  const lossPts = sign * (before.lead - after.lead);
  const myWrBefore = c === B ? before.wr : 1 - before.wr, myWrAfter = c === B ? after.wr : 1 - after.wr;
  const idx = before.moves.findIndex(m => m.move === mv);
  const best = before.moves[0];
  const humanProb = before.human ? before.human[p < 0 ? N * N : p] : null;
  const solid = before.moves.filter(m => m.visits >= 2);
  let gapWr = 0, gapPts = 0;
  if (solid.length >= 2 && solid[0].move === mv) {
    gapWr = sign * (solid[0].wr - solid[1].wr);
    gapPts = sign * (solid[0].lead - solid[1].lead);
  }
  const isBest = idx === 0 || lossPts <= 0.4 * scale;
  let tier = "plain";
  if (p >= 0 && isBest && humanProb != null && idx === 0) {
    if (humanProb < 0.003 && (gapWr >= 0.25 || gapPts >= 8 * scale)) tier = "god";
    else if (humanProb < 0.02 && (gapWr >= 0.10 || gapPts >= 4 * scale)) tier = "myo";
    else if (humanProb < 0.08 && (gapWr >= 0.05 || gapPts >= 2 * scale)) tier = "tesuji";
    else tier = "good";
  } else if (p >= 0 && isBest) tier = "good";
  if (myWrBefore >= 0.6 && myWrAfter <= 0.4 && lossPts >= 2 * scale) tier = "lose";
  else if (lossPts >= 8 * scale) tier = "bad";
  else if (lossPts >= 4 * scale && humanProb != null && humanProb >= 0.12) tier = "vulgar";
  else if (lossPts >= 3 * scale) tier = "slow";
  return { tier, lossPts, myWrBefore, myWrAfter, humanProb, best: best ? best.move : null, bestPv: best ? best.pv : [], idx };
}

// ---------- 老师（大模型） ----------
// 模型偶尔不按 JSON 回答，或在 JSON 外面包一层文字/代码块：尽量解析，实在不行就当纯文字
function parseLoose(txt) {
  const t = String(txt || "").trim();
  try { return JSON.parse(t); } catch (e) {}
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return { text: t.replace(/^```\w*|```$/g, "").trim(), cards: [] };
}
async function callLLM(messages, json) {
  let url = (cfg.base || DEF.base).trim().replace(/\/+$/, "");
  if (!/\/chat\/completions$/.test(url)) url += "/chat/completions";
  const body = JSON.stringify({ model: cfg.model, messages, temperature: 0.3, ...(json ? { response_format: { type: "json_object" } } : {}) });
  const r = await httpPost(url, { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.key }, body);
  if (r.status >= 400) throw new Error("接口返回 " + r.status);
  const j = JSON.parse(r.text);
  return j.choices[0].message.content;
}

const TERM_LIST = "打吃、提、长、立、爬、挡、扳、断、粘、虎、双、尖、跳、小飞、大飞、象步、拆、靠、碰、托、顶、挤、夹、点、刺、镇、压、挂角、守角、征子、枷、扑、倒扑、门吃、抱吃、双打吃、做眼、破眼、劫、渡、退、补、星位、小目、三三";

function sysPrompt() {
  const who = st.mode === "ai"
    ? "你是围棋教练，在和学生下指导棋。学生执黑，你执白。说话时黑棋叫\"你\"，白棋叫\"我\"。"
    : "你是围棋教练，在旁边看两位学生对局。称呼\"黑方\"\"白方\"。";
  return `${who}
${st.N} 路棋盘，学生水平约${rankName(st.rank)}。坐标：字母是列，A 在最左；数字是行，1 在最下面。

你的任务是写"招式卡"，把程序给的事实翻译成大白话。最重要的规则：
1. 只说事实里写到的东西。事实里没写的棋子、气数、死活、吃子、切断、目数，一律不说，也不要自己推算。
2. 位置只用事实里的方位词（如"右下角""3 线"），不要自己判断方位。
3. term 直接用事实里"招式名"那一项；没有给招式名时，再从常见术语里选一个最贴切的（${TERM_LIST}）。
4. reason / effect / advice 每句不超过 20 个字，说人话，不说空话套话：
   - 好棋：effect 说它具体起了什么作用（来自事实）。
   - 坏棋：reason 说亏在哪里（依据"引擎认为更好的是…"推断方向，例如"该先补自己的棋"），advice 给方向，不说坐标。
   - 普通的一手：只写 effect，其余留空。
   - 我（老师）的棋：effect 说我的打算，可参考"引擎预计的后续"。
5. 如果 term 不在"学生已学过的术语"里，newTerm 用不超过 18 字解释它；否则留空。
6. 语气轻松，像朋友在旁边指点，不说"非常好""加油"这类空话。`;
}

function moveFactsText(cardObj) {
  const c = cardObj.color, a = cardObj.cls;
  const lines = [`第 ${cardObj.moveNo} 手：${WHO(c)}（${c === B ? "黑" : "白"}）下在 ${cardObj.pos}`];
  if (cardObj.where) lines.push(`位置：${cardObj.where}`);
  if (cardObj.autoTerm) lines.push(`招式名（程序按棋形算出，直接用）：${cardObj.autoTerm}`);
  if (cardObj.rel && cardObj.rel.length) lines.push(`棋形关系：${cardObj.rel.join("；")}`);
  lines.push(...(cardObj.local || []));
  if (a) {
    const t = TIERS[a.tier];
    lines.push(`引擎评价：${t.name || "普通的一手"}；${a.lossPts >= 0.05 ? "亏了约 " + a.lossPts.toFixed(1) + " 目" : a.lossPts <= -0.05 ? "赚了约 " + (-a.lossPts).toFixed(1) + " 目" : "几乎不亏"}`);
    lines.push(`${WHO(c)}的胜率：${Math.round(a.myWrBefore * 100)}% → ${Math.round(a.myWrAfter * 100)}%`);
    if (a.idx !== 0 && a.best && a.best !== "pass") {
      const bp = go.parse(a.best);
      lines.push(`引擎认为更好的是 ${a.best}（${bp >= 0 ? go.where(bp).text : ""}），后续 ${a.bestPv.slice(0, 5).join(" ")}。只能用来解释"为什么亏"，不要把坐标说出来`);
    }
    if (a.humanProb != null) lines.push(`${rankName(st.rank)}的人约 ${(a.humanProb * 100).toFixed(0)}% 会下这里`);
  }
  if (cardObj.plan && cardObj.plan.length) lines.push(`这手之后引擎预计的后续：${cardObj.plan.join(" ")}（可用来说"我的打算"）`);
  return lines.join("\n");
}

function recentRecord() {
  const s = st.seq.slice(-40);
  const off = st.seq.length - s.length;
  return s.map((m, i) => `${off + i + 1}.${m[0] === "B" ? "黑" : "白"}${m[1]}`).join(" ");
}

async function teach(cardList) {
  const e = epoch;
  if (!cfg.key) { cardList.forEach(fallbackText); render(); return; }
  const terms = Object.keys(store.get("terms", {}));
  const user = `棋盘（x=黑 o=白，大写为最后一手）：\n${go.boardText(st.board, st.last)}
${(() => { const l = go.stoneList(st.board); return `黑子：${l.b.join(" ") || "无"}\n白子：${l.w.join(" ") || "无"}`; })()}\n棋谱（最近）：${recentRecord() || "无"}${st.hcpStones.length ? `\n让子：黑先摆 ${st.hcpStones.join(" ")}` : ""}
学生已学过的术语：${terms.join("、") || "无"}

要写招式卡的棋：
${cardList.map((c, i) => `【卡${i + 1}】\n${moveFactsText(c)}`).join("\n\n")}

返回 JSON：{"cards":[{"term":"","newTerm":"","reason":"","effect":"","advice":""}，按卡的顺序，共 ${cardList.length} 张],"hints":[{"pos":"坐标","color":"B或W","n":序号}]}
hints 是建议里想在棋盘上用半透明棋子演示的点，最多 3 个，可以为空数组。`;
  try {
    const out = parseLoose(await callLLM([{ role: "system", content: sysPrompt() }, { role: "user", content: user }], true));
    (out.cards || []).forEach((oc, i) => {
      const c = cardList[i]; if (!c) return;
      c.term = c.autoTerm || clean(oc.term).slice(0, 6) || "落子";
      c.reason = clean(oc.reason); c.effect = clean(oc.effect); c.advice = clean(oc.advice);
      const known = !!store.get("terms", {})[c.term];
      c.newTermFlag = !known && c.term !== "落子";
      if (c.term !== "落子") addTerm(c.term, oc.newTerm ? clean(oc.newTerm) : null, c);
      c.done = true;
    });
    cardList.forEach(c => { if (!c.done) fallbackText(c); });
    if (e === epoch && Array.isArray(out.hints) && out.hints.length) setHints(out.hints.slice(0, 3).map(h => ({ p: go.parse(h.pos), c: h.color === "W" ? W : B, n: h.n })).filter(h => h.p != null && h.p >= 0 && st.board[h.p] === EMPTY));
  } catch (err) {
    cardList.forEach(c => { fallbackText(c); c.netErr = err.message; });
  }
  st.notes = [...st.notes, ...cardList.map(c => `${WHO(c.color)}${c.pos}【${c.term}】${c.effect || c.reason || ""}`)].slice(-6);
  render();
  speakCards(cardList);
  saveGame();
}
const clean = s => String(s || "").replace(/[黑白]棋/g, m => st.mode === "ai" ? (m === "黑棋" ? "你的棋" : "我的棋") : (m === "黑棋" ? "黑方" : "白方")).trim();

function fallbackText(c) {
  c.done = true;
  if (!c.term) c.term = c.autoTerm || "落子";
  const a = c.cls;
  if (a) {
    const t = TIERS[a.tier];
    if (t.bad) { c.reason = `这手亏了约 ${Math.abs(a.lossPts).toFixed(1)} 目`; c.advice = "点“看正解”看看更好的下法"; }
    else if (t.good) c.effect = t.rank >= 2 ? "又好又难想到的一手！" : "这手下得不错";
  }
  if (!c.effect && !c.reason) c.effect = c.local[0] || "";
}

// ---------- 术语本 ----------
function addTerm(term, explain, c) {
  const terms = store.get("terms", {});
  const t = terms[term] || { explain: "", count: 0, ex: null };
  if (explain && !t.explain) t.explain = explain;
  t.count++;
  if (!t.ex && c.p >= 0) t.ex = { N: st.N, b: st.board.join(""), p: c.p, c: c.color };
  terms[term] = t;
  store.set("terms", terms);
}

function miniBoard(ex) {
  const N = ex.N, x0 = ex.p % N, y0 = (ex.p / N) | 0, R = N <= 9 ? 4 : 3;
  const xa = Math.max(0, Math.min(N - 1 - 2 * R, x0 - R)), ya = Math.max(0, Math.min(N - 1 - 2 * R, y0 - R));
  const span = Math.min(N - 1, 2 * R), step = 80 / span, c = i => 10 + i * step;
  let h = "";
  for (let i = 0; i <= span; i++) {
    h += `<line x1="${c(0)}" y1="${c(i)}" x2="${c(span)}" y2="${c(i)}" stroke="var(--grid)" stroke-width=".6"/>`;
    h += `<line x1="${c(i)}" y1="${c(0)}" x2="${c(i)}" y2="${c(span)}" stroke="var(--grid)" stroke-width=".6"/>`;
  }
  for (let y = 0; y <= span; y++) for (let x = 0; x <= span; x++) {
    const p = (ya + y) * N + xa + x, v = +ex.b[p];
    if (v) h += `<circle cx="${c(x)}" cy="${c(y)}" r="${step * .46}" fill="${v === B ? "#1d1b19" : "#f7f4ee"}" stroke="${v === B ? "#000" : "#8a8070"}" stroke-width=".5"/>`;
    if (p === ex.p) h += `<circle cx="${c(x)}" cy="${c(y)}" r="${step * .2}" fill="none" stroke="#c0392b" stroke-width="1.6"/>`;
  }
  return `<svg viewBox="0 0 100 100">${h}</svg>`;
}

function showTerms() {
  const terms = store.get("terms", {});
  const keys = Object.keys(terms).sort((a, b) => terms[b].count - terms[a].count);
  $("bookTitle").textContent = `术语本（${keys.length}）`;
  $("bookBody").innerHTML = keys.length ? keys.map(k => {
    const t = terms[k];
    return `<div class="term">${t.ex ? miniBoard(t.ex) : ""}<div><div class="tname">${esc(k)}</div><div class="texp">${esc(t.explain || "（老师还没解释过）")}</div><div class="tcount">出现过 ${t.count} 次</div></div></div>`;
  }).join("") : `<div class="empty">还没有术语。下几手棋，老师用到的术语会自动收进来。</div>`;
  $("book").hidden = false;
}

function showStats() {
  const career = store.get("career", { games: 0, wins: 0, tiers: {} });
  const order = ["god", "myo", "tesuji", "good", "slow", "vulgar", "bad", "lose"];
  $("bookTitle").textContent = "我的战绩";
  const lv = [9, 13, 19].map(n => `<div class="stat">${n} 路对手<b style="font-size:15px">${rankName(RANKS[levelOf(n).idx])}</b></div>`).join("");
  $("bookBody").innerHTML = `
    <div class="stat-grid">
      <div class="stat">人机对局<b>${career.games}</b></div>
      <div class="stat">胜<b>${career.wins}</b></div>
      ${lv}
    </div>
    <h3>我打出过的招式</h3>
    <div class="stat-grid">${order.map(k => `<div class="stat">${TIERS[k].name}<b>${career.tiers[k] || 0}</b></div>`).join("")}</div>`;
  $("book").hidden = false;
}

// ---------- 朗读 ----------
function speak(t) {
  if (!cfg.tts || !t) return;
  if (hasNative()) { try { window.Native.speak(t); } catch (e) {} return; }
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(t); u.lang = "zh-CN"; speechSynthesis.speak(u);
  } catch (e) {}
}
function speakCards(list) {
  const say = c => {
    const t = TIERS[c.cls ? c.cls.tier : "plain"];
    return `${WHO(c.color)}，${c.term}${t.name ? "，" + t.name : ""}。${c.reason || ""}${c.effect || ""}${c.advice || ""}`;
  };
  speak(list.map(say).join("。").replace(/([A-T])(\d+)/g, "$1 $2"));
}

// ---------- 棋盘绘制 ----------
function setHints(h) { hints = h; renderBoard(); }
function renderBoard() {
  const N = st.N, M = N <= 9 ? 8.5 : N <= 13 ? 6.5 : 4.8, step = (100 - 2 * M) / (N - 1), svg = $("board");
  const c = i => M + i * step, fs = N <= 9 ? 2.6 : N <= 13 ? 2.1 : 1.6;
  let h = "";
  for (let i = 0; i < N; i++) {
    h += `<line x1="${c(0)}" y1="${c(i)}" x2="${c(N - 1)}" y2="${c(i)}" stroke="var(--grid)" stroke-width="${N <= 9 ? .3 : .22}"/>`;
    h += `<line x1="${c(i)}" y1="${c(0)}" x2="${c(i)}" y2="${c(N - 1)}" stroke="var(--grid)" stroke-width="${N <= 9 ? .3 : .22}"/>`;
    h += `<text x="${c(i)}" y="${M * .45 + fs * .35}" font-size="${fs}" text-anchor="middle" fill="var(--grid)" opacity=".65">${go.COLS[i]}</text>`;
    h += `<text x="${M * .45}" y="${c(i) + fs * .35}" font-size="${fs}" text-anchor="middle" fill="var(--grid)" opacity=".65">${N - i}</text>`;
  }
  for (const [x, y] of go.hoshi()) h += `<circle cx="${c(x)}" cy="${c(y)}" r="${N <= 9 ? .9 : .6}" fill="var(--grid)"/>`;
  const r = step * .47;
  const bd = st.viewBoard || st.board, lastP = st.viewBoard ? st.viewLast : st.last;
  for (let p = 0; p < N * N; p++) {
    const x = c(p % N), y = c((p / N) | 0), v = bd[p];
    if (v) {
      h += `<circle cx="${x}" cy="${y}" r="${r}" fill="${v === B ? "#1d1b19" : "#f7f4ee"}" stroke="${v === B ? "#000" : "#8a8070"}" stroke-width=".25"/>`;
      if (p === lastP) h += `<circle cx="${x}" cy="${y}" r="${step * .18}" fill="none" stroke="${v === B ? "#f7f4ee" : "#1d1b19"}" stroke-width="${N <= 9 ? .6 : .4}"/>`;
    }
  }
  for (const t of hints) {
    if (t.p == null || t.p < 0) continue;
    const x = c(t.p % N), y = c((t.p / N) | 0);
    h += `<circle cx="${x}" cy="${y}" r="${r}" fill="${t.c === B ? "#1d1b19" : "#f7f4ee"}" fill-opacity=".45" stroke="${t.flash ? "#c0392b" : t.c === B ? "#000" : "#8a8070"}" stroke-width="${t.flash ? .8 : .25}" stroke-dasharray="${t.flash ? "" : "1 .6"}"/>`;
    if (t.n) h += `<text x="${x}" y="${y + r * .38}" font-size="${r * 1.05}" text-anchor="middle" font-weight="700" fill="${t.c === B ? "#fff" : "#1d1b19"}">${t.n}</text>`;
  }
  for (let p = 0; p < N * N; p++) {
    const x = c(p % N), y = c((p / N) | 0);
    h += `<rect data-p="${p}" x="${x - step / 2}" y="${y - step / 2}" width="${step}" height="${step}" fill="transparent"/>`;
  }
  svg.innerHTML = h;
}

// ---------- 界面 ----------
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
const linkCoords = s => esc(s).replace(/\b([A-HJ-T])(1[0-9]|[1-9])\b/g, (m) => go.parse(m) != null ? `<span class="coord" data-pos="${m}">${m}</span>` : m);

function renderCards() {
  const box = $("cards");
  // 最新的卡放在最下面，紧挨着棋盘
  const shown = cards.slice(0, 6);
  const fullN = st.mode === "ai" ? 2 : 1;
  let fullLeft = fullN;
  box.innerHTML = shown.map((c, i) => {
    const t = TIERS[c.cls ? c.cls.tier : "plain"];
    const isMsg = c.p === -2;
    const full = !isMsg && fullLeft > 0 && (fullLeft--, true);
    if (isMsg) return `<div class="msg-line ${c.fresh ? "flash" : ""}">${linkCoords(c.effect)}</div>`;
    if (!full) {
      const one = c.effect || c.reason || c.advice || "";
      return `<div class="card mini ${t.card}" data-id="${c.id}">
        <span class="who ${c.color === B ? "b" : "w"}">${WHO(c.color)}</span>
        <span class="skill-s">${c.done ? "【" + esc(c.term) + "】" : "……"}</span><span class="pos">${c.pos === "pass" ? "停" : c.pos}</span>
        ${t.name ? `<span class="tier ${t.cls}">${t.name}</span>` : ""}
        <span class="one">${esc(one)}</span>
      </div>`;
    }
    const lines = c.done
      ? [["原因", c.reason], ["作用", c.effect], ["建议", c.advice]].filter(x => x[1]).map(x => `<div><b>${x[0]}</b>${linkCoords(x[1])}</div>`).join("")
      : `<div class="wait">${c.cls ? "老师在想怎么讲…" : "引擎在看这手…"}</div>`;
    const facts = c.cls ? `${c.cls.lossPts >= 0.05 ? "亏" : c.cls.lossPts <= -0.05 ? "赚" : "差不多"} ${Math.abs(c.cls.lossPts).toFixed(1)} 目 · 胜率 ${Math.round(c.cls.myWrAfter * 100)}%` : "";
    const canSolve = c.cls && c.cls.idx !== 0 && c.cls.best && c.cls.best !== "pass";
    return `<div class="card ${t.card} ${c.fresh ? "flash" : ""}" data-id="${c.id}">
      <div class="card-head">
        <span class="who ${c.color === B ? "b" : "w"}">${WHO(c.color)}</span>
        <span class="skill ${c.done ? "" : "pending"}">${c.done ? "【" + esc(c.term) + "】" : "……"}</span>
        ${c.done && c.newTermFlag ? `<span class="new-term" data-term="${esc(c.term)}">新</span>` : ""}
        <span class="pos">${c.pos === "pass" ? "停一手" : c.pos}</span>
        ${t.name ? `<span class="tier ${t.cls}">${t.name}</span>` : ""}
      </div>
      <div class="lines">${lines}</div>
      <div class="foot">${facts ? `<span class="facts">${facts}${c.netErr ? " · 老师离线" : ""}</span>` : ""}
        ${canSolve ? `<button data-solve="${c.id}">看正解</button>` : ""}${c.done ? `<button data-ask="${c.id}">问这手</button>` : ""}</div>
    </div>`;
  }).reverse().join("");
  box.scrollTop = box.scrollHeight;
  cards.forEach(c => c.fresh = false);
}

function renderStatus() {
  const lv = rankName(st.rank);
  $("modeLine").textContent = `${st.N}路·${st.mode === "ai" ? lv.replace(" ", "") : "双人"}${st.hcp ? "·让" + st.hcp : ""}`;
  let s;
  if (st.over) s = "已终局";
  else if (st.viewBoard) s = "老师在讲解…";
  else if (busy) s = "老师在想…";
  else if (st.mode === "ai") s = st.toMove === B ? "轮到你" : "老师在想…";
  else s = st.toMove === B ? "轮到黑方" : "轮到白方";
  $("status").textContent = `${s} · 提${st.caps[1]}:${st.caps[2]}`;
  $("btnUndo").disabled = busy || !st.snaps.length;
  $("btnPass").disabled = busy || st.over;
  $("btnResign").disabled = busy || st.over;
}

function renderEval() {
  if (st.lastWr == null) { $("eval").innerHTML = ""; return; }
  const wr = st.lastWr, lead = st.lastLead;
  const lbl = st.mode === "ai" ? `你的胜率 ${Math.round(wr * 100)}%` : `黑 ${Math.round(wr * 100)}% : 白 ${100 - Math.round(wr * 100)}%`;
  const ld = lead >= 0 ? `黑领先 ${lead.toFixed(1)} 目` : `白领先 ${(-lead).toFixed(1)} 目`;
  $("eval").innerHTML = `<span>${lbl}</span><span class="bar-wr"><i style="width:${Math.round(wr * 100)}%"></i></span><span>${ld}</span>`;
}

function render() { renderBoard(); renderCards(); renderStatus(); renderEval(); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
// 程序算出的这一手的事实：局部战斗、位置、形状和招式名
function factsFor(r, p, color) {
  const sh = go.shape(r.before, st.board, p, color, r.captured || []);
  return {
    local: go.localFacts(r.before, st.board, p, color, r.captured || [], LABEL()),
    autoTerm: sh.term, rel: sh.rel, where: p >= 0 ? go.where(p).text : ""
  };
}
function makeCard(color, p, f) {
  return Object.assign({ id: ++cardSeq, color, p, pos: go.name(p), moveNo: st.seq.length, cls: null, done: false, fresh: true, term: "" }, f);
}
function newCard(color, p, f) {
  const c = makeCard(color, p, f);
  cards.unshift(c);
  if (cards.length > 30) cards.length = 30;
  return c;
}

function showMsg(t) {
  const c = { id: ++cardSeq, color: st.toMove, p: -2, pos: "", moveNo: st.seq.length, local: [], cls: null, done: true, fresh: true, term: "提示", effect: t };
  cards.unshift(c); renderCards();
}

// ---------- 对局流程 ----------
function setEval(a) { if (a) { st.lastWr = a.wr; st.lastLead = a.lead; renderEval(); } }

async function onPoint(p) {
  if (busy || st.over) return;
  if (st.mode === "ai" && st.toMove !== B) return;
  const color = st.toMove;
  const r = apply(color, p);
  if (!r.ok) { showMsg(r.why); return; }
  setHints([]);
  const e = epoch;
  const card = newCard(color, p, factsFor(r, p, color));
  if (st.passes >= 2) { render(); return finishGame("两人都停了一手"); }
  if (st.mode === "ai") { busy = true; render(); await aiReply(card, e); }
  else { render(); saveGame(); await reviewMove(card, e); }
}

// 双人：分析刚下的这手，出招式卡
async function reviewMove(card, e) {
  try {
    const seq = st.seq.slice(0, card.moveNo);
    const [before, after] = await Promise.all([analyzePos(seq.slice(0, -1)), analyzePos(seq)]);
    if (e !== epoch) return;
    card.cls = classify(before, after, card.p, card.color);
    countTier(card);
    if (st.seq.length === card.moveNo) setEval(after);
    render();
    await teach([card]);
  } catch (err) { card.done = true; card.effect = "引擎出错：" + err.message; render(); }
}

function countTier(card) {
  const k = card.cls.tier, side = colorName(card.color);
  st.stats[side][k] = (st.stats[side][k] || 0) + 1;
}

// 人机：引擎落子 + 两张招式卡
async function aiReply(myCard, e) {
  let after;
  try {
    const seq = st.seq.slice();
    const res = await Promise.all([analyzePos(seq.slice(0, -1)), analyzePos(seq)]);
    if (e !== epoch) return;
    const before = res[0]; after = res[1];
    if (myCard.p >= 0 || myCard.pos === "pass") { myCard.cls = classify(before, after, myCard.p, B); countTier(myCard); }
    setEval(after);
    renderCards();
  } catch (err) {
    busy = false; myCard.done = true; myCard.effect = "引擎出错：" + err.message; render(); return;
  }

  // 老师认输：连续 3 手胜率低于 3%
  const whiteWr = 1 - after.wr;
  st.aiLowCount = whiteWr < 0.03 && st.seq.length > st.N * 2 ? st.aiLowCount + 1 : 0;
  if (st.aiLowCount >= 3) { busy = false; render(); return finishGame("老师认输了", B); }

  const p = sampleHuman(after);
  const r = apply(W, p);
  if (!r.ok) { busy = false; render(); return; }
  // 先讲完你这一手，再把老师的子放到棋盘上：落子已经算好，但暂时不显示
  const aiCard = makeCard(W, p, factsFor(r, p, W));
  st.viewBoard = r.before; st.viewLast = myCard.p;
  render();

  let aiAfter = null;
  try {
    aiAfter = await analyzePos(st.seq.slice());
    if (e !== epoch) return;
    if (p >= 0) aiCard.cls = classify(after, aiAfter, p, W);
    if (aiAfter.moves[0]) aiCard.plan = aiAfter.moves[0].pv.slice(0, 4);
  } catch (err) { /* 引擎慢或出错：仍然让老师讲 */ }
  if (e !== epoch) return;

  const talk = teach(myCard.pos === "pass" ? [aiCard] : [myCard, aiCard]);
  await Promise.race([talk, sleep(20000)]);
  if (e !== epoch) return;
  if (myCard.pos !== "pass") await sleep(1200);     // 留一点时间看你的招式卡
  if (e !== epoch) return;

  st.viewBoard = null;
  aiCard.fresh = true;
  cards.unshift(aiCard);
  if (aiAfter) setEval(aiAfter);
  busy = false;
  render();
  saveGame();
  if (st.passes >= 2) return finishGame("双方都停了一手");
}

// 让子局 / 双人轮到 AI 先下
async function aiFirst() {
  if (st.mode !== "ai" || st.toMove !== W || st.over) return;
  busy = true; render();
  const e = epoch;
  try {
    const a = await analyzePos(st.seq.slice());
    if (e !== epoch) return;
    const p = sampleHuman(a);
    const r = apply(W, p);
    const card = newCard(W, p, factsFor(r, p, W));
    busy = false; render();
    const a2 = await analyzePos(st.seq.slice());
    setEval(a2);
    card.cls = classify(a, a2, p, W);
    render();
    await teach([card]);
  } catch (err) { busy = false; showMsg("引擎出错：" + err.message); render(); }
}

async function finishGame(why, forcedWinner) {
  st.over = true; busy = false; render();
  let lead = null;
  try { const a = await analyzePos(st.seq.slice()); lead = a.lead; } catch (e) { lead = go.areaScore(st.board, st.komi); }
  const winner = forcedWinner || (lead >= 0 ? B : W);
  const margin = forcedWinner ? "" : `${Math.max(0.5, Math.round(Math.abs(lead) * 2) / 2)} 目`;
  let line;
  if (st.mode === "ai") line = winner === B ? `你赢了${margin ? " " + margin : ""}！` : `老师赢了${margin ? " " + margin : ""}`;
  else line = `${winner === B ? "黑方" : "白方"}胜${margin ? " " + margin : ""}`;

  // 自动升降级 + 战绩
  let lvMsg = "";
  if (st.mode === "ai") {
    const career = store.get("career", { games: 0, wins: 0, tiers: {} });
    career.games++; if (winner === B) career.wins++;
    for (const [k, v] of Object.entries(st.stats.B)) career.tiers[k] = (career.tiers[k] || 0) + v;
    store.set("career", career);
    if (cfg.levelMode === "auto" && !st.hcp) {
      const lv = levelOf(st.N);
      if (winner === B) { lv.w++; lv.l = 0; } else { lv.l++; lv.w = 0; }
      if (lv.w >= 2 && lv.idx < RANKS.length - 1) { lv.idx++; lv.w = 0; lvMsg = `连赢两盘，对手升到 ${rankName(RANKS[lv.idx])}！`; }
      if (lv.l >= 2 && lv.idx > 0) { lv.idx--; lv.l = 0; lvMsg = `对手降到 ${rankName(RANKS[lv.idx])}，先把基本功练扎实。`; }
      store.set("levels", levels);
    }
  }
  const order = ["god", "myo", "tesuji", "slow", "vulgar", "bad", "lose"];
  const statBox = side => `<div class="stat-grid">${order.map(k => `<div class="stat">${TIERS[k].name}<b>${st.stats[side][k] || 0}</b></div>`).join("")}</div>`;
  $("resultBody").innerHTML = `<div class="result-line">${line}</div>
    <div class="hint">${why}${lead != null && !forcedWinner ? "（按引擎判断，含死子）" : ""}</div>
    ${lvMsg ? `<div><b>${lvMsg}</b></div>` : ""}
    ${st.mode === "ai" ? `<h3>你本局的招式</h3>${statBox("B")}` : `<h3>黑方</h3>${statBox("B")}<h3>白方</h3>${statBox("W")}`}`;
  $("result").hidden = false;
  speak(line + (lvMsg ? "。" + lvMsg : ""));
  store.set("game", null);
}

function startGame(fromSave) {
  epoch++; busy = false; cache.clear(); hints = []; cards = [];
  if (fromSave) {
    go = makeGo(fromSave.N);
    st = Object.assign(newState(fromSave.mode, fromSave.N, fromSave.hcp), fromSave, { snaps: [], viewBoard: null });
    cards = (fromSave.cards || []).map(c => Object.assign(c, { fresh: false }));
    cardSeq = cards.reduce((m, c) => Math.max(m, c.id), 0);
  } else {
    st = newState(cfg.mode, +cfg.size, +cfg.hcp);
    showMsg(st.mode === "ai"
      ? (st.hcp ? `让你 ${st.hcp} 子，我先下。` : `新的一局，你执黑先下。对手水平：${rankName(st.rank)}。`)
      : "双人对局：黑方先下，老师会点评双方的每一手。");
  }
  render();
  if (!fromSave || st.toMove === W) aiFirst();
}

function undo() {
  if (busy || !st.snaps.length) return;
  epoch++;
  let steps = 1;
  if (st.mode === "ai") {
    // 退回到你上一手之前
    const lastB = [...st.seq].map(m => m[0]).lastIndexOf("B");
    if (lastB < 0) return;
    steps = st.seq.length - lastB;
  }
  for (let i = 0; i < steps && st.snaps.length; i++) Object.assign(st, JSON.parse(st.snaps.pop()));
  st.over = false; st.aiLowCount = 0;
  cards = cards.filter(c => c.moveNo <= st.seq.length && c.p !== -2);
  hints = [];
  render(); saveGame();
}

// ---------- 问老师 ----------
let chatLog = [];
async function ask(q, focusCard) {
  $("chat").hidden = false;
  addMsg("u", q);
  if (!cfg.key) { addMsg("a", "还没填老师的接口 Key，在菜单里设置。"); return; }
  const ctx = `棋盘（x=黑 o=白，大写为最后一手）：\n${go.boardText(st.board, st.last)}\n棋谱（最近）：${recentRecord()}\n老师最近说过：${st.notes.join("；")}`
    + (focusCard ? `\n学生问的是这一手：\n${moveFactsText(focusCard)}` : "");
  const sys = sysPrompt() + `\n现在学生在提问。返回 JSON：{"text":"回答","hints":[{"pos":"坐标","color":"B或W","n":序号}]}。
text 用大白话，150 字以内，可以讲具体变化（这时可以说出坐标），讲变化时把每一步放进 hints（最多 6 步，按顺序编号），棋盘会用半透明棋子演示。`;
  try {
    const out = parseLoose(await callLLM([{ role: "system", content: sys }, ...chatLog.slice(-6), { role: "user", content: ctx + "\n\n学生问：" + q + "\n（记得按 JSON 格式回答）" }], true));
    const text = clean(out.text || out.answer || out.reply || "");
    if (!text) throw new Error("老师没有回答内容");
    chatLog.push({ role: "user", content: q }, { role: "assistant", content: JSON.stringify({ text, hints: [] }) });
    addMsg("a", text);
    const hs = (out.hints || []).slice(0, 6).map(h => ({ p: go.parse(h.pos), c: h.color === "W" ? W : B, n: h.n })).filter(h => h.p != null && h.p >= 0 && st.board[h.p] === EMPTY);
    if (hs.length) setHints(hs);
    speak(text);
  } catch (err) { addMsg("a", "老师连不上：" + err.message); }
}
function addMsg(who, t) {
  const d = document.createElement("div"); d.className = "m " + who;
  d.innerHTML = who === "a" ? linkCoords(t) : esc(t);
  $("msgs").appendChild(d); $("msgs").scrollTop = 1e9;
}

// ---------- 菜单 ----------
function fillMenu() {
  $("sMode").value = cfg.mode; $("sSize").value = String(cfg.size); $("sVisits").value = String(cfg.visits);
  $("sBase").value = cfg.base; $("sKey").value = cfg.key; $("sModel").value = cfg.model;
  fillHcp(); fillLevel();
  $("mTts").textContent = "朗读：" + (cfg.tts ? "开" : "关");
  showEngine();
}
function fillHcp() {
  const N = +$("sSize").value, max = N <= 9 ? 4 : 9;
  const opts = [0, 2, 3, 4, 5, 6, 7, 8, 9].filter(h => h <= max);
  $("sHcp").innerHTML = opts.map(h => `<option value="${h}">${h ? "让 " + h + " 子" : "不让子"}</option>`).join("");
  $("sHcp").value = String(Math.min(cfg.hcp, max));
}
function fillLevel() {
  const N = +$("sSize").value, lv = levelOf(N);
  $("sLevel").innerHTML = `<option value="auto">自动（按胜负升降，现在 ${rankName(RANKS[lv.idx])}）</option>` +
    RANKS.map((r, i) => `<option value="${i}">${rankName(r)}</option>`).join("");
  $("sLevel").value = cfg.levelMode === "auto" ? "auto" : String(lv.idx);
  $("lvlWrap").hidden = $("sMode").value !== "ai";
  $("lvlHint").textContent = $("sMode").value === "ai" ? "自动模式：连赢两盘升一级，连输两盘降一级。9 / 13 / 19 路分开记录。" : "双人对局里，老师按这个水平判断\"大多数人会怎么下\"。";
  $("lvlWrap").hidden = false;
}
function readMenu() {
  cfg.mode = $("sMode").value; cfg.size = +$("sSize").value; cfg.hcp = +$("sHcp").value; cfg.visits = +$("sVisits").value;
  cfg.base = $("sBase").value.trim() || DEF.base; cfg.key = $("sKey").value.trim(); cfg.model = $("sModel").value.trim() || DEF.model;
  const lvSel = $("sLevel").value;
  if (lvSel === "auto") cfg.levelMode = "auto";
  else { cfg.levelMode = "manual"; levelOf(cfg.size).idx = +lvSel; store.set("levels", levels); }
  saveCfg();
}

// ---------- 事件 ----------
$("board").addEventListener("click", e => { const p = e.target.dataset && e.target.dataset.p; if (p != null) onPoint(+p); });
$("btnPass").onclick = () => onPoint(-1);
$("btnUndo").onclick = undo;
$("btnResign").onclick = () => {
  if (st.over || busy) return;
  if (st.mode === "ai") finishGame("你认输了", W);
  else finishGame(`${st.toMove === B ? "黑方" : "白方"}认输`, opp(st.toMove));
};
$("btnWhy").onclick = () => {
  const c = cards.find(x => x.p >= -1 && (st.mode !== "ai" || x.color === B));
  ask(c ? `我这手 ${c.pos} 下得怎么样？为什么？` : "现在局面怎么样？该往哪里下？", c);
};
$("btnAsk").onclick = () => { const q = $("ask").value.trim(); if (q) { $("ask").value = ""; ask(q); } };
$("ask").addEventListener("keydown", e => { if (e.key === "Enter") $("btnAsk").click(); });
$("cards").addEventListener("click", e => {
  const t = e.target;
  if (t.dataset.pos) {
    const p = go.parse(t.dataset.pos);
    if (p != null && p >= 0) {
      const c = cards.find(x => x.id === +(t.closest(".card") || {}).dataset?.id);
      setHints([{ p, c: c ? c.color : st.toMove, flash: true }]);
    }
  } else if (t.dataset.solve) {
    const c = cards.find(x => x.id === +t.dataset.solve);
    if (c && c.cls) {
      // 在当时的局面上演示：先把棋盘退到那一手之前（只演示，不改变对局）
      const pv = c.cls.bestPv.slice(0, 6);
      let col = c.color;
      const hs = [];
      pv.forEach((m, i) => { const p = go.parse(m); if (p != null && p >= 0) hs.push({ p, c: col, n: i + 1 }); col = opp(col); });
      const note = c.moveNo === st.seq.length || (st.mode === "ai" && c.moveNo === st.seq.length - 1) ? "" : "（这是之前那一手的正解）";
      setHints(hs.filter(h => st.board[h.p] === EMPTY || h.p === c.p));
      showMsg(`正解是 ${pv[0]}，后续变化已用半透明棋子标出 1、2、3…${note}`);
      renderBoard();
    }
  } else if (t.dataset.ask) {
    const c = cards.find(x => x.id === +t.dataset.ask);
    if (c) ask(`${WHO(c.color)}下的 ${c.pos} 这手【${c.term}】，能再讲讲吗？`, c);
  } else if (t.dataset.term) {
    const terms = store.get("terms", {}); const k = t.dataset.term;
    showMsg(`【${k}】${(terms[k] && terms[k].explain) || ""}`);
  }
});
$("msgs").addEventListener("click", e => {
  const t = e.target;
  if (t.dataset.pos) { const p = go.parse(t.dataset.pos); if (p != null && p >= 0) setHints([{ p, c: st.toMove, flash: true }]); }
});
document.querySelectorAll("[data-close]").forEach(b => b.onclick = () => { $(b.dataset.close).hidden = true; });
document.querySelectorAll(".sheet").forEach(s => s.addEventListener("click", e => { if (e.target === s) s.hidden = true; }));
$("btnMenu").onclick = () => { fillMenu(); $("menu").hidden = false; };
$("sSize").onchange = () => { fillHcp(); fillLevel(); };
$("sMode").onchange = fillLevel;
$("mSave").onclick = () => { readMenu(); $("menu").hidden = true; showMsg("已保存。点“新的一局”让棋盘、模式、让子生效。"); };
$("mNew").onclick = () => { readMenu(); $("menu").hidden = true; $("result").hidden = true; startGame(null); };
$("rNew").onclick = () => { $("result").hidden = true; startGame(null); };
$("mDiag").onclick = () => {
  let log = "";
  try { log = JSON.parse(window.Native.engineStatus()).gpuLog || ""; } catch (e) {}
  $("menu").hidden = true;
  $("bookTitle").textContent = "GPU 诊断信息";
  $("bookBody").innerHTML = `<div class="hint">截图发给开发者即可。点"重试 GPU"后会生成新的记录。</div>
    <pre id="diagText" style="white-space:pre-wrap;word-break:break-all;font-size:12px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px;margin:0">${esc(log || "还没有记录。点菜单里的「重试 GPU」，等一会儿再来看。")}</pre>
    <button id="diagCopy">复制</button>`;
  $("book").hidden = false;
  $("diagCopy").onclick = () => {
    const t = $("diagText").textContent;
    (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => showMsg("已复制")).catch(() => {
      const r = document.createRange(); r.selectNodeContents($("diagText")); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    });
  };
};
$("mTerms").onclick = () => { $("menu").hidden = true; showTerms(); };
$("mStats").onclick = () => { $("menu").hidden = true; showStats(); };
$("mTts").onclick = () => { cfg.tts = !cfg.tts; saveCfg(); $("mTts").textContent = "朗读：" + (cfg.tts ? "开" : "关"); if (!cfg.tts && hasNative()) try { window.Native.stopSpeak(); } catch (e) {} };
$("mGpu").onclick = () => { if (hasNative()) { window.Native.restartEngine(false); cache.clear(); engineState.ready = false; engineState.text = "正在重试 GPU…"; showEngine(); } };
$("mCpu").onclick = () => { if (hasNative()) { window.Native.restartEngine(true); cache.clear(); engineState.ready = false; engineState.text = "正在切换到 CPU…"; showEngine(); } };
window.__onBack = () => {
  for (const id of ["menu", "book", "result"]) if (!$(id).hidden) { $(id).hidden = true; return; }
  if (!$("chat").hidden) { $("chat").hidden = true; return; }
  if (hasNative()) window.Native.exitApp();
};

// ---------- 启动 ----------
showEngine();
if (!cfg.key) setTimeout(() => { fillMenu(); $("menu").hidden = false; $("sKey").focus(); showMsg("第一次使用：请在菜单里填上老师（大模型接口）的 API Key，然后点保存。"); }, 300);
const saved = store.get("game", null);
if (saved && saved.seq && !saved.over && [9, 13, 19].includes(saved.N)) startGame(saved);
else startGame(null);
