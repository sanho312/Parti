#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// parti-mcp 서버 회귀 —  node parti-mcp/test.js
//
// tests.html 은 브라우저 전용이라 서버 쪽(MCP 프로토콜·정적 서빙·브리지·LAN 토큰)을
// 볼 수 없다. 그 자리를 이 파일이 메운다. 브라우저 없이 돈다.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const { spawn } = require('node:child_process');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, 'server.js');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const group = (n) => console.log('\n▷ ' + n);

function start(port, extraArgs, envMore) {
  // 기본은 --no-open: 회귀를 돌릴 때마다 진짜 브라우저 창이 뜨면 안 된다.
  // 자동 열기 자체를 검사할 때만 envMore.PARTI_MCP_OPEN_CMD 로 실행기를 갈아 끼워 연다.
  const args = envMore && envMore.PARTI_MCP_OPEN_CMD ? [SERVER] : [SERVER, '--no-open'];
  const p = spawn(process.execPath, args.concat(extraArgs || []), {
    env: Object.assign({ ...process.env, PARTI_MCP_PORT: String(port), PARTI_ROOT: ROOT,
      PARTI_MCP_TIMEOUT: '4000' }, envMore || {}),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const st = { proc: p, msgs: [], err: '', buf: '' };
  p.stdout.on('data', (c) => {
    st.buf += c.toString();
    let nl;
    while ((nl = st.buf.indexOf('\n')) >= 0) {
      const line = st.buf.slice(0, nl); st.buf = st.buf.slice(nl + 1);
      if (!line.trim()) continue;
      try { st.msgs.push(JSON.parse(line)); } catch (e) { st.msgs.push({ __PARSE_FAIL: line.slice(0, 200) }); }
    }
  });
  p.stderr.on('data', (c) => { st.err += c.toString(); });
  st.send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
  st.got = (id) => st.msgs.find(m => m.id === id);
  return st;
}

const lanIP = () => {
  for (const l of Object.values(os.networkInterfaces()))
    for (const ni of (l || [])) if (ni.family === 'IPv4' && !ni.internal) return ni.address;
  return null;
};

(async () => {
  // ═══ ① MCP 프로토콜 · 브리지 왕복 ═══════════════════════════════════════
  const PORT = 7399;
  const S = start(PORT);
  await wait(800);

  group('MCP 핸드셰이크');
  S.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  await wait(300);
  const init = S.got(1);
  ok(init && init.result, 'initialize 응답');
  ok(init && init.result.protocolVersion === '2025-06-18', '  요청한 프로토콜 버전을 그대로 돌려준다');
  ok(init && init.result.capabilities && init.result.capabilities.tools, '  tools capability 선언');
  const ins = (init && init.result.instructions) || '';
  ok(/개체 스키마/.test(ins), '  instructions 에 개체 스키마가 실려 있다');
  ok(/실행취소 1단계/.test(ins), '  instructions 에 undo 규약이 실려 있다');
  // ★노드 어휘는 길고 가끔 쓴다 — 매 세션 상주시키면 컨텍스트만 축낸다
  ok(!/노드 사전|arrayL/.test(ins), '★노드 어휘는 instructions 에 없다 (get_node_reference 로 꺼낸다)');

  group('도구 목록');
  S.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  S.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await wait(300);
  const tools = ((S.got(2) || {}).result || {}).tools || [];
  ok(tools.length >= 20, tools.length + '개');
  ok(tools.every(t => t.name && t.description && t.inputSchema && t.inputSchema.type === 'object'),
    '  전부 name·description·inputSchema(object)');
  const names = tools.map(t => t.name);
  ok(new Set(names).size === names.length, '  이름 중복 없음');
  for (const n of ['get_drawing', 'add_entities', 'get_screenshot', 'inspect', 'run_command',
    'build_massing', 'trace_concept', 'undo', 'export_drawing', 'get_node_reference']) ok(names.includes(n), '  ' + n);

  group('브라우저가 없을 때');
  S.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_drawing', arguments: {} } });
  await wait(300);
  ok(S.got(3) && S.got(3).result.isError === true, '도구 호출은 isError 로 실패한다');
  ok(S.got(3) && new RegExp('127\\.0\\.0\\.1:' + PORT).test(JSON.stringify(S.got(3).result)),
    '  ★열어야 할 주소를 알려 준다 (사용자가 무엇을 해야 하는지 알 수 있게)');
  S.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  S.send({ jsonrpc: '2.0', id: 5, method: 'ping' });
  S.send({ jsonrpc: '2.0', id: 6, method: 'resources/list' });
  await wait(300);
  ok(S.got(4) && S.got(4).result.isError === true, '알 수 없는 도구도 isError');
  ok(S.got(5) && S.got(5).result, 'ping');
  ok(S.got(6) && S.got(6).error && S.got(6).error.code === -32601, '미지원 메서드는 -32601');

  group('상태 — 어느 조각이 빠졌는지 알려 준다');
  // ★브라우저 패널이 "왜 로컬 모드지?" 에 답하려면, 서버가 Claude 쪽 상태까지 알려 줘야 한다.
  //   서버만 떠 있고 Claude 는 안 붙은 상태가 사용자가 가장 헷갈리는 지점이다.
  {
    const st = await fetch('http://127.0.0.1:' + PORT + '/bridge/status').then(r => r.json());
    ok(st.claude === true, '★initialize 를 받았으면 claude:true');
    ok(st.client && st.client.name === 't', '  붙은 클라이언트 이름을 알려 준다 (' + (st.client && st.client.name) + ')');
    ok(st.connected === false, '  브라우저는 아직 안 붙었다고 구분해서 알려 준다');
    ok(st.root && st.port === PORT, '  작업본 경로와 포트 (패널이 등록 명령을 조립하는 데 쓴다)');
    ok(typeof st.lan === 'boolean', '  LAN 모드 여부');
  }
  {
    // Claude 가 안 붙은 서버는 claude:false 여야 한다 — 위 값이 상수가 아님을 확인
    const F = start(7394);
    await wait(700);
    const st2 = await fetch('http://127.0.0.1:7394/bridge/status').then(r => r.json());
    ok(st2.claude === false, '★initialize 전에는 claude:false (항상 true 를 내는 게 아니다)');

    // ★브리지만 붙은 상태 → 나중에 Claude 가 붙는 상태. 두 번 다 브라우저에 알려 줘야 한다.
    //   (알려 주지 않으면 패널은 영영 '브리지만 붙음' 에 머문다)
    const r2 = (await fetch('http://127.0.0.1:7394/bridge/events')).body.getReader();
    const d2 = new TextDecoder(); let b2 = '';
    const read2 = async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 4000) {
        const m2 = b2.match(/data: (\{.*?\})\n\n/);
        if (m2) { b2 = b2.slice(m2.index + m2[0].length); const o = JSON.parse(m2[1]); if (o.state) return o.state; continue; }
        const { value, done } = await r2.read(); if (done) return null;
        b2 += d2.decode(value, { stream: true });
      }
      return null;
    };
    const sA = await read2();
    ok(sA && sA.claude === false, '★Claude 가 안 붙었으면 state.claude:false 로 알려 준다');
    F.send({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'late', version: '1' } } });
    const sB = await read2();
    ok(sB && sB.claude === true && sB.client.name === 'late',
      '★Claude 가 나중에 붙어도 열려 있던 탭에 곧바로 알려 준다');
    try { r2.cancel(); } catch (e) {}
    F.proc.kill();
  }

  group('브라우저 자동 열기 — 사용자가 주소를 직접 열지 않아도 된다');
  // ★사용자가 할 일을 하나로 줄이는 핵심. 다만 (a) 이미 붙은 탭이 있으면 안 열고,
  //   (b) --no-open 이면 안 열어야 한다 — 회귀가 진짜 창을 띄우면 안 되므로.
  {
    // (a) 아무도 안 붙었으면 연다 — 실행기는 테스트용으로 갈아 끼운다
    const O = start(7393, [], { PARTI_MCP_OPEN_CMD: 'node' });
    await wait(2600);
    ok(/브라우저를 엽니다/.test(O.err), '★붙은 탭이 없으면 브라우저를 대신 연다');
    ok(/http:\/\/127\.0\.0\.1:7393\//.test(O.err), '  자기 주소를 연다');
    ok(!/이미 열려/.test(O.err), '  (붙은 탭이 없는 경우)');
    O.proc.kill();
  }
  {
    // (b) 이미 붙어 있으면 열지 않는다
    const O2 = start(7392, [], { PARTI_MCP_OPEN_CMD: 'node' });
    await wait(400);
    const sse = await fetch('http://127.0.0.1:7392/bridge/events');
    await wait(2200);
    ok(/이미 열려 있는 Parti 탭/.test(O2.err), '★이미 붙은 탭이 있으면 새 창을 열지 않는다');
    ok(!/브라우저를 엽니다/.test(O2.err), '  중복 창이 뜨지 않는다');
    try { sse.body.cancel(); } catch (e) {}
    O2.proc.kill();
  }
  ok(!/브라우저를 엽니다/.test(S.err), '★--no-open 이면 열지 않는다 (회귀가 창을 띄우지 않는다)');

  group('정적 서빙');
  const html = await fetch('http://127.0.0.1:' + PORT + '/').then(r => r.text());
  ok(/<title>/i.test(html), 'GET / 이 Parti index.html 을 준다');
  ok(/mcp\.js/.test(html), '  ★index.html 에 mcp.js 가 배선돼 있다 (빠지면 브리지가 영영 안 붙는다)');
  const js = await fetch('http://127.0.0.1:' + PORT + '/arch.js');
  ok(js.ok && (js.headers.get('content-type') || '').includes('javascript'), 'arch.js — content-type javascript');
  const esc = await fetch('http://127.0.0.1:' + PORT + '/../../Windows/win.ini');
  ok(esc.status === 403 || esc.status === 404, '경로 탈출 차단 (' + esc.status + ')');

  group('브리지 왕복');
  const es = await fetch('http://127.0.0.1:' + PORT + '/bridge/events');
  const reader = es.body.getReader(); const dec = new TextDecoder(); let sse = '';
  const nextMsg = async (pred) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) {
      const m0 = sse.match(/data: (\{.*?\})\n\n/);
      if (m0) {
        sse = sse.slice(m0.index + m0[0].length);
        const o = JSON.parse(m0[1]); if (pred(o)) return o;
        continue;
      }
      const { value, done } = await reader.read();
      if (done) return null;
      sse += dec.decode(value, { stream: true });
    }
    return null;
  };
  const nextCall = () => nextMsg(o => !!o.id);
  const reply = (id, body) => fetch('http://127.0.0.1:' + PORT + '/bridge/result', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ id }, body)) });
  await wait(200);
  ok((await fetch('http://127.0.0.1:' + PORT + '/bridge/status').then(r => r.json())).connected === true,
    'SSE 연결 후 status.connected');

  // ★붙자마자 'Claude 가 붙었는가' 를 알려 준다.
  //   이게 없으면 브라우저는 브리지 연결만 보고 "Claude Code 창에 말하세요" 라고 안내하게 되는데,
  //   정작 Claude 가 안 붙어 있으면 그건 사용자가 실제로 겪은 그 거짓말이다.
  {
    const s0 = await nextMsg(o => !!o.state);
    ok(s0 && s0.state.claude === true, '★SSE 가 붙는 즉시 state 를 보낸다 (claude:true)');
    ok(s0 && s0.state.client && s0.state.client.name === 't', '  어느 클라이언트인지도 함께');
  }

  S.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'measure', arguments: {} } });
  const c1 = await nextCall();
  ok(c1 && c1.name === 'measure', 'SSE 로 도구 호출이 내려온다');
  await reply(c1.id, { ok: true, result: { count: 3 } });
  await wait(250);
  ok(S.got(7) && !S.got(7).result.isError && /"count": 3/.test(S.got(7).result.content[0].text),
    '결과가 MCP 응답으로 돌아온다');

  // ★스크린샷의 특수 반환형 — 모양을 바꾸면 이미지가 조용히 텍스트로 나간다
  S.send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'get_screenshot', arguments: {} } });
  const c2 = await nextCall();
  await reply(c2.id, { ok: true, result: { __image: 'QUJD', __media: 'image/jpeg', note: '2D 평면 뷰' } });
  await wait(250);
  const r8 = S.got(8);
  ok(r8 && r8.result.content[0].type === 'image', '★{__image,__media} 가 MCP image 블록이 된다');
  ok(r8 && r8.result.content[0].mimeType === 'image/jpeg' && r8.result.content[0].data === 'QUJD', '  data·mimeType 보존');
  ok(r8 && r8.result.content[1] && /2D 평면/.test(r8.result.content[1].text), '  note 가 텍스트로 따라간다');

  S.send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'undo', arguments: {} } });
  const c3 = await nextCall();
  await reply(c3.id, { ok: false, error: '되돌릴 것이 없습니다' });
  await wait(250);
  ok(S.got(9) && S.got(9).result.isError === true && /되돌릴/.test(S.got(9).result.content[0].text),
    '브라우저 쪽 오류가 isError 로 전달된다');

  group('붙이기 모드 — 포트를 잡지 않고 본체에 얹힌다');
  // ★코워커 채팅이 띄우는 헤드리스 Claude 도 parti 도구가 필요하다. 평범하게 띄우면 두 번째
  //   서버가 같은 포트를 잡으려다 실패해 브리지 없는 껍데기가 된다 — 그 사고를 못박는다.
  {
    const A = start(7391 /* 값은 무시된다 */, ['--attach=http://127.0.0.1:' + PORT]);
    await wait(600);
    ok(/붙이기 모드/.test(A.err), '붙이기 모드로 떴다');
    ok(!/Parti 를 서빙합니다/.test(A.err), '★HTTP 를 열지 않는다 (포트 충돌이 날 수 없다)');
    A.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'headless', version: '1' } } });
    await wait(200);
    ok(A.got(1) && A.got(1).result, '  MCP 핸드셰이크는 그대로 된다');
    A.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'measure', arguments: { what: 'x' } } });
    const ca = await nextCall();
    ok(ca && ca.name === 'measure', '★붙이기 모드의 도구 호출이 본체를 거쳐 브라우저까지 온다');
    ok(ca && ca.input && ca.input.what === 'x', '  인자가 그대로 전달된다');
    await reply(ca.id, { ok: true, result: { len: 42 } });
    await wait(300);
    ok(A.got(2) && !A.got(2).result.isError && /42/.test(JSON.stringify(A.got(2).result)),
      '  결과가 붙이기 서버까지 되돌아온다');
    // 실패도 실패로 전달돼야 한다 — 조용히 성공으로 둔갑하면 Claude 가 헛일을 한다
    A.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'undo', arguments: {} } });
    const cb = await nextCall();
    await reply(cb.id, { ok: false, error: '되돌릴 것이 없습니다' });
    await wait(300);
    ok(A.got(3) && A.got(3).result.isError === true && /되돌릴/.test(JSON.stringify(A.got(3).result)),
      '★브라우저 쪽 오류가 붙이기 모드에서도 isError 로 온다');
    A.proc.kill();
  }

  group('stdout 계약');
  // ★stdout 은 MCP 채널이다. console.log 하나면 클라이언트가 파싱에 실패한다.
  ok(!S.msgs.some(m => m.__PARSE_FAIL), '★stdout 에 JSON-RPC 아닌 것이 섞이지 않았다');
  ok(S.err.includes('[parti-mcp]'), '진단은 stderr 로 나간다');
  try { reader.cancel(); } catch (e) {}
  S.proc.kill();

  // ═══ ② LAN 모드 · 페어링 토큰 ═════════════════════════════════════════════
  group('LAN 모드 — 토큰이 문을 지킨다');
  const LP = 7398;
  const L = start(LP, ['--lan']);
  await wait(900);
  const m = L.err.match(/\?t=([A-Za-z0-9_-]+)/);
  ok(!!m, 'LAN 주소를 토큰과 함께 출력한다');
  const TOKEN = m ? m[1] : '';
  ok(TOKEN.length >= 12, '  토큰이 추측하기 어렵다 (' + TOKEN.length + '자)');
  ok(/화면 공유·캡처 시 주의/.test(L.err), '★토큰 노출 주의를 안내한다');

  ok((await fetch('http://127.0.0.1:' + LP + '/bridge/status')).ok,
    '루프백은 토큰 없이 통과 (같은 PC 안에서 온 것은 신뢰)');

  const ip = lanIP();
  if (!ip) console.log('  (외부 IPv4 없음 — LAN 접속 검사는 건너뜀)');
  else {
    ok((await fetch('http://' + ip + ':' + LP + '/bridge/events')).status === 403,
      '★LAN 에서 토큰 없이 /bridge/events → 403');
    ok((await fetch('http://' + ip + ':' + LP + '/bridge/events?t=wrong')).status === 403,
      '★틀린 토큰도 403');
    ok((await fetch('http://' + ip + ':' + LP + '/bridge/result', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{"id":1,"ok":true,"result":1}' })).status === 403,
      '★결과 회신 창구도 토큰이 없으면 403 (여기가 열리면 남이 결과를 위조할 수 있다)');
    // ★도구 대행 창구와 코워커 채팅도 같은 문을 써야 한다 — 하나라도 열리면 남이 도면을 만진다
    ok((await fetch('http://' + ip + ':' + LP + '/bridge/call', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{"name":"undo","input":{}}' })).status === 403,
      '★도구 대행(/bridge/call)도 토큰이 없으면 403');
    ok((await fetch('http://' + ip + ':' + LP + '/coworker/ask', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{"text":"hi"}' })).status === 403,
      '★코워커 채팅(/coworker/ask)도 토큰이 없으면 403 (남이 내 계정으로 Claude 를 돌릴 수 있다)');
    ok((await fetch('http://' + ip + ':' + LP + '/coworker/stop', { method: 'POST' })).status === 403,
      '★코워커 중단도 토큰이 없으면 403');
    ok((await fetch('http://' + ip + ':' + LP + '/')).ok,
      '  정적 파일은 토큰 없이도 준다 (앱만으로는 도면을 만질 수 없다)');
    const good = await fetch('http://' + ip + ':' + LP + '/bridge/events?t=' + TOKEN);
    ok(good.ok && (good.headers.get('content-type') || '').includes('event-stream'),
      '★올바른 토큰이면 LAN 에서 SSE 가 열린다');
    ok((await fetch('http://127.0.0.1:' + LP + '/bridge/status').then(r => r.json())).connected === true,
      '  그 기기가 활성 클라이언트가 된다');
    try { good.body.cancel(); } catch (e) {}
  }
  L.proc.kill();

  // ═══ ③ 기본은 루프백만 ════════════════════════════════════════════════════
  group('기본(--lan 없음)은 바깥에 열지 않는다');
  const DP = 7397;
  const D = start(DP);
  await wait(800);
  ok(!/LAN 모드/.test(D.err), '  LAN 안내를 하지 않는다');
  if (ip) {
    let reachable = true;
    try { await fetch('http://' + ip + ':' + DP + '/', { signal: AbortSignal.timeout(1500) }); }
    catch (e) { reachable = false; }
    ok(!reachable, '★LAN 주소로는 닿지 않는다 (127.0.0.1 에만 바인딩)');
  }
  D.proc.kill();

  // ═══ ④ 코워커 채팅 — 입력창의 자연어가 헤드리스 Claude 까지 갔다 오는가 ══════
  // ★진짜 Claude 를 돌리지 않는다(느리고 돈이 든다). PARTI_CLAUDE_BIN/ARGS 로 가짜 실행기를
  //   끼워 배관 전체 — 인자 조립 · 스트림 파싱 · SSE 중계 · 대화 이어가기 — 를 검사한다.
  group('코워커 채팅 — 입력창 → claude -p → SSE');
  const FAKE = path.join(__dirname, 'test-fake-claude.js');
  const argvLog = path.join(os.tmpdir(), 'parti-fake-argv-' + process.pid + '.txt');
  try { fs.unlinkSync(argvLog); } catch (e) {}
  const chatEnv = { PARTI_CLAUDE_BIN: process.execPath,
    PARTI_CLAUDE_ARGS: JSON.stringify([FAKE]), PARTI_FAKE_ARGV: argvLog };
  const KP = 7396;
  const K = start(KP, [], chatEnv);
  await wait(700);
  {
    const es2 = await fetch('http://127.0.0.1:' + KP + '/bridge/events');
    const rd = es2.body.getReader(); const dc = new TextDecoder(); let bf = '';
    const frames = [];
    const pump = async (ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const mm = bf.match(/data: (\{.*?\})\n\n/);
        if (mm) { bf = bf.slice(mm.index + mm[0].length); frames.push(JSON.parse(mm[1])); continue; }
        const { value, done } = await Promise.race([rd.read(), wait(300).then(() => ({ value: null, done: false }))]);
        if (done) return;
        if (value) bf += dc.decode(value, { stream: true });
      }
    };
    const ask = (text) => fetch('http://127.0.0.1:' + KP + '/coworker/ask', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }) }).then(r => r.json());

    const a1 = await ask('방 하나 그려줘');
    ok(a1 && a1.ok === true, '입력창의 말을 접수한다');
    ok(a1 && a1.resumed === false, '  첫 마디는 새 대화다');
    await pump(6000);
    const chat = frames.filter(f => f.chat).map(f => f.chat);
    ok(chat.some(c => c.k === 'start'), '★시작을 알린다 (패널이 "작업 중"을 띄울 수 있게)');
    const txt = chat.find(c => c.k === 'text');
    ok(txt && /가짜 응답/.test(txt.text), '★Claude 의 말이 SSE 로 패널까지 온다');
    const done = chat.find(c => c.k === 'done');
    ok(!!done, '★끝났음을 알린다 (안 오면 입력창이 영영 잠긴다)');
    ok(done && Math.abs(done.cost - 0.0123) < 1e-9, '  사용 비용을 함께 준다 (' + (done && done.cost) + ')');
    ok(done && !done.error, '  성공은 오류로 표시하지 않는다');

    // 실제로 어떤 인자로 불렀나 — 여기가 어긋나면 Claude 에게 도구가 없거나 권한이 없다
    const lines = fs.readFileSync(argvLog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const av = lines[0];
    ok(av.includes('-p') && av[av.indexOf('-p') + 1] === '방 하나 그려줘', '★사용자의 말이 그대로 프롬프트가 된다');
    ok(av.includes('--output-format') && av[av.indexOf('--output-format') + 1] === 'stream-json',
      '  스트림으로 받는다 (다 끝날 때까지 기다리지 않는다)');
    const cfg = JSON.parse(av[av.indexOf('--mcp-config') + 1]);
    ok(cfg.mcpServers && cfg.mcpServers.parti, '★parti 도구를 붙여서 띄운다');
    ok((cfg.mcpServers.parti.args || []).some(x => /--attach=http:\/\/127\.0\.0\.1:7396/.test(x)),
      '★★붙이기 모드로 띄운다 — 안 그러면 두 번째 서버가 포트를 못 잡아 도구가 전부 실패한다');
    ok(av.includes('--allowedTools') && av[av.indexOf('--allowedTools') + 1] === 'mcp__parti',
      '★도구를 미리 허용한다 (헤드리스에서 권한을 물으면 그대로 멈춘다)');
    ok(av.includes('--append-system-prompt'), '  코워커 역할을 일러 준다');
    ok(!av.includes('--resume'), '  첫 마디에는 --resume 이 없다');

    // 두 번째 마디는 같은 대화를 이어야 한다 ("방금 그거" 가 통하려면)
    const a2 = await ask('거기에 문 달아줘');
    ok(a2 && a2.ok === true && a2.resumed === true, '두 번째 마디는 이어서 간다');
    await pump(6000);
    const lines2 = fs.readFileSync(argvLog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const av2 = lines2[1] || [];
    ok(av2.includes('--resume') && av2[av2.indexOf('--resume') + 1] === 'FAKE-SESSION-1',
      '★★앞 대화를 이어 간다 — 이게 없으면 "방금 만든 그 방" 이 통하지 않는다');
    try { rd.cancel(); } catch (e) {}
  }
  K.proc.kill();

  {
    // 앞 요청이 도는 중에 또 보내면 거절해야 한다 (두 Claude 가 같은 도면을 동시에 만지면 엉킨다)
    const H = start(7390, [], Object.assign({}, chatEnv, { PARTI_FAKE_MODE: 'hang' }));
    await wait(700);
    const hEs = await fetch('http://127.0.0.1:7390/bridge/events');
    const post = (p, b) => fetch('http://127.0.0.1:7390' + p, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then(r => r.json());
    ok((await post('/coworker/ask', { text: 'a' })).ok === true, '첫 요청은 받는다');
    await wait(400);
    const busy = await post('/coworker/ask', { text: 'b' });
    ok(busy.ok === false && /처리하고 있습니다/.test(busy.error), '★도는 중에 또 보내면 거절한다');
    const st = await post('/coworker/stop', {});
    ok(st.ok === true && st.stopped === true, '★중단이 실제로 프로세스를 죽인다');
    await wait(500);
    ok((await post('/coworker/ask', { text: 'c' })).ok === true, '  중단한 뒤에는 다시 받는다');
    try { hEs.body.cancel(); } catch (e) {}
    H.proc.kill();
  }
  {
    // claude 가 실패하면 조용히 삼키지 말고 패널에 알려야 한다
    const X = start(7389, [], Object.assign({}, chatEnv, { PARTI_FAKE_MODE: 'crash' }));
    await wait(700);
    const xEs = await fetch('http://127.0.0.1:7389/bridge/events');
    const rd2 = xEs.body.getReader(); const dc2 = new TextDecoder(); let bf2 = '';
    await fetch('http://127.0.0.1:7389/coworker/ask', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{"text":"a"}' });
    let err = null; const t0 = Date.now();
    while (Date.now() - t0 < 6000 && !err) {
      const mm = bf2.match(/data: (\{.*?\})\n\n/);
      if (mm) { bf2 = bf2.slice(mm.index + mm[0].length); const o = JSON.parse(mm[1]);
        if (o.chat && o.chat.k === 'done' && o.chat.error) err = o.chat.error; continue; }
      const { value, done } = await Promise.race([rd2.read(), wait(400).then(() => ({ value: null, done: false }))]);
      if (done) break;
      if (value) bf2 += dc2.decode(value, { stream: true });
    }
    ok(!!err, '★claude 가 실패하면 done{error} 로 알린다 (조용히 멈추지 않는다)');
    ok(err && /3/.test(err), '  종료 코드를 알려 준다 (' + String(err).slice(0, 60) + ')');
    try { rd2.cancel(); } catch (e) {}
    X.proc.kill();
  }
  try { fs.unlinkSync(argvLog); } catch (e) {}

  console.log('\n' + (fail ? '✗ 실패 ' + fail + ' / 통과 ' + pass : '✔ 전체 통과 — ' + pass + '/' + pass));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('테스트 자체 오류:', e); process.exit(2); });
