// ============================================================
//  Parti 클라우드 기능 (auth.js 로그인 + supabase-cloud.sql 필요)
//  도면 클라우드 저장/목록/버전/공유 · 블록 라이브러리 · 설정 동기화
//  오류 수집 · 사용 통계 · 피드백 · 공지 · 플랜
// ============================================================
(() => {
  const API = window.WEBCAD_API;
  if (!API) return;

  let sb = null, user = null, plan = 'free';
  let cloudId = null;          // 현재 열려 있는 클라우드 도면 id
  let lastSavedRev = -1;       // 마지막 클라우드 저장 시점의 변경 카운터
  let setupNeeded = false;     // supabase-cloud.sql 미실행 감지

  // ---------- 스타일 ----------
  const st = document.createElement('style');
  st.textContent = `
  .cdOverlay{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;
    background:rgba(5,8,20,.55);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);}
  html.light .cdOverlay{background:rgba(60,80,130,.25);}
  html.light .cdBtn{background:rgba(30,60,140,.08);}
  html.light .cdBtn:hover{background:rgba(30,60,140,.15);}
  html.light .cdIn{background:rgba(30,60,140,.08);}
  html.light .cdCard{background:rgba(30,60,140,.06);}
  html.light .cdCard:hover{background:rgba(30,60,140,.11);}
  html.light .cdItem{background:rgba(30,60,140,.06);}
  .cdBox{width:min(94vw,560px);max-height:86vh;display:flex;flex-direction:column;
    background:var(--glass-pop,rgba(26,37,64,.92));-webkit-backdrop-filter:saturate(180%) blur(24px);backdrop-filter:saturate(180%) blur(24px);
    border-radius:22px;padding:20px 22px;box-shadow:0 12px 40px rgba(2,6,20,.6);color:var(--text,#f2f5ff);}
  .cdBox h2{margin:0 0 12px;font-size:18px;font-weight:600;letter-spacing:-0.02em;display:flex;align-items:center;gap:8px;}
  .cdBody{flex:1;overflow-y:auto;min-height:60px;}
  .cdRow{display:flex;gap:8px;align-items:center;margin:8px 0;}
  .cdBtn{background:rgba(150,180,255,.10);color:inherit;border:none;border-radius:980px;
    padding:7px 14px;font-size:13px;cursor:pointer;white-space:nowrap;flex:0 0 auto;}
  .cdBtn:hover{background:rgba(150,180,255,.18);}
  .cdBtn.pri{background:var(--accent,#0A84FF);color:#fff;}
  .cdBtn.danger{color:#ff8a80;}
  .cdIn{flex:1;min-width:0;background:rgba(150,180,255,.10);color:inherit;border:none;border-radius:10px;
    padding:8px 12px;font-size:13.5px;user-select:text;-webkit-user-select:text;}
  .cdIn:focus{outline:none;box-shadow:0 0 0 2px var(--accent,#0A84FF);}
  .cdGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;}
  .cdCard{background:rgba(150,180,255,.07);border-radius:14px;padding:10px;transition:background .15s;
    overflow:hidden;display:flex;flex-direction:column;min-width:0;}
  .cdCard:hover{background:rgba(150,180,255,.12);}
  .cdCard img,.cdCard .noThumb{width:100%;height:88px;object-fit:cover;border-radius:9px;background:#0a1020;display:block;}
  .cdCard .nm{font-size:13px;font-weight:590;margin-top:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .cdCard .sub{font-size:10.5px;color:var(--muted,rgba(210,222,250,.6));margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .cdCard .acts{display:flex;gap:5px;margin-top:9px;}
  .cdCard .acts .cdBtn{padding:5px 0;font-size:11.5px;flex:1;text-align:center;border-radius:9px;min-width:0;}
  .cdMuted{color:var(--muted,rgba(210,222,250,.6));font-size:12.5px;line-height:1.6;}
  .cdErr{color:#ff8a80;font-size:12.5px;min-height:16px;margin-top:6px;}
  .cdList{display:flex;flex-direction:column;gap:6px;}
  .cdItem{display:flex;gap:8px;align-items:center;background:rgba(150,180,255,.07);border-radius:11px;padding:8px 12px;font-size:13px;}
  .cdItem .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  #cloudNotice{position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:70;max-width:92vw;
    background:var(--accent,#0A84FF);color:#fff;font-size:13px;padding:9px 16px;border-radius:0 0 14px 14px;
    display:flex;gap:12px;align-items:center;box-shadow:0 6px 24px rgba(2,6,20,.5);}
  #cloudNotice button{background:rgba(255,255,255,.22);border:none;color:#fff;border-radius:980px;padding:4px 12px;cursor:pointer;font-size:12px;}
  .planBadge{display:inline-block;margin-left:5px;padding:1px 8px;border-radius:980px;font-size:10px;font-weight:700;
    background:linear-gradient(90deg,#ffd426,#ff9f0a);color:#3a2a00;vertical-align:1px;}
  `;
  document.head.appendChild(st);

  // ---------- 공통 다이얼로그 ----------
  let curDlg = null;
  function dlg(title, bodyHTML, onOpen) {
    closeDlg();
    const o = document.createElement('div'); o.className = 'cdOverlay';
    o.innerHTML = `<div class="cdBox"><h2>${title}<span style="flex:1"></span>
      <button class="cdBtn" data-x>닫기</button></h2><div class="cdBody">${bodyHTML}</div><div class="cdErr"></div></div>`;
    o.addEventListener('pointerdown', (e) => { if (e.target === o) closeDlg(); e.stopPropagation(); });
    o.querySelector('[data-x]').addEventListener('click', closeDlg);
    o.querySelectorAll('input,textarea').forEach(i => i.addEventListener('keydown', e => e.stopPropagation()));
    document.body.appendChild(o); curDlg = o;
    const bx = o.querySelector('.cdBox');
    if (window.webcadPopupDrag && bx) window.webcadPopupDrag(bx, bx.querySelector('h2')); // 제목줄을 잡고 위치 이동
    if (onOpen) onOpen(o);
    return o;
  }
  function closeDlg() { if (curDlg) { curDlg.remove(); curDlg = null; } }
  const dErr = (m) => { if (curDlg) curDlg.querySelector('.cdErr').textContent = m || ''; };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtT = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

  // 서버 오류 → 한국어
  function koErr(e) {
    const m = (e && (e.message || e.error_description)) || String(e);
    if (/plan_limit/.test(m)) return `무료 플랜은 클라우드 도면 5개까지 저장할 수 있습니다. 기존 도면을 삭제하거나 프로 플랜을 이용하세요.`;
    if (/user_not_found/.test(m)) return '해당 아이디의 사용자를 찾을 수 없습니다.';
    if (/self_share/.test(m)) return '자기 자신에게는 공유할 수 없습니다.';
    if (/no_permission/.test(m)) return '권한이 없습니다.';
    if (/not_signed_in/.test(m)) return '로그인이 필요합니다.';
    if (/42P01|PGRST202|PGRST205|Could not find/.test(m)) { setupNeeded = true; return '서버 설정이 필요합니다 (supabase-cloud.sql 미실행).'; }
    return m;
  }

  // ---------- ① 클라우드 저장 / 내 도면 ----------
  async function saveToCloud(silent, forceName) {
    if (!user) return;
    const doc = API.getDoc();
    if (!doc.data.entities.length && !cloudId) { if (!silent) API.log('  저장할 도형이 없습니다.', 'warn'); return; }
    let name = doc.name;
    if (!cloudId) {
      name = forceName || prompt('클라우드에 저장할 도면 이름:', name || '새 도면');
      if (!name) return;
    }
    try {
      const { data, error } = await sb.rpc('save_drawing', {
        p_id: cloudId, p_name: name, p_data: doc.data, p_thumb: API.thumb(240),
      });
      if (error) throw error;
      const isNew = !cloudId;
      cloudId = data; lastSavedRev = API.getRev();
      API.setName(name || doc.name);
      if (!silent) API.log(`  ☁ 클라우드에 저장됨: "${name || doc.name}"`, 'ok');
      if (isNew) { joinRealtime(cloudId, true); announceActiveDoc(cloudId); } // 저장 즉시 실시간 세션 + 계정 활성 도면 알림
      usage('cloud_save');
    } catch (e) {
      API.log('  ☁ 저장 실패: ' + koErr(e), 'warn');
      if (/plan_limit/.test((e && e.message) || '')) {
        // 무료 한도 도달 → 프로 문의로 유도
        openFeedback();
        setTimeout(() => { const t = document.getElementById('fbMsg'); if (t && !t.value) t.value = '[프로 플랜 문의] 도면 한도를 늘리고 싶습니다.'; }, 50);
      }
    }
  }

  // 도면 열기 — cloudId·실시간 세션 상태가 이 모듈에만 있으므로 로비도 반드시 이 함수를 거쳐야 한다.
  // 밖에서 직접 열면 cloudId가 갱신되지 않아 다음 "클라우드에 저장"이 같은 도면을 새로 하나 더 만든다.
  async function openDrawing(id, canEdit, mine) {
    // 공유 세션 일관성: 다른 도면으로 전환하기 전, 저장 안 된 현재 도면을 먼저 저장한다.
    // (추종으로 여는 경우는 이미 상대가 저장·방송했으므로 생략)
    if (cloudId && cloudId !== id && !followingDoc && API.getRev() !== lastSavedRev) {
      try { await saveToCloud(true); } catch (e) {}
    }
    const { data: row, error } = await sb.from('drawings').select('name,data').eq('id', id).single();
    if (error) throw error;
    API.setDoc(row.name, row.data);
    if (API.zoomFit) API.zoomFit();           // 기기 화면 크기에 맞게 전체보기
    cloudId = id; lastSavedRev = API.getRev();
    API.log(`  ☁ 도면 열기: "${row.name}"${mine ? '' : ' (공유받음)'}`, 'ok');
    usage('cloud_open');
    joinRealtime(id, !!canEdit);              // 실시간 세션 참가
    if (!canEdit) API.log('  👁 읽기 전용 — 상대의 변경이 실시간으로 보이지만 내 수정은 전송/저장되지 않습니다.', 'info');
    if (!followingDoc) announceActiveDoc(id);  // 다른 기기가 이 도면으로 추종하도록 알림
    return row.name;
  }

  async function openDrawingList() {
    dlg('☁ 내 도면', '<div class="cdMuted">불러오는 중…</div>', async (o) => {
      try {
        const { data, error } = await sb.rpc('list_drawings');
        if (error) throw error;
        const body = o.querySelector('.cdBody');
        if (!data.length) { body.innerHTML = '<div class="cdMuted">저장된 도면이 없습니다.<br>파일 메뉴 → "클라우드에 저장"으로 현재 도면을 올려보세요.</div>'; return; }
        body.innerHTML = '<div class="cdGrid">' + data.map(d => `
          <div class="cdCard" data-id="${d.id}" data-mine="${d.is_mine}" data-canedit="${d.can_edit}" data-name="${esc(d.name)}">
            ${d.thumb ? `<img src="${d.thumb}">` : '<div class="noThumb"></div>'}
            <div class="nm">${d.is_mine ? '' : '👥 '}${esc(d.name)}</div>
            <div class="sub">${fmtT(d.updated_at)}${d.is_mine ? '' : ' · ' + esc(d.owner_name || '') + (d.can_edit ? ' · 편집가능' : ' · 읽기전용')}</div>
            <div class="acts">
              <button class="cdBtn pri" data-open>열기</button>
              ${d.is_mine ? '<button class="cdBtn" data-ren>이름변경</button><button class="cdBtn danger" data-del>삭제</button>' : ''}
            </div>
          </div>`).join('') + '</div>';
        body.querySelectorAll('.cdCard').forEach(card => {
          const id = card.dataset.id, mine = card.dataset.mine === 'true';
          card.querySelector('[data-open]').addEventListener('click', async () => {
            try { await openDrawing(id, card.dataset.canedit === 'true', mine); closeDlg(); }
            catch (e) { dErr(koErr(e)); }
          });
          card.querySelector('[data-ren]')?.addEventListener('click', async () => {
            const nn = prompt('새 이름:', card.dataset.name); if (!nn) return;
            const { error: e2 } = await sb.from('drawings').update({ name: nn }).eq('id', id);
            if (e2) return dErr(koErr(e2));
            if (cloudId === id) API.setName(nn);
            openDrawingList();
          });
          card.querySelector('[data-del]')?.addEventListener('click', async () => {
            if (!confirm(`"${card.dataset.name}" 도면을 클라우드에서 삭제할까요? (버전 기록도 함께 삭제됩니다)`)) return;
            const { error: e2 } = await sb.from('drawings').delete().eq('id', id);
            if (e2) return dErr(koErr(e2));
            if (cloudId === id) { cloudId = null; }
            openDrawingList();
          });
        });
      } catch (e) { o.querySelector('.cdBody').innerHTML = `<div class="cdMuted">${esc(koErr(e))}</div>`; }
    });
  }

  // ---------- ② 버전 기록 ----------
  async function openVersions() {
    if (!cloudId) { API.log('  버전 기록은 클라우드에 저장된 도면에서 사용할 수 있습니다. 먼저 "클라우드에 저장"하세요.', 'warn'); return; }
    dlg('🕘 버전 기록', '<div class="cdMuted">불러오는 중…</div>', async (o) => {
      try {
        const { data, error } = await sb.from('drawing_versions')
          .select('id,created_at').eq('drawing_id', cloudId).order('id', { ascending: false });
        if (error) throw error;
        const body = o.querySelector('.cdBody');
        if (!data.length) { body.innerHTML = '<div class="cdMuted">버전이 없습니다.</div>'; return; }
        body.innerHTML = '<div class="cdList">' + data.map((v, i) => `
          <div class="cdItem"><span class="grow">${i === 0 ? '최신 저장본' : (i + 1) + '번째 전 버전'} — ${fmtT(v.created_at)}</span>
          <button class="cdBtn pri" data-v="${v.id}">이 버전 열기</button></div>`).join('') + '</div>' +
          '<div class="cdMuted" style="margin-top:8px;">버전을 열면 화면에 복원됩니다. 유지하려면 다시 "클라우드에 저장"하세요.</div>';
        body.querySelectorAll('[data-v]').forEach(b => b.addEventListener('click', async () => {
          try {
            const { data: row, error: e2 } = await sb.from('drawing_versions').select('data').eq('id', b.dataset.v).single();
            if (e2) throw e2;
            API.setDoc(API.getName(), row.data);
            closeDlg(); API.log('  🕘 버전을 복원했습니다. 유지하려면 클라우드에 저장하세요.', 'ok');
            usage('version_restore');
          } catch (e) { dErr(koErr(e)); }
        }));
      } catch (e) { o.querySelector('.cdBody').innerHTML = `<div class="cdMuted">${esc(koErr(e))}</div>`; }
    });
  }

  // ---------- ③ 공유 ----------
  // idArg 없이 부르면(파일 메뉴) 현재 열린 도면, 있으면(로비) 그 도면을 공유한다
  async function openShare(idArg) {
    const id = (typeof idArg === 'string' && idArg) ? idArg : cloudId;
    if (!id) { API.log('  공유는 클라우드에 저장된 도면에서 사용할 수 있습니다. 먼저 "클라우드에 저장"하세요.', 'warn'); return; }
    dlg('👥 도면 공유', `
      <div class="cdRow"><input class="cdIn" id="shUser" placeholder="공유할 상대의 아이디">
        <label style="font-size:12.5px;display:flex;align-items:center;gap:4px;"><input type="checkbox" id="shEdit">편집 허용</label>
        <button class="cdBtn pri" id="shAdd">공유</button></div>
      <div class="cdList" id="shList"></div>`, async (o) => {
      async function refresh() {
        const { data, error } = await sb.rpc('list_shares', { p_id: id });
        if (error) return dErr(koErr(error));
        o.querySelector('#shList').innerHTML = data.length
          ? data.map(s => `<div class="cdItem"><span class="grow">👤 ${esc(s.username)} — ${s.can_edit ? '편집 가능' : '읽기 전용'}</span>
              <button class="cdBtn danger" data-un="${esc(s.username)}">해제</button></div>`).join('')
          : '<div class="cdMuted">아직 공유한 사람이 없습니다.</div>';
        o.querySelectorAll('[data-un]').forEach(b => b.addEventListener('click', async () => {
          await sb.rpc('unshare_drawing', { p_id: id, p_username: b.dataset.un }); refresh();
        }));
      }
      o.querySelector('#shAdd').addEventListener('click', async () => {
        dErr('');
        const un = o.querySelector('#shUser').value.trim();
        if (!un) return dErr('아이디를 입력하세요.');
        const { error } = await sb.rpc('share_drawing', { p_id: id, p_username: un, p_can_edit: o.querySelector('#shEdit').checked });
        if (error) return dErr(koErr(error));
        o.querySelector('#shUser').value = ''; usage('share'); refresh();
      });
      refresh();
    });
  }

  // ---------- ④ 블록 라이브러리 ----------
  async function openBlockLib() {
    dlg('★ 내 블록 라이브러리', '<div class="cdMuted">불러오는 중…</div>', async (o) => {
      try {
        const { data, error } = await sb.from('user_blocks').select('id,name').order('name');
        if (error) throw error;
        const docBlocks = Object.keys(API.getBlocks());
        const body = o.querySelector('.cdBody');
        body.innerHTML =
          (docBlocks.length ? `<div class="cdMuted" style="margin-bottom:4px;">현재 도면의 블록을 라이브러리에 올리기:</div>
           <div class="cdList">${docBlocks.map(n => `<div class="cdItem"><span class="grow">${esc(n)}</span>
             <button class="cdBtn" data-up="${esc(n)}">↑ 올리기</button></div>`).join('')}</div><hr style="border-color:rgba(170,195,255,.12);margin:12px 0;">` : '') +
          `<div class="cdMuted" style="margin-bottom:4px;">라이브러리 (어느 도면에서나 가져와 사용):</div>` +
          (data.length ? `<div class="cdList">${data.map(b => `<div class="cdItem"><span class="grow">★ ${esc(b.name)}</span>
             <button class="cdBtn pri" data-get="${b.id}" data-name="${esc(b.name)}">↓ 가져오기</button>
             <button class="cdBtn danger" data-rm="${b.id}">삭제</button></div>`).join('')}</div>`
            : '<div class="cdMuted">저장된 블록이 없습니다. 도면에서 블록을 만들고(block 명령) 여기서 올려두세요.</div>');
        body.querySelectorAll('[data-up]').forEach(b => b.addEventListener('click', async () => {
          const n = b.dataset.up;
          const { error: e2 } = await sb.from('user_blocks').upsert({ owner: user.id, name: n, data: API.getBlocks()[n] }, { onConflict: 'owner,name' });
          if (e2) return dErr(koErr(e2));
          usage('block_upload'); openBlockLib();
        }));
        body.querySelectorAll('[data-get]').forEach(b => b.addEventListener('click', async () => {
          const { data: row, error: e2 } = await sb.from('user_blocks').select('name,data').eq('id', b.dataset.get).single();
          if (e2) return dErr(koErr(e2));
          let n = row.name;
          if (API.getBlocks()[n]) n = n + '_lib';
          API.addBlock(n, row.data);
          usage('block_import'); closeDlg();
        }));
        body.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', async () => {
          const { error: e2 } = await sb.from('user_blocks').delete().eq('id', b.dataset.rm);
          if (e2) return dErr(koErr(e2)); openBlockLib();
        }));
      } catch (e) { o.querySelector('.cdBody').innerHTML = `<div class="cdMuted">${esc(koErr(e))}</div>`; }
    });
  }

  // ---------- ⑤ 설정 동기화 ----------
  let setTimer = null;
  async function pullSettings() {
    try {
      const { data, error } = await sb.from('user_settings').select('data').eq('user_id', user.id).maybeSingle();
      if (error) throw error;
      if (data && data.data) API.applySettings(data.data);
      else pushSettings();
    } catch (e) { /* 테이블 없으면 조용히 넘어감 */ }
  }
  function pushSettings() {
    clearTimeout(setTimer);
    setTimer = setTimeout(async () => {
      if (!user) return;
      try { await sb.from('user_settings').upsert({ user_id: user.id, data: API.getSettings(), updated_at: new Date().toISOString() }); } catch (e) {}
    }, 2000);
  }
  API.onSettingsChange = pushSettings;

  // ---------- ⑥ 오류 수집 ----------
  let errSent = 0;
  function reportError(msg, src) {
    if (!sb || errSent >= 5) return; errSent++;
    try { sb.rpc('log_error', { p_message: String(msg), p_source: String(src || '') }).then(() => {}); } catch (e) {}
  }
  window.addEventListener('error', (e) => reportError(e.message, (e.filename || '').split('/').pop() + ':' + e.lineno));
  window.addEventListener('unhandledrejection', (e) => reportError('Promise: ' + (e.reason && e.reason.message || e.reason), ''));

  // ---------- ⑦ 사용 통계 ----------
  const usageBuf = {};
  function usage(ev) { usageBuf[ev] = (usageBuf[ev] || 0) + 1; }
  API.onUsage = usage;
  async function flushUsage() {
    if (!user || !Object.keys(usageBuf).length) return;
    const batch = { ...usageBuf };
    for (const k in usageBuf) delete usageBuf[k];
    try { await sb.rpc('bump_usage', { p_events: batch }); } catch (e) {}
  }
  setInterval(flushUsage, 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushUsage(); });

  // ---------- ⑧ 피드백 ----------
  function openFeedback() {
    dlg('💬 피드백 보내기', `
      <div class="cdMuted" style="margin-bottom:8px;">버그 신고나 기능 제안을 보내주세요. 보낸 사람 아이디가 함께 전달됩니다.</div>
      <textarea class="cdIn" id="fbMsg" rows="5" style="width:100%;resize:vertical;"></textarea>
      <div class="cdRow" style="justify-content:flex-end;"><button class="cdBtn pri" id="fbSend">보내기</button></div>`, (o) => {
      o.querySelector('#fbSend').addEventListener('click', async () => {
        const m = o.querySelector('#fbMsg').value.trim();
        if (m.length < 3) return dErr('내용을 입력해 주세요.');
        const { error } = await sb.rpc('send_feedback', { p_message: m });
        if (error) return dErr(koErr(error));
        closeDlg(); API.log('  💬 피드백이 전송됐습니다. 감사합니다!', 'ok'); usage('feedback');
      });
    });
  }

  // ---------- ⑨ 공지 ----------
  async function showAnnouncements() {
    try {
      const { data, error } = await sb.from('announcements').select('id,message').eq('active', true).order('id', { ascending: false }).limit(3);
      if (error || !data) return;
      const seen = JSON.parse(localStorage.getItem('webcad_seen_notices') || '[]');
      const fresh = data.filter(a => !seen.includes(a.id));
      if (!fresh.length) return;
      const n = document.createElement('div'); n.id = 'cloudNotice';
      n.innerHTML = `<span>📢 ${esc(fresh[0].message)}</span><button>확인</button>`;
      n.querySelector('button').addEventListener('click', () => {
        seen.push(...fresh.map(a => a.id));
        localStorage.setItem('webcad_seen_notices', JSON.stringify(seen.slice(-50)));
        n.remove();
      });
      document.body.appendChild(n);
    } catch (e) {}
  }

  // ---------- ⑩ 플랜 배지 ----------
  // 개발자(소유자) 계정은 항상 최고 플랜으로 고정 — 프로 기능 패치 적용 여부를 바로 확인하기 위함.
  // (클라이언트 측 표시/게이팅 전용. 서버 강제는 my_plan RPC 가 담당.)
  const OWNER_EMAILS = ['ghkdtksgh3430@gmail.com'];
  const TOP_PLAN = 'pro'; // 현재 최상위 티어
  async function loadPlan() {
    try {
      const { data, error } = await sb.rpc('my_plan');
      if (!error && data) plan = data;
      if (user && OWNER_EMAILS.includes(String(user.email || '').toLowerCase())) plan = TOP_PLAN;
      if (plan === 'pro') {
        const un = document.getElementById('userName');
        if (un && !un.querySelector('.planBadge')) un.insertAdjacentHTML('afterend', '<span class="planBadge">PRO</span>');
      }
    } catch (e) {}
  }

  // ---------- 실시간 공동편집 (같은 클라우드 도면을 연 사용자끼리 동기화) ----------
  const clientId = Math.random().toString(36).slice(2, 10);
  let rtChan = null, rtLast = null, rtRev = -1, rtCanEdit = false, rtGreeted = false;
  let rtBlocksHash = '', rtLayersHash = '';
  const hash = (o) => { try { return JSON.stringify(o); } catch (e) { return ''; } };
  function rtSnapshot() {
    const m = new Map();
    for (const e of API.getDoc().data.entities) m.set(e.id, JSON.stringify(e));
    return m;
  }
  function rtChip(text) {
    let c = document.getElementById('rtChip');
    if (!text) { if (c) c.style.display = 'none'; return; }
    if (!c) {
      c = document.createElement('span'); c.id = 'rtChip'; c.className = 'tbtn';
      c.style.cssText = 'cursor:default;background:rgba(48,209,88,.16);';
      document.getElementById('topbar').appendChild(c);
    }
    c.style.display = ''; c.textContent = text;
  }
  function joinRealtime(id, canEdit) {
    leaveRealtime();
    if (!sb.channel) return; // 구버전/스텁 환경 보호
    rtCanEdit = canEdit; rtGreeted = false;
    API.jitterNextId(); // id 충돌 회피
    rtLast = rtSnapshot(); rtRev = API.getRev();
    rtBlocksHash = hash(API.getBlocks()); rtLayersHash = hash(API.getDoc().data.layers);
    const uname = (user.user_metadata && user.user_metadata.username) || '사용자';
    rtChan = sb.channel('drawing:' + id, { config: { broadcast: { self: false }, presence: { key: clientId } } });
    rtChan.on('broadcast', { event: 'ops' }, ({ payload }) => {
      if (!payload || payload.c === clientId) return;
      if (payload.req) { if (rtCanEdit) sendFullState(); return; } // 신규 기기의 전체상태 요청 → 현재 상태 전송
      API.applyRemote(payload.ups, payload.dels, payload.blocks, payload.layers);
      // 원격 반영분이 다시 방송되지 않도록 기준 스냅샷 갱신
      rtLast = rtSnapshot(); rtRev = API.getRev();
      if (payload.blocks) rtBlocksHash = hash(API.getBlocks());
      if (payload.layers) rtLayersHash = hash(API.getDoc().data.layers);
    });
    rtChan.on('presence', { event: 'sync' }, () => {
      const stt = rtChan.presenceState();
      const names = Object.values(stt).flat().map(p => p.u).filter(Boolean);
      rtChip(names.length > 1 ? `🟢 실시간 ${names.length}명: ${names.join(', ')}` : '🟢 실시간 대기 중');
      // 기존 세션에 '새로' 합류했으면 기존 편집자에게 전체 상태를 요청해 현재 화면과 정확히 일치시킨다
      if (!rtGreeted && Object.keys(stt).some(k => k !== clientId)) {
        rtGreeted = true;
        setTimeout(() => { try { rtChan.send({ type: 'broadcast', event: 'ops', payload: { c: clientId, req: true } }); } catch (e) {} }, 150);
      }
    });
    rtChan.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') { try { await rtChan.track({ u: uname }); } catch (e) {} }
    });
    usage('realtime_join');
  }
  function leaveRealtime() {
    if (rtChan) { try { sb.removeChannel(rtChan); } catch (e) {} rtChan = null; }
    rtChip(null);
  }
  // 변경 감시 → 엔티티 단위 diff 방송 (편집 권한 있을 때만 송신)
  setInterval(() => {
    if (!rtChan || !rtCanEdit || API.getRev() === rtRev) return;
    rtRev = API.getRev();
    const cur = rtSnapshot();
    const ups = [], dels = [];
    for (const [id, s] of cur) if (rtLast.get(id) !== s) ups.push(JSON.parse(s));
    for (const id of rtLast.keys()) if (!cur.has(id)) dels.push(id);
    rtLast = cur;
    const payload = { c: clientId, ups, dels };
    const bh = hash(API.getBlocks()); if (bh !== rtBlocksHash) { rtBlocksHash = bh; payload.blocks = API.getBlocks(); }
    const lh = hash(API.getDoc().data.layers); if (lh !== rtLayersHash) { rtLayersHash = lh; payload.layers = API.getDoc().data.layers; }
    if (ups.length || dels.length || payload.blocks || payload.layers)
      try { rtChan.send({ type: 'broadcast', event: 'ops', payload }); } catch (e) {}
  }, 700);

  // ---------- 계정 실시간 세션: 한 계정의 모든 활성 기기가 '같은 활성 도면'을 공유 ----------
  // 요청: PC·모바일이 똑같은 작업물이어야 한다. 마지막에 연 도면을 모든 기기가 추종하고,
  // 로그인 기기에 저장 안 된 로컬 작업이 있으면 유실 없이 별도 도면으로 저장한 뒤 공유 세션에 합류한다.
  let acctChan = null, followingDoc = false, acctResolved = false;
  // 신규 합류 기기에 현재 전체 상태를 즉시 전달(늦게 켠 기기도 상대 화면과 정확히 일치)
  function sendFullState() {
    if (!rtChan) return;
    const d = API.getDoc().data;
    try {
      rtChan.send({ type: 'broadcast', event: 'ops',
        payload: { c: clientId, ups: d.entities, dels: [], blocks: API.getBlocks(), layers: d.layers, full: true } });
    } catch (e) {}
  }
  // 내가 연 도면을 계정의 활성 도면으로 알림 → 다른 기기가 추종
  function announceActiveDoc(id) {
    if (!id) return;
    if (acctChan) {
      try { acctChan.track({ doc: id, cid: clientId, at: Date.now() }); } catch (e) {}
      try { acctChan.send({ type: 'broadcast', event: 'active-doc', payload: { id, cid: clientId } }); } catch (e) {}
    }
    try { if (sb.auth && sb.auth.updateUser) sb.auth.updateUser({ data: { active_doc: id } }); } catch (e) {} // 재로그인 이어받기용
  }
  // 다른 기기가 연 도면으로 조용히 추종(추종 중엔 재방송/현재도면 저장을 하지 않는다)
  async function followOpen(id) {
    if (!id || id === cloudId) return;
    followingDoc = true;
    try { await openDrawing(id, true, true); } catch (e) { API.log('  실시간: 활성 도면을 여는 데 실패했습니다.', 'warn'); }
    followingDoc = false;
  }
  // 로그인 시 시작 도면 결정
  async function resolveInitialDoc(peerDoc) {
    if (peerDoc) { await followOpen(peerDoc); return; }                 // 다른 기기가 작업 중 → 그 도면에 합류
    const doc = API.getDoc();
    if (!cloudId && doc.data.entities.length) {                         // 저장 안 된 로컬 작업 → 유실 없이 저장 후 공유
      await saveToCloud(true, '내 작업 ' + new Date().toLocaleDateString());
      if (cloudId) announceActiveDoc(cloudId);
      return;
    }
    const last = user && user.user_metadata && user.user_metadata.active_doc;
    if (!cloudId && last) { try { await openDrawing(last, true, true); announceActiveDoc(cloudId); } catch (e) {} }
  }
  function startAccountSync() {
    if (acctChan || !sb || !sb.channel || !user || !user.id) return;
    acctChan = sb.channel('acct:' + user.id, { config: { broadcast: { self: false }, presence: { key: clientId } } });
    acctChan.on('broadcast', { event: 'active-doc' }, ({ payload }) => {
      if (!payload || payload.cid === clientId) return;
      if (payload.id && payload.id !== cloudId) followOpen(payload.id);
    });
    acctChan.on('presence', { event: 'sync' }, () => {
      if (acctResolved) return; acctResolved = true;                    // 최초 sync 1회로 시작 도면 결정
      const st = acctChan.presenceState() || {};
      const peers = Object.values(st).flat().filter(p => p && p.cid && p.cid !== clientId);
      resolveInitialDoc((peers.find(p => p.doc) || {}).doc || null);
    });
    acctChan.subscribe((s) => { if (s === 'SUBSCRIBED') { try { acctChan.track({ doc: cloudId || null, cid: clientId, at: Date.now() }); } catch (e) {} } });
  }

  // ---------- Ctrl+S: 클라우드 도면이면 클라우드에 저장 ----------
  window.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey && ev.key.toLowerCase() === 's' && user && cloudId) {
      ev.preventDefault(); ev.stopPropagation();
      saveToCloud(false);
      API.log('  (DXF 파일로 내보내려면 파일 메뉴 → 저장(DXF))', 'info');
    }
  }, true);

  // ---------- 창 숨김/전환 시 미저장분 즉시 저장 ----------
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && user && cloudId && API.getRev() !== lastSavedRev) saveToCloud(true);
  });

  // ---------- 미저장 표시(●) — 파일명 옆 ----------
  setInterval(() => {
    const fn = document.getElementById('fileName');
    if (!fn) return;
    let dot = document.getElementById('dirtyDot');
    const dirty = user && cloudId && API.getRev() !== lastSavedRev;
    if (dirty && !dot) {
      dot = document.createElement('span'); dot.id = 'dirtyDot';
      dot.textContent = ' ●'; dot.title = '클라우드에 저장되지 않은 변경 (Ctrl+S)';
      dot.style.cssText = 'color:#ffd426;font-size:11px;';
      fn.appendChild(dot);
    } else if (!dirty && dot) dot.remove();
  }, 2000);

  // ---------- 자동 클라우드 저장 (클라우드 도면이 열려 있고 변경된 경우, 2분마다) ----------
  setInterval(() => {
    if (user && cloudId && API.getRev() !== lastSavedRev) saveToCloud(true);
  }, 120000);

  // ---------- 도면 전환 시 클라우드 연결 해제 ----------
  API.onDocChange = () => { cloudId = null; lastSavedRev = -1; leaveRealtime(); };

  // ---------- 메뉴 통합 ----------
  function addMenuItem(menuId, html, fn) {
    const menu = document.getElementById(menuId); if (!menu) return;
    const b = document.createElement('button');
    b.className = 'menuItem'; b.innerHTML = html;
    b.addEventListener('click', () => { menu.classList.remove('open'); fn(); });
    menu.appendChild(b);
  }
  function buildMenus() {
    const sep = document.createElement('div'); sep.className = 'menuSep';
    document.getElementById('fileMenu')?.appendChild(sep);
    addMenuItem('fileMenu', '<svg class="ic" viewBox="0 0 24 24"><path d="M7.5 19a4 4 0 0 1-.4-7.98A5.2 5.2 0 0 1 17 9.2a3.6 3.6 0 0 1-.6 9.8"/><path d="M12 16.5v-5"/><path d="M9.8 13.2L12 11l2.2 2.2"/></svg>클라우드에 저장', () => saveToCloud(false));
    addMenuItem('fileMenu', '<svg class="ic" viewBox="0 0 24 24"><path d="M9 4h6l4 4v9a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M15 4v4h4"/><path d="M5 8v10a1 1 0 0 0 1 1h9"/></svg>내 도면…', openDrawingList);
    addMenuItem('fileMenu', '<svg class="ic" viewBox="0 0 24 24"><path d="M4.5 9A8 8 0 1 1 4 13"/><path d="M4.5 4.5V9H9"/><path d="M12 8v4.5l3 1.8"/></svg>버전 기록…', openVersions);
    addMenuItem('fileMenu', '<svg class="ic" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 5.2a3 3 0 0 1 0 5.6"/><path d="M17 13.5a5.5 5.5 0 0 1 3.5 5.5"/></svg>공유…', openShare);
    addMenuItem('optMenu', '<svg class="ic" viewBox="0 0 24 24"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5"/><path d="M12 12v9"/></svg>블록 라이브러리…', openBlockLib);
    addMenuItem('optMenu', '<svg class="ic" viewBox="0 0 24 24"><path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9.5L5 20v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><path d="M8 9.5h8"/><path d="M8 12.5h5"/></svg>피드백 보내기…', openFeedback);
  }

  // ---------- 로비(lobby.js)용 공개 API ----------
  // 도면 목록·열기·이름변경·삭제·공유를 로비에서도 쓰지만, cloudId 같은 상태가
  // 이 모듈에 있으므로 로비가 supabase를 직접 부르지 않고 여기를 거치게 한다.
  window.WEBCAD_CLOUD = {
    ready: () => !!(sb && user),
    list: async () => {
      const { data, error } = await sb.rpc('list_drawings');
      if (error) throw error;
      return data || [];
    },
    open: openDrawing,
    rename: async (id, name) => {
      const { error } = await sb.from('drawings').update({ name }).eq('id', id);
      if (error) throw error;
      if (cloudId === id) API.setName(name);
    },
    remove: async (id) => {
      const { error } = await sb.from('drawings').delete().eq('id', id);
      if (error) throw error;
      if (cloudId === id) cloudId = null;
    },
    share: openShare,
    plan: () => plan,
    err: koErr,
  };

  // ---------- 초기화 (로그인 준비 후) ----------
  let built = false;
  window.addEventListener('webcad-auth', async (ev) => {
    sb = window.WEBCAD_SB;
    const session = ev.detail && ev.detail.session;
    user = session ? session.user : null;
    if (!user) return;
    if (!built) { built = true; buildMenus(); }
    usage('session');
    pullSettings();
    await loadPlan();                 // 플랜을 읽고 나서 알려야 로비가 옛 값('free')을 그리지 않는다
    window.dispatchEvent(new CustomEvent('webcad-cloud-ready'));
    showAnnouncements();              // 공지는 로비를 막지 않게 기다리지 않는다
    startAccountSync();               // 계정의 모든 활성 기기가 '같은 활성 도면'을 실시간 공유
  });
})();
