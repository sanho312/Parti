/* ============================================================
   Parti 스케치 엔진 — Phase 1 (프로젝트 철학의 첫 구현)
   핵심 입력 장치는 Apple Pencil. 손그림은 끝까지 손그림이다 —
   필압·속도·감성을 원본 그대로 보존한다(Sketch Layer).
   구현 원칙:
   · cad.js 무수정 — WEBCAD_AI_BRIDGE + #cv 위 오버레이 캔버스만 사용.
   · 스트로크는 월드 좌표(mm)로 저장 → CAD·줌·팬과 항상 정합.
     이 원본 점열(좌표+필압)이 Phase 2 전처리 엔진의 입력 데이터다.
   · AI 사용 0 — 전부 알고리즘.
   ============================================================ */
(() => {
'use strict';
const B = window.WEBCAD_AI_BRIDGE;
const cv = document.getElementById('cv');
const wrap = document.getElementById('canvasWrap');
if (!B || !cv || !wrap) { console.warn('[sketch] 초기화 실패 — 브리지/캔버스 없음'); return; }
const V = () => B.state.view;
const appDraw = () => { (B.draw || B.refresh)(); };

// ---------- 상태 ----------
const SK = {
  on: false,          // 스케치 모드(입력 잠금) — 꺼져 있어도 Sketch Layer 는 항상 보인다
  visible: true,
  tool: 'pen',        // pen(그리기) | eraser
  brush: 'pen',       // pen | pencil | marker — 브러시 종류
  layer: '',          // CAD 레이어와 동일 연동 (색 일치) — 빈 값이면 현재 CAD 레이어
  color: '#e6e1d3',   // 연필 느낌의 기본 잉크
  sizePx: 4,          // 화면 기준 굵기(px) — 그리는 순간의 줌으로 월드 굵기 확정(종이에 잉크)
  strokes: [],        // {id, color, hw(월드 반폭 mm), brush, layer, pts:[[x, y, p], ...]}
  nextId: 1,
  undo: [], redo: [], // 스트로크 단위 (CAD undo 와 독립 — 드로잉 앱 방식)
  penSeen: false,     // 펜이 한 번이라도 감지되면 손가락은 내비게이션 전용(팜 리젝션)
  snap: true,         // 스트로크 시작/끝을 CAD 개체·다른 스트로크 끝점에 흡착
  aim: false,         // 🎯 조준 모드 — 접촉해도 그리지 않고 위치·스냅만 표시 (호버 미지원 기기 대체)
  rev: 0,             // 내용 변경 카운터 (rAF 뷰 동기화용)
  fitOv: {},          // S3 즉석 교정: strokeId -> 강제 종류(line/arc/…) — 미리보기 탭으로 순환
  docKey: '',
};
// 브러시 특성 — 폭 배율 곡선(필압), 폭 계수, 투명도
const BRUSH = {
  pen:    { wf: (p) => 0.25 + 1.5 * (p || 0.5), wmul: 1.0, alpha: 1 },
  pencil: { wf: (p) => 0.25 + 1.5 * (p || 0.5), wmul: 0.6, alpha: 0.85 },
  marker: { wf: (p) => 0.7 + 0.6 * (p || 0.5), wmul: 2.3, alpha: 0.45 },
};
const brushOf = (s) => BRUSH[s.brush] || BRUSH.pen;
const wf = (p) => BRUSH.pen.wf(p);           // (구버전 스트로크 호환)
const rnd1 = (n) => Math.round(n * 10) / 10; // 저장 절약: 0.1mm

// ---------- 오버레이 캔버스 (#cv 를 그대로 따라간다 — 4분할 평면 칸 포함) ----------
const skcv = document.createElement('canvas');
skcv.id = 'skcv';
skcv.style.cssText = 'position:absolute;left:0;top:0;z-index:21;pointer-events:none;'
  + 'touch-action:none;-webkit-user-select:none;user-select:none;';
wrap.appendChild(skcv);
const g = skcv.getContext('2d');
let ovRect = { x: 0, y: 0, w: 2, h: 2 };     // wrap 기준 CSS 위치/크기

function cvRect() {
  const wr = wrap.getBoundingClientRect(), cr = cv.getBoundingClientRect();
  return { x: cr.left - wr.left, y: cr.top - wr.top, w: cr.width, h: cr.height };
}
// cad.js 의 worldToScreen/screenToWorld 와 같은 식 (cv._w/_h 는 cad 가 쓰는 CSS 크기)
function w2s(wx, wy) {
  const v = V(), W = cv._w || ovRect.w, H = cv._h || ovRect.h;
  return [(wx - v.x) * v.scale + W / 2, -(wy - v.y) * v.scale + H / 2];
}
function s2w(sx, sy) {
  const v = V(), W = cv._w || ovRect.w, H = cv._h || ovRect.h;
  return [(sx - W / 2) / v.scale + v.x, -(sy - H / 2) / v.scale + v.y];
}

// ---------- 렌더링 ----------
// 필압 가변폭: 인접 점 사이를 둥근 캡 선분으로 잇는다.
// 반투명 브러시(연필·마커)는 겹침 얼룩이 없도록 임시 캔버스에 불투명으로 그린 뒤 통째로 합성한다.
const tmpCv = document.createElement('canvas');
const tg = tmpCv.getContext('2d');
function strokeCore(ctx2, s, k) {
  const B2 = brushOf(s);
  const pts = s.pts;
  ctx2.strokeStyle = s.color; ctx2.fillStyle = s.color;
  ctx2.lineCap = 'round'; ctx2.lineJoin = 'round';
  if (pts.length === 1) {
    const [x, y] = w2s(pts[0][0], pts[0][1]);
    ctx2.beginPath(); ctx2.arc(x, y, Math.max(0.4, s.hw * B2.wf(pts[0][2]) * B2.wmul * k), 0, 6.2832); ctx2.fill();
    return;
  }
  for (let i = 1; i < pts.length; i++) drawSeg(ctx2, s, pts[i - 1], pts[i], k);
}
function drawStroke(ctx2, s) {
  const k = V().scale;
  const alpha = brushOf(s).alpha;
  if (alpha >= 1 || ctx2 !== g) { strokeCore(ctx2, s, k); return; }
  // 반투명: 임시 캔버스에 스트로크 영역만 불투명으로 → 알파 합성 (겹침 자국 없음)
  const dpr = window.devicePixelRatio || 1;
  if (tmpCv.width !== skcv.width || tmpCv.height !== skcv.height) { tmpCv.width = skcv.width; tmpCv.height = skcv.height; }
  tg.setTransform(dpr, 0, 0, dpr, 0, 0);
  // 스트로크 화면 bbox (여유 = 최대 굵기)
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const p of s.pts) { const q = w2s(p[0], p[1]); if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
  const pad = s.hw * 4 * k + 4;
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  tg.clearRect(x0, y0, x1 - x0, y1 - y0);
  strokeCore(tg, s, k);
  ctx2.save();
  ctx2.globalAlpha = alpha;
  ctx2.setTransform(1, 0, 0, 1, 0, 0);
  const rx0 = Math.max(0, Math.floor(x0 * dpr)), ry0 = Math.max(0, Math.floor(y0 * dpr));
  const rw = Math.min(skcv.width - rx0, Math.ceil((x1 - x0) * dpr)), rh = Math.min(skcv.height - ry0, Math.ceil((y1 - y0) * dpr));
  if (rw > 0 && rh > 0) ctx2.drawImage(tmpCv, rx0, ry0, rw, rh, rx0, ry0, rw, rh);
  ctx2.restore();
  const dpr2 = window.devicePixelRatio || 1;
  ctx2.setTransform(dpr2, 0, 0, dpr2, 0, 0);
}
function drawSeg(ctx2, s, a, b, k) {
  const B2 = brushOf(s);
  const [ax, ay] = w2s(a[0], a[1]), [bx, by] = w2s(b[0], b[1]);
  ctx2.lineWidth = Math.max(0.5, s.hw * (B2.wf(a[2]) + B2.wf(b[2])) * B2.wmul * k);
  ctx2.beginPath(); ctx2.moveTo(ax, ay); ctx2.lineTo(bx, by); ctx2.stroke();
}
// 레이어 표시 상태 (CAD 레이어와 동일 연동 — 꺼진 레이어의 스케치도 숨긴다)
function layerVisible(name) {
  if (!name) return true;
  const l = B.state.layers.find(x => x.name === name);
  return !l || l.visible !== false;
}
let eraseCursor = null; // {x, y} 오버레이 로컬 px — 지우개 원 표시
let preview = null;     // ✨ 인식 결과 (WEBCAD_PREP.analyze) — 스케치가 바뀌면 무효
// 면적 표기 — 크기에 맞는 단위 (건축 스케일 ㎡, 소축척 스케치는 ㎠/㎟)
const fmtArea = (mm2) => mm2 >= 1e5 ? (mm2 / 1e6).toFixed(2) + '㎡'
  : (mm2 >= 1e3 ? Math.round(mm2 / 100) + '㎠' : Math.round(mm2) + '㎟');
function drawPreview() {
  const k = V().scale;
  g.save();
  g.fillStyle = 'rgba(53,208,255,.10)';
  for (const r of preview.regions) {                 // 닫힌 영역 채움
    if (r.circle) { const c = w2s(r.circle.cx, r.circle.cy); g.beginPath(); g.arc(c[0], c[1], r.circle.r * k, 0, 6.2832); g.fill(); }
    else { g.beginPath(); r.pts.forEach((p, i) => { const q = w2s(p[0], p[1]); i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]); }); g.closePath(); g.fill(); }
  }
  g.strokeStyle = '#35d0ff'; g.lineWidth = 1.5; g.setLineDash([7, 4]);
  for (const s of preview.shapes) {                  // 인식 기하 (점선)
    g.beginPath();
    if (s.kind === 'line') { const a = w2s(s.a[0], s.a[1]), b = w2s(s.b[0], s.b[1]); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); }
    else if (s.kind === 'circle') { const c = w2s(s.cx, s.cy); g.arc(c[0], c[1], s.r * k, 0, 6.2832); }
    else if (s.kind === 'arc') {                     // cad.js ARC 표기와 동일한 화면 각 변환
      const c = w2s(s.cx, s.cy);
      g.arc(c[0], c[1], s.r * k, -s.endAngle * Math.PI / 180, -s.startAngle * Math.PI / 180);
    } else if (s.pts) {
      s.pts.forEach((p, i) => { const q = w2s(p[0], p[1]); i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]); });
      if (s.closed || s.kind === 'rect' || s.kind === 'polygon') g.closePath();
    } else { continue; }
    g.stroke();
  }
  g.setLineDash([]);
  g.fillStyle = '#7fe3ff'; g.font = '12px -apple-system,system-ui,sans-serif'; g.textAlign = 'center';
  for (const r of preview.regions) {                 // 면적 라벨
    let cx = 0, cy = 0;
    if (r.circle) { cx = r.circle.cx; cy = r.circle.cy; }
    else { for (const p of r.pts) { cx += p[0]; cy += p[1]; } cx /= r.pts.length; cy /= r.pts.length; }
    const q = w2s(cx, cy);
    g.fillText(fmtArea(r.areaMM2), q[0], q[1]);
  }
  g.restore();
}
function redraw() {
  const r = ovRect;
  const dpr = window.devicePixelRatio || 1;
  const nw = Math.max(2, Math.round(r.w * dpr)), nh = Math.max(2, Math.round(r.h * dpr));
  if (skcv.width !== nw || skcv.height !== nh) { skcv.width = nw; skcv.height = nh; }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, r.w, r.h);
  if (!SK.visible) return;
  g.strokeStyle = '#000'; // 초기화
  for (const s of SK.strokes) if (layerVisible(s.layer)) drawStroke(g, s);
  if (live) drawStroke(g, live);
  if (preview) drawPreview();
  if (eraseCursor) {
    g.lineWidth = 1; g.strokeStyle = 'rgba(255,120,120,.9)';
    g.beginPath(); g.arc(eraseCursor.x, eraseCursor.y, eraseRadiusPx(), 0, 6.2832); g.stroke();
  }
}
const eraseRadiusPx = () => Math.max(12, SK.sizePx * 2.5);

