// ===== 围棋规则（确定性代码，不交给模型） =====
// 坐标：p = y*N + x，y=0 是最上面一行（显示为 N），列字母跳过 I
const ALL_COLS = "ABCDEFGHJKLMNOPQRST";
const EMPTY = 0, B = 1, W = 2;
const opp = c => 3 - c;
const colorName = c => c === B ? "B" : "W";

function makeGo(N) {
  const COLS = ALL_COLS.slice(0, N);
  const nbCache = [];
  for (let p = 0; p < N * N; p++) {
    const x = p % N, y = (p / N) | 0, r = [];
    if (x > 0) r.push(p - 1); if (x < N - 1) r.push(p + 1);
    if (y > 0) r.push(p - N); if (y < N - 1) r.push(p + N);
    nbCache.push(r);
  }
  const nb = p => nbCache[p];
  const name = p => p < 0 ? "pass" : COLS[p % N] + (N - ((p / N) | 0));
  const parse = s => {
    s = String(s || "").trim().toUpperCase();
    if (s === "PASS") return -1;
    const x = COLS.indexOf(s[0]), n = parseInt(s.slice(1), 10);
    if (x < 0 || !(n >= 1 && n <= N) || String(n) !== s.slice(1)) return null;
    return (N - n) * N + x;
  };

  function group(bd, p) {
    const c = bd[p], stones = [p], libs = new Set(), seen = new Set([p]);
    for (let i = 0; i < stones.length; i++) for (const q of nb(stones[i])) {
      if (bd[q] === EMPTY) libs.add(q);
      else if (bd[q] === c && !seen.has(q)) { seen.add(q); stones.push(q); }
    }
    return { color: c, stones, libs };
  }

  function tryPlay(st, c, p) {
    if (p < 0) return { ok: true, board: st.board.slice(), captured: [] };
    if (st.board[p] !== EMPTY) return { ok: false, why: "这里已经有子" };
    const bd = st.board.slice(); bd[p] = c;
    const captured = [];
    for (const q of nb(p)) if (bd[q] === opp(c)) {
      const g = group(bd, q);
      if (g.libs.size === 0) for (const s of g.stones) if (bd[s] !== EMPTY) { bd[s] = EMPTY; captured.push(s); }
    }
    if (group(bd, p).libs.size === 0) return { ok: false, why: "自杀手，不能下" };
    if (st.prev && bd.join("") === st.prev) return { ok: false, why: "打劫：要先在别处下一手，才能提回来" };
    return { ok: true, board: bd, captured };
  }

  function legal(st, c, p) { return p === -1 || (p != null && tryPlay(st, c, p).ok); }

  function allGroups(bd) {
    const seen = new Set(), gs = [];
    for (let p = 0; p < N * N; p++) if (bd[p] !== EMPTY && !seen.has(p)) {
      const g = group(bd, p); g.stones.forEach(s => seen.add(s)); gs.push(g);
    }
    return gs;
  }

  // 星位
  function hoshi() {
    const a = N <= 9 ? 2 : 3, b = N - 1 - a, m = (N - 1) / 2;
    const pts = [[a, a], [b, a], [a, b], [b, b]];
    if (N % 2 === 1) pts.push([m, m]);
    if (N >= 19) pts.push([a, m], [b, m], [m, a], [m, b]);
    return pts;
  }

  // 让子位置（标准顺序）
  function handicap(h) {
    const a = N <= 9 ? 2 : 3, b = N - 1 - a, m = (N - 1) / 2;
    const TR = [b, a], BL = [a, b], BR = [b, b], TL = [a, a], C = [m, m], L = [a, m], R = [b, m], T = [m, a], Bo = [m, b];
    const order = {
      2: [TR, BL], 3: [TR, BL, BR], 4: [TR, BL, BR, TL], 5: [TR, BL, BR, TL, C],
      6: [TR, BL, BR, TL, L, R], 7: [TR, BL, BR, TL, L, R, C],
      8: [TR, BL, BR, TL, L, R, T, Bo], 9: [TR, BL, BR, TL, L, R, T, Bo, C]
    }[h] || [];
    return order.map(([x, y]) => name(y * N + x));
  }

  function boardText(bd, last) {
    let s = "   " + COLS.split("").join(" ") + "\n";
    for (let y = 0; y < N; y++) {
      s += String(N - y).padStart(2) + " ";
      for (let x = 0; x < N; x++) {
        const p = y * N + x;
        s += (bd[p] === B ? (p === last ? "X" : "x") : bd[p] === W ? (p === last ? "O" : "o") : ".") + " ";
      }
      s += "\n";
    }
    return s;
  }

  // 一手棋在局部发生了什么（给老师看的事实）
  function localFacts(before, after, p, c, captured, label) {
    const L = [];
    const own = c === B ? label.B : label.W, other = c === B ? label.W : label.B;
    if (p < 0) return [`${own}停了一手`];
    if (captured.length) L.push(`提掉${other} ${captured.length} 子`);
    const g = group(after, p);
    L.push(`落子后这块${own}共 ${g.stones.length} 子、${g.libs.size} 口气`);
    if (g.libs.size === 1) L.push(`这块${own}只剩 1 口气，可以被对方在 ${[...g.libs].map(name)} 提掉`);
    const seen = new Set();
    for (const q of nb(p)) if (after[q] === opp(c) && !seen.has(q)) {
      const og = group(after, q); og.stones.forEach(s => seen.add(s));
      if (og.libs.size === 1) L.push(`打吃了${other} ${og.stones.length} 子（${name(og.stones[0])}），它只能从 ${[...og.libs].map(name)} 逃`);
      else if (og.libs.size === 2) L.push(`紧了${other}一块棋的气，那块只剩 2 口气`);
    }
    const parts = new Set();
    for (const q of nb(p)) if (before[q] === c) parts.add(Math.min(...group(before, q).stones));
    if (parts.size >= 2) L.push(`把 ${parts.size} 块${own}连在了一起`);
    // 是否把对方分断
    const oppParts = new Set();
    for (const q of nb(p)) if (after[q] === opp(c)) oppParts.add(Math.min(...group(after, q).stones));
    if (oppParts.size >= 2) L.push(`挡在${other} ${oppParts.size} 块棋中间`);
    return L;
  }

  // 位置描述：哪个角/边/中腹，第几线
  function where(p) {
    const x = p % N, y = (p / N) | 0;
    const lineX = Math.min(x, N - 1 - x) + 1, lineY = Math.min(y, N - 1 - y) + 1, line = Math.min(lineX, lineY);
    const zone = N <= 9 ? 3 : N <= 13 ? 4 : 5;
    const lr = x < zone ? "左" : x > N - 1 - zone ? "右" : "", tb = y < zone ? "上" : y > N - 1 - zone ? "下" : "";
    let area = lr && tb ? `${lr}${tb}角` : lr ? `${lr}边` : tb ? `${tb}边` : "中腹";
    if (area === "左上角") area = "左上角"; else if (area.length === 3) area = tb + lr === "上左" ? "左上角" : area;
    const name2 = { "左上角": "左上角", "右上角": "右上角", "左下角": "左下角", "右下角": "右下角" };
    if (lr && tb) area = name2[`${lr}${tb}角`] || `${lr}${tb}角`;
    return { area, line, text: `${area}，${line === 1 ? "一线（最边上）" : line + " 线"}` };
  }

  // 按形状判断招式名（程序判断，比让大模型看图准）
  function shape(before, after, p, c, captured) {
    if (p < 0) return { term: "停一手", rel: [] };
    const o = opp(c), x = p % N, y = (p / N) | 0, rel = [];
    const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= N || yy >= N) ? -1 : before[yy * N + xx];
    const nbs = nb(p);
    const ownAdj = nbs.filter(q => before[q] === c), oppAdj = nbs.filter(q => before[q] === o);
    // 新造成的打吃
    const ataris = [], seen = new Set();
    for (const q of nbs) if (after[q] === o && !seen.has(q)) {
      const g = group(after, q); g.stones.forEach(t => seen.add(t));
      if (g.libs.size === 1 && group(before, q).libs.size > 1) ataris.push(g);
    }
    const ownParts = new Set(ownAdj.map(q => Math.min(...group(before, q).stones)));
    const oppParts = new Set(oppAdj.filter(q => after[q] === o).map(q => Math.min(...group(after, q).stones)));
    for (const q of oppAdj) rel.push(`紧贴对方的 ${name(q)}`);
    let term = null;
    if (captured.length) term = "提";
    else if (ataris.length >= 2) term = "双打吃";
    else if (ataris.length === 1) term = "打吃";
    else if (ownParts.size >= 2) term = "粘";
    else if (oppParts.size >= 2 && oppAdj.length >= 2) term = "断";
    else if (oppAdj.length && (() => {
      // 扳：斜对角有自己的子，且那颗子和我贴着的对方子相邻
      for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) if (at(x + dx, y + dy) === c) {
        const s2 = (y + dy) * N + x + dx;
        if (oppAdj.some(q => nb(s2).includes(q))) return true;
      }
      return false;
    })()) term = "扳";
    else if (ownAdj.length && oppAdj.length) {
      term = "长";
    } else if (ownAdj.length) {
      const l = where(p).line, q = ownAdj[0], lq = where(q).line;
      term = l <= 2 && lq === l + 1 && ownAdj.length === 1 ? "立" : "长";
      rel.push(`接在自己的 ${name(q)} 旁边`);
    } else if (oppAdj.length) {
      term = "靠";
    }
    if (!term) {
      // 和最近的自己棋子的关系
      const shapes = [[1, 1, "尖"], [0, 2, "跳"], [1, 2, "小飞"], [2, 2, "象步"], [1, 3, "大飞"], [0, 3, "二间跳"]];
      for (const [a1, b1, nm] of shapes) {
        for (const [dx, dy] of [[a1, b1], [b1, a1], [-a1, b1], [-b1, a1], [a1, -b1], [b1, -a1], [-a1, -b1], [-b1, -a1]]) {
          if (at(x + dx, y + dy) === c) {
            const q = (y + dy) * N + x + dx;
            // 中间被对方挡住就不算
            const mx = x + Math.sign(dx) * (Math.abs(dx) > 1 ? 1 : 0), my = y + Math.sign(dy) * (Math.abs(dy) > 1 ? 1 : 0);
            if (!(nm === "跳" && at(mx, my) === o)) { term = nm; rel.push(`和自己的 ${name(q)} 是${nm}的关系`); }
            break;
          }
        }
        if (term) break;
      }
    }
    if (!term) {
      // 附近有对方棋子：角上是挂角，两边都有对方子是夹
      const near = [];
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (at(x + dx, y + dy) === o) near.push((y + dy) * N + x + dx);
      const w = where(p);
      if (near.length && w.area.endsWith("角") && w.line >= 3 && w.line <= 4) { term = "挂角"; rel.push(`靠近对方角上的 ${name(near[0])}`); }
      else if (near.length >= 2) { term = "夹"; }
    }
    if (!term) {
      const w = where(p), empty = before.every((v, i) => !v || Math.abs((i % N) - x) > 3 || Math.abs(((i / N) | 0) - y) > 3);
      if (empty && w.area.endsWith("角") && N >= 13) {
        const lx = Math.min(x, N - 1 - x) + 1, ly = Math.min(y, N - 1 - y) + 1;
        if (lx === 3 && ly === 3) term = "三三"; else if (lx === 4 && ly === 4) term = "星位"; else if ((lx === 3 && ly === 4) || (lx === 4 && ly === 3)) term = "小目";
        else term = "占角";
      } else if (empty) term = w.area.endsWith("角") ? "占角" : w.area === "中腹" ? "天元附近" : "占边";
    }
    return { term, rel, ataris: ataris.length };
  }

  function stoneList(bd) {
    const b = [], w = [];
    for (let p = 0; p < N * N; p++) { if (bd[p] === B) b.push(name(p)); else if (bd[p] === W) w.push(name(p)); }
    return { b, w };
  }

  // 粗略数子（不判死子，仅在引擎不可用时兜底）
  function areaScore(bd, komi) {
    let b = 0, w = 0; const seen = new Set();
    for (let p = 0; p < N * N; p++) {
      if (bd[p] === B) b++; else if (bd[p] === W) w++;
      else if (!seen.has(p)) {
        const area = [p], border = new Set(); seen.add(p);
        for (let i = 0; i < area.length; i++) for (const q of nb(area[i])) {
          if (bd[q] === EMPTY) { if (!seen.has(q)) { seen.add(q); area.push(q); } }
          else border.add(bd[q]);
        }
        if (border.size === 1) { if (border.has(B)) b += area.length; else w += area.length; }
      }
    }
    return b - (w + komi);
  }

  return { N, COLS, nb, name, parse, group, tryPlay, legal, allGroups, hoshi, handicap, boardText, localFacts, areaScore, where, shape, stoneList };
}

if (typeof module !== "undefined") module.exports = { makeGo, B, W, EMPTY, opp, colorName, ALL_COLS };
