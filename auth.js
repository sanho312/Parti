// ============================================================
//  Parti 로그인/회원가입 (이메일 인증번호 방식)
//  - 백엔드: Supabase Auth (auth-config.js 에 url/anonKey 설정 시 활성)
//  - 설정이 비어 있으면 게이트를 띄우지 않고 기존처럼 동작
//  - 데모 모드: 콘솔에서 localStorage.setItem('webcad_auth_demo','1') 후 새로고침
//    (서버 없이 UI 흐름 테스트용 — 인증번호가 화면에 표시됨)
// ============================================================
(() => {
  const cfg = window.WEBCAD_AUTH || {};
  const DEMO = !cfg.url && localStorage.getItem('webcad_auth_demo') === '1';
  if (!cfg.url && !DEMO) return; // 미설정 → 로그인 게이트 없음

  // ---------- 스타일 ----------
  const style = document.createElement('style');
  style.textContent = `
  #authGate{position:fixed;inset:0;z-index:100;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
    background:rgba(5,8,20,0.82);-webkit-backdrop-filter:saturate(180%) blur(30px);backdrop-filter:saturate(180%) blur(30px);}
  #authGate.hidden{display:none;}
  html.light #authGate{background:rgba(238,242,250,0.88);}
  html.light .authCard input{background:rgba(30,60,140,0.08);box-shadow:inset 0 .5px 0 0 rgba(20,40,90,.08);}
  html.light .authBtn.ghost{background:rgba(30,60,140,0.08);}
  #authGate .gateNote{font-size:12.5px;color:rgba(210,222,250,0.55);letter-spacing:-0.01em;}
  .authCard{width:min(92vw,360px);background:var(--glass-pop,rgba(26,37,64,.9));
    -webkit-backdrop-filter:saturate(180%) blur(24px);backdrop-filter:saturate(180%) blur(24px);
    border-radius:28px;padding:28px 26px;box-shadow:0 12px 40px rgba(2,6,20,.6),inset 0 .5px 0 0 rgba(200,220,255,.24);
    color:var(--text,#f2f5ff);user-select:none;}
  .authCard h1{margin:0 0 4px;font-size:22px;font-weight:600;letter-spacing:-0.02em;}
  .authCard .sub{margin:0 0 18px;font-size:13px;color:var(--muted,rgba(210,222,250,.62));line-height:1.5;}
  .authCard label{display:block;font-size:12px;color:var(--muted,rgba(210,222,250,.62));margin:10px 0 4px;}
  .authCard input{width:100%;box-sizing:border-box;background:rgba(150,180,255,.10);color:inherit;border:none;
    border-radius:11px;padding:10px 13px;font-size:14px;user-select:text;-webkit-user-select:text;
    box-shadow:inset 0 .5px 0 0 rgba(200,220,255,.18);}
  .authCard input:focus{outline:none;box-shadow:0 0 0 2px var(--accent,#0A84FF);}
  .authBtn{width:100%;margin-top:16px;background:var(--accent,#0A84FF);color:#fff;border:none;
    border-radius:980px;padding:11px;font-size:15px;font-weight:600;cursor:pointer;letter-spacing:-0.01em;}
  .authBtn:hover{background:var(--accent-hover,#3d9bff);}
  .authBtn:disabled{opacity:.55;cursor:default;}
  .authBtn.ghost{background:rgba(150,180,255,.10);font-weight:400;margin-top:8px;}
  .authErr{min-height:18px;margin-top:10px;font-size:12.5px;color:#ff6961;line-height:1.4;}
  .authLinks{margin-top:14px;display:flex;justify-content:space-between;font-size:12.5px;}
  .authLinks a{color:var(--accent-text,#5eb1ff);cursor:pointer;text-decoration:none;}
  .authLinks a:hover{text-decoration:underline;}
  .authDemo{margin-top:12px;padding:9px 11px;border-radius:11px;background:rgba(255,212,38,.12);
    color:#ffd426;font-size:12.5px;line-height:1.5;}
  #authCode{letter-spacing:8px;text-align:center;font-size:20px;font-family:ui-monospace,Consolas,monospace;}
  #userChipWrap{position:relative;display:inline-block;}
  /* ── 마이페이지 드롭다운 + 친구 패널 (2026-07-20) ── */
  #userChipWrap .dropdown{left:auto;right:0;min-width:185px;}
  #userMenu .menuItem{display:flex;align-items:center;gap:8px;width:100%;}
  #friendPanel{display:none;position:absolute;top:calc(100% + 6px);right:calc(100% + 8px);width:252px;
    background:var(--panel,#171b25);border:1px solid var(--line,rgba(128,140,170,.25));border-radius:12px;
    box-shadow:var(--shadow-pop,0 10px 30px rgba(0,0,0,.4));padding:10px;z-index:60;
    flex-direction:column;gap:8px;}
  #friendPanel.open{display:flex;}
  #friendPanel h4{margin:0;font-size:11.5px;font-weight:600;color:var(--muted,#8a93a6);letter-spacing:.02em;}
  #frList{display:flex;flex-direction:column;gap:2px;max-height:220px;overflow-y:auto;}
  .frRow{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--text,#e7eaf1);
    padding:5px 7px;border-radius:8px;}
  .frRow:hover{background:var(--glass-fill-hi,rgba(128,140,170,.12));}
  .frDot{width:8px;height:8px;border-radius:50%;background:#8a93a6;flex:0 0 auto;}
  .frDot.on{background:#31c46f;box-shadow:0 0 0 3px rgba(49,196,111,.18);}
  .frNm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .frSt{margin-left:auto;font-size:10.5px;color:var(--muted,#8a93a6);flex:0 0 auto;}
  .frDel{border:none;background:none;color:var(--muted,#8a93a6);cursor:pointer;font-size:13px;padding:0 2px;flex:0 0 auto;}
  .frDel:hover{color:#e04f4f;}
  #frAddRow{display:flex;gap:6px;}
  #frAdd{flex:1;min-width:0;font-size:12px;}
  #frEmpty{font-size:12px;color:var(--muted,#8a93a6);padding:2px 4px;line-height:1.5;}
  `;
  document.head.appendChild(style);

  // ---------- 백엔드 클라이언트 ----------
  let sb = null;
  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  }
  // 데모용 가짜 클라이언트: localStorage에 사용자 저장, 인증번호는 화면에 표시
  function mockClient() {
    const K_USERS = 'webcad_demo_users', K_SES = 'webcad_demo_session';
    const users = () => JSON.parse(localStorage.getItem(K_USERS) || '{}');
    const saveUsers = (u) => localStorage.setItem(K_USERS, JSON.stringify(u));
    let pending = null; // {email, code, kind, data}
    const listeners = [];
    const fire = () => listeners.forEach(f => f());
    const session = () => JSON.parse(localStorage.getItem(K_SES) || 'null');
    return {
      _demoCode: () => pending && pending.code,
      auth: {
        getSession: async () => ({ data: { session: session() } }),
        onAuthStateChange: (f) => { listeners.push(f); return { data: { subscription: { unsubscribe(){} } } }; },
        signUp: async ({ email, password, options }) => {
          const u = users();
          if (Object.values(u).some(x => x.email === email)) return { error: { message: 'User already registered' } };
          pending = { email, code: String(Math.floor(100000 + Math.random() * 900000)), kind: 'signup', data: { email, password, username: options?.data?.username } };
          return { data: {}, error: null };
        },
        resend: async ({ email }) => { if (pending && pending.email === email) pending.code = String(Math.floor(100000 + Math.random() * 900000)); return { error: null }; },
        verifyOtp: async ({ email, token, type }) => {
          if (!pending || pending.email !== email || pending.code !== token) return { error: { message: 'Token has expired or is invalid' } };
          if (type === 'signup') {
            const u = users(); u[pending.data.username] = pending.data; saveUsers(u);
            localStorage.setItem(K_SES, JSON.stringify({ user: { email, user_metadata: { username: pending.data.username } } }));
          } else { // recovery
            localStorage.setItem(K_SES, JSON.stringify({ user: { email, user_metadata: { username: (Object.values(users()).find(x => x.email === email) || {}).username } } }));
          }
          pending = null; fire();
          return { data: {}, error: null };
        },
        signInWithPassword: async ({ email, password }) => {
          const hit = Object.values(users()).find(x => x.email === email && x.password === password);
          if (!hit) return { error: { message: 'Invalid login credentials' } };
          localStorage.setItem(K_SES, JSON.stringify({ user: { email, user_metadata: { username: hit.username } } }));
          fire(); return { data: {}, error: null };
        },
        resetPasswordForEmail: async (email) => {
          if (!Object.values(users()).some(x => x.email === email)) return { error: null }; // 존재여부 노출 안 함
          pending = { email, code: String(Math.floor(100000 + Math.random() * 900000)), kind: 'recovery' };
          return { error: null };
        },
        updateUser: async ({ password }) => {
          const s = session(); if (!s) return { error: { message: 'not signed in' } };
          const u = users(); const k = Object.keys(u).find(k2 => u[k2].email === s.user.email);
          if (k) { u[k].password = password; saveUsers(u); }
          return { error: null };
        },
        signOut: async () => { localStorage.removeItem(K_SES); fire(); return { error: null }; },
      },
      rpc: async (fn, args) => {
        const u = users();
        if (fn === 'username_to_email') { const hit = u[args.u]; return { data: hit ? hit.email : null, error: null }; }
        if (fn === 'username_exists') return { data: !!u[args.u], error: null };
        return { data: null, error: null };
      },
    };
  }

  // ---------- 게이트 UI ----------
  const gate = document.createElement('div');
  gate.id = 'authGate'; gate.className = 'hidden';
  gate.innerHTML = `<div class="authCard" id="authCard"></div>
    <div class="gateNote">로그인해야 도구·메뉴를 사용할 수 있습니다</div>`;
  document.body.appendChild(gate);
  const card = gate.querySelector('#authCard');

  const ERR_KO = (m) => {
    if (!m) return '';
    if (/Invalid login credentials/i.test(m)) return '아이디(이메일) 또는 비밀번호가 올바르지 않습니다.';
    if (/Email not confirmed/i.test(m)) return '이메일 인증이 완료되지 않은 계정입니다. 회원가입에서 같은 이메일로 인증번호를 다시 받아 완료해 주세요.';
    if (/already registered/i.test(m)) return '이미 가입된 이메일입니다. 로그인하거나 비밀번호 재설정을 이용하세요.';
    if (/expired or is invalid/i.test(m)) return '인증번호가 올바르지 않거나 만료되었습니다. (가장 최근에 온 메일의 번호를 사용하세요)';
    const sec = m.match(/after (\d+) seconds?/i);
    if (sec) return `보안을 위해 ${sec[1]}초 후에 다시 시도할 수 있습니다.`;
    if (/rate limit|security purposes|too many/i.test(m)) return '요청이 잠시 제한되었습니다. 10초쯤 후 다시 시도해 주세요.';
    if (/least 8|password/i.test(m)) return '비밀번호는 8자 이상이어야 합니다.';
    return m;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let view = 'login';
  let verifyCtx = null; // {email, kind:'signup'|'recovery'}
  function render() {
    const demoBadge = DEMO ? `<div class="authDemo">데모 모드 — 실제 이메일 대신 인증번호가 이 화면에 표시됩니다.<span id="demoCode"></span></div>` : '';
    if (view === 'login') card.innerHTML = `
      <h1>Parti 로그인</h1><p class="sub">도면 작업을 시작하려면 로그인하세요.</p>
      <label>아이디 또는 이메일</label><input id="aId" autocomplete="username">
      <label>비밀번호</label><input id="aPw" type="password" autocomplete="current-password">
      <div class="authErr" id="aErr"></div>
      <button class="authBtn" id="aGo">로그인</button>
      <div class="authLinks"><a id="toSignup">회원가입</a><a id="toReset">비밀번호 재설정</a></div>${demoBadge}`;
    if (view === 'signup') card.innerHTML = `
      <h1>회원가입</h1><p class="sub">가입하면 이메일로 인증번호가 전송됩니다.</p>
      <label>아이디 (3~20자: 영문/숫자/한글)</label><input id="aUser" autocomplete="username">
      <label>이메일</label><input id="aEmail" type="email" autocomplete="email">
      <label>비밀번호 (8자 이상)</label><input id="aPw" type="password" autocomplete="new-password">
      <label>비밀번호 확인</label><input id="aPw2" type="password" autocomplete="new-password">
      <div class="authErr" id="aErr"></div>
      <button class="authBtn" id="aGo">인증번호 받기</button>
      <button class="authBtn ghost" id="toLogin">로그인으로 돌아가기</button>${demoBadge}`;
    if (view === 'verify') card.innerHTML = `
      <h1>이메일 인증</h1><p class="sub"><b>${esc(verifyCtx.email)}</b> 로 보낸<br>인증번호를 입력하세요.</p>
      <input id="authCode" maxlength="10" inputmode="numeric" placeholder="······">
      ${verifyCtx.kind === 'recovery' ? '<label>새 비밀번호 (8자 이상)</label><input id="aPw" type="password" autocomplete="new-password">' : ''}
      <div class="authErr" id="aErr"></div>
      <button class="authBtn" id="aGo">확인</button>
      <button class="authBtn ghost" id="aResend">인증번호 재전송</button>
      <button class="authBtn ghost" id="toLogin">취소</button>${demoBadge}`;
    if (view === 'reset') card.innerHTML = `
      <h1>비밀번호 재설정</h1><p class="sub">가입한 이메일로 인증번호를 보내드립니다.</p>
      <label>이메일</label><input id="aEmail" type="email" autocomplete="email">
      <div class="authErr" id="aErr"></div>
      <button class="authBtn" id="aGo">재설정 번호 받기</button>
      <button class="authBtn ghost" id="toLogin">로그인으로 돌아가기</button>${demoBadge}`;
    bind();
    updateDemoCode();
    const first = card.querySelector('input'); if (first) setTimeout(() => first.focus(), 50);
  }
  function updateDemoCode() {
    const el = card.querySelector('#demoCode');
    if (el && sb && sb._demoCode) el.textContent = sb._demoCode() ? ` 인증번호: ${sb._demoCode()}` : '';
  }
  const err = (m) => { const e = card.querySelector('#aErr'); if (e) e.textContent = ERR_KO(m); };
  const busy = (b) => { const g = card.querySelector('#aGo'); if (g) g.disabled = b; };

  function bind() {
    const q = (s) => card.querySelector(s);
    q('#toSignup')?.addEventListener('click', () => { view = 'signup'; render(); });
    q('#toReset')?.addEventListener('click', () => { view = 'reset'; render(); });
    q('#toLogin')?.addEventListener('click', () => { view = 'login'; verifyCtx = null; render(); });
    card.querySelectorAll('input').forEach(i => i.addEventListener('keydown', (ev) => {
      ev.stopPropagation(); if (ev.key === 'Enter') q('#aGo')?.click();
    }));
    q('#aResend')?.addEventListener('click', async () => {
      err('');
      const btn = q('#aResend');
      let res;
      if (verifyCtx.kind === 'signup') res = await sb.auth.resend({ type: 'signup', email: verifyCtx.email });
      else res = await sb.auth.resetPasswordForEmail(verifyCtx.email);
      if (res && res.error) { err(res.error.message); return; }
      err('인증번호를 다시 보냈습니다. 메일함(스팸함 포함)을 확인하세요.'); updateDemoCode();
      // 재전송 쿨다운(서버 제한과 동일하게 잠시 비활성)
      if (btn) {
        let left = 12; btn.disabled = true; const orig = btn.textContent;
        const t = setInterval(() => {
          left--; btn.textContent = `인증번호 재전송 (${left}초)`;
          if (left <= 0) { clearInterval(t); btn.disabled = false; btn.textContent = orig; }
        }, 1000);
      }
    });
    q('#aGo')?.addEventListener('click', async () => {
      err(''); busy(true);
      try {
        if (view === 'login') {
          let id = q('#aId').value.trim(), pw = q('#aPw').value;
          if (!id || !pw) return err('아이디와 비밀번호를 입력하세요.');
          let email = id;
          if (!id.includes('@')) {
            const { data } = await sb.rpc('username_to_email', { u: id });
            if (!data) return err('아이디(이메일) 또는 비밀번호가 올바르지 않습니다.');
            email = data;
          }
          const { error } = await sb.auth.signInWithPassword({ email, password: pw });
          if (error) return err(error.message);
        }
        if (view === 'signup') {
          const un = q('#aUser').value.trim(), em = q('#aEmail').value.trim(), pw = q('#aPw').value, pw2 = q('#aPw2').value;
          if (!/^[A-Za-z0-9가-힣_]{3,20}$/.test(un)) return err('아이디는 3~20자의 영문/숫자/한글/_ 만 가능합니다.');
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return err('올바른 이메일을 입력하세요.');
          if (pw.length < 8) return err('비밀번호는 8자 이상이어야 합니다.');
          if (pw !== pw2) return err('비밀번호 확인이 일치하지 않습니다.');
          const { data: exists } = await sb.rpc('username_exists', { u: un });
          if (exists) return err('이미 사용 중인 아이디입니다.');
          const { error } = await sb.auth.signUp({ email: em, password: pw, options: { data: { username: un } } });
          if (error) {
            // 발송 제한에 걸려도 인증 화면으로 넘어가 잠시 후 '재전송'으로 이어갈 수 있게
            if (/rate limit|security purposes|after \d+ seconds|too many/i.test(error.message)) {
              verifyCtx = { email: em, kind: 'signup' }; view = 'verify'; render();
              err(ERR_KO(error.message) + ' 잠시 후 아래 "인증번호 재전송"을 눌러주세요.');
              return;
            }
            return err(error.message);
          }
          verifyCtx = { email: em, kind: 'signup' }; view = 'verify'; render();
        }
        if (view === 'verify') {
          const code = q('#authCode').value.trim();
          if (!/^\d{6,10}$/.test(code)) return err('이메일로 받은 숫자 인증번호를 입력하세요.');
          if (verifyCtx.kind === 'recovery') {
            const pw = q('#aPw').value;
            if (pw.length < 8) return err('새 비밀번호는 8자 이상이어야 합니다.');
            const { error } = await sb.auth.verifyOtp({ email: verifyCtx.email, token: code, type: 'recovery' });
            if (error) return err(error.message);
            const { error: e2 } = await sb.auth.updateUser({ password: pw });
            if (e2) return err(e2.message);
          } else {
            const { error } = await sb.auth.verifyOtp({ email: verifyCtx.email, token: code, type: 'signup' });
            if (error) return err(error.message);
          }
          verifyCtx = null;
        }
        if (view === 'reset') {
          const em = q('#aEmail').value.trim();
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return err('올바른 이메일을 입력하세요.');
          const { error } = await sb.auth.resetPasswordForEmail(em);
          if (error) return err(error.message);
          verifyCtx = { email: em, kind: 'recovery' }; view = 'verify'; render();
        }
      } finally { busy(false); }
    });
  }

  // ---------- 세션 → 게이트/마이페이지 칩 ----------
  // 로그아웃 버튼을 상시 노출하지 않고 '마이페이지' 드롭다운에 넣는다 (2026-07-20 피드백).
  // 드롭다운: 플랜 · 친구(왼쪽으로 패널 — 접속 표시·추가) · 로그아웃.
  let chip = null, curSession = null;
  // 친구 목록: user_metadata.friends (계정에 저장 — 어느 기기에서나 동일). 데모/미지원이면 localStorage 폴백.
  const FR_KEY = 'webcad_friends_local';
  function getFriends() {
    const meta = curSession && curSession.user && curSession.user.user_metadata;
    if (meta && Array.isArray(meta.friends)) return meta.friends.slice();
    try { const a = JSON.parse(localStorage.getItem(FR_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  async function setFriends(list) {
    try { localStorage.setItem(FR_KEY, JSON.stringify(list)); } catch (e) {}
    try {
      if (sb && sb.auth && sb.auth.updateUser) {
        await sb.auth.updateUser({ data: { friends: list } });
        if (curSession && curSession.user) curSession.user.user_metadata = Object.assign({}, curSession.user.user_metadata || {}, { friends: list });
      }
    } catch (e) {}
  }
  // 접속 표시 + 동시접속 기기 제한: Supabase Realtime presence — 이메일을 key로 삼아
  // 같은 계정의 기기들이 한 key에 배열로 쌓인다(기기 수 카운트에 활용).
  let presCh = null, online = new Set(), presKey = '';
  // 기기 식별자 — 브라우저/기기당 1개, 새로고침·다중 탭에도 유지(같은 기기는 1대로 계산)
  function deviceId() {
    let d = null; try { d = localStorage.getItem('webcad_device_id'); } catch (e) {}
    if (!d) {
      d = (self.crypto && crypto.randomUUID) ? crypto.randomUUID()
        : 'dev-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      try { localStorage.setItem('webcad_device_id', d); } catch (e) {}
    }
    return d;
  }
  const DEVICE = deviceId();
  // 동시접속 한도: 프로=2대, 그 외(무료)=1대
  function deviceLimit() {
    try { return (window.WEBCAD_CLOUD && WEBCAD_CLOUD.plan && WEBCAD_CLOUD.plan() === 'pro') ? 2 : 1; } catch (e) { return 1; }
  }
  // 순수 판정(테스트용): 기기별 '가장 이른 접속시각(at)'으로 서열 → 먼저 접속한 N대만 활성,
  // 그 뒤에 접속한 내 기기는 차단(= 기존 활성 기기 보호). 같은 dev(기기)의 여러 탭은 1대로 합침.
  function deviceDecision(metas, myDev, limit) {
    const byDev = new Map();
    for (const m of (metas || [])) {
      const dv = (m && m.dev) || (m && m.presence_ref) || 'unknown';
      const at = (m && +m.at) || 0;
      if (!byDev.has(dv) || at < byDev.get(dv)) byDev.set(dv, at);
    }
    const order = [...byDev.entries()].sort((a, b) => (a[1] - b[1]) || (a[0] < b[0] ? -1 : 1)).map(e => e[0]);
    const active = order.slice(0, Math.max(1, limit | 0));
    const known = byDev.has(myDev);
    return { blocked: known && active.indexOf(myDev) < 0, devices: order.length, activeCount: active.length };
  }
  function evalDeviceLimit() {
    if (!presCh) return;
    let metas = [];
    try {
      const st = presCh.presenceState() || {};
      const k = Object.keys(st).find(x => String(x).toLowerCase() === presKey);
      metas = (k && st[k]) || [];
    } catch (e) {}
    const lim = deviceLimit();
    showDeviceLock(deviceDecision(metas, DEVICE, lim).blocked, lim);
  }
  function startPresence(session) {
    if (!session || presCh || !sb || typeof sb.channel !== 'function') return;
    try {
      presKey = String(session.user.email || 'user').toLowerCase();
      const myAt = Date.now();
      presCh = sb.channel('webcad-online', { config: { presence: { key: presKey } } });
      presCh.on('presence', { event: 'sync' }, () => {
        online = new Set(Object.keys(presCh.presenceState() || {}).map(k => String(k).toLowerCase()));
        renderFriendList();
        evalDeviceLimit();
      });
      presCh.subscribe((st) => { if (st === 'SUBSCRIBED') { try { presCh.track({ at: myAt, dev: DEVICE }); } catch (e) {} } });
    } catch (e) {}
  }
  // 플랜이 뒤늦게 로드(프로 확인)되면 한도를 다시 평가
  window.addEventListener('webcad-cloud-ready', () => { try { evalDeviceLimit(); } catch (e) {} });
  // 동시접속 초과 잠금 오버레이 — '새 기기 차단' 방식(기존 활성 기기를 보호)
  let devLockEl = null;
  function showDeviceLock(blocked, limit) {
    if (!blocked) { if (devLockEl) devLockEl.style.display = 'none'; return; }
    if (!devLockEl) {
      if (!document.getElementById('devLockStyle')) {
        const st = document.createElement('style'); st.id = 'devLockStyle';
        st.textContent = `
          #devLock{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:24px;
            background:rgba(6,10,20,0.72);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);}
          #devLock .dlCard{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:18px;
            box-shadow:var(--shadow-pop);width:400px;max-width:92vw;padding:30px 30px 26px;text-align:center;}
          #devLock .dlIco{width:52px;height:52px;margin:0 auto 16px;border-radius:50%;display:flex;align-items:center;
            justify-content:center;background:var(--glass-fill-hi);color:var(--accent-text);}
          #devLock .dlIco svg{width:26px;height:26px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;}
          #devLock .dlTit{font-size:18px;font-weight:650;margin:0 0 10px;letter-spacing:-0.01em;}
          #devLock .dlMsg{font-size:13px;line-height:1.6;color:var(--muted);margin:0 0 18px;}
          #devLock .dlMsg b{color:var(--text);font-weight:600;}
          #devLock .dlUp{font-size:12px;line-height:1.5;color:var(--accent-text);background:var(--glass-fill);
            border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin:0 0 18px;}
          #devLock .dlBtn{width:100%;padding:12px;border:none;border-radius:12px;background:var(--accent);color:#fff;
            font-size:14px;font-weight:600;cursor:pointer;transition:background .12s ease;}
          #devLock .dlBtn:hover{background:var(--accent-hover);}`;
        document.head.appendChild(st);
      }
      devLockEl = document.createElement('div'); devLockEl.id = 'devLock';
      document.body.appendChild(devLockEl);
    }
    const pro = limit >= 2;
    const line = pro ? '프로 플랜은 최대 2대까지 동시에 사용할 수 있어요.'
      : '일반 플랜은 한 번에 한 기기에서만 사용할 수 있어요.';
    const upsell = pro ? '' : '<div class="dlUp">여러 기기에서 동시에 이어 작업하려면 프로 플랜(2대 동시 접속)을 이용하세요.</div>';
    devLockEl.innerHTML = `
      <div class="dlCard">
        <div class="dlIco"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></div>
        <h2 class="dlTit">다른 기기에서 사용 중입니다</h2>
        <p class="dlMsg">이 계정은 이미 다른 기기에서 Parti를 사용하고 있습니다. ${line}<br>이 기기에서 이어서 작업하려면 <b>다른 기기의 Parti 창을 닫은 뒤</b> 아래 버튼을 눌러 주세요.</p>
        ${upsell}
        <button class="dlBtn" id="dlRetry">이 기기에서 이어서 작업</button>
      </div>`;
    devLockEl.style.display = 'flex';
    const rb = devLockEl.querySelector('#dlRetry');
    if (rb) rb.addEventListener('click', () => { try { evalDeviceLimit(); } catch (e) {} });
  }
  function renderFriendList() {
    const list = chip && chip.querySelector('#frList'); if (!list) return;
    const fr = getFriends();
    const me = String((curSession && curSession.user && curSession.user.email) || '').toLowerCase();
    list.innerHTML = '';
    const empty = chip.querySelector('#frEmpty');
    if (empty) empty.style.display = fr.length ? 'none' : '';
    for (const em of fr) {
      const on = online.has(String(em).toLowerCase());
      const row = document.createElement('div'); row.className = 'frRow';
      row.innerHTML = `<span class="frDot${on ? ' on' : ''}"></span>`
        + `<span class="frNm" title="${em}">${em.split('@')[0]}</span>`
        + `<span class="frSt">${on ? '접속 중' : '오프라인'}</span>`
        + `<button class="frDel" title="친구 삭제">✕</button>`;
      row.querySelector('.frDel').addEventListener('click', async () => {
        if (!confirm(`'${em}' 을(를) 친구에서 삭제할까요?`)) return;
        await setFriends(getFriends().filter(x => x !== em)); renderFriendList();
      });
      list.appendChild(row);
      void me; // (자기 자신은 추가 단계에서 걸러짐)
    }
  }
  function showUser(session) {
    curSession = session;
    const name = session?.user?.user_metadata?.username || (session?.user?.email || '').split('@')[0];
    if (!chip) {
      chip = document.createElement('div'); chip.id = 'userChipWrap'; chip.className = 'menuWrap';
      const IC_USER = '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.4"/><path d="M5.2 19.5a6.8 6.8 0 0 1 13.6 0"/></svg>';
      const IC_FRIENDS = '<svg class="ic" viewBox="0 0 24 24"><circle cx="9" cy="8.5" r="3"/><path d="M3.2 19a5.8 5.8 0 0 1 11.6 0"/><circle cx="17" cy="9.5" r="2.4"/><path d="M15.8 14.6a4.9 4.9 0 0 1 5 4.4"/></svg>';
      const IC_OUT = '<svg class="ic" viewBox="0 0 24 24"><path d="M14.5 8V5.5a1.5 1.5 0 0 0-1.5-1.5H6a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 6 20h7a1.5 1.5 0 0 0 1.5-1.5V16M10 12h10.5M17.5 9l3 3-3 3"/></svg>';
      chip.innerHTML = `
        <button class="tbtn tglc" id="userChip" title="마이페이지">${IC_USER} <span id="userName"></span></button>
        <div id="userMenu" class="dropdown">
          <div class="menuItem" id="umPlan" style="cursor:default;opacity:.9;">플랜: <b id="umPlanName" style="margin-left:4px;">무료</b></div>
          <div class="menuSep"></div>
          <button class="menuItem" id="umFriends">${IC_FRIENDS} 친구 <span style="margin-left:auto;opacity:.55;">◀</span></button>
          <div class="menuSep"></div>
          <button class="menuItem" id="umLogout">${IC_OUT} 로그아웃</button>
        </div>
        <div id="friendPanel">
          <h4>친구 — 접속 상태</h4>
          <div id="frEmpty">아직 친구가 없습니다.<br>아래에 이메일을 넣어 추가하세요.</div>
          <div id="frList"></div>
          <div id="frAddRow"><input id="frAdd" type="text" placeholder="친구 이메일"><button class="miniBtn" id="frAddBtn">추가</button></div>
        </div>`;
      document.getElementById('topbar').appendChild(chip);
      const btn = chip.querySelector('#userChip'), menu = chip.querySelector('#userMenu'), fp = chip.querySelector('#friendPanel');
      const toggle = (open) => {
        menu.classList.toggle('open', open === undefined ? !menu.classList.contains('open') : open);
        btn.classList.toggle('on', menu.classList.contains('open'));
        if (!menu.classList.contains('open')) fp.classList.remove('open');
        if (menu.classList.contains('open')) { // 열 때마다 플랜 최신화
          const p = window.WEBCAD_CLOUD && WEBCAD_CLOUD.plan ? WEBCAD_CLOUD.plan() : 'free';
          const el = chip.querySelector('#umPlanName'); if (el) el.textContent = p === 'pro' ? '프로 (PRO)' : '무료 (Free)';
        }
      };
      btn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); toggle(); });
      btn.addEventListener('click', (e) => e.stopPropagation());
      document.addEventListener('pointerdown', () => toggle(false));
      document.addEventListener('click', () => toggle(false));
      for (const el of [menu, fp]) { el.addEventListener('pointerdown', (e) => e.stopPropagation()); el.addEventListener('click', (e) => e.stopPropagation()); }
      chip.querySelector('#umLogout').addEventListener('click', async () => {
        if (!confirm('로그아웃할까요? (작업물은 이 브라우저에 자동 저장되어 있습니다)')) return;
        await sb.auth.signOut(); location.reload();
      });
      chip.querySelector('#umFriends').addEventListener('click', () => {
        fp.classList.toggle('open');
        if (fp.classList.contains('open')) {
          // 패널을 '메뉴의 왼쪽'에 붙인다 — 메뉴는 칩보다 왼쪽으로 더 넓게 펼쳐지므로
          // 칩 기준(right:100%)으로 두면 메뉴를 가린다. 메뉴 폭만큼 더 왼쪽으로.
          fp.style.right = (menu.offsetWidth + 8) + 'px';
          fp.style.top = menu.offsetTop + 'px';
          renderFriendList();
        }
      });
      const doAdd = async () => {
        const inp = chip.querySelector('#frAdd');
        const em = (inp.value || '').trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { alert('이메일 형식으로 입력하세요.'); return; }
        const me = String((curSession && curSession.user && curSession.user.email) || '').toLowerCase();
        if (em === me) { alert('자기 자신은 추가할 수 없습니다.'); return; }
        const fr = getFriends();
        if (fr.includes(em)) { alert('이미 친구 목록에 있습니다.'); return; }
        fr.push(em); await setFriends(fr); inp.value = ''; renderFriendList();
      };
      chip.querySelector('#frAddBtn').addEventListener('click', doAdd);
      chip.querySelector('#frAdd').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') doAdd(); });
    }
    chip.querySelector('#userName').textContent = name;
    chip.style.display = session ? 'inline-flex' : 'none';
    if (session) startPresence(session);
  }
  function setGate(open) {
    gate.classList.toggle('hidden', !open);
    document.body.classList.toggle('authLocked', open); // cad.js가 명령창 자동 포커스를 멈추도록
    if (open) { view = 'login'; render(); }
  }
  // 로비 화면(lobby.js)이 호출하는 API — 로그인 게이트 열고/닫기, 로그아웃
  window.WEBCAD_AUTH_API = {
    showLogin: () => setGate(true),
    hideLogin: () => setGate(false),
    isGateOpen: () => !gate.classList.contains('hidden'),
    signOut: async () => { if (sb) { await sb.auth.signOut(); } location.reload(); },
    _showUser: showUser, // 테스트 훅 — 마이페이지 칩/친구 패널 검증용 (세션 주입)
    _deviceDecision: deviceDecision, // 테스트 훅 — 동시접속 기기 제한 판정(순수 함수)
    _deviceId: () => DEVICE,
  };

  async function init() {
    if (cfg.url) {
      await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js');
      sb = window.supabase.createClient(cfg.url, cfg.anonKey);
    } else sb = mockClient();
    window.WEBCAD_SB = sb; // 클라우드 모듈(cloud.js)이 같은 클라이언트를 사용
    const announce = (s) => window.dispatchEvent(new CustomEvent('webcad-auth', { detail: { session: s } }));
    const { data: { session } } = await sb.auth.getSession();
    setGate(!session); showUser(session); announce(session);
    sb.auth.onAuthStateChange(async (..._a) => {
      const { data: { session: s2 } } = await sb.auth.getSession();
      setGate(!s2); showUser(s2); announce(s2);
    });
  }
  init();
})();