// ---------- 뷰 동기화 (rAF) — cad.js 를 건드리지 않고 팬/줌/4분할/문서 전환을 따라간다 ----------
let lastSig = '';
function syncNow() {
  const r = cvRect();
  const hidden = cv.style.display === 'none';
  ovRect = r;
  skcv.style.left = r.x + 'px'; skcv.style.top = r.y + 'px';
  skcv.style.width = r.w + 'px'; skcv.style.height = r.h + 'px';
  skcv.style.display = hidden ? 'none' : '';
  redraw();
}
let pendingImport = null;   // DXF 에서 온 스케치 — 파일명 확정(문서 키 전환) 시 우선 적용
function importStrokes(arr) {
  const deep = JSON.parse(JSON.stringify(arr));
  pendingImport = { strokes: deep, until: performance.now() + 3000 };
  SK.strokes = JSON.parse(JSON.stringify(deep));   // 이름이 안 바뀌는 열기(같은 키)도 즉시 반영
  SK.nextId = Math.max(0, ...SK.strokes.map(s => s.id || 0)) + 1;
  SK.undo.length = 0; SK.redo.length = 0;
  cancelLive(); SK.rev++; saveNow();
}
function tick() {
  const v = V();
  const r = cvRect();
  const hidden = cv.style.display === 'none';
  const dk = 'webcad_sketch::' + ((B.getDocName && B.getDocName()) || '무제');
  if (dk !== SK.docKey) {
    SK.docKey = dk;
    if (pendingImport && performance.now() < pendingImport.until) {
      // DXF 열기 직후 파일명이 바뀐 경우 — localStorage 복원이 파일 스케치를 덮지 않게
      SK.strokes = pendingImport.strokes; pendingImport = null;
      SK.nextId = Math.max(0, ...SK.strokes.map(s => s.id || 0)) + 1;
      SK.undo.length = 0; SK.redo.length = 0;
      SK.rev++; saveNow();
    } else { pendingImport = null; loadNow(); }
  }
  // CAD 레이어의 표시/색 변경도 스케치 렌더에 반영 (동일 연동)
  const lsig = B.state.layers.map(l => l.name + (l.visible === false ? 0 : 1) + l.color).join(',');
  const sig = [v.x, v.y, v.scale, r.x, r.y, r.w, r.h, hidden, SK.visible, SK.rev,
    window.devicePixelRatio || 1, lsig].join('|');
  if (sig !== lastSig) { lastSig = sig; syncNow(); }
  requestAnimationFrame(tick);
}

// ---------- 변경/실행취소 ----------
function pushOp(op) { SK.undo.push(op); if (SK.undo.length > 100) SK.undo.shift(); SK.redo.length = 0; }
// S1 라이브 인식: 스트로크가 바뀔 때마다 (펜 뗌·지우개·undo) 인식 미리보기를 자동 갱신.
// 유령선이 항상 겹쳐 보이고, 하단 칩의 확정 버튼 한 번이면 도면이 된다.
let prevTimer = null;
function schedulePreview() {
  clearTimeout(prevTimer);
  prevTimer = setTimeout(() => {
    if (!SK.on) return;
    if (SK.strokes.length) { try { recognize(); } catch (e) {} }
    else closePreview(), redraw();
  }, 160);
}
function changed() {
  SK.rev++;
  if (SKP.live !== 0) schedulePreview();   // 라이브 미리보기 (스케치 설정에서 끌 수 있음)
  else closePreview();
  saveSoon();
}
function undoSk() {
  const op = SK.undo.pop(); if (!op) return;
  if (op.t === 'add') SK.strokes = SK.strokes.filter(s => s.id !== op.s.id);
  else if (op.t === 'del') SK.strokes.push(...op.ss);
  else if (op.t === 'rep') SK.strokes = JSON.parse(JSON.stringify(op.before));
  SK.redo.push(op); SK.rev++; saveSoon();
  if (SKP.live !== 0) schedulePreview();
}
function redoSk() {
  const op = SK.redo.pop(); if (!op) return;
  if (op.t === 'add') SK.strokes.push(op.s);
  else if (op.t === 'del') { const ids = new Set(op.ss.map(s => s.id)); SK.strokes = SK.strokes.filter(s => !ids.has(s.id)); }
  else if (op.t === 'rep') SK.strokes = JSON.parse(JSON.stringify(op.after));
  SK.undo.push(op); SK.rev++; saveSoon();
  if (SKP.live !== 0) schedulePreview();
}

// ---------- 영속 (문서 이름별 localStorage — Phase 1 범위) ----------
let saveTimer = null, quotaWarned = false;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 600); }
function saveNow() {
  try {
    const data = { v: 1, nextId: SK.nextId, strokes: SK.strokes.map(s => ({
      id: s.id, color: s.color, hw: Math.round(s.hw * 100) / 100,
      pts: s.pts.map(p => [rnd1(p[0]), rnd1(p[1]), Math.round(p[2] * 100) / 100]),
    })) };
    if (SK.strokes.length) localStorage.setItem(SK.docKey, JSON.stringify(data));
    else localStorage.removeItem(SK.docKey);
  } catch (e) {
    if (!quotaWarned) { quotaWarned = true; B.logLine && B.logLine('  스케치 저장 공간이 가득 찼습니다 — 일부 스트로크를 지워주세요.', 'warn'); }
  }
}
function loadNow() {
  cancelLive();
  SK.undo.length = 0; SK.redo.length = 0;
  try {
    const d = JSON.parse(localStorage.getItem(SK.docKey) || 'null');
    SK.strokes = (d && d.strokes) || [];
    SK.nextId = (d && d.nextId) || (Math.max(0, ...SK.strokes.map(s => s.id)) + 1);
  } catch (e) { SK.strokes = []; }
  SK.rev++;
}

// ---------- 입력 ----------
let live = null;            // 진행 중 스트로크
let aiming = null;          // 🎯 조준 중 (그리지 않음)
let livePid = null, livePtype = '';
let lastPt = null;          // 마지막 채택 점 (스크린 px, 씨닝용)
let erasing = null;         // 지우개 드래그 — 지운 스트로크 모음(undo 1건)
const touches = new Map();  // 활성 터치 → 팬/줌
let nav = null;             // {mode:'pan'|'pinch', ...}
let ovClient = { x: 0, y: 0 };  // 오버레이의 client 좌표 원점 캐시

const localXY = (e) => [e.clientX - ovClient.x, e.clientY - ovClient.y];
const pressureOf = (e) => (e.pressure > 0 && e.pressure <= 1) ? e.pressure : 0.5;

