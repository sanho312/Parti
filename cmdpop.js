/* ============================================================
   Parti 커서 명령창 — 사용자 피드백 ⑥
   왼쪽 도구창(#toolbar)과 상단 명령 콘솔(#console)을 없애고,
   스페이스/엔터(또는 그냥 타이핑)를 누르면 마우스 커서 왼쪽에
   작은 명령창이 뜬다. 기존 #cmdInput DOM 을 통째로 옮겨 담으므로
   자동완성·직전 명령 반복·모든 명령 로직이 그대로 동작한다.
   명령 기록(logLine)은 상단 중앙의 짧은 토스트로 흘려보여 준다.
   ============================================================ */
(() => {
'use strict';
const cmdRow = document.getElementById('cmdInputRow');
const cmdInput = document.getElementById('cmdInput');
const cmdLog = document.getElementById('cmdLog');
if (!cmdRow || !cmdInput) return;

// ---------- 콘솔 도크 + 커서 팝업 ----------
// 2026-07-20 개편: 고정 명령창(하단 콘솔 = 로그 + 입력줄)을 되살린다.
//  · 콘솔은 화면 '하단'(작업영역 아래, 상태바 위) — 로그가 입력줄 바로 위.
//  · 얇은 알약 손잡이(#cmdDockTab)로 접고 펼침 (도구창 손잡이와 같은 문법).
//  · 콘솔을 '숨기면' 기존 커서 옆 팝업 명령창이 대신 동작한다.
const css = document.createElement('style');
css.textContent = `
  /* 콘솔을 하단으로 (BIM29 때 상단 order:2 → 하단 order:4) + 접힘 상태 */
  #console { order: 4 !important; border-top: 0.5px solid var(--line); border-bottom: none !important; }
  #statusBar { order: 5 !important; }
  #console.dockHidden { display: none !important; }
  /* ★구식 '기록 접기'(F2·hideBottom) 무력화 — 토글 버튼(#tgBottom)은 이미 숨겼는데 F2 를
     실수로 누르면 cmdLog 가 localStorage 로 영구 숨김되어 "로그가 사라졌다"가 된다(2026-07-25).
     도크 체제에서 로그는 항상 콘솔과 함께 보인다. */
  #app.hideBottom #cmdLog { display: block !important; }
  /* 하단 콘솔이므로 제안(자동완성)은 입력줄 '위'로 */
  #console #cmdSuggest { bottom: calc(100% + 8px) !important; top: auto !important; }
  #tgBottom { display: none !important; }
  /* 콘솔 접기/펼치기 손잡이 — 도구창 손잡이(.rz 알약)와 같은 비주얼, 가로 방향 */
  #cmdDockTab{position:absolute;left:50%;transform:translateX(-50%);width:76px;height:12px;z-index:60;
    background:var(--canvas-bg,#0a1020);border-radius:7px;cursor:pointer;user-select:none;touch-action:manipulation;}
  /* 불투명 칩 배경 — 4분할 활성 칸의 파란 테두리가 손잡이를 관통해 보이지 않게(테두리가 버튼 '밑'으로) */
  #cmdDockTab::after{content:'';position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
    width:44px;height:3px;border-radius:2px;background:var(--line-strong,rgba(120,140,180,.45));
    transition:background .15s ease,width .15s ease;}
  #cmdDockTab:hover::after{background:var(--accent,#0A84FF);width:64px;}
  /* 닫힘 = 투명+클릭 통과 (display:none 이면 안의 입력창이 포커스 불가라 '글자=명령'이 죽는다) */
  /* 네모난 흰 박스 — 검은 텍스트. '열리는 순간의 커서 위치'에 고정된다(따라다니지 않음 —
     아래로 뜨는 유사 명령어를 클릭할 수 있어야 하므로). 2026-07-20: 텍스트 한 줄 높이 · 폭 절반. */
  #cmdPop{position:fixed;z-index:70;display:flex;opacity:0;pointer-events:none;
    min-width:64px;max-width:min(150px,90vw);
    background:#ffffff;border:1px solid #b8bfcc;border-radius:3px;
    box-shadow:0 3px 10px rgba(0,0,0,.22);padding:1px 4px;}
  #cmdPop #cmdLabel{display:none;}                /* '명령:' 라벨 없이 입력만 */
  #cmdPop.open{opacity:1;pointer-events:auto;}
  #cmdPop #cmdInputRow{display:flex;background:none;border:none;padding:0;align-items:center;}
  #cmdPop .cmdInputWrap{flex:1 1 56px;min-width:0;max-width:120px;}
  #cmdPop #cmdLabel{color:#333;font-size:12px;}
  /* 텍스트 색은 테마와 무관하게 강제 — 흰 박스 안은 항상 진한 글자 (화이트모드 흰 글자 금지) */
  #cmdPop #cmdInput{background:#fff !important;color:#111 !important;-webkit-text-fill-color:#111;
    caret-color:#111;border:none;outline:none;font-size:12px;
    padding:0 2px;height:15px;line-height:15px;border-radius:0;box-shadow:none !important;
    font-family:var(--mono,monospace);}
  #cmdPop #cmdInput:focus{box-shadow:none !important;background:#fff !important;}
  /* 유사 명령어 목록은 입력 박스 '아래'로 — 박스가 고정이므로 그대로 클릭 가능 */
  #cmdPop #cmdSuggest{bottom:auto;top:calc(100% + 6px);}
  #cmdPop #cmdPrompt, #cmdPop #dimHint{color:#444;}
  /* 유사 명령어 목록 — 명령창과 같은 디자인(흰 박스·같은 테두리·radius 3px·12px 글자) */
  #cmdPop #cmdSuggest{background:#fff;color:#111;border:1px solid #b8bfcc;border-radius:3px;
    box-shadow:0 3px 10px rgba(0,0,0,.22);padding:3px;min-width:150px;font-size:12px;}
  #cmdPop .sugItem{color:#111;padding:4px 8px;border-radius:2px;font-size:12px;}
  #cmdPop .sugItem .sname{color:#0a54c8;}
  #cmdPop .sugItem .sko{color:#666;font-size:10.5px;}
  #cmdPop .sugItem.sel, #cmdPop .sugItem:hover{background:#e8f0ff;}
  /* ★일치 글자(.match) — 본체 CSS가 선택 행에 연백색(#dcebff)을 입혀 흰 박스에서 사라졌다.
     흰 박스 안은 항상 진한 파랑 (화이트모드 흰 글자 금지 규칙) */
  #cmdPop .sugItem .match{color:#0a54c8;}
  #cmdPop .sugItem.sel .match, #cmdPop .sugItem:hover .match{color:#0a54c8;}
  #cmdPop .sugItem.sel .sname, #cmdPop .sugItem:hover .sname{color:#0a54c8;}
  #cmdToast{position:fixed;left:50%;top:52px;transform:translateX(-50%);z-index:69;
    max-width:min(700px,92vw);background:rgba(15,22,40,.92);border:1px solid rgba(120,150,220,.35);
    border-radius:10px;padding:6px 14px;font:12.5px -apple-system,system-ui,sans-serif;color:#cfe0ff;
    pointer-events:none;opacity:0;transition:opacity .25s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
`;
document.head.appendChild(css);

// ---------- 플로팅 팝업 (콘솔을 숨겼을 때 입력줄을 입양) ----------
const pop = document.createElement('div');
pop.id = 'cmdPop';
document.body.appendChild(pop);
cmdInput.placeholder = '';                       // 입력 전 사용법 안내 텍스트 제거 — 빈 박스

// ---------- 콘솔 도크 (하단 고정 명령창 + 로그) ----------
const consoleEl = document.getElementById('console');
const DOCK_KEY = 'webcad_cmddock';
let dockOpen = true;                             // 기본 = 고정 명령창 표시 (2026-07-20 사용자 요청)
try { const s = localStorage.getItem(DOCK_KEY); if (s != null) dockOpen = JSON.parse(s); } catch (e) {}
const tab = document.createElement('div');
tab.id = 'cmdDockTab';
tab.title = '클릭: 명령창(로그+입력줄) 펼침/접기 — 접으면 커서 옆 팝업 명령창으로';
function positionTab() {
  const app = document.getElementById('app'); if (!app) return;
  const ar = app.getBoundingClientRect();
  const anchor = (dockOpen && consoleEl) ? consoleEl.getBoundingClientRect().top
    : (document.getElementById('statusBar') ? document.getElementById('statusBar').getBoundingClientRect().top : ar.bottom);
  tab.style.top = (anchor - ar.top - 7) + 'px';
}
function applyDock() {
  if (!consoleEl) return;
  if (dockOpen) {
    consoleEl.appendChild(cmdRow);               // 입력줄을 콘솔로 (로그 아래 = 로그가 입력줄 바로 위)
    consoleEl.classList.remove('dockHidden');
    hidePop(); pop.style.display = 'none';
  } else {
    pop.appendChild(cmdRow);                     // 입력줄을 커서 팝업으로
    pop.style.display = '';
    consoleEl.classList.add('dockHidden');
  }
  requestAnimationFrame(positionTab);
  window.dispatchEvent(new Event('resize'));     // 작업영역 높이 변화 → 캔버스 재조정
}
tab.addEventListener('click', () => {
  dockOpen = !dockOpen;
  try { localStorage.setItem(DOCK_KEY, JSON.stringify(dockOpen)); } catch (e) {}
  applyDock();
});
window.addEventListener('resize', () => requestAnimationFrame(positionTab));
(document.getElementById('app') || document.body).appendChild(tab);
const appEl = document.getElementById('app');
if (appEl && getComputedStyle(appEl).position === 'static') appEl.style.position = 'relative';
let lastPtr = { x: innerWidth / 2, y: innerHeight / 2 };
const isOpen = () => pop.classList.contains('open');
function place() {
  // 커서의 '오른쪽'에 — 팝업 왼쪽 끝을 커서에 붙인다 (화면 밖이면 왼쪽으로)
  const r = pop.getBoundingClientRect();
  let x = lastPtr.x + 14;
  if (x + r.width > innerWidth - 8) x = Math.max(8, lastPtr.x - r.width - 14);
  const y = Math.max(8, Math.min(innerHeight - r.height - 8, lastPtr.y - r.height / 2));
  pop.style.left = x + 'px'; pop.style.top = y + 'px';
}
// 열려 있는 동안엔 '고정' — 커서를 따라가면 입력 중 아래 유사 명령어를 클릭할 수 없다.
// lastPtr 만 계속 갱신해 두었다가, 다음에 '열리는 순간'의 커서 위치에 박스를 놓는다.
window.addEventListener('pointermove', (e) => {
  lastPtr = { x: e.clientX, y: e.clientY };
}, { passive: true });
window.addEventListener('pointerdown', (e) => { lastPtr = { x: e.clientX, y: e.clientY }; }, { passive: true, capture: true });

function showPop() {
  if (isOpen()) return;
  place();
  pop.classList.add('open');
  try { cmdInput.focus({ preventScroll: true }); } catch (e) {}
}
function hidePop() { pop.classList.remove('open'); }

// ---------- 열기/닫기 규칙 ----------
const sketchOn = () => !!(window.WEBCAD_SKETCH && window.WEBCAD_SKETCH.SK.on);
const inOtherField = (t) => t && ((/INPUT|TEXTAREA|SELECT/.test(t.tagName) && t.id !== 'cmdInput')
  || (t.closest && t.closest('#aiPanel')));
// 스페이스/엔터 = '직전 명령 반복'(빈 Enter 동작 — 작도 확정·차집합 완료 포함) (2026-07-20 개편).
// 예전엔 팝업을 여는 데 소비했는데, 반복이 라이노/오토캐드 관례이고 trim의 Space 확정도 이걸로 산다.
window.addEventListener('keydown', (e) => {
  if (sketchOn() || isOpen()) return;
  if (inOtherField(e.target)) return;
  if (e.target && e.target.id === 'cmdInput') return; // 도크 입력줄 안의 키는 본체(cad.js)가 처리
  if (document.body.classList.contains('authLocked')) return;
  const k = typeof e.key === 'string' ? e.key : '';
  if (k === ' ' || k === 'Enter') {
    e.preventDefault(); e.stopPropagation();
    if (window.WEBCAD_EMPTY_ENTER) window.WEBCAD_EMPTY_ENTER();
  }
}, true);
// 글자를 치면(전역 핸들러가 명령창에 넣어준다) 팝업이 따라 뜬다 — 콘솔을 숨긴 상태에서만
cmdInput.addEventListener('input', () => { if (!dockOpen && cmdInput.value && !isOpen() && !sketchOn()) showPop(); });
// 명령을 실행(엔터/스페이스)하고 입력이 비면 닫는다 — 진행 안내는 토스트가 맡는다
cmdInput.addEventListener('keydown', (e) => {
  const k = typeof e.key === 'string' ? e.key : '';
  if (k === 'Enter' || k === ' ') setTimeout(() => { if (!dockOpen && !cmdInput.value) hidePop(); }, 60);
}, false);
// Esc = 명령창 '초기화' — 입력이 있으면 지우기만(다른 취소로 안 새게), 비어 있으면 닫고 본체 취소로
cmdInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (cmdInput.value) { cmdInput.value = ''; e.stopPropagation(); e.preventDefault(); }
  if (!dockOpen) hidePop();
}, true);
// 바깥 클릭(작도 지점 클릭 포함) = 닫기 — 숫자·좌표를 다시 치면 곧바로 다시 뜬다
document.addEventListener('pointerdown', (e) => {
  if (isOpen() && !pop.contains(e.target)) hidePop();
}, true);

