/* ============================================================
   Parti 해석 파이프라인 — Phase 3 (손그림 → 건물)
   철학의 역할 분담 그대로:
   · 프로그램: 스케일 정규화, 규칙 기반 1차 분류, BIM 객체 생성 전부.
   · AI(Brain): 전처리 요약 JSON 만 받아 "무엇인가"(역할)만 판단.
     이미지 전송 없음 — 수백 토큰. 키가 없으면 규칙 판단만으로 동작.
   ============================================================ */
window.WEBCAD_BIMIFY = (() => {
'use strict';
const B = () => window.WEBCAD_AI_BRIDGE;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function perpInfo(p, x1, y1, x2, y2) {           // 점→선분: {d, t, px, py}
  const dx = x2 - x1, dy = y2 - y1;
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-12) return { d: Math.hypot(p[0] - x1, p[1] - y1), t: 0, px: x1, py: y1 };
  let t = ((p[0] - x1) * dx + (p[1] - y1) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  const px = x1 + t * dx, py = y1 + t * dy;
  return { d: Math.hypot(p[0] - px, p[1] - py), t, px, py };
}
const polyArea = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return Math.abs(a / 2);
};

// ---------- 스케일 정규화 ----------
// 화면 감각으로 작게 그린 스케치를 건축 스케일로. 기준: 가장 큰 닫힌 영역 ≈ 18㎡.
// (실척으로 그렸다면 1 — 아무것도 바꾸지 않는다)
function calcScale(analysis) {
  const nice = (k) => {                            // 1·1.5·2·2.5·3·4·5·6·8 ×10ⁿ 로 반올림
    const exp = Math.floor(Math.log10(k));
    const m = k / Math.pow(10, exp);
    const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    let best = steps[0];
    for (const s of steps) if (Math.abs(s - m) < Math.abs(best - m)) best = s;
    return best * Math.pow(10, exp);
  };
  const areas = analysis.regions.map(r => r.areaMM2);
  if (areas.length) {
    const maxA = Math.max(...areas);
    if (maxA >= 2e6) return 1;                     // 이미 방 크기(2㎡+) — 실척으로 간주
    return nice(Math.sqrt(18e6 / maxA));
  }
  let diag = 0;
  for (const s of analysis.shapes) if (s.bbox && s.bbox.diag > diag) diag = s.bbox.diag;
  if (!diag || diag >= 2500) return 1;
  return nice(10000 / diag);
}

// ---------- 규칙 기반 1차 분류 (AI 없이 항상 실행) ----------
// 역할: wall | door | window | column | furniture | ignore
function heuristic(analysis) {
  const roles = {};
  const shapes = analysis.shapes;
  const tol = analysis.opts.mergeTol;
  const lines = shapes.filter(s => s.kind === 'line');
  const nearLine = (p, mul) => lines.some(l => perpInfo(p, l.a[0], l.a[1], l.b[0], l.b[1]).d <= tol * (mul || 1));
  const connected = (s) => {                       // 끝점이 다른 선의 끝점/몸통에 닿는가
    const ends = s.kind === 'line' ? [s.a, s.b] : (s.pts ? [s.pts[0], s.pts[s.pts.length - 1]] : []);
    return ends.some(p => lines.some(l => l !== s && (dist(p, l.a) <= tol || dist(p, l.b) <= tol
      || perpInfo(p, l.a[0], l.a[1], l.b[0], l.b[1]).d <= tol)));
  };
  // 레이어 이름이 곧 의도 — 스케치 레이어가 지정돼 있으면 최우선 (AI 도 규칙도 필요 없다)
  const LAYER_ROLE = { '벽': 'wall', '기둥': 'column', '가구': 'furniture', '문': 'door',
    '창': 'window', '개구부': 'door', '슬래브': 'wall', '치수': 'ignore', '문자': 'ignore', '밑그림': 'ignore' };
  for (const s of shapes) {
    let role = 'furniture';
    if (s.layer && LAYER_ROLE[s.layer]) { roles[s.strokeId] = s.kind === 'dot' ? 'ignore' : LAYER_ROLE[s.layer]; continue; }
    if (s.kind === 'dot') role = 'ignore';
    else if (s.kind === 'circle') role = s.r <= 400 ? 'column' : (s.r >= 1000 ? 'wall' : 'furniture'); // 큰 원 = 원형 방(곡선 벽)
    else if (s.kind === 'arc') {
      // 문 호: 중심(경첩)과 끝점이 벽 후보 선 근처. 문이 아니면서 긴 호(1.5m+) = 곡선 벽
      const c = [s.cx, s.cy];
      if (nearLine(c, 2) || (nearLine(s.a, 1.5) && nearLine(s.b, 3))) role = 'door';
      else role = (s.lengthMM || 0) >= 1500 ? 'wall' : 'furniture';
    } else if (s.kind === 'rect' || s.kind === 'polygon' || (s.kind === 'curve' && s.closed)) {
      const area = polyArea(s.pts);
      role = area >= 4e6 ? 'wall' : (area <= 0.16e6 ? 'column' : 'furniture');
    } else if (s.kind === 'line' || s.kind === 'polyline') {
      // 창: 벽 후보 선의 '몸통 위'에 올린 짧은 평행선 (두 끝점 모두 다른 긴 선 근처)
      const isWin = s.kind === 'line' && s.lengthMM >= 300 && s.lengthMM <= 2500 && lines.some(l => l !== s
        && (l.lengthMM || 0) > s.lengthMM * 1.8
        && perpInfo(s.a, l.a[0], l.a[1], l.b[0], l.b[1]).d <= tol
        && perpInfo(s.b, l.a[0], l.a[1], l.b[0], l.b[1]).d <= tol);
      if (isWin) role = 'window';
      else role = ((s.lengthMM || 0) >= 1000 && (connected(s) || analysis.regions.length)) ? 'wall' : 'furniture';
    } else role = 'furniture';                     // 열린 자유곡선
    roles[s.strokeId] = role;
  }
  return roles;
}

// ---------- AI 역할 판정 (요약 JSON 만 — 이미지 없음) ----------
const ROLE_SET = ['wall', 'door', 'window', 'column', 'furniture', 'ignore'];
function aiPrompt(analysis, guesses) {
  const shapes = analysis.shapes.map(s => ({
    id: s.strokeId, kind: s.kind, closed: !!s.closed, color: s.color,
    len: Math.round(s.lengthMM || 0),
    size: s.bbox ? [Math.round(s.bbox.w), Math.round(s.bbox.h)] : null,
    guess: guesses[s.strokeId],
  }));
  return '건축 평면 스케치를 전처리한 도형 목록이다(단위 mm). guess 는 규칙 기반 추정.\n'
    + '각 도형의 역할을 wall|door|window|column|furniture|ignore 중에서 판정해\n'
    + '{"roles":{"<id>":"<역할>"}} JSON 만 출력하라. 확신이 없으면 guess 를 유지하라.\n'
    + JSON.stringify({ shapes, regions: analysis.summary.regions });
}
async function aiJudge(analysis, guesses, key, model) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: model || 'claude-haiku-4-5-20251001',   // 판단만 — 빠르고 저렴한 모델이면 충분
      max_tokens: 500,
      system: '건축 평면 스케치의 도형 역할 판정기. 반드시 JSON 만 출력한다.',
      messages: [{ role: 'user', content: aiPrompt(analysis, guesses) }],
    }),
  });
  if (!res.ok) throw new Error('API ' + res.status);
  const data = await res.json();
  const text = (data.content || []).map(c => c.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('JSON 없음');
  const parsed = JSON.parse(m[0]);
  const out = {};
  for (const [id, role] of Object.entries(parsed.roles || {}))
    if (ROLE_SET.includes(role)) out[id] = role;
  return out;
}
async function classify(analysis) {
  const roles = heuristic(analysis);
  let usedAI = false;
  try {
    const cfg = JSON.parse(localStorage.getItem('webcad_ai_cfg') || '{}');
    if (cfg.key) {
      const fixed = await aiJudge(analysis, roles, cfg.key);
      for (const [id, role] of Object.entries(fixed)) roles[id] = role;
      usedAI = true;
    }
  } catch (e) { console.warn('[bimify] AI 판단 실패 — 규칙 판단으로 진행:', e); }
  return { roles, usedAI };
}