// ---------- 스냅 — 스트로크 시작/끝을 CAD 개체·다른 스트로크에 흡착 (틈 없는 벽체)
// ─── 스케치 패스값(보정·인식 허용치) — 초보자도 자기 손에 맞게 조정 (2026-07-26) ───
// fitK: 보정 강도(직선화 관대함) · smooth: 손떨림 제거 횟수 · ortho: 수평수직 정리 각도(°)
// snap: 끝점 흡착 거리(px) · corner: 모서리 판정 각(rad, 작을수록 민감=꺾은선 판정↑)
const SKP_DEF = { fitK: 1, smooth: 2, ortho: 7, snap: 10, corner: 0.6, live: 1 };
// S2 프리셋 — 슬라이더도 부담인 초보용 원탭 (live 는 별도 토글이라 미포함)
const SKP_PRESETS = {
  rough: { ko: '러프 스케치', tip: '대충 그려도 반듯하게 — 강한 보정·넓은 흡착', v: { fitK: 1.8, smooth: 3, ortho: 12, snap: 18, corner: 0.7 } },
  basic: { ko: '기본', tip: '균형 잡힌 기본값', v: { fitK: 1, smooth: 2, ortho: 7, snap: 10, corner: 0.6 } },
  fine:  { ko: '정밀 트레이싱', tip: '원본 선을 최대한 존중 — 약한 보정·좁은 흡착', v: { fitK: 0.5, smooth: 1, ortho: 3, snap: 6, corner: 0.45 } },
};
const skpPresetNow = () => { // 현재 값이 정확히 일치하는 프리셋 키 (없으면 null = 사용자 지정)
  for (const [k, p] of Object.entries(SKP_PRESETS))
    if (Object.entries(p.v).every(([kk, vv]) => Math.abs(SKP[kk] - vv) < 1e-9)) return k;
  return null;
};
let SKP = { ...SKP_DEF };
try { Object.assign(SKP, JSON.parse(localStorage.getItem('webcad_sketch_params') || '{}')); } catch (e) {}
const skpSave = () => { try { localStorage.setItem('webcad_sketch_params', JSON.stringify(SKP)); } catch (e) {} };
const skpOpts = () => ({ fitK: SKP.fitK, orthoTolDeg: SKP.ortho, cornerTol: SKP.corner }); // 인식(analyze)에 넘길 묶음
const SNAP_PX = () => SKP.snap;
let snapPts = null;  // 끝점·꼭짓점·중심 [ [wx, wy], ... ]
let snapSegs = null; // 선 '몸통' [ [ax, ay, bx, by], ... ] — T자 접합도 틈 없이
function collectSnapPts() {
  const out = [], segs = [];
  const ents = B.state.entities;
  const n = Math.min(ents.length, 4000);
  for (let i = 0; i < n; i++) {
    const e = ents[i];
    if (e.type === 'LINE') { out.push([e.x1, e.y1], [e.x2, e.y2]); segs.push([e.x1, e.y1, e.x2, e.y2]); }
    else if (e.type === 'LWPOLYLINE' && e.points) {
      for (const p of e.points) out.push([p[0], p[1]]);
      for (let j = 1; j < e.points.length; j++) segs.push([e.points[j - 1][0], e.points[j - 1][1], e.points[j][0], e.points[j][1]]);
      if (e.closed && e.points.length > 2) { const a = e.points[e.points.length - 1], b = e.points[0]; segs.push([a[0], a[1], b[0], b[1]]); }
    }
    else if (e.type === 'CIRCLE' || e.type === 'ARC') out.push([e.cx, e.cy]);
    if (segs.length > 8000) break;
  }
  for (const s of SK.strokes) {
    if (!s.pts.length) continue;
    const a = s.pts[0], b = s.pts[s.pts.length - 1];
    out.push([a[0], a[1]], [b[0], b[1]]);
    for (let j = 3; j < s.pts.length; j += 3) segs.push([s.pts[j - 3][0], s.pts[j - 3][1], s.pts[j][0], s.pts[j][1]]);
  }
  snapSegs = segs;
  return out;
}
function snapWorld(wx, wy) {
  if (!SK.snap || !snapPts) return null;
  const rW = SNAP_PX() / V().scale;
  if (rW <= 0) return null;                            // 흡착 0 = 스냅 끔
  let best = null, bd = rW;
  for (const p of snapPts) {                            // ① 끝점·꼭짓점 우선
    const d = Math.hypot(p[0] - wx, p[1] - wy);
    if (d < bd) { bd = d; best = [p[0], p[1]]; }
  }
  if (best) return best;
  if (snapSegs) {                                       // ② 선 몸통(수선 투영) — T자 접합
    for (const sg of snapSegs) {
      const dx = sg[2] - sg[0], dy = sg[3] - sg[1];
      const L2 = dx * dx + dy * dy; if (L2 < 1e-9) continue;
      let t = ((wx - sg[0]) * dx + (wy - sg[1]) * dy) / L2;
      t = Math.max(0, Math.min(1, t));
      const px = sg[0] + t * dx, py = sg[1] + t * dy;
      const d = Math.hypot(wx - px, wy - py);
      if (d < bd) { bd = d; best = [px, py]; }
    }
  }
  return best;
}
// ---------- 상시 자동 보정 — 직선은 곧게, 곡선은 매끈하게 (손떨림 제거) ----------
function pressureSampler(pts) {
  const L = [0];
  for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const T = L[L.length - 1] || 1;
  return (f) => {
    const target = f * T;
    let i = 1; while (i < L.length - 1 && L[i] < target) i++;
    const f2 = (target - L[i - 1]) / Math.max(1e-9, L[i] - L[i - 1]);
    return pts[i - 1][2] + (pts[i][2] - pts[i - 1][2]) * Math.max(0, Math.min(1, f2));
  };
}
function beautifyStroke(s) {
  const P = window.WEBCAD_PREP;
  if (!P || s.pts.length < 3) return;
  let shape = null;
  try { shape = P.analyze([s], skpOpts()).shapes[0]; } catch (e) { return; }
  if (!shape || shape.kind === 'dot') return;
  const pres = pressureSampler(s.pts);
  const stepW = 6 / V().scale;                         // 화면 6px 간격 리샘플
  const out = [];
  const emitSeg = (a, b, f0, f1) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(L / stepW));
    for (let i = (out.length ? 1 : 0); i <= n; i++) {
      const t = i / n, f = f0 + (f1 - f0) * t;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, pres(f)]);
    }
    if (!out.length) out.push([a[0], a[1], pres(f0)]);
  };
  const emitPath = (vs, closed) => {
    const P2 = closed ? [...vs, vs[0]] : vs;
    let tot = 0; const Ls = [0];
    for (let i = 1; i < P2.length; i++) { tot += Math.hypot(P2[i][0] - P2[i - 1][0], P2[i][1] - P2[i - 1][1]); Ls.push(tot); }
    out.push([P2[0][0], P2[0][1], pres(0)]);
    for (let i = 1; i < P2.length; i++) emitSeg(P2[i - 1], P2[i], Ls[i - 1] / (tot || 1), Ls[i] / (tot || 1));
  };
  if (shape.kind === 'line') emitPath([shape.a, shape.b], false);
  else if (shape.kind === 'polyline') emitPath(shape.pts, false);
  else if (shape.kind === 'rect' || shape.kind === 'polygon') emitPath(shape.pts, true);
  else if (shape.kind === 'circle') {
    const vs = []; for (let i = 0; i < 48; i++) { const t = i / 48 * 2 * Math.PI; vs.push([shape.cx + Math.cos(t) * shape.r, shape.cy + Math.sin(t) * shape.r]); }
    emitPath(vs, true);
  } else if (shape.kind === 'arc') {
    const sweep = ((shape.endAngle - shape.startAngle) % 360 + 360) % 360 || 360;
    const n = Math.max(8, Math.round(sweep / 5));
    const vs = []; for (let i = 0; i <= n; i++) { const a = (shape.startAngle + sweep * i / n) * Math.PI / 180; vs.push([shape.cx + Math.cos(a) * shape.r, shape.cy + Math.sin(a) * shape.r]); }
    // ★ARC 는 반시계 규약이라 시계 방향으로 그린 호는 점열이 뒤집힌다 — 원래 진행 방향(a→b) 복원
    // (뒤집힌 채 두면 끝점 스냅·필압이 반대 끝에 붙는다)
    if (shape.a && Math.hypot(vs[0][0] - shape.a[0], vs[0][1] - shape.a[1])
      > Math.hypot(vs[vs.length - 1][0] - shape.a[0], vs[vs.length - 1][1] - shape.a[1])) vs.reverse();
    emitPath(vs, false);
  } else { // 자유곡선 — 등간격 리샘플 + 이동평균 2회 (미세 울퉁불퉁 제거, 형태 유지)
    const raw = s.pts;
    const rs = []; const prevPres = pres;
    { let tot = 0; const Ls = [0];
      for (let i = 1; i < raw.length; i++) { tot += Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]); Ls.push(tot); }
      const n = Math.max(4, Math.min(200, Math.round(tot / stepW)));
      for (let i = 0; i <= n; i++) {
        const target = tot * i / n;
        let j = 1; while (j < Ls.length - 1 && Ls[j] < target) j++;
        const f2 = (target - Ls[j - 1]) / Math.max(1e-9, Ls[j] - Ls[j - 1]);
        rs.push([raw[j - 1][0] + (raw[j][0] - raw[j - 1][0]) * f2, raw[j - 1][1] + (raw[j][1] - raw[j - 1][1]) * f2, prevPres(i / n)]);
      }
    }
    for (let pass = 0; pass < SKP.smooth; pass++)      // 손떨림 제거 횟수 (0 = 원본 그대로)
      for (let i = 1; i < rs.length - 1; i++) {
        rs[i][0] = (rs[i - 1][0] + rs[i][0] * 2 + rs[i + 1][0]) / 4;
        rs[i][1] = (rs[i - 1][1] + rs[i][1] * 2 + rs[i + 1][1]) / 4;
      }
    out.length = 0; out.push(...rs);
  }
  if (out.length >= 2) {
    // 보정 뒤에도 끝점 스냅 유지 (틈 방지)
    const sA = snapWorld(out[0][0], out[0][1]);
    const sB = snapWorld(out[out.length - 1][0], out[out.length - 1][1]);
    if (shape.kind === 'line' && (sA || sB)) {
      const a2 = sA ? [sA[0], sA[1]] : [out[0][0], out[0][1]];
      const b2 = sB ? [sB[0], sB[1]] : [out[out.length - 1][0], out[out.length - 1][1]];
      out.length = 0; emitPath([a2, b2], false);
    } else {
      if (sA) { out[0][0] = sA[0]; out[0][1] = sA[1]; }
      if (sB) { out[out.length - 1][0] = sB[0]; out[out.length - 1][1] = sB[1]; }
    }
    s.pts = out;
  }
}
// 조준/드로잉 스냅 미리보기 마커 (hover.js 의 마커를 빌려 쓴다)
function showAimAt(e) {
  const PH = window.WEBCAD_PENHOVER; if (!PH) return;
  PH.showDot(e.clientX, e.clientY);
  const [sx, sy] = localXY(e);
  const [wx, wy] = s2w(sx, sy);
  const sp = snapWorld(wx, wy);
  if (sp) { const q = w2s(sp[0], sp[1]); PH.showSnap(ovClient.x + q[0], ovClient.y + q[1]); }
  else PH.hideSnap();
}
function hideAimMarkers() {
  const PH = window.WEBCAD_PENHOVER;
  if (PH) { PH.hideDot(); PH.hideSnap(); }
}
function startStroke(e) {
  const [sx, sy] = localXY(e);
  livePid = e.pointerId; livePtype = e.pointerType;
  try { skcv.setPointerCapture(e.pointerId); } catch (err) {}
  if (SK.aim) {                                        // 🎯 조준: 그리지 않고 위치·스냅만
    aiming = true;
    snapPts = collectSnapPts();
    showAimAt(e);
    return;
  }
  if (SK.tool === 'eraser') { erasing = []; eraseCursor = { x: sx, y: sy }; eraseAt(sx, sy); return; }
  let [wx, wy] = s2w(sx, sy);
  snapPts = collectSnapPts();
  const sp = snapWorld(wx, wy);
  if (sp) { wx = sp[0]; wy = sp[1]; }
  live = { id: SK.nextId++, color: SK.color, hw: (SK.sizePx / 2) / V().scale,
    brush: SK.brush, layer: SK.layer || ((B.state && B.state.currentLayer) || ''),
    pts: [[wx, wy, pressureOf(e)]] };
  lastPt = { x: sx, y: sy, p: pressureOf(e) };
}
function extendStroke(e) {
  const evs = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
  const k = V().scale;
  for (const ev of evs) {
    const [sx, sy] = localXY(ev);
    const p = pressureOf(ev);
    // 씨닝: 0.35px 미만 이동이고 필압 변화도 작으면 버린다 (감성은 남고 용량만 준다)
    if (lastPt) {
      const d = Math.hypot(sx - lastPt.x, sy - lastPt.y);
      if (d < 0.35 && Math.abs(p - lastPt.p) < 0.06) continue;
    }
    const [wx, wy] = s2w(sx, sy);
    const prev = live.pts[live.pts.length - 1];
    live.pts.push([wx, wy, p]);
    drawSeg(g, live, prev, live.pts[live.pts.length - 1], k); // 라이브: 증분만 그린다(저지연)
    lastPt = { x: sx, y: sy, p };
  }
}
function finishStroke() {
  if (live && live.pts.length) {
    // 끝점 스냅 — 벽 끝·다른 스트로크에 정확히 붙는다
    const lp = live.pts[live.pts.length - 1];
    const sp = snapWorld(lp[0], lp[1]);
    if (sp) { lp[0] = sp[0]; lp[1] = sp[1]; }
    // 상시 자동 보정 — 직선은 곧게, 곡선은 매끈하게 (📐 토글로 끌 수 있음)
    if (SK.beautify !== false && SK.tool !== 'eraser') beautifyStroke(live);
    live.pts = live.pts.map(p => [rnd1(p[0]), rnd1(p[1]), Math.round(p[2] * 100) / 100]);
    SK.strokes.push(live);
    pushOp({ t: 'add', s: live });
    changed();
  }
  live = null; livePid = null; lastPt = null; snapPts = null;
  const PH = window.WEBCAD_PENHOVER; if (PH) PH.hideSnap();
}
function cancelLive() { live = null; livePid = null; lastPt = null; erasing = null; eraseCursor = null; aiming = null; hideAimMarkers(); }

