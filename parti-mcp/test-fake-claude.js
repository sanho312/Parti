#!/usr/bin/env node
// 회귀 전용 가짜 `claude -p` — 진짜 Claude 를 돌리지 않고 코워커 채팅 배관을 검사한다.
//
// PARTI_CLAUDE_BIN=<node> + PARTI_CLAUDE_ARGS=["<이 파일>"] 로 끼워 넣는다.
// 받은 argv 를 PARTI_FAKE_ARGV 가 가리키는 파일에 적어 두어, 테스트가
// --mcp-config · --allowedTools · --resume 이 제대로 넘어갔는지 확인할 수 있게 한다.
'use strict';
const fs = require('node:fs');

const argv = process.argv.slice(2);
if (process.env.PARTI_FAKE_ARGV) {
  try { fs.appendFileSync(process.env.PARTI_FAKE_ARGV, JSON.stringify(argv) + '\n'); } catch (e) {}
}
if (process.env.PARTI_FAKE_MODE === 'crash') { process.stderr.write('가짜 실패\n'); process.exit(3); }
if (process.env.PARTI_FAKE_MODE === 'hang') { setTimeout(() => {}, 60000); return; }

const sid = 'FAKE-SESSION-1';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');
say({ type: 'system', subtype: 'init', session_id: sid });
say({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: '가짜 응답입니다' }] } });
say({ type: 'result', subtype: 'success', session_id: sid, result: '가짜 응답입니다',
  total_cost_usd: 0.0123, is_error: false });
