/* ============================================================
   Parti — 브라우저 기반 2D CAD / DXF 편집기
   순수 JavaScript. 외부 의존성 없음.
   좌표계: 월드 좌표는 DXF 규약(Y 위쪽). 화면은 Y 아래쪽 → 변환 처리.
   ============================================================ */

(() => {
'use strict';

// ---------- DOM ----------
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const wrap = document.getElementById('canvasWrap');
const coordsEl = document.getElementById('coords');
const hintEl = document.getElementById('hint');
const statEl = document.getElementById('stat');

// ---------- 상태 ----------
const state = {
  entities: [],          // {id,type,layer,color, ...geom}  · 광원이면 lightId 참조를 가진다
  lights: [],            // LightSource[] — 개체와 분리된 광원 속성 컬렉션 (objectId로 연결)
  nextLightId: 1,
  sensors: [],           // 조도 측정면 (격자 측정점) — Phase 4
  nextSensorId: 1,
  sun: null,             // 태양 — sunDefaults() 로 초기화. 건축에서 빛의 주인공.
  layers: [],            // {name,color,visible}
  currentLayer: '0',
  currentColor: null,    // null = 레이어색(ByLayer), 아니면 '#rrggbb'
  tool: 'select',
  view: { x: 0, y: 0, scale: 1 },   // x,y = 화면 중앙이 가리키는 월드좌표
  levels: [{ name: '1F', elev: 0 }], // 층 목록 (BIM 다층)
  curLv: 0,                          // 현재 작업 층
  ghostLv: true,                     // 다른 층을 흐리게 표시(참조용)
  grid: { show: true, size: 10 },
  ortho: false,          // 직교 모드(F8): 기준점 대비 수평/수직 고정
  selection: new Set(),
  textHeight: 10,
  nextId: 1,
  matlib: {},            // 재질 라이브러리: 이름 -> {name,base,color,scale,rough,metal,img} — 도면에 저장된다
  owlib: {},             // 커스텀 창호 기호: 이름 -> {plan:[ents], elev:[ents], elevH, solid:[ents]} — 도면에 저장된다
  blocks: {},            // 블록 정의: name -> { entities:[...상대좌표 도형] }
  views: {},             // 저장된 뷰: name -> {x,y,scale}
};

// 작도 중 임시 상태
let draft = null;       // 현재 그리는 중인 도형
let pts = [];           // 폴리라인 등 다중 클릭 점
let mouseWorld = { x: 0, y: 0 };
let mouseScreen = { x: 0, y: 0 };
let isPanning = false, panStart = null;
let dragSelect = null;  // 영역 선택 박스
let toolPend = null;    // 도구 활성 중 좌클릭 보류 — 클릭(제자리)=도구 동작, 홀드-드래그=박스 선택 (선택은 어떤 상황에서도 가능)
let moveOp = null;      // 이동 작업
let cmdOp = null;       // 수정 명령(offset/copy/mirror/rotate/array) 상태 머신
let previewEnts = null; // 명령 실행 전 미리보기 도형들
let offsetDist = 10;    // 마지막 사용 오프셋 거리
let filletRadius = 0;   // 모깎기 반지름
let chamferDist = 10;   // 모따기 거리
let polygonSides = 6;   // 다각형 변 개수
let lengthenDelta = 10; // 길이조정 증감량(±)
let hatchSpacing = 5;   // 해치 간격
// ---------- 사용자 설정 (단위·객체스냅·단축키) — localStorage 유지 ----------
const SETTINGS_KEY = 'webcad_settings_v1';
let settings = {
  units: 'mm',
  osnapModes: { endpoint: true, midpoint: true, center: true, quad: true, perp: true, nearest: true, intersection: true, tangent: true, surface: true },
  polar: 0,      // 폴라 트래킹 각도(0=끄기, 15/30/45/90)
  dim: { txt: 0, dec: 2, suffix: false }, // 치수: 문자높이(0=그리기설정 따름)·소수자릿수·단위표시
  bim: { wallH: 2700, wallT: 200, slabT: 150, colH: 2700, doorW: 900, doorH: 2100, winW: 1500, winH: 1200, winSill: 900, roofRise: 1200, stairW: 1200, stairRiser: 180, railH: 1100, railSpacing: 1200, lightH: 1000, lightSpacing: 3000 }, // BIM 기본값(mm)
  aliases: {},   // 사용자 단축키: { 입력값: 도구명 }
};
(function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (s) { settings.units = s.units || 'mm'; Object.assign(settings.osnapModes, s.osnapModes || {}); settings.polar = s.polar || 0; settings.aliases = s.aliases || {}; Object.assign(settings.dim, s.dim || {}); Object.assign(settings.bim, s.bim || {}); }
  } catch (e) {}
})();
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
  if (window.WEBCAD_API && WEBCAD_API.onSettingsChange) WEBCAD_API.onSettingsChange(); // 클라우드 동기화 훅
}

let currentFileName = null; // 현재 작업 파일명 (null = 새 파일)
let currentFileLoc = null;  // 'pc'(실제 파일 핸들) | 'download' | null
let fileHandle = null;      // File System Access API 핸들 (크롬/엣지 — 같은 파일에 덮어쓰기 저장)
function setFileName(n, loc) {
  currentFileName = n || null;
  if (loc !== undefined) currentFileLoc = currentFileName ? loc : null;
  const el = document.getElementById('fileName');
  if (el) el.innerHTML = escapeHtml(currentFileName || '새 파일') +
    (currentFileName && currentFileLoc
      ? `<span class="floc">${currentFileLoc === 'pc' ? '— 내 PC (저장 시 덮어쓰기)' : '— 다운로드/파일 앱'}</span>` : '');
  document.title = (currentFileName ? currentFileName + ' — ' : '') + 'Parti — DXF 편집기';
  if (typeof renderDocTabs === 'function' && typeof docs !== 'undefined' && docs.length) renderDocTabs();
}
let lastCommand = '';   // 직전에 실행한 명령(스페이스/Enter로 반복)
let lastInputWasTouch = false; // 터치 입력 중에는 명령행 자동 포커스(키보드 팝업) 억제
let osnapEnabled = true;   // 객체 스냅(OSNAP) 사용 여부
let activeSnap = null;     // 현재 스냅된 점 {x,y,type}
let trackPt = null;        // 스냅 추적 기준점(마지막 획득 스냅)
let otrackAlign = null;    // 'x' | 'y' | 'xy' — 추적 정렬 활성

// ---------- 실행취소 스택 ----------
const undoStack = [], redoStack = [];
// 노드 에디터 라이브 프리뷰(_gh) 개체는 영구 저장·실행취소 대상에서 제외 (베이크해야 진짜 개체가 됨)
function liveEnts() { return state.entities.filter(e => !e._gh); }
function snapshot() {
  return JSON.stringify({
    entities: liveEnts(), layers: state.layers,
    currentLayer: state.currentLayer, nextId: state.nextId, blocks: state.blocks,
    lights: state.lights, nextLightId: state.nextLightId, // 광원 지정/해제도 undo 대상
    sensors: state.sensors, nextSensorId: state.nextSensorId,
    sun: state.sun,          // 태양 설정도 undo 대상
    matlib: state.matlib,    // 재질 라이브러리도 undo 대상 (저장/삭제를 되돌릴 수 있어야)
    owlib: state.owlib,      // 커스텀 창호 기호도 undo 대상
  });
}
let apiRev = 0; // 변경 카운터 (클라우드 자동저장의 dirty 판단용)
// 편집 커밋 알림 — 실시간 동기(cloud.js)가 폴링 없이 '변경 즉시' 방송하도록 훅 제공
function bumpRev() { apiRev++; if (window.WEBCAD_API && WEBCAD_API.onEdit) { try { WEBCAD_API.onEdit(); } catch (e) {} } }
function pushUndo() { undoStack.push(snapshot()); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; bumpRev(); if (typeof autosave === 'function') autosave(); }
function restore(snap) {
  bumpRev(); // undo/redo도 모델 변경으로 집계 (3D 라이브 갱신·클라우드 미저장 표시)
  const d = JSON.parse(snap);
  state.entities = d.entities; state.layers = d.layers;
  state.currentLayer = d.currentLayer; state.nextId = d.nextId; state.blocks = d.blocks || {};
  state.matlib = d.matlib || {};   // undo/redo 도 라이브러리를 되돌린다
  state.owlib = d.owlib || {};
  state.lights = d.lights || []; state.nextLightId = d.nextLightId || 1;
  state.sensors = d.sensors || []; state.nextSensorId = d.nextSensorId || 1;
  state.sun = d.sun || null;
  state.selection.clear();
  renderLayers(); renderLightList(); renderSensorList(); renderSunPanel();
  if (typeof refreshBlockList === 'function') refreshBlockList(); draw(); updateStat();
  if (typeof autosave === 'function') autosave();
}
function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); }

// ---------- 좌표 변환 ----------
function resize() {
  // #cv 는 '평면 뷰포트'의 캔버스다. 4분할이면 그 칸 크기, 아니면 화면 전체.
  // worldToScreen 이 cv._w/2 를 중심으로 쓰므로, 크기만 맞춰주면 draw() 는 그대로 그 칸에 그린다.
  const r = (typeof planCvRect === 'function' && typeof v3 !== 'undefined' && v3)
    ? planCvRect() : (() => { const b = wrap.getBoundingClientRect(); return { x: 0, y: 0, w: b.width, h: b.height }; })();
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(2, r.w * dpr); cv.height = Math.max(2, r.h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cv._w = r.w; cv._h = r.h;
  draw();
}
// 평면 칸 위에 #cv 를 올려놓는다 (3D 오버레이 z-index 18 위). 평면 칸이 없으면 숨긴다.
// 마우스 이벤트가 자동으로 갈라지는 게 핵심 — 평면 칸 클릭은 2D 핸들러가, 나머지는 3D 핸들러가 받는다.
function syncPlanCv() {
  const i = vpPlanIndex();
  if (!is3DActive()) { // 3D 미개방 = 오늘과 동일하게 #cv 가 화면 전체
    cv.style.position = ''; cv.style.left = cv.style.top = cv.style.width = cv.style.height = '';
    cv.style.zIndex = ''; cv.style.display = ''; cv.style.outline = '';
    for (let k = 0; k < 4; k++) vpHideLabel(k);
    return;
  }
  if (i < 0) { cv.style.display = 'none'; return; } // 평면 칸이 안 떠 있음 → 3D 가 화면 전체
  const r = vpRectCss(i);
  cv.style.display = ''; cv.style.position = 'absolute'; cv.style.zIndex = '19';
  cv.style.left = r.x + 'px'; cv.style.top = r.y + 'px';
  cv.style.width = r.w + 'px'; cv.style.height = r.h + 'px';
  const dpr = window.devicePixelRatio || 1;
  const nw = Math.max(2, Math.round(r.w * dpr)), nh = Math.max(2, Math.round(r.h * dpr));
  if (cv.width !== nw || cv.height !== nh) { // 크기가 바뀔 때만 리사이즈 (캔버스 리사이즈는 내용을 지운다)
    cv.width = nw; cv.height = nh;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  cv._w = r.w; cv._h = r.h;
  vpShowLabel(i, cv);   // 이름표·테두리는 DOM 으로 (아래 b3cv 에 그려봐야 #cv 가 덮는다)
  draw();
}
// 뷰포트 이름표 (지연 생성) — pointer-events 없음, 표시 전용.
// 다른 캔버스(#cv·#rvcv)가 그 칸을 덮는 경우 b3cv 에 그려봐야 안 보인다 → DOM 으로 올린다.
function vpLabelEl(i) {
  const id = 'vpLabel' + i;
  let el = document.getElementById(id);
  if (!el && typeof wrap !== 'undefined' && wrap) {
    el = document.createElement('div');
    el.id = id;
    // pointer-events:auto — 이름표는 클릭을 받는다(나머지 캔버스는 궤도·작도가 그대로 동작).
    // 각 칸의 '중앙 상단'에 놓는다 — 좌우 패널이 펼쳐져도 가려지지 않는 자리 (2026-07-20)
    el.style.cssText = 'position:absolute;z-index:20;font:600 12px -apple-system,system-ui,sans-serif;'
      + 'cursor:pointer;user-select:none;display:none;padding:1px 5px;border-radius:5px;white-space:nowrap;'
      + 'transform:translateX(-50%);';
    el.title = '클릭: 이 뷰를 활성화(입면은 방향 순환) · 우클릭: 표시 모드 선택';
    // 좌클릭 — 이 뷰포트를 활성으로. 입면이면 방향을 순환(예전 캔버스 히트가 하던 일).
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const vi = el._vi; if (vi == null || !v3) return;
      if (v3.act !== vi) { saveVp(); v3.act = vi; loadVp(vi); saveV3Layout(); render3D(); }
      const w = v3.views[vi];
      if (w && (w.name in ELEV_YAW)) cycleElev(vi);
    });
    // 더블클릭 — 이 뷰를 메인으로 확대 ↔ 4분할 복귀 (라이노 뷰 제목 더블클릭과 동일)
    el.addEventListener('dblclick', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const vi = el._vi; if (vi == null || !v3) return;
      if (v3.act !== vi) { saveVp(); v3.act = vi; loadVp(vi); }
      v3.quad = !v3.quad;
      render3D(); saveV3Layout();
    });
    // 우클릭 — 이름표 밑에 표시 모드 선택창
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      if (el._vi != null) vpModeMenu(el._vi, el);
    });
    wrap.appendChild(el);
  }
  return el;
}
// ── 뷰포트 표시 모드 메뉴 ───────────────────────────────
// 우클릭한 뷰포트 이름 밑에 뜨는 선택창. 작업 표시 / 렌더링 뷰 / 레이트레이싱.
// 렌더링 뷰·레이트레이싱은 이미 뷰포트에 묶여 있으므로(rview.vi / rt.vi) 같은 메뉴에서 고른다.
let _vpMenuEl = null;
function closeVpMenu() { if (_vpMenuEl) { _vpMenuEl.remove(); _vpMenuEl = null; } }
function vpModeMenu(i, labelEl) {
  closeVpMenu();
  const host = document.getElementById('canvasWrap'); if (!host) return;
  const cur = vpIsRt(i) ? 'raytrace' : (vpIsRendered(i) ? 'rendered' : 'work');
  // 평면 칸도 렌더링/레이트레이싱 선택 가능 (2026-07-20) — 위에서 내려다보는 유일한 화면이라
  // 재질·조명이 입혀진 상태를 볼 수단이 여기뿐이다. 선택 시 그 칸만 '3D 톱뷰(수직·회전 잠금)'로
  // 전환해 3D 파이프라인이 그리고, '작업 표시'로 고르면 2D 평면 도면으로 복귀한다.
  const items = [['work', '작업 표시'], ['rendered', '렌더링 뷰'], ['raytrace', '레이트레이싱']];
  const m = document.createElement('div');
  m.id = 'vpModeMenu';
  m.style.cssText = 'position:absolute;z-index:40;background:var(--panel,#161b28);'
    + 'border:1px solid var(--line,rgba(120,140,180,.3));border-radius:9px;padding:4px;'
    + 'box-shadow:0 8px 24px rgba(0,0,0,.45);font:13px -apple-system,system-ui,sans-serif;min-width:132px;';
  m.innerHTML = items.map(([k, label]) =>
    `<div data-mode="${k}" style="padding:6px 11px;border-radius:6px;cursor:pointer;white-space:nowrap;`
    + `color:${cur === k ? '#0A84FF' : 'var(--ink,#cfe0ff)'};">${cur === k ? '● ' : '○ '}${label}</div>`).join('');
  const lr = labelEl.getBoundingClientRect(), hr = host.getBoundingClientRect();
  m.style.left = (lr.left - hr.left) + 'px';
  m.style.top = (lr.bottom - hr.top + 3) + 'px';
  host.appendChild(m);
  _vpMenuEl = m;
  for (const it of m.querySelectorAll('[data-mode]')) {
    it.addEventListener('mouseenter', () => { it.style.background = 'rgba(120,140,180,.16)'; });
    it.addEventListener('mouseleave', () => { it.style.background = ''; });
    it.addEventListener('click', () => { const mode = it.dataset.mode; closeVpMenu(); vpSetMode(i, mode); });
  }
}
// 뷰포트 i 를 원하는 표시 모드로. rview·rt 는 한 번에 한 칸만(둘 다 무겁다) → 다른 칸/다른 모드는 끈다.
async function vpSetMode(i, mode) {
  if (!v3) return;
  if (vpIsPlan(i)) {
    if (mode === 'work') return; // 이미 도면 표시
    // 평면 칸 → 렌더/RT 동안만 3D '톱뷰'(위에서 수직, 회전 잠금)로 전환. 평면을 3D로
    // 재구현하는 게 아니라 표시 모드 동안 3D 파이프라인에 맡기는 것 — '작업 표시'가 원복한다.
    const w = v3.views[i];
    w._planCell = true; w.mode = 'top';
    w.yaw = 0; w.pitch = Math.PI / 2;
  }
  // 메뉴를 연 칸을 활성으로 (라이노: 뷰 이름을 누르면 그 뷰가 활성이 된다). cmdRendered/rtEnter 가 v3.act 를 본다.
  if (v3.act !== i) { saveVp(); v3.act = i; loadVp(i); saveV3Layout(); }
  { // '작업 표시' 복귀: 렌더/RT 용으로 톱뷰가 된 평면 칸을 2D 도면으로 되돌린다
    const w = v3.views[i];
    if (mode === 'work' && w && w._planCell) { w.mode = 'plan'; delete w._planCell; }
  }
  const wantR = mode === 'rendered', wantT = mode === 'raytrace';
  // 원치 않거나 다른 칸에 걸린 모드를 끈다 (cmdRendered/rtExit 는 토글이라 이렇게 조합한다)
  if (rt.on && !(wantT && rt.vi === i)) rtExit();
  if (rview.on && !(wantR && rview.vi === i)) await cmdRendered();
  // 원하는 모드를 켠다 (v3.act === i 이므로 이 칸에 붙는다)
  if (wantR && !(rview.on && rview.vi === i)) await cmdRendered();
  if (wantT && !(rt.on && rt.vi === i)) await rtEnter();
  render3D();
}
function vpHideLabel(i) { const el = document.getElementById('vpLabel' + i); if (el) el.style.display = 'none'; }
// 덮는 캔버스(cover) 위에 이름표 + 활성 테두리를 그린다 — 다른 칸과 같은 문법으로 보이게
function vpShowLabel(i, cover) {
  const el = vpLabelEl(i); if (!el) return;
  const r = vpRectCss(i), active = v3.act === i, w = v3.views[i];
  el._vi = i;
  const modeTag = vpIsRt(i) ? ' · 레이트레이싱' : (vpIsRendered(i) ? ' · 렌더링' : '');
  el.textContent = w.name + ((w.name in ELEV_YAW) ? ' ▾' : '') + modeTag;
  el.style.display = '';
  el.style.left = (r.x + r.w / 2) + 'px'; el.style.top = (r.y + 3) + 'px';   // 칸 중앙 상단
  el.style.color = active ? '#0A84FF' : (getCSS('--muted') || '#8a93a6');
  el.style.background = active ? 'rgba(10,132,255,.10)' : 'transparent';
  if (cover) {
    cover.style.outline = v3.quad ? (active ? '1.5px solid #0A84FF' : '1px solid rgba(120,140,180,.3)') : '';
    cover.style.outlineOffset = '-1px';
  }
}
// 이 뷰포트가 렌더링 뷰에 덮여 있나
const vpIsRendered = (i) => !!(typeof rview !== 'undefined' && rview && rview.on && rview.vi === i);
function worldToScreen(wx, wy) {
  return {
    x: (wx - state.view.x) * state.view.scale + cv._w / 2,
    y: -(wy - state.view.y) * state.view.scale + cv._h / 2,
  };
}
function screenToWorld(sx, sy) {
  return {
    x: (sx - cv._w / 2) / state.view.scale + state.view.x,
    y: -(sy - cv._h / 2) / state.view.scale + state.view.y,
  };
}

// ---------- 스냅 ----------
// 직교(Ortho) 모드 — 현재 작업의 기준점 대비 수평/수직으로 고정
function orthoBase() {
  if (pts.length) return pts[pts.length - 1];                       // 폴리라인: 직전 점
  if (draft && state.tool === 'line') return { x: draft.x1, y: draft.y1 }; // 선: 시작점
  if (moveOp) return moveOp.base;                                   // 이동/복사
  if (cmdOp && cmdOp.base) return cmdOp.base;                       // 수정 명령(복사 등)
  return null;
}
function applyOrtho(p, b) {
  const dx = p.x - b.x, dy = p.y - b.y;
  return Math.abs(dx) >= Math.abs(dy) ? { x: p.x, y: b.y } : { x: b.x, y: p.y };
}
// 커서 월드좌표 = 객체 스냅(OSNAP) 우선 → 없으면 그리드 스냅 + 직교 보정
function cursorPoint(raw) {
  activeSnap = findObjectSnap(raw);
  if (activeSnap) { trackPt = { x: activeSnap.x, y: activeSnap.y }; otrackAlign = null; return { x: activeSnap.x, y: activeSnap.y }; }
  // 객체 스냅 추적: 마지막 스냅점의 수평/수직선에 커서 정렬
  otrackAlign = null;
  if (osnapEnabled && trackPt) {
    const tolW = 8 / state.view.scale;
    const ax = Math.abs(raw.x - trackPt.x) <= tolW, ay = Math.abs(raw.y - trackPt.y) <= tolW;
    if (ax && ay) { otrackAlign = 'xy'; return { x: trackPt.x, y: trackPt.y }; }
    if (ax) { otrackAlign = 'x'; return { x: trackPt.x, y: raw.y }; }
    if (ay) { otrackAlign = 'y'; return { x: raw.x, y: trackPt.y }; }
  }
  let p = { x: raw.x, y: raw.y };
  const b = orthoBase();
  if (b) {
    if (state.ortho) p = applyOrtho(p, b);
    else if (settings.polar > 0) { // 폴라 트래킹: 기준점 대비 각도를 설정 단위로 스냅
      const dx = p.x - b.x, dy = p.y - b.y, d = Math.hypot(dx, dy);
      if (d > 1e-9) {
        const step = settings.polar * Math.PI / 180;
        const a = Math.round(Math.atan2(dy, dx) / step) * step;
        p = { x: b.x + d * Math.cos(a), y: b.y + d * Math.sin(a) };
      }
    }
  }
  return p;
}
function toggleOrtho() {
  state.ortho = !state.ortho;
  const b = document.getElementById('btnOrtho');
  if (b) b.classList.toggle('active', state.ortho);
  if (typeof hint === 'function') hint(state.ortho ? '직교 모드 ON — 수평·수직 고정 (F8)' : '직교 모드 OFF (F8)');
  draw();
}
function toggleOsnap() {
  osnapEnabled = !osnapEnabled;
  if (!osnapEnabled) activeSnap = null;
  const b = document.getElementById('btnOsnap');
  if (b) b.classList.toggle('active', osnapEnabled);
  if (typeof hint === 'function') hint(osnapEnabled ? '객체 스냅 ON — 끝점·중점·중심·근처 (F3)' : '객체 스냅 OFF (F3)');
  draw();
}

// ---------- 레이어 ----------
function getLayer(name) { return state.layers.find(l => l.name === name); }
function ensureLayer(name, color) {
  let l = getLayer(name);
  if (!l) { l = { name, color: color || '#ffffff', visible: true }; state.layers.push(l); }
  return l;
}
// 선택한 색 = 그려지는 색 (WYSIWYG). 배경과 겹쳐 아예 안 보이는 극단만 CAD 관례대로 자동 반전:
// 화이트 테마의 거의 흰색(L>=0.93) → 어두운 잉크, 다크 테마의 거의 검정(L<=0.06) → 밝은 잉크.
// 그 외 모든 색(밝은 노랑·하늘색 포함)은 변형 없이 그대로 그린다. (DXF 저장은 항상 원본 색)
function themedInk(c) {
  if (!/^#[0-9a-fA-F]{6}$/.test(c)) return c;
  const r = parseInt(c.slice(1, 3), 16) / 255, g = parseInt(c.slice(3, 5), 16) / 255, b = parseInt(c.slice(5, 7), 16) / 255;
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const light = document.documentElement.classList.contains('light');
  if (light && L >= 0.93) return '#1a1d29';
  if (!light && L <= 0.06) return '#e6e9f2';
  return c;
}
function entityColor(e) {
  const raw = e.color || ((getLayer(e.layer) || {}).color) || '#ffffff';
  return themedInk(raw);
}
// 선종류: 이름 → 월드 단위 dash 패턴. 화면 스케일 반영해 픽셀 배열 반환(null=실선)
const LINETYPES = {
  continuous: null,
  dashed: [6, 3], hidden: [4, 3], center: [12, 3, 3, 3], phantom: [16, 3, 3, 3, 3, 3], dot: [1, 3],
};
const LINETYPE_KO = { continuous: '실선', dashed: '파선', hidden: '숨은선', center: '중심선(일점쇄선)', phantom: '가상선(이점쇄선)', dot: '점선' };
function entityLineType(e) {
  const lt = e.linetype || (getLayer(e.layer) || {}).linetype || 'continuous';
  return LINETYPES[lt] === undefined ? 'continuous' : lt;
}
function entityDash(e) {
  const pat = LINETYPES[entityLineType(e)];
  if (!pat) return null;
  const s = state.view.scale, ltscale = state.ltscale || 1;
  return pat.map(v => Math.max(0.5, v * ltscale * s * 0.5));
}
function entityLineWeight(e) {
  const lw = (e.lineweight != null) ? e.lineweight : ((getLayer(e.layer) || {}).lineweight);
  if (lw == null || lw < 0) return 1.4;          // 기본
  return Math.max(0.5, lw / 100 * state.view.scale * 3.5); // mm → 화면 픽셀(대략)
}

// ---------- 도형 생성 ----------
// ─── 레이어 역할 라이브 반영 — 역할 레이어에 그리는 순간 BIM(벽/기둥/슬래브/문/창) 자동 부여 ───
// "선을 그리면 모델링이 레이어 설정대로 생성돼야 한다" (2026-07-25 요청).
// bim.auto=1 로 표시 — 사용자가 wall 명령 등으로 직접 지정한 BIM 은 절대 덮지 않는다.
function layerAutoBim(e, ly) {
  if (!ly || !ly.role || (e.bim && !e.bim.auto)) return false;
  const h = (+ly.defH > 0) ? +ly.defH : ((settings.bim && settings.bim.wallH) || 2400);
  const t = (+ly.defT > 0) ? +ly.defT : ((settings.bim && settings.bim.wallT) || 200);
  const closed = (e.type === 'LWPOLYLINE' && e.closed) || e.type === 'CIRCLE';
  let bim = null;
  if (ly.role === 'wall' && ['LINE', 'LWPOLYLINE', 'CIRCLE', 'ARC'].includes(e.type)) bim = { kind: 'wall', h, t, base: lvElev(), auto: 1 };
  else if (ly.role === 'column' && closed) bim = { kind: 'column', h, base: lvElev(), auto: 1 };
  else if (ly.role === 'slab' && closed) bim = { kind: 'slab', t: (+ly.defT > 0) ? +ly.defT : 150, top: lvElev(), auto: 1 };
  else if ((ly.role === 'door' || ly.role === 'window') && e.type === 'LINE')
    bim = ly.role === 'door' ? { kind: 'opening', ot: 'door', h: Math.min(h, 2100), sill: 0, t, auto: 1 }
                             : { kind: 'opening', ot: 'window', h: 1200, sill: 900, t, auto: 1 };
  if (!bim) return false;
  e.bim = bim; return true;
}
// 레이어 이동·역할 변경 후 자동 BIM 재평가 (수동 지정 BIM 보존, 역할 없어지면 자동 BIM 해제)
function applyLayerRoleTo(en) {
  if (en.bim && !en.bim.auto) return;
  const ly = getLayer(en.layer);
  if (ly && ly.role) { if (!layerAutoBim(en, ly) && en.bim && en.bim.auto) delete en.bim; }
  else if (en.bim && en.bim.auto) delete en.bim;
}
// 자동 BIM 이 생기면 3D 도 곧바로 — 연속 드로잉을 한 번에 묶는 30ms 디바운스
let _abT = null;
function scheduleBimRefresh() {
  if (_abT) return;
  _abT = setTimeout(() => { _abT = null; if (is3DActive() && typeof v3 !== 'undefined' && v3) { v3.solids = bimSolids(); render3D(); } }, 30);
}
function addEntity(e) {
  e.id = state.nextId++;
  e.layer = e.layer || state.currentLayer;
  if (state.currentColor) e.color = state.currentColor;
  e.lv = state.curLv || 0; // 생성 시점의 층에 귀속
  { // 3D 뷰에서 작업면을 올려놓고 그리면 그 높이에 생성 (레이캐스팅 교점의 z)
    const ov3 = typeof v3 !== 'undefined' && v3 && document.getElementById('bim3d');
    if (ov3 && ov3.style.display !== 'none' && v3.cplane != null && Math.abs(v3.cplane - lvElev()) > 0.5 && !e.bim)
      e.zo = v3.cplane - lvElev();
  }
  state.entities.push(e);
  // 레이어 역할 라이브: 역할 레이어면 그리는 순간 BIM 자동 부여 (이미 bim 있으면 유지 — bimify 등)
  if (!e.bim) { const lyA = getLayer(e.layer); if (lyA && lyA.role && layerAutoBim(e, lyA)) scheduleBimRefresh(); }
  return e;
}
// 현재 층 요소인가 (lv 없는 옛 도형 = 1층)
function onLv(e) { return (e.lv || 0) === (state.curLv || 0); }
function lvElev() { return (state.levels[state.curLv] || { elev: 0 }).elev; }

// ============================================================
//  렌더링
// ============================================================
function draw() {
  const W = cv._w, H = cv._h;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = getCSS('--canvas-bg');
  ctx.fillRect(0, 0, W, H);

  if (state.grid.show) drawGrid();
  drawAxes();

  // 뷰포트 컬링: 화면 밖 도형은 그리지 않음 (대형 도면 성능)
  const vtl = screenToWorld(0, 0), vbr = screenToWorld(W, H);
  const vxmin = Math.min(vtl.x, vbr.x), vxmax = Math.max(vtl.x, vbr.x);
  const vymin = Math.min(vtl.y, vbr.y), vymax = Math.max(vtl.y, vbr.y);
  const cull = state.entities.length > 300;
  for (const pass of [0, 1]) // 0: 밑그림 이미지 먼저(항상 바닥), 1: 나머지
  for (const e of state.entities) {
    if ((e.type === 'IMAGE') !== (pass === 0)) continue;
    const l = getLayer(e.layer);
    if (l && !l.visible) continue;
    if (cull) { const bb = entityBBox(e); if (bb && (bb.xmax < vxmin || bb.xmin > vxmax || bb.ymax < vymin || bb.ymin > vymax)) continue; }
    if (!onLv(e)) { // 다른 층: 흐리게(참조) 또는 숨김
      if (state.ghostLv && e.type !== 'IMAGE') { ctx.save(); ctx.globalAlpha = 0.15; drawEntity(e, false); ctx.restore(); }
      continue;
    }
    if (e.type === 'MESH') { drawMeshOverlay(e); continue; } // 메시는 윗면 윤곽만
    if (e.bim && e.bim.kind !== 'opening') drawBimOverlay(e); // 벽 밴드는 도형선 아래
    drawEntity(e, state.selection.has(e.id));
    if (e.bim && e.bim.kind === 'opening') drawBimOverlay(e);  // 개구부는 도형선 위
  }

  // 작도 미리보기
  if (draft) drawEntity(draft, false, true);
  if (pts.length) drawDraftPolyline();
  if (previewEnts) for (const e of previewEnts) drawEntity({ layer: '0', ...e }, false, true);

  // 플롯 영역 지정 미리보기
  if (state.tool === '_plotregion' && cmdOp && cmdOp.name === 'plotrgn') {
    const a = worldToScreen(cmdOp.p1.x, cmdOp.p1.y), b = worldToScreen(mouseWorld.x, mouseWorld.y);
    ctx.save(); ctx.strokeStyle = '#ffd65d'; ctx.fillStyle = 'rgba(255,214,93,.10)'; ctx.lineWidth = 1; ctx.setLineDash([6, 4]);
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y); ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); ctx.restore();
  }

  // STRETCH 걸침 영역 박스
  if (cmdOp && cmdOp.name === 'stretch' && (cmdOp.step === 'c2' || cmdOp.box)) {
    const c1 = cmdOp.c1, c2 = cmdOp.box ? { x: cmdOp.box.xmax, y: cmdOp.box.ymax } : mouseWorld;
    const p1 = cmdOp.box ? { x: cmdOp.box.xmin, y: cmdOp.box.ymin } : c1;
    if (c1) {
      const a = worldToScreen(p1.x, p1.y), b = worldToScreen(c2.x, c2.y);
      ctx.save(); ctx.strokeStyle = '#6ad28a'; ctx.fillStyle = 'rgba(106,210,138,.10)';
      ctx.lineWidth = 1; ctx.setLineDash([6, 4]);
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.restore();
    }
  }

  // 영역 선택 박스
  if (dragSelect) {
    ctx.save();
    const crossing = dragSelect.x2 < dragSelect.x1; // 오→왼 = 크로싱(초록 점선), 왼→오 = 윈도우(파랑 실선)
    if (crossing) { ctx.strokeStyle = '#30d158'; ctx.fillStyle = 'rgba(48,209,88,.12)'; ctx.setLineDash([5, 4]); }
    else { ctx.strokeStyle = '#0A84FF'; ctx.fillStyle = 'rgba(41,151,255,.14)'; ctx.setLineDash([]); }
    ctx.lineWidth = 1;
    const a = worldToScreen(dragSelect.x1, dragSelect.y1);
    const b = worldToScreen(dragSelect.x2, dragSelect.y2);
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.restore();
  }

  drawImgGumball(); // 이미지 검볼 (선택 1개 & IMAGE일 때만)

  // 커서 십자선
  drawCursor();
}

function drawGrid() {
  const W = cv._w, H = cv._h;
  let g = state.grid.size;
  // 화면에서 그리드 간격이 너무 촘촘하면 배수로 키움
  while (g * state.view.scale < 8) g *= 5;
  const tl = screenToWorld(0, 0), br = screenToWorld(W, H);
  const minX = Math.floor(tl.x / g) * g, maxX = Math.ceil(br.x / g) * g;
  const minY = Math.floor(br.y / g) * g, maxY = Math.ceil(tl.y / g) * g;
  ctx.save();
  ctx.lineWidth = 1;
  for (let x = minX; x <= maxX; x += g) {
    const s = worldToScreen(x, 0);
    ctx.strokeStyle = (Math.round(x / g) % 5 === 0) ? getCSS('--grid2') : getCSS('--grid');
    ctx.beginPath(); ctx.moveTo(s.x, 0); ctx.lineTo(s.x, H); ctx.stroke();
  }
  for (let y = minY; y <= maxY; y += g) {
    const s = worldToScreen(0, y);
    ctx.strokeStyle = (Math.round(y / g) % 5 === 0) ? getCSS('--grid2') : getCSS('--grid');
    ctx.beginPath(); ctx.moveTo(0, s.y); ctx.lineTo(W, s.y); ctx.stroke();
  }
  ctx.restore();
}

function drawAxes() {
  ctx.save();
  const o = worldToScreen(0, 0);
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = 'rgba(255,80,80,.5)';  // X
  ctx.beginPath(); ctx.moveTo(0, o.y); ctx.lineTo(cv._w, o.y); ctx.stroke();
  ctx.strokeStyle = 'rgba(80,255,120,.5)'; // Y
  ctx.beginPath(); ctx.moveTo(o.x, 0); ctx.lineTo(o.x, cv._h); ctx.stroke();
  ctx.restore();
}

function drawCursor() {
  const s = worldToScreen(mouseWorld.x, mouseWorld.y);
  ctx.save();
  ctx.strokeStyle = document.documentElement.classList.contains('light') ? 'rgba(20,30,60,.4)' : 'rgba(255,255,255,.35)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(s.x, 0); ctx.lineTo(s.x, cv._h);
  ctx.moveTo(0, s.y); ctx.lineTo(cv._w, s.y);
  ctx.stroke();
  ctx.restore();
  if (otrackAlign && trackPt) { // 스냅 추적선(주황 점선)
    const tp = worldToScreen(trackPt.x, trackPt.y);
    ctx.save(); ctx.strokeStyle = 'rgba(255,170,60,.8)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(tp.x, tp.y); ctx.lineTo(s.x, s.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(tp.x - 4, tp.y); ctx.lineTo(tp.x + 4, tp.y); ctx.moveTo(tp.x, tp.y - 4); ctx.lineTo(tp.x, tp.y + 4); ctx.stroke();
    ctx.restore();
  }
  if (activeSnap) drawSnapMarker(s, activeSnap.type);
}

// OSNAP 표식: 끝점=□, 중점=△, 중심=○, 근처=✕
function drawSnapMarker(s, type) {
  ctx.save();
  ctx.strokeStyle = '#2ee6a6'; ctx.lineWidth = 1.8; ctx.setLineDash([]);
  const r = 7;
  if (type === 'endpoint') {
    ctx.strokeRect(s.x - r, s.y - r, 2 * r, 2 * r);
  } else if (type === 'midpoint') {
    ctx.beginPath(); ctx.moveTo(s.x, s.y - r); ctx.lineTo(s.x - r, s.y + r); ctx.lineTo(s.x + r, s.y + r); ctx.closePath(); ctx.stroke();
  } else if (type === 'center') {
    ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.stroke();
  } else if (type === 'perp') { // 수직: 직각 기호 ⊐
    ctx.beginPath();
    ctx.moveTo(s.x - r, s.y - r); ctx.lineTo(s.x - r, s.y + r); ctx.lineTo(s.x + r, s.y + r); // ㄴ
    ctx.moveTo(s.x - r, s.y); ctx.lineTo(s.x, s.y); ctx.lineTo(s.x, s.y + r);                 // 안쪽 직각 표시
    ctx.stroke();
  } else if (type === 'intersect') { // 교차: ✕
    ctx.beginPath();
    ctx.moveTo(s.x - r, s.y - r); ctx.lineTo(s.x + r, s.y + r);
    ctx.moveTo(s.x + r, s.y - r); ctx.lineTo(s.x - r, s.y + r);
    ctx.stroke();
  } else if (type === 'tangent') { // 접선: 원 + 위쪽 접선
    ctx.beginPath(); ctx.arc(s.x, s.y + r * 0.25, r * 0.75, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(s.x - r, s.y - r * 0.5); ctx.lineTo(s.x + r, s.y - r * 0.5); ctx.stroke();
  } else if (type === 'quad') { // 사분점: ◇ + 중심점
    ctx.beginPath(); ctx.moveTo(s.x, s.y - r); ctx.lineTo(s.x + r, s.y); ctx.lineTo(s.x, s.y + r); ctx.lineTo(s.x - r, s.y); ctx.closePath(); ctx.stroke();
    ctx.fillStyle = '#2ee6a6'; ctx.beginPath(); ctx.arc(s.x, s.y, 1.6, 0, Math.PI * 2); ctx.fill();
  } else { // nearest: 모래시계(⧗)
    ctx.beginPath();
    ctx.moveTo(s.x - r, s.y - r); ctx.lineTo(s.x + r, s.y - r); ctx.lineTo(s.x - r, s.y + r);
    ctx.lineTo(s.x + r, s.y + r); ctx.closePath();
    ctx.stroke();
  }
  ctx.fillStyle = '#2ee6a6'; ctx.font = '11px "Segoe UI",sans-serif'; ctx.textBaseline = 'bottom';
  ctx.fillText(SNAP_KO[type], s.x + r + 3, s.y - r);
  ctx.restore();
}

function drawEntity(e, selected, preview) {
  ctx.save();
  const lw = entityLineWeight(e);
  ctx.lineWidth = selected ? Math.max(2, lw) : lw;
  ctx.strokeStyle = selected ? '#0A84FF' : entityColor(e);
  ctx.fillStyle = ctx.strokeStyle;
  const dash = entityDash(e);
  if (preview) { ctx.globalAlpha = .8; ctx.setLineDash([5, 4]); }
  else if (dash && e.type !== 'TEXT' && e.type !== 'HATCH') ctx.setLineDash(dash);

  switch (e.type) {
    case 'LINE': {
      const a = worldToScreen(e.x1, e.y1), b = worldToScreen(e.x2, e.y2);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      break;
    }
    case 'LWPOLYLINE': {
      ctx.beginPath();
      e.points.forEach((p, i) => {
        const s = worldToScreen(p[0], p[1]);
        i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y);
      });
      if (e.closed) ctx.closePath();
      ctx.stroke();
      break;
    }
    case 'CIRCLE': {
      const c = worldToScreen(e.cx, e.cy);
      ctx.beginPath(); ctx.arc(c.x, c.y, e.r * state.view.scale, 0, Math.PI * 2); ctx.stroke();
      break;
    }
    case 'ARC': {
      const c = worldToScreen(e.cx, e.cy);
      // DXF 각도는 반시계, 화면은 Y가 뒤집혀 시계 → start/end 부호 변환
      const a1 = -e.endAngle * Math.PI / 180;
      const a2 = -e.startAngle * Math.PI / 180;
      ctx.beginPath(); ctx.arc(c.x, c.y, e.r * state.view.scale, a1, a2); ctx.stroke();
      break;
    }
    case 'TEXT': {
      const p = worldToScreen(e.x, e.y);
      const h = e.height * state.view.scale;
      ctx.font = `${h}px "Segoe UI",sans-serif`;
      ctx.textBaseline = 'alphabetic';
      if (e.rotation) { // 화면 Y가 뒤집혀 있으므로 회전 부호 반전
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(-e.rotation * Math.PI / 180);
        ctx.fillText(e.text, 0, 0); ctx.restore();
      } else ctx.fillText(e.text, p.x, p.y);
      break;
    }
    case 'HATCH': {
      const b = e.boundary;
      const path = () => {
        ctx.beginPath();
        if (b.kind === 'circle') { const c = worldToScreen(b.cx, b.cy); ctx.arc(c.x, c.y, b.r * state.view.scale, 0, Math.PI * 2); }
        else { b.points.forEach((p, i) => { const s = worldToScreen(p[0], p[1]); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); }); ctx.closePath(); }
      };
      if (e.pattern === 'solid') { path(); const ga = ctx.globalAlpha; ctx.globalAlpha = 0.35; ctx.fill(); ctx.globalAlpha = ga; }
      else {
        const hs = hatchSegments(e);
        ctx.beginPath();
        for (const s of hs.segs) { const A = worldToScreen(s[0], s[1]), B = worldToScreen(s[2], s[3]); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); }
        ctx.stroke();
        for (const dp of hs.dots) { const P = worldToScreen(dp[0], dp[1]); ctx.fillRect(P.x - 1.2, P.y - 1.2, 2.4, 2.4); }
      }
      if (selected && !preview) { path(); ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]); }
      break;
    }
    case 'IMAGE': {
      if (!e._img) {
        const im = new Image(); im.src = e.src;
        Object.defineProperty(e, '_img', { value: im, configurable: true, writable: true, enumerable: false });
        im.onload = () => draw();
      }
      if (e._img.complete && e._img.naturalWidth) {
        const c = imgCenter(e), s = worldToScreen(c.x, c.y);
        const W = e.w * state.view.scale, H = e.h * state.view.scale;
        ctx.save();
        ctx.translate(s.x, s.y);
        if (e.rot) ctx.rotate(-e.rot * Math.PI / 180); // 화면 Y는 아래로 증가 → 월드 반시계 = 화면 시계
        if (e.flip) ctx.scale(-1, 1);
        // 투명도(op) · 채도(sat) · 명도(bri) — 특성창에서 조절. 기본값이면 필터 미적용(성능).
        ctx.globalAlpha = (preview ? 0.4 : 0.9) * (e.op != null ? e.op : 1);
        const sat = e.sat != null ? e.sat : 1, bri = e.bri != null ? e.bri : 1;
        if (sat !== 1 || bri !== 1) ctx.filter = `saturate(${Math.round(sat * 100)}%) brightness(${Math.round(bri * 100)}%)`;
        ctx.drawImage(e._img, -W / 2, -H / 2, W, H);
        ctx.restore();
      }
      if (selected && !preview) {
        const cs = imgCorners(e).map(p => worldToScreen(p.x, p.y));
        ctx.setLineDash([4, 3]); ctx.beginPath();
        cs.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
        ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
      }
      break;
    }
    case 'INSERT': {
      ctx.restore();
      for (const c of insertChildren(e)) drawEntity(c, false, preview); // 자식은 각자 색/선종류
      ctx.save(); ctx.strokeStyle = '#0A84FF';
      if (selected && !preview) { // 삽입점 X 마커 + 경계
        const p = worldToScreen(e.x, e.y);
        ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(p.x - 5, p.y); ctx.lineTo(p.x + 5, p.y); ctx.moveTo(p.x, p.y - 5); ctx.lineTo(p.x, p.y + 5); ctx.stroke();
        const bb = insertBBox(e), a = worldToScreen(bb.xmin, bb.ymax), c2 = worldToScreen(bb.xmax, bb.ymin);
        ctx.setLineDash([4, 3]); ctx.strokeRect(a.x, a.y, c2.x - a.x, c2.y - a.y); ctx.setLineDash([]);
      }
      break;
    }
  }

  // 선택 시 그립 표시
  if (selected && !preview) {
    ctx.setLineDash([]); ctx.fillStyle = '#0A84FF';
    for (const g of entityGrips(e)) {
      const s = worldToScreen(g.x, g.y);
      ctx.fillRect(s.x - 3, s.y - 3, 6, 6);
    }
    if (e.type === 'LWPOLYLINE') { // 세그먼트 중점: 속 빈 그립(클릭=정점 추가)
      ctx.strokeStyle = '#0A84FF'; ctx.lineWidth = 1.2;
      const p = e.points, n = p.length, segN = e.closed ? n : n - 1;
      for (let i = 0; i < segN; i++) {
        const s = worldToScreen((p[i][0] + p[(i + 1) % n][0]) / 2, (p[i][1] + p[(i + 1) % n][1]) / 2);
        ctx.strokeRect(s.x - 2.6, s.y - 2.6, 5.2, 5.2);
      }
    }
  }
  ctx.restore();
}

function drawDraftPolyline() {
  ctx.save();
  ctx.strokeStyle = '#0A84FF'; ctx.lineWidth = 1.4; ctx.setLineDash([5, 4]);
  ctx.beginPath();
  pts.forEach((p, i) => { const s = worldToScreen(p.x, p.y); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
  const m = worldToScreen(mouseWorld.x, mouseWorld.y);
  ctx.lineTo(m.x, m.y); ctx.stroke();
  ctx.restore();
}

// ---------- 이미지 기하 헬퍼 ----------
// IMAGE는 x,y = (회전 전) 좌하단, w,h = 크기, rot = 중심 기준 반시계 회전(도), flip = 좌우 반전.
// rot/flip/op/sat/bri는 모두 선택 속성 — 없으면 기존 동작(회전 0·불투명·원본색)과 동일.
function imgCenter(e) { return { x: e.x + e.w / 2, y: e.y + e.h / 2 }; }
// 월드 → 이미지 로컬(중심 원점, 회전 해제). 히트/그립 판정 공용.
function imgLocal(e, w) {
  const c = imgCenter(e), a = -(e.rot || 0) * Math.PI / 180;
  const ca = Math.cos(a), sa = Math.sin(a), dx = w.x - c.x, dy = w.y - c.y;
  return { u: dx * ca - dy * sa, v: dx * sa + dy * ca };
}
// 이미지 로컬(u,v) → 월드
function imgWorld(e, u, v) {
  const c = imgCenter(e), a = (e.rot || 0) * Math.PI / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  return { x: c.x + u * ca - v * sa, y: c.y + u * sa + v * ca };
}
const IMG_CORNER_UV = [[-1, -1], [1, -1], [1, 1], [-1, 1]]; // 좌하 → 우하 → 우상 → 좌상
function imgCorners(e) { return IMG_CORNER_UV.map(([su, sv]) => imgWorld(e, su * e.w / 2, sv * e.h / 2)); }
// 중심을 (cx,cy)에 두도록 x,y 재설정 (회전은 중심 기준이므로 중심 이동 = 평행이동)
function imgSetCenter(e, cx, cy) { e.x = cx - e.w / 2; e.y = cy - e.h / 2; }

function entityGrips(e) {
  switch (e.type) {
    case 'LINE': return [{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }];
    case 'LWPOLYLINE': return e.points.map(p => ({ x: p[0], y: p[1] }));
    case 'CIRCLE': case 'ARC': return [{ x: e.cx, y: e.cy }];
    case 'TEXT': return [{ x: e.x, y: e.y }];
    case 'HATCH': return e.boundary.kind === 'circle' ? [{ x: e.boundary.cx, y: e.boundary.cy }] : e.boundary.points.map(p => ({ x: p[0], y: p[1] }));
    case 'INSERT': return [{ x: e.x, y: e.y }];
    case 'IMAGE': return imgCorners(e); // 네 모서리 = 크기 조절 그립
  }
  return [];
}

// ============================================================
//  히트 테스트(선택)
// ============================================================
function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}
function isLocked(e) { const l = getLayer(e.layer); return !!(l && l.locked); }
function hitTest(w, tolWorld) {
  // 뒤에서부터(위에 그려진 것 우선). 잠긴 레이어는 선택 불가
  for (let i = state.entities.length - 1; i >= 0; i--) {
    const e = state.entities[i];
    const l = getLayer(e.layer); if (l && (!l.visible || l.locked)) continue;
    if (!onLv(e)) continue; // 다른 층은 선택 불가
    if (entityHit(e, w, tolWorld)) return e;
  }
  return null;
}
// 픽 전용: 화면 8px 허용오차로 스냅점·원시점 모두 검사(스냅된 도형도 잘 잡히도록)
function pick(w, rawW) {
  const tol = 8 / state.view.scale;
  return hitTest(rawW, tol) || hitTest(w, tol);
}
function entityHit(e, w, tol) {
  switch (e.type) {
    case 'LINE': return distToSeg(w.x, w.y, e.x1, e.y1, e.x2, e.y2) <= tol;
    case 'LWPOLYLINE': {
      for (let i = 0; i < e.points.length - 1; i++)
        if (distToSeg(w.x, w.y, e.points[i][0], e.points[i][1], e.points[i + 1][0], e.points[i + 1][1]) <= tol) return true;
      if (e.closed && e.points.length > 1) {
        const a = e.points[e.points.length - 1], b = e.points[0];
        if (distToSeg(w.x, w.y, a[0], a[1], b[0], b[1]) <= tol) return true;
      }
      return false;
    }
    case 'CIRCLE': return Math.abs(Math.hypot(w.x - e.cx, w.y - e.cy) - e.r) <= tol;
    case 'ARC': {
      const d = Math.abs(Math.hypot(w.x - e.cx, w.y - e.cy) - e.r);
      if (d > tol) return false;
      let ang = Math.atan2(w.y - e.cy, w.x - e.cx) * 180 / Math.PI;
      if (ang < 0) ang += 360;
      let s = e.startAngle, en = e.endAngle;
      if (en < s) en += 360;
      let a = ang; if (a < s) a += 360;
      return a >= s && a <= en;
    }
    case 'TEXT': {
      const w2 = e.height * 0.6 * e.text.length;
      return w.x >= e.x - tol && w.x <= e.x + w2 + tol && w.y >= e.y - tol && w.y <= e.y + e.height + tol;
    }
    case 'HATCH': return pointInBoundary(e.boundary, w.x, w.y); // 내부 클릭 = 선택
    case 'IMAGE': { const L = imgLocal(e, w); return Math.abs(L.u) <= e.w / 2 + tol && Math.abs(L.v) <= e.h / 2 + tol; } // 회전 반영
    case 'INSERT': {
      if (Math.hypot(w.x - e.x, w.y - e.y) <= tol) return true; // 삽입점
      for (const c of insertChildren(e)) if (entityHit(c, w, tol)) return true;
      return false;
    }
  }
  return false;
}
function entityInBox(e, x1, y1, x2, y2) {
  const xmin = Math.min(x1, x2), xmax = Math.max(x1, x2);
  const ymin = Math.min(y1, y2), ymax = Math.max(y1, y2);
  const inside = (x, y) => x >= xmin && x <= xmax && y >= ymin && y <= ymax;
  for (const g of entityGrips(e)) if (!inside(g.x, g.y)) return false;
  return entityGrips(e).length > 0;
}

// ---------- 윈도우/크로싱 선택용 경계 계산 ----------
function entityBBox(e) {
  switch (e.type) {
    case 'LINE': return { xmin: Math.min(e.x1, e.x2), xmax: Math.max(e.x1, e.x2), ymin: Math.min(e.y1, e.y2), ymax: Math.max(e.y1, e.y2) };
    case 'LWPOLYLINE': {
      const xs = e.points.map(p => p[0]), ys = e.points.map(p => p[1]);
      return { xmin: Math.min(...xs), xmax: Math.max(...xs), ymin: Math.min(...ys), ymax: Math.max(...ys) };
    }
    case 'CIRCLE': return { xmin: e.cx - e.r, xmax: e.cx + e.r, ymin: e.cy - e.r, ymax: e.cy + e.r };
    case 'ARC': {
      const pts = [ptOnArc(e, e.startAngle), ptOnArc(e, e.endAngle)];
      for (const a of [0, 90, 180, 270]) if (angleInArc(a, e.startAngle, e.endAngle)) pts.push(ptOnArc(e, a));
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
      return { xmin: Math.min(...xs), xmax: Math.max(...xs), ymin: Math.min(...ys), ymax: Math.max(...ys) };
    }
    case 'TEXT': { const w = (e.text ? e.text.length : 0) * e.height * 0.6; return { xmin: e.x, xmax: e.x + w, ymin: e.y, ymax: e.y + e.height }; }
    case 'HATCH': return boundaryBBox(e.boundary);
    case 'INSERT': return insertBBox(e);
    case 'IMAGE': { const cs = imgCorners(e), xs = cs.map(p => p.x), ys = cs.map(p => p.y);
      return { xmin: Math.min(...xs), xmax: Math.max(...xs), ymin: Math.min(...ys), ymax: Math.max(...ys) }; }
    case 'MESH': return meshBBox(e);
  }
  return null;
}
// 윈도우 선택: 객체 전체가 박스 안에
function entityFullyInBox(e, b) {
  const bb = entityBBox(e);
  return bb && bb.xmin >= b.xmin && bb.xmax <= b.xmax && bb.ymin >= b.ymin && bb.ymax <= b.ymax;
}
// 크로싱 선택: 객체가 박스에 걸치거나 들어옴
function entityCrossesBox(e, b) {
  if (e.type === 'HATCH') { const bb = entityBBox(e); return !(bb.xmax < b.xmin || bb.xmin > b.xmax || bb.ymax < b.ymin || bb.ymin > b.ymax); }
  const inB = (x, y) => x >= b.xmin && x <= b.xmax && y >= b.ymin && y <= b.ymax;
  const edges = [[b.xmin, b.ymin, b.xmax, b.ymin], [b.xmax, b.ymin, b.xmax, b.ymax], [b.xmax, b.ymax, b.xmin, b.ymax], [b.xmin, b.ymax, b.xmin, b.ymin]];
  const segHitsBox = (x1, y1, x2, y2) => {
    if (inB(x1, y1) || inB(x2, y2)) return true;
    for (const ed of edges) { const r = segSeg([x1, y1], [x2, y2], [ed[0], ed[1]], [ed[2], ed[3]]); if (r && r.t >= 0 && r.t <= 1 && r.u >= 0 && r.u <= 1) return true; }
    return false;
  };
  if (e.type === 'LINE' || e.type === 'LWPOLYLINE') {
    for (const sg of entitySegments(e)) if (segHitsBox(sg[0], sg[1], sg[2], sg[3])) return true;
    return false;
  }
  if (e.type === 'CIRCLE' || e.type === 'ARC') {
    if (e.type === 'CIRCLE' && inB(e.cx + e.r, e.cy)) return true; // 원이 박스에 통째로 들어온 경우 (원은 끝점이 없어 아래 검사로는 누락)
    for (const pt of entityEndpoints(e)) if (inB(pt.x, pt.y)) return true; // 호 끝점이 안에
    for (const ed of edges) {
      for (const h of segCircle([ed[0], ed[1]], [ed[2], ed[3]], e.cx, e.cy, e.r)) {
        if (h.t < 0 || h.t > 1) continue;
        if (e.type === 'ARC' && !angleInArc(ang(e.cx, e.cy, h.x, h.y), e.startAngle, e.endAngle)) continue;
        return true;
      }
    }
    return false;
  }
  if (e.type === 'TEXT') { const bb = entityBBox(e); return !(bb.xmax < b.xmin || bb.xmin > b.xmax || bb.ymax < b.ymin || bb.ymin > b.ymax); }
  return false;
}

// ============================================================
//  객체 스냅 (OSNAP) — 끝점 / 중점 / 중심 / 근처점
// ============================================================
function closestOnSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { x: x1 + t * dx, y: y1 + t * dy };
}
function entityEndpoints(e) {
  switch (e.type) {
    case 'LINE': return [{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }];
    case 'LWPOLYLINE': return e.points.map(p => ({ x: p[0], y: p[1] }));
    case 'ARC': { const a = ptOnArc(e, e.startAngle), b = ptOnArc(e, e.endAngle); return [a, b]; }
    case 'TEXT': return [{ x: e.x, y: e.y }];
  }
  return [];
}
function entityMidpoints(e) {
  switch (e.type) {
    case 'LINE': return [{ x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2 }];
    case 'LWPOLYLINE': {
      const out = [], p = e.points, n = p.length, segN = e.closed ? n : n - 1;
      for (let i = 0; i < segN; i++) { const a = p[i], b = p[(i + 1) % n]; out.push({ x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 }); }
      return out;
    }
    case 'ARC': { let s = e.startAngle, en = e.endAngle; if (en < s) en += 360; return [ptOnArc(e, (s + en) / 2)]; }
  }
  return [];
}
function nearestOnEntity(e, w) {
  switch (e.type) {
    case 'LINE': return closestOnSeg(w.x, w.y, e.x1, e.y1, e.x2, e.y2);
    case 'LWPOLYLINE': {
      let best = null, bd = Infinity, p = e.points, n = p.length, segN = e.closed ? n : n - 1;
      for (let i = 0; i < segN; i++) { const c = closestOnSeg(w.x, w.y, p[i][0], p[i][1], p[(i + 1) % n][0], p[(i + 1) % n][1]); const d = Math.hypot(c.x - w.x, c.y - w.y); if (d < bd) { bd = d; best = c; } }
      return best;
    }
    case 'CIRCLE': { const a = Math.atan2(w.y - e.cy, w.x - e.cx); return { x: e.cx + e.r * Math.cos(a), y: e.cy + e.r * Math.sin(a) }; }
    case 'ARC': {
      let deg = ang(e.cx, e.cy, w.x, w.y);
      if (!angleInArc(deg, e.startAngle, e.endAngle)) { // 호 범위 밖이면 가까운 끝점
        const a = ptOnArc(e, e.startAngle), b = ptOnArc(e, e.endAngle);
        return Math.hypot(a.x - w.x, a.y - w.y) < Math.hypot(b.x - w.x, b.y - w.y) ? a : b;
      }
      return ptOnArc(e, deg);
    }
  }
  return null;
}
// 커서(mouseScreen) 근처의 최적 스냅점을 찾음. 우선순위: 끝점>중점>중심>근처
function entitySegments(e) {
  if (e.type === 'LINE') return [[e.x1, e.y1, e.x2, e.y2]];
  if (e.type === 'LWPOLYLINE') {
    const out = [], p = e.points, n = p.length, segN = e.closed ? n : n - 1;
    for (let i = 0; i < segN; i++) out.push([p[i][0], p[i][1], p[(i + 1) % n][0], p[(i + 1) % n][1]]);
    return out;
  }
  return [];
}
function perpFoot(bx, by, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return null;
  const t = ((bx - x1) * dx + (by - y1) * dy) / len2;
  return { x: x1 + t * dx, y: y1 + t * dy, t };
}
function findObjectSnap(raw) {
  if (!osnapEnabled) return null;
  const tol = 12;
  const skipSel = !!moveOp; // 이동 중에는 자기 자신에 스냅 방지
  let best = null;
  const consider = (x, y, type, prio) => {
    const s = worldToScreen(x, y);
    const d = Math.hypot(s.x - mouseScreen.x, s.y - mouseScreen.y);
    if (d <= tol && (!best || prio < best.prio || (prio === best.prio && d < best.d))) best = { x, y, type, prio, d };
  };
  const base = orthoBase(); // 수직점 계산 기준점(작도 시작점 등)
  // 그리는 중인 도형의 자기 점들에도 스냅 (폴리라인 닫기, 시작점 복귀 등)
  if (settings.osnapModes.endpoint) {
    for (const p of pts) consider(p.x, p.y, 'endpoint', 1);
    if (draft && draft.type === 'LINE') consider(draft.x1, draft.y1, 'endpoint', 1);
  }
  let perp = null, perpD = Infinity, perpKind = 'perp';
  const preTol = tol / state.view.scale * 1.5; // bbox 프리체크(대형 도면 성능)
  for (const e of state.entities) {
    const l = getLayer(e.layer); if (l && !l.visible) continue;
    if (!onLv(e)) continue; // 다른 층에는 스냅하지 않음
    if (skipSel && state.selection.has(e.id)) continue;
    if (state.entities.length > 300) {
      const bb = entityBBox(e);
      if (bb && (raw.x < bb.xmin - preTol || raw.x > bb.xmax + preTol || raw.y < bb.ymin - preTol || raw.y > bb.ymax + preTol)) continue;
    }
    if (settings.osnapModes.endpoint) for (const g of entityEndpoints(e)) consider(g.x, g.y, 'endpoint', 1);
    if (settings.osnapModes.midpoint) for (const m of entityMidpoints(e)) consider(m.x, m.y, 'midpoint', 2);
    if (settings.osnapModes.center && (e.type === 'CIRCLE' || e.type === 'ARC')) consider(e.cx, e.cy, 'center', 3);
    // 사분점(Quad): 원/호의 0°/90°/180°/270° 점 — 호는 각도 범위 안에 있는 것만 (라이노 Quad)
    if (settings.osnapModes.quad && (e.type === 'CIRCLE' || e.type === 'ARC')) {
      for (const q of [[e.cx + e.r, e.cy], [e.cx - e.r, e.cy], [e.cx, e.cy + e.r], [e.cx, e.cy - e.r]]) {
        if (e.type === 'ARC' && !angleInArc(ang(e.cx, e.cy, q[0], q[1]), e.startAngle, e.endAngle)) continue;
        consider(q[0], q[1], 'quad', 3);
      }
    }
    // 수직점(perpendicular): 기준점에서 도형으로 내린 수선의 발. 커서가 그 도형 위에 있을 때 제공
    if (base && settings.osnapModes.perp) {
      for (const sg of entitySegments(e)) {
        const np = closestOnSeg(raw.x, raw.y, sg[0], sg[1], sg[2], sg[3]);
        const sn = worldToScreen(np.x, np.y);
        const dCur = Math.hypot(sn.x - mouseScreen.x, sn.y - mouseScreen.y);
        if (dCur > tol) continue;
        const f = perpFoot(base.x, base.y, sg[0], sg[1], sg[2], sg[3]);
        if (f && f.t >= -1e-9 && f.t <= 1 + 1e-9 && dCur < perpD) { perpD = dCur; perp = { x: f.x, y: f.y }; perpKind = 'perp'; }
      }
    }
    // 접점(Tan): 기준점에서 원/호에 그은 접선의 접점 — 라이노 Tan (기준점이 원 밖일 때만 존재)
    if (base && settings.osnapModes.tangent && (e.type === 'CIRCLE' || e.type === 'ARC')) {
      const tdx = base.x - e.cx, tdy = base.y - e.cy, tL = Math.hypot(tdx, tdy);
      if (tL > e.r + 1e-9) {
        const bAng = Math.atan2(tdy, tdx), al = Math.acos(e.r / tL);
        for (const sgn of [1, -1]) {
          const tx = e.cx + e.r * Math.cos(bAng + al * sgn), ty = e.cy + e.r * Math.sin(bAng + al * sgn);
          if (e.type === 'ARC' && !angleInArc(ang(e.cx, e.cy, tx, ty), e.startAngle, e.endAngle)) continue;
          const sn = worldToScreen(tx, ty);
          const dCur = Math.hypot(sn.x - mouseScreen.x, sn.y - mouseScreen.y);
          if (dCur <= tol && dCur < perpD) { perpD = dCur; perp = { x: tx, y: ty }; perpKind = 'tangent'; }
        }
      }
    }
    const np = settings.osnapModes.nearest ? nearestOnEntity(e, raw) : null;
    if (np) consider(np.x, np.y, 'nearest', 5);
  }
  // 교차점: 커서 근처 도형쌍의 실제 교차 계산 (근처 도형만 골라 저비용)
  if (settings.osnapModes.intersection) {
    const tolW = tol / state.view.scale, near = [];
    for (const e of state.entities) {
      if (!['LINE', 'LWPOLYLINE', 'CIRCLE', 'ARC'].includes(e.type)) continue;
      const l = getLayer(e.layer); if (l && !l.visible) continue;
      if (skipSel && state.selection.has(e.id)) continue;
      const bb = entityBBox(e); if (!bb) continue;
      if (raw.x < bb.xmin - tolW || raw.x > bb.xmax + tolW || raw.y < bb.ymin - tolW || raw.y > bb.ymax + tolW) continue;
      near.push(e); if (near.length > 12) break;
    }
    for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++)
      for (const pt of intersectEntities(near[i], near[j])) consider(pt[0], pt[1], 'intersect', 1);
  }
  // 우선순위: 끝점·중점·중심·교차 > 수직점·접점 > 근처점
  if (best && best.prio <= 3) return best;
  if (perp) return { x: perp.x, y: perp.y, type: perpKind };
  return best;
}
// 두 도형의 교차점 목록
function intersectEntities(A, B) {
  const out = [];
  const segsA = entitySegments(A), segsB = entitySegments(B);
  const isCirc = e => e.type === 'CIRCLE' || e.type === 'ARC';
  const onArc = (e, x, y) => e.type !== 'ARC' || angleInArc(ang(e.cx, e.cy, x, y), e.startAngle, e.endAngle);
  if (segsA.length && segsB.length) {
    for (const a of segsA) for (const b of segsB) {
      const r = segSeg([a[0], a[1]], [a[2], a[3]], [b[0], b[1]], [b[2], b[3]]);
      if (r && r.t >= -1e-9 && r.t <= 1 + 1e-9 && r.u >= -1e-9 && r.u <= 1 + 1e-9) out.push([r.x, r.y]);
    }
  } else if (segsA.length && isCirc(B)) {
    for (const a of segsA) for (const h of segCircle([a[0], a[1]], [a[2], a[3]], B.cx, B.cy, B.r))
      if (h.t >= -1e-9 && h.t <= 1 + 1e-9 && onArc(B, h.x, h.y)) out.push([h.x, h.y]);
  } else if (isCirc(A) && segsB.length) {
    return intersectEntities(B, A);
  } else if (isCirc(A) && isCirc(B)) {
    const d = Math.hypot(B.cx - A.cx, B.cy - A.cy);
    if (d > 1e-9 && d <= A.r + B.r && d >= Math.abs(A.r - B.r)) {
      const aa = (A.r * A.r - B.r * B.r + d * d) / (2 * d);
      const hh = Math.sqrt(Math.max(0, A.r * A.r - aa * aa));
      const mx = A.cx + aa * (B.cx - A.cx) / d, my = A.cy + aa * (B.cy - A.cy) / d;
      const ox = -(B.cy - A.cy) / d * hh, oy = (B.cx - A.cx) / d * hh;
      for (const p of [[mx + ox, my + oy], [mx - ox, my - oy]])
        if (onArc(A, p[0], p[1]) && onArc(B, p[0], p[1])) out.push(p);
    }
  }
  return out;
}
const SNAP_KO = { endpoint: '끝점', midpoint: '중점', center: '중심', quad: '사분점', perp: '수직', nearest: '근처', intersect: '교차', tangent: '접선', surface: '표면' };

// ============================================================
//  이동
// ============================================================
function translateEntity(e, dx, dy) {
  switch (e.type) {
    case 'MESH': meshXform(e, (x, y, z) => [x + dx, y + dy, z]); break; // 메시도 평면 이동 (move/copy 통합)
    case 'LINE': e.x1 += dx; e.y1 += dy; e.x2 += dx; e.y2 += dy; break;
    case 'LWPOLYLINE': e.points = e.points.map(p => [p[0] + dx, p[1] + dy]); break;
    case 'CIRCLE': case 'ARC': e.cx += dx; e.cy += dy; break;
    case 'TEXT': e.x += dx; e.y += dy; break;
    case 'HATCH': {
      const b = e.boundary;
      if (b.kind === 'circle') { b.cx += dx; b.cy += dy; }
      else b.points = b.points.map(p => [p[0] + dx, p[1] + dy]);
      hatchDirty(e); break;
    }
    case 'INSERT': e.x += dx; e.y += dy; break;
    case 'IMAGE': e.x += dx; e.y += dy; break;
  }
}

// ---------- 변환(transform) 헬퍼 : copy / mirror / rotate / array 공통 ----------
function cloneEntity(e) { const c = JSON.parse(JSON.stringify(e)); delete c.id; return c; }
function ptOnArc(e, deg) { const a = deg * Math.PI / 180; return { x: e.cx + e.r * Math.cos(a), y: e.cy + e.r * Math.sin(a) }; }

// ---------- 다각형/타원/면적 헬퍼 ----------
function polygonPoints(cx, cy, r, n, rot) {
  const out = [];
  for (let i = 0; i < n; i++) { const a = rot + i * 2 * Math.PI / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return out;
}
function ellipsePoints(cx, cy, rx, ry, n) {
  n = n || 64; const out = [];
  for (let i = 0; i < n; i++) { const a = i * 2 * Math.PI / n; out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
  return out;
}
function polyArea(ptsArr) { // shoelace, [[x,y],...]
  let s = 0; const n = ptsArr.length;
  for (let i = 0; i < n; i++) { const a = ptsArr[i], b = ptsArr[(i + 1) % n]; s += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(s) / 2;
}
function polyPerimeter(ptsArr, closed) {
  let s = 0; const n = ptsArr.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) { const a = ptsArr[i], b = ptsArr[(i + 1) % n]; s += Math.hypot(b[0] - a[0], b[1] - a[1]); }
  return s;
}
function fmtNum(n) { const d = (settings.dim && settings.dim.dec != null) ? settings.dim.dec : 2; return (+n.toFixed(d)).toString(); }
// 치수 문자용: 값 + (옵션) 단위 접미
function dimVal(n) { return fmtNum(n) + ((settings.dim && settings.dim.suffix) ? settings.units : ''); }
// 치수 문자 높이: 치수 설정이 있으면 그 값, 없으면 그리기 설정의 문자 높이
function dimTH() { return (settings.dim && settings.dim.txt > 0) ? settings.dim.txt : state.textHeight; }

function T_translate(dx, dy) { return { type: 'translate', pt: (x, y) => [x + dx, y + dy] }; }
function T_rotate(cx, cy, deg) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return { type: 'rotate', deg, pt: (x, y) => { const dx = x - cx, dy = y - cy; return [cx + dx * c - dy * s, cy + dx * s + dy * c]; } };
}
function T_mirror(ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
  const axisDeg = Math.atan2(dy, dx) * 180 / Math.PI;
  return {
    type: 'mirror', axisDeg,
    pt: (x, y) => { const t = ((x - ax) * dx + (y - ay) * dy) / len2; const px = ax + t * dx, py = ay + t * dy; return [2 * px - x, 2 * py - y]; }
  };
}
// 강체 변환(translate/rotate/mirror)을 도형에 적용. 반지름·문자높이는 보존.
function applyTransform(e, T) {
  switch (e.type) {
    // 메시: xy 변환 적용, z 유지. 대칭은 winding 뒤집기 (rotate/mirror 통합)
    case 'MESH': meshXform(e, (x, y, z) => { const q = T.pt(x, y); return [q[0], q[1], z]; }, T.type === 'mirror'); break;
    case 'LINE': [e.x1, e.y1] = T.pt(e.x1, e.y1); [e.x2, e.y2] = T.pt(e.x2, e.y2); break;
    case 'LWPOLYLINE': e.points = e.points.map(p => T.pt(p[0], p[1])); break;
    case 'CIRCLE': [e.cx, e.cy] = T.pt(e.cx, e.cy); break;
    case 'ARC': {
      const ps = ptOnArc(e, e.startAngle), pe = ptOnArc(e, e.endAngle);
      [e.cx, e.cy] = T.pt(e.cx, e.cy);
      const ns = T.pt(ps.x, ps.y), nps = T.pt(pe.x, pe.y);
      if (T.type === 'mirror') { // 반사는 방향(반시계)을 뒤집으므로 시작/끝 교환
        e.startAngle = ang(e.cx, e.cy, nps[0], nps[1]);
        e.endAngle = ang(e.cx, e.cy, ns[0], ns[1]);
      } else {
        e.startAngle = ang(e.cx, e.cy, ns[0], ns[1]);
        e.endAngle = ang(e.cx, e.cy, nps[0], nps[1]);
      }
      break;
    }
    case 'TEXT': {
      [e.x, e.y] = T.pt(e.x, e.y);
      if (T.type === 'rotate') e.rotation = (e.rotation || 0) + T.deg;
      else if (T.type === 'mirror') e.rotation = 2 * T.axisDeg - (e.rotation || 0);
      break;
    }
    case 'HATCH': {
      const b = e.boundary;
      if (b.kind === 'circle') [b.cx, b.cy] = T.pt(b.cx, b.cy);
      else b.points = b.points.map(p => T.pt(p[0], p[1]));
      hatchDirty(e); break;
    }
    case 'INSERT': {
      [e.x, e.y] = T.pt(e.x, e.y);
      if (T.type === 'rotate') e.rot = (e.rot || 0) + T.deg;
      else if (T.type === 'mirror') { e.sx = -(e.sx != null ? e.sx : 1); e.rot = 2 * T.axisDeg - (e.rot || 0); } // 미러: X배율 반전 + 회전 반사
      break;
    }
    // 이미지: 중심을 변환 + 회전각 누적 (rotate/mirror/copy/array 통합 — 라이노와 동일하게 전용 명령 불필요)
    case 'IMAGE': {
      const c = imgCenter(e), q = T.pt(c.x, c.y);
      if (T.type === 'rotate') e.rot = (e.rot || 0) + T.deg;
      else if (T.type === 'mirror') { e.flip = !e.flip; e.rot = 2 * T.axisDeg - (e.rot || 0); } // 미러: 좌우 반전 + 회전 반사
      imgSetCenter(e, q[0], q[1]);
      break;
    }
  }
  return e;
}
function transformedClone(e, T) { return applyTransform(cloneEntity(e), T); }
function selectedEntities() { const byId = new Map(state.entities.map(e => [e.id, e])); return [...state.selection].map(id => byId.get(id)).filter(Boolean); } // O(n²) 방지

// ---------- 블록(INSERT) ----------
// INSERT 인스턴스의 자식 도형을 월드좌표로 전개(축척·회전 적용). 렌더·히트·내보내기 공용.
function insertChildren(e) {
  const def = state.blocks[e.name];
  if (!def) return [];
  const sx = e.sx != null ? e.sx : 1, sy = e.sy != null ? e.sy : 1, rot = e.rot || 0;
  const a = rot * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const sc = Math.sqrt(Math.abs(sx * sy));
  const pt = (x, y) => { const px = x * sx, py = y * sy; return [px * ca - py * sa + e.x, px * sa + py * ca + e.y]; };
  const dirAngle = (deg) => { const t = deg * Math.PI / 180, vx = Math.cos(t) * sx, vy = Math.sin(t) * sy; return Math.atan2(vx * sa + vy * ca, vx * ca - vy * sa) * 180 / Math.PI; };
  const out = [];
  for (const src of def.entities) {
    const c = cloneEntity(src); c.layer = c.layer || e.layer;
    switch (c.type) {
      case 'LINE': [c.x1, c.y1] = pt(c.x1, c.y1); [c.x2, c.y2] = pt(c.x2, c.y2); break;
      case 'LWPOLYLINE': c.points = c.points.map(p => pt(p[0], p[1])); break;
      case 'CIRCLE': [c.cx, c.cy] = pt(c.cx, c.cy); c.r *= sc; break;
      case 'ARC': { [c.cx, c.cy] = pt(c.cx, c.cy); c.r *= sc; let s = dirAngle(c.startAngle), en = dirAngle(c.endAngle); if (sx * sy < 0) { const t = s; s = en; en = t; } c.startAngle = s; c.endAngle = en; break; }
      case 'TEXT': [c.x, c.y] = pt(c.x, c.y); c.height *= sc; c.rotation = (c.rotation || 0) + rot; break;
      case 'HATCH': { const b = c.boundary; if (b.kind === 'circle') { [b.cx, b.cy] = pt(b.cx, b.cy); b.r *= sc; } else b.points = b.points.map(p => pt(p[0], p[1])); c.spacing = (c.spacing || 5) * sc; break; }
    }
    out.push(c);
  }
  return out;
}
function insertBBox(e) {
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const c of insertChildren(e)) { const bb = entityBBox(c); if (bb) { mnx = Math.min(mnx, bb.xmin); mny = Math.min(mny, bb.ymin); mxx = Math.max(mxx, bb.xmax); mxy = Math.max(mxy, bb.ymax); } }
  if (!isFinite(mnx)) return { xmin: e.x, ymin: e.y, xmax: e.x, ymax: e.y };
  return { xmin: mnx, ymin: mny, xmax: mxx, ymax: mxy };
}

// ---------- 오프셋(간격복사) ----------
function lineLineIntersect(p1, d1, p2, d2) {
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-9) return null; // 평행
  const t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / den;
  return [p1[0] + t * d1[0], p1[1] + t * d1[1]];
}
function offsetEntity(e, dist, side) {
  switch (e.type) {
    case 'LINE': {
      const dx = e.x2 - e.x1, dy = e.y2 - e.y1, len = Math.hypot(dx, dy) || 1;
      let nx = -dy / len, ny = dx / len; // 왼쪽 법선
      const s = ((side.x - e.x1) * nx + (side.y - e.y1) * ny) >= 0 ? 1 : -1;
      const ox = s * dist * nx, oy = s * dist * ny;
      return { ...cloneEntity(e), x1: e.x1 + ox, y1: e.y1 + oy, x2: e.x2 + ox, y2: e.y2 + oy };
    }
    case 'CIRCLE': case 'ARC': {
      const d = Math.hypot(side.x - e.cx, side.y - e.cy);
      const nr = d > e.r ? e.r + dist : e.r - dist;
      if (nr <= 1e-6) return null;
      return { ...cloneEntity(e), r: nr };
    }
    case 'LWPOLYLINE': return offsetPolyline(e, dist, side);
  }
  return null; // TEXT 등은 오프셋 대상 아님
}
function offsetPolyline(e, dist, side) {
  // 점 정리: 연속 중복점 제거 + 닫는 점(=시작점 중복) 제거 → 0-길이 세그먼트로 인한 모서리 깨짐 방지
  let pts = [];
  for (const p of e.points) { const q = pts[pts.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) pts.push([p[0], p[1]]); }
  let closed = e.closed;
  if (pts.length >= 3 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) <= 1e-6) { pts.pop(); closed = true; } // 시작점으로 되돌아와 닫은 경우
  const n = pts.length;
  if (n < 2) return null;
  const segCount = closed ? n : n - 1;
  // 가장 가까운 세그먼트로 오프셋 방향(부호) 결정
  let best = Infinity, bestI = 0;
  for (let i = 0; i < segCount; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const d = distToSeg(side.x, side.y, a[0], a[1], b[0], b[1]);
    if (d < best) { best = d; bestI = i; }
  }
  const a0 = pts[bestI], b0 = pts[(bestI + 1) % n];
  const ldx = b0[0] - a0[0], ldy = b0[1] - a0[1], llen = Math.hypot(ldx, ldy) || 1;
  const nx0 = -ldy / llen, ny0 = ldx / llen;
  const sign = ((side.x - a0[0]) * nx0 + (side.y - a0[1]) * ny0) >= 0 ? 1 : -1;
  const off = sign * dist;
  // 각 세그먼트의 오프셋 직선(점+방향)
  const lines = [];
  for (let i = 0; i < segCount; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    lines.push({ p: [a[0] + off * nx, a[1] + off * ny], d: [dx, dy] });
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    let prevSeg, curSeg;
    if (closed) { prevSeg = (i - 1 + segCount) % segCount; curSeg = i % segCount; }
    else {
      if (i === 0) { const L = lines[0]; out.push([L.p[0], L.p[1]]); continue; }
      if (i === n - 1) { const L = lines[segCount - 1]; out.push([L.p[0] + L.d[0], L.p[1] + L.d[1]]); continue; }
      prevSeg = i - 1; curSeg = i;
    }
    const L1 = lines[prevSeg], L2 = lines[curSeg];
    const ip = lineLineIntersect(L1.p, L1.d, L2.p, L2.d);
    out.push(ip || [L2.p[0], L2.p[1]]);
  }
  return { ...cloneEntity(e), points: out, closed };
}

// ============================================================
//  교차(intersection) 헬퍼  — trim / extend / fillet 공통
// ============================================================
function norm360(a) { return ((a % 360) + 360) % 360; }
function angleInArc(a, s, e) {
  a = norm360(a); s = norm360(s); e = norm360(e);
  if (s <= e) return a >= s - 1e-6 && a <= e + 1e-6;
  return a >= s - 1e-6 || a <= e + 1e-6;
}
// 선분 ab 와 선분 cd 의 교차. {t,u,x,y} (t: ab 매개변수, u: cd 매개변수). 평행이면 null.
function segSeg(a, b, c, d) {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
  return { t, u, x: a[0] + t * rx, y: a[1] + t * ry };
}
// 선분 ab 와 원(cx,cy,r) 교차. [{t,x,y}...]
function segCircle(a, b, cx, cy, r) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const fx = a[0] - cx, fy = a[1] - cy;
  const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r;
  let disc = B * B - 4 * A * C;
  if (disc < 0 || A < 1e-12) return [];
  disc = Math.sqrt(disc);
  const out = [];
  for (const t of [(-B - disc) / (2 * A), (-B + disc) / (2 * A)]) out.push({ t, x: a[0] + t * dx, y: a[1] + t * dy });
  return out;
}
// 다른 엔티티 o 가 선분 a→b 를 교차하는 t 값들(0..1)
function lineCutsFromEntity(a, b, o) {
  const ts = [];
  if (o.type === 'LINE') {
    const r = segSeg(a, b, [o.x1, o.y1], [o.x2, o.y2]);
    if (r && r.u >= -1e-9 && r.u <= 1 + 1e-9) ts.push(r.t);
  } else if (o.type === 'LWPOLYLINE') {
    const p = o.points, n = p.length, segN = o.closed ? n : n - 1;
    for (let i = 0; i < segN; i++) {
      const r = segSeg(a, b, p[i], p[(i + 1) % n]);
      if (r && r.u >= -1e-9 && r.u <= 1 + 1e-9) ts.push(r.t);
    }
  } else if (o.type === 'CIRCLE' || o.type === 'ARC') {
    for (const h of segCircle(a, b, o.cx, o.cy, o.r)) {
      if (o.type === 'ARC' && !angleInArc(ang(o.cx, o.cy, h.x, h.y), o.startAngle, o.endAngle)) continue;
      ts.push(h.t);
    }
  }
  return ts;
}

// ============================================================
//  TRIM (자르기)
// ============================================================
function trimLine(line, clickW, edges) {
  const a = [line.x1, line.y1], b = [line.x2, line.y2];
  const cuts = [];
  for (const o of (edges || state.entities)) {
    if (o === line) continue; const l = getLayer(o.layer); if (l && !l.visible) continue;
    for (const t of lineCutsFromEntity(a, b, o)) if (t > 1e-4 && t < 1 - 1e-4) cuts.push(t);
  }
  if (!cuts.length) { logLine('  자를 경계(교차)가 없습니다.', 'warn'); return false; }
  cuts.sort((x, y) => x - y);
  const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy || 1;
  let tc = ((clickW.x - a[0]) * dx + (clickW.y - a[1]) * dy) / len2;
  tc = Math.max(0, Math.min(1, tc));
  const bounds = [0, ...cuts, 1];
  let lo = 0, hi = 1;
  for (let i = 0; i < bounds.length - 1; i++) if (tc >= bounds[i] && tc <= bounds[i + 1]) { lo = bounds[i]; hi = bounds[i + 1]; break; }
  const P = t => [a[0] + t * dx, a[1] + t * dy];
  if (lo <= 1e-4) { const p = P(hi); line.x1 = p[0]; line.y1 = p[1]; }
  else if (hi >= 1 - 1e-4) { const p = P(lo); line.x2 = p[0]; line.y2 = p[1]; }
  else { // 가운데 → 둘로 분할
    const pHi = P(hi), pLo = P(lo);
    const seg2 = cloneEntity(line); seg2.x1 = pHi[0]; seg2.y1 = pHi[1];
    line.x2 = pLo[0]; line.y2 = pLo[1];
    addEntity(seg2);
  }
  return true;
}
function trimCircleArc(e, clickW, edges) {
  const angs = [];
  for (const o of (edges || state.entities)) {
    if (o === e) continue; const l = getLayer(o.layer); if (l && !l.visible) continue;
    let hits = [];
    if (o.type === 'LINE') hits = segCircle([o.x1, o.y1], [o.x2, o.y2], e.cx, e.cy, e.r).filter(h => h.t >= -1e-9 && h.t <= 1 + 1e-9);
    else if (o.type === 'LWPOLYLINE') { const p = o.points, n = p.length, sN = o.closed ? n : n - 1; for (let i = 0; i < sN; i++) hits = hits.concat(segCircle(p[i], p[(i + 1) % n], e.cx, e.cy, e.r).filter(h => h.t >= -1e-9 && h.t <= 1 + 1e-9)); }
    else if (o.type === 'CIRCLE' || o.type === 'ARC') { // 원-원 교차
      const d = Math.hypot(o.cx - e.cx, o.cy - e.cy);
      if (d > 1e-9 && d <= e.r + o.r && d >= Math.abs(e.r - o.r)) {
        const aa = (e.r * e.r - o.r * o.r + d * d) / (2 * d);
        const hh = Math.sqrt(Math.max(0, e.r * e.r - aa * aa));
        const mx = e.cx + aa * (o.cx - e.cx) / d, my = e.cy + aa * (o.cy - e.cy) / d;
        const ox = -(o.cy - e.cy) / d * hh, oy = (o.cx - e.cx) / d * hh;
        hits = [{ x: mx + ox, y: my + oy }, { x: mx - ox, y: my - oy }];
      }
    }
    for (const h of hits) {
      const ag = ang(e.cx, e.cy, h.x, h.y);
      if (e.type === 'ARC' && !angleInArc(ag, e.startAngle, e.endAngle)) continue;
      angs.push(ag);
    }
  }
  if (e.type === 'CIRCLE' && angs.length < 2) { logLine('  원을 자르려면 교차가 2개 이상 필요합니다.', 'warn'); return false; }
  if (e.type === 'ARC' && angs.length < 1) { logLine('  자를 경계가 없습니다.', 'warn'); return false; }
  const ca = ang(e.cx, e.cy, clickW.x, clickW.y);
  let bounds;
  if (e.type === 'CIRCLE') bounds = angs.map(norm360).sort((a, b) => a - b);
  else bounds = [norm360(e.startAngle), ...angs.map(norm360), norm360(e.endAngle)].sort((a, b) => a - b);
  // ca 를 포함하는 (lo,hi) CCW 구간 찾기
  const n = bounds.length;
  let found = null;
  for (let i = 0; i < n; i++) {
    let lo = bounds[i], hi = bounds[(i + 1) % n]; if (hi < lo) hi += 360;
    let c = ca < lo ? ca + 360 : ca;
    if (c >= lo && c <= hi) { found = { lo: norm360(lo), hi: norm360(bounds[(i + 1) % n]) }; break; }
  }
  if (!found) return false;
  e.type = 'ARC'; e.startAngle = found.hi; e.endAngle = found.lo; // 제거구간 [lo,hi] 의 보각
  return true;
}

// ============================================================
//  EXTEND (연장)
// ============================================================
function rayBoundaryHit(P0, dir, exclude) {
  const far = [P0[0] + dir[0] * 1e7, P0[1] + dir[1] * 1e7];
  let best = Infinity, bp = null;
  for (const o of state.entities) {
    if (o === exclude) continue; const l = getLayer(o.layer); if (l && !l.visible) continue;
    if (o.type === 'LINE') { const r = segSeg(P0, far, [o.x1, o.y1], [o.x2, o.y2]); if (r && r.t > 1e-6 && r.u >= -1e-9 && r.u <= 1 + 1e-9) { const d = r.t; if (d < best) { best = d; bp = [r.x, r.y]; } } }
    else if (o.type === 'LWPOLYLINE') { const p = o.points, n = p.length, sN = o.closed ? n : n - 1; for (let i = 0; i < sN; i++) { const r = segSeg(P0, far, p[i], p[(i + 1) % n]); if (r && r.t > 1e-6 && r.u >= 0 && r.u <= 1 && r.t < best) { best = r.t; bp = [r.x, r.y]; } } }
    else if (o.type === 'CIRCLE' || o.type === 'ARC') { for (const h of segCircle(P0, far, o.cx, o.cy, o.r)) { if (h.t <= 1e-6) continue; if (o.type === 'ARC' && !angleInArc(ang(o.cx, o.cy, h.x, h.y), o.startAngle, o.endAngle)) continue; if (h.t < best) { best = h.t; bp = [h.x, h.y]; } } }
  }
  return bp;
}
function extendLine(line, clickW) {
  const a = [line.x1, line.y1], b = [line.x2, line.y2];
  const da = Math.hypot(clickW.x - a[0], clickW.y - a[1]), db = Math.hypot(clickW.x - b[0], clickW.y - b[1]);
  const endA = da < db;
  const P0 = endA ? a : b, Po = endA ? b : a;
  let dir = [P0[0] - Po[0], P0[1] - Po[1]]; const dl = Math.hypot(dir[0], dir[1]) || 1; dir = [dir[0] / dl, dir[1] / dl];
  const hit = rayBoundaryHit(P0, dir, line);
  if (!hit) { logLine('  연장할 경계를 찾지 못했습니다.', 'warn'); return false; }
  if (endA) { line.x1 = hit[0]; line.y1 = hit[1]; } else { line.x2 = hit[0]; line.y2 = hit[1]; }
  return true;
}

// ============================================================
//  FILLET (모깎기)
// ============================================================
function lineInfIntersect(a, b, c, d) { // 무한 직선 교차점
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
  return [a[0] + t * rx, a[1] + t * ry];
}
function doFillet(line1, line2, radius, keep1, keep2) {
  const a1 = [line1.x1, line1.y1], b1 = [line1.x2, line1.y2];
  const a2 = [line2.x1, line2.y1], b2 = [line2.x2, line2.y2];
  const C = lineInfIntersect(a1, b1, a2, b2);
  if (!C) { logLine('  두 선이 평행하여 모깎기할 수 없습니다.', 'warn'); return false; }
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  // 남길 쪽 = '클릭한 쪽' (라이노) — 교차점에서 클릭점이 향한 방향의 끝점을 유지한다.
  // ★예전엔 무조건 '긴 쪽'을 남겨서, 교차한 두 선의 짧은 쪽을 클릭해도 반대쪽에 코너가
  //   생겼다(사용자 보고: 직각이 반대로 작용). 클릭점이 없으면(직접 호출) 예전 규칙 유지.
  const pickFar = (a, b, keep) => {
    if (keep) {
      const dx = keep.x - C[0], dy = keep.y - C[1];
      const da = (a[0] - C[0]) * dx + (a[1] - C[1]) * dy;
      const db = (b[0] - C[0]) * dx + (b[1] - C[1]) * dy;
      return da >= db ? a : b;
    }
    return dist(C, a) > dist(C, b) ? a : b;
  };
  const far1 = pickFar(a1, b1, keep1), near1 = far1 === a1 ? 'b' : 'a';
  const far2 = pickFar(a2, b2, keep2), near2 = far2 === a2 ? 'b' : 'a';
  const setNear = (ln, key, p) => { if (key === 'a') { ln.x1 = p[0]; ln.y1 = p[1]; } else { ln.x2 = p[0]; ln.y2 = p[1]; } };
  let u1 = [far1[0] - C[0], far1[1] - C[1]]; let l1 = Math.hypot(u1[0], u1[1]) || 1; u1 = [u1[0] / l1, u1[1] / l1];
  let u2 = [far2[0] - C[0], far2[1] - C[1]]; let l2 = Math.hypot(u2[0], u2[1]) || 1; u2 = [u2[0] / l2, u2[1] / l2];
  const dot = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]));
  const theta = Math.acos(dot);
  if (radius <= 0 || theta < 1e-4 || Math.abs(theta - Math.PI) < 1e-4) {
    setNear(line1, near1, C); setNear(line2, near2, C);
    return true;
  }
  const tanDist = radius / Math.tan(theta / 2);
  const t1 = [C[0] + u1[0] * tanDist, C[1] + u1[1] * tanDist];
  const t2 = [C[0] + u2[0] * tanDist, C[1] + u2[1] * tanDist];
  let bis = [u1[0] + u2[0], u1[1] + u2[1]]; const bl = Math.hypot(bis[0], bis[1]) || 1; bis = [bis[0] / bl, bis[1] / bl];
  const cen = [C[0] + bis[0] * radius / Math.sin(theta / 2), C[1] + bis[1] * radius / Math.sin(theta / 2)];
  setNear(line1, near1, t1); setNear(line2, near2, t2);
  let sa = ang(cen[0], cen[1], t1[0], t1[1]), ea = ang(cen[0], cen[1], t2[0], t2[1]);
  if (norm360(ea - sa) > 180) { const tmp = sa; sa = ea; ea = tmp; }
  // 호는 모깎기한 '선들의 레이어'를 따른다 (예전엔 현재 레이어 — 벽 레이어의 모깎기가 딴 레이어로 샜다)
  const fa = addEntity({ type: 'ARC', layer: line1.layer || state.currentLayer, cx: cen[0], cy: cen[1], r: radius, startAngle: sa, endAngle: ea });
  // 벽끼리의 모깎기 → 호도 같은 벽으로: 3D 에서 곡면 벽(curv)이 두 벽을 매끈하게 잇는다 (2026-07-25 사용자).
  // addEntity 가 역할 레이어면 자동 부여하지만, wall 명령으로 직접 지정한 벽도 이어지도록 명시 승계.
  if (!fa.bim && line1.bim && line1.bim.kind === 'wall' && line2.bim && line2.bim.kind === 'wall') {
    fa.bim = { kind: 'wall', h: line1.bim.h, t: line1.bim.t, base: line1.bim.base || 0 };
    if (line1.bim.auto) fa.bim.auto = 1;
  }
  if (fa.bim) scheduleBimRefresh();
  return true;
}
// 폴리라인에서 클릭 지점에 가장 가까운 변(세그먼트) 인덱스 — 세그먼트 i는 points[i]~points[(i+1)%n]
function nearestPolySeg(e, w) {
  const pts = e.points, n = pts.length, segCount = e.closed ? n : n - 1;
  let best = Infinity, bi = 0;
  for (let i = 0; i < segCount; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const d = distToSeg(w.x, w.y, a[0], a[1], b[0], b[1]);
    if (d < best) { best = d; bi = i; }
  }
  return bi;
}
// 꼭짓점(apex)에서 far1·far2 방향의 두 변을 반지름 radius로 둥글게 — 접점 t1(far1쪽)~t2(far2쪽) 호를 직선 근사로 반환
// radius<=0 이면 뾰족한 코너(apex 한 점만) — 오토캐드 R=0 필렛
function filletArcPts(apex, far1, far2, radius) {
  if (radius <= 0) return [[apex[0], apex[1]]]; // R=0: 두 변이 apex에서 뾰족하게 만남
  let u1 = [far1[0] - apex[0], far1[1] - apex[1]], l1 = Math.hypot(u1[0], u1[1]);
  let u2 = [far2[0] - apex[0], far2[1] - apex[1]], l2 = Math.hypot(u2[0], u2[1]);
  if (l1 < 1e-6 || l2 < 1e-6) return null;
  u1 = [u1[0] / l1, u1[1] / l1]; u2 = [u2[0] / l2, u2[1] / l2];
  const dot = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]));
  const theta = Math.acos(dot);
  if (theta < 1e-4 || Math.abs(theta - Math.PI) < 1e-4) return null; // 일직선
  let tanDist = radius / Math.tan(theta / 2);
  const maxT = Math.min(l1, l2) * 0.999; if (tanDist > maxT) tanDist = maxT; // 변 길이 초과 클램프
  const effR = tanDist * Math.tan(theta / 2);
  const t1 = [apex[0] + u1[0] * tanDist, apex[1] + u1[1] * tanDist];
  const t2 = [apex[0] + u2[0] * tanDist, apex[1] + u2[1] * tanDist];
  let bis = [u1[0] + u2[0], u1[1] + u2[1]]; const bl = Math.hypot(bis[0], bis[1]) || 1; bis = [bis[0] / bl, bis[1] / bl];
  const cen = [apex[0] + bis[0] * effR / Math.sin(theta / 2), apex[1] + bis[1] * effR / Math.sin(theta / 2)];
  const a1 = Math.atan2(t1[1] - cen[1], t1[0] - cen[0]), a2 = Math.atan2(t2[1] - cen[1], t2[0] - cen[0]);
  let da = a2 - a1; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
  const steps = Math.max(2, Math.round(Math.abs(da) / (Math.PI / 16))); // ~11° 간격
  const arc = [];
  for (let k = 0; k <= steps; k++) { const a = a1 + da * k / steps; arc.push([cen[0] + effR * Math.cos(a), cen[1] + effR * Math.sin(a)]); }
  return arc; // arc[0]≈t1, arc[끝]≈t2
}
// 결과 점들이 원래 형태의 경계상자를 크게 벗어나면(뒤집힘/스파이크) true
function filletFlipped(orig, now) {
  if (!orig.length) return false;
  let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
  for (const p of orig) { if (p[0] < bx0) bx0 = p[0]; if (p[0] > bx1) bx1 = p[0]; if (p[1] < by0) by0 = p[1]; if (p[1] > by1) by1 = p[1]; }
  const mx = (bx1 - bx0) * 0.3 + 1, my = (by1 - by0) * 0.3 + 1;
  return now.some(p => p[0] < bx0 - mx || p[0] > bx1 + mx || p[1] < by0 - my || p[1] > by1 + my);
}
// 폴리라인 두 변 모깎기 래퍼 — 결과가 형태를 크게 뒤집으면 되돌림(인접·비인접 무관 안전장치)
function filletPolyCorner(e, segA, segB, radius) {
  const orig = e.points.map(p => p.slice()), origClosed = e.closed;
  const ok = filletPolyCore(e, segA, segB, radius);
  if (ok && filletFlipped(orig, e.points)) {
    e.points = orig; e.closed = origClosed;
    logLine('  모깎기: 결과가 원래 형태를 크게 벗어나(뒤집힘) 취소했습니다. 한 꼭짓점에서 만나는(붙어 있는) 두 변을 선택하세요.', 'warn');
    return false;
  }
  return ok;
}
function filletPolyCore(e, segA, segB, radius) {
  const P = e.points, n = P.length;
  if (segA === segB) { logLine('  모깎기: 서로 다른 두 변을 클릭하세요.', 'warn'); return false; }
  // radius=0 이면 뾰족한 코너(연장/트림), radius>0 이면 둥근 모깎기 — 둘 다 허용(오토캐드식)
  // 인접: 한 꼭짓점을 공유 → 그 꼭짓점을 호로 교체
  const setA = new Set([segA, (segA + 1) % n]);
  const shared = [segB, (segB + 1) % n].filter(v => setA.has(v));
  if (shared.length === 1) {
    const vi = shared[0], Pp = P[(vi - 1 + n) % n], V = P[vi], Pn = P[(vi + 1) % n];
    const arc = filletArcPts(V, Pp, Pn, radius);
    if (!arc) { logLine('  이 꼭짓점은 모깎기할 수 없습니다.', 'warn'); return false; }
    const np = P.slice(); np.splice(vi, 1, ...arc); e.points = np;
    logLine(`  · 코너 (${Math.round(V[0])}, ${Math.round(V[1])}) 모깎기`, 'info');
    return true;
  }
  // 비인접: 두 변의 무한 직선 교점 X에서 모깎기. 두 변 사이의 "더 짧은 경로"(의도한 코너)를 접는다
  let sA = Math.min(segA, segB), sB = Math.max(segA, segB);
  const A0 = P[sA], A1 = P[(sA + 1) % n], B0 = P[sB], B1 = P[(sB + 1) % n];
  const X = lineInfIntersect(A0, A1, B0, B1);
  if (!X) { logLine('  두 변이 평행하여 모깎기할 수 없습니다.', 'warn'); return false; }
  // 비인접은 두 변이 실제로 "교차"(교점이 두 변 위, 매개변수 0~1)할 때만 허용.
  // 떨어져서 연장해야 만나는 두 변은 형태가 뒤집힘 → 거부하고 인접 두 변을 쓰도록 안내.
  const proj = (S0, S1, pt) => { const dx = S1[0] - S0[0], dy = S1[1] - S0[1]; const L2 = dx * dx + dy * dy || 1; return ((pt[0] - S0[0]) * dx + (pt[1] - S0[1]) * dy) / L2; };
  const tA = proj(A0, A1, X), tB = proj(B0, B1, X);
  if (!(tA > 0.02 && tA < 0.98 && tB > 0.02 && tB < 0.98)) {
    logLine('  모깎기: 한 꼭짓점에서 만나는(붙어 있는) 두 변, 또는 서로 교차하는 두 변을 선택하세요. (서로 떨어진 두 변은 형태가 뒤집혀 지원하지 않습니다)', 'warn');
    return false;
  }
  // 교차: 큰 쪽(본체)을 남기고 교차점 X를 코너로. 작은 쪽(교차 꼬리)만 제거 → 형태 유지(뒤집힘 없음)
  const middleCount = sB - sA;                                   // 중간 경로 P[sA+1..sB] 정점 수
  const outerCount = e.closed ? (n - middleCount) : (sA + 1 + (n - 1 - sB)); // 바깥 경로 정점 수
  if (outerCount >= middleCount) { // 바깥쪽이 큼 → 바깥 유지, 중간(작은 교차 루프) 제거
    const arc = filletArcPts(X, A0, B1, radius);
    if (!arc) { logLine('  이 두 변으로는 모깎기할 수 없습니다.', 'warn'); return false; }
    e.points = [...P.slice(0, sA + 1), ...arc, ...P.slice(sB + 1)];
  } else { // 중간(본체)이 큼 → 중간 유지, 바깥(작은 꼬리) 제거하고 X에서 닫음
    const arc = filletArcPts(X, B0, A1, radius);
    if (!arc) { logLine('  이 두 변으로는 모깎기할 수 없습니다.', 'warn'); return false; }
    e.points = [...P.slice(sA + 1, sB + 1), ...arc]; e.closed = true;
  }
  logLine(`  · 교차점 (${Math.round(X[0])}, ${Math.round(X[1])})에서 모깎기 (교차 정리)`, 'info');
  return true;
}

// ============================================================
//  SCALE (배율)
// ============================================================
function scaleEntities(ents, base, f) {
  const sp = (x, y) => [base.x + (x - base.x) * f, base.y + (y - base.y) * f];
  const af = Math.abs(f); // 크기 속성은 부호 없는 배율(음수 반지름 등 방지)
  const bz = (base && base.z != null) ? base.z : (typeof cplaneZ === 'function' ? cplaneZ() : 0); // z 기준(3D 균등 배율)
  for (const e of ents) {
    switch (e.type) {
      case 'MESH': meshXform(e, (x, y, z) => { const q = sp(x, y); return [q[0], q[1], bz + (z - bz) * f]; }); break; // 메시 3D 균등 배율
      case 'LINE': [e.x1, e.y1] = sp(e.x1, e.y1); [e.x2, e.y2] = sp(e.x2, e.y2); break;
      case 'LWPOLYLINE': e.points = e.points.map(p => sp(p[0], p[1])); break;
      case 'CIRCLE': case 'ARC': [e.cx, e.cy] = sp(e.cx, e.cy); e.r *= af; break;
      case 'TEXT': [e.x, e.y] = sp(e.x, e.y); e.height *= af; break;
      case 'HATCH': {
        const b = e.boundary;
        if (b.kind === 'circle') { [b.cx, b.cy] = sp(b.cx, b.cy); b.r *= af; }
        else b.points = b.points.map(p => sp(p[0], p[1]));
        e.spacing = (e.spacing || 5) * af; hatchDirty(e); break;
      }
      case 'INSERT': [e.x, e.y] = sp(e.x, e.y); e.sx = (e.sx != null ? e.sx : 1) * af; e.sy = (e.sy != null ? e.sy : 1) * af; break;
      case 'IMAGE': { const c = imgCenter(e), q = sp(c.x, c.y); e.w *= af; e.h *= af; imgSetCenter(e, q[0], q[1]); break; } // 중심 기준(회전 반영)
    }
  }
}

// ============================================================
//  STRETCH (신축)
// ============================================================
function stretchEntities(ents, box, dx, dy) {
  const inB = (x, y) => x >= box.xmin && x <= box.xmax && y >= box.ymin && y <= box.ymax;
  for (const e of ents) {
    switch (e.type) {
      case 'LINE': if (inB(e.x1, e.y1)) { e.x1 += dx; e.y1 += dy; } if (inB(e.x2, e.y2)) { e.x2 += dx; e.y2 += dy; } break;
      case 'LWPOLYLINE': e.points = e.points.map(p => inB(p[0], p[1]) ? [p[0] + dx, p[1] + dy] : p); break;
      case 'CIRCLE': case 'ARC': if (inB(e.cx, e.cy)) { e.cx += dx; e.cy += dy; } break;
      case 'TEXT': if (inB(e.x, e.y)) { e.x += dx; e.y += dy; } break;
      case 'HATCH': {
        const b = e.boundary;
        if (b.kind === 'circle') { if (inB(b.cx, b.cy)) { b.cx += dx; b.cy += dy; hatchDirty(e); } }
        else { b.points = b.points.map(p => inB(p[0], p[1]) ? [p[0] + dx, p[1] + dy] : p); hatchDirty(e); }
        break;
      }
    }
  }
}
function entitiesTouchingBox(box) {
  const inB = (x, y) => x >= box.xmin && x <= box.xmax && y >= box.ymin && y <= box.ymax;
  return state.entities.filter(e => {
    const l = getLayer(e.layer); if (l && (!l.visible || l.locked)) return false;
    return entityGrips(e).some(g => inB(g.x, g.y));
  });
}

// ============================================================
//  마우스 / 입력
// ============================================================
cv.addEventListener('mousemove', (ev) => {
  const r = cv.getBoundingClientRect();
  mouseScreen = { x: ev.clientX - r.left, y: ev.clientY - r.top };
  const raw = screenToWorld(mouseScreen.x, mouseScreen.y);
  mouseWorld = cursorPoint(raw);
  coordsEl.textContent = `X: ${mouseWorld.x.toFixed(2)}  Y: ${mouseWorld.y.toFixed(2)} ${settings.units}` + (activeSnap ? `   [${SNAP_KO[activeSnap.type]}]` : '');

  if (isPanning && panStart) {
    const dx = (ev.clientX - panStart.sx) / state.view.scale;
    const dy = (ev.clientY - panStart.sy) / state.view.scale;
    state.view.x = panStart.vx - dx;
    state.view.y = panStart.vy + dy;
  }
  if (toolPend) {
    if (!(ev.buttons & 1)) toolPend = null; // 버튼이 이미 놓임(창 밖 release 등) — 보류 취소
    else if (Math.hypot(ev.clientX - toolPend.sx, ev.clientY - toolPend.sy) > 5) {
      if (state.tool === '_zoomw') { // 줌 윈도: 드래그 = 확대할 영역 박스 (선택 아님)
        dragSelect = { x1: toolPend.rawW.x, y1: toolPend.rawW.y, x2: raw.x, y2: raw.y, zoomw: true };
        toolPend = null;
      } else {
        // 홀드-드래그 = 박스 선택 시작 (도구 동작은 실행하지 않음 — 선택은 어떤 상황에서도 가능)
        if (!toolPend.shift) state.selection.clear();
        dragSelect = { x1: toolPend.rawW.x, y1: toolPend.rawW.y, x2: raw.x, y2: raw.y };
        toolPend = null; renderProps();
      }
    }
  }
  if (dragSelect) { dragSelect.x2 = raw.x; dragSelect.y2 = raw.y; }
  if (imgGumDrag) updateImgGum(ev); // 이미지 검볼 드래그(축 이동·회전·배율)
  if (moveOp) {
    moveOp.dx = mouseWorld.x - moveOp.base.x; moveOp.dy = mouseWorld.y - moveOp.base.y;
    if (moveOp.grip) updateGripMove();
  }
  if (draft) updateDraft();
  if (cmdOp || state.tool === 'insert') updateCmdPreview();
  scheduleDraw(); // 호버 재렌더는 rAF당 1회로 코얼레싱 — 대형 도면에서 이벤트 폭주 시 프레임 드랍 방지
});
let drawQueued = false;
function scheduleDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(); });
}

// 라이노처럼 뷰포트를 클릭하면 그 뷰가 활성이 된다. 평면 칸은 #cv 가 이벤트를 받으므로
// (3D 쪽 vpAt 전환 로직이 못 본다) 여기서 대칭으로 처리한다. 2D 편집 동작에는 관여하지 않는다.
cv.addEventListener('pointerdown', () => {
  if (typeof v3 === 'undefined' || !v3 || !is3DActive()) return;
  const i = vpPlanIndex();
  if (i >= 0 && v3.act !== i) { v3.act = i; saveV3Layout(); render3D(); }
});
cv.addEventListener('mousedown', (ev) => {
  lastInputWasTouch = false;
  if (ev.button === 1 || (ev.button === 0 && ev.altKey) || (ev.button === 0 && state.tool === 'pan')) {  // 중간버튼/Alt/손 도구 = 팬
    isPanning = true;
    panStart = { sx: ev.clientX, sy: ev.clientY, vx: state.view.x, vy: state.view.y };
    ev.preventDefault(); return;
  }
  if (ev.button === 2) return; // 우클릭은 contextmenu에서 처리
  if (ev.button !== 0) return;
  if (state.tool !== 'select') {
    // 도구 활성 중엔 동작을 보류: 제자리 클릭이면 mouseup에서 도구 동작, 드래그면 박스 선택으로 전환
    toolPend = { w: mouseWorld, rawW: screenToWorld(mouseScreen.x, mouseScreen.y), shift: ev.shiftKey, sx: ev.clientX, sy: ev.clientY };
    return;
  }
  handleClick(mouseWorld, screenToWorld(mouseScreen.x, mouseScreen.y), ev);
});

window.addEventListener('mouseup', (ev) => {
  if (isPanning) { isPanning = false; return; }
  if (imgGumDrag) { imgGumDrag = null; renderProps(); draw(); return; } // 검볼 드래그 종료

  if (toolPend) { const tp = toolPend; toolPend = null; handleClick(tp.w, tp.rawW, { shiftKey: tp.shift }); } // 보류된 도구 클릭 실행 (제자리 클릭)
  if (dragSelect) finishDragSelect(ev);
  if (moveOp && state.tool === 'select') finishGripMoveMaybe();
});

// 우클릭/두 손가락 탭: 작도 중이면 완료/취소, 아니면 선택 도구로
function contextAction() {
  if (state.tool === 'trim' && cmdOp && cmdOp.name === 'trim') { trimSpaceAction(); return; } // 우클릭=Space
  if (pts.length) { if (state.tool === 'spline') finishSpline(false); else finishPolyline(); }
  else if (draft) { cancelDraft(); }
  else { setTool('select'); }
}
cv.addEventListener('contextmenu', (ev) => { ev.preventDefault(); contextAction(); });

// 더블클릭: 문자 편집 / 선택된 폴리라인의 정점 삭제
cv.addEventListener('dblclick', () => {
  if (state.tool !== 'select') return;
  const rW = screenToWorld(mouseScreen.x, mouseScreen.y), tol = 8 / state.view.scale;
  const hit = pick(mouseWorld, rW);
  if (hit && hit.type === 'TEXT') { // 문자 더블클릭 = 즉시 편집
    const nt = prompt('문자 내용:', hit.text);
    if (nt !== null && nt !== hit.text) { pushUndo(); hit.text = nt; logLine('  ✔ 문자 수정', 'ok'); renderProps(); draw(); }
    return;
  }
  if (!hit || hit.type !== 'LWPOLYLINE' || !state.selection.has(hit.id)) return;
  const g = nearGrip(hit, rW, tol) || nearGrip(hit, mouseWorld, tol);
  if (!g) return;
  const minPts = hit.closed ? 3 : 2;
  if (hit.points.length <= minPts) { logLine('  정점을 더 삭제할 수 없습니다.', 'warn'); return; }
  moveOp = null;
  pushUndo();
  hit.points.splice(g.index, 1);
  logLine('  ✔ 정점 삭제 (더블클릭)', 'ok');
  renderProps(); draw();
});

cv.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const before = screenToWorld(mouseScreen.x, mouseScreen.y);
  // 델타 크기에 비례한 부드러운 줌 (한 칸 ≈ ×1.06) — 트랙패드·고해상 휠 과민 반응 방지
  const factor = Math.pow(1.06, -(ev.deltaMode === 1 ? ev.deltaY * 33 : ev.deltaY) / 100);
  state.view.scale = Math.max(1e-4, Math.min(1e6, state.view.scale * factor));
  const after = screenToWorld(mouseScreen.x, mouseScreen.y);
  state.view.x += before.x - after.x;
  state.view.y += before.y - after.y;
  draw();
}, { passive: false });

// ============================================================
//  터치(모바일/태블릿) 입력
//  한 손가락 탭 = 클릭 · 한 손가락 드래그 = 화면 이동
//  두 손가락 = 확대/축소 + 이동 · 두 손가락 탭 = 완료/취소(우클릭)
// ============================================================
// 포인터 위치 갱신(마우스 이동과 동일한 미리보기 처리). 패닝/드래그선택 제외.
function setPointer(sx, sy) {
  mouseScreen = { x: sx, y: sy };
  const raw = screenToWorld(sx, sy);
  mouseWorld = cursorPoint(raw);
  coordsEl.textContent = `X: ${mouseWorld.x.toFixed(2)}  Y: ${mouseWorld.y.toFixed(2)} ${settings.units}` + (activeSnap ? `   [${SNAP_KO[activeSnap.type]}]` : '');
  if (moveOp) { moveOp.dx = mouseWorld.x - moveOp.base.x; moveOp.dy = mouseWorld.y - moveOp.base.y; if (moveOp.grip) updateGripMove(); }
  if (draft) updateDraft();
  if (cmdOp || state.tool === 'insert') updateCmdPreview();
}
let touch = null;  // {mode:'tap'|'pan'|'pinch'|'twotap', ...}
function touchXY(t) { const r = cv.getBoundingClientRect(); return { x: t.clientX - r.left, y: t.clientY - r.top }; }
function touchMid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
function touchDist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

// 터치 삭제 — 선택한 개체를 길게 누르면 손끝 옆에 🗑 이 떠서, 끌어다 놓으면 지운다
// (iPad: 키보드 없이 Delete 를 대신한다. 다중 선택 시 선택 전체 삭제)
let trashEl = null;
function showTouchTrash(cx2, cy2) {
  if (!trashEl) {
    trashEl = document.createElement('div');
    trashEl.id = 'touchTrash';
    trashEl.style.cssText = 'position:fixed;z-index:60;width:44px;height:44px;border-radius:50%;'
      + 'display:flex;align-items:center;justify-content:center;font-size:20px;'
      + 'background:rgba(20,28,50,.95);border:1.5px solid rgba(224,79,79,.85);'
      + 'box-shadow:0 4px 14px rgba(0,0,0,.45);pointer-events:none;transition:transform .1s ease;';
    trashEl.textContent = '🗑';
    document.body.appendChild(trashEl);
  }
  const x = Math.min(window.innerWidth - 30, Math.max(30, cx2 + 56));
  const y = Math.min(window.innerHeight - 30, Math.max(30, cy2 - 56));
  trashEl.style.left = (x - 22) + 'px'; trashEl.style.top = (y - 22) + 'px';
  trashEl.style.display = 'flex';
  trashEl.style.transform = ''; trashEl.style.background = 'rgba(20,28,50,.95)';
}
function trashHitAt(cx2, cy2) {
  if (!trashEl || trashEl.style.display === 'none') return false;
  const r = trashEl.getBoundingClientRect();
  return cx2 >= r.left - 8 && cx2 <= r.right + 8 && cy2 >= r.top - 8 && cy2 <= r.bottom + 8;
}
function hideTouchTrash() { if (trashEl) trashEl.style.display = 'none'; }
cv.addEventListener('touchstart', (ev) => {
  ev.preventDefault();
  lastInputWasTouch = true;
  if (ev.touches.length === 1) {
    const t0 = ev.touches[0];
    const p = touchXY(t0);
    setPointer(p.x, p.y);
    touch = { mode: 'tap', sx: p.x, sy: p.y, sworld: screenToWorld(p.x, p.y), moved: 0,
      vx: state.view.x, vy: state.view.y, cx: t0.clientX, cy: t0.clientY };
    // 홀드(≈1초): 선택된 개체 위 = 🗑 드래그 삭제, 빈 곳 = 박스 선택 (피그마식)
    touch.lpTimer = setTimeout(() => {
      if (touch && touch.mode === 'tap' && touch.moved <= 12) {
        const hit = state.selection.size ? pick(touch.sworld, touch.sworld) : null;
        if (hit && state.selection.has(hit.id)) {
          touch.mode = 'trash';
          showTouchTrash(touch.cx, touch.cy);
          return;
        }
        state.selection.clear();
        dragSelect = { x1: touch.sworld.x, y1: touch.sworld.y, x2: touch.sworld.x, y2: touch.sworld.y };
        touch.mode = 'boxsel';
        renderProps(); draw();
      }
    }, 800);
    draw();
  } else if (ev.touches.length === 2) {
    if (touch && touch.lpTimer) clearTimeout(touch.lpTimer);   // 두 손가락 = 핀치 — 홀드 제스처 취소
    if (dragSelect && touch && touch.mode === 'boxsel') dragSelect = null;
    if (touch && touch.mode === 'trash') hideTouchTrash();
    const a = touchXY(ev.touches[0]), b = touchXY(ev.touches[1]);
    touch = { mode: 'pinch', startDist: touchDist(a, b) || 1, startScale: state.view.scale,
      mid: touchMid(a, b), vx: state.view.x, vy: state.view.y, moved: 0 };
  }
}, { passive: false });

cv.addEventListener('touchmove', (ev) => {
  ev.preventDefault();
  if (!touch) return;
  if (ev.touches.length === 1 && touch.mode !== 'pinch') {
    const t0 = ev.touches[0];
    const p = touchXY(t0);
    touch.moved = Math.max(touch.moved, Math.hypot(p.x - touch.sx, p.y - touch.sy));
    if (touch.mode === 'trash') {                      // 🗑 로 끌어다 놓으면 삭제
      touch.cx = t0.clientX; touch.cy = t0.clientY;
      const hot = trashHitAt(t0.clientX, t0.clientY);
      if (trashEl) {
        trashEl.style.transform = hot ? 'scale(1.3)' : '';
        trashEl.style.background = hot ? 'rgba(224,79,79,.92)' : 'rgba(20,28,50,.95)';
      }
      return;                                          // 팬으로 전환하지 않는다
    }
    if (touch.mode === 'boxsel') {                     // 홀드 후 드래그 = 선택 박스
      const w = screenToWorld(p.x, p.y);
      dragSelect.x2 = w.x; dragSelect.y2 = w.y;
      setPointer(p.x, p.y); draw(); return;
    }
    // 한 손가락 드래그 = 화면 이동(팬). 영역 선택은 홀드(≈1초) 후 드래그.
    if (touch.mode === 'tap' && touch.moved > 12) { touch.mode = 'pan'; clearTimeout(touch.lpTimer); }
    if (touch.mode === 'pan') {
      const dx = (p.x - touch.sx) / state.view.scale;
      const dy = (p.y - touch.sy) / state.view.scale;
      state.view.x = touch.vx - dx;
      state.view.y = touch.vy + dy;
    }
    setPointer(p.x, p.y);
    draw();
  } else if (ev.touches.length === 2) {
    const a = touchXY(ev.touches[0]), b = touchXY(ev.touches[1]);
    const mid = touchMid(a, b), dist = touchDist(a, b);
    touch.moved = (touch.moved || 0) + Math.abs(dist - touch.startDist);
    // 중점 기준 확대/축소
    const before = screenToWorld(mid.x, mid.y);
    state.view.scale = Math.max(1e-4, Math.min(1e6, touch.startScale * (dist / touch.startDist)));
    const after = screenToWorld(mid.x, mid.y);
    state.view.x += before.x - after.x;
    state.view.y += before.y - after.y;
    // 중점 이동분만큼 팬
    if (touch.mid) {
      state.view.x -= (mid.x - touch.mid.x) / state.view.scale;
      state.view.y += (mid.y - touch.mid.y) / state.view.scale;
    }
    touch.mid = mid;
    draw();
  }
}, { passive: false });

cv.addEventListener('touchend', (ev) => {
  ev.preventDefault();
  if (!touch) return;
  if (touch.lpTimer) clearTimeout(touch.lpTimer);
  if (touch.mode === 'trash') {                        // 🗑 위에서 놓으면 선택 전체 삭제
    const t0 = ev.changedTouches && ev.changedTouches[0];
    const fx = t0 ? t0.clientX : touch.cx, fy = t0 ? t0.clientY : touch.cy;
    const hot = trashHitAt(fx, fy);
    hideTouchTrash();
    if (hot) deleteSelection();
    if (ev.touches.length === 0) { touch = null; return; }
  } else if (touch.mode === 'boxsel') {                // 홀드-드래그 선택 확정
    if (dragSelect) finishDragSelect({ shiftKey: false });
    if (ev.touches.length === 0) { touch = null; return; }
  } else if (touch.mode === 'tap' && touch.moved <= 12) {
    // 탭 = 클릭 (마우스 down+up 과 동일하게 정리)
    handleClick(mouseWorld, screenToWorld(mouseScreen.x, mouseScreen.y), { shiftKey: false });
    if (dragSelect) finishDragSelect({ shiftKey: false });
    if (moveOp && state.tool === 'select') finishGripMoveMaybe();
    // 치수 입력 가능 상태가 되면 이 탭(사용자 제스처) 안에서 즉시 포커스 → iOS 키보드 표시
    if (currentDimPrompt() && cmdInputEl) cmdInputEl.focus({ preventScroll: true });
  } else if (touch.mode === 'pinch' && touch.moved < 10 && ev.touches.length === 0) {
    // 두 손가락 가벼운 탭 = 우클릭(완료/취소)
    contextAction();
  }
  // 남은 손가락이 있으면 제스처 재설정
  if (ev.touches.length === 1) {
    const p = touchXY(ev.touches[0]);
    touch = { mode: 'pan', sx: p.x, sy: p.y, moved: 99, vx: state.view.x, vy: state.view.y };
  } else if (ev.touches.length === 0) {
    touch = null;
  }
}, { passive: false });

// 클릭 처리 (도구별)
function handleClick(w, rawW, ev) {
  if (state.tool === '_paste' && cmdOp && cmdOp.name === 'paste') { doPaste(w); return; }
  if (state.tool === '_zoomw') { // 줌 윈도: 두 모서리 클릭도 지원 (드래그와 같은 결과)
    if (!cmdOp || cmdOp.name !== 'zoomw') { cmdOp = { name: 'zoomw', p1: { x: rawW.x, y: rawW.y } }; setPrompt('줌: 반대 모서리를 클릭하세요 (드래그도 가능) · Esc 취소'); return; }
    const zp1 = cmdOp.p1; cmdOp = null;
    applyZoomWindow({ x1: zp1.x, y1: zp1.y, x2: rawW.x, y2: rawW.y });
    return;
  }
  if (state.tool === '_plotregion') { // 플롯 영역 지정: 두 점
    if (!cmdOp || cmdOp.name !== 'plotrgn') { cmdOp = { name: 'plotrgn', p1: w }; setPrompt('플롯 영역: 반대 모서리를 클릭하세요.'); return; }
    const p1 = cmdOp.p1;
    plotRegion = { minX: Math.min(p1.x, w.x), minY: Math.min(p1.y, w.y), maxX: Math.max(p1.x, w.x), maxY: Math.max(p1.y, w.y) };
    cmdOp = null; const after = regionPickState && regionPickState.after; const prev = regionPickState ? regionPickState.prevTool : 'select';
    regionPickState = null; setTool(prev || 'select');
    logLine('  ✔ 플롯 영역 지정됨', 'info');
    if (after) after();
    return;
  }
  switch (state.tool) {
    case 'select': {
      const gp = imgGumHit(mouseScreen); // 검볼이 떠 있으면 검볼 조작이 최우선 (이미지 1개 선택 시에만 존재)
      if (gp && startImgGum(gp)) { draw(); return; }
      const tol = 8 / state.view.scale;
      const hit = pick(w, rawW);
      if (hit) {
        // 그립(끝점 등) 클릭 → 그 점만 늘리기. 본체 클릭은 선택만(통째 이동 안 함)
        const wasSelected = state.selection.has(hit.id);
        const grip = nearGrip(hit, rawW, tol) || nearGrip(hit, w, tol);
        if (!ev.shiftKey && !wasSelected) { state.selection.clear(); }
        state.selection.add(hit.id);
        if (hit.grp) for (const g of state.entities) if (g.grp === hit.grp) state.selection.add(g.id); // 그룹: 구성원 하나 = 전체 선택
        if (grip) { pushUndo(); moveOp = { gripEntity: hit, gripIndex: grip.index, base: w, dx: 0, dy: 0, grip: true }; }
        else if (wasSelected && hit.type === 'LWPOLYLINE') {
          // 선택된 폴리라인의 세그먼트 중점 그립 → 정점 삽입 후 드래그
          const mg = nearMidGrip(hit, rawW, tol) || nearMidGrip(hit, w, tol);
          if (mg) {
            pushUndo();
            hit.points.splice(mg.index + 1, 0, [w.x, w.y]);
            moveOp = { gripEntity: hit, gripIndex: mg.index + 1, base: w, dx: 0, dy: 0, grip: true };
            logLine('  ✔ 정점 추가 (드래그로 위치 조정)', 'ok');
          }
        }
        renderProps(); draw();
      } else {
        if (!ev.shiftKey) state.selection.clear();
        dragSelect = { x1: rawW.x, y1: rawW.y, x2: rawW.x, y2: rawW.y };
        renderProps(); draw();
      }
      break;
    }
    case 'line':
      if (!draft) { pushUndo(); draft = { type: 'LINE', x1: w.x, y1: w.y, x2: w.x, y2: w.y }; }
      else if (Math.hypot(w.x - draft.x1, w.y - draft.y1) > 1e-9) {
        draft.x2 = w.x; draft.y2 = w.y;
        commitDraft();                                   // 구간 확정
        pushUndo(); draft = { type: 'LINE', x1: w.x, y1: w.y, x2: w.x, y2: w.y }; // 끝점에서 이어 그리기
      }
      break;
    case 'pline':
    case 'spline': // 자유곡선: 제어점 연속 클릭 → Enter/우클릭으로 확정(부드럽게 통과)
      pts.push({ x: w.x, y: w.y, z: w.z }); // z = 표면 스냅 높이 (없으면 undefined → 작업면 z)
      break;
    case 'rect':
      if (!draft) { pushUndo(); draft = { type: 'LWPOLYLINE', closed: true, points: [], _base: { x: w.x, y: w.y } }; }
      else { commitDraft(); }
      break;
    case 'circle':
      if (!draft) { pushUndo(); draft = { type: 'CIRCLE', cx: w.x, cy: w.y, r: 0 }; }
      else { commitDraft(); }
      break;
    case 'arc':
      handleArcClick(w);
      break;
    case 'text': {
      const t = prompt('문자 입력:', '');
      if (t) { pushUndo(); addEntity({ type: 'TEXT', x: w.x, y: w.y, height: state.textHeight, text: t, rotation: 0 }); updateStat(); }
      draw();
      break;
    }
    case 'move': {
      if (!moveOp) {
        // 이미 선택된 도형이 있으면 첫 클릭 = 기준점(빈 곳도 OK). 없으면 도형을 집어서 시작.
        if (!state.selection.size) { const hit = pick(w, rawW); if (hit) state.selection.add(hit.id); }
        if (state.selection.size) {
          pushUndo();
          moveOp = { entities: [...state.selection], base: w, dx: 0, dy: 0, twoClick: true };
          setPrompt('이동: 이동점을 클릭하거나 거리·좌표(@dx,dy / x,y / 거리)를 입력하세요.');
        }
      } else { // 두번째 클릭 = 이동 확정
        commitMove();
      }
      break;
    }
    case 'erase': {
      const hit = pick(w, rawW);
      if (hit) { pushUndo(); state.entities = state.entities.filter(e => e !== hit); state.selection.delete(hit.id); updateStat(); draw(); }
      break;
    }
    case 'offset': clickOffset(w, rawW); break;
    case 'copy': clickCopy(w, rawW); break;
    case 'mirror': clickMirror(w, rawW); break;
    case 'rotate': clickRotate(w, rawW); break;
    case 'array': clickArray(w, rawW); break;
    case 'trim': clickTrim(w, rawW); break;
    case 'extend': clickExtend(w, rawW); break;
    case 'fillet': clickFillet(w, rawW); break;
    case 'scale': clickScale(w, rawW); break;
    case 'stretch': clickStretch(w, rawW); break;
    case 'polygon': clickPolygon(w); break;
    case 'ellipse': clickEllipse(w); break;
    case 'chamfer': clickChamfer(w, rawW); break;
    case 'dim': clickDim(w); break;
    case 'dimbase': clickDimBase(w); break;
    case 'dist': clickDist(w); break;
    case 'area': clickArea(w, rawW); break;
    case 'break': clickBreak(w, rawW); break;
    case 'lengthen': clickLengthen(w, rawW); break;
    case 'hatch': clickHatch(w, rawW); break;
    case 'insert': clickInsert(w); break;
    case 'matchprop': clickMatchprop(w, rawW); break;
    case 'dimrad': clickDimCircle(w, rawW, false); break;
    case 'dimdia': clickDimCircle(w, rawW, true); break;
    case 'dimang': clickDimAng(w, rawW); break;
    case 'divide': clickDivide(w, rawW); break;
    case 'measure': clickMeasure(w, rawW); break;
    case 'leader': clickLeader(w); break;
    case 'centerline': clickCenterline(w, rawW); break;
    case 'revcloud': clickRevcloud(w); break;
    case 'frame': clickFrame(w); break;
    case 'align': clickAlign(w, rawW); break;
    case 'xline': clickXline(w); break;
    case 'breakpt': clickBreakpt(w, rawW); break;
    case 'door': clickOpening(w, rawW, 'door'); break;
    case 'window': clickOpening(w, rawW, 'window'); break;
    case 'section': clickSection(w, false); break;
    case 'elevation': clickSection(w, true); break;
  }
  draw();
  // 명령 진행 중에는 명령행을 계속 활성 상태로 유지(치수 바로 입력). 터치는 키보드 팝업 방지로 제외.
  if (state.tool !== 'select' && cmdInputEl && !lastInputWasTouch) cmdInputEl.focus({ preventScroll: true });
}

// ====== 수정 명령: 선택 보장 헬퍼 ======
// 선택이 비어 있으면 클릭한 도형 하나를 잡고 false 반환(이번 클릭은 선택용으로 소비).
function ensureSelectionByClick(w, rawW) {
  if (state.selection.size) return true;
  const hit = pick(w, rawW);
  if (hit) { state.selection.add(hit.id); renderProps(); }
  return false;
}

// ====== OFFSET (간격복사) ======
function clickOffset(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'offset') cmdOp = { name: 'offset', step: 'select', target: null };
  if (cmdOp.step === 'select') {
    const hit = pick(w, rawW);
    if (hit) {
      if (hit.type === 'TEXT') { setPrompt('문자는 오프셋할 수 없습니다. 다른 도형을 선택하세요.'); return; }
      cmdOp.target = hit; cmdOp.step = 'side';
      state.selection.clear(); state.selection.add(hit.id); renderProps();
      setPrompt(`오프셋: 방향 쪽을 클릭하세요. (거리 ${offsetDist})`);
    }
  } else if (cmdOp.step === 'side') {
    const ne = offsetEntity(cmdOp.target, offsetDist, rawW);
    if (ne) { pushUndo(); addEntity(ne); logLine(`  ✔ 오프셋 거리 ${offsetDist}`, 'ok'); updateStat(); }
    cmdOp.step = 'select'; cmdOp.target = null;
    setPrompt(`오프셋: 도형을 선택하세요. (거리 ${offsetDist}, 숫자 입력으로 거리 변경)`);
  }
}

// ====== COPY (복사) ======
function clickCopy(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'copy') cmdOp = { name: 'copy', step: state.selection.size ? 'base' : 'pick' };
  if (cmdOp.step === 'pick') {
    if (ensureSelectionByClick(w, rawW)) {} // 선택됨
    if (state.selection.size) { cmdOp.step = 'base'; setPrompt('복사: 기준점을 클릭하세요.'); }
    return;
  }
  if (cmdOp.step === 'base') { cmdOp.base = w; cmdOp.step = 'dest'; setPrompt('복사: 붙여넣을 위치를 클릭하세요. (반복 가능, Esc로 종료)'); return; }
  if (cmdOp.step === 'dest') {
    pushUndo();
    const T = T_translate(w.x - cmdOp.base.x, w.y - cmdOp.base.y);
    const ents = selectedEntities();
    for (const e of ents) addEntity(transformedClone(e, T));
    logLine(`  ✔ 복사 ${ents.length}개`, 'ok');
    updateStat();
  }
}

// ====== MIRROR (대칭복사) ======
function clickMirror(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'mirror') cmdOp = { name: 'mirror', step: state.selection.size ? 'p1' : 'pick' };
  if (cmdOp.step === 'pick') {
    ensureSelectionByClick(w, rawW);
    if (state.selection.size) { cmdOp.step = 'p1'; setPrompt('대칭: 대칭축의 첫 점을 클릭하세요.'); }
    return;
  }
  if (cmdOp.step === 'p1') { cmdOp.p1 = w; cmdOp.step = 'p2'; setPrompt('대칭: 대칭축의 두 번째 점을 클릭하세요.'); return; }
  if (cmdOp.step === 'p2') {
    pushUndo();
    const T = T_mirror(cmdOp.p1.x, cmdOp.p1.y, w.x, w.y);
    const ents = selectedEntities();
    for (const e of ents) addEntity(transformedClone(e, T));
    logLine(`  ✔ 대칭복사 ${ents.length}개`, 'ok');
    updateStat();
    cmdOp = null; previewEnts = null;
    setTool('select');
  }
}

// ====== ROTATE (회전) ======
function clickRotate(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'rotate') cmdOp = { name: 'rotate', step: state.selection.size ? 'base' : 'pick' };
  if (cmdOp.step === 'pick') {
    ensureSelectionByClick(w, rawW);
    if (state.selection.size) { cmdOp.step = 'base'; setPrompt('회전: 회전 중심(기준점)을 클릭하세요.'); }
    return;
  }
  if (cmdOp.step === 'base') {
    cmdOp.base = w; cmdOp.refAng = 0; cmdOp.step = 'angle';
    setPrompt('회전: 각도 지점을 클릭하거나 각도(°)를 입력하세요.');
    return;
  }
  if (cmdOp.step === 'angle') {
    const deg = ang(cmdOp.base.x, cmdOp.base.y, w.x, w.y);
    applyRotate(deg);
  }
}
function applyRotate(deg) {
  pushUndo();
  const T = T_rotate(cmdOp.base.x, cmdOp.base.y, deg);
  const ents = selectedEntities();
  for (const e of ents) applyTransform(e, T);
  logLine(`  ✔ 회전 ${(+deg).toFixed(1)}° (${ents.length}개)`, 'ok');
  cmdOp = null; previewEnts = null; renderProps(); updateStat();
  setTool('select');
}

// ====== ARRAY (배열) ======
function clickArray(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'array') {
    if (!state.selection.size) {
      const hit = pick(w, rawW);
      if (hit) { state.selection.add(hit.id); renderProps(); }
      if (!state.selection.size) { setPrompt('배열: 먼저 도형을 선택하세요.'); return; }
    }
    cmdOp = { name: 'array', step: 'dialog' };
    openArrayDialog();
    return;
  }
  if (cmdOp.step === 'center') { // 원형 배열 중심 클릭
    applyPolarArray(cmdOp.params, w);
    cmdOp = null; previewEnts = null; setTool('select');
  }
}
function applyRectArray(p) {
  pushUndo();
  const base = selectedEntities();
  for (let r = 0; r < p.rows; r++)
    for (let c = 0; c < p.cols; c++) {
      if (r === 0 && c === 0) continue;
      const T = T_translate(c * p.colSpace, r * p.rowSpace);
      for (const e of base) addEntity(transformedClone(e, T));
    }
  logLine(`  ✔ 직사각형 배열 ${p.rows}×${p.cols}`, 'ok');
  updateStat(); renderProps();
}
function applyPolarArray(p, center) {
  pushUndo();
  const base = selectedEntities();
  // 한 바퀴(360°)이거나 '끝각 제외'면 count로, 그 외 부채꼴은 count-1로 분할
  const full = Math.abs(Math.abs(p.total) - 360) < 0.01 || p.fill;
  const step = p.total / (full ? p.count : (p.count - 1 || 1));
  for (let k = 1; k < p.count; k++) {
    const T = T_rotate(center.x, center.y, step * k);
    for (const e of base) addEntity(transformedClone(e, T));
  }
  logLine(`  ✔ 원형 배열 ${p.count}개`, 'ok');
  updateStat(); renderProps();
}

// ====== TRIM (자르기) ======
function clickTrim(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'trim') cmdOp = { name: 'trim', phase: 'edges', edges: [] }; // 기본 = 기준선 선택
  // 기준선 선택 단계: 클릭 = 기준 객체 추가/해제(하이라이트)
  if (cmdOp.phase === 'edges') {
    const hit = pick(w, rawW);
    if (!hit || !['LINE', 'LWPOLYLINE', 'CIRCLE', 'ARC'].includes(hit.type)) { logLine('  기준선: 선/폴리라인/원/호를 클릭하세요.', 'warn'); return; }
    const i = cmdOp.edges.indexOf(hit);
    if (i >= 0) { cmdOp.edges.splice(i, 1); state.selection.delete(hit.id); }
    else { cmdOp.edges.push(hit); state.selection.add(hit.id); }
    renderProps();
    setPrompt(`자르기(기준선): ${cmdOp.edges.length}개 선택됨. 계속 클릭하거나 Space로 확정하세요.`);
    return;
  }
  // 자르기 실행: bounds=null이면 모든 객체 기준(빠른), 아니면 선택한 기준선만
  const bounds = cmdOp.phase === 'cut' ? cmdOp.edges : null;
  const hit = pick(w, rawW);
  if (!hit) return;
  if (bounds && bounds.indexOf(hit) >= 0) { logLine('  기준선 자체는 자를 수 없습니다.', 'warn'); return; }
  if (hit.type === 'LINE') { pushUndo(); if (trimLine(hit, rawW, bounds)) { logLine('  ✔ 선 자름', 'ok'); updateStat(); } }
  else if (hit.type === 'CIRCLE' || hit.type === 'ARC') { pushUndo(); if (trimCircleArc(hit, rawW, bounds)) { logLine('  ✔ 원/호 자름', 'ok'); } }
  else logLine('  자르기는 선/원/호만 지원합니다.', 'warn');
  if (cmdOp.phase !== 'cut') { state.selection.clear(); renderProps(); } // 기준선 모드에선 하이라이트 유지
}
// Space/Enter/우클릭으로 자르기 모드 전환: 빠른 → 기준선 선택 → (확정) 자르기 → 빠른
function trimSpaceAction() {
  if (!cmdOp || cmdOp.name !== 'trim') cmdOp = { name: 'trim', phase: 'edges', edges: [] }; // 기본 = 기준선 선택
  if (cmdOp.phase === 'quick') {
    cmdOp.phase = 'edges'; cmdOp.edges = [];
    state.selection.clear(); renderProps();
    setPrompt('자르기(기준선): 기준이 될 객체들을 클릭하고 Space로 확정하세요.');
    logLine('  ▷ 기준선 선택 모드 (Space=확정)', 'info');
  } else if (cmdOp.phase === 'edges') {
    if (cmdOp.edges.length) {
      cmdOp.phase = 'cut';
      setPrompt(`자르기: 기준선 ${cmdOp.edges.length}개에 걸치는 부분을 클릭하세요. (Space=기준선 재선택)`);
      logLine(`  ▷ 자르기 시작 — 기준선 ${cmdOp.edges.length}개`, 'info');
    } else {
      cmdOp.phase = 'quick';
      setPrompt('자르기(빠른): 잘라낼 부분을 클릭하세요. 모든 객체가 기준. (Space=기준선 모드)');
      logLine('  ▷ 빠른 모드 (모든 객체 기준)', 'info');
    }
  } else { // cut → 기준선 다시 선택
    cmdOp.phase = 'edges'; cmdOp.edges = [];
    state.selection.clear(); renderProps();
    setPrompt('자르기(기준선): 기준이 될 객체들을 클릭하고 Space로 확정하세요.');
    logLine('  ▷ 기준선 재선택', 'info');
  }
  draw();
}

// ====== EXTEND (연장) ======
function clickExtend(w, rawW) {
  const hit = pick(w, rawW);
  if (!hit) return;
  if (hit.type !== 'LINE') { logLine('  연장은 선(LINE)만 지원합니다.', 'warn'); return; }
  pushUndo(); if (extendLine(hit, rawW)) logLine('  ✔ 선 연장', 'ok');
}

// ====== FILLET (모깎기) ======
// 폴리라인 중복 정점 정리(모양 불변) — 필렛 세그먼트 판정 안정화
function dedupePoly(e) {
  if (e.type !== 'LWPOLYLINE' || !e.points) return;
  const out = [];
  for (const p of e.points) { const q = out[out.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) out.push([p[0], p[1]]); }
  if (out.length >= 3 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 1e-6) { out.pop(); e.closed = true; }
  if (out.length !== e.points.length) e.points = out;
}
function clickFillet(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'fillet') cmdOp = { name: 'fillet', step: 'l1', l1: null };
  const hit = pick(w, rawW);
  if (!hit || (hit.type !== 'LINE' && hit.type !== 'LWPOLYLINE')) { logLine('  모깎기: 선 또는 폴리라인의 변을 클릭하세요. (선택 도구 아님 — [모깎기] 활성 상태여야 함)', 'warn'); return; }
  if (hit.type === 'LWPOLYLINE') dedupePoly(hit);
  const seg = hit.type === 'LWPOLYLINE' ? nearestPolySeg(hit, rawW || w) : null; // 스냅 전 실제 클릭점으로 변 판정 (꼭짓점 스냅 시 오선택 방지)
  if (cmdOp.step === 'l1') { // 첫 번째 변
    cmdOp.l1 = hit; cmdOp.seg1 = seg; cmdOp.step = 'l2';
    cmdOp.w1 = { x: (rawW || w).x, y: (rawW || w).y };   // 클릭점 — 남길 쪽 판정(라이노식)
    state.selection.clear(); state.selection.add(hit.id); renderProps();
    setPrompt(`모깎기 R=${filletRadius}: 두 번째 변을 클릭하세요. (반지름 변경: 숫자 입력 후 Enter)`);
    logLine(`  ▷ 첫 번째 변 선택됨 — 두 번째 변을 클릭 (반지름 R=${filletRadius})`, 'info');
    return;
  }
  // 두 번째 변 — R=0이면 뾰족한 코너, R>0이면 둥글게 (오토캐드식: r 입력 전 기본은 뾰족)
  const R = filletRadius;
  const done = (okDone) => {
    if (okDone) logLine(`  ✔ 모깎기 ${R > 0 ? 'R=' + R + ' (둥글게)' : 'R=0 (뾰족한 코너)'} 완료`, 'ok');
    cmdOp = null; updateStat(); renderProps();
    const ov = document.getElementById('bim3d');
    if (ov && ov.style.display !== 'none' && typeof v3 !== 'undefined' && v3) { v3.solids = bimSolids(); render3D(); } // 3D 뷰 즉시 갱신
    setTool('select');
  };
  if (hit.type === 'LWPOLYLINE' && cmdOp.l1 === hit) { pushUndo(); done(filletPolyCorner(hit, cmdOp.seg1, seg, R)); return; } // 같은 폴리라인의 두 변
  if (hit.type === 'LINE' && cmdOp.l1.type === 'LINE') { if (hit === cmdOp.l1) return; pushUndo(); done(doFillet(cmdOp.l1, hit, R, cmdOp.w1, { x: (rawW || w).x, y: (rawW || w).y })); return; } // 두 개의 선 — 클릭한 쪽 유지
  logLine('  모깎기: 같은 폴리라인의 두 변, 또는 두 개의 선을 선택하세요. (선↔폴리라인 혼합은 아직 미지원)', 'warn');
}

// ====== SCALE (배율) ======
function clickScale(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'scale') cmdOp = { name: 'scale', step: state.selection.size ? 'base' : 'pick' };
  if (cmdOp.step === 'pick') {
    ensureSelectionByClick(w, rawW);
    if (state.selection.size) { cmdOp.step = 'base'; setPrompt('배율: 기준점을 클릭하세요.'); }
    return;
  }
  if (cmdOp.step === 'base') { cmdOp.base = w; cmdOp.step = 'ref'; setPrompt('배율: 배율(숫자)을 입력하거나, 참조 길이의 끝점을 클릭하세요.'); return; }
  if (cmdOp.step === 'ref') { cmdOp.ref = Math.hypot(w.x - cmdOp.base.x, w.y - cmdOp.base.y); cmdOp.step = 'new'; setPrompt('배율: 새 길이의 끝점을 클릭하세요.'); return; }
  if (cmdOp.step === 'new') {
    const nd = Math.hypot(w.x - cmdOp.base.x, w.y - cmdOp.base.y);
    applyScale(cmdOp.ref > 1e-9 ? nd / cmdOp.ref : 1);
  }
}
function applyScale(f) {
  if (!cmdOp || !cmdOp.base || !(f > 1e-9)) { logLine('  잘못된 배율입니다.', 'warn'); return; }
  pushUndo();
  scaleEntities(selectedEntities(), cmdOp.base, f);
  logLine(`  ✔ 배율 ×${(+f).toFixed(4).replace(/\.?0+$/, '')}`, 'ok');
  cmdOp = null; previewEnts = null; updateStat(); renderProps();
  setTool('select');
}

// ====== STRETCH (신축) ======
function clickStretch(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'stretch') cmdOp = { name: 'stretch', step: 'c1' };
  if (cmdOp.step === 'c1') { cmdOp.c1 = w; cmdOp.step = 'c2'; setPrompt('신축: 걸침 영역의 반대 모서리를 클릭하세요.'); return; }
  if (cmdOp.step === 'c2') {
    const box = { xmin: Math.min(cmdOp.c1.x, w.x), xmax: Math.max(cmdOp.c1.x, w.x), ymin: Math.min(cmdOp.c1.y, w.y), ymax: Math.max(cmdOp.c1.y, w.y) };
    cmdOp.box = box; cmdOp.ents = entitiesTouchingBox(box);
    if (!cmdOp.ents.length) { logLine('  영역 안에 신축할 점이 없습니다.', 'warn'); cmdOp = null; setTool('select'); return; }
    cmdOp.step = 'base'; setPrompt('신축: 기준점을 클릭하세요.'); return;
  }
  if (cmdOp.step === 'base') { cmdOp.base = w; cmdOp.step = 'dest'; setPrompt('신축: 이동점을 클릭하세요.'); return; }
  if (cmdOp.step === 'dest') {
    pushUndo();
    stretchEntities(cmdOp.ents, cmdOp.box, w.x - cmdOp.base.x, w.y - cmdOp.base.y);
    logLine(`  ✔ 신축 (${cmdOp.ents.length}개 도형)`, 'ok');
    cmdOp = null; previewEnts = null; updateStat(); renderProps();
    setTool('select');
  }
}

// ====== POLYGON (정다각형) ======
function clickPolygon(w) {
  if (!draft) {
    pushUndo();
    draft = { type: 'LWPOLYLINE', closed: true, points: [], _poly: { cx: w.x, cy: w.y } };
    setPrompt(`다각형(${polygonSides}변): 반지름을 입력하거나 꼭짓점을 클릭하세요.`);
  } else {
    updateDraft();
    if (draft.points.length >= 3) { commitDraft(); logLine(`  ✔ ${polygonSides}각형`, 'ok'); }
  }
}

// ====== ELLIPSE (타원) ======
function clickEllipse(w) {
  if (!draft) {
    pushUndo();
    draft = { type: 'LWPOLYLINE', closed: true, points: [], _ell: { cx: w.x, cy: w.y } };
    setPrompt('타원: 코너점을 클릭하거나 rx,ry를 입력하세요.');
  } else {
    updateDraft();
    commitDraft(); logLine('  ✔ 타원', 'ok');
  }
}

// ====== CHAMFER (모따기) ======
function clickChamfer(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'chamfer') cmdOp = { name: 'chamfer', step: 'l1', l1: null };
  const hit = pick(w, rawW);
  if (!hit || hit.type !== 'LINE') { logLine('  모따기는 두 개의 선을 선택해야 합니다.', 'warn'); return; }
  if (cmdOp.step === 'l1') {
    cmdOp.l1 = hit; cmdOp.step = 'l2';
    state.selection.clear(); state.selection.add(hit.id); renderProps();
    setPrompt('모따기: 두 번째 선을 클릭하세요.');
  } else {
    if (hit === cmdOp.l1) return;
    pushUndo();
    if (doChamfer(cmdOp.l1, hit, chamferDist)) logLine(`  ✔ 모따기 d=${chamferDist}`, 'ok');
    cmdOp = null; updateStat(); renderProps();
    setTool('select');
  }
}
function doChamfer(l1, l2, d) {
  const a1 = [l1.x1, l1.y1], b1 = [l1.x2, l1.y2];
  const a2 = [l2.x1, l2.y1], b2 = [l2.x2, l2.y2];
  const C = lineInfIntersect(a1, b1, a2, b2);
  if (!C) { logLine('  두 선이 평행하여 모따기할 수 없습니다.', 'warn'); return false; }
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const far1 = dist(C, a1) > dist(C, b1) ? a1 : b1, near1 = far1 === a1 ? 'b' : 'a';
  const far2 = dist(C, a2) > dist(C, b2) ? a2 : b2, near2 = far2 === a2 ? 'b' : 'a';
  const setNear = (ln, key, p) => { if (key === 'a') { ln.x1 = p[0]; ln.y1 = p[1]; } else { ln.x2 = p[0]; ln.y2 = p[1]; } };
  let u1 = [far1[0] - C[0], far1[1] - C[1]]; const n1 = Math.hypot(u1[0], u1[1]) || 1; u1 = [u1[0] / n1, u1[1] / n1];
  let u2 = [far2[0] - C[0], far2[1] - C[1]]; const n2 = Math.hypot(u2[0], u2[1]) || 1; u2 = [u2[0] / n2, u2[1] / n2];
  const t1 = [C[0] + u1[0] * d, C[1] + u1[1] * d];
  const t2 = [C[0] + u2[0] * d, C[1] + u2[1] * d];
  setNear(l1, near1, t1); setNear(l2, near2, t2);
  if (d > 1e-9) addEntity({ type: 'LINE', layer: state.currentLayer, x1: t1[0], y1: t1[1], x2: t2[0], y2: t2[1] });
  return true;
}

// ====== DIM (치수 기입 — 정렬 치수) ======
function clickDim(w) {
  if (!cmdOp || cmdOp.name !== 'dim') cmdOp = { name: 'dim', step: 'p1' };
  if (cmdOp.step === 'p1') { cmdOp.p1 = w; cmdOp.step = 'p2'; setPrompt('치수: 두 번째 점을 클릭하세요.'); return; }
  if (cmdOp.step === 'p2') { cmdOp.p2 = w; cmdOp.step = 'pos'; setPrompt('치수: 치수선 위치를 클릭하세요.'); return; }
  if (cmdOp.step === 'cont') { // 연속 치수: 직전 끝점에서 같은 오프셋으로 체인 기입
    const p1 = cmdOp.p1, p2 = w;
    const dx = p2.x - p1.x, dy = p2.y - p1.y, L = Math.hypot(dx, dy);
    if (L < 1e-9) return;
    const nx = -dy / L, ny = dx / L;
    const pos = { x: (p1.x + p2.x) / 2 + nx * cmdOp.h, y: (p1.y + p2.y) / 2 + ny * cmdOp.h };
    pushUndo();
    for (const e of computeDimension(p1, p2, pos)) addEntity(e);
    logLine(`  ✔ 치수 ${fmtNum(L)} (연속)`, 'ok');
    cmdOp = { name: 'dim', step: 'cont', p1: p2, h: cmdOp.h };
    previewEnts = null; updateStat(); return;
  }
  // pos: 치수선 위치 확정 → 연속 모드 진입
  pushUndo();
  for (const e of computeDimension(cmdOp.p1, cmdOp.p2, w)) addEntity(e);
  logLine(`  ✔ 치수 ${fmtNum(Math.hypot(cmdOp.p2.x - cmdOp.p1.x, cmdOp.p2.y - cmdOp.p1.y))}`, 'ok');
  const ddx = cmdOp.p2.x - cmdOp.p1.x, ddy = cmdOp.p2.y - cmdOp.p1.y, DL = Math.hypot(ddx, ddy) || 1;
  const h = (w.x - cmdOp.p1.x) * (-ddy / DL) + (w.y - cmdOp.p1.y) * (ddx / DL); // 부호 있는 오프셋
  cmdOp = { name: 'dim', step: 'cont', p1: cmdOp.p2, h };
  previewEnts = null;
  updateStat(); setPrompt('치수(연속): 다음 점을 클릭하면 이어서 기입됩니다. (Esc 종료)');
}
// 기준선 치수: 같은 기준점(p1)에서 여러 점까지, 한 단씩 띄워 기입 (연속 치수는 dim에 내장)
function clickDimBase(w) {
  if (!cmdOp || cmdOp.name !== 'dimbase') cmdOp = { name: 'dimbase', step: 'p1' };
  if (cmdOp.step === 'p1') { cmdOp.p1 = w; cmdOp.step = 'p2'; setPrompt('기준선 치수: 두 번째 점을 클릭하세요.'); return; }
  if (cmdOp.step === 'p2') { cmdOp.p2 = w; cmdOp.step = 'pos'; setPrompt('기준선 치수: 치수선 위치를 클릭하세요.'); return; }
  if (cmdOp.step === 'base') { // 기준점 고정 · 클릭할 때마다 한 단씩 바깥으로
    const p1 = cmdOp.p1, p2 = w;
    const dx = p2.x - p1.x, dy = p2.y - p1.y, L = Math.hypot(dx, dy);
    if (L < 1e-9) return;
    cmdOp.k = (cmdOp.k || 1) + 1;
    const h = cmdOp.h + Math.sign(cmdOp.h || 1) * dimTH() * 2.2 * (cmdOp.k - 1);
    const nx = -dy / L, ny = dx / L;
    const pos = { x: (p1.x + p2.x) / 2 + nx * h, y: (p1.y + p2.y) / 2 + ny * h };
    pushUndo();
    for (const e of computeDimension(p1, p2, pos)) addEntity(e);
    logLine(`  ✔ 치수 ${fmtNum(L)} (기준선 ${cmdOp.k}단)`, 'ok');
    previewEnts = null; updateStat(); return;
  }
  pushUndo(); // pos 확정 → 기준선 모드 진입
  for (const e of computeDimension(cmdOp.p1, cmdOp.p2, w)) addEntity(e);
  const ddx = cmdOp.p2.x - cmdOp.p1.x, ddy = cmdOp.p2.y - cmdOp.p1.y, DL = Math.hypot(ddx, ddy) || 1;
  const h = (w.x - cmdOp.p1.x) * (-ddy / DL) + (w.y - cmdOp.p1.y) * (ddx / DL);
  logLine(`  ✔ 치수 ${fmtNum(DL)} (기준선 시작)`, 'ok');
  cmdOp = { name: 'dimbase', step: 'base', p1: cmdOp.p1, h, k: 1 };
  previewEnts = null; updateStat();
  setPrompt('기준선 치수: 다음 점을 클릭하면 같은 기준점에서 한 단씩 띄워 기입됩니다. (Esc 종료)');
}
// 치수 그래픽(치수 레이어의 선·화살표·문자) 생성 — 미리보기/확정 공용
function computeDimension(p1, p2, pos) {
  ensureLayer('치수', '#5dff8f');
  const dx = p2.x - p1.x, dy = p2.y - p1.y, L = Math.hypot(dx, dy);
  if (L < 1e-9) return [];
  const ux = dx / L, uy = dy / L;
  let nx = -uy, ny = ux;
  let h = (pos.x - p1.x) * nx + (pos.y - p1.y) * ny;
  if (h < 0) { nx = -nx; ny = -ny; h = -h; }
  const th = dimTH(), ext = th * 0.4, gap = th * 0.25, s = Math.min(th * 0.6, L / 4);
  const ents = [];
  const ln = (x1, y1, x2, y2) => ents.push({ type: 'LINE', layer: '치수', x1, y1, x2, y2 });
  const d1 = { x: p1.x + nx * h, y: p1.y + ny * h }, d2 = { x: p2.x + nx * h, y: p2.y + ny * h };
  ln(p1.x + nx * gap, p1.y + ny * gap, p1.x + nx * (h + ext), p1.y + ny * (h + ext)); // 치수보조선 1
  ln(p2.x + nx * gap, p2.y + ny * gap, p2.x + nx * (h + ext), p2.y + ny * (h + ext)); // 치수보조선 2
  ln(d1.x, d1.y, d2.x, d2.y);                                                        // 치수선
  // 화살표 (양끝 V)
  ln(d1.x, d1.y, d1.x + ux * s + nx * s * 0.35, d1.y + uy * s + ny * s * 0.35);
  ln(d1.x, d1.y, d1.x + ux * s - nx * s * 0.35, d1.y + uy * s - ny * s * 0.35);
  ln(d2.x, d2.y, d2.x - ux * s + nx * s * 0.35, d2.y - uy * s + ny * s * 0.35);
  ln(d2.x, d2.y, d2.x - ux * s - nx * s * 0.35, d2.y - uy * s - ny * s * 0.35);
  // 문자 (읽기 방향 유지: 90°~270°는 뒤집기)
  const txt = dimVal(L);
  let rot = Math.atan2(uy, ux) * 180 / Math.PI;
  let tux = ux, tuy = uy;
  const rn = ((rot % 360) + 360) % 360;
  if (rn > 90 && rn <= 270) { rot -= 180; tux = -ux; tuy = -uy; }
  const tw = txt.length * th * 0.6;
  const mid = { x: (d1.x + d2.x) / 2, y: (d1.y + d2.y) / 2 };
  ents.push({ type: 'TEXT', layer: '치수', x: mid.x - tux * tw / 2 + nx * gap, y: mid.y - tuy * tw / 2 + ny * gap, height: th, text: txt, rotation: rot });
  return ents;
}

// ====== DIMRAD / DIMDIA (반지름·지름 치수) ======
function clickDimCircle(w, rawW, dia) {
  const name = dia ? 'dimdia' : 'dimrad';
  if (!cmdOp || cmdOp.name !== name) cmdOp = { name, step: 'obj' };
  if (cmdOp.step === 'obj') {
    const hit = pick(w, rawW);
    if (!hit || (hit.type !== 'CIRCLE' && hit.type !== 'ARC')) { logLine('  원 또는 호를 클릭하세요.', 'warn'); return; }
    cmdOp.target = hit; cmdOp.step = 'pos';
    setPrompt('치수: 문자 위치를 클릭하세요.'); return;
  }
  const e = cmdOp.target;
  pushUndo();
  ensureLayer('치수', '#5dff8f');
  const a = Math.atan2(w.y - e.cy, w.x - e.cx);
  const ex = e.cx + e.r * Math.cos(a), ey = e.cy + e.r * Math.sin(a); // 원 위의 점(화살표 위치)
  const sx = dia ? e.cx - e.r * Math.cos(a) : e.cx, sy = dia ? e.cy - e.r * Math.sin(a) : e.cy; // 지름은 반대편 가장자리부터
  const ln = (x1, y1, x2, y2) => addEntity({ type: 'LINE', layer: '치수', x1, y1, x2, y2 });
  ln(sx, sy, w.x, w.y); // 지시선
  // 원 가장자리 화살표(V) — 지시선 방향
  const th = dimTH(), s = th * 0.5;
  const ux = Math.cos(a), uy = Math.sin(a), nx = -uy, ny = ux;
  ln(ex, ey, ex - ux * s + nx * s * 0.35, ey - uy * s + ny * s * 0.35);
  ln(ex, ey, ex - ux * s - nx * s * 0.35, ey - uy * s - ny * s * 0.35);
  const txt = (dia ? '⌀' : 'R') + dimVal(dia ? e.r * 2 : e.r);
  addEntity({ type: 'TEXT', layer: '치수', x: w.x + th * 0.3, y: w.y - th * 0.3, height: th, text: txt, rotation: 0 });
  logLine(`  ✔ ${dia ? '지름' : '반지름'} 치수 ${txt}`, 'ok');
  cmdOp = { name, step: 'obj' }; updateStat();
  setPrompt('치수: 원/호를 클릭하세요. (연속 기입, Esc 종료)');
}

// ============================================================
//  BIM 1단계 — 2D 도형에 3D 속성(벽·슬래브·기둥·개구부) 부여
//  e.bim = {kind:'wall',h,t,base} | {kind:'slab',t,top} | {kind:'column',h,base}
//        | {kind:'opening',ot:'door'|'window',h,sill,t}
//  (클라우드/자동저장/실시간에 자동 포함. DXF에는 저장되지 않음)
// ============================================================
function bimAskNum(msg, def) {
  const v = prompt(msg, def);
  if (v === null) return null;
  const n = parseFloat(v);
  return (isFinite(n) && n > 0) ? n : null;
}
function cmdWallTag() {
  const sel = selectedEntities().filter(e => e.type === 'LINE' || e.type === 'LWPOLYLINE');
  if (!sel.length) { logLine('  벽: 선/폴리라인을 선택한 뒤 실행하세요.', 'warn'); return; }
  const lyW = getLayer(sel[0].layer); // 레이어 기본 높이/두께가 있으면 그것부터 제안 — 모델링도 레이어 설정을 따른다
  const h = bimAskNum('벽 높이 (mm):', (lyW && +lyW.defH > 0) ? +lyW.defH : settings.bim.wallH); if (h == null) return;
  const t = bimAskNum('벽 두께 (mm):', (lyW && +lyW.defT > 0) ? +lyW.defT : settings.bim.wallT); if (t == null) return;
  settings.bim.wallH = h; settings.bim.wallT = t; saveSettings();
  pushUndo();
  for (const e of sel) e.bim = { kind: 'wall', h, t, base: (e.bim && e.bim.base != null) ? e.bim.base : lvElev() };
  const onSrf = sel.filter(e => wallBaseZs(e)).length; // 표면 위 곡선·3D 선 = 바닥이 지형을 타는 벽
  logLine(`  ✔ 벽 지정 ${sel.length}개 (높이 ${h}, 두께 ${t}) — 평면에 두께 밴드로 표시` + (onSrf ? ` · ${onSrf}개는 곡선 높이를 따라 세워짐(바닥이 지형을 탐)` : ''), 'ok');
  renderProps(); draw();
}
function cmdSlabTag() {
  const sel = selectedEntities().filter(e => (e.type === 'LWPOLYLINE' && e.closed) || e.type === 'CIRCLE');
  if (!sel.length) { logLine('  슬래브: 닫힌 폴리라인(또는 원)을 선택한 뒤 실행하세요.', 'warn'); return; }
  const t = bimAskNum('슬래브 두께 (mm):', settings.bim.slabT); if (t == null) return;
  settings.bim.slabT = t; saveSettings();
  pushUndo();
  for (const e of sel) e.bim = { kind: 'slab', t, top: (e.bim && e.bim.top != null) ? e.bim.top : lvElev() };
  logLine(`  ✔ 슬래브 지정 ${sel.length}개 (두께 ${t})`, 'ok');
  renderProps(); draw();
}
function cmdColumnTag() {
  const sel = selectedEntities().filter(e => e.type === 'CIRCLE' || (e.type === 'LWPOLYLINE' && e.closed));
  if (!sel.length) { logLine('  기둥: 원 또는 닫힌 폴리라인을 선택한 뒤 실행하세요.', 'warn'); return; }
  const h = bimAskNum('기둥 높이 (mm):', settings.bim.colH); if (h == null) return;
  settings.bim.colH = h; saveSettings();
  pushUndo();
  for (const e of sel) e.bim = { kind: 'column', h, base: (e.bim && e.bim.base != null) ? e.bim.base : lvElev() };
  logLine(`  ✔ 기둥 지정 ${sel.length}개 (높이 ${h})`, 'ok');
  renderProps(); draw();
}
function cmdBimClear() {
  const sel = selectedEntities().filter(e => e.bim);
  if (!sel.length) { logLine('  BIM 해제: BIM 속성이 있는 도형을 선택하세요.', 'warn'); return; }
  pushUndo();
  for (const e of sel) delete e.bim;
  logLine(`  ✔ BIM 속성 해제 ${sel.length}개`, 'ok');
  renderProps(); draw();
}
// ─── 창호 표시기호 (KS) — 개구부 유형 사전 ───
// bim.wt(유형)·hinge(경첩: 0=x1쪽 끝, 1=x2쪽)·flip(0=기본 열림 방향, 1=반대쪽) — DXF·클라우드·실시간 자동 왕복
const OPENING_TYPES = {
  door: [['swing', '여닫이문'], ['dswing', '쌍여닫이문'], ['slide', '미서기문'], ['pocket', '미닫이문'],
         ['fold', '접이문'], ['dact', '자재문'], ['rev', '회전문']],
  window: [['fix', '붙박이창'], ['wswing', '여닫이창'], ['wslide', '미서기창'], ['hung', '오르내리창'],
           ['shutter', '셔터'], ['mesh', '망사창']],
};
const owTypeKo = (wt) => { for (const g of Object.values(OPENING_TYPES)) for (const [v, t] of g) if (v === wt) return t; return wt || ''; };
// 개구부의 유형 결정: 개체 지정 > 레이어 기본(defWt, 같은 계열만) > 기본(여닫이문/붙박이창)
function owWt(e) {
  if (e.bim && e.bim.wt) return e.bim.wt;
  const ly = getLayer(e.layer);
  const fam = OPENING_TYPES[e.bim.ot] || [];
  if (ly && ly.defWt && (ly.defWt.charCodeAt(0) === 64 || fam.some(([v]) => v === ly.defWt))) return ly.defWt; // '@커스텀'은 문·창 공용
  return e.bim.ot === 'door' ? 'swing' : 'fix';
}
// ─── 커스텀 창호 기호 라이브러리 (owlib) ───
// 사용자가 직접 그린 기호를 저장해 유형('@이름')으로 지정 — 표기 방법이 다른 사무소·개인의 자유도.
// 정규화 계약: 선택 중 '가장 긴 LINE' = 기준선(개구 구간). 기준선 시작→끝 = X축 0..1000,
// 기준선의 왼쪽 = +Y. 평면·3D 는 X 균등 스케일, 입면은 X=폭·Y=높이(elevH 기준) 비균등.
// 3D 부위: 닫힌 LWPOLYLINE/CIRCLE = 기둥(프리즘). 개체에 bim{h,base}(mm, 기준높이 2100)를 주면
// 그 구간만 — 없으면 개구 전체 높이.
function owSaveDef(name, part, ents) { // part: 'plan' | 'elev' | 'solid' — 저장 성공 시 true
  const lines = ents.filter(e2 => e2.type === 'LINE');
  if (!lines.length || ents.length < 2) return false;
  const bl = lines.reduce((a, b2) => (Math.hypot(a.x2 - a.x1, a.y2 - a.y1) >= Math.hypot(b2.x2 - b2.x1, b2.y2 - b2.y1) ? a : b2));
  const W = Math.hypot(bl.x2 - bl.x1, bl.y2 - bl.y1); if (W < 1e-6) return false;
  const ux = (bl.x2 - bl.x1) / W, uy = (bl.y2 - bl.y1) / W, k = 1000 / W;
  const toLocal = (x, y) => [((x - bl.x1) * ux + (y - bl.y1) * uy) * k, ((x - bl.x1) * -uy + (y - bl.y1) * ux) * k];
  const T = { type: 'move', pt: (x, y) => toLocal(x, y) };
  const out = [];
  let hMax = 0;
  for (const src of ents) {
    if (src === bl) continue;
    if (!['LINE', 'LWPOLYLINE', 'CIRCLE', 'ARC'].includes(src.type)) continue;
    const c2 = JSON.parse(JSON.stringify(src)); delete c2.id; delete c2.layer;
    applyTransform(c2, T);
    if (c2.type === 'CIRCLE' || c2.type === 'ARC') c2.r *= k;
    if (src.bim && (src.bim.h || src.bim.base)) c2.zb = (src.bim.base || 0) / 2100, c2.zh = (src.bim.h || 2100) / 2100; // 3D 높이 구간(기준 2100)
    delete c2.bim;
    out.push(c2);
    // 입면 높이 범위 (기준선 위쪽 최대 y)
    const ys = c2.type === 'LINE' ? [c2.y1, c2.y2] : c2.type === 'LWPOLYLINE' ? c2.points.map(p => p[1]) : [c2.cy + c2.r];
    for (const yv of ys) hMax = Math.max(hMax, yv);
  }
  if (!out.length) return false;
  if (!state.owlib) state.owlib = {};
  if (!state.owlib[name]) state.owlib[name] = {};
  state.owlib[name][part] = out;
  if (part === 'elev') state.owlib[name].elevH = Math.max(100, hMax);
  return true;
}
// 저장 기호 → 실제 개구부 프레임으로 변환된 사본 목록 (mirX=경첩 반전, mirY=열림 반전)
function owPlaced(defEnts, P1, ux, uy, sx, sy, mirX, mirY) {
  const nx = -uy, ny = ux;
  const T = { type: (!!mirX !== !!mirY) ? 'mirror' : 'move', axisDeg: 0,
    pt: (x, y) => {
      const lx = (mirX ? 1000 - x : x) * sx, ly = (mirY ? -y : y) * sy;
      return [P1[0] + ux * lx + nx * ly, P1[1] + uy * lx + ny * ly];
    } };
  const out = [];
  for (const d of defEnts) {
    let c2 = JSON.parse(JSON.stringify(d));
    if ((c2.type === 'CIRCLE' || c2.type === 'ARC') && Math.abs(sx - sy) > 1e-9) { // 비균등: 원·호 → 폴리라인 근사
      const n2 = 24, pts = [];
      const a0 = c2.type === 'ARC' ? c2.startAngle * Math.PI / 180 : 0;
      const a1 = c2.type === 'ARC' ? (((c2.endAngle - c2.startAngle) % 360 + 360) % 360 || 360) * Math.PI / 180 + a0 : Math.PI * 2 + a0;
      for (let i = 0; i <= n2; i++) { const t2 = a0 + (a1 - a0) * i / n2; pts.push([c2.cx + Math.cos(t2) * c2.r, c2.cy + Math.sin(t2) * c2.r]); }
      c2 = { type: 'LWPOLYLINE', points: pts, closed: c2.type === 'CIRCLE', color: c2.color, linetype: c2.linetype, zb: c2.zb, zh: c2.zh };
    }
    applyTransform(c2, T);
    if (c2.type === 'CIRCLE' || c2.type === 'ARC') c2.r *= sx;
    out.push(c2);
  }
  return out;
}
function cmdOwSave() {
  const sel = selectedEntities();
  if (sel.length < 2) { logLine('  창호저장: 기호 도형들 + 기준선(개구 구간을 나타내는 "가장 긴 선")을 함께 선택한 뒤 실행하세요.', 'warn'); return; }
  const name = prompt('창호 기호 이름:'); if (!name) return;
  const p = bimAskNum('부위 (1=평면, 2=입면, 3=3D):', 1); if (p == null) return;
  const part = p === 2 ? 'elev' : p === 3 ? 'solid' : 'plan';
  pushUndo();
  if (!owSaveDef(name, part, sel)) { logLine('  창호저장 실패 — 기준선(LINE) 1개 + 기호 도형 1개 이상이 필요합니다.', 'warn'); return; }
  logLine(`  ✔ 창호 기호 "${name}" ${part === 'plan' ? '평면' : part === 'elev' ? '입면' : '3D'} 저장 — 속성/레이어의 창호 선택에서 "@${name}" 으로 지정`, 'ok');
  renderProps(); renderLayers();
}
// ─── 레이어 목록 템플릿 — 저장/불러오기/파일 공유 (클라우드 슬롯 UI 는 cloud.js) ───
const LAYER_TPL_KEYS = ['name', 'color', 'linetype', 'lineweight', 'mat', 'role', 'defH', 'defT', 'defWt', 'secHatch', 'noplot'];
function layersTplData() {
  return state.layers.map(l => { const o = {}; for (const k of LAYER_TPL_KEYS) if (l[k] !== undefined) o[k] = l[k]; return o; });
}
function applyLayersTpl(layers) {
  if (!Array.isArray(layers) || !layers.length || !layers.every(l => l && l.name)) return false;
  pushUndo();
  const next = layers.map(l => Object.assign({ visible: true }, l));
  // 도형이 실제로 쓰는 레이어는 잃지 않는다 — 템플릿에 없으면 기존 것을 뒤에 보존
  const used = new Set(state.entities.map(e => e.layer));
  for (const nm of used) if (nm && !next.some(l => l.name === nm)) { const old = getLayer(nm); next.push(old ? { ...old } : { name: nm, color: '#ffffff', visible: true }); }
  if (!next.some(l => l.name === '0')) next.unshift({ name: '0', color: '#ffffff', visible: true });
  state.layers = next;
  if (!getLayer(state.currentLayer)) state.currentLayer = '0';
  for (const en of state.entities) applyLayerRoleTo(en);   // 새 목록의 역할·기본값 라이브 반영
  renderLayers(); propRefresh();
  return true;
}
function exportLayersTpl() {
  const nm = prompt('내보낼 목록 이름:', currentFileName || '내 레이어') || '레이어목록';
  saveBlob(new Blob([JSON.stringify({ parti_layers: 1, name: nm, layers: layersTplData() }, null, 1)], { type: 'application/json' }), nm + '.layers.json');
  logLine('  ✔ 레이어 목록을 파일로 내보냄 (.layers.json — 다른 사람과 공유 가능, 불러오기 → 파일에서 가져오기)', 'ok');
}
function importLayersTplFile() {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
  inp.addEventListener('change', () => {
    const f = inp.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        if (!d || d.parti_layers !== 1 || !Array.isArray(d.layers)) throw 0;
        if (applyLayersTpl(d.layers)) logLine(`  ✔ 레이어 목록 "${d.name || f.name}" 적용 (${d.layers.length}개) — 기존 목록 대체(도형이 쓰는 레이어는 유지)`, 'ok');
      } catch (e2) { logLine('  레이어 목록 파일이 아닙니다 (.layers.json)', 'warn'); }
    };
    r.readAsText(f);
  });
  inp.click();
}
function cmdOwList() {
  const ks = Object.keys(state.owlib || {});
  if (!ks.length) { logLine('  저장된 창호 기호가 없습니다. 기호를 그리고 선택 → 창호저장', 'info'); return; }
  for (const k of ks) {
    const d = state.owlib[k];
    logLine(`  @${k} — ${['plan', 'elev', 'solid'].filter(pp => d[pp]).map(pp => pp === 'plan' ? '평면' : pp === 'elev' ? '입면' : '3D').join('·') || '(비어 있음)'}`, 'info');
  }
}
function cmdOwDel(name) {
  if (!name || !state.owlib || !state.owlib[name]) { logLine('  창호삭제 <이름> — 창호목록 으로 이름 확인', 'warn'); return; }
  pushUndo(); delete state.owlib[name];
  logLine(`  ✔ 창호 기호 "@${name}" 삭제 — 이 기호를 쓰던 개구부는 기본 표기로 돌아갑니다`, 'ok');
  renderProps(); renderLayers(); propRefresh();
}
// 문/창: 벽 선 위 클릭 → 폭 입력 → 벽 방향의 개구부 세그먼트 생성
function clickOpening(w, rawW, ot) {
  const hit = pick(w, rawW);
  if (!hit || hit.type !== 'LINE' || !hit.bim || hit.bim.kind !== 'wall') {
    logLine(`  ${ot === 'door' ? '문' : '창'}: 먼저 wall 명령으로 벽 지정된 "선"을 클릭하세요.`, 'warn'); return;
  }
  const dx = hit.x2 - hit.x1, dy = hit.y2 - hit.y1, L = Math.hypot(dx, dy);
  if (L < 1e-9) return;
  const ux = dx / L, uy = dy / L;
  let s = ((w.x - hit.x1) * ux + (w.y - hit.y1) * uy); // 클릭점의 벽 위 위치
  const defW = ot === 'door' ? settings.bim.doorW : settings.bim.winW;
  const wid = bimAskNum(`${ot === 'door' ? '문' : '창'} 폭 (mm):`, defW); if (wid == null) return;
  if (ot === 'door') settings.bim.doorW = wid; else settings.bim.winW = wid;
  saveSettings();
  s = Math.max(wid / 2, Math.min(L - wid / 2, s)); // 벽 밖으로 안 나가게
  const cx = hit.x1 + ux * s, cy = hit.y1 + uy * s;
  pushUndo();
  ensureLayer('개구부', '#ff9f0a');
  const bim = ot === 'door'
    ? { kind: 'opening', ot: 'door', h: settings.bim.doorH, sill: 0, t: hit.bim.t }
    : { kind: 'opening', ot: 'window', h: settings.bim.winH, sill: settings.bim.winSill, t: hit.bim.t };
  addEntity({ type: 'LINE', layer: '개구부',
    x1: cx - ux * wid / 2, y1: cy - uy * wid / 2, x2: cx + ux * wid / 2, y2: cy + uy * wid / 2, bim });
  logLine(`  ✔ ${ot === 'door' ? '문' : '창'} (폭 ${wid}) — 속성 패널에서 높이·씰 수정 가능`, 'ok');
  renderLayers(); updateStat(); draw();
}
// 평면 BIM 오버레이 (벽 두께 밴드 / 슬래브·기둥 채움 / 개구부 표식)
function drawBimOverlay(e) {
  if (!e.bim) return;
  const k = e.bim.kind, sc = state.view.scale;
  ctx.save();
  if (k === 'wall' && (e.type === 'LINE' || e.type === 'LWPOLYLINE')) {
    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = entityColor(e);
    ctx.lineWidth = Math.max(1, e.bim.t * sc);
    ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
    ctx.beginPath();
    if (e.type === 'LINE') {
      const a = worldToScreen(e.x1, e.y1), b = worldToScreen(e.x2, e.y2);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    } else {
      e.points.forEach((p, i) => { const q = worldToScreen(p[0], p[1]); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
      const n2 = e.points.length; // 끝점=시작점 고리도 닫아 그린다 (3D 마이터 판정과 동일 허용치)
      if (e.closed || (n2 > 3 && Math.hypot(e.points[0][0] - e.points[n2 - 1][0], e.points[0][1] - e.points[n2 - 1][1]) < 0.5)) ctx.closePath();
    }
    ctx.stroke();
  } else if (k === 'opening' && e.type === 'LINE') {
    // 창호 표시기호(KS) — 유형(wt)별 평면 기호. 벽 밴드를 끊는 배경 밴드는 공통.
    const a = worldToScreen(e.x1, e.y1), b = worldToScreen(e.x2, e.y2);
    ctx.lineCap = 'butt';
    ctx.strokeStyle = getCSS('--canvas-bg') || '#0a1020';
    ctx.lineWidth = Math.max(2, (e.bim.t || 200) * sc + 2);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.strokeStyle = '#ff9f0a'; ctx.globalAlpha = 0.9;
    ctx.lineWidth = Math.max(1.5, (e.bim.ot === 'door' ? 2.2 : 1.6));
    const wt = owWt(e);
    // 월드 기하: P1→P2, 진행 u, 법선 n(flip 으로 반전), 경첩 H(hinge: 0=P1, 1=P2)
    const W = Math.hypot(e.x2 - e.x1, e.y2 - e.y1) || 1;
    const ux2 = (e.x2 - e.x1) / W, uy2 = (e.y2 - e.y1) / W;
    const fs = e.bim.flip ? -1 : 1;
    const nx2 = -uy2 * fs, ny2 = ux2 * fs;
    const P1 = [e.x1, e.y1], P2 = [e.x2, e.y2];
    const H = e.bim.hinge ? P2 : P1, F = e.bim.hinge ? P1 : P2;
    const S = (p) => worldToScreen(p[0], p[1]);
    const wline = (p, q) => { const s1 = S(p), s2 = S(q); ctx.moveTo(s1.x, s1.y); ctx.lineTo(s2.x, s2.y); };
    // 경첩 H 기준, F 방향에서 n 쪽으로 deg° 스윙하는 호 (월드 폴리라인 근사 — 화면 Y 반전 무관)
    const warc = (h, f, deg, rad) => {
      const r = rad != null ? rad : Math.hypot(f[0] - h[0], f[1] - h[1]);
      const a0 = Math.atan2(f[1] - h[1], f[0] - h[0]);
      const sgn = fs * (e.bim.hinge ? -1 : 1); // 스윙 방향: n 쪽으로
      for (let i = 0; i <= 16; i++) {
        const t2 = a0 + sgn * (deg * Math.PI / 180) * i / 16;
        const s2 = S([h[0] + Math.cos(t2) * r, h[1] + Math.sin(t2) * r]);
        i ? ctx.lineTo(s2.x, s2.y) : ctx.moveTo(s2.x, s2.y);
      }
    };
    const dash = (on) => ctx.setLineDash(on ? [5, 4] : []);
    const P = (p, du, dn) => [p[0] + ux2 * du + nx2 * dn, p[1] + uy2 * du + ny2 * dn]; // u/n 오프셋 헬퍼
    const off = Math.min((e.bim.t || 200) / 4, 60);
    const arrow = (p, q) => { // 화면 화살표 (q = 촉)
      const s1 = S(p), s2 = S(q), dxs = s2.x - s1.x, dys = s2.y - s1.y, Ls = Math.hypot(dxs, dys) || 1;
      const ax2 = dxs / Ls, ay2 = dys / Ls;
      ctx.moveTo(s1.x, s1.y); ctx.lineTo(s2.x, s2.y);
      ctx.moveTo(s2.x - ax2 * 6 - ay2 * 3.5, s2.y - ay2 * 6 + ax2 * 3.5); ctx.lineTo(s2.x, s2.y);
      ctx.lineTo(s2.x - ax2 * 6 + ay2 * 3.5, s2.y - ay2 * 6 - ax2 * 3.5);
    };
    // 커스텀 기호('@이름') — 사용자가 그려 저장한 평면 기호를 개구 프레임으로 변환해 그대로 그림
    if (wt.charCodeAt(0) === 64) {
      const defC = (state.owlib || {})[wt.slice(1)];
      if (defC && defC.plan) {
        for (const c2 of owPlaced(defC.plan, P1, ux2, uy2, W / 1000, W / 1000, !!e.bim.hinge, !!e.bim.flip)) {
          if (!c2.color) c2.color = '#ff9f0a';
          c2.layer = e.layer; drawEntity(c2, false);
        }
        ctx.globalAlpha = 0.9; return;
      } // plan 부위가 없으면 아래 기본 표기로 폴백
    }
    ctx.beginPath();
    const hs = e.bim.hinge ? -1 : 1; // H 에서 F 쪽 진행 부호
    if (wt === 'swing' || (wt.charCodeAt(0) === 64 && e.bim.ot === 'door')) { // 여닫이 (커스텀 문 폴백 포함 — 창 폴백은 아래 기본 이중선)
      wline(H, P(H, 0, W)); warc(H, F, 90);
    } else if (wt === 'dswing') {    // 쌍여닫이: 반반 두 짝
      const M = P(P1, W / 2, 0);
      wline(P1, P(P1, 0, W / 2)); warc(P1, M, e.bim.flip ? -90 : 90, W / 2);
      wline(P2, P(P2, 0, W / 2));
      { const a0 = Math.atan2(M[1] - P2[1], M[0] - P2[0]); const sg = e.bim.flip ? 1 : -1;
        for (let i = 0; i <= 16; i++) { const t2 = a0 + sg * (Math.PI / 2) * i / 16; const s2 = S([P2[0] + Math.cos(t2) * W / 2, P2[1] + Math.sin(t2) * W / 2]); i ? ctx.lineTo(s2.x, s2.y) : ctx.moveTo(s2.x, s2.y); } }
    } else if (wt === 'slide' || wt === 'wslide') { // 미서기: 어긋난 두 짝(+문이면 화살표)
      wline(P(P1, 0, off), P(P1, W * 0.58, off));
      wline(P(P2, 0, -off), P(P2, -W * 0.58, -off));
      if (wt === 'slide') { arrow(P(P1, W * 0.2, off * 2.2), P(P1, W * 0.45, off * 2.2)); arrow(P(P2, -W * 0.2, -off * 2.2), P(P2, -W * 0.45, -off * 2.2)); }
    } else if (wt === 'pocket') {    // 미닫이: 문짝 + 벽 속 점선
      wline(H, P(H, hs * W * 0.65, 0));
      ctx.stroke(); ctx.beginPath(); dash(true);
      wline(P(H, hs * W * 0.65, 0), F);
      ctx.stroke(); dash(false); ctx.beginPath();
      arrow(P(H, hs * W * 0.5, off * 2), P(H, hs * W * 0.2, off * 2));
    } else if (wt === 'fold') {      // 접이문: 지그재그
      const amp = Math.min((e.bim.t || 200) * 0.9, W / 5);
      const s0 = S(P1); ctx.moveTo(s0.x, s0.y);
      for (let i = 1; i <= 4; i++) { const s2 = S(P(P1, W * (i - 0.5) / 4, amp)); ctx.lineTo(s2.x, s2.y); const s3 = S(P(P1, W * i / 4, 0)); ctx.lineTo(s3.x, s3.y); }
    } else if (wt === 'dact') {      // 자재문: 양방향 호 (반대쪽은 점선)
      wline(H, P(H, 0, W)); warc(H, F, 90);
      ctx.stroke(); ctx.beginPath(); dash(true);
      wline(H, P(H, 0, -W));
      { const a0 = Math.atan2(F[1] - H[1], F[0] - H[0]); const sg = -fs * (e.bim.hinge ? -1 : 1);
        for (let i = 0; i <= 16; i++) { const t2 = a0 + sg * (Math.PI / 2) * i / 16; const s2 = S([H[0] + Math.cos(t2) * W, H[1] + Math.sin(t2) * W]); i ? ctx.lineTo(s2.x, s2.y) : ctx.moveTo(s2.x, s2.y); } }
      ctx.stroke(); dash(false); ctx.beginPath();
    } else if (wt === 'rev') {       // 회전문: 원 + X 날개
      const M = P(P1, W / 2, 0);
      for (let i = 0; i <= 24; i++) { const t2 = i / 24 * Math.PI * 2; const s2 = S([M[0] + Math.cos(t2) * W / 2, M[1] + Math.sin(t2) * W / 2]); i ? ctx.lineTo(s2.x, s2.y) : ctx.moveTo(s2.x, s2.y); }
      const d = W / 2 * 0.72;
      wline([M[0] + (ux2 + nx2) * d * 0.707, M[1] + (uy2 + ny2) * d * 0.707], [M[0] - (ux2 + nx2) * d * 0.707, M[1] - (uy2 + ny2) * d * 0.707]);
      wline([M[0] + (ux2 - nx2) * d * 0.707, M[1] + (uy2 - ny2) * d * 0.707], [M[0] - (ux2 - nx2) * d * 0.707, M[1] - (uy2 - ny2) * d * 0.707]);
    } else if (wt === 'wswing') {    // 여닫이창: 중심선 + 창짝 + 점선 호
      wline(P1, P2);
      const E = [H[0] + Math.cos(Math.atan2(F[1] - H[1], F[0] - H[0]) + fs * (e.bim.hinge ? -1 : 1) * 0.6) * W * 0.92,
                 H[1] + Math.sin(Math.atan2(F[1] - H[1], F[0] - H[0]) + fs * (e.bim.hinge ? -1 : 1) * 0.6) * W * 0.92];
      wline(H, E);
      ctx.stroke(); ctx.beginPath(); dash(true); warc(H, F, 34, W * 0.92); ctx.stroke(); dash(false); ctx.beginPath();
    } else if (wt === 'hung') {      // 오르내리창: 이중선 + ↑ 표시
      wline(P(P1, 0, off), P(P2, 0, off)); wline(P(P1, 0, -off), P(P2, 0, -off));
      arrow(P(P1, W / 2, off * 1.5), P(P1, W / 2 + Math.min(200, W / 4), off * 1.5));
    } else if (wt === 'shutter') {   // 셔터: 이중선 + 셔터함(사각)
      wline(P(P1, 0, off), P(P2, 0, off)); wline(P(P1, 0, -off), P(P2, 0, -off));
      const bx = Math.min((e.bim.t || 200), 150);
      const c1 = P(H, 0, bx / 2), c2 = P(H, hs * bx, bx / 2), c3 = P(H, hs * bx, -bx / 2), c4 = P(H, 0, -bx / 2);
      wline(c1, c2); wline(c2, c3); wline(c3, c4); wline(c4, c1);
    } else if (wt === 'mesh') {      // 망사창: 이중선 + 중앙 점선
      wline(P(P1, 0, off), P(P2, 0, off)); wline(P(P1, 0, -off), P(P2, 0, -off));
      ctx.stroke(); ctx.beginPath(); dash(true); wline(P1, P2); ctx.stroke(); dash(false); ctx.beginPath();
    } else {                         // fix(붙박이창) 기본: 이중선
      wline(P1, P2);
      wline(P(P1, 0, off), P(P2, 0, off)); wline(P(P1, 0, -off), P(P2, 0, -off));
    }
    ctx.stroke(); dash(false);
  } else if (k === 'slab' || k === 'roof') {
    ctx.globalAlpha = 0.06; ctx.fillStyle = entityColor(e);
    ctx.beginPath();
    if (e.type === 'CIRCLE') { const c = worldToScreen(e.cx, e.cy); ctx.arc(c.x, c.y, e.r * sc, 0, Math.PI * 2); }
    else { e.points.forEach((p, i) => { const q = worldToScreen(p[0], p[1]); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.closePath(); }
    ctx.fill();
  } else if (k === 'stair' && (e.type === 'LINE' || e.type === 'LWPOLYLINE')) {
    // 3D 솔리드와 같은 stairSteps()로 그린다 — 평면 심볼과 입체가 어긋나지 않게
    const S = stairSteps(e);
    if (S) {
      const W = p => worldToScreen(p[0], p[1]);
      ctx.strokeStyle = entityColor(e); ctx.lineWidth = 1;
      // 외곽 = 좌측 오프셋 경로 + 우측 오프셋 경로 되짚기 (곡선이면 곡선을 따라 휜다)
      const left = [S.steps[0].quad[0], ...S.steps.map(s => s.quad[1])];
      const right = [S.steps[0].quad[3], ...S.steps.map(s => s.quad[2])];
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      [...left, ...right.slice().reverse()].forEach((p, i) => { const q = W(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
      ctx.closePath(); ctx.stroke();
      ctx.globalAlpha = 0.5;
      ctx.beginPath(); // 디딤판 선 (단 사이 경계)
      for (let i = 0; i < S.steps.length - 1; i++) {
        const p1 = W(S.steps[i].quad[1]), p2 = W(S.steps[i].quad[2]);
        ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
      }
      ctx.stroke();
      // 진행(UP) 화살표 — 경로를 따라가고 끝에서 마지막 진행방향으로 촉
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      S.P.forEach((p, i) => { const q = W(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
      const endP = S.P[S.P.length - 1], q = W(endP);
      const lt = S.steps[S.steps.length - 1].t;
      const ux = lt[0], uy = -lt[1]; // 화면 y는 아래로 증가
      ctx.moveTo(q.x, q.y); ctx.lineTo(q.x - ux * 10 - uy * 5, q.y - uy * 10 + ux * 5);
      ctx.moveTo(q.x, q.y); ctx.lineTo(q.x - ux * 10 + uy * 5, q.y - uy * 10 - ux * 5);
      ctx.stroke();
      const startS = W(S.P[0]);
      if (Math.hypot(q.x - startS.x, q.y - startS.y) > 40) {
        ctx.font = '10px -apple-system,system-ui,sans-serif'; ctx.fillStyle = entityColor(e);
        ctx.fillText('UP', q.x - ux * 18 + 4, q.y - uy * 18 - 4);
      }
    }
  } else if (k === 'railing') {
    // 평면: 손스침 경로(실선) + 동자기둥 위치(작은 사각) — 3D와 같은 railingSolids로 그려 어긋나지 않게
    const rs = railingSolids(e);
    if (rs.length) {
      ctx.strokeStyle = entityColor(e); ctx.fillStyle = entityColor(e); ctx.lineWidth = 1;
      for (const s of rs) {
        const isPost = !s.zb; // 손스침 밴드에만 zb가 있다 — 나머지는 기둥
        ctx.globalAlpha = isPost ? 0.75 : 0.5;
        ctx.beginPath();
        s.poly.forEach((p, i) => { const q = worldToScreen(p[0], p[1]); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
        ctx.closePath();
        if (isPost) ctx.fill(); else ctx.stroke();
      }
    }
  } else if (k === 'light') {
    // 평면: 경로(점선) + 조명 위치마다 ⊕ 심볼 (조명 기호 관례)
    const P = railingPath(e);
    if (P) {
      const b = e.bim, rr = Math.max(3, (b.headD || 200) * sc / 2);
      ctx.strokeStyle = entityColor(e); ctx.lineWidth = 1;
      ctx.globalAlpha = 0.35; ctx.setLineDash([4, 4]);
      ctx.beginPath();
      P.V.forEach((p, i) => { const q = worldToScreen(p[0], p[1]); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
      if (P.closed) ctx.closePath();
      ctx.stroke(); ctx.setLineDash([]);
      ctx.globalAlpha = 0.9;
      for (const st of pathStations(P, Math.max(200, b.spacing || 3000))) {
        const q = worldToScreen(st.x, st.y);
        ctx.beginPath(); ctx.arc(q.x, q.y, rr, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); // ⊕ 십자
        ctx.moveTo(q.x - rr, q.y); ctx.lineTo(q.x + rr, q.y);
        ctx.moveTo(q.x, q.y - rr); ctx.lineTo(q.x, q.y + rr);
        ctx.stroke();
      }
    }
  } else if (k === 'column') {
    ctx.globalAlpha = 0.22; ctx.fillStyle = entityColor(e);
    ctx.beginPath();
    if (e.type === 'CIRCLE') { const c = worldToScreen(e.cx, e.cy); ctx.arc(c.x, c.y, e.r * sc, 0, Math.PI * 2); }
    else { e.points.forEach((p, i) => { const q = worldToScreen(p[0], p[1]); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.closePath(); }
    ctx.fill();
  }
  ctx.restore();
}
// 가져온 메시의 평면(윗면) 윤곽 — 삼각형 에지를 위에서 본 투영으로 옅게
function drawMeshOverlay(e) {
  ctx.save();
  ctx.strokeStyle = entityColor(e); ctx.globalAlpha = state.selection.has(e.id) ? 0.85 : 0.3;
  ctx.lineWidth = state.selection.has(e.id) ? 1.5 : 0.6;
  ctx.beginPath();
  for (const t of e.tris) {
    for (let i = 0; i < 3; i++) {
      const a = worldToScreen(t[i][0], t[i][1]), b = worldToScreen(t[(i + 1) % 3][0], t[(i + 1) % 3][1]);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
  }
  ctx.stroke(); ctx.restore();
}

// ============================================================
//  BIM 2단계 — 3D 뷰 (의존성 없는 자체 렌더러)
//  모든 BIM 요소는 수직 기둥체(prism): {poly:[[x,y]..], z0, z1, color, glass?}
// ============================================================
// BIM 솔리드 색: 명시 색 > 이름있는(비흰색) 레이어 색 > 기본 건축 색. 레이어 바꾸면 3D 색도 바뀜.
function bimSolidColor(e, fallback) {
  if (e.color) return e.color;
  // 재질을 붙였는데 작업 화면이 그대로면 붙었는지 알 수가 없다 → 색 미지정(ByLayer) 개체는 재질색.
  // 질감·반사는 라이노처럼 렌더 표시(rendered/raytrace)의 몫이고, 여기선 색까지만 반영한다.
  const P = matOf(e);
  if (P) return P.color;
  const lc = (getLayer(e.layer) || {}).color;
  if (lc && lc.toLowerCase() !== '#ffffff') return lc;
  return fallback;
}
function bimSolids() {
  const solids = [];
  const walls = [], opens = [];
  // 곡면 분절 수 — 기본 CIRC_SEG(64)로 매끈하게. 다만 곡면 개체가 많으면 면 수가 곱으로 늘어
  // 회전이 뻑뻑해지므로(실측: 원기둥 60개 64각 179ms/frame vs 32각 93ms) 자동으로 낮춘다.
  // 실사용(원통 몇 개)에서는 항상 64각.
  let curvN = 0;
  for (const e of state.entities) if (e.bim && (e.type === 'CIRCLE' || e.type === 'ARC')) curvN++;
  const segN = curvN > 40 ? 24 : curvN > 12 ? 32 : CIRC_SEG;
  _curvSeg = segN; // 실제 사용 분절 — 면 인덱스(extrudesrf 옆면 밀당)가 같은 값을 봐야 한다
  for (const e of state.entities) {
    const l = getLayer(e.layer); if (l && !l.visible) continue;
    if (!e.bim) continue;
    if (e.bim.kind === 'wall') walls.push(e);
    else if (e.bim.kind === 'opening' && e.type === 'LINE') opens.push(e);
    else if (e.bim.kind === 'slab') {
      const poly = e.type === 'CIRCLE' ? circlePoly(e.cx, e.cy, e.r, segN) : e.points.map(p => [p[0], p[1]]);
      // top 누락 방어 — 외부 데이터(공유·임포트)에 top 이 없으면 z 가 NaN 이 되어
      // three 렌더러에서 슬래브가 통째로 조용히 사라진다 (computeBoundingSphere NaN 실측)
      const top = (e.bim.top == null || !isFinite(e.bim.top)) ? 0 : e.bim.top;
      solids.push({ poly, z0: top - (e.bim.t || 0), z1: top, color: bimSolidColor(e, '#9aa2af'), eid: e.id });
    } else if (e.bim.kind === 'roof' && e.type === 'LWPOLYLINE') {
      for (const s of roofSolids(e)) { s.eid = e.id; s.rf = true; s.color = bimSolidColor(e, s.color); solids.push(s); }
    } else if (e.bim.kind === 'stair' && (e.type === 'LINE' || e.type === 'LWPOLYLINE')) {
      for (const s of stairSolids(e)) { s.eid = e.id; s.color = bimSolidColor(e, s.color); solids.push(s); }
    } else if (e.bim.kind === 'railing') {
      for (const s of railingSolids(e)) solids.push(s); // 손스침 + 동자기둥
    } else if (e.bim.kind === 'mass') {
      // ── 범용 매스: '어떤 형상이든' 만들기 위한 일반 프리미티브 ──
      // 임의 닫힌 다각형(또는 원)을 바닥으로, 정점별 바닥/상단 높이를 줄 수 있고,
      // 윗면을 밀거나(shear) 줄이거나(taper) 돌려서(twist) 각뿔대·전단 프리즘·비틀린
      // 매스까지 한 개체로 표현한다. 기울어진 텐트·접힌 판·좁아지는 타워가 전부 여기에 든다.
      const b = e.bim;
      const poly = e.type === 'CIRCLE' ? circlePoly(e.cx, e.cy, e.r, segN)
        : (e.points || []).map(p => [p[0], p[1]]);
      if (poly.length >= 3) {
        const nv = poly.length, base = b.base || 0;
        const zb = (Array.isArray(b.zb) && b.zb.length === nv) ? b.zb.slice() : poly.map(() => base);
        const zt = (Array.isArray(b.zt) && b.zt.length === nv) ? b.zt.slice()
          : poly.map((p, i) => zb[i] + (b.h != null ? b.h : 3000));
        let ptop = null;
        if (b.shear || b.taper != null || b.twist) {
          let cx = 0, cy = 0; for (const p of poly) { cx += p[0]; cy += p[1]; }
          cx /= nv; cy /= nv;
          const k = (b.taper != null && isFinite(b.taper)) ? b.taper : 1;
          const th = (b.twist || 0) * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
          const sx = b.shear ? (b.shear[0] || 0) : 0, sy = b.shear ? (b.shear[1] || 0) : 0;
          ptop = poly.map(p => {
            const dx = (p[0] - cx) * k, dy = (p[1] - cy) * k;
            return [cx + dx * cs - dy * sn + sx, cy + dx * sn + dy * cs + sy];
          });
        }
        solids.push({ poly, ptop, zb, zt, z0: Math.min.apply(null, zb), z1: Math.max.apply(null, zt),
          color: bimSolidColor(e, '#c9c2b4'), eid: e.id, curv: e.type === 'CIRCLE',
          ...(e.type === 'CIRCLE' ? { cc: [e.cx, e.cy] } : {}) });
      }
    } else if (e.bim.kind === 'column') {
      const isC = e.type === 'CIRCLE';
      const poly = isC ? circlePoly(e.cx, e.cy, e.r, segN) : e.points.map(p => [p[0], p[1]]);
      solids.push({ poly, z0: e.bim.base || 0, z1: (e.bim.base || 0) + e.bim.h, color: bimSolidColor(e, '#8fa3c8'), eid: e.id, curv: isC });
    }
  }
  // ── LINE 벽 네트워크: 2D 는 분리된 선(따로 편집·삭제)이지만 3D 는 이어진 벽처럼 ──
  // ① 두 벽의 끝점이 맞닿음(0.5mm) → 폴리라인 코너와 같은 마이터
  // ② 벽 끝이 다른 벽 '몸통'에 닿음(T자) → 상대 두께 절반만큼 파묻어 합집합처럼
  // (3D 는 매 프레임 파생 — 선 하나를 지우면 그 벽 srf 만 사라지고 남은 벽은 자기 마이터로 복원)
  const lineWalls = walls.filter(w2 => w2.type === 'LINE' && !wallBaseZs(w2));
  const wallJoin = new Map();    // "id:end" -> {mo,mi}(마이터) | {ext:[dx,dy]}(T 파묻기)
  {
    const cornerMap = new Map();
    const ck = (x, y) => (Math.round(x * 2) / 2) + ',' + (Math.round(y * 2) / 2);
    for (const w2 of lineWalls) {
      const pts2 = [[w2.x1, w2.y1], [w2.x2, w2.y2]];
      for (let en2 = 0; en2 < 2; en2++) {
        const k2 = ck(pts2[en2][0], pts2[en2][1]);
        if (!cornerMap.has(k2)) cornerMap.set(k2, []);
        cornerMap.get(k2).push({ w: w2, end: en2, P: pts2[en2], far: pts2[1 - en2] });
      }
    }
    for (const list of cornerMap.values()) {
      if (list.length !== 2 || list[0].w === list[1].w) continue;   // 3벽 합류·자기 자신 = 맞댐 유지
      const [A, B] = list;
      const t2 = A.w.bim.t; if (Math.abs(t2 - B.w.bim.t) > 0.5) continue; // 두께 다르면 마이터 불가
      const P = A.P;
      const e1x = P[0] - B.far[0], e1y = P[1] - B.far[1], L1 = Math.hypot(e1x, e1y) || 1;
      const e2x = A.far[0] - P[0], e2y = A.far[1] - P[1], L2 = Math.hypot(e2x, e2y) || 1;
      const n1 = [-e1y / L1, e1x / L1], n2 = [-e2y / L2, e2x / L2];
      let mx2 = n1[0] + n2[0], my2 = n1[1] + n2[1]; const ml2 = Math.hypot(mx2, my2);
      if (ml2 < 1e-6) continue;                                    // 일직선 = 맞댐 그대로
      mx2 /= ml2; my2 /= ml2;
      const cosH = Math.max(0.25, mx2 * n2[0] + my2 * n2[1]);
      const ox2 = mx2 * (t2 / 2) / cosH, oy2 = my2 * (t2 / 2) / cosH;
      const j2 = { mo: [P[0] + ox2, P[1] + oy2], mi: [P[0] - ox2, P[1] - oy2] };
      wallJoin.set(A.w.id + ':' + A.end, j2); wallJoin.set(B.w.id + ':' + B.end, j2);
    }
    for (const list of cornerMap.values()) {                       // T자: 짝 없는 끝 → 상대 몸통에 파묻기
      if (list.length !== 1) continue;
      const A = list[0]; if (wallJoin.has(A.w.id + ':' + A.end)) continue;
      for (const hb of lineWalls) {
        if (hb === A.w) continue;
        const dx = hb.x2 - hb.x1, dy = hb.y2 - hb.y1, LL = Math.hypot(dx, dy) || 1;
        const tt = ((A.P[0] - hb.x1) * dx + (A.P[1] - hb.y1) * dy) / (LL * LL);
        if (tt < 0.02 || tt > 0.98) continue;
        if (Math.hypot(A.P[0] - (hb.x1 + dx * tt), A.P[1] - (hb.y1 + dy * tt)) > (hb.bim.t || 200) / 2 + 0.5) continue;
        const ux3 = A.P[0] - A.far[0], uy3 = A.P[1] - A.far[1]; const uL = Math.hypot(ux3, uy3) || 1;
        wallJoin.set(A.w.id + ':' + A.end, { ext: [ux3 / uL * (hb.bim.t || 200) / 2, uy3 / uL * (hb.bim.t || 200) / 2] });
        break;
      }
    }
  }
  for (const w of walls) {
    const t = w.bim.t, h = w.bim.h, base = w.bim.base || 0;
    // 곡선을 따라 세운 벽: 경로가 표면 위 곡선(zs)이거나 3D 선(z1/z2)이면 바닥이 그 높이를 따라간다.
    // bim.base는 지형으로부터의 '들어올림' 오프셋으로 계속 동작한다(기본 0 = 곡선 위에 그대로 앉음).
    const wz = wallBaseZs(w);
    const lift = wz ? (base - lvElev()) : 0;
    const wallCol = bimSolidColor(w, '#cfc7ba'); // 벽 불투명 밴드 색 (레이어/명시 색 반영)
    // 꼭짓점 링 구성: LINE=2점 열린, 폴리라인=점열(닫힘 여부), 원=24각 닫힘
    let V, closedW;
    if (w.type === 'CIRCLE') { V = circlePoly(w.cx, w.cy, w.r, segN); closedW = true; }
    else if (w.type === 'ARC') { // 호 벽(아치) — CIRCLE 벽과 같은 곡면 처리(64각 밀도·이음선 숨김·구로)
      const sw = ((w.endAngle - w.startAngle) % 360 + 360) % 360 || 360;
      const m = Math.max(2, Math.round(segN * sw / 360));
      V = [];
      for (let i = 0; i <= m; i++) { const a = (w.startAngle + sw * i / m) * Math.PI / 180; V.push([w.cx + Math.cos(a) * w.r, w.cy + Math.sin(a) * w.r]); }
      closedW = false;
    }
    else if (w.type === 'LINE') { V = [[w.x1, w.y1], [w.x2, w.y2]]; closedW = false; }
    else {
      V = (w.points || []).map(p => [p[0], p[1]]); closedW = !!w.closed && V.length > 2;
      // 폴리 도구로 끝점을 시작점에 '맞물려' 그린 고리: closed 플래그가 없어도 닫힌 벽으로 —
      // 안 그러면 마지막 모서리만 마이터 없이 맞대져 이음선이 보인다 (2026-07-25 사용자).
      if (!closedW && V.length > 3 && Math.hypot(V[0][0] - V[V.length - 1][0], V[0][1] - V[V.length - 1][1]) < 0.5) { V.pop(); closedW = true; }
    }
    const n = V.length; if (n < 2) continue;
    const nE = closedW ? n : n - 1;
    // 변별 단위 법선
    const eN = [];
    for (let k = 0; k < nE; k++) {
      const a = V[k], b = V[(k + 1) % n];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      eN.push([-(b[1] - a[1]) / L, (b[0] - a[0]) / L]);
    }
    // 꼭짓점별 마이터 오프셋 — 인접 변 오프셋 선의 교차 방향 (코너가 빈틈·단차 없이 맞물림)
    const mitO = [], mitI = [];
    for (let i = 0; i < n; i++) {
      const pe = closedW ? (i - 1 + n) % n : i - 1;
      const ce = i < nE ? i : nE - 1;
      let ox, oy;
      if (pe >= 0 && i < nE) {
        let mx = eN[pe][0] + eN[ce][0], my = eN[pe][1] + eN[ce][1];
        const ml = Math.hypot(mx, my);
        if (ml < 1e-6) { mx = eN[ce][0]; my = eN[ce][1]; }
        else { mx /= ml; my /= ml; }
        const cosH = Math.max(0.25, mx * eN[ce][0] + my * eN[ce][1]); // 예각 스파이크 제한
        ox = mx * (t / 2) / cosH; oy = my * (t / 2) / cosH;
      } else { ox = eN[ce][0] * t / 2; oy = eN[ce][1] * t / 2; } // 열린 끝: 수직 맞댐
      mitO.push([V[i][0] + ox, V[i][1] + oy]);
      mitI.push([V[i][0] - ox, V[i][1] - oy]);
    }
    // LINE 벽 네트워크 이어붙임: 끝점 마이터/T 파묻기 — 이 벽의 +eN 쪽이 mo 가 되도록 정렬(quad 꼬임 방지)
    if (w.type === 'LINE') {
      for (let en2 = 0; en2 < 2; en2++) {
        const j2 = wallJoin.get(w.id + ':' + en2);
        if (!j2) continue;
        if (j2.ext) { mitO[en2] = [mitO[en2][0] + j2.ext[0], mitO[en2][1] + j2.ext[1]]; mitI[en2] = [mitI[en2][0] + j2.ext[0], mitI[en2][1] + j2.ext[1]]; continue; }
        if ((j2.mo[0] - V[en2][0]) * eN[0][0] + (j2.mo[1] - V[en2][1]) * eN[0][1] >= 0) { mitO[en2] = j2.mo.slice(); mitI[en2] = j2.mi.slice(); }
        else { mitO[en2] = j2.mi.slice(); mitI[en2] = j2.mo.slice(); }
      }
    }
    // 자유곡선(비정형) 벽: bim.smooth 플래그 — 정점 법선(마이터 바깥 방향)으로 연속 구로 셰이딩
    const smoothW = !!(w.bim && w.bim.smooth) && w.type !== 'CIRCLE' && w.type !== 'ARC' && n > 2;
    // 기울어진 벽: bim.shear = [dx, dy] — 벽 꼭대기에서 이만큼 민다(전단). 없으면 수직.
    const wSh = (w.bim && w.bim.shear && (w.bim.shear[0] || w.bim.shear[1])) ? w.bim.shear : null;
    const vNrm = (idx) => {
      const dx = mitO[idx][0] - V[idx][0], dy = mitO[idx][1] - V[idx][1];
      const L2 = Math.hypot(dx, dy) || 1; return [dx / L2, dy / L2];
    };
    for (let k = 0; k < nE; k++) {
      const x1 = V[k][0], y1 = V[k][1], k2 = (k + 1) % n;
      const x2 = V[k2][0], y2 = V[k2][1];
      const L = Math.hypot(x2 - x1, y2 - y1); if (L < 1e-6) continue;
      const ux = (x2 - x1) / L, uy = (y2 - y1) / L;
      // 이 구간의 바닥 높이 (곡선을 따라 세운 벽이면 양 끝 정점 z를 세그먼트 안에서 보간)
      const bz0 = wz ? wz[k] + lift : base, bz1 = wz ? wz[k2] + lift : base;
      const baseAt = (s) => bz0 + (bz1 - bz0) * (L ? Math.max(0, Math.min(1, s / L)) : 0);
      // 이 세그먼트 위의 개구부(콜리니어) 수집 → 구간 분할
      const cuts = [];
      for (const o of opens) {
        const mx = (o.x1 + o.x2) / 2, my = (o.y1 + o.y2) / 2;
        const s = (mx - x1) * ux + (my - y1) * uy;
        const dPerp = Math.abs((mx - x1) * (-uy) + (my - y1) * ux);
        const ow = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
        const odir = Math.abs(((o.x2 - o.x1) / ow) * ux + ((o.y2 - o.y1) / ow) * uy);
        if (dPerp < t / 2 + 1 && odir > 0.99 && s > 0 && s < L)
          cuts.push({ s0: Math.max(0, s - ow / 2), s1: Math.min(L, s + ow / 2), o });
      }
      cuts.sort((a, b) => a.s0 - b.s0);
      const band = (s0, s1, z0, z1, color, glass, beid) => {
        if (s1 - s0 < 1e-6 || z1 - z0 < 0) return; // z1===z0(높이 0) 허용 — 라이노처럼 납작한 '면'으로 렌더
        const ax = x1 + ux * s0, ay = y1 + uy * s0, bx = x1 + ux * s1, by = y1 + uy * s1;
        const nx = -uy * t / 2, ny = ux * t / 2;
        let A1 = [ax + nx, ay + ny], A2 = [ax - nx, ay - ny];
        let B1 = [bx + nx, by + ny], B2 = [bx - nx, by - ny];
        if (s0 <= 0.01) { A1 = mitO[k]; A2 = mitI[k]; }            // 세그 시작 = 마이터 코너
        if (s1 >= L - 0.01) { B1 = mitO[k2]; B2 = mitI[k2]; }      // 세그 끝 = 마이터 코너
        const sol = { poly: [A1, B1, B2, A2], z0, z1, color, glass, eid: beid !== undefined ? beid : w.id, open: t <= 2 || glass, seg: k,
          curv: w.type === 'CIRCLE' || w.type === 'ARC' || smoothW,
          // 곡선 벽 구로 셰이딩용 진짜 원 중심 — 밴드(얇은 사각) 자체 무게중심으로 법선을 만들면
          // 인접 밴드끼리 정점 셰이드가 어긋나 면 단위 밝기 계단(각진 느낌)이 남는다.
          ...(w.type === 'CIRCLE' || w.type === 'ARC' ? { cc: [w.cx, w.cy] } : {}),  // 곡선 벽(원통·아치) → 세로 이음선 숨김
          // 자유곡선(비정형) 벽: 원 중심이 없으므로 양 끝 '정점 법선'(마이터 방향)을 직접 실어
          // 인접 밴드가 공유 정점에서 같은 법선을 보게 한다 — 연속 구로 셰이딩
          ...(smoothW ? { vnrm: [vNrm(k), vNrm(k2)] } : {}) };
        if (wz) {
          // 곡선을 따라 세운 벽: z0/z1을 '이 구간 바닥 기준의 오프셋'으로 재해석해 양 끝에서 기울인다.
          // (개구부 상·하단 밴드도 같은 오프셋을 유지하므로 창·문이 지형을 따라 같이 기울어짐)
          const dz0 = z0 - base, dz1 = z1 - base;
          const bA = baseAt(s0), bB = baseAt(s1);
          // poly 순서 = [A1(s0), B1(s1), B2(s1), A2(s0)]
          sol.zb = [bA + dz0, bB + dz0, bB + dz0, bA + dz0];
          sol.zt = [bA + dz1, bB + dz1, bB + dz1, bA + dz1];
          sol.z0 = Math.min(...sol.zb); // 스칼라 z0/z1은 항상 유효하게 유지 (fit·검볼·단면 등 나머지 코드용)
          sol.z1 = Math.max(...sol.zt);
        }
        // ── 기울어진 벽(shear) ──
        // 벽 전체를 h 만큼 올라갔을 때 wSh 만큼 미는 전단. 바닥 다각형은 z0 높이에 맞춰
        // 미리 밀고, 윗면(ptop)은 z1 높이에 맞춰 민다 → 개구부 위·아래 조각도 같은 기울기
        // 면 위에 정확히 놓여, 창·문이 기울어진 벽면에 그대로 박힌다.
        if (wSh) {
          const f0 = (z0 - base) / (h || 1), f1 = (z1 - base) / (h || 1);
          sol.poly = sol.poly.map(p => [p[0] + wSh[0] * f0, p[1] + wSh[1] * f0]);
          sol.ptop = sol.poly.map(p => [p[0] + wSh[0] * (f1 - f0), p[1] + wSh[1] * (f1 - f0)]);
        }
        solids.push(sol);
      };
      let cur = 0;
      for (const c of cuts) {
        band(cur, c.s0, base, base + h, wallCol);            // 개구부 앞 벽체
        const sill = c.o.bim.sill || 0, oh = c.o.bim.h || 2100;
        if (sill > 0) band(c.s0, c.s1, base, base + sill, wallCol);            // 창 아래
        if (base + h > base + sill + oh) band(c.s0, c.s1, base + sill + oh, base + h, wallCol); // 인방(상부)
        if (c.o.bim.ot === 'window') band(c.s0 + 10, c.s1 - 10, base + sill, base + sill + oh, '#7ec8ff', true, c.o.id); // 유리
        if (!wz) pushOpening3D(solids, c, { x1, y1, ux, uy, t, base, h, sh: wSh });   // 창호 3D — 문짝·창틀 (유형별)
        cur = c.s1;
      }
      band(cur, L, base, base + h, wallCol);
    }
  }
  // 광원으로 지정한 개체는 빛이 '형상 안'에 있다 — 모든 면의 법선이 광원을 등지므로
  // 단면 조명으로는 새까맣게 나온다. 양면으로 표시해 안에서 밝혀지게 한다(색은 그대로).
  const litIds = new Set();
  for (const e of state.entities) if (e.lightId) litIds.add(e.id);
  if (litIds.size) for (const s of solids) if (litIds.has(s.eid)) s.lit = 1;
  return solids;
}
// ─── 창호 3D — 문짝(열림 표현)·창틀 프레임. 유형(wt)별 단순 프리즘 몇 개 (3단계) ───
function pushOpening3D(solids, c, g) {
  const o = c.o, wt = owWt(o);
  const sill = o.bim.sill || 0, oh = o.bim.h || 2100;
  const z0 = g.base + sill, z1 = g.base + sill + oh;
  const Wd = c.s1 - c.s0; if (Wd < 60) return;
  const at = (s, d) => [g.x1 + g.ux * s - g.uy * d, g.y1 + g.uy * s + g.ux * d];
  const fs = o.bim.flip ? -1 : 1;
  const LEAF = '#a9825a', FRAME = '#8a8f98';
  // 벽이 기울어져 있으면(g.sh) 창틀·문짝도 그 기울기 면 위에 놓아야 벽을 뚫고 나오지 않는다.
  const shF = (z) => g.sh ? (z - g.base) / (g.h || 1) : 0;
  const plank = (p1, p2, zz0, zz1, col, th) => { // 두 점을 잇는 두께 th 판
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1], L2 = Math.hypot(dx, dy); if (L2 < 1) return;
    const nx = -dy / L2 * (th || 40) / 2, ny = dx / L2 * (th || 40) / 2;
    const f0 = shF(zz0), f1 = shF(zz1);
    const sx0 = g.sh ? g.sh[0] * f0 : 0, sy0 = g.sh ? g.sh[1] * f0 : 0;
    const poly = [[p1[0] + nx + sx0, p1[1] + ny + sy0], [p2[0] + nx + sx0, p2[1] + ny + sy0],
      [p2[0] - nx + sx0, p2[1] - ny + sy0], [p1[0] - nx + sx0, p1[1] - ny + sy0]];
    const so = { poly, z0: zz0, z1: zz1, color: col, eid: o.id };
    if (g.sh) { const dxs = g.sh[0] * (f1 - f0), dys = g.sh[1] * (f1 - f0);
      so.ptop = poly.map(p => [p[0] + dxs, p[1] + dys]); }
    solids.push(so);
  };
  // 경첩 끝의 세그먼트 s 위치 → c.s0/s1 어느 쪽인지 (개구선과 세그먼트 방향이 반대일 수 있음)
  const sO1 = (o.x1 - g.x1) * g.ux + (o.y1 - g.y1) * g.uy;
  const sO2 = (o.x2 - g.x1) * g.ux + (o.y2 - g.y1) * g.uy;
  const hingeS = o.bim.hinge ? sO2 : sO1;
  const hAtS0 = Math.abs(hingeS - c.s0) <= Math.abs(hingeS - c.s1);
  // 커스텀 기호('@이름') 3D — 저장한 닫힌 도형(풋프린트)을 프리즘으로. zb/zh(기준 2100 분율) 있으면 그 구간만
  if (wt.charCodeAt(0) === 64) {
    const defC = (state.owlib || {})[wt.slice(1)];
    if (defC && defC.solid) {
      const P1w = at(c.s0, 0);
      for (const c2 of owPlaced(defC.solid, P1w, g.ux, g.uy, Wd / 1000, Wd / 1000, !hAtS0, !!o.bim.flip)) {
        const zz0 = z0 + (c2.zb || 0) * oh, zz1 = z0 + ((c2.zb || 0) + (c2.zh != null ? c2.zh : 1 - (c2.zb || 0))) * oh;
        if (c2.type === 'CIRCLE') solids.push({ poly: circlePoly(c2.cx, c2.cy, c2.r, 24), z0: zz0, z1: zz1, color: c2.color || LEAF, eid: o.id, curv: true, cc: [c2.cx, c2.cy] });
        else if (c2.type === 'LWPOLYLINE' && c2.closed && c2.points.length > 2) solids.push({ poly: c2.points.map(p => [p[0], p[1]]), z0: zz0, z1: zz1, color: c2.color || LEAF, eid: o.id });
      }
      return;
    } // solid 부위 없으면 아래 기본(계열별)으로 폴백
  }
  if (o.bim.ot === 'door') {
    const Hs = hAtS0 ? c.s0 : c.s1, dir = hAtS0 ? 1 : -1;
    const H = at(Hs, 0);
    const swingEnd = (len) => { // 경첩에서 열림각 ~30° 로 뻗은 문짝 끝
      const a0 = Math.atan2(g.uy * dir, g.ux * dir) + fs * dir * 0.5;
      return [H[0] + Math.cos(a0) * len, H[1] + Math.sin(a0) * len];
    };
    if (wt === 'swing' || wt === 'dact') plank(H, swingEnd(Wd), z0, z1, LEAF);
    else if (wt === 'dswing') {
      plank(H, swingEnd(Wd / 2), z0, z1, LEAF);
      const F2 = at(hAtS0 ? c.s1 : c.s0, 0);
      const a1 = Math.atan2(g.uy * -dir, g.ux * -dir) - fs * dir * 0.5;
      plank(F2, [F2[0] + Math.cos(a1) * Wd / 2, F2[1] + Math.sin(a1) * Wd / 2], z0, z1, LEAF);
    } else if (wt === 'slide') {
      const off = Math.min(g.t / 6, 40);
      plank(at(c.s0, off), at(c.s0 + Wd * 0.55, off), z0, z1, LEAF);
      plank(at(c.s1, -off), at(c.s1 - Wd * 0.55, -off), z0, z1, LEAF);
    } else if (wt === 'pocket') plank(at(Hs, 0), at(Hs + dir * Wd * 0.5, 0), z0, z1, LEAF); // 반쯤 열린 미닫이
    else if (wt === 'fold') {
      const M = at((c.s0 + c.s1) / 2, fs * Math.min(g.t, Wd / 4));
      plank(at(c.s0, 0), M, z0, z1, LEAF); plank(M, at(c.s1, 0), z0, z1, LEAF);
    } else if (wt === 'rev') {
      const sm = (c.s0 + c.s1) / 2, r = Wd * 0.35;
      plank(at(sm - r, r), at(sm + r, -r), z0, z1, LEAF); plank(at(sm - r, -r), at(sm + r, r), z0, z1, LEAF);
    } else plank(H, swingEnd(Wd), z0, z1, LEAF); // 알 수 없는 유형 = 여닫이
  } else { // 창: 틀(4변) + 유형별 부재
    plank(at(c.s0 + 10, 0), at(c.s1 - 10, 0), z0, z0 + 50, FRAME);          // 하부 레일
    plank(at(c.s0 + 10, 0), at(c.s1 - 10, 0), z1 - 50, z1, FRAME);          // 상부 레일
    plank(at(c.s0 + 10, 0), at(c.s0 + 55, 0), z0, z1, FRAME);               // 좌 멀리언
    plank(at(c.s1 - 55, 0), at(c.s1 - 10, 0), z0, z1, FRAME);               // 우 멀리언
    if (wt === 'wslide' || wt === 'mesh') plank(at((c.s0 + c.s1) / 2 - 22, 0), at((c.s0 + c.s1) / 2 + 22, 0), z0, z1, FRAME); // 중앙 세로대
    if (wt === 'hung') plank(at(c.s0 + 10, 0), at(c.s1 - 10, 0), (z0 + z1) / 2 - 22, (z0 + z1) / 2 + 22, FRAME);             // 중앙 가로대
    if (wt === 'shutter') for (let z = z0 + 200; z < z1 - 100; z += 300) plank(at(c.s0 + 10, 0), at(c.s1 - 10, 0), z - 20, z + 20, FRAME); // 슬랫
  }
}
// 벽 경로의 정점별 바닥 높이 — 표면 위 곡선(zs) / 3D 선(z1,z2)이면 배열, 평면 도형이면 null(예전 동작)
function wallBaseZs(w) {
  if (w.type === 'LWPOLYLINE' && polyHasZ(w)) return w.zs;
  if (w.type === 'LINE' && (w.z1 != null || w.z2 != null)) {
    const zb = lvElev() + (w.zo || 0);
    return [w.z1 != null ? w.z1 : zb, w.z2 != null ? w.z2 : zb];
  }
  return null;
}
function circlePoly(cx, cy, r, n) {
  const p = [];
  for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return p;
}
// 3D 솔리드에서 원을 몇 각형으로 볼 것인가 — 곡면이 '직면'으로 보이지 않는 분절 수.
// ★16각(예전)은 22.5°마다 면이 꺾여 원통이 각져 보였고, 면마다 밝기가 달라 세로 줄이 보였다
//   (2026-07-20 사용자 보고). 64각이면 5.6°라 평면 셰이딩으로도 매끈하고, 불리언 결과 메시의
//   특징모서리 판정(cos 0.9 = 25.8°)에서도 자동으로 '내부선'이 되어 표면에 선이 남지 않는다.
const CIRC_SEG = 64;
let _curvSeg = CIRC_SEG; // bimSolids 가 실제로 쓴 분절 수 (곡면이 많으면 자동으로 낮아짐)

let v3 = null; // {yaw,pitch,zoom,cx,cy,cz,panX,panY,cv,ctx,faces}
function open3D() {
  const solids = bimSolids();
  if (!solids.length) logLine('  3D: 아직 BIM 요소가 없습니다 — 평면에서 그린 뒤 wall/slab/column으로 지정하면 여기 나타납니다.', 'info');
  let ov = document.getElementById('bim3d');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'bim3d';
    ov.style.cssText = 'position:absolute;inset:0;z-index:18;background:var(--canvas-bg);display:flex;flex-direction:column;';
    ov.innerHTML = `
      <canvas id="b3cv" style="flex:1 1 0;min-height:0;height:auto;width:100%;touch-action:none;cursor:default;"></canvas>`;
      // 작업면 Z 컨트롤은 하단 상태바(#cplaneStatus)로 이동 — 3D 모드에서만 표시(syncViewSeg)
    document.getElementById('canvasWrap').appendChild(ov);
    const cv3 = ov.querySelector('#b3cv');
    v3 = { yaw: -0.6, pitch: 0.85, zoom: 1, panX: 0, panY: 0, cv: cv3, ctx: cv3.getContext('2d'), solids: [],
      quad: false, act: 1, views: [ // 사분할 뷰 (TL/TR/BL/BR) — 라이노식
        // fixed = 평행 투영 고정(회전 불가): 평면·입면은 도면에 넣을 수 있는 정투영 뷰
        // mode:'plan' — 이 칸은 2D 엔진(draw())이 #cv 로 그린다. 3D 렌더러는 건너뛴다. vpIsPlan 참고.
        { name: '평면', yaw: 0, pitch: Math.PI / 2, zoom: 1, panX: 0, panY: 0, fixed: true, mode: 'plan' },
        { name: '아이소', yaw: -0.6, pitch: 0.85, zoom: 1, panX: 0, panY: 0 },
        { name: '정면', yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0, fixed: true },
        { name: '우측면', yaw: -Math.PI / 2, pitch: 0, zoom: 1, panX: 0, panY: 0, fixed: true },
      ] };
    bind3D(ov, cv3);
  }
  ov.style.display = 'flex';
  v3.solids = solids;
  fit3D(); // 모델 중심·초기 줌 (솔리드 + 밑그림 도형 포함)
  v3.refitPending = !isFinite(v3.hasContent) || !v3.hasContent; // 빈 모델로 열림 → 첫 도형에 자동 맞춤
  v3.zoom = 1; v3.panX = 0; v3.panY = 0;
  for (const w of v3.views) { w.zoom = 1; w.panX = 0; w.panY = 0; }
  try { // 저장된 뷰 레이아웃 복원 (분할 여부·활성 뷰·뷰 방향·입면 종류)
    const ly = JSON.parse(localStorage.getItem('webcad_v3_layout2') || 'null');
    if (ly && Array.isArray(ly.views) && ly.views.length === 4) {
      ly.views.forEach((w, i) => {
        if (!isFinite(w.yaw)) return;
        v3.views[i].yaw = w.yaw; v3.views[i].pitch = w.pitch;
        if (w.name) v3.views[i].name = w.name;
        v3.views[i].fixed = !!w.fixed;
      });
      v3.quad = !!ly.quad;
      v3.act = (ly.act >= 0 && ly.act < 4) ? ly.act : 1;
    }
  } catch (_) {}
  loadVp(v3.act);
  if (!v3.fit || !isFinite(v3.fit)) v3.fit = 10000;
  size3D(); render3D();
  syncViewSeg(true);
  startLive3D();
  logLine(`  ✔ 3D 작업 뷰 — 요소 ${solids.length}개. 클릭으로 선택해 속성 패널에서 높이·두께를 수정하면 즉시 반영됩니다.`, 'ok');
  usage3d();
}
// 뷰 세그먼트(평면/3D) 표시 동기화
// 3D 화면 맞춤: 솔리드 + 비 BIM 도형 전체 bbox → 중심·스케일 재계산 (전체보기와 연동)
// ─── 도면 범위 (전체보기의 유일한 진실) ───
// 예전엔 2D 전체보기(zoomFit)와 3D 화면맞춤(fit3D)이 각자 자기 switch 를 갖고 있었다.
// 둘 다 서로 다르게 틀렸다:
//   fit3D  : LINE/LWPOLYLINE/CIRCLE/ARC 화이트리스트 → 문자·해치·이미지·블록이 범위에서 빠짐
//   zoomFit: MESH 케이스가 없음 → STL/OBJ 를 가져오면 2D 전체보기가 그 형상을 못 봄
// 그래서 같은 도면에 대해 평면 칸과 3D 칸의 '전체보기' 가 서로 다른 곳을 봤다.
// 한쪽만 고치면 반대로 어긋난다 — '평면이 두 벌' 과 같은 병이다. 그래서 원천을 하나로 만든다.
//
// 개체 하나가 범위에 기여하는 점들을 out 에 [x,y,x,y,…] 로 밀어 넣는다.
// LINE/폴리라인/원·호/이미지는 예전 zoomFit 의 규칙을 그대로 유지하고(회귀 방지),
// 나머지(문자·해치·블록·메시)는 entityBBox 가 맡는다 — 그게 이미 전 타입을 안다.
function entityExtentPts(e, out) {
  const push = (x, y) => { if (isFinite(x) && isFinite(y)) { out.push(x); out.push(y); } };
  switch (e.type) {
    case 'LINE': push(e.x1, e.y1); push(e.x2, e.y2); return;
    case 'LWPOLYLINE': if (e.points) for (const q of e.points) push(q[0], q[1]); return;
    case 'CIRCLE': case 'ARC': push(e.cx - e.r, e.cy - e.r); push(e.cx + e.r, e.cy + e.r); return;
    case 'IMAGE': for (const q of imgCorners(e)) push(q.x, q.y); return;   // 회전 반영
    default: {
      let b = null; try { b = entityBBox(e); } catch (_) {}
      if (b) { push(b.xmin, b.ymin); push(b.xmax, b.ymax); }
    }
  }
}
// 도면 전체 범위. robust=true 면 1%/99% 분위수로 이상점을 잘라낸다
// (DXF 에 멀리 떨어진 점 하나가 섞여 있으면 전체보기가 쓸모없어진다).
// skip(e) 로 제외 — fit3D 는 BIM 개체를 솔리드가 이미 커버하므로 건너뛴다.
function modelExtents(robust, skip) {
  const xs = [], ys = [], buf = [];
  for (const e of state.entities) {
    if (skip && skip(e)) continue;
    buf.length = 0;
    entityExtentPts(e, buf);
    for (let i = 0; i < buf.length; i += 2) { xs.push(buf[i]); ys.push(buf[i + 1]); }
  }
  if (!xs.length) return null;
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  let minX = xs[0], maxX = xs[xs.length - 1], minY = ys[0], maxY = ys[ys.length - 1];
  if (robust && xs.length >= 50) {
    const q = (arr, t) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor((arr.length - 1) * t)))];
    const rx0 = q(xs, 0.01), rx1 = q(xs, 0.99), ry0 = q(ys, 0.01), ry1 = q(ys, 0.99);
    if (rx1 > rx0 && ry1 > ry0) { minX = rx0; maxX = rx1; minY = ry0; maxY = ry1; }
  }
  return { minX, maxX, minY, maxY, n: xs.length };
}
function fit3D() {
  let xmin = 1e18, xmax = -1e18, ymin = 1e18, ymax = -1e18, zmax = 0, has = 0;
  for (const s of v3.solids) {
    for (const [x, y] of s.poly) { xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
    zmax = Math.max(zmax, s.zt ? Math.max(...s.zt) : (s.z1 || 0)); has++;
  }
  // 평면 범위는 2D 전체보기와 같은 함수로 (BIM 은 위에서 솔리드가 이미 커버했다)
  const ex = modelExtents(false, (e) => !!e.bim);
  if (ex) {
    xmin = Math.min(xmin, ex.minX); xmax = Math.max(xmax, ex.maxX);
    ymin = Math.min(ymin, ex.minY); ymax = Math.max(ymax, ex.maxY);
    has++;
  }
  for (const e of state.entities) {   // z 는 3D 전용이라 여기서만 본다
    if (e.bim) continue;
    zmax = Math.max(zmax, e.zo || 0, e.z1 || 0, e.z2 || 0); // 공중에 띄운 도형·3D 선 높이 포함
    if (e.type === 'MESH' && e.tris) for (const t of e.tris) for (const q of t) zmax = Math.max(zmax, q[2]);
  }
  v3.hasContent = has > 0;
  if (!has) { v3.cx = 0; v3.cy = 0; v3.cz = 0; v3.fit = 10000; return; } // 빈 모델: 10m 기준
  v3.cx = (xmin + xmax) / 2; v3.cy = (ymin + ymax) / 2; v3.cz = zmax / 2;
  v3.fit = Math.max(xmax - xmin, ymax - ymin, zmax) || 1000;
  if (!isFinite(v3.fit)) v3.fit = 10000;
}
function syncViewSeg(is3d) {
  const p = document.getElementById('vwPlan'), d = document.getElementById('vw3d');
  const q = document.getElementById('vwQuad');
  if (!p || !d) return;
  // 통합 작업환경의 3상태: 평면 단일(평면 뷰포트 확대 또는 평면 전용 폴백) / 3D 단일 / 4분할
  const quadOn = is3d && v3 && v3.quad;
  const planFocus = !is3d || (v3 && !quadOn && vpPlanIndex() === v3.act);
  const seg = (el, on) => { el.style.background = on ? 'var(--accent)' : 'transparent'; el.style.color = on ? '#fff' : ''; };
  seg(p, planFocus && !quadOn);
  seg(d, is3d && !quadOn && !planFocus);
  if (q) seg(q, !!quadOn);
  // 3D 전용 도구함·작업면 Z 는 '3D 시점'일 때만 (평면 단일 시점에선 2D 도구가 맞다)
  const show3d = is3d && !planFocus;
  document.getElementById('toolbar')?.classList.toggle('show3d', show3d);
  const cps = document.getElementById('cplaneStatus'); if (cps) cps.style.display = show3d ? 'inline-flex' : 'none';
}
// 3D 열린 동안 모델 변경(속성 수정·삭제·undo) 감지 → 재빌드
let live3dTimer = null, live3dRev = -1, live3dSel = '';
function startLive3D() {
  stopLive3D();
  live3dRev = apiRev; live3dSel = [...state.selection].join(',');
  live3dTimer = setInterval(() => {
    const ov = document.getElementById('bim3d');
    if (!ov || ov.style.display === 'none') { stopLive3D(); return; }
    const selNow = [...state.selection].join(',');
    if (apiRev !== live3dRev || selNow !== live3dSel) {
      live3dRev = apiRev; live3dSel = selNow;
      v3.solids = bimSolids();
      if (v3.refitPending) { fit3D(); if (v3.hasContent) v3.refitPending = false; } // 빈 모델 → 첫 도형에 화면 맞춤
      render3D();
    }
  }, 300);
}
function stopLive3D() { if (live3dTimer) { clearInterval(live3dTimer); live3dTimer = null; } }
function usage3d() { if (window.WEBCAD_API && WEBCAD_API.onUsage) WEBCAD_API.onUsage('view3d'); }
function size3D() {
  const cvs = v3.cv, r = cvs.getBoundingClientRect();
  cvs.width = Math.max(2, r.width * (devicePixelRatio || 1));
  cvs.height = Math.max(2, r.height * (devicePixelRatio || 1));
}
function proj3D(x, y, z) {
  const dx = x - v3.cx, dy = y - v3.cy, dz = z - v3.cz;
  const c = Math.cos(v3.yaw), s = Math.sin(v3.yaw);
  const x1 = dx * c - dy * s, y1 = dx * s + dy * c;
  const cp = Math.cos(v3.pitch), sp = Math.sin(v3.pitch);
  const sx = x1, sy = y1 * sp + dz * cp, depth = y1 * cp - dz * sp;
  const vp = v3.vp || { x: 0, y: 0, w: v3.cv.width, h: v3.cv.height };
  const k = Math.min(vp.w, vp.h) / (v3.fit * 1.4) * v3.zoom;
  return [vp.x + vp.w / 2 + (sx + v3.panX) * k, vp.y + vp.h / 2 - (sy + v3.panY) * k, depth];
}
// 화면 캔버스 px → 월드 (z=ze 평면 위의 점) — proj3D의 역변환
function unproj3D(px, py, ze) {
  const vp = v3.vp || { x: 0, y: 0, w: v3.cv.width, h: v3.cv.height };
  const k = Math.min(vp.w, vp.h) / (v3.fit * 1.4) * v3.zoom;
  const sp = Math.sin(v3.pitch), cp = Math.cos(v3.pitch);
  const sx = (px - vp.x - vp.w / 2) / k - v3.panX;
  const sy = (vp.y + vp.h / 2 - py) / k - v3.panY;
  const dz = ze - v3.cz;
  // 거의 수평 시점(정면·우측면): 바닥면과 시선이 평행 → 모델 중심을 지나는 수직면에 투영
  // (화면 가로 = 해당 방향의 평면 좌표, 깊이는 모델 중심 고정 — 입면 보면서 위치 잡기용)
  const x1 = sx, y1 = Math.abs(sp) < 0.2 ? 0 : (sy - dz * cp) / sp;
  const cs = Math.cos(v3.yaw), sn = Math.sin(v3.yaw);
  return [x1 * cs + y1 * sn + v3.cx, -x1 * sn + y1 * cs + v3.cy];
}
// ── 뷰포트 유틸 (사분할) ──
function vpRect(i) {
  const W = v3.cv.width, H = v3.cv.height;
  if (!v3.quad) return { x: 0, y: 0, w: W, h: H };
  const w2 = Math.floor(W / 2), h2 = Math.floor(H / 2);
  return [{ x: 0, y: 0, w: w2, h: h2 }, { x: w2, y: 0, w: W - w2, h: h2 },
          { x: 0, y: h2, w: w2, h: H - h2 }, { x: w2, y: h2, w: W - w2, h: H - h2 }][i];
}
// ── 뷰포트 표시 모드 ──
// mode 'plan' 인 뷰포트는 3D 렌더러가 아니라 2D 엔진(draw())이 #cv 로 직접 그린다.
// 평면을 3D 파이프라인으로 "다시" 구현하지 않는 이유: 그게 정확히 '평면이 두 벌' 문제였다.
// 3D 밑그림 경로는 TEXT/HATCH/IMAGE/INSERT 를 통째로 버려서(아래 under 루프의 else continue)
// 치수는 선만 남고 숫자가 사라졌고, fit3D 도 같은 화이트리스트라 zoom 범위까지 2D와 어긋났다.
// → 성숙한 2D 엔진이 평면의 유일한 진실이고, 3D 렌더러는 평면 칸을 아예 건너뛴다.
const vpIsPlan = (i) => !!(v3 && v3.views[i] && v3.views[i].mode === 'plan');
// 지금 화면에 떠 있는 뷰포트 중 평면 칸의 인덱스 (없으면 -1)
function vpPlanIndex() {
  if (!v3) return -1;
  for (const i of (v3.quad ? [0, 1, 2, 3] : [v3.act])) if (vpIsPlan(i)) return i;
  return -1;
}
// vpRect 는 캔버스 좌표(디바이스 px). #cv 를 DOM 으로 배치하려면 CSS px 가 필요하다.
function vpRectCss(i) {
  const d = devicePixelRatio || 1, r = vpRect(i);
  return { x: r.x / d, y: r.y / d, w: r.w / d, h: r.h / d };
}
// #cv(2D 엔진) 가 차지해야 할 영역 — 평면 칸이 떠 있으면 그 칸, 아니면 캔버스 전체(3D 미개방 시 오늘과 동일)
function planCvRect() {
  const i = vpPlanIndex();
  if (i < 0 || !is3DActive()) { const r = wrap.getBoundingClientRect(); return { x: 0, y: 0, w: r.width, h: r.height }; }
  return vpRectCss(i);
}
function loadVp(i) { const w = v3.views[i]; v3.yaw = w.yaw; v3.pitch = w.pitch; v3.zoom = w.zoom; v3.panX = w.panX; v3.panY = w.panY; }
// 입면(파사드) 뷰 순환: 정면 → 우측면 → 좌측면 → 배면 (라벨 클릭)
const ELEV_ORDER = ['정면', '우측면', '좌측면', '배면'];
const ELEV_YAW = { '정면': 0, '우측면': -Math.PI / 2, '좌측면': Math.PI / 2, '배면': Math.PI };
function cycleElev(i) {
  const w = v3.views[i];
  if (!(w.name in ELEV_YAW)) return false;
  w.name = ELEV_ORDER[(ELEV_ORDER.indexOf(w.name) + 1) % ELEV_ORDER.length];
  w.yaw = ELEV_YAW[w.name]; w.pitch = 0;
  if (i === v3.act) loadVp(i);
  render3D(); saveV3Layout();
  logLine(`  ▷ 입면 뷰 전환: ${w.name}`, 'info');
  return true;
}
// 뷰 레이아웃(분할 여부·활성 뷰·각 뷰 방향·입면 종류) 저장/복원 — 줌·팬은 열 때마다 모델에 맞춤
function saveV3Layout() {
  try {
    localStorage.setItem('webcad_v3_layout2', JSON.stringify({
      quad: v3.quad, act: v3.act,
      views: v3.views.map(w => ({ name: w.name, yaw: w.yaw, pitch: w.pitch, fixed: !!w.fixed })),
    }));
  } catch (_) {}
}
function saveVp() { const w = v3.views[v3.act]; w.yaw = v3.yaw; w.pitch = v3.pitch; w.zoom = v3.zoom; w.panX = v3.panX; w.panY = v3.panY; }
function vpAt(px, py) {
  if (!v3.quad) return v3.act;
  return (px < v3.cv.width / 2 ? 0 : 1) + (py < v3.cv.height / 2 ? 0 : 2);
}
let _lastSegSig = '';
function render3D() {
  const c = v3.ctx, W = v3.cv.width, H = v3.cv.height;
  saveVp(); // 현재 조작 파라미터를 활성 뷰에 보존
  { // 통합 세그 하이라이트 — 어떤 경로(라벨 클릭·더블클릭 확대 등)로 뷰가 바뀌어도 따라온다
    const sig = (v3.quad ? 1 : 0) + ':' + v3.act;
    if (sig !== _lastSegSig) { _lastSegSig = sig; syncViewSeg(true); }
  }
  c.clearRect(0, 0, W, H);
  // 조명 보기(야간)는 어두운 배경. 태양이 켜져 있으면 낮이므로 옅은 하늘색을 깐다.
  if (sunOn()) { c.fillStyle = '#8fa9c4'; c.fillRect(0, 0, W, H); }
  else if (v3.lighting) { c.fillStyle = '#0a0c14'; c.fillRect(0, 0, W, H); }
  const dpr = devicePixelRatio || 1;
  v3.grip = null; v3.gum = null;
  const order = v3.quad ? [0, 1, 2, 3] : [v3.act];
  // 단일 화면(화면 키우기)에선 다른 칸의 DOM 이름표를 숨긴다 — 루프가 활성 칸만 돌므로
  // 여기서 안 지우면 4분할 시절 이름표('평면·정면·우측면')가 옛 자리에 계속 떠 있다 (사용자 스크린샷)
  if (!v3.quad) for (let k = 0; k < 4; k++) if (k !== v3.act) vpHideLabel(k);
  for (const i of order) {
    const r = vpRect(i);
    if (vpIsPlan(i)) { // 평면 칸은 2D 엔진이 #cv 로 그린다 (syncPlanCv). 3D 렌더러는 손대지 않는다.
      c.clearRect(r.x, r.y, r.w, r.h);
      continue;
    }
    v3.vp = r; loadVp(i);
    // ★렌더링 뷰가 덮은 칸은 조명·그림자를 계산하지 않는다.
    // 실측: 기둥 40개 + 태양 ON 에서 정밀 178.6ms vs 빠름 13.7ms 인데, 그 그림은 #rvcv(z17)가
    // 완전히 가려서 아무도 못 본다 — 안 보이는 그림에 178ms 를 태우고 궤도가 6fps 였다.
    // _fast 경로도 피킹 배열(v3.pick)은 그대로 만들므로 선택은 계속 된다.
    // (사용자가 말한 D5 원리 '눈에 안 보이는 부분은 잠시 안 보이게' 가 정확히 여기 필요했다)
    // 렌더링 뷰든 레이트레이싱이든, 덮인 칸의 소프트웨어 조명은 아무도 못 본다 (실측 178.6ms → 13.7ms)
    const covered = vpIsRendered(i) || vpIsRt(i);
    const keepFast = v3._fast;
    if (covered) v3._fast = true;
    c.save(); c.beginPath(); c.rect(r.x, r.y, r.w, r.h); c.clip();
    // 작업 표시 3D 칸 배경 = 평면 칸과 같은 캔버스색(라이트=흰색). 예전엔 투명이라 뒤의
    // 오버레이(--bg 옅은 회색)가 비쳐 평면 칸만 희고 나머지는 회색이었다 (2026-07-20 사용자).
    // 태양(하늘)·야간(어둠) 배경은 위에서 이미 칠했으므로 그때는 덮지 않는다. 렌더/RT 칸은
    // 별도 캔버스가 완전히 덮으므로 굳이 칠하지 않는다.
    if (!covered && !sunOn() && !v3.lighting) { c.fillStyle = getCSS('--canvas-bg') || '#ffffff'; c.fillRect(r.x, r.y, r.w, r.h); }
    const res = renderScene(i === v3.act);
    c.restore();
    v3._fast = keepFast;
    // 이름표는 항상 DOM 으로 (덮인 칸은 rviewFrame/rtFrame 이 올리고, 일반 칸은 여기서).
    // 캔버스에 fillText 하던 것을 없앴다 — 우클릭 메뉴를 받으려면 이름표가 실제 요소여야 한다.
    if (!covered) vpShowLabel(i, null);
    v3.views[i]._faces = res.faces; v3.views[i]._under = res.under; v3.views[i]._pick = res.pick;
    if (v3.quad) {
      c.strokeStyle = i === v3.act ? '#0A84FF' : (getCSS('--line') || 'rgba(120,140,180,.3)');
      c.lineWidth = i === v3.act ? 1.5 : 1;
      c.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    }
  }
  loadVp(v3.act); v3.vp = vpRect(v3.act);
  // 평면 칸이 활성이면 3D 면 목록이 없다 — 그 칸의 피킹은 2D pick() 이 맡으므로 빈 배열로 둔다.
  // (undefined 로 두면 pick3DAt/findFaceAt 이 v3.faces 를 훑다가 터진다)
  v3.faces = v3.views[v3.act]._faces || []; v3.under = v3.views[v3.act]._under || []; v3.pick = v3.views[v3.act]._pick || [];
  syncPlanCv(); // 평면 칸 위치·크기 동기화 + 2D 엔진 재그림
  rviewFrame(); // 렌더링 뷰가 켜져 있으면 그 뷰포트에 실시간 래스터를 겹친다
  rtFrame();    // 레이트레이싱이 켜져 있으면 그 뷰포트에 맞춘다 (자기 칸에만)
  if (v3.boxRect) { // 선택 박스 러버밴드 (드래그 중)
    const b = v3.boxRect, crossing = b.x1 < b.x0;
    c.save();
    c.strokeStyle = crossing ? '#30d158' : '#0A84FF';
    c.fillStyle = crossing ? 'rgba(48,209,88,.08)' : 'rgba(10,132,255,.08)';
    c.setLineDash(crossing ? [5, 4] : []); c.lineWidth = 1.5;
    const rx = Math.min(b.x0, b.x1), ry = Math.min(b.y0, b.y1);
    c.fillRect(rx, ry, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
    c.strokeRect(rx, ry, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
    c.restore();
  }
  const qb = document.getElementById('vwQuad');
  if (qb) { qb.style.background = v3.quad ? 'var(--accent)' : 'transparent'; qb.style.color = v3.quad ? '#fff' : ''; }
  if (window.__BIM3D_DEBUG) {
    window.__BIM3D_STATS = { solids: v3.solids.length, faces: v3.faces.length };
    window.__BIM3D_TEST = { v3, render3D, pick3DAt, size3D, unproj3D, proj3D, wall3DClick, vpAt, loadVp, vpRect };
  }
}
// 한 뷰포트의 장면 렌더 (v3.vp/yaw/pitch/zoom/pan 기준) — isActive면 그립/검볼/미리보기 포함
// ============================================================
//  소프트웨어 Z-버퍼 래스터라이저 — 은면 제거(hidden surface)
//  painter 정렬은 겹치는 면에서 뒤가 새어나옴 → 픽셀 깊이 비교로 해결
// ============================================================
// 조작 중 빠른 렌더 (painter 정렬) — 드래그가 끊기지 않도록
function paintFaces(c, faces, light) {
  faces.sort((a, b) => b.d - a.d);
  for (const f of faces) {
    const isSel = f.eid != null && state.selection.has(f.eid);
    c.beginPath(); f.pts.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.closePath();
    const rfGhost = f.rf && v3.roof === 'ghost';
    c.globalAlpha = f.glass ? 0.45 : rfGhost ? 0.22 : 1;
    c.fillStyle = isSel ? shadeColor('#0A84FF', 0.6 + 0.4 * f.shade)
      : (f.sh3 ? `rgb(${shadeColor3(f.color, f.sh3).join(',')})` : shadeColor(f.color, f.shade)); c.fill();
    c.globalAlpha = f.glass ? 0.6 : rfGhost ? 0.3 : 1;
    c.strokeStyle = isSel ? '#5eb1ff' : (light ? 'rgba(30,40,70,.35)' : 'rgba(10,16,32,.55)');
    c.lineWidth = isSel ? 2 : 1; c.stroke(); c.globalAlpha = 1;
  }
}
// 조작 중 렌더 코얼레싱 — 프레임당 최대 1회만 render3D (과도한 렌더로 인한 렉 방지)
function markInteract() {
  if (!v3) return;
  // Raytraced: 카메라가 움직이면 누적을 리셋해야 한다 — 안 하면 이전 각도의 샘플이 섞여 뭉개진다.
  // markInteract는 궤도·줌·팬·편집이 모두 지나는 공통 지점이라 여기 한 곳에만 걸면 빠짐이 없다.
  if (rt.on) rtCameraChanged();
  // 조명 보기에서 그림자는 비싸다(면×광원×가림형상). 궤도·드래그 중엔 생략해 부드럽게,
  // 멈추면 잠시 뒤 그림자까지 넣어 다시 그린다 — '조작 중 빠른 렌더 / 멈추면 정확 렌더'.
  if (v3.lighting || sunOn()) {
    v3._fast = true;
    clearTimeout(v3._settleT);
    v3._settleT = setTimeout(() => { v3._fast = false; render3D(); }, 180);
  }
  if (v3._rafPending) return;
  v3._rafPending = true;
  requestAnimationFrame(() => { v3._rafPending = false; render3D(); });
}
// 스캔라인 래스터: 각 행에서 삼각형과 교차하는 x-구간만 순회 (bbox 낭비 제거 → 얇은 삼각형에서 특히 빠름)
// cA/cB/cC (정점별 [r,g,b])가 오면 꼭짓점 색을 보간해 칠한다(구로 셰이딩) — 곡면의 면 단차 제거.
// 없으면 예전대로 단색(평면 셰이딩). 보간은 이미 계산 중인 무게중심 좌표를 그대로 쓴다.
function zTri(data, zb, fb, fid, W, H, ox, oy, A, B, C, r, g, b, cA, cB, cC) {
  const ax = A[0]-ox, ay = A[1]-oy, bx = B[0]-ox, by = B[1]-oy, cx = C[0]-ox, cy = C[1]-oy;
  const area = (by-cy)*(ax-cx) + (cx-bx)*(ay-cy);
  if (Math.abs(area) < 1e-9) return;
  const ia = 1/area;
  const minY = Math.max(0, Math.floor(Math.min(ay,by,cy)));
  const maxY = Math.min(H-1, Math.ceil(Math.max(ay,by,cy)));
  const E = [[ax,ay],[bx,by],[cx,cy]];
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    // 세 모서리와 수평선 py의 교차 x 수집
    let lo = Infinity, hi = -Infinity;
    for (let e = 0; e < 3; e++) {
      const p1 = E[e], p2 = E[(e+1)%3];
      const y1 = p1[1], y2 = p2[1];
      if ((py >= y1 && py < y2) || (py >= y2 && py < y1)) {
        const x = p1[0] + (p2[0]-p1[0]) * (py - y1) / (y2 - y1);
        if (x < lo) lo = x; if (x > hi) hi = x;
      }
    }
    if (lo > hi) continue;
    let xs = Math.max(0, Math.floor(lo)), xe = Math.min(W-1, Math.ceil(hi));
    const rowBase = y*W;
    for (let x = xs; x <= xe; x++) {
      const px = x + 0.5;
      const w0 = ((by-cy)*(px-cx) + (cx-bx)*(py-cy)) * ia;
      const w1 = ((cy-ay)*(px-cx) + (ax-cx)*(py-cy)) * ia;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
      const z = w0*A[2] + w1*B[2] + w2*C[2];
      const idx = rowBase + x;
      if (z < zb[idx]) {
        zb[idx] = z; fb[idx] = fid; const p = idx*4;
        if (cA) { // 구로 셰이딩 — 정점 색 보간
          data[p]   = (w0*cA[0] + w1*cB[0] + w2*cC[0]) | 0;
          data[p+1] = (w0*cA[1] + w1*cB[1] + w2*cC[1]) | 0;
          data[p+2] = (w0*cA[2] + w1*cB[2] + w2*cC[2]) | 0;
        } else { data[p]=r; data[p+1]=g; data[p+2]=b; }
        data[p+3]=255;
      }
    }
  }
}
function zLine(data, zb, fb, fid, W, H, ox, oy, A, B, r, g, b, eps) {
  const x0 = A[0]-ox, y0 = A[1]-oy, z0 = A[2], x1 = B[0]-ox, y1 = B[1]-oy, z1 = B[2];
  const dx = x1-x0, dy = y1-y0, steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
  // 은선 판정 — 깊이 관용(eps) 방식은 원리적으로 뚫린다: 실루엣·코너 근처의 비스듬한 면에서
  // '뒤에 숨은 코너 수직선' 과 표면의 깊이차가 관용 이하로 좁아지는 픽셀 열이 반드시 생긴다
  // (extrudecrv 벽 모퉁이마다 세로 줄무늬 — 사용자 스크린샷. eps 48→12 축소로도 잔존 실측).
  // 그래서 깊이 대신 픽셀 소유 면(fb)으로 판정한다: **이 선을 그리는 면(fid)이 그 픽셀
  // (반올림 오차 보정으로 상하좌우 1px 포함)의 승자일 때만** 그린다. 자기 면이 보이는 곳의
  // 경계선만 남고, 가려진 선은 어떤 기하에서도 절대 나오지 않는다. (eps 는 이제 안 쓴다)
  for (let s = 0; s <= steps; s++) {
    const t = s/steps, x = Math.round(x0+dx*t), y = Math.round(y0+dy*t);
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const idx = y*W + x;
    const own = fb[idx] === fid
      || (x > 0 && fb[idx-1] === fid) || (x < W-1 && fb[idx+1] === fid)
      || (y > 0 && fb[idx-W] === fid) || (y < H-1 && fb[idx+W] === fid);
    if (own) { const p = idx*4; data[p]=r; data[p+1]=g; data[p+2]=b; data[p+3]=255; }
  }
}
function rgbTriplet(hexOrRgb) {
  const m = hexOrRgb.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return [+m[1], +m[2], +m[3]];
  return [parseInt(hexOrRgb.slice(1,3),16), parseInt(hexOrRgb.slice(3,5),16), parseInt(hexOrRgb.slice(5,7),16)];
}
function zRasterFaces(c, faces, vp, light) {
  const opaque = [], overlay = [];
  for (const f of faces) { (f.glass || (f.rf && v3.roof === 'ghost')) ? overlay.push(f) : opaque.push(f); }
  // 불투명 면들의 실제 화면 영역만 처리 (부분 화면 모델에서 크게 빠름)
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const f of opaque) for (const p of f.pts) { if (p[0] < bx0) bx0 = p[0]; if (p[0] > bx1) bx1 = p[0]; if (p[1] < by0) by0 = p[1]; if (p[1] > by1) by1 = p[1]; }
  const ox = Math.max(vp.x, Math.floor(bx0)) | 0, oy = Math.max(vp.y, Math.floor(by0)) | 0;
  const ex = Math.min(vp.x + vp.w, Math.ceil(bx1)) | 0, ey = Math.min(vp.y + vp.h, Math.ceil(by1)) | 0;
  const W = ex - ox, H = ey - oy;
  if (W > 0 && H > 0 && opaque.length) {
    const img = c.getImageData(ox, oy, W, H), data = img.data;
    const zb = (v3._zb && v3._zb.length === W*H) ? v3._zb : (v3._zb = new Float32Array(W*H));
    zb.fill(Infinity);
    // 픽셀 소유 면 버퍼 — 모서리 선의 은선 판정용 (zLine 참고)
    const fb = (v3._fb && v3._fb.length === W*H) ? v3._fb : (v3._fb = new Int32Array(W*H));
    fb.fill(-1);
    const cache = v3._rgbCache || (v3._rgbCache = new Map()); // 색상(색+명암) 캐시 — 매 면 정규식 회피
    let fidSeq = 0;
    for (const f of opaque) {
      const isSel = f.eid != null && state.selection.has(f.eid);
      // sh3 = 채널별 밝기(색번짐). 없으면 예전처럼 스칼라 하나 — 기존 화면 불변.
      const t3 = !isSel && f.sh3;
      const key = (isSel ? 'S' : f.color) + '|' + (t3 ? (Math.round(f.sh3[0]*24)+','+Math.round(f.sh3[1]*24)+','+Math.round(f.sh3[2]*24)) : Math.round(f.shade * 24));
      let rgb = cache.get(key);
      if (!rgb) { rgb = t3 ? shadeColor3(f.color, f.sh3) : rgbTriplet(isSel ? shadeColor('#0A84FF', 0.6 + 0.4*f.shade) : shadeColor(f.color, f.shade)); cache.set(key, rgb); }
      f._r = rgb[0]; f._g = rgb[1]; f._b = rgb[2]; f._sel = isSel; f._vis = true;
      f._fid = fidSeq++;
      const P = f.pts;
      // 곡면(원통·구 등): 정점별 셰이드(vsh)를 색으로 바꿔 보간 → 분절 사이 밝기 계단 제거.
      // 선택 강조·조도 색표시 중엔 단색 유지(그 상태의 색 의미를 흐리지 않게).
      let VC = null;
      if (f.vsh && !isSel && !v3.falseColor) {
        VC = f.vsh.map(s => {
          const k2 = f.color + '|v' + Math.round(s * 60);
          let c2 = cache.get(k2);
          if (!c2) { c2 = rgbTriplet(shadeColor(f.color, s)); cache.set(k2, c2); }
          return c2;
        });
      }
      for (let i = 1; i+1 < P.length; i++)
        zTri(data, zb, fb, f._fid, W, H, ox, oy, P[0], P[i], P[i+1], rgb[0], rgb[1], rgb[2],
          VC ? VC[0] : null, VC ? VC[i] : null, VC ? VC[i+1] : null);
    }
    // 모서리 선의 기본 깊이 관용 — '화면 1px 이 담는 세계 mm' 기준.
    // ★예전 fit×0.008(6m 모델에서 48mm)은 실루엣 근처 비스듬한 면에서 벽 두께(200mm) 안의
    // 숨은 코너 수직선까지 통과시켰다(extrudecrv 상자 모퉁이마다 세로 줄무늬 — 사용자 스크린샷).
    // 픽셀 스케일 기준이면 줌과 무관하게 '반올림 오차만큼' 만 관용하고, 가파른 선의 추가 관용은
    // zLine 이 선 자체의 픽셀당 깊이 변화로 보탠다.
    const pxMM = (v3.fit * 1.4) / (Math.min(vp.w, vp.h) || 1) / (v3.zoom || 1);
    const eps = v3._edgeEps != null ? v3._edgeEps : Math.max(0.5, pxMM * 1.0);   // fb 판정이 주력 — eps 는 반올림 보정만
    const [er, eg, eb] = light ? [70, 85, 120] : [12, 18, 36];
    // 내부 이음선 숨김 — 같은 개체(eid)에서 '같은 평면'(shade 동일) 면 2개가 공유하는 변(밴드 분할선:
    // 벽 링 윗면의 마이터 대각선 등)은 그 개체의 '모든' 면에서 그리지 않음.
    // (컬링에서 살아남은 마이터 캡 면이 같은 선분을 혼자 그리는 것까지 차단해야 코너 선이 안 남음)
    // 윗면↔옆면(shade 다름)·코너 수직선(옆면끼리 방향 달라 shade 다름)은 그대로 남음.
    const edgeK = (a, b) => { const q = v => Math.round(v * 4) / 4; const ka = q(a[0]) + ',' + q(a[1]), kb = q(b[0]) + ',' + q(b[1]); return ka < kb ? ka + '|' + kb : kb + '|' + ka; };
    const seamShades = new Map(); // eid§변 → Map(shade반올림 → 등장 면 수)
    for (const f of opaque) {
      if (f.isMesh || f.eid == null) continue; // 메시는 자체 특징모서리(fe)로 처리
      // 조명 조각은 밝기가 조각마다 다른 게 정상이라 shade로 '같은 평면'을 판정할 수 없다.
      // 같은 면 종류(top/bot)끼리 묶어야 밴드 사이 분할선이 조명 상태에서도 숨는다.
      const P = f.pts, s = f.sub ? 'L' + f.fk : Math.round(f.shade * 50), seen = new Set();
      for (let i = 0; i < P.length; i++) {
        const k = f.eid + '§' + edgeK(P[i], P[(i + 1) % P.length]);
        if (seen.has(k)) continue; seen.add(k); // 퇴화 면(높이 0 옆면) 내부의 중복 변은 1회만 집계
        let m = seamShades.get(k); if (!m) seamShades.set(k, m = new Map());
        m.set(s, (m.get(s) || 0) + 1);
      }
    }
    const seamHide = new Set();
    for (const [k, m] of seamShades) { for (const cnt of m.values()) if (cnt >= 2) { seamHide.add(k); break; } }
    let seamHidden = 0;
    for (const f of opaque) {
      const P = f.pts, sel = f._sel;
      const R = sel ? 94 : er, G = sel ? 177 : eg, B = sel ? 255 : eb;
      // fe = '진짜 모서리' 표시. 메시는 삼각분할 내부선, 조명 조각은 세분화 내부선을
      // 여기서 걸러 표면에 격자가 생기지 않게 한다.
      for (let i = 0; i < P.length; i++) {
        if (f.fe && !f.fe[i]) continue;
        if (!f.isMesh && f.eid != null && seamHide.has(f.eid + '§' + edgeK(P[i], P[(i + 1) % P.length]))) { seamHidden++; continue; } // 내부 이음선
        zLine(data, zb, fb, f._fid, W, H, ox, oy, P[i], P[(i+1)%P.length], R, G, B, eps);
      }
    }
    v3._seamHidden = seamHidden; // 검증용 카운터
    c.putImageData(img, ox, oy);
  }
  // 반투명(유리·지붕 고스트): 합성 위에 알파로
  overlay.sort((a, b) => b.d - a.d);
  for (const f of overlay) {
    c.beginPath(); f.pts.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.closePath();
    c.globalAlpha = f.glass ? 0.42 : 0.22; c.fillStyle = shadeColor(f.color, f.shade); c.fill();
    c.globalAlpha = 1;
  }
}
function renderScene(isActive) {
  const c = v3.ctx;
  const faces = [];
  // ★ 피킹 전용 면 목록 — 표시용(faces)과 분리한다.
  // faces 는 조명 상태에 따라 pushLitPoly 가 면을 잘게 쪼개 넣는다(빛 웅덩이 표현).
  // 그런데 pick3DAt 이 그 배열을 쓰고 있어서, 태양/조명을 켜면 같은 자리를 클릭해도
  // 다른 면(fi)이 잡혔다 — extrudesrf 의 면 밀당이 엉뚱한 변을 잡는 원인.
  // (실측: 기둥 옆면 같은 점 클릭 → 태양 OFF fi=1 / ON fi=0)
  // pickFaces 는 쪼개기·_fast 와 무관하게 '통짜 면' 만 담는다 → 피킹이 조명에 흔들리지 않는다.
  const pickFaces = [];
  // 태양만 켜도 조명 계산이 돌아야 한다 — 안 그러면 sun 을 켜도 화면이 그대로다
  const litOn = v3.lighting || sunOn();
  v3._sh = skySH();          // 방향별 천공광 — 태양 설정이 그대로면 다시 접지 않는다
  v3._lights = litOn ? lightSources() : null; // 프레임당 1회 광원 수집 (둘 다 OFF면 null → 예전 셰이딩)
  // 그림자용 가림 형상도 프레임당 1회. 삼각형이 상한을 넘으면 그림자만 생략(조명은 유지) — 느려지는 것보다 낫다.
  if (litOn && !v3._fast && v3._lights && v3._lights.length) {
    const occ = shadowOccluders();
    v3._occ = occ.length >= SHADOW_TRI_CAP ? null : occ;
    if (!v3._occ && !v3._occWarned) { v3._occWarned = 1; logLine(`  ▷ 형상이 많아(삼각형 ${SHADOW_TRI_CAP}+) 그림자는 생략합니다 — 조명은 그대로 동작`, 'warn'); }
  } else v3._occ = null;
  // 간접광은 가림 형상이 있어야 계산할 수 있다 (광선을 쏘아 맞는 면을 찾으므로). 조작 중엔 생략.
  v3._bounce = (litOn && !v3._fast && v3._occ) ? bounceLights() : null;
  if (litOn) {
    const sg = litCacheSig();
    // 예산: 그림자 경계 세분의 상한. 다 쓰면 경계 세분만 멈춘다(조명·그림자 자체는 동작).
    // 태양은 장면 전체에 그림자를 드리우므로 인공조명보다 경계가 훨씬 많다 —
    // 1200 으로는 벽 20장 장면에서 이미 소진돼(잔량 8) 그림자 기울기가 계단으로 남았다.
    if (v3._litSig !== sg) { v3._litCache = new Map(); v3._litSig = sg; v3._litBudget = sunOn() ? 4000 : 1200; }
  }
  else { v3._litCache = null; v3._litSig = null; }
  // 바닥 그리드 (z=0, 모델 주변)
  const g = Math.pow(10, Math.round(Math.log10(v3.fit / 8)));
  const gx0 = Math.floor((v3.cx - v3.fit) / g) * g, gx1 = v3.cx + v3.fit, gy0 = Math.floor((v3.cy - v3.fit) / g) * g, gy1 = v3.cy + v3.fit;
  c.strokeStyle = getCSS('--grid') || 'rgba(140,160,220,.1)'; c.lineWidth = 1;
  c.beginPath();
  for (let x = gx0; x <= gx1; x += g) { const a = proj3D(x, gy0, 0), b = proj3D(x, gy1, 0); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); }
  for (let y = gy0; y <= gy1; y += g) { const a = proj3D(gx0, y, 0), b = proj3D(gx1, y, 0); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); }
  c.stroke();
  // 평면 밑그림 — BIM 지정 안 된 일반 도형도 해당 층 레벨 높이에 라인워크로 표시 (평면↔3D 연속성)
  // 투영 경로를 캐시해 클릭 픽킹(pick3DAt)에서 재사용 (활성 뷰 것만 v3.under로 노출)
  const under = [];
  c.save();
  c.lineWidth = 1;
  for (const e of state.entities) {
    if (e.bim) continue; // BIM 요소는 아래에서 솔리드로 그려짐 (광원 지정은 bim을 바꾸지 않으므로 여기 영향 없음)
    const l = getLayer(e.layer); if (l && !l.visible) continue;
    const z = (state.levels[e.lv || 0] || { elev: 0 }).elev + (e.zo || 0); // zo = 검볼 Z로 띄운 3D 표시 높이
    let path = null, closed = false;
    if (e.type === 'LINE') { // 3D 선: 정점별 z
      path = [proj3D(e.x1, e.y1, e.z1 != null ? e.z1 : z), proj3D(e.x2, e.y2, e.z2 != null ? e.z2 : z)];
    } else if (e.type === 'LWPOLYLINE' && e.points && e.points.length) {
      path = e.points.map((p, i) => proj3D(p[0], p[1], polyZ(e, i, z))); closed = !!e.closed; // zs = 표면 위 곡선의 정점별 높이
    } else if (e.type === 'CIRCLE') {
      path = []; for (let i = 0; i <= 32; i++) { const t = i / 32 * Math.PI * 2; path.push(proj3D(e.cx + e.r * Math.cos(t), e.cy + e.r * Math.sin(t), z)); }
    } else if (e.type === 'ARC') {
      let s0 = e.startAngle, e0 = e.endAngle; if (e0 < s0) e0 += 360;
      const steps = Math.max(8, Math.ceil((e0 - s0) / 10));
      path = []; for (let i = 0; i <= steps; i++) {
        const a = (s0 + (e0 - s0) * i / steps) * Math.PI / 180;
        path.push(proj3D(e.cx + e.r * Math.cos(a), e.cy + e.r * Math.sin(a), z));
      }
    } else continue; // TEXT/치수/해치 등은 3D 밑그림 생략
    under.push({ eid: e.id, path, closed });
    const isSel = state.selection.has(e.id);
    c.globalAlpha = isSel ? 0.95 : 0.5;
    c.strokeStyle = isSel ? '#0A84FF' : entityColor(e);
    c.lineWidth = isSel ? 2.5 : 1;
    c.beginPath();
    path.forEach((q, i) => i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]));
    if (closed) c.closePath();
    c.stroke();
  }
  c.restore();
  // 면 수집: 측면(모서리별 사각) + 상/하면
  const epsW = Math.max(1, v3.fit * 0.01); // 백페이스 판정용 월드 오프셋
  for (const s of v3.solids) {
    if (s.rf && v3.roof === 'hide') continue; // 지붕 숨김 모드
    const n = s.poly.length;
    const zt = s.zt || s.poly.map(() => s.z1);
    // zb = 정점별 바닥 높이(선택) — 지형·표면 위 곡선을 따라 세운 벽처럼 바닥이 기울어진 솔리드용.
    // 없으면 예전대로 평평한 s.z0. (s.z0은 항상 min(zb)로 유지되므로 다른 코드는 그대로 동작)
    const zb = s.zb || s.poly.map(() => s.z0);
    // ptop = 윗면 다각형(선택). 바닥과 XY 가 달라도 되므로 기울어진·좁아지는·비틀린
    // 매스(각뿔대·전단 프리즘)를 한 솔리드로 표현할 수 있다. 없으면 예전대로 수직 프리즘.
    const pTop = s.ptop && s.ptop.length === n ? s.ptop : s.poly;
    const top = pTop.map((p, i) => proj3D(p[0], p[1], zt[i]));
    const bot = s.poly.map((p, i) => proj3D(p[0], p[1], zb[i]));
    const cull = !s.open; // 닫힌 솔리드만 백페이스 컬링 (서피스·유리는 양면 표시)
    let ccx = 0, ccy = 0; for (const p of s.poly) { ccx += p[0]; ccy += p[1]; } ccx /= n; ccy /= n;
    const midz = (Math.min(...zb) + Math.max(...zt)) / 2;
    // 면이 카메라를 향하는가: 법선 방향으로 살짝 이동 시 깊이가 줄면(가까워지면) 정면
    const facesCam = (wx, wy, wz, nx, ny, nz) => proj3D(wx + nx * epsW, wy + ny * epsW, wz + nz * epsW)[2] < proj3D(wx, wy, wz)[2];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const quad = [bot[i], bot[j], top[j], top[i]];
      const ex = s.poly[j][0] - s.poly[i][0], ey = s.poly[j][1] - s.poly[i][1];
      const el = Math.hypot(ex, ey) || 1;
      let onx = ey / el, ony = -ex / el; // 바깥 방향 후보
      const mx = (s.poly[i][0] + s.poly[j][0]) / 2, my = (s.poly[i][1] + s.poly[j][1]) / 2;
      if ((mx - ccx) * onx + (my - ccy) * ony < 0) { onx = -onx; ony = -ony; } // 중심 반대쪽 = 바깥
      if (cull && !facesCam(mx, my, midz, onx, ony, 0)) continue; // 안쪽 면(카메라 반대) 제외
      const lightA = Math.abs(onx * 0.8 + ony * 0.35);
      let sSh, sSh3 = null, sFc = null;
      if (s.glow) sSh = 1;
      else if (v3.falseColor) { sSh = 1; sFc = falseColor(illuminanceAt(mx, my, midz, onx, ony, 0), v3.fcMax); } // 조도 색표시
      else if (litOn) { sSh = litFace(mx, my, midz, onx, ony, 0, !!s.lit); if (LIT_RGB[3]) sSh3 = [LIT_RGB[0], LIT_RGB[1], LIT_RGB[2]]; } // 색번짐
      else sSh = 0.55 + 0.45 * lightA;
      const qd = (quad[0][2] + quad[1][2] + quad[2][2] + quad[3][2]) / 4;
      // 곡면(원·호에서 나온 솔리드): 분절 사이의 '세로 이음선'은 진짜 모서리가 아니다 —
      // quad = [bot_i, bot_j, top_j, top_i] 이므로 변 1·3(세로)만 숨기고 위·아래 링은 남긴다.
      // 이게 없으면 64각이어도 면 경계마다 세로 줄이 그려져 표면에 잔선이 남는다.
      const fe = s.curv ? [true, false, true, false] : null;
      // 곡면: 정점 법선(그 점의 반경 방향)으로 정점 셰이드를 만들어 보간 → 면마다 끊기는 밝기 계단 제거.
      // quad = [bot_i, bot_j, top_j, top_i] 이므로 좌(i)·우(j) 두 값만 있으면 된다.
      let vsh = null;
      if (s.curv && !s.glow && !v3.falseColor) {
        // 곡률 중심: 솔리드가 진짜 원 중심(cc)을 실어주면 그걸 쓴다(곡선 벽 밴드) — 없으면
        // 무게중심(단일 링 솔리드는 무게중심=원 중심이라 동일). 인접 밴드가 같은 중심을 보므로
        // 공유 정점의 법선·셰이드가 정확히 이어져 곡면이 연속으로 매끈해진다.
        const cgx = s.cc ? s.cc[0] : ccx, cgy = s.cc ? s.cc[1] : ccy;
        const vn = (px, py) => { const dx = px - cgx, dy = py - cgy, L2 = Math.hypot(dx, dy) || 1; return [dx / L2, dy / L2]; };
        // 정점 법선: 자유곡선 벽(vnrm)이면 밴드가 실어준 법선을 그대로(poly=[A1,B1,B2,A2] →
        // 0·3=시작 정점, 1·2=끝 정점), 아니면 곡률 중심 기준 반경 방향.
        const nOf = s.vnrm
          ? (pi) => s.vnrm[(pi === 0 || pi === 3) ? 0 : 1]
          : (pi) => vn(s.poly[pi][0], s.poly[pi][1]);
        const shOf = (nrm) => {
          const sgn = (nrm[0] * onx + nrm[1] * ony) < 0 ? -1 : 1;   // 안쪽 면이면 법선도 안쪽으로
          const ax = nrm[0] * sgn, ay = nrm[1] * sgn;
          return litOn ? litFace(mx, my, midz, ax, ay, 0, !!s.lit) : 0.55 + 0.45 * Math.abs(ax * 0.8 + ay * 0.35);
        };
        const sL = shOf(nOf(i)), sR = shOf(nOf(j));
        vsh = [sL, sR, sR, sL];
      }
      faces.push({ pts: quad, d: qd, color: sFc || s.color, shade: sSh, sh3: sSh3, glass: s.glass, eid: s.eid, rf: s.rf, fk: 'side', fi: i, si: s.seg != null ? s.seg : null, sz0: s.z0, ...(fe ? { fe } : {}), ...(vsh ? { vsh } : {}) });
      pickFaces.push({ pts: quad, d: qd, eid: s.eid, fk: 'side', fi: i, si: s.seg != null ? s.seg : null, sz0: s.z0 });
    }
    const tcz = Math.max(...zt);
    if (!cull || facesCam(ccx, ccy, tcz, 0, 0, 1)) {  // 상면 (위 향함)
      const mTop = { color: s.color, glass: s.glass, eid: s.eid, rf: s.rf, fk: 'top' };
      const dTop = top.reduce((a, p) => a + p[2], 0) / n;
      pickFaces.push({ pts: top, d: dTop, eid: s.eid, fk: 'top', fi: null, si: s.seg != null ? s.seg : null, sz0: s.z0 });
      if (litOn && !v3._fast && !s.glow) pushLitPoly(faces, pTop, zt, 1, mTop, s.eid + '|t|' + (s.seg != null ? s.seg : '') + '|' + Math.round(s.z1), !!s.lit); // 넓은 면에도 빛 웅덩이가 보이게 (조작 중엔 생략)
      else faces.push({ ...mTop, pts: top, d: dTop, shade: s.glow ? 1 : 1.0 });
    }
    if (!cull || facesCam(ccx, ccy, Math.min(...zb), 0, 0, -1)) { // 하면 (아래 향함)
      const mBot = { color: s.color, glass: s.glass, eid: s.eid, rf: s.rf, fk: 'bot' };
      const dBot = bot.reduce((a, p) => a + p[2], 0) / n;
      pickFaces.push({ pts: bot, d: dBot, eid: s.eid, fk: 'bot', fi: null, si: s.seg != null ? s.seg : null, sz0: s.z0 });
      if (litOn && !v3._fast && !s.glow) pushLitPoly(faces, s.poly, zb, -1, mBot, s.eid + '|b|' + (s.seg != null ? s.seg : '') + '|' + Math.round(s.z0), !!s.lit);
      else faces.push({ ...mBot, pts: bot, d: dBot, shade: s.glow ? 1 : 0.5 });
    }
  }
  // 가져온/불리언 3D 메시 — 삼각형별 법선 셰이딩. 내부 삼각분할선은 감추고 '진짜 모서리'만 표시
  for (const e of state.entities) {
    if (e.type !== 'MESH') continue;
    const l = getLayer(e.layer); if (l && !l.visible) continue;
    const featSet = meshFeat(e); // 이 메시의 특징(코너·경계) 모서리 집합
    const vnorm = meshVNorm(e);  // 정점 법선(스무딩) — 곡면을 계단 없이
    const mcol = bimSolidColor(e, '#b9b2a6'); // 색: 명시색 > 레이어색 > 기본
    for (const t of e.tris) {
      const P = t.map(p => proj3D(p[0], p[1], p[2]));
      const ux = t[1][0] - t[0][0], uy = t[1][1] - t[0][1], uz = t[1][2] - t[0][2];
      const vx = t[2][0] - t[0][0], vy = t[2][1] - t[0][1], vz = t[2][2] - t[0][2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      const mcx = (t[0][0] + t[1][0] + t[2][0]) / 3, mcy = (t[0][1] + t[1][1] + t[2][1]) / 3, mcz = (t[0][2] + t[1][2] + t[2][2]) / 3;
      const mfc = v3.falseColor ? falseColor(illuminanceAt(mcx, mcy, mcz, nx, ny, nz), v3.fcMax) : null;
      const shade = mfc ? 1 : (litOn
        ? litFace(mcx, mcy, mcz, nx, ny, nz, true)
        : 0.5 + 0.5 * Math.abs(nx * 0.5 + ny * 0.3 + nz * 0.8));
      const msh3 = (!mfc && litOn && LIT_RGB[3]) ? [LIT_RGB[0], LIT_RGB[1], LIT_RGB[2]] : null;
      const fe = [featSet.has(meshEdgeKey(t[0], t[1])), featSet.has(meshEdgeKey(t[1], t[2])), featSet.has(meshEdgeKey(t[2], t[0]))];
      const dM = (P[0][2] + P[1][2] + P[2][2]) / 3;
      // 곡면 스무딩: 정점 법선이 이 면의 법선과 크게 어긋나지 않을 때만 정점 셰이드를 만든다
      // (코너에서 뭉개짐 방지). 하나라도 어긋나면 예전대로 면 단색.
      let mvsh = null;
      if (!mfc) {
        const vs = [];
        for (let vi = 0; vi < 3; vi++) {
          const a = vnorm.acc.get(meshVKey(t[vi]));
          if (!a || (a[0]*nx + a[1]*ny + a[2]*nz) < 0.72) { vs.length = 0; break; }
          vs.push(litOn ? litFace(mcx, mcy, mcz, a[0], a[1], a[2], true)
                        : 0.5 + 0.5 * Math.abs(a[0]*0.5 + a[1]*0.3 + a[2]*0.8));
        }
        if (vs.length === 3) mvsh = vs;
      }
      faces.push({ pts: P, d: dM, color: mfc || mcol, shade, sh3: msh3, eid: e.id, isMesh: true, fe, ...(mvsh ? { vsh: mvsh } : {}) });
      pickFaces.push({ pts: P, d: dM, eid: e.id, isMesh: true });
    }
  }
  const light = document.documentElement.classList.contains('light');
  zRasterFaces(c, faces, v3.vp, light);                // 항상 정확한 Z-버퍼 은면 제거 (회전·호버·정지 모두)
  if (v3.falseColor) { drawSensors(c, v3.vp); fcLegend(c, v3.vp); }   // 조도 숫자 + 범례 (§4.1/§4.2)
  else if (state.sensors.length && litOn) drawSensors(c, v3.vp);
  // 광원 기즈모 — 어느 개체가 광원인지 일반 뷰에서도 알아볼 수 있게 (꺼진 광원은 흐리게)
  for (const g of lightGizmos()) {
    const p = proj3D(g.x, g.y, g.z);
    if (p[0] < v3.vp.x || p[0] > v3.vp.x + v3.vp.w || p[1] < v3.vp.y || p[1] > v3.vp.y + v3.vp.h) continue;
    c.save();
    c.globalAlpha = g.on ? 0.95 : 0.35;
    const r = 7 * (devicePixelRatio || 1);
    c.beginPath(); c.arc(p[0], p[1], r, 0, Math.PI * 2);
    c.fillStyle = g.on ? '#ffe9a8' : '#8a8f98'; c.fill();
    c.lineWidth = Math.max(1, r * 0.22); c.strokeStyle = 'rgba(20,20,30,0.75)'; c.stroke();
    c.beginPath(); c.moveTo(p[0] - r * 0.45, p[1] + r * 0.75); c.lineTo(p[0] + r * 0.45, p[1] + r * 0.75); c.stroke(); // 전구 소켓
    if (state.selection.has(g.eid)) { c.beginPath(); c.arc(p[0], p[1], r * 1.7, 0, Math.PI * 2); c.strokeStyle = '#0A84FF'; c.stroke(); }
    c.restore();
  }
  // extrudesrf(면 밀당): 선택된 면(윗면·아랫면·옆면)만 강조 — 객체 전체가 아니라 그 면임을 명확히
  if (typeof extrudePend !== 'undefined' && extrudePend && extrudePend.srf && v3.srfHi && v3.srfHi.size) {
    const dpr = devicePixelRatio || 1, fb = !!extrudePend.fromBottom, sd = extrudePend.side;
    if (sd && sd.ea) { // 옆면: 클릭한 그 면(ea~eb × z0~z1) 사각을 직접 강조 — 어느 면을 잡았는지 명확
      const q = [proj3D(sd.ea[0], sd.ea[1], sd.z0), proj3D(sd.eb[0], sd.eb[1], sd.z0), proj3D(sd.eb[0], sd.eb[1], sd.z1), proj3D(sd.ea[0], sd.ea[1], sd.z1)];
      c.save();
      c.beginPath(); q.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.closePath();
      c.fillStyle = 'rgba(10,132,255,0.32)'; c.fill();
      c.strokeStyle = '#0A84FF'; c.lineWidth = 2.5 * dpr; c.stroke();
      c.restore();
    } else {
      for (const s of v3.solids) {
        if (!v3.srfHi.has(s.eid)) continue;
        const zt = s.zt || s.poly.map(() => s.z1);
        const zb = s.zb || s.poly.map(() => s.z0);
        const Qh = (s.ptop && s.ptop.length === s.poly.length) ? s.ptop : s.poly;
        const top = Qh.map((p, i) => proj3D(p[0], p[1], zt[i]));
        const bot = s.poly.map((p, i) => proj3D(p[0], p[1], zb[i]));
        // 강조 대상: 원기둥 옆면=클릭 변 사각, 아랫면 모드=아랫면, 기본=윗면
        const hi = (sd && sd.i != null && sd.i < s.poly.length) ? [bot[sd.i], bot[sd.j], top[sd.j], top[sd.i]] : (fb ? bot : top);
        const ref = fb ? top : bot; // 점선 참조 윤곽
        c.save();
        c.beginPath(); hi.forEach((q, i) => i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1])); c.closePath();
        c.fillStyle = 'rgba(10,132,255,0.32)'; c.fill();
        c.strokeStyle = '#0A84FF'; c.lineWidth = 2.5 * dpr; c.stroke();
        // 반대쪽 윤곽 + 수직 모서리 점선 — 붙일 수 있는 스냅 참조(꼭짓점·중점·모서리) 시각화
        c.setLineDash([6 * dpr, 4 * dpr]); c.strokeStyle = 'rgba(94,177,255,0.9)'; c.lineWidth = 1.4 * dpr;
        c.beginPath(); ref.forEach((q, i) => i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1])); c.closePath(); c.stroke();
        c.beginPath(); for (let i = 0; i < top.length; i++) { c.moveTo(bot[i][0], bot[i][1]); c.lineTo(top[i][0], top[i][1]); } c.stroke();
        c.setLineDash([]);
        c.restore();
      }
    }
  }
  // extrudesrf 옆면 밀당 축 가이드 — 면 중심을 지나는 법선(수직) 방향 점선 + 현재 면 위치 표시
  if (typeof extrudePend !== 'undefined' && extrudePend && extrudePend.side && extrudePend.heightPhase === 'awaitTop') {
    const s = extrudePend.side, dpr = devicePixelRatio || 1, L = v3.fit * 1.2;
    const a = proj3D(s.mx - s.nx * L, s.my - s.ny * L, s.mz), b = proj3D(s.mx + s.nx * L, s.my + s.ny * L, s.mz);
    const cur = proj3D(s.mx + s.nx * (extrudePend.val || 0), s.my + s.ny * (extrudePend.val || 0), s.mz);
    c.save();
    c.setLineDash([7 * dpr, 5 * dpr]); c.strokeStyle = 'rgba(255,159,10,0.9)'; c.lineWidth = 1.6 * dpr;
    c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); c.setLineDash([]);
    c.fillStyle = '#ff9f0a'; c.beginPath(); c.arc(cur[0], cur[1], 5 * dpr, 0, Math.PI * 2); c.fill(); // 현재 면 위치
    c.font = `700 ${12 * dpr}px -apple-system,system-ui,sans-serif`;
    c.fillText(`${extrudePend.val || 0}`, cur[0] + 9 * dpr, cur[1] - 8 * dpr);
    c.restore();
  }
  // extrudecrv 생성 단계 시각화(기준점 클릭 전) — 선택 crv 파란 실선 + 끝점 스냅표시(초록 사각)만.
  // 미리보기 입체는 만들지 않음(혼란 방지) — 실제 입체는 기준점 클릭 후 0에서부터 커서로 자라남.
  if (typeof extrudePend !== 'undefined' && extrudePend && !extrudePend.srf && extrudePend.stage === 'height' && extrudePend.heightPhase === 'awaitBase') {
    const dpr = devicePixelRatio || 1;
    c.save();
    for (const it of extrudePend.items) {
      const e = state.entities.find(x => x.id === it.id); if (!e) continue;
      if (e.bim && !(e.bim.kind === 'wall' && !(e.bim.h > 0))) continue; // 이미 입체로 보이는 BIM 제외 — 납작(h0) 병합 벽체는 포함(밴드가 없어 이 강조가 유일한 표시)
      const fp = e.type === 'CIRCLE' ? circlePoly(e.cx, e.cy, e.r, CIRC_SEG) : (e.points ? e.points.map(p => [p[0], p[1]]) : null);
      if (!fp || fp.length < 2) continue;
      const z0 = it.base, closed = e.type === 'CIRCLE' || e.closed || (typeof polyIsLoop === 'function' && polyIsLoop(e));
      const bot = fp.map(p => proj3D(p[0], p[1], z0));
      // 선택됨: 프로파일을 파란 실선으로 (srf의 파란 면 포커싱과 같은 언어)
      c.setLineDash([]); c.strokeStyle = '#0A84FF'; c.lineWidth = 2.4 * dpr;
      c.beginPath(); bot.forEach((q, i) => i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1])); if (closed) c.closePath(); c.stroke();
      // 끝점(꼭짓점) 스냅 표시 — 초록 사각 (2D 끝점 스냅과 동일 언어)
      if (e.type !== 'CIRCLE') {
        c.strokeStyle = '#2ee6a6'; c.lineWidth = 1.6 * dpr;
        const r0 = 5 * dpr;
        for (const q of bot) c.strokeRect(q[0] - r0, q[1] - r0, 2 * r0, 2 * r0);
      }
    }
    c.restore();
  }
  // 높이 그립 — 벽/기둥 1개 선택 시 상단에 드래그 핸들 (활성 뷰에서만, 거의 수직 뷰에서는 숨김)
  if (isActive && state.selection.size === 1 && Math.abs(Math.cos(v3.pitch)) >= 0.15) {
    const sid = [...state.selection][0];
    const ent = state.entities.find(en => en.id === sid);
    if (ent && ent.bim && (ent.bim.kind === 'wall' || ent.bim.kind === 'column' || ent.bim.kind === 'stair')) {
      const parts = v3.solids.filter(s => s.eid === sid && !s.zt);
      if (parts.length) {
        const topS = parts.reduce((a, b) => (b.z1 > a.z1 ? b : a));
        const wx = topS.poly.reduce((a, p) => a + p[0], 0) / topS.poly.length;
        const wy = topS.poly.reduce((a, p) => a + p[1], 0) / topS.poly.length;
        const dzRef = v3.fit / 10;
        const p0 = proj3D(wx, wy, topS.z1);
        const pUp = proj3D(wx, wy, topS.z1 + dzRef);
        const pxPerMm = (p0[1] - pUp[1]) / dzRef; // 월드 +z 1mm당 화면 위쪽 픽셀 (뒤집힌 뷰에선 음수 — 부호 그대로 사용)
        if (Math.abs(pxPerMm) > 0.005) {
          v3.grip = { x: p0[0], y: p0[1], eid: sid, pxPerMm };
          const dpr = devicePixelRatio || 1;
          c.strokeStyle = '#0A84FF'; c.fillStyle = '#0A84FF'; c.lineWidth = 2 * dpr;
          c.beginPath(); c.moveTo(p0[0], p0[1]); c.lineTo(p0[0], p0[1] - 34 * dpr); c.stroke();
          c.beginPath(); c.moveTo(p0[0], p0[1] - 48 * dpr); c.lineTo(p0[0] - 7 * dpr, p0[1] - 34 * dpr); c.lineTo(p0[0] + 7 * dpr, p0[1] - 34 * dpr); c.closePath(); c.fill();
          c.beginPath(); c.arc(p0[0], p0[1], 5 * dpr, 0, Math.PI * 2); c.fill();
          c.font = `${12 * dpr}px -apple-system,system-ui,sans-serif`;
          c.fillStyle = light ? '#1a3a66' : '#8fc3ff';
          c.fillText(`h ${ent.bim.h}`, p0[0] + 11 * dpr, p0[1] - 18 * dpr);
        }
      }
    }
  }
  // 검볼 — 선택 1개의 이동 핸들 (활성 뷰에서만)
  if (isActive && state.selection.size === 1) {
    const sid = [...state.selection][0];
    const ent = state.entities.find(en => en.id === sid);
    if (ent && (ent.bim || ['LINE', 'LWPOLYLINE', 'CIRCLE', 'ARC', 'MESH'].includes(ent.type))) {
      const bb = entityBBox(ent);
      let gx = (bb.xmin + bb.xmax) / 2, gy = (bb.ymin + bb.ymax) / 2;
      let gz = (state.levels[ent.lv || 0] || { elev: 0 }).elev + (ent.zo || 0);
      if (ent.type === 'LINE' && (ent.z1 != null || ent.z2 != null)) gz = ((ent.z1 || 0) + (ent.z2 || 0)) / 2; // 3D 선 중앙
      const parts = v3.solids.filter(s => s.eid === sid);
      if (parts.length) { let zm = 1e18, zM = -1e18; for (const s of parts) { zm = Math.min(zm, s.z0); zM = Math.max(zM, s.zt ? Math.max(...s.zt) : s.z1); } gz = (zm + zM) / 2; }
      if (ent.type === 'MESH' && ent.tris && ent.tris.length) { // 메시: 정점 z 범위 중앙
        let zm2 = 1e18, zM2 = -1e18;
        for (const t of ent.tris) for (const p of t) { if (p[2] < zm2) zm2 = p[2]; if (p[2] > zM2) zM2 = p[2]; }
        if (zm2 <= zM2) gz = (zm2 + zM2) / 2;
      }
      // 검볼 크기 — 선택 '개체'의 크기에 맞춘다 (예전엔 모델 전체 기준 v3.fit/7 고정이라
      // 작은 개체에 거대한 검볼이 씌워져 조작이 어려웠다 — 2026-07-20 사용자 보고).
      // 화면 픽셀 36~140px 범위로 클램프해 아주 작아지거나 커지지는 않게.
      let L;
      {
        const dprG = devicePixelRatio || 1;
        const pA = proj3D(gx, gy, gz), pB = proj3D(gx + 100, gy, gz);
        const pxPer100 = Math.hypot(pB[0] - pA[0], pB[1] - pA[1]) || 1e-6; // 화면px / 100mm
        const toWorld = (px) => px * 100 / pxPer100;
        const diagE = Math.hypot(bb.xmax - bb.xmin, bb.ymax - bb.ymin) || 0;
        L = Math.max(diagE * 0.55, 1);
        L = Math.min(Math.max(L, toWorld(36 * dprG)), toWorld(140 * dprG));
        if (!isFinite(L) || L <= 0) L = v3.fit / 7; // 투영 퇴화 시 예전 규칙 폴백
      }
      // Z축: 모든 객체 — 일반 도형=3D 표시 높이(zo), 문·창=씰, 벽·기둥·계단=base, 슬래브=top, 지붕=처마
      const AXES = [['x', 1, 0, 0, '#ff453a'], ['y', 0, 1, 0, '#30d158'], ['z', 0, 0, 1, '#0A84FF']];
      const g0 = proj3D(gx, gy, gz);
      const dpr = devicePixelRatio || 1;
      v3.gum = { eid: sid, axes: [] };
      for (const [name, vx, vy, vz, color] of AXES) {
        const g1 = proj3D(gx + vx * L, gy + vy * L, gz + vz * L);
        const ddx = g1[0] - g0[0], ddy = g1[1] - g0[1], len = Math.hypot(ddx, ddy);
        if (len < 6) continue; // 화면과 거의 수직인 축은 생략
        const ux = ddx / len, uy = ddy / len;
        v3.gum.axes.push({ name, p0: [g0[0], g0[1]], p1: [g1[0], g1[1]], ux, uy, pxPerMm: len / L, vx, vy, vz });
        c.strokeStyle = color; c.fillStyle = color; c.lineWidth = 2.5 * dpr; c.globalAlpha = 0.95;
        c.beginPath(); c.moveTo(g0[0], g0[1]); c.lineTo(g1[0], g1[1]); c.stroke();
        c.beginPath();
        c.moveTo(g1[0], g1[1]);
        c.lineTo(g1[0] - ux * 9 * dpr - uy * 4.5 * dpr, g1[1] - uy * 9 * dpr + ux * 4.5 * dpr);
        c.lineTo(g1[0] - ux * 9 * dpr + uy * 4.5 * dpr, g1[1] - uy * 9 * dpr - ux * 4.5 * dpr);
        c.closePath(); c.fill();
        c.font = `${11 * dpr}px -apple-system,system-ui,sans-serif`;
        c.fillText(name.toUpperCase(), g1[0] + ux * 8 * dpr + 2, g1[1] + uy * 8 * dpr + 2);
      }
      // 회전 링 (라이노식): Z=파랑 링은 모든 객체, X·Y 링은 메시·선·BIM 솔리드(수직 회전 시 메시로 변환됨)
      const can3D = ent.type === 'MESH' || (ent.type === 'LINE' && !ent.bim) || isBoolable(ent);
      const RING_R = L * 0.62, RINGS = can3D ? [['x', '#ff453a'], ['y', '#30d158'], ['z', '#0A84FF']] : [['z', '#0A84FF']];
      v3.gum.rings = [];
      c.lineWidth = 2 * dpr;
      for (const [name, color] of RINGS) {
        const rg = { name, cx: gx, cy: gy, cz: gz, R: RING_R, pts: [] };
        c.strokeStyle = color; c.globalAlpha = 0.7;
        c.beginPath();
        for (let i = 0; i <= 48; i++) {
          const p = gumRingPt(rg, i / 48 * Math.PI * 2);
          const sp = proj3D(p[0], p[1], p[2]);
          if (i < 48) rg.pts.push(sp);
          i ? c.lineTo(sp[0], sp[1]) : c.moveTo(sp[0], sp[1]);
        }
        c.closePath(); c.stroke();
        v3.gum.rings.push(rg);
      }
      if (v3.rotDeg != null) { // 회전 드래그 중 현재 각도 표시
        c.globalAlpha = 1; c.font = `700 ${12 * dpr}px -apple-system,system-ui,sans-serif`;
        c.fillStyle = '#ffd60a'; c.fillText(v3.rotDeg + '°', g0[0] + 12 * dpr, g0[1] - 12 * dpr);
      }
      c.beginPath(); c.fillStyle = '#ffd60a'; c.globalAlpha = 0.95; c.arc(g0[0], g0[1], 4 * dpr, 0, Math.PI * 2); c.fill();
      c.globalAlpha = 1;
    }
  }
  // 작업면 시각화 — 층 레벨과 다르면 점선 사각형 + 높이 라벨 (모든 뷰포트)
  if (Math.abs(cplaneZ() - lvElev()) > 0.5) {
    const zc = cplaneZ(), dcp = devicePixelRatio || 1;
    const hx = v3.fit * 0.7, hy = v3.fit * 0.7;
    const cor = [[v3.cx - hx, v3.cy - hy], [v3.cx + hx, v3.cy - hy], [v3.cx + hx, v3.cy + hy], [v3.cx - hx, v3.cy + hy]].map(p => proj3D(p[0], p[1], zc));
    c.save();
    c.strokeStyle = '#bf5af2'; c.globalAlpha = 0.75; c.lineWidth = 1.2 * dcp; c.setLineDash([8 * dcp, 5 * dcp]);
    c.beginPath(); cor.forEach((q, i) => i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1])); c.closePath(); c.stroke();
    c.setLineDash([]);
    c.font = `${11 * dcp}px -apple-system,system-ui,sans-serif`; c.fillStyle = '#bf5af2';
    c.fillText(`작업면 z=${zc}`, cor[0][0] + 4, cor[0][1] - 4);
    c.restore();
  }
  // 작도 가선 — 평면의 draft/pts/previewEnts를 층 바닥면에 투영 (모든 뷰포트에 표시)
  if (draft || pts.length || previewEnts) {
    const zw = cplaneZ(), dg = devicePixelRatio || 1;
    const pathOf = (e) => {
      if (e.type === 'LINE') return { p: [proj3D(e.x1, e.y1, zw), proj3D(e.x2, e.y2, zw)], cl: false };
      if (e.type === 'LWPOLYLINE' && e.points && e.points.length) return { p: e.points.map(q => proj3D(q[0], q[1], zw)), cl: !!e.closed };
      if (e.type === 'CIRCLE') { const p = []; for (let i = 0; i <= 32; i++) { const t = i / 32 * Math.PI * 2; p.push(proj3D(e.cx + e.r * Math.cos(t), e.cy + e.r * Math.sin(t), zw)); } return { p, cl: false }; }
      if (e.type === 'ARC') { let s0 = e.startAngle, e0 = e.endAngle; if (e0 < s0) e0 += 360; const st = Math.max(8, Math.ceil((e0 - s0) / 10)); const p = []; for (let i = 0; i <= st; i++) { const a = (s0 + (e0 - s0) * i / st) * Math.PI / 180; p.push(proj3D(e.cx + e.r * Math.cos(a), e.cy + e.r * Math.sin(a), zw)); } return { p, cl: false }; }
      return null;
    };
    const strokeGhost = (r) => {
      if (!r || r.p.length < 2) return;
      c.strokeStyle = '#ffd60a'; c.lineWidth = 1.5 * dg; c.globalAlpha = 0.9;
      c.setLineDash([6 * dg, 4 * dg]);
      c.beginPath(); r.p.forEach((q, i) => i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]));
      if (r.cl) c.closePath();
      c.stroke(); c.setLineDash([]); c.globalAlpha = 1;
    };
    if (draft) strokeGhost(pathOf(draft));
    if (pts.length) {
      const pp = pts.map(q => proj3D(q.x, q.y, zw));
      if (v3.toolCur) pp.push(proj3D(v3.toolCur.x, v3.toolCur.y, zw));
      strokeGhost({ p: pp, cl: false });
    }
    if (previewEnts) for (const e of previewEnts) strokeGhost(pathOf(e));
  }
  // 스냅 마커 — 2D와 동일한 초록 표식 (끝점=사각, 중간점=삼각). extrudesrf 중엔 크게 + z 라벨 + 커서→스냅 자석선
  if (v3.snapHit) {
    const sm = v3.snapHit, dpr3 = devicePixelRatio || 1;
    const sp3 = proj3D(sm.x, sm.y, sm.z != null ? sm.z : cplaneZ());
    const big = (typeof extrudePend !== 'undefined' && !!extrudePend); // 돌출(srf·crv 공통) 중엔 크게 + 자석선 + z라벨
    const rr = (big ? 15 : 7) * dpr3;
    c.save();
    // 자석 느낌: 커서에서 스냅점까지 점선 + 마커 뒤 반투명 후광
    if (big && v3.snapCursor) {
      c.strokeStyle = 'rgba(46,230,166,.55)'; c.lineWidth = 1.4 * dpr3; c.setLineDash([5 * dpr3, 4 * dpr3]);
      c.beginPath(); c.moveTo(v3.snapCursor[0], v3.snapCursor[1]); c.lineTo(sp3[0], sp3[1]); c.stroke(); c.setLineDash([]);
    }
    if (big) {
      c.fillStyle = 'rgba(46,230,166,.20)'; c.beginPath(); c.arc(sp3[0], sp3[1], rr + 6 * dpr3, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#2ee6a6'; c.beginPath(); c.arc(sp3[0], sp3[1], 2.4 * dpr3, 0, Math.PI * 2); c.fill(); // 중심 실점
    }
    c.strokeStyle = '#2ee6a6'; c.lineWidth = (big ? 3 : 1.8) * dpr3; c.setLineDash([]);
    if (big) { c.shadowColor = 'rgba(0,0,0,.55)'; c.shadowBlur = 3 * dpr3; }
    // 종류별 마커 모양 (2D 규약) — srfSurfaceSnap은 한글 kind, snap3D는 영문 kind라 둘 다 매핑
    const k = sm.kind;
    if (k === 'midpoint' || k === '중점') { // 중점=삼각형
      c.beginPath(); c.moveTo(sp3[0], sp3[1] - rr); c.lineTo(sp3[0] - rr, sp3[1] + rr); c.lineTo(sp3[0] + rr, sp3[1] + rr); c.closePath(); c.stroke();
    } else if (k === 'center' || k === '중심') { // 중심=원
      c.beginPath(); c.arc(sp3[0], sp3[1], rr, 0, Math.PI * 2); c.stroke();
    } else if (k === 'intersect' || k === '교차') { // 교차=✕ (2D 규약과 동일)
      c.beginPath();
      c.moveTo(sp3[0] - rr, sp3[1] - rr); c.lineTo(sp3[0] + rr, sp3[1] + rr);
      c.moveTo(sp3[0] + rr, sp3[1] - rr); c.lineTo(sp3[0] - rr, sp3[1] + rr);
      c.stroke();
    } else if (k === 'perp' || k === '수직') { // 수직=⊐ (2D 규약과 동일)
      c.beginPath();
      c.moveTo(sp3[0] - rr, sp3[1] - rr); c.lineTo(sp3[0] - rr, sp3[1] + rr); c.lineTo(sp3[0] + rr, sp3[1] + rr);
      c.moveTo(sp3[0] - rr, sp3[1]); c.lineTo(sp3[0], sp3[1]); c.lineTo(sp3[0], sp3[1] + rr);
      c.stroke();
    } else if (k === 'tangent' || k === '접선') { // 접선=원+위쪽 접선 (2D 규약과 동일)
      c.beginPath(); c.arc(sp3[0], sp3[1] + rr * 0.25, rr * 0.75, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.moveTo(sp3[0] - rr, sp3[1] - rr * 0.5); c.lineTo(sp3[0] + rr, sp3[1] - rr * 0.5); c.stroke();
    } else if (k === 'nearest' || k === '모서리') { // 모서리/근처=모래시계 (2D 규약과 통일 — ✕는 교차 전용)
      c.beginPath();
      c.moveTo(sp3[0] - rr, sp3[1] - rr); c.lineTo(sp3[0] + rr, sp3[1] - rr); c.lineTo(sp3[0] - rr, sp3[1] + rr);
      c.lineTo(sp3[0] + rr, sp3[1] + rr); c.closePath();
      c.stroke();
    } else if (k === 'quad' || k === '사분점') { // 사분점=◇+중심점 (2D 규약과 동일)
      c.beginPath(); c.moveTo(sp3[0], sp3[1] - rr); c.lineTo(sp3[0] + rr, sp3[1]); c.lineTo(sp3[0], sp3[1] + rr); c.lineTo(sp3[0] - rr, sp3[1]); c.closePath(); c.stroke();
      c.fillStyle = '#2ee6a6'; c.beginPath(); c.arc(sp3[0], sp3[1], 1.6 * dpr3, 0, Math.PI * 2); c.fill();
    } else if (k === '표면' || k === 'surface') { // 표면=마름모(꼭짓점과 구분)
      c.beginPath(); c.moveTo(sp3[0], sp3[1] - rr); c.lineTo(sp3[0] + rr, sp3[1]); c.lineTo(sp3[0], sp3[1] + rr); c.lineTo(sp3[0] - rr, sp3[1]); c.closePath(); c.stroke();
    } else { // 꼭짓점/끝점=사각
      c.strokeRect(sp3[0] - rr, sp3[1] - rr, 2 * rr, 2 * rr);
    }
    if (big && sm.z != null) { // z 라벨 — 어두운 배경칩 위에 또렷한 텍스트(초록 외곽선 겹침 번짐 방지)
      c.shadowBlur = 0;
      const fs = 13 * dpr3;
      c.font = `700 ${fs}px -apple-system,system-ui,sans-serif`;
      c.textBaseline = 'middle'; c.textAlign = 'left';
      const lbl = 'z=' + Math.round(sm.z) + (sm.kind ? ' ' + (SNAP_KO[sm.kind] || sm.kind) : '');
      const padX = 7 * dpr3, padY = 4 * dpr3;
      const bw = c.measureText(lbl).width + padX * 2, bh = fs + padY * 2;
      let lx = sp3[0] + rr + 6 * dpr3, ly = sp3[1] - rr - bh; // 기본: 마커 우상단
      const cw = v3.cv.width, ch = v3.cv.height, mg = 2 * dpr3; // 화면 밖으로 안 나가게 클램프(우측 넘침→좌측 등)
      if (lx + bw > cw - mg) lx = sp3[0] - rr - 6 * dpr3 - bw;
      if (lx < mg) lx = mg;
      if (ly < mg) ly = sp3[1] + rr + 6 * dpr3;
      if (ly + bh > ch - mg) ly = ch - mg - bh;
      c.fillStyle = 'rgba(10,15,13,.92)'; c.fillRect(lx, ly, bw, bh);           // 배경칩
      c.strokeStyle = 'rgba(46,230,166,.9)'; c.lineWidth = 1 * dpr3; c.strokeRect(lx, ly, bw, bh); // 얇은 초록 테두리
      c.fillStyle = '#eafff6'; c.fillText(lbl, lx + padX, ly + bh / 2);          // 또렷한 흰 텍스트
    }
    c.restore();
  }
  // 3D 선 러버밴드 — 시작점(실제 z)에서 커서(스냅 z/작업면)까지
  if (v3.line3d && v3.line3d.p1) {
    const p1 = v3.line3d.p1, dl = devicePixelRatio || 1;
    const a = proj3D(p1.x, p1.y, p1.z);
    c.fillStyle = '#ffd60a'; c.beginPath(); c.arc(a[0], a[1], 4 * dl, 0, Math.PI * 2); c.fill();
    if (v3.toolCur) {
      const tc = v3.toolCur;
      const b = proj3D(tc.x, tc.y, tc.z != null ? tc.z : cplaneZ());
      c.strokeStyle = '#ffd60a'; c.lineWidth = 1.5 * dl; c.setLineDash([6 * dl, 4 * dl]); c.globalAlpha = 0.9;
      c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
      c.setLineDash([]); c.globalAlpha = 1;
      c.font = `${11 * dl}px -apple-system,system-ui,sans-serif`; c.fillStyle = '#ffd60a';
      c.fillText(`${Math.round(Math.hypot(tc.x - p1.x, tc.y - p1.y, (tc.z || 0) - p1.z))}`, (a[0] + b[0]) / 2 + 6, (a[1] + b[1]) / 2 - 6);
    }
  }
  // 3D 벽 그리기 미리보기 (모든 뷰포트에 표시)
  if (v3.wallMode && v3.wallP1) {
    const dpr = devicePixelRatio || 1;
    const ze = v3.wallP1[2] != null ? v3.wallP1[2] : cplaneZ(); // 지형 위 시작점이면 그 높이에 표시
    const a = proj3D(v3.wallP1[0], v3.wallP1[1], ze);
    c.fillStyle = '#ff9f0a'; c.beginPath(); c.arc(a[0], a[1], 4 * dpr, 0, Math.PI * 2); c.fill();
    if (v3.wallCur && (v3.wallCur[0] !== v3.wallP1[0] || v3.wallCur[1] !== v3.wallP1[1])) {
      const b = proj3D(v3.wallCur[0], v3.wallCur[1], v3.wallCur[2] != null ? v3.wallCur[2] : ze);
      c.strokeStyle = '#ff9f0a'; c.lineWidth = 2 * dpr; c.setLineDash([6 * dpr, 4 * dpr]);
      c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); c.setLineDash([]);
      c.font = `${11 * dpr}px -apple-system,system-ui,sans-serif`; c.fillStyle = '#ff9f0a';
      c.fillText(`${Math.round(Math.hypot(v3.wallCur[0] - v3.wallP1[0], v3.wallCur[1] - v3.wallP1[1]))}`, (a[0] + b[0]) / 2 + 6, (a[1] + b[1]) / 2 - 6);
    }
  }
  return { faces, under, pick: pickFaces };
}
// 채널별 밝기로 색을 만든다 (색번짐용). k3 = [kr, kg, kb]
function shadeColor3(hex, k3) {
  const r = Math.round(parseInt(hex.slice(1, 3), 16) * k3[0]), g = Math.round(parseInt(hex.slice(3, 5), 16) * k3[1]), b = Math.round(parseInt(hex.slice(5, 7), 16) * k3[2]);
  return [Math.min(255, r), Math.min(255, g), Math.min(255, b)];
}
function shadeColor(hex, k) {
  const r = Math.round(parseInt(hex.slice(1, 3), 16) * k), g = Math.round(parseInt(hex.slice(3, 5), 16) * k), b = Math.round(parseInt(hex.slice(5, 7), 16) * k);
  return `rgb(${Math.min(255, r)},${Math.min(255, g)},${Math.min(255, b)})`;
}
// 작업면(Construction Plane) z — 3D 작도의 레이캐스팅 교차 평면 (기본: 현재 층 레벨)
function cplaneZ() { return (v3 && v3.cplane != null) ? v3.cplane : lvElev(); }
function setCplane(z) {
  if (!v3) return;
  v3.cplane = isFinite(z) ? Math.round(z) : null;
  const zi = document.getElementById('cpZ'), sl = document.getElementById('cpSlide');
  if (zi) zi.value = cplaneZ();
  if (sl) sl.value = Math.max(sl.min | 0, Math.min(sl.max | 0, cplaneZ()));
  render3D();
}
// 3D 커서 — 평면(setTool)과 동일 규칙: select=기본, pan=손, 그 외 도구=십자
function cursor3D() {
  if (v3 && v3.wallMode) return 'crosshair';
  return (state.tool === 'select') ? 'default' : (state.tool === 'pan') ? 'grab' : 'crosshair';
}
// 검볼 회전 링 위의 3D 점 — θ+ 방향 = 해당 축 기준 오른손 법칙 +회전
function gumRingPt(rg, th) {
  const c = Math.cos(th), s = Math.sin(th);
  if (rg.name === 'x') return [rg.cx, rg.cy + rg.R * c, rg.cz + rg.R * s];
  if (rg.name === 'y') return [rg.cx + rg.R * s, rg.cy, rg.cz + rg.R * c];
  return [rg.cx + rg.R * c, rg.cy + rg.R * s, rg.cz];
}
// 검볼 회전 적용 — 중심(cx,cy,cz)을 지나는 축 기준 deg도 회전 (오른손 법칙, 반시계 +)
function gumRotate(ent, axName, cx, cy, cz, deg) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  // 수직(X/Y) 회전을 받은 BIM 솔리드(벽 LINE 포함)는 메시로 변환 — 기울어진 입체는 발자국+높이로 표현 불가 (라이노 자유 회전과 동일)
  if (axName !== 'z' && ent.type !== 'MESH' && ent.bim) {
    const tris = entityToTris(ent);
    if (tris.length) {
      ent.type = 'MESH'; ent.tris = tris;
      delete ent.bim; delete ent.points; delete ent.closed; delete ent.zo;
      delete ent.x1; delete ent.y1; delete ent.x2; delete ent.y2; delete ent.z1; delete ent.z2;
      delete ent.cx; delete ent.cy; delete ent.r; delete ent.startAngle; delete ent.endAngle;
      delete ent._feat; delete ent._featRef;
      logLine('  ▷ 수직 회전: BIM 솔리드를 메시로 변환 (벽 두께·높이 속성 해제 — 원복은 실행취소)', 'info');
    }
  }
  if (ent.type === 'MESH') { // 메시: 정점 3D 회전 — X/Y/Z 모든 축 가능
    const fn = axName === 'x' ? (x, y, z) => { const dy = y - cy, dz = z - cz; return [x, cy + dy * c - dz * s, cz + dy * s + dz * c]; }
      : axName === 'y' ? (x, y, z) => { const dx = x - cx, dz = z - cz; return [cx + dx * c + dz * s, y, cz - dx * s + dz * c]; }
      : (x, y, z) => { const dx = x - cx, dy = y - cy; return [cx + dx * c - dy * s, cy + dx * s + dy * c, z]; };
    meshXform(ent, fn);
    return;
  }
  if (ent.type === 'LINE' && axName !== 'z' && !ent.bim) { // 선: 양끝점 3D 회전 (평면 선도 3D 선이 됨)
    const zb = (state.levels[ent.lv || 0] || { elev: 0 }).elev + (ent.zo || 0);
    const rot = axName === 'x'
      ? p => [p[0], cy + (p[1] - cy) * c - (p[2] - cz) * s, cz + (p[1] - cy) * s + (p[2] - cz) * c]
      : p => [cx + (p[0] - cx) * c + (p[2] - cz) * s, p[1], cz - (p[0] - cx) * s + (p[2] - cz) * c];
    const p1 = rot([ent.x1, ent.y1, ent.z1 != null ? ent.z1 : zb]);
    const p2 = rot([ent.x2, ent.y2, ent.z2 != null ? ent.z2 : zb]);
    [ent.x1, ent.y1, ent.z1] = [p1[0], p1[1], p1[2]];
    [ent.x2, ent.y2, ent.z2] = [p2[0], p2[1], p2[2]];
    delete ent.zo;
    return;
  }
  applyTransform(ent, T_rotate(cx, cy, deg)); // 평면 도형·BIM: Z축 평면 회전 (치수·속성 보존)
}
// 검볼 이동 적용: X/Y=평면 이동, Z=BIM 기준 높이(base/top/eave) 이동
function gumMove(ent, ax, d) {
  if (ent.type === 'MESH') { move3DEnt(ent, ax.vx * d, ax.vy * d, ax.vz * d); return; } // 메시: 정점 직접 이동
  if (ax.vz) {
    const b = ent.bim;
    if (!b) {
      if (ent.type === 'LINE' && (ent.z1 != null || ent.z2 != null)) { ent.z1 = (ent.z1 || 0) + d; ent.z2 = (ent.z2 || 0) + d; return; } // 3D 선: 양끝 동시 이동
      ent.zo = (ent.zo || 0) + d; return; // 일반 도형: 3D 표시 높이(층 레벨 + 오프셋)
    }
    if (b.kind === 'opening') b.sill = (b.sill || 0) + d; // 문·창: 씰 높이
    else if (b.kind === 'slab') b.top += d;
    else if (b.kind === 'roof') b.eave += d;
    else b.base = (b.base || 0) + d;
  } else translateEntity(ent, ax.vx * d, ax.vy * d);
}
function bind3D(ov, cv3) {
  let drag = null;
  cv3.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    // 돌출 높이: 좌클릭=기준점(스냅)/확정. 우드래그=뷰 회전, 휠드래그=뷰 이동은 그대로 살린다 —
    // 원하는 높이에 정확히 맞추려면 각도를 바꿔가며 봐야 하고, 그 사이 명령이 끊기면 안 된다.
    // 그래서 버튼 1(휠)·2(우)는 아래 공통 궤도/팬 처리로 흘려보낸다(extrudePend 유지).
    // 우클릭 '탭'(움직임 없음)은 예전처럼 취소 — pointerup 에서 drag.moved 로 가른다.
    if (extrudePend && extrudePend.stage === 'height' && e.button !== 1 && e.button !== 2) {
      const rr = cv3.getBoundingClientRect();
      const cpx = (e.clientX - rr.left) * (rr.width ? cv3.width / rr.width : 1);
      const cpy = (e.clientY - rr.top) * (rr.height ? cv3.height / rr.height : 1);
      if (extrudePend.heightPhase === 'awaitTop') { extrudeFinish(); return; }
      // 포커싱(confirmFace) 중 같은 객체의 '다른 면'을 클릭하면 그 면으로 재타겟 (윗·아랫·옆면 자유 선택)
      if (extrudePend.srf && extrudePend.heightPhase === 'confirmFace') {
        const f = findFaceAt(cpx, cpy);
        // ★ '다른 면' 일 때만 재타겟한다. 같은 면을 다시 클릭한 건 '기준점 지정' 이다.
        // 예전엔 eid 만 봐서, 밀고 있는 면 위에 기준점을 찍으면 명령이 통째로 재시작됐다
        // → heightPhase 가 confirmFace 에서 못 빠져나와 커서로 높이 조절이 아예 안 됐다.
        const cur = extrudePend.face;
        const sameFace = !!(f && cur && f.eid === cur.eid && (f.fk || null) === cur.fk
          && (f.fi != null ? f.fi : null) === cur.fi && (f.si != null ? f.si : null) === cur.si);
        if (f && !sameFace && extrudePend.items.some(it => it.id === f.eid)) {
          v3.pickFace = f;
          const ents = extrudePend.items.map(it => state.entities.find(en => en.id === it.id)).filter(Boolean);
          extrudePend = null;
          if (undoStack.length) restore(undoStack.pop()); // 직전 extrudeStart의 스냅샷으로 되돌린 뒤 새 면으로 재시작
          const ents2 = ents.map(en => state.entities.find(x => x.id === en.id)).filter(Boolean);
          if (ents2.length) { extrudeStart('extrudesrf', ents2); return; }
        }
      }
      extrudeSetBase(cpx, cpy); // confirmFace/awaitBase 클릭 → 기준점(스냅) 지정 후 높이 조절로
      return;
    }
    { // 사분할: 클릭한 뷰포트를 활성화
      const rv = cv3.getBoundingClientRect();
      const pxv = (e.clientX - rv.left) * (rv.width ? cv3.width / rv.width : 1);
      const pyv = (e.clientY - rv.top) * (rv.height ? cv3.height / rv.height : 1);
      const vi = vpAt(pxv, pyv);
      if (vi !== v3.act) { v3.act = vi; loadVp(vi); render3D(); }
    }
    // 높이 그립 히트 → 리프트 드래그 (벽/기둥 높이 끌어올리기)
    if (v3.grip && e.button === 0 && !e.shiftKey && !extrudePend) { // 돌출 진행 중엔 리프트 그립 비활성 — 면 클릭 우선
      const r = cv3.getBoundingClientRect();
      const kx = r.width ? cv3.width / r.width : 1, ky = r.height ? cv3.height / r.height : 1;
      const px = (e.clientX - r.left) * kx, py = (e.clientY - r.top) * ky;
      const dpr = devicePixelRatio || 1;
      if (Math.abs(px - v3.grip.x) <= 16 * dpr && py >= v3.grip.y - 54 * dpr && py <= v3.grip.y + 12 * dpr) {
        const ent = state.entities.find(en => en.id === v3.grip.eid);
        if (ent && ent.bim) {
          drag = { mode: 'lift', ent, h0: ent.bim.h, y0: e.clientY, py2cv: ky, pxPerMm: v3.grip.pxPerMm, pushed: false };
          try { cv3.setPointerCapture(e.pointerId); } catch (_) {}
          cv3.style.cursor = 'ns-resize';
          return;
        }
      }
    }
    // 검볼 축 히트 → 이동 드래그(1mm 스냅) / 클릭 = 수치 입력 (돌출 진행 중엔 비활성 — 면 클릭 우선)
    if (v3.gum && e.button === 0 && !e.shiftKey && !extrudePend) {
      const r2 = cv3.getBoundingClientRect();
      const kx2 = r2.width ? cv3.width / r2.width : 1, ky2 = r2.height ? cv3.height / r2.height : 1;
      const px2 = (e.clientX - r2.left) * kx2, py2 = (e.clientY - r2.top) * ky2;
      const tol2 = 10 * (devicePixelRatio || 1);
      // 원점 부근은 세 축이 겹치므로 "허용치 안 첫 번째"가 아니라 "가장 가까운 축"을 선택
      // (이전 로직은 Z 화살표 아래쪽을 잡아도 X/Y가 먼저 걸려 수평 이동되는 버그)
      let hitAx = null, hitD = tol2;
      for (const a of v3.gum.axes) {
        const ddx = a.p1[0] - a.p0[0], ddy = a.p1[1] - a.p0[1], L2 = ddx * ddx + ddy * ddy;
        const t = L2 ? Math.max(0, Math.min(1, ((px2 - a.p0[0]) * ddx + (py2 - a.p0[1]) * ddy) / L2)) : 0;
        const d = Math.hypot(px2 - (a.p0[0] + ddx * t), py2 - (a.p0[1] + ddy * t));
        if (d <= hitD) { hitD = d; hitAx = a; }
      }
      // 회전 링 히트 — 축과 링 중 화면상 더 가까운 쪽 (라이노식 회전)
      let hitRing = null, hitTh = 0;
      for (const rg of (v3.gum.rings || [])) {
        for (let i = 0; i < rg.pts.length; i++) {
          const d = Math.hypot(px2 - rg.pts[i][0], py2 - rg.pts[i][1]);
          if (d < hitD) { hitD = d; hitAx = null; hitRing = rg; hitTh = i / rg.pts.length * Math.PI * 2; }
        }
      }
      if (hitRing) {
        const ent = state.entities.find(en => en.id === v3.gum.eid);
        if (ent) {
          // 회전 = 커서가 중심 둘레를 도는 화면 각도를 그대로 추적 (커서 1바퀴 = 360° — 링이 작아도 폭주하지 않음)
          const gs = proj3D(hitRing.cx, hitRing.cy, hitRing.cz);
          const a0 = Math.atan2(hitRing.pts[0][1] - gs[1], hitRing.pts[0][0] - gs[0]);
          const a1 = Math.atan2(hitRing.pts[1][1] - gs[1], hitRing.pts[1][0] - gs[0]);
          let dw = a1 - a0; while (dw > Math.PI) dw -= 2 * Math.PI; while (dw < -Math.PI) dw += 2 * Math.PI;
          const sign = dw >= 0 ? 1 : -1; // 링의 θ+ 방향이 화면에서 도는 방향
          drag = { mode: 'gumrot', ent, ring: hitRing, gs, sign, th: 0, x0: e.clientX, y0: e.clientY, lastSA: Math.atan2(py2 - gs[1], px2 - gs[0]), kx: kx2, ky: ky2, appliedDeg: 0, pushed: false, moved: 0 };
          try { cv3.setPointerCapture(e.pointerId); } catch (_) {}
          cv3.style.cursor = 'grabbing';
          return;
        }
      }
      if (hitAx) {
        const ent = state.entities.find(en => en.id === v3.gum.eid);
        if (ent) {
          drag = { mode: 'gum', ent, ax: hitAx, x0: e.clientX, y0: e.clientY, kx: kx2, ky: ky2, applied: 0, pushed: false, moved: 0 };
          try { cv3.setPointerCapture(e.pointerId); } catch (_) {}
          cv3.style.cursor = 'move';
          return;
        }
      }
    }
    // 벽 그리기 모드/평면 도구 활성: 제자리 클릭=점 찍기, 홀드-드래그=박스 선택 (선택은 어떤 상황에서도 가능)
    if ((v3.wallMode || state.tool !== 'select') && e.button === 0 && !e.shiftKey) {
      drag = { mode: 'wallpt', x: e.clientX, y: e.clientY, moved: 0, shift: false };
      const rb0 = cv3.getBoundingClientRect();
      drag.kx = rb0.width ? cv3.width / rb0.width : 1; drag.ky = rb0.height ? cv3.height / rb0.height : 1;
      drag.bx0 = (e.clientX - rb0.left) * drag.kx; drag.by0 = (e.clientY - rb0.top) * drag.ky;
      drag.bx1 = drag.bx0; drag.by1 = drag.by0;
      try { cv3.setPointerCapture(e.pointerId); } catch (_) {}
      return;
    }
    // (입면 라벨 클릭은 이제 DOM 이름표가 받는다 — vpLabelEl. 캔버스 히트는 제거했다.)
    // 평면과 동일한 규약: 좌드래그=박스 선택 · 우드래그=회전(고정 뷰는 이동) · Shift/휠버튼=화면 이동 · 터치=회전
    const isTouch = e.pointerType === 'touch';
    const fixedVp = !!v3.views[v3.act].fixed; // 평면·입면: 평행 투영 고정 — 회전 대신 이동
    const mode = (e.button === 1 || (e.shiftKey && e.button === 0)) ? 'pan'
      : (e.button === 2) ? (fixedVp ? 'pan' : 'orbit')
      : isTouch ? (fixedVp ? 'pan' : 'orbit') : 'box';
    drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: 0, shift: e.shiftKey, mode };
    if (mode === 'box') {
      const rb = cv3.getBoundingClientRect();
      const kx = rb.width ? cv3.width / rb.width : 1, ky = rb.height ? cv3.height / rb.height : 1;
      drag.kx = kx; drag.ky = ky;
      drag.bx0 = (e.clientX - rb.left) * kx; drag.by0 = (e.clientY - rb.top) * ky;
      drag.bx1 = drag.bx0; drag.by1 = drag.by0;
    }
    try { cv3.setPointerCapture(e.pointerId); } catch (_) {}
    cv3.style.cursor = (mode === 'orbit' || mode === 'pan') ? 'grabbing' : cv3.style.cursor;
    if (isTouch && mode !== 'box') {                   // 터치 홀드(≈1초) 후 드래그 = 박스 선택 (피그마식)
      drag.lpTimer = setTimeout(() => {
        if (!drag || drag.moved >= 8) return;
        const rb = cv3.getBoundingClientRect();
        const kx2 = rb.width ? cv3.width / rb.width : 1, ky2 = rb.height ? cv3.height / rb.height : 1;
        drag.mode = 'box'; drag.kx = kx2; drag.ky = ky2;
        drag.bx0 = (e.clientX - rb.left) * kx2; drag.by0 = (e.clientY - rb.top) * ky2;
        drag.bx1 = drag.bx0; drag.by1 = drag.by0;
        render3D();
      }, 800);
    }
  });
  cv3.addEventListener('pointermove', (e) => {
    // 돌출 높이 조절 중: 커서 라이브 프리뷰. 단 뷰를 돌리거나 옮기는 중이면 그쪽이 우선 —
    // 안 그러면 궤도 드래그가 높이 조절로 오인돼 높이가 멋대로 바뀐다.
    if (extrudePend && extrudePend.stage === 'height' && !(drag && (drag.mode === 'orbit' || drag.mode === 'pan'))) { extrudeHover(e); return; }
    if (!drag && (v3.wallMode || state.tool !== 'select' || osnapEnabled)) { // 작도 가선 + 스냅 마커 (선택 도구에서도 마커 표시)
      const r3 = cv3.getBoundingClientRect();
      const px3 = (e.clientX - r3.left) * (r3.width ? cv3.width / r3.width : 1);
      const py3 = (e.clientY - r3.top) * (r3.height ? cv3.height / r3.height : 1);
      const vi3 = vpAt(px3, py3); // 사분할: 커서가 있는 뷰포트 기준으로 스냅·가선 계산
      if (vi3 !== v3.act) { v3.act = vi3; loadVp(vi3); v3.vp = vpRect(vi3); }
      const w = unproj3D(px3, py3, cplaneZ());
      if (w) {
        const sn = snap3D(px3, py3, null);
        v3.snapHit = sn || null; // 스냅 마커 표시용
        const cur = sn ? { x: sn.x, y: sn.y, z: sn.z != null ? sn.z : cplaneZ() }
                       : { x: Math.round(w[0]), y: Math.round(w[1]), z: cplaneZ() };
        v3.toolCur = cur;
        if (v3.wallMode && v3.wallP1) v3.wallCur = [Math.round(w[0] / 10) * 10, Math.round(w[1] / 10) * 10, (sn && sn.z != null) ? sn.z : cplaneZ()];
        mouseWorld = { x: cur.x, y: cur.y };  // 2D 파이프라인의 러버밴드 로직 재사용
        updateDraft();
        const co = document.getElementById('coords');
        if (co) co.textContent = `X: ${cur.x.toFixed(2)}  Y: ${cur.y.toFixed(2)}  Z: ${cur.z != null ? cur.z : cplaneZ()}`;
        const drawing = draft || pts.length || (v3.wallMode && v3.wallP1) || v3.line3d;
        const snapKey = v3.snapHit ? (v3.snapHit.x + ',' + v3.snapHit.y + ',' + v3.snapHit.z) : '';
        if (!drawing && snapKey === v3._lastSnapKey) return; // 단순 호버·스냅 변화 없음 → 재렌더 생략(정확 모드 호버 렉 방지)
        v3._lastSnapKey = snapKey;
        if (drawing) markInteract();  // 작도 중 = rAF 코얼레싱(가선 부드럽게)
        else render3D();              // 단순 호버·스냅 변화 = 즉시 정확 렌더(마커)
      }
      return;
    }
    if (!drag) { if (v3.snapHit) { v3.snapHit = null; render3D(); } return; }
    markInteract(); // 실제 드래그(회전·이동·검볼·박스) 중 빠른 렌더 → 멈추면 정확 렌더
    if (drag.mode === 'gum') {
      const dxc = (e.clientX - drag.x0) * drag.kx, dyc = (e.clientY - drag.y0) * drag.ky;
      drag.moved = Math.max(drag.moved, Math.abs(dxc) + Math.abs(dyc));
      const s = dxc * drag.ax.ux + dyc * drag.ax.uy;   // 축 화면방향으로의 이동량(px)
      const want = Math.round(s / drag.ax.pxPerMm);     // 월드 mm (1mm 스냅)
      const delta = want - drag.applied;
      if (delta) {
        if (!drag.pushed) { pushUndo(); drag.pushed = true; }
        gumMove(drag.ent, drag.ax, delta);
        drag.applied = want;
        v3.solids = bimSolids(); markInteract();
      }
      return;
    }
    if (drag.mode === 'gumrot') { // 검볼 회전: 커서가 검볼 중심 둘레를 도는 화면 각도를 추적 (뷰 방향 무관)
      drag.moved = Math.max(drag.moved, Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0));
      const rr3 = cv3.getBoundingClientRect();
      const cpx = (e.clientX - rr3.left) * drag.kx, cpy = (e.clientY - rr3.top) * drag.ky;
      if (Math.hypot(cpx - drag.gs[0], cpy - drag.gs[1]) > 8 * (devicePixelRatio || 1)) { // 중심 특이점 회피
        const sa = Math.atan2(cpy - drag.gs[1], cpx - drag.gs[0]);
        let d = sa - drag.lastSA; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
        drag.lastSA = sa;
        drag.th += d * drag.sign;
      }
      const want = Math.round(drag.th * 180 / Math.PI); // 1° 스냅
      const delta = want - drag.appliedDeg;
      if (delta) {
        if (!drag.pushed) { pushUndo(); drag.pushed = true; }
        gumRotate(drag.ent, drag.ring.name, drag.ring.cx, drag.ring.cy, drag.ring.cz, delta);
        drag.appliedDeg = want;
        v3.rotDeg = want;
        v3.solids = bimSolids(); markInteract();
      }
      return;
    }
    if (drag.mode === 'lift') {
      const dyc = (e.clientY - drag.y0) * drag.py2cv;         // 화면 아래(+)로 이동한 캔버스 픽셀
      let nh = drag.h0 - dyc / drag.pxPerMm;                  // 위로 끌면 높이 증가
      nh = Math.max(100, Math.round(nh / 10) * 10);           // 10mm 스냅, 최소 100
      if (nh !== drag.ent.bim.h) {
        if (!drag.pushed) { pushUndo(); drag.pushed = true; } // 드래그 1회 = undo 1단계
        drag.ent.bim.h = nh;
        v3.solids = bimSolids(); markInteract();
      }
      return;
    }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.mode === 'wallpt') {
      if (drag.moved < 4) return;
      drag.mode = 'box'; // 도구 작도 중에도 홀드-드래그 = 박스 선택으로 전환 (클릭=점 찍기는 pointerup에서 유지)
    }
    if (drag.mode === 'box') { // 선택 박스 러버밴드 (렌더 안에서 그림)
      drag.bx1 += dx * drag.kx; drag.by1 += dy * drag.ky;
      v3.boxRect = { x0: drag.bx0, y0: drag.by0, x1: drag.bx1, y1: drag.by1 };
      markInteract();
      return;
    }
    if (drag.mode === 'orbit') {
      // 라이노식 궤도 (2026-07-20):
      //  ① 회전 감도를 줌에 반비례시킨다 — 멀리서 보면 크게, 당겨서 보면 그만큼 미세하게.
      //     (예전엔 배율과 무관한 고정 감도라, 확대할수록 같은 드래그가 화면을 통째로 휘둘렀다)
      //  ② 회전 중심을 '화면 중앙에 있는 지점'으로 유지한다. 모델 중심(v3.cx..)만 축으로 삼으면
      //     확대해 들여다보던 부분이 회전과 함께 화면 밖으로 날아간다 — 라이노는 보고 있던 곳을
      //     붙잡고 돈다. 회전 후 pan 을 보정해 그 지점이 제자리에 있게 한다.
      const vpR = v3.vp || { x: 0, y: 0, w: v3.cv.width, h: v3.cv.height };
      const ccxR = vpR.x + vpR.w / 2, ccyR = vpR.y + vpR.h / 2;
      const kR = Math.min(vpR.w, vpR.h) / (v3.fit * 1.4) * (v3.zoom || 1);
      const pivot = unproj3D(ccxR, ccyR, v3.cz);            // 지금 화면 중앙에 보이는 월드 점
      const sens = 1 / Math.max(1, Math.sqrt(v3.zoom || 1)); // 줌 1=그대로, 4배=1/2, 25배=1/5 …
      v3.yaw += dx * 0.008 * sens;           // 드래그 방향 = 모델 회전 방향 (라이노식)
      v3.pitch += dy * 0.006 * sens;         // 각도 제한 없음 — 아래에서도 볼 수 있음
      if (pivot && kR > 0) {                 // 회전 후에도 그 점이 화면 중앙에 머물도록 pan 보정
        const pp = proj3D(pivot[0], pivot[1], v3.cz);
        v3.panX -= (pp[0] - ccxR) / kR;
        v3.panY += (pp[1] - ccyR) / kR;
      }
    } else {
      const k = Math.min(v3.cv.width, v3.cv.height) / (v3.fit * 1.4) * v3.zoom;
      v3.panX += dx * (devicePixelRatio || 1) / k;
      v3.panY -= dy * (devicePixelRatio || 1) / k;
    }
    markInteract();
  });
  const end = (e) => {
    if (drag && drag.lpTimer) clearTimeout(drag.lpTimer); // 터치 홀드 박스선택 타이머 정리
    if (v3.boxRect) v3.boxRect = null; // 러버밴드 상태 해제 (최종 렌더에서 사라짐)
    if (drag && drag.mode === 'gumrot') {
      if (drag.moved < 4 && e && e.type === 'pointerup') { // 링 클릭 = 각도 수치 입력 (라이노식)
        const v = parseFloat(prompt(`${drag.ring.name.toUpperCase()}축 회전 각도 (도, 반시계 +):`, '0'));
        if (isFinite(v) && v) {
          if (!drag.pushed) { pushUndo(); drag.pushed = true; }
          gumRotate(drag.ent, drag.ring.name, drag.ring.cx, drag.ring.cy, drag.ring.cz, v);
          drag.appliedDeg = Math.round(v);
          v3.solids = bimSolids();
        }
      }
      if (drag.pushed) logLine(`  ✔ ${drag.ring.name.toUpperCase()}축 회전 ${drag.appliedDeg}°`, 'ok');
      v3.rotDeg = null;
      renderProps(); render3D();
      drag = null; cv3.style.cursor = cursor3D();
      saveV3Layout();
      return;
    }
    if (drag && drag.mode === 'gum') {
      if (drag.moved < 4 && e && e.type === 'pointerup') { // 축 클릭 = 수치 입력 (라이노식)
        const v = parseFloat(prompt(`${drag.ax.name.toUpperCase()}축 이동 거리 (mm, +방향/-방향):`, '0'));
        if (isFinite(v) && v) {
          if (!drag.pushed) { pushUndo(); drag.pushed = true; }
          gumMove(drag.ent, drag.ax, Math.round(v));
          v3.solids = bimSolids();
        }
      }
      if (drag.pushed) logLine(`  ✔ ${drag.ax.name.toUpperCase()}축 이동 완료`, 'ok');
      renderProps(); render3D();
    } else if (drag && drag.mode === 'lift') {
      if (drag.pushed) { renderProps(); logLine(`  ✔ 높이 조절: ${drag.h0} → ${drag.ent.bim.h}`, 'ok'); }
    } else if (drag && e && e.type === 'pointerup') {
      // 돌출 중 우클릭: '탭'(거의 안 움직임)이면 예전처럼 취소, 드래그였으면 뷰를 돌린 것이므로 명령 유지.
      if (extrudePend && extrudePend.stage === 'height' && drag.mode === 'orbit' && drag.moved < 4 && e.button === 2) {
        extrudePendCancel();
        drag = null; cv3.style.cursor = cursor3D(); saveV3Layout();
        return;
      }
      if (drag.mode === 'box' && drag.moved >= 4) {
        // 줌 윈도(zoom): 3D·입면 뷰포트에서도 드래그한 박스만큼 확대 (2026-07-20 — 모든 환경 호환)
        if (state.tool === '_zoomw') applyZoomWindow3D(drag); else applyBox3D(drag);
      }
      else if (drag.moved < 4 && (e.button === 0 || e.pointerType === 'touch')) {
        if (v3.wallMode) wall3DClick(e);
        else if (state.tool === '_zoomw') { /* 줌 윈도는 3D에선 드래그로 박스 지정 — 클릭은 무시 */ }
        else if (state.tool === 'line') line3DClick(e); // 3D 선: 정점별 높이 지원
        else if (state.tool !== 'select') tool3DClick(e); // 나머지 평면 도구
        else {
          pick3D(e, drag.shift);
          // extrudesrf(면 밀당): 면/솔리드를 클릭하면 즉시 선택 → 높이 조절로 진행(Enter 불필요)
          if (extrudePend && extrudePend.stage === 'pickSel' && extrudePend.cmd === 'extrudesrf') {
            const valid = extrudeValidSel('extrudesrf');
            if (valid.length) { const c2 = extrudePend.cmd; extrudePend = null; extrudeStart(c2, valid); }
          }
        }
      } else if (drag.mode === 'box') render3D(); // 박스 흔적 지우기
    }
    drag = null; cv3.style.cursor = cursor3D();
    saveV3Layout();
  };
  cv3.addEventListener('pointerup', end); cv3.addEventListener('pointercancel', end);
  cv3.addEventListener('wheel', (e) => {
    e.preventDefault();
    markInteract();
    { // 커서가 올라간 뷰포트에 줌 적용
      const rv = cv3.getBoundingClientRect();
      const pxv = (e.clientX - rv.left) * (rv.width ? cv3.width / rv.width : 1);
      const pyv = (e.clientY - rv.top) * (rv.height ? cv3.height / rv.height : 1);
      const vi = vpAt(pxv, pyv);
      if (vi !== v3.act) { v3.act = vi; loadVp(vi); }
    }
    // 델타 크기에 비례한 부드러운 줌 (한 칸 ≈ ×1.06)
    // 확대 리미트 완화(0.1~20 → 사실상 무제한) — mm 단위 개체 작업이 리미트에 막혔다 (2026-07-20)
    v3.zoom = Math.max(0.001, Math.min(100000, v3.zoom * Math.pow(1.06, -(e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY) / 100)));
  }, { passive: false });
  // 더블클릭: 사분할 ↔ 해당 뷰 최대화 (라이노식)
  cv3.addEventListener('dblclick', (e) => {
    const rv = cv3.getBoundingClientRect();
    const pxv = (e.clientX - rv.left) * (rv.width ? cv3.width / rv.width : 1);
    const pyv = (e.clientY - rv.top) * (rv.height ? cv3.height / rv.height : 1);
    if (v3.quad) { v3.act = vpAt(pxv, pyv); loadVp(v3.act); v3.quad = false; }
    else v3.quad = true;
    render3D(); saveV3Layout();
  });
  cv3.addEventListener('contextmenu', (e) => e.preventDefault());
  // 터치: 핀치 줌
  let pinch = null;
  cv3.addEventListener('touchstart', (e) => { if (e.touches.length === 2) pinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); }, { passive: true });
  cv3.addEventListener('touchmove', (e) => {
    if (pinch && e.touches.length === 2) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      v3.zoom = Math.max(0.001, Math.min(100000, v3.zoom * d / pinch)); pinch = d; markInteract();
    }
  }, { passive: true });
  const setWallMode = (on) => {
    v3.wallMode = on; v3.wallP1 = null; v3.wallCur = null;
    cv3.style.cursor = cursor3D();
    if (on) logLine(`  ▷ 3D 벽 그리기: 바닥면(현재 층 레벨)을 클릭해 벽의 시작·끝점을 찍으세요 — 연속 그리기, Esc=종료`, 'info');
    render3D();
  };
  v3.setWallMode = setWallMode;
  { // 작업면 컨트롤 (하단 상태바 #cplaneStatus로 이동됨 — getElementById로 배선)
    const zi = document.getElementById('cpZ'), sl = document.getElementById('cpSlide');
    if (zi && sl) {
      zi.value = cplaneZ(); sl.value = cplaneZ();
      zi.addEventListener('change', () => setCplane(parseFloat(zi.value)));
      sl.addEventListener('input', () => setCplane(parseFloat(sl.value)));
      document.getElementById('cpMinus').addEventListener('click', () => setCplane(cplaneZ() - 100));
      document.getElementById('cpPlus').addEventListener('click', () => setCplane(cplaneZ() + 100));
      document.getElementById('cpReset').addEventListener('click', () => { v3.cplane = null; setCplane(NaN); });
      zi.addEventListener('keydown', (e) => e.stopPropagation()); // 전역 단축키와 충돌 방지
    }
  }
  window.addEventListener('resize', () => { if (ov.style.display !== 'none') { size3D(); render3D(); } });
  // 패널 폭 드래그·명령기록 접기 등 window resize 없이 영역만 변하는 경우 — 2D(wrap)와 동일하게 관찰
  // (버퍼 크기를 다시 잡지 않으면 CSS만 늘어나 개체가 왜곡되어 보임)
  new ResizeObserver(() => { if (ov.style.display !== 'none') { size3D(); render3D(); } }).observe(ov);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || ov.style.display === 'none') return;
    { // 명령창에 입력 중이면 Esc 1타 = 입력 '초기화'만 (2026-07-20 사용자 규칙) — 캡처가 먼저 먹기 전에 처리
      const ci = document.getElementById('cmdInput');
      if (ci && e.target === ci && ci.value) { ci.value = ''; e.stopPropagation(); e.preventDefault(); return; }
    }
    e.stopPropagation(); // 전역 Escape 핸들러가 선택을 먼저 지워 2단계 판정이 깨지는 것 방지
    if (typeof boolPending !== 'undefined' && boolPending) { boolPending = null; logLine('  차집합 취소', 'info'); state.selection.clear(); renderProps(); render3D(); return; } // 차집합 2단계 취소
    if (extrudePend) { extrudePendCancel(); return; }                                   // 0차: 돌출(선택/cap/높이) 취소
    if (v3.wallMode) { setWallMode(false); }                                          // 0차: 벽 그리기 종료
    else if (state.tool !== 'select') { setTool('select'); state.selection.clear(); renderProps(); render3D(); } // 0.5차: 도구 취소
    else if (state.selection.size) { state.selection.clear(); renderProps(); render3D(); } // 1차: 선택 해제
    // 평면 복귀는 상단 [평면|3D] 토글로만 — Esc로는 뷰를 바꾸지 않음
  }, true);
}
// 모드 메뉴는 바깥을 누르거나 Esc 로 닫는다 (모듈 로드 시 한 번 등록)
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => {
    if (_vpMenuEl && !_vpMenuEl.contains(e.target)) closeVpMenu();
  }, true);
  // ★window capture 로 등록한다. 3D 의 Escape 핸들러(bind3D)가 window capture 에서
  //   stopPropagation 을 하므로 document bubble 로는 이벤트가 오지 않는다. 모듈 로드 시 등록이라
  //   bind3D(첫 open3D 시 등록)보다 먼저 실행된다 → 메뉴가 열려 있으면 그 Esc 를 여기서 먹는다
  //   (Esc 로 메뉴만 닫히고 선택 해제 같은 다른 동작은 일어나지 않게).
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _vpMenuEl) { closeVpMenu(); e.stopPropagation(); }
  }, true);
}
function close3D() {
  const ov = document.getElementById('bim3d');
  if (ov) ov.style.display = 'none';
  if (v3 && v3.wallMode && v3.setWallMode) v3.setWallMode(false);
  stopLive3D(); syncViewSeg(false);
  closeVpMenu();
  for (let k = 0; k < 4; k++) vpHideLabel(k);   // 3D 이름표 정리 (평면으로 나가면 안 보여야)
  syncPlanCv(); // #cv 를 다시 화면 전체로 (평면 칸에 배치돼 있던 인라인 스타일 해제) — resize+draw 포함
  resize();     // 캔버스 크기를 화면 전체로 되돌린다
}
// 상단 뷰 세그먼트 — 통합 작업환경 (2026-07-19): 평면/3D/4분할은 별개 모드가 아니라
// 같은 3D 셸의 '시점 프리셋'이다. 평면 = 평면 뷰포트 단일 확대(같은 2D 엔진이 그린다),
// 3D = 아이소 단일, 4분할 = 쿼드 토글. close3D(평면 전용 화면)는 내부 폴백으로만 남긴다.
(function bindViewSeg() {
  const d = document.getElementById('vw3d'), p = document.getElementById('vwPlan');
  const q = document.getElementById('vwQuad');
  function focusView(planWanted) {
    if (!is3DActive()) open3D();
    if (!v3) return;
    // ★vpPlanIndex 는 '화면에 보이는' 칸만 찾는다(단일 뷰에선 -1) — 레이아웃 전체에서 찾아야 한다
    const i = planWanted ? v3.views.findIndex(w => w.mode === 'plan')
      : v3.views.findIndex(w => !w.fixed && w.mode !== 'plan');   // 자유 회전 뷰 = 아이소
    if (i < 0) { if (planWanted) close3D(); return; }             // 평면 칸 없는 레이아웃 → 기존 평면 전용 폴백
    saveVp(); v3.act = i; loadVp(i);
    v3.quad = false;
    render3D(); saveV3Layout(); syncViewSeg(true);
  }
  if (p) p.addEventListener('click', () => focusView(true));
  if (d) d.addEventListener('click', () => focusView(false));
  if (q) q.addEventListener('click', () => {
    const ov = document.getElementById('bim3d');
    if (!ov || ov.style.display === 'none') { open3D(); if (v3) { v3.quad = true; render3D(); saveV3Layout(); } }
    else { v3.quad = !v3.quad; render3D(); saveV3Layout(); }
    syncViewSeg(true);
  });
})();
// 시작하면 항상 통합 셸을 연다 (저장 레이아웃 복원, 첫 실행은 4분할).
// 테스트 iframe 은 기존 계약(평면 시작)을 유지한다.
if (!window.frameElement) setTimeout(() => {
  try {
    const first = localStorage.getItem('webcad_v3_layout2') == null;
    open3D();
    if (v3 && first) { v3.quad = true; render3D(); saveV3Layout(); }
    syncViewSeg(true);
  } catch (e) { console.warn('통합 셸 자동 열기 실패(평면으로 시작):', e); }
}, 0);
// 3D 스냅: 클릭 지점 근처(화면 12px)의 끝점·중간점으로 흡착 (OSNAP 토글 존중)
// 3D 선분-선분 최근접 거리와 중간점 — 라이노 Int의 '실제 3D 교차' 판정용 (Ericson 클램프 방식)
function seg3Dist(p1, p2, q1, q2) {
  const d1 = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
  const d2 = [q2[0] - q1[0], q2[1] - q1[1], q2[2] - q1[2]];
  const r0 = [p1[0] - q1[0], p1[1] - q1[1], p1[2] - q1[2]];
  const a = d1[0] * d1[0] + d1[1] * d1[1] + d1[2] * d1[2];
  const e = d2[0] * d2[0] + d2[1] * d2[1] + d2[2] * d2[2];
  const f = d2[0] * r0[0] + d2[1] * r0[1] + d2[2] * r0[2];
  let s, t;
  if (a <= 1e-12 && e <= 1e-12) { s = 0; t = 0; }
  else if (a <= 1e-12) { s = 0; t = Math.max(0, Math.min(1, f / e)); }
  else {
    const c0 = d1[0] * r0[0] + d1[1] * r0[1] + d1[2] * r0[2];
    if (e <= 1e-12) { t = 0; s = Math.max(0, Math.min(1, -c0 / a)); }
    else {
      const b = d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2], den = a * e - b * b;
      s = den > 1e-12 ? Math.max(0, Math.min(1, (b * f - c0 * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c0 / a)); }
      else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c0) / a)); }
    }
  }
  const cp = [p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s];
  const cq = [q1[0] + d2[0] * t, q1[1] + d2[1] * t, q1[2] + d2[2] * t];
  return { d: Math.hypot(cp[0] - cq[0], cp[1] - cq[1], cp[2] - cq[2]), p: [(cp[0] + cq[0]) / 2, (cp[1] + cq[1]) / 2, (cp[2] + cq[2]) / 2] };
}
// 점 (x,y)가 평면 곡선 e '위'에 있는지 (기울어진 3D 선의 평면 통과점이 진짜 교차인지 검증)
function onCurve2D(e, x, y, tol) {
  if (e.type === 'CIRCLE' || e.type === 'ARC') {
    if (Math.abs(Math.hypot(x - e.cx, y - e.cy) - e.r) > tol) return false;
    return e.type !== 'ARC' || angleInArc(ang(e.cx, e.cy, x, y), e.startAngle, e.endAngle);
  }
  for (const sg of entitySegments(e)) {
    const q = closestOnSeg(x, y, sg[0], sg[1], sg[2], sg[3]);
    if (Math.hypot(q.x - x, q.y - y) <= tol) return true;
  }
  return false;
}
// ============================================================
//  표면 스냅 (라이노 오스냅의 Surface에 해당)
//  솔리드·메시의 '면' 위에 커서를 얹는다 → 곡면 위에 직접 곡선을 그릴 수 있음.
//  꼭짓점·모서리보다 우선순위가 낮아, 면 위 빈 곳을 가리킬 때만 잡힌다.
//  투영이 직교(perspective divide 없음)라서 화면 삼각형의 무게중심 좌표로 z를 정확히 보간할 수 있다.
// ============================================================
function surfaceSnap3D(px, py, exclude) {
  if (typeof v3 === 'undefined' || !v3) return null;
  let best = null, bestDepth = Infinity;
  // 삼각형 하나 검사 — 커서가 화면상 삼각형 안이면 그 지점의 z를 보간해서 후보로
  const tri = (A, B, C) => {
    const a = proj3D(A[0], A[1], A[2]), b = proj3D(B[0], B[1], B[2]), c = proj3D(C[0], C[1], C[2]);
    const v0x = c[0] - a[0], v0y = c[1] - a[1], v1x = b[0] - a[0], v1y = b[1] - a[1], v2x = px - a[0], v2y = py - a[1];
    const d00 = v0x * v0x + v0y * v0y, d01 = v0x * v1x + v0y * v1y, d02 = v0x * v2x + v0y * v2y;
    const d11 = v1x * v1x + v1y * v1y, d12 = v1x * v2x + v1y * v2y;
    const den = d00 * d11 - d01 * d01;
    if (Math.abs(den) < 1e-9) return;
    const u = (d11 * d02 - d01 * d12) / den, t = (d00 * d12 - d01 * d02) / den;
    if (u < -0.001 || t < -0.001 || u + t > 1.001) return;
    const depth = (a[2] + b[2] + c[2]) / 3; // proj3D의 3번째 성분 = 깊이 (앞면 우선)
    if (depth >= bestDepth) return;
    const z = A[2] + (C[2] - A[2]) * u + (B[2] - A[2]) * t;
    const q = unproj3D(px, py, z);
    if (!q) return;
    bestDepth = depth;
    best = { x: Math.round(q[0]), y: Math.round(q[1]), z: Math.round(z), kind: 'surface' };
  };
  // 메시(불리언 결과·구·원뿔·STL·로프트 등)
  for (const e of state.entities) {
    if (e.type !== 'MESH' || !e.tris) continue;
    if (exclude && exclude.has(e.id)) continue;
    const l = getLayer(e.layer); if (l && !l.visible) continue;
    if (e.tris.length > 4000) continue; // 과대 메시는 성능상 생략 (기존 표면 스냅과 동일 기준)
    for (const t of e.tris) tri(t[0], t[1], t[2]);
  }
  // BIM 솔리드(벽·기둥·슬래브·지붕) — 윗면/바닥면 + 옆면
  for (const s of (v3.solids || [])) {
    if (exclude && exclude.has(s.eid)) continue;
    const P = s.poly; if (!P || P.length < 3) continue;
    const zt = s.zt || P.map(() => s.z1);
    const Q = (s.ptop && s.ptop.length === P.length) ? s.ptop : P;   // 어긋난 윗면 지원
    for (let i = 1; i < P.length - 1; i++) { // 팬 삼각화: 바닥·윗면
      tri([P[0][0], P[0][1], s.z0], [P[i][0], P[i][1], s.z0], [P[i + 1][0], P[i + 1][1], s.z0]);
      tri([Q[0][0], Q[0][1], zt[0]], [Q[i][0], Q[i][1], zt[i]], [Q[i + 1][0], Q[i + 1][1], zt[i + 1]]);
    }
    for (let i = 0; i < P.length; i++) { // 옆면(사각형 → 삼각형 2개)
      const j = (i + 1) % P.length;
      const a = [P[i][0], P[i][1], s.z0], b = [P[j][0], P[j][1], s.z0];
      const c = [Q[j][0], Q[j][1], zt[j]], d = [Q[i][0], Q[i][1], zt[i]];
      tri(a, b, c); tri(a, c, d);
    }
  }
  return best;
}

function snap3D(px, py, w, exclude) {
  if (!osnapEnabled) return w;
  let best = null, bestD = 14 * (devicePixelRatio || 1);
  // 그리는 중인 자기 점들 (폴리라인 pts, 3D 선 시작, 벽 시작) — 닫기/복귀 스냅
  if (!settings.osnapModes || settings.osnapModes.endpoint !== false) {
    const selfPts = [];
    for (const p of pts) selfPts.push([p.x, p.y, cplaneZ()]);
    if (v3 && v3.line3d && v3.line3d.p1) selfPts.push([v3.line3d.p1.x, v3.line3d.p1.y, v3.line3d.p1.z]);
    if (v3 && v3.wallMode && v3.wallP1) selfPts.push([v3.wallP1[0], v3.wallP1[1], v3.wallP1[2] != null ? v3.wallP1[2] : cplaneZ()]);
    for (const sp of selfPts) {
      const s = proj3D(sp[0], sp[1], sp[2]);
      const d = Math.hypot(s[0] - px, s[1] - py);
      if (d < bestD) { bestD = d; best = { x: sp[0], y: sp[1], z: sp[2], kind: 'endpoint' }; }
    }
  }
  for (const e of state.entities) {
    if (exclude && exclude.has(e.id)) continue; // 돌출 중인 대상 자신 제외
    const l = getLayer(e.layer); if (l && !l.visible) continue;
    const zb = (state.levels[e.lv || 0] || { elev: 0 }).elev + (e.zo || 0);
    let cands = [];
    if (e.type === 'LINE') { // 3D 선: 정점별 z (z1/z2 없으면 평면 z)
      const za = e.z1 != null ? e.z1 : zb, zc = e.z2 != null ? e.z2 : zb;
      cands = [
        { x: e.x1, y: e.y1, z: za, kind: 'endpoint' },
        { x: e.x2, y: e.y2, z: zc, kind: 'endpoint' },
        { x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2, z: (za + zc) / 2, kind: 'midpoint' },
      ];
    } else if (e.type === 'LWPOLYLINE' && polyHasZ(e)) { // 표면 위 곡선: 정점별 실제 높이로 스냅
      cands = e.points.map((p, i) => ({ x: p[0], y: p[1], z: e.zs[i], kind: 'endpoint' }));
      const segN = e.closed ? e.points.length : e.points.length - 1;
      for (let i = 0; i < segN; i++) {
        const j = (i + 1) % e.points.length;
        cands.push({ x: (e.points[i][0] + e.points[j][0]) / 2, y: (e.points[i][1] + e.points[j][1]) / 2,
                     z: (e.zs[i] + e.zs[j]) / 2, kind: 'midpoint' });
      }
    } else {
      let eps = [], mps = [];
      try { eps = entityEndpoints(e); mps = entityMidpoints(e); } catch (_) { continue; }
      cands = eps.map(p => ({ x: p.x, y: p.y, z: zb, kind: 'endpoint' }))
        .concat(mps.map(p => ({ x: p.x, y: p.y, z: zb, kind: 'midpoint' })));
      if (e.type === 'CIRCLE' || e.type === 'ARC') {
        cands.push({ x: e.cx, y: e.cy, z: zb, kind: 'center' }); // 중심 스냅
        // 사분점(Quad): 0°/90°/180°/270° — 호는 각도 범위 안의 것만 (라이노 Quad)
        for (const q of [[e.cx + e.r, e.cy], [e.cx - e.r, e.cy], [e.cx, e.cy + e.r], [e.cx, e.cy - e.r]]) {
          if (e.type === 'ARC' && !angleInArc(ang(e.cx, e.cy, q[0], q[1]), e.startAngle, e.endAngle)) continue;
          cands.push({ x: q[0], y: q[1], z: zb, kind: 'quad' });
        }
      }
    }
    for (const p of cands) {
      if (!p || !isFinite(p.x)) continue;
      if (settings.osnapModes && settings.osnapModes[p.kind] === false) continue; // 2D와 동일한 종류별 토글 존중
      const s = proj3D(p.x, p.y, p.z);
      const d = Math.hypot(s[0] - px, s[1] - py);
      if (d < bestD) { bestD = d; best = { x: p.x, y: p.y, z: p.z, kind: p.kind }; }
    }
  }
  // ── 라이노 정합 오스냅: Int(교차) / Perp(수직) / Tan(접선) ──
  const osOn = k => !settings.osnapModes || settings.osnapModes[k] !== false;
  const dpr3s = devicePixelRatio || 1;
  const entZ3 = e => (state.levels[e.lv || 0] || { elev: 0 }).elev + (e.zo || 0);
  const segs3Of = e => { // 곡선의 3D 세그먼트 (LINE은 정점 z, 폴리라인은 평면 z)
    const zb = entZ3(e), out = [];
    if (e.type === 'LINE') out.push([[e.x1, e.y1, e.z1 != null ? e.z1 : zb], [e.x2, e.y2, e.z2 != null ? e.z2 : zb]]);
    else if (e.type === 'LWPOLYLINE' && e.points) {
      for (let i = 0; i < e.points.length - (e.closed ? 0 : 1); i++) {
        const a = e.points[i], b = e.points[(i + 1) % e.points.length];
        out.push([[a[0], a[1], zb], [b[0], b[1], zb]]);
      }
    }
    return out;
  };
  const snapEnts = []; // Int/Perp/Tan 공용 곡선 목록 (레이어·exclude 필터)
  for (const e of state.entities) {
    if (exclude && exclude.has(e.id)) continue;
    if (!['LINE', 'LWPOLYLINE', 'CIRCLE', 'ARC'].includes(e.type)) continue;
    const l = getLayer(e.layer); if (l && !l.visible) continue;
    snapEnts.push(e);
  }
  // 교차(Int): 곡선쌍의 '실제 3D 교차점' — 겉보기(화면상) 교차가 아니라 공간에서 진짜 만나는 점만 (라이노 Int)
  if (osOn('intersection') && snapEnts.length >= 2) {
    const mg3 = 40 * dpr3s;
    const nearCur = e => { // 화면 근접 프리필터: 투영 bbox (성능)
      let bb = null; try { bb = entityBBox(e); } catch (_) { return false; }
      if (!bb) return false;
      const zb = entZ3(e);
      const zs = e.type === 'LINE' ? [e.z1 != null ? e.z1 : zb, e.z2 != null ? e.z2 : zb] : [zb];
      let x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18;
      for (const zz of zs) for (const cn of [[bb.xmin, bb.ymin], [bb.xmax, bb.ymin], [bb.xmax, bb.ymax], [bb.xmin, bb.ymax]]) {
        const p = proj3D(cn[0], cn[1], zz);
        x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
      }
      return px >= x0 - mg3 && px <= x1 + mg3 && py >= y0 - mg3 && py <= y1 + mg3;
    };
    const planeZ = e => { // 곡선이 실려 있는 수평면 z (기울어진 3D 선이면 null)
      const zb = entZ3(e);
      if (e.type === 'LINE' && (e.z1 != null || e.z2 != null)) {
        const za = e.z1 != null ? e.z1 : zb, zc = e.z2 != null ? e.z2 : zb;
        return Math.abs(za - zc) < 0.5 ? (za + zc) / 2 : null;
      }
      return zb;
    };
    const near = snapEnts.filter(nearCur).slice(0, 12), hits = [];
    for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) {
      const A = near[i], B = near[j], zA = planeZ(A), zB = planeZ(B);
      if (zA != null && zB != null) {
        if (Math.abs(zA - zB) > 0.5) continue; // 서로 다른 평면 — 공간에서 만나지 않음
        for (const pt of intersectEntities(A, B)) hits.push([pt[0], pt[1], zA]);
      } else if (zA == null && zB == null) { // 기울어진 3D 선 × 3D 선: 최근접 거리로 실제 교차 판정
        for (const a of segs3Of(A)) for (const b of segs3Of(B)) {
          const r = seg3Dist(a[0], a[1], b[0], b[1]);
          if (r.d <= 0.5) hits.push(r.p);
        }
      } else { // 기울어진 3D 선 × 평면 곡선: 선이 그 평면을 통과하는 점이 곡선 위에 있을 때만
        const ln = zA == null ? A : B, pl = zA == null ? B : A, zp = zA == null ? zB : zA;
        const sg = segs3Of(ln)[0];
        if (sg) {
          const [P, Q] = sg;
          if ((P[2] - zp) * (Q[2] - zp) <= 0 && Math.abs(Q[2] - P[2]) > 1e-9) {
            const t = (zp - P[2]) / (Q[2] - P[2]);
            const hx = P[0] + (Q[0] - P[0]) * t, hy = P[1] + (Q[1] - P[1]) * t;
            if (onCurve2D(pl, hx, hy, 0.5)) hits.push([hx, hy, zp]);
          }
        }
      }
    }
    for (const h of hits) {
      const s = proj3D(h[0], h[1], h[2]);
      const d = Math.hypot(s[0] - px, s[1] - py);
      if (d < bestD) { bestD = d; best = { x: h[0], y: h[1], z: h[2], kind: 'intersect' }; }
    }
  }
  // 수직(Perp)·접선(Tan): 작도 기준점(직전 클릭점)이 있을 때만 성립 — 라이노와 동일. 점 스냅이 없을 때 2순위.
  let base3 = null;
  if (typeof pts !== 'undefined' && pts.length) { const lp = pts[pts.length - 1]; base3 = [lp.x, lp.y, cplaneZ()]; }
  if (v3 && v3.line3d && v3.line3d.p1) base3 = [v3.line3d.p1.x, v3.line3d.p1.y, v3.line3d.p1.z];
  if (v3 && v3.wallMode && v3.wallP1) base3 = [v3.wallP1[0], v3.wallP1[1], v3.wallP1[2] != null ? v3.wallP1[2] : cplaneZ()];
  if (!best && base3) {
    let pt3 = null, ptD = 12 * dpr3s;
    for (const e of snapEnts) {
      const zb = entZ3(e);
      if (osOn('perp')) {
        if (e.type === 'CIRCLE' || e.type === 'ARC') { // 원 위 수직점: 기준점→중심 방향(법선)이 원과 만나는 점
          const dx = base3[0] - e.cx, dy = base3[1] - e.cy, L = Math.hypot(dx, dy);
          if (L > 1e-9) for (const sgn of [1, -1]) {
            const x = e.cx + dx / L * e.r * sgn, y = e.cy + dy / L * e.r * sgn;
            if (e.type === 'ARC' && !angleInArc(ang(e.cx, e.cy, x, y), e.startAngle, e.endAngle)) continue;
            const s = proj3D(x, y, zb), d = Math.hypot(s[0] - px, s[1] - py);
            if (d < ptD) { ptD = d; pt3 = { x, y, z: zb, kind: 'perp' }; }
          }
        } else {
          for (const [A, B] of segs3Of(e)) { // 3D 수선의 발 — 선분 범위 안에 있을 때만
            const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
            const L2 = ux * ux + uy * uy + uz * uz; if (L2 < 1e-12) continue;
            const t = ((base3[0] - A[0]) * ux + (base3[1] - A[1]) * uy + (base3[2] - A[2]) * uz) / L2;
            if (t < -1e-9 || t > 1 + 1e-9) continue;
            const x = A[0] + ux * t, y = A[1] + uy * t, z = A[2] + uz * t;
            const s = proj3D(x, y, z), d = Math.hypot(s[0] - px, s[1] - py);
            if (d < ptD) { ptD = d; pt3 = { x, y, z, kind: 'perp' }; }
          }
        }
      }
      if (osOn('tangent') && (e.type === 'CIRCLE' || e.type === 'ARC')) { // 접점: 기준점이 원 밖일 때 2개
        const dx = base3[0] - e.cx, dy = base3[1] - e.cy, L = Math.hypot(dx, dy);
        if (L > e.r + 1e-9) {
          const bAng = Math.atan2(dy, dx), al = Math.acos(e.r / L);
          for (const sgn of [1, -1]) {
            const x = e.cx + e.r * Math.cos(bAng + al * sgn), y = e.cy + e.r * Math.sin(bAng + al * sgn);
            if (e.type === 'ARC' && !angleInArc(ang(e.cx, e.cy, x, y), e.startAngle, e.endAngle)) continue;
            const s = proj3D(x, y, zb), d = Math.hypot(s[0] - px, s[1] - py);
            if (d < ptD) { ptD = d; pt3 = { x, y, z: zb, kind: 'tangent' }; }
          }
        }
      }
    }
    if (pt3) best = pt3;
  }
  // 근접(nearest): 밑그림·3D선 세그먼트 위의 최근접점 (끝점류가 안 잡힐 때 변 위에 흡착)
  if (!best && (!settings.osnapModes || settings.osnapModes.nearest !== false)) {
    let nb = null, nd = 10 * (devicePixelRatio || 1);
    for (const e of state.entities) {
      if (exclude && exclude.has(e.id)) continue;
      const l = getLayer(e.layer); if (l && !l.visible) continue;
      const zb = (state.levels[e.lv || 0] || { elev: 0 }).elev + (e.zo || 0);
      let segs2 = [];
      if (e.type === 'LINE') segs2 = [[[e.x1, e.y1, e.z1 != null ? e.z1 : zb], [e.x2, e.y2, e.z2 != null ? e.z2 : zb]]];
      else if (e.type === 'LWPOLYLINE' && e.points) {
        for (let i = 0; i < e.points.length - (e.closed ? 0 : 1); i++) {
          const a = e.points[i], b = e.points[(i + 1) % e.points.length];
          segs2.push([[a[0], a[1], zb], [b[0], b[1], zb]]);
        }
      } else continue;
      for (const [A, B] of segs2) {
        const pa = proj3D(A[0], A[1], A[2]), pb = proj3D(B[0], B[1], B[2]);
        const dx = pb[0] - pa[0], dy = pb[1] - pa[1], L2 = dx * dx + dy * dy;
        const tt = L2 ? Math.max(0, Math.min(1, ((px - pa[0]) * dx + (py - pa[1]) * dy) / L2)) : 0;
        const d = Math.hypot(px - (pa[0] + dx * tt), py - (pa[1] + dy * tt));
        if (d < nd) { nd = d; nb = { x: Math.round(A[0] + (B[0] - A[0]) * tt), y: Math.round(A[1] + (B[1] - A[1]) * tt), z: Math.round(A[2] + (B[2] - A[2]) * tt), kind: 'nearest' }; }
      }
    }
    if (nb) best = nb;
  }
  // 입체(BIM 솔리드) 모서리 꼭짓점 — 벽 상·하단 코너 등 3D 지오메트리에도 스냅
  if (!settings.osnapModes || settings.osnapModes.endpoint !== false) {
    for (const s of (v3.solids || [])) {
      if (exclude && exclude.has(s.eid)) continue; // 돌출 중인 대상의 솔리드 제외(자기 top에 흡착 방지)
      const zt = s.zt || s.poly.map(() => s.z1);
      const Qs = (s.ptop && s.ptop.length === s.poly.length) ? s.ptop : s.poly;
      for (let i = 0; i < s.poly.length; i++) {
        // 기울어진 매스는 윗 꼭짓점이 바닥과 다른 자리에 있다 — 각자 제 좌표로 흡착
        for (const [PP, zz] of [[s.poly[i], s.z0], [Qs[i], zt[i]]]) {
          const sp = proj3D(PP[0], PP[1], zz);
          const d = Math.hypot(sp[0] - px, sp[1] - py);
          if (d < bestD) { bestD = d; best = { x: PP[0], y: PP[1], z: zz, kind: 'endpoint' }; }
        }
      }
    }
  }
  // 표면 — 가장 낮은 우선순위. 꼭짓점·모서리·교차 등이 하나도 안 잡힐 때만,
  // 즉 면 위 빈 곳을 가리킬 때만 커서를 그 면에 얹는다 (라이노 Surface 오스냅과 동일).
  if (!best && (!settings.osnapModes || settings.osnapModes.surface !== false)) {
    const sf = surfaceSnap3D(px, py, exclude);
    if (sf) best = sf;
  }
  return best || w;
}
// 3D 선: 클릭한 점의 실제 높이(스냅 z 또는 작업면 z)를 정점에 저장 — 서로 다른 높이의 꼭짓점 연결 가능
function line3DClick(e) {
  const r = v3.cv.getBoundingClientRect();
  const px = (e.clientX - r.left) * (r.width ? v3.cv.width / r.width : 1);
  const py = (e.clientY - r.top) * (r.height ? v3.cv.height / r.height : 1);
  const u = unproj3D(px, py, cplaneZ());
  if (!u) return;
  const sn = snap3D(px, py, null);
  const pt = sn ? { x: sn.x, y: sn.y, z: sn.z != null ? sn.z : cplaneZ() }
               : { x: Math.round(u[0]), y: Math.round(u[1]), z: cplaneZ() };
  if (!v3.line3d) { v3.line3d = { p1: pt }; render3D(); return; }
  const p1 = v3.line3d.p1;
  if (Math.hypot(pt.x - p1.x, pt.y - p1.y) < 1 && Math.abs(pt.z - p1.z) < 1) return;
  pushUndo();
  const ln = addEntity({ type: 'LINE', x1: p1.x, y1: p1.y, x2: pt.x, y2: pt.y });
  const zb = lvElev();
  if (Math.abs(p1.z - zb) > 0.5 || Math.abs(pt.z - zb) > 0.5) { ln.z1 = p1.z; ln.z2 = pt.z; delete ln.zo; }
  v3.line3d = { p1: pt }; // 끝점에서 이어 그리기
  v3.solids = bimSolids();
  logLine(`  ✔ 3D 선 (${p1.x},${p1.y},${p1.z}) → (${pt.x},${pt.y},${pt.z}) · 길이 ${Math.round(Math.hypot(pt.x - p1.x, pt.y - p1.y, pt.z - p1.z))}`, 'ok');
  render3D();
}
// 평면 도구를 3D에서 사용: 클릭을 현재 층 바닥면으로 언프로젝션해 기존 도구 파이프라인(handleClick)에 전달
function tool3DClick(e) {
  const r = v3.cv.getBoundingClientRect();
  const px = (e.clientX - r.left) * (r.width ? v3.cv.width / r.width : 1);
  const py = (e.clientY - r.top) * (r.height ? v3.cv.height / r.height : 1);
  const u = unproj3D(px, py, cplaneZ()); // 레이캐스팅: 뷰 광선 ∩ 작업면
  if (!u) return;
  const w = snap3D(px, py, { x: Math.round(u[0]), y: Math.round(u[1]) });
  // 스냅된 점이 다른 높이면 작업면을 그 높이로 이동 — 생성되는 도형이 스냅점 높이에 정확히 실림.
  // 단 '표면' 스냅은 예외: 곡면 위를 찍을 때마다 작업면이 따라 튀면 미리보기가 요동치고,
  // 곡선은 어차피 정점별 z(zs)로 저장되므로 작업면을 옮길 이유가 없다.
  if (w.z != null && w.kind !== 'surface' && Math.abs(w.z - cplaneZ()) > 0.5) {
    setCplane(w.z);
    logLine(`  ▷ 작업면을 스냅점 높이 ${Math.round(w.z)}(으)로 이동 — 이 높이에 작도됩니다`, 'info');
  }
  handleClick(w, { x: Math.round(u[0]), y: Math.round(u[1]) }, e); // rawW=스냅 전 실제 클릭점 (변 판정 정확도)
  v3.solids = bimSolids(); render3D();
}
// 3D 벽 그리기: 클릭 → 층 바닥면에 언프로젝션 → 2점째에 벽(LINE+bim) 생성, 연속 체인
function wall3DClick(e) {
  const r = v3.cv.getBoundingClientRect();
  const px = (e.clientX - r.left) * (r.width ? v3.cv.width / r.width : 1);
  const py = (e.clientY - r.top) * (r.height ? v3.cv.height / r.height : 1);
  const w = unproj3D(px, py, cplaneZ());
  if (!w) return;
  const sn = snap3D(px, py, null);
  // 표면 스냅은 작업면을 옮기지 않는다 — 지형 위에 벽을 그릴 때 클릭마다 작업면이 튀면 안 되고,
  // 높이는 아래에서 정점별(z1/z2)로 저장되므로 옮길 이유도 없다.
  if (sn && sn.z != null && sn.kind !== 'surface' && Math.abs(sn.z - cplaneZ()) > 0.5) {
    setCplane(sn.z);
    logLine(`  ▷ 작업면을 스냅점 높이 ${Math.round(sn.z)}(으)로 이동 — 벽이 이 높이에서 시작됩니다`, 'info');
  }
  // [x, y, z] — 배열이라 기존 [0]/[1] 접근은 그대로 동작
  const pt = sn ? [sn.x, sn.y, sn.z != null ? sn.z : cplaneZ()]
                : [Math.round(w[0] / 10) * 10, Math.round(w[1] / 10) * 10, cplaneZ()];
  if (!v3.wallP1) { v3.wallP1 = pt; v3.wallCur = pt; render3D(); return; }
  if (Math.hypot(pt[0] - v3.wallP1[0], pt[1] - v3.wallP1[1]) < 10) return; // 같은 점
  pushUndo();
  const p1 = v3.wallP1;
  const ln = addEntity({ type: 'LINE', x1: p1[0], y1: p1[1], x2: pt[0], y2: pt[1] });
  // 두 끝 높이가 다르면 정점별 높이로 저장 → 벽 바닥이 지형을 탄다 (bimSolids의 wallBaseZs가 읽음)
  const za = p1[2] != null ? p1[2] : cplaneZ(), zb2 = pt[2] != null ? pt[2] : cplaneZ();
  const sloped = Math.abs(za - zb2) > 0.5;
  if (sloped) { ln.z1 = za; ln.z2 = zb2; delete ln.zo; }
  ln.bim = { kind: 'wall', h: settings.bim.wallH, t: settings.bim.wallT, base: sloped ? lvElev() : cplaneZ() };
  v3.wallP1 = pt; // 연속 그리기: 끝점이 다음 시작점
  v3.solids = bimSolids();
  logLine(`  ✔ 벽 생성 (${ln.x1},${ln.y1}) → (${ln.x2},${ln.y2}) · 길이 ${Math.round(Math.hypot(ln.x2 - ln.x1, ln.y2 - ln.y1))} — 평면에도 동시 반영`, 'ok');
  render3D();
}
// 3D 박스 선택 — 좌→우: 완전 포함(윈도우), 우→좌: 걸침(크로싱, 투영 bbox 겹침)
function applyBox3D(d) {
  const x0 = Math.min(d.bx0, d.bx1), x1 = Math.max(d.bx0, d.bx1);
  const y0 = Math.min(d.by0, d.by1), y1 = Math.max(d.by0, d.by1);
  if (x1 - x0 < 2 && y1 - y0 < 2) { render3D(); return; }
  const crossing = d.bx1 < d.bx0;
  const inBox = (p) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
  // 선분-사각형 교차 (양끝 밖이어도 박스를 가로지르면 참)
  const segHitsBox = (a, b) => {
    if (inBox(a) || inBox(b)) return true;
    const edges = [[[x0, y0], [x1, y0]], [[x1, y0], [x1, y1]], [[x1, y1], [x0, y1]], [[x0, y1], [x0, y0]]];
    const cross2 = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    for (const [c1, c2] of edges) {
      const d1 = cross2(a, b, c1), d2 = cross2(a, b, c2), d3 = cross2(c1, c2, a), d4 = cross2(c1, c2, b);
      if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return true;
    }
    return false;
  };
  const pts = new Map(), segs = new Map();
  const addP = (m, eid, v) => { let a = m.get(eid); if (!a) { a = []; m.set(eid, a); } a.push(v); };
  for (const f of (v3.pick || v3.faces || [])) if (f.eid != null) {
    for (let i = 0; i < f.pts.length; i++) { addP(pts, f.eid, f.pts[i]); addP(segs, f.eid, [f.pts[i], f.pts[(i + 1) % f.pts.length]]); }
  }
  for (const u of (v3.under || [])) {
    for (let i = 0; i < u.path.length; i++) {
      addP(pts, u.eid, u.path[i]);
      if (i < u.path.length - 1 || u.closed) addP(segs, u.eid, [u.path[i], u.path[(i + 1) % u.path.length]]);
    }
  }
  state.selection.clear();
  for (const [eid, arr] of pts) {
    if (crossing) { // 걸침: 실제로 점이 박스 안에 있거나 선분이 박스를 지나야 선택 (bbox 겹침 오선택 수정)
      if (arr.some(inBox) || (segs.get(eid) || []).some(([a, b]) => segHitsBox(a, b))) state.selection.add(eid);
    } else if (arr.every(inBox)) state.selection.add(eid);
  }
  renderProps(); render3D();
  logLine(`  ▷ 3D 박스 선택: ${state.selection.size}개 (${crossing ? '걸침' : '포함'})`, 'info');
}
// 3D 클릭 선택: 가장 앞(depth 최소) 면의 원본 엔티티
function pick3D(e, additive) {
  if (!v3 || !v3.faces) return;
  const r = v3.cv.getBoundingClientRect();
  const px = (e.clientX - r.left) * (r.width ? v3.cv.width / r.width : 1);
  const py = (e.clientY - r.top) * (r.height ? v3.cv.height / r.height : 1);
  pick3DAt(px, py, additive);
}
// 클릭 지점의 '면'만 판별 (선택 변경 없음) — extrudesrf 면 재타겟용
function findFaceAt(px, py) {
  if (!v3) return null;
  const src = v3.pick || v3.faces;   // 피킹 전용 목록 (조명에 흔들리지 않는다)
  if (!src) return null;
  const inPoly = (pts) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  };
  const f = [...src].sort((a, b) => a.d - b.d).find(f => f.eid != null && inPoly(f.pts));
  return f ? { eid: f.eid, fk: f.fk || null, fi: f.fi != null ? f.fi : null, si: f.si != null ? f.si : null, sz0: f.sz0 != null ? f.sz0 : null } : null;
}
// 캔버스 픽셀 좌표로 선택 (테스트/내부용)
function pick3DAt(px, py, additive) {
  if (!v3) return;
  // 표시용(v3.faces)이 아니라 피킹 전용 목록을 쓴다 — 조명/태양이 켜지면 표시용 면은
  // pushLitPoly 가 잘게 쪼개서 같은 자리를 클릭해도 다른 면이 잡힌다(extrudesrf 가 깨진 원인).
  const src = v3.pick || v3.faces;
  if (!src) return;
  const inPoly = (pts) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  };
  // 앞(depth 작은) 면부터
  let hit = [...src].sort((a, b) => a.d - b.d).find(f => f.eid != null && inPoly(f.pts));
  // 평면 밑그림(비 BIM 라인워크) 픽킹: 투영 경로와의 거리 + 깊이 비교(면보다 앞이면 밑그림 우선)
  if (v3.under && v3.under.length) {
    const tol = 8 * (devicePixelRatio || 1);
    let best = null, bestD = tol, bestDepth = Infinity;
    for (const u of v3.under) {
      const n = u.path.length;
      for (let i = 0; i < (u.closed ? n : n - 1); i++) {
        const a = u.path[i], b = u.path[(i + 1) % n];
        const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
        const t = L2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / L2)) : 0;
        const d = Math.hypot(px - (a[0] + dx * t), py - (a[1] + dy * t));
        if (d < bestD) { bestD = d; best = u; bestDepth = a[2] + (b[2] - a[2]) * t; }
      }
    }
    if (best && (!hit || bestDepth < hit.d)) hit = { eid: best.eid };
  }
  v3.pickFace = hit ? { eid: hit.eid, fk: hit.fk || null, fi: hit.fi != null ? hit.fi : null, si: hit.si != null ? hit.si : null, sz0: hit.sz0 != null ? hit.sz0 : null } : null; // 마지막 클릭 면(top/bot/side + 변 fi + 벽 세그 si + 밴드 z0) — extrudesrf 면 밀당용
  if (!additive) state.selection.clear();
  if (hit) {
    if (additive && state.selection.has(hit.eid)) state.selection.delete(hit.eid);
    else state.selection.add(hit.eid);
  }
  renderProps(); render3D();
}

// ============================================================
//  BIM 3·4단계 — 단면(section)/입면(elevation) 자동 추출
//  절단선(수직 평면) ∩ 기둥체 = 사각형이라는 성질을 이용해
//  새 문서 탭에 2D 단면/입면 도면을 생성한다.
// ============================================================
// 무한선(p1, 방향 u) ∩ 다각형 → 선 위 파라미터 s의 내부 구간들
function lineClipPoly(p1, u, poly) {
  const cross = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const rx = b[0] - a[0], ry = b[1] - a[1];
    // p1 + s*u = a + t*(b-a) 연립
    const det2 = u.x * (-ry) + rx * u.y;
    if (Math.abs(det2) < 1e-12) continue;
    const s = ((a[0] - p1.x) * (-ry) + rx * (a[1] - p1.y)) / det2;
    const t2 = (u.x * (a[1] - p1.y) - u.y * (a[0] - p1.x)) / det2;
    if (t2 >= 0 && t2 < 1) cross.push(s);
  }
  cross.sort((x, y) => x - y);
  const iv = [];
  for (let i = 0; i + 1 < cross.length; i += 2) iv.push([cross[i], cross[i + 1]]);
  return iv;
}
let secCount = 0, elevCount = 0;
function clickSection(w, isElev) {
  const name = isElev ? 'elevation' : 'section';
  if (!cmdOp || cmdOp.name !== name) cmdOp = { name, step: 'p1' };
  if (cmdOp.step === 'p1') { cmdOp.p1 = w; cmdOp.step = 'p2'; setPrompt((isElev ? '입면' : '단면') + ': 선의 끝 점을 클릭하세요.'); return; }
  if (cmdOp.step === 'p2') {
    if (Math.hypot(w.x - cmdOp.p1.x, w.y - cmdOp.p1.y) < 1e-6) return;
    cmdOp.p2 = w; cmdOp.step = 'dir';
    setPrompt((isElev ? '입면' : '단면') + ': 바라볼 방향(선의 어느 쪽인지)을 클릭하세요.'); return;
  }
  // dir 단계
  const p1 = cmdOp.p1, p2 = cmdOp.p2;
  const L = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const u = { x: (p2.x - p1.x) / L, y: (p2.y - p1.y) / L };
  let nrm = { x: -u.y, y: u.x };
  const side = (w.x - p1.x) * nrm.x + (w.y - p1.y) * nrm.y;
  if (side < 0) nrm = { x: u.y, y: -u.x };
  const depth = bimAskNum('투영 깊이 (mm — 이 거리 안의 요소를 뒤 배경으로 표시):', 20000);
  if (depth == null) { cmdOp = { name, step: 'p1' }; return; }
  genSectionView(p1, u, nrm, L, depth, isElev);
  cmdOp = { name, step: 'p1' }; previewEnts = null;
  setPrompt((isElev ? '입면' : '단면') + ': 첫 점을 클릭하세요. (연속, Esc 종료)');
}
// 절단면 재료표시(KS 도면 해치) 자동 결정 — 레이어 secHatch 명시 > 레이어/개체 재질에서 유도 > 기본 사선.
// 단면을 자를 때마다 일일이 해치를 그리지 않아도 재료 기호가 저절로 나오게 한다 (2026-07-25 사용자).
const MAT_SECHATCH = { concrete: 'concrete', plaster: 'dots', wood: 'ansi31', brick: 'ansi31', stone: 'rubble',
  tile: 'grid', metal: 'steel', steel: 'steel', asphalt: 'dots', marble: 'grid', paint: 'dots', fabric: 'dots' };
function secHatchFor(eid) {
  const src = state.entities.find(x => x.id === eid);
  const ly = src && getLayer(src.layer);
  const sh = ly && ly.secHatch;
  if (sh === 'none') return null;
  if (sh) return sh;
  const mname = (src && src.mat) || (ly && ly.mat) || '';
  const base = mname && matIsLib(mname) ? ((matLibGet(matLibName(mname)) || {}).base || '') : mname;
  return MAT_SECHATCH[base] || 'ansi31';
}
function genSectionView(p1, u, nrm, lineLen, depth, isElev) {
  const solids = bimSolids();
  if (!solids.length) { logLine('  BIM 요소가 없습니다 — 먼저 wall/slab/column을 지정하세요.', 'warn'); return; }
  const label = isElev ? `입면-${++elevCount}` : `단면-${++secCount}`;
  const cuts = [], projs = [];
  let smin = 1e18, smax = -1e18, zmin = 0, zmax = -1e18;
  for (const s of solids) {
    const dvals = s.poly.map(v => (v[0] - p1.x) * nrm.x + (v[1] - p1.y) * nrm.y);
    const svals = s.poly.map(v => (v[0] - p1.x) * u.x + (v[1] - p1.y) * u.y);
    const dmin = Math.min(...dvals), dmax = Math.max(...dvals);
    const sZ1 = s.zt ? Math.max(...s.zt) : s.z1;
    zmin = Math.min(zmin, s.z0); zmax = Math.max(zmax, sZ1);
    if (!isElev && dmin < -1e-6 && dmax > 1e-6) {
      // 절단됨: 선과 풋프린트의 교차 구간 → 사각형
      // ★기울어진 매스(ptop)는 높이에 따라 단면 위치가 달라진다 — 바닥만 잘라 수직으로
      //   세우면 3D 와 어긋난다. 윗면 다각형도 같이 잘라 상·하단 구간을 각각 쓴다.
      //   (전단은 z 에 대해 선형이므로 두 구간을 이으면 정확한 단면이 된다)
      const topClip = s.ptop ? lineClipPoly(p1, u, s.ptop) : null;
      for (const [s0, s1] of lineClipPoly(p1, u, s.poly)) {
        const hp = s.glass ? null : secHatchFor(s.eid); // ★새 탭 전환 전에 결정 — 이후엔 state 가 새 문서다
        let tS0 = null, tS1 = null;
        if (topClip && topClip.length) {                 // 같은 절단선의 윗면 구간(가장 가까운 것)
          let best = topClip[0], bd = Infinity;
          for (const iv of topClip) {
            const d2 = Math.abs((iv[0] + iv[1]) / 2 - (s0 + s1) / 2);
            if (d2 < bd) { bd = d2; best = iv; }
          }
          tS0 = best[0]; tS1 = best[1];
        }
        if (s.zt) {
          // 경사 상단: 절단선 위 두 점의 상단 높이 → 사다리꼴
          const A = { x: p1.x + u.x * s0, y: p1.y + u.y * s0 }, B = { x: p1.x + u.x * s1, y: p1.y + u.y * s1 };
          cuts.push({ s0, s1, z0: s.z0, z1: null, zA: solidTopZ(s, A.x, A.y), zB: solidTopZ(s, B.x, B.y), glass: s.glass, hp, tS0, tS1 });
        } else cuts.push({ s0, s1, z0: s.z0, z1: s.z1, glass: s.glass, hp, tS0, tS1 });
        smin = Math.min(smin, Math.min(s0, tS0 == null ? s0 : tS0));
        smax = Math.max(smax, Math.max(s1, tS1 == null ? s1 : tS1));
      }
    } else if (dmin > 1e-6 && dmin <= depth) {
      // 앞쪽(바라보는 방향)에 있음 → 투영
      // 투영 폭도 바닥·윗면을 모두 감싸야 한다 (기울어진 매스는 윗면이 옆으로 나간다)
      const sAll = s.ptop
        ? svals.concat(s.ptop.map(v => (v[0] - p1.x) * u.x + (v[1] - p1.y) * u.y)) : svals;
      const ps0 = Math.min.apply(null, sAll), ps1 = Math.max.apply(null, sAll);
      if (s.zt) {
        // 경사 지붕 프로파일: 꼭짓점 (s, zt) 상부 외곽선
        // ★윗면이 밀린 매스는 상단 꼭짓점의 s 도 밀린 자리에서 재야 입면이 3D 와 맞는다
        const sTop = s.ptop ? s.ptop.map(v => (v[0] - p1.x) * u.x + (v[1] - p1.y) * u.y) : svals;
        const vps = s.poly.map((v, i) => [sTop[i], s.zt[i]]).sort((a, b) => a[0] - b[0]);
        const env = []; // s별 최대 z (상부 포락선)
        for (const [sv, zv] of vps) {
          const last = env[env.length - 1];
          if (last && Math.abs(last[0] - sv) < 1) { last[1] = Math.max(last[1], zv); }
          else env.push([sv, zv]);
        }
        projs.push({ profile: env, s0: ps0, s1: ps1, z0: s.z0, glass: s.glass, d: dmin });
      } else projs.push({ s0: ps0, s1: ps1, z0: s.z0, z1: s.z1, glass: s.glass, d: dmin });
      smin = Math.min(smin, ps0); smax = Math.max(smax, ps1);
    }
  }
  // 창호 입면 기호 수집 (2단계) — 바라보는 쪽(depth 안) 개구부의 유형 기호. ★새 탭 전환 전에 원본 state 에서.
  const owlibSrc = state.owlib || {};   // 커스텀 기호도 전환 전에 캡처 (전환 후 state 는 새 문서)
  const owSyms = [];
  for (const o of state.entities) {
    if (!o.bim || o.bim.kind !== 'opening' || o.type !== 'LINE') continue;
    const lyO = getLayer(o.layer); if (lyO && !lyO.visible) continue;
    const mx = (o.x1 + o.x2) / 2, my = (o.y1 + o.y2) / 2;
    const d = (mx - p1.x) * nrm.x + (my - p1.y) * nrm.y;
    if (!(d > 1e-6 && d <= depth)) continue;
    const sA = (o.x1 - p1.x) * u.x + (o.y1 - p1.y) * u.y;
    const sB = (o.x2 - p1.x) * u.x + (o.y2 - p1.y) * u.y;
    // 호스트 벽의 base (개구 중점에 근접한 벽) — 층이 있는 모델에서 기호 높이가 맞도록
    let baseZ = 0;
    for (const wE of state.entities) {
      if (!wE.bim || wE.bim.kind !== 'wall' || wE.type !== 'LINE') continue;
      const ddx = wE.x2 - wE.x1, ddy = wE.y2 - wE.y1, LL2 = Math.hypot(ddx, ddy) || 1;
      const tt = ((mx - wE.x1) * ddx + (my - wE.y1) * ddy) / (LL2 * LL2);
      if (tt < -0.05 || tt > 1.05) continue;
      if (Math.hypot(mx - (wE.x1 + ddx * tt), my - (wE.y1 + ddy * tt)) <= (wE.bim.t || 200)) { baseZ = wE.bim.base || 0; break; }
    }
    const sillO = o.bim.sill || 0, ohO = o.bim.h || 2100;
    owSyms.push({ s0: Math.min(sA, sB), s1: Math.max(sA, sB), z0: baseZ + sillO, z1: baseZ + sillO + ohO,
      wt: owWt(o), ot: o.bim.ot, flip: !!o.bim.flip, hinge: (o.bim.hinge ? sB : sA) <= (sA + sB) / 2 ? 0 : 1, d });
    smin = Math.min(smin, Math.min(sA, sB)); smax = Math.max(smax, Math.max(sA, sB));
  }
  if (!cuts.length && !projs.length) {
    logLine('  이 위치에서는 절단/투영되는 BIM 요소가 없습니다. 선 위치와 방향을 확인하세요.', 'warn'); return;
  }
  // ── 새 탭에 도면 생성 ──
  newDocTab();
  ensureLayer('투영', '#8a94a8');
  ensureLayer('절단', '#e8e2d6');
  ensureLayer('유리', '#7ec8ff');
  // 지반선 + 층 레벨선 (원본 도면의 층 정보)
  const srcLevels = (state.levels || []).slice();
  addEntity({ type: 'LINE', layer: '투영', linetype: 'center', x1: smin - 500, y1: 0, x2: smax + 500, y2: 0 });
  // 투영(먼 것부터 그려 순서 유지)
  projs.sort((a, b) => b.d - a.d);
  for (const p of projs) {
    if (p.profile) { // 경사 지붕: 바닥 + 상부 프로파일 폴리곤
      const pts = [[p.s0, p.z0], [p.s1, p.z0]];
      for (let i = p.profile.length - 1; i >= 0; i--) pts.push([p.profile[i][0], p.profile[i][1]]);
      addEntity({ type: 'LWPOLYLINE', layer: '투영', closed: true, points: pts });
    } else {
      addEntity({ type: 'LWPOLYLINE', layer: p.glass ? '유리' : '투영', closed: true,
        points: [[p.s0, p.z0], [p.s1, p.z0], [p.s1, p.z1], [p.s0, p.z1]] });
    }
  }
  // 창호 입면 기호 발행 — '창호' 레이어 (KS: 실선=밖여닫이, 점선=안여닫이)
  if (owSyms.length) {
    ensureLayer('창호', '#e0a33a');
    const ln = (x1, y1, x2, y2, lt) => addEntity({ type: 'LINE', layer: '창호', x1, y1, x2, y2, ...(lt ? { linetype: lt } : {}) });
    for (const ss of owSyms) {
      const W2 = ss.s1 - ss.s0, sm = (ss.s0 + ss.s1) / 2, zm = (ss.z0 + ss.z1) / 2;
      addEntity({ type: 'LWPOLYLINE', layer: '창호', closed: true, points: [[ss.s0, ss.z0], [ss.s1, ss.z0], [ss.s1, ss.z1], [ss.s0, ss.z1]] });
      // 커스텀 기호('@이름') — 저장한 입면 기호를 개구 사각(폭×높이)으로 변환해 발행
      if (ss.wt.charCodeAt(0) === 64) {
        const defC = owlibSrc[ss.wt.slice(1)];
        if (defC && defC.elev) {
          for (const c2 of owPlaced(defC.elev, [ss.s0, ss.z0], 1, 0, W2 / 1000, (ss.z1 - ss.z0) / (defC.elevH || 1000), !!ss.hinge, false))
            addEntity(Object.assign(c2, { layer: '창호' }));
        }
        continue; // elev 부위 없으면 외곽 사각만 (이미 발행됨)
      }
      const dashLt = ss.flip ? 'dashed' : undefined; // 안여닫이 = 점선
      const hE = ss.hinge ? ss.s1 : ss.s0, oE = ss.hinge ? ss.s0 : ss.s1; // 경첩 변 / 손잡이 변
      const harrow = (x1, x2, z) => { ln(x1, z, x2, z); const ah = Math.min(W2 * 0.08, 120), dr = x2 > x1 ? 1 : -1; ln(x2 - dr * ah, z + ah * 0.6, x2, z); ln(x2 - dr * ah, z - ah * 0.6, x2, z); };
      const varrow = (s, z1a, z2a) => { ln(s, z1a, s, z2a); const ah = Math.min((ss.z1 - ss.z0) * 0.08, 120), dr = z2a > z1a ? 1 : -1; ln(s - ah * 0.6, z2a - dr * ah, s, z2a); ln(s + ah * 0.6, z2a - dr * ah, s, z2a); };
      switch (ss.wt) {
        case 'swing': case 'dact': case 'wswing':
          ln(hE, ss.z0, oE, zm, dashLt); ln(hE, ss.z1, oE, zm, dashLt); break;
        case 'dswing':
          ln(ss.s0, ss.z0, sm, zm); ln(ss.s0, ss.z1, sm, zm); ln(ss.s1, ss.z0, sm, zm); ln(ss.s1, ss.z1, sm, zm); break;
        case 'slide': case 'wslide':
          ln(sm, ss.z0, sm, ss.z1); harrow(ss.s0 + W2 * 0.15, sm - W2 * 0.08, zm); break;
        case 'hung':
          ln(ss.s0, zm, ss.s1, zm); varrow(sm, zm - (zm - ss.z0) * 0.5, ss.z0 + (ss.z1 - ss.z0) * 0.85); break;
        case 'shutter':
          for (let z = ss.z0 + 300; z < ss.z1 - 100; z += 300) ln(ss.s0, z, ss.s1, z); break;
        case 'fold':
          ln(ss.s0 + W2 / 4, ss.z0, ss.s0 + W2 / 4, ss.z1); ln(sm, ss.z0, sm, ss.z1); ln(ss.s0 + W2 * 3 / 4, ss.z0, ss.s0 + W2 * 3 / 4, ss.z1); break;
        case 'pocket':
          harrow(ss.s0 + W2 * 0.2, ss.s1 - W2 * 0.2, zm); break;
        case 'rev':
          ln(ss.s0, ss.z0, ss.s1, ss.z1); ln(ss.s0, ss.z1, ss.s1, ss.z0); break;
        case 'mesh':
          ln(ss.s0, ss.z0, ss.s1, ss.z1, 'dashed'); ln(ss.s0, ss.z1, ss.s1, ss.z0, 'dashed'); break;
        // fix: 사각 외곽만
      }
    }
  }
  // 절단(외곽 + 해치)
  for (const c of cuts) {
    // 상단 구간(tS0/tS1)이 따로 있으면 기울어진 매스 — 윗변을 그 자리에 놓는다
    const uS0 = (c.tS0 == null) ? c.s0 : c.tS0, uS1 = (c.tS1 == null) ? c.s1 : c.tS1;
    const pts = c.z1 == null
      ? [[c.s0, c.z0], [c.s1, c.z0], [uS1, c.zB], [uS0, c.zA]]
      : [[c.s0, c.z0], [c.s1, c.z0], [uS1, c.z1], [uS0, c.z1]];
    addEntity({ type: 'LWPOLYLINE', layer: '절단', closed: true, points: pts, lineweight: 50 });
    if (!c.glass && c.hp) { // 재료표시: 레이어/재질에서 결정된 패턴 + 재료에 맞는 간격
      const w2 = c.s1 - c.s0;
      const sp2 = c.hp === 'insul' ? Math.max(40, Math.min(300, w2))          // 고리 지름 = 부재 두께
        : c.hp === 'concrete' ? 90 : c.hp === 'rubble' ? 130
        : (c.hp === 'ansi37' || c.hp === 'steel') ? 70 : c.hp === 'dots' ? 60
        : Math.max(60, w2 / 3);
      addEntity({ type: 'HATCH', layer: '절단', pattern: c.hp,
        spacing: sp2, boundary: { kind: 'poly', points: pts } });
    }
  }
  // 층 레벨선 + 레벨 라벨
  for (const lvv of srcLevels) {
    if (lvv.elev !== 0) addEntity({ type: 'LINE', layer: '투영', linetype: 'dashed', x1: smin - 500, y1: lvv.elev, x2: smax + 500, y2: lvv.elev });
    addEntity({ type: 'TEXT', layer: '투영', x: smax + 600, y: lvv.elev - 100, height: 250,
      text: `${lvv.name}  ${lvv.elev >= 0 ? '+' : ''}${lvv.elev}`, rotation: 0 });
  }
  // 라벨
  addEntity({ type: 'TEXT', layer: '투영', x: smin, y: zmax + 400, height: 300, text: label + (isElev ? '' : ' (절단 해치 = 잘린 부분)'), rotation: 0 });
  setFileName(label, null);
  renderDocTabs(); renderLayers(); updateStat(); zoomFit();
  logLine(`  ✔ ${label} 생성 — 절단 ${cuts.length}개 · 투영 ${projs.length}개 (새 탭, 치수·수정·DXF 저장 가능)`, 'ok');
  if (window.WEBCAD_API && WEBCAD_API.onUsage) WEBCAD_API.onUsage(isElev ? 'elevation' : 'section');
}

// ============================================================
//  층(Level) UI — 그리기 설정의 층 선택/추가, 고스트 토글
// ============================================================
function renderLevels() {
  const sel = document.getElementById('curLv');
  if (!sel) return;
  sel.innerHTML = state.levels.map((l, i) =>
    `<option value="${i}" ${i === state.curLv ? 'selected' : ''}>${escapeHtml(l.name)} (${l.elev})</option>`).join('');
  const g = document.getElementById('lvGhost');
  if (g) g.checked = !!state.ghostLv;
}
(function bindLevels() {
  const sel = document.getElementById('curLv');
  if (!sel) return;
  sel.addEventListener('change', () => {
    state.curLv = parseInt(sel.value, 10) || 0;
    state.selection.clear(); renderProps(); draw();
    logLine(`  ▷ 현재 층: ${state.levels[state.curLv].name} (레벨 ${state.levels[state.curLv].elev}) — 새 도형·BIM은 이 층에 생성됩니다`, 'info');
  });
  document.getElementById('lvAdd').addEventListener('click', () => {
    const last = state.levels[state.levels.length - 1];
    const name = prompt('새 층 이름:', `${state.levels.length + 1}F`);
    if (!name) return;
    const elev = parseFloat(prompt('레벨(바닥 높이, mm):', last.elev + 3000));
    if (!isFinite(elev)) return;
    state.levels.push({ name, elev });
    state.curLv = state.levels.length - 1;
    renderLevels(); state.selection.clear(); renderProps(); draw();
    logLine(`  ✔ 층 추가: ${name} (레벨 ${elev}) — 아래층이 흐리게 비칩니다(참조용)`, 'ok');
  });
  document.getElementById('lvGhost').addEventListener('change', (ev) => { state.ghostLv = ev.target.checked; draw(); });
})();
function cmdLevelInfo() {
  logLine('  층 목록: ' + state.levels.map((l, i) => `${i === state.curLv ? '▶' : ''}${l.name}(${l.elev})`).join(' · ') +
    ' — 그리기 설정 패널에서 전환/추가', 'info');
}

// ====== 도형 길이/면적 헬퍼 ======
function entityLength(e) {
  if (e.type === 'LINE') return Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
  if (e.type === 'LWPOLYLINE') return polyPerimeter(e.points, !!e.closed);
  if (e.type === 'CIRCLE') return 2 * Math.PI * e.r;
  if (e.type === 'ARC') { const sw = norm360(e.endAngle - e.startAngle) || 360; return e.r * sw * Math.PI / 180; }
  return 0;
}
function entityArea2(e) {
  if (e.type === 'CIRCLE') return Math.PI * e.r * e.r;
  if (e.type === 'LWPOLYLINE' && e.closed) return polyArea(e.points);
  if (e.type === 'HATCH') { const b = e.boundary; return b.kind === 'circle' ? Math.PI * b.r * b.r : polyArea(b.points); }
  return 0;
}

// ====== ROOF — 지붕 지정 (사각 풋프린트: 박공/외쪽/평) ======
// ============================================================
//  솔리드 불리언 (합집합·차집합·교집합) — BSP 기반 CSG (외부 의존 없음)
//  Evan Wallace csg.js(MIT) 알고리즘을 삼각형 메시용으로 압축 구현
// ============================================================
const CSG_EPS = 1e-5;
function csgPlane(a, b, c) {
  const ux = b[0]-a[0], uy = b[1]-a[1], uz = b[2]-a[2];
  const vx = c[0]-a[0], vy = c[1]-a[1], vz = c[2]-a[2];
  let nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
  const l = Math.hypot(nx,ny,nz) || 1; nx/=l; ny/=l; nz/=l;
  return { n:[nx,ny,nz], w:nx*a[0]+ny*a[1]+nz*a[2] };
}
function csgLerp(a, b, t) { return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t]; }
// 다각형: {v:[[x,y,z]...], plane}
function csgSplit(pl, poly, coF, coB, front, back) {
  const COP=0, FR=1, BK=2, SP=3;
  let polyType = 0; const types = [];
  for (const p of poly.v) {
    const t = pl.n[0]*p[0]+pl.n[1]*p[1]+pl.n[2]*p[2] - pl.w;
    const type = t < -CSG_EPS ? BK : t > CSG_EPS ? FR : COP;
    polyType |= type; types.push(type);
  }
  if (polyType === COP) { (pl.n[0]*poly.plane.n[0]+pl.n[1]*poly.plane.n[1]+pl.n[2]*poly.plane.n[2] > 0 ? coF : coB).push(poly); }
  else if (polyType === FR) front.push(poly);
  else if (polyType === BK) back.push(poly);
  else {
    const f=[], b=[], n=poly.v.length;
    for (let i=0;i<n;i++){
      const j=(i+1)%n, ti=types[i], tj=types[j], vi=poly.v[i], vj=poly.v[j];
      if (ti!==BK) f.push(vi);
      if (ti!==FR) b.push(vi);
      if ((ti|tj)===SP){
        const t=(pl.w - (pl.n[0]*vi[0]+pl.n[1]*vi[1]+pl.n[2]*vi[2])) / (pl.n[0]*(vj[0]-vi[0])+pl.n[1]*(vj[1]-vi[1])+pl.n[2]*(vj[2]-vi[2]));
        const m=csgLerp(vi,vj,t); f.push(m); b.push(m);
      }
    }
    if (f.length>=3) front.push({v:f, plane:poly.plane});
    if (b.length>=3) back.push({v:b, plane:poly.plane});
  }
}
function csgNode(polys) { const nd={plane:null, front:null, back:null, polys:[]}; if (polys) csgBuild(nd, polys); return nd; }
function csgBuild(nd, polys) {
  if (!polys.length) return;
  if (!nd.plane) nd.plane = polys[0].plane;
  const f=[], b=[];
  for (const p of polys) csgSplit(nd.plane, p, nd.polys, nd.polys, f, b);
  if (f.length){ if(!nd.front) nd.front=csgNode(); csgBuild(nd.front, f); }
  if (b.length){ if(!nd.back) nd.back=csgNode(); csgBuild(nd.back, b); }
}
function csgInvert(nd) {
  for (const p of nd.polys) { p.v.reverse(); p.plane={n:[-p.plane.n[0],-p.plane.n[1],-p.plane.n[2]], w:-p.plane.w}; }
  nd.plane={n:[-nd.plane.n[0],-nd.plane.n[1],-nd.plane.n[2]], w:-nd.plane.w};
  const t=nd.front; nd.front=nd.back; nd.back=t;
  if (nd.front) csgInvert(nd.front); if (nd.back) csgInvert(nd.back);
}
function csgClipPolys(nd, polys) {
  if (!nd.plane) return polys.slice();
  let f=[], b=[];
  for (const p of polys) csgSplit(nd.plane, p, f, b, f, b);
  if (nd.front) f=csgClipPolys(nd.front, f); else f=f;
  if (nd.back) b=csgClipPolys(nd.back, b); else b=[];
  return f.concat(b);
}
function csgClipTo(nd, other) { nd.polys=csgClipPolys(other, nd.polys); if (nd.front) csgClipTo(nd.front, other); if (nd.back) csgClipTo(nd.back, other); }
function csgAll(nd) { let r=nd.polys.slice(); if (nd.front) r=r.concat(csgAll(nd.front)); if (nd.back) r=r.concat(csgAll(nd.back)); return r; }
function csgOp(pa, pb, op) {
  const a=csgNode(pa.map(csgClonePoly)), b=csgNode(pb.map(csgClonePoly));
  if (op==='union') {
    csgClipTo(a,b); csgClipTo(b,a); csgInvert(b); csgClipTo(b,a); csgInvert(b);
    csgBuild(a, csgAll(b)); return csgAll(a);
  }
  if (op==='intersect') {
    csgInvert(a); csgClipTo(b,a); csgInvert(b); csgClipTo(a,b); csgClipTo(b,a);
    csgBuild(a, csgAll(b)); csgInvert(a); return csgAll(a);
  }
  // subtract (A - B)
  csgInvert(a); csgClipTo(a,b); csgClipTo(b,a); csgInvert(b); csgClipTo(b,a); csgInvert(b);
  csgBuild(a, csgAll(b)); csgInvert(a); return csgAll(a);
}
function csgClonePoly(p){ return {v:p.v.map(x=>x.slice()), plane:{n:p.plane.n.slice(), w:p.plane.w}}; }
function trisToPolys(tris){ const r=[]; for(const t of tris){ if(t.length<3) continue; r.push({v:t.map(p=>p.slice()), plane:csgPlane(t[0],t[1],t[2])}); } return r; }
function polysToTris(polys){ const r=[]; for(const p of polys){ for(let i=1;i+1<p.v.length;i++) r.push([p.v[0].slice(), p.v[i].slice(), p.v[i+1].slice()]); } return r; }
// 엔티티(솔리드/메시)를 삼각형 배열로
function entityToTris(e){
  if (e.type==='MESH') return e.tris.map(t=>t.map(p=>p.slice()));
  return solidsToTris(new Set([e.id]));
}
// ── 메시 표면 정리: 삼각분할 내부선을 감추고 '진짜 모서리'(면 경계·꺾인 부분)만 그림 ──
const _meshQ = v => Math.round(v * 100) / 100; // 0.01 양자화 (공유 꼭짓점 매칭)
function meshVKey(p){ return _meshQ(p[0]) + ',' + _meshQ(p[1]) + ',' + _meshQ(p[2]); }
function meshEdgeKey(a, b){ const ka = meshVKey(a), kb = meshVKey(b); return ka < kb ? ka + '|' + kb : kb + '|' + ka; }
// 특징 모서리 집합: 경계 모서리(면 1개) 또는 인접 두 면이 이루는 각이 큰(비평면) 모서리만 → 코너·윤곽만 남고 내부 삼각형선 제거
function meshFeat(e){
  if (e._feat && e._featRef === e.tris) return e._feat;
  const emap = new Map();
  for (const t of e.tris){
    if (t.length < 3) continue;
    const ux=t[1][0]-t[0][0], uy=t[1][1]-t[0][1], uz=t[1][2]-t[0][2];
    const vx=t[2][0]-t[0][0], vy=t[2][1]-t[0][1], vz=t[2][2]-t[0][2];
    let nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx; const nl=Math.hypot(nx,ny,nz)||1; nx/=nl;ny/=nl;nz/=nl;
    for (let i=0;i<3;i++){
      const k = meshEdgeKey(t[i], t[(i+1)%3]);
      const m = emap.get(k);
      if (!m) emap.set(k, { nx, ny, nz, c:1, feat:true });
      else { const d = Math.abs(m.nx*nx + m.ny*ny + m.nz*nz); m.c++; if (d >= 0.9) m.feat = false; } // 거의 같은 평면 → 내부선(숨김)
    }
  }
  const set = new Set();
  for (const [k, m] of emap) if (m.c === 1 || m.feat) set.add(k);
  e._feat = set; e._featRef = e.tris; return set;
}
// 메시 정점 법선(스무딩) — 한 정점을 공유하는 삼각형들의 법선 평균.
// 단, '특징 모서리'(코너)로 갈라진 면끼리는 섞지 않아야 각이 뭉개지지 않으므로,
// 면 법선이 그 평균과 크게 어긋나면(cos < 0.72 ≈ 44°) 그 면은 자기 법선을 그대로 쓴다.
// → 원통·구는 매끈하게, 상자 코너는 또렷하게. (2026-07-20 곡면 표시 개선)
function meshVNorm(e) {
  if (e._vn && e._vnRef === e.tris) return e._vn;
  const acc = new Map();
  const triN = [];
  for (const t of e.tris) {
    const ux = t[1][0]-t[0][0], uy = t[1][1]-t[0][1], uz = t[1][2]-t[0][2];
    const vx = t[2][0]-t[0][0], vy = t[2][1]-t[0][1], vz = t[2][2]-t[0][2];
    let nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
    const nl = Math.hypot(nx, ny, nz) || 1; nx/=nl; ny/=nl; nz/=nl;
    triN.push([nx, ny, nz]);
    for (const p of t) {
      const k = meshVKey(p);
      const a = acc.get(k);
      if (a) { a[0]+=nx; a[1]+=ny; a[2]+=nz; a[3]++; } else acc.set(k, [nx, ny, nz, 1]);
    }
  }
  for (const a of acc.values()) { const L = Math.hypot(a[0],a[1],a[2]) || 1; a[0]/=L; a[1]/=L; a[2]/=L; }
  const out = { acc, triN };
  e._vn = out; e._vnRef = e.tris; return out;
}
// 서로 떨어진(꼭짓점을 공유하지 않는) 삼각형 무리를 개별 컴포넌트로 분리
function meshComponents(tris){
  const parent = new Map();
  const find = x => { let r=x; while(parent.get(r)!==r) r=parent.get(r); while(parent.get(x)!==r){ const n=parent.get(x); parent.set(x,r); x=n; } return r; };
  for (const t of tris){ for (const p of t){ const k=meshVKey(p); if(!parent.has(k)) parent.set(k,k); } for (let i=1;i<t.length;i++) parent.set(find(meshVKey(t[0])), find(meshVKey(t[i]))); }
  const groups = new Map();
  for (const t of tris){ const r = find(meshVKey(t[0])); if(!groups.has(r)) groups.set(r, []); groups.get(r).push(t); }
  return [...groups.values()];
}
let boolPending = null; // 라이노식 차집합 2단계: {keepIds}
let extrudePend = null; // extrudecrv/extrudesrf 진행: {cmd, stage:'pickSel'|'height', heightPhase:'awaitBase'|'awaitTop', items, val, cap, ...}
let lastExtrudeCap = true; // 캡 유무 마지막 선택 유지 (별도로 바꾸기 전까지 다음 돌출에도 적용)
function isBoolable(e){ return e.type==='MESH' || (e.bim && ['wall','column','slab','stair','roof'].includes(e.bim.kind)); }
function boolRefresh(){ const ov = document.getElementById('bim3d'); if (ov && ov.style.display !== 'none') { v3.solids = bimSolids(); render3D(); } else { renderProps(); draw(); } }
// keepEnts를 union한 뒤 op(union/intersect/subtract)로 cutterEnts 적용 → 결과 메시
function runBoolean(op, keepEnts, cutterEnts){
  let acc = null;
  for (const e of keepEnts){ const p = trisToPolys(entityToTris(e)); if (p.length) acc = acc ? csgOp(acc, p, 'union') : p; }
  if (!acc || !acc.length){ logLine('  불리언: 베이스 입체에서 면을 얻지 못했습니다.', 'warn'); return; }
  for (const e of cutterEnts){ const p = trisToPolys(entityToTris(e)); if (p.length) acc = csgOp(acc, p, op); }
  const tris = polysToTris(acc);
  if (!tris.length){ logLine('  불리언 결과가 비었습니다 — 입체가 겹치는지 확인하세요.', 'warn'); return; }
  pushUndo();
  const ids = new Set(keepEnts.concat(cutterEnts).map(e=>e.id));
  state.entities = state.entities.filter(e=>!ids.has(e.id));
  // 베이스(남길) 입체의 속성 승계 — 레이어·색을 유지해 불리언 후에도 정체성 보존
  const baseEnt = keepEnts[0] || {};
  const inheritLayer = baseEnt.layer, inheritColor = baseEnt.color;
  // 서로 붙어있지 않은(꼭짓점 미공유) 덩어리는 개별 개체로 분리
  const comps = meshComponents(tris);
  const created = [];
  for (const ct of comps) {
    const m = addEntity({ type:'MESH', tris: ct, layer: inheritLayer, color: inheritColor });
    created.push(m);
  }
  const koOp = op==='union' ? '합집합' : op==='intersect' ? '교집합' : '차집합';
  if (created.length > 1) logLine('  ✔ ' + koOp + ' 완료 → 붙어있지 않아 ' + created.length + '개 개체로 분리 (총 ' + tris.length + '개 삼각형)', 'ok');
  else logLine('  ✔ ' + koOp + ' 완료 → 메시 ' + tris.length + '개 삼각형', 'ok');
  state.selection.clear(); created.forEach(m => state.selection.add(m.id)); boolRefresh();
}
function cmdBoolean(op){
  const sel = selectedEntities().filter(isBoolable);
  if (op==='subtract'){ // 라이노 BooleanDifference: 남길 입체 선택 → 명령 → 잘라낼 입체 선택 → Enter
    if (!sel.length){ logLine('  차집합: 먼저 남길(베이스) 입체를 선택한 뒤 실행하세요.', 'warn'); return; }
    boolPending = { keepIds: sel.map(e=>e.id) };
    state.selection.clear();
    logLine('  ▷ 차집합: 이제 잘라낼(빼낼) 입체를 선택한 뒤 Enter (Esc=취소)', 'info');
    boolRefresh(); return;
  }
  if (sel.length < 2){ logLine('  ' + (op==='union'?'합집합':'교집합') + ': 입체 2개 이상을 선택하세요.', 'warn'); return; }
  runBoolean(op, [sel[0]], sel.slice(1)); // union/intersect는 순서 무관 (누적)
}
function boolFinish(){ // Enter 시 차집합 2단계 마무리
  const cutters = selectedEntities().filter(isBoolable);
  const keep = boolPending.keepIds.map(id => state.entities.find(e=>e.id===id)).filter(Boolean);
  boolPending = null;
  if (!keep.length){ logLine('  차집합 취소 — 베이스 입체가 없습니다.', 'warn'); boolRefresh(); return; }
  if (!cutters.length){ logLine('  차집합 취소 — 잘라낼 입체가 선택되지 않았습니다.', 'warn'); boolRefresh(); return; }
  runBoolean('subtract', keep, cutters);
}
// 3D 내보내기 — 모든 입체(bimSolids)를 삼각형화해 STL/OBJ 파일로 (mm 단위)
function solidsToTris(onlyIds) {
  const tris = [];
  for (const s of bimSolids()) {
    if (onlyIds && !onlyIds.has(s.eid)) continue; // 선택 객체만
    const n = s.poly.length;
    // 폴리곤 winding을 CCW로 정규화 → 옆면·상하면 법선이 항상 바깥을 향함.
    // (불리언 CSG는 안/밖 판정을 법선으로 하므로 입력이 CW면 차집합·교집합·합집합이 뒤바뀜.
    //  벽 밴드는 CW, 상자는 CCW, 사용자 폴리라인은 제각각이라 반드시 정규화해야 함.)
    let poly = s.poly, zt = s.zt || s.poly.map(() => s.z1);
    let area2 = 0;
    for (let i = 0; i < n; i++) { const a = poly[i], b = poly[(i + 1) % n]; area2 += a[0] * b[1] - b[0] * a[1]; }
    if (area2 < 0) { poly = poly.slice().reverse(); zt = zt.slice().reverse(); }
    const top = poly.map((p, i) => [p[0], p[1], zt[i]]);
    const bot = poly.map(p => [p[0], p[1], s.z0]);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      tris.push([bot[i], bot[j], top[j]], [bot[i], top[j], top[i]]); // 측면
    }
    for (let i = 1; i < n - 1; i++) { // 상·하면 (팬 분할)
      tris.push([top[0], top[i], top[i + 1]]);
      tris.push([bot[0], bot[i + 1], bot[i]]);
    }
  }
  return tris;
}
// STL/OBJ 저장 — saveBlob에 위임.
// (이전엔 <a>를 document에 붙이지 않고 click() 해서 다운로드가 걸리지 않았음 = STL/OBJ 저장 불가 버그.
//  saveBlob은 DOM 부착 후 클릭 + 모바일 공유 + 저장 로그까지 처리하므로 PDF·SVG와 동일 경로로 통일)
function dl3d(text, name, mime) {
  return saveBlob(new Blob([text], { type: mime || 'text/plain' }), name);
}
function cmdExportSTL(onlyIds, nameSuffix) {
  const tris = solidsToTris(onlyIds);
  if (!tris.length) { logLine('  내보낼 3D 입체가 없습니다 — 벽·기둥·extrudecrv 등으로 입체를 만든 뒤 실행하세요.', 'warn'); return; }
  const L = ['solid parti'];
  for (const t of tris) {
    L.push(' facet normal 0 0 0', '  outer loop');
    for (const v of t) L.push('   vertex ' + v[0].toFixed(3) + ' ' + v[1].toFixed(3) + ' ' + v[2].toFixed(3));
    L.push('  endloop', ' endfacet');
  }
  L.push('endsolid parti', '');
  dl3d(L.join(String.fromCharCode(10)), (nameSuffix || 'parti-3d') + '.stl', 'model/stl');
  logLine('  ✔ STL 내보내기 — 삼각형 ' + tris.length + '개, mm 단위 (라이노·스케치업에서 가져오기 가능)', 'ok');
}
function cmdExportOBJ(onlyIds, nameSuffix) {
  const tris = solidsToTris(onlyIds);
  if (!tris.length) { logLine('  내보낼 3D 입체가 없습니다 — 벽·기둥·extrudecrv 등으로 입체를 만든 뒤 실행하세요.', 'warn'); return; }
  const V = ['# Parti OBJ (mm)'], F = [];
  let idx = 1;
  for (const t of tris) {
    for (const p of t) V.push('v ' + p[0].toFixed(3) + ' ' + p[1].toFixed(3) + ' ' + p[2].toFixed(3));
    F.push('f ' + idx + ' ' + (idx + 1) + ' ' + (idx + 2)); idx += 3;
  }
  dl3d(V.concat(F).join(String.fromCharCode(10)), (nameSuffix || 'parti-3d') + '.obj', 'text/plain');
  logLine('  ✔ OBJ 내보내기 — 삼각형 ' + tris.length + '개, mm 단위', 'ok');
}
// 3D 작업 명령 세트(라이노식) — box/cylinder/settop  (이동·복사·회전·대칭·배열·배율은 평면·3D 공용 기본 명령이 담당)
function ask3(msg, def) {
  const s = prompt(msg, def); if (s == null) return null;
  const p = String(s).split(',').map(Number);
  return (p.length >= 2 && p.slice(0, 2).every(isFinite)) ? p : null;
}
function zShift3(e, dz) { if (dz) gumMove(e, { vz: 1 }, Math.round(dz)); }
function crvClosedQ(e) { return e.type === 'CIRCLE' || (e.type === 'LWPOLYLINE' && !!e.closed); }
function crvPtAt(e, t) { // t 0..1 (둘레 기준) → [x,y]
  if (e.type === 'LINE') return [e.x1 + (e.x2 - e.x1) * t, e.y1 + (e.y2 - e.y1) * t];
  if (e.type === 'CIRCLE') { const a = t * 2 * Math.PI; return [e.cx + e.r * Math.cos(a), e.cy + e.r * Math.sin(a)]; }
  if (e.type === 'ARC') { let s = e.startAngle, en = e.endAngle; if (en < s) en += 360; const a = (s + (en - s) * t) * Math.PI / 180; return [e.cx + e.r * Math.cos(a), e.cy + e.r * Math.sin(a)]; }
  if (e.type === 'LWPOLYLINE') {
    const p = e.points, n = p.length, segN = e.closed ? n : n - 1;
    if (!n) return null;
    const hz = polyHasZ(e); // 표면 위 곡선이면 정점별 높이도 같이 보간해서 [x,y,z]로 반환
    const lens = []; let total = 0;
    for (let i = 0; i < segN; i++) { const L = Math.hypot(p[(i + 1) % n][0] - p[i][0], p[(i + 1) % n][1] - p[i][1]); lens.push(L); total += L; }
    if (!total) return hz ? [p[0][0], p[0][1], e.zs[0]] : [p[0][0], p[0][1]];
    let d = Math.max(0, Math.min(total, t * total));
    for (let i = 0; i < segN; i++) {
      if (d <= lens[i] || i === segN - 1) {
        const j = (i + 1) % n, u = lens[i] ? Math.max(0, Math.min(1, d / lens[i])) : 0;
        const x = p[i][0] + (p[j][0] - p[i][0]) * u, y = p[i][1] + (p[j][1] - p[i][1]) * u;
        return hz ? [x, y, e.zs[i] + (e.zs[j] - e.zs[i]) * u] : [x, y];
      }
      d -= lens[i];
    }
  }
  return null;
}
function crvSampleN(e, n) { // 닫힘=n개 / 열림=n+1개(끝점 포함), z 반영(3D 선은 정점 z 보간)
  const closed = crvClosedQ(e), cnt = closed ? n : n + 1, out = [];
  for (let i = 0; i < cnt; i++) {
    const t = i / n, p = crvPtAt(e, t); if (!p) continue;
    const z = p[2] != null ? p[2] // 표면 위 곡선(zs): 정점별 높이가 보간되어 이미 들어 있음
      : (e.type === 'LINE' && (e.z1 != null || e.z2 != null))
        ? (e.z1 || 0) + ((e.z2 || 0) - (e.z1 || 0)) * t : (e.zo || 0);
    out.push([p[0], p[1], z]);
  }
  return out;
}
const LOFTABLE = ['LINE', 'LWPOLYLINE', 'CIRCLE', 'ARC'];

// ---------- 자유곡선(spline): 제어점을 부드럽게 통과하는 곡선 (Catmull-Rom → 폴리라인) ----------
// 성분 수는 입력에서 결정 — [x,y]면 평면, [x,y,z]면 표면 위 곡선(z도 같이 보간).
// 2D 입력은 예전과 완전히 동일한 결과를 낸다.
function catmullRom2D(P, closed, seg) {
  const n = P.length; if (n < 3) return P.map(p => p.slice());
  const dim = P[0].length;
  const out = [], at = i => P[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))];
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let s = 0; s < seg; s++) {
      const t = s / seg, t2 = t * t, t3 = t2 * t;
      const q = [];
      for (let d = 0; d < dim; d++)
        q.push(0.5 * (2 * p1[d] + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3));
      out.push(q);
    }
  }
  if (closed) out.push(out[0].slice()); else out.push(P[n - 1].slice());
  return out;
}
// ---------- 폴리라인 정점별 높이(zs) ----------
// 표면 위에 그린 곡선은 정점마다 z가 다르다. points는 [x,y] 그대로 두고 z만 별도 배열로 —
// 기존 2D 코드(points.map 등)를 건드리지 않기 위함.
// 길이가 어긋나면(오프셋·분해 등으로 정점 수가 바뀐 경우) 조용히 평면 z로 되돌아간다.
function polyZ(e, i, zBase) {
  return (e.zs && e.points && e.zs.length === e.points.length && e.zs[i] != null) ? e.zs[i] : zBase;
}
function polyHasZ(e) { return !!(e.zs && e.points && e.zs.length === e.points.length); }
function finishSpline(closed) {
  if (pts.length >= 2) {
    pushUndo();
    const base = lvElev() + (typeof cplaneZ === 'function' ? (cplaneZ() - lvElev()) : 0);
    // 제어점 높이가 서로 다르면(=표면 위에 찍은 경우) z까지 같이 보간해 곡선이 면을 타고 흐르게 한다
    const zOf = p => (p.z != null ? p.z : base);
    const has3 = pts.some(p => Math.abs(zOf(p) - zOf(pts[0])) > 0.5);
    const P = has3 ? pts.map(p => [p.x, p.y, zOf(p)]) : pts.map(p => [p.x, p.y]);
    const smooth = P.length >= 3 ? catmullRom2D(P, !!closed, 12) : P;
    const e = addEntity({ type: 'LWPOLYLINE', closed: !!closed, points: smooth.map(p => [p[0], p[1]]) });
    if (has3 && e) {
      e.zs = smooth.map(p => Math.round(p[2]));
      delete e.zo;
    }
    logLine(`  ✔ 자유곡선 (제어점 ${P.length}개 → 정점 ${smooth.length}개${closed ? ' · 닫힘' : ''}${has3 ? ` · 표면 위 z ${Math.min(...e.zs)}~${Math.max(...e.zs)}` : ''})`, 'ok');
    updateStat();
  }
  pts = []; draw();
}

// ---------- 로프트: 선택한 곡선들을 순서대로 이어 면/입체 생성 ----------
function cmdLoft() {
  const sel = selectedEntities().filter(e => LOFTABLE.includes(e.type));
  if (sel.length < 2) { logLine('  로프트: 이을 곡선을 2개 이상 선택하세요 (선·폴리라인·원·호). 서로 다른 높이(z 오프셋)에 두면 입체가 됩니다.', 'warn'); return; }
  const sv = bimAskNum('단면 분할 수 (클수록 매끄러움):', 24); if (sv == null) return;
  const n = Math.max(3, Math.min(200, Math.round(sv)));
  pushUndo();
  let made = 0;
  for (let s = 0; s + 1 < sel.length; s++) {
    const A = crvSampleN(sel[s], n), B = crvSampleN(sel[s + 1], n);
    const N = Math.min(A.length, B.length); if (N < 2) continue;
    const closed = crvClosedQ(sel[s]) && crvClosedQ(sel[s + 1]);
    const M = closed ? N : N - 1, tris = [];
    for (let k = 0; k < M; k++) { const k2 = (k + 1) % N; tris.push([A[k], B[k], B[k2]]); tris.push([A[k], B[k2], A[k2]]); }
    if (tris.length) { addEntity({ type: 'MESH', tris }); made++; }
  }
  if (!made) { logLine('  로프트: 생성할 면이 없습니다.', 'warn'); undo(); return; }
  logLine(`  ✔ 로프트 ${made}개 생성 (곡선 ${sel.length}개 연결 · 분할 ${n})`, 'ok');
  updateStat(); renderProps(); boolRefresh();
}

// ---------- 회전체: 프로필(x=축까지 거리, y=높이)을 수직축 둘레로 회전 ----------
function cmdRevolve() {
  const sel = selectedEntities().filter(e => LOFTABLE.includes(e.type));
  if (!sel.length) { logLine('  회전체: 프로필 곡선을 선택하세요 — 평면 좌표를 x=회전축까지 거리(반지름), y=높이로 해석합니다.', 'warn'); return; }
  const c = ask3('회전축 중심 x,y:', '0,0'); if (!c) return;
  const sv = bimAskNum('원주 분할 수:', 24); if (sv == null) return;
  const av = bimAskNum('스윕 각도(도, 360=한 바퀴):', 360); if (av == null) return;
  const seg = Math.max(4, Math.min(96, Math.round(sv))), sw = av * Math.PI / 180;
  pushUndo();
  let made = 0;
  for (const e of sel) {
    const c0 = crvSampleN(e, 32);
    const prof = crvClosedQ(e) ? c0.concat([c0[0]]) : c0;
    if (prof.length < 2) continue;
    const ring = (p, a) => [c[0] + p[0] * Math.cos(a), c[1] + p[0] * Math.sin(a), p[1]];
    const tris = [];
    for (let i = 0; i + 1 < prof.length; i++) for (let j = 0; j < seg; j++) {
      const a0 = sw * j / seg, a1 = sw * (j + 1) / seg;
      const A = ring(prof[i], a0), B = ring(prof[i], a1), C = ring(prof[i + 1], a1), D = ring(prof[i + 1], a0);
      tris.push([A, B, C]); tris.push([A, C, D]);
    }
    if (tris.length) { addEntity({ type: 'MESH', tris }); made++; }
  }
  if (!made) { logLine('  회전체: 생성 실패 — 프로필 점이 부족합니다.', 'warn'); undo(); return; }
  logLine(`  ✔ 회전체 ${made}개 생성 (축 ${c[0]},${c[1]} · 분할 ${seg} · ${av}°)`, 'ok');
  updateStat(); renderProps(); boolRefresh();
}

// ---------- 절단(slice): 입체를 수평면으로 잘라 위/아래 두 조각으로 ----------
function sliceBoxTris(x0, y0, z0, x1, y1, z1) { // 축정렬 박스 → 삼각형 12개
  const V = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const F = [[0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return F.map(f => f.map(i => V[i].slice()));
}
function cmdSlice() {
  const sel = selectedEntities().filter(isBoolable);
  if (!sel.length) { logLine('  절단: 자를 입체(솔리드·메시)를 선택하세요.', 'warn'); return; }
  const zv = bimAskNum('절단 높이 Z (수평 절단면):', 1000); if (zv == null) return;
  pushUndo();
  let cut = 0;
  for (const e of sel) {
    const tris = entityToTris(e); if (!tris.length) continue;
    let mnx = 1e18, mny = 1e18, mnz = 1e18, mxx = -1e18, mxy = -1e18, mxz = -1e18;
    for (const t of tris) for (const p of t) {
      mnx = Math.min(mnx, p[0]); mny = Math.min(mny, p[1]); mnz = Math.min(mnz, p[2]);
      mxx = Math.max(mxx, p[0]); mxy = Math.max(mxy, p[1]); mxz = Math.max(mxz, p[2]);
    }
    if (zv <= mnz + 1e-6 || zv >= mxz - 1e-6) { logLine(`  절단: z=${zv}가 입체 높이 범위(${Math.round(mnz)}~${Math.round(mxz)}) 밖 — 건너뜀`, 'warn'); continue; }
    const pad = 1000;
    const lower = polysToTris(csgOp(trisToPolys(tris), trisToPolys(sliceBoxTris(mnx - pad, mny - pad, mnz - pad, mxx + pad, mxy + pad, zv)), 'intersect'));
    const upper = polysToTris(csgOp(trisToPolys(tris), trisToPolys(sliceBoxTris(mnx - pad, mny - pad, zv, mxx + pad, mxy + pad, mxz + pad)), 'intersect'));
    if (!lower.length || !upper.length) { logLine('  절단: 결과 조각이 비어 건너뜀', 'warn'); continue; }
    const lay = e.layer, col = e.color;
    state.entities = state.entities.filter(x => x.id !== e.id);
    state.selection.delete(e.id);
    addEntity({ type: 'MESH', layer: lay, color: col, tris: lower });
    addEntity({ type: 'MESH', layer: lay, color: col, tris: upper });
    cut++;
  }
  if (!cut) { undo(); return; }
  logLine(`  ✔ 절단 ${cut}개 → 위/아래 조각으로 분리 (z=${zv})`, 'ok');
  updateStat(); renderProps(); boolRefresh();
}

// ---------- 조건 선택(qselect): 종류·레이어·색으로 한 번에 ----------
function cmdQSelect() {
  const q = prompt('조건 선택 — 종류(line, pline, circle, arc, text, mesh, hatch, insert) / 레이어명 / 색:#rrggbb\n예)  circle   ·   벽체선   ·   색:#ff0000', 'line');
  if (q == null) return;
  const s = q.trim().toLowerCase(); if (!s) return;
  const TYPE = { line: 'LINE', pline: 'LWPOLYLINE', polyline: 'LWPOLYLINE', circle: 'CIRCLE', arc: 'ARC', text: 'TEXT', mesh: 'MESH', hatch: 'HATCH', insert: 'INSERT' };
  let match;
  if (s.startsWith('색:') || s.startsWith('color:')) { const c = s.split(':').slice(1).join(':').trim(); match = e => (e.color || '').toLowerCase() === c; }
  else if (TYPE[s]) match = e => e.type === TYPE[s];
  else match = e => (e.layer || '').toLowerCase() === s;
  state.selection.clear();
  let n = 0;
  for (const e of state.entities) {
    const l = getLayer(e.layer); if (l && (!l.visible || l.locked)) continue;
    if (!onLv(e)) continue;
    if (match(e)) { state.selection.add(e.id); n++; }
  }
  logLine(n ? `  ✔ 조건 선택: ${n}개 ("${q.trim()}")` : `  조건 선택: 일치하는 도형이 없습니다 ("${q.trim()}")`, n ? 'ok' : 'warn');
  renderProps(); draw(); boolRefresh();
}

// ---------- 부피·무게중심(volume): 선택 입체의 질량 특성 ----------
function cmdVolume() {
  const sel = selectedEntities().filter(isBoolable);
  if (!sel.length) { logLine('  부피: 입체(솔리드·메시)를 선택하세요.', 'warn'); return; }
  let V = 0, cx = 0, cy = 0, cz = 0;
  for (const e of sel) for (const t of entityToTris(e)) {
    const a = t[0], b = t[1], c = t[2];
    const v = (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6; // 부호 있는 사면체
    V += v; cx += v * (a[0] + b[0] + c[0]) / 4; cy += v * (a[1] + b[1] + c[1]) / 4; cz += v * (a[2] + b[2] + c[2]) / 4;
  }
  const av = Math.abs(V);
  if (av < 1e-6) { logLine('  부피: 닫힌 입체가 아니거나 부피가 0입니다 (면만 있는 메시는 부피 없음).', 'warn'); return; }
  logLine(`  ✔ 부피 ${(av / 1e9).toFixed(4)} m³ (${Math.round(av).toLocaleString()} mm³) · 무게중심 (${(cx / V).toFixed(1)}, ${(cy / V).toFixed(1)}, ${(cz / V).toFixed(1)}) · 입체 ${sel.length}개`, 'ok');
}

// ---------- 쓸기(sweep): 단면을 경로 따라 훑어 입체 생성 ----------
function crvLen(e) {
  if (e.type === 'LINE') return Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
  if (e.type === 'CIRCLE') return 2 * Math.PI * e.r;
  if (e.type === 'ARC') { let s = e.startAngle, en = e.endAngle; if (en < s) en += 360; return (en - s) * Math.PI / 180 * e.r; }
  if (e.type === 'LWPOLYLINE') { const p = e.points, n = p.length, segN = e.closed ? n : n - 1; let L = 0; for (let i = 0; i < segN; i++) L += Math.hypot(p[(i + 1) % n][0] - p[i][0], p[(i + 1) % n][1] - p[i][1]); return L; }
  return 0;
}
function cmdSweep() {
  const sel = selectedEntities().filter(e => LOFTABLE.includes(e.type));
  if (sel.length !== 2) { logLine('  쓸기: 단면 곡선 1개 + 경로 곡선 1개(총 2개)를 선택하세요 — 짧은 쪽을 단면으로 사용합니다.', 'warn'); return; }
  const pair = crvLen(sel[0]) <= crvLen(sel[1]) ? [sel[0], sel[1]] : [sel[1], sel[0]];
  const prof = pair[0], path = pair[1];
  const sv = bimAskNum('경로 분할 수 (클수록 매끄러움):', 32); if (sv == null) return;
  const n = Math.max(2, Math.min(400, Math.round(sv)));
  const P = crvSampleN(path, n), C = crvSampleN(prof, 24); // 단면: x=경로 좌우 오프셋, y=높이 (회전체와 같은 규약)
  if (P.length < 2 || C.length < 2) { logLine('  쓸기: 샘플 점이 부족합니다.', 'warn'); return; }
  const profClosed = crvClosedQ(prof), M = C.length;
  // 경로의 '3D' 접선에 수직인 단면 프레임 (라이노 Sweep1의 Roadlike Top에 해당)
  //   side = 진행방향과 수직인 수평 벡터, up = 진행방향·side 양쪽에 수직 (경사면에서 세워짐)
  // 평평한 경로면 side=(-ty,tx,0), up=(0,0,1)이 되어 예전 결과와 완전히 동일하다.
  // 표면 위 곡선처럼 오르내리는 경로에서는 단면이 진행방향에 제대로 직교해 찌그러지지 않는다.
  const ring = (i) => {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
    const TL = Math.hypot(tx, ty, tz) || 1; tx /= TL; ty /= TL; tz /= TL;
    let sx = -ty, sy = tx, sz = 0; // T × worldUp — 진행방향과 수직인 수평 벡터
    const SL = Math.hypot(sx, sy);
    if (SL < 1e-6) { sx = 1; sy = 0; sz = 0; } // 수직 경로: 수평 성분이 없어 퇴화 → X축을 기준으로
    else { sx /= SL; sy /= SL; }
    // up = T × side (순서 중요 — side × T로 하면 평평한 경로에서 (0,0,-1)이 나와 단면이 뒤집힌다)
    let ux = ty * sz - tz * sy, uy = tz * sx - tx * sz, uz = tx * sy - ty * sx;
    const UL = Math.hypot(ux, uy, uz) || 1; ux /= UL; uy /= UL; uz /= UL;
    return C.map(c => [
      P[i][0] + sx * c[0] + ux * c[1],
      P[i][1] + sy * c[0] + uy * c[1],
      P[i][2] + sz * c[0] + uz * c[1],
    ]);
  };
  pushUndo();
  const tris = [];
  for (let i = 0; i + 1 < P.length; i++) {
    const R0 = ring(i), R1 = ring(i + 1), segs = profClosed ? M : M - 1;
    for (let k = 0; k < segs; k++) { const k2 = (k + 1) % M; tris.push([R0[k], R1[k], R1[k2]]); tris.push([R0[k], R1[k2], R0[k2]]); }
  }
  if (!tris.length) { logLine('  쓸기: 생성 실패.', 'warn'); undo(); return; }
  addEntity({ type: 'MESH', tris });
  logLine(`  ✔ 쓸기 생성 (단면=${prof.type} · 경로=${path.type} · 분할 ${n} · ${tris.length}면)`, 'ok');
  updateStat(); renderProps(); boolRefresh();
}

// ---------- 속 비우기(shell): 닫힌 폴리라인 입체를 두께만 남기고 비움 ----------
function polyArea2(p) { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; }
function polyOffsetIn(pts, d) { // 닫힌 폴리곤 안쪽 마이터 오프셋 (d>0 = 안쪽)
  const n = pts.length; if (n < 3) return null;
  const sgn = polyArea2(pts) > 0 ? 1 : -1; // CCW면 좌법선이 안쪽
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    const e1x = p1[0] - p0[0], e1y = p1[1] - p0[1], l1 = Math.hypot(e1x, e1y) || 1;
    const e2x = p2[0] - p1[0], e2y = p2[1] - p1[1], l2 = Math.hypot(e2x, e2y) || 1;
    const n1x = sgn * (-e1y / l1), n1y = sgn * (e1x / l1);
    const n2x = sgn * (-e2y / l2), n2y = sgn * (e2x / l2);
    const A1 = [p0[0] + n1x * d, p0[1] + n1y * d], B1 = [p1[0] + n1x * d, p1[1] + n1y * d];
    const A2 = [p1[0] + n2x * d, p1[1] + n2y * d], B2 = [p2[0] + n2x * d, p2[1] + n2y * d];
    const ip = lineInfIntersect(A1, B1, A2, B2);
    out.push(ip || B1);
  }
  return out;
}
function prismTris(pts, z0, z1) { // 닫힌 폴리곤 → 옆면+상하면 (CCW 정규화 + 팬: solidsToTris와 동일 규약)
  let p = pts.slice();
  if (polyArea2(p) < 0) p = p.reverse();
  const n = p.length, tris = [];
  const bot = p.map(q => [q[0], q[1], z0]), top = p.map(q => [q[0], q[1], z1]);
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; tris.push([bot[i], bot[j], top[j]], [bot[i], top[j], top[i]]); }
  for (let i = 1; i < n - 1; i++) { tris.push([top[0], top[i], top[i + 1]]); tris.push([bot[0], bot[i + 1], bot[i]]); }
  return tris;
}
function cmdShell() {
  const sel = selectedEntities().filter(e => e.type === 'LWPOLYLINE' && e.closed && e.bim && ['column', 'slab'].includes(e.bim.kind));
  if (!sel.length) { logLine('  속 비우기: 닫힌 폴리라인으로 만든 입체(기둥·상자·슬래브)를 선택하세요.', 'warn'); return; }
  const tv = bimAskNum('벽 두께 (mm):', 200); if (tv == null) return;
  const t = Math.abs(tv); if (t < 1) return;
  const openTop = window.confirm('윗면을 열까요?\n확인 = 위가 열린 통 · 취소 = 완전히 닫힌 중공');
  pushUndo();
  let made = 0;
  for (const e of sel) {
    const outer = entityToTris(e); if (!outer.length) continue;
    const inPts = polyOffsetIn(e.points, t);
    if (!inPts) continue;
    if (Math.sign(polyArea2(inPts)) !== Math.sign(polyArea2(e.points)) || Math.abs(polyArea2(inPts)) < 1) {
      logLine(`  속 비우기: 두께 ${t}가 너무 커서 안쪽이 없어짐 — 건너뜀`, 'warn'); continue;
    }
    const base = e.bim.base || 0, h = e.bim.h || 0;
    const inner = prismTris(inPts, base + t, openTop ? base + h + 10 : base + h - t); // 바닥은 t만큼 남김
    const res = polysToTris(csgOp(trisToPolys(outer), trisToPolys(inner), 'subtract'));
    if (!res.length) { logLine('  속 비우기: 결과가 비어 건너뜀', 'warn'); continue; }
    const lay = e.layer, col = e.color;
    state.entities = state.entities.filter(x => x.id !== e.id);
    state.selection.delete(e.id);
    addEntity({ type: 'MESH', layer: lay, color: col, tris: res });
    made++;
  }
  if (!made) { undo(); return; }
  logLine(`  ✔ 속 비우기 ${made}개 (두께 ${t}${openTop ? ' · 윗면 열림' : ' · 밀폐'})`, 'ok');
  updateStat(); renderProps(); boolRefresh();
}

// ---------- 3D 모깎기(fillet3d): 입체의 수직 모서리를 둥글게 (바닥 폴리곤 코너 라운딩) ----------
function polyRoundCorners(pts, r, seg) {
  const n = pts.length; if (n < 3) return pts.map(p => p.slice());
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    const v1x = p0[0] - p1[0], v1y = p0[1] - p1[1], l1 = Math.hypot(v1x, v1y);
    const v2x = p2[0] - p1[0], v2y = p2[1] - p1[1], l2 = Math.hypot(v2x, v2y);
    if (l1 < 1e-9 || l2 < 1e-9) { out.push(p1.slice()); continue; }
    const u1x = v1x / l1, u1y = v1y / l1, u2x = v2x / l2, u2y = v2y / l2;
    const ang = Math.acos(Math.max(-1, Math.min(1, u1x * u2x + u1y * u2y))); // 코너 내각
    if (ang < 0.05 || Math.abs(ang - Math.PI) < 0.05) { out.push(p1.slice()); continue; } // 거의 직선
    let d = r / Math.tan(ang / 2);
    d = Math.min(d, l1 / 2, l2 / 2);
    const rr = d * Math.tan(ang / 2);
    const t1 = [p1[0] + u1x * d, p1[1] + u1y * d], t2 = [p1[0] + u2x * d, p1[1] + u2y * d];
    const bx = u1x + u2x, by = u1y + u2y, bl = Math.hypot(bx, by) || 1;
    const c = [p1[0] + bx / bl * (rr / Math.sin(ang / 2)), p1[1] + by / bl * (rr / Math.sin(ang / 2))];
    let a1 = Math.atan2(t1[1] - c[1], t1[0] - c[0]), a2 = Math.atan2(t2[1] - c[1], t2[0] - c[0]);
    let da = a2 - a1; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
    for (let k = 0; k <= seg; k++) { const a = a1 + da * k / seg; out.push([c[0] + rr * Math.cos(a), c[1] + rr * Math.sin(a)]); }
  }
  return out;
}
function cmdFillet3D() {
  const sel = selectedEntities().filter(e => e.type === 'LWPOLYLINE' && e.closed && e.bim && ['column', 'slab', 'roof'].includes(e.bim.kind));
  if (!sel.length) { logLine('  3D 모깎기: 닫힌 폴리라인 입체(기둥·상자·슬래브)를 선택하세요 — 수직 모서리를 둥글게 만듭니다.', 'warn'); return; }
  const rv = bimAskNum('모깎기 반지름 (mm):', 200); if (rv == null) return;
  const r = Math.abs(rv); if (r < 1) return;
  pushUndo();
  let n = 0;
  for (const e of sel) {
    const rounded = polyRoundCorners(e.points, r, 6);
    if (rounded && rounded.length >= 3) { e.points = rounded; n++; }
  }
  if (!n) { undo(); return; }
  logLine(`  ✔ 3D 모깎기 ${n}개 — 수직 모서리 반지름 ${r}`, 'ok');
  updateStat(); renderProps(); boolRefresh(); draw();
}

// ---------- 그룹: 하나를 클릭하면 함께 선택 ----------
function cmdGroup() {
  const sel = selectedEntities();
  if (sel.length < 2) { logLine('  그룹: 2개 이상 선택한 뒤 실행하세요.', 'warn'); return; }
  pushUndo();
  const g = 'G' + (state.nextId++);
  sel.forEach(e => { e.grp = g; });
  logLine(`  ✔ 그룹 생성: ${sel.length}개 — 구성원 하나를 클릭하면 전체가 선택됩니다 (ungroup=해제)`, 'ok');
  renderProps(); draw();
}
function cmdUngroup() {
  const gs = new Set(selectedEntities().map(e => e.grp).filter(Boolean));
  if (!gs.size) { logLine('  그룹 해제: 그룹에 속한 도형을 선택하세요.', 'warn'); return; }
  pushUndo();
  let n = 0;
  for (const e of state.entities) if (e.grp && gs.has(e.grp)) { delete e.grp; n++; }
  logLine(`  ✔ 그룹 해제: ${n}개 (그룹 ${gs.size}개)`, 'ok');
  renderProps(); draw();
}

function cmdBox() {
  const a = ask3('상자 모서리1 x,y:', '0,0'); if (!a) return;
  const b = ask3('상자 모서리2 x,y:', '3000,3000'); if (!b) return;
  const h = bimAskNum('높이 (mm):', settings.bim.wallH); if (h == null) return;
  pushUndo();
  const e = addEntity({ type: 'LWPOLYLINE', closed: true, points: [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]] });
  e.bim = { kind: 'column', h, base: cplaneZ() }; delete e.zo;
  logLine(`  ✔ Box (${a[0]},${a[1]})~(${b[0]},${b[1]}) 높이 ${h} · 바닥 z=${cplaneZ()}`, 'ok');
  renderProps(); draw();
}
function cmdCylinder() {
  const c0 = ask3('원기둥 중심 x,y:', '0,0'); if (!c0) return;
  const r = bimAskNum('반지름 (mm):', 500); if (r == null) return;
  const h = bimAskNum('높이 (mm):', settings.bim.wallH); if (h == null) return;
  pushUndo();
  const e = addEntity({ type: 'CIRCLE', cx: c0[0], cy: c0[1], r });
  e.bim = { kind: 'column', h, base: cplaneZ() }; delete e.zo;
  logLine(`  ✔ Cylinder r=${r} 높이 ${h} · 바닥 z=${cplaneZ()}`, 'ok');
  renderProps(); draw();
}
function cmdSetTop() {
  const sel = selectedEntities().filter(e => e.bim && ['wall', 'column', 'stair'].includes(e.bim.kind));
  if (!sel.length) { logLine('  settop: 벽·기둥·계단(돌출체)을 선택한 뒤 실행하세요.', 'warn'); return; }
  const z = bimAskNum('상단 높이 z (mm):', lvElev() + settings.bim.wallH); if (z == null) return;
  pushUndo();
  for (const e of sel) e.bim.h = Math.max(10, Math.round(z - (e.bim.base || 0)));
  logLine(`  ✔ SetTop: ${sel.length}개 상단을 z=${z}(으)로 정렬`, 'ok');
  renderProps(); draw();
}
// ── 3D 변환·프리미티브 공용 헬퍼 ──────────────────────────────
function meshXform(e, fn, flip) { // fn:(x,y,z)->[x,y,z]; flip=삼각형 winding 뒤집기(대칭용)
  e.tris = e.tris.map(t => { const nt = t.map(p => fn(p[0], p[1], p[2])); return flip ? [nt[0], nt[2], nt[1]] : nt; });
}
function dupEnts(sel) { // 선택 객체 복제(새 id) — z 오프셋 보존
  return sel.map(e => { const c = JSON.parse(JSON.stringify(e)); delete c.id; const zo = c.zo; const n = addEntity(c); if (zo != null) n.zo = zo; else delete n.zo; return n; });
}
function move3DEnt(e, dx, dy, dz) { // 메시는 정점 이동, 그 외는 평면 이동 + z 시프트
  if (e.type === 'MESH') meshXform(e, (x, y, z) => [x + dx, y + dy, z + dz]);
  else { translateEntity(e, dx, dy); zShift3(e, dz); }
}
function meshSphere(cx, cy, cz, r, seg, rings) { // UV 구
  const tris = [], pt = (i, j) => { const th = Math.PI * j / rings, ph = 2 * Math.PI * i / seg;
    return [cx + r * Math.sin(th) * Math.cos(ph), cy + r * Math.sin(th) * Math.sin(ph), cz + r * Math.cos(th)]; };
  for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) {
    const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1);
    if (j !== 0) tris.push([a, b, c]);
    if (j !== rings - 1) tris.push([a, c, d]);
  }
  return tris;
}
function meshCone(cx, cy, z0, r, h, seg) { // 원뿔(꼭짓점 위)
  const tris = [], apex = [cx, cy, z0 + h], base = [cx, cy, z0];
  const ring = i => [cx + r * Math.cos(2 * Math.PI * i / seg), cy + r * Math.sin(2 * Math.PI * i / seg), z0];
  for (let i = 0; i < seg; i++) { const a = ring(i), b = ring(i + 1); tris.push([a, b, apex]); tris.push([b, a, base]); }
  return tris;
}
function newMesh(tris, name, color) { const e = addEntity({ type: 'MESH', tris, name, color: color || '#c7b6a0' }); state.selection.clear(); state.selection.add(e.id); return e; }
// Rotate3D: 선택 객체를 수직(Z)축 기준으로 회전 (평면 회전 + 메시 정점 회전, z 보존)
function cmdSphere() {
  const c = ask3('구 중심 x,y:', '0,0'); if (!c) return;
  const zs = prompt('중심 z (mm):', String(cplaneZ() + 1000)); if (zs == null) return;
  const cz = parseFloat(zs); if (!isFinite(cz)) return;
  const r = bimAskNum('반지름 (mm):', 1000); if (r == null) return;
  pushUndo();
  newMesh(meshSphere(c[0], c[1], cz, r, 24, 16), 'sphere');
  logLine(`  ✔ Sphere: 중심(${c[0]},${c[1]},${cz}) r=${r} — 메시 생성`, 'ok');
  boolRefresh();
}
// Cone: 원뿔 메시 생성
function cmdCone() {
  const c = ask3('원뿔 바닥 중심 x,y:', '0,0'); if (!c) return;
  const r = bimAskNum('바닥 반지름 (mm):', 800); if (r == null) return;
  const h = bimAskNum('높이 (mm):', 1600); if (h == null) return;
  pushUndo();
  newMesh(meshCone(c[0], c[1], cplaneZ(), r, h, 32), 'cone', '#c0a890');
  logLine(`  ✔ Cone: 바닥(${c[0]},${c[1]}) r=${r} 높이 ${h} · 바닥 z=${cplaneZ()} — 메시 생성`, 'ok');
  boolRefresh();
}
// ── 인터랙티브 돌출 컨트롤러 — extrudecrv/extrudesrf 공용: ①마우스로 값 끌기  ②명령창 수치 입력 ─────
// ── 돌출(extrudecrv/extrudesrf) — 라이노식, 예측 가능한 단일 흐름 ─────────────────
// extrudePend.stage: pickSel(객체 선택 대기) → height(마지막 캡 선택으로 즉시 생성; 기준점 클릭→높이 조절)
// 순서 (a) 명령→객체 클릭→Enter,  (b) 객체 선택→명령.  cap y/n = 명령창 버튼 클릭 또는 y/n 입력.
// 핵심: cap 선택 즉시 기본 높이로 "항상" 생성(바로 보임). 그 뒤 3D는 커서로, 어디서나 숫자로 조절,
//       Enter/클릭 확정, Esc 취소. 뷰 상태에 따라 되고 안 되고가 없어 일관됨.
function footprintCentroid(sel) { // 선택 곡선들의 평면 무게중심
  let sx = 0, sy = 0, n = 0;
  for (const e of sel) {
    if (e.type === 'CIRCLE') { sx += e.cx; sy += e.cy; n++; }
    else if (e.type === 'LINE') { sx += (e.x1 + e.x2) / 2; sy += (e.y1 + e.y2) / 2; n++; }
    else if (e.points) { for (const p of e.points) { sx += p[0]; sy += p[1]; n++; } }
  }
  return n ? { x: sx / n, y: sy / n } : { x: 0, y: 0 };
}
function is3DActive() { const ov = document.getElementById('bim3d'); return !!(ov && ov.style.display !== 'none'); }
// 돌출의 '3D 상호작용(기준점 클릭·커서 높이)'이 실제로 가능한가 — 화면에 3D/입면 칸이 하나라도 보여야 한다.
// ★ 작업환경 통합(2026-07-19) 후 셸이 항상 열려 있어 is3DActive()는 늘 참이 됐다. 그 바람에
//   '평면 단일 뷰'에서도 extrudecrv가 3D 흐름(기준점 클릭 대기)으로 빠졌는데, 평면 뷰에서 3D 캔버스는
//   2×2px 로 줄어 있어 클릭을 받을 수 없다 → 아무것도 생성되지 않는 회귀(사용자 보고 2026-07-20).
//   평면 뷰뿐이면 통합 전 '평면 작업환경'과 동일하게 기본 높이로 즉시 생성 + 숫자 입력 흐름이어야 한다.
function extrude3DUI() {
  if (!is3DActive() || typeof v3 === 'undefined' || !v3 || !v3.views) return false;
  const idxs = v3.quad ? [0, 1, 2, 3] : [v3.act];
  return idxs.some(i => !vpIsPlan(i)); // 보이는 칸 중 평면이 아닌(3D·입면) 칸이 있으면 3D 흐름
}
// 속성 편집(레이어·색·BIM 수치 등) 후 갱신 — 2D는 항상, 3D 뷰가 열려 있으면 솔리드 재빌드+재렌더 (패널은 유지)
function propRefresh() { draw(); if (is3DActive() && typeof v3 !== 'undefined' && v3) { v3.solids = bimSolids(); render3D(); } }
function extrudeRefresh() { if (is3DActive()) { if (typeof v3 !== 'undefined' && v3) v3.solids = bimSolids(); render3D(); } else { renderProps(); draw(); } }
// extrudesrf 스냅 — 대상 외 모든 객체(벽·기둥 솔리드 + 불리언/구/원뿔/STL 메시)의 꼭짓점·모서리·표면에 흡착.
// 우선순위: 꼭짓점 > 모서리 > 표면 > (솔리드)수직변. 전역 스냅 토글과 무관하게 항상.
function srfSurfaceSnap(px, py, exclude) {
  if (typeof v3 === 'undefined' || !v3) return null;
  const dpr = devicePixelRatio || 1;
  // snap3D는 비-BIM(선·곡선)만 담당 — BIM 객체는 snap3D가 중점/끝점을 항상 바닥 z로 줘서 부정확.
  // BIM은 아래 footprint 루프가 바닥(z0)·윗면(z1) 각각에서 꼭짓점·중점·모서리를 정확히 스냅.
  const svExclude = new Set(); for (const e of state.entities) if (e.bim) svExclude.add(e.id);
  if (exclude) for (const id of exclude) svExclude.add(id);
  const wasOsnap = osnapEnabled; osnapEnabled = true;
  const sv = snap3D(px, py, null, svExclude); // 비-BIM 선/곡선의 끝점·중점·중심·nearest
  osnapEnabled = wasOsnap;
  const svVertex = (sv && sv.z != null && ['endpoint', 'center', 'midpoint', 'intersect', 'quad'].includes(sv.kind)) ? sv : null;
  const svEdge = (sv && sv.z != null && sv.kind === 'nearest') ? sv : null;
  const segNear = (A, B) => { const pa = proj3D(A[0], A[1], A[2]), pb = proj3D(B[0], B[1], B[2]); const dx = pb[0] - pa[0], dy = pb[1] - pa[1], L2 = dx * dx + dy * dy; const t = L2 ? Math.max(0, Math.min(1, ((px - pa[0]) * dx + (py - pa[1]) * dy) / L2)) : 0; return { d: Math.hypot(px - (pa[0] + dx * t), py - (pa[1] + dy * t)), t }; };
  const inPoly = (pts) => { let ins = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1]; if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) ins = !ins; } return ins; };
  // BIM 객체(벽·기둥·슬래브·지붕 등): 각 엔티티 footprint를 '바닥/윗면' 높이에서 스냅.
  // v3.solids 밴드가 아니라 원본 footprint(선/폴리라인/원)를 쓰므로 두께 0 면(surface)도 실제 선이라 잡힘.
  // 꼭짓점·중점은 반경을 크게(착 달라붙게), 모서리는 좁게 → 꼭짓점/중점 우선 흡착
  let bV = null, bVD = 26 * dpr, mMid = null, mMidD = 22 * dpr, hBest = null, hBestD = 9 * dpr, sfBest = null, sfDepth = Infinity;
  for (const e of state.entities) {
    if (!e.bim) continue;
    if (exclude && exclude.has(e.id)) continue;
    const l = getLayer(e.layer); if (l && !l.visible) continue;
    // 벽: '실제 렌더 밴드'(마이터 코너·개구부 분할 포함)에 스냅 — 중심선의 보이지 않는 점 대신 눈에 보이는 지오메트리
    if (e.bim.kind === 'wall') {
      const parts2 = (v3.solids || []).filter(s => s.eid === e.id);
      if (parts2.length) {
        for (const s of parts2) {
          const zTop = s.zt ? Math.max(...s.zt) : s.z1;
          for (const zf of [zTop, s.z0]) {
            const fp2 = s.poly, proj2 = fp2.map(p => proj3D(p[0], p[1], zf));
            for (let i = 0; i < fp2.length; i++) { const d = Math.hypot(px - proj2[i][0], py - proj2[i][1]); if (d < bVD) { bVD = d; bV = { x: Math.round(fp2[i][0]), y: Math.round(fp2[i][1]), z: Math.round(zf), kind: '꼭짓점' }; } }
            for (let i = 0; i < fp2.length; i++) {
              const j = (i + 1) % fp2.length;
              if (Math.hypot(fp2[j][0] - fp2[i][0], fp2[j][1] - fp2[i][1]) < 1e-6) continue; // t0 퇴화 변 스킵
              const mx = (fp2[i][0] + fp2[j][0]) / 2, my = (fp2[i][1] + fp2[j][1]) / 2, mp = proj3D(mx, my, zf);
              const dm = Math.hypot(px - mp[0], py - mp[1]); if (dm < mMidD) { mMidD = dm; mMid = { x: Math.round(mx), y: Math.round(my), z: Math.round(zf), kind: '중점' }; }
              const rr = segNear([fp2[i][0], fp2[i][1], zf], [fp2[j][0], fp2[j][1], zf]); if (rr.d < hBestD) { hBestD = rr.d; hBest = { x: Math.round(fp2[i][0] + (fp2[j][0] - fp2[i][0]) * rr.t), y: Math.round(fp2[i][1] + (fp2[j][1] - fp2[i][1]) * rr.t), z: Math.round(zf), kind: '모서리' }; }
            }
            if (inPoly(proj2)) { const depth = proj2.reduce((a2, p) => a2 + p[2], 0) / proj2.length; if (depth < sfDepth) { const w = unproj3D(px, py, zf); sfDepth = depth; sfBest = { x: w ? Math.round(w[0]) : Math.round(fp2[0][0]), y: w ? Math.round(w[1]) : Math.round(fp2[0][1]), z: Math.round(zf), kind: '표면' }; } }
          }
        }
        continue;
      }
    }
    let fp = null, closed = false;
    if (e.type === 'CIRCLE') { fp = circlePoly(e.cx, e.cy, e.r, 32); closed = true; }
    else if (e.type === 'LINE') { fp = [[e.x1, e.y1], [e.x2, e.y2]]; }
    else if (e.points && e.points.length >= 2) { fp = e.points.map(p => [p[0], p[1]]); closed = !!e.closed; }
    if (!fp) continue;
    const parts = (v3.solids || []).filter(s => s.eid === e.id);
    let z0 = Infinity, z1 = -Infinity;
    for (const s of parts) { z0 = Math.min(z0, s.z0); z1 = Math.max(z1, s.zt ? Math.max(...s.zt) : s.z1); }
    if (!isFinite(z0)) { z0 = (e.bim.base != null ? e.bim.base : (e.bim.top != null ? e.bim.top - (e.bim.t || 0) : 0)); z1 = z0 + (e.bim.h || e.bim.t || 0); }
    const isCircle = e.type === 'CIRCLE' || e.type === 'ARC';
    for (const zf of [z1, z0]) { // 윗면·바닥 높이
      const proj = fp.map(p => proj3D(p[0], p[1], zf));
      if (isCircle) { // 라이노 오스냅 정합: 원/호는 중심(Cen)·사분점(Quad)만 점 스냅 — 다각형 근사 꼭짓점은 가짜라 스냅 안 함
        const pc = proj3D(e.cx, e.cy, zf); const dc = Math.hypot(px - pc[0], py - pc[1]);
        if (dc < bVD) { bVD = dc; bV = { x: Math.round(e.cx), y: Math.round(e.cy), z: Math.round(zf), kind: '중심' }; }
        for (const q of [[e.cx + e.r, e.cy], [e.cx - e.r, e.cy], [e.cx, e.cy + e.r], [e.cx, e.cy - e.r]]) {
          if (e.type === 'ARC' && !angleInArc(ang(e.cx, e.cy, q[0], q[1]), e.startAngle, e.endAngle)) continue; // 호: 범위 밖 사분점 제외
          const pq = proj3D(q[0], q[1], zf); const dq = Math.hypot(px - pq[0], py - pq[1]);
          if (dq < bVD) { bVD = dq; bV = { x: Math.round(q[0]), y: Math.round(q[1]), z: Math.round(zf), kind: '사분점' }; }
        }
      } else {
        for (let i = 0; i < fp.length; i++) { const d = Math.hypot(px - proj[i][0], py - proj[i][1]); if (d < bVD) { bVD = d; bV = { x: Math.round(fp[i][0]), y: Math.round(fp[i][1]), z: Math.round(zf), kind: '꼭짓점' }; } }
      }
      const nE = closed ? fp.length : fp.length - 1;
      for (let i = 0; i < nE; i++) {
        const j = (i + 1) % fp.length;
        if (!isCircle) { // 중점 스냅 — 원의 근사 다각형 변 중점은 가짜라 제외
          const mx = (fp[i][0] + fp[j][0]) / 2, my = (fp[i][1] + fp[j][1]) / 2, mp = proj3D(mx, my, zf); // 모서리 중점
          const dm = Math.hypot(px - mp[0], py - mp[1]); if (dm < mMidD) { mMidD = dm; mMid = { x: Math.round(mx), y: Math.round(my), z: Math.round(zf), kind: '중점' }; }
        }
        const rr = segNear([fp[i][0], fp[i][1], zf], [fp[j][0], fp[j][1], zf]); if (rr.d < hBestD) { hBestD = rr.d; hBest = { x: Math.round(fp[i][0] + (fp[j][0] - fp[i][0]) * rr.t), y: Math.round(fp[i][1] + (fp[j][1] - fp[i][1]) * rr.t), z: Math.round(zf), kind: '모서리' }; }
      }
      if (closed && inPoly(proj)) { const depth = proj.reduce((a, p) => a + p[2], 0) / proj.length; if (depth < sfDepth) { const w = unproj3D(px, py, zf); sfDepth = depth; sfBest = { x: w ? Math.round(w[0]) : Math.round(fp[0][0]), y: w ? Math.round(w[1]) : Math.round(fp[0][1]), z: Math.round(zf), kind: '표면' }; } }
    }
  }
  // 메시(불리언 결과·구·원뿔·STL): 삼각형 꼭짓점 mV, 모서리 mE, 면 mF
  let mV = null, mVD = 26 * dpr, mE = null, mED = 9 * dpr, mF = null, mFDepth = Infinity;
  for (const e of state.entities) {
    if (e.type !== 'MESH' || !e.tris) continue;
    if (exclude && exclude.has(e.id)) continue;
    const l = getLayer(e.layer); if (l && !l.visible) continue;
    if (e.tris.length > 4000) continue; // 과대 메시는 성능상 생략
    for (const t of e.tris) {
      const P = [proj3D(t[0][0], t[0][1], t[0][2]), proj3D(t[1][0], t[1][1], t[1][2]), proj3D(t[2][0], t[2][1], t[2][2])];
      for (let i = 0; i < 3; i++) { const d = Math.hypot(px - P[i][0], py - P[i][1]); if (d < mVD) { mVD = d; mV = { x: Math.round(t[i][0]), y: Math.round(t[i][1]), z: Math.round(t[i][2]), kind: '꼭짓점' }; } }
      for (let i = 0; i < 3; i++) { const j = (i + 1) % 3, pa = P[i], pb = P[j]; const dx = pb[0] - pa[0], dy = pb[1] - pa[1], L2 = dx * dx + dy * dy; const tt = L2 ? Math.max(0, Math.min(1, ((px - pa[0]) * dx + (py - pa[1]) * dy) / L2)) : 0; const d = Math.hypot(px - (pa[0] + dx * tt), py - (pa[1] + dy * tt)); if (d < mED) { mED = d; mE = { x: Math.round(t[i][0] + (t[j][0] - t[i][0]) * tt), y: Math.round(t[i][1] + (t[j][1] - t[i][1]) * tt), z: Math.round(t[i][2] + (t[j][2] - t[i][2]) * tt), kind: '모서리' }; } }
      const a = P[0], b = P[1], cc = P[2];
      const v0x = cc[0] - a[0], v0y = cc[1] - a[1], v1x = b[0] - a[0], v1y = b[1] - a[1], v2x = px - a[0], v2y = py - a[1];
      const d00 = v0x * v0x + v0y * v0y, d01 = v0x * v1x + v0y * v1y, d02 = v0x * v2x + v0y * v2y, d11 = v1x * v1x + v1y * v1y, d12 = v1x * v2x + v1y * v2y;
      const den = d00 * d11 - d01 * d01; if (Math.abs(den) < 1e-9) continue;
      const uu = (d11 * d02 - d01 * d12) / den, ww = (d00 * d12 - d01 * d02) / den;
      if (uu >= -0.001 && ww >= -0.001 && uu + ww <= 1.001) { const depth = (a[2] + b[2] + cc[2]) / 3; if (depth < mFDepth) { mFDepth = depth; const wz = t[0][2] + (t[2][2] - t[0][2]) * uu + (t[1][2] - t[0][2]) * ww; const w = unproj3D(px, py, wz); mF = { x: w ? Math.round(w[0]) : Math.round(t[0][0]), y: w ? Math.round(w[1]) : Math.round(t[0][1]), z: Math.round(wz), kind: '표면' }; } }
    }
  }
  // BIM 꼭짓점·중점은 화면상 더 가까운 쪽 (납작한 박스에서 바닥 꼭짓점이 윗변 중점을 가리는 것 방지)
  const bimPt = (bV && mMid) ? (bVD <= mMidD ? bV : mMid) : (bV || mMid);
  // 우선순위: BIM 꼭짓점/중점(정확 z) > 비-BIM 꼭짓점/중점 > 메시 꼭짓점 > 모서리 > 표면
  return bimPt || svVertex || mV || hBest || svEdge || mE || sfBest || mF || null;
}
// ═══════════ extrudecrv / extrudesrf — 동결 (2026-07-16, cad.js?v=20260716q) ═══════════
// 사용자 지시: "이대로 고정해줘". 별도 지시가 있기 전까지 아래 동작을 바꾸지 않는다.
// 개선 아이디어가 있어도 먼저 물어볼 것. (여러 번 "바꾸지 마라니까 왜 자꾸 바꿔" 를 들었다.)
//
// 확정된 흐름:
//   명령어 입력 → 면 클릭 → 높이 기준점 클릭 → 숫자 입력 또는 커서로 높낮이 조절 → 클릭/Enter 확정
//   · 같은 면을 다시 클릭 = 기준점 지정(재시작 아님). 다른 면 클릭 = 그 면으로 재타겟 (extrudePend.face 로 구별)
//   · 높이 = 커서가 가리키는 화면 높이와 정확히 일치 (extrudeValFromCursor — proj3D 를 역산)
//   · 스냅은 '다른 객체의 꼭짓점·중점·모서리' 에만. 자기 자신·표면 스냅 제외(높이가 0 으로 떨어지는 원인이었다)
//   · 높이 조절 중 우드래그=뷰 회전 · 휠드래그=뷰 이동 — 그 동안 명령이 취소되지 않는다
//   · 우클릭 '탭'(움직임 없음)·Esc = 취소 (원래 높이 복원)
//
// ★ 이 흐름은 extrude 코드를 안 건드려도 깨진다 — 표시용 면 배열(v3.faces)을 바꾸면 피킹이 달라진다.
//   3D 표시·조명 파이프라인을 손댔으면 반드시 extrudesrf 를 직접 돌려보고 커밋할 것.
// ★ 회귀 테스트 18개가 이 계약을 지킨다: tests.html 의
//   'extrudesrf 흐름 계약' + '면 피킹은 조명과 무관해야 한다' 그룹. 깨지면 거기서 잡힌다.
function extrudeSetVal(val) { // height 단계: 모든 항목에 적용 — 양수=위로, 음수=아래로(기준면 아래) 돌출, 0=평면
  const ex = extrudePend; if (!ex || ex.stage !== 'height') return;
  ex.val = Math.round(val); // 1단위로 부드럽게. 음수 허용 → 아래 방향은 base를 내리고 h=|값|으로 저장
  if (ex.side) { // 옆면: 라이노 ExtrudeSrf 방식 — 원본은 그대로, 클릭한 면에서 법선 방향으로 '새 솔리드'가 자라남
    const s = ex.side, src = state.entities.find(x => x.id === s.id); if (!src) return;
    if (s.circle) { src.r = Math.max(1, s.r0 + ex.val); return; } // 원기둥은 반지름 조절
    const d = ex.val;
    const fp = [[s.ea[0], s.ea[1]], [s.eb[0], s.eb[1]], [s.eb[0] + s.nx * d, s.eb[1] + s.ny * d], [s.ea[0] + s.nx * d, s.ea[1] + s.ny * d]];
    let ne = s.newId != null ? state.entities.find(x => x.id === s.newId) : null;
    if (!ne) {
      ne = addEntity({ type: 'LWPOLYLINE', closed: true, points: fp, layer: src.layer, color: src.color });
      ne.bim = { kind: 'column', h: s.z1 - s.z0, base: s.z0 }; delete ne.zo;
      s.newId = ne.id;
    } else ne.points = fp;
    return;
  }
  for (const it of ex.items) {
    const e = state.entities.find(x => x.id === it.id);
    if (e && e.bim) { e.bim.base = it.base + Math.min(0, ex.val); e.bim.h = Math.abs(ex.val); }
  }
}
// 캡 유무에 따라 대상 bim 종류 설정(=이때 비로소 입체 생성) — cap=y & 면 되는 프로파일=solid(column), 아니면 면(wall t0)
function extrudeApplyKind() {
  const ex = extrudePend; if (!ex || ex.stage !== 'height') return;
  if (ex.side) { ex.applied = true; return; } // 옆면 밀당: 기존 솔리드 유지 — 종류/높이 변경 없음
  extrudeDoChain(ex); // 끝점이 맞닿은 분해 곡선들 → 닫힌 프로파일 하나 (생성 시점 병합, cap 가능)
  extrudeDoMerge(ex); // 이중 외곽선 예약 병합 — 실제 생성 시점(여기)에 두 곡선 → 벽체 하나
  const h = Math.abs(ex.val), bOff = Math.min(0, ex.val); // 음수=아래 방향 돌출(base 내림), 0=평면
  for (const it of ex.items) {
    const e = state.entities.find(x => x.id === it.id); if (!e) continue;
    if (it.t != null) { e.bim = { kind: 'wall', h, t: it.t, base: it.base + bOff }; continue; } // 이중 외곽선 벽체: 두께 유지
    const cappable = (e.type === 'CIRCLE') || (e.type === 'LWPOLYLINE' && (e.points || []).length >= 3);
    // extrudesrf(면 밀당)은 항상 솔리드로. extrudecrv는 캡 선택에 따라 솔리드/면.
    const solid = ex.srf ? cappable : (ex.cap && cappable);
    e.bim = solid ? { kind: 'column', h, base: it.base + bOff } : { kind: 'wall', h, t: 0, base: it.base + bOff };
  }
  ex.applied = true;
}
function extrudePromptHeight() { // 단계별 명령창 안내 (+ 캡 유무 토글 버튼)
  const ex = extrudePend; if (!ex || ex.stage !== 'height') return;
  if (ex.srf) { setPrompt(`높이 ${ex.val} — 화면 클릭으로 조절(스냅) / 숫자 입력 / Esc`); return; } // 면 밀당은 캡 개념 없음
  // cap on/off — 라이노식 명령 옵션(2026-07-20): 명령창에 'cap on/off' 문구가 뜨고,
  // on/off 텍스트를 클릭하거나 명령창에 on·off 를 입력해 결정한다. 상시 기본은 on(lastExtrudeCap).
  const capCh = [
    { label: (ex.cap ? '● ' : '') + 'on', on: () => extrudeSetCap(true) },
    { label: (!ex.cap ? '● ' : '') + 'off', on: () => extrudeSetCap(false) },
  ];
  if (extrude3DUI() && ex.heightPhase === 'awaitBase')
    setPromptChoices('높이 기준점을 클릭하세요 (또는 숫자 입력) · cap on/off:', capCh);
  else if (extrude3DUI()) // awaitTop: 커서로 조절 중 (버튼 없이 텍스트만 — 매 프레임 갱신)
    setPrompt(`높이 ${ex.val} — 클릭/Enter 확정 · 숫자 · cap on/off 입력 · Esc`);
  else // 평면: 숫자 입력 + cap 선택
    setPromptChoices(`높이값 입력 후 Enter (${ex.val}) · cap on/off:`, capCh);
}
function extrudeSetCap(cap) { // 캡 유무 지정 → 마지막 선택으로 저장(다음 돌출에도 유지)
  const ex = extrudePend; if (!ex || ex.stage !== 'height') return;
  lastExtrudeCap = !!cap; ex.cap = !!cap;
  if (ex.applied) { extrudeApplyKind(); extrudeSetVal(ex.val); extrudeRefresh(); } // 이미 생성됐으면 종류만 갱신(아직 클릭 전이면 유지만)
  extrudePromptHeight();
  logLine(`  ▷ 캡 ${ex.cap ? '있음(솔리드)' : '없음(면)'} — 이후 돌출에도 유지`, 'info');
}
function extrudeToggleCap() { extrudeSetCap(!(extrudePend && extrudePend.cap)); }
// 높이 기준점을 '클릭'으로 지정 (화면 어느 곳이든 그 클릭 위치가 기준=높이 0) → 이때 비로소 입체 생성,
// 이후 커서로 높이 결정(다른 객체 스냅). 클릭 전엔 높이 없음(평면 곡선 상태).
// 커서가 가리키는 화면 높이 ↔ 개체의 실제 높이를 '정확히' 일치시킨다.
// proj3D 는 z 에 대해 선형이므로, 기준점의 수직선 위 두 점만 투영하면 역산할 수 있다.
//   화면y = A - (…+ dz·cos(pitch) + panY)·k   →  dz 는 화면y 에 대해 1차
// 이렇게 proj3D 자체로 되돌리면 pitch·zoom·pan·뷰포트가 무엇이든, 도중에 뷰를 돌려도
// '커서 높이 = 실제 높이' 가 항상 성립한다.
// ★ 예전엔 `h0 + (anchorPy - py) / k` 를 썼다. k 는 '수평' px/mm 라 Z 축에는 cos(pitch) 가 빠져 있어
//   커서보다 높이가 느리게(또는 빠르게) 따라왔고, 궤도를 돌리면 pitch 가 바뀌는데 k·anchorPy 는
//   클릭 시점 값이라 계속 어긋났다.
function extrudeValFromCursor(ex, py) {
  if (ex.ax == null || ex.ay == null) return null;
  const y0 = proj3D(ex.ax, ex.ay, ex.base)[1];
  const y1 = proj3D(ex.ax, ex.ay, ex.base + 1000)[1];
  const d = y1 - y0;
  if (Math.abs(d) < 0.5) return null; // 거의 수직으로 내려다보는 각 — 세로 이동으로 높이를 정할 수 없다
  return (py - y0) / d * 1000;
}
function extrudeSetBase(px, py) {
  const ex = extrudePend; if (!ex || ex.stage !== 'height' || !extrude3DUI() || typeof v3 === 'undefined' || !v3) return;
  if (ex.side) { // 옆면 밀당 기준점: 클릭 위치=기준(면은 안 움직임). 이후 커서 이동의 '법선 성분'만큼 밀당
    const s = ex.side;
    const a = proj3D(s.mx, s.my, s.mz), b = proj3D(s.mx + s.nx * 100, s.my + s.ny * 100, s.mz);
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    ex.sdir = [dx / L, dy / L]; ex.sscale = L / 100; ex.anchor2 = [px, py]; ex.h0 = ex.val; ex.heightPhase = 'awaitTop';
    v3.snapHit = null; extrudeRefresh();
    setPrompt(`이동 ${ex.val} — 면 중심의 수직(법선) 축을 따라 커서로 밀당 · 꼭짓점·모서리 근처에선 자석 스냅 · 클릭/Enter 확정 · 숫자 · Esc`);
    logLine('  ▷ 기준점 지정 — 커서를 움직이면 선택 면이 수직(법선) 방향으로 밀리고 당겨집니다. 클릭/Enter 확정', 'info');
    return;
  }
  const vi = vpAt(px, py), rct = vpRect(vi), w = v3.views ? v3.views[vi] : null;
  ex.k = (Math.min(rct.w, rct.h) / (v3.fit * 1.4) * (w ? w.zoom : v3.zoom)) || 1;
  let apy = py, h0 = (ex.srf && ex.applied) ? ex.val : 0;
  let ax = null, ay = null;
  { // 기준점 스냅(꼭짓점·중점·모서리·표면, 대상·다른 객체 포함) — srf·crv 공통. 그 점의 화면위치/높이를 기준으로
    const sn = srfSurfaceSnap(px, py, null);
    if (sn && sn.z != null) { const s = proj3D(sn.x, sn.y, sn.z); apy = s[1]; h0 = sn.z - ex.base; ax = sn.x; ay = sn.y; } // 기준면 아래 스냅이면 음수 시작(아래 방향)
  }
  // 높이를 읽어낼 '수직선' 의 밑점. 스냅이 없으면 클릭 광선이 기준 높이 평면과 만나는 점을 쓴다
  // → 그 순간 proj3D(ax, ay, base+h0) 의 화면 y 가 곧 커서 y 라, 클릭 직후 높이가 튀지 않는다.
  if (ax == null) { const w = unproj3D(px, py, ex.base + h0); ax = w[0]; ay = w[1]; }
  ex.ax = ax; ex.ay = ay;
  ex.anchorPy = apy; ex.h0 = h0; ex.heightPhase = 'awaitTop';
  if (!ex.applied) extrudeApplyKind(); // extrudecrv/평면: 이 클릭에서 비로소 입체 생성
  extrudeSetVal(ex.h0); // 면 밀당은 현재/스냅 높이에서, 그 외는 0에서 자연스럽게 시작 (커서 이동으로 즉시 자람)
  if (typeof v3 !== 'undefined' && v3) v3.snapHit = null;
  extrudeRefresh();
  setPrompt(`높이 ${ex.val} — 커서로 조절(다른 객체에 스냅) 후 클릭/Enter 확정 · 숫자 · Esc`);
  logLine('  ▷ 높이 기준점 지정 — 커서를 움직여 높이 결정(다른 객체에 스냅), 클릭/Enter 확정', 'info');
}
// 3D 커서로 높이 조절 (awaitTop) — 항상 스냅 우선: 커서 근처 지오메트리 z에 높이 흡착.
// 스냅이 없으면 기준점(클릭) 대비 세로 이동량으로 조절.
function extrudeHover(e) {
  const ex = extrudePend;
  if (!ex || ex.stage !== 'height' || !extrude3DUI() || typeof v3 === 'undefined' || !v3) return;
  const r = v3.cv.getBoundingClientRect();
  const px = (e.clientX - r.left) * (r.width ? v3.cv.width / r.width : 1);
  const py = (e.clientY - r.top) * (r.height ? v3.cv.height / r.height : 1);
  if (ex.heightPhase !== 'awaitTop') { // confirmFace(포커싱) 또는 awaitBase(기준점 대기)
    // srf·crv 공통: 포커싱/기준점 대기 순간부터 객체 꼭짓점·중점·모서리·표면 스냅 표시 (대상 자신 포함)
    const sn = srfSurfaceSnap(px, py, null);
    v3.snapHit = sn || null; v3.snapCursor = (sn && sn.z != null) ? [px, py] : null;
    setPrompt(sn && sn.z != null ? `스냅 ▶ z=${Math.round(sn.z)} (${sn.kind}) — 클릭=기준점 확정 · Esc` : '기준점 클릭 (객체 꼭짓점·중점·모서리·표면에 스냅) · 숫자 입력 · Esc');
    markInteract();
    return;
  }
  if (ex.side) { // 옆면 밀당: '면 중심의 법선 축'을 따라 커서 이동량으로 밀당. 스냅은 '다른 객체'의 꼭짓점·중점·모서리에만
    const s = ex.side;
    const dragVal = ex.h0 + ((px - ex.anchor2[0]) * ex.sdir[0] + (py - ex.anchor2[1]) * ex.sdir[1]) / (ex.sscale || 1);
    let useVal = dragVal, snapped = null;
    const excl = new Set(ex._exclude || []); if (s.newId != null) excl.add(s.newId); // 원본 + 자라는 새 솔리드(미리보기) 제외
    const sn = srfSurfaceSnap(px, py, excl); // 자기 자신 제외 — 자기 모서리에 되끌려가는 것 방지
    if (sn && sn.x != null && sn.kind !== '표면' && sn.kind !== 'surface') { // 표면 스냅 제외(값 널뛰기 방지)
      useVal = s.circle ? (Math.hypot(sn.x - s.cx, sn.y - s.cy) - s.r0) : ((sn.x - s.mx) * s.nx + (sn.y - s.my) * s.ny);
      snapped = sn; // 다른 객체의 꼭짓점·중점·모서리에 조준 → 그 위치의 법선 성분으로 정확 흡착
    }
    v3.snapHit = snapped; v3.snapCursor = snapped ? [px, py] : null;
    extrudeSetVal(useVal);
    setPrompt(snapped ? `이동 ${ex.val} · 스냅 (${snapped.kind}) — 클릭/Enter 확정 · 숫자 · Esc` : `이동 ${ex.val} — 면의 수직 방향으로 밀당 · 클릭/Enter 확정 · 숫자 · Esc`);
    v3.solids = bimSolids();
    markInteract();
    return;
  }
  // 높이 결정: 기본은 '기준점 대비 커서의 세로 이동량' — 클릭한 지점에서 마우스로 높낮이를 조절한다.
  // 스냅은 '다른 객체의 꼭짓점·중점·모서리' 에만 건다. 옆면 밀당(위 ex.side 분기)과 같은 규칙이다.
  // ★ 예전엔 srfSurfaceSnap(px, py, null) 로 '대상 자신 + 표면' 까지 스냅했다. 그래서:
  //    · 커서가 자기 윗면 위 → 자기 z 에 붙어 높이가 꿈쩍도 안 함
  //    · 커서가 바닥으로 나감 → 바닥 표면 z=0 에 붙어 높이가 0 으로 떨어짐
  //   즉 커서를 따라오지 않고 커서 밑 표면의 z 로 고정됐다. 자라는 자기 자신에 스냅하니
  //   되먹임까지 생긴다. 옆면 경로엔 이미 '표면 제외·자기 제외' 가 있었는데 높이 경로만 빠져 있었다.
  const sn = srfSurfaceSnap(px, py, ex._exclude); // 자기 자신 제외 — 자라는 제 모서리에 되끌리지 않게
  const usable = sn && sn.z != null && sn.kind !== '표면' && sn.kind !== 'surface'; // 표면 스냅 제외(값 널뛰기 방지)
  if (usable) { // 다른 객체의 꼭짓점·중점·모서리 z 에 흡착 → 높이를 정확히 맞춘다 (기준면 아래면 음수)
    v3.snapHit = sn; v3.snapCursor = [px, py];
    extrudeSetVal(sn.z - ex.base);
    setPrompt(`높이 ${ex.val} · 스냅 z=${Math.round(sn.z)}${sn.kind ? ' (' + sn.kind + ')' : ''} — 클릭/Enter 확정 · 숫자 · Esc`);
  } else { // 커서가 가리키는 화면 높이 = 실제 높이 (기준점의 수직선을 따라 읽는다)
    v3.snapHit = null; v3.snapCursor = null;
    const v = extrudeValFromCursor(ex, py);
    if (v != null) extrudeSetVal(v);
    setPrompt(v == null
      ? `높이 ${ex.val} — 이 각도에선 커서로 높이를 정할 수 없습니다(거의 위에서 봄). 우드래그로 뷰를 눕히거나 숫자 입력 · Esc`
      : `높이 ${ex.val} — 커서로 조절 · 우드래그=뷰 회전 · 휠드래그=이동 · 클릭/Enter 확정 · 숫자 · Esc`);
  }
  v3.solids = bimSolids();
  markInteract();
}
function extrudeFinish() { // 현재 높이로 확정
  const ex = extrudePend; if (!ex || ex.stage !== 'height') return;
  if (ex.side && !ex.side.circle && ex.side.newId != null) { // 옆면: 새 솔리드 정리/선택
    if (Math.abs(ex.val) < 0.5) state.entities = state.entities.filter(x => x.id !== ex.side.newId); // 돌출 0 → 생성 안 함
    else { state.selection.clear(); state.selection.add(ex.side.newId); }
  }
  if (!ex.srf && ex.applied) { // 라이노 ExtrudeCrv(DeleteInput=No): 입력 곡선을 원래 자리에 남김
    const readd = (c) => { if (!c) return; const ne = addEntity({ ...c }); ne.color = c.color; delete ne.zo; };
    for (const it of ex.items) if (it.crv0) readd(it.crv0);
    if (ex.merge2 && ex.mergedDone && ex.merge2.crvs) for (const c of ex.merge2.crvs) readd(c);
    if (ex.chain && ex.chainDone && ex.chain.crvs) for (const c of ex.chain.crvs) readd(c); // 체인 원본 곡선 복원 (DeleteInput=No)
  }
  extrudePend = null; setPrompt('');
  if (typeof v3 !== 'undefined' && v3) { v3.snapHit = null; v3.snapCursor = null; v3.srfHi = null; }
  // (겹친 곡선 통짜 합집합 병합은 사용자 요청으로 보류 — 안팎 포갬 벽체만 유지)
  logLine(ex.srf ? `  ✔ 면 밀당 완료 — 높이 ${ex.val}` : `  ✔ 돌출 완료 — 높이 ${ex.val} · ${ex.cap ? '캡 있음(솔리드)' : '캡 없음(면)'}`, 'ok');
  extrudeRefresh();
}
function extrudePendCancel() { // 어느 단계든 취소 (height면 만든 입체 되돌림)
  if (!extrudePend) return false;
  const st = extrudePend.stage;
  extrudePend = null; setPrompt('');
  if (typeof v3 !== 'undefined' && v3) { v3.snapHit = null; v3.snapCursor = null; v3.srfHi = null; }
  if (st === 'height' && undoStack.length) restore(undoStack.pop());
  logLine('  돌출 취소', 'info');
  extrudeRefresh();
  return true;
}
function extrudeValidSel(cmd) {
  const sel = selectedEntities();
  if (cmd === 'extrudecrv') return sel.filter(e => e.type === 'LINE' || e.type === 'LWPOLYLINE' || e.type === 'CIRCLE');
  // extrudesrf: '면(서피스·솔리드)'만 — 벽(t0 면 포함)·기둥. 일반 곡선(crv)은 대상 아님(라이노 ExtrudeSrf처럼 — 곡선은 extrudecrv로)
  return sel.filter(e => e.bim && ['wall', 'column'].includes(e.bim.kind));
}
function beginExtrude(cmd) {
  const valid = extrudeValidSel(cmd);
  if (valid.length) { extrudeStart(cmd, valid); return; } // (b) 선택 후 명령 → 바로 진행(cap 안 물음)
  if (cmd === 'extrudesrf' && selectedEntities().some(e => !e.bim && (e.type === 'LWPOLYLINE' || e.type === 'CIRCLE' || e.type === 'LINE')))
    logLine('  ⚠ extrudesrf는 면(서피스·솔리드) 전용입니다 — 곡선을 돌출하려면 extrudecrv를 쓰세요.', 'warn');
  extrudePend = { cmd, stage: 'pickSel' };                // (a) 명령 후 선택 대기
  if (state.tool !== 'select') setTool('select');
  const what = cmd === 'extrudecrv' ? '돌출할 곡선(선·폴리라인·원)' : '두께 줄 면(서피스·솔리드)';
  logLine(`  ▷ ${cmd}: ${what}을 클릭 선택하고 Enter(또는 Space) — Esc 취소`, 'info');
  setPrompt(`${what} 선택 후 Enter — ${cmd}`);
  extrudeRefresh();
}
// extrudecrv: 캡은 lastExtrudeCap 자동. 3D는 '클릭'해야 높이 시작(그 전엔 평면).
// extrudesrf(면 밀당): 대상 솔리드는 현재 높이 그대로 두고, 화면 클릭/숫자로 높이(밀거나 당김) 조절.
// 안팎 이중 외곽선(같은 모양 스케일/오프셋 쌍 — 안쪽 곡선이 바깥 곡선 안에 완전히 들어감) →
// 간격을 두께로 하는 '건물 벽체' 하나로 변환. 안쪽 각 꼭짓점→바깥 변 최단거리=두께, 그 중점=중심선.
// 폴리라인이 '고리(닫힌 윤곽)'인가 — closed 플래그거나, 끝점이 시작점 근처(=폴리 도구로 안 닫고 되돌아 찍음)면 참
function polyIsLoop(e) {
  if (!e || e.type !== 'LWPOLYLINE') return false;
  const p = e.points || []; if (p.length < 3) return false;
  if (e.closed) return true;
  if (p.length < 4) return false;
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const q of p) { mnx = Math.min(mnx, q[0]); mny = Math.min(mny, q[1]); mxx = Math.max(mxx, q[0]); mxy = Math.max(mxy, q[1]); }
  const diag = Math.hypot(mxx - mnx, mxy - mny) || 1;
  return Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) < diag * 0.08; // 끝점≈시작점
}
function detectDoubleOutlineWall(sel, dryRun) {
  const DBG = () => {}; // 진단 표시 제거(사용자 요청) — 판정 실패 시 조용히 개별 돌출로 진행
  if (sel.length !== 2) { if (sel.length > 2) DBG(`선택 ${sel.length}개 — 정확히 2개여야 벽체 병합`); return null; }
  // ★원 2개(포갬) = 통(파이프) — 라이노 ExtrudeCrv 와 같은 기대.
  //   중심선 = 반지름 중간인 원, 두께 = 반지름 차. 원은 곡선 그대로 유지되므로(다각형화 안 함)
  //   3D 에서 매끄러운 원통으로 나온다. ★예전엔 polyIsLoop 가 LWPOLYLINE 만 참이라
  //   원 2개는 감지 자체가 안 돼 '기둥 2개'가 따로 만들어졌다 (2026-07-20 사용자 보고).
  if (sel.length === 2 && sel.every(e => e.type === 'CIRCLE')) {
    const [a, b] = sel;
    const d = Math.hypot(a.cx - b.cx, a.cy - b.cy);
    const rO = Math.max(a.r, b.r), rI = Math.min(a.r, b.r);
    const outer = a.r >= b.r ? a : b, inner = a.r >= b.r ? b : a;
    const t = Math.round(rO - rI);
    // 안쪽 원이 바깥 원 안에 들어가야 통 — 중심이 어긋나도 '완전 포함'이면 평균 두께로
    if (!(t > 0.5) || d + rI > rO + 1e-6) { DBG('원 2개지만 포갬이 아님'); return null; }
    const base = lvElev() + (outer.zo || 0);
    return { circle: true, outerId: outer.id, innerId: inner.id, t,
      cx: (outer.cx + inner.cx) / 2, cy: (outer.cy + inner.cy) / 2, r: (rO + rI) / 2,
      base, layer: outer.layer, color: outer.color };
  }
  if (!sel.every(e => polyIsLoop(e))) {
    DBG(`고리(닫힌 윤곽) 2개 필요 (지금: ${sel.map(e => (e.type === 'LWPOLYLINE' ? '폴리라인' : e.type) + (polyIsLoop(e) ? '·고리' : e.closed ? '·닫힘' : '·열림') + (e.points ? e.points.length + '점' : '')).join(' , ')}) — 폴리 도구로 그렸으면 끝점을 시작점에 정확히 맞물려 닫으세요`); return null;
  }
  // 닫힘/끝점≈시작점 중복 꼭짓점 제거해 정규화 — 폴리 도구로 안 닫힌 5점 사각형도 4점으로
  const norm = pts => {
    const q = pts.map(p => [p[0], p[1]]);
    if (q.length >= 4) {
      let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
      for (const p of q) { mnx = Math.min(mnx, p[0]); mny = Math.min(mny, p[1]); mxx = Math.max(mxx, p[0]); mxy = Math.max(mxy, p[1]); }
      const tol = Math.max(1, Math.hypot(mxx - mnx, mxy - mny) * 0.04);
      while (q.length >= 4 && Math.hypot(q[0][0] - q[q.length - 1][0], q[0][1] - q[q.length - 1][1]) < tol) q.pop();
    }
    return q;
  };
  const P0 = norm(sel[0].points), P1 = norm(sel[1].points);
  const inPoly = (p, poly) => { let ins = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1]; if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) ins = !ins; } return ins; };
  // 안쪽 = 대다수(≥과반) 꼭짓점이 상대 안에 들어가는 쪽 (경계 오차 허용)
  const inFrac = (pts, poly) => pts.filter(p => inPoly(p, poly)).length / pts.length;
  const f10 = inFrac(P1, P0), f01 = inFrac(P0, P1);
  let outer = null, inner = null, op = null, ip = null;
  if (f10 >= 0.5 && f10 >= f01) { outer = sel[0]; inner = sel[1]; op = P0; ip = P1; }
  else if (f01 >= 0.5) { outer = sel[1]; inner = sel[0]; op = P1; ip = P0; }
  if (!outer || !inner) { DBG(`포개짐 아님 — 한쪽이 다른쪽 안에 들어가야 함 (포함율 ${Math.round(f10 * 100)}% / ${Math.round(f01 * 100)}%). 옆으로 걸쳐 겹친 배치면 합집합(union)으로 하세요`); return null; }
  const n2 = op.length, dists = [], mids = [];
  for (const p of ip) {
    // 두께 = 바깥 '변'까지 최단(수직) 거리
    let bd = Infinity;
    for (let i = 0; i < n2; i++) { const a = op[i], b = op[(i + 1) % n2]; const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy; const tt = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0; const qx = a[0] + dx * tt, qy = a[1] + dy * tt; const d = Math.hypot(p[0] - qx, p[1] - qy); if (d < bd) bd = d; }
    dists.push(bd);
    // 중심선 = 바깥 '꼭짓점'과의 중점 (스케일/오프셋 쌍은 대응 꼭짓점 → 코너까지 깔끔한 중심선)
    let vd = Infinity, vx = 0, vy = 0;
    for (let i = 0; i < n2; i++) { const d = Math.hypot(p[0] - op[i][0], p[1] - op[i][1]); if (d < vd) { vd = d; vx = op[i][0]; vy = op[i][1]; } }
    mids.push([(p[0] + vx) / 2, (p[1] + vy) / 2]);
  }
  const t = Math.round(dists.reduce((a, b) => a + b, 0) / dists.length);
  // 포개진(안쪽이 바깥쪽 안에 든) 두 곡선이면 간격이 고르지 않아도 항상 벽체로 병합 — 간격 평균을 두께로.
  if (!(t > 0.5)) { DBG(`두께 0 — 두 곡선이 거의 겹침(간격 ${t})`); return null; }
  DBG(`OK → 두께 ${t} 벽체로 병합 (포함율 ${Math.round(Math.max(f10, f01) * 100)}%)`);
  const base = lvElev() + (outer.zo || 0);
  if (dryRun) return { outerId: outer.id, innerId: inner.id, t, mids, base, layer: outer.layer, color: outer.color }; // 감지만(무변경) — 병합은 생성 시점에
  const ids = new Set([outer.id, inner.id]);
  state.entities = state.entities.filter(e => !ids.has(e.id));
  const ln = addEntity({ type: 'LWPOLYLINE', closed: true, points: mids, layer: outer.layer, color: outer.color });
  ln.bim = { kind: 'wall', h: 0, t, base }; delete ln.zo; // 높이 0에서 시작 — 미리 솟아있지 않게 (기준점 클릭 후 커서로 올림)
  state.selection.clear(); state.selection.add(ln.id); // 병합 벽체를 선택 상태로 → 파란 강조
  return ln;
}
// 이중 외곽선 병합을 '실제 생성' 시점에 실행 — 선택 단계에선 두 곡선이 그대로(둘 다 파란 강조) 보이게.
function extrudeDoMerge(ex) {
  const mi = ex && ex.merge2; if (!mi || ex.mergedDone) return;
  ex.mergedDone = true;
  const o = state.entities.find(e => e.id === mi.outerId), n = state.entities.find(e => e.id === mi.innerId);
  if (!o || !n) return;
  if (mi.circle) { // 원 2개 → 두께 있는 '원통(파이프)' — 중심선 원 + 벽 두께 (곡선 유지)
    const ids0 = new Set([mi.outerId, mi.innerId]);
    state.entities = state.entities.filter(e => !ids0.has(e.id));
    const ce = addEntity({ type: 'CIRCLE', cx: mi.cx, cy: mi.cy, r: mi.r, layer: mi.layer, color: mi.color });
    ce.bim = { kind: 'wall', h: 0, t: mi.t, base: mi.base }; delete ce.zo;
    state.selection.clear(); state.selection.add(ce.id);
    ex.items = [{ id: ce.id, base: mi.base, t: mi.t }];
    logLine(`  ▷ 원 2개 → 두께 ${mi.t} 원통(파이프)으로 병합`, 'ok');
    return;
  }
  const ids = new Set([mi.outerId, mi.innerId]);
  state.entities = state.entities.filter(e => !ids.has(e.id));
  const ln = addEntity({ type: 'LWPOLYLINE', closed: true, points: mi.mids, layer: mi.layer, color: mi.color });
  ln.bim = { kind: 'wall', h: 0, t: mi.t, base: mi.base }; delete ln.zo;
  state.selection.clear(); state.selection.add(ln.id);
  ex.items = [{ id: ln.id, base: mi.base, t: mi.t }];
  logLine(`  ▷ 곡선 2개 → 두께 ${mi.t} 벽체로 병합`, 'ok');
}
// 분해된 곡선(선·열린 폴리라인) 여러 개가 끝점끼리 맞닿아 '하나의 닫힌 고리'를 이루면
// 닫힌 프로파일로 병합 — cap on 이면 뚜껑 닫힌 솔리드로 돌출된다.
// (2026-07-20 사용자 요청: explode 된 사각형처럼 crv 가 나뉘어 있어도 닫혀 있으면 캡이 닫혀야 한다.
//  라이노가 조인된 폐곡선을 캡하는 것과 같은 기대. 병합은 merge2 처럼 '생성 시점'에 실행.)
function detectChainedLoop(sel) {
  if (sel.length < 2) return null;
  const segs = [];
  for (const e of sel) {
    if (e.bim) return null;
    if (e.type === 'LINE') segs.push({ id: e.id, pts: [[e.x1, e.y1], [e.x2, e.y2]] });
    else if (e.type === 'LWPOLYLINE' && !e.closed && e.points && e.points.length >= 2)
      segs.push({ id: e.id, pts: e.points.map(p => [p[0], p[1]]) });
    else return null; // 원·닫힌 폴리는 이미 단독 프로파일 — 체인 병합 대상이 아니다
  }
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const s of segs) for (const p of s.pts) { mnx = Math.min(mnx, p[0]); mny = Math.min(mny, p[1]); mxx = Math.max(mxx, p[0]); mxy = Math.max(mxy, p[1]); }
  const tol = Math.max(1, Math.hypot(mxx - mnx, mxy - mny) * 0.01);
  const near2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
  const used = new Array(segs.length).fill(false);
  used[0] = true;
  const chain = segs[0].pts.map(p => [p[0], p[1]]);
  for (let step = 1; step < segs.length; step++) {
    const end = chain[chain.length - 1];
    let hit = -1, rev = false;
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      if (near2(segs[i].pts[0], end)) { hit = i; rev = false; break; }
      if (near2(segs[i].pts[segs[i].pts.length - 1], end)) { hit = i; rev = true; break; }
    }
    if (hit < 0) return null; // 끝점이 이어지지 않음 — 고리 아님
    used[hit] = true;
    const pts = rev ? segs[hit].pts.slice().reverse() : segs[hit].pts;
    for (let k = 1; k < pts.length; k++) chain.push([pts[k][0], pts[k][1]]); // 첫 점 = 이음점(중복 제거)
  }
  if (!near2(chain[0], chain[chain.length - 1])) return null; // 시작으로 안 돌아옴 = 열린 사슬
  chain.pop(); // 마지막 점(=시작점) 제거 → 닫힌 다각형 점열
  if (chain.length < 3) return null;
  return { ids: sel.map(e => e.id), points: chain, layer: sel[0].layer, color: sel[0].color };
}
// 체인 병합을 '실제 생성' 시점에 실행 — 선택 단계에선 곡선들이 그대로(전부 파란 강조) 보이게.
function extrudeDoChain(ex) {
  const ch = ex && ex.chain; if (!ch || ex.chainDone) return;
  ex.chainDone = true;
  const alive = ch.ids.map(id => state.entities.find(e => e.id === id)).filter(Boolean);
  if (alive.length !== ch.ids.length) return; // 도중에 지워졌으면 개별 돌출로 폴백
  const base = ex.items.length ? Math.min(...ex.items.map(it => it.base)) : lvElev();
  const ids = new Set(ch.ids);
  state.entities = state.entities.filter(e => !ids.has(e.id));
  const ln = addEntity({ type: 'LWPOLYLINE', closed: true, points: ch.points, layer: ch.layer, color: ch.color });
  delete ln.zo;
  state.selection.clear(); state.selection.add(ln.id);
  ex.items = [{ id: ln.id, base }];
  logLine(`  ▷ 끝점이 맞닿은 곡선 ${ch.ids.length}개 → 닫힌 프로파일 하나로 병합 (cap ${ex.cap ? 'on' : 'off'})`, 'ok');
}
// 단일 닫힌 곡선(면돌출로 하나만 클릭한 경우 등)에 대해, 안팎으로 포개진 짝 곡선을 찾아 반환.
// → 면돌출은 '면 클릭' 흐름이라 한 개만 잡히는데, 짝이 있으면 함께 잡아 벽체로 병합되게.
function findNestedPartner(e) {
  if (!(e && !e.bim && polyIsLoop(e))) return null;
  const inPoly = (p, poly) => { let ins = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1]; if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) ins = !ins; } return ins; };
  const frac = (a, b) => a.filter(p => inPoly(p, b)).length / a.length;
  for (const c of state.entities) {
    if (c === e || c.bim || !polyIsLoop(c)) continue;
    const l = getLayer(c.layer); if (l && !l.visible) continue;
    const ep = e.points.map(p => [p[0], p[1]]), cp = c.points.map(p => [p[0], p[1]]);
    if (frac(cp, ep) >= 0.8 || frac(ep, cp) >= 0.8) return c; // 한쪽이 다른쪽 안에 대부분 들어감
  }
  return null;
}
// 발자국(닫힌 다각형)을 z0~z1 기둥 삼각형으로 (CCW 정규화)
function extrudePrism(pts, z0, z1) {
  const n = pts.length; if (n < 3) return [];
  let area2 = 0; for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; area2 += a[0] * b[1] - b[0] * a[1]; }
  const poly = area2 < 0 ? pts.slice().reverse() : pts;
  const top = poly.map(p => [p[0], p[1], z1]), bot = poly.map(p => [p[0], p[1], z0]), tris = [];
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; tris.push([bot[i], bot[j], top[j]], [bot[i], top[j], top[i]]); }
  for (let i = 1; i < n - 1; i++) { tris.push([top[0], top[i], top[i + 1]]); tris.push([bot[0], bot[i + 1], bot[i]]); }
  return tris;
}
// 겹친(합집합) 여러 곡선 돌출 → CSG 합집합으로 하나의 개체(라이노식 벽체처럼). 안 겹치면 그대로 둠.
function mergeOverlappingExtrusion(items) {
  const rows = items.map(it => ({ it, e: state.entities.find(e => e.id === it.id) })).filter(r => r.e);
  if (rows.length < 2) return;
  const fp = e => e.type === 'CIRCLE' ? circlePoly(e.cx, e.cy, e.r, 24) : (e.points ? e.points.map(p => [p[0], p[1]]) : null);
  for (const r of rows) { r.fp = fp(r.e); if (!r.fp || r.fp.length < 3) return; }
  const inP = (p, poly) => { let ins = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1]; if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) ins = !ins; } return ins; };
  const segX = (a, b, c, d) => { const D = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]); if (Math.abs(D) < 1e-9) return false; const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / D, u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / D; return t >= 0 && t <= 1 && u >= 0 && u <= 1; };
  const overlap = (A, B) => { if (A.some(p => inP(p, B)) || B.some(p => inP(p, A))) return true; for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) if (segX(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length])) return true; return false; };
  let any = false; for (let a = 0; a < rows.length && !any; a++) for (let b = a + 1; b < rows.length; b++) if (overlap(rows[a].fp, rows[b].fp)) any = true;
  if (!any) return; // 안 겹치면 따로 유지 (Phase95 원칙)
  let acc = null;
  for (const r of rows) { const z0 = r.it.base || 0, z1 = z0 + Math.max(1, (r.e.bim && r.e.bim.h) || 0); const p = trisToPolys(extrudePrism(r.fp, z0, z1)); if (p.length) acc = acc ? csgOp(acc, p, 'union') : p; }
  if (!acc || !acc.length) return;
  const outTris = polysToTris(acc); if (!outTris.length) return;
  const base = rows[0].e, ids = new Set(rows.map(r => r.e.id));
  state.entities = state.entities.filter(e => !ids.has(e.id));
  const comps = meshComponents(outTris), created = [];
  for (const ct of comps) created.push(addEntity({ type: 'MESH', tris: ct, layer: base.layer, color: base.color }));
  state.selection.clear(); created.forEach(m => state.selection.add(m.id));
  logLine(`  ✔ 겹친 ${rows.length}개 곡선 → 합집합 하나로 병합`, 'ok');
}
// 입력 곡선 지오메트리 스냅샷 — 라이노 ExtrudeCrv(DeleteInput=No)처럼 돌출 후 원본 곡선을 남기기 위함
function extrudeSnapCrv(e) {
  const c = { type: e.type, layer: e.layer, color: e.color };
  if (e.type === 'CIRCLE') { c.cx = e.cx; c.cy = e.cy; c.r = e.r; }
  else if (e.type === 'LINE') { c.x1 = e.x1; c.y1 = e.y1; c.x2 = e.x2; c.y2 = e.y2; }
  else { c.points = (e.points || []).map(p => [p[0], p[1]]); c.closed = !!e.closed; }
  return c;
}
function extrudeStart(cmd, sel) {
  pushUndo();
  const srf = (cmd === 'extrudesrf');
  // 곡선 병합(이중 외곽선→벽체, 겹친 곡선→합집합)은 extrudecrv(곡선 돌출) 전용. extrudesrf(면 밀당)는 손대지 않음.
  if (!srf) {
    // 선택한 것만 사용 — 짝 곡선 '자동 포함' 없음(사용자가 명시적으로 2개를 선택했을 때만 벽체 병합).
    // 이중 외곽선은 여기서 '감지만' — 병합은 실제 생성(기준점 클릭/숫자) 시점에. 선택 단계에선 두 곡선 모두 파란 강조로 보이게.
    var merge2 = sel.length === 2 ? detectDoubleOutlineWall(sel, true) : null;
    if (merge2) { merge2.crvs = [extrudeSnapCrv(sel[0]), extrudeSnapCrv(sel[1])]; logLine(`  ▷ 이중 외곽선 감지 — 곡선 2개가 생성 시 두께 ${merge2.t} 벽체로 병합됩니다`, 'ok'); }
    // 분해된 곡선들이 끝점으로 이어져 닫힌 고리를 이루면 → 생성 시점에 닫힌 프로파일 하나로 (cap 가능)
    var chain0 = (!merge2 && sel.length >= 2) ? detectChainedLoop(sel) : null;
    if (chain0) { chain0.crvs = sel.map(e => extrudeSnapCrv(e)); logLine(`  ▷ 끝점이 맞닿은 곡선 ${sel.length}개 — 닫힌 프로파일로 병합되어 cap ${lastExtrudeCap ? 'on(솔리드)' : 'off(면)'} 돌출됩니다`, 'ok'); }
  }
  // extrudesrf: 마지막으로 클릭한 면이 '아랫면'이면 윗면을 고정하고 아랫면을 밀당 (라이노처럼 위·아래 면 모두 가능)
  const pf = (srf && typeof v3 !== 'undefined' && v3 && v3.pickFace && sel.some(e => e.id === v3.pickFace.eid)) ? v3.pickFace : null;
  const fromBottom = !!(pf && pf.fk === 'bot');
  // 옆면 밀당: 클릭한 옆면(발자국의 변)을 법선 방향으로 밀고 당김 — 기둥(닫힌 발자국)·원기둥(반지름) 지원
  // 라이노 ExtrudeSrf 방식: 원본은 그대로 두고, 클릭한 면(ea~eb 구간, z0~z1 높이)에서
  // 법선(nx,ny) 방향으로 '새 솔리드'가 자라남. sideMode = {ea, eb, nx, ny, mx, my, mz, z0, z1}
  let sideMode = null;
  if (pf && pf.fk === 'side' && sel.length === 1) {
    const e = sel[0];
    const z0e = (e.bim && e.bim.base) || 0, z1e = z0e + ((e.bim && e.bim.h) || 0), mze = (z0e + z1e) / 2;
    if (e.bim && e.bim.kind === 'column' && e.type === 'CIRCLE') {
      sideMode = { id: e.id, circle: true, cx: e.cx, cy: e.cy, r0: e.r, mx: 0, my: 0, nx: 0, ny: 0, mz: mze }; // (변 인덱스는 CIRC_SEG 기준)
      // 법선(반경 방향)은 클릭 변 기준 — 표시용 분절(_curvSeg) 변 fi 의 중점 방향
      const cp = circlePoly(e.cx, e.cy, e.r, _curvSeg), i0 = pf.fi % _curvSeg, j0 = (i0 + 1) % _curvSeg;
      const mx = (cp[i0][0] + cp[j0][0]) / 2, my = (cp[i0][1] + cp[j0][1]) / 2;
      const L = Math.hypot(mx - e.cx, my - e.cy) || 1;
      sideMode.nx = (mx - e.cx) / L; sideMode.ny = (my - e.cy) / L; sideMode.mx = mx; sideMode.my = my;
      sideMode.i = i0; sideMode.j = j0; // 강조 표시용 (16각 solid poly 인덱스)
    } else if (e.bim && e.bim.kind === 'column' && e.points && e.points.length >= 3 && pf.fi != null && pf.fi < e.points.length) {
      const n = e.points.length, i0 = pf.fi, j0 = (i0 + 1) % n;
      const a = e.points[i0], b = e.points[j0];
      const ex2 = b[0] - a[0], ey2 = b[1] - a[1], L = Math.hypot(ex2, ey2) || 1;
      let nx = ey2 / L, ny = -ex2 / L; // 바깥 방향 후보 — 중심 반대쪽으로
      let ccx = 0, ccy = 0; for (const p of e.points) { ccx += p[0]; ccy += p[1]; } ccx /= n; ccy /= n;
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      if ((mx - ccx) * nx + (my - ccy) * ny < 0) { nx = -nx; ny = -ny; }
      sideMode = { id: e.id, ea: [a[0], a[1]], eb: [b[0], b[1]], nx, ny, mx, my, mz: mze, z0: z0e, z1: z1e };
    } else if (e.bim && e.bim.kind === 'wall' && pf.si != null && pf.fi != null) {
      // 벽: 클릭한 '실제 렌더 밴드'의 그 변을 그대로 사용 — 마이터 코너 포함, 면 끝에서 끝까지 정확
      const bands = (typeof v3 !== 'undefined' && v3 && v3.solids ? v3.solids : []).filter(s => s.eid === e.id && s.seg === pf.si);
      const band = bands.find(s => pf.sz0 == null || s.z0 === pf.sz0) || bands[0];
      if (band && pf.fi < band.poly.length) {
        const n4 = band.poly.length, i0 = pf.fi, j0 = (i0 + 1) % n4;
        const a = band.poly[i0], b = band.poly[j0];
        const ex2 = b[0] - a[0], ey2 = b[1] - a[1], L = Math.hypot(ex2, ey2);
        if (L > 1e-6) { // t0 벽의 퇴화(폭 0) 캡 변은 제외
          let nx = ey2 / L, ny = -ex2 / L;
          let ccx = 0, ccy = 0; for (const p of band.poly) { ccx += p[0]; ccy += p[1]; } ccx /= n4; ccy /= n4;
          const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
          if ((mx - ccx) * nx + (my - ccy) * ny < 0) { nx = -nx; ny = -ny; } // 밴드 중심 반대쪽 = 바깥
          const zTop = band.zt ? Math.max(...band.zt) : band.z1;
          sideMode = { id: e.id, ea: [a[0], a[1]], eb: [b[0], b[1]], nx, ny, mx, my, mz: (band.z0 + zTop) / 2, z0: band.z0, z1: zTop };
        }
      }
    }
  }
  const items = []; let nSlant = 0, curH = 0, hasSolid = false;
  for (const e of sel) {
    let base = lvElev() + (e.zo || 0);
    if (e.type === 'LINE' && (e.z1 != null || e.z2 != null)) { base = Math.min(e.z1 || 0, e.z2 || 0); if ((e.z1 || 0) !== (e.z2 || 0)) nSlant++; delete e.z1; delete e.z2; }
    else if (e.bim && e.bim.base != null) base = e.bim.base;
    if (e.bim && e.bim.h) { curH = Math.max(curH, e.bim.h); hasSolid = true; }
    if (fromBottom) base = base + ((e.bim && e.bim.h) || 0); // 아랫면 밀당: 고정 기준 = 원래 '윗면' z (val 음수 = 아랫면이 아래로)
    delete e.zo; items.push({ id: e.id, base, t: (e.bim && e.bim.kind === 'wall' && e.bim.t > 0) ? e.bim.t : null,
      crv0: (!srf && !e.bim) ? extrudeSnapCrv(e) : null }); // 라이노 DeleteInput=No — 완료 시 원본 곡선 복원용
  }
  if (nSlant) logLine(`  ⚠ 기울어진 3D 선 ${nSlant}개는 낮은 끝 높이 기준으로 수직 돌출`, 'warn');
  const c = footprintCentroid(sel);
  const defH = settings.bim.wallH || 2700;
  const base = items.length ? Math.min(...items.map(it => it.base)) : lvElev();
  const startVal = sideMode ? 0 : ((srf && hasSolid) ? (fromBottom ? -curH : curH) : defH); // 아랫면: 음수 시작 · 옆면: 이동량 0에서 시작
  extrudePend = { cmd, srf, stage: 'height', heightPhase: 'awaitBase', items, cx: c.x, cy: c.y, val: startVal, anchorPy: null, h0: 0, k: 0, cap: lastExtrudeCap, base, _exclude: new Set(items.map(it => it.id)), applied: false, fromBottom, side: sideMode };
  // 지금 밀고 있는 면을 기억한다 — '같은 면 다시 클릭' 과 '다른 면으로 재타겟' 을 구별하기 위해.
  // 이게 없으면 기준점을 그 면 위에 찍는 순간 재타겟으로 오인해 명령이 재시작된다.
  extrudePend.face = pf ? { eid: pf.eid, fk: pf.fk || null, fi: pf.fi != null ? pf.fi : null, si: pf.si != null ? pf.si : null } : null;
  if (!srf && typeof merge2 !== 'undefined' && merge2) extrudePend.merge2 = merge2; // 생성 시점 병합 예약
  if (!srf && typeof chain0 !== 'undefined' && chain0) extrudePend.chain = chain0;  // 체인 폐곡선 병합 예약
  if (srf) { // 면 밀당: 기존 솔리드는 현재 높이로 그대로 보이게, 화면 클릭/숫자로 높이·이동 조절 (스냅)
    if (sideMode) extrudePend.applied = true; // 옆면: 기존 솔리드의 발자국만 움직임 — 종류/높이 안 건드림
    else if (hasSolid) { extrudeApplyKind(); extrudeSetVal(startVal); }
    // 객체 전체가 아니라 '선택된 면(윗·아랫·옆면)'만 강조 — 전체 선택 하이라이트 해제하고 그 면만 표시
    if (typeof v3 !== 'undefined' && v3) v3.srfHi = new Set(items.map(it => it.id));
    state.selection.clear();
    extrudePend.heightPhase = 'confirmFace'; // 면 포커싱만 — Space/Enter로 기준점 선택 시작
    extrudeRefresh(); renderProps();
    const faceKo = sideMode ? '옆면' : fromBottom ? '아랫면' : '윗면';
    logLine(`  ▷ extrudesrf: ${faceKo} 포커싱됨 — Space/Enter를 눌러 기준점 선택을 시작하거나, ${sideMode ? '이동값' : '높이값'}을 바로 입력 · Esc`, 'info');
    setPrompt(`${faceKo} 선택됨 — Space/Enter로 기준점 선택 시작 · 또는 ${sideMode ? '이동값' : '높이값'} 입력 · Esc`);
  } else if (extrude3DUI()) { // extrudecrv 3D: 높이 0(평면)에서 시작 — 선택 crv 파란 강조 + 점선 예시, 클릭해야 높이 시작
    extrudePend.val = 0; // 미리 솟아있지 않게 — 기준점 클릭 후 커서/스냅/숫자로 0부터 올림
    extrudeRefresh();
    logLine(`  ▷ ${cmd}: 곡선 ${items.length}개 선택됨(파란 강조 + 끝점 표시)${extrudePend.merge2 ? ' — 생성 시 벽체 하나로 병합' : ''} — 화면 클릭=기준점(스냅), 커서로 0부터 높이 조절 · 또는 높이값 입력`, 'info');
    setPrompt(`곡선 ${items.length}개 선택됨 — 기준점 클릭(스냅) · 높이값 입력 · Esc`);
  } else { // 평면: 클릭 드래그 불가 → 기본 높이로 생성 후 숫자로 조정
    extrudeApplyKind(); extrudeSetVal(defH); extrudeRefresh();
    logLine(`  ✔ ${lastExtrudeCap ? '캡 있는 솔리드' : '캡 없는 면'} 생성(높이 ${defH}) — 높이값 입력 후 Enter`, 'ok');
    extrudePromptHeight();
  }
}
function cmdExtrudeCrv() { beginExtrude('extrudecrv'); }
function cmdExtrudeSrf() { beginExtrude('extrudesrf'); }
// 계단: LINE = 진행선(시작=아래, 끝=위). 단수 n = ceil(h/최대단높이), 단별 수직 프리즘.
function cmdStairTag() {
  const sel = selectedEntities().filter(e => e.type === 'LINE' || (e.type === 'LWPOLYLINE' && !e.closed));
  if (!sel.length) { logLine('  계단: 진행 방향 선/곡선(시작=아랫단, 끝=윗단)을 선택한 뒤 실행하세요 — 닫힌 폴리라인은 계단 경로가 될 수 없습니다.', 'warn'); return; }
  const w = bimAskNum('계단 폭 (mm):', settings.bim.stairW); if (w == null) return;
  const h = bimAskNum('총 높이 (오르는 높이, mm):', 3000); if (h == null) return;
  const riser = bimAskNum('최대 단높이 (mm):', settings.bim.stairRiser); if (riser == null) return;
  settings.bim.stairW = w; settings.bim.stairRiser = riser; saveSettings();
  pushUndo();
  for (const e of sel) e.bim = { kind: 'stair', w, h, riser, base: (e.bim && e.bim.base != null) ? e.bim.base : lvElev() };
  const n = Math.max(1, Math.ceil(h / riser));
  const curved = sel.filter(e => e.type === 'LWPOLYLINE').length;  // 곡선 경로 계단
  const onSrf = sel.filter(e => wallBaseZs(e)).length;             // 표면 위 곡선/3D 선 = 높이를 곡선에서 가져옴
  logLine(`  ✔ 계단 지정 ${sel.length}개 — ${n}단 (단높이 ${(h / n).toFixed(0)}, 폭 ${w}) · 경로 방향이 올라가는 방향`
    + (curved ? ` · ${curved}개는 곡선 경로(각 단이 진행방향에 직교)` : '')
    + (onSrf ? ` · ${onSrf}개는 곡선의 시작·끝 높이를 계단 높이로 사용(단높이는 균일 유지)` : ''), 'ok');
  renderProps(); draw();
}
// ---------- 계단 기하 (직선·곡선 공용) ----------
// 경로를 단 수만큼 등분해 단별 디딤판 사각형과 윗면 높이를 산출.
// 평면 심볼과 3D 솔리드가 이 함수 하나를 공유해 서로 어긋나지 않게 한다.
// 곡선(폴리라인) 경로면 각 단이 그 지점의 진행 방향에 직교해 놓인다(L자·아치형·자유곡선 계단).
// 경로가 표면 위 곡선/3D 선이면 곡선의 시작·끝 높이가 계단의 발밑·꼭대기가 된다.
//   단높이는 어디까지나 균일하게 유지한다 — 지형을 그대로 따라가면 단높이가 제각각이 되어
//   계단으로 성립하지 않는다(균일 단높이는 건축 기본).
function stairSteps(e) {
  const b = e.bim; if (!b) return null;
  const w = b.w || 1200;
  let base = b.base || 0, h = b.h || 0;
  const pz = wallBaseZs(e);
  if (pz && pz.length >= 2) {
    const z0 = pz[0], z1 = pz[pz.length - 1];
    if (z1 - z0 > 1) { base = z0; h = z1 - z0; } // 경로 방향 = 올라가는 방향
  }
  if (h <= 0) return null;
  const n = Math.max(1, Math.ceil(h / (b.riser || 180)));
  const P = crvSampleN(e, n); // 열린 경로 → n+1점 (단 경계)
  if (!P || P.length < 2) return null;
  const steps = [];
  for (let i = 0; i < Math.min(n, P.length - 1); i++) {
    const a = P[i], c = P[i + 1];
    let tx = c[0] - a[0], ty = c[1] - a[1];
    const L = Math.hypot(tx, ty); if (L < 1e-9) continue;
    tx /= L; ty /= L;
    const nx = -ty * w / 2, ny = tx * w / 2; // 그 지점 진행방향에 직교한 디딤판 폭
    steps.push({
      quad: [[a[0] + nx, a[1] + ny], [c[0] + nx, c[1] + ny], [c[0] - nx, c[1] - ny], [a[0] - nx, a[1] - ny]],
      z1: base + h * (i + 1) / n,
      t: [tx, ty],
    });
  }
  return steps.length ? { steps, base, h, n, w, P } : null;
}
function stairSolids(e) {
  const S = stairSteps(e); if (!S) return [];
  return S.steps.map(st => ({ poly: st.quad, z0: S.base, z1: st.z1, color: '#b9b2a6' }));
}

// ---------- 난간 (railing) ----------
// 경로(직선·곡선·원)를 따라 [상단 손스침] + [일정 간격 동자기둥]을 세운다.
// 경로가 표면 위 곡선(zs)이나 3D 선(z1/z2)이면 바닥이 그 높이를 따라간다 — 벽과 같은 규약.
// 경로 정점 + 바닥 높이 (닫힌 경로도 지원) — 난간·조명 등 '경로를 따라 세우는' 요소 공용
function railingPath(e) {
  const b = e.bim; if (!b) return null;
  let V, closed;
  if (e.type === 'LINE') { V = [[e.x1, e.y1], [e.x2, e.y2]]; closed = false; }
  else if (e.type === 'LWPOLYLINE' && e.points && e.points.length >= 2) { V = e.points.map(p => [p[0], p[1]]); closed = !!e.closed && e.points.length > 2; }
  else if (e.type === 'CIRCLE') { V = circlePoly(e.cx, e.cy, e.r, 32); closed = true; }
  else return null;
  const n = V.length, nE = closed ? n : n - 1;
  if (nE < 1) return null;
  const pz = wallBaseZs(e);
  const lift = pz ? ((b.base || 0) - lvElev()) : 0;
  const zAt = i => (pz && pz[i] != null) ? pz[i] + lift : (b.base || 0); // 정점별 바닥
  const segLen = [];
  let total = 0;
  for (let k = 0; k < nE; k++) { const k2 = (k + 1) % n; const L = Math.hypot(V[k2][0] - V[k][0], V[k2][1] - V[k][1]); segLen.push(L); total += L; }
  if (total < 1e-6) return null;
  return { V, n, nE, closed, zAt, segLen, total, onSrf: !!pz };
}
// 경로를 따라 일정 간격의 '설치 지점' 산출 — 난간 동자기둥·조명 기둥 공용.
// 양 끝을 포함해 균등 배치(닫힌 경로는 끝=시작이라 하나 생략). 지점마다 바닥 높이와 진행방향을 준다.
function pathStations(P, spacing) {
  const { V, n, nE, closed, zAt, segLen, total } = P;
  const cnt = Math.max(1, Math.round(total / Math.max(1, spacing)));
  const out = [];
  for (let i = 0; i <= cnt; i++) {
    if (closed && i === cnt) break;
    const d = total * i / cnt;
    let acc = 0, k = 0;
    while (k < nE - 1 && acc + segLen[k] < d) { acc += segLen[k]; k++; }
    const k2 = (k + 1) % n, L = segLen[k] || 1;
    const u = Math.max(0, Math.min(1, (d - acc) / L));
    out.push({
      x: V[k][0] + (V[k2][0] - V[k][0]) * u,
      y: V[k][1] + (V[k2][1] - V[k][1]) * u,
      z: zAt(k) + (zAt(k2) - zAt(k)) * u,   // 지형을 따라간 바닥 높이
      ux: (V[k2][0] - V[k][0]) / L, uy: (V[k2][1] - V[k][1]) / L,
    });
  }
  return out;
}
// 설치 지점에 진행방향으로 정렬된 정사각 단면
function stationQuad(st, size) {
  const ax = st.ux * size / 2, ay = st.uy * size / 2, bx = -st.uy * size / 2, by = st.ux * size / 2;
  return [[st.x - ax - bx, st.y - ay - by], [st.x + ax - bx, st.y + ay - by],
          [st.x + ax + bx, st.y + ay + by], [st.x - ax + bx, st.y - ay + by]];
}
function railingSolids(e) {
  const P = railingPath(e); if (!P) return [];
  const b = e.bim;
  const h = b.h || 1100, t = b.t || 50, pt = b.postT || 60, sp = Math.max(100, b.spacing || 1200);
  const col = bimSolidColor(e, '#9aa2af');
  const { V, n, nE, closed, zAt, segLen, total } = P;
  const out = [];
  // 1) 상단 손스침 — 세그먼트별 얇은 밴드. 바닥 높이를 따라 기울어진다(zb/zt).
  for (let k = 0; k < nE; k++) {
    const k2 = (k + 1) % n, a = V[k], c = V[k2], L = segLen[k];
    if (L < 1e-6) continue;
    const ux = (c[0] - a[0]) / L, uy = (c[1] - a[1]) / L;
    const nx = -uy * t / 2, ny = ux * t / 2;
    const zA = zAt(k), zC = zAt(k2);
    out.push({
      poly: [[a[0] + nx, a[1] + ny], [c[0] + nx, c[1] + ny], [c[0] - nx, c[1] - ny], [a[0] - nx, a[1] - ny]],
      zb: [zA + h - t, zC + h - t, zC + h - t, zA + h - t],
      zt: [zA + h, zC + h, zC + h, zA + h],
      z0: Math.min(zA, zC) + h - t, z1: Math.max(zA, zC) + h,
      color: col, eid: e.id,
    });
  }
  // 2) 동자기둥 — 호 길이 sp 간격으로 균등 배치. 발밑은 지형 높이, 머리는 손스침 바로 아래.
  for (const st of pathStations(P, sp))
    out.push({ poly: stationQuad(st, pt), z0: st.z, z1: st.z + h - t, color: col, eid: e.id });
  return out;
}

// ============================================================
//  광원 (LightSource) — Phase 1: 지정 인프라
//  개체와 광원 정보를 분리한다: 개체에는 lightId 참조만, 속성은 state.lights 컬렉션에.
//  개체 자체는 형태·색·BIM 정체 무엇도 바뀌지 않는다.
// ============================================================
// ═══════════ IES 배광 (IESNA LM-63) ═══════════
// 실제 조명기구는 방향마다 광도가 다르다. 지금까지 모든 광원이 lm/(4π) 균등 배광이라
// 방지따람이든 집광 다운라이트든 사방으로 똑같이 쐈다 — 조도 분석 패널에도 그렇게 고지해 왔다.
// IES 파일은 제조사가 실측한 '수직각별 광도(cd)' 표다. 그걸 읽어 배광을 그대로 재현한다.
//
// 파일 구조(LM-63): 헤더… TILT=NONE 다음에 숫자만 이어진다.
//   [1] 램프수 · 램프당광속(lm) · 배율 · 수직각수 · 수평각수 · 측광형식 · 단위 · 폭 · 길이 · 높이
//   [2] 밸러스트계수 · 미래용 · 입력전력(W)
//   [3] 수직각 목록 (수직각수 개)   — 0°=바로 아래(nadir) … 180°=바로 위
//   [4] 수평각 목록 (수평각수 개)
//   [5] 광도값 (수평각수 × 수직각수 개, cd)
// 줄바꿈·공백이 제멋대로라 줄 단위로 읽으면 깨진다 → '숫자 토큰 스트림' 으로 읽는다.
function parseIES(text) {
  const t = String(text || '');
  const ti = t.search(/TILT\s*=/i);
  if (ti < 0) return { err: 'TILT= 줄이 없습니다 — IES(LM-63) 파일이 아닌 것 같습니다.' };
  let rest = t.slice(ti);
  const nl = rest.indexOf('\n');
  const tiltLine = nl < 0 ? rest : rest.slice(0, nl);
  if (!/TILT\s*=\s*NONE/i.test(tiltLine)) return { err: 'TILT=NONE 만 지원합니다 (기울기표가 포함된 파일).' };
  rest = nl < 0 ? '' : rest.slice(nl + 1);
  const num = rest.replace(/,/g, ' ').match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g);
  if (!num || num.length < 13) return { err: '숫자 데이터가 부족합니다.' };
  const N = num.map(Number);
  let i = 0;
  const lamps = N[i++], lumensPerLamp = N[i++], mult = N[i++];
  const nV = N[i++], nH = N[i++];
  const photoType = N[i++];
  i++;      // units
  i += 3;   // width, length, height
  const ballast = N[i++];
  i++;      // future use
  i++;      // input watts
  if (!(nV > 0 && nH > 0)) return { err: `각도 개수가 이상합니다 (수직 ${nV}, 수평 ${nH}).` };
  const vAng = N.slice(i, i + nV); i += nV;
  const hAng = N.slice(i, i + nH); i += nH;
  const need = nV * nH;
  const cand = N.slice(i, i + need);
  if (cand.length < need) return { err: `광도값이 모자랍니다 (${cand.length}/${need}).` };
  // 배율·밸러스트계수 적용. 수평각이 여러 개면 축대칭이 아니지만 셰이더가 축대칭만 지원하므로
  // 수평 방향으로 평균 낸다 (사용자에게 근사임을 알린다).
  const k = (mult || 1) * (ballast || 1);
  const byV = new Array(nV).fill(0);
  for (let v = 0; v < nV; v++) {
    let sum = 0;
    for (let h = 0; h < nH; h++) sum += cand[h * nV + v] * k;
    byV[v] = sum / nH;
  }
  return { vAng, cd: byV, nH, photoType, lumens: (lamps || 1) * (lumensPerLamp || 0), axial: nH <= 1 };
}
// 수직각(°) → 광도(cd) 선형보간. 표 밖은 양 끝 값으로 물린다.
function iesCandelaAt(ies, deg) {
  const a = ies.vAng, c = ies.cd, n = a.length;
  if (!n) return 0;
  if (deg <= a[0]) return c[0];
  if (deg >= a[n - 1]) return c[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (a[m] <= deg) lo = m; else hi = m; }
  const t = (deg - a[lo]) / ((a[hi] - a[lo]) || 1);
  return c[lo] + (c[hi] - c[lo]) * t;
}
// IES 표 → 셰이더가 기대하는 텍스처.
// 셰이더(light_sampling_functions.glsl 의 getPhotometricAttenuation):
//     float angle = acos( dot(posToLight, lightDir) ) / PI;   // 0=정면축, 1=정반대
//     return texture2D( iesProfiles, vec3(angle, 0.0, iesProfile) ).r;
// 즉 가로축 = 정면축에서 벌어진 각(0~180° → 0~1), R = 광도 배율. 축대칭만 지원(v=0 고정).
// 스팟의 정면축은 target 방향(우리는 아래)이고 IES 수직각 0° 도 nadir 라 각이 그대로 대응한다.
// 값은 최대 광도로 정규화한다 — 절대 밝기는 루멘(intensity)이 담당하고 여기선 '모양' 만 준다.
const IES_TEX_W = 180;
function iesToTexture(ies, T3) {
  let mx = 0;
  for (const v of ies.cd) if (v > mx) mx = v;
  if (!(mx > 0)) return null;
  const data = new Float32Array(IES_TEX_W * 4);
  for (let x = 0; x < IES_TEX_W; x++) {
    const deg = (x + 0.5) / IES_TEX_W * 180;
    const r = iesCandelaAt(ies, deg) / mx;
    data[x * 4] = r; data[x * 4 + 1] = r; data[x * 4 + 2] = r; data[x * 4 + 3] = 1;
  }
  const tex = new T3.DataTexture(data, IES_TEX_W, 1, T3.RGBAFormat, T3.FloatType);
  tex.minFilter = T3.LinearFilter; tex.magFilter = T3.LinearFilter;
  tex.wrapS = tex.wrapT = T3.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}
// 배광의 입체각 적분 ∫f(θ)dΩ = 2π ∫₀^π f(θ)·sinθ dθ   (축대칭, f 는 최대=1 로 정규화된 모양)
// 이게 있어야 '광속(lm) 보존' 이 성립한다:
//   광도 I(θ) = lm · f(θ) / ∫f dΩ   →   ∫I dΩ = lm  (정의상)
// 균등 배광이면 f≡1 → ∫f dΩ = 4π → I = lm/(4π) 로 기존 식과 정확히 같아진다(연속성 확인).
// ★ 이게 없으면 IES 가 '모양만' 바꾸고 광속을 깎는다 — 집광 배광인데 중심이 안 밝아진다.
//   (실측: 집광 IES 를 붙였는데 중심 222 로 그대로, 주변만 65→37 로 어두워졌다. 광속이 샜다.)
function iesFluxFactor(ies) {
  if (!ies || !ies.cd || !ies.cd.length) return 4 * Math.PI;
  let mx = 0;
  for (const v of ies.cd) if (v > mx) mx = v;
  if (!(mx > 0)) return 4 * Math.PI;
  const N = 720;
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const th = (i + 0.5) / N * Math.PI;
    sum += (iesCandelaAt(ies, th * 180 / Math.PI) / mx) * Math.sin(th) * (Math.PI / N);
  }
  return Math.max(1e-6, 2 * Math.PI * sum);
}
// 광원의 '정면축 기준 각도(rad)' 에서의 광도(cd). 배광이 없으면 균등.
// 렌더러(3D 미리보기)·조도 분석·Raytraced 가 모두 이 한 함수를 쓴다 → 셋이 어긋날 수 없다.
//   lm  : 광속
//   ies : 배광 (없으면 균등)
//   ang : 광원의 정면축(아래)에서 벌어진 각 [rad]
function lightCandela(lm, ies, ang) {
  const flux = lm || 0;
  if (!ies) return flux / (4 * Math.PI);
  let mx = 0;
  for (const v of ies.cd) if (v > mx) mx = v;
  if (!(mx > 0)) return flux / (4 * Math.PI);
  const f = iesCandelaAt(ies, (ang || 0) * 180 / Math.PI) / mx;
  return flux * f / iesFluxFactor(ies);
}

// 배광의 '모양' 요약 — 파일이 제대로 읽혔는지 사용자가 알아볼 수 있게.
// 빔각 = 최대 광도의 50% 가 되는 각 × 2 (조명업계 관례)
function iesSummary(ies) {
  let mx = 0, mxAt = 0;
  for (let i = 0; i < ies.cd.length; i++) if (ies.cd[i] > mx) { mx = ies.cd[i]; mxAt = ies.vAng[i]; }
  // 50% 가 되는 각을 이분법으로 정확히 찾는다. 1° 단위로 훑으면 경계각을 통째로 넘겨
  // 빔각이 몇 도씩 틀린다(실측: 참값 60° 인 파일에서 62° 로 나왔다).
  let half = null;
  const halfCd = mx * 0.5;
  if (iesCandelaAt(ies, 180) < halfCd) {
    let lo = 0, hi = 180;
    for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (iesCandelaAt(ies, m) >= halfCd) lo = m; else hi = m; }
    half = (lo + hi) / 2;
  }
  return { maxCd: Math.round(mx), maxAt: mxAt, beamDeg: half != null ? Math.round(half * 2 * 10) / 10 : null };
}

// 배광이 사실상 끝나는 각(°) — 최대 광도의 2% 아래로 떨어지는 마지막 각.
// 렌더링 뷰의 SpotLight 원뿔 근사에 쓴다 (정확한 배광 모양은 raytrace 가 그린다).
function iesCutoffDeg(ies) {
  let mx = 0;
  for (const v of ies.cd) if (v > mx) mx = v;
  if (!(mx > 0)) return 180;
  let last = 0;
  for (let d = 0; d <= 180; d++) if (iesCandelaAt(ies, d) >= mx * 0.02) last = d;
  return Math.max(1, last);
}
const LIGHT_TYPES = ['emissive', 'point', 'spot', 'area'];
const LIGHT_TYPE_KO = { emissive: '발광면(개체 그대로)', point: '점광원', spot: '스팟', area: '면광원' };
// 사용자 대면 단위는 루멘(lm)·켈빈(K)으로 통일한다. 렌더러 내부 단위로의 환산은 이 아래 두 함수에만 둔다.
const LM_REF = 800;            // 다운라이트 기본값. 이 값이 내부 밝기 1이 되도록 맞춘다.
function lmToPower(lm) { return (lm == null ? LM_REF : lm) / LM_REF; }
// 색온도(K) → RGB. Planckian locus 근사 (Tanner Helland).
function kelvinToRGB(K) {
  const t = Math.max(1000, Math.min(40000, K || 3000)) / 100;
  const cl = v => Math.max(0, Math.min(255, v));
  let r, g, b;
  if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; }
  else { r = 329.698727446 * Math.pow(t - 60, -0.1332047592); g = 288.1221695283 * Math.pow(t - 60, -0.0755148492); }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [Math.round(cl(r)), Math.round(cl(g)), Math.round(cl(b))];
}
function lightColorRGB(L) { return (L && L.color) ? L.color : kelvinToRGB(L ? L.colorTemp : 3000); }
function lightDefaults() {
  return { type: 'emissive', enabled: true, intensity: LM_REF, colorTemp: 3000, color: null,
    spotAngleDeg: 60, spotPenumbra: 0.2,
    ies: null,        // {name, vAng[], cd[], nH, axial, lumens} — IES 배광. 있으면 균등 배광 대신 이걸 쓴다
    iesRadius: 0,     // 광원 반지름(mm) — 0보다 크면 면적을 가진 스팟 = 부드러운 그림자
    // 아래 셋은 현재 소프트웨어 렌더러용 힌트 — Phase 2(패스트레이싱)에서 물리 기반으로 대체된다
    range: LIGHT_RANGE_DEF, soft: 400, bounce: 0.5 };
}
const LIGHT_PRESETS = [
  { n: '다운라이트', intensity: 800, colorTemp: 3000 },
  { n: '형광등', intensity: 3300, colorTemp: 4000 },
  { n: '간접등', intensity: 1500, colorTemp: 2700 },
  { n: '주광색 LED', intensity: 2000, colorTemp: 6500 },
];
function lightById(id) { for (const L of state.lights) if (L.id === id) return L; return null; }
function lightOfEnt(e) { return (e && e.lightId) ? lightById(e.lightId) : null; }
function entById(id) { for (const e of state.entities) if (e.id === id) return e; return null; }
const LIGHTABLE = ['LINE', 'LWPOLYLINE', 'CIRCLE', 'MESH'];
function lightableEnt(e) { return !!e && LIGHTABLE.includes(e.type); }
// 개체가 지워지면 연결된 광원도 사라진다. undo는 state.lights를 통째로 스냅샷하므로 함께 복원된다.
// 단 '파일을 열 때부터 개체가 없던 광원'(_missing)은 지우지 않는다 — 조용히 없애면 사용자가
// 도면이 손상된 사실을 모른 채 저장해 영영 잃는다. 경고만 남기고 목록에 보이게 둔다.
function pruneLights() {
  if (!state.lights.length) return;
  const ids = new Set(state.entities.map(e => e.id));
  for (let i = state.lights.length - 1; i >= 0; i--) {
    const L = state.lights[i];
    if (!ids.has(L.objectId) && !L._missing) state.lights.splice(i, 1);
  }
}
let soloLightId = null; // 이 광원만 켜서 등기구 하나의 기여를 본다 (표시 상태이므로 저장하지 않는다)

// ---------- 발광 지점 ----------
// light는 형상을 만들지 않는다 — 선택한 개체 자체가 발광원이 된다.
// 그래서 조명 기구는 사용자가 원하는 대로 직접 모델링하고, 빛이 나올 자리만 지정하면 된다.
// 발광 높이는 묻지 않고 개체가 놓인 z를 그대로 쓴다. z 규약은 3D 밑그림(렌더러)과 동일하게
// 맞춘다 — 레벨 높이 + zo, 정점별 z(zs·z1/z2)가 있으면 그것. 어긋나면 광원만 엉뚱한 높이에 뜬다.
function lightPath(e, zb) {
  let V, closed, ZS;
  if (e.type === 'LINE') {
    V = [[e.x1, e.y1], [e.x2, e.y2]]; closed = false;
    ZS = [e.z1 != null ? e.z1 : zb, e.z2 != null ? e.z2 : zb];
  } else if (e.type === 'LWPOLYLINE' && e.points && e.points.length >= 2) {
    V = e.points.map(p => [p[0], p[1]]); closed = !!e.closed && e.points.length > 2;
    ZS = e.points.map((p, i) => polyZ(e, i, zb));
  } else return null;
  const n = V.length, nE = closed ? n : n - 1;
  if (nE < 1) return null;
  const segLen = []; let total = 0;
  for (let k = 0; k < nE; k++) { const k2 = (k + 1) % n; const L = Math.hypot(V[k2][0] - V[k][0], V[k2][1] - V[k][1]); segLen.push(L); total += L; }
  if (total < 1e-6) return null;
  return { V, n, nE, closed, zAt: i => ZS[i], segLen, total };
}
// 입체로 그려지는 개체(box·extrude 결과 등)의 z 범위. box는 MESH가 아니라
// 'LWPOLYLINE + bim{kind:column}'이라 bim에서 높이를 읽어야 한다.
// ═══════════ 태양 ═══════════
// 건축에서 빛의 주인공. 위도·경도·날짜·시각이 정해지면 태양의 위치는 하나로 결정된다.
// NOAA Solar Position Algorithm. 대기 굴절은 보정하지 않는다(지평선 근처에서 실제보다
// 0.5° 가량 낮게 나온다 — 건축 그림자 검토에는 영향이 없는 수준).
const SUN_D2R = Math.PI / 180, SUN_R2D = 180 / Math.PI;
const sunMod = (a, n) => ((a % n) + n) % n;
function sunDefaults() {
  return {
    enabled: false,
    lat: 37.5665, lon: 126.9780, tz: 540,   // 서울 · KST(UTC+9)
    y: 2026, mo: 6, d: 21, h: 12, mi: 0,
    north: 0,        // 진북 방위 — 평면의 +Y 에서 시계방향으로 몇 도 돌아갔나
    turbidity: 3,    // 대기 탁도 — 2=매우 맑음 … 10=뿌옇게 흐림
    cloud: 0,        // 운량(%) — 0=맑음 … 100=완전히 흐림. 탁도와 다른 축이다(아래 skyCloud 참고)
  };
}
function sunState() { return state.sun || (state.sun = sunDefaults()); }
// 지역시 → UTC → 율리우스일
function sunJulianDay(S) {
  return (Date.UTC(S.y, S.mo - 1, S.d, S.h, S.mi) - S.tz * 60000) / 86400000 + 2440587.5;
}
// 반환: alt=고도(°, 지평선 위가 +), az=방위(°, 진북에서 시계방향), decl=적위, eot=균시차(분)
function solarPosition(S) {
  const jc = (sunJulianDay(S) - 2451545) / 36525;                    // 율리우스 세기
  const gmls = sunMod(280.46646 + jc * (36000.76983 + jc * 0.0003032), 360);  // 기하평균 황경
  const gmas = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);      // 기하평균 근점이각
  const ecc = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);  // 궤도 이심률
  const ctr = Math.sin(gmas * SUN_D2R) * (1.914602 - jc * (0.004817 + 0.000014 * jc))
    + Math.sin(2 * gmas * SUN_D2R) * (0.019993 - 0.000101 * jc)
    + Math.sin(3 * gmas * SUN_D2R) * 0.000289;                       // 중심차
  const appLong = gmls + ctr - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * jc) * SUN_D2R);
  const moe = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const obl = moe + 0.00256 * Math.cos((125.04 - 1934.136 * jc) * SUN_D2R);   // 황도경사 보정
  const decl = Math.asin(Math.sin(obl * SUN_D2R) * Math.sin(appLong * SUN_D2R)) * SUN_R2D;
  const vy = Math.tan(obl / 2 * SUN_D2R) ** 2;
  const eot = 4 * SUN_R2D * (vy * Math.sin(2 * gmls * SUN_D2R)
    - 2 * ecc * Math.sin(gmas * SUN_D2R)
    + 4 * ecc * vy * Math.sin(gmas * SUN_D2R) * Math.cos(2 * gmls * SUN_D2R)
    - 0.5 * vy * vy * Math.sin(4 * gmls * SUN_D2R)
    - 1.25 * ecc * ecc * Math.sin(2 * gmas * SUN_D2R));              // 균시차(분)
  // 진태양시 — 경도와 표준시 자오선의 차이(4분/°)와 균시차를 시계 시각에 더한다
  const tst = sunMod(S.h * 60 + S.mi + eot + 4 * S.lon - S.tz, 1440);
  const ha = tst / 4 < 0 ? tst / 4 + 180 : tst / 4 - 180;            // 시간각(°)
  const latR = S.lat * SUN_D2R, declR = decl * SUN_D2R;
  const cz = Math.sin(latR) * Math.sin(declR)
    + Math.cos(latR) * Math.cos(declR) * Math.cos(ha * SUN_D2R);
  const zen = Math.acos(Math.min(1, Math.max(-1, cz))) * SUN_R2D;    // 천정각
  let az;
  const denom = Math.cos(latR) * Math.sin(zen * SUN_D2R);
  if (Math.abs(denom) < 1e-9) az = ha > 0 ? 180 : 0;                 // 천정/지평 특이점
  else {
    const c = Math.min(1, Math.max(-1,
      (Math.sin(latR) * Math.cos(zen * SUN_D2R) - Math.sin(declR)) / denom));
    az = ha > 0 ? sunMod(Math.acos(c) * SUN_R2D + 180, 360)
      : sunMod(540 - Math.acos(c) * SUN_R2D, 360);
  }
  return { alt: 90 - zen, az, decl, eot };
}
// 태양을 향하는 단위벡터 (씬 좌표계). 진북 보정 포함.
// 평면 규약: 기본 진북 = +Y, 동쪽 = +X, 위 = +Z.
function sunDirection(S) {
  const p = solarPosition(S);
  const a = (p.az - (S.north || 0)) * SUN_D2R, h = p.alt * SUN_D2R;
  return { x: Math.sin(a) * Math.cos(h), y: Math.cos(a) * Math.cos(h), z: Math.sin(h), alt: p.alt, az: p.az };
}
// 남중 시각(분, 지역시) — 그 날 태양이 가장 높이 뜨는 시각
function sunNoonMinutes(S) {
  const p = solarPosition(S);
  return sunMod(720 - 4 * S.lon + S.tz - p.eot, 1440);
}

// ─── 직달 일사 ───
// 태양의 각지름은 0.53°(각반경 0.265°). 이 크기가 그림자 반음영을 만든다 —
// 건축 사진에서 그림자 가장자리가 부드러운 이유이고, 델타 광원으로는 재현되지 않는다.
const SUN_ANG_RADIUS = 0.265 * SUN_D2R;
const SUN_SOLID_ANGLE = Math.PI * SUN_ANG_RADIUS * SUN_ANG_RADIUS;  // ≈ 6.8e-5 sr
const SUN_E0_LUX = 128000;   // 대기권 밖 태양 조도(태양 광도상수). 실측 물리상수.
// Kasten-Young(1989) 상대 대기질량 — 지평선 근처에서 1/cos 근사가 발산하는 것을 막는다
function sunAirMass(altDeg) {
  const z = 90 - Math.max(-1, altDeg);
  return 1 / (Math.cos(z * SUN_D2R) + 0.50572 * Math.pow(Math.max(1e-3, 96.07995 - z), -1.6364));
}
// Kasten(1996) 레일리 광학두께
function sunRayleighDepth(m) {
  return 1 / (6.6296 + 1.7513 * m - 0.1202 * m * m + 0.0065 * m ** 3 - 0.00013 * m ** 4);
}
// 직달 법선 조도(lux). Linke 탁도 T 로 소광. E = E0 · exp(−T · δR(m) · m)
// 검산: T=2, 태양 천정(m=1) → 128000·exp(−2·0.121) ≈ 100,500 lx.
//       교과서의 '맑은 날 정오 직달조도 ≈ 100,000 lx' 와 일치한다 — 상수를 맞춘 게 아니라 맞아떨어진 것.
// 운량 → 사람이 읽는 날씨 이름 (기상 관례의 대략적 구간)
function weatherName(cc) {
  const p = Math.round(cc * 100);
  if (p <= 10) return '맑음';
  if (p <= 40) return '구름 조금';
  if (p <= 70) return '구름 많음';
  if (p < 100) return '흐림';
  return '완전히 흐림';
}
// 운량 0~1. 탁도와 혼동하면 안 된다:
//   탁도 = 대기의 '뿌옇기'(에어로졸). Preetham 은 이걸로 맑은 하늘의 색·분포만 바꾼다.
//   운량 = 구름이 하늘을 덮은 비율. 구름은 태양을 가리고 하늘을 균일한 회색으로 만든다.
// Preetham 은 애초에 '맑은 하늘' 모델이라 탁도를 아무리 올려도 흐린 날이 되지 않는다.
// (그래서 탁도는 2~6 으로 묶어 뒀다 — 그 밖은 이 모델이 보증하지 않는다.)
const skyCloud = (S) => Math.min(1, Math.max(0, (S && S.cloud || 0) / 100));
// 구름이 없을 때의 직달 법선 조도 [lx] — 하늘 모델의 기준값이다.
function sunDirectIlluminanceClear(S) {
  const alt = solarPosition(S).alt;
  if (alt <= 0) return 0;
  const m = sunAirMass(alt);
  return SUN_E0_LUX * Math.exp(-Math.max(1, S.turbidity) * sunRayleighDepth(m) * m);
}
// 실제 직달 조도 — 구름에 가려진 만큼 준다.
// (1-cc) 는 '태양이 구름에 가려지지 않은 비율' 근사다. 완전히 흐리면(cc=1) 직달은 0 이고
// 그림자도 사라진다 — 흐린 날 그림자가 없는 게 바로 이것이다.
// 이 함수가 직달의 유일한 진실이라, 여기에 운량을 넣으면 소프트웨어 뷰·렌더링 뷰·
// 레이트레이싱·조도 분석이 전부 자동으로 따라온다 (sunLight/rviewSyncSun/rtMakeSky 가 이걸 쓴다).
function sunDirectIlluminance(S) {
  return sunDirectIlluminanceClear(S) * (1 - skyCloud(S));
}
// 태양 원반의 휘도(cd/m²) = 직달조도 / 입체각.
// 검산: 맑은 날 ≈ 100000/6.8e-5 ≈ 1.5e9 cd/m² — 알려진 태양 휘도 1.6e9 과 같은 자릿수.
function sunDiskLuminance(S) { return sunDirectIlluminance(S) / SUN_SOLID_ANGLE; }

// ─── 물리 하늘 (Preetham et al. 1999, "A Practical Analytic Model for Daylight") ───
// 탁도 T 하나로 맑음~뿌연 하늘을 만든다. 결과는 cd/m² 이라 그대로 HDR 환경맵이 된다.
function preethamCoeffs(T) {
  return {
    Y: [0.1787 * T - 1.4630, -0.3554 * T + 0.4275, -0.0227 * T + 5.3251, 0.1206 * T - 2.5771, -0.0670 * T + 0.3703],
    x: [-0.0193 * T - 0.2592, -0.0665 * T + 0.0008, -0.0004 * T + 0.2125, -0.0641 * T - 0.8989, -0.0033 * T + 0.0452],
    y: [-0.0167 * T - 0.2608, -0.0950 * T + 0.0092, -0.0079 * T + 0.2102, -0.0441 * T - 1.6537, -0.0109 * T + 0.0529],
  };
}
// Perez 광휘 분포 함수
function perezF(c, theta, gamma) {
  const ct = Math.max(0.01, Math.cos(theta));
  return (1 + c[0] * Math.exp(c[1] / ct)) * (1 + c[2] * Math.exp(c[3] * gamma) + c[4] * Math.cos(gamma) ** 2);
}
// 천정 휘도·색도
function preethamZenith(T, thS) {
  const chi = (4 / 9 - T / 120) * (Math.PI - 2 * thS);
  const Yz = Math.max(0, (4.0453 * T - 4.9710) * Math.tan(chi) - 0.2155 * T + 2.4192) * 1000; // kcd/m² → cd/m²
  const t = thS, t2 = t * t, t3 = t2 * t, T2 = T * T;
  const xz = (0.00166 * t3 - 0.00375 * t2 + 0.00209 * t) * T2
    + (-0.02903 * t3 + 0.06377 * t2 - 0.03202 * t + 0.00394) * T
    + (0.11693 * t3 - 0.21196 * t2 + 0.06052 * t + 0.25886);
  const yz = (0.00275 * t3 - 0.00610 * t2 + 0.00317 * t) * T2
    + (-0.04214 * t3 + 0.08970 * t2 - 0.04153 * t + 0.00516) * T
    + (0.15346 * t3 - 0.26756 * t2 + 0.06670 * t + 0.26688);
  return { Yz, xz, yz };
}
// 하늘 한 방향의 분광 휘도 → 선형 sRGB (cd/m²).
//   theta = 천정으로부터의 각, gamma = 태양과 이루는 각, thS = 태양의 천정각
// 계수는 (탁도, 태양 천정각) 만의 함수다 — 한 장의 하늘을 구울 때는 내내 같은 값이다.
// 그런데 텍셀마다 다시 계산하고 있었다: 배열 3개 할당 + tan/거듭제곱 수십 번을
// 레이트레이싱 환경맵(1024x512 = 52만 텍셀)마다 반복했다. 한 칸짜리 캐시로 충분하다.
let _preK = '', _preV = null;
function preethamCache(T, thS) {
  const k = T + '|' + thS;
  if (_preK === k && _preV) return _preV;
  _preK = k; _preV = { c: preethamCoeffs(T), z: preethamZenith(T, thS) };
  return _preV;
}
function skyRadiance(theta, gamma, thS, T) {
  const P = preethamCache(T, thS), c = P.c, z = P.z;
  const th = Math.min(theta, Math.PI / 2 - 0.001);          // 지평선 아래는 지평선 값으로
  const d = (co, zv) => zv * perezF(co, th, gamma) / perezF(co, 0, thS);
  const Y = Math.max(0, d(c.Y, z.Yz));
  const x = d(c.x, z.xz), y = d(c.y, z.yz);
  if (y <= 1e-6) return [0, 0, 0];
  const X = x * Y / y, Z = (1 - x - y) * Y / y;             // xyY → XYZ
  return [                                                   // XYZ → 선형 sRGB
    Math.max(0, 3.2406 * X - 1.5372 * Y - 0.4986 * Z),
    Math.max(0, -0.9689 * X + 1.8758 * Y + 0.0415 * Z),
    Math.max(0, 0.0557 * X - 0.2040 * Y + 1.0570 * Z),
  ];
}
// 지표면(태양 아래쪽 반구)의 색 — 하늘만 있으면 아래에서 오는 빛이 0이라 부자연스럽다.
const SKY_GROUND_ALBEDO = 0.2;
// Preetham 은 '맑은 하늘' 모델이다. 탁도를 올려도 구름 낀 하늘이 되지 않는다.
// 실측(하늘 반구 적분, 서울 하지 남중): 탁도 2→전천공 120,559 lx · 3→119,183 · 6→122,366 ·
// 10→135,446. 탁해질수록 전천공 조도가 늘어나는 건 에너지가 생기는 것이라 비물리다.
// 2~3 은 산란이 직달→확산으로 옮겨가는 것뿐이라 전천공이 거의 평평하다(정상).
// 그래서 이 범위로 제한한다. 진짜 흐린 하늘(10,000~25,000 lx)은 CIE 흐림 모델이 필요하고
// 그건 로드맵 C(날씨)의 몫이다.
const SKY_TURBIDITY_MIN = 2, SKY_TURBIDITY_MAX = 6;
const skyTurbidity = (S) => Math.min(SKY_TURBIDITY_MAX, Math.max(SKY_TURBIDITY_MIN, S.turbidity || 3));

function bimZSpan(b) {
  if (!b) return null;
  const base = b.base || 0;
  switch (b.kind) {
    case 'wall': case 'column': case 'stair': case 'railing': return [base, base + (b.h || 0)];
    case 'slab': { const top = b.top || 0; return [top - (b.t || 0), top]; }
    case 'roof': { const ev = b.eave || 0; return [ev, ev + (b.rise || 0)]; }
  }
  return null;
}
// 빛이 실제로 나오는 지점들.
//  · 입체(정육면체 등) = 그 입체 한가운데 → "정육면체 광원체"
//  · 메시 = 형상 한가운데
//  · 순수 곡선 = 원이면 중심, 선·폴리라인이면 간격마다(선형 광원)
function lightEmitters(e, L) {
  const out = [];
  const center = () => { // 개체의 3D 바운딩 중심
    if (e.type === 'MESH') {
      if (!e.tris || !e.tris.length) return null;
      const bb = meshBBox(e);
      let zm = 1e18, zM = -1e18;
      for (const t of e.tris) for (const p of t) { if (p[2] < zm) zm = p[2]; if (p[2] > zM) zM = p[2]; }
      return { x: (bb.xmin + bb.xmax) / 2, y: (bb.ymin + bb.ymax) / 2, z: (zm + zM) / 2 };
    }
    const bb = entityBBox(e); if (!bb) return null;
    const zs = bimZSpan(e.bim);
    const zb = (state.levels[e.lv || 0] || { elev: 0 }).elev + (e.zo || 0);
    return { x: (bb.xmin + bb.xmax) / 2, y: (bb.ymin + bb.ymax) / 2, z: zs ? (zs[0] + zs[1]) / 2 : zb };
  };
  // point/spot/area = 개체의 바운딩 중심에 놓이는 추상 광원 (emissive가 비쌀 때의 대안)
  if (L && L.type && L.type !== 'emissive') { const c = center(); if (c) out.push(c); return out; }
  // emissive = 개체의 지오메트리 자체가 발광면
  if (e.type === 'MESH' || bimZSpan(e.bim)) { const c = center(); if (c) out.push(c); return out; }
  const zb = (state.levels[e.lv || 0] || { elev: 0 }).elev + (e.zo || 0);
  if (e.type === 'CIRCLE') { out.push({ x: e.cx, y: e.cy, z: zb }); return out; }
  const P = lightPath(e, zb); if (!P) return out;
  for (const st of pathStations(P, Math.max(100, (L && L.spacing) || 3000))) out.push({ x: st.x, y: st.y, z: st.z });
  return out;
}
// 모든 광원의 기즈모 위치 (꺼진 것 포함) — 뷰포트 전구 아이콘용
function lightGizmos() {
  const out = [];
  const byId = new Map(state.entities.map(e => [e.id, e]));
  for (const L of state.lights) {
    const e = byId.get(L.objectId); if (!e) continue;
    const lay = getLayer(e.layer); if (lay && !lay.visible) continue;
    const p = lightEmitters(e, L)[0]; if (!p) continue;
    out.push({ x: p.x, y: p.y, z: p.z, on: L.enabled && (!soloLightId || soloLightId === L.id), id: L.id, eid: e.id });
  }
  return out;
}
// ---------- 실제 광원 (지정한 개체 → 3D 셰이딩) ----------
// v3.lighting이 켜졌을 때만 동작한다. 꺼져 있으면(기본) 셰이딩 식이 예전 그대로라 기존 화면 불변.
const NIGHT_AMBIENT = 0.16; // 야간 환경광 — 광원이 닿지 않는 곳의 최소 밝기
const sunOn = () => !!(state.sun && state.sun.enabled);
// 조도(lux) → 이 렌더러의 밝기 단위. 직사광과 같은 자를 쓴다:
//   직사광 q = dot × SUN_LIT_POWER×(직달/100,000) × LIT_GAIN = (직달×dot) × LIT_GAIN×SUN_LIT_POWER/100,000
// 그래서 어떤 조도든 이 계수를 곱하면 직사광과 같은 척도가 되고, 천공광/직사광의 '비'가
// 저절로 물리값과 맞는다. 상수를 따로 맞출 필요가 없다.
// ★ 함수로 둔 이유: LIT_GAIN·SUN_LIT_POWER 는 아래에서 정의된다. const 로 두면 TDZ 라
//   로드 시점에 ReferenceError 로 앱 전체가 죽는다(실제로 그렇게 짰다가 잡았다).
const shadePerLux = () => LIT_GAIN * SUN_LIT_POWER / 100000;
const LIT_SKY = [0, 0, 0];
// 면이 받는 천공광. 태양이 꺼져 있으면 예전의 야간 환경광 그대로.
// 검산: 맑은 날 남중, 위를 보는 면 → 24,161 lx × SHADE_PER_LUX = 0.29
//       (예전에 쓰던 상수 0.30 과 거의 같다 — 상수가 '평균적으로는' 맞았다는 뜻)
//       아래를 보는 면 9,359 lx → 0.11 · 북향 벽 17,133 lx → 0.21 · 남향 벽 20,932 lx → 0.25
// ─── 천공광 가림 ───
// 이게 없으면 실내에도 하늘빛이 그대로 들어와 방 전체가 균일하게 밝다.
// 슬릿 하나로 들어온 빛줄기를 보려면 나머지가 어두워야 한다 — 빛의 연출의 핵심.
// 법선 반구를 코사인 가중으로 훑어 '하늘이 보이는 비율'을 구한다.
// 고정 표본이라 프레임마다 얼룩이 어른거리지 않는다(난수를 쓰면 흔들린다).
const SKY_OCC_N = 12;
const SKY_OCC_DIRS = (() => {
  const a = [];
  for (let i = 0; i < SKY_OCC_N; i++) {
    const r = Math.sqrt((i + 0.5) / SKY_OCC_N);   // 원반 균일 표본 = 코사인 가중 반구
    const th = i * 2.399963229728653;             // 황금각 — 고르게 퍼진다
    a.push([r * Math.cos(th), r * Math.sin(th), Math.sqrt(Math.max(0, 1 - r * r))]);
  }
  return a;
})();
function skyVis(wx, wy, wz, nx, ny, nz) {
  if (!v3._occ || !v3._occ.length || v3._fast) return 1;
  // 법선 기준 접선 좌표계 (법선과 평행하지 않은 보조축을 고른다)
  const ax = Math.abs(nz) < 0.9 ? 0 : 1, az = Math.abs(nz) < 0.9 ? 1 : 0;
  let ux = ny * az, uy = nz * ax - nx * az, uz = -ny * ax;
  const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
  const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
  const D = Math.max(20000, (v3.fit || 10000) * 4);   // 이보다 멀면 하늘로 본다
  const ox = wx + nx * 2, oy = wy + ny * 2, oz = wz + nz * 2;  // 그림자 여드름 방지
  let vis = 0;
  for (const t of SKY_OCC_DIRS) {
    const dx = ux * t[0] + vx * t[1] + nx * t[2];
    const dy = uy * t[0] + vy * t[1] + ny * t[2];
    const dz = uz * t[0] + vz * t[1] + nz * t[2];
    if (!shadowed(ox, oy, oz, ox + dx * D, oy + dy * D, oz + dz * D)) vis++;
  }
  return vis / SKY_OCC_N;
}
function litSky(nx, ny, nz, wx, wy, wz) {
  // renderScene 이 프레임당 한 번 접어둔다. 그 밖에서 부르면(테스트 등) 그때 접는다.
  const SH = (typeof v3 !== 'undefined' && v3) ? (v3._sh || skySH()) : null;
  if (!SH || !sunOn()) { LIT_SKY[0] = LIT_SKY[1] = LIT_SKY[2] = NIGHT_AMBIENT; return; }
  skyIrradiance(SH, nx, ny, nz, LIT_SKY);
  let k = shadePerLux();
  if (wx !== undefined) k *= skyVis(wx, wy, wz, nx, ny, nz);   // 하늘이 가려진 만큼 어둡게
  LIT_SKY[0] *= k; LIT_SKY[1] *= k; LIT_SKY[2] *= k;
}
function litAmbient() { litSky(0, 0, 1); return (LIT_SKY[0] + LIT_SKY[1] + LIT_SKY[2]) / 3; }
// litFace가 방금 계산한 채널별 밝기 [r, g, b, tinted?]. 반환값(스칼라)과 함께 바로 읽어 쓴다.
// 루프 안에서 매번 배열을 새로 만들지 않으려고 공용 버퍼를 쓴다 (면 수만큼 호출되는 자리).
const LIT_RGB = [1, 1, 1, 0];
// 밝기 상한과 '무릎'. 광원이 여러 개면 밝기 합이 상한을 훌쩍 넘어(좁은 방에서 2.9까지)
// 그냥 잘라내면 전부 같은 값이 되어 감쇠도 그림자 계조도 사라진다 — 화면이 하얗게 뜨는 원인.
// 무릎 아래는 손대지 않고(어두운 곳의 느낌 보존) 그 위만 지수적으로 압축해 상한에 점근시킨다.
// 카메라의 하이라이트 롤오프와 같은 방식 — 아무리 밝아도 계조가 남는다.
const LIT_MAX = 1.5, LIT_KNEE = 0.9, LIT_MIN = 0.05;
// 광원 1개의 기본 세기(power=1일 때). 실측으로 정한 값 — 이보다 낮추면 실외에 가로등 하나
// 세웠을 때 바닥 색이 그대로라 켠 티가 안 나고, 높이면 실내에서 광원들이 합쳐져 계조가 뭉갠다.
// LIGHT_RANGE_DEF와 짝이다: 둘 중 하나만 바꾸면 실내·실외 중 한쪽이 무너진다.
const LIT_GAIN = 2.7;
const LIGHT_RANGE_DEF = 3000; // 밝기가 절반이 되는 기본 거리
function toneMap(v) {
  if (v <= LIT_KNEE) return Math.max(LIT_MIN, v);
  return LIT_KNEE + (LIT_MAX - LIT_KNEE) * (1 - Math.exp(-(v - LIT_KNEE) / (LIT_MAX - LIT_KNEE)));
}
// 태양을 '아주 멀리 있는 점광원' 으로 만든다. 그러면 litFace·visFraction·그림자·소프트섀도우를
// 한 줄도 고치지 않고 그대로 쓸 수 있다.
//  · range 를 거리보다 훨씬 크게  → 거리감쇠 1/(1+k²) 가 사실상 1 = 평행광
//  · far2 = Infinity            → 거리 컬링에 안 걸린다
//  · soft = D × 0.00925         → 원반 지름이 태양 각지름 0.53° 와 같아진다.
//    반그림자 폭 = soft × h/D = h × 0.00925 라 D 를 어떻게 잡든 물리적으로 맞는다.
// 세기는 물리 직달조도에 비례시킨다 — 해질녘에 저절로 약해지고 붉어진다.
const SUN_LIT_POWER = 0.45;   // 맑은 날 정오(직달 10만 lx)일 때의 power. 실측으로 정함(아래 주석).
function sunLight() {
  if (!sunOn()) return null;
  const S = sunState();
  const sd = sunDirection(S);
  if (sd.alt <= 0) return null;                       // 해가 지평선 아래 = 직사광 없음
  const fit = (v3 && v3.fit) ? v3.fit : 10000;
  const D = Math.max(50000, fit * 20);                // 씬보다 훨씬 멀리 = 평행광
  const cx = v3 ? v3.cx : 0, cy = v3 ? v3.cy : 0, cz = v3 ? v3.cz : 0;
  // 고도가 낮을수록 붉다 — 대기를 길게 통과하며 파랑이 산란돼 빠진다
  const cct = 2000 + 4000 * Math.min(1, Math.max(0, sd.alt / 30));
  const c = kelvinToRGB(cct), mx = Math.max(c[0], c[1], c[2]) || 1;
  return {
    x: cx + sd.x * D, y: cy + sd.y * D, z: cz + sd.z * D,
    range: D * 1e6, far2: Infinity, soft: D * 0.00925,
    power: SUN_LIT_POWER * (sunDirectIlluminance(S) / 100000),  // 물리 직달조도에 비례
    bounce: 0.5,
    cr: c[0] / mx, cg: c[1] / mx, cb: c[2] / mx,
    lm: 0,          // 태양은 lux 로 다룬다 — illuminanceAt 의 점광원 공식(lm/4πd²)에 넣으면 안 된다
    sun: true,
  };
}
function lightSources() {
  const out = [];
  const sl = sunLight();
  if (sl) out.push(sl);
  if (!state.lights.length) return out;
  const byId = new Map(state.entities.map(e => [e.id, e]));
  for (const L of state.lights) {
    if (!L.enabled) continue;
    if (soloLightId && L.id !== soloLightId) continue; // 솔로: 이 광원만
    const e = byId.get(L.objectId); if (!e) continue;  // 개체가 없는 광원(고아)은 조용히 건너뛴다
    const lay = getLayer(e.layer); if (lay && !lay.visible) continue;
    const c = lightColorRGB(L);
    const mx = Math.max(c[0], c[1], c[2]) || 1;        // 밝기는 intensity가 담당 → 색은 '비율'만
    const power = lmToPower(L.intensity);
    const rng = Math.max(100, L.range || LIGHT_RANGE_DEF);
    for (const p of lightEmitters(e, L)) {
      out.push({
        x: p.x, y: p.y, z: p.z,            // 개체가 놓인 자리에서 그대로 빛난다
        range: rng,                        // 밝기가 절반이 되는 거리
        far2: (rng * 6) * (rng * 6),       // 이보다 멀면 기여가 환경광 수준 → 계산 생략
        power,
        soft: L.soft != null ? Math.max(0, L.soft) : 400, // 광원 크기 = 그림자 부드러움(0이면 하드 섀도우)
        bounce: L.bounce != null ? Math.max(0, L.bounce) : 0.5, // 간접광(반사) 세기, 0=끔
        cr: c[0] / mx, cg: c[1] / mx, cb: c[2] / mx,      // 색온도 → 채널별 비율
        lm: L.intensity,                                   // 물리 광속 — 조도(lux) 계산에 쓴다
        ies: L.ies || null,                                // 배광 — 있으면 방향별 광도로 (조도 분석도 이걸 쓴다)
        type: L.type || 'point',                           // 렌더링 뷰가 스팟/IES 를 원뿔로 근사할 때 쓴다
        spotDeg: L.spotAngleDeg || 60,                     // 스팟 전각(°)
        spotPen: L.spotPenumbra == null ? 0.3 : L.spotPenumbra,
      });
      if (out.length >= 64) return out; // 성능 상한 (면 × 광원 연산) — 초과분은 무시
    }
  }
  return out;
}
// ---------- 그림자 ----------
// 면 → 광원 선분이 다른 형상에 막히면 그 광원은 그 면을 비추지 못한다.
// 삼각형 수가 많으면 비용이 크므로 상한을 두고, 넘으면 그림자를 생략한다(조명은 그대로 동작).
const SHADOW_TRI_CAP = 2000;
function shadowOccluders() {
  const tris = [];
  let col = [180, 180, 180]; // 현재 수집 중인 형상의 표면 색 (0~255) — 색번짐에 쓰인다
  const push = (a, b, c) => { if (tris.length < SHADOW_TRI_CAP) tris.push({ v: [a, b, c], col }); };
  // 광원으로 지정한 개체는 가림에서 뺀다 — 안 그러면 자기 형상이 자기 빛을 통째로 막아 캄캄해진다.
  // (box는 MESH가 아니라 LWPOLYLINE+bim이라 솔리드로 그려지므로 여기서도 걸러야 한다)
  const litIds = new Set();
  for (const e of state.entities) if (e.lightId) litIds.add(e.id);
  for (const s of (v3.solids || [])) {
    if (s.glass || s.glow) continue; // 유리는 빛을 막지 않는다
    if (litIds.has(s.eid)) continue; // 광원 지정 개체
    const P = s.poly, n = P.length; if (!P || n < 3) continue;
    col = rgbTriplet(s.color || '#b9b2a6');
    const zt = s.zt || P.map(() => s.z1), zb = s.zb || P.map(() => s.z0);
    const Q = (s.ptop && s.ptop.length === n) ? s.ptop : P;   // 어긋난 윗면
    for (let i = 1; i < n - 1; i++) { // 윗면·바닥면
      push([Q[0][0], Q[0][1], zt[0]], [Q[i][0], Q[i][1], zt[i]], [Q[i + 1][0], Q[i + 1][1], zt[i + 1]]);
      push([P[0][0], P[0][1], zb[0]], [P[i][0], P[i][1], zb[i]], [P[i + 1][0], P[i + 1][1], zb[i + 1]]);
    }
    for (let i = 0; i < n; i++) { // 옆면
      const j = (i + 1) % n;
      const a = [P[i][0], P[i][1], zb[i]], b = [P[j][0], P[j][1], zb[j]];
      const c = [Q[j][0], Q[j][1], zt[j]], d = [Q[i][0], Q[i][1], zt[i]];
      push(a, b, c); push(a, c, d);
    }
  }
  for (const e of state.entities) {
    if (e.type !== 'MESH' || !e.tris) continue;
    if (e.lightId) continue; // 광원으로 지정한 형상은 자기 빛을 스스로 막지 않는다
    const l = getLayer(e.layer); if (l && !l.visible) continue;
    col = rgbTriplet(bimSolidColor(e, '#b9b2a6'));
    for (const t of e.tris) push(t[0], t[1], t[2]);
  }
  for (const o of tris) { // 빠른 배제용 AABB
    const [a, b, c] = o.v;
    o.bb = [Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]), Math.min(a[2], b[2], c[2]),
            Math.max(a[0], b[0], c[0]), Math.max(a[1], b[1], c[1]), Math.max(a[2], b[2], c[2])];
  }
  return tris;
}
// 선분(면→광원)이 막혔는가 — Möller–Trumbore
function shadowed(ox, oy, oz, lx, ly, lz) {
  const O = v3._occ; if (!O || !O.length) return false;
  const dx = lx - ox, dy = ly - oy, dz = lz - oz;
  const maxT = 1; // 광원까지를 t=1로 정규화
  const sx0 = Math.min(ox, lx), sx1 = Math.max(ox, lx);
  const sy0 = Math.min(oy, ly), sy1 = Math.max(oy, ly);
  const sz0 = Math.min(oz, lz), sz1 = Math.max(oz, lz);
  for (const o of O) {
    const bb = o.bb; // 선분 AABB와 안 겹치면 즉시 배제 (대부분 여기서 걸러짐)
    if (bb[3] < sx0 || bb[0] > sx1 || bb[4] < sy0 || bb[1] > sy1 || bb[5] < sz0 || bb[2] > sz1) continue;
    const T = o.v;
    const e1x = T[1][0] - T[0][0], e1y = T[1][1] - T[0][1], e1z = T[1][2] - T[0][2];
    const e2x = T[2][0] - T[0][0], e2y = T[2][1] - T[0][1], e2z = T[2][2] - T[0][2];
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-9 && det < 1e-9) continue; // 광선과 평행
    const inv = 1 / det;
    const tx = ox - T[0][0], ty = oy - T[0][1], tz = oz - T[0][2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const vv = (dx * qx + dy * qy + dz * qz) * inv;
    if (vv < 0 || u + vv > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t > 1e-3 && t < maxT - 1e-3) return true; // 사이에 가로막는 형상이 있음
  }
  return false;
}
// ---------- 간접광 (1회 반사) ----------
// 1차 광원에서 사방으로 광선을 쏘아 '처음 맞는 면'을 찾고, 그 지점을 2차 광원으로 세운다
// (instant radiosity / VPL). 그러면 그림자 안이나 천장처럼 직접 빛이 닿지 않는 곳도
// 바닥·벽에 튕긴 빛으로 은은하게 밝아진다.
// 2차 광원은 그림자 검사를 하지 않는다 — 광원 수만큼 광선이 곱해져 감당이 안 되고,
// 반사광은 원래 부드러워서 그림자를 생략해도 크게 티가 나지 않는다(표준적인 근사).
// 주: 이 렌더러는 면 색에 '스칼라 밝기' 하나만 곱하므로 색번짐(빨간 벽 → 붉은 바닥)은 표현 못 한다.
//     밝기 기반 간접광만 구현한다.
const BOUNCE_DIRS = (() => { // 피보나치 구면 분포 — 고정·결정적 (난수는 캐시·프레임 안정성을 깬다)
  const d = [], N = 32;
  for (let i = 0; i < N; i++) {
    const z = 1 - 2 * (i + 0.5) / N, r = Math.sqrt(Math.max(0, 1 - z * z));
    const th = Math.PI * (1 + Math.sqrt(5)) * i;
    d.push([r * Math.cos(th), r * Math.sin(th), z]);
  }
  return d;
})();
const BOUNCE_CAP = 96; // 2차 광원 상한 (면마다 순회하므로 상한이 곧 성능)
// 광선이 처음 맞는 면 — {t, nx, ny, nz}
function rayHit(ox, oy, oz, dx, dy, dz, maxT) {
  const O = v3._occ; if (!O || !O.length) return null;
  let bt = maxT, bn = null, bc = null;
  for (const o of O) {
    const T = o.v;
    const e1x = T[1][0] - T[0][0], e1y = T[1][1] - T[0][1], e1z = T[1][2] - T[0][2];
    const e2x = T[2][0] - T[0][0], e2y = T[2][1] - T[0][1], e2z = T[2][2] - T[0][2];
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-9 && det < 1e-9) continue;
    const inv = 1 / det;
    const tx = ox - T[0][0], ty = oy - T[0][1], tz = oz - T[0][2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const vv = (dx * qx + dy * qy + dz * qz) * inv;
    if (vv < 0 || u + vv > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t > 1 && t < bt) {
      bt = t;
      let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const nl = Math.hypot(nx, ny, nz) || 1;
      bn = [nx / nl, ny / nl, nz / nl];
      bc = o.col;
    }
  }
  return bn ? { t: bt, nx: bn[0], ny: bn[1], nz: bn[2], col: bc } : null;
}
function bounceLights() {
  const out = [];
  if (!v3._occ || !v3._lights || !v3._lights.length) return out;
  for (const g of v3._lights) {
    const str = g.bounce != null ? g.bounce : 0.5;
    if (str <= 0) continue;
    for (const D of BOUNCE_DIRS) {
      const h = rayHit(g.x, g.y, g.z, D[0], D[1], D[2], g.range * 2);
      if (!h) continue;
      // 삼각형 winding은 신뢰할 수 없어 법선이 뒤집혀 나올 수 있다. 반사면은 반드시 '빛을 맞는 쪽'을
      // 향해야 하므로, 들어온 광선과 같은 방향이면 뒤집는다.
      // (이걸 안 하면 2차 광원이 벽 뒤로만 빛을 쏘아 색번짐이 전혀 안 나온다 — 실측으로 잡음)
      let hnx = h.nx, hny = h.ny, hnz = h.nz;
      if (D[0] * hnx + D[1] * hny + D[2] * hnz > 0) { hnx = -hnx; hny = -hny; hnz = -hnz; }
      const cos = -(D[0] * hnx + D[1] * hny + D[2] * hnz);
      if (cos < 0.05) continue; // 스치듯 맞은 면은 기여가 거의 없다
      const k = h.t / g.range, atten = 1 / (1 + k * k);
      // 광원이 내뿜는 빛을 방향 수만큼 나눠 갖는다. 나누지 않으면 2차 광원 하나하나가 원본만큼 세서
      // 다 더했을 때 그림자 안이 직접광만큼 밝아진다(실측: 그림자 0.16 → 1.066, 그림자로 안 보임).
      const p = g.power * atten * cos * str * (8 / BOUNCE_DIRS.length);
      if (p < 0.004) continue; // 너무 약한 2차 광원은 버린다 (상한을 아껴 쓰기)
      const rng = Math.max(500, g.range * 0.5); // 반사광은 멀리 못 간다
      // 반사광은 '반사면의 색 × 쏜 광원의 색' — 색온도가 반사광까지 일관되게 따라간다
      const sc = h.col || [180, 180, 180];
      const c = (g.cr == null) ? sc : [sc[0] * g.cr, sc[1] * g.cg, sc[2] * g.cb];
      const mx = Math.max(c[0], c[1], c[2]) || 1; // 밝기는 power가 담당 → 색은 '비율'만 남긴다
      out.push({
        x: g.x + D[0] * h.t + hnx * 20, y: g.y + D[1] * h.t + hny * 20, z: g.z + D[2] * h.t + hnz * 20,
        nx: hnx, ny: hny, nz: hnz, range: rng, far2: (rng * 4) * (rng * 4), power: p,
        cr: c[0] / mx, cg: c[1] / mx, cb: c[2] / mx, // 반사면의 색조 (최대 성분 1)
      });
      if (out.length >= BOUNCE_CAP) return out;
    }
  }
  return out;
}
// ---------- 부드러운 그림자 (펜엄브라) ----------
// 램프를 '점'이 아니라 넓이가 있는 광원(반지름 soft/2의 원반)으로 보고 여러 점을 샘플한다.
// 보이는 샘플 비율 = 그 광원이 이 면을 비추는 정도 → 경계에 반그림자가 생긴다.
// 원반은 '면을 향하는 방향'에 수직으로 놓는다(구형 광원의 투영 = 원반).
// 샘플 위치는 고정 패턴 — 난수를 쓰면 프레임마다 흔들리고 캐시도 못 쓴다.
const SOFT_DISC = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]];
function visFraction(ox, oy, oz, g, dx, dy, dz, d) {
  const r = g.soft / 2;
  if (r < 1) return shadowed(ox, oy, oz, g.x, g.y, g.z) ? 0 : 1; // 크기 0 = 점광원(하드 섀도우)
  // 면→광원 방향(단위)에 수직인 정규직교 축 u, v — 원반 광원의 평면
  const nx = dx / d, ny = dy / d, nz = dz / d;
  // 보조축은 방향과 평행하지 않게 고른다 (평행하면 외적이 0이 되어 축을 못 만든다)
  const ax = Math.abs(nz) < 0.9 ? 0 : 1, ay = 0, az = Math.abs(nz) < 0.9 ? 1 : 0;
  let ux = ny * az - nz * ay, uy = nz * ax - nx * az, uz = nx * ay - ny * ax;
  const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
  const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux; // 이미 단위
  const at = i => {
    const s = SOFT_DISC[i];
    return shadowed(ox, oy, oz, g.x + (ux * s[0] + vx * s[1]) * r, g.y + (uy * s[0] + vy * s[1]) * r, g.z + (uz * s[0] + vz * s[1]) * r) ? 0 : 1;
  };
  // 원반 양 끝 두 점이 같은 결과면 그 사이도 같다고 보고 확정 — 대부분의 면은 완전히 밝거나 완전히 그늘.
  // (두 점 사이만 가로막는 아주 얇은 형상은 놓칠 수 있다 — 반그림자 폭 대비 실익이 큰 근사)
  // 원반의 네 끝(±u, ±v)이 모두 같으면 그 사이도 같다고 보고 확정 — 대부분의 면은 완전히 밝거나 완전히 그늘.
  // ±u 두 점만 보면 안 된다: u가 가림 형상과 나란하면(예: Y축 벽 + Y축 u) 두 점이 같은 값이라
  // 반그림자를 통째로 놓친다(테스트로 실제로 잡힘). 네 방향을 봐야 어느 방향의 경계든 걸린다.
  const a = at(1);
  if (at(2) === a && at(3) === a && at(4) === a) return a;
  let vis = 0;
  for (let i = 0; i < SOFT_DISC.length; i++) vis += at(i);
  return vis / SOFT_DISC.length;
}
// 면 하나의 밝기 — 월드 위치·법선 기준, 거리 제곱 감쇠 + 그림자.
// twoSided: 메시는 삼각형 winding을 신뢰할 수 없어 양면 모두 빛을 받게 한다(기존 메시 셰이딩도 abs를 씀).
function litFace(wx, wy, wz, nx, ny, nz, twoSided) {
  const L = v3 && v3._lights;
  // 환경광 = 방향별 천공광. 하늘을 보는 면과 아래를 보는 면이 달라야 형태가 산다.
  // 양면 면은 카메라 쪽 법선을 모르므로 위쪽 하늘을 받는 것으로 근사한다.
  litSky(twoSided ? 0 : nx, twoSided ? 0 : ny, twoSided ? 1 : nz, wx, wy, wz);
  const ar = LIT_SKY[0], ag = LIT_SKY[1], ab = LIT_SKY[2];
  if (!L || !L.length) {
    LIT_RGB[0] = ar; LIT_RGB[1] = ag; LIT_RGB[2] = ab;
    LIT_RGB[3] = (Math.abs(ar - ag) > 0.02 || Math.abs(ag - ab) > 0.02 || Math.abs(ar - ab) > 0.02) ? 1 : 0;
    return (ar + ag + ab) / 3;
  }
  // 직접광도 채널별로 쌓는다 — 광원의 색온도(K)가 화면에 나타나려면 스칼라 하나로는 안 된다
  let sr = ar, sg = ag, sb = ab;
  for (const g of L) {
    const dx = g.x - wx, dy = g.y - wy, dz = g.z - wz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > g.far2) continue; // 도달거리 훨씬 밖 = 기여가 환경광 수준 → 광선 검사까지 생략(가장 큰 절감)
    const d = Math.sqrt(d2) || 1;
    let dot = (dx * nx + dy * ny + dz * nz) / d;
    if (twoSided) dot = Math.abs(dot);
    if (dot <= 0) continue; // 광원을 등진 면 — 광선 검사도 생략
    let vis = 1;
    if (v3._occ) {
      // 자기 면에 다시 맞는 것(그림자 여드름)을 피하려고 법선 방향으로 살짝 띄워 쏜다
      vis = visFraction(wx + nx * 2, wy + ny * 2, wz + nz * 2, g, dx, dy, dz, d);
      if (vis <= 0) continue; // 완전히 그늘
    }
    const k = d / g.range;
    const q = dot * g.power * LIT_GAIN / (1 + k * k) * vis;
    if (g.cr == null) { sr += q; sg += q; sb += q; }             // 색 없는 광원(테스트 등) = 백색
    else { sr += q * g.cr; sg += q * g.cg; sb += q * g.cb; }
  }
  // 간접광(2차 광원) — 그림자 검사 없이 코사인·감쇠만. 그림자 안·천장이 반사광으로 은은히 밝아진다.
  // 반사광은 '반사면의 색'을 띠므로 채널별로 따로 쌓는다 → 색번짐(빨간 벽 → 붉은 바닥).
  let tr = 0, tg = 0, tb = 0;
  const B = v3._bounce;
  if (B) for (const g of B) {
    const dx = g.x - wx, dy = g.y - wy, dz = g.z - wz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > g.far2) continue;
    const d = Math.sqrt(d2) || 1;
    let dot = (dx * nx + dy * ny + dz * nz) / d;
    if (twoSided) dot = Math.abs(dot);
    if (dot <= 0) continue;
    // 2차 광원은 자기가 붙은 면의 바깥쪽으로만 빛을 뿌린다 (벽 뒤로 새지 않게)
    if ((-dx * g.nx - dy * g.ny - dz * g.nz) / d <= 0) continue;
    const k = d / g.range;
    const e = dot * g.power * LIT_GAIN / (1 + k * k); // 직접광과 같은 배율 — 다르면 간접광 비율이 틀어진다
    tr += e * g.cr; tg += e * g.cg; tb += e * g.cb;
  }
  // 채널별 밝기 = 공통(환경광+직접광) + 그 채널의 반사광
  const cl = toneMap; // 하드 클립이 아니라 무릎 위를 압축 — 밝은 곳도 계조가 남는다
  const r = cl(sr + tr), g2 = cl(sg + tg), b = cl(sb + tb);
  LIT_RGB[0] = r; LIT_RGB[1] = g2; LIT_RGB[2] = b;
  // 색조가 사실상 없으면(백색광 + 간접광 OFF·회색 반사) 예전처럼 스칼라 하나로 처리하도록 알린다
  LIT_RGB[3] = (Math.abs(r - g2) > 0.02 || Math.abs(g2 - b) > 0.02 || Math.abs(r - b) > 0.02) ? 1 : 0;
  return (r + g2 + b) / 3;
}
// 조명 보기 전용: 넓은 상/하면을 잘게 나눠 빛의 계조가 '면 위에' 나타나게 한다.
// 이 렌더러는 평면 셰이딩(면 1개 = 밝기 1개)이라, 나누지 않으면 40m 슬래브가 중심점의 밝기로
// 통째로 칠해져 빛 웅덩이가 보이지 않는다. 조각은 원래 면의 메타데이터(fk/eid/…)를 그대로
// 물려받으므로 면 클릭(extrudesrf 면 밀당)에는 영향이 없다. lighting이 꺼져 있으면 호출되지 않는다.
// 조명은 '카메라와 무관'하다 — 형상·광원이 그대로면 궤도를 돌려도 밝기는 변하지 않는다.
// 그래서 (월드 삼각형 + 밝기)를 캐시해두고, 매 프레임 투영만 다시 한다.
// 캐시 키가 바뀌는 경우(형상·광원 변경)에만 재계산 → 반복 렌더가 사실상 공짜가 된다.
function litCacheSig() {
  let h = '';
  // 색(cr/cg/cb)까지 넣어야 한다 — 빠뜨리면 색온도를 바꿔도 캐시가 살아남아 옛 색이 그대로 남는다
  for (const g of (v3._lights || [])) h += `${g.x},${g.y},${g.z},${g.range},${g.power},${g.soft},${g.bounce},`
    + `${(g.cr || 0).toFixed(3)},${(g.cg || 0).toFixed(3)},${(g.cb || 0).toFixed(3)},`
    // 배광·타입도 캐시 키다 — 빠뜨리면 IES 를 바꿔도 소프트웨어 뷰·렌더링 뷰가 옛 조명을 그대로 보인다
    + `${g.type || ''},${g.ies ? (g.ies.name || 'i') + g.ies.cd.length : ''},${g.spotDeg || 0},${g.spotPen || 0};`;
  h += 'S' + (v3._shSig || '') + ';';   // 하늘(태양 설정)이 바뀌면 천공광이 달라진다
  h += 'B' + ((v3._bounce || []).length) + ';'; // 2차 광원이 바뀌면 캐시 무효
  h += 'F' + (v3.falseColor ? (v3.fcMax || FC_MAX_DEF) : 0) + ';'; // 조도 표시/스케일이 바뀌면 색이 달라진다
  h += '#';
  for (const s of (v3.solids || [])) { // 형상이 바뀌면(이동·높이·개수) 키가 바뀐다
    h += s.eid + ',' + Math.round(s.z0) + ',' + Math.round(s.z1) + ',' + s.poly.length + ',';
    for (const p of s.poly) h += Math.round(p[0]) + '.' + Math.round(p[1]) + '_';
    h += ';';
  }
  return h + '#' + state.entities.length;
}
function pushLitPoly(faces, poly, zs, nz, meta, cacheKey, twoSided) {
  const cache = v3._litCache || (v3._litCache = new Map());
  const hit = cacheKey != null ? cache.get(cacheKey) : null;
  if (hit) { // 캐시 적중: 투영만 다시 (밝기·그림자 계산 생략)
    for (const fr of hit) {
      const P = [proj3D(fr.a[0], fr.a[1], fr.a[2]), proj3D(fr.b[0], fr.b[1], fr.b[2]), proj3D(fr.c[0], fr.c[1], fr.c[2])];
      faces.push({ ...meta, ...(fr.fc ? { color: fr.fc } : {}), pts: P, d: (P[0][2] + P[1][2] + P[2][2]) / 3, shade: fr.s, sh3: fr.t3, sub: 1, fe: fr.fe });
    }
    return;
  }
  const frags = [];
  // 분할 세밀도는 빛의 감쇠 규모에 맞춘다 — 도달거리가 짧으면 더 곱게, 길면 성기게.
  // ★ 태양은 평행광이라 '감쇠 거리' 라는 게 없다 — range 에 천문학적 값(D×1e6)을 넣어뒀다.
  // 그걸 그대로 쓰면 MAX_EDGE 가 상한 3000 에 붙어 바닥이 3m 덩어리로만 쪼개진다
  // (실측: 12m 바닥이 4×4 격자 → 그림자 기울기가 계단으로 보이고 명암이 뭉갠다).
  // 그래서 태양이 있으면 '장면 규모' 로 정한다. 감쇠가 없으니 기준이 될 건 화면에 담긴 크기뿐이다.
  const pl = (v3._lights || []).filter(g => !g.sun);
  const rng = pl.length ? Math.min(...pl.map(g => g.range)) : 6000;
  let maxEdge = Math.max(800, Math.min(3000, rng / 3));
  if ((v3._lights || []).some(g => g.sun)) maxEdge = Math.min(maxEdge, Math.max(300, (v3.fit || 10000) / 12));
  const MAX_EDGE = maxEdge, MIN_EDGE = 250, MAX_DEPTH = 14;
  // 그림자 경계 세분에는 '전역 예산'을 둔다. 그림자 경계는 계단 함수라 아무리 잘게 나눠도
  // 꼭짓점 밝기 차이가 줄지 않는다 → 예산이 없으면 모든 경계에서 최소 크기까지 무한정 쪼갠다.
  // (실측: 예산 없이 벽 20장 장면에서 조각 13,721개 · soft=0일 때 12.6초)
  // 예산을 다 쓰면 경계 세분만 멈춘다 — 기하 분할과 조명·그림자 자체는 그대로 동작.
  const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const softOn = !!(v3._occ && (v3._lights || []).some(g => g.soft > 0)); // 반그림자가 존재하는 경우에만 경계 세분
  // 경계 탐지는 '싸구려 판정'으로 한다: 광원마다 중심 광선 1개로 가림 여부만 보고 비트마스크를 만든다.
  // 여기서 전체 밝기(litFace: 광원 × 4~9 샘플)를 부르면 후보 삼각형마다 그 비용이 곱해져 감당이 안 된다
  // (실측: 전체 밝기로 판정 → 30초 타임아웃). 마스크가 다르면 = 그 사이에 그림자 경계가 있다는 뜻.
  // 꼭짓점은 이웃 삼각형과 공유되므로 좌표로 메모이즈.
  const mCache = new Map();
  const maskAt = p => {
    const k = (p[0] | 0) + ',' + (p[1] | 0) + ',' + (p[2] | 0);
    let m = mCache.get(k);
    if (m !== undefined) return m;
    m = 0;
    const L = v3._lights || [];
    for (let i = 0; i < L.length && i < 30; i++) {
      const g = L[i];
      const dx = g.x - p[0], dy = g.y - p[1], dz = g.z - p[2];
      if (dx * dx + dy * dy + dz * dz > g.far2) continue;
      if (dx * 0 + dy * 0 + dz * nz <= 0) continue; // 등진 면 (상/하면이라 법선은 (0,0,nz))
      if (!shadowed(p[0], p[1], p[2] + nz * 2, g.x, g.y, g.z)) m |= (1 << i);
    }
    mCache.set(k, m);
    return m;
  };
  // e0/e1/e2 = 변 ab/bc/ca 가 '원래 다각형의 외곽선'인가. 분할하며 물려 내려간다.
  // 이게 없으면 조각마다 세 변을 다 그려 면 위에 격자가 생긴다 — 이음선 숨김(seamHide)은
  // '밝기가 같은 두 면'만 숨기는데, 조명 세분화는 일부러 조각마다 밝기를 다르게 만들기 때문에
  // 그 조건이 절대 성립하지 않는다. 메시의 fe(특징 모서리)와 같은 방식으로 푼다.
  const emit = (a, b, c, depth, e0, e1, e2) => {
    // '가장 긴 변만' 이등분한다. 네 갈래로 쪼개면 모든 변이 같이 반토막 나서,
    // 벽 윗면 같은 길고 얇은 띠(16m × 0.2m)가 256조각으로 폭발한다(실측: 조각 10,770개 → 913ms).
    // 긴 변만 나누면 필요한 방향으로만 잘려 조각 수가 형상 비율에 맞게 유지된다.
    const dab = d3(a, b), dbc = d3(b, c), dca = d3(c, a);
    const m = Math.max(dab, dbc, dca);
    let split = depth < MAX_DEPTH && m > MAX_EDGE;
    // 그림자 경계에서만 추가로 잘게 나눈다. 이게 없으면 반그림자(수백 mm)가 조각(수 m)보다 작아
    // 화면에 아예 나타나지 않는다(실측: 0.16 → 0.62로 건너뜀 = 중간 밝기 소실).
    // 반그림자가 있을 때만(soft>0) 경계를 더 잘게 나눈다.
    // 하드 섀도우(soft=0)는 경계가 계단이라 아무리 나눠도 값이 수렴하지 않고 비용만 폭증한다
    // (실측: 하드에서 경계 세분을 켜면 12.6초 → 끄면 0.15초. 게다가 나눠도 보이는 게 달라지지 않음).
    if (softOn && !split && depth < MAX_DEPTH && m > MIN_EDGE && v3._litBudget > 0) {
      const ma = maskAt(a);
      if (maskAt(b) !== ma || maskAt(c) !== ma) { split = true; v3._litBudget--; } // 꼭짓점 간 가림 상태가 다름 = 경계
    }
    if (split) {
      // 쪼갠 변의 두 반쪽은 원래 변의 성질을 물려받고, 새로 생긴 변은 항상 내부선이다
      if (m === dab) { const x = mid(a, b); emit(a, x, c, depth + 1, e0, false, e2); emit(x, b, c, depth + 1, e0, e1, false); }
      else if (m === dbc) { const x = mid(b, c); emit(a, b, x, depth + 1, e0, e1, false); emit(a, x, c, depth + 1, false, e1, e2); }
      else { const x = mid(c, a); emit(a, b, x, depth + 1, e0, false, e2); emit(x, b, c, depth + 1, false, e1, e2); }
      return;
    }
    const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3, cz = (a[2] + b[2] + c[2]) / 3;
    // 조도 색표시: 밝기 대신 lux를 색으로. 측정면과 같은 illuminanceAt()을 쓰므로 숫자와 색이 일치한다.
    const fc = v3.falseColor ? falseColor(illuminanceAt(cx, cy, cz, 0, 0, nz), v3.fcMax) : null;
    const sh = fc ? 1 : litFace(cx, cy, cz, 0, 0, nz, !!twoSided);
    const t3 = (!fc && LIT_RGB[3]) ? [LIT_RGB[0], LIT_RGB[1], LIT_RGB[2]] : null; // 색조가 있을 때만
    const fe = [e0, e1, e2];
    frags.push({ a, b, c, s: sh, t3, fe, fc });
    const P = [proj3D(a[0], a[1], a[2]), proj3D(b[0], b[1], b[2]), proj3D(c[0], c[1], c[2])];
    faces.push({ ...meta, ...(fc ? { color: fc } : {}), pts: P, d: (P[0][2] + P[1][2] + P[2][2]) / 3, shade: sh, sh3: t3, sub: 1, fe });
  };
  const V = poly.map((p, i) => [p[0], p[1], zs[i]]);
  const nV = V.length;
  // 팬 삼각화: V0-Vi 는 i=1일 때만, Vi+1-V0 는 i+1이 마지막일 때만 외곽선. Vi-Vi+1 은 항상 외곽선.
  for (let i = 1; i < nV - 1; i++) emit(V[0], V[i], V[i + 1], 0, i === 1, true, i + 1 === nV - 1);
  if (cacheKey != null) cache.set(cacheKey, frags);
}

// ============================================================
//  Raytraced 모드 (Phase 2) — three-gpu-pathtracer
//  Parti의 3D는 자체 소프트웨어 래스터라이저(2D 캔버스)다. 패스트레이싱은 WebGL2가
//  필요하므로 Raytraced일 때만 three.js를 CDN에서 지연 로드해 별도 캔버스를 겹쳐 띄운다.
//  기존 조명 보기(lighting)는 지시문 §2.4의 '근사 렌더 모드' 폴백 자리를 그대로 맡는다.
// ============================================================
const RT_CDN = {
  three: 'https://esm.sh/three@0.169.0',
  pt: 'https://esm.sh/three-gpu-pathtracer@0.0.24?deps=three@0.169.0,three-mesh-bvh@0.7.8',
  bvh: 'https://esm.sh/three-mesh-bvh@0.7.8?deps=three@0.169.0',
};
const RT_TRI_WARN = 3e6;      // 이 이상이면 진입 전 경고 (§6)
const rt = {
  on: false, mod: null, tracer: null, renderer: null, scene: null, cam: null,
  // denoise: 미완성이라 기본 OFF에 UI도 없다 — 아래 rtSetupDenoise 주석 참고
  cv: null, hud: null, raf: 0, loading: false, geoSig: '', env: 'black', denoise: true, err: null,
  vi: -1,                // 이 뷰포트에 묶인다 (-1 = 안 붙음). rview 와 같은 규약 — 자기 칸에만 그린다.
  q: { spp: 64, bounces: 10, name: '보통' },   // 품질 프리셋 (rtquality)
  autoSave: false,       // finalrender — 수렴(spp 도달)하면 자동으로 PNG 저장
  bg: 'sky',             // 렌더 배경 (bg 명령): sky(기본) | white(스튜디오) | black — 조명은 그대로, 배경 그림만
  ground: true,          // 렌더 전용 대지 평면 (ground 명령 토글)
  exposure: 0,           // 0 = 환경에 따라 자동 (rtExposure 참고)
};
// WebGL2 지원 여부. 결과를 캐시하고 시험용 컨텍스트는 반드시 반납한다 —
// 브라우저는 동시 WebGL 컨텍스트 수를 제한해서, 매번 새로 만들면 몇 번 켰다 끄는 사이
// 한도가 차서 '지원 안 함'이라는 거짓 안내가 나온다.
// 성공만 캐시한다. 컨텍스트 한도가 잠깐 찼을 때의 실패를 영구 기억하면
// 그 뒤로는 멀쩡한 브라우저에도 '지원 안 함'이라고 계속 우기게 된다.
let _rtSup = false;
function rtSupported() {
  if (_rtSup) return true;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (gl) { _rtSup = true; const ex = gl.getExtension('WEBGL_lose_context'); if (ex) ex.loseContext(); }
  } catch (e) { /* 지원 안 함 — 다음에 다시 시도 */ }
  return _rtSup;
}
// 개체 색 → PBR. Parti 재질은 색(hex)뿐이라 합리적 기본값으로 매핑한다 (§2.2).
// ═══════════ 재질 (PBR) — 세 렌더러가 공유하는 하나의 진실 ═══════════
// 사용자 요구: "재료의 질감 등을 구현하여 렌더링을 확인할 수 있는 뷰".
// 설계 원칙(이번 개편의 핵심 교훈): 같은 개념을 두 군데에 구현하면 반드시 어긋난다.
//   → 재질 해석은 matOf/matBuild 한 쌍뿐이고, 렌더링 뷰(rview)와 레이트레이싱(rt)이 그걸 그대로 쓴다.
// 라이노 규약: 재질은 '렌더 표시'의 것이다. 와이어/셰이딩(작업 표시)은 개체·레이어 색을 유지한다.
//   단 색을 지정하지 않은 개체(ByLayer)는 작업 뷰에서도 재질 기본색을 쓴다 — 재질을 붙였는데
//   작업 화면이 그대로면 붙었는지 알 수가 없으니까.
const MAT_PRESETS = {
  concrete: { ko: '콘크리트', color: '#9e9b96', rough: 0.92, metal: 0, tex: 'speckle', bump: 0.5, scale: 700 },
  plaster:  { ko: '회벽',     color: '#ded9d1', rough: 0.95, metal: 0, tex: 'noise',   bump: 0.15, scale: 500 },
  wood:     { ko: '목재',     color: '#a9723f', rough: 0.5,  metal: 0, tex: 'wood',    bump: 0.35, scale: 1400 },
  brick:    { ko: '벽돌',     color: '#9c5540', rough: 0.9,  metal: 0, tex: 'brick',   bump: 1.0, scale: 900 },
  stone:    { ko: '석재',     color: '#8f8d88', rough: 0.75, metal: 0, tex: 'speckle', bump: 0.7, scale: 1000 },
  tile:     { ko: '타일',     color: '#c9ccc9', rough: 0.14, metal: 0, tex: 'tile',    bump: 0.6, scale: 600 },
  metal:    { ko: '금속',     color: '#b8bcc2', rough: 0.28, metal: 1, tex: null,      bump: 0,   scale: 500 },
  paint:    { ko: '페인트',   color: '#d8d4cc', rough: 0.42, metal: 0, tex: null,      bump: 0,   scale: 500 },
  asphalt:  { ko: '아스팔트', color: '#3f4145', rough: 0.97, metal: 0, tex: 'speckle', bump: 0.5, scale: 500 },
  grass:    { ko: '잔디',     color: '#5c7f3f', rough: 1.0,  metal: 0, tex: 'noise',   bump: 0.8, scale: 250 },
  marble:   { ko: '대리석',   color: '#e8e6e1', rough: 0.12, metal: 0, tex: 'marble',  bump: 0.15, scale: 1400 },
  fabric:   { ko: '직물',     color: '#b0a894', rough: 0.96, metal: 0, tex: 'fabric',  bump: 0.5, scale: 260 },
  steel:    { ko: '스테인리스', color: '#c4c8cc', rough: 0.34, metal: 1, tex: 'brushed', bump: 0.12, scale: 800 },
  // 투과 재질 — MeshPhysicalMaterial. 레이트레이싱에서 굴절·투과가 물리적으로 계산된다.
  glass:    { ko: '유리',     color: '#dfeef2', rough: 0.02, metal: 0, tex: null, bump: 0, scale: 500, transmission: 0.95, ior: 1.52, thickness: 12 },
  water:    { ko: '물',       color: '#4f8fb0', rough: 0.03, metal: 0, tex: null, bump: 0, scale: 500, transmission: 0.85, ior: 1.33, thickness: 200 },
};
const MAT_ALIAS = { 콘크리트: 'concrete', 노출콘크리트: 'concrete', 회벽: 'plaster', 석고: 'plaster', 목재: 'wood', 나무: 'wood',
  벽돌: 'brick', 석재: 'stone', 돌: 'stone', 타일: 'tile', 금속: 'metal', 철: 'metal', 페인트: 'paint', 도장: 'paint',
  아스팔트: 'asphalt', 잔디: 'grass', 유리: 'glass', 물: 'water',
  대리석: 'marble', 직물: 'fabric', 패브릭: 'fabric', 천: 'fabric', 스테인리스: 'steel', 스텐: 'steel' };
// 개체 → 재질 스펙 (없으면 null = 기존 기본 재질 동작 그대로)
// ─── 재질 라이브러리 ───
// 개체별 재정의(matx)만으로는 '같은 커스텀 벽돌' 을 여러 개체에 쓰려면 하나하나 맞춰야 하고,
// 나중에 색을 바꾸려면 또 전부 찾아다녀야 한다. 라이브러리는 그 반대다:
//   e.mat = '@내 벽돌'  → 항목을 고치면 그걸 쓰는 개체가 전부 따라 바뀐다. 그게 존재 이유다.
// 프리셋(MAT_PRESETS)은 코드가 주는 것이고, 라이브러리(state.matlib)는 도면이 갖는 것이다
// (문서에 저장돼야 남에게 보내도 같은 재질로 보인다).
const MAT_LIB_PREFIX = '@';
const matIsLib = (k) => typeof k === 'string' && k.charCodeAt(0) === 64;
const matLibName = (k) => matIsLib(k) ? k.slice(1) : null;
function matLibGet(name) { return (state.matlib && state.matlib[name]) || null; }
// 라이브러리 항목 → 재질 스펙. base 프리셋 위에 항목의 값을 덮는다.
function matLibSpec(L) {
  const P = MAT_PRESETS[L.base] || MAT_PRESETS.paint;
  const o = Object.assign({}, P);   // 프리셋은 공유 객체 — 절대 직접 고치지 않는다
  if (L.color) o.color = L.color;
  if (isFinite(L.scale) && L.scale > 0) o.scale = L.scale;
  if (isFinite(L.rough)) o.rough = Math.min(1, Math.max(0, L.rough));
  if (isFinite(L.metal)) o.metal = Math.min(1, Math.max(0, L.metal));
  if (L.img) { o.img = L.img; o.tex = o.tex || 'img'; }   // 자기 이미지가 있으면 그게 질감이다
  o.ko = L.name || '(이름 없음)';
  o._lib = true;
  return o;
}
// ─── 사용자 이미지 질감 ───
// 이미지 로드는 비동기인데 matBuild 는 동기다. 그래서:
//   캐시에 있으면 그걸 쓰고, 없으면 로드를 걸고 **절차적 질감으로 폴백**한다.
//   로드가 끝나면 matRefresh() 로 다시 그린다 — 잠깐 프리셋 무늬로 보였다가 사진으로 바뀐다.
// (여기서 기다리게 만들면 렌더 루프가 통째로 멈춘다)
const _matImgCache = new Map();   // dataURI → {canvas} | 'loading' | 'error'
function matImgCanvas(uri) {
  const hit = _matImgCache.get(uri);
  if (hit && hit !== 'loading' && hit !== 'error') return hit;
  if (hit) return null;                      // 로딩 중이거나 실패 — 폴백
  _matImgCache.set(uri, 'loading');
  const im = new Image();
  im.onload = () => {
    const c = document.createElement('canvas');
    c.width = im.naturalWidth || 512; c.height = im.naturalHeight || 512;
    c.getContext('2d').drawImage(im, 0, 0);
    _matImgCache.set(uri, { canvas: c });
    _matTexCache.clear();                    // 이 이미지를 쓰는 텍스처를 다시 만들어야 한다
    if (typeof matRefresh === 'function') matRefresh();
  };
  im.onerror = () => { _matImgCache.set(uri, 'error'); logLine('  ✗ 재질 이미지를 읽지 못했습니다.', 'warn'); };
  im.src = uri;
  return null;
}
// 업로드 이미지를 문서에 넣을 크기로 줄인다.
// 원본을 그대로 담으면 도면이 수 MB 로 붓고 공유 링크가 못 쓰게 된다(§ shareLink 경고 참고).
const MAT_IMG_MAX = 512;
function matImgShrink(im) {
  const s = Math.min(1, MAT_IMG_MAX / Math.max(im.naturalWidth || 1, im.naturalHeight || 1));
  const w = Math.max(1, Math.round((im.naturalWidth || 1) * s));
  const h = Math.max(1, Math.round((im.naturalHeight || 1) * s));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(im, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.85);
}
// 이미지에서 노멀맵 — 밝기를 높이로 본다. 사진 질감도 요철이 있어야 빛을 받는다.
function matImgNormal(canvas, strength) {
  const N = MAT_TEX_N;
  const t = document.createElement('canvas'); t.width = t.height = N;
  const g = t.getContext('2d');
  g.drawImage(canvas, 0, 0, N, N);
  return matNormalFromHeight({ ctx: g }, strength);
}
// 개체 → 재질 스펙. e.matx 가 있으면 프리셋 위에 덮어쓴다.
// ★MAT_PRESETS 의 객체는 모든 개체가 공유한다 — 직접 고치면 한 개체의 색을 바꿨는데
//   같은 재질을 쓰는 다른 개체가 전부 따라 바뀐다. 반드시 사본에 덮어쓴다.
function matOf(e) {
  if (!e) return null;
  // 재질 결정: 개체에 직접 지정(e.mat)이 최우선, 없으면 '레이어의 재질'을 상속 —
  // 레빗 패밀리처럼 레이어에 재질만 넣어도 그 레이어의 srf/솔리드가 전부 그 재질을 입는다 (2026-07-25).
  let matName = e.mat;
  if (!matName) { const ly = getLayer(e.layer); matName = (ly && ly.mat) || null; }
  if (!matName) return null;
  let P;
  if (matIsLib(matName)) {
    const L = matLibGet(matLibName(matName));
    // 라이브러리에서 지워진 재질을 참조하면 '기본' 으로 떨어진다.
    // 조용히 다른 재질로 갈아끼우면 도면이 사용자 몰래 달라진다 — 차라리 기본이 정직하다.
    if (!L) return null;
    P = matLibSpec(L);
  } else P = MAT_PRESETS[matName];
  if (!P) return null;
  const x = e.matx;
  if (!x) return P;
  const o = Object.assign({}, P);   // (라이브러리 스펙은 이미 사본이지만, 프리셋은 공유라 무조건 복사한다)
  if (x.color) o.color = x.color;
  if (isFinite(x.scale) && x.scale > 0) o.scale = x.scale;
  if (isFinite(x.rough)) o.rough = Math.min(1, Math.max(0, x.rough));
  if (isFinite(x.metal)) o.metal = Math.min(1, Math.max(0, x.metal));
  return o;
}
// 재정의 하나를 설정/해제. v == null 이면 프리셋 값으로 되돌린다.
function matSetX(e, k, v) {
  if (v == null) { if (e.matx) { delete e.matx[k]; if (!Object.keys(e.matx).length) delete e.matx; } return; }
  if (!e.matx) e.matx = {};
  e.matx[k] = v;
}
// ─── 전역 재질 라이브러리 ───
// 도면(문서) 라이브러리는 도면과 함께 저장된다. 전역 라이브러리는 이 브라우저의 것 —
// '내 벽돌' 을 어느 도면에서든 이름만 불러 쓰기 위한 저장소다 (material 공유 <이름>).
// 쓰는 순간 문서 라이브러리로 **복사**된다: 문서는 항상 자립적이어야 남에게 보내도 같은 재질로 보인다.
const MATG_KEY = 'webcad_matlib_global';
function matGlobalAll() {
  try { return JSON.parse(localStorage.getItem(MATG_KEY) || '{}') || {}; } catch (e) { return {}; }
}
function matGlobalSet(name, L) {
  const all = matGlobalAll();
  all[name] = L;
  try { localStorage.setItem(MATG_KEY, JSON.stringify(all)); return true; }
  catch (e) { return false; }   // 사진 질감이 큰 경우 용량 초과 가능 — 호출자가 알린다
}
function matGlobalDelete(name) {
  const all = matGlobalAll();
  if (!(name in all)) return false;
  delete all[name];
  try { localStorage.setItem(MATG_KEY, JSON.stringify(all)); } catch (e) {}
  return true;
}
function matKey(arg) {
  const raw = String(arg || '').trim();
  if (!raw) return null;
  // 저장된 재질 이름이 먼저 — 사용자가 지은 이름이 프리셋 별칭에 가려지면 안 된다
  if (matLibGet(raw)) return MAT_LIB_PREFIX + raw;
  if (matIsLib(raw) && matLibGet(matLibName(raw))) return raw;
  // 전역 라이브러리 — 이 도면에 없으면 전역에서 문서로 복사해 온다 (자동 가져오기)
  const nm = matIsLib(raw) ? matLibName(raw) : raw;
  const G = matGlobalAll()[nm];
  if (G) {
    if (!state.matlib) state.matlib = {};
    state.matlib[nm] = Object.assign({}, G, { name: nm });
    logLine(`  ▷ 전역 재질 "${nm}" 을 이 도면으로 가져왔습니다`, 'info');
    return MAT_LIB_PREFIX + nm;
  }
  const a = raw.toLowerCase();
  if (MAT_PRESETS[a]) return a;
  return MAT_ALIAS[raw] || null;
}
// ── 절차적 질감 ──
// 외부 이미지에 의존하지 않는다: CDN 이 막히거나 오프라인이면 재질이 통째로 사라지고,
// 그건 '가끔 다르게 보이는 렌더러'가 되어 신뢰를 잃는다. 캔버스로 그려서 항상 같게 만든다.
const MAT_TEX_N = 512;
const _matTexCache = new Map();
function matDrawTex(kind, hex, out) { // out: 'color' | 'height'
  const c = document.createElement('canvas'); c.width = c.height = MAT_TEX_N;
  const g = c.getContext('2d'), N = MAT_TEX_N;
  const [br, bg, bb] = hexToRgb(hex || '#b9b2a6');
  const color = out === 'color';
  // 결정론적 난수 — 새로고침마다 질감이 바뀌면 렌더 비교가 불가능해진다
  let seed = 20260716;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const put = (v) => color ? `rgb(${Math.round(br * v)},${Math.round(bg * v)},${Math.round(bb * v)})`
                           : `rgb(${Math.round(255 * v)},${Math.round(255 * v)},${Math.round(255 * v)})`;
  g.fillStyle = put(color ? 1 : 0.5); g.fillRect(0, 0, N, N);
  if (kind === 'speckle') {              // 콘크리트·석재·아스팔트: 미세 반점
    for (let i = 0; i < 26000; i++) {
      const x = rnd() * N, y = rnd() * N, r = 0.4 + rnd() * 1.8;
      const v = color ? (0.82 + rnd() * 0.30) : (0.30 + rnd() * 0.42);
      g.fillStyle = put(v); g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }
  } else if (kind === 'noise') {         // 회벽·잔디: 부드러운 얼룩
    for (let i = 0; i < 1400; i++) {
      const x = rnd() * N, y = rnd() * N, r = 3 + rnd() * 22;
      const v = color ? (0.86 + rnd() * 0.24) : (0.34 + rnd() * 0.34);
      g.globalAlpha = 0.30; g.fillStyle = put(v); g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }
    g.globalAlpha = 1;
  } else if (kind === 'wood') {          // 목재: 나이테 + 결
    for (let y = 0; y < N; y++) {
      const w = Math.sin(y * 0.075 + Math.sin(y * 0.013) * 3.4) * 0.5 + 0.5;
      const v = color ? (0.74 + w * 0.34) : (0.34 + w * 0.34);
      g.fillStyle = put(v); g.fillRect(0, y, N, 1);
    }
    for (let i = 0; i < 2600; i++) {     // 결(길게 늘어난 스크래치)
      const x = rnd() * N, y = rnd() * N, L = 8 + rnd() * 60;
      g.strokeStyle = put(color ? (0.72 + rnd() * 0.2) : (0.3 + rnd() * 0.2));
      g.lineWidth = 0.5 + rnd(); g.beginPath(); g.moveTo(x, y); g.lineTo(x + L, y + (rnd() - 0.5) * 2); g.stroke();
    }
  } else if (kind === 'brick') {         // 벽돌: 막힌줄눈(러닝 본드)
    const rows = 8, bh = N / rows, bw = N / 4, mortar = Math.max(2, bh * 0.13);
    g.fillStyle = put(color ? 0.92 : 0.12); g.fillRect(0, 0, N, N);   // 줄눈(움푹)
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) ? bw / 2 : 0;
      for (let i = -1; i < 5; i++) {
        const x = i * bw + off + mortar / 2, y = r * bh + mortar / 2;
        const v = color ? (0.80 + rnd() * 0.34) : (0.72 + rnd() * 0.2);
        g.fillStyle = put(v); g.fillRect(x, y, bw - mortar, bh - mortar);
      }
    }
  } else if (kind === 'marble') {        // 대리석: 밝은 바탕 + 정맥(랜덤 워크 곡선)
    for (let i = 0; i < 26; i++) {
      let x = rnd() * N, y = rnd() * N, a = rnd() * Math.PI * 2;
      g.strokeStyle = put(color ? (0.78 + rnd() * 0.12) : (0.30 + rnd() * 0.14));
      g.lineWidth = 0.6 + rnd() * 1.6; g.globalAlpha = 0.55;
      g.beginPath(); g.moveTo(x, y);
      for (let s = 0; s < 46; s++) {
        a += (rnd() - 0.5) * 0.9;                         // 방향이 흔들리며 흐르는 정맥
        x += Math.cos(a) * 7; y += Math.sin(a) * 7;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    g.globalAlpha = 0.25;                                  // 옅은 구름 얼룩 (돌의 깊이감)
    for (let i = 0; i < 260; i++) {
      const x = rnd() * N, y = rnd() * N, r = 6 + rnd() * 26;
      g.fillStyle = put(color ? (0.90 + rnd() * 0.10) : (0.44 + rnd() * 0.12));
      g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }
    g.globalAlpha = 1;
  } else if (kind === 'fabric') {        // 직물: 씨실/날실 직조 격자
    const s = N / 64;                                       // 실 간격
    for (let k = 0; k < 64; k++) {
      const vy = color ? (0.86 + rnd() * 0.20) : (0.36 + rnd() * 0.30);
      g.fillStyle = put(vy); g.fillRect(0, k * s, N, s * 0.55);           // 씨실(가로)
      const vx = color ? (0.82 + rnd() * 0.20) : (0.30 + rnd() * 0.30);
      g.globalAlpha = 0.5; g.fillStyle = put(vx); g.fillRect(k * s, 0, s * 0.55, N); g.globalAlpha = 1; // 날실(세로)
    }
  } else if (kind === 'brushed') {       // 헤어라인 금속: 가로 미세 스크래치
    for (let i = 0; i < 9000; i++) {
      const x = rnd() * N, y = rnd() * N, L = 20 + rnd() * 150;
      g.strokeStyle = put(color ? (0.86 + rnd() * 0.24) : (0.42 + rnd() * 0.18));
      g.globalAlpha = 0.35; g.lineWidth = 0.5 + rnd() * 0.7;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + L, y); g.stroke();
    }
    g.globalAlpha = 1;
  } else if (kind === 'tile') {          // 타일: 격자 + 그라우트
    const n = 4, s = N / n, gr = Math.max(2, s * 0.05);
    g.fillStyle = put(color ? 0.78 : 0.15); g.fillRect(0, 0, N, N);   // 그라우트
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const v = color ? (0.94 + rnd() * 0.10) : (0.85 + rnd() * 0.08);
      g.fillStyle = put(v); g.fillRect(i * s + gr / 2, j * s + gr / 2, s - gr, s - gr);
    }
  }
  return { canvas: c, ctx: g };
}
// 높이맵 → 노멀맵 (Sobel). bumpMap 은 패스트레이서가 안 읽는다 — 두 렌더러가 같이 읽는 건 normalMap.
function matNormalFromHeight(hc, strength) {
  const N = MAT_TEX_N;
  const src = hc.ctx.getImageData(0, 0, N, N).data;
  const out = document.createElement('canvas'); out.width = out.height = N;
  const og = out.getContext('2d'), img = og.createImageData(N, N);
  const H = (x, y) => src[((((y + N) % N) * N + ((x + N) % N)) << 2)] / 255;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = (H(x + 1, y) - H(x - 1, y)) * strength * 6;
    const dy = (H(x, y + 1) - H(x, y - 1)) * strength * 6;
    let nx = -dx, ny = -dy, nz = 1;
    const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
    const i = (y * N + x) << 2;
    img.data[i] = (nx * 0.5 + 0.5) * 255; img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
    img.data[i + 2] = (nz * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  og.putImageData(img, 0, 0);
  return out;
}
// 재질 키+색 → three 텍스처 묶음 (캐시)
// 스펙(프리셋이든 라이브러리든) + 색 → three 텍스처 묶음. 캐시 키에 이미지까지 넣어야
// 같은 base 를 쓰는 서로 다른 라이브러리 재질이 남의 무늬를 쓰지 않는다.
function matTextures(T, P, hex) {
  if (!P || (!P.tex && !P.img)) return null;
  const ck = (P.img ? 'I' + P.img.length + ':' + P.img.slice(-24) : 'P' + P.tex) + '|' + hex + '|' + P.bump;
  let o = _matTexCache.get(ck);
  if (o) return o;
  let map = null, nrm = null;
  if (P.img) {
    const ic = matImgCanvas(P.img);
    if (!ic) return matTextures(T, Object.assign({}, P, { img: null, tex: MAT_PRESETS[P.base] ? MAT_PRESETS[P.base].tex : 'noise' }), hex);
    map = new T.CanvasTexture(ic.canvas);
    if (P.bump > 0) nrm = new T.CanvasTexture(matImgNormal(ic.canvas, P.bump));
  } else {
    map = new T.CanvasTexture(matDrawTex(P.tex, hex, 'color').canvas);
    if (P.bump > 0) nrm = new T.CanvasTexture(matNormalFromHeight(matDrawTex(P.tex, hex, 'height'), P.bump));
  }
  map.wrapS = map.wrapT = T.RepeatWrapping;
  map.anisotropy = 8;                                  // 이방성 필터 — 스치는 각도에서 질감 선명 (three 가 GPU 상한으로 캡)
  if (T.SRGBColorSpace) map.colorSpace = T.SRGBColorSpace;
  if (nrm) { nrm.wrapS = nrm.wrapT = T.RepeatWrapping; nrm.anisotropy = 8; }
  o = { map, normalMap: nrm };
  _matTexCache.set(ck, o);
  return o;
}
// 재질 → three 재질. rtBuildScene 과 rviewBuildScene 이 **이 함수 하나**를 쓴다.
//   opts.emissive/emissiveIntensity: 발광체(광원 지정 개체)
//   opts.fast: 렌더링 뷰용 — 투과를 근사 투명으로 낮춘다 (래스터에는 굴절이 없다)
function matBuild(T, e, fallbackHex, opts) {
  opts = opts || {};
  const P = matOf(e);
  const hex = matHex(e, fallbackHex);
  const [r, g, b] = hexToRgb(hex);
  const base = { color: new T.Color(r / 255, g / 255, b / 255) };
  let m;
  if (P && P.transmission) {
    m = new T.MeshPhysicalMaterial(Object.assign(base, {
      roughness: P.rough, metalness: P.metal,
      transmission: opts.fast ? 0 : P.transmission,     // 래스터는 굴절을 못 한다 → opacity 근사
      ior: P.ior || 1.5, thickness: (P.thickness || 10) * RT_MM,
      transparent: !!opts.fast, opacity: opts.fast ? 0.32 : 1,
      side: T.DoubleSide,
    }));
  } else {
    m = new T.MeshStandardMaterial(Object.assign(base, {
      roughness: P ? P.rough : 0.6, metalness: P ? P.metal : 0,
    }));
  }
  if (P) {
    const tx = matTextures(T, P, hex);
    if (tx) {
      m.map = tx.map;
      // 사진 질감은 이미 자기 색을 갖고 있다 — 거기에 재질색을 곱하면 두 번 물든다.
      // 색을 지정하지 않았다면 흰색으로 두고 사진 그대로 보여준다.
      if (P.img && !(e && e.color) && !(e && e.matx && e.matx.color)) m.color.setRGB(1, 1, 1);
      if (tx.normalMap) { m.normalMap = tx.normalMap; m.normalScale = new T.Vector2(1, 1); }
    }
  }
  if (opts.emissive) { m.emissive = new T.Color(opts.emissive[0], opts.emissive[1], opts.emissive[2]); m.emissiveIntensity = opts.emissiveIntensity || 1; }
  return m;
}
// 표시색 — 개체색 > 재질색 > 레이어색 > 기본. 재질을 붙였는데 화면이 그대로면 붙었는지 알 수 없다.
function matHex(e, fallbackHex) {
  if (e && e.color) return e.color;
  const P = matOf(e);
  if (P) return P.color;
  return fallbackHex || '#b9b2a6';
}
// 월드 스케일 박스 매핑 UV — 삼각형의 지배 축으로 평면 투영.
// 개체 크기에 비례하는 UV 는 건축에서 틀렸다: 벽돌 한 장은 벽이 크든 작든 같은 크기여야 한다.
function matBoxUV(tris, scaleMM) {
  const uv = new Float32Array(tris.length * 6);
  const S = Math.max(1, scaleMM || 500);
  let k = 0;
  for (const t of tris) {
    const ax = t[1][0] - t[0][0], ay = t[1][1] - t[0][1], az = t[1][2] - t[0][2];
    const bx = t[2][0] - t[0][0], by = t[2][1] - t[0][1], bz = t[2][2] - t[0][2];
    const nx = Math.abs(ay * bz - az * by), ny = Math.abs(az * bx - ax * bz), nz = Math.abs(ax * by - ay * bx);
    let iu, iv;
    if (nz >= nx && nz >= ny) { iu = 0; iv = 1; }        // 바닥·천장 → XY 평면
    else if (nx >= ny) { iu = 1; iv = 2; }               // X 를 보는 벽 → YZ
    else { iu = 0; iv = 2; }                             // Y 를 보는 벽 → XZ
    for (const p of t) { uv[k++] = p[iu] / S; uv[k++] = p[iv] / S; }
  }
  return uv;
}
// 삼각형 목록 → BufferGeometry (위치·노멀·UV). 두 렌더러가 공유한다.
function matGeo(T, tris, e) {
  const pos = new Float32Array(tris.length * 9);
  let k = 0;
  for (const t of tris) for (const p of t) { pos[k++] = p[0] * RT_MM; pos[k++] = p[1] * RT_MM; pos[k++] = p[2] * RT_MM; }
  const geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.BufferAttribute(pos, 3));
  const P = matOf(e);
  if (P && (P.tex || P.img)) geo.setAttribute('uv', new T.BufferAttribute(matBoxUV(tris, P.scale), 2));
  geo.computeVertexNormals();
  return geo;
}
// 속성 패널의 재질 드롭다운 — 단일/다중 선택이 같은 코드를 쓴다 (한쪽만 고치면 어긋난다)
// 여러 개체가 같은 값을 가질 때만 그 값, 아니면 null (섞여 있는데 하나를 보여주면 거짓말이다)
function matCommon(sel, get) {
  if (!sel.length) return null;
  const v0 = get(sel[0]);
  return sel.every(e => get(e) === v0) ? v0 : null;
}
function matPropRow(cur, sel) {
  const libs = Object.keys(state.matlib || {});
  const opts = ['<option value="">— 기본 —</option>']
    .concat(libs.length ? ['<optgroup label="저장된 재질">'] : [])
    .concat(libs.map(k => `<option value="${MAT_LIB_PREFIX}${escapeHtml(k)}" ${cur === MAT_LIB_PREFIX + k ? 'selected' : ''}>${escapeHtml(k)}</option>`))
    .concat(libs.length ? ['</optgroup>', '<optgroup label="기본 재질">'] : [])
    .concat(Object.keys(MAT_PRESETS).map(k =>
      `<option value="${k}" ${cur === k ? 'selected' : ''}>${MAT_PRESETS[k].ko}</option>`))
    .concat(libs.length ? ['</optgroup>'] : []).join('');
  let h = `<div class="row"><label>재질</label><select id="pMat" title="질감·거칠기·투과 — rendered/raytrace 에서 보입니다">${opts}</select></div>`;
  const P = (sel && sel.length) ? matOf(sel[0]) : (MAT_PRESETS[cur] || null);
  if (!P || !sel || !sel.length) return h;
  const isLib = matIsLib(cur);
  if (isLib) h += `<div class="row" style="font-size:11px;opacity:.7;"><label></label><span>저장된 재질 — 고치면 이 재질을 쓰는 개체가 전부 바뀝니다</span></div>`;
  // 재정의 — 프리셋을 출발점으로 쓰고 필요한 것만 바꾼다. 값을 안 건드리면 프리셋을 따라간다.
  const spec = P;
  const sc = matCommon(sel, e => (e.matx && e.matx.scale) || null);
  h += `<div class="row"><label>재질색</label><input type="color" id="pMatC" value="${spec.color}">`
     + `<button class="miniBtn" id="pMatCR" title="프리셋 색으로">기본</button></div>`;
  if (P.tex || P.img) h += `<div class="row"><label>질감 크기</label><input type="number" id="pMatS" step="50" min="50" value="${sc != null ? sc : P.scale}" title="무늬 한 칸의 실제 크기(mm) — 벽돌·타일 크기를 여기서 맞춘다"><span style="font-size:11px;opacity:.6;">mm</span></div>`;
  const sl = (id, lab, v, tip) => `<div class="row"><label>${lab}</label>`
    + `<input type="range" id="${id}" min="0" max="1" step="0.02" value="${v}" style="flex:1;" title="${tip}">`
    + `<span id="${id}T" style="width:34px;text-align:right;font-size:11px;font-variant-numeric:tabular-nums;">${(+v).toFixed(2)}</span></div>`;
  h += sl('pMatR', '거칠기', spec.rough, '0=거울처럼 매끈 · 1=완전히 거침');
  h += sl('pMatM', '금속성', spec.metal, '0=비금속 · 1=금속 (금속은 색이 반사에 실린다)');
  h += `<div style="display:flex;gap:6px;margin-top:4px;"><button class="miniBtn" id="pMatReset" style="flex:1;">재정의 초기화</button></div>`;
  return h;
}
function wireMatProp(body, sel) {
  const el = body.querySelector('#pMat');
  if (!el) return;
  el.addEventListener('change', () => {
    pushUndo();
    for (const e of sel) {
      if (el.value) { if (e.mat !== el.value) delete e.matx; e.mat = el.value; }   // 재질을 바꾸면 재정의는 무의미하다
      else { delete e.mat; delete e.matx; }
    }
    const P = MAT_PRESETS[el.value];
    logLine(P ? `  ✔ 재질 ${P.ko} — 개체 ${sel.length}개` : `  ▷ 재질 해제 — 개체 ${sel.length}개`, 'ok');
    renderProps(); matRefresh();
  });
  // 재정의 — 슬라이더는 드래그 중 패널을 다시 만들지 않는다(만들면 잡고 있던 슬라이더가 사라진다)
  const apply = (k, v, rebuild) => {
    pushUndo();
    for (const e of sel) matSetX(e, k, v);
    if (rebuild) renderProps();
    matRefresh();
  };
  const c = body.querySelector('#pMatC');
  if (c) c.addEventListener('change', () => apply('color', c.value, false));
  const cr = body.querySelector('#pMatCR');
  if (cr) cr.addEventListener('click', () => apply('color', null, true));
  const sc = body.querySelector('#pMatS');
  if (sc) sc.addEventListener('change', () => {
    const v = parseFloat(sc.value);
    apply('scale', isFinite(v) && v > 0 ? v : null, false);
  });
  for (const [id, k] of [['pMatR', 'rough'], ['pMatM', 'metal']]) {
    const r = body.querySelector('#' + id); if (!r) continue;
    const t = body.querySelector('#' + id + 'T');
    r.addEventListener('input', () => {
      if (t) t.textContent = (+r.value).toFixed(2);
      for (const e of sel) matSetX(e, k, +r.value);
      rtPreview();          // 드래그 중엔 1/4 해상도로 (기존 광원 슬라이더와 같은 규약)
      matRefresh();
    });
    r.addEventListener('pointerdown', () => pushUndo());
    r.addEventListener('change', () => rtFullRes());
  }
  const rs = body.querySelector('#pMatReset');
  if (rs) rs.addEventListener('click', () => {
    pushUndo();
    for (const e of sel) delete e.matx;
    logLine(`  ▷ 재질 재정의 초기화 — 개체 ${sel.length}개가 프리셋 값으로`, 'ok');
    renderProps(); matRefresh();
  });
}
// 선택한 개체의 현재 재질(프리셋 + 재정의)을 라이브러리에 이름 붙여 저장한다.
// 이미 있는 이름이면 덮어쓴다 — 그러면 그 재질을 쓰는 개체가 전부 따라 바뀐다(라이브러리의 존재 이유).
function matLibSave(name, sel) {
  const e = sel[0];
  const cur = matOf(e);
  if (!cur) { logLine('  재질이 지정된 개체를 선택하세요 — 저장할 재질이 없습니다.', 'warn'); return; }
  const old = matLibGet(name);
  const base = matIsLib(e.mat) ? (matLibGet(matLibName(e.mat)) || {}).base : e.mat;
  pushUndo();
  if (!state.matlib) state.matlib = {};
  state.matlib[name] = {
    name, base: base || 'paint',
    color: cur.color, scale: cur.scale, rough: cur.rough, metal: cur.metal,
    img: cur.img || (old && old.img) || null,   // 이미지는 유지 (색만 바꿔 저장해도 사진이 날아가면 안 된다)
  };
  // 선택한 개체들을 그 라이브러리 재질로 연결 — 저장했는데 안 붙으면 뭘 한 건지 알 수 없다
  for (const x of sel) { x.mat = MAT_LIB_PREFIX + name; delete x.matx; }
  logLine(`  ✔ 재질 저장 — "${name}" (${old ? '덮어씀' : '새로 만듦'}) · 개체 ${sel.length}개가 이 재질을 씁니다`, 'ok');
  logLine('     이 재질을 고치면 쓰는 개체가 전부 따라 바뀝니다. 도면에 함께 저장됩니다.', 'info');
  renderProps(); matRefresh();
}
function matLibList() {
  const ks = Object.keys(state.matlib || {});
  const gs = Object.keys(matGlobalAll());
  if (!ks.length && !gs.length) { logLine('  저장된 재질이 없습니다 — material 저장 <이름> 으로 만듭니다.', 'info'); return; }
  if (ks.length) {
    logLine(`  저장된 재질 ${ks.length}개:`, 'info');
    for (const k of ks) {
      const L = state.matlib[k], P = MAT_PRESETS[L.base];
      const used = state.entities.filter(e => e.mat === MAT_LIB_PREFIX + k).length;
      logLine(`    · ${k} — ${P ? P.ko : L.base} 바탕 · ${L.color}${L.img ? ' · 사진 질감' : ''} · 쓰는 개체 ${used}개`, 'info');
    }
  }
  const gOnly = gs.filter(k => !state.matlib || !state.matlib[k]);
  if (gOnly.length) logLine(`  전역 재질(모든 도면에서 이름으로 사용 가능): ${gOnly.join(' · ')}`, 'info');
}
// material 공유 <이름> — 문서 라이브러리 항목을 전역(이 브라우저의 모든 도면)으로 올린다
function matLibShare(name) {
  const L = matLibGet(name);
  if (!L) { logLine(`  "${name}" 이라는 저장된 재질이 없습니다 — 먼저 material 저장 <이름>.`, 'warn'); return; }
  if (!matGlobalSet(name, L)) { logLine('  ✗ 전역 저장 실패 — 브라우저 저장 용량 초과(사진 질감이 너무 큼)일 수 있습니다.', 'warn'); return; }
  logLine(`  ✔ 재질 "${name}" 전역 공유 — 다른 도면에서도 material ${name} 으로 바로 씁니다`, 'ok');
  logLine('     전역에서 빼려면 material 공유해제 <이름>.', 'info');
}
function matLibUnshare(name) {
  if (!matGlobalDelete(name)) { logLine(`  전역에 "${name}" 이 없습니다.`, 'warn'); return; }
  logLine(`  ▷ 전역 재질 "${name}" 제거 — 이미 가져다 쓴 도면들에는 사본이 남아 있습니다`, 'ok');
}
function matLibDelete(name) {
  if (!matLibGet(name)) { logLine(`  "${name}" 이라는 재질이 없습니다.`, 'warn'); return; }
  const used = state.entities.filter(e => e.mat === MAT_LIB_PREFIX + name);
  pushUndo();
  delete state.matlib[name];
  // 참조를 그대로 두면 matOf 가 null 을 줘서 조용히 기본 재질이 된다 — 그래서 명시적으로 알린다
  for (const e of used) delete e.mat;
  logLine(`  ▷ 재질 "${name}" 삭제` + (used.length ? ` — 쓰던 개체 ${used.length}개는 기본 재질로 돌아갑니다` : ''), 'ok');
  renderProps(); matRefresh();
}
// 사진을 질감으로. 라이브러리 재질에만 붙인다 — 이미지는 무거워서 개체마다 복사되면 안 된다.
function matLibImage(sel) {
  const e = sel[0];
  if (!matIsLib(e.mat)) {
    logLine('  사진 질감은 저장된 재질에만 붙일 수 있습니다.', 'warn');
    logLine('  먼저 material 저장 <이름> 으로 재질을 만든 뒤 다시 시도하세요 — 사진은 무거워서', 'info');
    logLine('  개체마다 복사하지 않고 재질 하나가 갖고 여러 개체가 함께 씁니다.', 'info');
    return;
  }
  const name = matLibName(e.mat);
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.addEventListener('change', () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      const im = new Image();
      im.onload = () => {
        const uri = matImgShrink(im);   // 512px + JPEG — 원본을 담으면 도면이 MB 단위로 붓는다
        pushUndo();
        state.matlib[name].img = uri;
        _matTexCache.clear();
        logLine(`  ✔ 사진 질감 — "${name}" 에 ${f.name} (${im.naturalWidth}x${im.naturalHeight} → ${MAT_IMG_MAX}px 로 줄여 ${Math.round(uri.length / 1024)}KB)`, 'ok');
        logLine('     질감 크기(mm)로 사진 한 장이 덮는 실제 크기를 맞추세요.', 'info');
        renderProps(); matRefresh();
      };
      im.onerror = () => logLine('  ✗ 이미지를 읽지 못했습니다.', 'warn');
      im.src = rd.result;
    };
    rd.onerror = () => logLine('  ✗ 파일을 읽지 못했습니다.', 'warn');
    rd.readAsDataURL(f);
  });
  inp.click();
}
// material / 재질 — 선택한 개체에 재질을 지정 (라이노: 개체 속성의 재질)
function cmdMaterial(arg) {
  const sel = [...state.selection].map(id => state.entities.find(e => e.id === id)).filter(Boolean);
  const a = String(arg || '').trim();
  const list = () => Object.keys(MAT_PRESETS).map(k => `${k}(${MAT_PRESETS[k].ko})`).join(' · ')
    + (Object.keys(state.matlib || {}).length ? '\n  저장된 재질: ' + Object.keys(state.matlib).join(' · ') : '');
  // 선택이 필요 없는 하위명령 — 목록·공유·공유해제는 라이브러리 관리다
  const mgmt = a.match(/^(목록|list|공유해제|unshare|공유|share)\s*(.*)$/i);
  if (mgmt) {
    const cmd = mgmt[1].toLowerCase(), rest = mgmt[2].trim();
    if (/^(목록|list)$/.test(cmd)) { matLibList(); return; }
    if (/^(공유해제|unshare)$/.test(cmd)) {
      if (!rest) { logLine('  사용법: material 공유해제 <이름>', 'warn'); return; }
      matLibUnshare(rest); return;
    }
    if (!rest) { logLine('  사용법: material 공유 <이름> — 저장된 재질을 모든 도면에서 쓰게 합니다', 'warn'); matLibList(); return; }
    matLibShare(rest); return;
  }
  if (!sel.length) {
    logLine('  재질을 지정할 개체를 먼저 선택하세요.', 'warn');
    logLine('  사용법: material 콘크리트 · material 해제 · material 저장 <이름> · material 이미지 · material 목록 · material 공유 <이름>', 'info');
    logLine('  재질: ' + list(), 'info');
    return;
  }
  // 하위명령 — material 저장 <이름> / 삭제 <이름> / 이미지 (목록·공유는 위에서 선택 없이 처리)
  const sub = a.match(/^(저장|save|삭제|delete|이미지|image)\s*(.*)$/i);
  if (sub) {
    const cmd = sub[1].toLowerCase(), rest = sub[2].trim();
    if (/^(삭제|delete)$/.test(cmd)) {
      if (!rest) { logLine('  사용법: material 삭제 <이름>', 'warn'); matLibList(); return; }
      matLibDelete(rest); return;
    }
    if (/^(저장|save)$/.test(cmd)) {
      if (!rest) { logLine('  사용법: material 저장 <이름> — 선택한 개체의 재질을 그 이름으로 저장합니다', 'warn'); return; }
      matLibSave(rest, sel); return;
    }
    if (/^(이미지|image)$/.test(cmd)) { matLibImage(sel); return; }
  }
  if (/^(해제|off|none|제거|clear)$/i.test(a)) {
    pushUndo();
    for (const e of sel) { delete e.mat; delete e.matx; }
    logLine(`  ▷ 재질 해제 — 개체 ${sel.length}개가 기본 재질로 돌아갑니다`, 'ok');
    matRefresh();
    return;
  }
  const key = matKey(a);
  if (!key) {
    if (a) logLine(`  ✗ 모르는 재질입니다: ${a}`, 'warn');
    logLine('  재질: ' + list(), 'info');
    logLine('  사용법: material 콘크리트 · material wood · material 해제', 'info');
    return;
  }
  pushUndo();
  for (const e of sel) { if (e.mat !== key) delete e.matx; e.mat = key; }   // 재질이 바뀌면 옛 재정의는 무의미
  const P = matOf(sel[0]);
  const bits = [`거칠기 ${P.rough}`, P.metal ? '금속' : null, P.tex ? `질감 ${P.tex}(${P.scale}mm)` : null,
    P.transmission ? `투과 ${Math.round(P.transmission * 100)}% · 굴절률 ${P.ior}` : null].filter(Boolean).join(' · ');
  logLine(`  ✔ 재질 ${P.ko} — 개체 ${sel.length}개 · ${bits}`, 'ok');
  logLine('     질감·반사는 rendered(렌더링 뷰)·raytrace 에서 보입니다.', 'info');
  matRefresh();
}
// 재질이 바뀌면 세 렌더러를 모두 무효화한다 — 한 곳만 갱신하면 화면마다 다른 재질이 보인다
function matRefresh() {
  if (typeof rview !== 'undefined' && rview) rview.sig = '';
  if (rt && rt.on) { rt.geoSig = ''; rtLightsChanged(); }
  renderProps();
  if (typeof v3 !== 'undefined' && v3 && is3DActive()) { v3.solids = bimSolids(); render3D(); } else draw();
}
function rtStdMat(T, hex, emissiveRGB, emissiveIntensity) {
  const [r, g, b] = hexToRgb(hex || '#b9b2a6');
  const m = new T.MeshStandardMaterial({
    color: new T.Color(r / 255, g / 255, b / 255), roughness: 0.6, metalness: 0,
  });
  if (emissiveRGB) { m.emissive = new T.Color(emissiveRGB[0], emissiveRGB[1], emissiveRGB[2]); m.emissiveIntensity = emissiveIntensity; }
  return m;
}
// Parti 형상 → 삼각형. 솔리드(폴리+z)와 메시를 개체별로 묶는다.
function rtTrisByEntity() {
  const out = new Map(); // eid → {tris:[[p,p,p]...], color, area}
  const put = (eid, color) => { let o = out.get(eid); if (!o) out.set(eid, o = { tris: [], color, area: 0 }); return o; };
  for (const s of (v3.solids || [])) {
    let P = s.poly; const n = P ? P.length : 0; if (!P || n < 3) continue;
    const o = put(s.eid, s.color || '#b9b2a6');
    let zt = s.zt || P.map(() => s.z1), zb = s.zb || P.map(() => s.z0);
    // ★감기 방향 정규화 — 반드시 반시계(CCW)로 맞춘다.
    // bimSolids 의 벽 밴드는 시계방향(CW)으로 나오고, 사용자가 그린 폴리라인도 방향이 제멋대로다.
    // CW 폴리곤을 그대로 부채꼴 삼각형화하면 윗면 법선이 아래를 향해 three 의 FrontSide 컬링이
    // 윗면을 지운다 — 렌더링 뷰에서 벽 두께(윗면 밴드)가 사라져 보이던 버그의 원인.
    // (옆면 법선도 안쪽으로 뒤집혀 조명까지 틀렸다. 소프트웨어 뷰는 양면을 그려 멀쩡했다.)
    { let a2 = 0;
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; a2 += P[i][0] * P[j][1] - P[j][0] * P[i][1]; }
      if (a2 < 0) { P = P.slice().reverse(); zt = zt.slice().reverse(); zb = zb.slice().reverse(); }
    }
    for (let i = 1; i < n - 1; i++) {
      o.tris.push([[P[0][0], P[0][1], zt[0]], [P[i][0], P[i][1], zt[i]], [P[i + 1][0], P[i + 1][1], zt[i + 1]]]);
      o.tris.push([[P[0][0], P[0][1], zb[0]], [P[i + 1][0], P[i + 1][1], zb[i + 1]], [P[i][0], P[i][1], zb[i]]]);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = [P[i][0], P[i][1], zb[i]], b = [P[j][0], P[j][1], zb[j]];
      const c = [P[j][0], P[j][1], zt[j]], d = [P[i][0], P[i][1], zt[i]];
      o.tris.push([a, b, c]); o.tris.push([a, c, d]);
    }
  }
  for (const e of state.entities) {
    if (e.type !== 'MESH' || !e.tris) continue;
    const lay = getLayer(e.layer); if (lay && !lay.visible) continue;
    const o = put(e.id, bimSolidColor(e, '#b9b2a6'));
    for (const t of e.tris) o.tris.push(t);
  }
  for (const o of out.values()) o.area = o.tris.reduce((a, t) => a + triArea(t), 0);
  return out;
}
function triArea(t) {
  const ux = t[1][0] - t[0][0], uy = t[1][1] - t[0][1], uz = t[1][2] - t[0][2];
  const vx = t[2][0] - t[0][0], vy = t[2][1] - t[0][1], vz = t[2][2] - t[0][2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}
// 지오메트리 서명 — 실제로 형상이 바뀔 때만 BVH를 다시 만든다 (§2.3).
// 광원 세기·색온도만 바뀌면 이 값이 그대로라 재빌드를 건너뛴다 = 슬라이더 UX의 핵심.
function rtGeoSig() {
  // 레이어 표시 상태도 시그니처에 — 메시만 있는 레이어를 숨기면 solids 수·개체 수가 그대로라
  // 렌더링 뷰가 옛 장면을 계속 보여줬다 (2026-07-20 레이어 숨김 3D 미반영과 같은 뿌리)
  let h = state.entities.length + '|' + (v3.solids || []).length + '|'
    + 'V' + state.layers.map(l => (l.visible === false ? '0' : '1')).join('') + '|';
  // 라이브러리 항목을 고치면 그걸 쓰는 개체가 전부 바뀌어야 한다 → 라이브러리도 시그니처에
  for (const k in (state.matlib || {})) {
    const L = state.matlib[k];
    h += 'L' + k + ':' + L.base + ',' + (L.color || '') + ',' + (L.scale || '') + ',' + (L.rough != null ? L.rough : '')
       + ',' + (L.metal != null ? L.metal : '') + ',' + (L.img ? L.img.length : 0) + ';';
  }
  // 재질·재정의가 바뀌면 재빌드 (재정의를 빼먹으면 색·질감 크기를 바꿔도 화면이 그대로다)
  for (const e of state.entities) if (e.mat) {
    h += 'T' + e.id + ':' + e.mat;
    const x = e.matx;
    if (x) h += '/' + (x.color || '') + ',' + (x.scale || '') + ',' + (x.rough != null ? x.rough : '') + ',' + (x.metal != null ? x.metal : '');
    h += ';';
  }
  for (const s of (v3.solids || [])) h += s.eid + ',' + Math.round(s.z0) + ',' + Math.round(s.z1) + ',' + s.poly.length + ';';
  for (const e of state.entities) if (e.type === 'MESH') h += 'M' + e.id + ',' + (e.tris || []).length + ';';
  return h;
}
// 씬 단위는 mm. three는 단위 불문이지만 감쇠가 스케일에 좌우되므로 m로 환산해 넘긴다 (§3.2).
const RT_MM = 0.001;
// 루멘 → 발광 radiance: 램버시안 발광면이면 L = Φ / (A·π)  [lm/(m²·sr)]
// 이 값은 실제 단위라 수백~수천이 되고, 화면에 담으려면 노출(tone mapping)이 필요하다.
// RT_EXPOSURE는 전형적인 실내가 적정 밝기로 보이도록 정한 값. 근거(손계산):
//   800lm 다운라이트 2개 · 천장 2.55m → 광도 63.7cd → 바닥 조도 19.6lux
//   바닥 #9a9a9a 의 선형 반사율 0.323 → 바닥 휘도 L = E·ρ/π ≈ 2.0 cd/m²
//   이 값을 화면 범위에 담을 노출은 손계산(0.2)이 과했고, 실측 스윕으로 0.05로 정했다:
//     노출 0.2 → 바닥 213/189 (포화)   0.1 → 175/142   0.05 → 125/92 (계조 살아있음)   0.02 → 65/44 (어두움)
//   (램프 자체는 1326 cd/m² 라 어느 노출에서도 하얗게 포화 — 광원을 직접 보는 것이므로 정상)
function rtRadiance(lm, areaM2) { return lm / (Math.max(1e-4, areaM2) * Math.PI); }
// ─── 노출 ───
// 실내 인공조명과 주광은 밝기가 2,000배 차이 난다. 실제 카메라가 실내·실외에서 노출을 바꾸는
// 것과 같은 문제라, 하나의 고정값으로는 둘 다 담을 수 없다.
//   800lm 램프 실내: 바닥 휘도 ≈ 2 cd/m²
//   맑은 날 오후 주광: 바닥 휘도 ≈ 4,500 cd/m²
// 그래서 환경에 따라 바꾼다. 두 값 모두 실측 스윕으로 정했다.
//   검은 환경 스윕(바닥/램프): 0.2 → 213/189(포화) · 0.1 → 175/142 · 0.05 → 125/92 ← 채택 · 0.02 → 65/44
//   주광 스윕(바닥):          5e-4 → 167 · 1e-4 → 159 · 5e-5 → 150 · 2.5e-5 → 133 ← 채택 · 1e-5 → 96
const RT_EXPOSURE = 0.05;         // 검은 환경 (인공조명만)
const RT_EXPOSURE_DAY = 2.5e-5;   // 주광 (물리 하늘 + 태양)
function rtExposure() {
  if (rt.exposure) return rt.exposure;                      // 사용자가 정한 값이 있으면 그것
  // rt.env 는 레이트레이싱에 들어가야 태양과 동기화된다(rtEnter→rtSetEnv). 렌더링 뷰처럼
  // rt 밖에서 노출이 필요하면 태양에서 직접 파생한다 — 안 그러면 stale 'black' 탓에
  // 주광 장면(수만 lux)에 실내 노출(0.05)이 걸려 화면이 하얗게 타버린다. (태양이 유일한 진실)
  const env = rt.on ? rt.env : rtEnvWanted();
  return env === 'day' ? RT_EXPOSURE_DAY : RT_EXPOSURE;
}
function rtApplyExposure() {
  if (rt.renderer) rt.renderer.toneMappingExposure = rtExposure();
}
// ground — 렌더 전용 대지 평면 토글 (렌더링 뷰·레이트레이싱 공통)
function cmdGround() {
  rt.ground = !rt.ground;
  logLine(rt.ground ? '  ▷ 대지 켬 — 건물 밖 그림자가 대지에 떨어집니다 (렌더 전용, 도형 아님)'
                    : '  ▷ 대지 끔', 'info');
  if (typeof rview !== 'undefined' && rview) rview.sig = '';
  if (rt.on) { rt.geoSig = ''; rtLightsChanged(); }
  if (typeof v3 !== 'undefined' && v3 && is3DActive()) render3D();
}
// rtquality — 레이트레이싱 품질 프리셋. 낮음/보통/높음/최고 또는 숫자(spp).
function cmdRtQuality(arg) {
  const a = String(arg || '').trim();
  if (!a) {
    logLine(`  현재 품질: ${rt.q.name} — ${rt.q.spp} spp · 반사 ${rt.q.bounces}회`, 'info');
    logLine('  사용법: rtquality 낮음|보통|높음|최고 · rtquality 128 (spp 직접)', 'info');
    return;
  }
  const preset = RT_QUALITY[a];
  if (preset) {
    rt.q = { spp: preset.spp, bounces: preset.bounces, name: a };
  } else {
    const n = parseInt(a, 10);
    if (!isFinite(n) || n < 1) { logLine(`  ✗ 모르는 품질: ${a} — 낮음/보통/높음/최고 또는 숫자`, 'warn'); return; }
    rt.q = { spp: Math.min(8192, n), bounces: rt.q.bounces, name: n + 'spp' };
  }
  logLine(`  ✔ 레이트레이싱 품질 ${rt.q.name} — ${rt.q.spp} spp · 반사 ${rt.q.bounces}회`, 'ok');
  if (rt.on && rt.tracer) {
    rt.tracer.bounces = rt.q.bounces;
    rtReset();               // 품질을 바꾸면 처음부터 다시 누적 (spp 만 늘린 경우도 단순하게 통일)
  }
}
// 라이노에는 없는 개념이라 이름은 렌더러 관례를 따른다.
function cmdExposure(arg) {
  const a = (arg || '').trim();
  if (!a) {
    logLine(`  노출 ${rtExposure().toExponential(2)} ${rt.exposure ? '(직접 지정)' : '(환경에 따라 자동: 주광 ' + RT_EXPOSURE_DAY.toExponential(1) + ' · 검은 환경 ' + RT_EXPOSURE + ')'}`, 'info');
    logLine('     설정: exposure 2.5e-5 · 자동으로 되돌리려면 exposure auto', 'info');
    return;
  }
  if (/^(auto|자동)$/i.test(a)) { rt.exposure = 0; }
  else {
    const v = parseFloat(a);
    if (!isFinite(v) || v <= 0) { logLine('  노출은 0보다 큰 수로 입력하세요 (예: exposure 2.5e-5)', 'warn'); return; }
    rt.exposure = v;
  }
  rtApplyExposure(); rtReset();
  logLine(`  ▷ 노출 ${rtExposure().toExponential(2)}${rt.exposure ? '' : ' (자동)'}`, 'ok');
}

// ---------- 발광 메시 vs 해석적 광원 (노이즈의 근원) ----------
// 광원을 발광 메시로만 두면 패스트레이서는 그 면을 '우연히 맞혀야만' 빛을 찾는다.
// 작은 광원일수록 확률이 낮아 파이어플라이(흰 점)가 생기고, 밝기까지 과소평가된다.
// 해석적 광원(PointLight/SpotLight)을 두면 매 샘플마다 광원을 직접 조준(NEE)하므로 노이즈가 사라진다.
// 격리 harness 실측 (같은 장면·같은 20 spp, 바닥 영역):
//   발광 메시만        평균 3.5  · 상대노이즈(sd/평균) 5.92   ← 노이즈뿐 아니라 밝기도 틀림
//   PointLight(NEE)   평균 16.0 · 상대노이즈 0.43            ← 13.8배 개선
// 칸델라 = lm/(4π) 는 illuminanceAt 과 같은 '균등 배광' 모델이라, 이걸 쓰면
// 레이트레이싱 화면과 조도 분석 숫자가 같은 물리 모델을 공유하게 된다 (§4.3의 전제와 일치).
//
// 표시용 발광 radiance 상한. 광원을 직접 보면 밝게 빛나 보여야 하므로 남겨두되,
// 에너지는 해석적 광원이 낸다. RT_EXPOSURE 기준으로 이 값이면 하얗게 포화한다.
// ─── 하늘의 방향별 밝기 ───
// 아래 두 곳이 이 함수를 공유한다 → 3D 미리보기의 하늘과 Raytraced 의 하늘이 어긋날 수 없다.
//   ① 3D 뷰의 천공광(SH 투영)   ② Raytraced 환경맵(rtMakeSky)
// 태양 원반은 여기 넣지 않는다 — 직사광은 따로 다룬다(3D 뷰는 sunLight, RT 는 원반 텍셀).
// ─── 날씨: 운량과 흐린 하늘 ───
// Preetham(맑음)과 Moon–Spencer(흐림)를 운량으로 섞는다.
//   흐린 하늘 L(θ) = Lz·(1 + 2cosθ)/3  — 천정이 지평선의 3배. 고전적 CIE 흐림 하늘.
//   Lz=1 일 때 수평면 조도 E = ∫L·cosθ dΩ = 2π/3·[1/2 + 2/3] = 7π/9 (직접 적분해서 나온 값).
const SKY_OVERCAST_E = 7 * Math.PI / 9;
// 흐린 하늘은 파랗지 않다 — 약간 찬 회백색. 광도(luminance)가 정확히 1 이 되도록 정규화해서
// '색'과 '밝기'를 분리한다 (밝기는 아래 Ed 가 정한다).
const SKY_OVERCAST_RGB = (() => {
  const c = [0.94, 0.99, 1.10];
  const Y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return [c[0] / Y, c[1] / Y, c[2] / Y];
})();
// ─── 구름 모양 ───
// 운량은 '하늘이 얼마나 덮였나' 라는 양이고, 여기서는 '어디가 덮였나' 를 그린다.
// 결정론적 값 노이즈 + fBm — 새로고침마다 구름이 움직이면 렌더 비교가 불가능해진다.
function _skyHash(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}
function _skyVNoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = _skyHash(xi, yi), b = _skyHash(xi + 1, yi), c = _skyHash(xi, yi + 1), d = _skyHash(xi + 1, yi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
const _SKY_FBM_OCT = 5, _SKY_FBM_NORM = 1 / (1 - Math.pow(0.5, _SKY_FBM_OCT));
function _skyFbm(x, y) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < _SKY_FBM_OCT; i++) { s += a * _skyVNoise(x * f, y * f); a *= 0.5; f *= 2; }
  return s * _SKY_FBM_NORM;   // 대략 [0,1]
}
const _sstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0 || 1e-9))); return t * t * (3 - 2 * t); };
// 구름층의 시야 압축 — 방향을 구름 '평면' 에 투영한다. 천정은 성기고 지평선으로 갈수록 촘촘해진다
// (실제로 구름이 지평선에서 뭉쳐 보이는 이유). dz 가 0 에 가까우면 좌표가 폭주하므로 잘라낸다.
const SKY_CLOUD_TILE = 1.7;      // 하늘을 가로지르는 구름 덩어리 개수 (클수록 작은 구름)
const SKY_CLOUD_SOFT = 0.13;     // 가장자리 부드러움
// ─── 임계값 보정 ───
// 임계값을 그냥 (1−운량) 으로 두면 안 된다. fBm 값이 0.5 근처에 몰려 있어서 덮임 비율이
// 임계값에 대해 심하게 비선형이다 — 실측: 운량 20% 로 두면 하늘의 1% 만 덮였고,
// 그 1% 가 확산광 20% 를 지느라 정규화 계수가 31 배로 튀어 구름이 발광하는 덩어리가 됐다.
// 그래서 fBm 값의 '코사인 가중 분포' 를 미리 구해 분위수로 임계값을 정한다.
// 구름장과 투영이 고정이라 이 분포도 고정이다 — 처음 쓸 때 한 번만 만든다.
let _skyCloudQ = null;
function skyCloudQuantiles() {
  if (_skyCloudQ) return _skyCloudQ;
  const NT = 64, NP = 128, dth = (Math.PI / 2) / NT, dph = 2 * Math.PI / NP;
  const arr = [];
  let W = 0;
  for (let i = 0; i < NT; i++) {
    const th = (i + 0.5) * dth, st = Math.sin(th), ct = Math.cos(th);
    if (ct <= 0.03) continue;                 // 지평선 근처는 마스크가 평균값이라 분포에 안 들어간다
    const t = SKY_CLOUD_TILE / ct;
    for (let j = 0; j < NP; j++) {
      const ph = (j + 0.5) * dph;
      const v = _skyFbm(st * Math.cos(ph) * t, st * Math.sin(ph) * t);
      const w = ct * st * dth * dph;          // 수평면 조도 기준 = 코사인 가중
      arr.push(v); arr.push(w); W += w;
    }
  }
  // [값, 가중] 쌍을 값 기준 정렬 (평탄 배열이라 인덱스로 짝을 맞춘다)
  const n = arr.length / 2, idx = new Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((p, q) => arr[p * 2] - arr[q * 2]);
  const vs = new Float64Array(n), ws = new Float64Array(n);
  for (let i = 0; i < n; i++) { vs[i] = arr[idx[i] * 2]; ws[i] = arr[idx[i] * 2 + 1]; }
  _skyCloudQ = { vs, ws, W };
  return _skyCloudQ;
}
// 덮임 비율이 cc 가 되는 임계값 — 위(밝은 쪽)에서부터 누적 가중이 cc·W 에 닿는 지점.
// ★한 칸짜리 캐시다. 예전엔 Map + cc.toFixed(3) 였는데, 이 함수는 **텍셀마다** 불린다:
// 하늘 텍스처 3만 번, 레이트레이싱 환경맵은 52만 번 — 문자열을 52만 개 만들고 있었다.
// 한 장을 굽는 동안 cc 는 상수라 한 칸이면 100% 적중한다.
let _skyThK = -1, _skyThV = 0;
function skyCloudThreshold(cc) {
  if (cc === _skyThK) return _skyThV;
  const { vs, ws, W } = skyCloudQuantiles();
  let acc = 0, th = 0;
  for (let i = vs.length - 1; i >= 0; i--) {
    acc += ws[i];
    if (acc >= cc * W) { th = vs[i]; break; }
  }
  _skyThK = cc; _skyThV = th;
  return th;
}
// 방향 → 구름 덮임 0(맑음)~1(구름). 운량이 임계값을 정한다.
function skyCloudMask(cc, dx, dy, dz) {
  if (cc <= 0.005) return 0;
  if (cc >= 0.995) return 1;                 // 완전히 흐리면 모양이 없다 — 하늘 전체가 구름이다
  if (dz <= 0.03) return cc;                 // 지평선 근처: 뭉개져 평균값 (수치 폭주도 막는다)
  const t = SKY_CLOUD_TILE / dz;
  const f = _skyFbm(dx * t, dy * t);
  const th = skyCloudThreshold(cc);          // 덮임 비율이 실제로 운량과 맞도록 보정된 임계값
  return _sstep(th - SKY_CLOUD_SOFT, th + SKY_CLOUD_SOFT, f);
}
// ─── 하늘 적분 ───
// 한 번의 격자 순회로 셋을 구한다:
//   EdClear = ∫ Y_clear·cosθ dΩ        맑은 하늘의 확산 수평조도
//   A       = ∫ (1−m)·Y_clear·cosθ dΩ  구름이 안 덮은 곳의 맑은 하늘 몫
//   B       = ∫ m·f_oc·cosθ dΩ         구름이 덮은 곳의 흐림 하늘 몫
// 여기서 α=(1−cc)·EdClear/A, β=cc·E_oc/B 로 정규화하면 **구름이 어떤 모양이든**
// 전체 확산조도가 정확히 Ed 가 된다. m≡cc(균일)이면 α=β=1 이라 구름 없던 시절 식과 완전히 같다.
// 구름은 하늘에 고정돼 있고 태양은 방위를 따라 도므로, 적분은 태양 방위에 불변이 아니다
// → 캐시 키에 태양 방향이 들어간다 (skyCtx 가 통째로 캐시하므로 프레임당 한 번도 안 돈다).
function skySolve(K) {
  const NT = 32, NP = 64, dth = (Math.PI / 2) / NT, dph = 2 * Math.PI / NP;
  let Ed = 0, A = 0, B = 0;
  for (let i = 0; i < NT; i++) {
    const th = (i + 0.5) * dth, st = Math.sin(th), ct = Math.cos(th);
    for (let j = 0; j < NP; j++) {
      const ph = (j + 0.5) * dph;
      const dx = st * Math.cos(ph), dy = st * Math.sin(ph), dz = ct;
      const cg = Math.max(-1, Math.min(1, dx * K.sx + dy * K.sy + dz * K.sz));
      const r = skyRadiance(th, Math.acos(cg), K.thS, K.Tb);
      const Y = 0.2126 * r[0] + 0.7152 * r[1] + 0.0722 * r[2];
      const w = ct * st * dth * dph;
      const m = skyCloudMask(K.cc, dx, dy, dz);
      Ed += Y * w;
      A += (1 - m) * Y * w;
      B += m * ((1 + 2 * ct) / 3) * w;
    }
  }
  K.EdClear = Math.max(1e-6, Ed);
  K.ka = A > 1e-9 ? (1 - K.cc) * K.EdClear / A : 0;
  K.kb = B > 1e-9 ? K.cc * SKY_OVERCAST_E / B : 0;
}
const _skyCtxCache = new Map();
function skyCtx(S) {
  // 적분(skySolve)이 들어가면서 이 함수가 비싸졌다 — rviewSyncSun 은 매 프레임 부른다.
  // 태양 상태가 같으면 결과도 같으므로 통째로 캐시한다 (반환 객체를 고쳐 쓰는 곳은 없다).
  const ck = [S.y, S.mo, S.d, S.h, S.mi, S.lat, S.lon, S.tz, S.north, skyTurbidity(S), skyCloud(S)].join(',');
  const hit = _skyCtxCache.get(ck);
  if (hit) return hit;
  const K = skyCtxCompute(S);
  if (_skyCtxCache.size > 64) _skyCtxCache.clear();
  _skyCtxCache.set(ck, K);
  return K;
}
function skyCtxCompute(S) {
  const sd = sunDirection(S);
  const Tb = skyTurbidity(S), thS = Math.max(0, 90 - sd.alt) * SUN_D2R;
  const up = sd.alt > 0, cc = skyCloud(S);
  // 목표 확산 수평조도 Ed — 구름이 빛을 '없애는' 게 아니라 '직달에서 확산으로 옮긴다'.
  //   전천 조도: Kasten–Czeplak(1980)  Eg = Eg_clear · (1 − 0.75·cc^3.4)
  //   직달:      Edn = Edn_clear · (1 − cc)      (가려지지 않은 비율 근사)
  //   확산:      Ed  = Eg − Edn·sin(고도)        (나머지가 전부 하늘에서 온다)
  // 그래서 흐릴수록 그림자는 사라지지만 하늘 자체는 오히려 밝아진다 — 흐린 날의 실제 모습이다.
  const K = { sx: sd.x, sy: sd.y, sz: sd.z, alt: sd.alt, thS, Tb, up, cc, Ed: 0, EdClear: 1, ka: 1, kb: 0 };
  if (up) {
    skySolve(K);                                   // EdClear·ka·kb 를 한 번에
    const sinA = Math.sin(sd.alt * SUN_D2R);
    const EdnClear = sunDirectIlluminanceClear(S);
    const Eg = (EdnClear * sinA + K.EdClear) * (1 - 0.75 * Math.pow(cc, 3.4));
    K.Ed = Math.max(0, Eg - EdnClear * (1 - cc) * sinA);
  }
  return K;
}
// 상반구 한 방향의 하늘 radiance — 맑은 성분과 흐린 성분을 운량으로 섞는다.
// 각 성분을 '단위 조도당' 으로 정규화한 뒤 목표 조도 Ed 를 곱하므로,
// 혼합해도 수평면 확산조도가 정확히 Ed 가 된다. cc=0 이면 Ed=EdClear 라 예전 값과 동일하다.
function skyBlend(K, th, gamma, dx, dy, dz, out) {
  const c = skyRadiance(th, gamma, K.thS, K.Tb);
  const cz = Math.max(0, dz);
  const m = skyCloudMask(K.cc, dx, dy, dz);              // 이 방향이 구름에 덮였나 (0~1)
  const w = (1 - m) * K.ka / K.EdClear;                  // 구름 사이로 보이는 맑은 하늘
  const oc = m * K.kb * ((1 + 2 * cz) / 3) / SKY_OVERCAST_E;  // 구름 자체 (흐림 하늘 분포)
  out[0] = K.Ed * (w * c[0] + oc * SKY_OVERCAST_RGB[0]);
  out[1] = K.Ed * (w * c[1] + oc * SKY_OVERCAST_RGB[1]);
  out[2] = K.Ed * (w * c[2] + oc * SKY_OVERCAST_RGB[2]);
  return out;
}
// 씬 좌표(Z-up) 방향 하나의 하늘 radiance [cd/m²]
function skyDirRadiance(K, dx, dy, dz, out) {
  if (!K.up) { out[0] = 0.006; out[1] = 0.008; out[2] = 0.014; return out; }   // 밤
  const gamma = Math.acos(Math.max(-1, Math.min(1, dx * K.sx + dy * K.sy + dz * K.sz)));
  const cz = Math.max(-1, Math.min(1, dz));
  if (cz < 0) {   // 아래 반구 = 지표가 되반사하는 빛. 이게 있어야 처마 밑·차양 아래가 죽지 않는다.
    // 지표는 하늘 전체의 평균을 되반사한다 — 구름 무늬까지 비추면 땅에 구름이 찍힌다.
    // dz=0.01 이면 skyCloudMask 가 평균값(cc)을 주므로 자연히 무늬 없는 평균이 된다.
    skyBlend(K, Math.PI / 2 - 0.01, gamma, dx, dy, 0.01, out);
    out[0] *= SKY_GROUND_ALBEDO; out[1] *= SKY_GROUND_ALBEDO; out[2] *= SKY_GROUND_ALBEDO;
    return out;
  }
  return skyBlend(K, Math.acos(cz), gamma, dx, dy, dz, out);
}

// ─── 방향별 천공광 (구면조화 L2) ───
// 면의 조도는 E(n) = ∫ L(ω)·max(0, n·ω) dω 다. 면마다 반구를 적분하면 못 쓴다.
// 그래서 하늘을 구면조화 9계수로 한 번 접어두고, 면마다 내적 한 번으로 조도를 얻는다.
// Ramamoorthi & Hanrahan(2001): 조도는 코사인에 뭉개져 저주파라 L2(9계수)로 오차 ~1%.
// 이게 있어야 하늘을 보는 바닥, 아래를 보는 처마 밑, 북측 벽이 서로 다른 밝기가 된다 —
// 상수 환경광은 이 차이를 전부 지워서 형태를 뭉갠다.
function shBasis(x, y, z, Y) {
  Y[0] = 0.282095;
  Y[1] = 0.488603 * y; Y[2] = 0.488603 * z; Y[3] = 0.488603 * x;
  Y[4] = 1.092548 * x * y; Y[5] = 1.092548 * y * z;
  Y[6] = 0.315392 * (3 * z * z - 1); Y[7] = 1.092548 * x * z;
  Y[8] = 0.546274 * (x * x - y * y);
  return Y;
}
// 코사인 커널의 SH 변환값 — l=0: π, l=1: 2π/3, l=2: π/4
const SH_A = [Math.PI, 2 * Math.PI / 3, 2 * Math.PI / 3, 2 * Math.PI / 3,
  Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4];
const _shY = new Float64Array(9), _shRGB = [0, 0, 0];
function skyProjectSH(S) {
  const K = skyCtx(S);
  const c = new Float64Array(27);            // 9계수 × RGB
  const NT = 48, NP = 96;                    // 구면 전체(하늘+지면 반사)를 훑는다
  for (let i = 0; i < NT; i++) {
    const th = (i + 0.5) / NT * Math.PI, st = Math.sin(th), ct = Math.cos(th);
    const dOm = (Math.PI / NT) * (2 * Math.PI / NP) * st;
    for (let j = 0; j < NP; j++) {
      const ph = (j + 0.5) / NP * 2 * Math.PI;
      const dx = st * Math.cos(ph), dy = st * Math.sin(ph), dz = ct;
      skyDirRadiance(K, dx, dy, dz, _shRGB);
      shBasis(dx, dy, dz, _shY);
      for (let k = 0; k < 9; k++) {
        const w = _shY[k] * dOm;
        c[k * 3] += _shRGB[0] * w; c[k * 3 + 1] += _shRGB[1] * w; c[k * 3 + 2] += _shRGB[2] * w;
      }
    }
  }
  return c;
}
// 법선 n 이 받는 천공 조도 [lux]
function skyIrradiance(c, nx, ny, nz, out) {
  shBasis(nx, ny, nz, _shY);
  let r = 0, g = 0, b = 0;
  for (let k = 0; k < 9; k++) {
    const w = SH_A[k] * _shY[k];
    r += c[k * 3] * w; g += c[k * 3 + 1] * w; b += c[k * 3 + 2] * w;
  }
  out[0] = Math.max(0, r); out[1] = Math.max(0, g); out[2] = Math.max(0, b);
  return out;
}
// 태양 설정이 그대로면 다시 접지 않는다 (48×96 = 4,608 방향 × Preetham)
function skySH() {
  if (!sunOn()) return null;
  const S = sunState();
  const sig = [S.lat, S.lon, S.tz, S.y, S.mo, S.d, S.h, S.mi, S.north, skyTurbidity(S)].join(',');
  if (v3._shSig !== sig) { v3._sh = skyProjectSH(S); v3._shSig = sig; }
  return v3._sh;
}

// ─── 하늘 → HDR 등장방형 환경맵 ───
// 태양을 DirectionalLight 로 두지 않고 하늘 텍스처에 원반으로 박는 이유:
//  · 라이브러리의 DIR_LIGHT 분기는 방향만 넘기고 radius 를 넘기지 않는다(소스 확인) → 델타 광원
//    → 그림자가 면도날처럼 날카롭다. 실제 태양은 각지름 0.53° 라 반음영이 생기고,
//    그 부드러움이 건축 사진의 핵심이다.
//  · 환경맵에 넣으면 EquirectHdrInfoUniform 의 중요도 샘플링(marginal/conditional CDF)이
//    태양을 직접 조준한다 → 반음영이 물리적으로 맞으면서 노이즈도 낮다. 프로덕션 렌더러의 방식.
const SKY_TEX_W = 1024, SKY_TEX_H = 512;
const SKY_HALF_MAX = 60000;   // half-float 상한 65,504 에 여유를 둔 값
// 라이브러리 셰이더의 등장방형 규약(util_functions.glsl 의 equirectDirectionToUv)을 그대로 뒤집은 것.
//   uv → theta = (u-0.5)·2π, phi = (1-v)·π  →  방향 = (sinφ·cosθ, cosφ, sinφ·sinθ)
// ★ three 의 Vector3.setFromSpherical 과 x·z 가 뒤바뀌어 있다. 라이브러리가 소스 주석에
//   "ray sampling x and z are swapped to align with expected background view" 라고 밝혀둔 그대로다.
//   setFromSpherical 을 쓰면 텍셀이 나타내는 방향을 잘못 계산해 태양이 거울상 위치에 구워진다
//   (실측: 카메라를 태양 쪽으로 정면으로 돌려도 화면에 포화 픽셀이 0개였다).
function skyTexelDir(theta, phi, out) {
  const sp = Math.sin(phi);
  return out.set(sp * Math.cos(theta), Math.cos(phi), sp * Math.sin(theta));
}
// 태양 원반이 텍셀 몇 개에 걸리든 조도가 흔들리면 안 된다.
// 1024×512 면 텍셀 하나가 약 0.35° 라 0.53° 태양은 겨우 1~2 텍셀이다.
// 그래서 원반이 실제로 덮는 입체각을 먼저 세어보고, 휘도를 그 값으로 나눈다.
//   원반휘도 = 직달조도 / (덮은 입체각)  →  ∑(휘도·입체각) = 직달조도 가 해상도와 무관하게 성립.
function skySunCoverage(sunV, T3) {
  const cosDisk = Math.cos(SUN_ANG_RADIUS);
  const d = new T3.Vector3();
  let omega = 0;
  for (let y = 0; y < SKY_TEX_H; y++) {
    const phi = (1 - (y + 0.5) / SKY_TEX_H) * Math.PI;
    const dPhi = Math.PI / SKY_TEX_H, dTheta = 2 * Math.PI / SKY_TEX_W;
    const solid = Math.sin(phi) * dPhi * dTheta;        // 텍셀의 입체각
    if (solid <= 0) continue;
    for (let x = 0; x < SKY_TEX_W; x++) {
      const theta = ((x + 0.5) / SKY_TEX_W - 0.5) * 2 * Math.PI;
      skyTexelDir(theta, phi, d);
      if (d.dot(sunV) >= cosDisk) omega += solid;
    }
  }
  return omega;
}
function rtMakeSky(S) {
  const { T: T3, P } = rt.mod;
  const sd = sunDirection(S);
  const sunV = new T3.Vector3(sd.x, sd.y, sd.z).normalize();
  const Tb = skyTurbidity(S);
  const up = sd.alt > 0;
  // ★하늘은 skyCtx/skyDirRadiance 가 유일한 진실이다.
  // 예전엔 여기서 skyRadiance 를 직접 불러 하늘을 '두 번째로' 구현하고 있었다. 그래서 날씨(운량)를
  // skyDirRadiance 에만 넣으면 레이트레이싱만 맑은 하늘로 남는 — 정확히 우리가 평면에서 겪은 —
  // 이중 구현 사고가 났을 것이다. 같은 함수를 쓰게 해서 그럴 방법 자체를 없앤다.
  const K = skyCtx({ ...S, turbidity: Tb });
  const _rgb = [0, 0, 0];
  // 원반이 실제로 덮은 입체각으로 휘도를 정규화 (해상도가 바뀌어도 조도가 같다)
  let diskL = 0;
  if (up) {
    const om = skySunCoverage(sunV, T3);
    // 운량이 오르면 sunDirectIlluminance 가 줄어 원반도 같이 흐려진다 (완전히 흐리면 0 = 원반 소멸)
    diskL = om > 1e-9 ? sunDirectIlluminance({ ...S, turbidity: Tb }) / om : 0;
  }
  const tex = new P.ProceduralEquirectTexture(SKY_TEX_W, SKY_TEX_H);
  const d = new T3.Vector3();
  const cosDisk = Math.cos(SUN_ANG_RADIUS);
  tex.generationCallback = (polar, uv, coord, color) => {
    skyTexelDir(polar.theta, polar.phi, d);
    // 씬은 Z-up 이다 — rtBuildScene 이 Parti 좌표를 그대로 넘긴다. 그래서 천정각을 z 로 잰다.
    skyDirRadiance(K, d.x, d.y, d.z, _rgb);   // 소프트웨어 뷰·천공광 SH 와 같은 함수
    const disk = (up && d.dot(sunV) >= cosDisk) ? diskL : 0;
    color.setRGB(_rgb[0] + disk, _rgb[1] + disk, _rgb[2] + disk);
  };
  tex.update();
  // ─ half-float 벽 ─
  // 라이브러리는 환경맵의 중요도 샘플링용 CDF 를 half-float 로 만든다(preprocessEnvMap 의
  // targetType 기본값). half-float 상한이 65,504 라 태양(약 1.2e9 cd/m²)을 그대로 넣으면
  // 65,504 로 잘린다. 그러면 CDF 상 태양이 하늘보다 겨우 5배 밝은 셈이 되어 중요도 샘플링이
  // 태양을 조준하지 않는다 → 직사광도 그림자도 사라진다.
  // (실측으로 확인: 바닥이 확산광만 받은 밝기(75)로 나왔다. 하늘은 정상인데 태양만 없었다.)
  // 그래서 텍스처에는 스케일을 나눠 담고 그 배율을 environmentIntensity 로 되돌린다.
  // CDF 는 상대값이라 스케일에 무관하고, 셰이더는 intensity 를 곱해 물리값을 복원한다.
  const data = tex.image.data;
  let mx = 0;
  for (let i = 0; i < data.length; i += 4) {
    const L = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    if (L > mx) mx = L;
  }
  const scale = Math.max(1, mx / SKY_HALF_MAX);
  if (scale > 1) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] /= scale; data[i + 1] /= scale; data[i + 2] /= scale;
    }
  }
  tex.needsUpdate = true;
  return { tex, scale };
}

const RT_EMITTER_LOOK = 40;
// 발광 메시가 실제로 낼 radiance 와 그때 나가는 루멘.
//  · 작고 밝은 광원 → 물리 radiance 가 상한을 훌쩍 넘음 → 상한으로 깎임 → 메시 몫 루멘은 미미
//  · 크고 어두운 면광원 → 물리 radiance 가 상한 아래 → 그대로 → 메시 몫이 전부 (= 지금 동작 유지)
// 해석적 광원에는 '전체 루멘 − 메시 몫'만 준다. 그래서 이중계산이 원리적으로 생기지 않고,
// 면적이 큰 발광체는 남는 몫이 0 이 되어 기존 동작이 그대로 보존된다.
function rtEmitterLook(L, areaM2) {
  const physR = rtRadiance(L.intensity, areaM2);
  const lookR = Math.min(RT_EMITTER_LOOK, physR);
  return { lookR, meshLm: lookR * Math.PI * areaM2 };
}
// 해석적 광원을 씬에 추가한다. meshLm: eid → 발광 메시가 이미 낸 루멘.
// 순수 곡선 광원(선·원)은 삼각형이 없어 발광 메시가 아예 없었다 — 여기서 처음으로 실제 빛을 낸다.
// IES 텍스처는 광원별로 캐시한다 — 매 프레임 180개 텍셀을 다시 굽지 않게.
const _iesTexCache = new Map();
function rtIesTexture(L, T3) {
  const key = L.id + '|' + (L.ies && L.ies.name || '');
  let t = _iesTexCache.get(key);
  if (!t) { t = iesToTexture(L.ies, T3); if (t) _iesTexCache.set(key, t); }
  return t;
}
function rtAddLights(T, scene, meshLm) {
  const P = rt.mod && rt.mod.P;
  const byId = new Map(state.entities.map(e => [e.id, e]));
  for (const L of state.lights) {
    if (!L.enabled) continue;
    if (soloLightId && L.id !== soloLightId) continue;
    const e = byId.get(L.objectId); if (!e) continue;
    const lay = getLayer(e.layer); if (lay && !lay.visible) continue;
    const rest = Math.max(0, (L.intensity || 0) - (meshLm.get(e.id) || 0));
    if (rest < 1e-3) continue;                    // 메시만으로 충분한 큰 발광면
    const pts = lightEmitters(e, L); if (!pts.length) continue;
    const c = lightColorRGB(L), mx = Math.max(c[0], c[1], c[2]) || 1;
    const col = new T.Color(c[0] / mx, c[1] / mx, c[2] / mx);
    // 스팟도 lm/(4π) 를 쓴다 — 원뿔로 몰아주면 조도 분석(균등 배광)과 어긋난다. §4.3 전제 유지.
    // 광속 보존: 배광이 있으면 그 모양의 입체각 적분으로 나눈다(균등이면 4π 라 기존과 동일).
    // 그래야 집광 배광이 '같은 루멘을 좁게 모아 더 밝은' 물리가 된다.
    const flux = rest / pts.length;
    const cd = flux / (L.ies ? iesFluxFactor(L.ies) : 4 * Math.PI);
    for (const p of pts) {
      let lt;
      if (L.type === 'spot' || L.ies) {
        // IES 가 붙으면 PhysicalSpotLight — iesMap·radius 는 이 클래스에만 있다.
        // 라이브러리(WebGLPathTracer)가 씬을 훑어 iesMap 텍스처를 모아 셰이더에 올린다:
        //   getPhotometricAttenuation: angle = acos(dot(posToLight, lightDir))/PI → texture(iesProfiles, ...).r
        // 즉 '정면축에서 벌어진 각' 으로 배광을 조회한다. 우리 스팟의 정면축은 아래(-Z)이고
        // IES 수직각 0° 도 nadir 라 그대로 맞물린다.
        const SpotCls = (L.ies && P && P.PhysicalSpotLight) ? P.PhysicalSpotLight : T.SpotLight;
        lt = new SpotCls(col, cd);
        // IES 가 있으면 배광이 각도를 정하므로 원뿔은 넓게 열어둔다 — 원뿔로 자르면 배광이 잘린다.
        lt.angle = L.ies ? Math.PI / 2 : Math.max(0.02, (L.spotAngleDeg || 60) * Math.PI / 360); // 전각 → 반각
        lt.penumbra = L.ies ? 0 : Math.min(1, Math.max(0, L.spotPenumbra == null ? 0.3 : L.spotPenumbra));
        if (L.ies && lt.iesMap !== undefined) {
          const tex = rtIesTexture(L, T);
          if (tex) lt.iesMap = tex;
        }
        // 광원 반지름 → 면적을 가진 스팟 = 부드러운 그림자 (0 이면 점광원 = 칼날 그림자)
        if (lt.radius !== undefined) lt.radius = Math.max(0, (L.iesRadius || 0)) * RT_MM;
        lt.target.position.set(p.x * RT_MM, p.y * RT_MM, (p.z - 1000) * RT_MM); // 아래를 비춘다
        lt.target.userData.rtLight = true;
        scene.add(lt.target);
      } else {
        lt = new T.PointLight(col, cd);
      }
      lt.position.set(p.x * RT_MM, p.y * RT_MM, p.z * RT_MM);
      lt.userData.rtLight = true;
      scene.add(lt);
    }
  }
}
// ── 렌더 전용 대지 평면 ──
// 건물이 검은 허공에 떠 있으면 그림자가 갈 곳이 없어 렌더가 죽는다 — D5 가 항상 대지를 까는 이유.
// 알베도는 하늘 모델이 이미 가정하는 SKY_GROUND_ALBEDO(0.2) 와 맞춘다: 천공광의 아래 반구
// 반사율과 실제 바닥 반사율이 같아야 조명이 자기모순이 없다.
// z 는 대지 기준면(레벨 0) 바로 아래 — 슬래브 윗면(z=0)과 겹치면 z-파이팅이 난다.
// 도형이 아니다: 선택·스냅·저장 어디에도 없고 렌더 씬에만 존재한다. ground 명령으로 토글.
const GROUND_Z_MM = -3;
function groundSizeMM() {
  const base = Math.max(60000, ((v3 && v3.fit) || 10000) * 6);
  if (!v3) return base;
  // ★현재 뷰가 보는 폭까지 덮는다 — 줌아웃 상태에서 대지의 '가장자리' 가 보이면
  // 만들지도 않은 원판이 떠 있는 것처럼 보인다 (사용자 스크린샷). 피치가 얕을수록
  // 지면이 화면 안쪽으로 멀리 보이므로 sin(pitch) 로 나눈다 (입면 근처는 0.25 로 캡).
  const viewW = (v3.fit * 1.4) / Math.max(v3.zoom || 1, 0.01);
  const sp = Math.max(0.25, Math.abs(Math.sin(v3.pitch == null ? 1 : v3.pitch)));
  return Math.max(base, viewW * 2 / sp);
}
function makeGroundMesh(T, forRt) {
  const R = groundSizeMM() * RT_MM;
  const geo = new T.CircleGeometry(R, 48);
  const mat = new T.MeshStandardMaterial({ color: new T.Color(SKY_GROUND_ALBEDO, SKY_GROUND_ALBEDO * 0.98, SKY_GROUND_ALBEDO * 0.92), roughness: 0.95, metalness: 0 });
  const m = new T.Mesh(geo, mat);
  m.position.z = GROUND_Z_MM * RT_MM;   // CircleGeometry 는 XY 평면 = 우리 씬의 바닥 방향 그대로
  if (!forRt) { m.receiveShadow = true; }
  m.userData.ground = true;
  return m;
}
function rtBuildScene(T) {
  const scene = new T.Scene();
  scene.background = new T.Color(0x000000);   // 실내 조명 검토 기본 = 완전한 어둠 (§2.2)
  scene.environment = null;
  const byEnt = rtTrisByEntity();
  const litIds = new Map();                    // eid → LightSource
  for (const L of state.lights) if (L.enabled && (!soloLightId || soloLightId === L.id)) litIds.set(L.objectId, L);
  const entById = new Map(state.entities.map(e => [e.id, e]));
  let triCount = 0;
  const meshLm = new Map();                    // eid → 발광 메시가 내는 루멘 (해석적 광원에서 뺄 몫)
  for (const [eid, o] of byEnt) {
    if (!o.tris.length) continue;
    triCount += o.tris.length;
    const ent = entById.get(eid);
    const geo = matGeo(T, o.tris, ent);          // 재질의 UV(월드 박스 매핑) 포함
    const L = litIds.get(eid);
    let mat;
    if (L) {
      const c = lightColorRGB(L), mx = Math.max(c[0], c[1], c[2]) || 1;
      const areaM2 = Math.max(1e-4, o.area * RT_MM * RT_MM);
      const { lookR, meshLm: lm } = rtEmitterLook(L, areaM2);
      meshLm.set(eid, lm);
      // 발광체는 재질을 타지 않는다 — 광원채는 '빛' 이지 '표면' 이 아니다 (rtEmitterLook 이 밝기의 진실)
      mat = rtStdMat(T, '#000000', [c[0] / mx, c[1] / mx, c[2] / mx], lookR);
    } else mat = matBuild(T, ent, o.color);      // ★렌더링 뷰와 같은 함수 = 두 화면의 재질이 어긋날 수 없다
    const mesh = new T.Mesh(geo, mat);
    mesh.userData.eid = eid;
    scene.add(mesh);
  }
  if (rt.ground) scene.add(makeGroundMesh(T, true));   // 대지 — GI·그림자를 받는다 (도형 아님)
  rtAddLights(T, scene, meshLm);   // 나머지 루멘은 해석적 광원이 낸다 (노이즈 제거)
  rt.triCount = triCount;
  return scene;
}
// Parti의 정투영 규약(proj3D)을 그대로 three 카메라로 옮긴다.
// 어긋나면 레이트레이싱 화면만 다른 각도로 나와 비교가 불가능해진다.
function rtSyncCamera(T, cam) {
  const c = Math.cos(v3.yaw), s = Math.sin(v3.yaw);
  const cp = Math.cos(v3.pitch), sp = Math.sin(v3.pitch);
  const right = new T.Vector3(c, -s, 0);
  const up = new T.Vector3(s * sp, c * sp, cp);
  const fwd = new T.Vector3(s * cp, c * cp, -sp);      // 화면 안쪽(깊이 증가) 방향
  const vp = v3.vp || { x: 0, y: 0, w: v3.cv.width, h: v3.cv.height };
  const k = Math.min(vp.w, vp.h) / (v3.fit * 1.4) * v3.zoom;   // px per mm
  const center = new T.Vector3(v3.cx, v3.cy, v3.cz);
  const target = center.clone().addScaledVector(right, -v3.panX).addScaledVector(up, -v3.panY);
  // ★카메라 거리는 시야 폭에도 비례해야 한다 — 고정(fit×4)이면 극단 줌아웃에서 프레임
  // 하단의 지면이 카메라 '등 뒤' 로 가서 near 클리핑으로 사라진다 (대지 하단이 하늘로 뚫려
  // 보이던 실측). 정투영이라 거리를 늘려도 그림은 동일하고 절두체만 넓어진다.
  const viewSpanMM = Math.max(vp.w, vp.h) / k;
  const D = Math.max(1, v3.fit * 4, viewSpanMM * 2);
  cam.up.copy(up);
  cam.position.copy(target).addScaledVector(fwd, -D).multiplyScalar(RT_MM);
  cam.lookAt(target.clone().multiplyScalar(RT_MM));
  const hw = (vp.w / 2) / k * RT_MM, hh = (vp.h / 2) / k * RT_MM;
  cam.left = -hw; cam.right = hw; cam.top = hh; cam.bottom = -hh;
  cam.near = 0.01; cam.far = (D * 4) * RT_MM;
  cam.updateProjectionMatrix(); cam.updateMatrixWorld();
}
// ═══════════ 렌더링 뷰 (Rendered) — 라이노의 Rendered 표시 모드 상당 ═══════════
// 사용자 요구: "라이노에서의 perspective 뷰에서 rendering뷰로 전환하는 방식" + "렌더링 방식은 D5".
// 역할 분담(중요 — D5의 '보이는 것만 그리기'를 올바른 곳에만 적용):
//   · Rendered(여기) = three.js 실시간 래스터. 프러스텀 컬링(three 기본)·해상도 캡이 유효하다.
//     즉시 열리고(BVH 없음) 궤도 회전을 실시간으로 따라온다.
//   · Raytraced(rt)  = 최종 확인. 화면 밖 기하도 GI·반사·그림자에 기여하므로 컬링 금지.
// 이 뷰는 '보기용' 프리뷰다. 태양 방향·시간·계절·탁도는 [태양] 패널 값을 그대로 따르지만,
// 조도 수치의 진실은 조도 분석(illuminanceAt)과 Raytraced 가 담당한다.
const rview = { on: false, vi: -1, renderer: null, scene: null, cam: null, cv: null, sun: null, hemi: null, sig: '', err: null, skyTex: null, skySig: '', pmrem: null, envTex: null, envFrom: null,
  // ao 기본 끔 — three 내장 GTAO 는 정투영 카메라에서 개활 평면에 얼룩(가짜 음영)을 만든다.
  // 앱 코드 0줄의 미니멀 독립 씬에서도 재현(2026-07-17) = 라이브러리 고유 한계. NaN 가드·thickness·
  // radius·샘플수·시선 보정·3D 거리 게이트·바이어스·디노이즈 강화 8개 축 전부 실측 실패.
  // 디자인 결과물에 불순물은 치명적(사용자) → 기본은 '항상 깨끗', AO 는 ao 명령으로 선택(경고 표시).
  ao: false, fx: null, _fxLoading: false, composer: null, _rp: null, _ao: null, _aoW: 0, _aoH: 0, _aoCfg: '',
  groundMat: null, groundMesh: null, groundR0: 1, cloudTex: null, cloudSig: '',   // 구름 그림자 (시각 전용 — 대지 알베도 변조)
  edges: false };   // 모서리 표시 (edges 명령 — 라이노 Rendered 의 모서리 옵션, 기본 끔)
// 뷰포트에 종속된 캔버스 — rt 의 inset:0 실수(4분할 전체를 덮음)를 반복하지 않는다.
function rviewCanvas() {
  if (rview.cv) return rview.cv;
  const ov = document.getElementById('bim3d'); if (!ov) return null;
  const c = document.createElement('canvas');
  c.id = 'rvcv';
  // pointer-events:none — 궤도/팬/선택 이벤트는 그대로 밑의 #b3cv 가 받는다 (조작 유지가 핵심)
  c.style.cssText = 'position:absolute;z-index:17;pointer-events:none;display:none;';
  ov.appendChild(c);
  rview.cv = c;
  return c;
}
function rviewSig() {
  // 광원 특성은 state.lights 에서 직접 읽는다 — litCacheSig 는 v3._lights 를 보는데,
  // 소프트웨어 조명이 꺼진 밤 씬에선 그게 null 이라 광원을 바꿔도 시그니처가 안 변했다
  // (실측: IES 해제가 렌더링 뷰에 반영 안 됨 — 세기·색도 같은 조건이면 마찬가지였다).
  let ls = '';
  for (const L of state.lights) {
    ls += `${L.id},${L.enabled ? 1 : 0},${L.intensity},${L.color || ''},${L.colorTemp || 0},`
      + `${L.type || ''},${L.ies ? (L.ies.name || 'i') + L.ies.cd.length : ''},${L.spotAngleDeg || 0},${L.spotPenumbra == null ? '' : L.spotPenumbra};`;
  }
  ls += 'solo' + (soloLightId || '');
  return rtGeoSig() + '|' + litCacheSig() + '|' + ls + '|E' + (rview.edges ? 1 : 0);
}
// 씬 구성 — rtBuildScene 과 같은 삼각형(rtTrisByEntity)에서 출발하되 실시간용 재질/광원.
// three@0.155+ 물리 단위: DirectionalLight=lux, PointLight=cd → rt 와 같은 노출(rtExposure)을 그대로 쓴다.
function rviewBuildScene(T) {
  const scene = new T.Scene();
  const byEnt = rtTrisByEntity();
  const litIds = new Map();
  for (const L of state.lights) if (L.enabled && (!soloLightId || soloLightId === L.id)) litIds.set(L.objectId, L);
  const entById = new Map(state.entities.map(e => [e.id, e]));
  for (const [eid, o] of byEnt) {
    if (!o.tris.length) continue;
    const ent = entById.get(eid);
    const geo = matGeo(T, o.tris, ent);
    const L = litIds.get(eid);
    let mat;
    if (L) { // 발광 개체 — 모양은 rt 와 같은 rtEmitterLook 로 (두 뷰의 광원채 밝기가 어긋나지 않게)
      const c = lightColorRGB(L), mx = Math.max(c[0], c[1], c[2]) || 1;
      const areaM2 = Math.max(1e-4, o.area * RT_MM * RT_MM);
      const { lookR } = rtEmitterLook(L, areaM2);
      mat = new T.MeshStandardMaterial({ color: 0x000000, emissive: new T.Color(c[0] / mx, c[1] / mx, c[2] / mx), emissiveIntensity: lookR, roughness: 0.9 });
    } else {
      mat = matBuild(T, ent, o.color, { fast: true });   // ★레이트레이싱과 같은 함수 (투과만 래스터 근사)
    }
    if (rview.edges) { mat.polygonOffset = true; mat.polygonOffsetFactor = 1; mat.polygonOffsetUnits = 1; }   // 면을 살짝 밀어 모서리 선이 이긴다
    const mesh = new T.Mesh(geo, mat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData.eid = eid;
    scene.add(mesh);
  }
  // 모서리 표시(edges 명령) — 라이노 Rendered 의 '모서리' 옵션. 솔리드의 상·하 링과 수직
  // 모서리 + 메시의 특징 모서리(meshFeat — 내부 삼각형선 제외)만 검은 선으로 얹는다. 표시 전용.
  if (rview.edges) {
    const pts = [];
    const seg = (x1, y1, z1, x2, y2, z2) => pts.push(x1 * RT_MM, y1 * RT_MM, z1 * RT_MM, x2 * RT_MM, y2 * RT_MM, z2 * RT_MM);
    for (const s of (v3.solids || [])) {
      const P = s.poly; if (!P || P.length < 3) continue;
      const zt = s.zt || P.map(() => s.z1), zb = s.zb || P.map(() => s.z0);
      const Q = (s.ptop && s.ptop.length === P.length) ? s.ptop : P;
      for (let i = 0; i < P.length; i++) {
        const j = (i + 1) % P.length;
        seg(Q[i][0], Q[i][1], zt[i], Q[j][0], Q[j][1], zt[j]);   // 윗면 링
        seg(P[i][0], P[i][1], zb[i], P[j][0], P[j][1], zb[j]);   // 아랫면 링
        seg(P[i][0], P[i][1], zb[i], Q[i][0], Q[i][1], zt[i]);   // 모서리(기울면 사선)
      }
    }
    for (const e of state.entities) {
      if (e.type !== 'MESH' || !e.tris || !e.tris.length) continue;
      const lay = getLayer(e.layer); if (lay && !lay.visible) continue;
      for (const k of meshFeat(e)) {                              // "x,y,z|x,y,z" (0.01 양자화)
        const [a, b] = k.split('|');
        const [ax, ay, az] = a.split(',').map(Number);
        const [bx, by, bz] = b.split(',').map(Number);
        seg(ax, ay, az, bx, by, bz);
      }
    }
    if (pts.length) {
      const eg = new T.BufferGeometry();
      eg.setAttribute('position', new T.Float32BufferAttribute(pts, 3));
      scene.add(new T.LineSegments(eg, new T.LineBasicMaterial({ color: 0x14161a })));
    }
  }
  rview.groundMat = null; rview.groundMesh = null; rview.cloudSig = '';
  if (rt.ground) {
    const gm = makeGroundMesh(T, false);                // 대지 — 그림자를 받는다 (rt 와 같은 토글)
    rview.groundMat = gm.material;                      // 구름 그림자는 이 재질의 map(알베도 변조)으로 얹는다
    rview.groundMesh = gm;                              // 매 프레임 시야를 따라 스케일·이동 (rviewFrame)
    rview.groundR0 = groundSizeMM() * RT_MM;            // 빌드 시점 반지름(m) — 스케일 기준
    scene.add(gm);
  }
  // 인공 광원 — lightSources()(소프트웨어 뷰·조도 분석과 같은 원천)에서 위치/색/광속을 가져온다.
  // PointLight 물리 단위 = cd → lm/4π. 그림자 맵은 비싸므로 광속 상위 4개까지만 그림자를 켠다.
  const arts = lightSources().filter(g => !g.sun);
  arts.sort((a, b) => (b.lm || 0) - (a.lm || 0));
  arts.slice(0, 32).forEach((g, i) => {
    let pl;
    if (g.ies || g.type === 'spot') {
      // 스팟/IES = 하향 원뿔 근사 — rt 의 스팟과 같은 조준(바로 아래)·같은 광도식(lm/∫배광dΩ).
      // 래스터에는 IES 프로파일 셰이더가 없으므로 '배광이 끝나는 각' 을 원뿔로 삼는다.
      // 모양은 근사, 광속은 보존 — 정확한 배광(도넛·비대칭 등)은 raytrace 가 그린다.
      const cd = Math.max(0, (g.lm || 0) / (g.ies ? iesFluxFactor(g.ies) : 4 * Math.PI));
      pl = new T.SpotLight(new T.Color(g.cr, g.cg, g.cb), cd);
      if (g.ies) {
        const cut = iesCutoffDeg(g.ies), sm = iesSummary(g.ies);
        pl.angle = Math.min(Math.PI / 2, cut * Math.PI / 180);
        // 빔각(50%)→컷오프 사이를 반그림자로 — 배광의 어깨를 흉내낸다
        pl.penumbra = sm.beamDeg ? Math.min(1, Math.max(0.05, 1 - (sm.beamDeg / 2) / cut)) : 0.5;
      } else {
        pl.angle = Math.max(0.02, (g.spotDeg || 60) * Math.PI / 360);   // 전각 → 반각
        pl.penumbra = Math.min(1, Math.max(0, g.spotPen));
      }
      pl.target.position.set(g.x * RT_MM, g.y * RT_MM, (g.z - 1000) * RT_MM);
      scene.add(pl.target);
    } else {
      pl = new T.PointLight(new T.Color(g.cr, g.cg, g.cb), Math.max(0, (g.lm || 0) / (4 * Math.PI)));
    }
    pl.position.set(g.x * RT_MM, g.y * RT_MM, g.z * RT_MM);
    pl.decay = 2; pl.distance = 0;
    if (i < 4) { pl.castShadow = true; pl.shadow.mapSize.set(1024, 1024); pl.shadow.bias = -0.002; }
    scene.add(pl);
  });
  // 태양·하늘 — 매 프레임 rviewSyncSun 이 [태양] 패널 값(시간·계절·탁도)을 반영한다
  rview.sun = new T.DirectionalLight(0xffffff, 0);
  rview.sun.castShadow = true;
  rview.sun.shadow.mapSize.set(4096, 4096);   // 2048 은 큰 대지에서 그림자 가장자리가 각졌다
  rview.sun.shadow.bias = -0.0015;
  rview.sun.shadow.normalBias = 0.02;          // 경사면 acne 방지
  rview.sun.shadow.radius = 4;                 // PCFSoft 반경 — 실제 반그림자 느낌
  scene.add(rview.sun); scene.add(rview.sun.target);
  rview.hemi = new T.HemisphereLight(0xbdd3ea, 0x4a4640, 0);
  scene.add(rview.hemi);
  return scene;
}
// 렌더링 뷰의 하늘 배경 — 실제 하늘(구름 포함)을 equirect 텍스처로 굽는다.
// 예전엔 천정색 한 점으로 배경을 칠했다. 구름을 그려놓고 보이지 않으면 만든 의미가 없다.
//
// ★equirect 규약 — 여기서 한 번 크게 당한 적이 있다(라이브러리마다 축이 다르다).
// 추측하지 않고 three 의 샘플링 식을 그대로 뒤집는다:
//     equirectUv(d) = ( atan2(d.z, d.x)/2π + 0.5 , asin(d.y)/π + 0.5 )
// 텍셀 (u,v) 를 샘플하게 될 방향 W 를 이 식의 역으로 구해, 그 자리에 sky(W) 를 넣는다.
// 그러면 축이 Y-up 이든 Z-up 이든 상관없다 — 텍스처는 '방향의 함수' 일 뿐이고 매핑을 정확히 뒤집었으니까.
// 512x256 — 256 은 구름 가장자리가 계단으로 보였다. 굽기는 1회성(캐시)이라 해상도를 올린다.
const RVIEW_SKY_W = 512, RVIEW_SKY_H = 256;
function rviewSkyTexture(T, S) {
  const sig = [S.y, S.mo, S.d, S.h, S.mi, S.lat, S.lon, S.tz, S.north, skyTurbidity(S), skyCloud(S), S.enabled].join(',');
  if (rview.skyTex && rview.skySig === sig) return rview.skyTex;
  // 조작 중(슬라이더 드래그·궤도)에는 다시 굽지 않는다 — 한 장에 100ms 라 프레임을 다 잡아먹는다.
  // 손을 떼면 settle 타이머가 정밀 렌더를 다시 돌리고 그때 최신 하늘이 구워진다.
  // ('조작 중 빠른 렌더 / 멈추면 정확 렌더' — v3._fast 가 이미 쓰는 규약이다)
  if (v3 && v3._fast && rview.skyTex) return rview.skyTex;
  const K = skyCtx(S);
  const sd = sunDirection(S);
  const diskL = sunDiskLuminance(S);              // 운량이 오르면 같이 흐려진다 (완전히 흐리면 0)
  const cosDisk = Math.cos(SUN_ANG_RADIUS * 3);   // 배경용이라 원반을 살짝 키워 계단현상을 줄인다
  const W = RVIEW_SKY_W, H = RVIEW_SKY_H;
  const data = new Float32Array(W * H * 4);
  const rgb = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H, elev = (v - 0.5) * Math.PI;
    const sy = Math.sin(elev), cy = Math.cos(elev);
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W, phi = (u - 0.5) * 2 * Math.PI;
      const wx = cy * Math.cos(phi), wy = sy, wz = cy * Math.sin(phi);   // 이 텍셀을 샘플할 방향
      skyDirRadiance(K, wx, wy, wz, rgb);
      const disk = (K.up && (wx * sd.x + wy * sd.y + wz * sd.z) >= cosDisk) ? diskL : 0;
      const i = (y * W + x) * 4;
      data[i] = rgb[0] + disk; data[i + 1] = rgb[1] + disk; data[i + 2] = rgb[2] + disk; data[i + 3] = 1;
    }
  }
  if (rview.skyTex) rview.skyTex.dispose();
  const tex = new T.DataTexture(data, W, H, T.RGBAFormat, T.FloatType);
  tex.mapping = T.EquirectangularReflectionMapping;
  tex.minFilter = T.LinearFilter; tex.magFilter = T.LinearFilter;
  tex.needsUpdate = true;
  rview.skyTex = tex; rview.skySig = sig;
  return tex;
}
// ── 구름 그림자 (렌더링 뷰 전용 · 시각 근사) ──
// 대지 재질의 map(알베도 변조)에 구름 그림자를 굽는다. ★물리 렌더(rt·조도 분석)에는 넣지 않는다 —
// 거긴 태양 모델이 에너지를 관리하므로 임의 감쇠를 얹으면 자기모순이 된다. 여기는 '보이는 맛' 전용.
// (첫 구현은 지면 위 Multiply 평면이었는데 투명 렌더 순서가 슬래브 위까지 어둡게 칠했다 —
//  알베도 변조는 깊이·블렌딩 문제가 원천적으로 없고, CircleGeometry 의 UV(0..1)와 정확히 맞물린다.)
// 무늬: 지면 점 p 에서 태양 쪽으로 올라가 구름층(고도 H)과 만나는 점의 방향을 skyCloudMask 에
// 넣는다 → 하늘과 같은 fbm 장·같은 임계값에서 그림자가 나온다 (태양을 옮기면 그림자도 흐른다).
// 단 H(배율)는 물리 구름 고도가 아니라 모델 fit 기준 — 하늘 구름과 1:1 위치 대응까지는 하지 않는다.
// 그림자 짙기 = 직달광 비중(Ebh/(Ebh+Ed)) — 흐릴수록 직달이 확산으로 옮겨가 그림자가 옅어지다 사라진다.
// 한계(명시): 그림자는 대지에만 진다 — 지붕·슬래브 위 구름 그림자는 없다 (시각 전용 예외).
const RVIEW_CLOUD_N = 128;   // 대지에 뿌옇게 깔리는 그림자 — 128 이면 충분하고 굽기가 4배 싸다
function rviewCloudShadowTexture(T, S, sd) {   // sd = 태양 '쪽' 단위벡터 (위로)
  const cc = skyCloud(S);
  const R = groundSizeMM();                    // 그림자 평면 = 대지와 같은 반경 (원점 중심)
  // 가상 구름층 고도 = 구름 무늬의 공간 배율. 대지(R) 기준으로 잡으면 덩어리가 ~R 크기라
  // 화면(모델 fit 몇 배)에는 구름 '하나의 속' 만 들어와 균일해 보인다 — 실측으로 걸렸다.
  // 모델 fit 기준: 시야에 항상 두어 덩이가 걸리는 스케일 (시각 전용이므로 보이는 게 기준).
  const H = Math.max(8000, ((v3 && v3.fit) || 10000) * 2);
  const Ebh = Math.max(0, sunDirectIlluminance(S)), Ed = Math.max(0, skyCtx(S).Ed);
  const dirFrac = (Ebh + Ed) > 0 ? Ebh / (Ebh + Ed) : 0;   // 직달 비중 = 구름이 지울 수 있는 몫
  const N = RVIEW_CLOUD_N, data = new Uint8Array(N * N * 4);
  const ox = sd.z > 0.05 ? sd.x / sd.z * H : 0, oy = sd.z > 0.05 ? sd.y / sd.z * H : 0;
  for (let j = 0; j < N; j++) {
    const wy = ((j + 0.5) / N - 0.5) * 2 * R;
    for (let i = 0; i < N; i++) {
      const wx = ((i + 0.5) / N - 0.5) * 2 * R;
      const cx = wx + ox, cy = wy + oy;        // 구름층 위 교점 (원점 관측 기준)
      const d = Math.hypot(cx, cy, H) || 1;
      const m = skyCloudMask(cc, cx / d, cy / d, H / d);
      const a = Math.max(0, Math.min(1, 1 - m * dirFrac));
      const v = Math.round(a * 255), k = (j * N + i) * 4;
      data[k] = v; data[k + 1] = v; data[k + 2] = v; data[k + 3] = 255;
    }
  }
  const tex = new T.DataTexture(data, N, N, T.RGBAFormat, T.UnsignedByteType);
  tex.minFilter = T.LinearFilter; tex.magFilter = T.LinearFilter;
  if (T.LinearSRGBColorSpace) tex.colorSpace = T.LinearSRGBColorSpace;   // 값 = 감쇠 계수 그대로 (색이 아니다)
  tex.needsUpdate = true;
  return tex;
}
function rviewSyncCloudShadow(T, S, sd) {
  if (!rview.groundMat) return;                        // 대지가 꺼져 있으면 얹을 곳이 없다
  const cc = skyCloud(S);
  const on = !!(sd && cc > 0.005 && cc < 0.995 && sunOn());  // 완전 흐림 = 그림자 자체가 없다
  if (!on) {
    if (rview.groundMat.map) { rview.groundMat.map = null; rview.groundMat.needsUpdate = true; rview.cloudSig = ''; }
    return;
  }
  if (v3 && v3._fast && rview.cloudSig) return;        // 슬라이더 드래그 중엔 옛 그림자 유지 — 굽기는 정식 렌더에서
  const sig = [S.mo, S.d, S.h, S.mi, S.lat, S.lon, S.north, Math.round(cc * 100), Math.round(groundSizeMM()), Math.round((v3 && v3.fit) || 0)].join(',');
  if (rview.cloudSig !== sig) {
    if (rview.cloudTex) rview.cloudTex.dispose();
    rview.cloudTex = rviewCloudShadowTexture(T, S, sd);
    rview.groundMat.map = rview.cloudTex;
    rview.groundMat.needsUpdate = true;
    rview.cloudSig = sig;
  }
}
// 태양 방향·세기·하늘색을 현재 sunState 로 — sunLight()(소프트웨어 뷰와 같은 원천)를 재사용
function rviewSyncSun(T) {
  const sl = sunOn() ? sunLight() : null;
  const S = sunState();
  if (sl) {
    const dx = sl.x - v3.cx, dy = sl.y - v3.cy, dz = sl.z - v3.cz;
    const d = Math.hypot(dx, dy, dz) || 1;
    const R = Math.max(10, v3.fit * 1.5) * RT_MM;               // 그림자 카메라가 모델을 덮는 거리
    rview.sun.position.set(v3.cx * RT_MM + dx / d * R, v3.cy * RT_MM + dy / d * R, v3.cz * RT_MM + dz / d * R);
    rview.sun.target.position.set(v3.cx * RT_MM, v3.cy * RT_MM, v3.cz * RT_MM);
    rview.sun.color.setRGB(sl.cr, sl.cg, sl.cb);
    rview.sun.intensity = sunDirectIlluminance(S);               // lux 그대로 (노출이 압축)
    const sc = rview.sun.shadow.camera;
    sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.near = 0.01; sc.far = R * 3;
    sc.updateProjectionMatrix();
    // 천공광 = 실제 확산 수평조도(skyCtx.Ed). 예전엔 직달의 15% 로 어림했는데, 그러면
    // 흐린 날(직달 0)에 하늘까지 같이 죽어 화면이 새까매진다 — 실측으로 드러났다(0.8/255).
    // 흐림의 본질은 '빛이 사라지는 것' 이 아니라 '직달이 확산으로 옮겨가는 것' 이다.
    const K = skyCtx(S);
    rview.hemi.intensity = Math.max(0, K.Ed);
    // 하늘색도 운량을 따라간다 — 맑으면 파랗고 흐리면 회백색
    const zen = [0, 0, 0];
    skyDirRadiance(K, 0, 0, 1, zen);
    const mx = Math.max(zen[0], zen[1], zen[2]) || 1;
    rview.hemi.color.setRGB(zen[0] / mx, zen[1] / mx, zen[2] / mx);
    // 배경 = 실제 하늘 (구름이 여기 보인다). 물리 휘도라 노출이 알아서 압축한다.
    const skyTex = rviewSkyTexture(T, S);
    rview.scene.background = skyTex;
    rview.scene.backgroundIntensity = 1;
    // ★반사 환경도 같은 하늘로. 없으면 금속이 반사할 게 없어 **새까맣게** 나온다(실측 0/255).
    // equirect 를 scene.environment 에 그냥 꽂으면 안 되고 PMREM 으로 구워야 한다.
    // 하늘이 바뀔 때만 다시 굽는다 (skyTex 객체가 그대로면 재사용).
    if (rview.envFrom !== skyTex) {
      if (!rview.pmrem) rview.pmrem = new T.PMREMGenerator(rview.renderer);
      if (rview.envTex) rview.envTex.dispose();
      rview.envTex = rview.pmrem.fromEquirectangular(skyTex).texture;
      rview.envFrom = skyTex;
    }
    rview.scene.environment = rview.envTex;
    rview.scene.environmentIntensity = 1;
    rviewSyncCloudShadow(T, S, { x: dx / d, y: dy / d, z: dz / d });   // 구름 그림자 (시각 전용)
  } else {
    rviewSyncCloudShadow(T, S, null);                 // 밤엔 태양 그림자도 구름 그림자도 없다
    rview.sun.intensity = 0;
    rview.hemi.intensity = state.lights.length ? 2 : 40;         // 야간: 광원이 있으면 캄캄하게, 없으면 형태만 보이게
    rview.hemi.color.setHex(0xbdd3ea);
    rview.scene.background = new T.Color(0x0a0c14);   // 밤: 하늘 텍스처를 구울 이유가 없다
    rview.scene.environment = null;                   // 밤엔 반사할 하늘도 없다
  }
  // 스튜디오 배경(bg 명령) — 배경 '그림' 만 바꾼다. environment(조명·반사)는 그대로라
  // 태양·하늘빛 물리는 변하지 않는다. 흰색은 노출·톤맵을 통과해 순백이 되도록 물리 휘도로.
  if (rt.bg === 'white') {
    if (!rview._bgWhite) rview._bgWhite = new T.Color();
    rview._bgWhite.setScalar(3 / rtExposure());       // ACES(3)≈0.96 — 화면에서 거의 순백
    rview.scene.background = rview._bgWhite;
  } else if (rt.bg === 'black') {
    if (!rview._bgBlack) rview._bgBlack = new T.Color(0x000000);
    rview.scene.background = rview._bgBlack;
  }
}
// 매 프레임 — render3D 끝에서 불린다 (궤도·팬 중에도 render3D 가 돌므로 실시간으로 따라온다)
function rviewFrame() {
  if (!rview.on || !rt.mod) return;
  const T = rt.mod.T;
  const c = rviewCanvas(); if (!c) return;
  // 이 모드가 붙은 뷰포트가 화면에 없으면(레이아웃 변경) 그리지 않는다
  const visible = v3.quad ? (rview.vi >= 0 && rview.vi < 4) : (rview.vi === v3.act);
  if (!visible || vpIsPlan(rview.vi)) { c.style.display = 'none'; vpHideLabel(rview.vi); return; }
  const sig = rviewSig();
  if (!rview.scene || sig !== rview.sig) { rview.scene = rviewBuildScene(T); rview.sig = sig; }
  // 캔버스를 그 뷰포트 rect 에만 (해상도 캡: dpr 1.5 — D5식 '가벼움 우선')
  const r = vpRect(rview.vi), rc = vpRectCss(rview.vi);
  c.style.display = ''; c.style.left = rc.x + 'px'; c.style.top = rc.y + 'px';
  c.style.width = rc.w + 'px'; c.style.height = rc.h + 'px';
  const cap = Math.min(1, 1.5 / (devicePixelRatio || 1));
  const nw = Math.max(2, Math.round(r.w * cap)), nh = Math.max(2, Math.round(r.h * cap));
  if (c.width !== nw || c.height !== nh) { c.width = nw; c.height = nh; rview.renderer.setViewport(0, 0, nw, nh); }
  // 카메라 = 그 뷰포트의 파라미터 (활성 뷰가 아니어도 자기 카메라로 그린다)
  const keepVp = v3.vp, keepAct = v3.act;
  saveVp(); loadVp(rview.vi); v3.vp = vpRect(rview.vi);
  rtSyncCamera(T, rview.cam);
  // ★대지 시야 추종 — 어떤 줌·팬에서도 대지 가장자리가 화면에 들어오지 않게, 매 프레임
  // 뷰 중심 아래로 옮기고 시야 대각보다 크게 스케일한다 (가장자리가 보이면 '만들지 않은
  // 원판' 이 된다 — 사용자 스크린샷). 렌더 전용 메시라 옮겨도 아무것도 어긋나지 않는다.
  if (rview.groundMesh) {
    const gm2 = rview.groundMesh;
    const c2 = Math.cos(v3.yaw), s2 = Math.sin(v3.yaw), sp2 = Math.sin(v3.pitch), cp2 = Math.cos(v3.pitch);
    // rtSyncCamera 와 같은 식으로 뷰 중심(타깃)을 구한다 (mm)
    const tx = v3.cx - c2 * v3.panX - s2 * sp2 * v3.panY;
    const ty = v3.cy + s2 * v3.panX - c2 * sp2 * v3.panY;
    const halfDiag = Math.hypot(rview.cam.right, rview.cam.top);          // 프레임 반대각 (m)
    const need = (halfDiag * 2) / Math.max(0.25, Math.abs(sp2));          // 얕은 피치 = 지면이 멀리 보임
    gm2.scale.setScalar(Math.max(1, need / (rview.groundR0 || 1)));
    gm2.position.x = tx * RT_MM; gm2.position.y = ty * RT_MM;             // z 는 대지 높이 그대로
    const camD = Math.max(1, v3.fit * 4) * RT_MM;                          // rtSyncCamera 의 카메라 거리
    if (rview.cam.far < (camD + need) * 2) { rview.cam.far = (camD + need) * 2; rview.cam.updateProjectionMatrix(); }
  }
  loadVp(keepAct); v3.vp = keepVp;
  rviewSyncSun(T);
  rview.renderer.toneMappingExposure = rtExposure();
  if (rview.ao && rview.fx) {
    // AO 경로가 어떤 이유로든 죽으면 기본 렌더로 폴백 — 렌더링 뷰 자체는 절대 못 죽인다
    try { rviewAoRender(); }
    catch (e) { rview.ao = false; rview.err = e; rview.renderer.render(rview.scene, rview.cam); }
  } else {
    rview.renderer.render(rview.scene, rview.cam);
  }
  vpShowLabel(rview.vi, rview.cv);   // 이름표·활성 테두리 (rtFrame 과 대칭 — 없으면 라벨이 옛 텍스트로 고인다)
}
// ============================================================
//  GTAO (앰비언트 오클루전) — 렌더링 뷰 전용 표시 필터
//  정투영 카메라에서 동작함을 실측으로 검증(2026-07-17): 구석 -5.4 / 벽하단 -8.0 / 열린 바닥 0.
//  주의 — 검증 때 걸린 함정 2개:
//   ① 기본 radius 0.25(m)는 건축 스케일에 너무 좁다 → 1.2m.
//   ② AO 디버그 출력은 ACES 톤맵의 상단 압축을 통과해 '전멸'로 보인다 — 판정은 반드시 최종 화면 A/B 로.
//  레이트레이싱에는 넣지 않는다 (패스트레이싱은 진짜 GI — AO 는 근사의 보정일 뿐).
// ============================================================
// thickness 0.25 — 지평선 갱신을 '깊이 차 25cm 이내 연속면' 으로 제한. 기본값 1(m)은 부감
// 정투영에서 벽 상단 밴드와 안쪽 바닥의 깊이 차가 그 안에 들어와, 개활 바닥에 낫 모양
// 가짜 음영이 생겼다 (사용자 스크린샷 — 실측: t1→0.25 에서 얼룩 88% 감소, 구석 AO 는 유지).
const RVIEW_AO = { radius: 1.2, scale: 2.5, samples: 16, thickness: 0.25 };   // scale = 강도 (ao 명령 0.5~5)
async function rviewLoadFx() {
  if (rview.fx || rview._fxLoading) return;
  rview._fxLoading = true;
  try {
    const b = RT_CDN.three + '/examples/jsm/postprocessing/';
    const [m1, m2, m3, m4] = await Promise.all([
      import(b + 'EffectComposer.js'), import(b + 'RenderPass.js'),
      import(b + 'GTAOPass.js'), import(b + 'OutputPass.js'),
    ]);
    rview.fx = { EffectComposer: m1.EffectComposer, RenderPass: m2.RenderPass, GTAOPass: m3.GTAOPass, OutputPass: m4.OutputPass };
    if (rview.on) render3D();                          // 준비되는 즉시 AO 반영
  } catch (e) { rview.err = e; }                       // CDN 실패 → AO 없이 기본 렌더 유지 (조용한 폴백)
  rview._fxLoading = false;
}
function rviewAoRender() {
  const fx = rview.fx, c = rview.cv;
  if (!rview.composer) {
    rview.composer = new fx.EffectComposer(rview.renderer);
    rview._rp = new fx.RenderPass(rview.scene, rview.cam);
    rview._ao = new fx.GTAOPass(rview.scene, rview.cam, c.width, c.height);
    // ★NaN 가드 (셰이더 런타임 패치) — 라이브러리 GTAO 는 slice 계산에서 normalize(0) 이 나올 수 있다:
    //   sliceBitangent = normalize(cross(sampleDir, viewDir)) — 둘이 평행하면 0벡터 → NaN
    //   normalInSlice  = normalize(viewNormal - …)            — 법선이 slice 축과 평행하면 0벡터 → NaN
    // 방향은 화면 고정 노이즈 타일에서 오므로, NaN 픽셀이 씬과 무관하게 같은 자리에 '검은 삼각형' 으로
    // 찍힌다 (사용자 스크린샷 — 정투영 + 평평한 대지에서 잘 걸린다). NaN 은 모든 비교가 거짓이라
    // !(ao >= 0.0) 으로 잡아 '음영 없음(1)' 로 대체한다. 치환 실패(라이브러리 변경) 시엔 원래 동작.
    // 가드는 slice 누적 단계에 건다 — 최종 ao 에 걸면 늦는다: clamp(NaN, 0, 1) 이 GPU 에서
    // 0 으로 씻겨 '정상적인 완전 오클루전' 이 되어버린다 (실측 — 최종 가드는 안 걸렸다).
    // NaN slice 는 '가림 없음(1)' 으로 — 그 방향 하나만 잃고 픽셀은 살아남는다.
    {
      const gm = rview._ao.gtaoMaterial;
      const anchor = 'ao += occlusion;';
      if (gm && gm.fragmentShader && gm.fragmentShader.indexOf(anchor) >= 0) {
        gm.fragmentShader = gm.fragmentShader.replace(anchor,
          'ao += isnan(occlusion) ? 1.0 : occlusion;');
        gm.needsUpdate = true;
      }
    }
    rview.composer.addPass(rview._rp);
    rview.composer.addPass(rview._ao);
    rview.composer.addPass(new fx.OutputPass());
    rview._aoW = 0; rview._aoCfg = '';                 // 크기·설정 갱신 강제
  }
  // 씬은 편집 때마다 새로 빌드된다 — 패스가 옛 씬을 그리지 않도록 참조 동기화
  if (rview._rp.scene !== rview.scene) { rview._rp.scene = rview.scene; rview._ao.scene = rview.scene; }
  if (c.width !== rview._aoW || c.height !== rview._aoH) {
    rview.composer.setSize(c.width, c.height);         // 내부 타깃까지 전파 (renderer pixelRatio 는 1)
    rview._aoW = c.width; rview._aoH = c.height;
  }
  const cfg = RVIEW_AO.radius + '|' + RVIEW_AO.scale + '|' + RVIEW_AO.thickness;
  if (rview._aoCfg !== cfg) {
    rview._ao.updateGtaoMaterial({ radius: RVIEW_AO.radius, distanceExponent: 1, thickness: RVIEW_AO.thickness, scale: RVIEW_AO.scale, samples: RVIEW_AO.samples, distanceFallOff: 1, screenSpaceRadius: false });
    rview._aoCfg = cfg;
  }
  rview.composer.render();
}
// ao / gtao — 렌더링 뷰 구석 음영 토글·강도 (실험적 — 기본 끔)
function cmdAo(arg) {
  const a = String(arg || '').trim();
  if (a) {
    const v = parseFloat(a);
    if (isFinite(v) && v >= 0.5 && v <= 5) {
      RVIEW_AO.scale = v; rview.ao = true;
      logLine(`  ✔ AO 강도 ${v} (기본 2.5 — 클수록 구석이 짙어짐)`, 'ok');
    } else if (/^(on|off|켬|끔)$/i.test(a)) {
      rview.ao = /^(on|켬)$/i.test(a);
      logLine(rview.ao ? '  ▷ AO ON — 구석·모서리 접촉 음영 (렌더링 뷰 전용)' : '  ▷ AO OFF', 'info');
    } else { logLine('  사용법: ao (토글) · ao 0.5~5 (강도) · ao on|off', 'warn'); return; }
  } else {
    rview.ao = !rview.ao;
    logLine(rview.ao ? '  ▷ AO ON — 구석·모서리 접촉 음영 (렌더링 뷰 전용)' : '  ▷ AO OFF', 'info');
  }
  if (rview.ao) logLine('     ⚠ 실험적: 정투영 화면공간 AO 는 평평한 면에 얼룩이 생길 수 있습니다 (three.js GTAO 한계 — 최종 결과물은 raytrace 권장)', 'warn');
  if (rview.ao && !rview.fx) rviewLoadFx();
  if (rview.on) render3D();
}
// rendered / 렌더링 — 활성 3D 뷰포트를 렌더링 뷰로 토글
async function cmdRendered() {
  if (!is3DActive() || !v3) { logLine('  렌더링 뷰는 3D 화면에서 켭니다 — view3d 로 열어주세요.', 'warn'); return; }
  if (rview.on) {
    const was = rview.vi;
    rview.on = false;
    if (rview.cv) { rview.cv.style.display = 'none'; rview.cv.style.outline = ''; }
    vpHideLabel(was);   // 끄면 3D 렌더러가 자기 캔버스에 이름표를 다시 그린다
    logLine('  ▷ 렌더링 뷰 끔 — 작업 표시로 복귀', 'info');
    render3D();
    return;
  }
  if (vpIsPlan(v3.act)) { logLine('  평면 칸은 도면 표시 전용입니다 — 아이소 등 3D 뷰포트에서 켜주세요.', 'warn'); return; }
  if (!rtSupported()) { logLine('  이 브라우저는 WebGL2 를 지원하지 않아 렌더링 뷰를 켤 수 없습니다.', 'warn'); return; }
  try {
    await rtLoad();                                   // three 모듈 공유 (레이트레이서와 동일 버전)
    if (rview.ao && !rview.fx) rviewLoadFx();         // AO(GTAO) 모듈은 비동기 — 준비 전엔 AO 없이 그린다
    const T = rt.mod.T;
    if (!rview.renderer) {
      const c = rviewCanvas();
      rview.renderer = new T.WebGLRenderer({ canvas: c, antialias: true });
      rview.renderer.shadowMap.enabled = true;
      rview.renderer.shadowMap.type = T.PCFSoftShadowMap;
      rview.renderer.toneMapping = T.ACESFilmicToneMapping;
      rview.cam = new T.OrthographicCamera();
    }
    rview.vi = v3.act;
    rview.sig = '';                                   // 씬 강제 재빌드
    rview.on = true;
    logLine("  ✔ 렌더링 뷰 — '" + v3.views[rview.vi].name + "' 뷰포트. 태양·조명·그림자가 실시간으로 보입니다. 다시 rendered 로 끕니다.", 'ok');
    logLine('     시간·날씨는 [태양] 패널 · 모서리: edges · 배경: bg 흰색 · 최종 화질: raytrace', 'info');
    render3D();
  } catch (err) {
    rview.err = err;
    logLine('  ✗ 렌더링 뷰를 켜지 못했습니다: ' + (err && err.message || err), 'warn');
  }
}
function rtHud(msg) {
  if (!rt.hud) return;
  rt.hud.textContent = msg;
}
async function rtLoad() {
  if (rt.mod) return rt.mod;
  rt.loading = true; rtHud('레이트레이서 불러오는 중…');
  const T = await import(RT_CDN.three);
  const P = await import(RT_CDN.pt);
  const B = await import(RT_CDN.bvh);
  rt.mod = { T, P, B }; rt.loading = false;
  return rt.mod;
}
function rtReset() { if (rt.tracer) rt.tracer.reset(); }
async function rtRebuild() {
  const { T, P, B } = rt.mod;
  rt.scene = rtBuildScene(T);
  if (!rt.cam) rt.cam = new T.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
  rtSyncCamera(T, rt.cam);
  if (!rt.tracer) {
    rt.tracer = new P.WebGLPathTracer(rt.renderer);
    // 교차 출처 워커는 브라우저가 차단한다(SecurityError) → 메인 스레드에서 BVH를 만든다.
    // 작은 장면에선 체감이 없고, 큰 장면은 진입 시 경고로 알린다.
    rt.tracer.setBVHWorker({ generate: (g, o) => Promise.resolve(new B.MeshBVH(g, o)) });
    rt.tracer.renderDelay = 0; rt.tracer.minSamples = 1;
    // ★파이어플라이(흰 점 노이즈) 억제 — 광택 경로의 분산을 죽이는 라이브러리 공식 레버.
    //   0 = 끔(물리적으로 가장 정확하지만 점 노이즈가 수백 spp 까지 남는다),
    //   커질수록 매끈하지만 광택 하이라이트가 뭉개진다. 0.5 는 데모들이 쓰는 관례값.
    rt.tracer.filterGlossyFactor = 0.5;
    rtSetupDenoise();   // 표시 필터 — rt.denoise 로 토글 (denoise 명령)
  }
  rt.tracer.bounces = rt.q.bounces;   // 품질 프리셋(rtquality)이 정한 반사 횟수
  await rt.tracer.setSceneAsync(rt.scene, rt.cam);
  rt.geoSig = rtGeoSig();
}
// 프로그레시브 누적 루프. renderSample()은 THREE.Clock(실제 시간)으로 renderDelay를 재므로
// 빡빡한 for 루프로 돌리면 누적이 시작되지 않는다 — 반드시 프레임마다 한 번씩 부른다.
// 수렴 목표 — 여기 도달하면 샘플링을 멈추고 GPU를 쉰다.
// 예전에는 멈추는 조건이 아예 없었다. 24 spp 에서 '완료'라고 써놓고는 계속 renderSample() 을
// 돌려 900 spp 를 넘겨도 GPU를 100%로 태웠다 — 라벨만 완료였지 실제로는 끝나지 않았다.
// 해석적 광원(NEE) 도입 뒤 실측 (800lm 램프 장면, 바닥 영역):
//   16 spp 0.5초 · 평균 42.0 · 상대노이즈 0.241      ← 밝기는 여기서 이미 확정
//   32 spp 1.0초 · 42.4 · 0.220
//   64 spp 1.8초 · 42.7 · 0.194                      ← 채택
//   128 spp 3.5초 · 41.9 · 0.170
//   256 spp 6.8초 · 41.7 · 0.160
// 64 를 넘기면 노이즈가 사실상 평평해진다(남은 값의 대부분은 실제 명암 기울기라 더 내려가지
// 않는다). 그래서 시간을 4배 더 써도 눈에 보이는 이득이 없다.
// ── 품질 프리셋 ──
// spp(샘플 수) = 노이즈, bounces(반사 횟수) = 간접광 깊이. 시간과 품질의 직교하는 두 축이다.
// '높음' 이 기본값의 4배 시간이 아니라는 점에 주의 — spp 는 선형이지만 초반 수렴이 가파르다.
const RT_QUALITY = {
  '낮음':  { spp: 24,  bounces: 5,  ko: '낮음(빠른 확인)' },
  '보통':  { spp: 64,  bounces: 10, ko: '보통' },
  '높음':  { spp: 256, bounces: 10, ko: '높음' },
  '최고':  { spp: 1024, bounces: 15, ko: '최고(오래 걸림)' },
};
const RT_TARGET_SPP = 64;   // 하위호환 — rt.q.spp 가 실제 기준
function rtLoop() {
  if (!rt.on) return;
  rt.raf = requestAnimationFrame(rtLoop);
  if (!rt.tracer) return;
  const done = (rt.tracer.samples || 0) >= rt.q.spp;
  // 수렴했으면 그리지 않는다. 캔버스는 마지막 프레임을 그대로 유지한다.
  // 카메라·광원·형상이 바뀌면 rtReset()이 samples를 0으로 되돌려 여기서 다시 돌기 시작한다.
  if (!done) {
    try { rt.tracer.renderSample(); } catch (e) { rt.err = String(e); rt.on = false; rtHud('오류: ' + e); return; }
  }
  const s = rt.tracer.samples || 0;
  rtHud(rt.tracer.isCompiling ? '셰이더 준비 중…'
    : (s >= rt.q.spp ? `${rt.q.spp} spp · 완료 (${rt.q.name})`
      : `${s < 1 ? 0 : Math.floor(s)}/${rt.q.spp} spp · 수렴 중…`)
      + (rt.denoise ? ' · 디노이즈' : '')
      + (rt.env === 'day' ? ' · 주광' : '')
      + (rt.autoSave && s < rt.q.spp ? ' · 완료 시 저장' : '')
      );
  // finalrender — 수렴한 프레임에서 딱 한 번 저장 (rtReset 으로 다시 돌기 시작하면 플래그는 유지)
  if (done && rt.autoSave) {
    rt.autoSave = false;
    cmdCapture();
    logLine('  ✔ 최종 렌더 완료 — 자동 저장했습니다 (finalrender)', 'ok');
  }
}
// rt 가 붙은 뷰포트의 카메라 파라미터로 잠시 전환해 fn 을 실행한다.
// v3 는 '활성 뷰포트 하나' 를 전역에 펼쳐놓는 구조(loadVp/saveVp)라, 이렇게 감싸야
// 활성이 아닌 칸에 레이트레이싱을 걸어도 그 칸의 카메라로 렌더된다.
function rtWithVp(fn) {
  if (!v3 || !v3.views || rt.vi == null || rt.vi < 0) return fn();
  const keepVp = v3.vp, keepAct = v3.act;
  saveVp(); loadVp(rt.vi); v3.vp = vpRect(rt.vi);
  try { return fn(); } finally { loadVp(keepAct); v3.vp = keepVp; }
}
// 이 뷰포트가 레이트레이싱에 덮여 있나 (vpIsRendered 와 같은 개념)
const vpIsRt = (i) => !!(rt && rt.on && rt.vi === i);
// 레이트레이싱 캔버스를 자기 뷰포트 rect 에 맞춘다. render3D 말미에서 불린다.
function rtFrame() {
  if (!rt.on || !rt.cv) return;
  const visible = v3.quad ? (rt.vi >= 0 && rt.vi < 4) : (rt.vi === v3.act);
  if (!visible || vpIsPlan(rt.vi)) { rt.cv.style.display = 'none'; rt.hud.style.display = 'none'; vpHideLabel(rt.vi); return; }
  rt.cv.style.display = ''; rt.hud.style.display = '';
  const rc = vpRectCss(rt.vi);
  rt.cv.style.left = rc.x + 'px'; rt.cv.style.top = rc.y + 'px';
  rt.cv.style.width = rc.w + 'px'; rt.cv.style.height = rc.h + 'px';
  rt.hud.style.right = ''; rt.hud.style.left = (rc.x + rc.w - 130) + 'px'; rt.hud.style.top = (rc.y + 8) + 'px';
  rtResize();
  vpShowLabel(rt.vi, rt.cv);
}
function rtResize() {
  if (!rt.on || !rt.renderer) return;
  // 크기·카메라 모두 'rt 가 붙은 칸' 기준. 활성 칸(v3.vp)을 쓰면 다른 칸을 보고 있을 때 어긋난다.
  const vp = (v3 && v3.views && rt.vi >= 0) ? vpRect(rt.vi) : (v3.vp || { w: v3.cv.width, h: v3.cv.height });
  const dpr = 1; // 패스트레이싱은 픽셀당 비용이 커서 dpr 배율을 쓰지 않는다
  const w = Math.max(1, Math.round(vp.w * dpr)), h = Math.max(1, Math.round(vp.h * dpr));
  if (rt.cv.width !== w || rt.cv.height !== h) rt.renderer.setSize(w, h, false);
  if (rt.cam) rtWithVp(() => { rtSyncCamera(rt.mod.T, rt.cam); rt.tracer && rt.tracer.updateCamera(); });
}
// 카메라가 움직이면 누적을 리셋하고 저해상도로 (§2.3). 멈추면 풀 해상도로 다시 누적.
function rtCameraChanged() {
  if (!rt.on || !rt.tracer) return;
  rtWithVp(() => rtSyncCamera(rt.mod.T, rt.cam));
  rt.tracer.renderScale = 0.25;      // 조작 중 1/4 해상도 → 응답성 유지
  rt.tracer.updateCamera();          // 내부에서 누적 리셋
  clearTimeout(rt._settle);
  rt._settle = setTimeout(() => {
    if (!rt.on || !rt.tracer) return;
    rt.tracer.renderScale = 1; rt.tracer.updateCamera();
  }, 220);
}
// 슬라이더 드래그 중: 1/4 해상도로 떨어뜨려 첫 반영을 100ms 안에 (§6).
// 픽셀 수가 1/16이라 첫 샘플이 즉시 나온다. 손을 떼면 rtFullRes()가 풀 해상도로 되돌린다.
function rtPreview() {
  if (!rt.on || !rt.tracer) return;
  rt.tracer.renderScale = 0.25;
  clearTimeout(rt._lightSettle);
  rt._lightSettle = setTimeout(rtFullRes, 260); // 드래그가 끝나지 않아도 손이 멈추면 복귀
}
function rtFullRes() {
  clearTimeout(rt._lightSettle);
  if (!rt.on || !rt.tracer) return;
  if (rt.tracer.renderScale !== 1) { rt.tracer.renderScale = 1; rt.tracer.reset(); }
}
// 광원 속성(세기·색온도)만 바뀐 경우: BVH 재빌드 없이 머티리얼만 갱신 + 누적 리셋 (§2.3)
function rtLightsChanged() {
  if (!rt.on || !rt.tracer || !rt.scene) return;
  const T = rt.mod.T;
  if (rtGeoSig() !== rt.geoSig) { rtRebuild(); return; }   // 형상이 바뀌었으면 재빌드
  const byEnt = rtTrisByEntity();
  const lit = new Map();
  for (const L of state.lights) if (L.enabled && (!soloLightId || soloLightId === L.id)) lit.set(L.objectId, L);
  const meshLm = new Map();
  rt.scene.traverse(o => {
    if (!o.isMesh) return;
    const L = lit.get(o.userData.eid), info = byEnt.get(o.userData.eid);
    if (L && info) {
      const c = lightColorRGB(L), mx = Math.max(c[0], c[1], c[2]) || 1;
      const areaM2 = Math.max(1e-4, info.area * RT_MM * RT_MM);
      const { lookR, meshLm: lm } = rtEmitterLook(L, areaM2);
      meshLm.set(o.userData.eid, lm);
      o.material.color.setRGB(0, 0, 0);
      o.material.emissive.setRGB(c[0] / mx, c[1] / mx, c[2] / mx);
      o.material.emissiveIntensity = lookR;
    } else if (info) {
      const [r, g, b] = hexToRgb(info.color || '#b9b2a6');
      o.material.color.setRGB(r / 255, g / 255, b / 255);
      o.material.emissive.setRGB(0, 0, 0); o.material.emissiveIntensity = 0;
    }
    o.material.needsUpdate = true;
  });
  // 해석적 광원은 세기·색·타입이 바뀌면 값만 고칠 게 아니라 개수까지 달라질 수 있어(선형 광원의
  // 간격, 솔로/끄기) 통째로 걷어내고 다시 만든다. 형상 재빌드(BVH)가 아니라서 여전히 싸다.
  const stale = [];
  rt.scene.traverse(o => { if (o.userData && o.userData.rtLight) stale.push(o); });
  for (const o of stale) rt.scene.remove(o);
  rtAddLights(T, rt.scene, meshLm);
  rt.tracer.updateMaterials();
  rt.tracer.updateLights();
}
// ── 디노이저 ──
// 한 번 '효과 없음 미규명' 으로 봉인했던 것을 라이브러리 소스를 읽고 다시 살렸다.
// 원인: DenoiseMaterial(smartDeNoise) 의 threshold 는 **버퍼 단위의 색 차이**를 나눈다.
//   기본값 0.03 은 LDR(0~1) 가정이다. 우리 버퍼는 물리 radiance(수백~수만 cd/m²)라
//   이웃 픽셀 차이가 수백 → exp(-차이²/threshold²) = exp(-수만) = 0 → 모든 이웃의
//   가중치가 0 이 되어 출력 == 입력. sigma 를 아무리 키워도 불변이었던 이유다.
// 해법: threshold 를 노출(exposure)로 스케일한다. 화면에 보이는 밝기 ≈ radiance × exposure
//   이므로 threshold = (LDR 기준 상수) / exposure 로 두면 주광(2.5e-5)이든 실내(0.05)든
//   '화면에서 같은 정도의 색 차이' 를 같은 강도로 스무딩한다.
// 적용 시점: 항상 표시 필터로 (누적 버퍼는 건드리지 않는다 — 표시만 매끈하게).
//   파이어플라이 번짐 우려는 filterGlossyFactor(생성 억제)와 threshold(큰 차이는 보존)가 막는다.
// 라이브러리의 DenoiseMaterial 은 두 가지가 우리와 안 맞는다(소스 확인):
//   ① rgb *= alpha 프리멀티플라이 — 누적 버퍼의 알파가 1 이 아니라서 화면이 16% 어두워졌다(실측 103→87).
//   ② 선형 HDR 에서 평균 — 기본 블릿(ClampedInterpolationMaterial)은 텍셀별로 톤맵 후 섞는다.
// 그래서 자체 셰이더로 **디스플레이 공간** 디노이즈를 한다: 커널 안에서 각 텍셀을 먼저
// 톤맵하고(기본 블릿과 같은 순서) 그 위에서 bilateral. threshold 가 진짜 LDR(0~1) 단위가
// 되므로 노출 나누기 보정도 필요 없다 — 주광이든 실내든 '화면에서 같은 정도의 차이' 기준.
const RT_DN = { ldrT: 0.12, sigma: 3, kSigma: 1.5 };
function rtSetupDenoise() {
  const { T } = rt.mod;
  if (!rt._dnQuad) {
    rt._dnMat = new T.ShaderMaterial({
      uniforms: { map: { value: null }, sigma: { value: RT_DN.sigma }, kSigma: { value: RT_DN.kSigma }, threshold: { value: RT_DN.ldrT } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        uniform sampler2D map;
        uniform float sigma, kSigma, threshold;
        varying vec2 vUv;
        // 텍셀 하나를 '화면에 보이는 값' 으로 — 기본 블릿과 같은 처리 (톤맵. 색공간 변환은 마지막에 한 번)
        vec3 disp(vec2 uv){
          vec3 c = texture2D(map, uv).rgb;
          #if defined( TONE_MAPPING )
          c = toneMapping(c);
          #endif
          return c;
        }
        void main(){
          float radius = round(kSigma * sigma);
          float invSigmaQx2 = 0.5 / (sigma * sigma);
          float invTQx2 = 0.5 / (threshold * threshold);
          vec2 size = vec2(textureSize(map, 0));
          vec3 centre = disp(vUv);
          float z = 0.0; vec3 acc = vec3(0.0);
          for (float dx = -8.0; dx <= 8.0; dx++) {
            if (abs(dx) > radius) continue;
            float pt = sqrt(radius * radius - dx * dx);
            for (float dy = -8.0; dy <= 8.0; dy++) {
              if (abs(dy) > pt) continue;
              vec2 d = vec2(dx, dy);
              float w = exp(-dot(d, d) * invSigmaQx2);
              vec3 px = disp(vUv + d / size);
              vec3 dC = px - centre;
              w *= exp(-dot(dC, dC) * invTQx2);     // 화면 기준 색 차이가 크면(=모서리) 섞지 않는다
              z += w; acc += w * px;
            }
          }
          gl_FragColor = vec4(acc / max(z, 1e-6), 1.0);
          #include <colorspace_fragment>
        }`,
      depthWrite: false, depthTest: false,
    });
    rt._dnMat.toneMapped = true;   // three 가 TONE_MAPPING 정의 + toneMapping() 함수를 주입하게
    rt._dnQuad = new T.Mesh(new T.PlaneGeometry(2, 2), rt._dnMat);
    rt._dnScene = new T.Scene(); rt._dnScene.add(rt._dnQuad);
    rt._dnCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  rt.tracer.renderToCanvasCallback = (target, renderer, quad) => {
    if (rt.denoise) {
      rt._dnMat.uniforms.map.value = target.texture;
      rt._dnMat.uniforms.sigma.value = RT_DN.sigma;
      rt._dnMat.uniforms.kSigma.value = RT_DN.kSigma;
      rt._dnMat.uniforms.threshold.value = RT_DN.ldrT;   // LDR 단위 그대로 (디스플레이 공간이므로)
      const ac = renderer.autoClear; renderer.autoClear = false;
      renderer.render(rt._dnScene, rt._dnCam);
      renderer.autoClear = ac;
      return;
    }
    const ac = renderer.autoClear; renderer.autoClear = false;
    quad.render(renderer);
    renderer.autoClear = ac;
  };
}
// 환경: 'black'(기본, 실내 조명 검토) | 'day'(물리 하늘 + 태양)
// §2.2 — 검은 환경이 기본이어야 인공조명의 효과를 판별할 수 있다. 주광은 옵션.
//
// 예전에는 GradientEquirectTexture 로 만든 '균일 스카이' 였다. 방향이 없어서 그림자도,
// 시간대도, 방위도 없었다 — 자연광이 아니라 앰비언트 채움광이었다.
// 지금은 Preetham 물리 하늘 + 실제 위치의 태양 원반을 굽는다. 휘도가 cd/m² 실단위라
// 세기 배율(예전의 RT_SKY_INTENSITY)이 필요 없다 — 물리값을 그대로 쓴다.
// ★ 레이트레이싱 환경은 '태양이 켜졌는가' 에서 파생된다. 진실은 state.sun.enabled 하나뿐이다.
// 예전엔 rt.env 를 따로 토글해서 진실이 둘이었다 — 태양을 켜도 레이트레이싱은 검은 환경인
// 상태가 실제로 생겼다(실측: 태양 ON·고도 55.8° 인데 rt.env='black', 하늘 텍스처 없음, 노출 0.05).
// 사용자는 태양을 켰는데 렌더에 햇빛이 없으니 앱이 거짓말하는 셈이었다.
const rtEnvWanted = () => (sunOn() ? 'day' : 'black');
function rtSetEnv(mode) {
  rt.env = (mode === 'day') ? 'day' : 'black';
  if (!rt.on || !rt.scene || !rt.mod) return;
  const { T, P } = rt.mod;
  if (rt.env === 'day') {
    const S = sunState();
    const sig = [S.lat, S.lon, S.tz, S.y, S.mo, S.d, S.h, S.mi, S.north, skyTurbidity(S)].join(',');
    if (!rt._sky || rt._skySig !== sig) {          // 태양·날씨가 그대로면 다시 굽지 않는다
      if (rt._sky) rt._sky.dispose();
      const made = rtMakeSky(S);
      rt._sky = made.tex; rt._skyScale = made.scale;
      rt._skySig = sig;
    }
    rt.scene.environment = rt._sky;
    rt.scene.background = rt._sky;
    // 텍스처에 나눠 담은 배율을 여기서 되돌린다 → 셰이더가 보는 값은 물리 단위(cd/m²)
    rt.scene.environmentIntensity = rt._skyScale;
    rt.scene.backgroundIntensity = rt._skyScale;
  } else {
    rt.scene.environment = null;
    rt.scene.background = new T.Color(0x000000);
    rt.scene.environmentIntensity = 1;
  }
  // 스튜디오 배경(bg 명령) — 배경만 교체, environment(조명)는 그대로.
  // 패스트레이서는 Color 배경을 GradientEquirectTexture 로 받아준다 (소스 확인).
  if (rt.bg === 'white') {
    rt.scene.background = new T.Color().setScalar(3 / rtExposure());   // 노출 통과 후 순백
    rt.scene.backgroundIntensity = 1;
  } else if (rt.bg === 'black') {
    rt.scene.background = new T.Color(0x000000);
    rt.scene.backgroundIntensity = 1;
  }
  rtApplyExposure();   // 주광 ↔ 검은 환경은 밝기가 2,000배 달라 노출도 함께 바꿔야 한다
  if (rt.tracer) { rt.tracer.updateEnvironment(); rtReset(); }
}
// rtenv = 태양 토글. 환경을 따로 토글하면 태양과 진실이 둘이 되어 어긋난다(그래서 그랬다).
function cmdRtEnv() { cmdSun(); }
// bg / 배경 — 렌더 배경만 바꾼다 (스튜디오 컷). 조명·반사(environment)는 그대로.
function cmdBg(arg) {
  const a = String(arg || '').trim().toLowerCase();
  const map = { '흰색': 'white', white: 'white', '화이트': 'white', '하늘': 'sky', sky: 'sky', '기본': 'sky', '검정': 'black', black: 'black', '검은색': 'black' };
  const v = map[a];
  const ko = { white: '흰색(스튜디오)', black: '검정', sky: '하늘(기본)' };
  if (!v) {
    logLine('  사용법: bg 흰색|하늘|검정 — 렌더 배경 그림만 바꿉니다 (태양·하늘빛 조명은 그대로)', 'info');
    logLine(`  지금: ${ko[rt.bg] || rt.bg}`, 'info');
    return;
  }
  rt.bg = v;
  logLine(`  ✔ 렌더 배경: ${ko[v]} — 렌더링 뷰·레이트레이싱 공통`, 'ok');
  if (rt.on) rtSetEnv(rtEnvWanted());   // rt 는 배경 텍스처 갱신 + 재수렴
  if (typeof v3 !== 'undefined' && v3 && is3DActive()) render3D();
}
// edges / 엣지 — 렌더링 뷰에 모서리 선 (라이노 Rendered 의 '모서리 표시' 옵션)
function cmdEdges(arg) {
  const a = String(arg || '').trim();
  if (/^(on|켬)$/i.test(a)) rview.edges = true;
  else if (/^(off|끔)$/i.test(a)) rview.edges = false;
  else rview.edges = !rview.edges;
  logLine(rview.edges ? '  ▷ 모서리 표시 ON — 렌더링 뷰에 윤곽선을 얹습니다 (표시 전용)' : '  ▷ 모서리 표시 OFF', 'info');
  rview.sig = '';                                     // 씬 재빌드 (rviewSig 에도 포함돼 있다)
  if (rview.on && typeof v3 !== 'undefined' && v3) render3D();
  else if (!rview.on) logLine('     렌더링 뷰(rendered)를 켜면 보입니다.', 'info');
}
// 태양 설정 요약 한 줄
function sunSummary() {
  const S = sunState(), p = solarPosition(S);
  const hhmm = `${String(S.h).padStart(2, '0')}:${String(S.mi).padStart(2, '0')}`;
  if (p.alt <= 0) return `${S.mo}/${S.d} ${hhmm} · 태양이 지평선 아래 (고도 ${p.alt.toFixed(1)}°)`;
  const cc = skyCloud(S);
  const w = cc > 0 ? ` · ${weatherName(cc)}(운량 ${Math.round(cc * 100)}%)` : '';
  return `${S.mo}/${S.d} ${hhmm} · 고도 ${p.alt.toFixed(1)}° 방위 ${p.az.toFixed(0)}°${w} · 직달 ${Math.round(sunDirectIlluminance(S)).toLocaleString()} lx · 천공 ${Math.round(skyCtx(S).Ed).toLocaleString()} lx`;
}
// 태양이 화면에 반영되도록 갱신한다. 형상은 그대로이므로 BVH 재빌드는 하지 않는다.
function sunApply() {
  renderSunPanel();
  if (typeof render3D === 'function' && v3) render3D();
  if (rt.on) rtSetEnv(rtEnvWanted());   // 하늘을 다시 굽고 노출도 환경에 맞춘다
}
// IES 배광 파일 불러오기 — 선택한 광원(또는 유일한 광원)에 붙인다.
// 붙이면 그 광원은 균등 배광 대신 제조사 실측 배광으로 빛난다.
function cmdIes(arg) {
  const a = (arg || '').trim();
  const sel = selectedLights();
  if (/^(해제|off|none|제거)$/i.test(a)) {
    if (!sel.length) { logLine('  IES 를 해제할 광원을 먼저 선택하세요.', 'warn'); return; }
    pushUndo();
    for (const L of sel) { L.ies = null; _iesTexCache.delete(L.id + '|'); }
    for (const k of [..._iesTexCache.keys()]) if (sel.some(L => k.startsWith(L.id + '|'))) _iesTexCache.delete(k);
    logLine(`  ▷ IES 해제 — 광원 ${sel.length}개가 균등 배광(lm/4π)으로 돌아갑니다`, 'ok');
    renderLightList(); renderProps(); if (v3) render3D();
    return;
  }
  if (!sel.length) {
    logLine('  IES 를 붙일 광원을 먼저 선택하세요 — [광원] 패널에서 클릭하거나 개체를 선택합니다.', 'warn');
    logLine('  사용법: ies (파일 선택) · ies 해제', 'info');
    return;
  }
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.ies,.IES,text/plain';
  inp.addEventListener('change', () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      const ies = parseIES(rd.result);
      if (ies.err) { logLine(`  ✗ ${f.name}: ${ies.err}`, 'warn'); return; }
      const sm = iesSummary(ies);
      if (!(sm.maxCd > 0)) { logLine(`  ✗ ${f.name}: 광도가 모두 0 입니다.`, 'warn'); return; }
      pushUndo();
      ies.name = f.name;
      for (const L of sel) {
        L.ies = ies;
        if (L.type === 'emissive' || L.type === 'area') L.type = 'spot'; // 배광은 방향이 있는 광원의 개념
        for (const k of [..._iesTexCache.keys()]) if (k.startsWith(L.id + '|')) _iesTexCache.delete(k);
      }
      logLine(`  ▷ IES 적용 — ${f.name} · 최대 ${sm.maxCd.toLocaleString()} cd (${sm.maxAt}°) · 빔각 ${sm.beamDeg != null ? sm.beamDeg + '°' : '—'}`, 'ok');
      if (ies.lumens > 0) logLine(`     파일의 광속 ${Math.round(ies.lumens).toLocaleString()} lm — 밝기는 광원의 세기(lm) 설정을 그대로 씁니다. 맞추려면 세기를 이 값으로 바꾸세요.`, 'info');
      if (!ies.axial) logLine(`     ⚠ 수평각 ${ies.nH}개(비축대칭) — 렌더러가 축대칭 배광만 지원해 수평 방향으로 평균했습니다. 좌우가 다른 배광은 근사입니다.`, 'warn');
      renderLightList(); renderProps(); if (v3) render3D();
    };
    rd.onerror = () => logLine('  ✗ 파일을 읽지 못했습니다.', 'warn');
    rd.readAsText(f);
  });
  inp.click();
}
// 선택된 광원들 — 개체 선택 또는 [광원] 패널 선택
function selectedLights() {
  const out = [];
  for (const L of state.lights) if (state.selection.has(L.objectId)) out.push(L);
  if (!out.length && state.lights.length === 1) out.push(state.lights[0]); // 광원이 하나뿐이면 그것
  return out;
}

// 라이노의 Sun 명령과 같은 이름·같은 개념(날짜·시각·위경도·북쪽).
// 인자 없이 부르면 켜고/끈다 — 라이노의 Sun 패널 체크박스와 같다.
// 값만 보고 싶으면 sun 상태.
function cmdSun(arg) {
  const S = sunState();
  const a = (arg || '').trim();
  if (!a) {
    if (!is3DActive()) { logLine('  태양은 3D 작업 뷰에서 보입니다 — 먼저 3d 명령으로 여세요.', 'warn'); return; }
    pushUndo();
    S.enabled = !S.enabled;
    sunApply();
    if (S.enabled) {
      const p = solarPosition(S);
      if (p.alt <= 0) logLine(`  ☀ 태양 ON — 그런데 ${S.mo}/${S.d} ${String(S.h).padStart(2,'0')}:${String(S.mi).padStart(2,'0')} 은 해가 지평선 아래입니다(고도 ${p.alt.toFixed(1)}°). 오른쪽 [태양] 패널의 시각을 낮으로 옮기세요.`, 'warn');
      else logLine(`  ☀ 태양 ON — ${sunSummary()}. 오른쪽 [태양] 패널에서 날짜·시각을 조절하세요 (다시 입력하면 OFF)`, 'ok');
    } else logLine('  ☀ 태양 OFF', 'info');
    return;
  }
  if (/^(상태|status|\?)$/i.test(a)) {
    const p = solarPosition(S);
    const n = sunNoonMinutes(S);
    logLine(`  ☀ 태양 ${S.enabled ? 'ON' : 'OFF'} — ${S.y}-${String(S.mo).padStart(2, '0')}-${String(S.d).padStart(2, '0')} ${String(S.h).padStart(2, '0')}:${String(S.mi).padStart(2, '0')} (UTC${S.tz >= 0 ? '+' : ''}${S.tz / 60})`, 'info');
    logLine(`     위치 ${S.lat.toFixed(4)}, ${S.lon.toFixed(4)} · 진북 ${S.north}° · 탁도 ${skyTurbidity(S)}`, 'info');
    logLine(`     고도 ${p.alt.toFixed(2)}° · 방위 ${p.az.toFixed(2)}° · 남중 ${String(Math.floor(n / 60)).padStart(2, '0')}:${String(Math.round(n % 60)).padStart(2, '0')}`, 'info');
    logLine(`     직달 ${Math.round(sunDirectIlluminance(S)).toLocaleString()} lx`, 'info');
    return;
  }
  const m = a.split('=').map(s => s.trim());
  const k = m[0], v = m[1];
  if (v == null) { logLine('  sun 항목=값 형식으로 입력하세요. 그냥 sun 을 입력하면 현재 값을 봅니다.', 'warn'); return; }
  pushUndo();
  const num = parseFloat(v);
  if (/^(시각|time)$/i.test(k)) {
    const t = v.split(':'); S.h = Math.min(23, Math.max(0, parseInt(t[0], 10) || 0)); S.mi = Math.min(59, Math.max(0, parseInt(t[1], 10) || 0));
  } else if (/^(날짜|date)$/i.test(k)) {
    const t = v.split('-'); S.y = parseInt(t[0], 10) || S.y; S.mo = Math.min(12, Math.max(1, parseInt(t[1], 10) || S.mo)); S.d = Math.min(31, Math.max(1, parseInt(t[2], 10) || S.d));
  } else if (/^(위도|lat)$/i.test(k)) { S.lat = Math.min(90, Math.max(-90, num)); }
  else if (/^(경도|lon)$/i.test(k)) { S.lon = Math.min(180, Math.max(-180, num)); }
  else if (/^(시간대|tz)$/i.test(k)) { S.tz = Math.round(num * 60); }
  else if (/^(북|북쪽|north)$/i.test(k)) { S.north = sunMod(num, 360); }
  else if (/^(탁도|turbidity)$/i.test(k)) { S.turbidity = Math.min(SKY_TURBIDITY_MAX, Math.max(SKY_TURBIDITY_MIN, num)); }
  else { logLine(`  모르는 항목: ${k} — 시각·날짜·위도·경도·시간대·북·탁도`, 'warn'); return; }
  if (!S.enabled) { S.enabled = true; logLine('  (값을 바꿨으므로 태양을 함께 켰습니다)', 'info'); }
  sunApply();
  logLine(`  ☀ ${sunSummary()}`, 'ok');
}
// 디노이저가 실제로 동작하게 되면 다시 명령어로 등록한다. 그 전까지는 노출하지 않는다.
function cmdRtDenoise(arg) {
  const a = String(arg || '').trim();
  if (a) {
    const v = parseFloat(a);
    if (isFinite(v) && v > 0 && v <= 2) {
      RT_DN.ldrT = v;
      rt.denoise = true;
      logLine(`  ✔ 디노이즈 강도 ${v} (기본 0.15 — 클수록 매끈하지만 흐릿해짐)`, 'ok');
      return;
    }
    if (!/^(on|off|켬|끔)$/i.test(a)) { logLine('  사용법: denoise (토글) · denoise 0.1~2 (강도)', 'warn'); return; }
    rt.denoise = /^(on|켬)$/i.test(a);
  } else rt.denoise = !rt.denoise;
  logLine(rt.denoise ? '  ▷ 디노이즈 ON — 표시만 매끈하게 (누적 데이터는 그대로)' : '  ▷ 디노이즈 OFF (원본 표시)', 'info');
}

// viewcapturetofile / capture / 렌더저장 [2~4] — 지금 보이는 렌더를 PNG 로 저장 (라이노 ViewCaptureToFile)
//  배율(2~4)을 주면 렌더링 뷰를 그 배율의 오프스크린 해상도로 다시 그려 저장한다 (인쇄·발표용).
//  ★WebGL 캔버스는 preserveDrawingBuffer 가 없으면 태스크가 끝난 뒤 읽으면 빈 그림이 나온다 —
//    렌더링 뷰는 '같은 태스크 안에서' 렌더 직후 2D 캔버스로 복사한다.
function cmdCapture(arg) {
  const a = String(arg || '').trim();
  let s = 1;
  if (a) {
    const v = parseInt(a, 10);
    if (isFinite(v) && v >= 2 && v <= 4) s = v;
    else if (a) { logLine('  사용법: 렌더저장 (그대로) · 렌더저장 2~4 (고해상도 — 렌더링 뷰 전용)', 'warn'); return; }
  }
  const d = new Date(), p2 = n => String(n).padStart(2, '0');
  const stamp = d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  const grab = (src, label) => {
    const t = document.createElement('canvas'); t.width = src.width; t.height = src.height;
    t.getContext('2d').drawImage(src, 0, 0);            // ★동기 복사 — 이후 원본 크기를 되돌려도 안전
    t.toBlob(b => {
      if (!b) { logLine('  ✗ 캡처 실패 — 캔버스를 읽지 못했습니다.', 'warn'); return; }
      saveBlob(b, 'parti-render-' + stamp + '.png');
      logLine('  ✔ ' + label + ' 저장 — parti-render-' + stamp + '.png (' + t.width + '×' + t.height + ')', 'ok');
    }, 'image/png');
  };
  if (rt.on && rt.cv && rt.cv.style.display !== 'none') {  // rtcv 는 preserveDrawingBuffer:true
    grab(rt.cv, '레이트레이싱');
    if (s > 1) logLine('     레이트레이싱은 누적된 화면 해상도 그대로 저장됩니다 — 고해상도(×2~4)는 렌더링 뷰에서 지원합니다.', 'info');
    return;
  }
  if (rview.on && rview.cv && rview.cv.style.display !== 'none') {
    if (s > 1) {
      // 고해상도: 캔버스 내부 해상도만 키워 한 번 렌더 → 복사 → 원상복구 (카메라는 종횡비 동일이라 그대로)
      const c = rview.cv, kw = c.width, kh = c.height;
      const sc = Math.max(1, Math.min(s, Math.floor(8192 / Math.max(kw, kh)) || 1));   // GPU 텍스처 상한 보호
      try {
        c.width = kw * sc; c.height = kh * sc;
        rview.renderer.setViewport(0, 0, c.width, c.height);
        rview._aoW = 0;                                    // AO(선택 사용) 컴포저도 새 크기로
        if (rview.ao && rview.fx) { try { rviewAoRender(); } catch (e) { rview.renderer.render(rview.scene, rview.cam); } }
        else rview.renderer.render(rview.scene, rview.cam);
        grab(c, `렌더링 뷰 ×${sc}`);
      } finally {
        c.width = kw; c.height = kh;
        rview.renderer.setViewport(0, 0, kw, kh);
        rview._aoW = 0;
        render3D();                                        // 화면 원상복구
      }
      return;
    }
    rviewFrame(); grab(rview.cv, '렌더링 뷰');
    return;
  }
  if (!is3DActive()) {                                   // 순수 2D 화면 — 도면 그대로
    const c2 = document.getElementById('cv');
    if (c2) { grab(c2, '도면 화면'); return; }
  }
  logLine('  캡처할 렌더가 없습니다 — rendered(렌더링 뷰)나 raytrace 를 켠 뒤 사용하세요.', 'warn');
  logLine('  (도면 자체의 PNG 내보내기는 저장 메뉴의 PNG 를 쓰세요.)', 'info');
}

async function rtEnter() {
  if (!v3 || !is3DActive()) {
    logLine('  Raytraced: 3D 작업 뷰에서만 사용합니다 — 먼저 3d 명령으로 여세요.', 'warn'); return;
  }
  if (!rtSupported()) { // §2.4 폴백
    logLine('  ⚠ 이 브라우저는 WebGL2를 지원하지 않아 Raytraced 모드를 쓸 수 없습니다.', 'warn');
    logLine('    대신 lighting(조명 보기)을 켜면 근사 렌더로 확인할 수 있습니다 (근사 모드).', 'info');
    return;
  }
  if (rt.on) { rtExit(); return; }
  if (vpIsPlan(v3.act)) { logLine('  평면 칸은 도면 표시 전용입니다 — 아이소 등 3D 뷰포트에서 켜주세요.', 'warn'); return; }
  const ov = document.getElementById('bim3d');
  if (!rt.cv) {
    rt.cv = document.createElement('canvas');
    rt.cv.id = 'rtcv';
    // ★뷰포트 종속 — 예전엔 inset:0 로 오버레이 '전체' 를 덮었다. 4분할에서 레이트레이싱을 켜면
    // 활성 칸 하나의 카메라로 그린 그림이 4분할 격자를 통째로 덮어쓰고 종횡비까지 틀어졌다.
    // pointer-events:none — 궤도·팬·선택 이벤트는 밑의 #b3cv 가 그대로 받아야 한다.
    // (예전엔 이게 없어서 레이트레이싱 중 캔버스가 이벤트를 먹었다 — rview 는 처음부터 none 이었다)
    rt.cv.style.cssText = 'position:absolute;z-index:19;pointer-events:none;';
    rt.hud = document.createElement('div');
    rt.hud.style.cssText = 'position:absolute;z-index:20;font:11px/1.5 var(--mono);'
      + 'padding:4px 9px;border-radius:980px;background:rgba(10,16,32,.72);color:#cfe0ff;pointer-events:none;';
    ov.appendChild(rt.cv); ov.appendChild(rt.hud);
  }
  rt.cv.style.display = ''; rt.hud.style.display = '';
  rt.vi = v3.act;          // 이 뷰포트에 묶인다 (rview 와 같은 규약)
  rt.on = true;
  try {
    const { T } = await rtLoad();
    if (!rt.renderer) {
      // preserveDrawingBuffer: 검증(픽셀 읽기)과 화면 캡처에 필요
      rt.renderer = new T.WebGLRenderer({ canvas: rt.cv, preserveDrawingBuffer: true });
      rt.renderer.setPixelRatio(1);
      // 물리 단위(cd/m²)는 수백~수천이라 그대로 그리면 전부 하얗다 — 노출로 화면 범위에 담는다
      rt.renderer.toneMapping = T.ACESFilmicToneMapping;
    }
    rtResize();
    await rtRebuild();
    rtSetEnv(rtEnvWanted());   // 태양이 켜져 있으면 주광, 아니면 검은 환경. 노출도 여기서 함께 잡힌다
    if (rt.triCount > RT_TRI_WARN && !confirm(`삼각형이 ${rt.triCount.toLocaleString()}개입니다. 레이트레이싱이 매우 느릴 수 있습니다. 계속할까요?`)) { rtExit(); return; }
    logLine(`  ▷ Raytraced ON — 삼각형 ${rt.triCount.toLocaleString()}개 · 광원 ${lightSources().length}개 · 환경 ${rt.env === 'day' ? '주광' : '검은 환경'} (다시 입력하면 OFF)`, 'info');
    if (!state.lights.length) logLine('    광원이 없어 화면이 검게 나옵니다 — setaslight 로 광원을 지정하세요.', 'warn');
    rtLoop();
  } catch (e) {
    rt.on = false; rt.err = String(e);
    logLine('  ⚠ 레이트레이서를 불러오지 못했습니다: ' + e, 'warn');
    logLine('    lighting(조명 보기)으로 근사 렌더를 쓸 수 있습니다.', 'info');
    rtExit();
  }
}
function rtExit() {
  const was = rt.vi;
  rt.on = false;
  rt.autoSave = false;   // finalrender 예약은 세션과 함께 끝난다 — 다음 진입에서 불쑥 저장되면 안 된다
  cancelAnimationFrame(rt.raf);
  if (rt.cv) { rt.cv.style.display = 'none'; rt.cv.style.outline = ''; }
  if (rt.hud) rt.hud.style.display = 'none';
  if (was != null && was >= 0) vpHideLabel(was);   // 끄면 3D 렌더러가 자기 캔버스에 이름표를 다시 그린다
  rt.vi = -1;
  render3D();
}
function cmdRaytrace() { rtEnter(); }
// finalrender / 최종렌더 — 라이노 Render 의 흐름: 레이트레이싱을 돌려 수렴하면 자동으로 PNG 저장.
// 품질은 rtquality(낮음/보통/높음/최고)를 그대로 따른다 — 발표용이면 먼저 rtquality 높음.
function cmdFinalRender() {
  if (!v3 || !is3DActive()) { logLine('  최종 렌더는 3D 화면에서 — view3d 로 열어주세요.', 'warn'); return; }
  if (vpIsPlan(v3.act) && !rt.on) { logLine('  평면 칸은 도면 표시 전용입니다 — 아이소 등 3D 뷰포트에서 실행하세요.', 'warn'); return; }
  rt.autoSave = true;
  logLine(`  ▶ 최종 렌더 — ${rt.q.spp} spp(${rt.q.name}) 수렴 후 자동 저장합니다. 품질 변경: rtquality 높음/최고`, 'info');
  if (!rt.on) rtEnter();
}


// ============================================================
//  조도 분석 (Phase 4) — False Color + 측정면
//  조도는 광원의 '실제 루멘'으로 해석적으로 계산한다. False Color와 측정면이 같은
//  함수를 쓰므로 화면의 색과 측정점 숫자가 반드시 일치한다.
//  근사임을 분명히 한다: IES 배광 없이 균등 배광 가정 (§4.3).
// ============================================================
// 조도(lux). 거리는 반드시 m로 환산한다 — 씬 단위가 mm라 그냥 쓰면 조도가 10^6 배 틀어진다 (§3.2).
function illuminanceAt(wx, wy, wz, nx, ny, nz) {
  const L = (typeof v3 !== 'undefined' && v3 && v3._lights) ? v3._lights : lightSources();
  let E = 0;
  for (const g of L) {
    const dx = g.x - wx, dy = g.y - wy, dz = g.z - wz;
    const d2 = dx * dx + dy * dy + dz * dz;
    const d = Math.sqrt(d2) || 1;
    const cos = (dx * nx + dy * ny + dz * nz) / d;
    if (cos <= 0) continue;                       // 광원을 등진 면
    let vis = 1;
    if (typeof v3 !== 'undefined' && v3 && v3._occ) {
      vis = visFraction(wx + nx * 2, wy + ny * 2, wz + nz * 2, g, dx, dy, dz, d);
      if (vis <= 0) continue;                     // 완전히 그늘
    }
    // 광도(cd). 배광(IES)이 있으면 그 방향의 실측 광도를, 없으면 균등 배광.
    // ★ 렌더러와 반드시 같은 함수를 써야 한다 — 안 그러면 화면과 조도 숫자가 어긋난다.
    // 광원의 정면축은 아래(-Z). 면에서 광원으로 가는 방향의 반대가 광원이 쏘는 방향이다.
    const ang = g.ies ? Math.acos(Math.max(-1, Math.min(1, -(-dz) / d))) : 0;
    const I = lightCandela(g.lm || 0, g.ies || null, ang);
    const dM2 = d2 * RT_MM * RT_MM;               // mm² → m²
    E += I * cos / Math.max(1e-9, dM2) * vis;
  }
  return E;
}
// False Color 스케일: 0=파랑 → 중간=초록 → 최대 이상=빨강 (§4.1)
const FC_MAX_DEF = 500; // 주거 검토 기본. 사무는 1000 등으로 조절.
function falseColor(E, max) {
  const t = Math.max(0, Math.min(1, E / Math.max(1, max || FC_MAX_DEF)));
  const mix = (a, b, u) => Math.round(a + (b - a) * u);
  let r, g, b;
  if (t < 0.5) { const u = t / 0.5; r = mix(32, 32, u); g = mix(80, 192, u); b = mix(255, 96, u); }
  else { const u = (t - 0.5) / 0.5; r = mix(32, 255, u); g = mix(192, 48, u); b = mix(96, 32, u); }
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}
function fcLegend(c, vp) {
  const max = v3.fcMax || FC_MAX_DEF;
  const w = 150, h = 12, x = vp.x + 12, y = vp.y + vp.h - 34;
  const g = c.createLinearGradient(x, 0, x + w, 0);
  for (let i = 0; i <= 10; i++) g.addColorStop(i / 10, falseColor(max * i / 10, max));
  c.save();
  c.fillStyle = 'rgba(10,16,32,0.72)';
  c.fillRect(x - 8, y - 16, w + 16, h + 30);
  c.fillStyle = g; c.fillRect(x, y, w, h);
  c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 1; c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  c.fillStyle = '#cfe0ff'; c.font = '10px monospace'; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  c.fillText('조도 (lux, 근사)', x, y - 4);
  c.fillText('0', x, y + h + 11);
  c.fillText(String(Math.round(max / 2)), x + w / 2 - 8, y + h + 11);
  c.fillText(String(max) + '+', x + w - 22, y + h + 11);
  c.restore();
}
// ---------- 측정면 (Sensor Grid) ----------
// 사각 영역 위에 격자 측정점을 만들어 조도를 읽는다. 보통 바닥에서 750mm 작업면.
function sensorGrid(S) {
  const pts = [];
  const sp = Math.max(50, S.spacing || 500);
  const nx = Math.max(1, Math.round((S.x1 - S.x0) / sp));
  const ny = Math.max(1, Math.round((S.y1 - S.y0) / sp));
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++)
    pts.push({ x: S.x0 + (S.x1 - S.x0) * i / nx, y: S.y0 + (S.y1 - S.y0) * j / ny, z: S.z });
  return pts;
}
function sensorMeasure(S) {
  const pts = sensorGrid(S);
  const vals = pts.map(p => illuminanceAt(p.x, p.y, p.z, 0, 0, 1)); // 작업면은 위를 향한다
  const min = Math.min(...vals), max = Math.max(...vals);
  const avg = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
  S.pts = pts; S.vals = vals;
  S.stats = { min, max, avg, u0: avg > 0 ? min / avg : 0, n: vals.length }; // 균제도 U0 = min/avg
  return S.stats;
}
function cmdAddSensorPlane() {
  const sel = selectedEntities().filter(e => e.type === 'LWPOLYLINE' && e.closed && (e.points || []).length >= 3);
  if (!sel.length) { logLine('  측정면: 측정할 사각 영역(닫힌 폴리라인)을 선택한 뒤 실행하세요.', 'warn'); return; }
  const z = bimAskNum('측정면 높이 (mm) — 작업면은 보통 750:', settings.bim.sensorZ || 750); if (z == null) return;
  const sp = bimAskNum('격자 간격 (mm):', settings.bim.sensorSp || 500); if (sp == null) return;
  settings.bim.sensorZ = z; settings.bim.sensorSp = sp; saveSettings();
  pushUndo();
  for (const e of sel) {
    const bb = entityBBox(e); if (!bb) continue;
    state.sensors.push({ id: 'S' + (state.nextSensorId++), x0: bb.xmin, y0: bb.ymin, x1: bb.xmax, y1: bb.ymax, z, spacing: sp });
  }
  logLine('  ✔ 측정면 ' + sel.length + '개 — 높이 ' + z + 'mm · 격자 ' + sp + 'mm. 3d + lighting 에서 조도가 표시됩니다.', 'ok');
  renderSensorList(); draw(); boolRefresh();
}
function cmdClearSensorPlanes() {
  if (!state.sensors.length) { logLine('  측정면이 없습니다.', 'warn'); return; }
  pushUndo();
  const n = state.sensors.length; state.sensors.length = 0;
  logLine('  ✔ 측정면 ' + n + '개 삭제', 'ok');
  renderSensorList(); draw(); boolRefresh();
}
function sensorCSV() {
  if (!state.sensors.length) return '';
  let out = 'plane,x_mm,y_mm,z_mm,illuminance_lux\n';
  for (const S of state.sensors) {
    if (!S.vals) sensorMeasure(S);
    S.pts.forEach((p, i) => {
      out += S.id + ',' + Math.round(p.x) + ',' + Math.round(p.y) + ',' + Math.round(p.z) + ',' + S.vals[i].toFixed(1) + '\n';
    });
  }
  out += '\n# 이 값은 시각화용 근사치이며, 법규·인증용 조도 계산(Radiance, DIALux 등)을 대체하지 않습니다.\n';
  out += '# IES 배광 데이터 없이 균등 배광을 가정했습니다.\n';
  return out;
}
function cmdSensorCSV() {
  if (!state.sensors.length) { logLine('  측정면이 없습니다 — addsensorplane 으로 먼저 만드세요.', 'warn'); return; }
  if (!is3DActive()) { logLine('  조도 계산은 3D 작업 뷰에서 합니다 — 먼저 3d 로 여세요.', 'warn'); return; }
  saveBlob(new Blob([sensorCSV()], { type: 'text/csv;charset=utf-8' }), (currentFileName || 'parti') + '_조도.csv');
  logLine('  ✔ 조도 CSV 내보내기', 'ok');
}
// 측정면 패널 — 통계(최소/평균/최대/균제도)와 정확도 고지
function renderSensorList() {
  const el = document.getElementById('sensorList');
  if (!el) return;
  if (!state.sensors.length) {
    el.innerHTML = '<div class="empty" style="font-size:11.5px;opacity:.6;padding:4px 2px;">측정면이 없습니다. 사각 영역을 선택하고 <b>addsensorplane</b>.</div>';
    return;
  }
  const on = is3DActive() && typeof v3 !== 'undefined' && v3 && (v3.lighting || sunOn() || rt.on);
  let h = '';
  for (const S of state.sensors) {
    let st = S.stats;
    if (on) st = sensorMeasure(S);
    const w = Math.round((S.x1 - S.x0) / 100) / 10, d = Math.round((S.y1 - S.y0) / 100) / 10;
    h += '<div class="layer"><div class="lrow1"><span class="nm">' + S.id + ' · ' + w + '×' + d + 'm · z=' + S.z + '</span></div>';
    h += st
      ? '<div class="lrow2" style="font-size:10.5px;opacity:.75;font-variant-numeric:tabular-nums;">'
        + '최소 ' + st.min.toFixed(0) + ' · 평균 ' + st.avg.toFixed(0) + ' · 최대 ' + st.max.toFixed(0) + ' lx<br>'
        + '균제도 U0 = ' + st.u0.toFixed(2) + ' · 측정점 ' + st.n + '개</div>'
      : '<div class="lrow2" style="font-size:10.5px;opacity:.6;">3d + lighting 에서 계산됩니다</div>';
    h += '</div>';
  }
  h += '<div style="font-size:10px;opacity:.55;line-height:1.5;margin-top:6px;">'
    + '이 조도 값은 시각화용 근사치이며, 법규·인증용 조도 계산(Radiance, DIALux 등)을 대체하지 않습니다. '
    + 'IES 배광 없이 균등 배광을 가정합니다.</div>';
  el.innerHTML = h;
}
// 3D에 측정점과 조도 숫자를 그린다
function drawSensors(c, vp) {
  if (!state.sensors.length) return;
  const dpr = devicePixelRatio || 1;
  c.save();
  c.font = (9 * dpr) + 'px monospace';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  for (const S of state.sensors) {
    if (!S.vals) sensorMeasure(S);
    S.pts.forEach((p, i) => {
      const q = proj3D(p.x, p.y, p.z);
      if (q[0] < vp.x || q[0] > vp.x + vp.w || q[1] < vp.y || q[1] > vp.y + vp.h) return;
      const E = S.vals[i];
      c.fillStyle = falseColor(E, v3.fcMax || FC_MAX_DEF);
      c.beginPath(); c.arc(q[0], q[1], 2.5 * dpr, 0, Math.PI * 2); c.fill();
      c.strokeStyle = 'rgba(8,12,24,.85)'; c.lineWidth = 2.5 * dpr;
      const s = String(Math.round(E));
      c.strokeText(s, q[0], q[1] - 9 * dpr);
      c.fillStyle = '#e8f0ff';
      c.fillText(s, q[0], q[1] - 9 * dpr);
    });
  }
  c.restore();
}
function cmdFalseColor() {
  if (!v3 || !is3DActive()) { logLine('  False Color: 3D 작업 뷰에서만 사용합니다 — 먼저 3d 로 여세요.', 'warn'); return; }
  v3.falseColor = !v3.falseColor;
  if (v3.falseColor && !v3.lighting) { v3.lighting = true; logLine('  (조도 표시를 위해 조명 보기를 함께 켰습니다)', 'info'); }
  v3._litCache = new Map(); v3._litSig = null;
  const mx = v3.fcMax || FC_MAX_DEF;
  logLine(v3.falseColor
    ? '  ▷ False Color ON — 표면 조도를 색으로 (0=파랑 · ' + Math.round(mx / 2) + '=초록 · ' + mx + '+=빨강 lux). 시각화용 근사치입니다.'
    : '  ▷ False Color OFF', 'info');
  renderSensorList(); render3D();
}
function cmdFcMax() {
  if (!v3) { logLine('  3D 작업 뷰에서 사용합니다.', 'warn'); return; }
  const m = bimAskNum('False Color 최대값 (lux) — 주거 500, 사무 1000:', v3.fcMax || FC_MAX_DEF);
  if (m == null) return;
  v3.fcMax = Math.max(10, m);
  v3._litCache = new Map(); v3._litSig = null;
  logLine('  ✔ False Color 스케일 0 ~ ' + v3.fcMax + ' lux', 'ok');
  renderSensorList(); render3D();
}

function cmdLighting() {
  if (!v3 || !document.getElementById('bim3d') || document.getElementById('bim3d').style.display === 'none') {
    logLine('  조명 보기: 3D 작업 뷰에서만 사용합니다 — 먼저 3d 명령으로 여세요.', 'warn'); return;
  }
  v3.lighting = !v3.lighting;
  const n = v3.lighting ? lightSources().length : 0;
  if (v3.lighting && !n) logLine('  ▷ 조명 보기 ON — 그런데 배치된 조명 기구가 없습니다. light 명령으로 먼저 조명을 세우세요.', 'warn');
  else logLine(v3.lighting ? `  ▷ 조명 보기 ON — 야간 화면, 광원 ${n}개가 주변을 밝힙니다 (다시 입력하면 OFF)` : '  ▷ 조명 보기 OFF — 기본 셰이딩으로 복귀', 'info');
  if (!v3.lighting) v3.falseColor = false;   // 조명이 꺼지면 조도 표시도 의미가 없다
  render3D();
}
// 선택한 개체를 광원으로 지정한다. 개체 자체는 아무것도 바뀌지 않는다 —
// 형태·색·BIM 정체(기둥·벽·면) 모두 그대로. 정육면체를 지정하면 정육면체 광원체가 된다.
// 광원 속성은 개체가 아니라 state.lights 컬렉션에 두고, 개체엔 lightId 참조만 남긴다.
// 높이는 묻지 않는다: 개체가 놓인 자리에서 그대로 빛난다.
function defaultLightName(e) {
  const kind = e.type === 'MESH' ? '메시' : (e.bim ? (LIGHT_NAME_KO[e.bim.kind] || e.bim.kind) : e.type.toLowerCase());
  return `${kind} #${e.id}`;
}
const LIGHT_NAME_KO = { wall: '벽', slab: '슬래브', column: '기둥', stair: '계단', roof: '지붕', railing: '난간' };
function cmdSetAsLight() {
  const sel = selectedEntities().filter(lightableEnt);
  if (!sel.length) { logLine('  광원으로 지정: 빛을 낼 개체(솔리드·면·메시 또는 선·폴리라인·원)를 선택한 뒤 실행하세요.', 'warn'); return; }
  const fresh = sel.filter(e => !lightOfEnt(e));
  if (!fresh.length) { logLine(`  이미 광원입니다 (해제는 unsetlight)`, 'warn'); return; }
  pushUndo();
  for (const e of fresh) {
    const L = Object.assign({ id: 'L' + (state.nextLightId++), objectId: e.id, name: defaultLightName(e) }, lightDefaults());
    state.lights.push(L); e.lightId = L.id;
  }
  logLine(`  ✔ 광원으로 지정 ${fresh.length}개 — 개체의 형태·색은 그대로입니다`
    + ` · ${LM_REF}lm / 3000K · 3d 후 lighting 으로 확인 (해제: unsetlight)`, 'ok');
  renderLightList(); renderProps(); draw(); boolRefresh();
}
function cmdUnsetLight() {
  const sel = selectedEntities().filter(e => lightOfEnt(e));
  if (!sel.length) { logLine('  광원 해제: 광원으로 지정된 개체를 선택한 뒤 실행하세요.', 'warn'); return; }
  pushUndo();
  for (const e of sel) {
    const i = state.lights.findIndex(L => L.id === e.lightId);
    if (i >= 0) state.lights.splice(i, 1);
    delete e.lightId;
  }
  logLine(`  ✔ 광원 해제 ${sel.length}개 — 개체는 그대로 남습니다`, 'ok');
  renderLightList(); renderProps(); draw(); boolRefresh();
}
function cmdRailingTag() {
  const sel = selectedEntities().filter(e => e.type === 'LINE' || e.type === 'LWPOLYLINE' || e.type === 'CIRCLE');
  if (!sel.length) { logLine('  난간: 선/곡선/원(난간이 설 경로)을 선택한 뒤 실행하세요.', 'warn'); return; }
  const h = bimAskNum('난간 높이 (mm):', settings.bim.railH || 1100); if (h == null) return;
  const sp = bimAskNum('동자기둥 간격 (mm):', settings.bim.railSpacing || 1200); if (sp == null) return;
  settings.bim.railH = h; settings.bim.railSpacing = sp; saveSettings();
  pushUndo();
  for (const e of sel) e.bim = { kind: 'railing', h, t: 50, postT: 60, spacing: sp, base: (e.bim && e.bim.base != null) ? e.bim.base : lvElev() };
  const onSrf = sel.filter(e => wallBaseZs(e)).length;
  logLine(`  ✔ 난간 지정 ${sel.length}개 (높이 ${h}, 기둥 간격 ${sp})`
    + (onSrf ? ` · ${onSrf}개는 곡선 높이를 따라감` : '')
    + ' — 경사진 난간은 경로에 높이가 있어야 합니다(표면 위 곡선 또는 3D 선)', 'ok');
  renderProps(); draw(); boolRefresh();
}
function cmdRoofTag() {
  const sel = selectedEntities().filter(e => e.type === 'LWPOLYLINE' && e.closed);
  if (!sel.length) { logLine('  지붕: 닫힌 폴리라인(지붕 외곽)을 선택한 뒤 실행하세요.', 'warn'); return; }
  const tp = prompt('지붕 유형 — 1: 박공(gable)  2: 외쪽(shed)  3: 평(flat)', '1');
  if (tp === null) return;
  const rtype = tp.trim() === '2' ? 'shed' : tp.trim() === '3' ? 'flat' : 'gable';
  const eave = bimAskNum('처마 높이 (지붕이 시작되는 z, mm):', lvElev() + settings.bim.wallH); if (eave == null) return;
  const rise = rtype === 'flat'
    ? (bimAskNum('지붕 두께 (mm):', 300) || 300)
    : (bimAskNum(rtype === 'gable' ? '용마루 추가 높이 (처마 위로, mm):' : '높은 쪽 추가 높이 (mm):', settings.bim.roofRise) || settings.bim.roofRise);
  let dir = 'auto';
  if (rtype === 'shed') {
    const d = prompt('높은 쪽 방향 — 1: 북(+Y)  2: 남(-Y)  3: 동(+X)  4: 서(-X)', '1');
    dir = { '1': 'n', '2': 's', '3': 'e', '4': 'w' }[(d || '1').trim()] || 'n';
  } else if (rtype === 'gable') {
    const d = prompt('용마루 방향 — Enter: 자동(긴 변)  1: 가로(X)  2: 세로(Y)', '');
    dir = d && d.trim() === '1' ? 'x' : d && d.trim() === '2' ? 'y' : 'auto';
  }
  settings.bim.roofRise = rise; saveSettings();
  pushUndo();
  for (const e of sel) e.bim = { kind: 'roof', rtype, eave, rise, dir };
  logLine(`  ✔ 지붕 지정 ${sel.length}개 (${{ gable: '박공', shed: '외쪽', flat: '평' }[rtype]}, 처마 ${eave}${rtype === 'flat' ? '' : ', 상승 ' + rise})`, 'ok');
  renderProps(); draw();
}
// 지붕 → 경사 상단(zt) 솔리드 생성 (풋프린트의 bbox 사각 기준)
function roofSolids(e) {
  const b = e.bim;
  // 기울임(shear) — 지붕 볼륨의 윗면을 수평으로 밀어 매스가 기울어 서게 한다.
  // 스케치에서 잰 기울기를 그대로 받는 통로. 없으면 예전대로 수직 프리즘.
  const shr = (b.shear && (b.shear[0] || b.shear[1])) ? b.shear : null;
  const withShear = (arr) => shr
    ? arr.map(s => ({ ...s, ptop: s.poly.map(p => [p[0] + shr[0], p[1] + shr[1]]) }))
    : arr;
  const xs = e.points.map(p => p[0]), ys = e.points.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const col = '#b8695a';
  // ── 회전된 사각 지붕 ── (축 정렬이면 아래 기존 경로 그대로 — 회귀 없음)
  // 축 정렬 bbox 로만 처리하면 비스듬히 앉힌 동의 지붕이 통째로 틀어진다. 네 꼭짓점이 있는
  // 사각형이면 긴 변 방향을 용마루로 삼아 두 경사면을 만든다(축 정렬 결과와 동일하게 환원).
  if (e.points.length === 4 && b.rtype !== 'flat') {
    const P = e.points.map(p => [p[0], p[1]]);
    const axisAligned = P.every((p, i) => {
      const q = P[(i + 1) % 4];
      return Math.abs(p[0] - q[0]) < 1e-6 || Math.abs(p[1] - q[1]) < 1e-6;
    });
    // ridgeF: 용마루를 앞변(P0→P1) 쪽에서 비율 f 지점에 — 비대칭 박공(0.5=대칭).
    // rdir 'short': 용마루를 짧은 변과 평행하게 — 박공벽(gable wall) 프로필용.
    const rF = (b.ridgeF != null && isFinite(b.ridgeF)) ? Math.min(0.92, Math.max(0.08, b.ridgeF)) : 0.5;
    if (!axisAligned || rF !== 0.5 || b.rdir) {
      const hi = b.eave + b.rise, lo = b.eave;
      const len = (a2, b2) => Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
      const at = (a2, b2, f) => [a2[0] + (b2[0] - a2[0]) * f, a2[1] + (b2[1] - a2[1]) * f];
      if (b.rtype === 'shed') {                       // 외쪽: 긴 변을 따라 한 방향으로 기울인다
        return withShear([{ poly: P, z0: lo, z1: hi, zt: [lo, lo, hi, hi], color: col }]);
      }
      let alongFirst = len(P[0], P[1]) >= len(P[1], P[2]);
      if (b.rdir === 'short') alongFirst = !alongFirst;
      if (alongFirst) {                               // 용마루 ∥ P0→P1, 앞변에서 rF 지점
        const m0 = at(P[0], P[3], rF), m1 = at(P[1], P[2], rF);
        return withShear([
          { poly: [P[0], P[1], m1, m0], z0: lo, z1: hi, zt: [lo, lo, hi, hi], color: col },
          { poly: [m0, m1, P[2], P[3]], z0: lo, z1: hi, zt: [hi, hi, lo, lo], color: col },
        ]);
      }
      const m0 = at(P[0], P[1], rF), m1 = at(P[3], P[2], rF);
      return withShear([
        { poly: [P[0], m0, m1, P[3]], z0: lo, z1: hi, zt: [lo, hi, hi, lo], color: col },
        { poly: [m0, P[1], P[2], m1], z0: lo, z1: hi, zt: [hi, lo, lo, hi], color: col },
      ]);
    }
  }
  if (b.rtype === 'flat')
    return withShear([{ poly: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], z0: b.eave, z1: b.eave + b.rise, color: col }]);
  if (b.rtype === 'shed') {
    const P = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    const hi = b.eave + b.rise, lo = b.eave;
    const ztOf = { n: [lo, lo, hi, hi], s: [hi, hi, lo, lo], e: [lo, hi, hi, lo], w: [hi, lo, lo, hi] }[b.dir] || [lo, lo, hi, hi];
    return withShear([{ poly: P, z0: b.eave, z1: hi, zt: ztOf, color: col }]);
  }
  // 박공: 용마루 = 긴 변 방향(또는 지정) 중앙선, 두 개의 경사 솔리드
  const alongX = b.dir === 'x' || (b.dir !== 'y' && (x1 - x0) >= (y1 - y0));
  const hi = b.eave + b.rise, lo = b.eave;
  if (alongX) {
    const ym = (y0 + y1) / 2;
    return withShear([
      { poly: [[x0, y0], [x1, y0], [x1, ym], [x0, ym]], z0: lo, z1: hi, zt: [lo, lo, hi, hi], color: col },
      { poly: [[x0, ym], [x1, ym], [x1, y1], [x0, y1]], z0: lo, z1: hi, zt: [hi, hi, lo, lo], color: col },
    ]);
  }
  const xm = (x0 + x1) / 2;
  return withShear([
    { poly: [[x0, y0], [xm, y0], [xm, y1], [x0, y1]], z0: lo, z1: hi, zt: [lo, hi, hi, lo], color: col },
    { poly: [[xm, y0], [x1, y0], [x1, y1], [xm, y1]], z0: lo, z1: hi, zt: [hi, lo, lo, hi], color: col },
  ]);
}
// 경사 상단 평면 z(x,y) — zt 솔리드용 (첫 세 꼭짓점으로 평면 결정)
function solidTopZ(s, x, y) {
  if (!s.zt) return s.z1;
  const [p0, p1, p2] = [s.poly[0], s.poly[1], s.poly[2]];
  const [z0v, z1v, z2v] = [s.zt[0], s.zt[1], s.zt[2]];
  const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = z1v - z0v;
  const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = z2v - z0v;
  // 법선 n = a × b, 평면: n·(P - p0) = 0
  const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  if (Math.abs(nz) < 1e-12) return s.zt[0];
  return z0v - (nx * (x - p0[0]) + ny * (y - p0[1])) / nz;
}

// ====== SUM — 선택 도형의 길이·면적 합계 ======
function cmdSum() {
  const sel = selectedEntities();
  if (!sel.length) { logLine('  합계: 먼저 도형을 선택하세요.', 'warn'); return; }
  let len = 0, area = 0, nL = 0, nA = 0;
  for (const e of sel) {
    const l = entityLength(e); if (l > 0) { len += l; nL++; }
    const a = entityArea2(e); if (a > 0) { area += a; nA++; }
  }
  const u = settings.units;
  logLine(`  Σ 합계 (${sel.length}개 선택): 길이 ${fmtNum(len)}${u} (${nL}개)` + (nA ? ` · 면적 ${fmtNum(area)}${u}² (${nA}개)` : ''), 'ok');
}

// ====== ISOLATE / UNISO — 선택 도형의 레이어만 표시 ======
function cmdIsolate() {
  const sel = selectedEntities();
  if (!sel.length) { logLine('  격리: 먼저 도형을 선택하세요.', 'warn'); return; }
  const keep = new Set(sel.map(e => e.layer || '0'));
  let hidden = 0;
  for (const l of state.layers) { const v = keep.has(l.name); if (l.visible && !v) hidden++; l.visible = v; }
  renderLayers(); propRefresh();   // 3D 도 같이 (숨긴 레이어의 솔리드 제거)
  logLine(`  ✔ 레이어 격리: ${[...keep].join(', ')}만 표시 (${hidden}개 레이어 숨김) — uniso로 해제`, 'ok');
}
function cmdUniso() {
  for (const l of state.layers) l.visible = true;
  renderLayers(); propRefresh();
  logLine('  ✔ 격리 해제: 모든 레이어 표시', 'ok');
}

// ====== XLINE — 구성선(아주 긴 보조선) ======
function clickXline(w) {
  if (!cmdOp || cmdOp.name !== 'xline') cmdOp = { name: 'xline', step: 'p1' };
  if (cmdOp.step === 'p1') { cmdOp.p1 = w; cmdOp.step = 'p2'; setPrompt('구성선: 방향 점을 클릭하세요. (수평/수직은 직교 F8 활용)'); return; }
  const p1 = cmdOp.p1, dx = w.x - p1.x, dy = w.y - p1.y, L = Math.hypot(dx, dy);
  if (L < 1e-9) return;
  const ux = dx / L, uy = dy / L, EXT = 100000; // 사실상 무한
  pushUndo();
  ensureLayer('보조선', '#5d9dff');
  addEntity({ type: 'LINE', layer: '보조선', x1: p1.x - ux * EXT, y1: p1.y - uy * EXT, x2: p1.x + ux * EXT, y2: p1.y + uy * EXT });
  logLine('  ✔ 구성선 (보조선 레이어 — 자르기 기준·스냅 대상)', 'ok');
  cmdOp = { name: 'xline', step: 'p1' }; previewEnts = null; updateStat(); renderLayers();
  setPrompt('구성선: 지나는 점을 클릭하세요. (연속, Esc 종료)');
}

// ====== BREAKPT — 한 점에서 끊기 ======
function clickBreakpt(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'breakpt') cmdOp = { name: 'breakpt', step: 'obj' };
  if (cmdOp.step === 'obj') {
    const hit = pick(w, rawW);
    if (!hit || !['LINE', 'CIRCLE', 'ARC'].includes(hit.type)) { logLine('  한 점 끊기: 선/원/호만 지원합니다.', 'warn'); return; }
    cmdOp.target = hit; cmdOp.step = 'p';
    state.selection.clear(); state.selection.add(hit.id); renderProps();
    setPrompt('한 점 끊기: 끊을 지점을 클릭하세요.'); return;
  }
  pushUndo();
  if (doBreak(cmdOp.target, w, w)) logLine('  ✔ 한 점에서 끊음 (두 도형으로 분리)', 'ok');
  cmdOp = { name: 'breakpt', step: 'obj' }; state.selection.clear(); renderProps(); updateStat();
  setPrompt('한 점 끊기: 대상을 클릭하세요. (연속, Esc 종료)');
}

// ====== ALIGN — 두 점 쌍으로 이동+회전(+배율) ======
function clickAlign(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'align') {
    if (!state.selection.size) {
      // 이 클릭은 도형 선택용으로 소비
      const hit = pick(w, rawW);
      if (hit) { state.selection.add(hit.id); renderProps(); cmdOp = { name: 'align', step: 's1' }; setPrompt('정렬: 원본 1번째 점을 클릭하세요.'); }
      else setPrompt('정렬: 먼저 도형을 선택하세요.');
      return;
    }
    // 이미 선택돼 있으면 이 클릭이 곧 원본 1번째 점
    cmdOp = { name: 'align', step: 's1' };
  }
  if (cmdOp.step === 's1') { cmdOp.s1 = w; cmdOp.step = 'd1'; setPrompt('정렬: 목표 1번째 점을 클릭하세요.'); return; }
  if (cmdOp.step === 'd1') { cmdOp.d1 = w; cmdOp.step = 's2'; setPrompt('정렬: 원본 2번째 점을 클릭하세요.'); return; }
  if (cmdOp.step === 's2') { cmdOp.s2 = w; cmdOp.step = 'd2'; setPrompt('정렬: 목표 2번째 점을 클릭하세요.'); return; }
  const s1 = cmdOp.s1, d1 = cmdOp.d1, s2 = cmdOp.s2, d2 = w;
  const v1x = s2.x - s1.x, v1y = s2.y - s1.y, v2x = d2.x - d1.x, v2y = d2.y - d1.y;
  const L1 = Math.hypot(v1x, v1y), L2 = Math.hypot(v2x, v2y);
  if (L1 < 1e-9 || L2 < 1e-9) { logLine('  정렬: 두 점이 같습니다.', 'warn'); cmdOp = null; setTool('select'); return; }
  const ang = (Math.atan2(v2y, v2x) - Math.atan2(v1y, v1x)) * 180 / Math.PI;
  const doScale = Math.abs(L2 / L1 - 1) > 1e-6 && confirm(`목표 간격에 맞춰 배율도 적용할까요? (×${(L2 / L1).toFixed(3)})`);
  pushUndo();
  const ents = selectedEntities();
  for (const e of ents) {
    translateEntity(e, d1.x - s1.x, d1.y - s1.y);
    applyTransform(e, T_rotate(d1.x, d1.y, ang));
  }
  if (doScale) scaleEntities(ents, d1, L2 / L1);
  logLine(`  ✔ 정렬 ${ents.length}개 (회전 ${ang.toFixed(2)}°${doScale ? `, 배율 ×${(L2 / L1).toFixed(3)}` : ''})`, 'ok');
  cmdOp = null; previewEnts = null; state.selection.clear(); renderProps(); updateStat();
  setTool('select');
}

// ====== FRAME — 도곽 + 표제란 ======
const FRAME_PAPERS = { a4: [297, 210], a3: [420, 297], a2: [594, 420], a1: [841, 594], letter: [279, 216] };
function clickFrame(w) {
  const paper = (prompt('용지 (a4 / a3 / a2 / a1 / letter):', 'a3') || '').trim().toLowerCase();
  if (!FRAME_PAPERS[paper]) { if (paper) logLine('  도곽: 알 수 없는 용지입니다.', 'warn'); setTool('select'); return; }
  const sc = parseFloat(prompt('축척 1:N (도면 단위 = mm):', '100'));
  if (!(sc > 0)) { setTool('select'); return; }
  pushUndo();
  ensureLayer('도곽', '#c0c0c0');
  const pp = FRAME_PAPERS[paper];
  const W = pp[0] * sc, H = pp[1] * sc, M = 10 * sc; // 여백 10mm
  const x0 = w.x, y0 = w.y;
  const rect = (x, y, ww, hh) => addEntity({ type: 'LWPOLYLINE', layer: '도곽', closed: true, points: [[x, y], [x + ww, y], [x + ww, y + hh], [x, y + hh]] });
  rect(x0, y0, W, H);
  rect(x0 + M, y0 + M, W - 2 * M, H - 2 * M);
  const tbW = 90 * sc, tbH = 24 * sc, rH = tbH / 3;
  const tx = x0 + W - M - tbW, ty = y0 + M;
  rect(tx, ty, tbW, tbH);
  const ln = (x1, y1, x2, y2) => addEntity({ type: 'LINE', layer: '도곽', x1, y1, x2, y2 });
  ln(tx, ty + rH, tx + tbW, ty + rH); ln(tx, ty + rH * 2, tx + tbW, ty + rH * 2);
  ln(tx + 28 * sc, ty, tx + 28 * sc, ty + tbH);
  const th = 3.2 * sc, tpad = 2.2 * sc;
  const txt = (x, y, t) => addEntity({ type: 'TEXT', layer: '도곽', x, y, height: th, text: t, rotation: 0 });
  const today = new Date();
  const dstr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  txt(tx + tpad, ty + rH * 2 + (rH - th) / 2, '제목'); txt(tx + 28 * sc + tpad, ty + rH * 2 + (rH - th) / 2, '도면명 입력');
  txt(tx + tpad, ty + rH + (rH - th) / 2, '축척');     txt(tx + 28 * sc + tpad, ty + rH + (rH - th) / 2, '1 : ' + sc);
  txt(tx + tpad, ty + (rH - th) / 2, '날짜');          txt(tx + 28 * sc + tpad, ty + (rH - th) / 2, dstr);
  logLine(`  ✔ 도곽 ${paper.toUpperCase()} (1:${sc}) — '도면명 입력' 문자를 더블클릭해 수정하세요.`, 'ok');
  updateStat(); renderLayers(); zoomFit();
  setTool('select');
}

// ====== CENTERLINE (중심선) — 원/호 클릭 → 십자 중심선 ======
function clickCenterline(w, rawW) {
  const hit = pick(w, rawW);
  if (!hit || (hit.type !== 'CIRCLE' && hit.type !== 'ARC')) { logLine('  중심선: 원 또는 호를 클릭하세요.', 'warn'); return; }
  pushUndo();
  const lay = ensureLayer('중심선', '#ffd65d');
  if (!lay.linetype) lay.linetype = 'center'; // 일점쇄선
  const L = hit.r * 1.15 + dimTH() * 0.5; // 원 밖으로 살짝 연장
  addEntity({ type: 'LINE', layer: '중심선', x1: hit.cx - L, y1: hit.cy, x2: hit.cx + L, y2: hit.cy });
  addEntity({ type: 'LINE', layer: '중심선', x1: hit.cx, y1: hit.cy - L, x2: hit.cx, y2: hit.cy + L });
  logLine('  ✔ 중심선', 'ok'); renderLayers(); updateStat();
}

// ====== REVCLOUD (구름마크) — 두 코너 → 사각 둘레를 바깥으로 볼록한 호들로 ======
function clickRevcloud(w) {
  if (!cmdOp || cmdOp.name !== 'revcloud') cmdOp = { name: 'revcloud', step: 'p1' };
  if (cmdOp.step === 'p1') { cmdOp.p1 = w; cmdOp.step = 'p2'; setPrompt('구름마크: 반대 코너를 클릭하세요.'); return; }
  const ents = computeRevcloud(cmdOp.p1, w);
  if (!ents.length) { logLine('  영역이 너무 작습니다.', 'warn'); return; }
  pushUndo();
  for (const e of ents) addEntity(e);
  logLine(`  ✔ 구름마크 (호 ${ents.length}개)`, 'ok');
  cmdOp = { name: 'revcloud', step: 'p1' }; previewEnts = null; updateStat();
  setPrompt('구름마크: 첫 코너를 클릭하세요. (연속, Esc 종료)');
}
function computeRevcloud(p1, p2) {
  const xmin = Math.min(p1.x, p2.x), xmax = Math.max(p1.x, p2.x);
  const ymin = Math.min(p1.y, p2.y), ymax = Math.max(p1.y, p2.y);
  const wR = xmax - xmin, hR = ymax - ymin;
  if (wR < 1e-6 || hR < 1e-6) return [];
  const seg = Math.max(Math.min(wR, hR) / 2.5, Math.max(wR, hR) / 12); // 호 하나의 현 길이
  const ents = [];
  // 시계방향 순회(위→오른쪽→아래→왼쪽). 호는 끝→시작 각도로 만들어 바깥으로 볼록하게.
  const corners = [[xmin, ymax], [xmax, ymax], [xmax, ymin], [xmin, ymin], [xmin, ymax]];
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = corners[i], [bx, by] = corners[i + 1];
    const elen = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.round(elen / seg)), s = elen / n;
    const ux = (bx - ax) / elen, uy = (by - ay) / elen;
    for (let k = 0; k < n; k++) {
      const sx = ax + ux * s * k, sy = ay + uy * s * k;
      const ex2 = ax + ux * s * (k + 1), ey2 = ay + uy * s * (k + 1);
      const cx = (sx + ex2) / 2, cy = (sy + ey2) / 2, r = s / 2;
      const aS = Math.atan2(sy - cy, sx - cx) * 180 / Math.PI;
      const aE = Math.atan2(ey2 - cy, ex2 - cx) * 180 / Math.PI;
      // CCW(start→end) 호는 진행방향 오른쪽으로 볼록 → 끝→시작 순서로 바깥(왼쪽) 볼록
      ents.push({ type: 'ARC', layer: state.currentLayer, cx, cy, r, startAngle: norm360(aE), endAngle: norm360(aS) });
    }
  }
  return ents;
}

// ====== LEADER (지시선) — 화살표 → 문자 위치 → 문구 ======
function clickLeader(w) {
  if (!cmdOp || cmdOp.name !== 'leader') cmdOp = { name: 'leader', step: 'p1' };
  if (cmdOp.step === 'p1') { cmdOp.p1 = w; cmdOp.step = 'p2'; setPrompt('지시선: 문자 위치를 클릭하세요.'); return; }
  const p1 = cmdOp.p1, p2 = w;
  const txt = prompt('지시 문구:', '');
  if (txt === null) { cmdOp = { name: 'leader', step: 'p1' }; setPrompt('지시선: 화살표 지점을 클릭하세요.'); return; }
  pushUndo();
  ensureLayer('치수', '#5dff8f');
  const th = dimTH(), dx = p2.x - p1.x, dy = p2.y - p1.y;
  const dir = dx >= 0 ? 1 : -1, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
  const ln = (x1, y1, x2, y2) => addEntity({ type: 'LINE', layer: '치수', x1, y1, x2, y2 });
  ln(p1.x, p1.y, p2.x, p2.y);                       // 지시선
  const tail = th * 1.2;
  ln(p2.x, p2.y, p2.x + dir * tail, p2.y);           // 수평 꼬리
  const s = th * 0.5, nx = -uy, ny = ux;             // 화살표(V)
  ln(p1.x, p1.y, p1.x + ux * s + nx * s * 0.35, p1.y + uy * s + ny * s * 0.35);
  ln(p1.x, p1.y, p1.x + ux * s - nx * s * 0.35, p1.y + uy * s - ny * s * 0.35);
  if (txt.trim()) addEntity({ type: 'TEXT', layer: '치수',
    x: p2.x + dir * (tail + th * 0.25) - (dir < 0 ? txt.length * th * 0.6 : 0),
    y: p2.y - th * 0.35, height: th, text: txt, rotation: 0 });
  logLine('  ✔ 지시선', 'ok');
  cmdOp = { name: 'leader', step: 'p1' }; previewEnts = null;
  updateStat(); setPrompt('지시선: 화살표 지점을 클릭하세요. (연속, Esc 종료)');
}

// ====== DIMANGULAR (각도 치수) — 두 선 사이 각도 호 + 도수 ======
function clickDimAng(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'dimang') cmdOp = { name: 'dimang', step: 'l1' };
  if (cmdOp.step === 'l1' || cmdOp.step === 'l2') {
    const hit = pick(w, rawW);
    if (!hit || hit.type !== 'LINE') { logLine('  각도 치수: 두 개의 선을 클릭하세요.', 'warn'); return; }
    if (cmdOp.step === 'l1') { cmdOp.l1 = hit; cmdOp.step = 'l2'; state.selection.clear(); state.selection.add(hit.id); renderProps(); setPrompt('각도 치수: 두 번째 선을 클릭하세요.'); }
    else if (hit !== cmdOp.l1) { cmdOp.l2 = hit; cmdOp.step = 'pos'; state.selection.add(hit.id); renderProps(); setPrompt('각도 치수: 호 위치를 클릭하세요.'); }
    return;
  }
  const ents = computeAngularDim(cmdOp.l1, cmdOp.l2, w);
  if (!ents) { logLine('  두 선이 평행합니다.', 'warn'); return; }
  pushUndo();
  for (const e of ents.list) addEntity(e);
  logLine(`  ✔ 각도 치수 ${ents.deg}°`, 'ok');
  cmdOp = { name: 'dimang', step: 'l1' }; previewEnts = null;
  state.selection.clear(); renderProps(); updateStat();
  setPrompt('각도 치수: 첫 번째 선을 클릭하세요. (연속, Esc 종료)');
}
function computeAngularDim(l1, l2, pos) {
  const C = lineInfIntersect([l1.x1, l1.y1], [l1.x2, l1.y2], [l2.x1, l2.y1], [l2.x2, l2.y2]);
  if (!C) return null;
  const unit = (l) => { const dx = l.x2 - l.x1, dy = l.y2 - l.y1, L = Math.hypot(dx, dy) || 1; return [dx / L, dy / L]; };
  let d1 = unit(l1), d2 = unit(l2);
  const v = [pos.x - C[0], pos.y - C[1]];
  if (d1[0] * v[0] + d1[1] * v[1] < 0) d1 = [-d1[0], -d1[1]]; // pos 쪽 사분면의 방향 선택
  if (d2[0] * v[0] + d2[1] * v[1] < 0) d2 = [-d2[0], -d2[1]];
  const r = Math.hypot(v[0], v[1]) || 1;
  let a1 = Math.atan2(d1[1], d1[0]) * 180 / Math.PI, a2 = Math.atan2(d2[1], d2[0]) * 180 / Math.PI;
  if (norm360(a2 - a1) > 180) { const t = a1; a1 = a2; a2 = t; } // CCW 짧은 쪽
  const sweep = norm360(a2 - a1);
  ensureLayer('치수', '#5dff8f');
  const list = [{ type: 'ARC', layer: '치수', cx: C[0], cy: C[1], r, startAngle: norm360(a1), endAngle: norm360(a2) }];
  const th = dimTH(), s = Math.min(th * 0.6, r * sweep * Math.PI / 180 / 4);
  const arrow = (deg, dir) => { // 호 끝 화살표(접선 방향)
    const a = deg * Math.PI / 180, px = C[0] + r * Math.cos(a), py = C[1] + r * Math.sin(a);
    const tx = -Math.sin(a) * dir, ty = Math.cos(a) * dir, nx2 = Math.cos(a), ny2 = Math.sin(a);
    list.push({ type: 'LINE', layer: '치수', x1: px, y1: py, x2: px + tx * s + nx2 * s * 0.35, y2: py + ty * s + ny2 * s * 0.35 });
    list.push({ type: 'LINE', layer: '치수', x1: px, y1: py, x2: px + tx * s - nx2 * s * 0.35, y2: py + ty * s - ny2 * s * 0.35 });
  };
  arrow(a1, 1); arrow(a2, -1);
  const mid = (a1 + sweep / 2) * Math.PI / 180;
  const deg = +sweep.toFixed(1);
  const txt = deg + '°';
  list.push({ type: 'TEXT', layer: '치수', x: C[0] + (r + th * 0.5) * Math.cos(mid) - txt.length * th * 0.3, y: C[1] + (r + th * 0.5) * Math.sin(mid), height: th, text: txt, rotation: 0 });
  return { list, deg };
}

// ====== DIVIDE / MEASURE (등분·일정간격 표식) ======
let divideCount = 4, measureStep = 10;
function pointsAlongEntity(e, opt) {
  const pts = [];
  const emitFracs = (fr) => fr.map(t => pointAtParam(e, t)).filter(Boolean);
  function pointAtParam(e, t) { // t: 0..1 (둘레 기준)
    if (e.type === 'LINE') return [e.x1 + (e.x2 - e.x1) * t, e.y1 + (e.y2 - e.y1) * t];
    if (e.type === 'CIRCLE') { const a = t * 2 * Math.PI; return [e.cx + e.r * Math.cos(a), e.cy + e.r * Math.sin(a)]; }
    if (e.type === 'ARC') { let s = e.startAngle, en = e.endAngle; if (en < s) en += 360; const a = (s + (en - s) * t) * Math.PI / 180; return [e.cx + e.r * Math.cos(a), e.cy + e.r * Math.sin(a)]; }
    if (e.type === 'LWPOLYLINE') {
      const p = e.points, n = p.length, segN = e.closed ? n : n - 1;
      let total = 0; const lens = [];
      for (let i = 0; i < segN; i++) { const L = Math.hypot(p[(i + 1) % n][0] - p[i][0], p[(i + 1) % n][1] - p[i][1]); lens.push(L); total += L; }
      let d = t * total;
      for (let i = 0; i < segN; i++) { if (d <= lens[i] || i === segN - 1) { const u = lens[i] ? d / lens[i] : 0; return [p[i][0] + (p[(i + 1) % n][0] - p[i][0]) * u, p[i][1] + (p[(i + 1) % n][1] - p[i][1]) * u]; } d -= lens[i]; }
    }
    return null;
  }
  function totalLen(e) {
    if (e.type === 'LINE') return Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
    if (e.type === 'CIRCLE') return 2 * Math.PI * e.r;
    if (e.type === 'ARC') { let s = e.startAngle, en = e.endAngle; if (en < s) en += 360; return (en - s) * Math.PI / 180 * e.r; }
    if (e.type === 'LWPOLYLINE') { const p = e.points, n = p.length, segN = e.closed ? n : n - 1; let L = 0; for (let i = 0; i < segN; i++) L += Math.hypot(p[(i + 1) % n][0] - p[i][0], p[(i + 1) % n][1] - p[i][1]); return L; }
    return 0;
  }
  if (opt.count) { // 등분: 내부 점(닫힌/원은 n개)
    const n = Math.max(2, opt.count);
    const closedLike = e.type === 'CIRCLE' || (e.type === 'LWPOLYLINE' && e.closed);
    const fr = [];
    if (closedLike) for (let i = 0; i < n; i++) fr.push(i / n);
    else for (let i = 1; i < n; i++) fr.push(i / n);
    return emitFracs(fr);
  }
  const L = totalLen(e); if (!L || !opt.step || opt.step <= 0) return [];
  const fr = []; for (let d = opt.step; d < L - 1e-9; d += opt.step) fr.push(d / L);
  return emitFracs(fr);
}
function placeMarks(e, opt, label) {
  const pts = pointsAlongEntity(e, opt);
  if (!pts.length) { logLine('  표식을 만들 수 없습니다(간격이 너무 크거나 지원 안 함).', 'warn'); return; }
  pushUndo();
  const s = state.textHeight * 0.35;
  for (const p of pts) { // ✕ 표식(작은 선 2개)
    addEntity({ type: 'LINE', layer: state.currentLayer, x1: p[0] - s, y1: p[1] - s, x2: p[0] + s, y2: p[1] + s });
    addEntity({ type: 'LINE', layer: state.currentLayer, x1: p[0] - s, y1: p[1] + s, x2: p[0] + s, y2: p[1] - s });
  }
  logLine(`  ✔ ${label}: 표식 ${pts.length}개`, 'ok');
  updateStat(); draw();
}
function clickDivide(w, rawW) {
  const hit = pick(w, rawW);
  if (!hit || !['LINE', 'LWPOLYLINE', 'CIRCLE', 'ARC'].includes(hit.type)) { logLine('  등분: 선/폴리라인/원/호를 클릭하세요.', 'warn'); return; }
  placeMarks(hit, { count: divideCount }, `${divideCount}등분`);
}
function clickMeasure(w, rawW) {
  const hit = pick(w, rawW);
  if (!hit || !['LINE', 'LWPOLYLINE', 'CIRCLE', 'ARC'].includes(hit.type)) { logLine('  간격 표식: 선/폴리라인/원/호를 클릭하세요.', 'warn'); return; }
  placeMarks(hit, { step: measureStep }, `간격 ${measureStep}`);
}

// ====== DIST (거리 측정) ======
function clickDist(w) {
  if (!cmdOp || cmdOp.name !== 'dist') cmdOp = { name: 'dist', step: 'p1' };
  if (cmdOp.step === 'p1') { cmdOp.p1 = w; cmdOp.step = 'p2'; setPrompt('거리: 두 번째 점을 클릭하세요.'); return; }
  const dx = w.x - cmdOp.p1.x, dy = w.y - cmdOp.p1.y;
  logLine(`  거리 = ${fmtNum(Math.hypot(dx, dy))} ${settings.units}   ΔX = ${fmtNum(dx)}   ΔY = ${fmtNum(dy)}   각도 = ${fmtNum(ang(cmdOp.p1.x, cmdOp.p1.y, w.x, w.y))}°`, 'ok');
  cmdOp = { name: 'dist', step: 'p1' }; previewEnts = null;
  setPrompt('거리: 첫 점을 클릭하세요. (연속 측정, Esc 종료)');
}

// ====== AREA (면적) ======
function clickArea(w, rawW) {
  if (!pts.length) { // 첫 클릭이 닫힌 도형이면 그 면적
    const hit = pick(w, rawW);
    if (hit && hit.type === 'CIRCLE') {
      logLine(`  원 면적 = ${fmtNum(Math.PI * hit.r * hit.r)} ${settings.units}²   둘레 = ${fmtNum(2 * Math.PI * hit.r)} ${settings.units}`, 'ok'); return;
    }
    if (hit && hit.type === 'LWPOLYLINE' && hit.closed) {
      logLine(`  면적 = ${fmtNum(polyArea(hit.points))} ${settings.units}²   둘레 = ${fmtNum(polyPerimeter(hit.points, true))} ${settings.units}`, 'ok'); return;
    }
  }
  pts.push({ x: w.x, y: w.y });
  setPrompt(`면적: 점 ${pts.length}개 지정됨. 계속 클릭하거나 Enter로 계산하세요.`);
}
function finishArea() {
  if (pts.length >= 3) {
    const arr = pts.map(p => [p.x, p.y]);
    logLine(`  면적 = ${fmtNum(polyArea(arr))} ${settings.units}²   둘레 = ${fmtNum(polyPerimeter(arr, true))} ${settings.units}`, 'ok');
  } else logLine('  면적: 점이 3개 이상 필요합니다.', 'warn');
  pts = []; setPrompt('면적: 원/닫힌 폴리라인을 클릭하거나 점들을 찍고 Enter.'); draw();
}

// ====== EXPLODE (분해) / JOIN (결합) — 즉시 실행 명령 ======
function cmdExplode() {
  const sel = selectedEntities().filter(e => e.type === 'LWPOLYLINE' || e.type === 'INSERT');
  if (!sel.length) { logLine('  분해: 폴리라인 또는 블록을 먼저 선택하세요.', 'warn'); return; }
  pushUndo(); let made = 0;
  for (const e of sel) {
    if (e.type === 'INSERT') {
      for (const c of insertChildren(e)) { addEntity(c); made++; }
    } else {
      const p = e.points, n = p.length, segN = e.closed ? n : n - 1;
      for (let i = 0; i < segN; i++) {
        const a = p[i], b = p[(i + 1) % n];
        const ne = { type: 'LINE', layer: e.layer, x1: a[0], y1: a[1], x2: b[0], y2: b[1] };
        if (e.color) ne.color = e.color;
        addEntity(ne); made++;
      }
    }
    state.entities = state.entities.filter(x => x !== e); state.selection.delete(e.id);
  }
  logLine(`  ✔ 분해: ${sel.length}개 → 도형 ${made}개`, 'ok');
  updateStat(); renderProps(); draw();
}
function cmdJoin() {
  const sel = selectedEntities().filter(e => e.type === 'LINE' || (e.type === 'LWPOLYLINE' && !e.closed));
  if (sel.length < 2) { logLine('  결합: 선/열린 폴리라인을 2개 이상 선택하세요.', 'warn'); return; }
  const TOL = 1e-4;
  const eq = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= TOL;
  const pieces = sel.map(e => e.type === 'LINE' ? [[e.x1, e.y1], [e.x2, e.y2]] : e.points.map(p => [p[0], p[1]]));
  const used = new Array(pieces.length).fill(false);
  const chains = [];
  for (let i = 0; i < pieces.length; i++) {
    if (used[i]) continue; used[i] = true;
    let chain = pieces[i].slice(); let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < pieces.length; j++) {
        if (used[j]) continue; const pj = pieces[j];
        const h = chain[0], t = chain[chain.length - 1];
        if (eq(t, pj[0])) { chain = chain.concat(pj.slice(1)); used[j] = true; grew = true; }
        else if (eq(t, pj[pj.length - 1])) { chain = chain.concat(pj.slice(0, -1).reverse()); used[j] = true; grew = true; }
        else if (eq(h, pj[pj.length - 1])) { chain = pj.slice(0, -1).concat(chain); used[j] = true; grew = true; }
        else if (eq(h, pj[0])) { chain = pj.slice(1).reverse().concat(chain); used[j] = true; grew = true; }
      }
    }
    chains.push(chain);
  }
  if (chains.length === sel.length) { logLine('  결합: 끝점이 만나는 도형이 없습니다.', 'warn'); return; }
  pushUndo();
  const layer = sel[0].layer;
  for (const e of sel) { state.entities = state.entities.filter(x => x !== e); state.selection.delete(e.id); }
  let closedN = 0;
  for (const ch of chains) {
    let closed = false, arr = ch;
    if (ch.length > 2 && eq(ch[0], ch[ch.length - 1])) { closed = true; arr = ch.slice(0, -1); closedN++; }
    const ne = addEntity({ type: 'LWPOLYLINE', layer, closed, points: arr });
    state.selection.add(ne.id);
  }
  logLine(`  ✔ 결합: ${sel.length}개 → 폴리라인 ${chains.length}개${closedN ? ` (닫힘 ${closedN})` : ''}`, 'ok');
  updateStat(); renderProps(); draw();
}
// ====== BREAK (끊기) — 선/원/호의 두 점 사이 제거 ======
function clickBreak(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'break') cmdOp = { name: 'break', step: 'obj' };
  if (cmdOp.step === 'obj') {
    const hit = pick(w, rawW);
    if (!hit || !['LINE', 'CIRCLE', 'ARC'].includes(hit.type)) { logLine('  끊기는 선/원/호만 지원합니다.', 'warn'); return; }
    cmdOp.target = hit; cmdOp.step = 'p1';
    state.selection.clear(); state.selection.add(hit.id); renderProps();
    setPrompt('끊기: 첫 번째 끊기점을 클릭하세요.'); return;
  }
  if (cmdOp.step === 'p1') { cmdOp.p1 = w; cmdOp.step = 'p2'; setPrompt('끊기: 두 번째 끊기점을 클릭하세요.'); return; }
  pushUndo();
  if (doBreak(cmdOp.target, cmdOp.p1, w)) logLine('  ✔ 끊기', 'ok');
  cmdOp = null; state.selection.clear(); renderProps(); updateStat();
  setTool('select');
}
function doBreak(e, P1, P2) {
  if (e.type === 'LINE') {
    const x1 = e.x1, y1 = e.y1, dx = e.x2 - x1, dy = e.y2 - y1, L2 = dx * dx + dy * dy || 1;
    let t1 = ((P1.x - x1) * dx + (P1.y - y1) * dy) / L2;
    let t2 = ((P2.x - x1) * dx + (P2.y - y1) * dy) / L2;
    t1 = Math.max(0, Math.min(1, t1)); t2 = Math.max(0, Math.min(1, t2));
    if (t2 < t1) { const t = t1; t1 = t2; t2 = t; }
    const segs = [];
    if (t1 > 1e-6) segs.push([0, t1]);
    if (t2 < 1 - 1e-6) segs.push([t2, 1]);
    if (!segs.length) { state.entities = state.entities.filter(x => x !== e); return true; } // 전체 제거
    const P = t => ({ x: x1 + t * dx, y: y1 + t * dy });
    const a = P(segs[0][0]), b = P(segs[0][1]);
    e.x1 = a.x; e.y1 = a.y; e.x2 = b.x; e.y2 = b.y;
    if (segs.length === 2) {
      const c = P(segs[1][0]), d = P(segs[1][1]);
      const ne = { type: 'LINE', layer: e.layer, x1: c.x, y1: c.y, x2: d.x, y2: d.y };
      if (e.color) ne.color = e.color;
      addEntity(ne);
    }
    return true;
  }
  if (e.type === 'CIRCLE') { // 첫→둘 반시계 구간 제거 → 나머지 호
    const a1 = ang(e.cx, e.cy, P1.x, P1.y), a2 = ang(e.cx, e.cy, P2.x, P2.y);
    if (Math.abs(norm360(a2 - a1)) < 1e-6) { logLine('  두 점이 같습니다.', 'warn'); return false; }
    e.type = 'ARC'; e.startAngle = a2; e.endAngle = a1;
    return true;
  }
  if (e.type === 'ARC') {
    let s = e.startAngle, en = e.endAngle; if (en < s) en += 360;
    const span = en - s;
    const rel = a => Math.max(0, Math.min(span, norm360(a - s)));
    let r1 = rel(ang(e.cx, e.cy, P1.x, P1.y)), r2 = rel(ang(e.cx, e.cy, P2.x, P2.y));
    if (r2 < r1) { const t = r1; r1 = r2; r2 = t; }
    const segs = [];
    if (r1 > 0.01) segs.push([0, r1]);
    if (r2 < span - 0.01) segs.push([r2, span]);
    if (!segs.length) { state.entities = state.entities.filter(x => x !== e); return true; }
    e.startAngle = norm360(s + segs[0][0]); e.endAngle = norm360(s + segs[0][1]);
    if (segs.length === 2) {
      const ne = { type: 'ARC', layer: e.layer, cx: e.cx, cy: e.cy, r: e.r, startAngle: norm360(s + segs[1][0]), endAngle: norm360(s + segs[1][1]) };
      if (e.color) ne.color = e.color;
      addEntity(ne);
    }
    return true;
  }
  return false;
}

// ====== LENGTHEN (길이조정) — 클릭한 끝쪽을 ±delta 만큼 ======
// ====== 클립보드 복사/붙여넣기 (Ctrl+C / Ctrl+V, 탭 간 공유) ======
const CLIP_KEY = 'webcad_clipboard_v1';
function copySelection() {
  const sel = selectedEntities();
  if (!sel.length) { logLine('  복사할 도형을 먼저 선택하세요. (Ctrl+C)', 'warn'); return; }
  let mnx = Infinity, mny = Infinity;
  for (const e of sel) { const bb = entityBBox(e); if (bb) { mnx = Math.min(mnx, bb.xmin); mny = Math.min(mny, bb.ymin); } }
  if (!isFinite(mnx)) { mnx = 0; mny = 0; }
  const clip = { base: [mnx, mny], ents: sel.map(e => cloneEntity(e)),
    blocks: {} };
  for (const e of sel) if (e.type === 'INSERT' && state.blocks[e.name]) clip.blocks[e.name] = state.blocks[e.name]; // 블록 정의 동봉
  try { localStorage.setItem(CLIP_KEY, JSON.stringify(clip)); } catch (e) {}
  logLine(`  ✔ 복사됨: ${sel.length}개 (Ctrl+V로 붙여넣기)`, 'ok');
}
function startPaste() {
  let clip = null;
  try { clip = JSON.parse(localStorage.getItem(CLIP_KEY) || 'null'); } catch (e) {}
  if (!clip || !clip.ents || !clip.ents.length) { logLine('  붙여넣을 내용이 없습니다.', 'warn'); return; }
  cmdOp = { name: 'paste', clip };
  state.tool = '_paste';
  document.querySelectorAll('.tool').forEach(el => el.classList.remove('active'));
  setPrompt(`붙여넣기: 위치를 클릭하세요. (${clip.ents.length}개, Esc 취소)`);
  draw();
}
function doPaste(w) {
  const clip = cmdOp.clip;
  pushUndo();
  for (const [nm, def] of Object.entries(clip.blocks || {})) if (!state.blocks[nm]) state.blocks[nm] = def; // 블록 정의 이식
  const dx = w.x - clip.base[0], dy = w.y - clip.base[1];
  state.selection.clear();
  for (const src of clip.ents) {
    const c = cloneEntity(src);
    translateEntity(c, dx, dy);
    const ne = addEntity(c); state.selection.add(ne.id);
  }
  logLine(`  ✔ 붙여넣기: ${clip.ents.length}개`, 'ok');
  updateStat(); renderProps(); refreshBlockList();
  cmdOp = null; previewEnts = null; setTool('select');
}

// ====== MATCHPROP (속성 일치) — 원본 선택 후 대상들에 속성 복사 ======
function clickMatchprop(w, rawW) {
  const hit = pick(w, rawW);
  if (!hit) return;
  if (!cmdOp || cmdOp.name !== 'matchprop') {
    cmdOp = { name: 'matchprop', src: hit };
    state.selection.clear(); state.selection.add(hit.id); renderProps();
    setPrompt('속성일치: 이제 속성을 적용할 대상들을 클릭하세요. (Esc 종료)');
    logLine('  속성 원본 선택됨', 'info'); return;
  }
  const s = cmdOp.src;
  if (hit === s) return;
  pushUndo();
  hit.layer = s.layer;
  if (s.color) hit.color = s.color; else delete hit.color;
  if (s.linetype) hit.linetype = s.linetype; else delete hit.linetype;
  if (s.lineweight != null) hit.lineweight = s.lineweight; else delete hit.lineweight;
  if (hit.type === 'TEXT' && s.type === 'TEXT') hit.height = s.height;                 // 문자: 높이도
  if (hit.type === 'HATCH' && s.type === 'HATCH') { hit.pattern = s.pattern; hit.spacing = s.spacing; hatchDirty(hit); } // 해치: 패턴
  logLine('  ✔ 속성 적용', 'ok');
  draw();
}

function clickLengthen(w, rawW) {
  const hit = pick(w, rawW);
  if (!hit) return;
  if (hit.type !== 'LINE') { logLine('  길이조정은 선(LINE)만 지원합니다.', 'warn'); return; }
  const dx = hit.x2 - hit.x1, dy = hit.y2 - hit.y1, L = Math.hypot(dx, dy) || 1;
  if (L + lengthenDelta <= 1e-6) { logLine('  선 길이보다 크게 줄일 수 없습니다.', 'warn'); return; }
  pushUndo();
  const ux = dx / L, uy = dy / L;
  const d1 = Math.hypot(w.x - hit.x1, w.y - hit.y1), d2 = Math.hypot(w.x - hit.x2, w.y - hit.y2);
  if (d1 < d2) { hit.x1 -= ux * lengthenDelta; hit.y1 -= uy * lengthenDelta; }
  else { hit.x2 += ux * lengthenDelta; hit.y2 += uy * lengthenDelta; }
  logLine(`  ✔ 길이조정 ${lengthenDelta > 0 ? '+' : ''}${lengthenDelta} → 길이 ${fmtNum(L + lengthenDelta)}`, 'ok');
  draw();
}

// ====== HATCH (해치) — 단일 객체, 건축 패턴 8종 ======
const HATCH_PATTERNS = {
  ansi31: { ko: '사선(일반)' }, ansi37: { ko: '격자 사선' }, steel: { ko: '강재(이중 사선)' },
  grid: { ko: '격자(타일)' }, brick: { ko: '벽돌(조적)' }, concrete: { ko: '콘크리트' },
  dots: { ko: '점(모래·미장)' }, solid: { ko: '단색 채움' },
  insul: { ko: '단열재(고리)' }, rubble: { ko: '잡석' }, xbox: { ko: '목구조재(X)' }, // KS 도면 재료표시 (단면 자동해치용)
};
let hatchPattern = 'ansi31';

function boundaryBBox(b) {
  if (b.kind === 'circle') return { xmin: b.cx - b.r, xmax: b.cx + b.r, ymin: b.cy - b.r, ymax: b.cy + b.r };
  const xs = b.points.map(p => p[0]), ys = b.points.map(p => p[1]);
  return { xmin: Math.min(...xs), xmax: Math.max(...xs), ymin: Math.min(...ys), ymax: Math.max(...ys) };
}
function pointInBoundary(b, x, y) {
  if (b.kind === 'circle') return Math.hypot(x - b.cx, y - b.cy) <= b.r;
  let inside = false; const p = b.points, n = p.length;
  for (let i = 0, j = n - 1; i < n; j = i++)
    if ((p[i][1] > y) !== (p[j][1] > y) && x < (p[j][0] - p[i][0]) * (y - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0]) inside = !inside;
  return inside;
}
// 한 방향 평행선 무리를 경계 내부로 잘라 세그먼트 생성
function clipFamily(b, sp, angleDeg, phase) {
  const a = angleDeg * Math.PI / 180, d = [Math.cos(a), Math.sin(a)], nv = [-d[1], d[0]];
  const bb = boundaryBBox(b);
  const corners = [[bb.xmin, bb.ymin], [bb.xmax, bb.ymin], [bb.xmax, bb.ymax], [bb.xmin, bb.ymax]];
  let cmin = Infinity, cmax = -Infinity;
  for (const c of corners) { const v = nv[0] * c[0] + nv[1] * c[1]; if (v < cmin) cmin = v; if (v > cmax) cmax = v; }
  const out = [];
  for (let c = cmin + sp * (phase === undefined ? 0.5 : phase); c < cmax; c += sp) {
    let hits = [];
    if (b.kind === 'circle') {
      const cc = nv[0] * b.cx + nv[1] * b.cy, dist = c - cc;
      if (Math.abs(dist) < b.r) {
        const half = Math.sqrt(b.r * b.r - dist * dist);
        const mx = b.cx + nv[0] * dist, my = b.cy + nv[1] * dist;
        hits = [[mx - d[0] * half, my - d[1] * half], [mx + d[0] * half, my + d[1] * half]];
      }
    } else {
      const p = b.points, n = p.length;
      for (let i = 0; i < n; i++) {
        const A = p[i], B = p[(i + 1) % n];
        const fa = nv[0] * A[0] + nv[1] * A[1] - c, fb = nv[0] * B[0] + nv[1] * B[1] - c;
        if ((fa > 0 && fb <= 0) || (fa <= 0 && fb > 0)) {
          const u = fa / (fa - fb);
          hits.push([A[0] + u * (B[0] - A[0]), A[1] + u * (B[1] - A[1])]);
        }
      }
      hits.sort((x, y) => (d[0] * x[0] + d[1] * x[1]) - (d[0] * y[0] + d[1] * y[1]));
    }
    for (let i = 0; i + 1 < hits.length; i += 2) out.push([hits[i][0], hits[i][1], hits[i + 1][0], hits[i + 1][1]]);
  }
  return out;
}
// 패턴별 세그먼트/점 계산
function computePatternSegs(e) {
  const b = e.boundary, sp = e.spacing || 5, segs = [], dots = [];
  const add = (arr) => { for (const s of arr) segs.push(s); };
  switch (e.pattern) {
    case 'ansi37': add(clipFamily(b, sp, 45)); add(clipFamily(b, sp, 135)); break;
    case 'steel': add(clipFamily(b, sp, 45)); add(clipFamily(b, sp, 45, 0.75)); break;
    case 'grid': add(clipFamily(b, sp, 0)); add(clipFamily(b, sp, 90)); break;
    case 'brick': {
      add(clipFamily(b, sp, 0, 0));
      const bb = boundaryBBox(b); let row = 0;
      for (let y = Math.floor(bb.ymin / sp) * sp; y < bb.ymax; y += sp, row++) {
        const off = (row % 2) * sp;
        for (let x = Math.floor(bb.xmin / (2 * sp)) * 2 * sp + off; x < bb.xmax; x += 2 * sp)
          if (pointInBoundary(b, x, y) && pointInBoundary(b, x, y + sp) && pointInBoundary(b, x, y + sp / 2))
            segs.push([x, y, x, y + sp]);
      }
      break;
    }
    case 'concrete': {
      add(clipFamily(b, sp * 1.7, 45));
      const bb = boundaryBBox(b);
      for (let i = 0; bb.xmin + i * sp < bb.xmax; i++) for (let j = 0; bb.ymin + j * sp < bb.ymax; j++) {
        const h = Math.abs(Math.sin(i * 127.1 + j * 311.7) * 43758.5453) % 1; // 결정적 의사난수
        if (h < 0.45) continue;
        const x = bb.xmin + i * sp + (h * 7.919 % 1) * sp, y = bb.ymin + j * sp + (h * 104.729 % 1) * sp;
        if (pointInBoundary(b, x, y)) dots.push([x, y]);
      }
      break;
    }
    case 'dots': {
      const bb = boundaryBBox(b); let row = 0;
      for (let y = bb.ymin + sp / 2; y < bb.ymax; y += sp, row++)
        for (let x = bb.xmin + sp / 2 + (row % 2) * sp / 2; x < bb.xmax; x += sp)
          if (pointInBoundary(b, x, y)) dots.push([x, y]);
      break;
    }
    case 'insul': { // 단열재 — 고리(원) 사슬. sp = 고리 지름 (보통 벽 두께에 맞춤)
      const bb = boundaryBBox(b), d = Math.max(20, sp);
      for (let x = bb.xmin + d / 2; x < bb.xmax + d / 2 - 1e-6; x += d) {
        const cx = Math.min(x, bb.xmax - d / 2);
        for (let y = bb.ymin; y < bb.ymax; y += d) {
          const cy = y + d / 2; let prev = null;
          for (let k = 0; k <= 12; k++) { // 원 고리 12각 근사
            const a = k / 12 * 2 * Math.PI;
            const px = cx + Math.cos(a) * d * 0.475, py = cy + Math.sin(a) * d * 0.475;
            if (prev && pointInBoundary(b, px, py) && pointInBoundary(b, prev[0], prev[1])) segs.push([prev[0], prev[1], px, py]);
            prev = [px, py];
          }
        }
      }
      break;
    }
    case 'rubble': { // 잡석 — 불규칙 돌덩이 윤곽 (결정적 의사난수)
      const bb = boundaryBBox(b); let i = 0;
      for (let y = bb.ymin; y < bb.ymax; y += sp) for (let x = bb.xmin; x < bb.xmax; x += sp) {
        i++;
        const h = Math.abs(Math.sin(i * 127.1) * 43758.5453) % 1;
        const cx = x + sp / 2 + (h - 0.5) * sp * 0.35, cy = y + sp / 2 + ((h * 7.919 % 1) - 0.5) * sp * 0.35;
        const r = sp * 0.3 * (0.7 + h * 0.5), nv = 5 + Math.floor(h * 3);
        let prev = null;
        for (let k = 0; k <= nv; k++) {
          const a = k / nv * 2 * Math.PI + h * 6;
          const rr = r * (0.72 + ((Math.sin(a * 3 + h * 9) + 1) / 2) * 0.5);
          const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
          if (prev && pointInBoundary(b, px, py) && pointInBoundary(b, prev[0], prev[1])) segs.push([prev[0], prev[1], px, py]);
          prev = [px, py];
        }
      }
      break;
    }
    case 'xbox': { // 목구조재(각재) — 단면 사각에 대각 X (KS 재료표시)
      const bb = boundaryBBox(b);
      segs.push([bb.xmin, bb.ymin, bb.xmax, bb.ymax], [bb.xmin, bb.ymax, bb.xmax, bb.ymin]);
      break;
    }
    case 'solid': break;
    default: add(clipFamily(b, sp, 45)); // ansi31
  }
  return { segs, dots };
}
// 캐시(직렬화 제외) — 변형 시 hatchDirty()로 무효화
function hatchSegments(e) {
  if (!e._hc) Object.defineProperty(e, '_hc', { value: computePatternSegs(e), configurable: true, writable: true, enumerable: false });
  return e._hc;
}
function hatchDirty(e) { if (e._hc) delete e._hc; }

function clickHatch(w, rawW) {
  const hit = pick(w, rawW);
  if (!hit || !(hit.type === 'CIRCLE' || (hit.type === 'LWPOLYLINE' && hit.closed))) {
    logLine('  해치: 원 또는 닫힌 폴리라인(사각형·다각형)을 클릭하세요.', 'warn'); return;
  }
  pushUndo();
  const boundary = hit.type === 'CIRCLE'
    ? { kind: 'circle', cx: hit.cx, cy: hit.cy, r: hit.r }
    : { kind: 'poly', points: hit.points.map(p => [p[0], p[1]]) };
  const ne = addEntity({ type: 'HATCH', layer: state.currentLayer, pattern: hatchPattern, spacing: hatchSpacing, boundary });
  state.selection.clear(); state.selection.add(ne.id);
  logLine(`  ✔ 해치 1개 객체 (${HATCH_PATTERNS[hatchPattern].ko}, 간격 ${hatchSpacing})`, 'ok');
  updateStat(); renderProps(); draw();
}
// 내보내기용: HATCH → 선/점(짧은 선) 분해 목록
// 블록 정의 내부 엔티티에서 HATCH만 선으로 분해(정의는 로컬좌표라 hatchSegments 그대로 사용)
function exportHatchExpand(ents) {
  const out = [];
  for (const e of ents) {
    if (e.type !== 'HATCH') { out.push(e); continue; }
    const hs = e.pattern === 'solid' ? { segs: [], dots: [] } : hatchSegments(e);
    for (const s of hs.segs) out.push({ type: 'LINE', layer: e.layer, color: e.color, x1: s[0], y1: s[1], x2: s[2], y2: s[3] });
    if (e.pattern === 'solid') { const b = e.boundary; out.push(b.kind === 'circle' ? { type: 'CIRCLE', layer: e.layer, cx: b.cx, cy: b.cy, r: b.r } : { type: 'LWPOLYLINE', layer: e.layer, closed: true, points: b.points }); }
  }
  return out;
}
// keepInserts=true: INSERT는 그대로(DXF 블록 저장용). false: 자식으로 전개(SVG/PNG/PDF용)
function exportEntities(keepInserts) {
  const out = [];
  const emit = (e) => {
    // 이미지는 표준 DXF 엔티티로 내보내지 않는다(IMAGE 엔티티는 외부 파일 경로 참조 방식이라
    // 같이 배포할 파일이 없음). 대신 정의 전체를 999 WCX 블록에 담아 Parti에서 복원한다.
    if (e.type === 'IMAGE') return;
    if (e.type === 'INSERT') { if (keepInserts) out.push(e); else for (const c of insertChildren(e)) emit(c); return; }
    if (e.type !== 'HATCH') { out.push(e); return; }
    const hs = e.pattern === 'solid' ? { segs: [], dots: [] } : hatchSegments(e);
    for (const s of hs.segs) out.push({ type: 'LINE', layer: e.layer, color: e.color, x1: s[0], y1: s[1], x2: s[2], y2: s[3] });
    const t = (e.spacing || 5) * 0.06;
    for (const dp of hs.dots) out.push({ type: 'LINE', layer: e.layer, color: e.color, x1: dp[0] - t, y1: dp[1], x2: dp[0] + t, y2: dp[1] });
    if (e.pattern === 'solid') {
      const b = e.boundary;
      out.push(b.kind === 'circle'
        ? { type: 'CIRCLE', layer: e.layer, color: e.color, cx: b.cx, cy: b.cy, r: b.r }
        : { type: 'LWPOLYLINE', layer: e.layer, color: e.color, closed: true, points: b.points });
    }
  };
  for (const e of state.entities) emit(e);
  return out;
}

// BLOCK: 선택 도형으로 블록 정의(선택 기준점=선택 bbox 좌하단), 원본은 그 블록 인스턴스로 대체
let insertName = null;   // insert 도구가 삽입할 블록
let insertScale = 1, insertRot = 0;
function refreshBlockList() {
  const sec = document.getElementById('blockSection'), list = document.getElementById('blockList');
  if (!sec || !list) return;
  const names = Object.keys(state.blocks);
  sec.style.display = names.length ? '' : 'none';
  if (!insertName || !state.blocks[insertName]) insertName = names[0] || null;
  list.innerHTML = names.map(n => `<div class="layer${n === insertName ? ' active' : ''}" data-blk="${escapeHtml(n)}" style="flex-direction:row;align-items:center;">
    <span class="nm">▣ ${escapeHtml(n)}</span></div>`).join('');
  list.querySelectorAll('[data-blk]').forEach(el => el.addEventListener('click', () => {
    insertName = el.dataset.blk; refreshBlockList();
    if (state.tool !== 'insert') { setTool('insert'); lastCommand = 'insert'; }
  }));
}
function clickInsert(w) {
  const names = Object.keys(state.blocks);
  if (!names.length) { logLine('  삽입할 블록이 없습니다. 먼저 block 명령으로 블록을 만드세요.', 'warn'); setTool('select'); return; }
  if (!insertName || !state.blocks[insertName]) insertName = names[0];
  pushUndo();
  const ins = addEntity({ type: 'INSERT', layer: state.currentLayer, name: insertName, x: w.x, y: w.y, sx: insertScale, sy: insertScale, rot: insertRot });
  state.selection.clear(); state.selection.add(ins.id);
  logLine(`  ✔ 블록 "${insertName}" 삽입 (배율 ${insertScale}, 회전 ${insertRot}°)`, 'ok');
  updateStat(); renderProps(); draw(); // 도구 유지 → 연속 삽입
}
function cmdBlock() {
  const sel = selectedEntities().filter(e => e.type !== 'INSERT');
  if (!sel.length) { logLine('  블록: 먼저 도형을 선택하세요.', 'warn'); return; }
  let name = prompt('블록 이름:', 'Block' + (Object.keys(state.blocks).length + 1));
  if (!name) return; name = name.trim(); if (!name) return;
  if (state.blocks[name] && !confirm(`블록 "${name}"이 이미 있습니다. 덮어쓸까요?`)) return;
  // 기준점 = 선택 bbox 좌하단
  let mnx = Infinity, mny = Infinity;
  for (const e of sel) { const bb = entityBBox(e); if (bb) { mnx = Math.min(mnx, bb.xmin); mny = Math.min(mny, bb.ymin); } }
  if (!isFinite(mnx)) { mnx = 0; mny = 0; }
  pushUndo();
  const defEnts = sel.map(e => { const c = cloneEntity(e); translateEntity(c, -mnx, -mny); return c; }); // 블록 좌표계(기준점 원점)
  state.blocks[name] = { entities: defEnts };
  const layer = sel[0].layer;
  for (const e of sel) { state.entities = state.entities.filter(x => x !== e); state.selection.delete(e.id); }
  const ins = addEntity({ type: 'INSERT', layer, name, x: mnx, y: mny, sx: 1, sy: 1, rot: 0 });
  state.selection.add(ins.id);
  logLine(`  ✔ 블록 "${name}" 정의 (${sel.length}개 → 블록 1개)`, 'ok');
  updateStat(); renderProps(); refreshBlockList(); draw();
}
// 그리기 순서: 선택을 맨앞/맨뒤로
function reorderSel(front) {
  const sel = selectedEntities();
  if (!sel.length) { logLine('  순서 변경: 도형을 먼저 선택하세요.', 'warn'); return; }
  pushUndo();
  state.entities = state.entities.filter(e => !state.selection.has(e.id));
  if (front) state.entities.push(...sel); else state.entities.unshift(...sel);
  logLine(`  ✔ ${sel.length}개 → ${front ? '맨 앞으로' : '맨 뒤로'}`, 'ok');
  draw();
}
// 유사 선택: 선택과 같은 종류+레이어 전부 선택
function selectSimilar() {
  const sel = selectedEntities();
  if (!sel.length) { logLine('  유사 선택: 기준 도형을 먼저 선택하세요.', 'warn'); return; }
  const keys = new Set(sel.map(e => e.type + '|' + e.layer));
  let n = 0;
  for (const e of state.entities) {
    const l = getLayer(e.layer); if (l && (!l.visible || l.locked)) continue;
    if (keys.has(e.type + '|' + e.layer) && !state.selection.has(e.id)) { state.selection.add(e.id); n++; }
  }
  logLine(`  ✔ 유사 선택: +${n}개 (총 ${state.selection.size}개)`, 'ok');
  renderProps(); draw();
}
// 도구 전환 없이 즉시 실행되는 명령들
const INSTANT_CMDS = {
  explode: cmdExplode,
  join: cmdJoin,
  block: cmdBlock,
  front: () => reorderSel(true),
  back: () => reorderSel(false),
  similar: selectSimilar,
  // zoom = 줌 윈도(드래그한 박스만큼 확대 — 사용자 정의, 2026-07-20). 전체보기는 ze/F/버튼.
  zoom: () => cmdZoomWindow(),
  ze: () => { zoomFit(); logLine('  ✔ 전체보기', 'info'); },
  zp: zoomPrev,
  undo: () => { undo(); logLine('  ✔ 실행취소', 'info'); },
  redo: () => { redo(); logLine('  ✔ 다시실행', 'info'); },
  isolate: cmdIsolate,
  uniso: cmdUniso,
  sum: cmdSum,
  help: openCmdHelp,
  wall: cmdWallTag,
  slab: cmdSlabTag,
  column: cmdColumnTag,
  stair: cmdStairTag,
  railing: cmdRailingTag,
  setaslight: cmdSetAsLight,
  owsave: cmdOwSave, owlist: cmdOwList, owdel: () => cmdOwDel(prompt('삭제할 창호 기호 이름 (@ 없이):') || ''),   // 커스텀 창호 기호
  raytrace: cmdRaytrace,
  rendered: cmdRendered,
  material: cmdMaterial,
  rtquality: cmdRtQuality,
  ground: cmdGround,
  denoise: cmdRtDenoise,
  ao: cmdAo,
  viewcapturetofile: cmdCapture,
  finalrender: cmdFinalRender,
  bg: cmdBg,
  edges: cmdEdges,
  rtenv: cmdRtEnv,
  sun: cmdSun,
  ies: cmdIes,
  exposure: cmdExposure,
  falsecolor: cmdFalseColor,
  fcmax: cmdFcMax,
  addsensorplane: cmdAddSensorPlane,
  clearsensorplanes: cmdClearSensorPlanes,
  sensorcsv: cmdSensorCSV,
  unsetlight: cmdUnsetLight,
  lighting: cmdLighting,
  extrudecrv: cmdExtrudeCrv,
  extrudesrf: cmdExtrudeSrf,
  box: cmdBox,
  cylinder: cmdCylinder,
  sphere: cmdSphere,
  cone: cmdCone,
  settop: cmdSetTop,
  booleanunion: () => cmdBoolean('union'),
  booleandifference: () => cmdBoolean('subtract'),
  booleanintersection: () => cmdBoolean('intersect'),
  loft: cmdLoft,
  sweep: cmdSweep,
  shell: cmdShell,
  filletedge: cmdFillet3D,
  group: cmdGroup,
  ungroup: cmdUngroup,
  revolve: cmdRevolve,
  slice: cmdSlice,
  qselect: cmdQSelect,
  volume: cmdVolume,
  exportstl: () => cmdExportSTL(),
  exportobj: () => cmdExportOBJ(),
  selectedexport: () => { // 선택한 객체만 STL/OBJ로
    if (!state.selection.size) { logLine('  selectedexport: 내보낼 객체를 먼저 선택하세요.', 'warn'); return; }
    const ids = new Set(state.selection);
    const f = String(prompt('형식 — 1: STL  2: OBJ', '1') || '1').trim();
    if (f === '2') cmdExportOBJ(ids, 'parti-selected'); else cmdExportSTL(ids, 'parti-selected');
  },
  bimclear: cmdBimClear,
  view3d: open3D,
  roofview: () => {
    if (!v3 || !document.getElementById('bim3d')) { logLine('  3D 뷰에서 사용하는 명령입니다.', 'warn'); return; }
    v3.roof = (!v3.roof || v3.roof === 'show') ? 'ghost' : v3.roof === 'ghost' ? 'hide' : 'show';
    render3D();
    logLine(`  ▷ 지붕 표시: ${v3.roof === 'ghost' ? '투명' : v3.roof === 'hide' ? '숨김' : '보임'}`, 'info');
  },
  level: cmdLevelInfo,
  roof: cmdRoofTag,
};

function nearGrip(e, w, tol) {
  const grips = entityGrips(e);
  for (let i = 0; i < grips.length; i++)
    if (Math.hypot(grips[i].x - w.x, grips[i].y - w.y) <= tol) return { index: i, p: grips[i] };
  return null;
}
// 폴리라인 세그먼트 중점 그립(정점 추가용)
function nearMidGrip(e, w, tol) {
  if (e.type !== 'LWPOLYLINE') return null;
  const p = e.points, n = p.length, segN = e.closed ? n : n - 1;
  for (let i = 0; i < segN; i++) {
    const mx = (p[i][0] + p[(i + 1) % n][0]) / 2, my = (p[i][1] + p[(i + 1) % n][1]) / 2;
    if (Math.hypot(mx - w.x, my - w.y) <= tol) return { index: i, x: mx, y: my };
  }
  return null;
}

// 드래프트 업데이트(미리보기)
function updateDraft() {
  if (!draft) return;
  const w = mouseWorld;
  switch (draft.type) {
    case 'LINE': draft.x2 = w.x; draft.y2 = w.y; break;
    case 'CIRCLE': draft.r = Math.hypot(w.x - draft.cx, w.y - draft.cy); break;
    case 'LWPOLYLINE':
      if (draft._base) {
        const b = draft._base;
        draft.points = [[b.x, b.y], [w.x, b.y], [w.x, w.y], [b.x, w.y]];
      } else if (draft._poly) {
        const c = draft._poly;
        const r = Math.hypot(w.x - c.cx, w.y - c.cy);
        const a0 = Math.atan2(w.y - c.cy, w.x - c.cx);
        draft.points = polygonPoints(c.cx, c.cy, r, polygonSides, a0);
      } else if (draft._ell) {
        const c = draft._ell;
        draft.points = ellipsePoints(c.cx, c.cy, Math.abs(w.x - c.cx) || 1e-6, Math.abs(w.y - c.cy) || 1e-6);
      }
      break;
  }
  if (moveOp && moveOp.grip) updateGripMove();
}

function updateGripMove() {
  // 그립 이동은 라이브로 적용하되 base 갱신
  const e = moveOp.gripEntity, i = moveOp.gripIndex, w = mouseWorld;
  switch (e.type) {
    case 'LINE': if (i === 0) { e.x1 = w.x; e.y1 = w.y; } else { e.x2 = w.x; e.y2 = w.y; } break;
    case 'LWPOLYLINE': e.points[i] = [w.x, w.y]; break;
    case 'CIRCLE': case 'ARC': { const dx = w.x - e.cx, dy = w.y - e.cy; e.cx = w.x; e.cy = w.y; break; }
    case 'TEXT': e.x = w.x; e.y = w.y; break;
    // 이미지 모서리 그립 = 크기 조절 (반대편 모서리 고정, 회전 상태에서도 동작)
    case 'IMAGE': {
      const cor = IMG_CORNER_UV[i]; if (!cor) break;
      const opp = imgCorners(e)[(i + 2) % 4];      // 고정할 반대편 모서리(월드)
      const L = imgLocal(e, w);                    // 끄는 점(로컬)
      const nw = Math.abs(L.u - (-cor[0] * e.w / 2)), nh = Math.abs(L.v - (-cor[1] * e.h / 2));
      if (nw < 1e-6 || nh < 1e-6) break;           // 0 크기 방지
      e.w = nw; e.h = nh;
      // 반대편 모서리가 제자리에 남도록 중심 역산
      const a = (e.rot || 0) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
      const ou = -cor[0] * nw / 2, ov = -cor[1] * nh / 2;
      imgSetCenter(e, opp.x - (ou * ca - ov * sa), opp.y - (ou * sa + ov * ca));
      break;
    }
  }
}

// ============================================================
//  평면 검볼 (이미지) — 선택이 이미지 1개일 때 중심에 표시
//  X(빨강)/Y(초록) 화살표 = 축 이동 · 끝 사각 = 축 배율 · 원호 = 회전(Shift=15° 스냅)
//  중심 점 = 자유 이동. 그 외 상황엔 절대 뜨지 않으므로 기존 그립/선택 동작에 영향 없음.
// ============================================================
let imgGumDrag = null;
const GUM2 = { axis: 62, head: 9, scale: 78, ring: 46, tol: 7 }; // 화면 px
function gumballImage() {
  if (state.tool !== 'select' || state.selection.size !== 1) return null;
  const id = state.selection.values().next().value;
  const e = state.entities.find(x => x.id === id);
  return (e && e.type === 'IMAGE' && !isLocked(e) && onLv(e)) ? e : null;
}
// 화면 좌표 → 검볼 파트. 없으면 null (→ 평소의 선택 동작으로 넘어감)
function imgGumHit(sc) {
  const e = gumballImage(); if (!e || !sc) return null;
  const c = imgCenter(e), s = worldToScreen(c.x, c.y);
  const dx = sc.x - s.x, dy = sc.y - s.y, r = Math.hypot(dx, dy);
  const near = (px, py) => Math.hypot(sc.x - px, sc.y - py) <= 8;
  if (near(s.x + GUM2.scale, s.y)) return 'sx';           // 배율 사각(축 화살표보다 바깥)
  if (near(s.x, s.y - GUM2.scale)) return 'sy';
  const a = Math.atan2(-dy, dx) * 180 / Math.PI;          // 화면 → 월드 방향각
  if (Math.abs(r - GUM2.ring) <= 6 && a >= 22 && a <= 68) return 'rot'; // 1사분면 원호(축과 겹치지 않는 구간만)
  if (Math.abs(dy) <= GUM2.tol && dx > 8 && dx <= GUM2.axis + GUM2.head) return 'x';
  if (Math.abs(dx) <= GUM2.tol && dy < -8 && -dy <= GUM2.axis + GUM2.head) return 'y';
  if (r <= 8) return 'free';
  return null;
}
function startImgGum(part) {
  const e = gumballImage(); if (!e) return false;
  const c = imgCenter(e), w = screenToWorld(mouseScreen.x, mouseScreen.y);
  pushUndo();
  imgGumDrag = {
    e, part, c0: { x: c.x, y: c.y }, base: w, w0: e.w, h0: e.h, rot0: e.rot || 0,
    ang0: Math.atan2(w.y - c.y, w.x - c.x) * 180 / Math.PI,
    d0: part === 'sx' ? (w.x - c.x) : (w.y - c.y),
  };
  return true;
}
function updateImgGum(ev) {
  const g = imgGumDrag; if (!g) return;
  const e = g.e, w = screenToWorld(mouseScreen.x, mouseScreen.y); // 검볼은 스냅 미적용(예측 가능한 드래그)
  switch (g.part) {
    case 'x': imgSetCenter(e, g.c0.x + (w.x - g.base.x), g.c0.y); break;                       // X축만
    case 'y': imgSetCenter(e, g.c0.x, g.c0.y + (w.y - g.base.y)); break;                       // Y축만
    case 'free': imgSetCenter(e, g.c0.x + (w.x - g.base.x), g.c0.y + (w.y - g.base.y)); break;
    case 'rot': {
      const a = Math.atan2(w.y - g.c0.y, w.x - g.c0.x) * 180 / Math.PI;
      let nr = g.rot0 + (a - g.ang0);
      if (ev && ev.shiftKey) nr = Math.round(nr / 15) * 15; // 최종 각도를 15° 배수로 (증분이 아니라 절대각 스냅)
      e.rot = (nr % 360 + 360) % 360;
      imgSetCenter(e, g.c0.x, g.c0.y); // 회전은 중심 기준 — 중심 고정
      break;
    }
    case 'sx': case 'sy': {
      if (Math.abs(g.d0) < 1e-9) break;
      const d = g.part === 'sx' ? (w.x - g.c0.x) : (w.y - g.c0.y);
      const f = Math.max(0.02, Math.abs(d / g.d0));
      if (g.part === 'sx') e.w = g.w0 * f; else e.h = g.h0 * f;
      imgSetCenter(e, g.c0.x, g.c0.y);
      break;
    }
  }
}
function drawImgGumball() {
  const e = gumballImage(); if (!e || imgGumDrag && imgGumDrag.part === undefined) return;
  const c = imgCenter(e), s = worldToScreen(c.x, c.y);
  const A = GUM2.axis, HD = GUM2.head;
  ctx.save();
  ctx.lineWidth = 2; ctx.setLineDash([]); ctx.lineCap = 'round';
  const arrow = (col, tx, ty, ax, ay) => { // ax,ay = 화살촉 방향 단위벡터(화면)
    ctx.strokeStyle = ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(tx, ty); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(tx + ax * HD, ty + ay * HD);
    ctx.lineTo(tx - ay * HD * 0.42, ty + ax * HD * 0.42);
    ctx.lineTo(tx + ay * HD * 0.42, ty - ax * HD * 0.42);
    ctx.closePath(); ctx.fill();
  };
  arrow('#ff453a', s.x + A, s.y, 1, 0);   // +X (빨강)
  arrow('#30d158', s.x, s.y - A, 0, -1);  // +Y (초록)
  // 축 배율 사각
  ctx.fillStyle = '#ff453a'; ctx.fillRect(s.x + GUM2.scale - 3.5, s.y - 3.5, 7, 7);
  ctx.fillStyle = '#30d158'; ctx.fillRect(s.x - 3.5, s.y - GUM2.scale - 3.5, 7, 7);
  // 회전 원호(1사분면)
  ctx.strokeStyle = '#0A84FF';
  ctx.beginPath(); ctx.arc(s.x, s.y, GUM2.ring, -Math.PI / 2, 0); ctx.stroke();
  // 중심(자유 이동)
  ctx.fillStyle = '#0A84FF'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(s.x, s.y, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  // 드래그 중 수치 표시
  if (imgGumDrag) {
    const g = imgGumDrag;
    let t = '';
    if (g.part === 'rot') t = `${(e.rot || 0).toFixed(1)}°`;
    else if (g.part === 'sx' || g.part === 'sy') t = `${e.w.toFixed(1)} × ${e.h.toFixed(1)}`;
    else t = `Δ ${(c.x - g.c0.x).toFixed(1)}, ${(c.y - g.c0.y).toFixed(1)}`;
    ctx.font = '600 12px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(0,0,0,.65)';
    const tw = ctx.measureText(t).width;
    ctx.fillRect(s.x + 12, s.y - 30, tw + 10, 18);
    ctx.fillStyle = '#fff'; ctx.fillText(t, s.x + 17, s.y - 14);
  }
  ctx.restore();
}

function commitDraft() {
  if (!draft) return;
  if (draft.type === 'CIRCLE' && draft.r < 1e-6) { cancelDraft(); return; }
  if (draft.type === 'LWPOLYLINE' && (!draft.points || draft.points.length < 2)) { cancelDraft(); return; }
  delete draft._base; delete draft._poly; delete draft._ell;
  addEntity(draft);
  draft = null;
  updateStat(); renderProps();
}
function cancelDraft() { draft = null; pts = []; draw(); }

// 폴리라인 완료
function finishPolyline() {
  if (pts.length >= 2) {
    pushUndo();
    const e = addEntity({ type: 'LWPOLYLINE', closed: false, points: pts.map(p => [p.x, p.y]) });
    attachPtsZ(e, pts);
    updateStat();
  }
  pts = []; draw();
}
// 클릭한 점들의 높이가 서로 다르면(=표면 위에 그린 곡선) 정점별 z를 심는다.
// 전부 같은 높이면 아무것도 하지 않는다 — 기존 평면 도형(zo) 동작 그대로.
function attachPtsZ(e, ps) {
  if (!e || !ps || !ps.length) return;
  const base = lvElev() + (e.zo || 0);
  const zs = ps.map(p => (p.z != null ? p.z : base));
  if (zs.some(z => Math.abs(z - zs[0]) > 0.5)) {
    e.zs = zs.map(z => Math.round(z));
    delete e.zo; // zs는 절대 높이 — zo와 이중 적용되면 안 됨
    logLine(`  ▷ 표면 위 곡선: 정점별 높이 저장 (z ${Math.min(...e.zs)}~${Math.max(...e.zs)})`, 'info');
  }
}

// 호: 3클릭(중심 → 시작 → 끝)
let arcState = null;
function handleArcClick(w) {
  if (!arcState) { arcState = { cx: w.x, cy: w.y }; hint('호: 시작점을 클릭하세요.'); }
  else if (arcState.r === undefined) {
    arcState.r = Math.hypot(w.x - arcState.cx, w.y - arcState.cy);
    arcState.startAngle = ang(arcState.cx, arcState.cy, w.x, w.y);
    hint('호: 끝점을 클릭하세요.');
  } else {
    const endAngle = ang(arcState.cx, arcState.cy, w.x, w.y);
    pushUndo();
    addEntity({ type: 'ARC', cx: arcState.cx, cy: arcState.cy, r: arcState.r,
      startAngle: arcState.startAngle, endAngle });
    arcState = null; updateStat(); hint('호: 중심점을 클릭하세요.');
  }
}
function ang(cx, cy, x, y) { let a = Math.atan2(y - cy, x - cx) * 180 / Math.PI; return a < 0 ? a + 360 : a; }

// 이동 확정
function commitMove() {
  if (!moveOp) return;
  const dz = moveOp.dz || 0;
  for (const id of moveOp.entities) {
    const e = state.entities.find(x => x.id === id);
    if (!e) continue;
    if (dz) move3DEnt(e, moveOp.dx, moveOp.dy, dz); // z가 있으면 3D 이동 (평면·3D 공용)
    else translateEntity(e, moveOp.dx, moveOp.dy);
  }
  moveOp = null; draw(); renderProps();
  if (typeof boolRefresh === 'function') boolRefresh(); // 3D 뷰 열려 있으면 즉시 반영
}
function finishGripMoveMaybe() {
  if (moveOp && moveOp.grip) { moveOp = null; renderProps(); return; }
  if (moveOp && !moveOp.twoClick && moveOp.entities) { commitMove(); }
}

function finishDragSelect(ev) {
  if (dragSelect.zoomw) { // 줌 윈도: 드래그한 박스만큼 확대 (선택 아님)
    const b = dragSelect; dragSelect = null;
    applyZoomWindow(b);
    return;
  }
  const { x1, y1, x2, y2 } = dragSelect;
  if (Math.hypot(x2 - x1, y2 - y1) * state.view.scale > 3) {  // 실제 드래그(3px 이상)일 때만
    if (!ev.shiftKey) state.selection.clear();
    const box = { xmin: Math.min(x1, x2), xmax: Math.max(x1, x2), ymin: Math.min(y1, y2), ymax: Math.max(y1, y2) };
    const crossing = x2 < x1; // 오른쪽→왼쪽 드래그 = 크로싱(걸치면 선택), 왼→오 = 윈도우(전체 포함)
    for (const e of state.entities) {
      const l = getLayer(e.layer); if (l && (!l.visible || l.locked)) continue; // 잠긴 레이어 제외
      if (!onLv(e)) continue;
      if (crossing ? entityCrossesBox(e, box) : entityFullyInBox(e, box)) state.selection.add(e.id);
    }
  }
  dragSelect = null; renderProps(); draw();
}

// 이동 미리보기를 위해 draw에서 moveOp 반영
const _origDrawEntity = drawEntity;
// (이동 중인 도형은 임시 오프셋으로 그림)
function drawWithMove() { /* 통합 draw에서 처리 */ }

// draw 함수에서 moveOp 오프셋 적용을 위해 래핑
const realDraw = draw;
// override entity drawing during move preview
(function patchMovePreview() {
  const origDraw = draw;
})();

// ============================================================
//  명령행 / 미리보기
// ============================================================
const cmdPromptEl = document.getElementById('cmdPrompt');
const cmdInputEl = document.getElementById('cmdInput');
const cmdLogEl = document.getElementById('cmdLog');
function setPrompt(t) { if (cmdPromptEl) { cmdPromptEl.style.maxWidth = ''; cmdPromptEl.textContent = t; cmdPromptEl.style.display = 'none'; } hint(t); } // 텍스트 안내는 숨김(사용자 요청) — 로그창엔 남음
// 명령창에 텍스트 + 클릭 가능한 선택 버튼 (예: cap y/n) 표시. choices=[{label,on}]
function setPromptChoices(text, choices) {
  if (!cmdPromptEl) return;
  cmdPromptEl.style.maxWidth = '62%';
  cmdPromptEl.style.display = ''; // 클릭 가능한 선택지가 있을 때만 프롬프트 표시(텍스트 안내는 setPrompt에서 숨김)
  cmdPromptEl.textContent = text + ' ';
  for (const ch of choices) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'promptBtn'; b.textContent = ch.label;
    b.addEventListener('mousedown', (ev) => { ev.preventDefault(); ev.stopPropagation(); }); // 포커스/선택 방해 방지
    b.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); ch.on(); });
    cmdPromptEl.appendChild(b);
  }
  hint(text);
}
// 명령 기록(로그) 한 줄 추가. cls: 'cmd' | 'ok' | 'warn' | 'info'
function logLine(text, cls) {
  if (!cmdLogEl) return;
  const d = document.createElement('div');
  d.className = 'logline' + (cls ? ' l-' + cls : '');
  d.textContent = text;
  cmdLogEl.appendChild(d);
  cmdLogEl.scrollTop = cmdLogEl.scrollHeight;
  while (cmdLogEl.children.length > 400) cmdLogEl.removeChild(cmdLogEl.firstChild);
}
const TOOL_KO = {
  select: '선택(SELECT)', pan: '화면 이동(PAN)', line: '선(LINE)', pline: '폴리라인(PLINE)', spline: '자유곡선(SPLINE)', dimbase: '기준선 치수(DIMBASE)', rect: '사각형(RECT)',
  circle: '원(CIRCLE)', arc: '호(ARC)', text: '문자(TEXT)', move: '이동(MOVE)', erase: '지우기(ERASE)',
  offset: '오프셋(OFFSET)', copy: '복사(COPY)', mirror: '대칭(MIRROR)', rotate: '회전(ROTATE)',
  array: '배열(ARRAY)', trim: '자르기(TRIM)', extend: '연장(EXTEND)', fillet: '모깎기(FILLET)',
  scale: '배율(SCALE)', stretch: '신축(STRETCH)',
  polygon: '다각형(POLYGON)', ellipse: '타원(ELLIPSE)', chamfer: '모따기(CHAMFER)',
  dim: '치수(DIM)', dist: '거리(DIST)', area: '면적(AREA)',
  explode: '분해(EXPLODE)', join: '결합(JOIN)', zoom: '줌(ZOOM)',
  break: '끊기(BREAK)', lengthen: '길이조정(LENGTHEN)', hatch: '해치(HATCH)',
  dimrad: '반지름 치수(DIMRADIUS)', dimdia: '지름 치수(DIMDIAMETER)',
  block: '블록 정의(BLOCK)', insert: '블록 삽입(INSERT)', matchprop: '속성 일치(MATCHPROP)',
  dimang: '각도 치수(DIMANGULAR)', divide: '등분(DIVIDE)', measure: '간격 표식(MEASURE)',
  leader: '지시선(LEADER)', front: '맨 앞으로(FRONT)', back: '맨 뒤로(BACK)', similar: '유사 선택(SIMILAR)',
  // 아래는 도구로는 동작하는데 이름표가 빠져 있어 명령 로그에 'door'처럼 원시 이름이 찍히던 것들
  centerline: '중심선(CENTERLINE)', revcloud: '구름형 리비전(REVCLOUD)', frame: '도면 틀(FRAME)',
  align: '정렬(ALIGN)', xline: '무한 구성선(XLINE)', breakpt: '점에서 끊기(BREAKPT)',
  door: '문(DOOR)', window: '창(WINDOW)', section: '단면(SECTION)', elevation: '입면(ELEVATION)',
  railing: '난간(RAILING)',
  setaslight: '광원으로 지정(SETASLIGHT)',
  raytrace: '레이트레이싱 렌더(RAYTRACE)',
  rendered: '렌더링 뷰 — 실시간 태양·조명·그림자(RENDERED)',
  material: '재질 지정 — 질감·거칠기·투과(MATERIAL)',
  rtquality: '레이트레이싱 품질 — 낮음/보통/높음/최고(RTQUALITY)',
  ground: '대지 평면 토글 — 렌더 전용(GROUND)',
  denoise: '레이트레이싱 디노이즈 — 표시 스무딩(DENOISE)',
  ao: '렌더링 뷰 구석 음영 — 실험적 GTAO 토글·강도(AO)',
  viewcapturetofile: '보이는 렌더를 PNG 저장 · 2~4 배율 고해상도(VIEWCAPTURETOFILE)',
  finalrender: '레이트레이싱 수렴 후 자동 PNG 저장(FINALRENDER)',
  bg: '렌더 배경 — 흰색·하늘·검정, 조명은 유지(BG)',
  edges: '렌더링 뷰 모서리 표시 토글(EDGES)',
  rtenv: '렌더 환경 전환(RTENV)',
  sun: '태양 — 날짜·시각·위치·방위(SUN)',
  ies: 'IES 배광 파일(IES)',
  exposure: '렌더 노출(EXPOSURE)',
  falsecolor: '조도 색표시(FALSECOLOR)',
  fcmax: '조도 스케일(FCMAX)',
  addsensorplane: '측정면 추가(ADDSENSORPLANE)',
  clearsensorplanes: '측정면 삭제(CLEARSENSORPLANES)',
  sensorcsv: '조도 CSV(SENSORCSV)',
  unsetlight: '광원 해제(UNSETLIGHT)',
  lighting: '조명 보기(LIGHTING)',
};

const CMD_ALIASES = {
  line: 'line', l: 'line', pline: 'pline', pl: 'pline', polyline: 'pline',
  spline: 'spline', spl: 'spline', 자유곡선: 'spline', 스플라인: 'spline',
  curve: 'spline', interpcrv: 'spline', // 라이노에서 자유곡선을 부르는 이름
  distance: 'dist', // 라이노 Distance
  matchproperties: 'matchprop', // 라이노 MatchProperties
  rect: 'rect', rectangle: 'rect', rec: 'rect', circle: 'circle', c: 'circle',
  arc: 'arc', a: 'arc', text: 'text', t: 'text', dtext: 'text', mtext: 'text',
  move: 'move', m: 'move', erase: 'erase', e: 'erase', del: 'erase', delete: 'erase',
  select: 'select', s: 'select',
  offset: 'offset', o: 'offset', copy: 'copy', co: 'copy', cp: 'copy',
  mirror: 'mirror', mi: 'mirror', rotate: 'rotate', ro: 'rotate',
  array: 'array', ar: 'array',
  trim: 'trim', tr: 'trim', extend: 'extend', ex: 'extend',
  fillet: 'fillet', f: 'fillet', scale: 'scale', sc: 'scale',
  stretch: 'stretch', st: 'stretch',
  polygon: 'polygon', pol: 'polygon', ellipse: 'ellipse', el: 'ellipse',
  chamfer: 'chamfer', cha: 'chamfer',
  explode: 'explode', x: 'explode', join: 'join', j: 'join',
  dist: 'dist', di: 'dist', area: 'area', aa: 'area',
  dim: 'dim', dli: 'dim', dal: 'dim', dimlinear: 'dim', dimaligned: 'dim',
  dimbase: 'dimbase', dimbaseline: 'dimbase', 기준선치수: 'dimbase',
  zoom: 'zoom', z: 'zoom', ze: 'ze', fit: 'ze', zoomextents: 'ze', 전체보기: 'ze', zp: 'zp', u: 'undo', undo: 'undo', redo: 'redo',
  pan: 'pan',
  break: 'break', br: 'break', lengthen: 'lengthen', len: 'lengthen',
  hatch: 'hatch', h: 'hatch',
  dimradius: 'dimrad', dimrad: 'dimrad', dra: 'dimrad',
  dimdiameter: 'dimdia', dimdia: 'dimdia', ddi: 'dimdia',
  block: 'block', b: 'block', insert: 'insert', i: 'insert',
  matchprop: 'matchprop', ma: 'matchprop', mp: 'matchprop',
  dimangular: 'dimang', dimang: 'dimang', dan: 'dimang',
  divide: 'divide', div: 'divide', measure: 'measure', me: 'measure',
  leader: 'leader', le: 'leader', ld: 'leader',
  front: 'front', fr: 'front', back: 'back', bk: 'back',
  similar: 'similar', ss: 'similar',
  centerline: 'centerline', cl: 'centerline',
  revcloud: 'revcloud', rc: 'revcloud',
  frame: 'frame', align: 'align', al: 'align',
  isolate: 'isolate', iso: 'isolate', uniso: 'uniso', unisolate: 'uniso',
  sum: 'sum', xline: 'xline', xl: 'xline',
  breakpt: 'breakpt', bp: 'breakpt',
  help: 'help', '?': 'help',
  wall: 'wall', slab: 'slab', column: 'column', col: 'column',
  door: 'door', window: 'window', win: 'window', bimclear: 'bimclear',
  '3d': 'view3d', view3d: 'view3d',
  roofview: 'roofview', rview: 'roofview',
  level: 'level', lv: 'level',
  roof: 'roof',
  stair: 'stair', '계단': 'stair',
  railing: 'railing', handrail: 'railing', 난간: 'railing', 손스침: 'railing',
  setaslight: 'setaslight', light: 'setaslight', lamp: 'setaslight', 조명: 'setaslight', 광원지정: 'setaslight', 광원: 'setaslight',
  창호저장: 'owsave', 창호목록: 'owlist', 창호삭제: 'owdel',
  unsetlight: 'unsetlight', 광원해제: 'unsetlight',
  raytrace: 'raytrace', rt: 'raytrace', raytraced: 'raytrace', 레이트레이싱: 'raytrace', 렌더: 'raytrace',
  rendered: 'rendered', 렌더링: 'rendered', 렌더링뷰: 'rendered', 렌더뷰: 'rendered',
  material: 'material', mat: 'material', 재질: 'material', 재료: 'material',
  rtquality: 'rtquality', 품질: 'rtquality', 렌더품질: 'rtquality',
  ground: 'ground', 지면: 'ground', 대지: 'ground',
  denoise: 'denoise', 디노이즈: 'denoise', 노이즈제거: 'denoise',
  ao: 'ao', gtao: 'ao', 구석음영: 'ao', 앰비언트오클루전: 'ao',
  viewcapturetofile: 'viewcapturetofile', capture: 'viewcapturetofile', 캡처: 'viewcapturetofile', 렌더저장: 'viewcapturetofile', 화면저장: 'viewcapturetofile',
  // '렌더' 는 예전부터 raytrace 의 별칭 — 기존 습관을 뺏지 않는다 (계약 테스트 있음)
  finalrender: 'finalrender', 최종렌더: 'finalrender', render: 'finalrender',
  bg: 'bg', 배경: 'bg', background: 'bg',
  edges: 'edges', 엣지: 'edges', 모서리선: 'edges', 모서리표시: 'edges',
  rtenv: 'rtenv', 주광: 'rtenv', daylight: 'rtenv', 환경: 'rtenv',
  sun: 'sun', 태양: 'sun', sunlight: 'sun',
  ies: 'ies', 배광: 'ies', iesfile: 'ies',
  exposure: 'exposure', 노출: 'exposure',
  falsecolor: 'falsecolor', fc: 'falsecolor', 조도: 'falsecolor', 조도표시: 'falsecolor',
  fcmax: 'fcmax', 조도스케일: 'fcmax',
  addsensorplane: 'addsensorplane', sensor: 'addsensorplane', 측정면: 'addsensorplane',
  clearsensorplanes: 'clearsensorplanes', 측정면삭제: 'clearsensorplanes',
  sensorcsv: 'sensorcsv', 조도csv: 'sensorcsv',
  lighting: 'lighting', night: 'lighting', 야간: 'lighting', 조명보기: 'lighting', 조명켜기: 'lighting',
  extrudecrv: 'extrudecrv', extcrv: 'extrudecrv', extrude: 'extrudecrv', ext: 'extrudecrv', 돌출: 'extrudecrv',
  extrudesrf: 'extrudesrf', extsrf: 'extrudesrf',

  box: 'box', cylinder: 'cylinder', cyl: 'cylinder',
  sphere: 'sphere', 구: 'sphere', cone: 'cone', 원뿔: 'cone',
  settop: 'settop',

  loft: 'loft', 로프트: 'loft',
  sweep: 'sweep', 쓸기: 'sweep',
  shell: 'shell', 속비우기: 'shell',
  filletedge: 'filletedge', fe: 'filletedge', 모서리모깎기: 'filletedge', // 라이노 FilletEdge (곡선 Fillet과는 다른 명령 — 라이노도 분리되어 있음)
  group: 'group', g: 'group', 그룹: 'group',
  ungroup: 'ungroup', ung: 'ungroup', 그룹해제: 'ungroup',
  revolve: 'revolve', rev: 'revolve', 회전체: 'revolve',
  slice: 'slice', 절단: 'slice',
  qselect: 'qselect', qsel: 'qselect', 조건선택: 'qselect',
  volume: 'volume', vol: 'volume', 부피: 'volume', massprop: 'volume',
  // 불리언 — 정식 이름은 라이노와 동일(BooleanUnion/BooleanDifference/BooleanIntersection),
  // 라이노 단축키(bu/bd/bi)와 기존 짧은 이름은 별칭으로 유지
  booleanunion: 'booleanunion', bu: 'booleanunion', boolunion: 'booleanunion', union: 'booleanunion', 합집합: 'booleanunion',
  booleandifference: 'booleandifference', bd: 'booleandifference', boolsub: 'booleandifference', subtract: 'booleandifference', difference: 'booleandifference', 차집합: 'booleandifference',
  booleanintersection: 'booleanintersection', bi: 'booleanintersection', boolint: 'booleanintersection', 교집합: 'booleanintersection',
  exportstl: 'exportstl', stl: 'exportstl',
  exportobj: 'exportobj', obj: 'exportobj',
  selectedexport: 'selectedexport', selexport: 'selectedexport', exportsel: 'selectedexport',
  section: 'section', sec: 'section',
  elevation: 'elevation', elev: 'elevation', ev: 'elevation',
};

function runCommandInput(raw) {
  const v = raw.trim().toLowerCase();
  if (!v) return; // 빈 Enter
  logLine('명령: ' + v, 'cmd');
  // 돌출(extrudecrv/extrudesrf) 진행 단계 입력 우선 처리
  if (extrudePend) {
    if (extrudePend.stage === 'height') { // on/off(=cap)·y/n=캡 전환, 숫자=그 높이로 (클릭 안 했어도) 생성·확정
      if (v === 'on' || v === 'y' || v === 'yes' || v === '예' || v === 'cap on') { extrudeSetCap(true); return; }
      if (v === 'off' || v === 'n' || v === 'no' || v === '아니오' || v === 'cap off') { extrudeSetCap(false); return; }
      const hn = parseFloat(v);
      if (!isNaN(hn) && /^-?[\d.]+$/.test(v)) { if (!extrudePend.applied) extrudeApplyKind(); extrudeSetVal(hn); extrudeFinish(); return; } // 0=평면, 음수=기준면 아래로 돌출
      logLine('  높이값 입력(음수=아래 방향)·빈 Enter 확정 · y/n=캡 전환.', 'warn'); return;
    }
    if (extrudePend.stage === 'pickSel') { extrudePend = null; setPrompt(''); } // 다른 명령 입력 시 선택대기 취소 후 진행
  }
  // 뷰 명령: vs 이름(저장) / vg 이름(이동) / vl(목록)
  let vm = raw.trim().match(/^vs\s+(.+)$/i);
  if (vm) { state.views[vm[1].trim()] = { ...state.view }; logLine(`  ✔ 뷰 저장: "${vm[1].trim()}"`, 'ok'); return; }
  vm = raw.trim().match(/^vg\s+(.+)$/i);
  if (vm) {
    const vv = state.views[vm[1].trim()];
    if (vv) { pushViewPrev(); state.view = { ...vv }; draw(); logLine(`  ✔ 뷰 이동: "${vm[1].trim()}"`, 'ok'); }
    else logLine(`  뷰 "${vm[1].trim()}"이 없습니다. (vl=목록)`, 'warn');
    return;
  }
  if (v === 'vl') { const ns = Object.keys(state.views); logLine('  저장된 뷰: ' + (ns.length ? ns.join(', ') : '(없음)') + '  — vs 이름=저장, vg 이름=이동', 'info'); return; }
  // 해치 도구 중 패턴명 입력 (예: brick, concrete)
  if (state.tool === 'hatch' && HATCH_PATTERNS[v]) {
    hatchPattern = v;
    setPrompt(`해치: 패턴 ${HATCH_PATTERNS[v].ko}, 간격 ${hatchSpacing}. 경계를 클릭하세요.`);
    logLine(`  해치 패턴 = ${HATCH_PATTERNS[v].ko}`, 'info'); return;
  }
  // 진행 중 작도 도구의 좌표/치수 입력을 우선 처리
  if (feedDrawInput(v)) return;
  // 모깎기/모따기 'r'(반지름) 옵션 — 오토캐드식: r 입력 → 반지름 조정 모드, 이어서 숫자 입력
  if (state.tool === 'fillet' && (v === 'r' || v === 'radius' || v === '반지름')) {
    setPrompt(`모깎기 반지름 조정: 값을 입력하고 Enter (현재 R=${filletRadius})`);
    logLine(`  ▷ 반지름 조정 모드 — 숫자를 입력하세요 (현재 R=${filletRadius})`, 'info');
    return;
  }
  if (state.tool === 'chamfer' && (v === 'd' || v === 'r' || v === '거리')) {
    setPrompt(`모따기 거리 조정: 값을 입력하고 Enter (현재 ${chamferDist})`);
    logLine(`  ▷ 거리 조정 모드 — 숫자를 입력하세요 (현재 ${chamferDist})`, 'info');
    return;
  }
  // 숫자 입력 → 진행 중 명령의 수치 인자
  const num = parseFloat(v);
  if (!isNaN(num) && /^-?[\d.]+$/.test(v)) {
    if (state.tool === 'offset') { offsetDist = Math.abs(num) || offsetDist; setPrompt(`오프셋: 도형을 선택하세요. (거리 ${offsetDist})`); logLine(`  오프셋 거리 = ${offsetDist}`, 'info'); return; }
    if (state.tool === 'rotate' && cmdOp && cmdOp.step === 'angle') { logLine(`  회전 각도 = ${num}°`, 'info'); applyRotate(num); return; }
    if (state.tool === 'fillet') { filletRadius = Math.abs(num); setPrompt(`모깎기 R=${filletRadius} — 두 변(선·폴리라인)을 차례로 클릭하세요. (반지름 변경: r 또는 숫자)`); logLine(`  ✔ 모깎기 반지름 = ${filletRadius}`, 'ok'); return; }
    if (state.tool === 'chamfer') { chamferDist = Math.abs(num); setPrompt(`모따기: 거리 ${chamferDist}. 첫 번째 선을 클릭하세요.`); logLine(`  모따기 거리 = ${chamferDist}`, 'info'); return; }
    if (state.tool === 'lengthen') { lengthenDelta = num; setPrompt(`길이조정: ${num > 0 ? '+' : ''}${num}. 조정할 선의 끝쪽을 클릭하세요.`); logLine(`  증감 길이 = ${num > 0 ? '+' : ''}${num}`, 'info'); return; }
    if (state.tool === 'hatch') { hatchSpacing = Math.abs(num) || hatchSpacing; setPrompt(`해치: 간격 ${hatchSpacing}. 원/닫힌 폴리라인을 클릭하세요.`); logLine(`  해치 간격 = ${hatchSpacing}`, 'info'); return; }
    if (state.tool === 'divide') { divideCount = Math.max(2, Math.round(Math.abs(num))); setPrompt(`등분: ${divideCount}등분. 대상을 클릭하세요.`); logLine(`  등분 개수 = ${divideCount}`, 'info'); return; }
    if (state.tool === 'measure') { measureStep = Math.abs(num) || measureStep; setPrompt(`간격 표식: ${measureStep}. 대상을 클릭하세요.`); logLine(`  간격 = ${measureStep}`, 'info'); return; }
    if (state.tool === 'scale' && cmdOp && (cmdOp.step === 'ref' || cmdOp.step === 'factor')) { applyScale(num); return; }
    logLine('  (입력한 숫자를 받을 명령이 없습니다)', 'warn'); return;
  }
  const tool = settings.aliases[v] || CMD_ALIASES[v]; // 사용자 단축키 우선
  if (tool && INSTANT_CMDS[tool]) { // 즉시 실행 명령(분해·결합·줌·실행취소 등)
    // 3D 명령(extrudecrv·box·union…) 포함 모두 스페이스 반복 대상 — 단 undo/redo류는 연쇄 실행 위험이라 제외.
    // 실행 전에 기록: 명령이 대화상자 취소 등으로 중단돼도 스페이스 반복은 가능해야 함
    if (!['undo', 'redo', 'help'].includes(tool)) lastCommand = tool;
    INSTANT_CMDS[tool]();
    return;
  }
  if (tool) { setTool(tool); if (tool !== 'select') lastCommand = tool; }
  else if (!feedCmdArg(raw, v)) logLine(`  알 수 없는 명령: ${v}`, 'warn');
}
// '명령 인자' 형태 — material 벽돌 / ies 해제 / exposure 0.05
// 여태 디스패처는 입력 '전체'를 별칭 표에서 찾기만 했다. 그래서 인자를 받도록 만든 명령
// (cmdIes(arg)·cmdExposure(arg))도 명령창에선 인자를 못 받았고, 심지어 그 명령의 도움말이
// "사용법: ies 해제" 라고 안내하는데 실제로 치면 '알 수 없는 명령' 이 났다 — 앱이 거짓말을 했다.
// 인자는 원문(raw)에서 잘라 넘긴다: 파일명·한글 재질명이 소문자화되면 안 된다.
function feedCmdArg(raw, v) {
  const sp = v.search(/\s/);
  if (sp <= 0) return false;
  const head = v.slice(0, sp);
  const t = settings.aliases[head] || CMD_ALIASES[head];
  if (!t || !INSTANT_CMDS[t]) return false;
  const arg = raw.trim().slice(sp).trim();
  if (!['undo', 'redo', 'help'].includes(t)) lastCommand = t;
  INSTANT_CMDS[t](arg);
  return true;
}

// 직전 명령 반복(스페이스/Enter)
function repeatLastCommand() {
  if (!lastCommand) { logLine('  반복할 명령이 없습니다.', 'warn'); return; }
  logLine(`명령: ${lastCommand}  (반복)`, 'cmd');
  if (INSTANT_CMDS[lastCommand]) { INSTANT_CMDS[lastCommand](); return; }
  setTool(lastCommand);
}
// 빈 칸에서 Enter/스페이스: 폴리라인 작도 중이면 종료, 아니면 직전 명령 반복
function emptyEnterAction() {
  if (extrudePend) { // 돌출 진행: pickSel=선택 확정→생성 / height=현재 높이로 확정
    if (extrudePend.stage === 'pickSel') {
      const valid = extrudeValidSel(extrudePend.cmd);
      if (!valid.length) { logLine('  선택된 대상이 없습니다 — 곡선/면을 클릭한 뒤 Enter.', 'warn'); return; }
      const cmd = extrudePend.cmd; extrudePend = null; extrudeStart(cmd, valid); return;
    }
    if (extrudePend.stage === 'height') {
      if (extrudePend.srf && extrudePend.heightPhase === 'confirmFace') { // 면 포커싱 후 Space/Enter → 기준점 선택 시작
        extrudePend.heightPhase = 'awaitBase';
        setPrompt('기준점을 클릭하세요 — 화면 어디나 가능, 객체 꼭짓점·모서리·표면엔 스냅 · 숫자 입력도 가능 · Esc');
        logLine('  ▷ 기준점을 클릭하세요 (객체 꼭짓점·모서리·표면에 스냅됨) — 또는 높이값 입력', 'info');
        return;
      }
      if (extrudePend.srf && extrudePend.heightPhase === 'awaitBase') { logLine('  ▷ 기준점을 화면에서 클릭하세요 (스냅). 또는 높이값 입력.', 'info'); return; } // 기준점 클릭 대기 — Enter로 안 끝냄
      if (!extrudePend.applied) { extrudePend.val = settings.bim.wallH || 2700; extrudeApplyKind(); } // Enter=현재(또는 기본) 높이로 확정
      extrudeFinish(); return;
    }
  }
  if (typeof boolPending !== 'undefined' && boolPending) { boolFinish(); return; } // 차집합 2단계 완료
  if (state.tool === 'pline') {
    if (pts.length >= 2) { finishPolyline(); return; }
    pts = []; draw(); return;
  }
  if (state.tool === 'spline') { // 자유곡선 확정 (제어점 2개 이상)
    if (pts.length >= 2) { finishSpline(false); return; }
    pts = []; draw(); return;
  }
  if (state.tool === 'area' && pts.length) { finishArea(); return; } // 면적 계산 확정
  if (state.tool === 'trim') { trimSpaceAction(); return; }           // 자르기 모드 전환/확정
  if (draft) { cancelDraft(); return; }
  repeatLastCommand();
}
// cmdpop(커서 명령창)이 '빈 Space/Enter'를 여기로 넘긴다 — 직전 명령 반복·작도 확정이 즉시 동작
window.WEBCAD_EMPTY_ENTER = emptyEnterAction;

// ---------- 좌표/치수 입력 파서 ----------
// "x,y" → 절대점 | "@dx,dy" → 상대점 | "12" → 단일 수치
function parsePointOrNumber(v) {
  v = v.trim();
  let m = v.match(/^@\s*(-?[\d.]+)\s*<\s*(-?[\d.]+)$/); // 극좌표: @거리<각도
  if (m) { const dd = +m[1], aa = +m[2] * Math.PI / 180; return { kind: 'rel', dx: dd * Math.cos(aa), dy: dd * Math.sin(aa) }; }
  m = v.match(/^@\s*(-?[\d.]+)\s*[, ]\s*(-?[\d.]+)\s*[, ]\s*(-?[\d.]+)$/); // 3D 상대: @dx,dy,dz
  if (m) return { kind: 'rel', dx: +m[1], dy: +m[2], dz: +m[3] };
  m = v.match(/^@\s*(-?[\d.]+)\s*[, ]\s*(-?[\d.]+)$/);
  if (m) return { kind: 'rel', dx: +m[1], dy: +m[2] };
  m = v.match(/^(-?[\d.]+)\s*[, ]\s*(-?[\d.]+)\s*[, ]\s*(-?[\d.]+)$/); // 3D 절대: x,y,z
  if (m) return { kind: 'abs', x: +m[1], y: +m[2], z: +m[3] };
  m = v.match(/^(-?[\d.]+)\s*[, ]\s*(-?[\d.]+)$/);
  if (m) return { kind: 'abs', x: +m[1], y: +m[2] };
  if (/^-?[\d.]+$/.test(v)) return { kind: 'num', n: +v };
  return null;
}
// 진행 중 작도 도구에 좌표/치수 입력을 공급. 소비하면 true.
function feedDrawInput(v) {
  const p = parsePointOrNumber(v);
  if (!p) return false;
  switch (state.tool) {
    case 'line': return feedLine(p);
    case 'circle': return feedCircle(p);
    case 'rect': return feedRect(p);
    case 'pline': case 'spline': return feedPline(p); // 자유곡선도 같은 pts 배열(제어점) 사용
    case 'arc': return feedArc(p);
    case 'move': return feedMove(p);
    case 'copy': return feedCopy(p);
    case 'polygon': return feedPolygon(p);
    case 'ellipse': return feedEllipse(p);
    case 'dim': return feedPointCmd(p, clickDim);
    case 'dimbase': return feedPointCmd(p, clickDimBase);
    case 'leader': return feedPointCmd(p, clickLeader);
    case 'revcloud': return feedPointCmd(p, clickRevcloud);
    case 'frame': return feedPointCmd(p, clickFrame);
    case 'align': return feedPointCmd(p, (w) => clickAlign(w, w));
    case 'xline': return feedPointCmd(p, clickXline);
    case 'breakpt': return feedPointCmd(p, (w) => clickBreakpt(w, w));
    case 'section': return feedPointCmd(p, (w) => clickSection(w, false));
    case 'elevation': return feedPointCmd(p, (w) => clickSection(w, true));
    case 'text': return feedPointCmd(p, (w) => { const t = prompt('문자 입력:', ''); if (t) { pushUndo(); addEntity({ type: 'TEXT', x: w.x, y: w.y, height: state.textHeight, text: t, rotation: 0 }); updateStat(); } });
    case 'dist': return feedPointCmd(p, clickDist);
    case 'area': return feedPointCmd(p, (w) => clickArea(w, w));
    case 'break': return feedPointCmd(p, (w) => clickBreak(w, w));
  }
  return false;
}
// 기준점(base) 대비 입력값 → 변위(dx,dy). 절대점/상대점/거리(커서 방향) 지원
function displacementFrom(base, p) {
  if (p.kind === 'rel') return { dx: p.dx, dy: p.dy, dz: p.dz || 0 };
  if (p.kind === 'abs') return { dx: p.x - base.x, dy: p.y - base.y, dz: p.z != null ? p.z - (base.z || 0) : 0 };
  const c = screenToWorld(mouseScreen.x, mouseScreen.y);
  const vx = c.x - base.x, vy = c.y - base.y, l = Math.hypot(vx, vy) || 1;
  return { dx: vx / l * p.n, dy: vy / l * p.n };
}
function feedMove(p) {
  if (!moveOp || !moveOp.base) {
    // 기준점도 좌표로 지정 가능 (라이노 Move: 기준점·목적점 모두 입력/클릭). copy와 동작 일치
    if (p.kind === 'abs' && state.selection.size) {
      pushUndo();
      moveOp = { entities: [...state.selection], base: { x: p.x, y: p.y, z: p.z != null ? p.z : 0 }, dx: 0, dy: 0, dz: 0, twoClick: true };
      setPrompt('이동: 이동점을 클릭하거나 좌표(@dx,dy[,dz] / x,y[,z] / 거리)를 입력하세요.');
      return true;
    }
    logLine('  먼저 옮길 도형을 선택하고 기준점을 지정하세요 (클릭 또는 x,y[,z] 입력).', 'warn'); return true;
  }
  const d = displacementFrom(moveOp.base, p);
  moveOp.dx = d.dx; moveOp.dy = d.dy; moveOp.dz = d.dz || 0; commitMove();
  logLine(`  ✔ 이동 (${d.dx.toFixed(2)}, ${d.dy.toFixed(2)}${d.dz ? ', ' + d.dz.toFixed(2) : ''})`, 'ok'); draw(); return true;
}
function feedCopy(p) {
  // 클릭 없이 좌표만으로도 시작 (라이노 Copy: 기준점·목적점 모두 입력 가능) — move와 동작 일치
  if (!cmdOp || cmdOp.name !== 'copy') {
    if (!state.selection.size) { logLine('  먼저 복사할 도형을 선택하세요.', 'warn'); return true; }
    cmdOp = { name: 'copy', step: 'base' };
  }
  if (cmdOp.step === 'pick') {
    if (!state.selection.size) { logLine('  먼저 복사할 도형을 선택하세요.', 'warn'); return true; }
    cmdOp.step = 'base';
  }
  if (cmdOp.step === 'base') { // 기준점을 좌표로 지정
    if (p.kind === 'abs') { cmdOp.base = { x: p.x, y: p.y, z: p.z != null ? p.z : 0 }; cmdOp.step = 'dest'; setPrompt('복사: 붙일 위치 입력/클릭 (@dx,dy[,dz] · 반복 가능)'); return true; }
    logLine('  복사 기준점을 클릭하거나 x,y로 입력하세요.', 'warn'); return true;
  }
  if (cmdOp.step === 'dest') {
    const d = displacementFrom(cmdOp.base, p);
    pushUndo();
    if (d.dz) { // 3D 복사 (@dx,dy,dz) — 메시·솔리드 포함
      const cs = dupEnts(selectedEntities());
      for (const e of cs) move3DEnt(e, d.dx, d.dy, d.dz);
      logLine(`  ✔ 복사 (${d.dx.toFixed(2)}, ${d.dy.toFixed(2)}, ${d.dz.toFixed(2)})`, 'ok');
      updateStat(); draw(); if (typeof boolRefresh === 'function') boolRefresh(); return true;
    }
    const T = T_translate(d.dx, d.dy); const ents = selectedEntities();
    for (const e of ents) addEntity(transformedClone(e, T));
    logLine(`  ✔ 복사 ${ents.length}개 (${d.dx.toFixed(2)}, ${d.dy.toFixed(2)})`, 'ok');
    updateStat(); draw(); return true; // step 유지 → 반복 붙여넣기
  }
  return true;
}
// 점 기반 명령(dim/dist/area)에 x,y 좌표 입력 전달
function feedPointCmd(p, fn) {
  if (p.kind === 'abs') { fn({ x: p.x, y: p.y }); draw(); return true; }
  logLine('  이 명령은 점(x,y)으로 입력하세요.', 'warn'); return true;
}
function feedPolygon(p) {
  if (!draft) {
    if (p.kind === 'num') {
      polygonSides = Math.max(3, Math.round(Math.abs(p.n)));
      setPrompt(`다각형(${polygonSides}변): 중심을 클릭하거나 x,y로 입력하세요.`);
      logLine(`  변 개수 = ${polygonSides}`, 'info'); return true;
    }
    if (p.kind === 'abs') { clickPolygon({ x: p.x, y: p.y }); draw(); return true; }
    logLine('  변 개수(숫자) 또는 중심(x,y)을 입력하세요.', 'warn'); return true;
  }
  const c = draft._poly;
  let r, a0;
  if (p.kind === 'num') { r = Math.abs(p.n); a0 = Math.PI / 2; } // 꼭짓점 위쪽
  else if (p.kind === 'abs') { r = Math.hypot(p.x - c.cx, p.y - c.cy); a0 = Math.atan2(p.y - c.cy, p.x - c.cx); }
  else { r = Math.hypot(p.dx, p.dy); a0 = Math.atan2(p.dy, p.dx); }
  if (r < 1e-9) { logLine('  반지름이 0입니다.', 'warn'); return true; }
  draft.points = polygonPoints(c.cx, c.cy, r, polygonSides, a0);
  commitDraft(); logLine(`  ✔ ${polygonSides}각형 R=${fmtNum(r)}`, 'ok'); draw(); return true;
}
function feedEllipse(p) {
  if (!draft) {
    if (p.kind === 'abs') { clickEllipse({ x: p.x, y: p.y }); draw(); return true; }
    logLine('  먼저 중심점을 지정하세요 (x,y 또는 클릭).', 'warn'); return true;
  }
  const c = draft._ell;
  let rx, ry;
  if (p.kind === 'num') rx = ry = Math.abs(p.n);
  else if (p.kind === 'abs') { rx = Math.abs(p.x); ry = Math.abs(p.y); }
  else { rx = Math.abs(p.dx); ry = Math.abs(p.dy); }
  if (rx < 1e-9 || ry < 1e-9) { logLine('  반지름이 0입니다.', 'warn'); return true; }
  draft.points = ellipsePoints(c.cx, c.cy, rx, ry);
  commitDraft(); logLine(`  ✔ 타원 ${fmtNum(rx)}×${fmtNum(ry)}`, 'ok'); draw(); return true;
}
function feedLine(p) {
  if (!draft) {
    if (p.kind === 'abs') { pushUndo(); draft = { type: 'LINE', x1: p.x, y1: p.y, x2: p.x, y2: p.y }; setPrompt('선: 끝점(x,y / @dx,dy / 길이) 입력 또는 클릭'); logLine(`  시작점 (${p.x}, ${p.y})`, 'info'); draw(); return true; }
    logLine('  먼저 시작점을 지정하세요 (x,y 또는 클릭).', 'warn'); return true;
  }
  let ex, ey;
  if (p.kind === 'abs') { ex = p.x; ey = p.y; }
  else if (p.kind === 'rel') { ex = draft.x1 + p.dx; ey = draft.y1 + p.dy; }
  else { const dx = mouseWorld.x - draft.x1, dy = mouseWorld.y - draft.y1, L = Math.hypot(dx, dy) || 1; ex = draft.x1 + dx / L * p.n; ey = draft.y1 + dy / L * p.n; }
  draft.x2 = ex; draft.y2 = ey; commitDraft(); logLine('  ✔ 선', 'ok');
  pushUndo(); draft = { type: 'LINE', x1: ex, y1: ey, x2: ex, y2: ey }; // 끝점에서 이어 그리기
  setPrompt('선: 다음 끝점 입력/클릭 (Enter·우클릭으로 종료)');
  draw(); return true;
}
function feedCircle(p) {
  if (!draft) {
    if (p.kind === 'abs') { pushUndo(); draft = { type: 'CIRCLE', cx: p.x, cy: p.y, r: 0 }; setPrompt('원: 반지름(숫자)을 입력하거나 점을 클릭하세요.'); logLine(`  중심 (${p.x}, ${p.y})`, 'info'); draw(); return true; }
    logLine('  먼저 중심점을 지정하세요 (x,y 또는 클릭).', 'warn'); return true;
  }
  let r;
  if (p.kind === 'num') r = Math.abs(p.n);
  else if (p.kind === 'abs') r = Math.hypot(p.x - draft.cx, p.y - draft.cy);
  else r = Math.hypot(p.dx, p.dy);
  draft.r = r; commitDraft(); logLine(`  ✔ 원 반지름 ${r}`, 'ok'); draw(); return true;
}
function feedRect(p) {
  if (!draft) {
    if (p.kind === 'abs') { pushUndo(); draft = { type: 'LWPOLYLINE', closed: true, _base: { x: p.x, y: p.y }, points: [[p.x, p.y], [p.x, p.y], [p.x, p.y], [p.x, p.y]] }; setPrompt('사각형: 크기 w,h (또는 한 변 길이)를 입력하거나 클릭'); logLine(`  첫 모서리 (${p.x}, ${p.y})`, 'info'); draw(); return true; }
    logLine('  먼저 첫 모서리를 지정하세요 (x,y 또는 클릭).', 'warn'); return true;
  }
  const b = draft._base; let ox, oy;
  if (p.kind === 'num') { ox = b.x + p.n; oy = b.y + p.n; }       // 정사각형
  else if (p.kind === 'abs') { ox = b.x + p.x; oy = b.y + p.y; }   // w,h 크기
  else { ox = b.x + p.dx; oy = b.y + p.dy; }
  draft.points = [[b.x, b.y], [ox, b.y], [ox, oy], [b.x, oy]]; commitDraft(); logLine('  ✔ 사각형', 'ok'); draw(); return true;
}
function feedPline(p) {
  let np;
  if (p.kind === 'abs') np = { x: p.x, y: p.y };
  else if (p.kind === 'rel') { const last = pts[pts.length - 1] || { x: 0, y: 0 }; np = { x: last.x + p.dx, y: last.y + p.dy }; }
  else { const last = pts[pts.length - 1]; if (!last) { logLine('  먼저 첫 점을 지정하세요.', 'warn'); return true; } const dx = mouseWorld.x - last.x, dy = mouseWorld.y - last.y, L = Math.hypot(dx, dy) || 1; np = { x: last.x + dx / L * p.n, y: last.y + dy / L * p.n }; }
  pts.push(np); draw(); return true;
}
function feedArc(p) {
  if (p.kind !== 'abs') { logLine('  호는 점(x,y)으로 입력하세요.', 'warn'); return true; }
  if (!arcState) { arcState = { cx: p.x, cy: p.y }; setPrompt('호: 시작점(x,y)을 입력하거나 클릭'); return true; }
  if (arcState.r === undefined) { arcState.r = Math.hypot(p.x - arcState.cx, p.y - arcState.cy); arcState.startAngle = ang(arcState.cx, arcState.cy, p.x, p.y); setPrompt('호: 끝점(x,y)을 입력하거나 클릭'); return true; }
  const ea = ang(arcState.cx, arcState.cy, p.x, p.y);
  pushUndo(); addEntity({ type: 'ARC', cx: arcState.cx, cy: arcState.cy, r: arcState.r, startAngle: arcState.startAngle, endAngle: ea });
  arcState = null; logLine('  ✔ 호', 'ok'); updateStat(); draw(); return true;
}

// 명령 실행 전 결과 미리보기(점선 고스트)
function updateCmdPreview() {
  previewEnts = null;
  if (state.tool === '_paste' && cmdOp && cmdOp.name === 'paste') { // 붙여넣기 고스트
    const clip = cmdOp.clip, dx = mouseWorld.x - clip.base[0], dy = mouseWorld.y - clip.base[1];
    previewEnts = clip.ents.map(src => { const c = cloneEntity(src); translateEntity(c, dx, dy); return c; });
    return;
  }
  if (state.tool === 'insert' && insertName && state.blocks[insertName]) { // 블록 삽입 고스트
    previewEnts = insertChildren({ type: 'INSERT', layer: state.currentLayer, name: insertName, x: mouseWorld.x, y: mouseWorld.y, sx: insertScale, sy: insertScale, rot: insertRot });
    return;
  }
  if (!cmdOp) return;
  const sel = selectedEntities();
  const w = mouseWorld;
  if (cmdOp.name === 'copy' && cmdOp.step === 'dest' && cmdOp.base) {
    const T = T_translate(w.x - cmdOp.base.x, w.y - cmdOp.base.y);
    previewEnts = sel.map(e => transformedClone(e, T));
  } else if (cmdOp.name === 'mirror' && cmdOp.step === 'p2' && cmdOp.p1) {
    const T = T_mirror(cmdOp.p1.x, cmdOp.p1.y, w.x, w.y);
    previewEnts = sel.map(e => transformedClone(e, T));
  } else if (cmdOp.name === 'rotate' && cmdOp.step === 'angle' && cmdOp.base) {
    const deg = ang(cmdOp.base.x, cmdOp.base.y, w.x, w.y);
    const T = T_rotate(cmdOp.base.x, cmdOp.base.y, deg);
    previewEnts = sel.map(e => transformedClone(e, T));
    setPrompt(`회전: ${deg.toFixed(1)}° (클릭 또는 각도 입력)`);
  } else if (cmdOp.name === 'offset' && cmdOp.step === 'side' && cmdOp.target) {
    const ne = offsetEntity(cmdOp.target, offsetDist, screenToWorld(mouseScreen.x, mouseScreen.y));
    if (ne) previewEnts = [ne];
  } else if (cmdOp.name === 'scale' && cmdOp.step === 'new' && cmdOp.base && cmdOp.ref > 1e-9) {
    const f = Math.hypot(w.x - cmdOp.base.x, w.y - cmdOp.base.y) / cmdOp.ref;
    previewEnts = sel.map(e => cloneEntity(e));
    scaleEntities(previewEnts, cmdOp.base, f);
    setPrompt(`배율: ×${f.toFixed(3)} (클릭 또는 숫자 입력)`);
  } else if (cmdOp.name === 'stretch' && cmdOp.step === 'dest' && cmdOp.base && cmdOp.ents) {
    previewEnts = cmdOp.ents.map(e => cloneEntity(e));
    stretchEntities(previewEnts, cmdOp.box, w.x - cmdOp.base.x, w.y - cmdOp.base.y);
  } else if (cmdOp.name === 'dim' && cmdOp.step === 'pos' && cmdOp.p1 && cmdOp.p2) {
    previewEnts = computeDimension(cmdOp.p1, cmdOp.p2, w);
  } else if (cmdOp.name === 'dimang' && cmdOp.step === 'pos' && cmdOp.l1 && cmdOp.l2) {
    const r2 = computeAngularDim(cmdOp.l1, cmdOp.l2, w);
    if (r2) previewEnts = r2.list;
  } else if (cmdOp.name === 'dim' && cmdOp.step === 'cont' && cmdOp.p1) {
    const p1 = cmdOp.p1, dx = w.x - p1.x, dy = w.y - p1.y, L = Math.hypot(dx, dy);
    if (L > 1e-9) previewEnts = computeDimension(p1, w, { x: (p1.x + w.x) / 2 + (-dy / L) * cmdOp.h, y: (p1.y + w.y) / 2 + (dx / L) * cmdOp.h });
  } else if (cmdOp.name === 'dim' && cmdOp.step === 'p2' && cmdOp.p1) {
    previewEnts = [{ type: 'LINE', x1: cmdOp.p1.x, y1: cmdOp.p1.y, x2: w.x, y2: w.y }];
  } else if (cmdOp.name === 'leader' && cmdOp.step === 'p2' && cmdOp.p1) {
    previewEnts = [{ type: 'LINE', x1: cmdOp.p1.x, y1: cmdOp.p1.y, x2: w.x, y2: w.y }];
  } else if (cmdOp.name === 'dist' && cmdOp.step === 'p2' && cmdOp.p1) {
    previewEnts = [{ type: 'LINE', x1: cmdOp.p1.x, y1: cmdOp.p1.y, x2: w.x, y2: w.y }];
    setPrompt(`거리: ${fmtNum(Math.hypot(w.x - cmdOp.p1.x, w.y - cmdOp.p1.y))} (두 번째 점 클릭)`);
  }
}

// ============================================================
//  배열(ARRAY) 대화상자
// ============================================================
function openArrayDialog() {
  const dlg = document.getElementById('arrayDlg');
  dlg.style.display = 'flex';
  setPrompt('배열: 옵션을 설정하세요.');
}
function closeArrayDialog() { document.getElementById('arrayDlg').style.display = 'none'; }
(function bindArrayDialog() {
  const dlg = document.getElementById('arrayDlg');
  if (!dlg) return;
  dlg.querySelectorAll('input[name=arrMode]').forEach(r =>
    r.addEventListener('change', () => {
      const polar = dlg.querySelector('input[name=arrMode]:checked').value === 'polar';
      dlg.querySelector('#arrRect').style.display = polar ? 'none' : 'block';
      dlg.querySelector('#arrPolar').style.display = polar ? 'block' : 'none';
    }));
  document.getElementById('arrCancel').addEventListener('click', () => { closeArrayDialog(); cmdOp = null; setTool('select'); });
  document.getElementById('arrOk').addEventListener('click', () => {
    const mode = dlg.querySelector('input[name=arrMode]:checked').value;
    if (mode === 'rect') {
      const p = {
        rows: Math.max(1, parseInt(dlg.querySelector('#arrRows').value) || 1),
        cols: Math.max(1, parseInt(dlg.querySelector('#arrCols').value) || 1),
        rowSpace: parseFloat(dlg.querySelector('#arrRowSp').value) || 0,
        colSpace: parseFloat(dlg.querySelector('#arrColSp').value) || 0,
      };
      closeArrayDialog(); applyRectArray(p); cmdOp = null; setTool('select');
    } else {
      const p = {
        count: Math.max(2, parseInt(dlg.querySelector('#arrCount').value) || 2),
        total: parseFloat(dlg.querySelector('#arrAngle').value) || 360,
        fill: dlg.querySelector('#arrFill').checked,
      };
      closeArrayDialog();
      cmdOp = { name: 'array', step: 'center', params: p };
      setPrompt('원형 배열: 중심점을 클릭하세요.');
    }
  });
})();

// ============================================================
//  도구 / UI
// ============================================================
function setTool(t) {
  state.tool = t;
  if (t !== 'select' && t !== 'pan' && window.WEBCAD_API && WEBCAD_API.onUsage) WEBCAD_API.onUsage('tool:' + t);
  draft = null; pts = []; arcState = null; moveOp = null; dragSelect = null; toolPend = null;
  cmdOp = null; previewEnts = null; trackPt = null; otrackAlign = null;
  document.querySelectorAll('.tool').forEach(el => el.classList.toggle('active', el.dataset.tool === t));
  cv.style.cursor = (t === 'select') ? 'default' : (t === 'pan') ? 'grab' : 'crosshair';
  const b3c = document.getElementById('b3cv'); if (b3c) b3c.style.cursor = typeof cursor3D === 'function' ? cursor3D() : cv.style.cursor; // 3D 캔버스도 동일 규칙
  if (typeof v3 !== 'undefined' && v3) v3.line3d = null; // 도구 변경 시 3D 선 체인 종료
  const hints = {
    select: '선택 도구입니다. 도형을 클릭하거나 빈 영역을 드래그(왼→오 윈도우 / 오→왼 크로싱)하세요.',
    pan: '화면 이동(손 도구): 빈 화면을 드래그하면 화면이 이동합니다. 선택하려면 "선택" 도구로 바꾸세요.',
    line: '선: 점을 연속 클릭하면 이어서 그려집니다. 우클릭·Enter·Esc로 종료. (x,y / @dx,dy / 길이 입력 가능)',
    pline: '폴리라인: 점 연속 클릭(또는 x,y 입력), 빈 Enter로 완료.',
    spline: '자유곡선: 제어점을 연속 클릭하면 그 점들을 부드럽게 통과하는 곡선. 빈 Enter/우클릭으로 완료.',
    rect: '사각형: 첫 모서리 클릭/입력 후 크기 w,h(또는 한 변 길이) 입력 가능.',
    circle: '원: 중심 클릭/입력(x,y) 후 반지름 숫자를 명령행에 입력하세요.',
    arc: '호: 중심→시작→끝 클릭(또는 각 점을 x,y로 입력).',
    text: '문자: 위치를 클릭하면 입력창이 열립니다.',
    move: '이동: (도형 선택)→기준점→이동점 클릭. 또는 @dx,dy · x,y · 거리 입력.',
    erase: '지우기: 지울 도형을 클릭하세요.',
    offset: `오프셋: 도형을 선택하세요. (거리 ${offsetDist}, 숫자 입력으로 변경)`,
    copy: '복사: (도형 선택)→기준점 후, 붙일 위치 클릭 또는 @dx,dy · x,y · 거리 입력(반복).',
    mirror: '대칭: 도형을 선택하고 대칭축 두 점을 클릭하세요.',
    rotate: '회전: 도형을 선택하고 중심 지정 후, 각도(°) 입력 또는 클릭.',
    array: '배열: 도형을 선택하면 배열 설정 창이 열립니다.',
    trim: '자르기: 기준 객체들을 클릭하고 Space로 확정 → 걸치는 부분 클릭. (기준 없이 바로 Space=빠른 모드)',
    extend: '연장: 늘릴 선의 끝쪽을 클릭하면 가장 가까운 경계까지 연장됩니다.',
    fillet: `모깎기 R=${filletRadius}${filletRadius > 0 ? '(둥글게)' : '(뾰족한 코너)'} — 두 변(선·폴리라인)을 차례로 클릭. 둥글게 하려면 r 또는 숫자로 반지름 입력.`,
    scale: '배율: 도형을 선택하고 기준점 → 배율(숫자) 또는 참조 두 점을 지정하세요.',
    stretch: '신축: 걸침 영역의 두 모서리를 클릭하고, 기준점 → 이동점을 지정하세요.',
    polygon: `다각형: 변 개수(숫자, 현재 ${polygonSides}) 입력 → 중심 → 반지름/꼭짓점.`,
    ellipse: '타원: 중심 클릭 후 코너 클릭 또는 rx,ry 입력.',
    chamfer: `모따기: 거리 ${chamferDist}. 첫 선 → 둘째 선 클릭. (숫자로 거리 변경)`,
    dim: '치수: 첫 점 → 둘째 점 → 치수선 위치 클릭. (치수 레이어에 생성, 이후 클릭마다 연속 기입)',
    dimbase: '기준선 치수: 첫 점(기준) → 둘째 점 → 치수선 위치. 이후 클릭마다 같은 기준점에서 한 단씩 띄워 기입.',
    dist: '거리 측정: 두 점을 클릭하세요. (결과는 명령 기록에 표시)',
    area: '면적: 원/닫힌 폴리라인을 클릭하거나, 점들을 찍고 Enter로 계산.',
    insert: '블록 삽입: 삽입 위치를 클릭하세요. (레이어 패널 아래 목록에서 블록 선택)',
    matchprop: '속성 일치: 원본 도형을 클릭 → 속성을 적용할 대상들을 클릭. (레이어·색·선종류·선굵기 복사)',
    dimang: '각도 치수: 첫 선 → 둘째 선 → 호 위치 클릭.',
    leader: '지시선: 화살표 지점 → 문자 위치 클릭 → 문구 입력.',
    divide: `등분: 개수(숫자, 현재 ${divideCount}) 입력 후 선/폴리라인/원/호 클릭 → ✕ 표식 생성.`,
    measure: `간격 표식: 간격(숫자, 현재 ${measureStep}) 입력 후 대상 클릭 → 시작점부터 일정간격 ✕ 표식.`,
    dimrad: '반지름 치수: 원/호 클릭 → 문자 위치 클릭. (R값, 연속 기입)',
    dimdia: '지름 치수: 원/호 클릭 → 문자 위치 클릭. (⌀값, 연속 기입)',
    break: '끊기: 선/원/호 선택 → 끊기점 두 개 클릭. (사이 구간 제거)',
    lengthen: `길이조정: 증감량 ${lengthenDelta > 0 ? '+' : ''}${lengthenDelta}. 선의 조정할 끝쪽을 클릭하세요. (음수=줄이기)`,
    hatch: `해치: ${HATCH_PATTERNS[hatchPattern].ko}, 간격 ${hatchSpacing}. 경계 클릭. (숫자=간격, 패턴명 입력: ansi31·ansi37·steel·grid·brick·concrete·dots·solid)`,
    centerline: '중심선: 원/호를 클릭하면 십자 중심선이 그려집니다. (중심선 레이어, 일점쇄선)',
    revcloud: '구름마크: 영역의 첫 코너 → 반대 코너를 클릭하세요. (도면 검토 표시)',
    frame: '도곽: 배치할 좌하단 지점을 클릭하세요. (이후 용지·축척 입력)',
    align: '정렬: (도형 선택) → 원본1점 → 목표1점 → 원본2점 → 목표2점. 이동+회전(+배율).',
    xline: '구성선: 지나는 점 → 방향 점을 클릭하면 아주 긴 보조선이 그려집니다.',
    breakpt: '한 점 끊기: 선/원/호 클릭 → 끊을 지점을 클릭하면 그 점에서 둘로 나뉩니다.',
    door: '문: 벽(wall 지정된 선)에서 문 중심 위치를 클릭하세요. (이후 폭 입력)',
    section: '단면: 절단선의 첫 점을 클릭하세요. (선 → 바라볼 방향 순)',
    elevation: '입면: 기준선의 첫 점을 클릭하세요. (건물 바깥에 긋고 → 건물 쪽 클릭)',
    window: '창: 벽(wall 지정된 선)에서 창 중심 위치를 클릭하세요. (이후 폭 입력)',
  };
  setPrompt(hints[t] || '');
  // 값 옵션이 있는 도구는 cap on/off 와 같은 문법으로 — 명령창에 클릭 가능한 옵션 칩 + 키워드 입력 (2026-07-20)
  if (t === 'fillet') setPromptChoices('모깎기 — 두 변을 차례로 클릭 ·', [{ label: `r=${filletRadius}`, on: () => runCommandInput('r') }]);
  else if (t === 'chamfer') setPromptChoices('모따기 — 두 선을 차례로 클릭 ·', [{ label: `d=${chamferDist}`, on: () => runCommandInput('d') }]);
  if (t !== 'select') {
    logLine('▶ ' + (TOOL_KO[t] || t), 'cmd');
    // 도구 활성 즉시 치수 입력이 가능한 명령(offset·fillet 등)은 터치에서도 바로 포커스(키보드 표시).
    // 그 외에는 터치 시 키보드 팝업 방지를 위해 포커스 생략.
    const dimNow = typeof currentDimPrompt === 'function' && currentDimPrompt();
    if (cmdInputEl && (dimNow || !lastInputWasTouch)) cmdInputEl.focus({ preventScroll: true });
  }
  draw();
}
function hint(t) { hintEl.textContent = t; hintEl.style.display = t ? 'block' : 'none'; }

document.querySelectorAll('.tool').forEach(el =>
  el.addEventListener('click', () => {
    const t = el.dataset.tool;
    if (INSTANT_CMDS[t]) { logLine('▶ ' + (TOOL_KO[t] || t), 'cmd'); INSTANT_CMDS[t](); lastCommand = t; return; } // 분해·결합 등 즉시 실행
    setTool(t); if (t !== 'select') lastCommand = t;
  }));

// ── 레이어 색상 선택 팝오버: 고정 프리셋 + 최근 사용 5색 + 팔레트(네이티브 컬러 픽커) ──
const PRESET_COLORS = ['#ff0000', '#ff7f00', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ffffff', '#808080', '#000000'];
const RECENT_COLOR_KEY = 'webcad_recent_colors';
function readRecentColors() {
  try { const a = JSON.parse(localStorage.getItem(RECENT_COLOR_KEY) || '[]'); return Array.isArray(a) ? a.filter(c => /^#[0-9a-fA-F]{6}$/.test(c)) : []; } catch (e) { return []; }
}
function pushRecentColor(c) {
  c = rgbHex(c).toLowerCase();
  const a = readRecentColors().filter(x => x.toLowerCase() !== c);
  a.unshift(c);
  try { localStorage.setItem(RECENT_COLOR_KEY, JSON.stringify(a.slice(0, 5))); } catch (e) { }
}
function closeColorPop() {
  const p = document.getElementById('colorPop');
  if (p) { p.remove(); document.removeEventListener('pointerdown', colorPopOutside, true); }
}
function colorPopOutside(e) {
  const p = document.getElementById('colorPop');
  if (p && !p.contains(e.target)) closeColorPop();
}
function openColorPop(anchor, current, onPick) {
  closeColorPop();
  const cur = rgbHex(current).toLowerCase();
  const pop = document.createElement('div');
  pop.id = 'colorPop';
  const chip = (c) => `<span class="cp${c.toLowerCase() === cur ? ' on' : ''}" data-c="${c}" title="${c}" style="background:${c}"></span>`;
  const rec = readRecentColors();
  pop.innerHTML =
    `<div class="cpTtl">기본 색</div><div class="cpRow">${PRESET_COLORS.map(chip).join('')}</div>` +
    (rec.length ? `<div class="cpTtl">최근 사용</div><div class="cpRow">${rec.map(chip).join('')}</div>` : '') +
    `<button class="cpPal" type="button">🎨 팔레트에서 선택…</button>`;
  document.body.appendChild(pop);
  popupDrag(pop, pop.querySelector('.cpTtl'));
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left)) + 'px';
  pop.style.top = Math.min(window.innerHeight - pop.offsetHeight - 8, r.bottom + 6) + 'px';
  pop.querySelectorAll('.cp').forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation(); onPick(el.dataset.c); closeColorPop();
  }));
  pop.querySelector('.cpPal').addEventListener('click', (e) => {
    e.stopPropagation();
    const inp = document.createElement('input'); inp.type = 'color'; inp.value = cur;
    inp.addEventListener('input', () => onPick(inp.value));
    inp.addEventListener('change', () => { pushRecentColor(inp.value); closeColorPop(); });
    inp.click();
  });
  setTimeout(() => document.addEventListener('pointerdown', colorPopOutside, true), 0);
}

// 레이어 목록 렌더
// 광원 목록 패널 — 행 클릭=개체 선택, 체크박스=on/off, 솔로=이 광원만 (등기구 하나씩 검토)
function renderLightList() {
  // 광원이 바뀌는 모든 경로(지정·해제·on/off·솔로·특성 편집)가 이 함수를 거친다 →
  // Raytraced 갱신을 여기 한 곳에만 걸면 빠짐이 없다. 형상이 그대로면 BVH는 다시 만들지 않는다.
  if (rt.on) rtLightsChanged();
  for (const S of state.sensors) { S.vals = null; S.stats = null; }  // 광원이 바뀌면 조도를 다시 잰다
  const list = document.getElementById('lightList');
  if (!list) return;
  list.innerHTML = '';
  if (!state.lights.length) {
    list.innerHTML = '<div class="empty" style="font-size:11.5px;opacity:.6;padding:4px 2px;">광원이 없습니다. 개체를 선택하고 <b>setaslight</b>.</div>';
    return;
  }
  const byId = new Map(state.entities.map(e => [e.id, e]));
  for (const L of state.lights) {
    const e = byId.get(L.objectId);
    const c = lightColorRGB(L);
    const solo = soloLightId === L.id;
    const dim = !L.enabled || (soloLightId && !solo);
    const div = document.createElement('div');
    div.className = 'layer' + (e && state.selection.has(e.id) ? ' active' : '');
    div.style.opacity = dim ? '0.45' : '1';
    div.innerHTML =
      `<div class="lrow1">
        <input type="checkbox" ${L.enabled ? 'checked' : ''} title="켜짐/꺼짐" style="margin:0 2px 0 0;">
        <span class="sw" style="background:rgb(${c[0]},${c[1]},${c[2]})"></span>
        <span class="nm">${escapeHtml(L.name || L.id)}${e ? '' : ' ⚠'}</span>
        <span class="eye" title="이 광원만 보기(솔로)" style="${solo ? 'color:var(--warn);' : ''}">${solo ? '◉' : '○'}</span>
       </div>
       <div class="lrow2" style="font-size:10.5px;opacity:.65;">${L.intensity}lm · ${L.colorTemp}K · ${LIGHT_TYPE_KO[L.type] || L.type}</div>`;
    div.querySelector('input').addEventListener('click', ev => {
      ev.stopPropagation();
      pushUndo(); L.enabled = ev.target.checked; renderLightList(); renderProps(); draw(); boolRefresh();
    });
    div.querySelector('.eye').addEventListener('click', ev => {
      ev.stopPropagation();
      soloLightId = solo ? null : L.id;   // 표시 상태이므로 undo 대상이 아니다
      renderLightList(); draw(); boolRefresh();
    });
    div.addEventListener('click', () => {
      if (!e) { logLine(`  ⚠ "${L.name}" — 연결된 개체를 찾을 수 없습니다`, 'warn'); return; }
      state.selection.clear(); state.selection.add(e.id);
      renderLightList(); renderProps(); draw();
    });
    list.appendChild(div);
  }
}
// 레이어 행의 잠금·표시 아이콘 — 이모지 대신 도구창과 같은 라인 아이콘 (Beyond UI 통일)
const LAYIC = {
  lock:   '<svg class="ic" viewBox="0 0 24 24"><rect x="5.5" y="11" width="13" height="8.5" rx="2"/><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/></svg>',
  unlock: '<svg class="ic" viewBox="0 0 24 24"><rect x="5.5" y="11" width="13" height="8.5" rx="2"/><path d="M8.5 11V8a3.5 3.5 0 0 1 6.8-1.2"/></svg>',
  eye:    '<svg class="ic" viewBox="0 0 24 24"><path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/></svg>',
  eyeOff: '<svg class="ic" viewBox="0 0 24 24"><path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/><line x1="4.5" y1="4.5" x2="19.5" y2="19.5"/></svg>',
  plot:    '<svg class="ic" viewBox="0 0 24 24"><path d="M7 9V4h10v5"/><path d="M7 18H5a1 1 0 0 1-1-1v-5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5a1 1 0 0 1-1 1h-2"/><rect x="7" y="15" width="10" height="5" rx="1"/></svg>',
  plotOff: '<svg class="ic" viewBox="0 0 24 24"><path d="M7 9V4h10v5"/><path d="M7 18H5a1 1 0 0 1-1-1v-5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5a1 1 0 0 1-1 1h-2"/><rect x="7" y="15" width="10" height="5" rx="1"/><line x1="4.5" y1="4.5" x2="19.5" y2="19.5"/></svg>',
};
// 건물화 역할 선택지 — 레이어 속성으로 명시 지정(자동 = 이름·모양 판정). bimify.js 가 최우선 참조.
const LAYER_ROLE_OPTS = [['', '자동'], ['wall', '벽'], ['column', '기둥'], ['slab', '슬래브'], ['door', '문'], ['window', '창'], ['furniture', '가구'], ['ignore', '제외']];
function renderLayers() {
  const list = document.getElementById('layerList');
  list.innerHTML = '';
  for (const l of state.layers) {
    const div = document.createElement('div');
    div.className = 'layer' + (l.name === state.currentLayer ? ' active' : '');
    // 행은 5요소만 — 색·이름·인쇄·잠금·눈. 선종류/재질/역할 등 세부는 옵션 → 레이어 설정에서 (2026-07-25 요청)
    div.innerHTML =
      `<div class="lrow1">
        <span class="sw" style="background:${l.color}"></span>
        <span class="nm">${escapeHtml(l.name)}</span>
        <span class="plt${l.noplot ? ' off' : ''}" title="인쇄·내보내기 포함/제외 — 끄면 화면엔 보이되 플롯 PDF·SVG·PNG 에서 빠집니다">${l.noplot ? LAYIC.plotOff : LAYIC.plot}</span>
        <span class="lk${l.locked ? ' on' : ''}" title="잠금(수정 불가)">${l.locked ? LAYIC.lock : LAYIC.unlock}</span>
        <span class="eye${l.visible ? '' : ' off'}" title="표시/숨김">${l.visible ? LAYIC.eye : LAYIC.eyeOff}</span>
       </div>`;
    div.addEventListener('contextmenu', (e) => { // 우클릭: 선택한 객체를 이 레이어로 이동 (라이노식)
      e.preventDefault(); e.stopPropagation();
      const sel = [...state.selection].map(id => state.entities.find(en => en.id === id)).filter(Boolean);
      if (!sel.length) { logLine('  레이어 이동: 먼저 객체를 선택한 뒤 대상 레이어를 우클릭하세요.', 'warn'); return; }
      if (!confirm(`선택한 개체 ${sel.length}개를 '${l.name}' 레이어로 바꾸겠습니까?`)) return;
      pushUndo();
      for (const en of sel) { en.layer = l.name; applyLayerRoleTo(en); } // 역할 레이어로 옮기면 BIM 도 따라감
      logLine(`  ✔ 선택 ${sel.length}개 객체를 '${l.name}' 레이어로 이동`, 'ok');
      renderProps(); renderLayers(); draw();
      if (typeof v3 !== 'undefined' && v3 && document.getElementById('bim3d') && document.getElementById('bim3d').style.display !== 'none') { v3.solids = bimSolids(); render3D(); }
    });
    div.querySelector('.sw').addEventListener('click', (e) => {
      e.stopPropagation();
      openColorPop(e.currentTarget, l.color, (c) => {
        l.color = c; renderLayers(); draw();
        if (typeof v3 !== 'undefined' && v3 && document.getElementById('bim3d') && document.getElementById('bim3d').style.display !== 'none') { v3.solids = bimSolids(); render3D(); }
      });
    });
    div.querySelector('.eye').addEventListener('click', (e) => {
      // ★레이어 표시/숨김은 3D 에도 즉시 반영되어야 한다 — bimSolids 가 숨은 레이어를 걸러내지만
      //   v3.solids 는 캐시라 다시 만들지 않으면 3D 에 그대로 남는다(2026-07-20 사용자 보고).
      e.stopPropagation(); l.visible = !l.visible; renderLayers(); propRefresh();
    });
    div.querySelector('.lk').addEventListener('click', (e) => {
      e.stopPropagation(); l.locked = !l.locked;
      if (l.locked) { state.entities.forEach(en => { if (en.layer === l.name) state.selection.delete(en.id); }); renderProps(); }
      renderLayers(); propRefresh();   // 잠금 시 선택 해제가 3D 강조에도 반영되게
    });
    div.querySelector('.plt').addEventListener('click', (e) => {
      e.stopPropagation(); l.noplot = !l.noplot; renderLayers();   // 출력 시점에만 걸러지므로 재렌더 불필요
    });
    div.querySelector('.nm').addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const nn = prompt('레이어 이름:', l.name);
      if (nn && nn !== l.name && !getLayer(nn)) {
        state.entities.forEach(en => { if (en.layer === l.name) en.layer = nn; });
        if (state.currentLayer === l.name) state.currentLayer = nn;
        l.name = nn; renderLayers(); draw();
      }
    });
    div.addEventListener('click', () => { if (lyDragged) return; state.currentLayer = l.name; renderLayers(); });
    div.dataset.ly = l.name;   // 드래그 재정렬이 행↔레이어를 잇는 키
    list.appendChild(div);
  }
}
// ─── 레이어 순서 드래그 (도구막대와 같은 규약: 6px 이동부터 드래그, 제자리 클릭은 레이어 선택) ───
let lyDrag = null, lyDragged = false;
{
  const list = document.getElementById('layerList');
  // 행 히트테스트는 좌표 계산으로 — elementFromPoint 는 패널이 접히거나(오프스크린) 위에 뭔가
  // 덮이면 null 을 반환해 드래그가 조용히 죽는다. 세로 위치만 보면 되므로 rect 순회가 정확하고 견고하다.
  const rowAt = (x, y) => {
    for (const r of list.querySelectorAll('.layer')) {
      const b = r.getBoundingClientRect();
      if (y >= b.top && y <= b.bottom) return r;
    }
    return null;
  };
  list.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.sw,.eye,.lk,.plt')) return;   // 토글·색 스와치는 자기 동작
    const row = e.target.closest('.layer');
    if (row) lyDrag = { row, x: e.clientX, y: e.clientY, on: false };
  });
  list.addEventListener('pointermove', (e) => {
    if (!lyDrag) return;
    if (!lyDrag.on) {
      if (Math.hypot(e.clientX - lyDrag.x, e.clientY - lyDrag.y) <= 6) return;
      lyDrag.on = true; lyDrag.row.classList.add('lyDragging');
      pushUndo();   // ★순서를 바꾸기 '전' 상태를 스냅샷 — 끝난 뒤 부르면 되돌려도 바뀐 순서가 남는다
      try { list.setPointerCapture(e.pointerId); } catch (_) {}
    }
    const over = rowAt(e.clientX, e.clientY);
    for (const r of list.querySelectorAll('.lyOver')) r.classList.remove('lyOver');
    if (!over || over === lyDrag.row) return;
    over.classList.add('lyOver');
    const from = state.layers.findIndex(x => x.name === lyDrag.row.dataset.ly);
    const to = state.layers.findIndex(x => x.name === over.dataset.ly);
    if (from < 0 || to < 0) return;
    const [mv] = state.layers.splice(from, 1);
    state.layers.splice(to, 0, mv);                      // 실시간 미리보기 = 최종 결과와 동일
    const keep = lyDrag.row.dataset.ly;
    renderLayers();
    lyDrag.row = list.querySelector(`.layer[data-ly="${CSS.escape(keep)}"]`);
    if (lyDrag.row) lyDrag.row.classList.add('lyDragging');
  });
  const lyEnd = () => {
    if (!lyDrag) return;
    if (lyDrag.on) {
      lyDragged = true; setTimeout(() => { lyDragged = false; }, 0);   // 직후 click 1회만 차단
      renderLayers(); draw();
    }
    for (const r of document.querySelectorAll('#layerList .lyOver,#layerList .lyDragging')) r.classList.remove('lyOver', 'lyDragging');
    lyDrag = null;
  };
  list.addEventListener('pointerup', lyEnd);
  list.addEventListener('pointercancel', lyEnd);
}

// ─── 레이어 설정 팝업 (옵션 메뉴) — 행에서 뺀 세부 속성(선·재질·역할·단면·창호·높이/두께) 편집 ───
let layerCfgEl = null;
function layerCfgForm(l) {
  const ltOpts = Object.keys(LINETYPES).map(k => `<option value="${k}" ${(l.linetype || 'continuous') === k ? 'selected' : ''}>${LINETYPE_KO[k]}</option>`).join('');
  const matOpts = ['<option value="">재질 없음</option>']
    .concat(Object.keys(state.matlib || {}).map(k => `<option value="${MAT_LIB_PREFIX}${escapeHtml(k)}" ${l.mat === MAT_LIB_PREFIX + k ? 'selected' : ''}>${escapeHtml(k)}</option>`))
    .concat(Object.keys(MAT_PRESETS).map(k => `<option value="${k}" ${l.mat === k ? 'selected' : ''}>${MAT_PRESETS[k].ko}</option>`)).join('');
  const secOpts = [['', '자동(재질 따름)'], ['none', '해치 없음'], ['concrete', '콘크리트'], ['ansi31', '사선(벽돌·목재·지반)'], ['ansi37', '콘크리트블럭'], ['steel', '강재'], ['insul', '단열재'], ['rubble', '잡석'], ['xbox', '목구조재'], ['dots', '모르타르·모래'], ['grid', '타일'], ['solid', '단색']]
    .map(([v, t]) => `<option value="${v}" ${(l.secHatch || '') === v ? 'selected' : ''}>${t}</option>`).join('');
  const wtOpts = '<option value="">자동</option>'
    + `<optgroup label="문">${OPENING_TYPES.door.map(([v, t]) => `<option value="${v}" ${l.defWt === v ? 'selected' : ''}>${t}</option>`).join('')}</optgroup>`
    + `<optgroup label="창">${OPENING_TYPES.window.map(([v, t]) => `<option value="${v}" ${l.defWt === v ? 'selected' : ''}>${t}</option>`).join('')}</optgroup>`
    + (Object.keys(state.owlib || {}).length ? `<optgroup label="내 기호">${Object.keys(state.owlib).map(n2 => `<option value="@${escapeHtml(n2)}" ${l.defWt === '@' + n2 ? 'selected' : ''}>@${escapeHtml(n2)}</option>`).join('')}</optgroup>` : '');
  return `
    <label>선종류</label><select id="lcLt">${ltOpts}</select>
    <label>선굵기</label><select id="lcLw">${[['', '기본'], ['0', '가는'], ['25', '0.25'], ['50', '0.50'], ['70', '0.70'], ['100', '1.00'], ['200', '2.00']]
      .map(([v, t]) => `<option value="${v}" ${String(l.lineweight ?? '') === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <label>재질</label><select id="lcMat" title="이 레이어의 srf·솔리드가 자동으로 입는 재질 (개체 직접 지정이 우선)">${matOpts}</select>
    <label>단면재료</label><select id="lcSec" title="단면을 자르면 절단면에 자동으로 채워지는 KS 재료 해치">${secOpts}</select>
    <label>역할</label><select id="lcRole" title="이 레이어에 그리면 즉시 생성되는 모델 (벽·기둥·슬래브·문·창)">${LAYER_ROLE_OPTS.map(([v, t]) => `<option value="${v}" ${(l.role || '') === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <label>창호</label><select id="lcWt" title="이 레이어 문/창의 기본 표시기호">${wtOpts}</select>
    <label>높이(mm)</label><input id="lcH" type="number" min="0" step="50" placeholder="기본 2400" value="${l.defH ?? ''}">
    <label>두께(mm)</label><input id="lcT" type="number" min="0" step="10" placeholder="기본 200" value="${l.defT ?? ''}">`;
}
function openLayerCfg(selName) {
  if (!layerCfgEl) {
    layerCfgEl = document.createElement('div');
    layerCfgEl.id = 'layerCfgDlg';
    layerCfgEl.style.cssText = 'position:absolute;left:50%;top:64px;transform:translateX(-50%);z-index:41;display:none;';
    const host = document.getElementById('uiEditDlg');
    (host ? host.parentElement : document.body).appendChild(layerCfgEl);
  }
  const cur = getLayer(selName) || getLayer(state.currentLayer) || state.layers[0];
  layerCfgEl.innerHTML = `
    <div class="dlgBox" style="width:340px;max-width:92vw;padding:0;overflow:hidden;display:flex;flex-direction:column;">
      <div id="lcHead" style="display:flex;align-items:center;gap:10px;padding:14px 16px 10px;cursor:move;">
        <svg class="ic" style="width:17px;height:17px;color:var(--accent-text);" viewBox="0 0 24 24"><path d="M12 3l8 4.5-8 4.5-8-4.5z"/><path d="M4 12l8 4.5 8-4.5"/><path d="M4 16.5L12 21l8-4.5"/></svg>
        <span style="font-size:15px;font-weight:650;letter-spacing:-0.01em;flex:1;">레이어 설정</span>
        <button id="lcClose" style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;background:transparent;border:none;color:var(--muted);cursor:pointer;border-radius:var(--radius-sm);"><svg class="ic" style="width:15px;height:15px;" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
      <div style="padding:0 16px 16px;display:flex;flex-direction:column;gap:9px;">
        <select id="lcLayer" style="font-weight:600;">${state.layers.map(x => `<option value="${escapeHtml(x.name)}" ${x.name === cur.name ? 'selected' : ''}>${escapeHtml(x.name)}</option>`).join('')}</select>
        <div id="lcGrid" style="display:grid;grid-template-columns:64px 1fr;gap:7px 9px;align-items:center;font-size:12.5px;color:var(--muted);">${layerCfgForm(cur)}</div>
        <div class="dlgHint" style="font-size:11.5px;">변경은 즉시 적용·저장됩니다. 역할·높이·두께는 이 레이어의 자동 생성 모델에 곧바로 반영됩니다.</div>
      </div>
    </div>`;
  layerCfgEl.style.display = 'block';
  if (window.webcadPopupDrag) window.webcadPopupDrag(layerCfgEl, layerCfgEl.querySelector('#lcHead'));
  layerCfgEl.querySelector('#lcClose').addEventListener('click', () => { layerCfgEl.style.display = 'none'; });
  const L = () => getLayer(layerCfgEl.querySelector('#lcLayer').value) || cur;
  layerCfgEl.querySelector('#lcLayer').addEventListener('change', () => { layerCfgEl.querySelector('#lcGrid').innerHTML = layerCfgForm(L()); wire(); });
  const wire = () => {
    const $ = (id) => layerCfgEl.querySelector('#' + id);
    $('lcLt').addEventListener('change', (e) => { L().linetype = e.target.value; draw(); });
    $('lcLw').addEventListener('change', (e) => { L().lineweight = e.target.value === '' ? undefined : parseInt(e.target.value, 10); draw(); });
    $('lcMat').addEventListener('change', (e) => { pushUndo(); L().mat = e.target.value || undefined; propRefresh(); });
    $('lcSec').addEventListener('change', (e) => { pushUndo(); L().secHatch = e.target.value || undefined; });
    $('lcWt').addEventListener('change', (e) => { pushUndo(); L().defWt = e.target.value || undefined; draw(); });
    $('lcRole').addEventListener('change', (e) => {
      pushUndo(); const l = L(); l.role = e.target.value || undefined;
      let nA = 0;
      for (const en of state.entities) if (en.layer === l.name && (!en.bim || en.bim.auto)) { applyLayerRoleTo(en); if (en.bim) nA++; }
      logLine(`  레이어 "${l.name}" 역할 ${l.role ? LAYER_ROLE_OPTS.find(o2 => o2[0] === l.role)[1] + ' 지정' : '해제'} — 기존 도형 ${nA}개 반영`, 'info');
      propRefresh();
    });
    $('lcH').addEventListener('change', (e) => {
      pushUndo(); const l = L(); const v = parseFloat(e.target.value); l.defH = (isFinite(v) && v > 0) ? v : undefined;
      for (const en of state.entities) if (en.layer === l.name && en.bim && en.bim.auto) layerAutoBim(en, l);
      propRefresh();
    });
    $('lcT').addEventListener('change', (e) => {
      pushUndo(); const l = L(); const v = parseFloat(e.target.value); l.defT = (isFinite(v) && v > 0) ? v : undefined;
      for (const en of state.entities) if (en.layer === l.name && en.bim && en.bim.auto) layerAutoBim(en, l);
      propRefresh();
    });
  };
  wire();
}
document.getElementById('moLayerCfg')?.addEventListener('click', () => { document.getElementById('optMenu').classList.remove('open'); openLayerCfg(state.currentLayer); });
// 레이어 목록 저장/불러오기 — 로그인 상태면 cloud.js 의 슬롯 다이얼로그, 아니면 파일로
document.getElementById('btnLayTplSave').addEventListener('click', () => { if (window.PARTI_LAYERTPL) PARTI_LAYERTPL.save(); else exportLayersTpl(); });
document.getElementById('btnLayTplLoad').addEventListener('click', () => { if (window.PARTI_LAYERTPL) PARTI_LAYERTPL.load(); else importLayersTplFile(); });
document.getElementById('blkScale').addEventListener('change', e => { insertScale = parseFloat(e.target.value) || 1; });
document.getElementById('blkRot').addEventListener('change', e => { insertRot = parseFloat(e.target.value) || 0; });
// ─── 태양 패널 ───
// 시각 슬라이더를 끌면 그림자가 실시간으로 돈다 — 이게 없으면 태양이 있어도 확인할 방법이 없다.
// 드래그 중에는 pushUndo 를 부르지 않는다(슬라이더 한 번에 스냅샷 수백 개가 쌓인다) —
// 광원 속성 패널과 같은 모델: pointerdown 에서 한 번만.
function renderSunPanel() {
  const S = sunState();
  const $ = (id) => document.getElementById(id);
  const on = $('sunOn'); if (!on) return;                 // 패널이 없는 빌드
  if (document.activeElement !== on) on.checked = !!S.enabled;
  const body = $('sunBody'); if (body) body.style.opacity = S.enabled ? '1' : '0.45';
  const p = solarPosition(S);
  const set = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v; };
  set('sunDate', `${S.y}-${String(S.mo).padStart(2, '0')}-${String(S.d).padStart(2, '0')}`);
  set('sunTime', S.h * 60 + S.mi);
  set('sunNorth', S.north);
  set('sunTurb', skyTurbidity(S));
  set('sunLat', S.lat); set('sunLon', S.lon); set('sunTz', S.tz / 60);
  const t = $('sunTimeTxt'); if (t) t.textContent = `${String(S.h).padStart(2, '0')}:${String(S.mi).padStart(2, '0')}`;
  const nt = $('sunNorthTxt'); if (nt) nt.textContent = S.north + '°';
  const tt = $('sunTurbTxt'); if (tt) tt.textContent = skyTurbidity(S).toFixed(1);
  set('sunCloud', Math.round(skyCloud(S) * 100));
  const ct = $('sunCloudTxt'); if (ct) ct.textContent = Math.round(skyCloud(S) * 100) + '%';
  const wx = $('sunWeather');
  if (wx) {
    const cc = skyCloud(S);
    // 흐릴수록 직달은 줄고 확산(하늘)은 는다 — 숫자로 보여줘야 '왜 그림자가 없지?' 가 풀린다
    wx.textContent = p.alt > 0
      ? `${weatherName(cc)} · 직달 ${Math.round(sunDirectIlluminance(S)).toLocaleString()} lx · 천공 ${Math.round(skyCtx(S).Ed).toLocaleString()} lx`
      : weatherName(cc);
  }
  const al = $('sunAlt');
  if (al) al.textContent = S.enabled ? (p.alt > 0 ? `고도 ${p.alt.toFixed(1)}°` : '지평선 아래') : '';
  const info = $('sunInfo');
  if (info) {
    const n = sunNoonMinutes(S);
    const noon = `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(Math.round(n % 60)).padStart(2, '0')}`;
    info.innerHTML = p.alt > 0
      ? `고도 <b>${p.alt.toFixed(1)}°</b> · 방위 <b>${p.az.toFixed(0)}°</b><br>직달 <b>${Math.round(sunDirectIlluminance(S)).toLocaleString()} lx</b> · 남중 ${noon}`
      : `해가 지평선 아래입니다 (고도 ${p.alt.toFixed(1)}°)<br>남중 ${noon} — 시각을 낮으로 옮기세요`;
  }
}
{
  const S = () => sunState();
  const $ = (id) => document.getElementById(id);
  let dragged = false;
  const startEdit = () => { if (!dragged) { dragged = true; pushUndo(); } };
  const endEdit = () => { dragged = false; };
  $('sunOn')?.addEventListener('change', (e) => {
    pushUndo(); S().enabled = e.target.checked; sunApply();
    logLine(e.target.checked ? `  ☀ 태양 ON — ${sunSummary()}` : '  ☀ 태양 OFF', 'info');
  });
  const live = (id, apply) => {
    const el = $(id); if (!el) return;
    el.addEventListener('pointerdown', startEdit);
    // markInteract: 드래그 중엔 그림자·하늘 재굽기를 미루고, 멈추면 정밀 렌더로 다시 그린다.
    // 안 걸면 시각/운량 슬라이더가 매 스텝 하늘을 굽느라 6fps 로 기어간다 (실측).
    el.addEventListener('input', () => { startEdit(); markInteract(); apply(el.value); sunApply(); });
    el.addEventListener('change', () => { apply(el.value); sunApply(); endEdit(); });
    el.addEventListener('pointerup', endEdit);
    el.addEventListener('lostpointercapture', endEdit);   // 패널 밖에서 손을 뗀 경우
  };
  live('sunTime', v => { const m = Math.max(0, Math.min(1439, +v)); S().h = Math.floor(m / 60); S().mi = m % 60; });
  live('sunNorth', v => { S().north = sunMod(+v, 360); });
  live('sunTurb', v => { S().turbidity = Math.min(SKY_TURBIDITY_MAX, Math.max(SKY_TURBIDITY_MIN, +v)); });
  live('sunCloud', v => { S().cloud = Math.min(100, Math.max(0, +v)); });
  // 날씨 프리셋 — 슬라이더를 정확한 숫자에 맞추기 어려우니 한 번에
  for (const b of document.querySelectorAll('[data-cloud]')) {
    b.addEventListener('click', () => {
      pushUndo();
      S().cloud = +b.dataset.cloud;
      if (!S().enabled) S().enabled = true;   // 날씨를 고르는 건 '해를 켜겠다'는 뜻이다
      sunApply();
      logLine(`  ☁ ${weatherName(skyCloud(S()))} (운량 ${S().cloud}%) — ${sunSummary()}`, 'info');
    });
  }
  $('sunDate')?.addEventListener('change', (e) => {
    const t = (e.target.value || '').split('-');
    if (t.length !== 3) return;
    pushUndo();
    S().y = +t[0] || S().y; S().mo = +t[1] || S().mo; S().d = +t[2] || S().d;
    sunApply();
  });
  for (const [id, key, min, max] of [['sunLat', 'lat', -90, 90], ['sunLon', 'lon', -180, 180]]) {
    $(id)?.addEventListener('change', (e) => {
      const v = parseFloat(e.target.value); if (!isFinite(v)) return;
      pushUndo(); S()[key] = Math.min(max, Math.max(min, v)); sunApply();
    });
  }
  $('sunTz')?.addEventListener('change', (e) => {
    const v = parseFloat(e.target.value); if (!isFinite(v)) return;
    pushUndo(); S().tz = Math.round(Math.min(14, Math.max(-12, v)) * 60); sunApply();
  });
  $('btnSunNoon')?.addEventListener('click', () => {
    pushUndo();
    const n = sunNoonMinutes(S()); S().h = Math.floor(n / 60); S().mi = Math.round(n % 60);
    sunApply(); logLine(`  ☀ 남중으로 — ${sunSummary()}`, 'ok');
  });
  $('btnSunHere')?.addEventListener('click', () => {
    if (!navigator.geolocation) { logLine('  이 브라우저는 위치 정보를 지원하지 않습니다.', 'warn'); return; }
    logLine('  위치를 가져오는 중…', 'info');
    navigator.geolocation.getCurrentPosition((pos) => {
      pushUndo();
      S().lat = +pos.coords.latitude.toFixed(4); S().lon = +pos.coords.longitude.toFixed(4);
      S().tz = -new Date().getTimezoneOffset();
      sunApply(); logLine(`  ☀ 현재 위치 ${S().lat}, ${S().lon} (UTC${S().tz >= 0 ? '+' : ''}${S().tz / 60})`, 'ok');
    }, () => logLine('  위치를 가져오지 못했습니다 — 위도·경도를 직접 입력하세요.', 'warn'));
  });
}
renderSunPanel();   // 시작 시 패널을 현재 태양 상태로 채운다
document.getElementById('btnSetAsLight')?.addEventListener('click', cmdSetAsLight);
document.getElementById('btnFalseColor')?.addEventListener('click', cmdFalseColor);
document.getElementById('btnFcMax')?.addEventListener('click', cmdFcMax);
document.getElementById('btnAddSensor')?.addEventListener('click', cmdAddSensorPlane);
document.getElementById('btnSensorCSV')?.addEventListener('click', cmdSensorCSV);
document.getElementById('btnSoloOff')?.addEventListener('click', () => { soloLightId = null; renderLightList(); draw(); boolRefresh(); });
document.getElementById('btnAddLayer').addEventListener('click', () => {
  let i = state.layers.length, name;
  do { name = 'Layer' + i++; } while (getLayer(name));
  const colors = ['#ff5d5d', '#5dff8f', '#5d9dff', '#ffd65d', '#d65dff', '#5dffff'];
  ensureLayer(name, colors[state.layers.length % colors.length]);
  state.currentLayer = name; renderLayers();
});
document.getElementById('btnDelLayer').addEventListener('click', () => {
  if (state.currentLayer === '0') { alert("기본 레이어 '0'은 삭제할 수 없습니다."); return; }
  if (state.entities.some(e => e.layer === state.currentLayer)) {
    if (!confirm('이 레이어의 도형도 함께 삭제됩니다. 계속할까요?')) return;
    pushUndo();
    state.entities = state.entities.filter(e => e.layer !== state.currentLayer);
  }
  state.layers = state.layers.filter(l => l.name !== state.currentLayer);
  state.currentLayer = '0'; renderLayers(); draw(); updateStat();
});

// 속성 패널
// 광원 편집기 마크업 — 단일 선택과 다중 선택이 같은 코드를 쓴다.
// (다중 선택 패널에 이게 없으면 "등기구 6개를 골라 색온도를 한 번에 드래그"가 불가능하다 — §3.1/§5-4)
function lightPropRows(LT, multi) {
  let rows = '';
  const kc = lightColorRGB(LT);
  // 색온도 슬라이더 바탕에 실제 색 그라데이션을 깔아, 숫자를 몰라도 따뜻함/차가움이 보이게 한다
  const kGrad = [1800, 2200, 2700, 3000, 4000, 5000, 6500, 8000, 10000]
    .map(k => { const c = kelvinToRGB(k); return `rgb(${c[0]},${c[1]},${c[2]}) ${Math.round((k - 1800) / 8200 * 100)}%`; }).join(',');
  const SL = 'flex:1;min-width:0;';
  const NUM = 'width:62px;flex:none;';
  rows += `<div class="row" style="margin-top:8px;"><label style="color:var(--accent-text);">광원</label>
    <label style="display:flex;align-items:center;gap:5px;font-weight:590;">
      <input type="checkbox" data-lon ${LT.enabled ? 'checked' : ''}>켜짐</label>
    ${multi ? `<span style="font-size:11px;opacity:.6;">${multi}개 일괄</span>` : ''}</div>`;
  // 세기: 100~20,000 lm 로그 스케일 (낮은 쪽 분해능을 살리려면 선형으로는 안 된다)
  rows += `<div class="row"><label>세기</label>
    <input type="range" data-ls="intensity" min="2" max="4.301" step="0.001" value="${Math.log10(Math.max(100, LT.intensity))}" style="${SL}">
    <input type="number" step="10" min="100" max="20000" data-lk="intensity" value="${Math.round(LT.intensity)}" style="${NUM}">
    <span style="font-size:11px;opacity:.6;">lm</span></div>`;
  rows += `<div class="row"><label>색온도</label>
    <input type="range" data-ls="colorTemp" min="1800" max="10000" step="50" value="${LT.colorTemp}"
      style="${SL}background:linear-gradient(90deg,${kGrad});border-radius:980px;height:14px;">
    <input type="number" step="50" min="1800" max="10000" data-lk="colorTemp" value="${LT.colorTemp}" style="${NUM}">
    <span style="font-size:11px;opacity:.6;">K</span></div>`;
  rows += `<div class="row"><label>색</label><span style="flex:1;height:14px;border-radius:4px;background:rgb(${kc[0]},${kc[1]},${kc[2]});"></span>
    <button class="miniBtn" id="pLightCustom">${LT.color ? '색온도로' : '커스텀 색'}</button></div>`;
  if (LT.color) rows += `<div class="row"><label></label><input type="color" id="pLightColor" value="${rgbHex('rgb(' + LT.color.join(',') + ')')}"></div>`;
  rows += `<div class="row"><label>타입</label><select data-ltype style="flex:1;">` +
    LIGHT_TYPES.map(t => `<option value="${t}" ${LT.type === t ? 'selected' : ''}>${LIGHT_TYPE_KO[t]}</option>`).join('') + `</select></div>`;
  if (LT.type === 'spot') {
    rows += `<div class="row"><label>스팟 각도</label>
      <input type="range" data-ls="spotAngleDeg" min="5" max="120" step="1" value="${LT.spotAngleDeg}" style="${SL}">
      <input type="number" step="1" min="5" max="120" data-lk="spotAngleDeg" value="${LT.spotAngleDeg}" style="${NUM}">
      <span style="font-size:11px;opacity:.6;">°</span></div>`;
    rows += `<div class="row"><label>페넘브라</label>
      <input type="range" data-ls="spotPenumbra" min="0" max="1" step="0.01" value="${LT.spotPenumbra}" style="${SL}">
      <input type="number" step="0.05" min="0" max="1" data-lk="spotPenumbra" value="${LT.spotPenumbra}" style="${NUM}"></div>`;
  }
  rows += `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:5px;">` +
    LIGHT_PRESETS.map((p, i) => `<button class="miniBtn" data-lpre="${i}" title="${p.intensity}lm / ${p.colorTemp}K">${p.n}</button>`).join('') + `</div>`;
  rows += `<details style="margin-top:6px;"><summary style="font-size:11px;opacity:.6;cursor:pointer;">고급 (소프트웨어 렌더러 전용 — Raytraced에는 쓰이지 않음)</summary>`;
  for (const [k, lab] of [['range', '빛 도달거리'], ['soft', '그림자 부드러움(0=선명)'], ['bounce', '간접광 세기(0=끔)'], ['spacing', '발광 지점 간격(선·폴리라인)']])
    rows += `<div class="row"><label>${lab}</label><input type="number" step="any" data-lk="${k}" value="${LT[k] != null ? LT[k] : 0}"></div>`;
  rows += `</details>`;
  rows += `<button class="miniBtn" id="pLightClr" style="margin-top:4px;">광원 해제</button>`;
  return rows;
}
// 광원 속성 핸들러 — 단일·다중 선택 패널이 같은 코드를 쓴다.
// 선택된 광원 전부에 일괄 적용된다 (여러 등기구를 한 번에 조절).
function wireLightProps(body) {
  if (!body.querySelector('[data-lon],[data-lk],[data-ls]')) return;
  const selLights = () => selectedEntities().map(lightOfEnt).filter(Boolean);
  // 드래그 중 실시간 반영 — undo를 쌓지 않고 패널도 다시 그리지 않는다.
  //  · pushUndo는 스냅샷(도면 전체 JSON)이라 input마다 부르면 실행취소 기록이 드래그
  //    부스러기 수백 개로 뒤덮이고 느려진다 → 드래그 시작에 딱 한 번만.
  //  · renderProps()는 패널을 통째로 새로 만들어서, 드래그 중인 슬라이더가 사라진다.
  //  · 형상은 바뀌지 않으므로 bimSolids() 재빌드도 생략한다.
  const lightsLive = (fn) => {
    const Ls = selLights(); if (!Ls.length) return;
    Ls.forEach(fn);
    renderLightList();                                   // 광원 패널 + Raytraced 갱신
    if (is3DActive() && typeof v3 !== 'undefined' && v3) render3D(); else draw();
  };
  const applyLights = (fn, refresh) => {
    const Ls = selLights(); if (!Ls.length) return;
    pushUndo(); Ls.forEach(fn);
    renderLightList(); if (refresh) renderProps(); propRefresh();
  };
  // 슬라이더 ↔ 숫자 입력 동기화
  const syncNum = (k, v) => { const n = body.querySelector(`input[data-lk="${k}"]`); if (n) n.value = v; };
  const syncSl = (k, v) => {
    const sl = body.querySelector(`input[data-ls="${k}"]`); if (!sl) return;
    sl.value = (k === 'intensity') ? Math.log10(Math.max(100, v)) : v;
  };
  let lightDragging = false;
  const endDrag = () => { if (!lightDragging) return; lightDragging = false; rtFullRes(); renderProps(); };
  body.querySelectorAll('input[type=range][data-ls]').forEach(sl => {
    const k = sl.dataset.ls;
    const readVal = () => k === 'intensity' ? Math.round(Math.pow(10, +sl.value))
      : (k === 'spotPenumbra' ? Math.round(+sl.value * 100) / 100 : Math.round(+sl.value));
    sl.addEventListener('pointerdown', () => { if (!lightDragging) { pushUndo(); lightDragging = true; } });
    sl.addEventListener('input', () => {
      const v = readVal();
      syncNum(k, v);
      rtPreview();                                        // 조작 중 저해상도 → 100ms 안에 첫 반영
      lightsLive(L => { L[k] = v; if (k === 'colorTemp') L.color = null; });
    });
    sl.addEventListener('change', endDrag);
    sl.addEventListener('pointerup', endDrag);
    sl.addEventListener('lostpointercapture', endDrag);   // 패널 밖에서 손을 뗀 경우
  });
  body.querySelectorAll('input[data-lk]').forEach(inp => inp.addEventListener('change', () => {
    const v = parseFloat(inp.value);
    if (!isFinite(v)) return;
    syncSl(inp.dataset.lk, v);
    applyLights(L => { L[inp.dataset.lk] = v; if (inp.dataset.lk === 'colorTemp') L.color = null; },
      inp.dataset.lk === 'colorTemp');
  }));
  body.querySelector('input[data-lon]')?.addEventListener('change', ev => applyLights(L => { L.enabled = ev.target.checked; }));
  body.querySelector('select[data-ltype]')?.addEventListener('change', ev => applyLights(L => { L.type = ev.target.value; }, true));
  body.querySelectorAll('[data-lpre]').forEach(b => b.addEventListener('click', () => {
    const p = LIGHT_PRESETS[+b.dataset.lpre];
    applyLights(L => { L.intensity = p.intensity; L.colorTemp = p.colorTemp; L.color = null; }, true);
  }));
  document.getElementById('pLightCustom')?.addEventListener('click', () => {
    const on = !!(LT && LT.color);
    applyLights(L => { L.color = on ? null : lightColorRGB(L); }, true); // 색온도 ↔ 커스텀 색은 배타
  });
  document.getElementById('pLightColor')?.addEventListener('input', ev => {
    const [r, g2, b2] = hexToRgb(ev.target.value);
    applyLights(L => { L.color = [r, g2, b2]; });
  });
  document.getElementById('pLightClr')?.addEventListener('click', cmdUnsetLight);
}
function renderProps() {
  const body = document.getElementById('propsBody');
  const byId = new Map(state.entities.map(e => [e.id, e])); // 대량 선택 시 find 반복은 O(n²) — 맵으로 1패스
  const sel = [...state.selection].map(id => byId.get(id)).filter(Boolean);
  if (!sel.length) { body.innerHTML = '<div class="empty">선택된 도형이 없습니다.</div>'; return; }
  if (sel.length > 1) {
    const mLights = sel.map(lightOfEnt).filter(Boolean);
    body.innerHTML =
      `<div class="row"><label>선택</label><span>${sel.length}개 도형</span></div>
       <div class="row"><label>레이어</label><select id="mLayer"><option value="">— 변경 —</option>${state.layers.map(l => `<option>${escapeHtml(l.name)}</option>`).join('')}</select></div>
       <div class="row"><label>색상</label><input type="color" id="mColor" value="#ffffff"><button class="miniBtn" id="mColApply">적용</button><button class="miniBtn" id="mColClear">레이어색</button></div>
       <div class="row"><label>선종류</label><select id="mLt"><option value="">— 변경 —</option>${Object.keys(LINETYPES).map(k => `<option value="${k}">${LINETYPE_KO[k]}</option>`).join('')}</select></div>
       ${matPropRow(sel.every(e => e.mat === sel[0].mat) ? sel[0].mat : '', sel)}
       <div style="display:flex;gap:6px;margin-top:6px;">
         <button class="miniBtn" id="pFront">맨 앞</button><button class="miniBtn" id="pBack">맨 뒤</button>
         <button class="miniBtn" id="pSim">유사 선택</button>
       </div>
       <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;">
         <button class="miniBtn" id="pBimWall">벽 지정</button><button class="miniBtn" id="pBimSlab">슬래브</button>
         <button class="miniBtn" id="pBimCol">기둥</button><button class="miniBtn" id="pBimClr">BIM 해제</button>
       </div>`
       // 선택 안에 광원이 있으면 공통 속성을 일괄 편집할 수 있게 같은 편집기를 붙인다 (§3.1)
       + (mLights.length ? lightPropRows(mLights[0], mLights.length) : '')
       + `<button class="miniBtn" id="pDel" style="margin-top:6px;">선택 삭제</button>`;
    wireLightProps(body);   // 다중 선택에서도 광원 슬라이더가 동작하게 (단일과 같은 코드)
    wireMatProp(body, sel);   // 재질도 단일 선택과 같은 코드
    const apply = fn => { pushUndo(); sel.forEach(fn); renderProps(); propRefresh(); };
    document.getElementById('pFront').addEventListener('click', () => reorderSel(true));
    document.getElementById('pBack').addEventListener('click', () => reorderSel(false));
    document.getElementById('pSim').addEventListener('click', selectSimilar);
    document.getElementById('mLayer').addEventListener('change', ev => { if (ev.target.value) apply(e => e.layer = ev.target.value); });
    document.getElementById('mColApply').addEventListener('click', () => apply(e => e.color = document.getElementById('mColor').value));
    document.getElementById('mColClear').addEventListener('click', () => apply(e => delete e.color));
    document.getElementById('mLt').addEventListener('change', ev => { if (ev.target.value) apply(e => { if (ev.target.value === 'continuous') delete e.linetype; else e.linetype = ev.target.value; }); });
    document.getElementById('pDel').addEventListener('click', deleteSelection);
    document.getElementById('pBimWall').addEventListener('click', cmdWallTag);
    document.getElementById('pBimSlab').addEventListener('click', cmdSlabTag);
    document.getElementById('pBimCol').addEventListener('click', cmdColumnTag);
    document.getElementById('pBimClr').addEventListener('click', cmdBimClear);
    return;
  }
  const e = sel[0];
  let rows = `<div class="row"><label>종류</label><span>${typeKo(e.type)}</span></div>`;
  rows += `<div class="row"><label>레이어</label><select id="pLayer">${
    state.layers.map(l => `<option ${l.name === e.layer ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('')
  }</select></div>`;
  rows += matPropRow(e.mat, [e]);
  const geomRows = {
    LINE: [['x1', 'x1'], ['y1', 'y1'], ['x2', 'x2'], ['y2', 'y2']],
    CIRCLE: [['cx', '중심X'], ['cy', '중심Y'], ['r', '반지름']],
    ARC: [['cx', '중심X'], ['cy', '중심Y'], ['r', '반지름'], ['startAngle', '시작각'], ['endAngle', '끝각']],
    TEXT: [['x', 'X'], ['y', 'Y'], ['height', '높이'], ['rotation', '회전']],
    HATCH: [['spacing', '간격']],
    IMAGE: [['x', 'X'], ['y', 'Y'], ['w', '폭'], ['h', '높이'], ['rot', '회전(°)']],
  };
  if (geomRows[e.type]) for (const [k, lab] of geomRows[e.type])
    rows += `<div class="row"><label>${lab}</label><input type="number" step="any" data-k="${k}" value="${e[k]}"></div>`;
  if (e.type === 'LINE' && (e.z1 != null || e.z2 != null))
    rows += `<div class="row"><label>Z1(3D)</label><input type="number" step="any" data-k="z1" value="${e.z1 || 0}"></div>
             <div class="row"><label>Z2(3D)</label><input type="number" step="any" data-k="z2" value="${e.z2 || 0}"></div>`;
  if (e.type === 'TEXT')
    rows += `<div class="row"><label>내용</label><input type="text" data-k="text" value="${escapeHtml(e.text)}"></div>`;
  if (e.type === 'HATCH')
    rows += `<div class="row"><label>패턴</label><select id="pHatch">${Object.keys(HATCH_PATTERNS).map(k =>
      `<option value="${k}" ${e.pattern === k ? 'selected' : ''}>${HATCH_PATTERNS[k].ko}</option>`).join('')}</select></div>`;
  // 이미지 표시 효과 — 투명도(0%=불투명) · 채도 · 명도 (100% = 원본)
  if (e.type === 'IMAGE') {
    const sl = (k, lab, v, max) => `<div class="row"><label>${lab}</label>
      <input type="range" data-ks="${k}" min="0" max="${max}" step="0.01" value="${v}" style="flex:1;min-width:0;">
      <span class="ksv" data-for="${k}" style="width:42px;text-align:right;font-variant-numeric:tabular-nums;">${Math.round(v * 100)}%</span></div>`;
    rows += `<div class="row" style="margin-top:8px;"><label style="color:var(--accent-text);">표시</label><span style="font-size:11px;opacity:.7;">100% = 원본</span></div>`;
    rows += sl('tr', '투명도', 1 - (e.op != null ? e.op : 1), 1);
    rows += sl('sat', '채도', e.sat != null ? e.sat : 1, 2);
    rows += sl('bri', '명도', e.bri != null ? e.bri : 1, 2);
    rows += `<div style="display:flex;gap:6px;margin-top:6px;">
      <button class="miniBtn" id="pImgFlip">좌우 반전</button>
      <button class="miniBtn" id="pImgFit">원본 비율</button>
      <button class="miniBtn" id="pImgReset">효과 초기화</button></div>`;
  } else
  rows += `<div class="row"><label>색상</label><input type="color" id="pColor" value="${rgbHex(entityColor(e))}">
    <button class="miniBtn" id="pColClear">레이어색</button></div>`;
  // BIM 속성
  const BIM_FIELDS = {
    wall: [['h', '벽 높이'], ['t', '벽 두께'], ['base', '하단(base)']],
    slab: [['t', '두께'], ['top', '상단(top)']],
    column: [['h', '높이'], ['base', '하단(base)']],
    opening: [['h', '개구 높이'], ['sill', '씰 높이']],
    stair: [['w', '폭'], ['h', '총높이'], ['riser', '단높이(최대)'], ['base', '하단(base)']],
    railing: [['h', '난간 높이'], ['spacing', '기둥 간격'], ['t', '손스침 두께'], ['postT', '기둥 두께'], ['base', '하단(base)']],
    roof: [['eave', '처마 높이(z)'], ['rise', '상승 높이']],
  };
  // 광원 특성 — BIM 정체와 무관하게 덧붙는다 (기둥이면서 광원일 수 있다)
  // 광원 속성 — 사용자 대면 단위는 루멘(lm)·켈빈(K). BIM 정체와 무관하게 덧붙는다.
  const LT = lightOfEnt(e);
  if (LT) rows += lightPropRows(LT, 0);
  if (e.bim) {
    const kindKo = { wall: '벽', slab: '슬래브', column: '기둥', stair: '계단', roof: '지붕', railing: '난간', opening: (e.bim.ot === 'door' ? '문' : '창') }[e.bim.kind];
    rows += `<div class="row" style="margin-top:8px;"><label style="color:var(--accent-text);">BIM</label><span style="font-weight:590;">${kindKo}</span></div>`;
    if (e.bim.kind === 'opening') { // 창호 표시기호: 유형 + 경첩/열림 방향
      const wtCur = owWt(e);
      const owCust = Object.keys(state.owlib || {});
      rows += `<div class="row"><label>창호</label><select id="pOwt">${(OPENING_TYPES[e.bim.ot] || [])
        .map(([v, t]) => `<option value="${v}" ${wtCur === v ? 'selected' : ''}>${t}</option>`).join('')
        }${owCust.length ? '<optgroup label="내 기호 (창호저장)">' + owCust.map(n2 =>
          `<option value="@${escapeHtml(n2)}" ${wtCur === '@' + n2 ? 'selected' : ''}>@${escapeHtml(n2)}</option>`).join('') + '</optgroup>' : ''}</select></div>`;
      rows += `<div style="display:flex;gap:6px;margin-top:2px;">
        <button class="miniBtn" id="pOwHinge" title="경첩(스윙 축)을 반대쪽 끝으로">경첩 반전</button>
        <button class="miniBtn" id="pOwFlip" title="열림 방향을 벽 반대쪽으로">안/밖 반전</button></div>`;
    }
    for (const [k, lab] of (BIM_FIELDS[e.bim.kind] || []))
      rows += `<div class="row"><label>${lab}</label><input type="number" step="any" data-bk="${k}" value="${e.bim[k] != null ? e.bim[k] : 0}"></div>`;
    rows += `<button class="miniBtn" id="pBimClr1" style="margin-top:2px;">BIM 해제</button>`;
  } else if (['LINE', 'LWPOLYLINE', 'CIRCLE'].includes(e.type)) {
    rows += `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">
      <button class="miniBtn" id="pBimWall1">벽 지정</button><button class="miniBtn" id="pBimSlab1">슬래브</button>
      <button class="miniBtn" id="pBimCol1">기둥</button></div>`;
  }
  rows += `<div style="display:flex;gap:6px;margin-top:6px;">
    <button class="miniBtn" id="pFront1">맨 앞</button><button class="miniBtn" id="pBack1">맨 뒤</button>
    <button class="miniBtn" id="pSim1">유사 선택</button></div>`;
  rows += `<button class="miniBtn" id="pDel" style="margin-top:6px;">삭제</button>`;
  body.innerHTML = rows;
  document.getElementById('pFront1').addEventListener('click', () => reorderSel(true));
  document.getElementById('pBack1').addEventListener('click', () => reorderSel(false));
  body.querySelectorAll('input[data-bk]').forEach(inp => inp.addEventListener('change', () => {
    const v = parseFloat(inp.value);
    if (!isFinite(v)) return;
    pushUndo(); e.bim[inp.dataset.bk] = v; propRefresh();
  }));
  wireLightProps(body);
  wireMatProp(body, [e]);   // 재질 — 다중 선택과 같은 코드
  document.getElementById('pOwt')?.addEventListener('change', (ev) => { pushUndo(); e.bim.wt = ev.target.value; propRefresh(); logLine(`  창호 유형 → ${owTypeKo(e.bim.wt)}`, 'info'); });
  document.getElementById('pOwHinge')?.addEventListener('click', () => { pushUndo(); e.bim.hinge = e.bim.hinge ? 0 : 1; propRefresh(); });
  document.getElementById('pOwFlip')?.addEventListener('click', () => { pushUndo(); e.bim.flip = e.bim.flip ? 0 : 1; propRefresh(); });
  document.getElementById('pBimClr1')?.addEventListener('click', cmdBimClear);
  document.getElementById('pBimWall1')?.addEventListener('click', cmdWallTag);
  document.getElementById('pBimSlab1')?.addEventListener('click', cmdSlabTag);
  document.getElementById('pBimCol1')?.addEventListener('click', cmdColumnTag);
  document.getElementById('pSim1').addEventListener('click', selectSimilar);

  body.querySelectorAll('input[data-k]').forEach(inp =>
    inp.addEventListener('change', () => {
      pushUndo();
      const k = inp.dataset.k;
      e[k] = (inp.type === 'number') ? parseFloat(inp.value) : inp.value;
      if (e.type === 'HATCH') hatchDirty(e);
      propRefresh();
    }));
  const pHatch = document.getElementById('pHatch');
  if (pHatch) pHatch.addEventListener('change', () => { pushUndo(); e.pattern = pHatch.value; hatchDirty(e); draw(); logLine(`  해치 패턴 → ${HATCH_PATTERNS[e.pattern].ko}`, 'info'); });
  document.getElementById('pLayer').addEventListener('change', (ev) => { pushUndo(); e.layer = ev.target.value; applyLayerRoleTo(e); renderProps(); propRefresh(); });
  document.getElementById('pColor')?.addEventListener('input', (ev) => { pushUndo(); e.color = ev.target.value; propRefresh(); }); // 이미지엔 색상 행 없음
  document.getElementById('pColClear')?.addEventListener('click', () => { pushUndo(); delete e.color; renderProps(); propRefresh(); });
  // 이미지 효과 슬라이더 — 드래그 중엔 draw()만(슬라이더 포커스 유지), 드래그 1회 = undo 1회
  body.querySelectorAll('input[data-ks]').forEach(inp => {
    const k = inp.dataset.ks;
    inp.addEventListener('pointerdown', () => pushUndo());
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value);
      if (!isFinite(v)) return;
      if (k === 'tr') e.op = 1 - v; else e[k] = v; // 투명도는 반전(0%=불투명)
      const lbl = body.querySelector(`.ksv[data-for="${k}"]`);
      if (lbl) lbl.textContent = Math.round(v * 100) + '%';
      draw();
    });
  });
  document.getElementById('pImgFlip')?.addEventListener('click', () => { pushUndo(); e.flip = !e.flip; logLine('  ✔ 이미지 좌우 반전', 'ok'); draw(); });
  document.getElementById('pImgReset')?.addEventListener('click', () => { pushUndo(); e.op = 1; e.sat = 1; e.bri = 1; renderProps(); draw(); logLine('  ✔ 이미지 효과 초기화', 'ok'); });
  document.getElementById('pImgFit')?.addEventListener('click', () => { // 원본 종횡비 복원 (폭 유지)
    const im = e._img;
    if (!im || !im.naturalWidth) { logLine('  이미지 로딩 중입니다. 잠시 후 다시 시도하세요.', 'warn'); return; }
    pushUndo();
    const c = imgCenter(e);
    e.h = e.w * im.naturalHeight / im.naturalWidth;
    imgSetCenter(e, c.x, c.y);
    renderProps(); draw(); logLine(`  ✔ 원본 비율 복원 (${im.naturalWidth}×${im.naturalHeight})`, 'ok');
  });
  document.getElementById('pDel').addEventListener('click', deleteSelection);
}

function deleteSelection() {
  if (!state.selection.size) return;
  pushUndo();
  state.entities = state.entities.filter(e => !state.selection.has(e.id));
  state.selection.clear(); renderProps(); updateStat(); draw();
}

function typeKo(t) { return ({ LINE: '선', LWPOLYLINE: '폴리라인', CIRCLE: '원', ARC: '호', TEXT: '문자', HATCH: '해치', INSERT: '블록', IMAGE: '밑그림 이미지' })[t] || t; }
function updateStat() {
  pruneLights(); // 개체가 지워지면 연결된 광원도 사라진다 (undo는 state.lights를 통째로 복원)
  statEl.textContent = `도형 ${state.entities.length}개 · 레이어 ${state.layers.length}개`
    + (state.lights.length ? ` · 광원 ${state.lights.length}개` : '');
}

// ============================================================
//  뷰 조작
// ============================================================
// robust=true이면 극단 이상치(드물게 도면에서 멀리 떨어진 잔여 도형)를 제외하고 맞춤 — 불러오기 직후 사용
// 이전 뷰 스택 (zp)
const viewPrevStack = [];
function pushViewPrev() { viewPrevStack.push({ ...state.view }); if (viewPrevStack.length > 24) viewPrevStack.shift(); }
function zoomPrev() {
  const v = viewPrevStack.pop();
  if (!v) { logLine('  이전 뷰가 없습니다.', 'warn'); return; }
  state.view = v; draw(); logLine('  ✔ 이전 뷰', 'info');
}
// ── 줌 윈도(zoom) — 드래그(또는 두 클릭)로 지정한 박스만큼 확대. 전체보기는 ze/F/전체보기 버튼 ──
let zoomwPrevTool = 'select';
function applyZoomWindow(b) {
  const bw = Math.abs(b.x2 - b.x1), bh = Math.abs(b.y2 - b.y1);
  if (bw * state.view.scale < 3 && bh * state.view.scale < 3) { logLine('  줌: 영역이 너무 작습니다 — 확대할 박스를 드래그하세요.', 'warn'); return false; }
  pushViewPrev();
  state.view.x = (b.x1 + b.x2) / 2; state.view.y = (b.y1 + b.y2) / 2;
  state.view.scale = Math.min(cv._w / Math.max(bw, 1e-9), cv._h / Math.max(bh, 1e-9)) * 0.95; // 리미트 없음
  setTool(zoomwPrevTool === '_zoomw' ? 'select' : zoomwPrevTool);
  logLine('  ✔ 줌 — 지정한 영역으로 확대 (이전 뷰: zp · 전체보기: ze)', 'ok');
  draw();
  return true;
}
function cmdZoomWindow() {
  zoomwPrevTool = state.tool === '_zoomw' ? 'select' : state.tool;
  cmdOp = null;
  setTool('_zoomw');
  setPrompt('줌: 확대할 영역을 드래그(또는 두 모서리 클릭)하세요 · Esc 취소');
  logLine('  ▷ 줌 — 확대할 영역을 드래그하세요 (전체보기는 ze 또는 F)', 'info');
}
// 3D·입면 뷰포트용 줌 윈도 — 드래그 박스(캔버스 px)를 그 칸 가득 확대.
// proj3D: 화면x = 칸중심x + (sx+panX)·k, 화면y = 칸중심y − (sy+panY)·k  (k = min(w,h)/(fit·1.4)·zoom)
// ① 박스 중심을 칸 중심으로(pan 이동, 현재 k 기준) ② zoom 배율 곱(칸 중심 기준 확대라 중심 유지)
function applyZoomWindow3D(d) {
  if (typeof v3 === 'undefined' || !v3) return false;
  const x0 = Math.min(d.bx0, d.bx1), x1 = Math.max(d.bx0, d.bx1);
  const y0 = Math.min(d.by0, d.by1), y1 = Math.max(d.by0, d.by1);
  const bw = x1 - x0, bh = y1 - y0;
  if (bw < 4 || bh < 4) { logLine('  줌: 영역이 너무 작습니다 — 확대할 박스를 드래그하세요.', 'warn'); render3D(); return false; }
  const vi = vpAt((x0 + x1) / 2, (y0 + y1) / 2);
  if (v3.act !== vi) { saveVp(); v3.act = vi; loadVp(vi); }
  const r = vpRect(vi);
  const k = Math.min(r.w, r.h) / (v3.fit * 1.4) * v3.zoom;
  if (!(k > 0)) return false;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const ccx = r.x + r.w / 2, ccy = r.y + r.h / 2;
  v3.panX -= (cx - ccx) / k;
  v3.panY += (cy - ccy) / k;
  v3.zoom = Math.max(0.001, Math.min(100000, v3.zoom * Math.min(r.w / bw, r.h / bh) * 0.95));
  saveVp();
  setTool(zoomwPrevTool === '_zoomw' ? 'select' : zoomwPrevTool);
  logLine('  ✔ 줌 — 지정한 영역으로 확대 (전체보기: ze)', 'ok');
  render3D();
  return true;
}
function zoomFit(robust) {
  // 전체보기는 두 카메라(평면 state.view / 3D v3)를 모두 맞춘다. 범위는 modelExtents 하나로
  // 계산하므로 둘이 다른 곳을 볼 수 없다 — 예전엔 각자 자기 switch 로 범위를 구해 어긋났다.
  if (is3DActive() && v3) {           // (예전엔 이 검사를 인라인으로 복제해 뒀다)
    v3.solids = bimSolids(); fit3D();
    v3.zoom = 1; v3.panX = 0; v3.panY = 0;
    for (const w of v3.views) { w.zoom = 1; w.panX = 0; w.panY = 0; }
    loadVp(v3.act); render3D();
    // return 하지 않음 — 평면 뷰도 함께 맞춰야 (3D 중 문서 열기 등에서) 복귀 시 화면이 맞음
  }
  pushViewPrev();
  if (!state.entities.length) { state.view = { x: 0, y: 0, scale: 4 }; draw(); return; }
  // ★fit3D 와 같은 함수를 쓴다 — 같은 도면에 두 개의 '전체 범위' 가 나오면 안 된다
  const ex = modelExtents(robust);
  if (!ex) { state.view = { x: 0, y: 0, scale: 4 }; draw(); return; }
  const minX = ex.minX, maxX = ex.maxX, minY = ex.minY, maxY = ex.maxY;
  const w = maxX - minX || 1, h = maxY - minY || 1;
  const pad = 1.2;
  if (cv._w > 2 && cv._h > 2) // 창이 0 크기일 때 scale이 0/∞로 깨지는 것 방지
    state.view.scale = Math.min(cv._w / (w * pad), cv._h / (h * pad));
  state.view.x = (minX + maxX) / 2;
  state.view.y = (minY + maxY) / 2;
  draw();
}

// ============================================================
//  키보드
// ============================================================
// 텍스트를 드래그로 선택 중인가 — AI 채팅 등에서 글을 긁었을 때 Ctrl+C 는
// '개체 복사' 가 아니라 브라우저 기본 '텍스트 복사' 로 가야 한다
function textSelActive() {
  const s = window.getSelection ? window.getSelection() : null;
  return !!(s && !s.isCollapsed && String(s));
}
window.addEventListener('keydown', (ev) => {
  const key = typeof ev.key === 'string' ? ev.key : ''; // 일부 브라우저 확장·IME가 key 없는 합성 이벤트를 보냄 — undefined 방어
  if (key === 'F8') { ev.preventDefault(); toggleOrtho(); return; }  // 직교 모드(입력창 포커스 중에도 동작)
  if (key === 'F3') { ev.preventDefault(); toggleOsnap(); return; }  // 객체 스냅
  const ae = document.activeElement;
  if (ae && /INPUT|SELECT|TEXTAREA/.test(ae.tagName)) return;
  // 글자를 치면 곧장 명령창으로 — Space/Enter 없이 즉시 명령 입력 가능
  if (cmdInputEl && key.length === 1 && key !== ' ' && !ev.ctrlKey && !ev.metaKey && !ev.altKey
      && !document.body.classList.contains('authLocked')) {
    cmdInputEl.focus({ preventScroll: true }); return; // 이 키 입력은 그대로 명령창에 들어감
  }
  if (ev.ctrlKey && key.toLowerCase() === 'z') { ev.preventDefault(); undo(); return; }
  if (ev.ctrlKey && (key.toLowerCase() === 'y' || (ev.shiftKey && key.toLowerCase() === 'z'))) { ev.preventDefault(); redo(); return; }
  if (ev.ctrlKey && key.toLowerCase() === 's') { ev.preventDefault(); saveDXF(); return; }
  if (ev.ctrlKey && key.toLowerCase() === 'a') { ev.preventDefault(); state.entities.forEach(e => { if (onLv(e)) state.selection.add(e.id); }); renderProps(); draw(); return; }
  if (ev.ctrlKey && key.toLowerCase() === 'c') { if (textSelActive()) return; ev.preventDefault(); copySelection(); return; }
  if (ev.ctrlKey && key.toLowerCase() === 'v') { ev.preventDefault(); startPaste(); return; }
  switch (key) {
    case 'Escape': if (extrudePend) { extrudePendCancel(); break; } if (typeof boolPending !== 'undefined' && boolPending) { boolPending = null; logLine('  차집합 취소', 'info'); } setTool('select'); state.selection.clear(); renderProps(); draw(); break;
    case 'Enter': if (state.tool === 'pline') finishPolyline(); break;
    case 'Delete': case 'Backspace': deleteSelection(); break;
    case 'l': case 'L': setTool('line'); break;
    case 'p': case 'P': setTool('pline'); break;
    case 'r': case 'R': setTool('rect'); break;
    case 'c': case 'C': setTool('circle'); break;
    case 'a': case 'A': setTool('arc'); break;
    case 't': case 'T': setTool('text'); break;
    case 'm': case 'M': setTool('move'); break;
    case 'f': case 'F': zoomFit(); break;
  }
});

// ============================================================
//  팝업 드래그 이동 — 모든 팝업창은 상단(제목줄)을 잡고 자유롭게 옮길 수 있다
// ============================================================
function popupDrag(box, handle) {
  if (!box || !handle || handle._dragBound) return;
  handle._dragBound = true;
  handle.style.cursor = 'move';
  handle.style.touchAction = 'none';
  handle.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    // 제목줄 위의 버튼·입력 등은 원래 기능 그대로 — 빈 영역과 제목 글자만 손잡이
    if (ev.target.closest('button,select,input,textarea,a,label')) return;
    const r = box.getBoundingClientRect();
    // 중앙정렬(flex)·right/bottom 배치를 뷰포트 좌표 고정으로 바꾼 뒤 움직인다
    box.style.position = 'fixed';
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.right = 'auto'; box.style.bottom = 'auto';
    box.style.margin = '0'; box.style.transform = 'none';
    const dx = ev.clientX - r.left, dy = ev.clientY - r.top;
    const move = (e) => {
      // 손잡이가 화면 밖으로 완전히 나가 못 되찾는 일이 없도록 60px은 남긴다
      const x = Math.min(window.innerWidth - 60, Math.max(60 - r.width, e.clientX - dx));
      const y = Math.min(window.innerHeight - 30, Math.max(0, e.clientY - dy));
      box.style.left = x + 'px'; box.style.top = y + 'px';
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    ev.preventDefault(); ev.stopPropagation();
  });
}
window.webcadPopupDrag = popupDrag; // ai.js·nodes.js·cloud.js 의 팝업도 같은 방식으로
// index.html 의 정적 다이얼로그들
['helpDlg', 'arrayDlg', 'saveAsDlg', 'optionsDlg', 'plotDlg'].forEach((id) => {
  const d = document.getElementById(id); if (!d) return;
  const bx = d.querySelector('.dlgBox'); if (bx) popupDrag(bx, bx.querySelector('h2'));
});

// ============================================================
//  버튼 바인딩
// ============================================================
// 파일 드롭다운 메뉴
(function () {
  const btn = document.getElementById('btnFile');
  const menu = document.getElementById('fileMenu');
  const toggle = (open) => {
    menu.classList.toggle('open', open === undefined ? !menu.classList.contains('open') : open);
    btn.classList.toggle('on', menu.classList.contains('open'));   // 열림=활성 → 라벨 표시(.tglc)
  };
  // pointerdown으로 토글 — 포커스 이동/클릭 합성 실패와 무관하게 항상 동작
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); toggle(); });
  btn.addEventListener('click', (e) => { e.stopPropagation(); }); // 같은 탭의 click이 문서 닫힘/재토글을 일으키지 않게
  document.addEventListener('pointerdown', () => toggle(false));
  document.addEventListener('click', () => toggle(false));
  menu.addEventListener('pointerdown', (e) => e.stopPropagation()); // 항목 클릭 전에 닫히지 않게
  menu.addEventListener('click', (e) => e.stopPropagation());
  const close = () => toggle(false);
  document.getElementById('miSetAsLight')?.addEventListener('click', () => { close(); cmdSetAsLight(); });
  document.getElementById('miUnsetLight')?.addEventListener('click', () => { close(); cmdUnsetLight(); });
  document.getElementById('miNew').addEventListener('click', () => { close(); doNew(); });
  document.getElementById('miOpen').addEventListener('click', () => { close(); openFile(); });
  document.getElementById('miSave').addEventListener('click', () => { close(); saveDXF(); });
  document.getElementById('miSaveAs').addEventListener('click', () => { close(); openSaveAs(); });
  document.getElementById('miShare').addEventListener('click', () => { close(); shareLink(); });
  document.getElementById('miImage').addEventListener('click', () => { close(); document.getElementById('imgInput').click(); });
})();
// 밑그림 이미지 삽입: 축소 인코딩 → '밑그림' 레이어(기본 잠금)에 배치 → 위에 트레이싱
document.getElementById('imgInput').addEventListener('change', (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const MAX = 1600, k = Math.min(1, MAX / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const src = c.toDataURL('image/jpeg', 0.72);
      // 뷰 중앙에 화면폭 60% 크기로 배치
      const wWorld = (cv._w / state.view.scale) * 0.6;
      const hWorld = wWorld * c.height / c.width;
      const x = state.view.x - wWorld / 2, y = state.view.y - hWorld / 2;
      const lay = ensureLayer('밑그림', '#8a8a94');
      // 삽입 시 항상 잠금 해제 — 잠긴 레이어에 넣으면 방금 넣은 이미지를 선택·이동·삭제조차 못 한다
      // (이전 기본값이 잠금이라 "이미지 선택이 안 된다"의 원인이었음). 트레이싱 중 고정이 필요하면
      // 레이어 창의 🔓 토글로 사용자가 직접 잠그면 되고, 그 상태는 다음 삽입 전까지 유지된다.
      lay.locked = false;
      pushUndo();
      const ent = addEntity({ type: 'IMAGE', layer: '밑그림', x, y, w: wWorld, h: hWorld, src, rot: 0, op: 1, sat: 1, bri: 1 });
      if (ent) { state.selection.clear(); state.selection.add(ent.id); setTool('select'); } // 삽입 직후 선택 → 검볼 바로 사용
      logLine(`  ✔ 이미지 삽입 (${c.width}×${c.height}) — 클릭 선택 · 검볼로 이동/회전 · 특성창에서 투명도·채도·명도, Del=삭제`, 'ok');
      renderLayers(); updateStat(); renderProps(); draw();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(f);
  ev.target.value = '';
});
// 옵션 드롭다운 + 설정 대화상자 (단축키/객체스냅/단위)
(function () {
  const btn = document.getElementById('btnOpts');
  const menu = document.getElementById('optMenu');
  const toggle = (open) => {
    menu.classList.toggle('open', open === undefined ? !menu.classList.contains('open') : open);
    btn.classList.toggle('on', menu.classList.contains('open'));   // 열림=활성 → 라벨 표시(.tglc)
  };
  // pointerdown으로 토글 — 포커스 이동/클릭 합성 실패와 무관하게 항상 동작
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); toggle(); });
  btn.addEventListener('click', (e) => { e.stopPropagation(); });
  document.addEventListener('pointerdown', () => toggle(false));
  document.addEventListener('click', () => toggle(false));
  menu.addEventListener('pointerdown', (e) => e.stopPropagation());
  menu.addEventListener('click', (e) => e.stopPropagation());
  const dlg = document.getElementById('optionsDlg');
  function openOptions(sec) {
    toggle(false);
    // 현재값 채우기
    document.getElementById('optUnits').value = settings.units;
    document.getElementById('optPolar').value = String(settings.polar || 0);
    document.getElementById('optDimTxt').value = settings.dim.txt || 0;
    document.getElementById('optDimDec').value = String(settings.dim.dec != null ? settings.dim.dec : 2);
    document.getElementById('optDimSuffix').checked = !!settings.dim.suffix;
    for (const k of ['endpoint', 'midpoint', 'center', 'quad', 'perp', 'tangent', 'nearest', 'intersection', 'surface'])
      document.getElementById('os_' + k).checked = !!settings.osnapModes[k];
    // 단축키 목록 (도구명 → 현재 사용자 별칭 역조회)
    const rev = {}; for (const [a, t] of Object.entries(settings.aliases)) if (!rev[t]) rev[t] = a;
    document.getElementById('aliasList').innerHTML = COMMAND_LIST.map(c => {
      const tool = CMD_ALIASES[c.name] || c.name;
      return `<span class="aname">${escapeHtml(c.ko)} (${c.name})</span><input data-tool="${tool}" value="${escapeHtml(rev[tool] || '')}" placeholder="예: qq">`;
    }).join('');
    dlg.style.display = 'flex';
    const el = document.getElementById(sec); if (el) el.scrollIntoView({ block: 'start' });
  }
  document.getElementById('moPlot').addEventListener('click', () => { toggle(false); openPlot(); });
  document.getElementById('moShortcut').addEventListener('click', () => openOptions('secShortcut'));
  document.getElementById('moOsnap').addEventListener('click', () => openOptions('secOsnap'));
  document.getElementById('moUnits').addEventListener('click', () => openOptions('secUnits'));
  document.getElementById('moDim').addEventListener('click', () => openOptions('secDim'));
  document.getElementById('optCancel').addEventListener('click', () => dlg.style.display = 'none');
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.style.display = 'none'; });
  document.getElementById('optSave').addEventListener('click', () => {
    settings.units = document.getElementById('optUnits').value;
    settings.polar = parseInt(document.getElementById('optPolar').value, 10) || 0;
    settings.dim.txt = Math.max(0, parseFloat(document.getElementById('optDimTxt').value) || 0);
    settings.dim.dec = parseInt(document.getElementById('optDimDec').value, 10);
    settings.dim.suffix = document.getElementById('optDimSuffix').checked;
    for (const k of ['endpoint', 'midpoint', 'center', 'quad', 'perp', 'tangent', 'nearest', 'intersection', 'surface'])
      settings.osnapModes[k] = document.getElementById('os_' + k).checked;
    const aliases = {};
    document.querySelectorAll('#aliasList input').forEach(inp => {
      const a = inp.value.trim().toLowerCase();
      if (a) aliases[a] = inp.dataset.tool;
    });
    settings.aliases = aliases;
    saveSettings();
    dlg.style.display = 'none';
    logLine(`  ✔ 옵션 저장 (단위 ${settings.units}, 단축키 ${Object.keys(aliases).length}개)`, 'ok');
    draw();
  });
})();
// ---------- 인쇄 / 플롯 ----------
let plotRegion = null; // {minX,minY,maxX,maxY} — 창 지정 시
function openPlot() { document.getElementById('plotDlg').style.display = 'flex'; }
function closePlot() { document.getElementById('plotDlg').style.display = 'none'; }
(function () {
  const dlg = document.getElementById('plotDlg');
  document.getElementById('plCancel').addEventListener('click', closePlot);
  dlg.addEventListener('click', e => { if (e.target === dlg) closePlot(); });
  document.getElementById('plOk').addEventListener('click', () => {
    const region = document.getElementById('plRegion').value;
    if (region === 'win' && !plotRegion) { // 영역 미지정 → 창 드래그 요청
      closePlot();
      startRegionPick(() => { document.getElementById('plotDlg').style.display = 'flex'; });
      return;
    }
    doPlot();
  });
})();
function startRegionPick(after) {
  const prevTool = state.tool;
  cmdOp = null; dragSelect = null;
  state.tool = '_plotregion';
  setPrompt('플롯 영역: 인쇄할 사각형 영역의 두 모서리를 클릭하세요.');
  regionPickState = { after, prevTool };
  cv.style.cursor = 'crosshair'; draw();
}
let regionPickState = null;
function doPlot() {
  const paper = document.getElementById('plPaper').value;
  const landscape = document.getElementById('plOrient').value === 'land';
  const scaleDenom = parseInt(document.getElementById('plScale').value, 10) || 0;
  const useRegion = document.getElementById('plRegion').value === 'win' && plotRegion;
  const title = document.getElementById('plTitleBlock').checked ? {
    title: document.getElementById('plTitle').value || (currentFileName || '무제'),
    file: currentFileName || '(미저장)',
    scale: scaleDenom ? '1:' + scaleDenom : 'FIT',
    date: new Date().toISOString().slice(0, 10),
  } : null;
  closePlot();
  const opt = { paper, landscape, scaleDenom, region: useRegion ? plotRegion : null, title, units: settings.units };
  const pdf = buildPDF(opt);
  const base = (currentFileName ? currentFileName.replace(/\.[^.]+$/, '') : 'plot');
  logLine(`  ✔ 플롯 PDF (${paper.toUpperCase()} ${landscape ? '가로' : '세로'}, ${scaleDenom ? '1:' + scaleDenom : '맞춤'})`, 'ok');
  saveBlob(new Blob([pdf], { type: 'application/pdf' }), base + '_plot.pdf');
}

function doNew() {
  if (state.entities.length && !confirm('현재 도면을 지우고 새로 시작할까요?')) return;
  if (typeof clearLocal === 'function') clearLocal();
  fileHandle = null; setFileName(null, null);
  if (window.WEBCAD_API && WEBCAD_API.onDocChange) WEBCAD_API.onDocChange(); // 클라우드 연결 해제
  newDrawing();
}
document.getElementById('fileInput').addEventListener('change', (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  const reader = new FileReader();
  if (ext === 'stl') {
    reader.onload = () => { if (loadMesh(parseSTL(reader.result), f.name)) { fileHandle = null; } ev.target.value = ''; };
    reader.readAsArrayBuffer(f);
  } else if (ext === 'obj') {
    reader.onload = () => { if (loadMesh(parseOBJ(reader.result), f.name)) { fileHandle = null; } ev.target.value = ''; };
    reader.readAsText(f);
  } else {
    reader.onload = () => { if (loadDXF(reader.result)) { fileHandle = null; setFileName(f.name, null); } ev.target.value = ''; };
    reader.readAsText(f);
  }
});
// 다른 이름으로 저장 대화상자
function openSaveAs() {
  const inp = document.getElementById('saveName');
  if (inp) inp.value = currentFileName ? currentFileName.replace(/\.[^.]+$/, '') : 'drawing';
  document.getElementById('saveAsDlg').style.display = 'flex';
}
function closeSaveAs() { document.getElementById('saveAsDlg').style.display = 'none'; }
(function () {
  const dlg = document.getElementById('saveAsDlg');
  document.getElementById('saveAsCancel').addEventListener('click', closeSaveAs);
  document.getElementById('saveAsOk').addEventListener('click', () => {
    const fmt = dlg.querySelector('input[name=saveFmt]:checked').value;
    const name = (document.getElementById('saveName').value || 'drawing').replace(/\.[^.]+$/, '');
    closeSaveAs();
    if (fmt === 'dxf') { saveAsDXF(name); }
    else if (fmt === 'svg') saveBlob(new Blob([buildSVG()], { type: 'image/svg+xml' }), name + '.svg');
    else if (fmt === 'pdf') saveBlob(new Blob([buildPDF()], { type: 'application/pdf' }), name + '.pdf');
    else if (fmt === 'png') savePNG(name + '.png');
    else if (fmt === 'stl' || fmt === 'obj') {
      const selOnly = document.getElementById('saveSelOnly') && document.getElementById('saveSelOnly').checked;
      const ids = (selOnly && state.selection.size) ? new Set(state.selection) : null;
      if (selOnly && !ids) { logLine('  선택한 객체만 저장하려면 먼저 객체를 선택하세요.', 'warn'); return; }
      if (fmt === 'stl') cmdExportSTL(ids, name); else cmdExportOBJ(ids, name);
    }
  });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeSaveAs(); });
})();
document.getElementById('btnUndo').addEventListener('click', undo);
document.getElementById('btnRedo').addEventListener('click', redo);
document.getElementById('btnGrid').addEventListener('click', (e) => { state.grid.show = !state.grid.show; e.currentTarget.classList.toggle('active', state.grid.show); draw(); });
document.getElementById('btnZoomFit').addEventListener('click', () => zoomFit());
document.getElementById('btnOrtho').addEventListener('click', toggleOrtho);
document.getElementById('btnOsnap').addEventListener('click', toggleOsnap);
// 토글 버튼 초기 상태 반영 (그리드 표시 ON, 직교 OFF, 객체스냅 ON)
document.getElementById('btnGrid').classList.toggle('active', state.grid.show);
document.getElementById('btnOrtho').classList.toggle('active', state.ortho);
document.getElementById('btnOsnap').classList.toggle('active', osnapEnabled);

// iOS 등 요소 전체화면 미지원 시: "홈 화면에 추가" 안내 모달
function showHomeScreenHelp() {
  if (document.getElementById('homeHelp')) return;
  const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform || ''));
  const o = document.createElement('div');
  o.id = 'homeHelp';
  o.style.cssText = 'position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);padding:20px;';
  o.innerHTML =
    '<div style="background:rgba(26,37,64,0.90);-webkit-backdrop-filter:saturate(180%) blur(20px);backdrop-filter:saturate(180%) blur(20px);border-radius:18px;max-width:360px;padding:24px;color:#f5f5f7;box-shadow:0 8px 30px rgba(0,0,0,0.55);font-family:-apple-system,\'SF Pro Text\',\'Segoe UI\',sans-serif;letter-spacing:-0.01em;">' +
    '<h2 style="margin:0 0 10px;font-size:19px;font-weight:600;letter-spacing:-0.02em;">전체화면으로 쓰는 법</h2>' +
    '<p style="margin:0 0 12px;font-size:13px;color:rgba(235,235,245,0.6);line-height:1.6;">이 브라우저 탭은 전체화면 API를 지원하지 않습니다. 아래처럼 <b style="color:#f5f5f7;">홈 화면에 앱으로 추가</b>하면 주소창·툴바 없이 전체화면으로 실행됩니다.</p>' +
    '<ol style="margin:0 0 4px;padding-left:20px;font-size:13px;line-height:1.9;">' +
    (isiOS
      ? '<li>Safari 하단(또는 상단)의 <b>공유 버튼 <span style="display:inline-block;border:1px solid #6a6a75;border-radius:4px;padding:0 5px;">⬆️</span></b> 탭</li><li>목록에서 <b>"홈 화면에 추가"</b> 선택</li><li>오른쪽 위 <b>"추가"</b> 탭</li><li>홈 화면의 <b>Parti 아이콘</b>으로 실행 → 전체화면</li>'
      : '<li>브라우저 메뉴(⋮) 열기</li><li><b>"홈 화면에 추가"</b> 또는 <b>"앱 설치"</b> 선택</li><li>추가된 아이콘으로 실행 → 전체화면</li>') +
    '</ol>' +
    '<div style="text-align:right;margin-top:16px;"><button id="homeHelpClose" style="background:#0071e3;color:#fff;border:none;border-radius:8px;padding:8px 17px;font-size:14px;cursor:pointer;">확인</button></div>' +
    '</div>';
  document.body.appendChild(o);
  popupDrag(o.firstElementChild, o.querySelector('h2'));
  const close = () => o.remove();
  o.addEventListener('click', (e) => { if (e.target === o) close(); });
  o.querySelector('#homeHelpClose').addEventListener('click', close);
}

// 전체화면 토글 — 모바일/태블릿에서 주소창·브라우저 UI 숨김 (Fullscreen API + 벤더 프리픽스)
(function () {
  const btn = document.getElementById('btnFull');
  if (!btn) return;
  const el = document.documentElement;
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
  function enter() {
    const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen || el.mozRequestFullScreen || el.msRequestFullscreen;
    if (fn) {
      try { const p = fn.call(el); if (p && p.catch) p.catch(() => showHomeScreenHelp()); }
      catch (e) { showHomeScreenHelp(); }
    } else showHomeScreenHelp();
  }
  function exit() {
    const fn = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
    if (fn) fn.call(document);
  }
  btn.addEventListener('click', () => { fsEl() ? exit() : enter(); });
  // Esc가 전체화면을 해제하지 않게 — Esc는 취소 등 핵심 기능과 엮여 있어 토글 버튼으로만 on/off (2026-07-20).
  // Keyboard Lock API(크롬 데스크톱): 전체화면 중 Esc를 페이지가 소유한다. 미지원 브라우저는 브라우저 규칙대로.
  function lockEsc(on) {
    try {
      if (on && navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock(['Escape']);
      else if (!on && navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
    } catch (e) {}
  }
  function sync() {
    const on = !!fsEl();
    lockEsc(on);
    const lbl = btn.querySelector('.tl');                          // 아이콘(svg)은 두고 라벨만 갱신
    if (lbl) lbl.textContent = on ? '창모드' : '전체화면';
    else btn.textContent = on ? '⛶ 창모드' : '⛶ 전체화면';
    btn.classList.toggle('active', on);
    setTimeout(resize, 120); // 전환 후 캔버스 크기 재계산
  }
  ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach(e => document.addEventListener(e, sync));
})();

document.getElementById('curColor').addEventListener('input', (e) => {
  state.currentColor = e.target.value;
  document.getElementById('curColorTxt').textContent = '고정색';
});
document.getElementById('curColorTxt').addEventListener('click', () => {
  state.currentColor = null;
  document.getElementById('curColorTxt').textContent = '레이어색 사용';
});
document.getElementById('textHeight').addEventListener('change', (e) => state.textHeight = parseFloat(e.target.value) || 10);
document.getElementById('gridSize').addEventListener('change', (e) => { state.grid.size = parseFloat(e.target.value) || 10; draw(); });

// ============================================================
//  명령어 자동완성 (라이노식 미리보기 + 클릭 선택)
// ============================================================
// ============================================================
//  명령어 도움말 (❓ 명령어 버튼 / help / ?)
// ============================================================
const CMD_HELP = [
  { c: '그리기', items: [
    ['line', '선', '점을 연속 클릭해 이어 그림. 좌표(x,y / @dx,dy / @거리<각도) 입력 가능'],
    ['pline', '폴리라인', '여러 점을 하나의 연결선으로. 빈 Enter로 완료'],
    ['spline', '자유곡선', '제어점을 부드럽게 통과하는 곡선 — 유기적 형태 작도. 빈 Enter로 완료'],
    ['rect', '사각형', '두 코너 클릭(또는 크기 w,h 입력) — 닫힌 폴리라인'],
    ['circle', '원', '중심 클릭 → 반지름 입력(또는 클릭)'],
    ['arc', '호', '시작 → 끝 → 통과점 3점'],
    ['polygon', '정다각형', '변 개수 입력 → 중심 → 반지름'],
    ['ellipse', '타원', '중심 → 코너 클릭 또는 rx,ry 입력'],
    ['text', '문자', '위치 클릭 → 내용 입력. 기존 문자는 더블클릭으로 수정'],
    ['hatch', '해치', '패턴명/간격 입력 후 경계(원·닫힌 폴리라인) 클릭. 8종 패턴'],
    ['block', '블록 정의', '선택한 도형들을 하나의 블록으로 묶음 (즉시 실행)'],
    ['insert', '블록 삽입', '우측 블록 목록에서 선택 후 배치 (배율·회전 지정)'],
    ['xline', '구성선', '두 점 → 사실상 무한한 보조선 (기준선·자르기 기준)'],
    ['frame', '도곽', '배치점 → 용지·축척 입력 → 외곽+테두리+표제란 자동 생성'],
    ['revcloud', '구름마크', '두 코너 → 검토 표시용 구름 모양 (연속 기입)'],
    ['centerline', '중심선', '원/호 클릭 → 십자 중심선 (일점쇄선 레이어)'],
    ['leader', '지시선', '화살표 지점 → 문자 위치 → 문구 입력'],
  ]},
  { c: '편집', items: [
    ['move', '이동(평면·3D 공용)', '선택 → 기준점 → 이동점 (좌표·거리 입력 가능)'],
    ['copy', '복사(평면·3D 공용)', '선택 → 기준점 → 붙일 위치 반복 클릭'],
    ['erase', '지우기', '클릭한 도형 삭제 (= Delete 키)'],
    ['offset', '오프셋', '거리 입력 → 도형 클릭 → 방향 클릭 (평행 복사)'],
    ['mirror', '대칭', '선택 → 대칭축 두 점 클릭'],
    ['rotate', '회전', '선택 → 중심 클릭 → 각도 입력/클릭'],
    ['scale', '배율', '선택 → 기준점 → 배율 숫자(또는 참조 두 점)'],
    ['array', '배열', '선택 → 설정창 (직사각 행·열 / 원형 개수·각도)'],
    ['stretch', '신축', '걸침 영역 두 코너 → 기준점 → 이동점 (걸친 끝점만 이동)'],
    ['align', '정렬', '선택 → 원본 2점 → 목표 2점 (이동+회전, 배율 선택)'],
    ['trim', '자르기', '기준선들 클릭 → Space → 잘라낼 부분 클릭 (바로 Space=빠른 모드)'],
    ['extend', '연장', '늘릴 선의 끝쪽 클릭 → 가까운 경계까지 연장'],
    ['fillet', '모깎기', '반지름 입력 → 두 선(또는 폴리라인의 이웃한 두 변) 클릭 — 평면·3D 동일'],
    ['chamfer', '모따기', '거리 입력 → 두 선 클릭'],
    ['break', '끊기', '대상 → 두 점 클릭 → 사이 구간 제거'],
    ['breakpt', '한 점 끊기', '대상 → 한 점 클릭 → 그 지점에서 둘로 분리'],
    ['lengthen', '길이조정', '증감량(±) 입력 → 선의 끝쪽 클릭'],
    ['explode', '분해', '폴리라인·블록을 낱개 도형으로 (즉시 실행)'],
    ['join', '결합', '맞닿은 선들을 폴리라인으로 (즉시 실행)'],
    ['matchprop', '속성 일치', '원본 클릭 → 대상들 클릭 (레이어·색·선종류 복사)'],
    ['front', '맨 앞으로', '선택 도형의 그리기 순서를 맨 앞으로 (즉시 실행)'],
    ['back', '맨 뒤로', '선택 도형을 맨 뒤로 (즉시 실행)'],
    ['similar', '유사 선택', '같은 종류+레이어 도형 전부 선택 (즉시 실행)'],
  ]},
  { c: '치수·주석', items: [
    ['dim', '선형 치수', '두 점 → 치수선 위치 → 이후 클릭만으로 연속(체인) 기입'],
    ['dimrad', '반지름 치수', '원/호 클릭 → 문자 위치 (R값)'],
    ['dimdia', '지름 치수', '원/호 클릭 → 문자 위치 (⌀값)'],
    ['dimang', '각도 치수', '두 선 클릭 → 호 위치 (사이 각도)'],
  ]},
  { c: '측정·정보', items: [
    ['dist', '거리', '두 점 클릭 → 거리·ΔX·ΔY·각도 표시'],
    ['area', '면적', '도형 클릭 또는 점 지정 후 Enter → 면적·둘레'],
    ['sum', '합계', '선택 도형들의 총 길이·총 면적 (자재 산출, 즉시 실행)'],
    ['divide', '등분', '개수 입력 → 대상 클릭 → 등분점 ✕ 표식'],
    ['measure', '간격 표식', '간격 입력 → 대상 클릭 → 일정 간격 ✕ 표식'],
  ]},
  { c: '화면·표시', items: [
    ['zoom', '줌(영역 확대) · z', '확대할 영역을 드래그(또는 두 모서리 클릭)하면 그 박스만큼 확대'],
    ['ze', '전체보기 (fit)', '모든 도형이 보이도록 화면 맞춤 (F 키·전체보기 버튼과 동일)'],
    ['zp', '이전 뷰', '직전 화면으로 되돌아가기 (즉시 실행)'],
    ['pan', '화면 이동', '드래그로 화면 이동 (마우스 휠 드래그와 동일)'],
    ['vs 이름', '뷰 저장', '현재 화면을 이름으로 저장 (예: vs 평면)'],
    ['vg 이름', '뷰 이동', '저장한 화면으로 이동'],
    ['vl', '뷰 목록', '저장된 뷰 이름들 표시'],
    ['isolate', '레이어 격리', '선택 도형의 레이어만 표시, 나머지 숨김 (즉시 실행)'],
    ['uniso', '격리 해제', '모든 레이어 표시 (즉시 실행)'],
  ]},
  { c: 'BIM (2D→3D)', items: [
    ['wall', '벽 지정', '선/폴리라인 선택 후 실행 → 높이·두께 입력. 표면 위 곡선을 고르면 벽 바닥이 그 지형을 그대로 탐(높이는 균일 유지)'],
    ['slab', '슬래브 지정', '닫힌 폴리라인/원 선택 후 → 두께 입력 (바닥판)'],
    ['column', '기둥 지정', '원/닫힌 폴리라인 선택 후 → 높이 입력'],
    ['door', '문 배치', '벽 선을 클릭한 위치에 문 개구부 생성 (폭 입력)'],
    ['window', '창 배치', '벽 선을 클릭한 위치에 창 개구부 생성 (폭·씰 기본값)'],
    ['bimclear', 'BIM 해제', '선택 도형의 BIM 속성 제거'],
    ['3d', '3D 작업 뷰', '상단 [평면|3D] 토글과 동일 — 클릭=선택, 그립 드래그=높이, Del=삭제, Esc=선택해제/평면 복귀. BIM 미지정 도형은 층 바닥에 밑그림으로 표시, 지붕:보임/투명/숨김 토글'],
    ['section', '단면 추출', '절단선 두 점 → 방향 클릭 → 새 탭에 단면도 자동 생성(절단 해치+후방 투영)'],
    ['elevation', '입면 추출', '건물 밖에 기준선 → 건물 쪽 클릭 → 새 탭에 입면도 자동 생성'],
    ['level', '층(다층)', '그리기 설정 패널에서 층 전환/추가 — 새 도형은 현재 층에 생성, 다른 층은 흐리게 표시, BIM 높이 자동 반영'],
    ['roof', '지붕 지정', '닫힌 폴리라인 선택 후 → 박공/외쪽/평 + 처마 높이 + 상승 높이 — 3D 경사면·단면 사다리꼴 자동'],
    ['box', '상자', '모서리 2점 + 높이 — 작업면 위에 솔리드 상자'],
    ['cylinder', '원기둥', '중심·반지름·높이 — 작업면 위에 원기둥'],
    ['sphere', '구', '중심·반지름 — 구 메시 생성 (불리언·STL 가능)'],
    ['cone', '원뿔', '바닥 중심·반지름·높이 — 원뿔 메시 생성'],
    ['loft', '로프트', '곡선 2개+ 선택 → 이어서 면/입체 생성 (서로 다른 z에 두면 입체)'],
    ['sweep', '쓸기(라이노 Sweep1)', '단면+경로 곡선 선택 → 단면을 경로 따라 훑어 입체 (짧은 쪽=단면). 경로가 표면 위 곡선이면 그 높이를 그대로 따라감'],
    ['shell', '속 비우기', '닫힌 폴리라인 입체 선택 → 두께 입력, 속을 비워 통/중공으로'],
    ['filletedge', '모서리 모깎기(라이노 FilletEdge)', '입체 선택 → 반지름, 수직 모서리를 둥글게 (곡선 fillet과 다른 명령)'],
    ['group', '그룹', '2개+ 선택 → 묶기. 하나를 클릭하면 전체 선택'],
    ['ungroup', '그룹 해제', '그룹 구성원 선택 → 묶음 해제'],
    ['dimbase', '기준선 치수', '같은 기준점에서 여러 점까지 한 단씩 띄워 치수 기입'],
    ['revolve', '회전체', '프로필 곡선 선택 → 수직축 둘레로 회전 (x=축까지 거리, y=높이)'],
    ['slice', '절단', '입체 선택 후 z 입력 → 수평면으로 위/아래 두 조각 분리'],
    ['volume', '부피', '선택 입체의 부피(m³)·무게중심 계산'],
    ['qselect', '조건 선택', '종류/레이어/색으로 한 번에 선택 (예: circle, 벽체선, 색:#ff0000)'],
    ['stl', '3D 저장(STL)', '모든 입체를 STL 파일로 — 라이노·스케치업·3D프린터에서 열기'],
    ['obj', '3D 저장(OBJ)', '모든 입체를 OBJ 파일로 내보내기'],
    ['selectedexport', '선택 3D 저장', '선택한 객체만 STL/OBJ로 내보내기 (형식 선택)'],
    ['settop', '상단 정렬', '벽·기둥·계단 선택 후 상단 z 입력 — 높이가 그 z에 맞게 조정'],
    ['booleanunion', '합집합(라이노 BooleanUnion · bu)', '입체 2개+ 선택 → 하나로 합침 (결과 메시)'],
    ['booleandifference', '차집합(라이노 BooleanDifference · bd)', '남길 입체 선택 → booleandifference → 잘라낼 입체 선택 → Enter'],
    ['booleanintersection', '교집합(라이노 BooleanIntersection · bi)', '입체 2개+ 선택 → 겹치는 부분만 남김'],
    ['extrudecrv', '곡선 돌출(라이노)', '곡선 선택 후 높이 지정 — 기울어진 3D 뷰에선 마우스로 높이 끌기(클릭=확정)나 명령창 숫자 입력, 평면에선 수치 입력. 닫힌 곡선=솔리드, 열린 곡선=면'],
    ['extrudesrf', '면 두께(라이노)', '3D에서 실행 후 돌출할 면(두께0 면·닫힌 곡선)을 클릭 → 마우스로 두께 끌기/수치. 면을 솔리드로'],
    ['lighting', '조명 보기(야간)', '3D 뷰를 야간으로 바꾸고 배치한 조명 기구가 실제로 주변을 밝힘(부드러운 그림자 + 간접광 포함) — 다시 입력하면 OFF. 밝기·도달거리·그림자 부드러움·간접광 세기는 특성창에서 조절'],
    ['setaslight', '광원으로 지정', '선택한 개체를 광원으로 지정 — 형태·색·BIM 정체는 하나도 바뀌지 않고 광원 속성만 붙는다(정육면체 → 정육면체 광원체). 발광 위치는 개체가 놓인 자리: 입체·메시=형상 한가운데, 원=중심, 선·폴리라인=간격마다. 기본 800lm / 3000K. 세기(lm)·색온도(K)는 특성창에서, on/off·솔로는 사이드바 [광원] 패널에서. 3d 후 lighting 으로 확인'],
    ['unsetlight', '광원 해제', '광원 지정을 푼다 — 개체는 그대로 남는다'],
    ['raytrace', '레이트레이싱 렌더', '3D 뷰를 경로추적(path tracing)으로 렌더 — 지정한 광원의 직접광·그림자·간접광이 물리적으로 계산되어 프레임이 쌓이며 수렴한다. 환경은 기본이 완전한 어둠이라 광원이 없으면 검은 화면. 카메라를 움직이면 저해상도로 즉시 따라오고 놓으면 다시 수렴. WebGL2가 없으면 lighting(근사 모드)로 안내. 다시 입력하면 OFF'],
    ['rtenv', '렌더 환경', '태양 켜기/끄기 — sun 과 같다. 태양이 켜져 있으면 Raytraced 도 물리 하늘+태양으로, 꺼져 있으면 검은 환경(인공조명만 판별)으로 자동 전환된다'],
    ['exposure', '노출', 'Raytraced 화면의 노출. 실내 인공조명과 주광은 밝기가 2,000배 차이 나서 환경에 따라 자동으로 바뀐다. exposure 2.5e-5 처럼 직접 지정하거나 exposure auto 로 되돌린다'],
    ['ies', 'IES 배광', '조명기구 제조사의 .ies 파일을 광원에 붙인다 — 방향별 실측 광도를 그대로 재현. 광원을 선택하고 ies 입력. ies 해제 로 균등 배광 복귀. Raytraced 에서 보인다'],
    ['sun', '태양', '날짜·시각·위경도·진북으로 실제 태양 위치를 계산한다. 그냥 sun 이면 현재 값, sun 시각=14:30 처럼 설정. 주광 환경(rtenv)에서 하늘과 그림자에 반영된다'],
    ['railing', '난간 지정', '선/곡선/원 선택 후 → 높이·기둥 간격. 상단 손스침 + 동자기둥. 표면 위 곡선이면 그 높이를 따라 기울어짐(발코니는 닫힌 폴리라인)'],
    ['stair', '계단 지정', '진행 방향 선/곡선(시작=아랫단) 선택 후 → 폭·총높이·최대 단높이. 곡선이면 각 단이 진행방향에 직교(L자·아치형), 표면 위 곡선이면 그 시작·끝 높이를 사용(단높이는 균일)'],
  ]},
  { c: '기타', items: [
    ['undo', '실행취소', 'Ctrl+Z와 동일'],
    ['redo', '다시실행', 'Ctrl+Y와 동일'],
    ['select', '선택 도구', '클릭/박스 선택으로 복귀 (= Esc)'],
    ['help', '명령어 목록', '이 창 열기 (? 도 가능)'],
  ]},
  { c: '키보드', items: [
    ['Space/Enter', '확정·반복', '입력 확정 / 빈 칸에서 직전 명령 반복'],
    ['Esc', '취소', '명령 취소, 선택 해제'],
    ['Delete', '삭제', '선택 도형 삭제'],
    ['Ctrl+Z / Y', '취소/복구', '실행취소 / 다시실행'],
    ['Ctrl+S', '저장', '클라우드 도면이면 클라우드로, 아니면 DXF 저장'],
    ['Ctrl+A / C / V', '전체·복사·붙여넣기', '전체 선택 / 복사 / 고스트 미리보기 배치'],
    ['F3 / F8', '스냅/직교', '객체 스냅 켬끔 / 직교 모드 켬끔'],
    ['문자 더블클릭', '문자 수정', '문자 내용 바로 편집'],
  ]},
];
function openCmdHelp() {
  const dlg = document.getElementById('helpDlg');
  if (!dlg) return;
  renderCmdHelp('');
  const s = document.getElementById('helpSearch');
  s.value = '';
  dlg.style.display = 'flex';
  setTimeout(() => s.focus(), 50);
}
function renderCmdHelp(q) {
  // 별칭 역조회: 도구명 → 짧은 별칭들
  const rev = {};
  for (const [a, t] of Object.entries(CMD_ALIASES)) { if (a === t) continue; (rev[t] = rev[t] || []).push(a); }
  q = (q || '').trim().toLowerCase();
  const html = CMD_HELP.map(sec => {
    const rows = sec.items.filter(([n, ko, d]) => {
      if (!q) return true;
      const al = (rev[n] || []).join(' ');
      return (n + ' ' + ko + ' ' + d + ' ' + al).toLowerCase().includes(q);
    }).map(([n, ko, d]) => {
      const al = (rev[n] || []).join(', ');
      return `<div style="display:grid;grid-template-columns:105px 62px 1fr;gap:8px;padding:4px 6px;border-radius:7px;align-items:baseline;" class="helpRow">
        <span style="font-family:var(--mono);color:var(--accent-text);">${escapeHtml(n)}</span>
        <span style="font-family:var(--mono);color:var(--muted);font-size:11px;">${escapeHtml(al)}</span>
        <span><b style="font-weight:590;">${escapeHtml(ko)}</b> — <span style="color:var(--muted);">${escapeHtml(d)}</span></span>
      </div>`;
    }).join('');
    if (!rows) return '';
    return `<div style="margin:8px 0 2px;font-size:11px;font-weight:700;letter-spacing:.5px;color:var(--accent-text);text-transform:uppercase;">${sec.c}</div>` + rows;
  }).join('');
  document.getElementById('helpList').innerHTML = html || '<div style="color:var(--muted);padding:12px;">검색 결과가 없습니다.</div>';
}
(function bindCmdHelp() {
  const dlg = document.getElementById('helpDlg');
  if (!dlg) return;
  document.getElementById('btnCmdHelp').addEventListener('click', openCmdHelp);
  document.getElementById('helpClose').addEventListener('click', () => dlg.style.display = 'none');
  dlg.addEventListener('pointerdown', (e) => { if (e.target === dlg) dlg.style.display = 'none'; e.stopPropagation(); });
  document.getElementById('helpSearch').addEventListener('input', (e) => renderCmdHelp(e.target.value));
  document.getElementById('helpSearch').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') dlg.style.display = 'none'; });
})();

const COMMAND_LIST = [
  { name: 'centerline', ko: '중심선' }, { name: 'revcloud', ko: '구름마크' },
  { name: 'frame', ko: '도곽(표제란)' }, { name: 'align', ko: '정렬' },
  { name: 'isolate', ko: '레이어 격리' }, { name: 'uniso', ko: '격리 해제' },
  { name: 'sum', ko: '길이·면적 합계' }, { name: 'xline', ko: '구성선' },
  { name: 'breakpt', ko: '한 점 끊기' },
  { name: 'help', ko: '명령어 목록(?)' },
  { name: 'wall', ko: 'BIM 벽 지정' }, { name: 'slab', ko: 'BIM 슬래브' },
  { name: 'column', ko: 'BIM 기둥' }, { name: 'door', ko: 'BIM 문' },
  { name: 'window', ko: 'BIM 창' }, { name: 'bimclear', ko: 'BIM 해제' },
  { name: '3d', ko: '3D 뷰' },
  { name: 'section', ko: '단면 추출' }, { name: 'elevation', ko: '입면 추출' },
  { name: 'level', ko: '층 정보' }, { name: 'roof', ko: 'BIM 지붕' }, { name: 'stair', ko: 'BIM 계단' }, { name: 'railing', ko: 'BIM 난간', d3: 1 }, { name: 'setaslight', ko: '광원으로 지정', d3: 1 }, { name: 'raytrace', ko: '레이트레이싱 렌더', d3: 1 }, { name: 'rtenv', ko: '렌더 환경(주광)', d3: 1 }, { name: 'sun', ko: '태양', d3: 1 }, { name: 'ies', ko: 'IES 배광', d3: 1 }, { name: 'exposure', ko: '렌더 노출', d3: 1 }, { name: 'falsecolor', ko: '조도 색표시', d3: 1 }, { name: 'addsensorplane', ko: '측정면 추가', d3: 1 }, { name: 'sensorcsv', ko: '조도 CSV', d3: 1 }, { name: 'unsetlight', ko: '광원 해제', d3: 1 }, { name: 'lighting', ko: '조명 보기(야간)', d3: 1 },
  { name: 'extrudecrv', ko: '곡선 돌출(마우스·수치)', d3: 1 }, { name: 'extrudesrf', ko: '면 두께(마우스·수치)', d3: 1 },
  { name: 'box', ko: '상자', d3: 1 }, { name: 'cylinder', ko: '원기둥', d3: 1 }, { name: 'settop', ko: '상단 정렬', d3: 1 },
  { name: 'stl', ko: '3D 저장 STL', d3: 1 }, { name: 'obj', ko: '3D 저장 OBJ', d3: 1 }, { name: 'selectedexport', ko: '선택 3D 저장', d3: 1 },
  { name: 'booleanunion', ko: '합집합', d3: 1 }, { name: 'booleandifference', ko: '차집합', d3: 1 }, { name: 'booleanintersection', ko: '교집합', d3: 1 },
  { name: 'sphere', ko: '구', d3: 1 }, { name: 'cone', ko: '원뿔', d3: 1 },
  { name: 'line', ko: '선' }, { name: 'polyline', ko: '폴리라인' }, { name: 'rectangle', ko: '사각형' },
  { name: 'circle', ko: '원' }, { name: 'arc', ko: '호' }, { name: 'text', ko: '문자' },
  { name: 'move', ko: '이동', d3: 1 }, { name: 'erase', ko: '지우기' }, { name: 'select', ko: '선택' },
  { name: 'pan', ko: '화면 이동' }, { name: 'offset', ko: '오프셋' }, { name: 'copy', ko: '복사', d3: 1 },
  { name: 'mirror', ko: '대칭', d3: 1 }, { name: 'rotate', ko: '회전', d3: 1 }, { name: 'array', ko: '배열', d3: 1 },
  { name: 'trim', ko: '자르기' }, { name: 'extend', ko: '연장' }, { name: 'fillet', ko: '모깎기' },
  { name: 'scale', ko: '배율', d3: 1 }, { name: 'stretch', ko: '신축' },
  { name: 'polygon', ko: '다각형' }, { name: 'ellipse', ko: '타원' }, { name: 'chamfer', ko: '모따기' },
  { name: 'explode', ko: '분해' }, { name: 'join', ko: '결합' }, { name: 'dim', ko: '치수 기입' },
  { name: 'dist', ko: '거리 측정' }, { name: 'area', ko: '면적' }, { name: 'zoom', ko: '줌(영역 확대)' }, { name: 'ze', ko: '전체보기' },
  { name: 'undo', ko: '실행취소' }, { name: 'redo', ko: '다시실행' },
  { name: 'break', ko: '끊기' }, { name: 'lengthen', ko: '길이조정' }, { name: 'hatch', ko: '해치' },
  { name: 'dimradius', ko: '반지름 치수' }, { name: 'dimdiameter', ko: '지름 치수' },
  { name: 'block', ko: '블록 정의' }, { name: 'insert', ko: '블록 삽입' }, { name: 'matchprop', ko: '속성 일치' },
  { name: 'dimangular', ko: '각도 치수' }, { name: 'divide', ko: '등분' }, { name: 'measure', ko: '간격 표식' },
  { name: 'leader', ko: '지시선' }, { name: 'front', ko: '맨 앞으로' }, { name: 'back', ko: '맨 뒤로' }, { name: 'similar', ko: '유사 선택' },
];
const sugEl = document.getElementById('cmdSuggest');
let sugMatches = [], sugIndex = -1;
const is3DView = is3DActive;   // 같은 검사가 두 벌이었다 — 이름만 다른 복제였다
function computeMatches(text) {
  const t = text.trim().toLowerCase();
  if (!t || /^[-@\d.]/.test(t)) return []; // 빈칸/좌표·숫자 입력이면 제안 안 함
  const in3d = is3DView();
  const starts = [], contains = [];
  for (const c of COMMAND_LIST) {
    if (c.d3 && !in3d) continue; // 3D 전용 명령은 3D 뷰에서만 제안 (평면 작업 방해 안 함)
    const n = c.name;
    if (n.startsWith(t)) starts.push(c);
    else if (n.includes(t)) contains.push(c);
  }
  return starts.concat(contains).slice(0, 10);
}
function renderSuggest(text) {
  if (!sugEl) return;
  sugMatches = computeMatches(text);
  if (!sugMatches.length) { hideSuggest(); return; }
  const t = text.trim().toLowerCase();
  sugIndex = 0;
  sugEl.innerHTML = sugMatches.map((c, i) => {
    const n = c.name, idx = n.toLowerCase().indexOf(t);
    const disp = idx < 0 ? escapeHtml(n)
      : escapeHtml(n.slice(0, idx)) + '<span class="match">' + escapeHtml(n.slice(idx, idx + t.length)) + '</span>' + escapeHtml(n.slice(idx + t.length));
    return `<div class="sugItem${i === 0 ? ' sel' : ''}" data-name="${n}"><span class="sname">${disp}</span><span class="sko">${escapeHtml(c.ko)}</span></div>`;
  }).join('');
  sugEl.classList.add('open');
  sugEl.querySelectorAll('.sugItem').forEach(el =>
    el.addEventListener('mousedown', (e) => { e.preventDefault(); selectSuggestion(el.dataset.name); }));
}
function hideSuggest() { if (sugEl) { sugEl.classList.remove('open'); sugEl.innerHTML = ''; } sugMatches = []; sugIndex = -1; }
function moveSuggest(d) {
  if (!sugMatches.length) return;
  sugIndex = (sugIndex + d + sugMatches.length) % sugMatches.length;
  const items = sugEl.querySelectorAll('.sugItem');
  items.forEach((el, i) => el.classList.toggle('sel', i === sugIndex));
  if (items[sugIndex]) items[sugIndex].scrollIntoView({ block: 'nearest' });
}
function selectSuggestion(name) { cmdInputEl.value = ''; hideSuggest(); runCommandInput(name); }

// 명령행 입력 — Enter/스페이스 = 확정(자동완성 선택), 빈 칸이면 직전 명령 반복
// 데스크톱(터치 없음)에서는 명령창을 항상 활성화 — 클릭/명령 후에도 바로 타이핑 가능
// (터치 기기는 가상 키보드가 계속 떠버리므로 제외; 기존 치수-프롬프트 자동 포커스만 사용)
const ALWAYS_FOCUS_CMD = (navigator.maxTouchPoints || 0) === 0;
if (cmdInputEl && ALWAYS_FOCUS_CMD) {
  const refocus = () => setTimeout(() => {
    if (document.body.classList.contains('authLocked')) return; // 로그인 게이트 열림
    if (document.querySelector('.dropdown.open')) return;       // 메뉴가 열려 있으면 간섭하지 않음
    if (textSelActive()) return; // 채팅 텍스트를 긁는 중 — 포커스를 뺏으면 선택이 죽어 Ctrl+C 복사가 안 된다
    // 다른 입력요소(레이어명·옵션·다이얼로그 등)가 포커스를 가져갔으면 뺏지 않음
    const a = document.activeElement;
    if (!a || a === document.body || a.tagName === 'BUTTON' || a.tagName === 'CANVAS')
      cmdInputEl.focus({ preventScroll: true });
  }, 0);
  cmdInputEl.addEventListener('blur', refocus);
  window.addEventListener('mouseup', refocus);
  setTimeout(() => cmdInputEl.focus({ preventScroll: true }), 0);
}
if (cmdInputEl) {
  cmdInputEl.addEventListener('input', () => renderSuggest(cmdInputEl.value));
  cmdInputEl.addEventListener('blur', () => setTimeout(hideSuggest, 150));
  cmdInputEl.addEventListener('keydown', (ev) => {
    // F8(직교)/F3(객체스냅)/F2(명령 기록 토글)는 전역 핸들러가 처리 — 여기서 가로채지 않고 통과
    if (ev.key === 'F8' || ev.key === 'F3' || ev.key === 'F2') return;
    // 입력창이 항상 포커스되므로, 앱 전역 단축키를 여기서도 처리
    if (ev.ctrlKey) {
      const k = (typeof ev.key === 'string' ? ev.key : '').toLowerCase(); // key 없는 합성 이벤트 방어
      if (k === 'z') { ev.preventDefault(); ev.stopPropagation(); undo(); return; }
      if (k === 'y') { ev.preventDefault(); ev.stopPropagation(); redo(); return; }
      if (k === 's') { ev.preventDefault(); ev.stopPropagation(); saveDXF(); return; }
      if (cmdInputEl.value === '') { // 텍스트 편집과 겹치지 않을 때만
        if (k === 'a') { ev.preventDefault(); ev.stopPropagation(); state.entities.forEach(e => { if (onLv(e)) state.selection.add(e.id); }); renderProps(); draw(); return; }
        if (k === 'c') { if (textSelActive()) return; ev.preventDefault(); ev.stopPropagation(); copySelection(); return; }
        if (k === 'v') { ev.preventDefault(); ev.stopPropagation(); startPaste(); return; }
      }
    }
    if (ev.key === 'Delete' && cmdInputEl.value === '') { // 빈 입력창에서 Delete = 선택 삭제
      ev.preventDefault(); ev.stopPropagation(); deleteSelection(); return;
    }
    if (sugMatches.length && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
      ev.preventDefault(); ev.stopPropagation(); moveSuggest(ev.key === 'ArrowDown' ? 1 : -1); return;
    }
    if (sugMatches.length && ev.key === 'Tab') {
      ev.preventDefault(); ev.stopPropagation();
      cmdInputEl.value = sugMatches[sugIndex < 0 ? 0 : sugIndex].name; renderSuggest(cmdInputEl.value); return;
    }
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault(); ev.stopPropagation();
      if (sugMatches.length && sugIndex >= 0) { selectSuggestion(sugMatches[sugIndex].name); return; }
      const v = cmdInputEl.value; cmdInputEl.value = ''; hideSuggest();
      if (v.trim() === '') emptyEnterAction(); else runCommandInput(v);
      return;
    }
    if (ev.key === 'Escape') {
      if (sugMatches.length) { hideSuggest(); }
      else if (extrudePend) { extrudePendCancel(); cmdInputEl.value = ''; }
      else { cmdInputEl.value = ''; cmdInputEl.blur(); setTool('select'); state.selection.clear(); renderProps(); draw(); }
    }
    ev.stopPropagation();
  });
}
// 입력 필드 밖에서 스페이스바 = (작도 중이면 종료) 직전 명령 반복(CAD 관습)
window.addEventListener('keydown', (ev) => {
  if (ev.key === ' ' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) {
    ev.preventDefault(); emptyEnterAction();
  }
});

// ============================================================
//  DXF 쓰기 (R12 ASCII — 호환성 우선)
// ============================================================
// ACI(AutoCAD Color Index) 기본 팔레트 — 62번 코드용 근사값
const ACI_PALETTE = {
  1: [255, 0, 0], 2: [255, 255, 0], 3: [0, 255, 0], 4: [0, 255, 255], 5: [0, 0, 255],
  6: [255, 0, 255], 7: [255, 255, 255], 8: [128, 128, 128], 9: [192, 192, 192],
  // 자주 쓰는 중간색(표준 ACI 값) — 근사 품질을 위해 확장
  10: [255, 0, 0], 20: [255, 63, 0], 30: [255, 127, 0], 40: [255, 191, 0], 50: [255, 255, 0],
  60: [191, 255, 0], 70: [127, 255, 0], 80: [63, 255, 0], 90: [0, 255, 0], 100: [0, 255, 63],
  110: [0, 255, 127], 120: [0, 255, 191], 130: [0, 255, 255], 140: [0, 191, 255], 150: [0, 127, 255],
  160: [0, 63, 255], 170: [0, 0, 255], 180: [63, 0, 255], 190: [127, 0, 255], 200: [191, 0, 255],
  210: [255, 0, 255], 220: [255, 0, 191], 230: [255, 0, 127], 240: [255, 0, 63],
  250: [51, 51, 51], 251: [80, 80, 80], 252: [105, 105, 105], 253: [130, 130, 130], 254: [190, 190, 190], 255: [255, 255, 255],
};
function hexToRgb(hex) {
  const h = rgbHex(hex).replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
// 62번(ACI) 코드용 — 팔레트에서 가장 가까운 색번호. 예전엔 8개 hex만 정확히 일치시키고
// 나머지를 전부 7(흰색)으로 떨어뜨려서, 라이노에서 대부분의 레이어가 같은 색으로 보였다
// (= "레이어가 적용되지 않은" 것처럼 보이던 원인). 이제 최근접 색으로 근사한다.
function dxfColorIndex(hex) {
  const [r, g, b] = hexToRgb(hex);
  let best = 7, bestD = Infinity;
  for (const k in ACI_PALETTE) {
    const [pr, pg, pb] = ACI_PALETTE[k];
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestD) { bestD = d; best = +k; }
  }
  return best;
}
// 420번(트루컬러) 코드용 — 24비트 RGB 정수. 라이노·오토캐드는 420이 있으면 이 값을 쓰므로
// 62의 근사 오차와 무관하게 화면 색이 정확히 재현된다.
function dxfTrueColor(hex) { const [r, g, b] = hexToRgb(hex); return (r << 16) | (g << 8) | b; }
// 엔티티 지오메트리 시그니처 — DXF 저장/불러오기에서 BIM 속성·z값을 같은 도형에 재결합하기 위한 키
function entSig(e) {
  const R = v => Math.round((+v || 0) * 100) / 100;
  switch (e.type) {
    case 'LINE': return 'L' + R(e.x1) + ',' + R(e.y1) + ',' + R(e.x2) + ',' + R(e.y2);
    case 'LWPOLYLINE': return 'P' + (e.closed ? 1 : 0) + ':' + (e.points || []).map(p => R(p[0]) + ',' + R(p[1])).join(';');
    case 'CIRCLE': return 'C' + R(e.cx) + ',' + R(e.cy) + ',' + R(e.r);
    case 'ARC': return 'A' + R(e.cx) + ',' + R(e.cy) + ',' + R(e.r) + ',' + R(e.startAngle) + ',' + R(e.endAngle);
    case 'TEXT': return 'T' + R(e.x) + ',' + R(e.y) + ',' + String(e.text || '').slice(0, 24);
  }
  return null;
}
function buildDXFText() {
  const L = [];
  const g = (code, val) => { L.push(code); L.push(val); };
  let handle = 0x100;                                  // 엔티티/테이블 핸들
  const H = () => (handle++).toString(16).toUpperCase();

  // 소유자(330) 참조에 필요한 핸들은 먼저 확보 — R13+ DXF는 모든 엔티티가 소유 블록레코드를 가리켜야 함
  const hBlkRecTab = H(), hMSpace = H(), hPSpace = H(), hDictRoot = H(), hDictGroup = H();
  const blkNames = Object.keys(state.blocks || {});
  const hBlkRec = {}; for (const nm of blkNames) hBlkRec[nm] = H();

  // Parti 확장(999 주석)은 파일 선두에 — 주석의 표준 위치(다른 CAD는 건너뜀)
  {
    const wcx = { v: 1, ext: [], mesh: [], img: [] };
    for (const e of state.entities) {
      if (e.type === 'MESH') { wcx.mesh.push((e.tris || []).length); continue; }
      // 이미지: 표준 DXF IMAGE 엔티티는 외부 파일 경로를 참조하는 방식이라 브라우저에서 같이 배포할
      // 파일이 없다. 그래서 정의 전체(데이터 URL 포함)를 WCX에 담는다 — 다른 CAD는 999 주석을
      // 건너뛰므로 호환성에 영향이 없고, Parti에서 열면 효과까지 그대로 복원된다.
      if (e.type === 'IMAGE') {
        wcx.img.push({
          layer: e.layer, lv: e.lv || 0, x: e.x, y: e.y, w: e.w, h: e.h,
          rot: e.rot || 0, op: e.op != null ? e.op : 1, sat: e.sat != null ? e.sat : 1,
          bri: e.bri != null ? e.bri : 1, flip: e.flip ? 1 : 0, src: e.src,
        });
        continue;
      }
      const sig = entSig(e); if (!sig) continue;
      const x = {};
      if (e.bim) x.bim = e.bim;
      if (e.lightId) x.lightId = e.lightId; // 광원 참조 (속성 본체는 wcx.lights)
      if (e.grp) x.grp = e.grp;
      if (e.zo) x.zo = e.zo;
      if (e.z1 != null) x.z1 = e.z1;
      if (e.z2 != null) x.z2 = e.z2;
      if (polyHasZ(e)) x.zs = e.zs; // 표면 위 곡선의 정점별 높이
      if (Object.keys(x).length) wcx.ext.push([sig, x]);
    }
    if (state.sensors.length) { wcx.sensors = state.sensors.map(S => ({ id:S.id, x0:S.x0, y0:S.y0, x1:S.x1, y1:S.y1, z:S.z, spacing:S.spacing })); wcx.nextSensorId = state.nextSensorId; }
    if (state.lights.length) { // _missing 은 실행 중 표시라 저장하지 않는다
      wcx.lights = state.lights.map(L => { const c = Object.assign({}, L); delete c._missing; return c; });
      wcx.nextLightId = state.nextLightId;
    }
    if (wcx.ext.length || wcx.mesh.length || wcx.img.length || wcx.lights || wcx.sensors) {
      const js = JSON.stringify(wcx);
      for (let i = 0; i < js.length; i += 200) g(999, 'WCX' + js.slice(i, i + 200));
    }
  }
  // 손그림 스케치(Sketch Layer) — 새 철학: 손그림은 파일과 함께 산다.
  // WCX 와 같은 999 주석 방식(WSK) — 다른 CAD 는 주석을 무시하므로 호환 무해.
  // 스트로크가 없으면 아무것도 쓰지 않는다 (기존 파일 출력 완전 불변).
  try {
    const skS = window.WEBCAD_SKETCH && window.WEBCAD_SKETCH.SK.strokes;
    if (skS && skS.length) {
      const js2 = JSON.stringify({ v: 1, strokes: skS });
      if (js2.length < 2e6) for (let i = 0; i < js2.length; i += 200) g(999, 'WSK' + js2.slice(i, i + 200));
      else logLine('  스케치가 너무 커서 DXF 에 담지 못했습니다 (브라우저 저장은 유지).', 'warn');
    }
  } catch (eSk) { console.warn('스케치 DXF 기록 실패(무시):', eSk); }

  // HEADER — AC1021(R2007): UTF-8이라 한글 레이어명 안전
  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1021');
  // $DWGCODEPAGE: R2007 내용은 UTF-8이지만, 이 변수가 없으면 파서가 인코딩 판별에 실패해
  // 한글 레이어·문자에서 디코딩 오류를 냄(실측 확인). 실제 R2007 파일도 이 값을 그대로 씀.
  g(9, '$DWGCODEPAGE'); g(3, 'ANSI_1252');
  g(9, '$INSUNITS'); g(70, ({ mm: 4, cm: 5, m: 6, in: 1 })[settings.units] || 4); // 단위 설정 반영
  g(9, '$HANDSEED'); g(5, 'FFFFF');
  g(0, 'ENDSEC');

  // CLASSES — R13+ 필수 섹션 (내용 없어도 존재해야 함)
  g(0, 'SECTION'); g(2, 'CLASSES'); g(0, 'ENDSEC');

  // TABLES
  // R13+ 규칙: 심볼 테이블은 330=0(루트 소유), 각 레코드는 330=소속 테이블 핸들을 가져야 한다.
  // 이게 없으면 라이노는 파일은 열되 레이어 테이블을 무시하고 전부 기본 레이어에 올린다(실측).
  const tbl = (name, count) => { const h = H(); g(0, 'TABLE'); g(2, name); g(5, h); g(330, '0'); g(100, 'AcDbSymbolTable'); g(70, count); return h; };
  const rec = (type, ownerH, sub) => { g(0, type); g(5, H()); g(330, ownerH); g(100, 'AcDbSymbolTableRecord'); g(100, sub); };
  g(0, 'SECTION'); g(2, 'TABLES');
  // VPORT — 필수
  const hVportTab = tbl('VPORT', 1);
  rec('VPORT', hVportTab, 'AcDbViewportTableRecord');
  g(2, '*Active'); g(70, 0);
  g(10, 0); g(20, 0); g(11, 1); g(21, 1); g(12, 0); g(22, 0); g(13, 0); g(23, 0);
  g(14, 10); g(24, 10); g(15, 10); g(25, 10); g(16, 0); g(26, 0); g(36, 1);
  g(17, 0); g(27, 0); g(37, 0); g(40, 1000); g(41, 1.5); g(42, 50); g(43, 0); g(44, 0);
  g(50, 0); g(51, 0); g(71, 0); g(72, 100); g(73, 1); g(74, 3); g(75, 0); g(76, 0); g(77, 0); g(78, 0);
  g(0, 'ENDTAB');
  // LTYPE — ByBlock/ByLayer 레코드가 반드시 있어야 함
  const LTDEF = { dashed: [6, -3], hidden: [4, -3], center: [12, -3, 3, -3], phantom: [16, -3, 3, -3, 3, -3], dot: [0, -3] };
  const usedLts = new Set(['continuous']);
  for (const l of state.layers) if (l.linetype && LTDEF[l.linetype]) usedLts.add(l.linetype);
  for (const e of state.entities) if (e.linetype && LTDEF[e.linetype]) usedLts.add(e.linetype);
  const hLtypeTab = tbl('LTYPE', usedLts.size + 2);
  const ltRec = (name, desc, pat) => {
    rec('LTYPE', hLtypeTab, 'AcDbLinetypeTableRecord');
    g(2, name); g(70, 0); g(3, desc); g(72, 65); g(73, pat ? pat.length : 0);
    g(40, pat ? pat.reduce((s, v) => s + Math.abs(v), 0) : 0);
    if (pat) for (const v of pat) g(49, v);
  };
  ltRec('ByBlock', '', null); ltRec('ByLayer', '', null); ltRec('CONTINUOUS', 'Solid line', null);
  for (const lt of usedLts) { if (lt === 'continuous') continue; ltRec(lt.toUpperCase(), lt, LTDEF[lt]); }
  g(0, 'ENDTAB');
  // LAYER
  const hLayerTab = tbl('LAYER', state.layers.length);
  for (const l of state.layers) {
    rec('LAYER', hLayerTab, 'AcDbLayerTableRecord');
    g(2, l.name); g(70, l.visible ? 0 : 1);
    g(62, (l.visible ? 1 : -1) * dxfColorIndex(l.color)); // 음수 = 레이어 꺼짐
    g(420, dxfTrueColor(l.color)); // 트루컬러 — 레이어 색을 정확히 전달
    g(6, (l.linetype && LTDEF[l.linetype]) ? l.linetype.toUpperCase() : 'CONTINUOUS');
    g(370, (l.lineweight != null && l.lineweight >= 0) ? l.lineweight : -3); // -3 = 기본(ByLayer 두께)
    // 390(플롯스타일)·347(재질)은 실제 객체 핸들을 가리켜야 하는 하드 포인터라 생략한다.
    // 예전엔 g(390,'F')로 존재하지도 않는 핸들을 썼는데, 이 끊어진 참조 때문에 라이노가
    // 레이어 레코드를 통째로 버리고 모든 객체를 기본 레이어에 올렸다. 선택 필드는 없는 게 정답.
  }
  g(0, 'ENDTAB');
  // STYLE — TEXT가 참조하는 문자 스타일
  const hStyleTab = tbl('STYLE', 1);
  rec('STYLE', hStyleTab, 'AcDbTextStyleTableRecord');
  g(2, 'Standard'); g(70, 0); g(40, 0); g(41, 1); g(50, 0); g(71, 0); g(42, 2.5); g(3, 'txt'); g(4, '');
  g(0, 'ENDTAB');
  // VIEW / UCS — 비어 있어도 테이블 자체는 존재해야 함
  tbl('VIEW', 0); g(0, 'ENDTAB');
  tbl('UCS', 0); g(0, 'ENDTAB');
  // APPID
  const hAppidTab = tbl('APPID', 1);
  rec('APPID', hAppidTab, 'AcDbRegAppTableRecord'); g(2, 'ACAD'); g(70, 0);
  g(0, 'ENDTAB');
  // DIMSTYLE — 레코드 핸들 코드가 5가 아니라 105 (표준)
  const hDimTab = H();
  g(0, 'TABLE'); g(2, 'DIMSTYLE'); g(5, hDimTab); g(330, '0'); g(100, 'AcDbSymbolTable'); g(70, 1); g(100, 'AcDbDimStyleTable'); g(71, 0);
  g(0, 'DIMSTYLE'); g(105, H()); g(330, hDimTab); g(100, 'AcDbSymbolTableRecord'); g(100, 'AcDbDimStyleTableRecord'); g(2, 'Standard'); g(70, 0);
  g(0, 'ENDTAB');
  // BLOCK_RECORD — R13+ 필수. 모든 블록(모델/페이퍼 공간 포함)의 소유 레코드
  g(0, 'TABLE'); g(2, 'BLOCK_RECORD'); g(5, hBlkRecTab); g(330, '0'); g(100, 'AcDbSymbolTable'); g(70, 2 + blkNames.length);
  const blkRec = (h, nm) => { g(0, 'BLOCK_RECORD'); g(5, h); g(330, hBlkRecTab); g(100, 'AcDbSymbolTableRecord'); g(100, 'AcDbBlockTableRecord'); g(2, nm); g(70, 0); };
  blkRec(hMSpace, '*Model_Space');
  blkRec(hPSpace, '*Paper_Space');
  for (const nm of blkNames) blkRec(hBlkRec[nm], nm);
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  // BLOCKS — *Model_Space/*Paper_Space 는 필수, 그 뒤 사용자 블록
  g(0, 'SECTION'); g(2, 'BLOCKS');
  const emitBlock = (nm, owner, ents) => {
    g(0, 'BLOCK'); g(5, H()); g(330, owner); g(100, 'AcDbEntity'); g(8, '0'); g(100, 'AcDbBlockBegin');
    g(2, nm); g(70, 0); g(10, 0); g(20, 0); g(30, 0); g(3, nm); g(1, '');
    for (const ce of (ents || [])) writeEntity(g, ce, H, owner);
    g(0, 'ENDBLK'); g(5, H()); g(330, owner); g(100, 'AcDbEntity'); g(8, '0'); g(100, 'AcDbBlockEnd');
  };
  emitBlock('*Model_Space', hMSpace, []);
  emitBlock('*Paper_Space', hPSpace, []);
  for (const nm of blkNames) emitBlock(nm, hBlkRec[nm], exportHatchExpand(state.blocks[nm].entities));
  g(0, 'ENDSEC');

  // ENTITIES — 모두 모델 공간 소유
  g(0, 'SECTION'); g(2, 'ENTITIES');
  for (const e of exportEntities(true)) writeEntity(g, e, H, hMSpace); // INSERT 보존, HATCH는 선으로 분해
  g(0, 'ENDSEC');

  // OBJECTS — R13+ 필수. 루트 딕셔너리
  g(0, 'SECTION'); g(2, 'OBJECTS');
  g(0, 'DICTIONARY'); g(5, hDictRoot); g(330, '0'); g(100, 'AcDbDictionary'); g(281, 1); g(3, 'ACAD_GROUP'); g(350, hDictGroup); // 330/0 = 루트(소유자 없음)
  g(0, 'DICTIONARY'); g(5, hDictGroup); g(330, hDictRoot); g(100, 'AcDbDictionary'); g(281, 1);
  g(0, 'ENDSEC'); // (Parti 999 확장은 파일 선두로 이동 — ENDSEC~EOF 사이 주석은 엄격한 파서가 거부)
  g(0, 'EOF');

  // 코드/값 쌍을 줄로
  let out = '';
  for (let i = 0; i < L.length; i += 2) {
    out += String(L[i]).padStart(3, ' ') + '\n' + L[i + 1] + '\n';
  }
  return out;
}
// DXF 저장 — 모바일은 공유시트(파일 앱 저장), 데스크톱은 다운로드
// 공통 저장: 모바일은 공유시트(파일 앱), 데스크톱은 다운로드
async function saveBlob(blob, fname) {
  const ua = navigator.userAgent || '';
  const isiOS = /iPad|iPhone|iPod/.test(ua) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform || ''));
  const isCoarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if ((isiOS || isCoarse) && navigator.share) {
    try {
      const file = new File([blob], fname, { type: blob.type });
      if (!navigator.canShare || navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: fname });
        logLine('  ✔ ' + fname + ' 공유/저장 완료', 'ok');
        return;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return; // 사용자가 취소
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fname;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  logLine('  ✔ ' + fname + ' 저장', 'ok');
}
const DXF_PICKER_TYPES = [{ description: 'DXF 도면', accept: { 'application/dxf': ['.dxf'] } }];
// ---------- 링크 공유 (서버 불필요, 도면을 압축해 URL에 담음) ----------
function b64ToUrl(b64) { return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function urlToB64(u) { u = u.replace(/-/g, '+').replace(/_/g, '/'); while (u.length % 4) u += '='; return u; }
async function shareEncode(str) {
  if (window.CompressionStream) {
    const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
    const buf = new Uint8Array(await new Response(stream).arrayBuffer());
    let bin = ''; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    return 'g' + b64ToUrl(btoa(bin));
  }
  return 'r' + b64ToUrl(btoa(unescape(encodeURIComponent(str)))); // 폴백(비압축)
}
async function shareDecode(enc) {
  const mode = enc[0], bin = atob(urlToB64(enc.slice(1)));
  if (mode === 'r') return decodeURIComponent(escape(bin));
  const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}
function drawingPayload() {
  return JSON.stringify({ v: 1, entities: liveEnts(), layers: state.layers, currentLayer: state.currentLayer, blocks: state.blocks, matlib: state.matlib, sun: state.sun, nextId: state.nextId, view: state.view, fileName: currentFileName });
}
async function shareLink() {
  if (!state.entities.length) { logLine('  공유할 도형이 없습니다.', 'warn'); return; }
  const enc = await shareEncode(drawingPayload());
  const url = location.origin + location.pathname + '#d=' + enc;
  if (url.length > 30000) { logLine(`  ⚠ 도면이 커서 링크가 매우 깁니다(${url.length}자). 일부 앱에서 잘릴 수 있어요. DXF 저장 후 공유를 권장합니다.`, 'warn'); }
  let copied = false;
  try { await navigator.clipboard.writeText(url); copied = true; } catch (e) {}
  logLine(`  ✔ 공유 링크 생성 (${(url.length / 1024).toFixed(1)}KB)${copied ? ' — 클립보드에 복사됨' : ''}`, 'ok');
  showShareResult(url, copied);
}
async function loadFromHash() {
  const m = location.hash.match(/^#d=(.+)$/);
  if (!m) return false;
  try {
    const data = JSON.parse(await shareDecode(m[1]));
    if (!data.entities) return false;
    restoreLocal(data);
    setFileName(data.fileName || null, null);
    zoomFit(true);
    logLine(`공유 링크에서 도면을 불러왔습니다 (도형 ${data.entities.length}개).`, 'info');
    history.replaceState(null, '', location.pathname); // 주소창 정리(작업 시작)
    return true;
  } catch (err) { console.error(err); return false; }
}
function showShareResult(url, copied) {
  const o = document.createElement('div');
  o.style.cssText = 'position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);';
  o.innerHTML = `<div style="background:rgba(26,37,64,0.90);-webkit-backdrop-filter:saturate(180%) blur(20px);backdrop-filter:saturate(180%) blur(20px);border-radius:18px;max-width:520px;width:90%;padding:24px;color:#f5f5f7;box-shadow:0 8px 30px rgba(0,0,0,0.55);font-family:-apple-system,'SF Pro Text','Segoe UI',sans-serif;letter-spacing:-0.01em;">
    <h2 style="margin:0 0 10px;font-size:19px;font-weight:600;letter-spacing:-0.02em;">🔗 공유 링크</h2>
    <p style="margin:0 0 10px;font-size:13px;color:rgba(235,235,245,0.6);line-height:1.5;">${copied ? '클립보드에 복사되었습니다. ' : ''}이 링크를 열면 지금 도면이 그대로 보입니다(서버 없이 URL에 저장됨).</p>
    <textarea readonly style="width:100%;height:90px;background:#1a2540;color:#f5f5f7;border:none;border-radius:8px;padding:10px;font-family:ui-monospace,Consolas,monospace;font-size:12px;">${url}</textarea>
    <div style="text-align:right;margin-top:14px;"><button id="shCopy" style="background:rgba(255,255,255,0.09);color:#fff;border:none;border-radius:8px;padding:8px 15px;cursor:pointer;margin-right:6px;font-size:14px;">복사</button><button id="shClose" style="background:#0071e3;color:#fff;border:none;border-radius:8px;padding:8px 17px;cursor:pointer;font-size:14px;">닫기</button></div>
  </div>`;
  document.body.appendChild(o);
  popupDrag(o.firstElementChild, o.querySelector('h2'));
  const ta = o.querySelector('textarea');
  o.querySelector('#shCopy').onclick = () => { ta.select(); try { navigator.clipboard.writeText(url); } catch (e) { document.execCommand('copy'); } };
  const close = () => o.remove();
  o.querySelector('#shClose').onclick = close;
  o.addEventListener('click', e => { if (e.target === o) close(); });
}

async function saveDXF() {
  const text = buildDXFText();
  { // 이미지는 파일에 통째로 embed된다 — 용량이 갑자기 커지는 이유를 알 수 있게 알려준다
    const nImg = state.entities.filter(e => e.type === 'IMAGE').length;
    if (nImg) logLine(`  이미지 ${nImg}개 포함 → 파일 ${(text.length / 1024 / 1024).toFixed(1)}MB (이미지가 파일 안에 저장됨 · 라이노 등 다른 CAD에서는 표시되지 않음)`, 'info');
  }
  // 1) 실제 파일 핸들이 있으면 그 파일에 조용히 덮어쓰기 (CAD의 저장과 동일)
  if (fileHandle) {
    try {
      const w = await fileHandle.createWritable(); await w.write(text); await w.close();
      logLine(`  ✔ ${currentFileName} 저장(덮어쓰기)`, 'ok'); autosave(); return;
    } catch (err) { if (err && err.name === 'AbortError') return; fileHandle = null; /* 아래 폴백 */ }
  }
  const base = currentFileName ? currentFileName.replace(/\.[^.]+$/, '') : 'drawing';
  // 2) 크롬/엣지: OS 저장 대화상자로 실제 위치 선택
  if (window.showSaveFilePicker) {
    try {
      const h = await showSaveFilePicker({ suggestedName: base + '.dxf', types: DXF_PICKER_TYPES });
      const w = await h.createWritable(); await w.write(text); await w.close();
      fileHandle = h; setFileName(h.name, 'pc');
      logLine(`  ✔ ${h.name} 저장 (선택한 위치)`, 'ok'); return;
    } catch (err) { if (err && err.name === 'AbortError') return; }
  }
  // 3) 폴백: 다운로드/공유
  const fname = base + '.dxf';
  setFileName(fname, 'download');
  await saveBlob(new Blob([text], { type: 'application/dxf' }), fname);
}
async function saveAsDXF(name) {
  const text = buildDXFText();
  if (window.showSaveFilePicker) {
    try {
      const h = await showSaveFilePicker({ suggestedName: name + '.dxf', types: DXF_PICKER_TYPES });
      const w = await h.createWritable(); await w.write(text); await w.close();
      fileHandle = h; setFileName(h.name, 'pc');
      logLine(`  ✔ ${h.name} 저장 (선택한 위치)`, 'ok'); return;
    } catch (err) { if (err && err.name === 'AbortError') return; }
  }
  fileHandle = null; setFileName(name + '.dxf', 'download');
  saveBlob(new Blob([text], { type: 'application/dxf' }), name + '.dxf');
}
// 열기: 지원 시 OS 파일 선택기(핸들 확보 → 덮어쓰기 저장 가능), 아니면 기존 input
async function openFile() {
  // 확장자 분기가 필요해 항상 파일 입력(<input accept>)을 사용 — DXF·STL·OBJ 모두 지원
  document.getElementById('fileInput').click();
}

// ---------- 도면 경계(내보내기 공통) ----------
function drawingBBox() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const ext = (x, y) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
  for (const e of state.entities) { const bb = entityBBox(e); if (bb) { ext(bb.xmin, bb.ymin); ext(bb.xmax, bb.ymax); } }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 100; }
  return { minX, minY, maxX, maxY, w: Math.max(1e-6, maxX - minX), h: Math.max(1e-6, maxY - minY) };
}

// ============================================================
//  SVG 내보내기 (벡터, 한글 문자 안전)
// ============================================================
function buildSVG() {
  const b = drawingBBox(), m = Math.max(b.w, b.h) * 0.05 + 5; // 여백
  const W = b.w + 2 * m, H = b.h + 2 * m;
  const X = x => (x - b.minX + m).toFixed(3);
  const Y = y => (b.maxY - y + m).toFixed(3); // SVG는 Y가 아래로 → 뒤집기
  const sw = (Math.max(b.w, b.h) / 600).toFixed(3); // 선 두께
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W.toFixed(3)} ${H.toFixed(3)}" width="${W.toFixed(1)}" height="${H.toFixed(1)}">`];
  out.push(`<rect width="100%" height="100%" fill="white"/>`);
  out.push(`<g fill="none" stroke-width="${sw}">`);
  for (const e of exportEntities()) {
    const l = getLayer(e.layer); if (l && (!l.visible || l.noplot)) continue; // noplot = 화면엔 보이되 출력(PDF·SVG·PNG)에선 제외
    const c = entityColor(e) === '#ffffff' ? '#000000' : entityColor(e); // 흰색은 흰배경에서 검정으로
    switch (e.type) {
      case 'LINE': out.push(`<line x1="${X(e.x1)}" y1="${Y(e.y1)}" x2="${X(e.x2)}" y2="${Y(e.y2)}" stroke="${c}"/>`); break;
      case 'LWPOLYLINE': {
        const pts = e.points.map(p => `${X(p[0])},${Y(p[1])}`).join(' ');
        out.push(`<${e.closed ? 'polygon' : 'polyline'} points="${pts}" stroke="${c}"/>`); break;
      }
      case 'CIRCLE': out.push(`<circle cx="${X(e.cx)}" cy="${Y(e.cy)}" r="${e.r.toFixed(3)}" stroke="${c}"/>`); break;
      case 'ARC': {
        const a0 = e.startAngle * Math.PI / 180, a1 = e.endAngle * Math.PI / 180;
        const sx = e.cx + e.r * Math.cos(a0), sy = e.cy + e.r * Math.sin(a0);
        const ex = e.cx + e.r * Math.cos(a1), ey = e.cy + e.r * Math.sin(a1);
        let sweepDeg = e.endAngle - e.startAngle; sweepDeg = ((sweepDeg % 360) + 360) % 360;
        const large = sweepDeg > 180 ? 1 : 0;
        // 화면 Y뒤집힘 → sweep 플래그 0(반시계가 화면상 시계가 됨)
        out.push(`<path d="M ${X(sx)} ${Y(sy)} A ${e.r.toFixed(3)} ${e.r.toFixed(3)} 0 ${large} 0 ${X(ex)} ${Y(ey)}" stroke="${c}"/>`); break;
      }
      case 'TEXT': {
        const t = escapeHtml(e.text);
        out.push(`<text x="${X(e.x)}" y="${Y(e.y)}" font-size="${e.height.toFixed(3)}" fill="${c}" stroke="none" font-family="sans-serif">${t}</text>`); break;
      }
    }
  }
  out.push('</g></svg>');
  return out.join('\n');
}

// ============================================================
//  PNG 내보내기 (오프스크린 렌더, 한글 안전)
// ============================================================
function savePNG(fname) {
  const b = drawingBBox();
  const margin = Math.max(b.w, b.h) * 0.05 + 5;
  const scale = Math.min(2000 / (b.w + 2 * margin), 2000 / (b.h + 2 * margin)); // 최대 2000px
  const W = Math.ceil((b.w + 2 * margin) * scale), Hh = Math.ceil((b.h + 2 * margin) * scale);
  const oc = document.createElement('canvas'); oc.width = W; oc.height = Hh;
  const o = oc.getContext('2d');
  o.fillStyle = '#ffffff'; o.fillRect(0, 0, W, Hh);
  const X = x => (x - b.minX + margin) * scale;
  const Y = y => (b.maxY - y + margin) * scale;
  o.lineWidth = Math.max(1, (Math.max(b.w, b.h) / 600) * scale);
  for (const e of exportEntities()) {
    const l = getLayer(e.layer); if (l && (!l.visible || l.noplot)) continue; // noplot = 화면엔 보이되 출력(PDF·SVG·PNG)에선 제외
    let c = entityColor(e); if (c === '#ffffff') c = '#000000';
    o.strokeStyle = c; o.fillStyle = c;
    o.beginPath();
    switch (e.type) {
      case 'LINE': o.moveTo(X(e.x1), Y(e.y1)); o.lineTo(X(e.x2), Y(e.y2)); o.stroke(); break;
      case 'LWPOLYLINE': e.points.forEach((p, i) => i ? o.lineTo(X(p[0]), Y(p[1])) : o.moveTo(X(p[0]), Y(p[1]))); if (e.closed) o.closePath(); o.stroke(); break;
      case 'CIRCLE': o.arc(X(e.cx), Y(e.cy), e.r * scale, 0, Math.PI * 2); o.stroke(); break;
      case 'ARC': o.arc(X(e.cx), Y(e.cy), e.r * scale, -e.endAngle * Math.PI / 180, -e.startAngle * Math.PI / 180); o.stroke(); break;
      case 'TEXT': o.font = `${e.height * scale}px sans-serif`; o.textBaseline = 'alphabetic'; o.fillText(e.text, X(e.x), Y(e.y)); break;
    }
  }
  oc.toBlob(blob => { if (blob) saveBlob(blob, fname); }, 'image/png');
}

// ============================================================
//  PDF 내보내기 (벡터 단일 페이지)
// ============================================================
const PAPER_SIZES = { // pt (1mm=2.8346pt)
  a4: [841.89, 595.28], a3: [1190.55, 841.89], a2: [1683.78, 1190.55], a1: [2383.94, 1683.78], letter: [792, 612],
};
// opt: { paper:'a3', landscape:true, scaleDenom:100(=1:100, 0=자동맞춤), region:{minX..}|null, title:{...}|null, units:'mm' }
function buildPDF(opt) {
  opt = opt || {};
  const MM = 2.83464567; // mm → pt
  const size = PAPER_SIZES[opt.paper || 'a3'] || PAPER_SIZES.a3;
  let PW = size[0], PH = size[1];
  if (opt.landscape === false) { PW = size[1]; PH = size[0]; }        // 기본 가로
  const margin = 15 * MM;
  const b = opt.region ? { minX: opt.region.minX, minY: opt.region.minY, w: opt.region.maxX - opt.region.minX, h: opt.region.maxY - opt.region.minY, maxX: opt.region.maxX, maxY: opt.region.maxY } : drawingBBox();
  const availW = PW - 2 * margin, availH = PH - 2 * margin - (opt.title ? 12 * MM : 0);
  // 축척: scaleDenom>0 이면 1:denom 고정, 아니면 용지에 맞춤
  const unitToMM = ({ mm: 1, cm: 10, m: 1000, in: 25.4 })[opt.units || settings.units] || 1;
  let sc; // 도면단위 → pt
  if (opt.scaleDenom > 0) sc = (unitToMM * MM) / opt.scaleDenom;      // 1 도면단위 = unitToMM mm, 축척 적용
  else sc = Math.min(availW / b.w, availH / b.h);                     // 자동 맞춤
  // 그림을 인쇄영역 중앙에 배치
  const drawW = b.w * sc, drawH = b.h * sc;
  const offX = margin + (availW - drawW) / 2, offY = margin + (opt.title ? 12 * MM : 0) + (availH - drawH) / 2;
  const X = x => (offX + (x - b.minX) * sc);
  const Y = y => (offY + (y - b.minY) * sc);
  const num = n => (Math.round(n * 1000) / 1000).toFixed(3);
  const K = 0.5522847498;
  const ops = [];
  ops.push('0.7 w');
  const setColor = (hex) => { hex = rgbHex(hex === '#ffffff' ? '#000000' : hex); const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, bl = parseInt(hex.slice(5, 7), 16) / 255; ops.push(`${num(r)} ${num(g)} ${num(bl)} RG`); ops.push(`${num(r)} ${num(g)} ${num(bl)} rg`); };
  const circlePath = (cx, cy, r) => {
    const x = X(cx), y = Y(cy), rr = r * sc;
    ops.push(`${num(x + rr)} ${num(y)} m`);
    ops.push(`${num(x + rr)} ${num(y + rr * K)} ${num(x + rr * K)} ${num(y + rr)} ${num(x)} ${num(y + rr)} c`);
    ops.push(`${num(x - rr * K)} ${num(y + rr)} ${num(x - rr)} ${num(y + rr * K)} ${num(x - rr)} ${num(y)} c`);
    ops.push(`${num(x - rr)} ${num(y - rr * K)} ${num(x - rr * K)} ${num(y - rr)} ${num(x)} ${num(y - rr)} c`);
    ops.push(`${num(x + rr * K)} ${num(y - rr)} ${num(x + rr)} ${num(y - rr * K)} ${num(x + rr)} ${num(y)} c`);
    ops.push('S');
  };
  const arcPath = (e) => {
    let s = e.startAngle, en = e.endAngle; if (en < s) en += 360;
    const steps = Math.max(2, Math.ceil((en - s) / 30));
    for (let i = 0; i <= steps; i++) {
      const a = (s + (en - s) * i / steps) * Math.PI / 180;
      const px = X(e.cx + e.r * Math.cos(a)), py = Y(e.cy + e.r * Math.sin(a));
      ops.push(`${num(px)} ${num(py)} ${i ? 'l' : 'm'}`);
    }
    ops.push('S');
  };
  // 인쇄영역으로 클리핑(축척 고정 시 용지 밖 잘림)
  ops.push('q');
  ops.push(`${num(margin)} ${num(margin)} ${num(availW)} ${num(PH - 2 * margin)} re W n`);
  for (const e of exportEntities()) {
    const l = getLayer(e.layer); if (l && (!l.visible || l.noplot)) continue; // noplot = 화면엔 보이되 출력(PDF·SVG·PNG)에선 제외
    setColor(entityColor(e));
    switch (e.type) {
      case 'LINE': ops.push(`${num(X(e.x1))} ${num(Y(e.y1))} m ${num(X(e.x2))} ${num(Y(e.y2))} l S`); break;
      case 'LWPOLYLINE': e.points.forEach((p, i) => ops.push(`${num(X(p[0]))} ${num(Y(p[1]))} ${i ? 'l' : 'm'}`)); if (e.closed) ops.push('h'); ops.push('S'); break;
      case 'CIRCLE': circlePath(e.cx, e.cy, e.r); break;
      case 'ARC': arcPath(e); break;
      case 'TEXT': { const txt = String(e.text).replace(/[^\x20-\x7e]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); ops.push(`BT /F1 ${num(e.height * sc)} Tf ${num(X(e.x))} ${num(Y(e.y))} Td (${txt}) Tj ET`); break; }
    }
  }
  ops.push('Q');
  // 제목블록(하단 테두리 + 정보)
  if (opt.title) {
    const t = opt.title, bx = margin, by = margin, bw = PW - 2 * margin, bh = 11 * MM;
    ops.push('0 0 0 RG 0.8 w');
    ops.push(`${num(bx)} ${num(by)} ${num(bw)} ${num(bh)} re S`);
    ops.push(`${num(bx + bw * 0.7)} ${num(by)} m ${num(bx + bw * 0.7)} ${num(by + bh)} l S`);
    ops.push(`${num(bx)} ${num(by + bh / 2)} m ${num(bx + bw * 0.7)} ${num(by + bh / 2)} l S`);
    const asc = s => String(s == null ? '' : s).replace(/[^\x20-\x7e]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    const txt = (x, y, s, sz) => ops.push(`BT /F1 ${num(sz)} Tf ${num(x)} ${num(y)} Td (${asc(s)}) Tj ET`);
    txt(bx + 4 * MM, by + bh * 0.62, 'TITLE: ' + (t.title || ''), 9);
    txt(bx + 4 * MM, by + bh * 0.2, 'FILE: ' + (t.file || ''), 7);
    txt(bx + bw * 0.7 + 4 * MM, by + bh * 0.62, 'SCALE: ' + (t.scale || ''), 9);
    txt(bx + bw * 0.7 + 4 * MM, by + bh * 0.2, 'DATE: ' + (t.date || ''), 7);
  }
  const content = ops.join('\n');
  // PDF 객체 조립 (오프셋 정확히 계산)
  const objs = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(PW)} ${num(PH)}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`);
  objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 0; i < objs.length; i++) { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return pdf;
}
function writeEntity(g, e, H, owner) {
  // AC1021(R2007) 구조: 핸들(5) + 소유자(330, R13+ 필수) + AcDbEntity + 서브클래스 마커
  const head = (type, sub) => { g(0, type); g(5, H()); if (owner) g(330, owner); g(100, 'AcDbEntity'); g(8, e.layer);
    if (e.color) { g(62, dxfColorIndex(e.color)); g(420, dxfTrueColor(e.color)); } // 62=근사 ACI + 420=정확한 트루컬러
    if (e.linetype && e.linetype !== 'continuous') g(6, e.linetype.toUpperCase());
    if (e.lineweight != null && e.lineweight >= 0) g(370, e.lineweight); g(100, sub); };
  switch (e.type) {
    case 'LINE':
      head('LINE', 'AcDbLine');
      g(10, e.x1); g(20, e.y1); g(30, 0);
      g(11, e.x2); g(21, e.y2); g(31, 0);
      break;
    case 'LWPOLYLINE':
      head('LWPOLYLINE', 'AcDbPolyline');
      g(90, e.points.length); g(70, e.closed ? 1 : 0);
      for (const p of e.points) { g(10, p[0]); g(20, p[1]); }
      break;
    case 'CIRCLE':
      head('CIRCLE', 'AcDbCircle');
      g(10, e.cx); g(20, e.cy); g(30, 0); g(40, e.r);
      break;
    case 'ARC':
      head('ARC', 'AcDbCircle');
      g(10, e.cx); g(20, e.cy); g(30, 0); g(40, e.r);
      g(100, 'AcDbArc'); g(50, e.startAngle); g(51, e.endAngle);
      break;
    case 'TEXT':
      head('TEXT', 'AcDbText');
      g(10, e.x); g(20, e.y); g(30, 0); g(40, e.height);
      g(1, e.text); g(50, e.rotation || 0);
      break;
    case 'INSERT':
      head('INSERT', 'AcDbBlockReference');
      g(2, e.name); g(10, e.x); g(20, e.y); g(30, 0);
      g(41, e.sx != null ? e.sx : 1); g(42, e.sy != null ? e.sy : 1); g(43, 1);
      g(50, e.rot || 0);
      break;
    case 'MESH': // R12 호환: 삼각형마다 3DFACE — 불러오기 시 999 WCX의 mesh 구획 정보로 원래 메시 단위로 복원
      for (const t of (e.tris || [])) {
        head('3DFACE', 'AcDbFace');
        g(10, t[0][0]); g(20, t[0][1]); g(30, t[0][2] || 0);
        g(11, t[1][0]); g(21, t[1][1]); g(31, t[1][2] || 0);
        g(12, t[2][0]); g(22, t[2][1]); g(32, t[2][2] || 0);
        g(13, t[2][0]); g(23, t[2][1]); g(33, t[2][2] || 0);
      }
      break;
  }
}

// ============================================================
//  DXF 읽기 (R12~ 일반 엔티티 파서)
// ============================================================
// ============================================================
//  3D 메시 가져오기 — STL(ASCII/바이너리)·OBJ → MESH 엔티티(삼각형 집합)
// ============================================================
function parseSTL(buf) {
  const tris = [];
  const bytes = new Uint8Array(buf);
  // ASCII 판별: 선두가 'solid'이고 'facet'이 텍스트로 존재
  let head = '';
  for (let i = 0; i < Math.min(bytes.length, 256); i++) head += String.fromCharCode(bytes[i]);
  const looksAscii = /^\s*solid/i.test(head) && head.toLowerCase().indexOf('facet') !== -1;
  if (looksAscii) {
    const txt = new TextDecoder().decode(buf);
    const nums = txt.match(/vertex\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)/g) || [];
    for (let i = 0; i + 2 < nums.length; i += 3) {
      const v = j => { const m = nums[i + j].trim().split(/\s+/); return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]; };
      tris.push([v(0), v(1), v(2)]);
    }
    if (tris.length) return tris;
  }
  // 바이너리 STL: 80바이트 헤더 + uint32 개수 + 삼각형당 50바이트
  if (buf.byteLength >= 84) {
    const dv = new DataView(buf);
    const n = dv.getUint32(80, true);
    if (84 + n * 50 <= buf.byteLength) {
      let off = 84;
      for (let k = 0; k < n; k++) {
        off += 12; // 법선 스킵
        const rd = () => { const x = dv.getFloat32(off, true), y = dv.getFloat32(off + 4, true), z = dv.getFloat32(off + 8, true); off += 12; return [x, y, z]; };
        tris.push([rd(), rd(), rd()]);
        off += 2; // 속성 바이트
      }
    }
  }
  return tris;
}
function parseOBJ(text) {
  const V = [], tris = [];
  const lines = text.split(/\r?\n/);
  for (const ln of lines) {
    const t = ln.trim();
    if (t[0] === 'v' && t[1] === ' ') {
      const p = t.split(/\s+/); V.push([parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])]);
    } else if (t[0] === 'f' && t[1] === ' ') {
      const idx = t.slice(2).trim().split(/\s+/).map(tok => {
        const i = parseInt(tok.split('/')[0], 10); return i < 0 ? V.length + i : i - 1;
      });
      for (let i = 1; i + 1 < idx.length; i++) { // 팬 삼각화
        const a = V[idx[0]], b = V[idx[i]], c = V[idx[i + 1]];
        if (a && b && c) tris.push([a, b, c]);
      }
    }
  }
  return tris;
}
function loadMesh(tris, name) {
  if (!tris || !tris.length) { logLine('  ' + (name || '메시') + ': 유효한 삼각형이 없습니다.', 'warn'); return false; }
  pushUndo();
  const e = addEntity({ type: 'MESH', tris, name: name || 'mesh', color: '#b9b2a6' });
  logLine('  ✔ 3D 메시 가져오기: ' + tris.length + '개 삼각형 (' + (name || '') + ') — 3D 뷰에서 확인', 'ok');
  state.selection.clear(); state.selection.add(e.id);
  const ov = document.getElementById('bim3d');
  if (ov && ov.style.display !== 'none' && typeof fit3D === 'function') { v3.solids = bimSolids(); fit3D(); v3.zoom = 1; v3.panX = 0; v3.panY = 0; loadVp(v3.act); render3D(); }
  else { renderProps(); draw(); }
  return true;
}
function meshBBox(e) {
  let xm = 1e18, xM = -1e18, ym = 1e18, yM = -1e18;
  for (const t of e.tris) for (const p of t) { xm = Math.min(xm, p[0]); xM = Math.max(xM, p[0]); ym = Math.min(ym, p[1]); yM = Math.max(yM, p[1]); }
  return { xmin: xm, xmax: xM, ymin: ym, ymax: yM };
}
function loadDXF(text) {
  try {
    const pairs = parseDXFPairs(text);
    const result = parseDXFEntities(pairs);
    pushUndo();
    state.entities = result.entities;
    state.layers = result.layers.length ? result.layers : [{ name: '0', color: '#ffffff', visible: true }];
    if (!getLayer('0')) state.layers.unshift({ name: '0', color: '#ffffff', visible: true });
    state.currentLayer = '0';
    // 999 확장 복원: 3DFACE→MESH, BIM·z 재결합, 이미지 복원.
    // 레이어 확정 이후에 호출해야 한다 — 이미지 복원이 레이어를 참조/추가하는데,
    // 앞서 호출하면 바로 아래 state.layers 대입에 덮여 사라진다.
    try { applyWcxExt(text); } catch (e2) { console.warn('WCX 확장 복원 실패(무시):', e2); }
    try { // 손그림 스케치 복원 (999 WSK) — 파일에 담긴 스케치가 있으면 Sketch Layer 로
      let skJs = '';
      for (const m of text.matchAll(/^\s*999\s*\r?\n(WSK[^\r\n]*)/gm)) skJs += m[1].slice(3);
      if (skJs && window.WEBCAD_SKETCH) {
        const d = JSON.parse(skJs);
        if (d && Array.isArray(d.strokes)) window.WEBCAD_SKETCH.importStrokes(d.strokes);
      }
    } catch (e3) { console.warn('스케치 복원 실패(무시):', e3); }
    state.blocks = result.blocks || {}; insertName = null;
    state.nextId = state.entities.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1;
    state.selection.clear();
    renderLayers(); refreshBlockList(); updateStat(); zoomFit(true);
    hint(`DXF 불러오기 완료: 도형 ${state.entities.length}개`);
    return true;
  } catch (err) {
    alert('DXF 파일을 읽는 중 오류가 발생했습니다:\n' + err.message);
    console.error(err);
    return false;
  }
}
// Parti 확장(999 WCX) 복원: 3DFACE 연속 구간을 MESH로 병합하고, 시그니처로 BIM 속성·z값을 재결합
function applyWcxExt(text) {
  let js = '';
  for (const m of text.matchAll(/^\s*999\s*\r?\n(WCX[^\r\n]*)/gm)) js += m[1].slice(3);
  let data = null;
  if (js) { try { data = JSON.parse(js); } catch (e) { data = null; } }
  // 1) _F3(3DFACE) 연속 구간 → MESH (WCX mesh의 삼각형 개수 목록이 있으면 그 단위로 분할)
  const counts = data && Array.isArray(data.mesh) ? data.mesh.slice() : null;
  const toTris = f => { const ts = [f.p]; if (f.p4) ts.push([f.p[0], f.p[2], f.p4]); return ts; };
  const out = []; let run = null;
  const flushRun = () => {
    if (!run) return;
    let faces = run.faces;
    while (faces.length) {
      const n = (counts && counts.length) ? Math.max(1, Math.round(counts.shift()) || 1) : faces.length;
      const part = faces.slice(0, n); faces = faces.slice(n);
      out.push({ type: 'MESH', layer: run.layer, color: run.color, tris: part.flatMap(toTris) });
    }
    run = null;
  };
  for (const e of state.entities) {
    if (e.type === '_F3') { if (!run) run = { layer: e.layer, color: e.color, faces: [] }; run.faces.push(e); }
    else { flushRun(); out.push(e); }
  }
  flushRun();
  state.entities = out;
  // 2) 시그니처 매칭 → bim/zo/z1/z2 재적용 (같은 시그니처 여러 개면 순서대로 소비)
  if (data && Array.isArray(data.ext)) {
    const map = new Map();
    for (const [sig, x] of data.ext) { if (!map.has(sig)) map.set(sig, []); map.get(sig).push(x); }
    const legacyLights = []; // 구버전(e.light) 파일 → 새 LightSource 모델로 옮긴다
    for (const e of state.entities) {
      const sig = entSig(e); if (!sig) continue;
      const q = map.get(sig); if (!q || !q.length) continue;
      const x = q.shift();
      if (x.bim) e.bim = JSON.parse(JSON.stringify(x.bim));
      if (x.lightId) e.lightId = x.lightId;
      else if (x.light) legacyLights.push([e, x.light]); // 구버전(e.light) → 아래에서 LightSource로 변환
      if (x.grp) e.grp = x.grp;
      if (x.zo != null) e.zo = x.zo;
      if (x.z1 != null) e.z1 = x.z1;
      if (x.z2 != null) e.z2 = x.z2;
      if (Array.isArray(x.zs) && e.points && x.zs.length === e.points.length) e.zs = x.zs.slice(); // 표면 위 곡선
    }
    if (Array.isArray(data.sensors)) { state.sensors = data.sensors; state.nextSensorId = data.nextSensorId || (state.sensors.length + 1); }
    // 광원 컬렉션 복원
    if (Array.isArray(data.lights)) {
      state.lights = data.lights.map(L => Object.assign(lightDefaults(), L));
      state.nextLightId = data.nextLightId || (state.lights.length + 1);
      // 개체가 사라진 광원은 조용히 지우지 않고 경고로 남긴다 (§1.2).
      // _missing 을 달아야 pruneLights가 이 광원을 지우지 않는다 — 안 달면 경고 직후 사라진다.
      const ids = new Set(state.entities.map(e => e.id));
      const orphan = state.lights.filter(L => !ids.has(L.objectId));
      orphan.forEach(L => { L._missing = 1; });
      if (orphan.length) logLine(`  ⚠ 광원 ${orphan.length}개가 가리키는 개체를 찾지 못했습니다: ${orphan.map(o => o.name || o.id).join(', ')}`, 'warn');
    }
    // 구버전 e.light → LightSource 승격 (사용자가 이미 저장해 둔 도면이 깨지지 않게)
    for (const [e, old] of legacyLights) {
      const L = Object.assign(lightDefaults(), { id: 'L' + (state.nextLightId++), objectId: e.id, name: defaultLightName(e) },
        { range: old.range, soft: old.soft, bounce: old.bounce, spacing: old.spacing });
      if (old.power != null) L.intensity = Math.round(old.power * LM_REF); // 옛 power(1=기본) → 루멘
      for (const k of Object.keys(L)) if (L[k] === undefined) delete L[k];
      state.lights.push(L); e.lightId = L.id;
    }
    if (legacyLights.length) logLine(`  광원 ${legacyLights.length}개를 새 형식으로 옮겼습니다 (세기는 루멘으로 환산)`, 'info');
  }
  // 3) 이미지 복원 — DXF 엔티티가 아니라 WCX에만 있으므로 정의로부터 새로 만든다.
  //    (id는 여기서 직접 부여: loadDXF가 nextId를 max(id)+1로 계산하므로 겹치면 안 된다)
  if (data && Array.isArray(data.img) && data.img.length) {
    let maxId = state.entities.reduce((m, e) => Math.max(m, e.id || 0), 0);
    for (const im of data.img) {
      if (!im || !im.src) continue;
      state.entities.push({
        id: ++maxId, type: 'IMAGE', layer: im.layer || '밑그림', lv: im.lv || 0,
        x: +im.x || 0, y: +im.y || 0, w: +im.w || 1, h: +im.h || 1, src: im.src,
        rot: +im.rot || 0, op: im.op != null ? +im.op : 1,
        sat: im.sat != null ? +im.sat : 1, bri: im.bri != null ? +im.bri : 1,
        flip: !!im.flip,
      });
      if (!getLayer(im.layer || '밑그림')) state.layers.push({ name: im.layer || '밑그림', color: '#8a8a94', visible: true });
    }
  }
}
function parseDXFPairs(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (isNaN(code)) { i -= 1; continue; } // 어긋난 경우 한 줄 보정
    pairs.push([code, lines[i + 1]]);
  }
  return pairs;
}
function aci2hex(n) {
  const p = ACI_PALETTE[Math.abs(n)];
  if (!p) return '#ffffff';
  return '#' + p.map(v => v.toString(16).padStart(2, '0')).join('');
}
// 420(트루컬러) 24비트 정수 → hex
function tc2hex(n) {
  const v = n & 0xffffff;
  return '#' + ((v >> 16) & 255).toString(16).padStart(2, '0')
             + ((v >> 8) & 255).toString(16).padStart(2, '0')
             + (v & 255).toString(16).padStart(2, '0');
}
function parseDXFEntities(pairs) {
  const entities = [], layers = [];
  const blocks = {}; // 블록 정의: name -> { bx, by, entities: [] }
  const usedBlocks = new Set(); // INSERT로 유지된 블록 이름

  function num(d, code, def = 0) { const v = d[code]; return v === undefined ? def : parseFloat(Array.isArray(v) ? v[0] : v); }
  function baseOf(d) {
    const layer = (d[8] !== undefined ? (Array.isArray(d[8]) ? d[8][0] : d[8]) : '0').trim();
    const base = { layer };
    if (d[62] !== undefined) {
      const n = parseInt(Array.isArray(d[62]) ? d[62][0] : d[62], 10);
      if (n !== 256 && n !== 0) base.color = aci2hex(n); // 256=ByLayer, 0=ByBlock → 기본색
    }
    if (d[420] !== undefined) { // 트루컬러가 있으면 62의 근사값보다 우선
      const n = parseInt(Array.isArray(d[420]) ? d[420][0] : d[420], 10);
      if (isFinite(n)) base.color = tc2hex(n);
    }
    if (d[6] !== undefined) { const lt = String(Array.isArray(d[6]) ? d[6][0] : d[6]).trim().toLowerCase(); if (LINETYPES[lt] !== undefined && lt !== 'continuous' && lt !== 'bylayer') base.linetype = lt; }
    if (d[370] !== undefined) { const lw = parseInt(Array.isArray(d[370]) ? d[370][0] : d[370], 10); if (lw >= 0) base.lineweight = lw; }
    return base;
  }
  function buildEntity(t, d, verts) {
    const base = baseOf(d);
    switch (t) {
      case 'LINE': return { ...base, type: 'LINE', x1: num(d, 10), y1: num(d, 20), x2: num(d, 11), y2: num(d, 21) };
      case 'LWPOLYLINE': {
        const pts = verts.filter(p => p[1] !== undefined);
        if (pts.length < 2) return null;
        return { ...base, type: 'LWPOLYLINE', closed: (num(d, 70) & 1) === 1, points: pts };
      }
      case 'CIRCLE': {
        let cx = num(d, 10), cy = num(d, 20);
        if (num(d, 230, 1) < 0) cx = -cx; // 음수 Z 돌출 → OCS가 X축 반전 저장됨
        return { ...base, type: 'CIRCLE', cx, cy, r: num(d, 40) };
      }
      case 'ARC': {
        let cx = num(d, 10), cy = num(d, 20), sa = num(d, 50), ea = num(d, 51);
        if (num(d, 230, 1) < 0) { cx = -cx; const ns = 180 - ea, ne = 180 - sa; sa = ns; ea = ne; } // OCS X축 반전: 좌표·각도 미러 + 진행방향 반전
        return { ...base, type: 'ARC', cx, cy, r: num(d, 40), startAngle: sa, endAngle: ea };
      }
      case 'TEXT': case 'MTEXT': case 'ATTRIB': {
        let parts = [];
        if (d[3] !== undefined) parts.push(...(Array.isArray(d[3]) ? d[3] : [d[3]])); // MTEXT 연속 텍스트
        if (d[1] !== undefined) parts.push(...(Array.isArray(d[1]) ? d[1] : [d[1]]));
        let txt = parts.join('')
          .replace(/\\P/gi, ' ')                 // MTEXT 줄바꿈 → 공백
          .replace(/\\[A-Za-z][^;]*;/g, '')      // 서식 코드 제거
          .replace(/[{}]/g, '')
          .replace(/%%c/gi, '⌀').replace(/%%d/gi, '°').replace(/%%p/gi, '±');
        if (!txt.trim()) return null;
        return { ...base, type: 'TEXT', x: num(d, 10), y: num(d, 20), height: num(d, 40, 10), text: txt, rotation: num(d, 50) };
      }
      case 'ELLIPSE': {
        const cx = num(d, 10), cy = num(d, 20), mx = num(d, 11), my = num(d, 21);
        const ratio = num(d, 40, 1), t0 = num(d, 41, 0), t1 = num(d, 42, Math.PI * 2);
        const nx = -my * ratio, ny = mx * ratio; // 단축 벡터
        const full = Math.abs((t1 - t0) - Math.PI * 2) < 1e-6;
        const N = 48, pts = [];
        for (let k = 0; k <= (full ? N - 1 : N); k++) {
          const t = t0 + (t1 - t0) * k / N;
          pts.push([cx + Math.cos(t) * mx + Math.sin(t) * nx, cy + Math.cos(t) * my + Math.sin(t) * ny]);
        }
        return { ...base, type: 'LWPOLYLINE', closed: full, points: pts };
      }
      case 'SPLINE': {
        const arr = c => d[c] === undefined ? [] : (Array.isArray(d[c]) ? d[c] : [d[c]]).map(parseFloat);
        const fx = arr(11), fy = arr(12).length ? arr(12) : arr(21); // 일부 파일은 21 사용
        const cxs = arr(10), cys = arr(20);
        let pts = [];
        if (fx.length >= 2 && fy.length >= 2) pts = fx.map((x, i) => [x, fy[i]]);       // 맞춤점 통과
        else if (cxs.length >= 2) pts = cxs.map((x, i) => [x, cys[i]]);                  // 제어점 근사
        if (pts.length < 2) return null;
        const closed = (num(d, 70) & 1) === 1;
        return { ...base, type: 'LWPOLYLINE', closed, points: pts };
      }
      case '3DFACE': {
        const P = [[num(d, 10), num(d, 20), num(d, 30)], [num(d, 11), num(d, 21), num(d, 31)], [num(d, 12), num(d, 22), num(d, 32)]];
        const p4 = d[13] !== undefined ? [num(d, 13), num(d, 23), num(d, 33)] : null;
        const quad = p4 && (p4[0] !== P[2][0] || p4[1] !== P[2][1] || p4[2] !== P[2][2]);
        return { ...base, type: '_F3', p: P, p4: quad ? p4 : null }; // loadDXF 후처리에서 연속 구간을 MESH로 병합
      }
      case 'SOLID': {
        const pts = [[num(d, 10), num(d, 20)], [num(d, 11), num(d, 21)]];
        if (d[13] !== undefined) { pts.push([num(d, 13), num(d, 23)]); pts.push([num(d, 12), num(d, 22)]); }
        else if (d[12] !== undefined) pts.push([num(d, 12), num(d, 22)]);
        if (pts.length < 3) return null;
        return { ...base, type: 'HATCH', pattern: 'solid', spacing: 5, boundary: { kind: 'poly', points: pts } };
      }
      case 'HATCH': {
        const arr = c => d[c] === undefined ? [] : (Array.isArray(d[c]) ? d[c] : [d[c]]).map(parseFloat);
        let xs = arr(10), ys = arr(20);
        const seedN = num(d, 98, 0);                       // 마지막 N쌍은 시드점 → 제외
        if (seedN > 0) { xs = xs.slice(0, xs.length - seedN); ys = ys.slice(0, ys.length - seedN); }
        const v93 = arr(93);                               // 폴리라인 경계 정점 수(첫 루프만 사용)
        const nv = v93.length ? Math.min(v93[0], xs.length) : xs.length;
        const pts = [];
        for (let k = 0; k < nv; k++) if (isFinite(xs[k]) && isFinite(ys[k])) pts.push([xs[k], ys[k]]);
        if (pts.length < 3) return null;
        const pname = (d[2] !== undefined ? String(Array.isArray(d[2]) ? d[2][0] : d[2]) : '').trim().toUpperCase();
        const solid = num(d, 70) === 1 || pname === 'SOLID';
        const PMAP = { ANSI31: 'ansi31', ANSI37: 'ansi37', ANSI32: 'steel', 'AR-CONC': 'concrete', 'AR-SAND': 'dots', DOTS: 'dots', 'AR-B816': 'brick', BRICK: 'brick', NET: 'grid', GRID: 'grid' };
        const scale = num(d, 41, 1);
        return { ...base, type: 'HATCH', pattern: solid ? 'solid' : (PMAP[pname] || 'ansi31'),
          spacing: Math.max(0.5, Math.min(1000, 3.175 * scale)), boundary: { kind: 'poly', points: pts } };
      }
      case 'POINT': {
        const x = num(d, 10), y = num(d, 20), s = 1;
        return { ...base, type: 'LINE', x1: x - s, y1: y, x2: x + s, y2: y };
      }
    }
    return null;
  }
  function buildPoly(d, pts) {
    if (pts.length < 2) return null;
    return { ...baseOf(d), type: 'LWPOLYLINE', closed: (num(d, 70) & 1) === 1, points: pts };
  }
  // 블록 엔티티를 INSERT 위치/스케일/회전에 맞게 변환한 사본 생성.
  // sx/sy 부호로 미러링도 처리(호는 반사 시 방향이 뒤집히므로 각도 재계산 + start/end 교환).
  function xformEntity(src, tp, sx, sy, rot) {
    const e = JSON.parse(JSON.stringify(src));
    const a = rot * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    const sc = Math.sqrt(Math.abs(sx * sy)); // 반지름/문자 크기 배율(미러여도 양수)
    // 블록 좌표계 방향각(도)을 스케일+회전 적용 후 방향각(도)으로 변환
    const dirAngle = (deg) => {
      const t = deg * Math.PI / 180, vx = Math.cos(t) * sx, vy = Math.sin(t) * sy;
      return Math.atan2(vx * sa + vy * ca, vx * ca - vy * sa) * 180 / Math.PI;
    };
    switch (e.type) {
      case 'LINE': [e.x1, e.y1] = tp(e.x1, e.y1); [e.x2, e.y2] = tp(e.x2, e.y2); break;
      case 'LWPOLYLINE': e.points = e.points.map(p => tp(p[0], p[1])); break;
      case 'CIRCLE': [e.cx, e.cy] = tp(e.cx, e.cy); e.r *= sc; break;
      case 'ARC': {
        [e.cx, e.cy] = tp(e.cx, e.cy); e.r *= sc;
        let s = dirAngle(e.startAngle), en = dirAngle(e.endAngle);
        if (sx * sy < 0) { const t = s; s = en; en = t; } // 반사 → 호 진행방향 반전
        e.startAngle = s; e.endAngle = en;
        break;
      }
      case 'TEXT': [e.x, e.y] = tp(e.x, e.y); e.height *= sc; e.rotation = (e.rotation || 0) + rot; break;
      case 'HATCH': {
        const b = e.boundary;
        if (b.kind === 'circle') { [b.cx, b.cy] = tp(b.cx, b.cy); b.r *= sc; }
        else b.points = b.points.map(p => tp(p[0], p[1]));
        e.spacing = (e.spacing || 5) * sc;
        break;
      }
    }
    return e;
  }
  function expandInsert(d, out) {
    const name = (d[2] !== undefined ? String(Array.isArray(d[2]) ? d[2][0] : d[2]) : '').trim();
    const blk = blocks[name];
    if (!blk) return;
    const ix = num(d, 10), iy = num(d, 20), sx = num(d, 41, 1), sy = num(d, 42, 1), rot = num(d, 50, 0);
    const a = rot * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    const tp = (x, y) => { const px = (x - blk.bx) * sx, py = (y - blk.by) * sy; return [px * ca - py * sa + ix, px * sa + py * ca + iy]; };
    for (const src of blk.entities) out.push(xformEntity(src, tp, sx, sy, rot));
  }
  // 엔티티 스트림 파서 — ENTITIES/블록 정의 양쪽에서 공용. ENDSEC 또는 ENDBLK에서 멈춤.
  function parseEntityStream(p, start, out) {
    let j = start;
    const stop = v => v === 'ENDSEC' || v === 'ENDBLK';
    while (j < p.length && !(p[j][0] === 0 && stop(p[j][1].trim()))) {
      if (p[j][0] !== 0) { j++; continue; }
      const t = p[j][1].trim();
      j++;
      const data = {}, verts = [];
      while (j < p.length && p[j][0] !== 0) {
        const [c, v] = p[j];
        if (t === 'LWPOLYLINE' && c === 10) verts.push([parseFloat(v), undefined]);
        else if (t === 'LWPOLYLINE' && c === 20) { if (verts.length) verts[verts.length - 1][1] = parseFloat(v); }
        else (data[c] === undefined) ? data[c] = v : (Array.isArray(data[c]) ? data[c].push(v) : data[c] = [data[c], v]);
        j++;
      }
      if (t === 'POLYLINE') {
        // 구형 POLYLINE: 뒤따르는 VERTEX들을 모아 LWPOLYLINE으로 변환
        const pts = [];
        while (j < p.length && p[j][0] === 0 && p[j][1].trim() === 'VERTEX') {
          j++;
          const vd = {};
          while (j < p.length && p[j][0] !== 0) { const [c, v] = p[j]; vd[c] = v; j++; }
          pts.push([num(vd, 10), num(vd, 20)]);
        }
        if (j < p.length && p[j][0] === 0 && p[j][1].trim() === 'SEQEND') { j++; while (j < p.length && p[j][0] !== 0) j++; }
        const e = buildPoly(data, pts);
        if (e) out.push(e);
        continue;
      }
      if (t === 'INSERT') {
        const nm = (data[2] !== undefined ? String(Array.isArray(data[2]) ? data[2][0] : data[2]) : '').trim();
        if (blocks[nm]) { // 정의가 있으면 INSERT 엔티티로 유지(블록 보존)
          usedBlocks.add(nm);
          out.push({ ...baseOf(data), type: 'INSERT', name: nm, x: num(data, 10), y: num(data, 20),
            sx: num(data, 41, 1), sy: num(data, 42, 1), rot: num(data, 50, 0) });
        } else expandInsert(data, out); // 없으면 전개(빈 블록 방지)
        continue;
      }
      if (t === 'DIMENSION') {
        // 치수는 렌더링된 기하가 담긴 익명 블록(*D..)을 참조 → 그대로 전개(WCS 좌표)
        const bn = (data[2] !== undefined ? String(Array.isArray(data[2]) ? data[2][0] : data[2]) : '').trim();
        const blk = blocks[bn];
        if (blk) for (const src of blk.entities) out.push(JSON.parse(JSON.stringify(src)));
        continue;
      }
      const e = buildEntity(t, data, verts);
      if (e) out.push(e);
    }
    return j;
  }
  function parseLayers(p, start, out) {
    let j = start;
    while (j < p.length && !(p[j][0] === 0 && p[j][1].trim() === 'ENDSEC')) {
      if (p[j][0] === 0 && p[j][1].trim() === 'LAYER') {
        const lay = { name: '0', color: '#ffffff', visible: true };
        j++;
        while (j < p.length && p[j][0] !== 0) {
          const [c, v] = p[j];
          if (c === 2) lay.name = v.trim();
          else if (c === 62) { const n = parseInt(v, 10); lay.visible = n >= 0; if (!lay._tc) lay.color = aci2hex(n); } // 음수 = 꺼짐
          else if (c === 420) { const n = parseInt(v, 10); if (isFinite(n)) { lay.color = tc2hex(n); lay._tc = 1; } } // 트루컬러 우선(62보다 정확)
          else if (c === 6) { const lt = v.trim().toLowerCase(); if (LINETYPES[lt] !== undefined && lt !== 'continuous') lay.linetype = lt; }
          else if (c === 370) { const lw = parseInt(v, 10); if (lw >= 0) lay.lineweight = lw; }
          j++;
        }
        delete lay._tc; // 파싱용 임시 플래그
        if (!out.find(l => l.name === lay.name)) out.push(lay);
      } else j++;
    }
    return j;
  }
  function parseBlocks(p, start) {
    let j = start;
    while (j < p.length && !(p[j][0] === 0 && p[j][1].trim() === 'ENDSEC')) {
      if (p[j][0] === 0 && p[j][1].trim() === 'BLOCK') {
        j++;
        const bd = {};
        while (j < p.length && p[j][0] !== 0) { const [c, v] = p[j]; bd[c] = v; j++; }
        const name = (bd[2] !== undefined ? String(bd[2]) : '').trim();
        const ents = [];
        j = parseEntityStream(p, j, ents); // ENDBLK에서 멈춤
        blocks[name] = { bx: num(bd, 10), by: num(bd, 20), entities: ents };
        if (j < p.length && p[j][0] === 0 && p[j][1].trim() === 'ENDBLK') { j++; while (j < p.length && p[j][0] !== 0) j++; }
      } else j++;
    }
    return j;
  }

  // 섹션 단위로 진행 (BLOCKS는 ENTITIES보다 먼저 나오므로 INSERT 전개 시 참조 가능)
  let i = 0;
  while (i < pairs.length) {
    const [code, val] = pairs[i];
    if (code === 0 && val.trim() === 'SECTION') {
      const sec = pairs[i + 1] && pairs[i + 1][0] === 2 ? pairs[i + 1][1].trim() : '';
      if (sec === 'TABLES') { i = parseLayers(pairs, i + 2, layers); continue; }
      if (sec === 'BLOCKS') { i = parseBlocks(pairs, i + 2); continue; }
      if (sec === 'ENTITIES') { i = parseEntityStream(pairs, i + 2, entities); continue; }
    }
    i++;
  }
  let id = 1;
  for (const e of entities) e.id = id++;
  // 유지된 INSERT가 참조하는 블록 정의를 Parti 형식(기준점=원점)으로 변환
  const outBlocks = {};
  for (const nm of usedBlocks) {
    const bd = blocks[nm]; if (!bd) continue;
    outBlocks[nm] = { entities: bd.entities.map(src => { const c = JSON.parse(JSON.stringify(src)); delete c.id; translateEntity(c, -bd.bx, -bd.by); return c; }) };
  }
  return { entities, layers, blocks: outBlocks };
}

// ============================================================
//  유틸
// ============================================================
function getCSS(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function rgbHex(c) {
  if (!c) return '#ffffff';
  if (c[0] === '#') {
    if (c.length === 4) return '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
    return c;
  }
  const m = c.match(/\d+/g); if (!m) return '#ffffff';
  return '#' + m.slice(0, 3).map(n => (+n).toString(16).padStart(2, '0')).join('');
}

// ============================================================
//  초기화 + 이동 미리보기 포함 최종 draw 패치
// ============================================================
// moveOp 미리보기를 위해 draw를 확장
const baseDraw = draw;
draw = function () {
  // 이동 미리보기: 선택 도형 임시 이동
  let undoMove = null;
  if (moveOp && (moveOp.dx || moveOp.dy) && moveOp.entities) {
    undoMove = [];
    for (const id of moveOp.entities) {
      const e = state.entities.find(x => x.id === id);
      if (e) { undoMove.push(e); translateEntity(e, moveOp.dx, moveOp.dy); }
    }
  }
  baseDraw();
  if (undoMove) for (const e of undoMove) translateEntity(e, -moveOp.dx, -moveOp.dy);
  updateDimHint();
};

// 현재 상태에서 치수/수치 입력이 가능하면 그 라벨을, 아니면 null
function currentDimPrompt() {
  const t = state.tool;
  if (t === 'offset') return '간격 거리 입력';
  if (t === 'fillet') return '반지름 입력';
  if (t === 'circle' && draft) return '반지름 입력';
  if (t === 'line' && draft) return '길이·좌표 입력';
  if (t === 'rect' && draft) return '크기(w,h) 입력';
  if (t === 'pline' && pts.length) return '다음 점·길이 입력';
  if (t === 'arc' && arcState) return '다음 점 입력';
  if (t === 'rotate' && cmdOp && cmdOp.step === 'angle') return '각도(°) 입력';
  if (t === 'scale' && cmdOp && (cmdOp.step === 'ref' || cmdOp.step === 'new')) return '배율 입력';
  if (t === 'move' && moveOp && moveOp.base) return '이동 거리 입력';
  if (t === 'copy' && cmdOp && cmdOp.step === 'dest') return '이동 거리 입력';
  if (t === 'chamfer') return '모따기 거리 입력';
  if (t === 'polygon') return draft ? '반지름 입력' : '변 개수 입력';
  if (t === 'ellipse' && draft) return '반지름 rx,ry 입력';
  if (t === 'lengthen') return '증감 길이(±) 입력';
  if (t === 'hatch') return '해치 간격 입력';
  if (t === 'divide') return '등분 개수 입력';
  if (t === 'measure') return '간격 입력';
  return null;
}
let _lastDimLabel = '__init__';
function updateDimHint() {
  const label = currentDimPrompt();
  if (label === _lastDimLabel) return; // 변화 없으면 스킵
  _lastDimLabel = label;
  const el = document.getElementById('dimHint');
  if (!el || !cmdInputEl) return;
  if (label) {
    el.textContent = '⌨ ' + label; el.classList.add('on'); cmdInputEl.classList.add('dim');
    // 치수 입력 가능 → 명령창을 자동 활성화(포커스). setTimeout으로 클릭 기본동작 뒤에 확정.
    setTimeout(() => { if (currentDimPrompt() && document.activeElement !== cmdInputEl) cmdInputEl.focus({ preventScroll: true }); }, 0);
  } else { el.classList.remove('on'); el.textContent = ''; cmdInputEl.classList.remove('dim'); }
}

// ============================================================
//  다중 문서 탭 — 각 탭 = 독립 도면(엔티티·레이어·블록·뷰·undo·파일명)
// ============================================================
let docs = [], curDoc = 0;
function captureDoc() {
  return {
    entities: liveEnts(), layers: state.layers, currentLayer: state.currentLayer,
    nextId: state.nextId, blocks: state.blocks, view: { ...state.view }, views: state.views,
    levels: state.levels, curLv: state.curLv, ghostLv: state.ghostLv,
    // ★광원·센서·재질 라이브러리·태양도 문서의 일부다. 여기 없으면 문서 탭을 전환하거나
    //   새로고침 복원할 때 조명·재질·날씨가 통째로 사라진다 — 실사용 스윕에서 잡았다.
    lights: state.lights, nextLightId: state.nextLightId,
    sensors: state.sensors, nextSensorId: state.nextSensorId,
    matlib: state.matlib, sun: state.sun,
    fileName: currentFileName, fileLoc: currentFileLoc, fileHandle,
    undo: undoStack.slice(), redo: redoStack.slice(),
  };
}
function applyDoc(d) {
  state.entities = d.entities || [];
  state.layers = (d.layers && d.layers.length) ? d.layers : [{ name: '0', color: '#ffffff', visible: true }];
  if (!getLayer('0')) state.layers.unshift({ name: '0', color: '#ffffff', visible: true });
  state.currentLayer = d.currentLayer && getLayer(d.currentLayer) ? d.currentLayer : '0';
  // nextId는 반드시 기존 최대 id보다 커야 한다. 저장본의 nextId가 뒤처져 있으면(옛 파일·손상된 세션)
  // 새로 만든 도형이 기존 도형과 같은 id를 갖게 되어 선택·삭제·검볼이 엉뚱한 객체를 잡는다.
  state.nextId = Math.max(d.nextId || 1, state.entities.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1);
  state.blocks = d.blocks || {}; insertName = null;
  state.matlib = d.matlib || {};   // 재질 라이브러리 — 없으면 빈 것으로 (옛 도면 호환)
  state.owlib = d.owlib || {};     // 커스텀 창호 기호 라이브러리
  // ★태양·날씨(시간·계절·운량·탁도)도 도면의 일부다. restore(undo)만 이걸 복원하고
  //   문서 저장/불러오기·공유 경로(applyDoc)는 빠뜨렸었다 — 흐린 오후로 저장해도 열면 맑음이 됐다.
  state.sun = d.sun || null;
  // 광원 컬렉션. 개체를 못 찾는 광원은 조용히 지우지 않고 경고로 남긴다 (§1.2)
  state.sensors = Array.isArray(d.sensors) ? d.sensors : [];
  state.nextSensorId = d.nextSensorId || (state.sensors.length + 1);
  state.lights = Array.isArray(d.lights) ? d.lights.map(L => Object.assign(lightDefaults(), L)) : [];
  state.nextLightId = Math.max(d.nextLightId || 1, state.lights.reduce((m, L) => Math.max(m, +String(L.id).replace(/\D/g, '') || 0), 0) + 1);
  soloLightId = null;
  if (state.lights.length) {
    const ids = new Set(state.entities.map(e => e.id));
    const orphan = state.lights.filter(L => !ids.has(L.objectId));
    orphan.forEach(L => { L._missing = 1; }); // 조용히 지우지 말고 경고 목록에 남긴다
    if (orphan.length) logLine(`  ⚠ 광원 ${orphan.length}개가 가리키는 개체를 찾지 못했습니다: ${orphan.map(o => o.name || o.id).join(', ')}`, 'warn');
  }
  state.views = d.views || {};
  state.levels = (d.levels && d.levels.length) ? d.levels : [{ name: '1F', elev: 0 }];
  state.curLv = Math.min(d.curLv || 0, state.levels.length - 1);
  state.ghostLv = d.ghostLv !== false;
  renderLevels();
  viewPrevStack.length = 0;
  if (d.view) state.view = { ...d.view };
  fileHandle = d.fileHandle || null;
  currentFileName = d.fileName || null; currentFileLoc = d.fileLoc || null;
  undoStack.length = 0; if (d.undo) undoStack.push(...d.undo);
  redoStack.length = 0; if (d.redo) redoStack.push(...d.redo);
  state.selection.clear(); cmdOp = null; draft = null; pts = []; previewEnts = null; moveOp = null;
  setFileName(currentFileName, currentFileLoc);
  renderLayers(); renderProps(); updateStat(); refreshBlockList();
  if (typeof renderSunPanel === 'function') renderSunPanel();   // 복원한 태양·날씨를 패널에 반영
  draw();
}
function switchDoc(i) {
  if (i === curDoc || !docs[i]) { renderDocTabs(); return; }
  docs[curDoc] = captureDoc();
  curDoc = i;
  applyDoc(docs[i]);
  renderDocTabs();
  if (window.WEBCAD_API && WEBCAD_API.onDocChange) WEBCAD_API.onDocChange();
  logLine(`▷ 탭 전환: ${currentFileName || '새 파일'}`, 'info');
}
function newDocTab() {
  docs[curDoc] = captureDoc();
  docs.push({});
  curDoc = docs.length - 1;
  applyDoc({}); // 빈 도면
  if (window.WEBCAD_API && WEBCAD_API.onDocChange) WEBCAD_API.onDocChange();
  state.layers = [
    { name: '0', color: '#ffffff', visible: true },
    { name: '치수', color: '#5dff8f', visible: true },
    { name: '보조선', color: '#5d9dff', visible: true },
  ];
  state.view = { x: 0, y: 0, scale: 4 };
  renderLayers(); draw();
  renderDocTabs();
  logLine('▷ 새 탭', 'info');
}
function closeDocTab(i) {
  const d = docs[i] && i !== curDoc ? docs[i] : (i === curDoc ? captureDoc() : docs[i]);
  if (d && d.entities && d.entities.length && !confirm(`"${d.fileName || '새 파일'}" 탭을 닫을까요? (저장 안 된 내용은 사라집니다)`)) return;
  if (docs.length <= 1) { doNew(); renderDocTabs(); return; } // 마지막 탭 = 내용만 초기화
  docs.splice(i, 1);
  if (curDoc === i) { curDoc = Math.max(0, i - 1); applyDoc(docs[curDoc]); }
  else if (curDoc > i) curDoc--;
  renderDocTabs();
}
function renderDocTabs() {
  const bar = document.getElementById('docTabs');
  if (!bar) return;
  let untitled = 0;
  bar.innerHTML = docs.map((d, i) => {
    const isCur = i === curDoc;
    const nm = (isCur ? currentFileName : d.fileName) || ('새 파일' + (++untitled > 1 ? ' ' + untitled : ''));
    return `<div class="dtab${isCur ? ' active' : ''}" data-doc="${i}" title="${escapeHtml(nm)}">
      <span class="dname">${escapeHtml(nm)}</span><span class="dclose" data-close="${i}" title="탭 닫기">×</span></div>`;
  }).join('') + `<button class="dtabNew" id="dtabNew" title="새 탭">+</button>`;
  bar.querySelectorAll('.dtab').forEach(el => el.addEventListener('click', (ev) => {
    if (ev.target.dataset.close !== undefined) return;
    switchDoc(+el.dataset.doc);
  }));
  bar.querySelectorAll('.dclose').forEach(el => el.addEventListener('click', (ev) => {
    ev.stopPropagation(); closeDocTab(+el.dataset.close);
  }));
  document.getElementById('dtabNew').addEventListener('click', newDocTab);
  syncModuleTabs(bar);  // 모듈 탭(스케치·코워커·노드)을 저장된 순서로 문서 탭 왼쪽에 재삽입
  bindTabDrag(bar);     // 탭 클릭&드래그 순서 변경
}
// ── 하단 탭 라인: 모듈 탭(스케치·AI 코워커·노드) + 문서 탭 — 드래그로 순서 변경 (2026-07-20) ──
const MODTAB_KEY = 'webcad_bottabs';
const MODTAB_EL = { sk: () => window.__skTabBtn, ai: () => window.__aiTabBtn, node: () => window.__nodeTabBtn };
function modTabOrder() {
  try { const a = JSON.parse(localStorage.getItem(MODTAB_KEY) || 'null'); if (Array.isArray(a) && a.length) return a.filter(k => MODTAB_EL[k]); } catch (e) {}
  return ['sk', 'ai', 'node'];   // 기본: [스케치][AI 코워커][노드] — 코워커는 노드 왼쪽, 스케치는 맨 왼쪽
}
function syncModuleTabs(bar) {
  bar = bar || document.getElementById('docTabs'); if (!bar) return;
  const order = modTabOrder();
  for (const k of ['sk', 'ai', 'node']) if (!order.includes(k)) order.push(k);
  const els = order.map(k => MODTAB_EL[k]()).filter(Boolean);
  for (const el of els) if (el.parentNode === bar) bar.removeChild(el);
  for (let i = els.length - 1; i >= 0; i--) bar.insertBefore(els[i], bar.firstChild);
}
window.__syncBottomTabs = syncModuleTabs; // sketch.js·ai.js·nodes.js 가 등록 직후 호출
let _tabSupClick = false;
function bindTabDrag(bar) {
  if (bar._dragBound) return; bar._dragBound = true;
  const isMod = (el) => el === window.__skTabBtn || el === window.__aiTabBtn || el === window.__nodeTabBtn;
  let td = null;
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType !== 'touch') return;
    const t = e.target.closest('#docTabs > *');
    if (!t || t.id === 'dtabNew') return;
    td = { el: t, x: e.clientX, y: e.clientY, on: false };
  });
  bar.addEventListener('pointermove', (e) => {
    if (!td) return;
    if (!td.on) {
      if (Math.hypot(e.clientX - td.x, e.clientY - td.y) <= 8) return;
      td.on = true; td.el.style.opacity = '.5';
      try { bar.setPointerCapture(e.pointerId); } catch (_) {}
    }
    // 좌표(rect) 스캔으로 대상 판정 — elementFromPoint 는 숨김/백그라운드 창에서 null 이라 못 쓴다
    let over = null, rct = null;
    for (const el of bar.children) {
      if (el === td.el || el.id === 'dtabNew') continue;
      const rc = el.getBoundingClientRect();
      if (rc.width && e.clientX >= rc.left && e.clientX <= rc.right) { over = el; rct = rc; break; }
    }
    if (!over) return;
    if (isMod(td.el) !== isMod(over)) return;  // 모듈 탭 ↔ 문서 탭 사이 교차 이동은 없음
    bar.insertBefore(td.el, e.clientX > rct.left + rct.width / 2 ? over.nextSibling : over);
  });
  const tdEnd = () => {
    if (!td) return;
    if (td.on) {
      td.el.style.opacity = '';
      if (isMod(td.el)) {   // 모듈 탭 순서 저장
        const ord = [...bar.children].filter(isMod).map(el =>
          el === window.__skTabBtn ? 'sk' : el === window.__aiTabBtn ? 'ai' : 'node');
        try { localStorage.setItem(MODTAB_KEY, JSON.stringify(ord)); } catch (_) {}
      } else {              // 문서 탭 순서 = docs 배열 재배열
        const idxs = [...bar.querySelectorAll('.dtab')].map(el => +el.dataset.doc);
        if (idxs.length === docs.length && idxs.every(i => docs[i] !== undefined)) {
          const cur = docs[curDoc];
          docs = idxs.map(i => docs[i]);
          curDoc = Math.max(0, docs.indexOf(cur));
          renderDocTabs();
        }
      }
      _tabSupClick = true; setTimeout(() => { _tabSupClick = false; }, 0);
    }
    td = null;
  };
  bar.addEventListener('pointerup', tdEnd);
  bar.addEventListener('pointercancel', tdEnd);
  bar.addEventListener('click', (e) => { if (_tabSupClick) { e.stopPropagation(); e.preventDefault(); } }, true);
}

function newDrawing() {
  state.entities = [];
  state.levels = [{ name: '1F', elev: 0 }]; state.curLv = 0; state.ghostLv = true;
  if (typeof renderLevels === 'function') try { renderLevels(); } catch (e) {}
  state.layers = [
    { name: '0', color: '#ffffff', visible: true },
    { name: '치수', color: '#5dff8f', visible: true },
    { name: '보조선', color: '#5d9dff', visible: true },
  ];
  state.currentLayer = '0';
  state.selection.clear();
  state.nextId = 1;
  state.blocks = {}; insertName = null;
  // 문서 소유 데이터는 전부 비운다 — 재질 라이브러리·광원·측정면이 남으면 '새 도면' 이 아니다
  // (실측: 새 도면에 이전 도면의 재질 라이브러리가 그대로 남아 있었다 — 전역 재질 검증 중 발견)
  state.matlib = {};
  state.lights = []; state.nextLightId = 1;
  state.sensors = []; state.nextSensorId = 1;
  undoStack.length = 0; redoStack.length = 0;
  state.view = { x: 0, y: 0, scale: 4 };
  renderLayers(); renderLightList(); renderSensorList(); renderProps(); updateStat(); refreshBlockList(); setTool('select'); draw();
  logLine('새 도면을 시작했습니다. 명령행에 명령을 입력하거나 도구를 선택하세요.', 'info');
}

// ============================================================
//  자동 저장 (브라우저 localStorage) — 새로고침·앱 종료에도 작업 보존
// ============================================================
const AUTOSAVE_KEY = 'webcad_autosave_v1';
function saveLocal() {
  try {
    if (!docs.length) docs = [{}];
    docs[curDoc] = captureDoc();
    // 핸들·undo 만 빼고 문서 전체를 담는다. 예전엔 화이트리스트가 도형·레이어만 살려서
    // ★새로고침하면 광원·센서·재질 라이브러리·태양·층 구성이 통째로 사라졌다 (실사용 스윕에서 잡음).
    const sane = docs.map(d => ({
      entities: d.entities, layers: d.layers, currentLayer: d.currentLayer, nextId: d.nextId,
      blocks: d.blocks, view: d.view, views: d.views,
      levels: d.levels, curLv: d.curLv, ghostLv: d.ghostLv,
      lights: d.lights, nextLightId: d.nextLightId,
      sensors: d.sensors, nextSensorId: d.nextSensorId,
      matlib: d.matlib, sun: d.sun,
      fileName: d.fileName, fileLoc: d.fileLoc === 'pc' ? null : d.fileLoc,
    }));
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ v: 2, docs: sane, cur: curDoc, t: Date.now() }));
  } catch (e) { /* 용량 초과 등 무시 */ }
}
function loadLocal() {
  try { const s = localStorage.getItem(AUTOSAVE_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; }
}
function clearLocal() { try { localStorage.removeItem(AUTOSAVE_KEY); } catch (e) {} }
function restoreLocal(d) {
  if (d && d.docs) { // v2: 다중 문서
    docs = d.docs.map(x => ({ ...x }));
    curDoc = Math.min(d.cur || 0, docs.length - 1);
    applyDoc(docs[curDoc]); setTool('select'); renderDocTabs();
    return;
  }
  state.entities = d.entities || [];
  state.layers = (d.layers && d.layers.length) ? d.layers : [{ name: '0', color: '#ffffff', visible: true }];
  if (!getLayer('0')) state.layers.unshift({ name: '0', color: '#ffffff', visible: true });
  state.currentLayer = d.currentLayer && getLayer(d.currentLayer) ? d.currentLayer : '0';
  // nextId는 반드시 기존 최대 id보다 커야 한다. 저장본의 nextId가 뒤처져 있으면(옛 파일·손상된 세션)
  // 새로 만든 도형이 기존 도형과 같은 id를 갖게 되어 선택·삭제·검볼이 엉뚱한 객체를 잡는다.
  state.nextId = Math.max(d.nextId || 1, state.entities.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1);
  state.blocks = d.blocks || {}; insertName = null;
  state.matlib = d.matlib || {};   // 재질 라이브러리 — 없으면 빈 것으로 (옛 도면 호환)
  state.owlib = d.owlib || {};     // 커스텀 창호 기호 라이브러리
  if (d.view) state.view = d.view;
  setFileName(d.fileName || null, d.fileLoc === 'pc' ? null : (d.fileLoc || null)); // 핸들은 복원 불가 → 'pc' 표시는 내림
  state.selection.clear();
  undoStack.length = 0; redoStack.length = 0;
  renderLayers(); renderLightList(); renderSensorList(); renderProps(); updateStat(); refreshBlockList(); setTool('select'); draw();
  docs[curDoc] = captureDoc(); renderDocTabs();
}
// 변경 시 자동 저장(디바운스) + 백그라운드 전환/종료 시 즉시 저장
let _autosaveTimer = null;
function autosave() { clearTimeout(_autosaveTimer); _autosaveTimer = setTimeout(saveLocal, 800); }
window.addEventListener('beforeunload', saveLocal);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveLocal(); });
setInterval(saveLocal, 10000);

new ResizeObserver(resize).observe(wrap);
// 모바일 키보드가 올라오면 화면 높이를 가시영역에 맞춰 → 명령창이 키보드에 가리지 않게
if (window.visualViewport) {
  const app = document.getElementById('app');
  const onVV = () => { app.style.height = window.visualViewport.height + 'px'; resize(); };
  window.visualViewport.addEventListener('resize', onVV);
  window.visualViewport.addEventListener('scroll', onVV);
}
newDrawing();
resize();
// 시작 시: 공유 링크(#d=) 우선 → 없으면 자동 저장 복원(다중 탭 포함)
(function () {
  if (location.hash.indexOf('#d=') === 0) { loadFromHash(); }
  else {
    const d = loadLocal();
    if (d && ((d.docs && d.docs.length) || (d.entities && d.entities.length))) {
      restoreLocal(d);
      logLine(`이전 작업을 복원했습니다${d.docs ? ` (탭 ${d.docs.length}개)` : ''}. 새로 시작하려면 "새로 만들기".`, 'info');
    }
  }
  if (!docs.length) docs = [captureDoc()];
  renderDocTabs();
})();

// ============================================================
//  테스트 훅 — tests.html 에서 내부 순수 로직을 검증하기 위해 노출
// ============================================================
window.__CADTEST__ = {
  state,
  // 기하/스냅
  segSeg, segCircle, distToSeg, closestOnSeg, angleInArc, norm360, ang,
  intersectEntities, entityBBox, entityEndpoints, entityMidpoints, nearestOnEntity,
  entityFullyInBox, entityCrossesBox, pointInBoundary,
  // 변환
  T_translate, T_rotate, T_mirror, applyTransform, translateEntity, scaleEntities, stretchEntities,
  // 파서/직렬화
  parsePointOrNumber, buildDXFText, buildSVG, loadDXF, parseDXFPairs, parseDXFEntities,
  parseSTL, parseOBJ, loadMesh, csgOp, trisToPolys, polysToTris, cmdBoolean,
  meshSphere, meshCone, meshXform, move3DEnt, dupEnts,
  cmdSphere, cmdCone,
  cmdExtrudeCrv, cmdExtrudeSrf, beginExtrude, extrudeValidSel, extrudeStart, extrudeApplyKind, extrudeSetCap, extrudeToggleCap, extrudeSetBase, extrudeSetVal, extrudeFinish, extrudePendCancel, extrudeHover, extrude3DUI,
  footprintCentroid, runBoolean, boolFinish,
  get v3(){ return (typeof v3!=='undefined') ? v3 : null; }, get extrudePend(){ return extrudePend; }, get lastExtrudeCap(){ return lastExtrudeCap; },
  get boolPending(){return boolPending;}, zTri, zRasterFaces,
  // 이미지 + 평면 검볼
  imgCenter, imgCorners, imgLocal, imgWorld, imgSetCenter, gumballImage, imgGumHit, drawImgGumball,
  get imgGumDrag(){ return imgGumDrag; },
  get mouseScreen(){ return mouseScreen; },
  draw, worldToScreen, screenToWorld, entityHit, entityGrips, renderProps, pick, applyDoc,
  dxfColorIndex, dxfTrueColor, aci2hex, tc2hex,
  CMD_ALIASES, INSTANT_CMDS, TOOL_KO, // 명령어 체계 회귀 검사용 (라이노 이름 대조 / 2D·3D 분리 재발 방지)
  surfaceSnap3D, snap3D, polyZ, polyHasZ, finishPolyline, attachPtsZ, lvElev,
  exportEntities, computeHatchSegs: (e) => hatchSegments(e),
  polyArea, polyPerimeter, polygonPoints,
  // 편집 연산(순수)
  trimLine, extendLine, doFillet, filletPolyCorner, nearestPolySeg, clickFillet, doChamfer, offsetEntity, insertChildren,
  applyZoomWindow, cmdZoomWindow, applyZoomWindow3D, clickTrim, trimSpaceAction, emptyEnterAction, handleClick, syncModuleTabs,
  detectDoubleOutlineWall, meshVNorm, meshFeat, circlePoly, CIRC_SEG,
  // 유틸
  dxfColorIndex, aci2hex, rgbHex,
  // 링크 공유
  shareEncode, shareDecode, drawingPayload,
  // 편의기능(1~8)
  isLocked, reorderSel, selectSimilar, pointsAlongEntity,
  computeAngularDim, lineInfIntersect, zoomPrev, pushViewPrev,
  reset: () => { state.blocks = {}; state.views = {}; newDrawing(); },
  // BIM (단면/솔리드 수치 검증용)
  bimSolids, pushLitPoly, lineClipPoly, genSectionView, stairSolids, stairSteps, railingSolids, railingPath, cmdRailingTag, lightEmitters, lightGizmos, renderLightList, cmdSetAsLight, cmdUnsetLight, cmdLighting, cmdRaytrace, rtBuildScene, rtTrisByEntity, rtSyncCamera, rtGeoSig, rtSupported, rtPreview, rtFullRes, rtLightsChanged, litCacheSig, rtSetEnv, rtEnvWanted, cmdRtEnv, parseIES, iesCandelaAt, iesSummary, iesToTexture, iesFluxFactor, lightCandela, cmdIes, selectedLights, cmdRtDenoise, rtExposure, cmdExposure, RT_EXPOSURE, RT_EXPOSURE_DAY,
  vpIsPlan, vpPlanIndex, vpRect, vpRectCss, planCvRect, syncPlanCv, open3D, close3D, is3DActive, resize, worldToScreen, screenToWorld,
  rview, rviewFrame, rviewBuildScene, rviewSyncSun, rviewSig, cmdRendered,
  MAT_PRESETS, MAT_ALIAS, matOf, matKey, matHex, matBoxUV, matGeo, matBuild, matTextures, matDrawTex, cmdMaterial, rtGeoSig, bimSolidColor, secHatchFor, computePatternSegs, owWt, OPENING_TYPES, owSaveDef, owPlaced, layerAutoBim, applyLayerRoleTo, addEntity, renderLayers,
  runCommandInput, feedCmdArg,
  skyCloud, sunDirectIlluminanceClear, skyBlend, SKY_OVERCAST_E, SKY_OVERCAST_RGB,
  skyCloudMask, skySolve, skyCtxCompute, _skyFbm, SKY_CLOUD_TILE,
  skyCloudThreshold, skyCloudQuantiles,
  rviewSkyTexture, RVIEW_SKY_W, RVIEW_SKY_H,
  vpIsRendered, vpShowLabel, vpHideLabel, vpLabelEl,
  markInteract, sunApply, preethamCache,
  captureDoc, saveLocal, loadLocal,
  RT_QUALITY, cmdRtQuality, cmdGround, makeGroundMesh, groundSizeMM, GROUND_Z_MM,
  RVIEW_AO, cmdAo, rviewAoRender, rviewLoadFx, cmdCapture, cmdFinalRender, cmdBg, cmdEdges,
  iesCutoffDeg, matGlobalAll, matGlobalSet, matGlobalDelete, matLibShare, matLibUnshare,
  rviewCloudShadowTexture, rviewSyncCloudShadow, RVIEW_CLOUD_N, MATG_KEY,
  RT_DN, rtSetupDenoise,
  vpIsRt, rtFrame, rtWithVp, rtExit, rtResize, rtCameraChanged,
  vpModeMenu, vpSetMode, closeVpMenu, cycleElev,
  modelExtents, entityExtentPts, fit3D, zoomFit, pushViewPrev, zoomPrev,
  matSetX, matCommon, matPropRow, wireMatProp, matRefresh,
  matIsLib, matLibName, matLibGet, matLibSpec, matImgCanvas, matImgShrink, MAT_LIB_PREFIX, MAT_IMG_MAX,
  matLibSave, matLibList, matLibDelete, matLibImage,
  weatherName,
  renderScene, render3D, findFaceAt, sunDefaults, sunState, solarPosition, sunLight, sunOn, renderSunPanel, sunApply, litAmbient, litSky, skyVis, SUN_LIT_POWER, shadePerLux, skyProjectSH, skyIrradiance, skyDirRadiance, skyCtx, skySH, sunDirection, sunNoonMinutes, sunDirectIlluminance, sunDiskLuminance,
  skyRadiance, sunAirMass, rtMakeSky, cmdSun, sunSummary, skyTurbidity, SUN_SOLID_ANGLE, SUN_ANG_RADIUS, rtAddLights, rtEmitterLook, rtRadiance, RT_EMITTER_LOOK, RT_MM, rtLoop, RT_TARGET_SPP, illuminanceAt, falseColor, sensorMeasure, sensorGrid, sensorCSV,
  cmdAddSensorPlane, cmdFalseColor, renderSensorList, FC_MAX_DEF, lightPropRows, renderProps, get undoStack() { return undoStack; }, get rt() { return rt; }, lightSources, litFace,
  kelvinToRGB, lmToPower, lightOfEnt, lightById, pruneLights, LIGHT_PRESETS, shadowOccluders, shadowed, visFraction, bounceLights, rayHit, shadeColor3, pathStations, renderScene,
  get LIT_RGB(){ return LIT_RGB; }, roofSolids, solidTopZ,
  proj3D, unproj3D, snap3D, srfSurfaceSnap,
  renderProps, propRefresh, pick3DAt, findFaceAt, bimSolidColor,
  runBoolean, meshFeat, meshComponents, meshEdgeKey, detectDoubleOutlineWall,
  // 작업 자유도 확장 (자유곡선·로프트·회전체·절단·조건선택·부피)
  catmullRom2D, finishSpline, crvSampleN, crvPtAt, crvClosedQ, sliceBoxTris,
  cmdLoft, cmdRevolve, cmdSlice, cmdQSelect, cmdVolume,
  cmdSweep, cmdShell, cmdFillet3D, cmdGroup, cmdUngroup, clickDimBase,
  crvLen, polyOffsetIn, polyRoundCorners, prismTris, polyArea2,
  get pts(){ return pts; }, set pts(v){ pts = v; },
  // 색상 (WYSIWYG 잉크 + 팝오버)
  themedInk, entityColor, readRecentColors, pushRecentColor, openColorPop, closeColorPop, PRESET_COLORS,
};

// ============================================================
//  AI 코워크 브리지 — ai.js(자연어 챗봇)가 도면을 조작할 때 쓰는 내부 API
// ============================================================
window.WEBCAD_AI_BRIDGE = {
  state, pushUndo, addEntity, logLine, selectedEntities, ensureLayer,
  entityBBox, entityLength, polyArea,
  translateEntity, applyTransform, T_rotate, move3DEnt, gumRotate, meshSphere, meshCone,
  runBoolean, isBoolable, bimSolids,
  genSectionView,   // 입면/단면 자동 생성 (AI make_views 도구)
  renderLayers,     // 레이어 정리 후 패널 갱신 (AI organize_layers 도구)
  switchDoc, getCurDoc: () => curDoc, getDocName: () => currentFileName,   // 입면/단면은 새 탭에 생성 — 봇이 원본 탭으로 복귀할 때 사용
  is3D: is3DActive,
  draw,             // 가벼운 2D 재그리기 — 스케치 엔진(sketch.js)의 팬/줌이 매 프레임 사용 (refresh 는 패널까지 다시 그려 무겁다)
  refresh: () => {
    renderLayers(); renderLightList(); renderSensorList(); renderProps(); draw(); updateStat();
    if (is3DActive() && typeof v3 !== 'undefined' && v3) { v3.solids = bimSolids(); render3D(); }
  },
};

// ============================================================
//  공식 외부 API — 클라우드 모듈(cloud.js)이 사용
// ============================================================
window.WEBCAD_API = {
  // 현재 도면 스냅샷 (클라우드 저장용)
  getDoc: () => ({
    name: currentFileName,
    data: { v: 1, entities: liveEnts(), layers: state.layers, currentLayer: state.currentLayer,
            blocks: state.blocks, matlib: state.matlib, owlib: state.owlib, sun: state.sun, nextId: state.nextId, view: state.view, views: state.views,
            levels: state.levels, curLv: state.curLv,
            lights: state.lights, nextLightId: state.nextLightId,
            sensors: state.sensors, nextSensorId: state.nextSensorId },
  }),
  // 클라우드 도면 로드
  setDoc: (name, d) => {
    applyDoc({ entities: d.entities, layers: d.layers, currentLayer: d.currentLayer, nextId: d.nextId,
               matlib: d.matlib, owlib: d.owlib, sun: d.sun,
               lights: d.lights, nextLightId: d.nextLightId,
               sensors: d.sensors, nextSensorId: d.nextSensorId,
               blocks: d.blocks, view: d.view, views: d.views, levels: d.levels, curLv: d.curLv,
               fileName: name || null, fileLoc: 'cloud' });
    renderDocTabs(); draw();
  },
  getName: () => currentFileName,
  setName: (n) => { setFileName(n, 'cloud'); renderDocTabs(); },
  getRev: () => apiRev, // 변경 카운터 (dirty 판단)
  // 축소 썸네일 (JPEG dataURL)
  thumb: (px) => {
    try {
      const k = (px || 240) / Math.max(cv.width || 1, cv.height || 1);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(cv.width * k)); c.height = Math.max(1, Math.round(cv.height * k));
      c.getContext('2d').drawImage(cv, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.6);
    } catch (e) { return null; }
  },
  // 설정 동기화
  getSettings: () => JSON.parse(JSON.stringify(settings)),
  setOsnapMode: (k, on) => { if (settings.osnapModes && k in settings.osnapModes) { settings.osnapModes[k] = !!on; saveSettings(); } },
  applySettings: (s) => {
    if (!s) return;
    settings.units = s.units || settings.units;
    Object.assign(settings.osnapModes, s.osnapModes || {});
    if (s.polar !== undefined) settings.polar = s.polar;
    settings.aliases = s.aliases || settings.aliases;
    Object.assign(settings.dim, s.dim || {});
    Object.assign(settings.bim, s.bim || {});
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
    draw();
  },
  zoomFit: () => zoomFit(true),
  redraw: () => { draw(); if (is3DActive() && typeof v3 !== 'undefined' && v3) render3D(); }, // 테마 전환 등 전체 갱신 시 4분할 3D 칸도 새 캔버스색으로 다시 칠함(안 그러면 직전 테마 색이 남아 반대로 보임)
  layersTpl: { get: layersTplData, apply: applyLayersTpl, exportFile: exportLayersTpl, importFile: importLayersTplFile }, // 레이어 목록 템플릿 (cloud.js 슬롯 UI 가 사용)
  // 블록 라이브러리
  getBlocks: () => state.blocks,
  addBlock: (name, def) => { state.blocks[name] = def; refreshBlockList(); logLine(`  ✔ 라이브러리에서 블록 "${name}" 가져옴 — 삽입(insert)으로 배치`, 'ok'); },
  log: (msg, kind) => logLine(msg, kind || 'info'),
  // ── 실시간 공동편집용 ──
  // 원격 변경 적용 (undo 스택에 넣지 않음 — 내 실행취소가 상대 작업을 되돌리지 않게)
  applyRemote: (ups, dels, blocks, layers) => {
    const byId = new Map(state.entities.map(e => [e.id, e]));
    for (const e of (ups || [])) {
      const ex = byId.get(e.id);
      if (ex) {
        for (const k of Object.keys(ex)) delete ex[k];
        Object.assign(ex, e);
        if (ex.type === 'HATCH') hatchDirty(ex);
      } else state.entities.push(e);
      if (e.id >= state.nextId) state.nextId = e.id + 1 + Math.floor(Math.random() * 50);
    }
    if (dels && dels.length) {
      const s = new Set(dels);
      state.entities = state.entities.filter(e => !s.has(e.id));
      for (const id of s) state.selection.delete(id);
    }
    if (blocks) { state.blocks = blocks; refreshBlockList(); }
    if (layers) { state.layers = layers; renderLayers(); }
    updateStat(); renderProps(); draw();
    // 3D 뷰도 즉시 갱신 — 이게 없으면 원격 변경이 솔리드에 반영되지 않아, 개체를 클릭해
    // 선택 경로가 render3D 를 돌릴 때까지 3D 화면이 옛 상태로 남는다 (2026-07-24 사용자).
    if (is3DActive() && typeof v3 !== 'undefined' && v3) { v3.solids = bimSolids(); render3D(); }
  },
  // 세션 참가 시 id 충돌 회피 (두 사용자가 같은 nextId로 동시에 생성하는 것 방지)
  jitterNextId: () => { state.nextId += 1000 + Math.floor(Math.random() * 9000); },
  // cloud.js가 설정하는 훅
  onUsage: null, onSettingsChange: null, onDocChange: null, onEdit: null,
};

// 로드된 cad.js 버전을 명령 로그에 표시 (캐시로 예전 버전 로딩 여부 확인용)
try {
  const sc = [...document.scripts].find(s => /cad\.js/.test(s.src || ''));
  const m = sc && (sc.src || '').match(/v=([0-9a-z.]+)/);
  window.WEBCAD_VERSION = m ? m[1] : 'unknown';
} catch (e) { window.WEBCAD_VERSION = 'unknown'; }
setTimeout(() => { try { logLine(`Parti · cad.js 버전 ${window.WEBCAD_VERSION}`, 'info'); } catch (e) {} }, 900);
// 자동 업데이트 — GitHub Pages가 index.html을 10분 캐시(max-age=600)해서, 새로고침해도
// 예전 index.html→예전 cad.js가 로딩되는 문제. 고유 쿼리로 원본에서 최신 index.html을 받아
// 로딩된 버전과 다르면(=캐시로 옛 버전 로딩됨) 캐시 우회 URL로 자동 이동(세션당 버전별 1회).
setTimeout(async () => {
  try {
    const res = await fetch(location.pathname + '?_=' + Date.now(), { cache: 'no-store' });
    const txt = await res.text();
    const m = txt.match(/cad\.js\?v=([0-9a-z.]+)/);
    const latest = m && m[1];
    if (latest && latest !== window.WEBCAD_VERSION) {
      const goFresh = () => location.replace(location.pathname + '?v=' + latest + '.' + Date.now().toString(36));
      // 눈에 확 띄는 업데이트 배너 (클릭=캐시 우회 새로고침) — 자동 새로고침이 막혀도 사용자가 직접 누를 수 있게
      try {
        const bar = document.createElement('div');
        bar.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:99999;background:#0A84FF;color:#fff;padding:11px 18px;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.45);font:600 14px system-ui,sans-serif;cursor:pointer;';
        bar.textContent = `새 버전(${latest}) 있음 — 눌러서 업데이트`;
        bar.onclick = goFresh;
        document.body.appendChild(bar);
        try { logLine(`  ↻ 새 버전(${latest}) 감지 — 상단 파란 배너를 누르거나 잠시 후 자동 새로고침`, 'info'); } catch (e) {}
      } catch (e) {}
      const guard = 'webcad_upd_' + latest;
      if (!sessionStorage.getItem(guard)) { sessionStorage.setItem(guard, '1'); setTimeout(goFresh, 1200); } // 자동 1회 시도(고유 쿼리로 캐시 확실 우회)
    }
  } catch (e) {}
}, 1500);

})();