function eraseAt(sx, sy) {
  const rW = eraseRadiusPx() / V().scale; // 월드 반경
  const [wx, wy] = s2w(sx, sy);
  const hit = [];
  for (const s of SK.strokes) {
    const rr = rW + s.hw * 2;
    if (s.pts.some(p => Math.hypot(p[0] - wx, p[1] - wy) <= rr)) hit.push(s);
  }
  if (hit.length) {
    const ids = new Set(hit.map(s => s.id));
    SK.strokes = SK.strokes.filter(s => !ids.has(s.id));
    erasing.push(...hit);
    SK.rev++;
  }
}

// 팬/줌 — 두 손가락(펜 사용자) 또는 마우스 우/휠 버튼. 뷰는 cad 의 state.view 를 직접 움직인다.
function navStart() {
  const r = skcv.getBoundingClientRect(); ovClient = { x: r.left, y: r.top };
  const ts = [...touches.values()];
  const v = V();
  if (ts.length >= 2) nav = { mode: 'pinch', a0: { ...ts[0] }, b0: { ...ts[1] }, v0: { x: v.x, y: v.y, scale: v.scale } };
  else if (ts.length === 1) nav = { mode: 'pan', p0: { ...ts[0] }, v0: { x: v.x, y: v.y, scale: v.scale } };
  else nav = null;
}
function navMove() {
  if (!nav) return;
  const v = V(), ts = [...touches.values()];
  if (nav.mode === 'pan' && ts.length >= 1) {
    v.x = nav.v0.x - (ts[0].x - nav.p0.x) / nav.v0.scale;
    v.y = nav.v0.y + (ts[0].y - nav.p0.y) / nav.v0.scale;
  } else if (nav.mode === 'pinch' && ts.length >= 2) {
    const d0 = Math.hypot(nav.b0.x - nav.a0.x, nav.b0.y - nav.a0.y) || 1;
    const d1 = Math.hypot(ts[1].x - ts[0].x, ts[1].y - ts[0].y) || 1;
    const f = Math.min(20, Math.max(0.05, d1 / d0));
    const W = cv._w || ovRect.w, H = cv._h || ovRect.h;
    const m0 = { x: (nav.a0.x + nav.b0.x) / 2 - ovClient.x, y: (nav.a0.y + nav.b0.y) / 2 - ovClient.y };
    const m1 = { x: (ts[0].x + ts[1].x) / 2 - ovClient.x, y: (ts[0].y + ts[1].y) / 2 - ovClient.y };
    // 시작 중점 아래 월드점이 현재 중점을 따라오도록
    const wmx = (m0.x - W / 2) / nav.v0.scale + nav.v0.x;
    const wmy = -(m0.y - H / 2) / nav.v0.scale + nav.v0.y;
    v.scale = Math.min(1e4, Math.max(1e-7, nav.v0.scale * f));
    v.x = wmx - (m1.x - W / 2) / v.scale;
    v.y = wmy + (m1.y - H / 2) / v.scale;
  }
  appDraw();
}
let mousePan = null;
function zoomAt(sx, sy, f) {
  const v = V(), W = cv._w || ovRect.w, H = cv._h || ovRect.h;
  const [wx, wy] = s2w(sx, sy);
  v.scale = Math.min(1e4, Math.max(1e-7, v.scale * f));
  v.x = wx - (sx - W / 2) / v.scale;
  v.y = wy + (sy - H / 2) / v.scale;
  appDraw();
}

skcv.addEventListener('pointerdown', (e) => {
  if (!SK.on) return;
  e.preventDefault();
  const r = skcv.getBoundingClientRect(); ovClient = { x: r.left, y: r.top };
  if (e.pointerType === 'pen') SK.penSeen = true;
  if (e.pointerType === 'touch') {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { skcv.setPointerCapture(e.pointerId); } catch (err) {}
    if (live && livePtype === 'touch' && touches.size >= 2) { cancelLive(); redraw(); } // 손가락 그리기 → 두 번째 손가락 = 팬줌 전환
    if (live) return;                       // 펜으로 그리는 중의 터치(손바닥) 전면 무시
    if (touches.size >= 2) { navStart(); return; }
    if (SK.penSeen) return;                 // 팜 리젝션: 펜 사용자는 한 손가락 무시
    if (maybeTapFit(e)) return;             // S3: 미리보기 도형 탭 = 후보 순환 (그리기 아님)
    startStroke(e); return;                 // 펜 없는 기기(폰 등)는 손가락 그리기
  }
  if (e.button === 2 || e.button === 1) {   // 마우스 우/휠 버튼 = 팬
    mousePan = { cx: e.clientX, cy: e.clientY, v0: { x: V().x, y: V().y }, s: V().scale };
    try { skcv.setPointerCapture(e.pointerId); } catch (err) {}
    return;
  }
  if (maybeTapFit(e)) return;               // S3: 미리보기 도형 탭 = 후보 순환
  startStroke(e);
});
// S3 탭 판정 상태 — pointerdown 에서 미리보기 도형 위면 그리기를 미루고, up 에서 이동량이 작으면 순환
let tapFit = null;
function maybeTapFit(e) {
  if (!preview || SK.tool === 'eraser' || aiming) return false;
  const hitId = hitPreviewShape(e.clientX - ovClient.x, e.clientY - ovClient.y);
  if (hitId == null) return false;
  tapFit = { id: hitId, x: e.clientX, y: e.clientY, pid: e.pointerId };
  try { skcv.setPointerCapture(e.pointerId); } catch (err) {}
  return true;
}
skcv.addEventListener('pointermove', (e) => {
  if (!SK.on) return;
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (nav) { navMove(); return; }
  }
  if (mousePan && (e.buttons & 6)) {
    const v = V();
    v.x = mousePan.v0.x - (e.clientX - mousePan.cx) / mousePan.s;
    v.y = mousePan.v0.y + (e.clientY - mousePan.cy) / mousePan.s;
    appDraw(); return;
  }
  if (e.pointerId !== livePid) return;
  e.preventDefault();
  if (aiming) { showAimAt(e); return; }                // 🎯 조준: 마커만 따라간다
  if (erasing) { const [sx, sy] = localXY(e); eraseCursor = { x: sx, y: sy }; eraseAt(sx, sy); redraw(); return; }
  if (live) {
    extendStroke(e);
    // 지금 떼면 흡착될 지점을 실시간 표시 — 호버 미지원 기기에서도 떼기 전에 확인
    const PH = window.WEBCAD_PENHOVER;
    if (PH && live) {
      const lp = live.pts[live.pts.length - 1];
      const sp = snapWorld(lp[0], lp[1]);
      if (sp) { const q = w2s(sp[0], sp[1]); PH.showSnap(ovClient.x + q[0], ovClient.y + q[1]); }
      else PH.hideSnap();
    }
  }
});
function pointerEnd(e) {
  if (tapFit && e.pointerId === tapFit.pid) {   // S3: 이동이 작으면 탭 = 후보 순환
    const moved = Math.hypot(e.clientX - tapFit.x, e.clientY - tapFit.y);
    const id2 = tapFit.id; tapFit = null;
    if (moved <= 7) { cycleFit(id2); return; }
    return;                                     // 드래그로 변하면 무시 (그리기는 빈 곳에서)
  }
  if (e.pointerType === 'touch') {
    touches.delete(e.pointerId);
    if (nav) { if (touches.size) navStart(); else nav = null; }
  }
  if (mousePan && e.pointerType === 'mouse') mousePan = null;
  if (e.pointerId !== livePid) return;
  if (aiming) { aiming = null; hideAimMarkers(); livePid = null; snapPts = null; return; }
  if (erasing) {
    if (erasing.length) { pushOp({ t: 'del', ss: erasing }); changed(); }
    erasing = null; eraseCursor = null; livePid = null; redraw(); return;
  }
  finishStroke();
}
skcv.addEventListener('pointerup', pointerEnd);
skcv.addEventListener('pointercancel', (e) => {
  if (e.pointerType === 'touch') { touches.delete(e.pointerId); if (nav) { if (touches.size) navStart(); else nav = null; } }
  if (e.pointerId === livePid) { cancelLive(); redraw(); }
});
skcv.addEventListener('wheel', (e) => {
  if (!SK.on) return;
  e.preventDefault();
  const r = skcv.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0012));
}, { passive: false });
skcv.addEventListener('contextmenu', (e) => { if (SK.on) e.preventDefault(); });

