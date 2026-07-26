/* ============================================================
   Parti 전처리 엔진 — Phase 2 (AI 사용 0, 전부 알고리즘)
   손그림 스트로크(월드 mm + 필압) → 기하 인식 + 구조화 요약.
   철학: 손그림 전체를 LLM 에 보내지 않는다 — 프로그램이 먼저
   거의 모든 일을 하고, AI(Phase 3)에게는 정리된 요약만 준다.
   파이프라인: RDP 단순화 → 코너 분해 → 직선/호/원/사각 피팅
   → 직교 정리 → 끝점 병합 → 평면 그래프 닫힌 영역 검출 → 요약.
   ============================================================ */
window.WEBCAD_PREP = (() => {
'use strict';

// ---------- 기본 기하 ----------
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const DEG = 180 / Math.PI;
function perpDist(p, a, b) {           // 점 → 선분 거리
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-12) return dist(p, a);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
function rdp(pts, eps) {               // Ramer–Douglas–Peucker (반복형)
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const seg = stack.pop(), i0 = seg[0], i1 = seg[1];
    let mi = -1, md = 0;
    for (let i = i0 + 1; i < i1; i++) {
      const d = perpDist(pts[i], pts[i0], pts[i1]);
      if (d > md) { md = d; mi = i; }
    }
    if (md > eps) { keep[mi] = 1; stack.push([i0, mi], [mi, i1]); }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}
function bboxOf(pts) {
  let x0 = 1e30, y0 = 1e30, x1 = -1e30, y1 = -1e30;
  for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, diag: Math.hypot(x1 - x0, y1 - y0) };
}
const turnAngle = (a, b, c) => {       // b 에서의 꺾임각 (0=직진, 라디안)
  const a1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const a2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
  let d = a2 - a1;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
};
// Kåsa 원 최소제곱 피팅 → {cx, cy, r, rmse}
function fitCircle(pts) {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  const n = pts.length;
  for (const p of pts) {
    const x = p[0], y = p[1], z = x * x + y * y;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z;
  }
  // [[sxx,sxy,sx],[sxy,syy,sy],[sx,sy,n]] · [A,B,C]ᵀ = [sxz,syz,sz]ᵀ  (cx=A/2, cy=B/2)
  const det3 = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const M = [sxx, sxy, sx, sxy, syy, sy, sx, sy, n];
  const D = det3(M);
  if (Math.abs(D) < 1e-9) return null;
  const A = det3([sxz, sxy, sx, syz, syy, sy, sz, sy, n]) / D;
  const Bc = det3([sxx, sxz, sx, sxy, syz, sy, sx, sz, n]) / D;
  const C = det3([sxx, sxy, sxz, sxy, syy, syz, sx, sy, sz]) / D;
  const cx = A / 2, cy = Bc / 2;
  const r2 = C + cx * cx + cy * cy;
  if (r2 <= 0) return null;
  const r = Math.sqrt(r2);
  let se = 0;
  for (const p of pts) { const e = Math.hypot(p[0] - cx, p[1] - cy) - r; se += e * e; }
  return { cx, cy, r, rmse: Math.sqrt(se / n) };
}
// 스트로크가 중심을 도는 총 회전각 (부호: + 반시계)
function sweepOf(pts, cx, cy) {
  let sw = 0, prev = Math.atan2(pts[0][1] - cy, pts[0][0] - cx);
  for (let i = 1; i < pts.length; i++) {
    const a = Math.atan2(pts[i][1] - cy, pts[i][0] - cx);
    let d = a - prev;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    sw += d; prev = a;
  }
  return sw;
}
const norm360 = (a) => ((a % 360) + 360) % 360;

// ---------- 직교 정리 ----------
function snapLineOrtho(a, b, tolDeg) {
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * DEG;
  const m = ((ang % 90) + 90) % 90;                 // 0..90, 0 또는 90 근처 = 축 정렬 후보
  const off = Math.min(m, 90 - m);
  if (off > tolDeg) return null;
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const L = dist(a, b) / 2;
  const horiz = Math.abs(((ang % 180) + 180) % 180 - 90) > 45;  // 0/180 근처 = 수평
  // ★원래 진행 방향(시작→끝)을 보존 — 뒤집으면 끝점 스냅·보정이 반대 끝에 붙는다
  if (horiz) {
    const s = a[0] <= b[0] ? 1 : -1;
    return [[mid[0] - L * s, mid[1]], [mid[0] + L * s, mid[1]]];
  }
  const s = a[1] <= b[1] ? 1 : -1;
  return [[mid[0], mid[1] - L * s], [mid[0], mid[1] + L * s]];
}

// ---------- 스트로크 1개 → 도형 ----------
function fitStroke(stroke, opts) {
  const raw = stroke.pts.map(p => [p[0], p[1]]);
  const avgP = stroke.pts.reduce((s, p) => s + (p[2] || 0.5), 0) / stroke.pts.length;
  const widthMM = Math.round(stroke.hw * 2 * (0.25 + 1.5 * avgP) * 10) / 10;
  const base = { strokeId: stroke.id, color: stroke.color, widthMM, layer: stroke.layer || '' };
  const bb = bboxOf(raw);
  if (raw.length < 2 || bb.diag < opts.dotMax) return { ...base, kind: 'dot', at: [(bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2], bbox: bb };
  // fitK = 보정 강도(스케치 설정). 상한(80)도 fitK>1 이면 비례해 올린다 — 아니면 강한 보정이 상한에 잘림
  const eps = Math.min(80 * Math.max(1, opts.fitK || 1), Math.max(1, bb.diag * 0.02 * (opts.fitK || 1)));
  const sp = rdp(raw, eps);
  const closed = dist(raw[0], raw[raw.length - 1]) < Math.max(bb.diag * 0.12, opts.closeTol);
  // 코너 검출 (닫힌 스트로크는 시작점 둘레도 평가)
  const angTol = opts.cornerTol != null ? opts.cornerTol : 0.6;   // ≈34° 이상 꺾이면 코너 (스케치 설정으로 조정)
  const cornerIdx = [];
  const n = sp.length;
  if (closed) {
    for (let i = 0; i < n; i++) {
      const a = sp[(i - 1 + n) % n], b = sp[i], c = sp[(i + 1) % n];
      if (turnAngle(a, b, c) > angTol) cornerIdx.push(i);
    }
  } else {
    for (let i = 1; i < n - 1; i++) if (turnAngle(sp[i - 1], sp[i], sp[i + 1]) > angTol) cornerIdx.push(i);
  }
  // 원 — 닫힘 + 원 피팅 양호. 코너 개수로 거르지 않는다(굵은 단순화의 원은 꼭짓점 꺾임각이
  // 코너 문턱을 넘는다). 잔떨림 사각형은 rmse 가 커서 자연 탈락.
  if (closed) {
    const cf = fitCircle(raw);
    if (cf && cf.rmse < Math.max(bb.diag * 0.035, 2) && Math.abs(sweepOf(raw, cf.cx, cf.cy)) > 5.2)
      return { ...base, kind: 'circle', cx: cf.cx, cy: cf.cy, r: cf.r, bbox: bb, lengthMM: 2 * Math.PI * cf.r, closed: true };
  } else {
    // 직선 우선 — 현(chord) 편차가 작으면 잔떨림은 직선이다 (떨리는 직선을 호로 오인 방지)
    const chordDev = raw.reduce((m, p) => Math.max(m, perpDist(p, raw[0], raw[raw.length - 1])), 0);
    if (chordDev < Math.max(eps * 1.8, bb.diag * 0.035)) {
      let la = raw[0], lb = raw[raw.length - 1];
      const snapped = snapLineOrtho(la, lb, opts.orthoTolDeg);
      if (snapped) { la = snapped[0]; lb = snapped[1]; }
      return { ...base, kind: 'line', a: la, b: lb, bbox: bb, lengthMM: dist(la, lb), closed: false, ortho: !!snapped };
    }
    // 호 — 실제로 휘어 있고(chordDev 큼) 원 피팅이 현 근사보다 훨씬 좋을 때만.
    // 코너가 있어도 '부드러운 곡선'(모든 꺾임이 60° 미만 + 같은 방향)이면 허용 —
    // 작은 호는 굵은 단순화 탓에 코너 문턱을 넘는다 (L자는 90° 꺾임이라 자연 배제).
    let smooth = true, sgnSum = 0, nTurn = 0;
    for (let i = 1; i < n - 1; i++) {
      const a1 = Math.atan2(sp[i][1] - sp[i - 1][1], sp[i][0] - sp[i - 1][0]);
      const a2 = Math.atan2(sp[i + 1][1] - sp[i][1], sp[i + 1][0] - sp[i][0]);
      let d = a2 - a1;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      if (Math.abs(d) > 1.05) { smooth = false; break; }
      if (Math.abs(d) > 0.12) { sgnSum += Math.sign(d); nTurn++; }
    }
    if (smooth && nTurn) smooth = Math.abs(sgnSum) === nTurn;  // 전부 같은 방향
    if (!cornerIdx.length || smooth) {
      const cf = fitCircle(raw);
      if (cf && chordDev > bb.diag * 0.05 && cf.rmse < Math.max(2, chordDev * 0.3)) {
        const swS = sweepOf(raw, cf.cx, cf.cy), sw = Math.abs(swS);
        if (sw > 0.35 && sw < 6.1) {                   // 20°~350°
          const sgn = swS > 0;
          const aS = Math.atan2(raw[0][1] - cf.cy, raw[0][0] - cf.cx) * DEG;
          const aE = Math.atan2(raw[raw.length - 1][1] - cf.cy, raw[raw.length - 1][0] - cf.cx) * DEG;
          return { ...base, kind: 'arc', cx: cf.cx, cy: cf.cy, r: cf.r,
            startAngle: norm360(sgn ? aS : aE), endAngle: norm360(sgn ? aE : aS),
            a: raw[0], b: raw[raw.length - 1], bbox: bb, lengthMM: sw * cf.r, closed: false };
        }
      }
    }
  }
  // 조각(코너 사이)이 전부 직선인가
  const cutIdx = closed
    ? (cornerIdx.length ? cornerIdx.slice() : [0])
    : [0, ...cornerIdx, n - 1];
  const pieces = [];
  if (closed) {
    for (let k = 0; k < cutIdx.length; k++) {
      const i0 = cutIdx[k], i1 = cutIdx[(k + 1) % cutIdx.length];
      const seg = [];
      for (let i = i0; ; i = (i + 1) % n) { seg.push(sp[i]); if (i === i1) break; }
      pieces.push(seg);
    }
  } else {
    for (let k = 0; k < cutIdx.length - 1; k++) pieces.push(sp.slice(cutIdx[k], cutIdx[k + 1] + 1));
  }
  const lineTol = eps * 1.8;
  const isLine = (seg) => {
    for (let i = 1; i < seg.length - 1; i++) if (perpDist(seg[i], seg[0], seg[seg.length - 1]) > lineTol) return false;
    return true;
  };
  const allLines = pieces.every(isLine) && pieces.length >= 1;
  const vtx = pieces.map(seg => seg[0]);              // 코너 꼭짓점들
  const lengthOf = (ps, cl) => { let L = 0; for (let i = 1; i < ps.length; i++) L += dist(ps[i - 1], ps[i]); if (cl) L += dist(ps[ps.length - 1], ps[0]); return L; };
  if (allLines && closed && pieces.length === 4) {
    // 사각형 후보: 네 꼭짓점의 내부각 ≈ 90°, 변이 축에 가깝다 → 정사각 직교 정리
    const angOK = vtx.every((v, i) => {
      const a = vtx[(i + 3) % 4], c = vtx[(i + 1) % 4];
      const t = Math.abs(turnAngle(a, v, c) * DEG - 90);
      return t < 22;
    });
    const axisOK = vtx.every((v, i) => {
      const c = vtx[(i + 1) % 4];
      const ang = Math.atan2(c[1] - v[1], c[0] - v[0]) * DEG;
      const m = ((ang % 90) + 90) % 90;
      return Math.min(m, 90 - m) < opts.orthoTolDeg + 4;
    });
    if (angOK && axisOK) {
      const xs = vtx.map(v => v[0]).sort((a, b) => a - b), ys = vtx.map(v => v[1]).sort((a, b) => a - b);
      const x0 = (xs[0] + xs[1]) / 2, x1 = (xs[2] + xs[3]) / 2, y0 = (ys[0] + ys[1]) / 2, y1 = (ys[2] + ys[3]) / 2;
      const pts4 = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      return { ...base, kind: 'rect', pts: pts4, bbox: bboxOf(pts4), lengthMM: 2 * ((x1 - x0) + (y1 - y0)), closed: true };
    }
    if (angOK) return { ...base, kind: 'polygon', pts: vtx, bbox: bb, lengthMM: lengthOf(vtx, true), closed: true };
  }
  if (allLines && closed && pieces.length >= 3)
    return { ...base, kind: 'polygon', pts: vtx, bbox: bb, lengthMM: lengthOf(vtx, true), closed: true };
  if (allLines && !closed && pieces.length === 1) {
    let a = sp[0], b2 = sp[n - 1];
    const snapped = snapLineOrtho(a, b2, opts.orthoTolDeg);
    if (snapped) { a = snapped[0]; b2 = snapped[1]; }
    return { ...base, kind: 'line', a, b: b2, bbox: bb, lengthMM: dist(a, b2), closed: false, ortho: !!snapped };
  }
  if (allLines && !closed)
    return { ...base, kind: 'polyline', pts: [...vtx, sp[n - 1]], bbox: bb, lengthMM: lengthOf([...vtx, sp[n - 1]], false), closed: false };
  // 매끈하지 않은 자유곡선 — 단순화 점열 그대로 (손그림의 감성은 Sketch Layer 에 있고, 이것은 기하 후보)
  return { ...base, kind: 'curve', pts: sp, bbox: bb, lengthMM: lengthOf(sp, closed), closed };
}

// ---------- 끝점 병합 + 평면 그래프 → 닫힌 영역 ----------
function detectRegions(shapes, opts) {
  // 그래프 간선: 열린 도형의 직선 변들 (자기 자신이 닫힌 도형은 그 자체로 영역)
  let segs = []; // {a, b, shapeId}
  for (const s of shapes) {
    if (s.kind === 'line') segs.push({ a: s.a, b: s.b, shapeId: s.strokeId });
    else if (s.kind === 'polyline') for (let i = 1; i < s.pts.length; i++) segs.push({ a: s.pts[i - 1], b: s.pts[i], shapeId: s.strokeId });
    else if (s.kind === 'arc') segs.push({ a: s.a, b: s.b, shapeId: s.strokeId, arc: s }); // 호는 현으로 연결성만
  }
  if (!segs.length) return [];
  const tol = opts.mergeTol;
  // T자 접합: 끝점이 다른 선분의 '몸통' 근처에 닿으면 그 선분을 거기서 쪼갠다
  // (칸막이 벽이 외벽 중간에 붙는 경우 — 쪼개지 않으면 면이 갈라지지 않는다)
  {
    const endpoints = [];
    for (const sg of segs) endpoints.push(sg.a, sg.b);
    const out2 = [];
    for (const sg of segs) {
      const L = dist(sg.a, sg.b) || 1;
      const cuts = [];
      for (const p of endpoints) {
        if (dist(p, sg.a) <= tol || dist(p, sg.b) <= tol) continue;
        if (perpDist(p, sg.a, sg.b) <= tol) {
          const t = ((p[0] - sg.a[0]) * (sg.b[0] - sg.a[0]) + (p[1] - sg.a[1]) * (sg.b[1] - sg.a[1])) / (L * L);
          if (t > 0.02 && t < 0.98) cuts.push(t);
        }
      }
      if (!cuts.length) { out2.push(sg); continue; }
      cuts.sort((x, y) => x - y);
      const uniq = cuts.filter((t, i) => !i || t - cuts[i - 1] > 0.02);
      let prev = sg.a;
      for (const t of uniq) {
        const q = [sg.a[0] + (sg.b[0] - sg.a[0]) * t, sg.a[1] + (sg.b[1] - sg.a[1]) * t];
        out2.push({ a: prev, b: q, shapeId: sg.shapeId }); prev = q;
      }
      out2.push({ a: prev, b: sg.b, shapeId: sg.shapeId });
    }
    segs = out2;
  }
  // 끝점 클러스터링 (그리디 병합)
  const nodes = []; // {x, y, cnt}
  const nodeOf = (p) => {
    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      if (Math.hypot(nd.x - p[0], nd.y - p[1]) <= tol) {
        nd.x = (nd.x * nd.cnt + p[0]) / (nd.cnt + 1); nd.y = (nd.y * nd.cnt + p[1]) / (nd.cnt + 1); nd.cnt++;
        return i;
      }
    }
    nodes.push({ x: p[0], y: p[1], cnt: 1 }); return nodes.length - 1;
  };
  const edges = [];
  for (const sg of segs) {
    const u = nodeOf(sg.a), v = nodeOf(sg.b);
    if (u !== v) edges.push({ u, v, shapeId: sg.shapeId });
  }
  // 하프에지 회전 순회로 면 추출
  const out = new Map(); // node -> [{to, ang, key}]
  const heNext = new Map();
  const addHE = (u, v, ei) => {
    if (!out.has(u)) out.set(u, []);
    out.get(u).push({ to: v, ang: Math.atan2(nodes[v].y - nodes[u].y, nodes[v].x - nodes[u].x), key: u + '>' + v + '#' + ei, ei });
  };
  edges.forEach((e, i) => { addHE(e.u, e.v, i); addHE(e.v, e.u, i); });
  for (const list of out.values()) list.sort((a, b) => a.ang - b.ang);
  // (u→v) 다음 = v 에서 (v→u) 방향으로부터 시계방향 다음 간선
  function nextHE(u, v, ei) {
    const list = out.get(v);
    const back = Math.atan2(nodes[u].y - nodes[v].y, nodes[u].x - nodes[v].x);
    let best = null, bestD = 1e9;
    for (const h of list) {
      if (h.to === u && h.ei === ei && list.length > 1) continue; // 자기 역방향은 최후의 수단
      let d = back - h.ang;                            // 시계방향 각차 (0, 2π]
      while (d <= 1e-9) d += 2 * Math.PI;
      while (d > 2 * Math.PI) d -= 2 * Math.PI;
      if (d < bestD) { bestD = d; best = h; }
    }
    return best || list.find(h => h.to === u && h.ei === ei);
  }
  const visited = new Set();
  const regions = [];
  for (const e of edges.map((e, i) => ({ ...e, i }))) {
    for (const [su, sv] of [[e.u, e.v], [e.v, e.u]]) {
      const k0 = su + '>' + sv + '#' + e.i;
      if (visited.has(k0)) continue;
      let u = su, v = sv, ei = e.i;
      const cycle = [u];
      let guard = 0, ok = false;
      while (guard++ < 4000) {
        visited.add(u + '>' + v + '#' + ei);
        if (v === su && guard > 1) { ok = true; break; }
        cycle.push(v);
        const nx = nextHE(u, v, ei);
        if (!nx) break;
        u = v; v = nx.to; ei = nx.ei;
        if (visited.has(u + '>' + v + '#' + ei)) break;
      }
      if (!ok || cycle.length < 3) continue;
      let area = 0;
      for (let i = 0; i < cycle.length; i++) {
        const p = nodes[cycle[i]], q = nodes[cycle[(i + 1) % cycle.length]];
        area += p.x * q.y - q.x * p.y;
      }
      area /= 2;
      if (area > opts.minArea)                          // 양수(반시계) = 내부 면, 외곽 면은 음수 → 자연 탈락
        regions.push({ pts: cycle.map(i => [nodes[i].x, nodes[i].y]), areaMM2: area, nEdges: cycle.length });
    }
  }
  return regions;
}

// ---------- 공개 API ----------
// strokes: sketch.js 의 SK.strokes 형식 [{id, color, hw, pts:[[x,y,p]...]}]
function analyze(strokes, userOpts) {
  const all = strokes.flatMap(s => s.pts.map(p => [p[0], p[1]]));
  const scene = all.length ? bboxOf(all) : { diag: 1000 };
  const opts = Object.assign({
    dotMax: Math.max(3, scene.diag * 0.004),
    closeTol: Math.max(5, scene.diag * 0.02),
    orthoTolDeg: 7,
    mergeTol: Math.min(400, Math.max(3, scene.diag * 0.015)),
    minArea: Math.max(100, scene.diag * scene.diag * 1e-4),
  }, userOpts || {});
  const shapes = strokes.filter(s => s.pts.length).map(s => fitStroke(s, opts));
  // 자기 자신이 닫힌 도형 = 그대로 영역
  const regions = [];
  for (const s of shapes) {
    if (s.kind === 'rect' || s.kind === 'polygon' || (s.kind === 'curve' && s.closed)) {
      let a = 0; const P = s.pts;
      for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; }
      regions.push({ pts: P.slice(), areaMM2: Math.abs(a / 2), nEdges: P.length, self: true, shapeIds: [s.strokeId] });
    } else if (s.kind === 'circle') {
      regions.push({ circle: { cx: s.cx, cy: s.cy, r: s.r }, areaMM2: Math.PI * s.r * s.r, nEdges: 1, self: true, shapeIds: [s.strokeId] });
    }
  }
  regions.push(...detectRegions(shapes, opts));
  const counts = {};
  for (const s of shapes) counts[s.kind] = (counts[s.kind] || 0) + 1;
  // 구조화 요약 — Phase 3 에서 AI 가 '무엇인가'만 판단할 때 이것만 보낸다 (이미지 전송 없음)
  const summary = {
    unit: 'mm',
    shapes: shapes.map(s => ({
      kind: s.kind, color: s.color, layer: s.layer || undefined, strokeWidthMM: s.widthMM, closed: !!s.closed,
      lengthMM: s.lengthMM ? Math.round(s.lengthMM) : undefined,
      sizeMM: s.bbox ? [Math.round(s.bbox.w), Math.round(s.bbox.h)] : undefined,
      centerMM: s.bbox ? [Math.round(s.bbox.x0 + s.bbox.w / 2), Math.round(s.bbox.y0 + s.bbox.h / 2)] : undefined,
    })),
    regions: regions.map(r => ({
      areaM2: Math.round(r.areaMM2 / 1e6 * 100) / 100, nEdges: r.nEdges, selfClosed: !!r.self,
    })),
    counts,
  };
  return { shapes, regions, counts, summary, opts };
}

return { analyze, _internal: { rdp, fitCircle, fitStroke, detectRegions, perpDist } };
})();
