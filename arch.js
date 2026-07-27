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
  // ★1층용 — 상가(근린생활). 아랫층과 윗층이 같은 구성인 건물은 실제로 드물다.
  shop:     { ko: '상가',   rooms: [{ n: '화장실', fix: 4.0 }, { n: '창고', fix: 4.0 }, { n: '점포1', w: 0.5 }, { n: '점포2', w: 0.5 }] },
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
  if (/상가|점포|근생|근린생활|리테일|retail|shop/i.test(t)) return 'shop';
  if (/필로티|피로티|piloti|기둥만|비워/i.test(t)) return 'piloti';
  return null;
}
// ── 층별 구성 ──
// ★1층과 윗층이 같은 건물은 실제로 드물다(1층은 상가·필로티, 윗층은 주거).
//   구성이 같은 연속 층을 묶어 한 번씩만 구획한다 — 구획기는 층을 모르고 '한 판'만 만든다.
function floorGroups(o) {
  const N = Math.max(1, o.floors || 1);
  const fp = Object.assign({}, o.floorProgram || {});
  if (o.ground && fp[1] == null) fp[1] = o.ground;
  const out = [];
  for (let fl = 1; fl <= N; fl++) {
    const pg = fp[fl] != null ? fp[fl] : (fp[String(fl)] != null ? fp[String(fl)] : null);
    const last = out[out.length - 1];
    if (last && last.program === pg) last.floors.push(fl);
    else out.push({ program: pg, floors: [fl] });
  }
  return out;
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
// ── ★내부 실 구획 ── (부채꼴·일렬·링 배치가 함께 쓴다)
// 결과물이 외피뿐이면 안이 통째로 빈다. 네 꼭짓점으로 둘러싸인 어떤 사각형이든 (x, y)
// 매개변수 공간에서는 직사각형이므로, 이미 검증된 재귀 이분할기 slice() 를 그 공간에서
// 돌리고 겹선형 보간으로 되돌리면 그대로 실 구획이 된다 — 배치마다 새 알고리즘이 필요 없다.
// ★부채꼴은 각도축을 '호길이'로 환산해 넘긴다(W). 라디안 그대로 주면 slice() 의
//   '긴 변을 자른다' 판정이 무의미해져 실이 전부 한 방향으로만 잘린다.
//   일렬·링 배치는 직사각형이라 W 가 곧 동 폭이다.
function buildInterior(br, o, counts, roomSeq, ctx) {
  const FL = ctx.FL, FR = ctx.FR, BR = ctx.BR, BL = ctx.BL;
  const arcW = ctx.W, Di = ctx.D, chord = ctx.chord, wSh = ctx.wSh || null;
  const curMat = ctx.mat || null;
  // ★어느 층에 이 구획을 놓을지 받는다. 예전엔 '전 층'에 같은 판을 찍었다 —
  //   그래서 1층 상가·윗층 주거 같은 실제 건물을 만들 수가 없었다.
  const FLOORS = (ctx.floors && ctx.floors.length) ? ctx.floors
    : Array.from({ length: Math.max(1, o.floors || 1) }, (_, k) => k + 1);
  // 올라갈 계단이 필요한 층 — 최상층은 없다. 필로티처럼 건너뛴 층 몫도 여기로 넘어온다.
  const STF = ctx.stairFloors || FLOORS.filter(fl => fl < (o.floors || 1));
  if (o.rooms !== false && Di >= 3000 && chord >= 3000) {
        const areaM2 = arcW * Di / 1e6;
    const prog = ctx.program || o.program || (areaM2 < 26 ? 'oneroom' : areaM2 < 40 ? 'oneHalf'
      : areaM2 < 60 ? 'tworoom' : 'threeroom');
    const P = PROGRAMS[prog] || PROGRAMS.oneroom;
    const fixed = P.rooms.filter(r2 => r2.fix), flex = P.rooms.filter(r2 => !r2.fix);
    const fixSum = fixed.reduce((a2, r2) => a2 + r2.fix, 0);
    const restA = Math.max(areaM2 * 0.25, areaM2 - fixSum);
    const wSum = flex.reduce((a2, r2) => a2 + (r2.w || 1), 0) || 1;
    const items = P.rooms.map(r2 => ({ name: r2.n, area: r2.fix ? r2.fix : restA * (r2.w || 1) / wSum }));
    // ── ★복도를 아는 배치 (중복도) ──
    // 재귀 이분할기는 복도를 모른다. 뒤쪽에 복도 띠만 두었더니 뒷줄 방만 복도에 닿고
    // 나머지는 이웃을 거쳤다(실측: 내부문 21개 중 6개만 복도에 면함).
    // → 복도를 앞뒤로 관통시키고(중복도) 방을 양쪽 밴드에 '깊이로만' 나눈다.
    //   그러면 밴드의 모든 방이 복도변에 자기 면을 갖는다 — 동선이 원리적으로 보장된다.
    //   폭이 좁아 밴드가 성립하지 않으면(복도폭+5m 미만) 예전처럼 이분할기로 돌아간다.
    // ★쐐기는 앞이 좁고 뒤가 넓다 — 매개변수 폭을 그대로 쓰면 복도가 앞에서 유효폭 미만이
    //   된다. 가장 좁은 앞쪽(현 chord)에서 STD.corridor 를 지키도록 되돌려 잡는다.
    const CORR = STD.corridor * Math.max(1, arcW / Math.max(1, chord));
    const useCorr = o.corridor !== false && arcW >= CORR + 5000 && items.length >= 3;
    const xc0 = (arcW - CORR) / 2, xc1 = xc0 + CORR;     // 복도 좌·우 선
    let cells, corrCell = null;
    if (useCorr) {
      corrCell = { x: xc0, y: 0, w: CORR, h: Di, room: { name: '복도' } };
      // ★배분 기준은 면적이 아니라 '창이 필요한가'다.
      //   면적만 보고 담으면 한 밴드에 침실이 셋 몰려 가운데 하나가 창을 못 받는다(실측).
      //   밴드의 창 자리는 앞·뒤 두 곳뿐이므로, 거주실을 밴드마다 둘씩 나눠 담는다.
      //   현관은 복도가 있으면 뺀다 — 복도 앞끝이 곧 현관이라 따로 두면 뒤로 밀린다.
      const NEEDWIN = /침실|거실|주방|작업|업무|회의|원룸/;
      const src = items.filter(it => !/현관/.test(it.name));
      const need0 = src.filter(it => NEEDWIN.test(it.name)).sort((a2, b2) => b2.area - a2.area);
      const rest0 = src.filter(it => !NEEDWIN.test(it.name)).sort((a2, b2) => b2.area - a2.area);
      const LB = [], RB = [];
      need0.forEach((it, k) => (k % 2 ? RB : LB).push(it));      // 거주실을 번갈아
      let la = LB.reduce((a2, v) => a2 + v.area, 0), ra = RB.reduce((a2, v) => a2 + v.area, 0);
      for (const it of rest0) { if (la <= ra) { LB.push(it); la += it.area; } else { RB.push(it); ra += it.area; } }
      // ★최소 실 깊이를 보장한다 — 면적 비례로만 나누면 욕실이 90cm 깊이가 된다(실측).
      //   먼저 모두에게 최소값을 주고 남은 깊이만 면적 비례로 나눈다.
      //   그래도 다 못 들어가면 작은 실부터 뺀다 — 들어가지도 않는 실을 그리지 않는다.
      const MINRD = 1800;
      // ★창이 필요한 실은 밴드 양 끝(앞·뒤)에 놓는다.
      //   면적 순으로만 쌓으면 침실이 밴드 가운데에 갇혀 외벽에 닿지 못한다
      //   (실측: 21실 중 6실이 창 없는 방 — 침실2·욕실·욕실2).
      //   욕실·현관·창고는 창이 없어도 성립하므로 가운데를 맡는다.
      const band = (bx, bw, list) => {
        let L2 = list.slice();
        while (L2.length > 1 && L2.length * MINRD > Di) {
          L2.sort((a2, b2) => a2.area - b2.area); L2.shift();
        }
        {
          const need = L2.filter(it => NEEDWIN.test(it.name));
          const rest = L2.filter(it => !NEEDWIN.test(it.name));
          if (need.length && rest.length) {
            need.sort((a2, b2) => b2.area - a2.area);
            const head = need.shift();                    // 가장 큰 실은 앞(마당 쪽)
            const tail = need.length ? [need.pop()] : [];  // 그 다음은 뒤
            L2 = [head].concat(need, rest, tail);
          }
        }
        const tot = L2.reduce((a2, v) => a2 + v.area, 0) || 1;
        const rem = Di - L2.length * MINRD;
        const hs = rem >= 0 ? L2.map(it => MINRD + rem * it.area / tot)
          : L2.map(() => Di / L2.length);
        let y = 0; const out2 = [];
        L2.forEach((it, k) => {
          const hh = (k === L2.length - 1) ? (Di - y) : hs[k];
          out2.push({ x: bx, y, w: bw, h: hh, room: { name: it.name } });
          y += hh;
        });
        return out2;
      };
      cells = band(0, xc0, LB).concat(band(xc1, arcW - xc1, RB));
      cells.push(corrCell);
    } else {
      cells = slice({ x: 0, y: 0, w: arcW, h: Di }, items);
    }
    // ── (x, y) → 세계 좌표 ──
    // ★쐐기 네 꼭짓점의 겹선형(bilinear) 보간을 쓴다. 호를 다시 각도로 되돌리면
    //   실 경계가 호를 여러 조각으로 근사하는 셈이라, 현 하나로 그린 '벽·바닥판'보다
    //   바깥으로 부푼다(실측: 실 면적 합이 건축면적보다 0.9% 컸다).
    //   벽이 현이면 실도 같은 현 위에 있어야 한다 — 그래야 실 면적 합 = 건축면적이다.
    const PXY = (x, y) => {
      const u = Math.max(0, Math.min(1, x / arcW)), v = Math.max(0, Math.min(1, y / Di));
      const px = (1 - u) * (1 - v) * FL[0] + u * (1 - v) * FR[0] + u * v * BR[0] + (1 - u) * v * BL[0];
      const py = (1 - u) * (1 - v) * FL[1] + u * (1 - v) * FR[1] + u * v * BR[1] + (1 - u) * v * BL[1];
      return wSh ? [px + wSh[0], py + wSh[1]] : [px, py];   // 기운 동이면 벽도 같이 기운다
    };
    const EPS2 = 1;
    const onEdge = (a2, b2, lim) => Math.abs(a2 - lim) < EPS2 && Math.abs(b2 - lim) < EPS2;
    const seen = new Set();
    const madeWalls = [];                                // {key, cell, A, B, len}
    const extEdges = [];                                 // 실이 외벽에 면한 변 (창 자리)
    for (const c of cells) {
      const x1 = c.x, x2 = c.x + c.w, y1 = c.y, y2 = c.y + c.h;
      // 셀의 네 변 중 '쐐기 외곽에 붙은 변'은 이미 외벽이 있으므로 만들지 않는다
      const edges = [
        [x1, y1, x2, y1, onEdge(y1, y1, 0)],                 // 앞(마당 쪽)
        [x1, y2, x2, y2, onEdge(y2, y2, Di)],             // 뒤
        [x1, y1, x1, y2, onEdge(x1, x1, 0)],                 // 좌
        [x2, y1, x2, y2, onEdge(x2, x2, arcW)],              // 우
      ];
      void corrCell;
      for (const [ax, ay, bx, by, isExt] of edges) {
        if (isExt) {
          // ★외벽에 면한 변은 창 자리 후보다. 단 이웃과 공유하는 측벽(세대분리벽)은
          //   창을 뚫으면 옆 동으로 뚫린다 — 무리 끝동이거나 떨어져 있을 때만 쓴다.
          const vert = Math.abs(ax - bx) < EPS2;
          const outer = !vert ? true
            : (Math.abs(ax) < EPS2 ? ctx.sideExtL !== false : ctx.sideExtR !== false);
          if (outer && c !== corrCell) {
            const A3 = PXY(ax, ay), B3 = PXY(bx, by);
            const L3 = Math.hypot(B3[0] - A3[0], B3[1] - A3[1]);
            if (L3 >= 1500) extEdges.push({ cell: c, A: A3, B: B3, len: L3 });
          }
          continue;
        }
        const k = [Math.round(ax), Math.round(ay), Math.round(bx), Math.round(by)].join(',');
        const k2 = [Math.round(bx), Math.round(by), Math.round(ax), Math.round(ay)].join(',');
        if (seen.has(k) || seen.has(k2)) continue;           // 이웃 실과 공유하는 벽은 한 번만
        seen.add(k);
        const A2 = PXY(ax, ay), B2 = PXY(bx, by);
        const len2 = Math.hypot(B2[0] - A2[0], B2[1] - A2[1]);
        if (len2 < 600) continue;
        for (const fl2 of FLOORS) {
          const f = fl2 - 1;
          const iw = br.addEntity({ type: 'LINE', layer: '벽',
            x1: Math.round(A2[0]), y1: Math.round(A2[1]),
            x2: Math.round(B2[0]), y2: Math.round(B2[1]) });
          iw.bim = { kind: 'wall', h: STD.ceil, t: STD.wallInt, base: f * o.floorH };
          if (wSh) iw.bim.shear = wSh;
          if (curMat) iw.mat = curMat;
          counts.wall++;
        }
        // 복도에 면한 변 — 복도의 좌·우 선 위에 놓인 세로 변
        madeWalls.push({ cell: c, A: A2, B: B2, len: len2,
          corr: useCorr && Math.abs(ax - bx) < EPS2
            && (Math.abs(ax - xc0) < EPS2 || Math.abs(ax - xc1) < EPS2) });
      }
      // ── 실을 '면적을 가진 객체'로 남긴다 ──
      // 이름표만 찍으면 면적표를 뽑을 수 없다. 실 경계를 폴리라인으로 남기고 면적을 함께
      // 실어 두면 층별·실별 면적이 데이터에서 바로 나온다(층마다 하나씩 — 연면적 계산용).
      const RP2 = [PXY(c.x, c.y), PXY(c.x + c.w, c.y),
        PXY(c.x + c.w, c.y + c.h), PXY(c.x, c.y + c.h)];
      const a2 = Math.abs(RP2.reduce((acc, p, k) =>
        acc + (p[0] * RP2[(k + 1) % 4][1] - RP2[(k + 1) % 4][0] * p[1]), 0)) / 2;   // 실측 폴리곤 면적
      // ★실번호 — 층 백단위 + 순번(101, 102 …). 도면 표기와 면적표가 이 번호로 이어진다.
      const nos = [];
      for (const fl of FLOORS) {
        const f = fl - 1;
        const seq = (roomSeq.get(fl) || 0) + 1; roomSeq.set(fl, seq);
        const no = fl * 100 + seq;
        nos.push(no);
        const rp = br.addEntity({ type: 'LWPOLYLINE', layer: '실', closed: true,
          points: RP2.map(p => [Math.round(p[0]), Math.round(p[1])]) });
        rp.bim = { kind: 'room', name: c.room.name, areaM2: +(a2 / 1e6).toFixed(2),
          top: f * o.floorH, floor: fl, no };
      }
      // ── 실명·면적 표기 ──
      // 이름만 찍으면 도면에서 크기를 읽을 수 없다. 번호·이름 한 줄, 면적 한 줄로 적어
      // 면적표와 같은 번호로 서로 참조되게 한다(한국 실무 실별 면적표 방식).
      const cm2 = PXY(c.x + c.w / 2, c.y + c.h / 2);
      const TH2 = 280;
      // ★크기는 height 다. h 로 넣으면 e.height 가 undefined 가 되어 글자 크기가 NaN 이 되고,
      //   경계상자도 NaN 이라 이름표가 도면 범위·시트 배치에서 통째로 빠진다.
      // ★층을 달아 둔다 — 층별 평면도가 '1층 것'을 2층 도면에 얹지 않으려면 필요하다.
      br.addEntity({ type: 'TEXT', layer: '문자', x: Math.round(cm2[0]),
        y: Math.round(cm2[1] + TH2 * 0.7), height: TH2, text: nos[0] + ' ' + c.room.name,
        bim: { kind: 'label', floor: 1 } });
      br.addEntity({ type: 'TEXT', layer: '문자', x: Math.round(cm2[0]),
        y: Math.round(cm2[1] - TH2 * 0.7), height: TH2 * 0.8,
        text: (a2 / 1e6).toFixed(1) + '㎡', bim: { kind: 'label', floor: 1 } });
      counts.room++;
    }
    // ── 실내문 ──
    // ★내벽마다 문을 달면 안 된다(실측: 3동에 문 39개). 방 하나에 문 하나면 모든 방이
    //   서로 이어진다(연결 트리). 첫 실은 현관 쪽이므로 건너뛴다.
    // ★복도가 있으면 '복도에 면한 벽'을 최우선으로 고른다 — 그래야 방을 지나지 않는다.
    //   복도 자신과 (복도가 없을 때는) 첫 실은 문을 받지 않는다.
    const doored = new Set([corrCell || cells[0]]);
    for (const c of cells) {
      if (doored.has(c)) continue;
      const all2 = madeWalls.filter(mw => mw.cell === c);
      const pref = all2.filter(mw => mw.corr);
      const mine = (pref.length ? pref : all2).sort((a2, b2) => b2.len - a2.len);
      if (!mine.length) continue;
      const mw = mine[0];
      doored.add(c);
      const L2 = mw.len, ux2 = (mw.B[0] - mw.A[0]) / L2, uy2 = (mw.B[1] - mw.A[1]) / L2;
      const dw2 = Math.min(STD.doorW, L2 * 0.6);
      const mx2 = (mw.A[0] + mw.B[0]) / 2, my2 = (mw.A[1] + mw.B[1]) / 2;
      for (const fl2 of FLOORS) {
          const f = fl2 - 1;
        const dpe = br.addEntity({ type: 'LINE', layer: '개구부',
          x1: Math.round(mx2 - ux2 * dw2 / 2), y1: Math.round(my2 - uy2 * dw2 / 2),
          x2: Math.round(mx2 + ux2 * dw2 / 2), y2: Math.round(my2 + uy2 * dw2 / 2) });
        dpe.bim = { kind: 'opening', ot: 'door', wt: 'swing',
          h: STD.doorH, sill: f * o.floorH, t: STD.wallInt };
        counts.door++;
      }
    }
    // ── ★실마다 창 ──
    // 창을 외피에만 균일하게 뚫으면 어떤 방은 창이 없고 어떤 방은 여러 개가 된다.
    // 실이 객체가 된 지금은 '이 실의 외벽 구간에 개구부가 하나라도 있는가'를 물을 수 있다.
    // 없으면 그 구간 한가운데에 하나 넣는다 — 창 없는 방을 만들지 않는다.
    {
      const ops = br.state.entities.filter(e2 => e2.bim && e2.bim.kind === 'opening'
        && e2.bim.ot === 'window' && e2.type === 'LINE');
      const byCell = new Map();
      for (const ee of extEdges) {
        if (!byCell.has(ee.cell)) byCell.set(ee.cell, []);
        byCell.get(ee.cell).push(ee);
      }
      for (const [c, list] of byCell) {
        const best = list.slice().sort((a2, b2) => b2.len - a2.len)[0];
        const ux2 = (best.B[0] - best.A[0]) / best.len, uy2 = (best.B[1] - best.A[1]) / best.len;
        // 이 구간에 이미 창이 있는가 — 개구부 중심을 이 변에 투영해 안에 들어오는지
        const has = ops.some(e2 => {
          const mx2 = (e2.x1 + e2.x2) / 2, my2 = (e2.y1 + e2.y2) / 2;
          const t3 = (mx2 - best.A[0]) * ux2 + (my2 - best.A[1]) * uy2;
          if (t3 < 0 || t3 > best.len) return false;
          const px2 = best.A[0] + ux2 * t3, py2 = best.A[1] + uy2 * t3;
          return Math.hypot(mx2 - px2, my2 - py2) < 400;      // 같은 벽면 위
        });
        if (has) continue;
        const bath = /욕실|화장실/.test(c.room.name);
        const ww2 = Math.min(bath ? STD.bathWinW : STD.winW, best.len * 0.5);
        if (ww2 < 500) continue;
        const s3 = best.len / 2;
        for (const fl2 of FLOORS) {
          const f = fl2 - 1;
          const e3 = br.addEntity({ type: 'LINE', layer: '개구부',
            x1: Math.round(best.A[0] + ux2 * (s3 - ww2 / 2)),
            y1: Math.round(best.A[1] + uy2 * (s3 - ww2 / 2)),
            x2: Math.round(best.A[0] + ux2 * (s3 + ww2 / 2)),
            y2: Math.round(best.A[1] + uy2 * (s3 + ww2 / 2)) });
          // src='room' — 그림에서 읽은 창·커튼월과 구분한다(판독 결과를 검사하는 회귀가
          // 이 창까지 세면 의미가 흐려진다). 창호일람표에는 똑같이 잡힌다.
          e3.bim = { kind: 'opening', ot: 'window', wt: 'fix', src: 'room',
            h: bath ? STD.bathWinH : STD.winH,
            sill: f * o.floorH + (bath ? STD.bathWinSill : STD.winSill), t: STD.wallExt };
          counts.window++;
        }
      }
    }
    // ── ★계단 ──
    // 2층 이상인데 계단이 없으면 위층에 올라갈 수 없다. 복도 한쪽 끝에 직선 계단을 놓는다.
    // 경로 선(시작=아랫단, 끝=윗단)에 bim.kind='stair' 를 달면 평면 심볼과 3D 를 cad.js 가
    // 같은 기하로 만들어 준다.
    if (useCorr && STF.length) {
      const RISER = 180, run = Math.max(2400, Math.min(Di * 0.55, (o.floorH / RISER) * 280));
      const sy = xc0 + CORR / 2;                          // 복도 한가운데 (앞뒤로 오른다)
      for (const flS of STF) {
        const f = flS - 1;
        const S1 = PXY(sy, Di * 0.06), S2 = PXY(sy, Di * 0.06 + run);
        const st = br.addEntity({ type: 'LINE', layer: '벽',
          x1: Math.round(S1[0]), y1: Math.round(S1[1]),
          x2: Math.round(S2[0]), y2: Math.round(S2[1]) });
        st.bim = { kind: 'stair', w: Math.min(1200, CORR - 100), h: o.floorH,
          riser: RISER, base: f * o.floorH };
        counts.stair = (counts.stair || 0) + 1;
        // ★계단 난간 — 난간 없는 계단은 3D 에서 '판만 떠 있는' 꼴이고 실제로도 위법이다.
        //   (건축물의 피난·방화구조 규칙: 높이 1m 넘는 계단에는 난간)
        //   경로에 높이가 있어야 난간이 경사를 따라가므로 z1/z2 를 준다.
        const rl = br.addEntity({ type: 'LINE', layer: '벽',
          x1: st.x1, y1: st.y1, x2: st.x2, y2: st.y2 });
        rl.z1 = f * o.floorH; rl.z2 = (f + 1) * o.floorH;
        rl.bim = { kind: 'railing', h: 1000, t: 50, postT: 60, spacing: 1100,
          base: f * o.floorH };
        counts.rail = (counts.rail || 0) + 1;
      }
    }
  }
}

// 동은 마당을 향해 회전한다 — roofSolids 가 회전 사각형을 지원하므로 지붕도 함께 돈다.
function buildComplex(spec) {
  const br = B(); if (!br) return null;
  const o = Object.assign({ count: 5, floors: 1, w: 8000, d: 12000, floorH: STD.ceil + 600,
    arrange: 'arc', roof: 'gable', glass: true, courtyardR: 0, massList: null, attached: true, lean: 0, depths: null,
    mat: null, rooms: true, program: null, site: true,
    ox: 0, oy: 0 }, spec || {});
  const n = Math.max(1, Math.min(12, Math.round(o.count)));
  const H = o.floors * o.floorH;
  br.pushUndo();
  br.ensureLayer('벽', '#cfc7ba'); br.ensureLayer('개구부', '#ff9f0a');
  br.ensureLayer('지붕', '#b8695a'); br.ensureLayer('조경', '#6aa84f'); br.ensureLayer('문자', '#8fa3c8');
  br.ensureLayer('유리', '#7ea6d1'); br.ensureLayer('조경길', '#e0dacc'); br.ensureLayer('바닥', '#bdb6a8');
  br.ensureLayer('홈통', '#8d9099'); br.ensureLayer('실', '#9fb3c8');
  const counts = { wall: 0, window: 0, door: 0, roof: 0, court: 0, slab: 0, room: 0 };
  // ── 치수 근거(웹 조사) ──
  // · 주거 박공 물매 4:12~9:12 (18.4~36.9°) — KCS 41 56 05 아스팔트 싱글 적용범위 1/3~3/4
  // · 처마(eave) 내밀기 305~610mm, 박공측(rake/verge) 152~305mm — IRC R804 / 실무 표준
  // · 방화벽은 지붕면 위로 500mm 이상 돌출 — 건축물의 피난·방화구조 규칙 제21조
  //   (나란한 박공동 사이에 연속된 골(valley)을 만들지 않는 실무 해법이기도 하다)
  const RIDGE_F = 0.42;      // 비대칭 박공 — 용마루가 폭의 42% 지점 (스케치의 치우친 봉우리)
  const RAKE = 300;          // 박공측(앞뒤) 내밀기
  const EAVE = 500;          // 처마측(양 끝동 바깥) 내밀기
  const OVH = RAKE;
  const PARTY = 200;         // 세대분리벽(측벽) 두께
  const FIREW = 500;         // 방화벽이 지붕면 위로 솟는 높이

  // 동별 폭·지붕 높이 — 스케치에서 읽은 비율이 있으면 그대로, 없으면 균일
  const ml = (o.massList && o.massList.length === n) ? o.massList : null;
  const hMax = ml ? Math.max.apply(null, ml.map(m => m.hFrac || 1)) || 1 : 1;
  const Ws = [], pitches = [], Hs = [];
  for (let i = 0; i < n; i++) {
    const wf = ml ? (ml[i].wFrac || 1 / n) * n : 1;
    Ws.push(Math.max(3000, Math.round(o.w * Math.min(2.2, Math.max(0.45, wf)))));
    const hf = ml ? (ml[i].hFrac || 1) / hMax : 1;
    // 물매 — 스케치의 봉우리 높이 비율로. 급경사 상한 12:12(45°)까지 허용한다:
    // 4:12~9:12 는 아스팔트 싱글 주거 기준이고, 이런 유리·금속 파빌리온은 더 가파르다.
    pitches.push(0.50 + 0.50 * hf);
    // ★처마 높이도 동마다 다르게 — 같으면 지붕이 하나로 이어져 '부채 지붕' 한 덩어리로 읽힌다.
    //   스케치는 높이가 제각각인 개별 파빌리온이다.
    Hs.push(Math.round(H * (0.82 + 0.36 * hf)));
  }
  // 용마루 높이 — 비대칭 박공은 두 면의 물매가 다르다. 급한 쪽(짧은 run = min(rF,1-rF))을
  // 기준으로 잡아야 두 면 모두 규범 범위에 들어온다. (긴 쪽만 보면 급한 쪽이 상한을 넘는다)
  const riseOf = (i, span) => Math.round(Math.max(600, span * Math.min(RIDGE_F, 1 - RIDGE_F) * pitches[i]));
  // 동별 깊이 — 판독한 배수(depthK)가 있으면 그대로, 없으면 균일
  const Ds = [];
  for (let i = 0; i < n; i++) {
    if (o.depths && o.depths.length) Ds.push(Math.max(4000, Math.round(o.depths[Math.min(i, o.depths.length - 1)])));
    else Ds.push(Math.max(4000, Math.round(o.d * ((ml && ml[i] && ml[i].depthK) ? Math.min(1.8, Math.max(0.6, ml[i].depthK)) : 1))));
  }
  const gap = o.attached ? 0 : Math.round(o.w * 0.45);
  const L = Ws.reduce((a, v) => a + v, 0) + gap * (n - 1);   // 늘어선 전체 길이

  // 판독한 재료를 담아 둘 자리 — 동마다 다를 수 있으므로 벽을 만들 때 실어 준다.
  // ★재질은 e.mat 에 붙는다(bim.mat 아님). 붙는 즉시 3D 색이 그 재질을 따라간다.
  let curMat = null;
  // ── 층별 구성 ──
  // ★구성이 같은 연속 층끼리 묶어 한 번씩 구획한다. 필로티 층은 아예 부르지 않는다 —
  //   실을 만들지 않는 게 곧 필로티다(면적도 잡히지 않는다).
  //   ★건너뛴 층의 '올라갈 계단'은 잃어버리면 안 되므로 다음 그룹에 넘겨 준다.
  const FG = floorGroups(o);
  const runInterior = (ctx) => {
    let pend = [];
    for (const g of FG) {
      const up = g.floors.filter(fl => fl < Math.max(1, o.floors));
      if (g.program === 'piloti') { pend = pend.concat(up); continue; }
      buildInterior(br, o, counts, roomSeq, Object.assign({}, ctx,
        { floors: g.floors, program: g.program, stairFloors: pend.concat(up) }));
      pend = [];
    }
  };
  const wall = (p, q, t2, h2, sh2) => {
    const e = br.addEntity({ type: 'LINE', layer: '벽',
      x1: Math.round(p[0]), y1: Math.round(p[1]), x2: Math.round(q[0]), y2: Math.round(q[1]) });
    e.bim = { kind: 'wall', h: h2 || H, t: t2 || STD.wallExt, base: 0 };
    if (sh2) e.bim.shear = sh2;          // 기울어진 벽 — 개구부도 이 면 위에 함께 기운다
    if (curMat) e.mat = curMat;
    counts.wall++;
    return e;
  };
  const poly = (pts, layer, bim) => {
    const e = br.addEntity({ type: 'LWPOLYLINE', layer, closed: true,
      points: pts.map(p => [Math.round(p[0]), Math.round(p[1])]) });
    e.bim = bim; return e;
  };
  // 앞면 커튼월 — 멀리언로 나뉜 유리 패널. 가운데 동 한가운데 패널은 출입문.
  const curtain = (FL, FR, isEntry, Hc) => {
    const chord = Math.hypot(FR[0] - FL[0], FR[1] - FL[1]);
    const m = PARTY / 2 + 250;                    // 측벽을 침범하지 않도록 양끝 여유
    const span = chord - m * 2; if (span < 900) return;
    const ux = (FR[0] - FL[0]) / chord, uy = (FR[1] - FL[1]) / chord;
    const nP = Math.max(2, Math.round(span / 1600));   // 멀리언 간격 ~1.6m
    const mull = 80;
    const pw = (span - mull * (nP - 1)) / nP;
    const dIdx = isEntry ? (nP >> 1) : -1;
    // ── 층간 스팬드럴 ──
    // 한 장의 거대한 유리로 두면 층 리듬이 없어 매스처럼 보인다. 층마다 유리를 끊고
    // 그 사이를 불투명 띠(스팬드럴)로 남기면 입면에 수평 리듬이 생긴다(커튼월의 기본 구성).
    const Ht = Hc || H;
    const nf = Math.max(1, o.floors);
    const bandH = Ht / nf, SPAND = Math.min(700, Math.max(400, bandH * 0.22));
    for (let k = 0; k < nP; k++) {
      const s0 = m + k * (pw + mull);
      const P1 = [FL[0] + ux * s0, FL[1] + uy * s0];
      const P2 = [FL[0] + ux * (s0 + pw), FL[1] + uy * (s0 + pw)];
      if (k === dIdx) {                              // 출입문 칸: 1층은 문, 위층은 유리
        const e = br.addEntity({ type: 'LINE', layer: '개구부',
          x1: Math.round(P1[0]), y1: Math.round(P1[1]), x2: Math.round(P2[0]), y2: Math.round(P2[1]) });
        // ★'single' 은 OPENING_TYPES.door 에 없는 값이라 2D 평면에서 붙박이창 이중선으로
        //   폴백돼 '문인데 창 기호'가 그려지고 있었다. 카탈로그 값 'swing' 으로 바로잡는다.
        e.bim = { kind: 'opening', ot: 'door', wt: 'swing', h: 2100, sill: 0, t: STD.wallExt };
        counts.door++;
        for (let f = 1; f < nf; f++) {
          const g2 = br.addEntity({ type: 'LINE', layer: '개구부',
            x1: Math.round(P1[0]), y1: Math.round(P1[1]), x2: Math.round(P2[0]), y2: Math.round(P2[1]) });
          g2.bim = { kind: 'opening', ot: 'window', wt: 'fix',
            h: Math.max(900, bandH - SPAND), sill: Math.round(f * bandH + SPAND * 0.4), t: STD.wallExt };
          counts.window++;
        }
        continue;
      }
      for (let f = 0; f < nf; f++) {
        const e = br.addEntity({ type: 'LINE', layer: '개구부',
          x1: Math.round(P1[0]), y1: Math.round(P1[1]), x2: Math.round(P2[0]), y2: Math.round(P2[1]) });
        e.bim = { kind: 'opening', ot: 'window', wt: 'fix',
          h: Math.max(900, bandH - SPAND),
          sill: Math.round(f === 0 ? 150 : f * bandH + SPAND * 0.4), t: STD.wallExt };
        counts.window++;
      }
    }
  };

  // ── ★스케치에서 읽은 창 위치 그대로 뚫기 ──
  // 균일 격자는 '창이 있다'는 것만 표현할 뿐, 그림의 리듬(가운데만 크게, 위층만 띠창 등)을
  // 버린다. 판독기가 창 사각형을 잡아냈으면 그 자리·그 크기로 뚫는다.
  // 겹치는 개구부는 벽을 두 번 자르므로 뒤에 오는 쪽을 버린다.
  const sketchWins = (FL, FR, wins, Hc, isEntry) => {
    const chord = Math.hypot(FR[0] - FL[0], FR[1] - FL[1]);
    const M = PARTY / 2 + 250;                       // 측벽 침범 방지 여유
    if (chord - M * 2 < 800) return false;
    const ux = (FR[0] - FL[0]) / chord, uy = (FR[1] - FL[1]) / chord;
    const Ht = Hc || H;
    // ── 출입문 ──
    // ★'가장 낮은 창'을 문으로 승격하면 안 된다. 허리 높이 창(v 0.3)이 문이 되면서 문턱이
    //   바닥까지 내려와 2.1m 를 차지하고, 그 자리의 진짜 창들이 겹침으로 버려졌다(7개 중 2개 소실).
    //   문은 '밑변에 닿아 있는 개구부'만이다 — 아래끝이 처마높이의 20% 안쪽에 있어야 한다.
    let dIdx = -1, best = 1e9;
    if (isEntry) {
      wins.forEach((q, k) => {
        // 처마높이의 8% (약 30cm) 안쪽까지 내려온 것만 문. 0.20 으로 뒀더니 허리창(밑끝 0.185)이
        // 문이 되어 2.1m 를 차지하고, 그 위 큰 창을 겹침으로 삼켰다(3개 중 2개 소실).
        if (q.v - q.hFrac / 2 > 0.08) return;
        const sc = Math.abs(q.u - 0.5);
        if (sc < best) { best = sc; dIdx = k; }
      });
    }
    const placed = [];
    let made = 0;
    wins.forEach((q, k) => {
      const cw = Math.max(700, Math.min(chord - M * 2, q.wFrac * chord));
      const s = Math.max(M + cw / 2, Math.min(chord - M - cw / 2, q.u * chord));
      const isDoor = k === dIdx;
      const wh = isDoor ? 2100 : Math.max(600, Math.min(Ht * 0.8, q.hFrac * Ht));
      const sill = isDoor ? 0
        : Math.max(150, Math.min(Math.max(150, Ht - wh - 150), Math.round(q.v * Ht - wh / 2)));
      // 같은 높이대에서 가로로 겹치면 버린다 (벽을 두 번 자르면 개구부가 깨진다)
      if (placed.some(p => Math.abs(p.s - s) < (p.cw + cw) / 2 + 120 &&
                           sill < p.sill + p.wh + 120 && p.sill < sill + wh + 120)) return;
      placed.push({ s, cw, sill, wh });
      const P1 = [FL[0] + ux * (s - cw / 2), FL[1] + uy * (s - cw / 2)];
      const P2 = [FL[0] + ux * (s + cw / 2), FL[1] + uy * (s + cw / 2)];
      const e = br.addEntity({ type: 'LINE', layer: '개구부',
        x1: Math.round(P1[0]), y1: Math.round(P1[1]), x2: Math.round(P2[0]), y2: Math.round(P2[1]) });
      if (isDoor) {
        // 판독한 문 종류를 그대로 — 근거가 없으면 여닫이 기본값이다
        e.bim = { kind: 'opening', ot: 'door', wt: q.dkind || 'swing', h: 2100, sill: 0, t: STD.wallExt };
        if (q.dkindConf != null) e.bim.wtConf = q.dkindConf;
        counts.door++;
      }
      else {
        // ★판독한 창 종류를 그대로 싣는다. 확신이 낮으면(안 그린 그림) 붙박이 기본값이다.
        e.bim = { kind: 'opening', ot: 'window', wt: q.kind || 'fix', h: Math.round(wh), sill, t: STD.wallExt };
        if (q.kindConf != null) e.bim.wtConf = q.kindConf;
        counts.window++;
      }
      made++;
    });
    // 바닥에 닿은 개구부가 하나도 없으면 현관이 없는 건물이 된다 — 빈 자리에 문을 하나 넣는다.
    if (isEntry && dIdx < 0) {
      const DW = Math.min(1200, chord - M * 2);
      // 배치된 개구부들 사이에서 가장 넓은 빈 구간의 한가운데
      const occ = placed.filter(p => p.sill < 2100).map(p => [p.s - p.cw / 2, p.s + p.cw / 2])
        .sort((a, b) => a[0] - b[0]);
      let cur = M, bs = M + DW / 2, bg = -1;
      for (const [q0, q1] of occ.concat([[chord - M, chord - M]])) {
        if (q0 - cur > bg) { bg = q0 - cur; bs = (cur + q0) / 2; }
        cur = Math.max(cur, q1);
      }
      if (bg >= DW) {
        const P1 = [FL[0] + ux * (bs - DW / 2), FL[1] + uy * (bs - DW / 2)];
        const P2 = [FL[0] + ux * (bs + DW / 2), FL[1] + uy * (bs + DW / 2)];
        const e = br.addEntity({ type: 'LINE', layer: '개구부',
          x1: Math.round(P1[0]), y1: Math.round(P1[1]), x2: Math.round(P2[0]), y2: Math.round(P2[1]) });
        e.bim = { kind: 'opening', ot: 'door', wt: 'swing', h: 2100, sill: 0, t: STD.wallExt };
        counts.door++; made++;
      }
    }
    return made > 0;
  };

  const roomSeq = new Map();                       // 층별 실번호 카운터 (101, 102, …)
  const siteAcc = [];                             // 대지 슬래브 범위를 모을 자리
  let R = 0, courtC = [o.ox, o.oy], entryFront = null;

  if (o.arrange === 'arc') {
    // ── 방사 분할 쐐기(사다리꼴) 배치 ──
    // ★회전된 '직사각형'을 호 위에 늘어놓으면, 간격을 중심 반경의 호길이로 잡기 때문에
    //   반경이 더 작은 앞쪽에서 이웃끼리 파고든다(외벽·커튼월이 옆 동을 관통 — 실사용 보고).
    //   부채 중심 O 에서 방사로 자른 쐐기로 만들면 이웃과 측벽이 '정확히 같은 선'이 되어
    //   겹침이 원천적으로 0 이고, 그 선이 곧 세대분리벽(party wall)이 된다.
    const SPAN = Math.PI * (n <= 2 ? 0.12 : 0.26);     // 부채 전체 각 (약 22~47°)
    const r0 = L / SPAN;                               // 앞(마당 쪽) 반지름
    const r1 = r0 + o.d;                               // 뒤 반지름
    const rm = (r0 + r1) / 2;
    const shiftY = o.oy - rm;                          // 부채 중앙이 (ox,oy) 에 오도록 평행이동
    const PT = (a, r) => [o.ox + Math.cos(a) * r, shiftY + Math.sin(a) * r];
    // ★각도는 감소 방향으로 — 각이 클수록 화면 왼쪽이므로, 그림 왼쪽 동이 1동이 되게 한다.
    const bays = [];
    let a0 = Math.PI / 2 + SPAN / 2;
    for (let i = 0; i < n; i++) {
      const th = Ws[i] / r0;
      bays.push([a0, a0 - th]);        // [aL(큰 각=왼쪽), aR(작은 각=오른쪽)]
      a0 -= th + gap / r0;
    }
    const dth = EAVE / rm;                              // 처마를 각도로 환산
    const mid = n >> 1;
    for (let i = 0; i < n; i++) {
      const aL = bays[i][0], aR = bays[i][1];
      // ★동별 깊이 — 뒤 반경이 동마다 다르다. 측벽(방사선)은 이웃과 '더 얕은 쪽까지' 공유되고,
      //   더 깊은 동은 그만큼 뒤로 더 나간다(계단식 배면). 앞면은 모두 r0 로 정렬.
      const r1i = r0 + Ds[i];
      const FL = PT(aL, r0), FR = PT(aR, r0), BR = PT(aR, r1i), BL = PT(aL, r1i);
      const chord = Math.hypot(FR[0] - FL[0], FR[1] - FL[1]);
      const rise = riseOf(i, chord);          // 용마루는 방사 방향 → 스팬은 앞면 폭
      const Hi = Hs[i];                       // 이 동의 처마 높이 (동마다 다르다)
      // ★스케치에서 읽은 기울기를 그대로 세운다 — 지붕 볼륨의 윗면을 접선 방향으로 민다.
      //   (실루엣의 좌·우 경계 기울기를 vision 이 재서 lean 으로 넘겨준다)
      curMat = (ml && ml[i] && ml[i].mat) || o.mat || null;   // 이 동의 재료
      const lnI = (ml && ml[i] && ml[i].lean != null) ? ml[i].lean : o.lean;
      const tvec = [-(Math.sin((aL + aR) / 2)), Math.cos((aL + aR) / 2)];   // 접선(폭 방향)
      const shr = Math.abs(lnI) > 0.05 ? [tvec[0] * lnI * rise, tvec[1] * lnI * rise] : null;
      // 벽 — 앞/뒤는 각 동마다, 측벽은 이웃과 공유하므로 한 번만 만든다(중복 벽 금지).
      // 이웃과 맞닿는 측벽은 방화벽 → 두 동 중 높은 처마 위로 500 솟는다.
      const shared = gap === 0 && i < n - 1;
      const wSh = Math.abs(lnI) > 0.05 ? [tvec[0] * lnI * Hi, tvec[1] * lnI * Hi] : null;
      wall(FL, FR, STD.wallExt, Hi, wSh); wall(BR, BL, STD.wallExt, Hi, wSh);
      if (i === 0 || gap > 0) wall(BL, FL, PARTY, Hi, wSh);
      wall(FR, BR, PARTY, shared ? Math.max(Hi, Hs[i + 1]) + FIREW : Hi, wSh);
      poly([FL, FR, BR, BL], '바닥', { kind: 'slab', t: STD.slabT, top: 0 }); counts.slab++;
      siteAcc.push(FL, FR, BR, BL);
      // 지붕 — 처마는 앞뒤로만. 측면은 이웃과 맞닿으므로 내밀면 지붕끼리 겹친다.
      if (o.roof && o.roof !== 'none') {
        const sgn = aL >= aR ? 1 : -1;               // 바깥쪽으로 내밀도록 부호를 맞춘다
        const oL = aL + sgn * ((i === 0 || gap > 0) ? dth : 0);
        const oR = aR - sgn * ((i === n - 1 || gap > 0) ? dth : 0);
        // ★지붕은 '기울어진 벽의 꼭대기'에서 시작한다 — 벽 전단량(wSh)만큼 옮긴 자리에 얹는다.
        //   안 옮기면 벽은 기울고 지붕만 제자리에 남아 서로 어긋난다.
        const OS = (p) => wSh ? [p[0] + wSh[0], p[1] + wSh[1]] : p;
        const RP = [OS(PT(oL, r0 - RAKE)), OS(PT(oR, r0 - RAKE)), OS(PT(oR, r1i + RAKE)), OS(PT(oL, r1i + RAKE))];
        // ★rdir 판정은 roofSolids 가 실제로 재는 값(RP 변 길이)으로 해야 한다.
        //   벽 현으로 재면 처마만큼 어긋나 폭≈깊이 조합에서 용마루가 90° 돌아간다.
        const cF = Math.hypot(RP[1][0] - RP[0][0], RP[1][1] - RP[0][1]);
        const cR = Math.hypot(RP[2][0] - RP[1][0], RP[2][1] - RP[1][1]);
        poly(RP, '지붕', { kind: 'roof', rtype: o.roof, eave: Hi, rise, ridgeF: RIDGE_F,
          rdir: cF >= cR ? 'short' : undefined, shear: shr });   // 용마루는 항상 방사(앞뒤) 방향
        counts.roof++;
      }
      // 박공면 — 마당 쪽은 유리(통유리 박공), 뒤쪽은 벽. 지붕과 같은 프로필의 얇은 띠.
      if (o.roof === 'gable') {
        const prof = { kind: 'roof', rtype: 'gable', eave: Hi, rise, ridgeF: RIDGE_F, rdir: 'short', shear: shr };
        const OS2 = (p) => wSh ? [p[0] + wSh[0], p[1] + wSh[1]] : p;
        poly([OS2(PT(aL, r0)), OS2(PT(aR, r0)), OS2(PT(aR, r0 + 240)), OS2(PT(aL, r0 + 240))], o.glass ? '유리' : '벽', prof);
        poly([OS2(PT(aL, r1i - 240)), OS2(PT(aR, r1i - 240)), OS2(PT(aR, r1i)), OS2(PT(aL, r1i))], '벽', prof);
      }
      // 그림에서 읽은 창이 있으면 그 자리에, 없으면 기존 커튼월 규칙.
      const wlist = (ml && ml[i] && ml[i].wins) || null;
      const drew = (wlist && wlist.length) ? sketchWins(FL, FR, wlist, Hi, i === mid) : false;
      if (!drew && o.glass) curtain(FL, FR, i === mid, Hi);
      if (i === mid && (drew || o.glass)) entryFront = [FL, FR];
      // 처마돌림(fascia) — 처마 끝을 마감하는 띠. 얇은 벽으로 표현하면 3D 에서 지붕 가장자리가
      // '두께 있는 면'으로 보여 종잇장 같지 않다. 앞/뒤 처마선에만.
      const sgn2 = aL >= aR ? 1 : -1;
      const fL = aL + sgn2 * ((i === 0 || gap > 0) ? dth : 0);
      const fR = aR - sgn2 * ((i === n - 1 || gap > 0) ? dth : 0);
      for (const rr of [r0 - RAKE, r1i + RAKE]) {
        const fa1 = wSh ? [PT(fL, rr)[0] + wSh[0], PT(fL, rr)[1] + wSh[1]] : PT(fL, rr);
        const fa2 = wSh ? [PT(fR, rr)[0] + wSh[0], PT(fR, rr)[1] + wSh[1]] : PT(fR, rr);
        const fa = br.addEntity({ type: 'LINE', layer: '지붕',
          x1: Math.round(fa1[0]), y1: Math.round(fa1[1]), x2: Math.round(fa2[0]), y2: Math.round(fa2[1]) });
        fa.bim = { kind: 'wall', h: 260, t: 120, base: Hi - 60 };
      }
      // ── 내부 실 구획 ── (부채꼴 쐐기: 각도축을 호길이로 환산해 넘긴다)
      runInterior({ FL, FR, BR, BL, W: Math.abs(aL - aR) * ((r0 + r1i) / 2), D: Ds[i], chord, wSh,
        mat: curMat, sideExtL: (i === 0 || gap > 0), sideExtR: (i === n - 1 || gap > 0) });
      const cM = PT((aL + aR) / 2, (r0 + r1i) / 2);
      br.addEntity({ type: 'TEXT', layer: '문자', x: Math.round(cM[0]), y: Math.round(cM[1]), height: 400, text: (i + 1) + '동' });
    }
    // ★내부 홈통(box gutter) — 데드밸리 방지
    // 용마루가 방사 방향이면 지붕은 각도 방향으로만 기울어, 이웃과 맞닿는 방사선에서 양쪽
    // 지붕이 같은 높이로 내려온다 = 물이 못 빠지는 수평 골. 실무에서 절대 만들면 안 되는 형태다.
    // 경계마다 마당 쪽으로 1:300 물매를 준 홈통을 넣어 배수 방향을 만든다(규정 1:400~1:200).
    if (gap === 0 && n > 1) {
      const gwA = 250 / rm;                                  // 홈통 폭 500 → 반각
      for (let k = 1; k < n; k++) {
        const ak = bays[k][0];                               // 이웃과 공유하는 경계각
        const rGut = r0 + Math.min(Ds[k - 1], Ds[k]);   // 두 동이 함께 있는 구간까지만
        poly([PT(ak - gwA, r0 - RAKE), PT(ak + gwA, r0 - RAKE), PT(ak + gwA, rGut), PT(ak - gwA, rGut)],
          '홈통', { kind: 'roof', rtype: 'shed', eave: Math.min(Hs[k - 1], Hs[k]) - 300, rise: Math.round((rGut - r0 + RAKE) / 300) });
      }
    }
    // 기단 — 건물군 외곽을 300 내밀어 한 장으로 (건물이 땅에 앉은 느낌)
    if (o.attached) {
      const pts = [PT(bays[0][0], r0 - 300)];
      for (let i = 0; i < n; i++) pts.push(PT(bays[i][1], r0 - 300));
      // 배면은 동마다 깊이가 달라 계단식이다 — 각 동의 좌·우 각도에서 그 동의 뒤 반경을 쓴다
      for (let i = n - 1; i >= 0; i--) {
        pts.push(PT(bays[i][1], r0 + Ds[i] + 300));
        pts.push(PT(bays[i][0], r0 + Ds[i] + 300));
      }
      poly(pts, '바닥', { kind: 'slab', t: 400, top: 150 }); counts.slab++;
    }
    // 전면 잔디 띠 — 부채를 따라 연속으로
    const ang = [bays[0][0]].concat(bays.map(b2 => b2[1]));
    const lb = [];
    for (const aa of ang) lb.push(PT(aa, r0 - 900));
    for (let i = ang.length - 1; i >= 0; i--) lb.push(PT(ang[i], r0 - 2700));
    poly(lb, '조경', { kind: 'slab', t: 80, top: 20 });
    R = Math.max(3000, Math.round(L / 5));
    courtC = [o.ox, o.oy - o.d / 2 - 2700 - 2200 - R];
  } else {
    // 회전 없는 배치 — 일렬 / 마당을 두른 링 (동끼리 떨어져 있어 겹침 없음)
    const place = (i, C, t, u) => {
      const W2 = Ws[i] / 2, D2 = Ds[i] / 2;   // 동별 깊이 — 링/일렬 배치에서도 반영
      curMat = (ml && ml[i] && ml[i].mat) || o.mat || null;   // 이 동의 재료 (부채꼴과 같게)
      const P = [
        [C[0] - t[0] * W2 - u[0] * D2, C[1] - t[1] * W2 - u[1] * D2],
        [C[0] + t[0] * W2 - u[0] * D2, C[1] + t[1] * W2 - u[1] * D2],
        [C[0] + t[0] * W2 + u[0] * D2, C[1] + t[1] * W2 + u[1] * D2],
        [C[0] - t[0] * W2 + u[0] * D2, C[1] - t[1] * W2 + u[1] * D2],
      ];
      for (let k = 0; k < 4; k++) wall(P[k], P[(k + 1) % 4]);
      poly(P, '바닥', { kind: 'slab', t: STD.slabT, top: 0 }); counts.slab++;
      if (o.roof && o.roof !== 'none') {
        const W2o = W2 + OVH, D2o = D2 + OVH;
        const RP = [
          [C[0] - t[0] * W2o - u[0] * D2o, C[1] - t[1] * W2o - u[1] * D2o],
          [C[0] + t[0] * W2o - u[0] * D2o, C[1] + t[1] * W2o - u[1] * D2o],
          [C[0] + t[0] * W2o + u[0] * D2o, C[1] + t[1] * W2o + u[1] * D2o],
          [C[0] - t[0] * W2o + u[0] * D2o, C[1] - t[1] * W2o + u[1] * D2o],
        ];
        poly(RP, '지붕', { kind: 'roof', rtype: o.roof, eave: H, rise: riseOf(i, Math.min(Ws[i], Ds[i])), ridgeF: RIDGE_F,
          rdir: Ws[i] >= Ds[i] ? 'short' : undefined });
        counts.roof++;
      }
      if (o.roof === 'gable') {
        const prof = { kind: 'roof', rtype: 'gable', eave: H, rise: riseOf(i, Math.min(Ws[i], Ds[i])), ridgeF: RIDGE_F, rdir: 'short' };
        const band = (sgn, layer) => {
          const f0 = sgn * D2, f1 = sgn * (D2 - 240);
          poly([
            [C[0] - t[0] * W2 + u[0] * f0, C[1] - t[1] * W2 + u[1] * f0],
            [C[0] + t[0] * W2 + u[0] * f0, C[1] + t[1] * W2 + u[1] * f0],
            [C[0] + t[0] * W2 + u[0] * f1, C[1] + t[1] * W2 + u[1] * f1],
            [C[0] - t[0] * W2 + u[0] * f1, C[1] - t[1] * W2 + u[1] * f1],
          ], layer, prof);
        };
        band(-1, o.glass ? '유리' : '벽');
        band(1, '벽');
      }
      if (o.glass) curtain(P[0], P[1], i === (n >> 1));
      // ── 내부 실 구획 ── ★일렬·링 배치도 안이 있어야 한다. 예전엔 부채꼴에서만 실을
      //   만들어서, 일렬로 놓으면 껍데기만 나오고 면적표·층별 평면도가 통째로 비었다.
      //   직사각형이라 매개변수 공간이 그대로 세계 좌표다(쐐기 보정이 필요 없다).
      //   동끼리 떨어져 있으므로 좌·우 측벽도 외벽이다 = 창을 뚫어도 된다.
      runInterior({ FL: P[0], FR: P[1], BR: P[2], BL: P[3],
        W: Ws[i], D: Ds[i], chord: Ws[i], wSh: null, mat: curMat,
        sideExtL: true, sideExtR: true });
      br.addEntity({ type: 'TEXT', layer: '문자', x: Math.round(C[0]), y: Math.round(C[1]), height: 400, text: (i + 1) + '동' });
    };
    if (o.arrange === 'row') {
      let s = 0;
      for (let i = 0; i < n; i++) {
        place(i, [o.ox + s + Ws[i] / 2, o.oy], [1, 0], [0, 1]);
        s += Ws[i] + (gap || Math.round(o.w * 0.5));
      }
    } else {
      const foot = Math.max(o.w, Math.max.apply(null, Ds));
      R = o.courtyardR || Math.max(6000, Math.round((n * (foot + 3000)) / (2 * Math.PI)));
      const ring = R + Math.max.apply(null, Ds) / 2 + 2500;
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
        const u = [Math.cos(a), Math.sin(a)];
        place(i, [o.ox + ring * u[0], o.oy + ring * u[1]], [-u[1], u[0]], u);
      }
    }
  }

  // ── 진입 계단 ── 기단이 150 올라와 있으므로 문 앞에 디딤판이 필요하다(문턱 13mm 제한).
  if (entryFront) {
    const [A9, B9] = entryFront;
    const dx9 = B9[0] - A9[0], dy9 = B9[1] - A9[1], L9 = Math.hypot(dx9, dy9) || 1;
    const ux9 = dx9 / L9, uy9 = dy9 / L9, nx9 = -uy9, ny9 = ux9;
    const hw = 900, dp = 1200;                       // 계단참 폭·깊이
    const mx9 = (A9[0] + B9[0]) / 2, my9 = (A9[1] + B9[1]) / 2;
    // 마당 쪽(바깥)으로 내밀어 놓는다
    const sgn9 = ((mx9 + nx9 * 100) - courtC[0]) ** 2 + ((my9 + ny9 * 100) - courtC[1]) ** 2
      < ((mx9 - nx9 * 100) - courtC[0]) ** 2 + ((my9 - ny9 * 100) - courtC[1]) ** 2 ? 1 : -1;
    const st = [
      [mx9 - ux9 * hw + nx9 * sgn9 * 40, my9 - uy9 * hw + ny9 * sgn9 * 40],
      [mx9 + ux9 * hw + nx9 * sgn9 * 40, my9 + uy9 * hw + ny9 * sgn9 * 40],
      [mx9 + ux9 * hw + nx9 * sgn9 * dp, my9 + uy9 * hw + ny9 * sgn9 * dp],
      [mx9 - ux9 * hw + nx9 * sgn9 * dp, my9 - uy9 * hw + ny9 * sgn9 * dp],
    ];
    const sl = br.addEntity({ type: 'LWPOLYLINE', layer: '바닥', closed: true,
      points: st.map(p => [Math.round(p[0]), Math.round(p[1])]) });
    sl.bim = { kind: 'slab', t: 120, top: 80 };      // 기단(150)의 절반 높이 디딤판 (두께를 달리해 바닥판과 구분)
    counts.slab++;
  }
  // ── 스케일 앵커 ── 인물 1.7m·차량 4.5×1.8m. 매스만 보면 크기 감각이 0이라
  //   비례 오류를 못 잡는다(리서치: 매스 단계에서 비용 대비 효과가 가장 큰 요소).
  //   인쇄에는 빠지도록 별도 레이어.
  if (R > 0) {
    br.ensureLayer('참조', '#8fa3c8');
    const pl = (br.state && br.state.layers || []).find(l => l.name === '참조');
    if (pl) pl.plot = false;                        // 인쇄·내보내기에서는 빠진다
    const person = (px, py) => {
      const e = br.addEntity({ type: 'CIRCLE', layer: '참조', cx: Math.round(px), cy: Math.round(py), r: 220 });
      e.bim = { kind: 'mass', base: 0, h: 1700 };
    };
    person(courtC[0] - R * 0.5, courtC[1] + R * 0.15);
    person(courtC[0] - R * 0.5 + 700, courtC[1] + R * 0.15 - 400);
    const car = br.addEntity({ type: 'LWPOLYLINE', layer: '참조', closed: true, points: [
      [Math.round(courtC[0] + R * 0.55), Math.round(courtC[1] - 900)],
      [Math.round(courtC[0] + R * 0.55 + 4500), Math.round(courtC[1] - 900)],
      [Math.round(courtC[0] + R * 0.55 + 4500), Math.round(courtC[1] + 900)],
      [Math.round(courtC[0] + R * 0.55), Math.round(courtC[1] + 900)]] });
    car.bim = { kind: 'mass', base: 0, h: 1450, taper: 0.72 };
  }
  if (R > 0) {                                        // 마당 — 방사형 수레바퀴 잔디
    const cx = Math.round(courtC[0]), cy = Math.round(courtC[1]), Rr = Math.round(R);
    const ct = br.addEntity({ type: 'CIRCLE', layer: '조경', cx, cy, r: Rr });
    ct.bim = { kind: 'slab', t: 100, top: 0 }; counts.court = 1;
    const inner = br.addEntity({ type: 'CIRCLE', layer: '조경길', cx, cy, r: Math.round(Rr * 0.26) });
    inner.bim = { kind: 'slab', t: 100, top: 30 };
    for (let k = 0; k < 8; k++) {
      const a2 = (k * 2 * Math.PI) / 8;
      br.addEntity({ type: 'LINE', layer: '조경길',
        x1: Math.round(cx + Math.cos(a2) * Rr * 0.26), y1: Math.round(cy + Math.sin(a2) * Rr * 0.26),
        x2: Math.round(cx + Math.cos(a2) * Rr * 0.97), y2: Math.round(cy + Math.sin(a2) * Rr * 0.97) });
    }
  }
  // ── ★대지 슬래브 ──
  // 건물이 허공에 떠 있으면 3D·렌더가 모형 사진처럼 보인다. 건물과 마당을 아우르는
  // 대지 판을 깔아 지면을 만든다. 두께 있는 판이라 옆에서 봐도 지면이 끊기지 않는다.
  // ※기단(150) 아래로 내려 깔아 바닥판과 z-fighting 이 나지 않게 한다.
  if (o.site !== false && siteAcc.length) {
    let sx0 = 1e18, sy0 = 1e18, sx1 = -1e18, sy1 = -1e18;
    const acc = siteAcc.concat(courtC ? [[courtC[0] - R, courtC[1] - R], [courtC[0] + R, courtC[1] + R]] : []);
    for (const p of acc) {
      sx0 = Math.min(sx0, p[0]); sx1 = Math.max(sx1, p[0]);
      sy0 = Math.min(sy0, p[1]); sy1 = Math.max(sy1, p[1]);
    }
    const PAD = Math.max(6000, (sx1 - sx0) * 0.12);
    br.ensureLayer('대지', '#b9b2a6');
    const sp = br.addEntity({ type: 'LWPOLYLINE', layer: '대지', closed: true, points: [
      [Math.round(sx0 - PAD), Math.round(sy0 - PAD)], [Math.round(sx1 + PAD), Math.round(sy0 - PAD)],
      [Math.round(sx1 + PAD), Math.round(sy1 + PAD)], [Math.round(sx0 - PAD), Math.round(sy1 + PAD)]] });
    // ★지면은 건물 최하단(기단 밑)보다 아래여야 한다 — 위로 올라오면 바닥판을 뚫는다.
    //   실측: top -200 이 바닥 하단 -250 보다 위라 판이 관통했다. 기단이 드러나도록 -260.
    // 두께는 기단(400)과 다르게 — 회귀가 '기단 한 장'을 두께로 세고 있어 겹치면 안 된다
    sp.bim = { kind: 'slab', t: 500, top: -260 };
    sp.mat = 'concrete';
    counts.site = 1;
  }
  br.refresh();
  return { n, floors: o.floors, H, R: Math.round(R), L, widths: Ws, counts, arrange: o.arrange };
}