// ---------- 키보드 (스케치 모드에서만; 캡처로 앱 단축키보다 먼저) ----------
window.addEventListener('keydown', (e) => {
  if (!SK.on) return;
  const t = e.target;
  if (t && (/INPUT|TEXTAREA|SELECT/.test(t.tagName) || (t.closest && t.closest('#aiPanel')))) return; // 입력창·AI 채팅은 그대로
  const k = (typeof e.key === 'string' ? e.key : '').toLowerCase();
  if (e.ctrlKey && k === 'z' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); undoSk(); return; }
  if (e.ctrlKey && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); e.stopPropagation(); redoSk(); return; }
  if (e.key === 'Escape') { e.stopPropagation(); if (preview) closePreview(); else exit(); return; }
  if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    if (k === 'b') { e.stopPropagation(); setTool('pen'); return; }
    if (k === 'e') { e.stopPropagation(); setTool('eraser'); return; }
  }
  e.stopPropagation(); // 스케치 모드에선 나머지 앱 단축키(글자→명령창 점프 등)를 잠근다
}, true);

// ---------- ✨ 인식 (Phase 2 전처리 엔진 — AI 0) ----------
function closePreview() { if (preview) { preview = null; SK.rev++; } if (infoEl) infoEl.style.display = 'none'; }
// S3 즉석 교정: 자동 판정이 틀린 도형을 미리보기에서 '탭'하면 후보를 순환한다 (파라미터 조정 없이 그 도형만).
// SK.fitOv = {strokeId: kind} — 인식(analyze) 결과에 강제 재적합(refitAs)으로 덮어씀. 확정·건물화 모두 반영.
function applyFitOv(anal) {
  if (!anal || !SK.fitOv || !Object.keys(SK.fitOv).length) return anal;
  const P2 = window.WEBCAD_PREP;
  anal.shapes = anal.shapes.map(sh => {
    const k = SK.fitOv[sh.strokeId];
    if (!k || k === sh.kind) return sh;
    const st = SK.strokes.find(s2 => s2.id === sh.strokeId);
    return (st && P2.refitAs && P2.refitAs(st, k, skpOpts())) || sh;
  });
  return anal;
}
const FIT_KO = { line: '직선', arc: '호', polyline: '꺾은선', curve: '곡선', circle: '원', rect: '사각형', polygon: '다각형' };
function cycleFit(strokeId) {
  const cur = preview && preview.shapes.find(s2 => s2.strokeId === strokeId);
  if (!cur) return;
  const closedish = !!(cur.closed || ['circle', 'rect', 'polygon'].includes(cur.kind));
  const cyc = closedish ? ['circle', 'rect', 'polygon', 'curve'] : ['line', 'arc', 'polyline', 'curve'];
  const beforeKind = cur.kind;
  let idx = cyc.indexOf(SK.fitOv[strokeId] || cur.kind);
  // 후보를 순서대로 시도하되, 재적합이 폴백으로 '같은 판정'을 내면(예: 거의 직선 → 호 요청이 직선 폴백)
  // 다음 후보로 계속 — 탭했는데 안 바뀌는 헛순환 방지. 한 바퀴 끝은 자동 판정 복귀.
  let applied = null;
  for (let step = 0; step <= cyc.length; step++) {
    idx++;
    if (idx >= cyc.length) { delete SK.fitOv[strokeId]; applied = null; recognize(); break; }
    SK.fitOv[strokeId] = cyc[idx];
    recognize();
    const nk = (preview.shapes.find(s2 => s2.strokeId === strokeId) || {}).kind;
    if (nk && nk !== beforeKind) { applied = nk; break; }
  }
  if (infoTxt) infoTxt.textContent = '🔄 ' + (applied ? FIT_KO[applied] + '(으)로 교정' : '자동 판정으로 복귀') + ' — ' + infoTxt.textContent.replace(/^[✨🔄][^—]*— ?/, '').replace(/^[✨🔄] ?/, '');
}
// 미리보기 도형 히트테스트 (화면 px) — 탭 위치에서 8px 안의 도형 strokeId
function hitPreviewShape(sx, sy) {
  if (!preview) return null;
  const k = V().scale, TOL = 9;
  const segD = (x1, y1, x2, y2) => {
    const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy || 1;
    const t2 = Math.max(0, Math.min(1, ((sx - x1) * dx + (sy - y1) * dy) / L2));
    return Math.hypot(sx - (x1 + dx * t2), sy - (y1 + dy * t2));
  };
  for (const s of preview.shapes) {
    if (s.kind === 'line') { const a = w2s(s.a[0], s.a[1]), b = w2s(s.b[0], s.b[1]); if (segD(a[0], a[1], b[0], b[1]) <= TOL) return s.strokeId; }
    else if (s.kind === 'circle' || s.kind === 'arc') { const c = w2s(s.cx, s.cy); if (Math.abs(Math.hypot(sx - c[0], sy - c[1]) - s.r * k) <= TOL) return s.strokeId; }
    else if (s.pts) {
      const n2 = s.pts.length, m2 = (s.closed || s.kind === 'rect' || s.kind === 'polygon') ? n2 : n2 - 1;
      for (let i = 0; i < m2; i++) {
        const a = w2s(s.pts[i][0], s.pts[i][1]), b = w2s(s.pts[(i + 1) % n2][0], s.pts[(i + 1) % n2][1]);
        if (segD(a[0], a[1], b[0], b[1]) <= TOL) return s.strokeId;
      }
    }
  }
  return null;
}
function recognize() {
  if (!window.WEBCAD_PREP) { B.logLine && B.logLine('  전처리 엔진(prep.js)이 로드되지 않았습니다.', 'warn'); return null; }
  if (!SK.strokes.length) { B.logLine && B.logLine('  인식할 스케치가 없습니다 — 먼저 펜으로 그려주세요.', 'warn'); return null; }
  if (!SK.fitOv) SK.fitOv = {};
  preview = applyFitOv(window.WEBCAD_PREP.analyze(SK.strokes, skpOpts()));
  SK.rev++;
  const KN = { line: '선', polyline: '꺾은선', rect: '사각형', polygon: '다각형', circle: '원', arc: '호', curve: '곡선', dot: '점' };
  const parts = Object.entries(preview.counts).map(([k, n]) => (KN[k] || k) + ' ' + n);
  const areaSum = preview.regions.reduce((a, r) => a + r.areaMM2, 0);
  infoTxt.textContent = '✨ ' + parts.join(' · ')
    + (preview.regions.length ? ` · 닫힌 영역 ${preview.regions.length}개 (${fmtArea(areaSum)})` : ' · 닫힌 영역 없음');
  infoEl.style.display = 'flex';
  return preview;
}
function commitRecog() {
  if (!preview) return 0;
  B.pushUndo();
  B.ensureLayer('스케치 인식', '#35d0ff');
  let nAdded = 0;
  for (const s of preview.shapes) {
    let e = null;
    if (s.kind === 'line') e = { type: 'LINE', x1: s.a[0], y1: s.a[1], x2: s.b[0], y2: s.b[1] };
    else if (s.kind === 'rect' || s.kind === 'polygon') e = { type: 'LWPOLYLINE', points: s.pts.map(p => [p[0], p[1]]), closed: true };
    else if (s.kind === 'polyline' || s.kind === 'curve') e = { type: 'LWPOLYLINE', points: s.pts.map(p => [p[0], p[1]]), closed: !!s.closed };
    else if (s.kind === 'circle') e = { type: 'CIRCLE', cx: s.cx, cy: s.cy, r: s.r };
    else if (s.kind === 'arc') e = { type: 'ARC', cx: s.cx, cy: s.cy, r: s.r, startAngle: s.startAngle, endAngle: s.endAngle };
    if (!e) continue;                                  // dot 등은 건너뜀
    e.layer = '스케치 인식';
    const ent = B.addEntity(e);
    ent.color = s.color;                               // 스트로크 색 유지 — Phase 3 의미 판단의 단서
    nAdded++;
  }
  B.refresh();
  clearConverted();
  B.logLine && B.logLine(`  ✨ 스케치 인식 → CAD ${nAdded}개 생성('스케치 인식' 레이어). 스케치 선은 정리했습니다 (Ctrl+Z 로 복원).`, 'ok');
  closePreview();
  return nAdded;
}
// 변환이 끝난 스케치 선은 지운다 — 도면과 겹쳐 헷갈리지 않게 (스케치 Ctrl+Z 로 복원 가능)
function clearConverted() {
  if (!SK.strokes.length) return;
  pushOp({ t: 'del', ss: SK.strokes.slice() });
  SK.strokes = [];
  SK.rev++; saveSoon();
}

