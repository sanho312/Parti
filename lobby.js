// ============================================================
//  Parti 로비(랜딩) 화면 v2 — 프로젝트 관리형
//  - 상단: 햄버거(자주 안 쓰는 기능·확장) · 검색 · 프로필/구독 카드
//  - 최근 작업 레일 + 그룹 탭 + 도면 목록(목록형/카드형)
//  - 도면 데이터는 cloud.js(window.WEBCAD_CLOUD), 인증은 auth.js(WEBCAD_AUTH_API)
//  - 프로젝트 그룹은 서버 스키마에 없어 이 브라우저에만 저장된다(localStorage)
// ============================================================
(() => {
  const AUTH = () => window.WEBCAD_AUTH_API || null;
  const CLOUD = () => window.WEBCAD_CLOUD || null;
  const authConfigured = !!(window.WEBCAD_AUTH && window.WEBCAD_AUTH.url) || localStorage.getItem('webcad_auth_demo') === '1';
  let session = null;      // 로그인 세션 (webcad-auth 이벤트로 갱신)
  let files = [];          // list_drawings() 결과
  let loadErr = '';        // 목록 로드 실패 사유

  // ---------- 스타일 ----------
  // 색·둥근모서리는 index.html의 Liquid Glass 토큰을 그대로 상속한다.
  // 테마 분기는 컴포넌트 규칙이 아니라 토큰(--lb-sel)에만 둔다.
  const style = document.createElement('style');
  style.textContent = `
  #lobby{position:fixed;inset:0;z-index:300;overflow:auto;color:var(--text);
    --lb-sel:var(--panel3);
    background:var(--bg);   /* 작업환경과 같은 플랫 배경 — 그라디언트 제거 (2026-07-26 톤 통일) */
    -webkit-user-select:none;user-select:none;}
  html.light #lobby{--lb-sel:#ffffff;}
  #lobby.hidden{display:none;}
  #lobby button{font-family:inherit;color:inherit;border:none;background:none;cursor:pointer;letter-spacing:inherit;}
  #lobby :focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px;}
  @media (prefers-reduced-motion:reduce){ #lobby *{transition:none!important;animation:none!important;} }

  /* 상단 크롬 */
  #lobby .lbChrome{position:sticky;top:0;z-index:40;background:var(--panel);
    border-bottom:0.5px solid var(--line);}   /* 작업환경 상단바와 같은 플랫 패널 */
  #lobby .lbChromeIn{max-width:1240px;margin:0 auto;padding:11px 24px;display:flex;align-items:center;gap:14px;}
  #lobby .lbIcoBtn{width:36px;height:36px;border-radius:var(--radius);display:grid;place-items:center;
    background:var(--panel2);box-shadow:var(--spec);transition:background .12s ease;flex:none;}
  #lobby .lbIcoBtn:hover{background:var(--panel3);}
  #lobby .lbIcoBtn svg{width:17px;height:17px;stroke:currentColor;stroke-width:1.7;fill:none;stroke-linecap:round;}
  #lobby .lbWord{font-size:15.5px;font-weight:680;letter-spacing:-0.025em;white-space:nowrap;flex:none;
    display:flex;align-items:center;gap:7px;}
  #lobby .lbWord .mk{color:var(--accent-text);font-size:16px;}

  #lobby .lbSearch{flex:1;min-width:0;position:relative;max-width:560px;margin:0 auto;}
  #lobby .lbSearch svg{position:absolute;left:12px;top:50%;transform:translateY(-50%);width:15px;height:15px;
    stroke:var(--muted2);stroke-width:1.8;fill:none;pointer-events:none;}
  #lobby .lbSearch input{width:100%;height:36px;padding:0 14px 0 34px;border-radius:var(--radius-pill);
    background:var(--panel2);box-shadow:var(--spec);color:var(--text);font-size:13px;font-family:inherit;
    border:0.5px solid transparent;transition:border-color .12s,background .12s;-webkit-user-select:text;user-select:text;}
  #lobby .lbSearch input::placeholder{color:var(--muted2);}
  #lobby .lbSearch input:focus{outline:none;border-color:var(--accent);background:var(--panel3);}

  #lobby .lbPcard{display:flex;align-items:center;gap:9px;padding:5px 10px 5px 5px;border-radius:var(--radius-pill);
    background:var(--panel2);box-shadow:var(--spec);transition:background .12s ease;flex:none;}
  #lobby .lbPcard:hover,#lobby .lbPcard[aria-expanded="true"]{background:var(--panel3);}
  #lobby .lbAv{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;flex:none;
    font-size:11.5px;font-weight:700;color:#fff;letter-spacing:0;background:linear-gradient(145deg,var(--accent),#6f4bff);}
  #lobby .lbPtxt{display:flex;flex-direction:column;gap:1px;align-items:flex-start;line-height:1.15;}
  #lobby .lbPname{font-size:12.5px;font-weight:620;}
  #lobby .lbPplan{font-size:9.5px;font-weight:700;letter-spacing:0.04em;color:var(--muted);}
  #lobby .lbChev{width:13px;height:13px;stroke:var(--muted2);stroke-width:2;fill:none;flex:none;}

  /* 본문 */
  #lobby .lbMain{max-width:1240px;margin:0 auto;padding:22px 24px 80px;display:flex;flex-direction:column;gap:26px;}
  #lobby .lbSecHead{display:flex;align-items:baseline;gap:10px;margin-bottom:11px;}
  #lobby .lbSecHead h2{margin:0;font-size:13px;font-weight:660;letter-spacing:-0.01em;}
  #lobby .lbSecHead .hint{font-size:11.5px;color:var(--muted2);}

  /* 최근 작업 레일 */
  #lobby .lbTrack{display:grid;grid-auto-flow:column;grid-auto-columns:210px;gap:12px;overflow-x:auto;
    padding:2px 2px 10px;scroll-snap-type:x proximity;}
  #lobby .lbTrack > *{scroll-snap-align:start;}
  #lobby .lbNew{display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:8px;
    padding:16px;border-radius:var(--radius-lg);text-align:left;border:1.5px dashed var(--line-strong);
    background:transparent;transition:border-color .12s,background .12s;}
  #lobby .lbNew:hover{border-color:var(--accent);background:var(--panel2);}
  #lobby .lbNew .plus{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;
    background:var(--accent);color:#fff;font-size:17px;line-height:1;}
  #lobby .lbNew .nt{font-size:13.5px;font-weight:640;}
  #lobby .lbNew .nd{font-size:11px;color:var(--muted);line-height:1.4;}

  #lobby .lbRcard{display:flex;flex-direction:column;border-radius:var(--radius-lg);overflow:hidden;text-align:left;
    background:var(--panel2);box-shadow:var(--spec);transition:transform .12s ease,background .12s ease;}
  #lobby .lbRcard:hover{transform:translateY(-2px);background:var(--panel3);}
  #lobby .lbThumb{width:100%;height:112px;display:block;object-fit:cover;background:var(--panel2);
    border-bottom:0.5px solid var(--line);}
  #lobby .lbNoThumb{width:100%;height:112px;display:grid;place-items:center;background:var(--panel2);
    border-bottom:0.5px solid var(--line);color:var(--muted2);font-size:22px;}
  #lobby .lbCbody{padding:9px 11px 11px;display:flex;flex-direction:column;gap:5px;}
  #lobby .lbCname{font-size:12.5px;font-weight:620;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  #lobby .lbCmeta{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--muted);
    font-variant-numeric:tabular-nums;min-width:0;}
  #lobby .lbCmeta .sep{color:var(--muted2);}
  #lobby .lbChip{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:var(--radius-pill);
    font-size:10px;font-weight:600;background:var(--panel3);color:var(--muted);white-space:nowrap;
    max-width:100%;overflow:hidden;text-overflow:ellipsis;}
  #lobby .lbChip.shared{color:var(--accent-text);background:rgba(10,132,255,0.15);}

  /* 그룹 탭 + 도구 */
  #lobby .lbBrowser{display:flex;flex-direction:column;gap:12px;}
  #lobby .lbTabsRow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
  #lobby .lbTabs{display:flex;gap:4px;overflow-x:auto;padding:3px;flex:1;min-width:0;
    background:var(--panel2);border-radius:var(--radius-pill);box-shadow:var(--spec);scrollbar-width:none;}
  #lobby .lbTabs::-webkit-scrollbar{display:none;}
  #lobby .lbTab{display:inline-flex;align-items:center;gap:6px;padding:6px 13px;border-radius:var(--radius-pill);
    font-size:12.5px;font-weight:560;color:var(--muted);white-space:nowrap;transition:background .12s,color .12s;}
  #lobby .lbTab:hover{color:var(--text);background:var(--panel2);}
  #lobby .lbTab[aria-selected="true"]{background:var(--lb-sel);color:var(--text);font-weight:640;}
  #lobby .lbTab .cnt{font-size:10.5px;color:var(--muted2);font-variant-numeric:tabular-nums;}
  #lobby .lbTab[aria-selected="true"] .cnt{color:var(--accent-text);}
  #lobby .lbTab.add{color:var(--muted2);font-weight:400;}
  #lobby .lbTools{display:flex;align-items:center;gap:8px;flex:none;}
  #lobby .lbBtn2{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;
    border-radius:var(--radius-pill);background:var(--panel2);box-shadow:var(--spec);
    font-size:12px;font-weight:560;transition:background .12s;}
  #lobby .lbBtn2:hover{background:var(--panel3);}
  #lobby .lbBtn2 svg{width:13px;height:13px;stroke:currentColor;stroke-width:1.8;fill:none;stroke-linecap:round;}
  #lobby .lbViewTog{display:flex;gap:2px;padding:2px;border-radius:var(--radius-pill);
    background:var(--panel2);box-shadow:var(--spec);}
  #lobby .lbViewTog button{width:30px;height:28px;border-radius:var(--radius-pill);display:grid;place-items:center;
    color:var(--muted2);transition:background .12s,color .12s;}
  #lobby .lbViewTog button svg{width:14px;height:14px;stroke:currentColor;stroke-width:1.8;fill:none;stroke-linecap:round;}
  #lobby .lbViewTog button[aria-pressed="true"]{background:var(--lb-sel);color:var(--text);}

  /* 목록형 */
  #lobby .lbListWrap{border-radius:var(--radius-lg);background:var(--panel2);box-shadow:var(--spec);overflow:hidden;}
  #lobby .lbGrid{display:grid;grid-template-columns:34px minmax(200px,2.4fr) 120px 132px minmax(110px,1fr) 36px;
    align-items:center;gap:10px;padding:0 12px;}
  #lobby .lbHead{border-bottom:0.5px solid var(--line);height:36px;}
  #lobby .lbCol{font-size:10.5px;font-weight:640;color:var(--muted2);letter-spacing:0.03em;
    display:inline-flex;align-items:center;gap:4px;text-align:left;}
  #lobby .lbCol:hover{color:var(--text);}
  #lobby .lbCol .arrow{opacity:0;font-size:8px;}
  #lobby .lbCol[data-dir] .arrow{opacity:1;color:var(--accent-text);}
  #lobby .lbRow{height:52px;border-bottom:0.5px solid var(--line);transition:background .1s;text-align:left;width:100%;}
  #lobby .lbRow:last-child{border-bottom:none;}
  #lobby .lbRow:hover{background:var(--panel3);}
  #lobby .lbRow[data-checked="true"]{background:rgba(10,132,255,0.12);}
  #lobby .lbCbox{width:16px;height:16px;border-radius:5px;border:1.5px solid var(--line-strong);display:grid;
    place-items:center;opacity:0;transition:opacity .1s;background:var(--panel);cursor:pointer;}
  #lobby .lbRow:hover .lbCbox,#lobby .lbRow[data-checked="true"] .lbCbox,#lobby .lbHead .lbCbox{opacity:1;}
  #lobby .lbCbox[data-on="true"]{background:var(--accent);border-color:var(--accent);}
  #lobby .lbCbox svg{width:10px;height:10px;stroke:#fff;stroke-width:2.6;fill:none;opacity:0;stroke-linecap:round;}
  #lobby .lbCbox[data-on="true"] svg{opacity:1;}
  #lobby .lbFname{display:flex;align-items:center;gap:9px;min-width:0;}
  #lobby .lbFname .t{font-size:13px;font-weight:560;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  #lobby .lbMini{width:34px;height:24px;border-radius:5px;object-fit:cover;background:var(--panel2);flex:none;}
  #lobby .lbCell{font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap;
    overflow:hidden;text-overflow:ellipsis;}
  #lobby .lbRowMenu{width:26px;height:26px;border-radius:7px;display:grid;place-items:center;color:var(--muted2);
    opacity:0;transition:opacity .1s,background .12s;justify-self:end;}
  #lobby .lbRow:hover .lbRowMenu{opacity:1;}
  #lobby .lbRowMenu:hover{background:var(--panel3);color:var(--text);}

  /* 카드형 */
  #lobby .lbCards{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;}
  #lobby .lbFcard{display:flex;flex-direction:column;border-radius:var(--radius-lg);overflow:hidden;text-align:left;
    background:var(--panel2);box-shadow:var(--spec);transition:transform .12s,background .12s;position:relative;}
  #lobby .lbFcard:hover{transform:translateY(-2px);background:var(--panel3);}
  #lobby .lbFcard .lbThumb,#lobby .lbFcard .lbNoThumb{height:104px;}
  #lobby .lbEmpty{padding:52px 20px;text-align:center;color:var(--muted2);font-size:12.5px;line-height:1.7;}
  #lobby .lbEmpty .lbGo{margin-top:12px;display:inline-block;background:var(--accent);color:#fff;
    border-radius:var(--radius-pill);padding:9px 18px;font-size:13px;font-weight:600;}

  /* 선택 액션 바 */
  #lobby .lbBulk{position:fixed;left:50%;bottom:22px;transform:translateX(-50%) translateY(200%);z-index:45;
    visibility:hidden;   /* 140% 이동으로는 상단 몇 px 가 화면 하단에 걸려 '이상한 바'로 보였다 (2026-07-26) */
    display:flex;align-items:center;gap:6px;padding:7px 8px 7px 15px;border-radius:var(--radius-pill);
    background:var(--panel);border:1px solid var(--line);box-shadow:var(--shadow-pop);
    transition:transform .2s cubic-bezier(.2,.9,.3,1),visibility .2s;}
  #lobby .lbBulk[data-open="true"]{transform:translateX(-50%) translateY(0);visibility:visible;}
  #lobby .lbBulk .n{font-size:12.5px;font-weight:620;white-space:nowrap;}
  #lobby .lbBulk .div{width:0.5px;height:18px;background:var(--line-strong);margin:0 4px;}
  #lobby .lbBulk button{padding:6px 11px;border-radius:var(--radius-pill);font-size:12px;font-weight:560;
    transition:background .12s;white-space:nowrap;}
  #lobby .lbBulk button:hover{background:var(--panel3);}
  #lobby .lbBulk button.danger{color:var(--danger);}

  /* 햄버거 서랍 */
  #lobby .lbScrim{position:fixed;inset:0;z-index:50;background:rgba(4,7,16,0.5);opacity:0;pointer-events:none;
    transition:opacity .2s;}
  #lobby .lbScrim[data-open="true"]{opacity:1;pointer-events:auto;}
  #lobby .lbDrawer{position:fixed;left:0;top:0;bottom:0;z-index:51;width:min(88vw,320px);overflow-y:auto;
    background:var(--panel);border-right:1px solid var(--line);box-shadow:var(--shadow-pop);
    transform:translateX(-102%);transition:transform .24s cubic-bezier(.2,.9,.3,1);
    display:flex;flex-direction:column;gap:2px;padding:14px 12px 24px;}
  #lobby .lbDrawer[data-open="true"]{transform:translateX(0);}
  #lobby .lbDhead{display:flex;align-items:center;gap:10px;padding:2px 4px 12px;}
  #lobby .lbDsec{font-size:9.5px;font-weight:700;letter-spacing:0.08em;color:var(--muted2);padding:16px 10px 6px;}
  #lobby .lbDitem{display:flex;align-items:center;gap:11px;padding:9px 10px;border-radius:var(--radius);
    font-size:13px;font-weight:530;text-align:left;width:100%;transition:background .1s;}
  #lobby .lbDitem:hover{background:var(--panel3);}
  #lobby .lbDitem svg{width:17px;height:17px;stroke:var(--muted);stroke-width:1.7;fill:none;flex:none;stroke-linecap:round;}
  #lobby .lbDitem .dsub{font-size:10.5px;color:var(--muted2);font-weight:400;margin-left:auto;}
  #lobby .lbDitem .badge{margin-left:auto;font-size:9px;font-weight:700;padding:2px 6px;border-radius:var(--radius-pill);
    background:rgba(255,212,38,0.16);color:var(--warn);}
  #lobby .lbDnote{margin:6px 10px 0;padding:9px 11px;border-radius:var(--radius);background:var(--panel2);
    font-size:10.5px;color:var(--muted);line-height:1.5;}

  /* 팝오버 */
  #lobby .lbPop{position:fixed;z-index:60;min-width:250px;padding:6px;border-radius:var(--radius-lg);
    background:var(--panel);border:1px solid var(--line);
    box-shadow:var(--shadow-pop);opacity:0;transform:translateY(-6px) scale(.98);pointer-events:none;
    transition:opacity .13s,transform .13s;transform-origin:top right;}
  #lobby .lbPop[data-open="true"]{opacity:1;transform:none;pointer-events:auto;}
  #lobby .lbPop hr{border:none;border-top:0.5px solid var(--line);margin:5px 8px;}
  #lobby .lbPitem{display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border-radius:var(--radius-sm);
    font-size:12.5px;font-weight:520;text-align:left;transition:background .1s;}
  #lobby .lbPitem:hover{background:var(--panel3);}
  #lobby .lbPitem svg{width:15px;height:15px;stroke:var(--muted);stroke-width:1.7;fill:none;flex:none;stroke-linecap:round;}
  #lobby .lbPitem.danger{color:var(--danger);}
  #lobby .lbPitem.danger svg{stroke:var(--danger);}
  #lobby .lbPhead{display:flex;gap:11px;align-items:center;padding:11px 10px 12px;}
  #lobby .lbPhead .lbAv{width:38px;height:38px;font-size:14px;}
  #lobby .lbPheadT{min-width:0;}
  #lobby .lbPheadN{font-size:13.5px;font-weight:650;}
  #lobby .lbPheadE{font-size:11px;color:var(--muted2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  #lobby .lbPlan{margin:0 10px 4px;padding:11px 12px;border-radius:var(--radius);background:var(--panel2);
    box-shadow:var(--spec);display:flex;flex-direction:column;gap:8px;}
  #lobby .lbPlanTop{display:flex;align-items:center;justify-content:space-between;gap:8px;}
  #lobby .lbPlanN{font-size:12px;font-weight:650;display:flex;align-items:center;gap:6px;}
  #lobby .lbPlanN .tag{font-size:9px;font-weight:700;padding:2px 6px;border-radius:var(--radius-pill);
    background:rgba(255,212,38,0.18);color:var(--warn);}
  #lobby .lbPlanUp{font-size:11px;font-weight:640;color:var(--accent-text);}
  #lobby .lbMeter{height:5px;border-radius:99px;background:var(--line);overflow:hidden;}
  #lobby .lbMeter i{display:block;height:100%;border-radius:99px;background:var(--accent);}
  #lobby .lbPlanC{font-size:10.5px;color:var(--muted);font-variant-numeric:tabular-nums;display:flex;
    justify-content:space-between;}

  /* 토스트 */
  #lobby .lbToast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%) translateY(200%);z-index:70;
    visibility:hidden;
    padding:10px 18px;border-radius:var(--radius-pill);background:var(--panel);border:1px solid var(--line);
    box-shadow:var(--shadow-pop);font-size:12.5px;font-weight:560;
    transition:transform .22s cubic-bezier(.2,.9,.3,1),visibility .22s;max-width:80vw;}
  #lobby .lbToast[data-open="true"]{transform:translateX(-50%) translateY(0);visibility:visible;}

  /* 공용 모달 (사용법·에셋·플랜) */
  #lbModalWrap{position:fixed;inset:0;z-index:320;display:none;align-items:center;justify-content:center;padding:20px;
    background:rgba(0,0,0,0.5);}   /* 블러 제거 — 작업환경 다이얼로그(helpDlg)와 같은 문법 */
  #lbModalWrap.open{display:flex;}
  #lbModal{width:min(94vw,560px);max-height:86vh;overflow:auto;background:var(--panel);
    border:1px solid var(--line);border-radius:14px;padding:24px 24px 20px;color:var(--text);box-shadow:var(--shadow-pop);
    -webkit-user-select:none;user-select:none;}
  #lbModal h2{margin:0 0 4px;font-size:20px;font-weight:650;letter-spacing:-0.02em;}
  #lbModal .lbMsub{margin:0 0 16px;font-size:13px;color:var(--muted);line-height:1.5;}
  #lbModal .lbClose{position:sticky;top:0;float:right;margin:-6px -6px 0 0;font-size:20px;cursor:pointer;
    background:none;border:none;color:inherit;opacity:.6;}
  #lbModal .lbClose:hover{opacity:1;}
  #lbModal .lbBtn{display:inline-block;margin-top:6px;background:var(--accent);color:#fff;border:none;
    border-radius:var(--radius-pill);padding:10px 18px;font-size:14px;font-weight:600;cursor:pointer;}
  #lbModal .lbBtn.ghost{background:var(--panel3);color:inherit;font-weight:500;}
  #lbModal .lbBtn:hover{filter:brightness(1.08);}
  #lbModal .lbRow{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px;}
  .lbCards2{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;margin-top:6px;}
  .lbCard2{background:var(--panel2);border-radius:14px;padding:14px 12px;text-align:center;font-size:12.5px;}
  .lbCard2 .ci{display:block;margin-bottom:6px;color:var(--accent-text);}
  .lbCard2 .ci svg{width:24px;height:24px;stroke:currentColor;stroke-width:1.5;fill:none;stroke-linecap:round;stroke-linejoin:round;}
  .lbCard2 .cs{display:block;margin-top:3px;font-size:10.5px;color:var(--muted2);}
  .lbSoon{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:var(--radius-pill);font-size:9.5px;
    font-weight:700;background:rgba(255,212,38,0.16);color:var(--warn);vertical-align:middle;}
  .lbPlans{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:6px;}
  .lbPlanBox{background:var(--panel2);border-radius:18px;padding:18px 16px;}
  .lbPlanBox.pro{box-shadow:0 0 0 1px var(--accent) inset;}
  .lbPlanBox h3{margin:0 0 2px;font-size:16px;}
  .lbPlanBox .price{font-size:22px;font-weight:750;margin:4px 0 10px;letter-spacing:-0.02em;}
  .lbPlanBox .price small{font-size:12px;font-weight:500;color:var(--muted);}
  .lbPlanBox ul{margin:0;padding-left:16px;font-size:12.5px;line-height:1.7;color:var(--muted);}
  .lbGuide{font-size:13px;line-height:1.65;}
  .lbGuide h4{margin:16px 0 6px;font-size:14px;color:var(--accent-text);}
  .lbGuide code{background:var(--panel3);border-radius:6px;padding:1px 6px;font-family:var(--mono);font-size:12px;}
  .lbGuide .kv{display:grid;grid-template-columns:120px 1fr;gap:4px 10px;margin:4px 0;}
  .lbGuide .kv b{font-weight:600;}

  @media (max-width:900px){
    #lobby .lbGrid{grid-template-columns:34px minmax(150px,2fr) 110px 36px;}
    #lobby .lbColOwn,#lobby .lbColGrp{display:none;}
    #lobby .lbSearch{max-width:none;}
    #lobby .lbWord .wm-t{display:none;}
    .lbPlans{grid-template-columns:1fr;}
  }
  @media (max-width:620px){
    #lobby .lbChromeIn{padding:9px 14px;gap:9px;}
    #lobby .lbMain{padding:16px 14px 80px;}
    #lobby .lbPtxt{display:none;}
  }`;
  document.head.appendChild(style);

  // ---------- 마크업 ----------
  const ICON = {
    ham: '<svg viewBox="0 0 20 20"><path d="M3 6h14M3 10h14M3 14h14"/></svg>',
    search: '<svg viewBox="0 0 20 20"><circle cx="9" cy="9" r="6"/><path d="M13.5 13.5 17 17"/></svg>',
    chev: '<svg class="lbChev" viewBox="0 0 20 20"><path d="m6 8 4 4 4-4"/></svg>',
    list: '<svg viewBox="0 0 20 20"><path d="M3 5h14M3 10h14M3 15h14"/></svg>',
    cards: '<svg viewBox="0 0 20 20"><rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="11" y="3" width="6" height="6" rx="1.5"/><rect x="3" y="11" width="6" height="6" rx="1.5"/><rect x="11" y="11" width="6" height="6" rx="1.5"/></svg>',
    folder: '<svg viewBox="0 0 20 20"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h3l1.5 2h6.5A1.5 1.5 0 0 1 17 8.5v6A1.5 1.5 0 0 1 15.5 16h-11A1.5 1.5 0 0 1 3 14.5z"/></svg>',
    check: '<svg viewBox="0 0 12 12"><path d="m2.5 6 2.5 2.5L9.5 3.5"/></svg>',
    share: '<svg viewBox="0 0 20 20"><path d="M7.5 11.5 12.5 8.5M7.5 8.5 12.5 11.5"/><circle cx="5.5" cy="10" r="2.5"/><circle cx="14.5" cy="6.5" r="2.5"/><circle cx="14.5" cy="13.5" r="2.5"/></svg>',
    pen: '<svg viewBox="0 0 20 20"><path d="M13.5 3.5 16.5 6.5 7 16H4v-3z"/></svg>',
    trash: '<svg viewBox="0 0 20 20"><path d="M4 6h12M8 6V4.5A1.5 1.5 0 0 1 9.5 3h1A1.5 1.5 0 0 1 12 4.5V6"/><path d="M5.5 6 6 16h8l.5-10"/></svg>',
  };

  const lobby = document.createElement('div');
  lobby.id = 'lobby';
  lobby.innerHTML = `
    <header class="lbChrome"><div class="lbChromeIn">
      <button class="lbIcoBtn" id="lbHam" aria-label="메뉴 열기">${ICON.ham}</button>
      <div class="lbWord"><span class="mk">▦</span><span class="wm-t">Parti</span></div>
      <div class="lbSearch">${ICON.search}
        <input id="lbQ" type="search" placeholder="이전 작업 검색 — 파일명, 그룹, 소유자" aria-label="이전 작업 검색"></div>
      <button class="lbPcard" id="lbPbtn" aria-expanded="false" aria-haspopup="menu">
        <span class="lbAv" id="lbAv">게</span>
        <span class="lbPtxt"><span class="lbPname" id="lbPname">게스트</span>
          <span class="lbPplan" id="lbPplan">로그인 필요</span></span>
        ${ICON.chev}
      </button>
    </div></header>

    <main class="lbMain">
      <section>
        <div class="lbSecHead"><h2>이어서 작업</h2>
          <span class="hint" id="lbRailHint">최근 저장 순 · 썸네일은 마지막 저장 화면</span></div>
        <div class="lbTrack" id="lbTrack"></div>
      </section>
      <section class="lbBrowser">
        <div class="lbTabsRow">
          <div class="lbTabs" id="lbTabs" role="tablist"></div>
          <div class="lbTools">
            <div class="lbViewTog" role="group" aria-label="보기 전환">
              <button id="lbVList" aria-pressed="true" aria-label="목록형">${ICON.list}</button>
              <button id="lbVCard" aria-pressed="false" aria-label="카드형">${ICON.cards}</button>
            </div>
            <button class="lbBtn2" id="lbOpenFile">${ICON.folder} 파일 열기</button>
          </div>
        </div>
        <div id="lbView"></div>
      </section>
    </main>

    <div class="lbBulk" id="lbBulk" data-open="false">
      <span class="n" id="lbBulkN">0개 선택됨</span>
      <span class="div"></span>
      <button data-b="group">그룹으로 이동</button>
      <button class="danger" data-b="del">삭제</button>
      <span class="div"></span>
      <button id="lbBulkX" aria-label="선택 해제">✕</button>
    </div>

    <div class="lbScrim" id="lbScrim" data-open="false"></div>
    <aside class="lbDrawer" id="lbDrawer" data-open="false" aria-label="메뉴">
      <div class="lbDhead"><div class="lbWord"><span class="mk">▦</span>Parti</div></div>
      <div class="lbDsec">둘러보기</div>
      <button class="lbDitem" data-d="guide"><svg viewBox="0 0 20 20"><path d="M4 4h5a2 2 0 0 1 2 2v10a1.5 1.5 0 0 0-1.5-1.5H4z"/><path d="M16 4h-5a2 2 0 0 0-2 2v10a1.5 1.5 0 0 1 1.5-1.5H16z"/></svg>사용법 · 빠른 시작</button>
      <button class="lbDitem" data-d="cmds"><svg viewBox="0 0 20 20"><rect x="3" y="3" width="14" height="14" rx="3"/><path d="M7 7.5h6M7 10h6M7 12.5h3.5"/></svg>명령어 목록<span class="dsub">help</span></button>
      <button class="lbDitem" data-d="assets"><svg viewBox="0 0 20 20"><path d="M3 7h14v8.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 15.5z"/><path d="M6.5 7V5.5a3.5 3.5 0 0 1 7 0V7"/></svg>에셋 스토어<span class="badge">준비 중</span></button>
      <button class="lbDitem" data-d="plan"><svg viewBox="0 0 20 20"><path d="m10 3 2.1 4.3 4.7.7-3.4 3.3.8 4.7L10 13.8 5.8 16l.8-4.7L3.2 8l4.7-.7z"/></svg>플랜 구독 안내</button>
      <div class="lbDsec">확장 프로그램</div>
      <button class="lbDitem" data-d="nodes"><svg viewBox="0 0 20 20"><circle cx="5" cy="6" r="2"/><circle cx="5" cy="14" r="2"/><circle cx="15" cy="10" r="2"/><path d="M7 6.7 13 9.4M7 13.3 13 10.6"/></svg>노드 에디터<span class="dsub">고급</span></button>
      <button class="lbDitem" data-d="blocks"><svg viewBox="0 0 20 20"><path d="M10 3 3 6.5 10 10l7-3.5z"/><path d="M3 13.5 10 17l7-3.5M3 10l7 3.5L17 10"/></svg>블록 라이브러리</button>
      <div class="lbDnote">새 기능은 메인 화면에 바로 넣지 않고 여기에 먼저 둡니다.</div>
      <div class="lbDsec">기타</div>
      <button class="lbDitem" data-d="theme"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="4"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.5 4.5 6 6M14 14l1.5 1.5M15.5 4.5 14 6M6 14l-1.5 1.5"/></svg>테마<span class="dsub" id="lbThemeNow">다크</span></button>
      <button class="lbDitem" data-d="feedback"><svg viewBox="0 0 20 20"><path d="M17 12.5a2 2 0 0 1-2 2H7l-4 3V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>피드백 보내기</button>
    </aside>

    <div class="lbPop" id="lbPpop" data-open="false" role="menu"></div>
    <div class="lbPop" id="lbRpop" data-open="false" role="menu" style="min-width:190px"></div>
    <div class="lbToast" id="lbToast" data-open="false"></div>`;
  document.body.appendChild(lobby);

  const $ = s => lobby.querySelector(s);
  const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---------- 공용 모달 ----------
  const modalWrap = document.createElement('div');
  modalWrap.id = 'lbModalWrap';
  modalWrap.innerHTML = `<div id="lbModal"></div>`;
  document.body.appendChild(modalWrap);
  const modalEl = modalWrap.querySelector('#lbModal');
  modalWrap.addEventListener('click', (e) => { if (e.target === modalWrap) closeModal(); });
  function openModal(html) {
    modalEl.innerHTML = `<button class="lbClose" aria-label="닫기">✕</button>` + html;
    modalEl.querySelector('.lbClose').onclick = closeModal;
    modalWrap.classList.add('open');
  }
  function closeModal() { modalWrap.classList.remove('open'); }

  // ---------- 토스트 ----------
  let toastT;
  function toast(msg) {
    const t = $('#lbToast'); t.textContent = msg; t.dataset.open = 'true';
    clearTimeout(toastT); toastT = setTimeout(() => { t.dataset.open = 'false'; }, 2200);
  }

  // ---------- 프로젝트 그룹 (이 브라우저에만 저장) ----------
  const GKEY = 'webcad_groups';
  let G = { list: [], map: {} };
  function loadGroups() {
    try {
      const g = JSON.parse(localStorage.getItem(GKEY) || '{}');
      G = { list: Array.isArray(g.list) ? g.list : [], map: (g.map && typeof g.map === 'object') ? g.map : {} };
    } catch (e) { G = { list: [], map: {} }; }
  }
  function saveGroups() { try { localStorage.setItem(GKEY, JSON.stringify(G)); } catch (e) {} }
  const groupOf = id => G.map[id] || '미분류';

  // ---------- 상태 ----------
  const st = { group: '전체', view: 'list', q: '', sort: 'm', dir: 1, sel: new Set() };

  function ago(iso) {
    const t = new Date(iso).getTime();
    if (!isFinite(t)) return '—';
    const min = Math.max(0, Math.floor((Date.now() - t) / 60000));
    if (min < 1) return '방금';
    if (min < 60) return min + '분 전';
    if (min < 1440) return Math.floor(min / 60) + '시간 전';
    if (min < 10080) return Math.floor(min / 1440) + '일 전';
    if (min < 43200) return Math.floor(min / 10080) + '주 전';
    return Math.floor(min / 43200) + '개월 전';
  }
  const uname = () => (session && session.user && (session.user.user_metadata?.username || (session.user.email || '').split('@')[0])) || '게스트';
  const uemail = () => (session && session.user && session.user.email) || '';

  function thumbEl(f, cls) {
    if (f.thumb) { const i = el('img', cls || 'lbThumb'); i.src = f.thumb; i.alt = ''; return i; }
    const d = el('div', 'lbNoThumb'); d.textContent = '▦'; return d;
  }
  function chip(txt, cls) { const c = el('span', 'lbChip' + (cls ? ' ' + cls : '')); c.textContent = txt; return c; }

  // ---------- 데이터 ----------
  async function reload() {
    loadErr = '';
    const C = CLOUD();
    if (!session || !C || !C.ready()) { files = []; renderAll(); return; }
    try { files = await C.list(); }
    catch (e) { files = []; loadErr = (C.err ? C.err(e) : (e && e.message)) || '목록을 불러오지 못했습니다.'; }
    renderAll();
  }

  function rows() {
    const q = st.q.trim().toLowerCase();
    let r = files.filter(f => st.group === '전체' || groupOf(f.id) === st.group);
    if (q) r = r.filter(f => (f.name + ' ' + groupOf(f.id) + ' ' + (f.owner_name || '')).toLowerCase().includes(q));
    const k = st.sort;
    return r.sort((a, b) => {
      const v = k === 'm' ? (new Date(b.updated_at) - new Date(a.updated_at))
        : k === 'n' ? a.name.localeCompare(b.name, 'ko')
        : k === 'o' ? String(a.is_mine ? '' : a.owner_name || '').localeCompare(String(b.is_mine ? '' : b.owner_name || ''), 'ko')
        : groupOf(a.id).localeCompare(groupOf(b.id), 'ko');
      return v * st.dir;
    });
  }

  // ---------- 액션 ----------
  function enterWorkspace() {
    hideLobby();
    if (!session && authConfigured && AUTH()) AUTH().showLogin();
  }
  async function openFile(f) {
    const C = CLOUD();
    if (!C || !C.ready()) return toast('로그인 후 이용할 수 있습니다');
    toast(`"${f.name}" 여는 중…`);
    try { await C.open(f.id, f.can_edit, f.is_mine); hideLobby(); }
    catch (e) { toast('열기 실패 — ' + ((C.err ? C.err(e) : e.message) || '')); }
  }
  function newDrawing() {
    hideLobby();
    const b = document.getElementById('miNew');   // cad.js가 doNew()를 여기에 물려 둠
    if (b) b.click();
    if (!session && authConfigured && AUTH()) AUTH().showLogin();
  }
  async function renameFile(f) {
    const nn = prompt('새 이름:', f.name); if (!nn || nn === f.name) return;
    try { await CLOUD().rename(f.id, nn); toast('이름을 바꿨습니다'); reload(); }
    catch (e) { toast('이름 변경 실패'); }
  }
  async function removeFiles(list) {
    if (!list.length) return;
    const msg = list.length === 1
      ? `"${list[0].name}" 도면을 클라우드에서 삭제할까요? (버전 기록도 함께 삭제됩니다)`
      : `${list.length}개 도면을 삭제할까요? (버전 기록도 함께 삭제됩니다)`;
    if (!confirm(msg)) return;
    try {
      for (const f of list) { await CLOUD().remove(f.id); delete G.map[f.id]; }
      saveGroups(); st.sel.clear(); toast(`${list.length}개 삭제됨`); reload();
    } catch (e) { toast('삭제 실패 — 내 도면만 삭제할 수 있습니다'); reload(); }
  }
  function moveToGroup(list) {
    if (!list.length) return;
    const names = G.list.join(', ');
    const g = prompt(`옮길 그룹 이름${names ? ` (기존: ${names})` : ''}:`, list.length === 1 ? groupOf(list[0].id) : '');
    if (g === null) return;
    const name = g.trim();
    list.forEach(f => { if (name) G.map[f.id] = name; else delete G.map[f.id]; });
    if (name && !G.list.includes(name)) G.list.push(name);
    saveGroups(); st.sel.clear();
    toast(name ? `${list.length}개를 "${name}"(으)로 옮겼습니다` : `${list.length}개를 미분류로 옮겼습니다`);
    renderAll();
  }

  // ---------- 렌더: 최근 작업 레일 ----------
  function buildRail() {
    const tr = $('#lbTrack'); tr.innerHTML = '';
    const nt = el('button', 'lbNew');
    nt.innerHTML = '<span class="plus">+</span><span class="nt">새 도면</span>' +
      '<span class="nd">빈 작업으로 시작합니다</span>';
    nt.onclick = newDrawing;
    tr.appendChild(nt);

    const recent = [...files].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, 6);
    $('#lbRailHint').textContent = recent.length
      ? '최근 저장 순 · 썸네일은 마지막 저장 화면'
      : (session ? '아직 클라우드에 저장한 도면이 없습니다' : '로그인하면 저장한 도면이 여기에 나타납니다');

    recent.forEach(f => {
      const c = el('button', 'lbRcard');
      c.appendChild(thumbEl(f));
      const b = el('div', 'lbCbody');
      const n = el('div', 'lbCname'); n.textContent = f.name; b.appendChild(n);
      const m = el('div', 'lbCmeta');
      m.append(ago(f.updated_at));
      const s = el('span', 'sep'); s.textContent = '·'; m.appendChild(s);
      m.append(groupOf(f.id));
      b.appendChild(m);
      if (!f.is_mine) {
        const r2 = el('div', 'lbCmeta');
        r2.appendChild(chip('👥 ' + (f.owner_name || '공유받음') + (f.can_edit ? '' : ' · 읽기전용'), 'shared'));
        b.appendChild(r2);
      }
      c.appendChild(b);
      c.onclick = () => openFile(f);
      tr.appendChild(c);
    });
  }

  // ---------- 렌더: 그룹 탭 ----------
  function buildTabs() {
    const t = $('#lbTabs'); t.innerHTML = '';
    const used = new Set(files.map(f => groupOf(f.id)));
    const names = [...new Set([...G.list, ...used])].filter(n => n !== '미분류');
    if (used.has('미분류')) names.push('미분류');
    const mk = (name, cnt) => {
      const b = el('button', 'lbTab'); b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', st.group === name ? 'true' : 'false');
      b.append(name);
      if (cnt != null) { const c = el('span', 'cnt'); c.textContent = cnt; b.appendChild(c); }
      b.onclick = () => { st.group = name; st.sel.clear(); renderAll(); };
      return b;
    };
    t.appendChild(mk('전체', files.length));
    names.forEach(n => t.appendChild(mk(n, files.filter(f => groupOf(f.id) === n).length)));
    const add = el('button', 'lbTab add'); add.textContent = '+ 그룹 추가';
    add.onclick = () => {
      const g = prompt('새 그룹 이름:'); if (!g || !g.trim()) return;
      const name = g.trim();
      if (!G.list.includes(name)) { G.list.push(name); saveGroups(); }
      st.group = name; renderAll();
      toast(`"${name}" 그룹을 만들었습니다 — 도면의 ⋯ 메뉴에서 옮기세요`);
    };
    t.appendChild(add);
  }

  // ---------- 렌더: 목록/카드 ----------
  function checkbox(on) {
    const c = el('span', 'lbCbox'); c.dataset.on = on ? 'true' : 'false';
    c.innerHTML = ICON.check; return c;
  }
  function emptyBox() {
    const w = el('div', 'lbListWrap'), e = el('div', 'lbEmpty');
    if (loadErr) e.textContent = loadErr;
    else if (!session) {
      e.innerHTML = '로그인하면 클라우드에 저장한 도면이 여기에 모두 표시됩니다.<br>로그인 없이도 새 도면으로 바로 작업할 수 있습니다.';
      const b = el('button', 'lbGo'); b.textContent = '로그인'; b.onclick = doLogin;
      e.appendChild(document.createElement('br')); e.appendChild(b);
    } else if (st.q) e.textContent = `"${st.q}" 와(과) 일치하는 도면이 없습니다`;
    else if (files.length) e.textContent = '이 그룹에는 아직 도면이 없습니다';
    else e.innerHTML = '아직 클라우드에 저장한 도면이 없습니다.<br>새 도면으로 작업한 뒤 파일 → ☁ 클라우드에 저장을 눌러보세요.';
    w.appendChild(e); return w;
  }

  function renderList(list) {
    const wrap = el('div', 'lbListWrap');
    const head = el('div', 'lbGrid lbHead');
    const mine = list.filter(f => f.is_mine);
    const allOn = mine.length > 0 && mine.every(f => st.sel.has(f.id));
    const hc = checkbox(allOn);
    hc.onclick = () => { allOn ? st.sel.clear() : mine.forEach(f => st.sel.add(f.id)); renderAll(); };
    head.appendChild(hc);
    [['n', '파일명', ''], ['m', '최근 수정', ''], ['o', '소유자', 'lbColOwn'], ['g', '속한 그룹', 'lbColGrp']]
      .forEach(([k, label, cls]) => {
        const b = el('button', 'lbCol' + (cls ? ' ' + cls : ''));
        b.append(label);
        const ar = el('span', 'arrow'); ar.textContent = st.dir > 0 ? '▼' : '▲';
        b.appendChild(ar);
        if (st.sort === k) b.dataset.dir = st.dir;
        b.onclick = () => { st.dir = st.sort === k ? -st.dir : 1; st.sort = k; renderAll(); };
        head.appendChild(b);
      });
    head.appendChild(el('span'));
    wrap.appendChild(head);

    list.forEach(f => {
      const r = el('div', 'lbGrid lbRow');
      r.dataset.checked = st.sel.has(f.id) ? 'true' : 'false';
      const cb = checkbox(st.sel.has(f.id));
      if (f.is_mine) {
        cb.onclick = e => { e.stopPropagation(); st.sel.has(f.id) ? st.sel.delete(f.id) : st.sel.add(f.id); renderAll(); };
      } else { cb.style.visibility = 'hidden'; }  // 남의 도면은 일괄 삭제/이동 대상이 아니다
      r.appendChild(cb);

      const nm = el('div', 'lbFname');
      nm.appendChild(thumbEl(f, 'lbMini'));
      const tt = el('span', 't'); tt.textContent = f.name; nm.appendChild(tt);
      if (!f.is_mine) nm.appendChild(chip(f.can_edit ? '공유받음' : '읽기전용', 'shared'));
      r.appendChild(nm);

      const md = el('div', 'lbCell'); md.textContent = ago(f.updated_at); r.appendChild(md);
      const ow = el('div', 'lbCell lbColOwn'); ow.textContent = f.is_mine ? '나' : (f.owner_name || '—'); r.appendChild(ow);
      const gp = el('div', 'lbCell lbColGrp'); gp.appendChild(chip(groupOf(f.id))); r.appendChild(gp);

      const mb = el('button', 'lbRowMenu'); mb.setAttribute('aria-label', f.name + ' 메뉴'); mb.textContent = '⋯';
      mb.onclick = e => { e.stopPropagation(); openRowMenu(mb, f); };
      r.appendChild(mb);

      r.onclick = () => openFile(f);
      wrap.appendChild(r);
    });
    return wrap;
  }

  function renderCards(list) {
    const g = el('div', 'lbCards');
    list.forEach(f => {
      const c = el('button', 'lbFcard');
      c.appendChild(thumbEl(f));
      const b = el('div', 'lbCbody');
      const n = el('div', 'lbCname'); n.textContent = f.name; b.appendChild(n);
      const m = el('div', 'lbCmeta');
      m.append(ago(f.updated_at));
      const s = el('span', 'sep'); s.textContent = '·'; m.appendChild(s);
      m.append(f.is_mine ? '나' : (f.owner_name || '—'));
      b.appendChild(m);
      const r2 = el('div', 'lbCmeta');
      r2.appendChild(chip(groupOf(f.id)));
      if (!f.is_mine) r2.appendChild(chip(f.can_edit ? '공유받음' : '읽기전용', 'shared'));
      b.appendChild(r2);
      c.appendChild(b);
      c.onclick = () => openFile(f);
      g.appendChild(c);
    });
    return g;
  }

  function renderAll() {
    buildRail(); buildTabs();
    const list = rows();
    const v = $('#lbView'); v.innerHTML = '';
    v.appendChild(!list.length ? emptyBox() : (st.view === 'list' ? renderList(list) : renderCards(list)));
    $('#lbVList').setAttribute('aria-pressed', st.view === 'list' ? 'true' : 'false');
    $('#lbVCard').setAttribute('aria-pressed', st.view === 'card' ? 'true' : 'false');
    const b = $('#lbBulk');
    b.dataset.open = st.sel.size ? 'true' : 'false';
    $('#lbBulkN').textContent = st.sel.size + '개 선택됨';
    reflect();
  }

  // ---------- 팝오버 ----------
  const pPop = $('#lbPpop'), rPop = $('#lbRpop'), pBtn = $('#lbPbtn');
  function place(pop, anchor) {
    pop.dataset.open = 'true';
    const r = anchor.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
    pop.style.left = Math.max(8, Math.min(r.right - pw, innerWidth - pw - 8)) + 'px';
    pop.style.top = Math.min(r.bottom + 8, Math.max(8, innerHeight - ph - 8)) + 'px';
  }
  function closePops() { pPop.dataset.open = rPop.dataset.open = 'false'; pBtn.setAttribute('aria-expanded', 'false'); }

  function buildProfilePop() {
    const logged = !!session;
    const plan = (CLOUD() && CLOUD().plan && CLOUD().plan()) || 'free';
    const cnt = files.filter(f => f.is_mine).length;
    const limit = plan === 'free' ? 5 : null;
    const pct = limit ? Math.min(100, Math.round(cnt / limit * 100)) : 0;
    pPop.innerHTML = logged ? `
      <div class="lbPhead"><span class="lbAv">${esc(uname()[0] || '?')}</span>
        <span class="lbPheadT"><div class="lbPheadN">${esc(uname())}</div>
          <div class="lbPheadE">${esc(uemail())}</div></span></div>
      <div class="lbPlan">
        <div class="lbPlanTop"><span class="lbPlanN">${plan === 'free' ? '무료 플랜' : '프로 플랜'}
          ${limit ? `<span class="tag">${cnt}/${limit}</span>` : ''}</span>
          ${plan === 'free' ? '<button class="lbPlanUp" data-p="plan">프로로 업그레이드</button>' : ''}</div>
        ${limit ? `<div class="lbMeter"><i style="width:${pct}%"></i></div>
        <div class="lbPlanC"><span>클라우드 도면 ${cnt}개 사용</span><span>${Math.max(0, limit - cnt)}개 남음</span></div>`
        : '<div class="lbPlanC"><span>클라우드 도면 무제한</span></div>'}
      </div><hr>
      <button class="lbPitem" data-p="work"><svg viewBox="0 0 20 20"><rect x="3" y="3" width="14" height="14" rx="3"/><path d="M3 8h14"/></svg>작업 공간으로</button>
      <button class="lbPitem" data-p="plan"><svg viewBox="0 0 20 20"><rect x="2.5" y="4.5" width="15" height="11" rx="2"/><path d="M2.5 8.5h15"/></svg>플랜 · 구독</button>
      <button class="lbPitem" data-p="feedback"><svg viewBox="0 0 20 20"><path d="M17 12.5a2 2 0 0 1-2 2H7l-4 3V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>피드백 보내기</button>
      <button class="lbPitem" data-p="theme"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="4"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2"/></svg>테마 전환</button>
      <hr>
      <button class="lbPitem danger" data-p="logout"><svg viewBox="0 0 20 20"><path d="M8 17H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3"/><path d="M13 13.5 16.5 10 13 6.5"/><path d="M16.5 10H8"/></svg>로그아웃</button>`
    : `<div class="lbPhead"><span class="lbAv">게</span>
        <span class="lbPheadT"><div class="lbPheadN">게스트</div>
          <div class="lbPheadE">로그인하면 클라우드 저장·공유를 쓸 수 있습니다</div></span></div><hr>
      <button class="lbPitem" data-p="login"><svg viewBox="0 0 20 20"><circle cx="10" cy="7" r="3"/><path d="M4 16.5a6 6 0 0 1 12 0"/></svg>로그인 · 회원가입</button>
      <button class="lbPitem" data-p="work"><svg viewBox="0 0 20 20"><rect x="3" y="3" width="14" height="14" rx="3"/><path d="M3 8h14"/></svg>게스트로 작업 시작</button>
      <button class="lbPitem" data-p="theme"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="4"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2"/></svg>테마 전환</button>`;
    pPop.querySelectorAll('[data-p]').forEach(b => b.onclick = () => {
      closePops();
      const a = b.dataset.p;
      if (a === 'work') enterWorkspace();
      else if (a === 'login') doLogin();
      else if (a === 'plan') openPlan();
      else if (a === 'theme') toggleTheme();
      else if (a === 'feedback') { enterWorkspace(); hintMenu('피드백은 [옵션] 메뉴 → 피드백 보내기로 남겨주세요.'); }
      else if (a === 'logout') { if (confirm('로그아웃할까요? (작업물은 이 브라우저에 자동 저장되어 있습니다)')) AUTH() && AUTH().signOut(); }
    });
  }

  function openRowMenu(btn, f) {
    closePops();
    rPop.innerHTML =
      `<button class="lbPitem" data-r="open">${ICON.folder}열기</button>` +
      (f.is_mine ? `<button class="lbPitem" data-r="share">${ICON.share}도면 공유</button>
        <button class="lbPitem" data-r="ren">${ICON.pen}이름 수정</button>` : '') +
      `<button class="lbPitem" data-r="grp">${ICON.folder}그룹으로 이동</button>` +
      (f.is_mine ? `<hr><button class="lbPitem danger" data-r="del">${ICON.trash}파일 삭제</button>` : '');
    rPop.querySelectorAll('[data-r]').forEach(b => b.onclick = () => {
      closePops();
      const a = b.dataset.r;
      if (a === 'open') openFile(f);
      else if (a === 'share') { const C = CLOUD(); if (C) { hideLobby(); C.share(f.id); } }
      else if (a === 'ren') renameFile(f);
      else if (a === 'grp') moveToGroup([f]);
      else if (a === 'del') removeFiles([f]);
    });
    place(rPop, btn);
  }

  // ---------- 서랍 ----------
  const drawer = $('#lbDrawer'), scrim = $('#lbScrim');
  const openDrawer = o => { drawer.dataset.open = scrim.dataset.open = o ? 'true' : 'false'; };
  $('#lbHam').onclick = () => openDrawer(drawer.dataset.open !== 'true');
  scrim.onclick = () => openDrawer(false);

  function toggleTheme() {
    const light = document.documentElement.classList.toggle('light');
    try { localStorage.setItem('webcad_theme', light ? 'light' : 'dark'); } catch (e) {}
    $('#lbThemeNow').textContent = light ? '라이트' : '다크';
  }
  function hintMenu(msg) { try { const el2 = document.getElementById('cmdPrompt'); if (el2) el2.textContent = msg; } catch (e) {} }

  drawer.querySelectorAll('[data-d]').forEach(b => b.onclick = () => {
    const a = b.dataset.d;
    if (a === 'theme') { toggleTheme(); return; }        // 서랍을 닫지 않고 바로 확인
    openDrawer(false);
    if (a === 'guide') openGuide();
    else if (a === 'assets') openAssets();
    else if (a === 'plan') openPlan();
    else if (a === 'cmds') { enterWorkspace(); hintMenu('명령행에 help 를 입력하면 전체 명령 목록이 나옵니다.'); }
    else if (a === 'nodes') { enterWorkspace(); const N = window.WEBCAD_NODES; if (N && N.open) N.open(); else hintMenu('노드 에디터를 열 수 없습니다.'); }
    else if (a === 'blocks') { enterWorkspace(); hintMenu('블록 라이브러리는 상단 [옵션] 메뉴에서 열 수 있습니다.'); }
    else if (a === 'feedback') { enterWorkspace(); hintMenu('피드백은 [옵션] 메뉴 → 피드백 보내기로 남겨주세요.'); }
  });

  // ---------- 모달 내용 ----------
  function doLogin() {
    if (session) { closePops(); pBtn.click(); return; }
    hideLobby();
    if (AUTH()) AUTH().showLogin();
    else openModal('<h2>로그인 미설정</h2><p class="lbMsub">이 배포에는 로그인 서버가 설정되어 있지 않아 게스트로만 사용할 수 있습니다.</p>');
  }
  function openAssets() {
    openModal(`<h2>에셋스토어 <span class="lbSoon">오픈 예정</span></h2>
      <p class="lbMsub">자주 쓰는 블록·심볼·도면 템플릿을 받아 바로 배치할 수 있는 라이브러리입니다. 카테고리를 준비 중이며, 지금은 작업 공간의 <b>블록 라이브러리</b>에서 내 블록을 저장·재사용할 수 있습니다.</p>
      <div class="lbCards2">
        <div class="lbCard2"><span class="ci"><svg viewBox="0 0 24 24"><path d="M4 20h16"/><path d="M5 20V9l7-5 7 5v11"/><path d="M9 20v-6h6v6"/></svg></span>건축<span class="cs">문·창·계단</span></div>
        <div class="lbCard2"><span class="ci"><svg viewBox="0 0 24 24"><path d="M5 11V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3"/><path d="M3 13a2 2 0 0 1 4 0v1h10v-1a2 2 0 0 1 4 0v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M6 18v2M18 18v2"/></svg></span>가구/집기<span class="cs">평면 심볼</span></div>
        <div class="lbCard2"><span class="ci"><svg viewBox="0 0 24 24"><path d="M12 21v-6"/><path d="M12 15a5.5 5.5 0 0 1-5.5-5.5A5.5 5.5 0 0 1 12 4a5.5 5.5 0 0 1 5.5 5.5A5.5 5.5 0 0 1 12 15z"/><path d="M8.5 21h7"/></svg></span>조경<span class="cs">수목·포장</span></div>
        <div class="lbCard2"><span class="ci"><svg viewBox="0 0 24 24"><path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-5 5.9V21h-2v-4.1A6 6 0 0 1 6 11z"/></svg></span>전기/설비<span class="cs">콘센트·조명</span></div>
        <div class="lbCard2"><span class="ci"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 16h16"/><path d="M13 16v4"/></svg></span>템플릿<span class="cs">도곽·표제란</span></div>
        <div class="lbCard2"><span class="ci"><svg viewBox="0 0 24 24"><path d="M3 20h18"/><rect x="6" y="8" width="4" height="12"/><rect x="14" y="8" width="4" height="12"/><path d="M4 8h16V5H4z"/></svg></span>구조<span class="cs">기둥·보</span></div>
      </div>
      <div class="lbRow"><button class="lbBtn" data-go="work">작업 공간에서 블록 라이브러리 열기</button></div>`);
    modalEl.querySelector('[data-go="work"]').onclick = () => { closeModal(); enterWorkspace(); hintMenu('블록 라이브러리는 상단 [옵션] 메뉴에서 열 수 있습니다.'); };
  }
  function openPlan() {
    const note = session ? '' : '<p class="lbMsub" style="margin-top:10px;">프로 플랜을 이용하려면 먼저 로그인하세요.</p>';
    openModal(`<h2>플랜 구독</h2>
      <p class="lbMsub">Parti는 로컬 작업은 언제나 무료입니다. 클라우드 저장·협업을 넓히려면 프로 플랜을 이용하세요.</p>
      <div class="lbPlans">
        <div class="lbPlanBox"><h3>무료</h3><div class="price">₩0</div>
          <ul><li>모든 2D·3D·BIM 도구</li><li>로컬 저장 무제한</li><li>클라우드 도면 5개</li><li>링크 공유</li></ul></div>
        <div class="lbPlanBox pro"><h3>프로 <span class="lbSoon">문의</span></h3><div class="price">₩— <small>/월</small></div>
          <ul><li>클라우드 도면 무제한</li><li>실시간 공동편집 우선</li><li>버전 기록 확장</li><li>우선 지원</li></ul></div>
      </div>${note}
      <div class="lbRow"><button class="lbBtn" id="lbProAsk">프로 플랜 문의</button></div>`);
    modalEl.querySelector('#lbProAsk').onclick = () => { closeModal(); enterWorkspace(); hintMenu('프로 플랜 문의는 [옵션] 메뉴 → 피드백 보내기로 남겨주세요.'); };
  }
  function openGuide() {
    openModal(`<h2>사용법 — 빠른 시작</h2>
      <p class="lbMsub">명령행에 명령어를 입력하거나 왼쪽 도구를 눌러 작업합니다. 빈 곳에서 스페이스=직전 명령 반복.</p>
      <div class="lbGuide">
        <h4>기본 흐름</h4>
        <div class="kv"><b>그리기</b><span>선(<code>line</code>)·폴리라인(<code>pl</code>)·사각(<code>rec</code>)·원(<code>circle</code>)</span></div>
        <div class="kv"><b>편집</b><span>이동·복사·오프셋(<code>offset</code>)·모깎기(<code>fillet</code>)·자르기(<code>trim</code>)</span></div>
        <div class="kv"><b>스냅</b><span>하단 상태바에서 끝점·중간점·중심 등 켜고 끄기</span></div>
        <div class="kv"><b>저장</b><span>파일 → 저장(DXF) / 다른 이름으로(STL·OBJ 3D) / 링크 공유</span></div>
        <h4>3D · BIM</h4>
        <div class="kv"><b>3D 뷰</b><span>상단 [3D]·[4분할] 토글 — 우드래그 회전, 좌드래그 박스 선택</span></div>
        <div class="kv"><b>돌출</b><span><code>extrudecrv</code> 곡선→면(마우스로 높이 끌기), <code>extrudesrf</code> 면→두께</span></div>
        <div class="kv"><b>솔리드</b><span><code>box</code>·<code>cylinder</code>·<code>sphere</code>·<code>cone</code>, 불리언 <code>union</code>·<code>difference</code></span></div>
        <div class="kv"><b>조명</b><span><code>lighting</code> 조명 보기 — 그림자·간접광·색번짐</span></div>
        <h4>도움말</h4>
        <div class="kv"><b>명령 목록</b><span>명령행에 <code>help</code> 입력 — 전체 명령·설명 표시</span></div>
      </div>
      <div class="lbRow"><button class="lbBtn" data-go="work">바로 작업 시작</button></div>`);
    modalEl.querySelector('[data-go="work"]').onclick = () => { closeModal(); enterWorkspace(); };
  }

  // ---------- 열기/닫기 ----------
  function showLobby() { lobby.classList.remove('hidden'); if (AUTH()) AUTH().hideLogin(); reload(); }
  function hideLobby() { lobby.classList.add('hidden'); closePops(); openDrawer(false); }
  window.WEBCAD_LOBBY = { show: showLobby, hide: hideLobby };

  // ---------- 상단 프로필 카드 반영 ----------
  function reflect() {
    const logged = !!session;
    const plan = (CLOUD() && CLOUD().plan && CLOUD().plan()) || 'free';
    const cnt = files.filter(f => f.is_mine).length;
    $('#lbAv').textContent = logged ? (uname()[0] || '?') : '게';
    $('#lbPname').textContent = logged ? uname() : '게스트';
    $('#lbPplan').textContent = logged
      ? (plan === 'free' ? `무료 · ${cnt}/5` : '프로')
      : '로그인 필요';
    $('#lbThemeNow').textContent = document.documentElement.classList.contains('light') ? '라이트' : '다크';
  }

  // ---------- 배선 ----------
  pBtn.onclick = e => {
    e.stopPropagation();
    const open = pPop.dataset.open === 'true';
    closePops();
    if (!open) { buildProfilePop(); place(pPop, pBtn); pBtn.setAttribute('aria-expanded', 'true'); }
  };
  document.addEventListener('click', e => { if (!e.target.closest('.lbPop') && !e.target.closest('.lbPcard')) closePops(); });
  window.addEventListener('keydown', e => {
    if (lobby.classList.contains('hidden')) return;
    if (e.key === 'Escape') { closePops(); openDrawer(false); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#lbQ').focus(); }
  });
  window.addEventListener('resize', closePops);

  $('#lbQ').oninput = e => { st.q = e.target.value; renderAll(); };
  $('#lbVList').onclick = () => { st.view = 'list'; renderAll(); };
  $('#lbVCard').onclick = () => { st.view = 'card'; renderAll(); };
  $('#lbOpenFile').onclick = () => {
    hideLobby();
    const b = document.getElementById('miOpen');   // 파일 메뉴의 "열기"
    if (b) b.click(); else hintMenu('파일 메뉴 → 열기 에서 DXF 파일을 불러오세요.');
  };
  $('#lbBulkX').onclick = () => { st.sel.clear(); renderAll(); };
  $('#lbBulk').querySelectorAll('[data-b]').forEach(b => b.onclick = () => {
    const list = files.filter(f => st.sel.has(f.id));
    if (b.dataset.b === 'group') moveToGroup(list); else removeFiles(list);
  });

  // ---------- 세션/클라우드 이벤트 ----------
  window.addEventListener('webcad-auth', (ev) => {
    session = (ev.detail && ev.detail.session) || null;
    if (!session) { files = []; }
    renderAll();
  });
  window.addEventListener('webcad-cloud-ready', reload);

  // ---------- 상단 로고 클릭 → 로비로 복귀 ----------
  function wireLogo() {
    const logo = document.querySelector('#topbar .title');
    if (!logo) { setTimeout(wireLogo, 300); return; }
    logo.style.cursor = 'pointer';
    logo.title = '로비로 돌아가기';
    logo.addEventListener('click', showLobby);
  }
  wireLogo();

  loadGroups();
  renderAll();
})();