// ---------- BIM 생성 (전부 프로그램) ----------
const LAYERS = { wall: ['벽', '#cfc7ba'], opening: ['개구부', '#ff9f0a'], column: ['기둥', '#8fa3c8'],
  slab: ['슬래브', '#9aa2af'], furniture: ['가구', '#7fb28a'] };
function build(analysis, roles, opts) {
  const o = Object.assign({ wallT: 200, wallH: 2400, slabT: 150 }, opts || {});
  const br = B();
  br.pushUndo();
  for (const [name, color] of Object.values(LAYERS)) br.ensureLayer(name, color);
  const counts = { wall: 0, door: 0, window: 0, column: 0, furniture: 0, slab: 0 };
  const wallSegs = [];                             // {x1,y1,x2,y2,L}
  const addWallSeg = (a, b) => {
    const L = dist(a, b); if (L < 50) return;
    const e = br.addEntity({ type: 'LINE', layer: '벽', x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
    e.bim = { kind: 'wall', h: o.wallH, t: o.wallT, base: 0 };
    wallSegs.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1], L });
    counts.wall++;
  };
  const later = [];                                // 문/창은 벽 생성 후에
  for (const s of analysis.shapes) {
    const role = roles[s.strokeId] || 'ignore';
    if (role === 'ignore') continue;
    if (role === 'wall') {
      if (s.kind === 'line') addWallSeg(s.a, s.b);
      else if (s.kind === 'rect' || s.kind === 'polygon')
        for (let i = 0; i < s.pts.length; i++) addWallSeg(s.pts[i], s.pts[(i + 1) % s.pts.length]);
      else if (s.kind === 'polyline' || s.kind === 'curve') {
        for (let i = 1; i < s.pts.length; i++) addWallSeg(s.pts[i - 1], s.pts[i]);
        if (s.closed) addWallSeg(s.pts[s.pts.length - 1], s.pts[0]);   // 닫힌 자유곡선 벽은 마지막 변도
      } else if (s.kind === 'arc' || s.kind === 'circle') {
        // 곡선 벽 = 진짜 ARC/CIRCLE 개체 하나 — 라이노·퓨전처럼 매끈한 곡면.
        // cad.js(bimSolids)가 64각 마이터 링 + 세로 이음선 숨김 + 구로 셰이딩으로 원통/아치를 그린다.
        // 예전처럼 짧은 직선 벽 여러 개로 테셀레이션하면 '뚝뚝 끊긴 벽체'가 됐다 (2026-07-24 사용자).
        const e = s.kind === 'circle'
          ? br.addEntity({ type: 'CIRCLE', layer: '벽', cx: s.cx, cy: s.cy, r: s.r })
          : br.addEntity({ type: 'ARC', layer: '벽', cx: s.cx, cy: s.cy, r: s.r, startAngle: s.startAngle, endAngle: s.endAngle });
        e.bim = { kind: 'wall', h: o.wallH, t: o.wallT, base: 0 };
        counts.wall++;
        // 문/창 호스트 매칭용 '가상' 세그먼트 — 개체는 만들지 않고 매칭 표(wallSegs)만 채운다
        const sweep = s.kind === 'circle' ? 360 : (((s.endAngle - s.startAngle) % 360 + 360) % 360 || 360);
        const st = s.kind === 'circle' ? 0 : s.startAngle;
        const n = Math.min(48, Math.max(8, Math.ceil(sweep / 12)));
        let prev = null;
        for (let i = 0; i <= n; i++) {
          const a = (st + sweep * i / n) * Math.PI / 180;
          const p = [s.cx + Math.cos(a) * s.r, s.cy + Math.sin(a) * s.r];
          if (prev) wallSegs.push({ x1: prev[0], y1: prev[1], x2: p[0], y2: p[1], L: dist(prev, p) });
          prev = p;
        }
      }
      continue;
    }
    if (role === 'door' || role === 'window') { later.push([role, s]); continue; }
    if (role === 'column') {
      let e = null;
      if (s.kind === 'circle') e = br.addEntity({ type: 'CIRCLE', layer: '기둥', cx: s.cx, cy: s.cy, r: s.r });
      else if (s.pts) e = br.addEntity({ type: 'LWPOLYLINE', layer: '기둥', points: s.pts.map(p => [p[0], p[1]]), closed: true });
      if (e) { e.bim = { kind: 'column', h: o.wallH, base: 0 }; counts.column++; }
      continue;
    }
    // furniture — 인식 기하 그대로, '가구' 레이어 (색 유지)
    let e = null;
    if (s.kind === 'line') e = br.addEntity({ type: 'LINE', layer: '가구', x1: s.a[0], y1: s.a[1], x2: s.b[0], y2: s.b[1] });
    else if (s.kind === 'circle') e = br.addEntity({ type: 'CIRCLE', layer: '가구', cx: s.cx, cy: s.cy, r: s.r });
    else if (s.kind === 'arc') e = br.addEntity({ type: 'ARC', layer: '가구', cx: s.cx, cy: s.cy, r: s.r, startAngle: s.startAngle, endAngle: s.endAngle });
    else if (s.pts) e = br.addEntity({ type: 'LWPOLYLINE', layer: '가구', points: s.pts.map(p => [p[0], p[1]]), closed: !!s.closed });
    if (e) { e.color = s.color; counts.furniture++; }
  }
  // 문/창 — 가장 가까운 벽에 개구부로
  const bestHost = (p, maxD) => {
    let best = null, bd = maxD;
    for (const w of wallSegs) {
      const pi = perpInfo(p, w.x1, w.y1, w.x2, w.y2);
      if (pi.d < bd && pi.t > 0.02 && pi.t < 0.98) { bd = pi.d; best = { w, pi }; }
    }
    return best;
  };
  const tol = analysis.opts.mergeTol;
  for (const [role, s] of later) {
    let host = null, width = 900, centerT = 0.5;
    if (role === 'door' && s.kind === 'arc') {
      const h = bestHost([s.cx, s.cy], tol * 2.5);   // 호 중심 = 경첩(벽 위)
      if (h) {
        // 경첩에서 '벽에 가까운 호 끝점' 쪽으로 문폭만큼
        const eNear = [s.a, s.b].sort((p, q) =>
          perpInfo(p, h.w.x1, h.w.y1, h.w.x2, h.w.y2).d - perpInfo(q, h.w.x1, h.w.y1, h.w.x2, h.w.y2).d)[0];
        const pe = perpInfo(eNear, h.w.x1, h.w.y1, h.w.x2, h.w.y2);
        width = Math.min(Math.max(dist([s.cx, s.cy], [pe.px, pe.py]), 500), Math.min(1500, h.w.L * 0.9));
        centerT = (h.pi.t + pe.t) / 2;
        host = h;
      }
    } else {                                       // 창(선·짧은 도형): 중심에서 가장 가까운 벽
      const c = s.bbox ? [s.bbox.x0 + s.bbox.w / 2, s.bbox.y0 + s.bbox.h / 2] : (s.a || (s.pts && s.pts[0]));
      const h = c && bestHost(c, tol * 2.5);
      if (h) { width = Math.min(Math.max(s.lengthMM || 900, 400), h.w.L * 0.9); centerT = h.pi.t; host = h; }
    }
    if (!host) { // 벽을 못 찾으면 가구로 강등 (조용히 사라지지 않게)
      if (s.kind === 'arc') { const e = br.addEntity({ type: 'ARC', layer: '가구', cx: s.cx, cy: s.cy, r: s.r, startAngle: s.startAngle, endAngle: s.endAngle }); e.color = s.color; counts.furniture++; }
      continue;
    }
    const w = host.w, ux = (w.x2 - w.x1) / w.L, uy = (w.y2 - w.y1) / w.L;
    let off = centerT * w.L;
    off = Math.max(width / 2 + 10, Math.min(w.L - width / 2 - 10, off));
    const cx2 = w.x1 + ux * off, cy2 = w.y1 + uy * off;
    const eo = br.addEntity({ type: 'LINE', layer: '개구부',
      x1: cx2 - ux * width / 2, y1: cy2 - uy * width / 2, x2: cx2 + ux * width / 2, y2: cy2 + uy * width / 2 });
    eo.bim = role === 'door'
      ? { kind: 'opening', ot: 'door', h: 2100, sill: 0, t: o.wallT }
      : { kind: 'opening', ot: 'window', h: 1200, sill: 900, t: o.wallT };
    counts[role]++;
  }
  // 바닥 슬래브 — 닫힌 영역마다 (프로그램 자동, AI 불필요). 원형 방은 다각 근사.
  for (const r of analysis.regions) {
    let pts = r.pts;
    if (!pts && r.circle && roles[(r.shapeIds || [])[0]] === 'wall') {
      pts = [];
      for (let i = 0; i < 24; i++) { const a = i / 24 * 2 * Math.PI; pts.push([r.circle.cx + Math.cos(a) * r.circle.r, r.circle.cy + Math.sin(a) * r.circle.r]); }
    }
    if (!pts || pts.length < 3) continue;
    const e = br.addEntity({ type: 'LWPOLYLINE', layer: '슬래브', points: pts.map(p => [p[0], p[1]]), closed: true });
    e.bim = { kind: 'slab', t: o.slabT, top: 0 };
    counts.slab++;
  }
  br.refresh();
  return counts;
}

return { calcScale, heuristic, classify, aiJudge, aiPrompt, build };
})();