// ---------- 명령 기록 토스트 (콘솔이 사라진 자리를 가볍게 대신한다) ----------
const toast = document.createElement('div');
toast.id = 'cmdToast';
document.body.appendChild(toast);
let toastTimer = null;
function showToast(text) {
  if (!text) return;
  toast.textContent = text;
  toast.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.style.opacity = '0'; }, 3500);
}
if (cmdLog) {
  new MutationObserver(() => {
    // 콘솔(로그)이 '실제로 보일' 때만 토스트 억제 — dockOpen 플래그만 믿으면 다른 코드가
    // 콘솔·로그를 숨겼을 때 로그가 어디에도 안 보이는 사각지대가 생긴다 (2026-07-25 회귀의 교훈)
    const logVisible = dockOpen && consoleEl && consoleEl.offsetParent !== null
      && cmdLog.offsetParent !== null;
    if (logVisible) return;
    const last = cmdLog.lastElementChild;
    if (last && last.textContent) showToast(last.textContent.trim());
  }).observe(cmdLog, { childList: true });
}

// 시작 배치 (저장된 접힘 상태 복원)
applyDock();
setTimeout(() => requestAnimationFrame(positionTab), 200); // 레이아웃 안정 후 손잡이 위치 보정

// 외부/테스트 훅
window.WEBCAD_CMDPOP = { show: showPop, hide: hidePop, isOpen, pop, place, setPtr: (x, y) => { lastPtr = { x, y }; },
  isDock: () => dockOpen,
  setDock: (o) => { dockOpen = !!o; try { localStorage.setItem(DOCK_KEY, JSON.stringify(dockOpen)); } catch (e) {} applyDock(); },
  tab };
})();