// ---------- 🏠 건물 만들기 (Phase 3 해석 파이프라인) ----------
// 스케일 보정(프로그램) → 역할 판정(규칙, 키 있으면 AI 가 요약 JSON 만 보고 보정)
// → BIM 생성(프로그램). 손그림은 그대로 남는다.
function scaleStrokes(k) {
  const before = JSON.parse(JSON.stringify(SK.strokes));
  for (const s of SK.strokes) { s.hw *= k; s.pts = s.pts.map(p => [p[0] * k, p[1] * k, p[2]]); }
  pushOp({ t: 'rep', before, after: JSON.parse(JSON.stringify(SK.strokes)) });
  SK.rev++; saveSoon();
}
function fitView() {
  const all = SK.strokes.flatMap(s => s.pts);
  if (!all.length) return;
  let x0 = 1e30, y0 = 1e30, x1 = -1e30, y1 = -1e30;
  for (const p of all) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  const v = V(), W = cv._w || ovRect.w, H = cv._h || ovRect.h;
  v.x = (x0 + x1) / 2; v.y = (y0 + y1) / 2;
  v.scale = Math.min(W / Math.max(1, (x1 - x0) * 1.3), H / Math.max(1, (y1 - y0) * 1.3));
  appDraw();
}
let building = false;
async function buildBuilding() {
  const BF = window.WEBCAD_BIMIFY;
  if (!preview || !BF || building) return null;
  building = true;
  try {
    infoTxt.textContent = '🏠 해석 중…';
    // ① 스케일 보정 — 화면 감각으로 작게 그린 스케치를 건축 스케일로 (스트로크도 함께 → 정합 유지)
    let anal = preview;
    let k = BF.calcScale(anal);
    // B1 축척 어시스트: 닫힌 방이 있으면 '가장 큰 방의 실제 면적'을 한 번 물어 전체 축척 확정.
    // 엔터 = 자동 추정값 그대로(기존 동작), 숫자 입력 = 그 면적 기준으로 정확히. "5평"처럼 평도 허용.
    const areasB = (anal.regions || []).map(r => r.areaMM2);
    if (areasB.length) {
      const maxA = Math.max(...areasB);
      const autoM2 = Math.round(maxA * k * k / 1e6 * 10) / 10;
      const ans = prompt(`가장 큰 방의 실제 면적을 알려주세요 — 스케치 전체 축척이 여기에 맞춰집니다.\n(㎡ 기본 · "5평"처럼 평 단위도 가능 · 엔터 = 자동 ${autoM2}㎡)`, String(autoM2));
      if (ans === null) { recognize(); return null; }        // 취소 = 건물화 중단 (미리보기 복원)
      const mB = String(ans).trim().match(/^([\d.]+)\s*(평|py)?/i);
      if (mB && parseFloat(mB[1]) > 0) {
        const wantM2 = parseFloat(mB[1]) * (mB[2] ? 3.3058 : 1);
        k = Math.round(Math.sqrt(wantM2 * 1e6 / maxA) * 1000) / 1000;   // 입력 면적은 '정확히' 맞춘다
      }
    }
    if (Math.abs(k - 1) > 1e-9) {
      scaleStrokes(k);                             // (changed 아님 — 미리보기는 직접 재계산)
      anal = applyFitOv(window.WEBCAD_PREP.analyze(SK.strokes, skpOpts()));   // 즉석 교정 반영
      B.logLine && B.logLine(`  📐 축척 확정 ×${k} — 가장 큰 방 기준으로 스케치를 건축 스케일에 맞췄습니다.`, 'info');
    }
    // ② 역할 판정 — 규칙 우선, API 키가 있으면 AI 가 요약만 보고 보정 (이미지 전송 없음)
    const { roles } = await BF.classify(anal);
    // ③ 생성 — 전부 프로그램
    const counts = BF.build(anal, roles);
    preview = null; SK.rev++; infoEl.style.display = 'none';
    fitView();
    clearConverted();
    const KO = { wall: '벽', door: '문', window: '창', column: '기둥', furniture: '가구', slab: '슬래브' };
    const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([kk, n]) => KO[kk] + ' ' + n);
    B.logLine && B.logLine(`  🏠 손그림 → 건물 생성: ${parts.join(' · ')} (규칙 판정). 스케치 선은 정리했습니다(Ctrl+Z 복원). 3D(view3d)로 확인해 보세요.`, 'ok');
    return counts;
  } finally { building = false; }
}

// ---------- 모드 전환 — 스케치는 별도 화면이 아니다 (사용자 피드백) ----------
// CAD 화면 그대로 위에서 그린다. 4분할이면 평면 칸 위에서 — 3D 와 나란히 보며 스케치.
function enter() {
  if (SK.on) return;
  // 평면 칸이 아예 없으면(3D 단일 화면) 평면으로 — 스케치 입력면은 평면 좌표계다
  if (B.is3D && B.is3D() && cv.style.display === 'none') { const b = document.getElementById('vwPlan'); if (b) b.click(); }
  SK.on = true;
  skcv.style.pointerEvents = 'auto';
  skcv.style.cursor = 'crosshair';
  // 툴바를 '스케치 탭' 바로 위에 세로로 — 탭 위치를 따라간다 (탭 순서를 바꿔도)
  try {
    const tb = entryBtn.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    if (tb.width) {
      bar.style.left = Math.max(8, tb.left - wr.left) + 'px';
      bar.style.bottom = Math.max(44, wr.bottom - tb.top + 6) + 'px';
    }
  } catch (e) {}
  bar.style.display = 'flex';
  entryBtn.classList.add('on');                       // 탭 활성 표시
  refreshLayerSel();
  B.logLine && B.logLine('  ✏️ 스케치 — 펜: 그리기 · 두 손가락: 이동/확대 · 시작/끝점은 CAD 에 스냅 · Esc/완료: 종료', 'info');
}
function exit() {
  if (!SK.on) return;
  SK.on = false;
  cancelLive();
  closePreview();
  skcv.style.pointerEvents = 'none';
  bar.style.display = 'none';
  entryBtn.classList.remove('on');                    // 탭 활성 해제
  redraw();
}
function setTool(tool) {
  SK.tool = tool;
  eraseCursor = null;
  const active = tool === 'eraser' ? 'eraser' : SK.brush;
  for (const [t, btn] of Object.entries(toolBtns)) {
    btn.style.background = t === active ? 'var(--accent,#0A84FF)' : 'transparent';
    btn.style.color = t === active ? '#fff' : 'var(--ink,#cfe0ff)';
  }
  skcv.style.cursor = 'crosshair';
}
function setBrush(b2) { SK.brush = b2; SK.tool = 'pen'; rememberPref(); setTool('pen'); }
// 레이어별 펜 종류·색 기억 — "각 레이어에 펜·색이 지정되면 효율이 높아진다"
let skPrefs = {};
try { skPrefs = JSON.parse(localStorage.getItem('webcad_sketch_prefs') || '{}'); } catch (e) {}
function rememberPref() {
  const ly = SK.layer || (B.state && B.state.currentLayer) || '';
  if (!ly) return;
  skPrefs[ly] = { brush: SK.brush, color: SK.color };
  try { localStorage.setItem('webcad_sketch_prefs', JSON.stringify(skPrefs)); } catch (e) {}
}
const layerColorOf = (name) => {
  const l = B.state.layers.find(x => x.name === name);
  return (l && l.color) || SK.color;
};

// ---------- UI — 드로잉 앱 문법 (Procreate 참고: 큰 터치 타깃, 최소 크롬) ----------
const SWATCHES = ['#e6e1d3', '#ffffff', '#16161a', '#e04f4f', '#3a7bd5', '#3aa66a', '#e0a33a', '#9c6bd5'];
const bar = document.createElement('div');
bar.id = 'skBar';
// 스케치 툴바 — 하단 '스케치 탭' 위로 세로(컬럼)로 열린다. 색은 전부 테마 변수 —
// 라이트/다크 모두 따라간다 (예전엔 다크 고정이라 라이트 모드에서도 검었다. 2026-07-20)
bar.style.cssText = 'position:absolute;left:8px;bottom:52px;z-index:30;'
  + 'display:none;flex-direction:column;align-items:stretch;gap:4px;width:176px;'
  + 'max-height:min(600px, calc(100% - 140px));overflow-y:auto;padding:10px;border-radius:14px;'
  + 'background:var(--glass-pop,#171b25);border:1px solid var(--line-strong,rgba(120,140,200,.35));'
  + 'box-shadow:var(--shadow-pop,0 8px 26px rgba(0,0,0,.45));font:13px -apple-system,system-ui,sans-serif;'
  + 'color:var(--text,#dbe6ff);touch-action:manipulation;user-select:none;-webkit-user-select:none;';
function mkBtn(label, title, onClick) {
  const b = document.createElement('button');
  b.innerHTML = label; b.title = title;
  b.style.cssText = 'min-width:34px;height:34px;border:none;border-radius:10px;background:transparent;display:inline-flex;align-items:center;justify-content:center;'
    + 'color:var(--text,#cfe0ff);font-size:15px;cursor:pointer;padding:0 8px;';
  b.addEventListener('click', onClick);
  return b;
}
const rowOf = (...els) => { // 세로 툴바 안의 가로 묶음 (브러시 4종 등)
  const r0 = document.createElement('div');
  r0.style.cssText = 'display:flex;gap:4px;align-items:center;';
  els.forEach(el => { el.style.flex = '1'; r0.appendChild(el); });
  return r0;
};
const grip = document.createElement('span');
grip.textContent = '⠿'; grip.title = '툴바 이동';
grip.style.cssText = 'font-size:15px;color:var(--muted,#6d7ea8);padding:0 2px;';
bar.appendChild(grip);
const toolBtns = {};
toolBtns.pen = mkBtn('<svg class="ic" viewBox="0 0 24 24"><path d="M4 20l1.3-4.2L15.5 5.6a2 2 0 0 1 2.8 0l.1.1a2 2 0 0 1 0 2.8L8.2 18.7z"/><path d="M14 7l3 3"/><path d="M4 20l4-1.3"/></svg>', '펜 (B) — 또렷한 잉크', () => setBrush('pen'));
toolBtns.pencil = mkBtn('<svg class="ic" viewBox="0 0 24 24"><path d="M4 20l4-1 9.5-9.5-3-3L5 16z"/><path d="M13.5 6.5l3 3"/><path d="M4 20l3.8-.8"/></svg>', '연필 — 가늘고 연하게', () => setBrush('pencil'));
toolBtns.marker = mkBtn('<svg class="ic" viewBox="0 0 24 24"><path d="M9 15l7-7 3.5 3.5-7 7H9z"/><path d="M9 15l-1.5 4.5L12 18"/><path d="M6.5 21h6"/></svg>', '마커 — 굵고 반투명', () => setBrush('marker'));
toolBtns.eraser = mkBtn('<svg class="ic" viewBox="0 0 24 24"><path d="M8 18l-3.2-3.2a2 2 0 0 1 0-2.8l7-7a2 2 0 0 1 2.8 0l3.4 3.4a2 2 0 0 1 0 2.8L14 18z"/><path d="M8.5 11.5l4.6 4.6"/><path d="M8 18h11"/></svg>', '지우개 — 스트로크 단위 (E)', () => setTool('eraser'));
bar.appendChild(rowOf(toolBtns.pen, toolBtns.pencil, toolBtns.marker, toolBtns.eraser));
// 레이어 — CAD 레이어와 동일 연동 (평면·3D·스케치가 같은 레이어·같은 색)
const layWrap = document.createElement('span');
layWrap.style.cssText = 'display:flex;align-items:center;gap:4px;padding:0 4px;';
const layDot = document.createElement('span');
layDot.style.cssText = 'width:12px;height:12px;border-radius:3px;background:#888;flex:0 0 auto;';
const laySel = document.createElement('select');
laySel.title = '스케치 레이어 — CAD 레이어와 연동되어 색이 일치합니다 (레이어별 펜·색 기억)';
laySel.style.cssText = 'background:var(--panel2,#0e1730);color:var(--text,#cfe0ff);border:1px solid var(--line-strong,#2a3760);border-radius:8px;'
  + 'font-size:12px;padding:6px 6px;flex:1;min-width:0;height:34px;';