// ---------- 범용 형상 빌더 — '어떤 형상이든' ----------
// 고정된 지붕 유형이 아니라 임의 다면체를 직접 세운다. bim.kind='mass' 프리미티브가
// 바닥 다각형 + 정점별 상단 높이 + 윗면 밀기/줄이기/돌리기를 받으므로,
// 아래 조합만으로 텐트·기울어진 쐐기·각뿔·좁아지는 타워·톱니 지붕이 전부 나온다.
const SHAPES = {
  box:      { ko: '상자' },
  wedge:    { ko: '쐐기' },        // 한쪽만 높은 단면 (한쪽으로 기운 판)
  tent:     { ko: '텐트' },        // 가운데가 솟은 박공형 단면
  lean:     { ko: '기운 상자' },   // 윗면을 통째로 민 전단 프리즘
  taper:    { ko: '좁아지는 매스' },
  pyramid:  { ko: '각뿔' },
  cylinder: { ko: '원통' },
  cone:     { ko: '원뿔' },
  saw:      { ko: '톱니' },        // 톱니 지붕 (여러 쐐기 반복)
};
function shapeOf(text) {
  const t = String(text || '');
  if (/톱니|saw|셰드 ?연속/i.test(t)) return 'saw';
  if (/원뿔|콘|cone/i.test(t)) return 'cone';
  if (/원통|실린더|cylinder|기둥형/i.test(t)) return 'cylinder';
  if (/각뿔|피라미드|pyramid/i.test(t)) return 'pyramid';
  if (/좁아지|테이퍼|taper|사다리꼴 ?매스/i.test(t)) return 'taper';
  if (/기울|기운|비스듬|lean|전단/i.test(t)) return 'lean';
  if (/텐트|tent|박공 ?매스|삼각/i.test(t)) return 'tent';
  if (/쐐기|wedge|외쪽|한쪽만/i.test(t)) return 'wedge';
  if (/상자|박스|box|직육면체/i.test(t)) return 'box';
  return null;
}
// 정다각형/원 바닥
function ngon(cx, cy, r, n, rot) {
  const p = [];
  for (let i = 0; i < n; i++) { const a = (rot || 0) + i * 2 * Math.PI / n; p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return p;
}
// spec: { shape, w, d, h, ox, oy, rot(도), sides, lean(0~1), taper(0~1), twist(도), n(반복) }
function buildShape(spec) {
  const br = B(); if (!br) return null;
  const o = Object.assign({ shape: 'box', w: 10000, d: 8000, h: 6000, ox: 0, oy: 0,
    rot: 0, sides: 6, lean: 0.45, taper: 0.45, twist: 0, n: 1, layer: '매스' }, spec || {});
  br.pushUndo();
  br.ensureLayer('매스', '#cfc7ba');
  const th = o.rot * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
  const RT = (x, y) => [o.ox + x * cs - y * sn, o.oy + x * sn + y * cs];
  const W2 = o.w / 2, D2 = o.d / 2;
  const rect = () => [RT(-W2, -D2), RT(W2, -D2), RT(W2, D2), RT(-W2, D2)];
  const put = (pts, bim, circle) => {
    const e = circle
      ? br.addEntity({ type: 'CIRCLE', layer: o.layer, cx: Math.round(circle[0]), cy: Math.round(circle[1]), r: Math.round(circle[2]) })
      : br.addEntity({ type: 'LWPOLYLINE', layer: o.layer, closed: true,
        points: pts.map(p => [Math.round(p[0]), Math.round(p[1])]) });
    e.bim = Object.assign({ kind: 'mass' }, bim);
    return e;
  };
  const made = [];
  const S = o.shape;
  if (S === 'saw') {                                   // 톱니 지붕 — 쐐기 n개 반복
    const cnt = Math.max(2, Math.min(12, o.n || 4)), bw = o.w / cnt;
    for (let i = 0; i < cnt; i++) {
      const x0 = -W2 + i * bw, x1 = x0 + bw;
      const P = [RT(x0, -D2), RT(x1, -D2), RT(x1, D2), RT(x0, D2)];
      // 앞(-D2)이 낮고 뒤(+D2)가 높은 외쪽 — 정점 순서대로 상단 높이를 준다
      made.push(put(P, { base: 0, zt: [o.h * 0.55, o.h * 0.55, o.h, o.h] }));
    }
  } else if (S === 'wedge') {
    made.push(put(rect(), { base: 0, zt: [o.h * 0.35, o.h * 0.35, o.h, o.h] }));
  } else if (S === 'tent') {
    // 가운데가 솟은 단면 — 사각을 세로로 반 갈라 두 조각(맞배 매스)
    made.push(put([RT(-W2, -D2), RT(W2, -D2), RT(W2, 0), RT(-W2, 0)], { base: 0, zt: [o.h * 0.3, o.h * 0.3, o.h, o.h] }));
    made.push(put([RT(-W2, 0), RT(W2, 0), RT(W2, D2), RT(-W2, D2)], { base: 0, zt: [o.h, o.h, o.h * 0.3, o.h * 0.3] }));
  } else if (S === 'lean') {
    made.push(put(rect(), { base: 0, h: o.h, shear: [o.d * o.lean * cs * -sn + o.d * o.lean * 0, o.d * o.lean] }));
  } else if (S === 'taper') {
    made.push(put(rect(), { base: 0, h: o.h, taper: Math.max(0.05, 1 - o.taper), twist: o.twist }));
  } else if (S === 'pyramid') {
    made.push(put(ngon(o.ox, o.oy, Math.max(o.w, o.d) / 2, Math.max(3, o.sides), th), { base: 0, h: o.h, taper: 0.02 }));
  } else if (S === 'cone') {
    made.push(put(null, { base: 0, h: o.h, taper: 0.02 }, [o.ox, o.oy, Math.max(o.w, o.d) / 2]));
  } else if (S === 'cylinder') {
    made.push(put(null, { base: 0, h: o.h }, [o.ox, o.oy, Math.max(o.w, o.d) / 2]));
  } else {                                             // box
    made.push(put(rect(), { base: 0, h: o.h, taper: o.taper && o.shape === 'taper' ? 1 - o.taper : undefined,
      twist: o.twist || undefined }));
  }
  br.refresh();
  return { shape: S, ko: (SHAPES[S] || {}).ko || S, count: made.length, w: o.w, d: o.d, h: o.h };
}
// 임의 좌표 다각형을 그대로 매스로 — 사용자가 점을 주거나 스케치에서 뽑은 윤곽용
function buildPolyMass(points, spec) {
  const br = B(); if (!br || !points || points.length < 3) return null;
  const o = Object.assign({ h: 6000, base: 0, zt: null, shear: null, taper: null, twist: 0, layer: '매스' }, spec || {});
  br.pushUndo(); br.ensureLayer('매스', '#cfc7ba');
  const e = br.addEntity({ type: 'LWPOLYLINE', layer: o.layer, closed: true,
    points: points.map(p => [Math.round(p[0]), Math.round(p[1])]) });
  e.bim = { kind: 'mass', base: o.base, h: o.h };
  if (o.zt) e.bim.zt = o.zt;
  if (o.shear) e.bim.shear = o.shear;
  if (o.taper != null) e.bim.taper = o.taper;
  if (o.twist) e.bim.twist = o.twist;
  br.refresh();
  return { n: points.length, h: o.h };
}

return { STD, roomType, PROGRAMS, programOf, floorGroups, planLayout, buildPlan, buildMassing, buildComplex,
  SHAPES, shapeOf, buildShape, buildPolyMass };
})();
