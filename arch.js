/* ============================================================
   Parti 건축 지식 엔진 — AI(API) 없이 알고리즘만으로 평면을 만든다
   ------------------------------------------------------------
   · STD      : 보편적 작도 표준 치수 (벽두께·층고·문창 규격·실별 면적)
   · roomType : 면적·비율로 실 용도 추정
   · plan()   : 실 구성(program) → 재귀 이분할(guillotine)로 실 배치 → 벽/문/창/슬래브
   설계 의도: 하드코딩된 도면 몇 장이 아니라 '면적을 나누는 규칙'이라 평수·실 구성이
   달라져도 그럴듯한 평면이 나온다. 결과는 bim 태그가 붙은 CAD 개체 — 3D·단면이 즉시 따라온다.
   ============================================================ */
window.PARTI_ARCH = (() => {
'use strict';
const B = () => window.WEBCAD_AI_BRIDGE;

// ---------- 표준 치수 (mm) — 국내 주거 보편값 ----------
const STD = {
  wallExt: 200, wallInt: 100,      // 외벽·내벽 두께
  ceil: 2400, ceilLiving: 2400,    // 층고(천장고)
  doorW: 900, doorH: 2100,         // 실내문
  entryW: 1000, entryH: 2100,      // 현관문
  bathDoorW: 800,
  winW: 1500, winH: 1200, winSill: 900,   // 일반 창
  bathWinW: 600, bathWinH: 600, bathWinSill: 1500,
  slabT: 150,
  corridor: 1200,                  // 복도 유효폭
  minRoom: 4.0,                    // 최소 실 면적(㎡) — 이보다 작게는 안 쪼갠다
};

// ---------- 실 용도 추정 — 면적·형상비 (스케치 인식 결과 보조용) ----------
function roomType(areaM2, ratio) {
  const r = ratio > 1 ? ratio : 1 / (ratio || 1);
  if (areaM2 < 2.5) return '현관';
  if (areaM2 < 6) return r > 2.4 ? '복도' : '욕실';
  if (areaM2 < 9) return '침실';
  if (areaM2 < 14) return r > 2.2 ? '주방' : '침실';
  if (areaM2 < 22) return '거실';
  return '거실';
}

// ---------- 실 구성 프리셋 — 이름 → [{name, w(가중치=목표 면적비), fixed(고정 면적㎡)}] ----------
// 가중치는 '남은 면적을 나누는 비율', fixed 는 평수와 무관하게 거의 일정한 실(욕실·현관).
const PROGRAMS = {
  oneroom:  { ko: '원룸',   rooms: [{ n: '현관', fix: 2.0 }, { n: '욕실', fix: 4.0 }, { n: '원룸', w: 1 }] },
  oneHalf:  { ko: '1.5룸',  rooms: [{ n: '현관', fix: 2.0 }, { n: '욕실', fix: 4.0 }, { n: '침실', w: 0.38 }, { n: '거실', w: 0.62 }] },
  tworoom:  { ko: '투룸',   rooms: [{ n: '현관', fix: 2.4 }, { n: '욕실', fix: 4.5 }, { n: '주방', w: 0.22 }, { n: '침실', w: 0.3 }, { n: '거실', w: 0.48 }] },
  threeroom:{ ko: '쓰리룸', rooms: [{ n: '현관', fix: 2.6 }, { n: '욕실', fix: 4.5 }, { n: '욕실2', fix: 3.6 }, { n: '주방', w: 0.18 }, { n: '침실', w: 0.19 }, { n: '침실2', w: 0.19 }, { n: '거실', w: 0.44 }] },
  office:   { ko: '사무실', rooms: [{ n: '현관', fix: 3.0 }, { n: '화장실', fix: 4.0 }, { n: '회의실', w: 0.3 }, { n: '업무공간', w: 0.7 }] },
  studio:   { ko: '작업실', rooms: [{ n: '현관', fix: 2.0 }, { n: '욕실', fix: 4.0 }, { n: '창고', w: 0.18 }, { n: '작업실', w: 0.82 }] },
};
// 한국어/자연어 → 프리셋 키
function programOf(text) {
  const t = String(text || '');
  if (/쓰리룸|three|방\s*3|3룸|three-?room/i.test(t)) return 'threeroom';
  if (/투룸|two|방\s*2|2룸|two-?room/i.test(t)) return 'tworoom';
  if (/1\.5|일점오|한칸반/.test(t)) return 'oneHalf';
  if (/사무|오피스|office/i.test(t)) return 'office';
  if (/작업실|스튜디오|공방/.test(t)) return 'studio';
  if (/원룸|스튜디오형|one-?room|studio/i.test(t)) return 'oneroom';
  return null;
}

// ---------- 재귀 이분할 배치 (guillotine) ----------
// 각 실에 '목표 면적'을 주고, 긴 변을 따라 면적 비율대로 자른다.
// 정사각에 가깝게 자르도록 항상 긴 변을 선택 → 길쭉한 방이 잘 안 나온다.
function slice(rect, items) {
  if (items.length === 1) return [{ ...rect, room: items[0] }];
  const total = items.reduce((a, r) => a + r.area, 0);
  // 앞에서부터 담아 절반에 가장 가까운 지점에서 컷
  let acc = 0, cut = 1, best = Infinity;
  for (let i = 1; i < items.length; i++) {
    acc += items[i - 1].area;
    const d = Math.abs(acc / total - 0.5);
    if (d < best) { best = d; cut = i; }
  }
  const aItems = items.slice(0, cut), bItems = items.slice(cut);
  const aArea = aItems.reduce((a, r) => a + r.area, 0);
  const f = aArea / total;
  const horiz = rect.w >= rect.h;                 // 긴 변을 자른다
  const r1 = horiz ? { x: rect.x, y: rect.y, w: rect.w * f, h: rect.h }
                   : { x: rect.x, y: rect.y, w: rect.w, h: rect.h * f };
  const r2 = horiz ? { x: rect.x + rect.w * f, y: rect.y, w: rect.w * (1 - f), h: rect.h }
                   : { x: rect.x, y: rect.y + rect.h * f, w: rect.w, h: rect.h * (1 - f) };
  return slice(r1, aItems).concat(slice(r2, bItems));
}

// ---------- 평면 생성 ----------
// spec: { areaM2 | w,d (mm), program:'oneroom'|…, h(층고), name }
// 반환: { cells:[{x,y,w,h,name}], walls:[…], openings:[…], W,D, areaM2 }
function planLayout(spec) {
  const o = Object.assign({ areaM2: 33, program: 'oneroom', h: STD.ceil }, spec || {});
  const P = PROGRAMS[o.program] || PROGRAMS.oneroom;
  // 외형 — 면적에서 1.35:1 비율 직사각 (한 변 지정 시 그 값 우선)
  let W = o.w, D = o.d;
  if (!W || !D) {
    const A = Math.max(9, o.areaM2) * 1e6;
    W = Math.round(Math.sqrt(A * 1.35) / 100) * 100;
    D = Math.round(A / W / 100) * 100;
  }
  const areaM2 = W * D / 1e6;
  // 실별 목표 면적: 고정 실 먼저 빼고, 나머지를 가중치로
  const fixed = P.rooms.filter(r => r.fix), flex = P.rooms.filter(r => !r.fix);
  const fixSum = fixed.reduce((a, r) => a + r.fix, 0);
  const rest = Math.max(areaM2 * 0.25, areaM2 - fixSum);
  const wSum = flex.reduce((a, r) => a + (r.w || 1), 0) || 1;
  const items = P.rooms.map(r => ({ name: r.n, area: r.fix ? r.fix : rest * (r.w || 1) / wSum }));
  // 현관은 항상 첫 컷(입구 쪽) — 순서를 면적 큰 순으로 두면 거실이 안쪽으로 밀린다
  const cells = slice({ x: 0, y: 0, w: W, h: D }, items).map(c => ({
    x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.w), h: Math.round(c.h), name: c.room.name,
  }));
  // ── 벽: 셀 경계를 모아 중복 제거 → 외벽/내벽 구분 ──
  const EPS = 1;
  const segs = [];
  const push = (x1, y1, x2, y2) => {
    if (Math.hypot(x2 - x1, y2 - y1) < 50) return;
    segs.push({ x1, y1, x2, y2, ext: (Math.abs(x1) < EPS && Math.abs(x2) < EPS) || (Math.abs(x1 - W) < EPS && Math.abs(x2 - W) < EPS)
      || (Math.abs(y1) < EPS && Math.abs(y2) < EPS) || (Math.abs(y1 - D) < EPS && Math.abs(y2 - D) < EPS) });
  };
  for (const c of cells) {
    push(c.x, c.y, c.x + c.w, c.y);                     // 하
    push(c.x + c.w, c.y, c.x + c.w, c.y + c.h);         // 우
    push(c.x, c.y + c.h, c.x + c.w, c.y + c.h);         // 상
    push(c.x, c.y, c.x, c.y + c.h);                     // 좌
  }
  // 같은 선(수평/수직) 위 겹치는 구간 병합 — 공유 벽이 두 번 생기지 않게
  const merged = [];
  const key = (s) => (Math.abs(s.y1 - s.y2) < EPS ? 'h' + Math.round(s.y1) : 'v' + Math.round(s.x1));
  const byLine = new Map();
  for (const s of segs) { const k = key(s); if (!byLine.has(k)) byLine.set(k, []); byLine.get(k).push(s); }
  for (const [k, list] of byLine) {
    const horiz = k[0] === 'h', c0 = parseFloat(k.slice(1));
    const iv = list.map(s => horiz ? [Math.min(s.x1, s.x2), Math.max(s.x1, s.x2)] : [Math.min(s.y1, s.y2), Math.max(s.y1, s.y2)]).sort((a, b) => a[0] - b[0]);
    let cur = iv[0].slice();
    const out = [];
    for (let i = 1; i < iv.length; i++) {
      if (iv[i][0] <= cur[1] + EPS) cur[1] = Math.max(cur[1], iv[i][1]);
      else { out.push(cur); cur = iv[i].slice(); }
    }
    out.push(cur);
    for (const [a, b] of out) {
      const ext = horiz ? (Math.abs(c0) < EPS || Math.abs(c0 - D) < EPS) : (Math.abs(c0) < EPS || Math.abs(c0 - W) < EPS);
      merged.push(horiz ? { x1: a, y1: c0, x2: b, y2: c0, ext } : { x1: c0, y1: a, x2: c0, y2: b, ext });
    }
  }
  // ── 개구부: 내벽마다 문 1개, 외벽에 접한 실마다 창 1개 ──
  const openings = [];
  const cellOf = (mx, my) => cells.find(c => mx > c.x + 1 && mx < c.x + c.w - 1 && my > c.y + 1 && my < c.y + c.h - 1);
  for (const w of merged) {
    if (w.ext) continue;
    const L = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
    const horiz = Math.abs(w.y1 - w.y2) < EPS;
    // 이 내벽이 가르는 두 실 — 욕실이면 좁은 문
    const mx = (w.x1 + w.x2) / 2, my = (w.y1 + w.y2) / 2;
    const a = cellOf(horiz ? mx : mx - 60, horiz ? my - 60 : my);
    const b2 = cellOf(horiz ? mx : mx + 60, horiz ? my + 60 : my);
    const bath = [a, b2].some(c => c && /욕실|화장실/.test(c.name));
    const dw = Math.min(bath ? STD.bathDoorW : STD.doorW, L * 0.6);
    if (L < dw + 300) continue;                          // 너무 짧은 벽엔 문을 안 낸다
    const t = (a && b2) ? 0.5 : 0.5;
    const cx = w.x1 + (w.x2 - w.x1) * t, cy = w.y1 + (w.y2 - w.y1) * t;
    openings.push({ ot: 'door', x1: horiz ? cx - dw / 2 : cx, y1: horiz ? cy : cy - dw / 2,
      x2: horiz ? cx + dw / 2 : cx, y2: horiz ? cy : cy + dw / 2, h: STD.doorH, sill: 0, room: (a || b2 || {}).name });
  }
  for (const c of cells) {
    if (/현관|복도/.test(c.name)) continue;
    // 이 실이 접한 외벽 중 가장 긴 변에 창
    const cands = [];
    if (Math.abs(c.y) < EPS) cands.push({ len: c.w, horiz: true, cx: c.x + c.w / 2, cy: 0 });
    if (Math.abs(c.y + c.h - D) < EPS) cands.push({ len: c.w, horiz: true, cx: c.x + c.w / 2, cy: D });
    if (Math.abs(c.x) < EPS) cands.push({ len: c.h, horiz: false, cx: 0, cy: c.y + c.h / 2 });
    if (Math.abs(c.x + c.w - W) < EPS) cands.push({ len: c.h, horiz: false, cx: W, cy: c.y + c.h / 2 });
    if (!cands.length) continue;
    cands.sort((p, q) => q.len - p.len);
    const e = cands[0];
    const bath = /욕실|화장실/.test(c.name);
    const ww = Math.min(bath ? STD.bathWinW : STD.winW, e.len * 0.6);
    if (ww < 400) continue;
    openings.push({ ot: 'window', x1: e.horiz ? e.cx - ww / 2 : e.cx, y1: e.horiz ? e.cy : e.cy - ww / 2,
      x2: e.horiz ? e.cx + ww / 2 : e.cx, y2: e.horiz ? e.cy : e.cy + ww / 2,
      h: bath ? STD.bathWinH : STD.winH, sill: bath ? STD.bathWinSill : STD.winSill, room: c.name });
  }
  // 현관문 — 현관 실이 접한 외벽에
  const ent = cells.find(c => /현관/.test(c.name));
  if (ent) {
    const cands = [];
    if (Math.abs(ent.y) < EPS) cands.push({ horiz: true, cx: ent.x + ent.w / 2, cy: 0, len: ent.w });
    if (Math.abs(ent.y + ent.h - D) < EPS) cands.push({ horiz: true, cx: ent.x + ent.w / 2, cy: D, len: ent.w });
    if (Math.abs(ent.x) < EPS) cands.push({ horiz: false, cx: 0, cy: ent.y + ent.h / 2, len: ent.h });
    if (Math.abs(ent.x + ent.w - W) < EPS) cands.push({ horiz: false, cx: W, cy: ent.y + ent.h / 2, len: ent.h });
    if (cands.length) {
      cands.sort((p, q) => q.len - p.len);
      const e = cands[0], dw = Math.min(STD.entryW, e.len * 0.7);
      openings.push({ ot: 'door', entry: true, x1: e.horiz ? e.cx - dw / 2 : e.cx, y1: e.horiz ? e.cy : e.cy - dw / 2,
        x2: e.horiz ? e.cx + dw / 2 : e.cx, y2: e.horiz ? e.cy : e.cy + dw / 2, h: STD.entryH, sill: 0, room: '현관' });
    }
  }
  return { cells, walls: merged, openings, W, D, areaM2, program: P.ko, h: o.h };
}

// ---------- 생성 (CAD 개체로) ----------
function buildPlan(spec) {
  const br = B(); if (!br) return null;
  const p = planLayout(spec);
  br.pushUndo();
  br.ensureLayer('벽', '#cfc7ba'); br.ensureLayer('개구부', '#ff9f0a');
  br.ensureLayer('슬래브', '#9aa2af'); br.ensureLayer('실명', '#8fa3c8');
  const counts = { wall: 0, door: 0, window: 0, slab: 0, room: 0 };
  for (const w of p.walls) {
    const e = br.addEntity({ type: 'LINE', layer: '벽', x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 });
    e.bim = { kind: 'wall', h: p.h, t: w.ext ? STD.wallExt : STD.wallInt, base: 0 };
    counts.wall++;
  }
  for (const o of p.openings) {
    const e = br.addEntity({ type: 'LINE', layer: '개구부', x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2 });
    e.bim = { kind: 'opening', ot: o.ot, h: o.h, sill: o.sill, t: STD.wallExt,
      wt: o.ot === 'door' ? (o.entry ? 'swing' : 'swing') : 'wslide' };
    counts[o.ot === 'door' ? 'door' : 'window']++;
  }
  const slab = br.addEntity({ type: 'LWPOLYLINE', layer: '슬래브', closed: true,
    points: [[0, 0], [p.W, 0], [p.W, p.D], [0, p.D]] });
  slab.bim = { kind: 'slab', t: STD.slabT, top: 0 };
  counts.slab++;
  for (const c of p.cells) {
    const t = br.addEntity({ type: 'TEXT', layer: '실명', x: c.x + c.w / 2, y: c.y + c.h / 2,
      height: Math.max(150, Math.min(300, Math.min(c.w, c.h) / 6)),
      text: `${c.name} ${(c.w * c.h / 1e6).toFixed(1)}㎡`, rotation: 0 });
    t.align = 'center'; counts.room++;
  }
  br.refresh();
  return { ...p, counts };
}

// ---------- 매스 근사 (건물 사진 → 박스 + 창) ----------
// 사진에서 얻는 건 층수·베이수·비례뿐이다. 깊이는 사진에 없으므로 기본값(폭×0.6).
// '정확한 복원'이 아니라 '스케일과 리듬이 맞는 매스' — 초기 검토용.
function buildMassing(spec) {
  const br = B(); if (!br) return null;
  const o = Object.assign({ floors: 3, bays: 3, widthMM: 12000, depthMM: 8000, floorH: STD.ceil + 600, windows: null, ox: 0, oy: 0 }, spec || {});
  const W = Math.max(2000, Math.round(o.widthMM)), D = Math.max(2000, Math.round(o.depthMM));
  const H = o.floors * o.floorH;
  const OX = Math.round(o.ox), OY = Math.round(o.oy);   // 원점 오프셋 — 사진 여러 장을 나란히 세울 때
  br.pushUndo();
  br.ensureLayer('벽', '#cfc7ba'); br.ensureLayer('개구부', '#ff9f0a'); br.ensureLayer('슬래브', '#9aa2af');
  const counts = { wall: 0, window: 0, slab: 0 };
  const wall = (x1, y1, x2, y2) => {
    const e = br.addEntity({ type: 'LINE', layer: '벽', x1: x1 + OX, y1: y1 + OY, x2: x2 + OX, y2: y2 + OY });
    e.bim = { kind: 'wall', h: H, t: STD.wallExt, base: 0 }; counts.wall++;
  };
  wall(0, 0, W, 0); wall(W, 0, W, D); wall(W, D, 0, D); wall(0, D, 0, 0);
  // 바닥판 — 층수가 많으면 지면·지붕만 (60층에 판 61장은 검토에 도움이 안 된다)
  const perFloor = o.floors <= 12;
  for (let f = 0; f <= o.floors; f++) {
    if (!perFloor && f > 0 && f < o.floors) continue;
    const s = br.addEntity({ type: 'LWPOLYLINE', layer: '슬래브', closed: true, points: [[OX, OY], [OX + W, OY], [OX + W, OY + D], [OX, OY + D]] });
    s.bim = { kind: 'slab', t: STD.slabT, top: f * o.floorH }; counts.slab++;
  }
  // 창 — 전면(y=0) 격자. 모서리에 너무 붙으면 건너뛴다(구조적으로도 벽이 필요).
  for (const win of (o.windows || [])) {
    const cw = Math.max(600, win.wFrac * W), cx = win.cx * W;
    const wh = Math.max(600, Math.min(o.floorH * 0.7, win.hFrac * H));
    const sill = win.floor * o.floorH + (o.floorH - wh) / 2;
    if (cx - cw / 2 < 300 || cx + cw / 2 > W - 300) continue;
    const e = br.addEntity({ type: 'LINE', layer: '개구부', x1: Math.round(cx - cw / 2) + OX, y1: OY, x2: Math.round(cx + cw / 2) + OX, y2: OY });
    e.bim = { kind: 'opening', ot: 'window', h: Math.round(wh), sill: Math.round(sill), t: STD.wallExt, wt: 'fix' };
    counts.window++;
  }
  br.refresh();
  return { W, D, H, floors: o.floors, bays: o.bays, floorH: o.floorH, counts };
}

// ---------- 다동(多棟) 배치 — 콘셉트 스케치 대응 ----------
// 투시 스케치는 픽셀만으로 복원할 수 없다(깊이·왜곡). 대신 스케치의 '구성'(N동·지붕형·
// 마당 배치)을 사용자에게 확인받아 그 구성대로 세운다. 각 동은 축 정렬(회전 없음) —
// 배치는 스케치의 구성을 따른다: 'arc'(부채꼴로 늘어서고 마당은 그 앞) · 'circle'(마당을 두름) · 'row'(일렬).
// 동은 마당을 향해 회전한다 — roofSolids 가 회전 사각형을 지원하므로 지붕도 함께 돈다.
function buildComplex(spec) {
  const br = B(); if (!br) return null;
  const o = Object.assign({ count: 5, floors: 1, w: 8000, d: 12000, floorH: STD.ceil + 600,
    arrange: 'arc', roof: 'gable', glass: true, courtyardR: 0, massList: null, attached: true,
    ox: 0, oy: 0 }, spec || {});
  const n = Math.max(1, Math.min(12, Math.round(o.count)));
  const H = o.floors * o.floorH;
  br.pushUndo();
  br.ensureLayer('벽', '#cfc7ba'); br.ensureLayer('개구부', '#ff9f0a');
  br.ensureLayer('지붕', '#b8695a'); br.ensureLayer('조경', '#6aa84f'); br.ensureLayer('문자', '#8fa3c8');
  const counts = { wall: 0, window: 0, roof: 0, court: 0 };

  // 동별 폭·지붕 높이 — 스케치에서 읽은 비율이 있으면 그대로, 없으면 균일
  const ml = (o.massList && o.massList.length === n) ? o.massList : null;
  const hMax = ml ? Math.max.apply(null, ml.map(m => m.hFrac || 1)) || 1 : 1;
  const Ws = [], rises = [];
  for (let i = 0; i < n; i++) {
    const wf = ml ? (ml[i].wFrac || 1 / n) * n : 1;
    Ws.push(Math.max(3000, Math.round(o.w * Math.min(2.2, Math.max(0.45, wf)))));
    const hf = ml ? (ml[i].hFrac || 1) / hMax : 1;
    rises.push(Math.round(Math.min(o.w, o.d) * 0.35 * (0.6 + 0.8 * hf)));
  }
  const gap = o.attached ? 0 : Math.round(o.w * 0.45);
  const L = Ws.reduce((a, v) => a + v, 0) + gap * (n - 1);   // 늘어선 전체 길이

  const wall = (p, q) => {
    const e = br.addEntity({ type: 'LINE', layer: '벽',
      x1: Math.round(p[0]), y1: Math.round(p[1]), x2: Math.round(q[0]), y2: Math.round(q[1]) });
    e.bim = { kind: 'wall', h: H, t: STD.wallExt, base: 0 }; counts.wall++;
  };
  // 동 하나: 중심 C, 접선 t(폭 방향), 법선 u(마당 반대쪽이 +u) → 회전된 사각형
  const place = (i, C, t, u) => {
    const W2 = Ws[i] / 2, D2 = o.d / 2;
    const P = [
      [C[0] - t[0] * W2 - u[0] * D2, C[1] - t[1] * W2 - u[1] * D2],   // 앞-좌 (마당 쪽)
      [C[0] + t[0] * W2 - u[0] * D2, C[1] + t[1] * W2 - u[1] * D2],   // 앞-우
      [C[0] + t[0] * W2 + u[0] * D2, C[1] + t[1] * W2 + u[1] * D2],   // 뒤-우
      [C[0] - t[0] * W2 + u[0] * D2, C[1] - t[1] * W2 + u[1] * D2],   // 뒤-좌
    ];
    for (let k = 0; k < 4; k++) wall(P[k], P[(k + 1) % 4]);
    if (o.roof && o.roof !== 'none') {
      const r2 = br.addEntity({ type: 'LWPOLYLINE', layer: '지붕', closed: true,
        points: P.map(p => [Math.round(p[0]), Math.round(p[1])]) });
      r2.bim = { kind: 'roof', rtype: o.roof, eave: H, rise: rises[i],
        dir: (Ws[i] >= o.d ? 'x' : 'y') };
      counts.roof++;
    }
    if (o.glass) {                                    // 마당을 향한 앞면 전체 유리
      const m = 600, a = P[0], b = P[1];
      const dx = b[0] - a[0], dy = b[1] - a[1], Lf = Math.hypot(dx, dy) || 1;
      const e = br.addEntity({ type: 'LINE', layer: '개구부',
        x1: Math.round(a[0] + dx / Lf * m), y1: Math.round(a[1] + dy / Lf * m),
        x2: Math.round(b[0] - dx / Lf * m), y2: Math.round(b[1] - dy / Lf * m) });
      e.bim = { kind: 'opening', ot: 'window', wt: 'fix', h: H - 600, sill: 300, t: STD.wallExt };
      counts.window++;
    }
    br.addEntity({ type: 'TEXT', layer: '문자', x: Math.round(C[0]), y: Math.round(C[1]), h: 400, text: (i + 1) + '동' });
  };

  let R = 0, courtC = [o.ox, o.oy];
  if (o.arrange === 'row') {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const C = [o.ox + s + Ws[i] / 2, o.oy];
      place(i, C, [1, 0], [0, 1]);                    // 앞면은 -y (아래) 방향
      s += Ws[i] + (gap || Math.round(o.w * 0.5));
    }
  } else if (o.arrange === 'circle') {
    const foot = Math.max(o.w, o.d);
    R = o.courtyardR || Math.max(6000, Math.round((n * (foot + 3000)) / (2 * Math.PI)));
    const ring = R + o.d / 2 + 2500;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      const u = [Math.cos(a), Math.sin(a)];           // 바깥 방향
      const C = [o.ox + ring * u[0], o.oy + ring * u[1]];
      place(i, C, [-u[1], u[0]], u);
    }
  } else {                                            // 'arc' — 완만한 부채꼴, 마당은 그 앞
    // 스케치의 부채는 완만하다 — 크게 휘면 '마당을 두른 링'처럼 보여 원본과 달라진다(실측 후 조정)
    const span = Math.PI * (n <= 2 ? 0.16 : 0.32);    // 약 29~58°
    const ring = Math.max(L / span, o.d * 1.6);
    let s = 0;
    for (let i = 0; i < n; i++) {
      const sc = s + Ws[i] / 2;                       // 이 동의 호 위 위치(중앙)
      // ★부호는 '-' — 그림 왼쪽 동이 도면에서도 왼쪽에 와야 한다(뒤집혀 나오던 것 수정).
      // 중앙 동이 원점에 오도록 ring 만큼 내려 배치 → 양 끝이 아래로 벌어지는 완만한 부채꼴.
      const a = Math.PI / 2 - (sc - L / 2) / ring;
      const u = [Math.cos(a), Math.sin(a)];
      const C = [o.ox + ring * u[0], o.oy + ring * u[1] - ring];
      place(i, C, [-u[1], u[0]], u);
      s += Ws[i] + gap;
    }
    // 마당은 '호의 중심'이 아니라 '늘어선 줄 바로 앞'에 놓는다.
    // 호가 완만할수록 중심은 아득히 멀어서, 중심에 두면 마당이 건물에서 수십 m 떨어진다(실측).
    R = Math.max(3000, Math.round(L / 5));
    courtC = [o.ox, o.oy - o.d / 2 - R - 3000];
  }
  if (R > 0) {                                        // 마당 — 잔디
    const ct = br.addEntity({ type: 'CIRCLE', layer: '조경',
      cx: Math.round(courtC[0]), cy: Math.round(courtC[1]), r: Math.round(R) });
    ct.bim = { kind: 'slab', t: 100, top: 0 }; counts.court = 1;
  }
  br.refresh();
  return { n, floors: o.floors, H, R: Math.round(R), L, widths: Ws, counts, arrange: o.arrange };
}

return { STD, roomType, PROGRAMS, programOf, planLayout, buildPlan, buildMassing, buildComplex };
})();