function refreshLayerSel() {
  const cur = SK.layer || (B.state && B.state.currentLayer) || '';
  laySel.innerHTML = '';
  for (const l of B.state.layers) {
    const o = document.createElement('option');
    o.value = l.name; o.textContent = l.name;
    if (l.name === cur) o.selected = true;
    laySel.appendChild(o);
  }
  SK.layer = cur;
  layDot.style.background = layerColorOf(cur);
}
laySel.addEventListener('change', () => {
  SK.layer = laySel.value;
  const p = skPrefs[SK.layer];
  SK.brush = (p && p.brush) || SK.brush;
  SK.color = (p && p.color) || layerColorOf(SK.layer);   // 기본 = 레이어 색 (일치)
  customC.value = /^#[0-9a-fA-F]{6}$/.test(SK.color) ? SK.color : customC.value;
  layDot.style.background = layerColorOf(SK.layer);
  setTool('pen'); markColor();
});
layWrap.appendChild(layDot); layWrap.appendChild(laySel);
bar.appendChild(layWrap);
// 색
const swBox = document.createElement('span');
swBox.style.cssText = 'display:flex;gap:4px;align-items:center;padding:0 4px;flex-wrap:wrap;';
const swEls = [];
for (const c of SWATCHES) {
  const s = document.createElement('span');
  s.style.cssText = `width:22px;height:22px;border-radius:50%;background:${c};cursor:pointer;`
    + 'border:2px solid transparent;box-sizing:border-box;';
  s.title = c;
  s.addEventListener('click', () => { SK.color = c; setTool('pen'); markColor(); rememberPref(); });
  swBox.appendChild(s); swEls.push([c, s]);
}
const customC = document.createElement('input');
customC.type = 'color'; customC.value = '#e6e1d3'; customC.title = '다른 색';
customC.style.cssText = 'width:26px;height:26px;border:none;background:none;cursor:pointer;padding:0;';
customC.addEventListener('input', () => { SK.color = customC.value; setTool('pen'); markColor(); rememberPref(); });
swBox.appendChild(customC);
bar.appendChild(swBox);
function markColor() {
  for (const [c, el] of swEls) el.style.borderColor = (c.toLowerCase() === SK.color.toLowerCase()) ? 'var(--accent,#0A84FF)' : 'transparent';
}
// 굵기
const sizeWrapEl = document.createElement('span');
sizeWrapEl.style.cssText = 'display:flex;align-items:center;gap:6px;padding:0 4px;';
const sizeDot = document.createElement('span');
sizeDot.style.cssText = 'width:24px;height:24px;display:flex;align-items:center;justify-content:center;';
const sizeDotIn = document.createElement('span');
sizeDotIn.style.cssText = 'border-radius:50%;background:var(--text,#dbe6ff);width:8px;height:8px;';
sizeDot.appendChild(sizeDotIn);
const sizeIn = document.createElement('input');
sizeIn.type = 'range'; sizeIn.min = '1'; sizeIn.max = '24'; sizeIn.step = '0.5'; sizeIn.value = String(SK.sizePx);
sizeIn.title = '굵기';
sizeIn.style.cssText = 'width:90px;accent-color:#5ad1ff;';
sizeIn.addEventListener('input', () => {
  SK.sizePx = +sizeIn.value;
  const d = Math.max(3, Math.min(22, SK.sizePx));
  sizeDotIn.style.width = d + 'px'; sizeDotIn.style.height = d + 'px';
});
sizeWrapEl.appendChild(sizeIn); sizeWrapEl.appendChild(sizeDot);
bar.appendChild(sizeWrapEl);
// 🎯 조준 모드 — 호버 미지원 기기(M1 이하 iPad)의 대체: 대고 움직여도 그려지지 않는다
const aimBtn = mkBtn('<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/><path d="M12 2.5v3.5M12 18v3.5M2.5 12h3.5M18 12h3.5"/><circle cx="12" cy="12" r="1.6"/></svg>', '조준 모드 — 펜을 대고 움직여도 그려지지 않고 위치·스냅점만 표시 (호버 미지원 기기 대체). 다시 누르면 그리기 복귀', () => {
  SK.aim = !SK.aim;
  aimBtn.style.background = SK.aim ? 'var(--accent,#0A84FF)' : 'transparent';
  aimBtn.style.color = SK.aim ? '#fff' : 'var(--ink,#cfe0ff)';
});
// 📐 상시 자동 보정 토글 (기본 켬)
const beautBtn = mkBtn('<svg class="ic" viewBox="0 0 24 24"><path d="M4 20L14 10"/><path d="M16 4l.9 2.1L19 7l-2.1.9L16 10l-.9-2.1L13 7l2.1-.9z"/><path d="M19.5 12.5l.4 1 1 .4-1 .4-.4 1-.4-1-1-.4 1-.4z"/></svg>', '자동 보정 — 직선은 곧게, 곡선은 매끈하게 (손떨림 제거). 끄면 원본 그대로', () => {
  SK.beautify = SK.beautify === false ? true : false;
  beautBtn.style.opacity = SK.beautify === false ? '.35' : '1';
});
// ✨ 인식 — 손그림 → 기하 (전처리 엔진, AI 0)
const recogBtn = mkBtn('<svg class="ic" viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/><circle cx="16" cy="16" r="4.5"/></svg>', '인식 — 손그림을 직선·원·호·사각형과 닫힌 영역으로 (전부 알고리즘, AI 사용 없음)', recognize);
bar.appendChild(rowOf(aimBtn, beautBtn, recogBtn));
// 실행취소/재실행/표시/전체지우기 — 한 줄
const undoBtn = mkBtn('<svg class="ic" viewBox="0 0 24 24"><polyline points="3.5 5.5 3.5 11 9 11"/><path d="M5.8 15.5a8 8 0 1 0 1.7-8.7L3.5 11"/></svg>', '스케치 실행 취소 (Ctrl+Z)', undoSk);
const redoBtn = mkBtn('<svg class="ic" viewBox="0 0 24 24"><polyline points="20.5 5.5 20.5 11 15 11"/><path d="M18.2 15.5a8 8 0 1 1-1.7-8.7L20.5 11"/></svg>', '다시 실행 (Ctrl+Y)', redoSk);
const eyeBtn = mkBtn('<svg class="ic" viewBox="0 0 24 24"><path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/></svg>', 'Sketch Layer 표시/숨김 (CAD 와 항상 공존)', () => {
  SK.visible = !SK.visible; eyeBtn.style.opacity = SK.visible ? '1' : '.35';
});
const clearBtn = mkBtn('<svg class="ic" viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 13a1 1 0 0 0 1 .9h8a1 1 0 0 0 1-.9l1-13"/><path d="M10 11v6M14 11v6"/></svg>', '이 도면의 스케치 전체 지우기', () => {
  if (!SK.strokes.length) return;
  if (!confirm('이 도면의 손그림 스케치를 전부 지울까요? (Ctrl+Z 로 되돌릴 수 있습니다)')) return;
  pushOp({ t: 'del', ss: SK.strokes.slice() });
  SK.strokes = []; changed();
});
// ── 스케치 설정(패스값) 팝업 — 보정·인식 허용치를 슬라이더로 (초보자용) ──
let skpEl = null;
function openSkp() {
  if (!skpEl) {
    skpEl = document.createElement('div');
    skpEl.id = 'skpDlg';
    skpEl.style.cssText = 'position:fixed;left:50%;top:70px;transform:translateX(-50%);z-index:80;display:none;';
    document.body.appendChild(skpEl);
  }
  const row = (id, label, min, max, step, val, tipL, tipR) => `
    <label style="display:flex;flex-direction:column;gap:3px;font-size:11.5px;color:var(--muted,#8b93a5);">
      <span style="display:flex;justify-content:space-between;"><b style="color:var(--text,#e7ecf5);font-weight:600;">${label}</b><span id="${id}V" style="font-variant-numeric:tabular-nums;">${val}</span></span>
      <input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${val}" style="width:100%;accent-color:var(--accent,#0A84FF);">
      <span style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted2,#6b7488);"><span>${tipL}</span><span>${tipR}</span></span>
    </label>`;
  skpEl.innerHTML = `
    <div class="dlgBox" style="width:280px;max-width:92vw;background:var(--panel,#171b25);border:1px solid var(--line,rgba(255,255,255,.08));border-radius:14px;box-shadow:var(--shadow-pop,0 18px 48px rgba(0,0,0,.5));padding:0;overflow:hidden;color:var(--text,#e7ecf5);">
      <div id="skpHead" style="display:flex;align-items:center;gap:9px;padding:13px 15px 9px;cursor:move;">
        <svg class="ic" style="width:16px;height:16px;color:var(--accent-text,#5eb1ff);" viewBox="0 0 24 24"><path d="M5 4v5m0 4.5V20M12 4v9m0 4.5V20M19 4v3m0 4.5V20"/><path d="M2.8 11.5h4.4M9.8 15h4.4M16.8 9.5h4.4"/></svg>
        <span style="font-size:14px;font-weight:650;flex:1;">스케치 설정</span>
        <button id="skpReset" style="background:transparent;border:none;color:var(--muted,#8b93a5);font-size:11.5px;cursor:pointer;padding:4px 8px;border-radius:7px;">기본값</button>
        <button id="skpClose" style="background:transparent;border:none;color:var(--muted,#8b93a5);cursor:pointer;width:26px;height:26px;border-radius:7px;display:inline-flex;align-items:center;justify-content:center;"><svg class="ic" style="width:14px;height:14px;" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
      <div style="display:flex;flex-direction:column;gap:11px;padding:2px 15px 15px;">
        <div id="skpPre" style="display:flex;gap:4px;padding:3px;border-radius:9px;background:var(--panel2,#1d222e);">
          ${Object.entries(SKP_PRESETS).map(([k, p]) => `<button data-pre="${k}" title="${p.tip}"
            style="flex:1;border:none;cursor:pointer;padding:6px 4px;border-radius:7px;font-size:11.5px;font-weight:600;
            background:${skpPresetNow() === k ? 'var(--accent,#0A84FF)' : 'transparent'};
            color:${skpPresetNow() === k ? '#fff' : 'var(--muted,#8b93a5)'};">${p.ko}</button>`).join('')}
        </div>
        ${row('skpFit', '보정 강도', 0.3, 2.5, 0.1, SKP.fitK, '원본 그대로', '강하게 정리')}
        ${row('skpSm', '손떨림 제거', 0, 4, 1, SKP.smooth, '끔', '많이')}
        ${row('skpOr', '수평·수직 정리', 0, 15, 1, SKP.ortho, '끔', '15°까지 반듯하게')}
        ${row('skpSn', '끝점 흡착', 0, 30, 1, SKP.snap, '끔', '30px')}
        ${row('skpCo', '모서리 민감도', 0.35, 1.0, 0.05, SKP.corner, '민감(꺾은선↑)', '둔감(곡선↑)')}
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text,#e7ecf5);cursor:pointer;">
          <input id="skpLive" type="checkbox" ${SKP.live !== 0 ? 'checked' : ''} style="accent-color:var(--accent,#0A84FF);width:14px;height:14px;">
          라이브 인식 미리보기 — 펜을 떼면 유령선 자동 표시</label>
        <div style="font-size:10.5px;line-height:1.55;color:var(--muted2,#6b7488);">변경은 즉시 저장 — 다음 스트로크와 인식(✨)부터 적용됩니다.<br>미리보기의 도형을 <b>탭</b>하면 직선↔호↔꺾은선↔곡선으로 교정할 수 있습니다.</div>
      </div>
    </div>`;
  skpEl.style.display = 'block';
  if (window.webcadPopupDrag) window.webcadPopupDrag(skpEl, skpEl.querySelector('#skpHead'));
  skpEl.querySelector('#skpClose').addEventListener('click', () => { skpEl.style.display = 'none'; });
  skpEl.querySelector('#skpReset').addEventListener('click', () => { SKP = { ...SKP_DEF }; skpSave(); openSkp(); });
  const refreshPre = () => {   // 슬라이더 수동 조정 시 프리셋 하이라이트 동기
    const now = skpPresetNow();
    skpEl.querySelectorAll('[data-pre]').forEach(b2 => {
      const on = b2.dataset.pre === now;
      b2.style.background = on ? 'var(--accent,#0A84FF)' : 'transparent';
      b2.style.color = on ? '#fff' : 'var(--muted,#8b93a5)';
    });
  };
  const wireS = (id, key, fmt) => {
    const el = skpEl.querySelector('#' + id);
    el.addEventListener('input', () => {
      SKP[key] = parseFloat(el.value); skpSave();
      skpEl.querySelector('#' + id + 'V').textContent = fmt ? fmt(SKP[key]) : SKP[key];
      refreshPre();
    });
  };
  wireS('skpFit', 'fitK'); wireS('skpSm', 'smooth'); wireS('skpOr', 'ortho'); wireS('skpSn', 'snap'); wireS('skpCo', 'corner');
  skpEl.querySelector('#skpLive').addEventListener('change', (e) => {
    SKP.live = e.target.checked ? 1 : 0; skpSave();
    if (SKP.live && SK.strokes.length) schedulePreview(); else if (!SKP.live) { closePreview(); redraw(); }
  });
  // S2 프리셋 — 원탭으로 5개 패스값 일괄 적용 (팝업 재렌더로 슬라이더·하이라이트 동기)
  skpEl.querySelectorAll('[data-pre]').forEach(b2 => b2.addEventListener('click', () => {
    Object.assign(SKP, SKP_PRESETS[b2.dataset.pre].v); skpSave(); openSkp();
    if (SKP.live !== 0 && SK.strokes.length) schedulePreview();   // 라이브 미리보기도 새 값으로
  }));
}
const skpBtn = mkBtn('<svg class="ic" viewBox="0 0 24 24"><path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h10M18 18h2"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="18" r="2"/></svg>',
  '스케치 설정 — 보정 강도·손떨림 제거·수평수직 정리·끝점 흡착·모서리 민감도 (패스값 조정)', openSkp);
bar.appendChild(rowOf(undoBtn, redoBtn, eyeBtn, clearBtn));
bar.appendChild(rowOf(skpBtn));
const doneBtn = mkBtn('완료', '스케치 모드 종료 (Esc) — 스케치는 화면에 남습니다', exit);
doneBtn.style.cssText += 'font-size:13px;font-weight:700;background:var(--glass-fill-hi,rgba(120,140,200,.15));';
bar.appendChild(doneBtn);
wrap.appendChild(bar);
if (window.webcadPopupDrag) window.webcadPopupDrag(bar, grip);
// ✨ 인식 결과 칩 — 미리보기 상태에서 [CAD 만들기 / 닫기]
const infoEl = document.createElement('div');
infoEl.id = 'skInfo';
infoEl.style.cssText = 'position:absolute;left:50%;top:64px;transform:translateX(-50%);z-index:30;'
  + 'display:none;align-items:center;gap:8px;padding:6px 12px;border-radius:12px;'
  + 'background:var(--glass-pop,#171b25);border:1px solid var(--line-strong,rgba(53,208,255,.5));'
  + 'font:12.5px -apple-system,system-ui,sans-serif;color:var(--text,#bfeaff);box-shadow:var(--shadow-pop,0 6px 20px rgba(0,0,0,.4));';
const infoTxt = document.createElement('span');
infoEl.appendChild(infoTxt);
const infoBim = document.createElement('button');
infoBim.textContent = '🏠 건물로';
infoBim.title = '역할 판정(벽·문·기둥·가구) 후 BIM 생성 — API 키가 있으면 AI 가 요약만 보고 판단(이미지 전송 없음), 없으면 규칙 판단';
infoBim.style.cssText = 'height:30px;border:none;border-radius:8px;background:#3aa66a;color:#06331c;'
  + 'font-weight:700;font-size:12.5px;cursor:pointer;padding:0 12px;';
infoBim.addEventListener('click', buildBuilding);
infoEl.appendChild(infoBim);
const infoOk = document.createElement('button');
infoOk.textContent = 'CAD 선만';
infoOk.title = '역할 판정 없이 인식된 기하만 CAD 개체로';
infoOk.style.cssText = 'height:30px;border:none;border-radius:8px;background:#35d0ff;color:#06233a;'
  + 'font-weight:700;font-size:12.5px;cursor:pointer;padding:0 12px;';
infoOk.addEventListener('click', commitRecog);
infoEl.appendChild(infoOk);
const infoX = document.createElement('button');
infoX.textContent = '닫기';
infoX.style.cssText = 'height:30px;border:1px solid rgba(53,208,255,.4);border-radius:8px;background:transparent;'
  + 'color:#bfeaff;font-size:12.5px;cursor:pointer;padding:0 10px;';
infoX.addEventListener('click', closePreview);
infoEl.appendChild(infoX);
wrap.appendChild(infoEl);
setTool('pen'); markColor();

// 진입 버튼 — 하단 탭 라인(팝업창 줄)의 '맨 왼쪽' 탭 (2026-07-20 — 상단바에서 이동)
const entryBtn = document.createElement('button');
entryBtn.className = 'modTab'; entryBtn.id = 'btnSketch'; entryBtn.type = 'button';
entryBtn.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><path d="M17 3.5a2.6 2.6 0 0 1 3.7 3.7L8.2 19.7 3.3 20.9l1.2-4.9z"/><path d="M15 5.5l3.7 3.7"/></svg><span class="tl">스케치</span>';
entryBtn.title = '스케치 모드 — Apple Pencil/펜으로 생각을 그린다 (손그림은 CAD 와 별도 레이어로 보존)';
entryBtn.addEventListener('click', () => { SK.on ? exit() : enter(); });
{
  const dtBar = document.getElementById('docTabs');
  if (dtBar) {
    dtBar.insertBefore(entryBtn, dtBar.firstChild);
    window.__skTabBtn = entryBtn;
    if (window.__syncBottomTabs) window.__syncBottomTabs();
  } else document.getElementById('topbar') && document.getElementById('topbar').appendChild(entryBtn); // 폴백
}

// ---------- 시작 ----------
SK.docKey = 'webcad_sketch::' + ((B.getDocName && B.getDocName()) || '무제');
loadNow();
requestAnimationFrame(tick);

// 외부/테스트 훅 — Phase 2 전처리 엔진이 이 데이터를 읽는다
window.WEBCAD_SKETCH = { SK, enter, exit, setTool, undoSk, redoSk, redraw, syncNow, saveNow, loadNow, w2s, s2w,
  recognize, commitRecog, closePreview, getPreview: () => preview, buildBuilding, fitView, importStrokes,
  cycleFit, hitPreviewShape, applyFitOv,   // S3 즉석 교정 (테스트 훅 포함)
  // A2: AI 코워커가 패스값을 대신 조정 ("선이 자꾸 곡선으로 인식돼" → 봇이 도구 호출)
  getParams: () => ({ ...SKP }),
  setParams: (patch) => {
    if (patch && patch.preset && SKP_PRESETS[patch.preset]) Object.assign(SKP, SKP_PRESETS[patch.preset].v);
    for (const k2 of ['fitK', 'smooth', 'ortho', 'snap', 'corner', 'live'])
      if (patch && patch[k2] != null && isFinite(patch[k2])) SKP[k2] = +patch[k2];
    SKP.fitK = Math.min(2.5, Math.max(0.3, SKP.fitK));
    SKP.smooth = Math.round(Math.min(4, Math.max(0, SKP.smooth)));
    SKP.ortho = Math.min(15, Math.max(0, SKP.ortho));
    SKP.snap = Math.min(30, Math.max(0, SKP.snap));
    SKP.corner = Math.min(1, Math.max(0.35, SKP.corner));
    skpSave();
    if (SKP.live !== 0 && SK.strokes.length) schedulePreview();   // 새 값으로 즉시 재인식
    return { ...SKP };
  },
  // A1: AI 코워커용 구조 요약 — 이미지가 아니라 인식 결과(철학)를 한 줄로
  summaryCtx: () => {
    if (!SK.strokes.length) return null;
    let anal = preview;
    try { if (!anal) anal = applyFitOv(window.WEBCAD_PREP.analyze(SK.strokes, skpOpts())); } catch (e) { return null; }
    if (!anal) return null;
    const KO = { line: '선', polyline: '꺾은선', curve: '곡선', rect: '사각', polygon: '다각형', circle: '원', arc: '호', dot: '점' };
    const parts = Object.entries(anal.counts || {}).map(([k, n]) => (KO[k] || k) + n);
    const regs = (anal.regions || []).filter(r => r.areaMM2 > 1e4);
    const rTxt = regs.length ? ' — 닫힌 영역 ' + regs.length + '개(' + regs.slice(0, 3).map(r => fmtArea(r.areaMM2)).join(', ') + (regs.length > 3 ? ' 외' : '') + ')' : '';
    return '스케치 인식: ' + (parts.join('·') || '없음') + rTxt + ' · 스트로크 ' + SK.strokes.length + '개' + (Object.keys(SK.fitOv || {}).length ? ' · 수동교정 ' + Object.keys(SK.fitOv).length : '');
  } };
})();
