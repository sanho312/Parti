// ─────────────────────────────────────────────────────────────────────────────
// mcp.js — MCP 브리지 (브라우저 쪽)
//
// parti-mcp 서버(node parti-mcp/server.js)와 이어져, Claude 가 부른 도구를 이 탭의
// 도면에 실행한다. 서버→브라우저는 SSE, 브라우저→서버는 fetch POST.
//
// ★언제 붙나
//   ① 루프백 — 브리지가 서빙하는 http://127.0.0.1:PORT/ (데스크톱 기본)
//   ② LAN — 서버를 --lan 으로 띄우면 http://<PC의 IP>:PORT/?t=토큰 을 출력한다.
//      아이패드가 그 주소를 열면 서버가 페이지를 준 것이므로 동일 출처고, 중계 홉이 없다.
//      토큰을 아는 기기만 브리지를 쓸 수 있다.
//   배포본(https://sanho312.github.io/Parti/)에서는 아무 일도 하지 않는다 — HTTPS 페이지가
//   http 로컬로 붙는 것은 브라우저마다 막히는 정도가 다르고(사파리는 차단), 무엇보다
//   휴대기기 입장에서 127.0.0.1 은 자기 자신이라 데스크톱 서버에 닿지 않는다.
//   조용히 실패하느니 시도하지 않는 편이 낫다.
//
// ★도구 호출 1건 = 실행취소 1단계
//   ai.js 의 turnPushed 리셋은 send()(API 경로) 안에 있었다. 그 경로가 사라졌으므로
//   여기서 매 호출마다 beginTurn() 을 불러 준다 — 안 하면 두 번째 호출부터 pushUndo 가
//   영영 안 걸려 Ctrl+Z 가 먹지 않는다.
//
// ★모든 실패를 삼킨다
//   index.html 의 전역 오류 배너가 uncaught error / unhandledrejection 을 잡아
//   화면 최상단에 빨간 '오류 발생' 바를 띄운다. 브리지 연결 실패 한 번이 앱이 망가진
//   것처럼 보이면 안 된다.
// ─────────────────────────────────────────────────────────────────────────────
(() => {
  'use strict';

  const LOOP = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
  const PLAIN = location.protocol === 'http:';     // 배포본(https)은 여기서 걸러진다

  // ── 페어링 토큰 (LAN 모드) ────────────────────────────────────────────────
  // 서버가 --lan 으로 뜨면 주소에 ?t=… 를 실어 출력한다. 아이패드가 그 주소를 열면
  // 여기서 받아 기억하고, 브리지 호출마다 붙인다. 루프백은 토큰이 필요 없다.
  const TKEY = 'parti_mcp_token:' + location.origin;
  let TOKEN = '';
  try {
    const qt = new URLSearchParams(location.search).get('t');
    if (qt) { TOKEN = qt; localStorage.setItem(TKEY, qt); }
    else TOKEN = localStorage.getItem(TKEY) || '';
  } catch (e) {}

  let OPT = '';
  try { OPT = localStorage.getItem('parti_mcp_url') || ''; } catch (e) {}
  // 루프백이거나, 평문 http 로 열렸고 토큰이 있으면(=브리지가 준 주소) 붙을 수 있다.
  // ★붙을 수 없어도 이 파일은 끝까지 실행된다 — 진단·안내는 어디서든 해야 하기 때문이다.
  //   (예전엔 여기서 return 해 버려서, 정작 "왜 연결이 안 되나" 를 물을 곳이 없었다.)
  const ELIGIBLE = LOOP || (PLAIN && !!TOKEN) || !!OPT;
  const BASE = (LOOP || (PLAIN && TOKEN)) ? '' : (OPT || '').replace(/\/+$/, '');
  const q = TOKEN ? ('?t=' + encodeURIComponent(TOKEN)) : '';
  // 이 페이지가 브리지가 준 것이 아닐 때, '거기 서버가 떠 있나' 를 물어볼 곳
  const PROBE = BASE || 'http://127.0.0.1:7391';

  const AI = () => window.WEBCAD_AI || window.__WEBCAD_AI_TEST__ || null;
  const C = () => window.__CADTEST__ || null;
  const B = () => window.WEBCAD_AI_BRIDGE || null;
  const ARCH = () => window.PARTI_ARCH || null;
  const VIS = () => window.PARTI_VISION || null;

  const err = (m) => ({ error: m });

  // ── 상태 표시등 (하단 상태바 칩 — 라이노식 stBtn 규약을 따른다) ────────────
  let chip = null;
  function ensureChip() {
    if (chip && chip.isConnected) return chip;
    const bar = document.getElementById('statusBar');
    chip = document.createElement('span');
    chip.className = 'stBtn'; chip.id = 'stMcp';        // data-proxy 없음 → 상태바 미러 루프가 건드리지 않는다
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:5px';
    chip.innerHTML = '<i style="width:6px;height:6px;border-radius:50%;background:var(--muted,#888);'
      + 'display:inline-block"></i><span>MCP</span>';
    if (bar) bar.appendChild(chip);
    else {                                              // 상태바가 없으면 떠 있는 알약으로
      chip.style.cssText += ';position:fixed;right:10px;bottom:8px;z-index:9998;'
        + 'background:var(--glass-fill,rgba(20,24,32,.72));border-radius:999px;padding:3px 9px';
      document.body.appendChild(chip);
    }
    // ★눌러서 진단창 — 왜 안 붙었는지 알려주고 거기서 바로 잇는다.
    //   (예전엔 조용히 재연결만 해서, 서버가 꺼져 있으면 아무 반응도 없었다.)
    chip.style.cursor = 'pointer';
    chip.addEventListener('click', () => { try { openDialog(); } catch (e) {} });
    return chip;
  }
  function setDot(cssVar, tip, on) {
    try {
      const c = ensureChip();
      c.firstChild.style.background = cssVar;
      c.title = 'MCP 브리지 — ' + tip;
      c.classList.toggle('on', !!on);
    } catch (e) {}
  }

  // ── 공통 ───────────────────────────────────────────────────────────────────
  const ents = () => (C() ? C().state.entities : []);
  const nDocs = () => (C() && C().docCount ? C().docCount() : 1);
  const curDoc = () => (C() && C().curDocIdx ? C().curDocIdx() : 0);
  const snap = () => ({ n: ents().length, doc: curDoc(), docs: nDocs() });
  function delta(before, extra) {
    return Object.assign({
      entities_before: before.n, entities_after: ents().length,
      doc: curDoc(), docs: nDocs(),
      new_tabs: nDocs() - before.docs || undefined,
    }, extra || {});
  }
  function refresh() { try { const b = B(); if (b && b.refresh) b.refresh(); } catch (e) {} }

  // 첨부/밑그림 이미지의 dataURL — ★이 값은 절대 MCP 로 내보내지 않는다.
  //   전처리 결과(JSON)만 나간다. 손그림을 통째로 LLM 에 보내지 않는 것이 이 프로젝트의 제1원칙.
  function imgSrc(source) {
    if (source === 'underlay') {
      const e = ents().find(x => x.type === 'IMAGE' && x.layer === '밑그림');
      return e ? e.src : null;
    }
    const ai = AI();
    return (ai && ai.lastImg && ai.lastImg.dataUrl) || null;
  }

  // ── MCP 전용 도구 ──────────────────────────────────────────────────────────
  const OWN = {
    inspect(i) {
      const c = C(); if (!c) return err('cad.js 가 아직 로드되지 않았습니다.');
      switch (i.what) {
        case 'area': {
          const d = c.areaData(); if (!d) return err('면적을 낼 건물이 없습니다.');
          const rows = c.areaRows(Number(i.site_m2) > 0 ? Number(i.site_m2) : 0);
          return { data: d, rows,
            note: '건폐율·용적률은 site_m2 를 줬을 때만 나온다 — 대지면적은 모델에 없다.' };
        }
        case 'windows': {
          const r = c.owSchedRows();
          return { rows: r, count: r.length,
            note: 'conf 가 0.4 미만인 행은 개폐방식을 그림에서 추정한 것이다. 사실처럼 쓰지 말 것.' };
        }
        case 'floors': {
          const fi = c.floorInfo ? c.floorInfo() : null;
          const t = c.planFloorTag ? c.planFloorTag(ents()) : null;
          return { max_floor: fi && fi.max, has_roof: !!(fi && fi.roof),
            floor_height_mm: t && t.fh, note: (t && !t.fh) ? '층고를 가를 근거가 없다(단층이거나 슬래브가 없다).' : undefined };
        }
        case 'sections': return { lines: c.autoSecLines() };
        case 'details': return { available: c.detailSources().map(d => d.name) };
        case 'docs': {
          const b = B();
          return { current: curDoc(), count: nDocs(),
            current_name: b && b.getDocName ? b.getDocName() : undefined,
            note: '탭 이름은 현재 탭만 알 수 있다 — switch_doc 으로 옮겨 확인할 것.' };
        }
        case 'layers': return { layers: c.state.layers, current: c.state.currentLayer };
        default: return err('what 은 area|windows|floors|sections|details|docs|layers 중 하나여야 합니다.');
      }
    },

    run_command(i) {
      const c = C(); if (!c) return err('cad.js 가 아직 로드되지 않았습니다.');
      const raw = String(i.command || '').trim();
      if (!raw) return err('command 가 비어 있습니다.');
      // ★cmd* 를 직접 부른다 — runCommandInput 은 언제나 undefined 를 돌려주기 때문에
      //   그것만 쓰면 Claude 가 무엇이 만들어졌는지 알 길이 없다.
      const FN = { sheetset: c.cmdSheetSet, sheet: c.cmdSheet, detail: c.cmdDetails,
        areatable: c.cmdAreaTable, owsched: c.cmdOwSchedule, autodim: c.cmdAutoDim,
        autosection: c.cmdAutoSection, floorview: c.cmdFloorView };
      const sp = raw.search(/\s/);
      const head = (sp > 0 ? raw.slice(0, sp) : raw).toLowerCase();
      const arg = sp > 0 ? raw.slice(sp).trim() : '';
      const tool = (c.CMD_ALIASES || {})[head];
      const before = snap();
      let out;
      if (tool && FN[tool]) out = FN[tool](arg);
      else { c.runCommandInput(raw); out = undefined; }
      refresh();
      return delta(before, { command: raw, result: out === undefined ? null : out,
        note: tool && FN[tool] ? undefined
          : '이 명령은 전용 경로가 없어 명령창으로 실행했다 — 반환값이 없고, 대화형(클릭 대기) 명령이면 아무것도 안 바뀔 수 있다.' });
    },

    build_massing(i) {
      const A = ARCH(); if (!A || !A.buildComplex) return err('arch.js 가 아직 로드되지 않았습니다.');
      const o = {};
      for (const k of ['count', 'floors', 'w', 'd', 'roof', 'arrange', 'program', 'floorProgram',
        'attached', 'glass', 'lean', 'balcony', 'eaveOvh', 'rooms', 'site', 'parking']) {
        if (i[k] !== undefined && i[k] !== null) o[k] = i[k];
      }
      // ★미지정은 undefined 로 남긴다 — arch.js 기본값이 채우게 하는 것이 이 코드베이스의 관례다.
      const before = snap();
      A.buildComplex(o);
      refresh();
      const warn = [];
      if (o.program === 'piloti') warn.push("program:'piloti' 는 지원되지 않아 oneroom 으로 지어졌다 — floorProgram 을 쓸 것.");
      if ((o.w && !o.d) || (o.d && !o.w)) warn.push('w 와 d 는 쌍으로 줘야 한다 — 하나만 주면 둘 다 무시된다.');
      if (o.rooms === false && (o.floors || 2) > 1) warn.push('rooms:false 라 계단이 없다 — 2층 이상인데 올라갈 방법이 없는 건물이다.');
      if (o.lean && o.arrange && o.arrange !== 'arc') warn.push("lean 은 arrange:'arc' 에서만 적용된다 — 무시되었다.");
      return delta(before, { spec: o, warnings: warn.length ? warn : undefined });
    },

    async trace_concept(i) {
      const V = VIS(); if (!V || !V.traceConcept) return err('vision.js 가 아직 로드되지 않았습니다.');
      const src = imgSrc(i.source || 'attachment');
      if (!src) {
        return err((i.source === 'underlay')
          ? '도면에 밑그림이 없습니다 — set_underlay 로 먼저 깔거나 source:"attachment" 를 쓰세요.'
          : '첨부된 이미지가 없습니다. 사용자에게 Parti 채팅에 손그림을 첨부해 달라고 요청하세요(📎 또는 붙여넣기).');
      }
      const r = await V.traceConcept(src);
      if (!r) return err('판독하지 못했습니다.');
      // ★conf/why 를 반드시 함께 내보낸다. 이것을 빼면 헤지된 판독이 자신만만한 거짓말이 된다.
      const { meta, ...rest } = r;   // meta 는 진단용이라 크고 시끄럽다 — 내보내지 않는다
      return Object.assign(rest, {
        note: (r.conf != null && r.conf < 0.6)
          ? '★확신도가 낮다. why 를 사용자에게 알리고 값을 확인받은 뒤에 쓸 것.'
          : undefined,
      });
    },

    get_node_reference() { return { reference: NODE_REF }; },

    switch_doc(i) {
      const c = C(); if (!c) return err('cad.js 가 아직 로드되지 않았습니다.');
      const n = nDocs();
      if (!(i.index >= 0 && i.index < n)) return err('탭 번호는 0~' + (n - 1) + ' 입니다.');
      c.switchDoc(i.index, true); refresh();
      const b = B();
      return { doc: curDoc(), name: b && b.getDocName ? b.getDocName() : undefined, entities: ents().length };
    },

    undo() {
      const c = C(); if (!c) return err('cad.js 가 아직 로드되지 않았습니다.');
      const before = snap();
      c.runCommandInput('undo'); refresh();
      return delta(before);
    },

    export_drawing(i) {
      const c = C(); if (!c) return err('cad.js 가 아직 로드되지 않았습니다.');
      const f = String(i.format || '').toLowerCase();
      if (f === 'dxf') return { format: 'dxf', text: c.buildDXFText() };
      if (f === 'svg') return { format: 'svg', text: c.buildSVG() };
      if (f === 'pdf') {
        const text = c.buildPDF({ paper: i.paper || 'a3',
          scaleDenom: i.scale_denom === undefined ? 100 : i.scale_denom });
        return { format: 'pdf', text, note: '한글은 Helvetica 에 없어 "?" 로 나간다.' };
      }
      return err('format 은 dxf|svg|pdf 중 하나여야 합니다.');
    },
  };

  // ── 디스패치 ───────────────────────────────────────────────────────────────
  function dispatch(name, input) {
    const inp = input || {};
    if (OWN[name]) return OWN[name](inp);
    const ai = AI();
    if (!ai || !ai.execTool) return err('ai.js 도구 계층이 없습니다 — 페이지를 새로고침해 주세요.');
    if (name === 'get_screenshot' && document.body.classList.contains('authLocked')) {
      return err('로그인 게이트가 화면을 덮고 있어 스크린샷이 도면을 보여 주지 못합니다. 사용자에게 로그인을 요청하세요.');
    }
    if (ai.beginTurn) ai.beginTurn();      // 호출 1건 = undo 1단계
    const out = ai.execTool(name, inp);
    // ★execTool 자체는 화면을 되살리지 않는다 — API 루프가 매 라운드 refresh 를 불렀었다.
    if (!/^(get_|measure|select_)/.test(name)) refresh();
    return out;
  }

  // ── 전송 ───────────────────────────────────────────────────────────────────
  async function post(id, ok, payload) {
    try {
      await fetch(BASE + '/bridge/result' + q, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(ok ? { id, ok: true, result: payload } : { id, ok: false, error: String(payload) }),
      });
    } catch (e) { /* 서버가 죽었으면 SSE 도 곧 끊긴다 */ }
  }

  // Claude 가 무엇을 하고 있는지 채팅 패널에 남긴다 — 이게 없으면 사용자는 도면이 저절로
  // 바뀌는 것만 보고 누가 왜 그랬는지 알 길이 없다.
  const OWN_KO = { inspect: '도면 조회', run_command: '명령 실행', build_massing: '건물 생성',
    trace_concept: '손그림 판독', get_node_reference: '노드 사전', switch_doc: '탭 전환',
    undo: '실행취소', export_drawing: '내보내기' };
  function notify(kind, text) {
    try { const ai = AI(); if (ai && ai.notify) ai.notify(kind, text); } catch (e) {}
  }
  // 코워커 패널의 안내를 지금 상태로 다시 쓴다 (인사말 · 입력창 안내문)
  //   state: 'off'(브리지 없음) · 'bridge'(브리지만 붙음) · 'on'(Claude 까지 붙음)
  // ★셋을 구분하는 이유: 브리지가 붙었다고 Claude 가 붙은 것이 아니다. 뭉뚱그리면
  //   Claude 가 없는데도 "Claude Code 창에 말하세요" 라고 안내하게 된다.
  let uiState = 'off';
  function setMcpUI(state) {
    uiState = state === true ? 'on' : (state === false ? 'off' : String(state || 'off'));
    try { const ai = AI(); if (ai && ai.setMcp) ai.setMcp(uiState); } catch (e) {}
  }
  function toolKo(name) {
    const ai = AI();
    return OWN_KO[name] || (ai && ai.TOOL_KO && ai.TOOL_KO[name]) || name;
  }

  async function onCall(msg) {
    const { id, name, input } = msg;
    notify('tool', '🔧 ' + toolKo(name));
    setDot('var(--accent,#0A84FF)', name + ' 실행 중', true);
    try {
      const out = await Promise.resolve(dispatch(name, input));
      if (out && out.error) await post(id, false, out.error);
      else await post(id, true, out === undefined ? null : out);
    } catch (e) {
      await post(id, false, (e && e.message) || String(e));
    }
    setDot('var(--success,#30d158)', '연결됨', true);
  }

  // ── 연결 ───────────────────────────────────────────────────────────────────
  let es = null, evicted = false, announced = false;
  function connect() {
    evicted = false;
    try { if (es) es.close(); } catch (e) {}
    setDot('var(--muted,#888)', '연결 중…', false);
    try {
      es = new EventSource(BASE + '/bridge/events' + q);
    } catch (e) { setDot('var(--danger,#ff453a)', '연결 실패', false); return; }
    es.onopen = () => {
      // 붙은 것은 '브리지'다. Claude 가 붙었는지는 서버가 곧 보내 주는 state 로만 알 수 있다.
      setDot('var(--warn,#ffd60a)', '브리지 연결됨 — Claude 확인 중…', true);
      // ★메시지를 덧붙이지 않고 인사말 자체를 다시 쓴다.
      //   예전에는 "지금은 로컬 모드입니다" 인사말 아래에 "MCP 연결됨" 을 따로 붙였는데,
      //   두 메시지가 서로 모순되고 사용자는 위에 있는 것을 읽는다(실사용 보고).
      setMcpUI('bridge');
      announced = true;
    };
    es.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      // ★다른 탭에 자리를 내준다. 여기서 스스로 close 하지 않으면 EventSource 가 1초 뒤
      //   자동 재접속해서 두 탭이 서로를 끊어내는 무한 루프가 된다.
      if (m && m.evict) {
        evicted = true;
        try { es.close(); } catch (e) {}
        setMcpUI('off');
        setDot('var(--muted,#888)', '다른 Parti 탭이 브리지를 쓰고 있습니다 — 눌러서 가져오기', false);
        return;
      }
      // 서버가 알려 주는 'Claude 가 붙었는가'. 붙는 순간·떠 있는 채로 탭을 연 순간 둘 다 온다.
      if (m && m.state) {
        const on = !!m.state.claude;
        setMcpUI(on ? 'on' : 'bridge');
        setDot(on ? 'var(--success,#30d158)' : 'var(--warn,#ffd60a)',
          on ? '연결됨 — Claude 가 이 도면을 만질 수 있습니다'
            : '브리지만 연결됨 — Claude Code 에서 parti 서버를 승인하세요 (눌러서 진단)', true);
        return;
      }
      if (m && m.id) onCall(m).catch(() => {});   // 절대 밖으로 던지지 않는다
    };
    es.onerror = () => {
      if (evicted) return;
      setMcpUI('off');   // 끊겼는데 'Claude Code 창에 말하세요' 가 남아 있으면 거짓말이 된다
      // ★토큰은 서버를 다시 켤 때마다 바뀐다. 기억해 둔 옛 토큰으로는 403 이 나는데
      //   EventSource 는 상태 코드를 알려 주지 않으므로, 토큰을 쓰는 중이면 그 가능성을 함께 안내한다.
      setDot('var(--danger,#ff453a)', TOKEN
        ? '끊김 — 서버를 다시 켰다면 토큰이 바뀌었습니다. 서버가 출력한 새 주소로 여세요.'
        : '끊김 — parti-mcp 서버가 떠 있는지 확인 (눌러서 재연결)', false);
    };
  }

  // ★iframe 안에서는 연결하지 않는다
  //   tests.html 이 index.html 을 iframe 으로 띄운다. 그대로 두면 테스트를 돌릴 때마다
  //   임베드된 Parti 가 브리지에 붙어 사용자가 보고 있는 진짜 탭의 연결을 빼앗는다
  //   (서버는 활성 클라이언트를 하나만 둔다). 도구 실행 계층은 그대로 노출하므로
  //   테스트는 PARTI_MCP.dispatch 를 직접 부르면 된다.
  const TOP = (() => { try { return window.top === window.self; } catch (e) { return false; } })();

  // 앱이 다 뜬 뒤에 붙는다 (ai.js·nodes.js 와 같은 폴링 관용구)
  function start() {
    if (!C() || !B()) { setTimeout(start, 300); return; }
    connect();
    try { B().logLine('MCP 브리지 준비 — parti-mcp 서버에 연결합니다.', 'info'); } catch (e) {}
  }
  if (TOP) {
    const boot = () => setTimeout(() => {
      if (ELIGIBLE) start();
      // ★붙을 수 없는 자리에서도 칩은 띄운다 — 눌러서 '무엇을 해야 하나' 를 볼 수 있어야 한다.
      else setDot('var(--muted,#888)', '연결 안 됨 — 눌러서 연결 방법 보기', false);
    }, 300);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  진단 + 연결 안내 — "왜 로컬 모드지?" 에 답하는 곳
  //
  //  MCP 는 세 조각이 다 붙어야 동작한다. 하나라도 빠지면 코워커가 로컬이라고 말하는데,
  //  예전에는 어느 조각이 빠졌는지 알 길이 없었다.
  //    ① 서버   — node parti-mcp/server.js 가 떠 있는가
  //    ② 브라우저 — 이 탭이 그 서버가 준 페이지이고 브리지에 붙었는가
  //    ③ Claude  — Claude Code 가 그 서버를 MCP 로 붙였는가 (서버가 initialize 를 받았는가)
  // ═══════════════════════════════════════════════════════════════════════════
  async function probe(base) {
    try {
      const r = await fetch(base + '/bridge/status' + q, { cache: 'no-store' });
      if (r.status === 403) return { up: true, forbidden: true };
      if (!r.ok) return { up: true, bad: r.status };
      return Object.assign({ up: true }, await r.json());
    } catch (e) { return { up: false, err: String((e && e.message) || e) }; }
  }
  async function diagnose() {
    const st = await probe(PROBE);
    return {
      probeUrl: PROBE,
      servedByBridge: ELIGIBLE && BASE === '',
      eligible: ELIGIBLE,
      https: location.protocol === 'https:',
      origin: location.origin,
      server: st,
      browser: !!(es && es.readyState === 1),
      claude: !!st.claude,
    };
  }

  const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  function dlgStyle() {
    if (document.getElementById('mcpDlgCss')) return;
    const st = document.createElement('style');
    st.id = 'mcpDlgCss';
    st.textContent = `
    #mcpDlg{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,.45)}
    #mcpDlg .box{width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 60px);overflow:auto;
      background:var(--panel,#141922);color:var(--text,#e7ecf5);border:1px solid var(--line,#2a3242);
      border-radius:14px;box-shadow:var(--shadow-pop,0 18px 60px rgba(0,0,0,.5));padding:18px 20px;
      font:13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif}
    #mcpDlg h3{margin:0 0 4px;font-size:15px;display:flex;align-items:center;gap:8px}
    #mcpDlg .sub{color:var(--muted,#8fa3c8);font-size:12px;margin-bottom:14px}
    #mcpDlg .step{display:flex;gap:10px;padding:9px 0;border-top:1px solid var(--line,#2a3242)}
    #mcpDlg .mark{flex:0 0 20px;font-size:15px;line-height:1.4}
    #mcpDlg .body{flex:1;min-width:0}
    #mcpDlg .t{font-weight:600}
    #mcpDlg .d{color:var(--muted,#8fa3c8);font-size:12px;margin-top:2px}
    #mcpDlg code{display:block;margin-top:7px;padding:8px 10px;border-radius:8px;
      background:var(--glass-fill,rgba(255,255,255,.06));font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;
      white-space:pre-wrap;word-break:break-all;user-select:all}
    #mcpDlg .row{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
    #mcpDlg button{background:var(--accent,#0A84FF);color:#fff;border:none;border-radius:8px;
      padding:7px 13px;cursor:pointer;font-size:12px;font-weight:600}
    #mcpDlg button.ghost{background:var(--glass-fill,rgba(255,255,255,.08));color:var(--text,#e7ecf5)}
    #mcpDlg .foot{display:flex;justify-content:space-between;align-items:center;margin-top:16px;
      padding-top:12px;border-top:1px solid var(--line,#2a3242)}`;
    document.head.appendChild(st);
  }

  function copyBtn(text, label) {
    const b = document.createElement('button');
    b.className = 'ghost'; b.textContent = label || '복사';
    b.addEventListener('click', () => {
      const done = () => { const o = b.textContent; b.textContent = '복사됨 ✓'; setTimeout(() => { b.textContent = o; }, 1400); };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
        else { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta);
          ta.select(); document.execCommand('copy'); ta.remove(); done(); }
      } catch (e) { done(); }
    });
    return b;
  }

  function step(mark, title, desc, extras) {
    const d = document.createElement('div'); d.className = 'step';
    d.innerHTML = '<div class="mark">' + mark + '</div><div class="body"><div class="t">'
      + esc(title) + '</div>' + (desc ? '<div class="d">' + desc + '</div>' : '') + '</div>';
    const body = d.querySelector('.body');
    for (const e of (extras || [])) body.appendChild(e);
    return d;
  }
  function cmdBlock(text) { const c = document.createElement('code'); c.textContent = text; return c; }
  function rowOf(...els) { const r = document.createElement('div'); r.className = 'row'; for (const e of els) if (e) r.appendChild(e); return r; }

  let dlg = null, dlgTimer = 0;
  async function render() {
    if (!dlg) return;
    const g = await diagnose();
    const root = (g.server && g.server.root) || 'C:\\Parti';
    const port = (g.server && g.server.port) || 7391;
    const runCmd = 'node parti-mcp/server.js';
    const addCmd = 'claude mcp add parti -- node ' + root.replace(/\\/g, '/') + '/parti-mcp/server.js';
    const box = dlg.querySelector('.box');
    box.innerHTML = '<h3>MCP 연결</h3><div class="sub">Claude 가 이 도면을 직접 만지게 합니다. '
      + '세 조각이 다 붙어야 동작합니다.</div>';

    // ① 서버
    if (g.server.up) {
      box.appendChild(step('✅', 'parti-mcp 서버가 떠 있습니다',
        esc(root) + ' · 포트 ' + port + (g.server.tools ? ' · 도구 ' + g.server.tools + '개' : '')));
    } else {
      box.appendChild(step('❌', 'parti-mcp 서버가 꺼져 있습니다',
        g.https ? '이 페이지는 https 라 로컬 서버를 확인하지 못할 수도 있습니다.'
          : '<b>가장 쉬운 방법: Parti 폴더에서 Claude Code 를 열면</b> 서버가 뜨고 브라우저까지 알아서 열립니다.'
            + '<br>서버만 따로 띄우려면 아래를 실행하세요 (아이패드까지 쓰려면 <b>--lan</b>).',
        [cmdBlock(runCmd), rowOf(copyBtn(runCmd, '명령 복사'), copyBtn(runCmd + ' --lan', 'LAN 모드 복사'))]));
    }

    // ② 브라우저
    if (g.browser) {
      box.appendChild(step('✅', '이 탭이 브리지에 붙었습니다', esc(g.origin)));
    } else if (!g.servedByBridge) {
      const open = document.createElement('button');
      open.textContent = PROBE + '/ 로 열기';
      open.addEventListener('click', () => { location.href = PROBE + '/'; });
      box.appendChild(step('❌', '이 페이지는 브리지가 준 것이 아닙니다',
        '지금 주소는 <b>' + esc(g.origin) + '</b> 입니다. MCP 는 서버가 직접 서빙한 주소에서만 붙습니다 — '
        + '그래야 같은 출처가 되어 브라우저가 막지 않습니다.'
        + (g.https ? '<br>배포본(https)에서는 쓸 수 없습니다. 데스크톱에서 로컬 주소로 열어 주세요.' : ''),
        [rowOf(g.server.up ? open : null, copyBtn(PROBE + '/', '주소 복사'))]));
    } else {
      const re = document.createElement('button');
      re.textContent = '다시 연결';
      re.addEventListener('click', () => { connect(); setTimeout(render, 700); });
      box.appendChild(step('❌', '브리지에 붙지 않았습니다',
        g.server.forbidden ? '토큰이 맞지 않습니다 — 서버를 다시 켰다면 새 주소(?t=…)로 여세요.'
          : g.server.up ? '서버는 떠 있습니다. 다시 연결해 보세요.' : '서버부터 켜 주세요.',
        [rowOf(re)]));
    }

    // ③ Claude
    if (g.claude) {
      const c = g.server.client || {};
      box.appendChild(step('✅', 'Claude 가 붙었습니다',
        esc((c.name || '') + ' ' + (c.version || '')) + ' — 이제 Claude 에게 그냥 말하면 됩니다.'));
    } else {
      box.appendChild(step('❌', 'Claude 가 아직 붙지 않았습니다',
        '이 저장소에는 <b>.mcp.json</b> 이 있어서, <b>' + esc(root) + '</b> 에서 Claude Code 를 열면 '
        + '<b>parti</b> 서버를 쓸지 물어봅니다 — 승인하면 끝입니다.<br>'
        + '이미 열려 있다면 <b>한 번 껐다 켜야</b> 합니다(MCP 설정은 시작할 때 읽습니다).<br>'
        + '다른 폴더에서 쓰려면 아래 명령으로 등록하세요.',
        [cmdBlock(addCmd), rowOf(copyBtn(addCmd, '등록 명령 복사'))]));
    }

    const foot = document.createElement('div'); foot.className = 'foot';
    const hint = document.createElement('span');
    hint.style.cssText = 'color:var(--muted,#8fa3c8);font-size:11px';
    hint.textContent = g.browser && g.claude ? '전부 연결됨' : '3초마다 다시 확인합니다';
    const close = document.createElement('button');
    close.className = 'ghost'; close.textContent = '닫기';
    close.addEventListener('click', closeDialog);
    foot.appendChild(hint); foot.appendChild(close);
    box.appendChild(foot);
  }

  function closeDialog() {
    if (dlgTimer) { clearInterval(dlgTimer); dlgTimer = 0; }
    if (dlg) { dlg.remove(); dlg = null; }
  }
  function openDialog() {
    if (dlg) { render(); return; }
    dlgStyle();
    dlg = document.createElement('div');
    dlg.id = 'mcpDlg';
    dlg.innerHTML = '<div class="box"></div>';
    dlg.addEventListener('click', (e) => { if (e.target === dlg) closeDialog(); });
    document.body.appendChild(dlg);
    render();
    // ★열어 둔 채로 서버를 켜면 바로 초록으로 바뀌어야 한다 — 그게 '한 번에 연결'의 실체다.
    //   ★단 iframe 안에서는 절대 붙지 않는다. 이 자동 연결이 TOP 가드를 무시하면
    //   tests.html 이 진단창을 여는 순간 임베드된 Parti 가 브리지를 가로채,
    //   사용자가 보고 있는 진짜 탭의 연결을 빼앗는다(실측으로 잡았다).
    dlgTimer = setInterval(async () => {
      if (!dlg) return;
      if (TOP && ELIGIBLE && !(es && es.readyState === 1)) { const s = await probe(PROBE); if (s.up) connect(); }
      render();
    }, 3000);
  }

  // ── 노드 어휘 사전 (get_node_reference) ────────────────────────────────────
  // ★ai.js 의 SYSTEM 프롬프트에만 있던 자산이다. API 경로를 지우면서 여기로 옮겼다.
  //   길어서 MCP instructions 에 상주시키지 않고, 필요할 때만 꺼내 쓰게 한다.
  const NODE_REF = [
    '# 노드 vs 직접 생성',
    '- 노드: 반복·배열·패턴(루버·기둥열·격자·타워 층), 값을 바꿔가며 탐색할 디자인, 열관류/풍압 분석, 도면 개체(geoIn) 연동 로직.',
    '  반복 개체를 add_entities 로 낱개 생성하는 것은 조절 불가능한 죽은 사본이다.',
    '- add_entities: 고정 치수의 단일/소수 개체, 문·창·계단 배치, 일회성 수정. 애매하면 노드를 우선.',
    '',
    '# 묘사 → 로직 (사용자는 전문용어를 쓰지 않는다)',
    '- "가까울수록 커지게/촘촘하게" → dist(요소들, 기준점)→remap→크기·간격 (같은 dist 를 gradient 에 물리면 색도)',
    '- "물결치는/출렁이는" → series→expr(f:"sin(x/주기)*진폭")→pt 또는 move dz',
    '- "비틀린/꼬인 타워" → 층 복제 + rotate deg 에 series(0,층당각도,층수), 외피는 loft',
    '- "층층이/계단식" → series(0,층고,층수)→move dz→slab 또는 extrude',
    '- "무작위로 흩어진" → rand(seed) (seed 슬라이더 = "다른 배치 보기")',
    '- "하나 걸러 하나" → cull(pattern 1,0…)',
    '- "돔/항아리/원뿔 지붕" → revolve(프로필 x=반지름·y=높이)',
    '- "두 모양을 부드럽게 잇는" → 두 단면 커브(위 커브는 move dz)→loft',
    '',
    '# 노드 사전',
    '[입력] num{params:{v}} · slider{params:{v,min,max,step}} · series(start,step,count) · range(start,end,count) ·',
    '  rand(count,min,max,seed) · remap(v,f0,f1,t0,t1) · expr(x,y,z / params:{f:"수식"} — sin cos sqrt abs min max floor round pow pi) ·',
    '  geoIn{ids:[개체id]}=도면 참조 · panel(v)=값보기',
    '[리스트] listItem(list,i) · subList(list,start,count) · revList · shiftL(list,n) · cull(list,pattern)→[남김,제거] ·',
    '  merge(a,b,c) · listLen · sortL(keys,values) · stats(list)→[합,평균,최소,최대] · dist(a,b) · ptXYZ(pt)→[x,y,z]',
    '[커브] pt(x,y,z) · ptGrid(nx,ny,dx,dy) · line(a,b) · rect(c,w,h) · circle(c,r) · polygon(c,r,sides) · arc(c,r,a0,a1) ·',
    '  plineN(pts,closed) · divide(crv,count)→0=점들·1=접선각("노드id:1") · offsetC(crv,d) · endPts(crv) · lenC(crv) ·',
    '  areaC(crv)→[면적㎡,도심] · bboxN(geo)→[상자,중심,w,h]',
    '[변환] move(geo,dx,dy,dz) · rotate(geo,cx,cy,deg) · mirror(geo,x1,y1,x2,y2) · scaleN(geo,cx,cy,f) ·',
    '  arrayL(geo,count,dx,dy,dz) · arrayP(geo,count,cx,cy,sweep) · orientPts(geo,pts,deg) · louver(crv,count,depth,deg,h,t)',
    '[BIM] extrude(geo,h) · slab(crv,t,top) · sphereN(c,r,seg) · loft(a,b,seg) · revolve(profile,cx,cy,seg,sweep)',
    '[분석] thermal(geo,U,dT)→[히트맵,Q합W,개별] · wind(geo,V,dir,Cp)→[색상,F합kN,개별] · gradient(geo,v,lo,hi)→[색칠,정규화]',
    '',
    '# 스펙 형식',
    '[{id:"고유문자열", type, params?, inputs?, label?}] — inputs 값이 숫자면 리터럴, "다른노드id"면 그 노드 출력을 연결.',
    '★사용자가 조절할 값은 반드시 slider 노드로 만들고 label(한국어+단위: "층수", "루버 깊이(mm)")을 붙일 것 —',
    '  슬라이더는 화면 왼쪽 아래 [🎛 패턴 컨트롤] 패널에 자동 노출되어 사용자가 드래그로 조절한다.',
    '리스트 매칭: move/rotate/scaleN/extrude/slab 의 숫자 입력에 리스트를 물리면 개체마다 다른 값이 적용된다.',
    '',
    '# 예 (개수 조절되는 원 배열)',
    '[{"id":"s","type":"slider","params":{"v":5,"min":1,"max":12,"step":1},"label":"개수"},',
    ' {"id":"p","type":"pt"},',
    ' {"id":"c","type":"circle","inputs":{"c":"p","r":400}},',
    ' {"id":"a","type":"arrayL","inputs":{"geo":"c","count":"s","dx":1200}}]',
    '',
    'replace 결과는 라이브 프리뷰(파란색)로 보인다. 사용자가 확정을 원할 때만 action:"bake".',
    '그래프는 매번 전체 교체이므로 수정 시 action:"get" 으로 현재 스펙을 받아 전체를 다시 보낼 것.',
  ].join('\n');

  window.PARTI_MCP = { dispatch, connect, OWN, diagnose, openDialog, closeDialog, eligible: ELIGIBLE,
    get connected() { return !!es && es.readyState === 1; },
    // 'off' | 'bridge' | 'on' — 'on' 이라야 Claude 가 실제로 붙어 있다는 뜻이다.
    get state() { return (!!es && es.readyState === 1) ? uiState : 'off'; } };
})();
