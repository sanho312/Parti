// ============================================================
//  Parti 코워커 — 자연어로 작도·3D 작업
//  cad.js의 WEBCAD_AI_BRIDGE를 통해 도면을 직접 조작한다.
//
//  ★모드는 둘이다. 어느 쪽도 브라우저에 API 키를 두지 않는다.
//   ① 로컬(키 없음) — localReply 가 알고리즘으로 문장을 해석한다. 어디서나 되고, 아이패드 포함.
//   ② MCP — parti-mcp 서버를 통해 Claude 가 직접 도면을 만진다(mcp.js · parti-mcp/README.md).
//      데스크톱 전용. 이 파일은 도구 계층(TOOLS·execTool)을 WEBCAD_AI 로 내보내기만 한다.
//
//  2026-07-28: 브라우저에서 api.anthropic.com 을 직접 때리던 API 키 경로를 걷어냈다.
//   키를 평문 localStorage 에 두고, 모델 목록·가격표를 손으로 따라가야 했고, 사용자가
//   토큰 값을 따로 물어야 했다. MCP 는 그 셋이 전부 필요 없다.
// ============================================================
(function () {
  'use strict';
  const B = () => window.WEBCAD_AI_BRIDGE;
  // 옛 API 키 설정이 평문으로 남아 있지 않게 한 번 지운다.
  try { localStorage.removeItem('webcad_ai_cfg'); localStorage.removeItem('webcad_ai_hist'); } catch (e) {}


  // ---------- 도구 정의 ----------
  const num = { type: 'number' };
  const TOOLS = [
    {
      name: 'get_drawing', description: '현재 도면 상태(레이어·층·선택·개체 목록)를 요약해 반환. 기존 도면을 다루기 전에 호출.',
      input_schema: { type: 'object', properties: { detail: { type: 'boolean', description: 'true면 개체별 좌표 포함(최대 150개)' } } },
    },
    {
      name: 'add_entities', description: '개체들을 생성한다(최대 200개). 반환: 생성된 id 목록.',
      input_schema: {
        type: 'object', required: ['entities'],
        properties: { entities: { type: 'array', items: { type: 'object' }, description: '시스템 프롬프트의 개체 스키마를 따르는 객체 배열' } },
      },
    },
    {
      name: 'update_entities', description: '개체 속성 수정(얕은 병합, bim은 필드 단위 병합). 예: bim.h 변경, layer 이동.',
      input_schema: {
        type: 'object', required: ['updates'],
        properties: { updates: { type: 'array', items: { type: 'object', required: ['id', 'set'], properties: { id: num, set: { type: 'object' } } } } },
      },
    },
    {
      name: 'delete_entities', description: '개체 삭제.',
      input_schema: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: num } } },
    },
    {
      name: 'transform_entities', description: '개체 이동/회전. move: dx,dy,dz(mm). rotate: 중심(cx,cy) 기준 deg도(수평 회전).',
      input_schema: {
        type: 'object', required: ['ids', 'op'],
        properties: { ids: { type: 'array', items: num }, op: { type: 'string', enum: ['move', 'rotate'] }, dx: num, dy: num, dz: num, cx: num, cy: num, deg: num },
      },
    },
    {
      name: 'boolean_op', description: '3D 불리언. keep(베이스)에 cutter를 합/차/교집합. 대상은 BIM 솔리드 또는 메시.',
      input_schema: {
        type: 'object', required: ['op', 'keep_ids', 'cutter_ids'],
        properties: { op: { type: 'string', enum: ['union', 'subtract', 'intersect'] }, keep_ids: { type: 'array', items: num }, cutter_ids: { type: 'array', items: num } },
      },
    },
    {
      name: 'set_view', description: '뷰 전환/맞춤. mode 2d|3d, fit=전체보기.',
      input_schema: { type: 'object', properties: { mode: { type: 'string', enum: ['2d', '3d'] }, fit: { type: 'boolean' } } },
    },
    {
      name: 'select_entities', description: '개체를 선택 상태로 표시(사용자에게 보여주기용).',
      input_schema: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: num } } },
    },
    {
      name: 'get_screenshot', description: '현재 뷰(2D 평면 또는 3D)의 화면 스크린샷을 이미지로 반환. 작업 결과를 눈으로 검증하거나 사용자가 화면에 대해 물을 때 사용. 찍기 전에 set_view {fit:true}로 화면을 맞추면 좋다.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'measure', description: '측정. ids를 주면 개체별 길이(mm)·면적(mm²)·bbox, from/to([x,y] 또는 [x,y,z])를 주면 두 점 거리, 아무것도 없으면 도면 전체 bbox와 개수를 반환.',
      input_schema: { type: 'object', properties: { ids: { type: 'array', items: num }, from: { type: 'array', items: num }, to: { type: 'array', items: num } } },
    },
    {
      name: 'set_sketch_params',
      description: '스케치 보정·인식 패스값 조정. 사용자가 "선이 자꾸 곡선으로 인식돼", "보정이 너무 세다/약하다", "끝점이 자꾸 붙는다(안 붙는다)", "기울어진 선이 자꾸 수평이 된다" 같은 스케치 인식 불만을 말하면 이 도구로 대신 조정하라. preset(rough=대충 그려도 반듯 | basic=기본 | fine=원본 존중) 또는 개별값 일부만 넘겨도 된다: fitK(0.3~2.5 보정 강도), smooth(0~4 손떨림 제거), ortho(0~15 수평수직 정리각°), snap(0~30 끝점 흡착px), corner(0.35~1.0 모서리 판정각rad — 낮을수록 완만한 꺾임도 꺾은선). 반환: 적용된 전체 값. 조정 후 무엇을 어떻게 바꿨는지 한 줄로 알려줄 것.',
      input_schema: {
        type: 'object',
        properties: {
          preset: { type: 'string', enum: ['rough', 'basic', 'fine'] },
          fitK: num, smooth: num, ortho: num, snap: num, corner: num,
        },
      },
    },
    {
      name: 'set_underlay', description: '사용자가 채팅에 첨부한 최신 이미지를 도면 밑그림(IMAGE 개체, 밑그림 레이어)으로 삽입. width_mm=이미지의 실제 폭(스케일) — 세로는 비율 자동. 원점(0,0)이 이미지 좌하단. 이미 밑그림이 있으면 교체. 반환: {id,w_mm,h_mm}.',
      input_schema: {
        type: 'object', required: ['width_mm'],
        properties: { width_mm: num, x: { ...num, description: '좌하단 x (기본 0)' }, y: { ...num, description: '좌하단 y (기본 0)' }, opacity: { ...num, description: '0.1~1 (기본 0.55 — 트레이스하기 좋게 반투명)' } },
      },
    },
    {
      name: 'make_views', description: 'BIM 모델에서 입면/단면 도면을 자동 생성해 모델 옆에 배치. kind "elevation"+edge(front=남/back=북/left=서/right=동에서 바라봄) 또는 kind "section"+axis("x"=세로로 절단해 동서 방향을 봄, "y"=가로로 절단해 남북을 봄)+at(절단 위치 좌표, 생략=모델 중앙). 벽·슬래브 등 BIM 개체가 있어야 한다.',
      input_schema: {
        type: 'object', required: ['kind'],
        properties: {
          kind: { type: 'string', enum: ['elevation', 'section'] },
          edge: { type: 'string', enum: ['front', 'back', 'left', 'right'] },
          axis: { type: 'string', enum: ['x', 'y'] }, at: num,
          depth: { ...num, description: '투영 깊이 mm (기본 30000)' },
        },
      },
    },
    {
      name: 'organize_layers', description: '도면 전체를 표준 레이어 체계로 자동 정리(벽/기둥/슬래브/지붕/계단/난간/개구부/가구/문자/치수/밑그림 — 시스템 프롬프트의 색상 포함). BIM 종류·개체 타입으로 분류. 반환: 레이어별 이동 개수.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'edit_node_graph', description: '파라메트릭 노드 그래프(그래스호퍼형) 편집. action "replace"=nodes 스펙으로 그래프 전체 교체 — 라이브 프리뷰가 표시되고 슬라이더들이 [패턴 컨트롤] 패널에 노출되어 사용자가 조절, "get"=현재 그래프 조회, "bake"=프리뷰를 영구 개체로 확정, "clear"=그래프·프리뷰 삭제. 반복·패턴·조절형 요청에 사용.',
      input_schema: {
        type: 'object', required: ['action'],
        properties: {
          action: { type: 'string', enum: ['replace', 'get', 'bake', 'clear'] },
          nodes: { type: 'array', items: { type: 'object' }, description: 'replace용 노드 스펙 배열 — 시스템 프롬프트의 노드 그래프 규칙 참고' },
        },
      },
    },
  ];

  // ---------- 도구 실행 ----------
  let turnPushed = false;  // 사용자 요청 1건 = undo 1단계
  let turnCreated = 0;     // 요청(턴)당 생성 개체 수 — 생성 폭주 가드
  function ensureUndo() { if (!turnPushed) { B().pushUndo(); turnPushed = true; } }

  // ---------- 안전 가드 ----------
  const LIMITS = { perCall: 200, perTurn: 500, drawingMax: 20000, boolTris: 60000 };
  const BLOCKED_KEYS = new Set(['id', 'type', 'tris', '_feat', '_featRef']); // 내부 필드 조작 금지
  function validSet(o) { // 수정값 검증: 금지 키 없음 + 모든 숫자 유한·±1e7 이내 (재귀)
    for (const k of Object.keys(o)) {
      if (BLOCKED_KEYS.has(k)) return false;
      const v = o[k];
      if (typeof v === 'number') { if (!isFinite(v) || Math.abs(v) > 1e7) return false; }
      else if (Array.isArray(v)) { for (const x of v.flat(4)) if (typeof x === 'number' && (!isFinite(x) || Math.abs(x) > 1e7)) return false; }
      else if (v && typeof v === 'object' && !validSet(v)) return false;
    }
    return true;
  }

  function entSummary(e, detail) {
    const o = { id: e.id, type: e.type, layer: e.layer };
    if (e.bim) o.bim = e.bim;
    if (!detail) { const bb = safeBBox(e); if (bb) o.bbox = [bb.xmin, bb.ymin, bb.xmax, bb.ymax].map(Math.round); return o; }
    switch (e.type) {
      case 'LINE': o.x1 = e.x1; o.y1 = e.y1; o.x2 = e.x2; o.y2 = e.y2; if (e.z1 != null) { o.z1 = e.z1; o.z2 = e.z2; } break;
      case 'LWPOLYLINE': o.points = e.points.map(p => [Math.round(p[0]), Math.round(p[1])]); o.closed = !!e.closed; break;
      case 'CIRCLE': o.cx = e.cx; o.cy = e.cy; o.r = e.r; break;
      case 'ARC': o.cx = e.cx; o.cy = e.cy; o.r = e.r; o.startAngle = e.startAngle; o.endAngle = e.endAngle; break;
      case 'TEXT': o.x = e.x; o.y = e.y; o.text = e.text; break;
      case 'MESH': o.tris = e.tris.length; { const bb = safeBBox(e); if (bb) o.bbox = [bb.xmin, bb.ymin, bb.xmax, bb.ymax].map(Math.round); } break;
      default: { const bb = safeBBox(e); if (bb) o.bbox = [bb.xmin, bb.ymin, bb.xmax, bb.ymax].map(Math.round); }
    }
    if (e.zo) o.zo = e.zo;
    return o;
  }
  function safeBBox(e) { try { return B().entityBBox(e); } catch (err) { return null; } }

  function toolGetDrawing(inp) {
    const S = B().state;
    const ents = S.entities.slice(0, 150).map(e => entSummary(e, inp && inp.detail));
    return {
      units: 'mm', view: B().is3D() ? '3d' : '2d',
      layers: S.layers.map(l => l.name), currentLayer: S.currentLayer,
      levels: S.levels, currentLevel: S.curLv || 0,
      selection: [...S.selection],
      totalEntities: S.entities.length,
      truncated: S.entities.length > 150,
      entities: ents,
    };
  }

  function toolAddEntities(inp) {
    const list = (inp && inp.entities) || [];
    if (!Array.isArray(list) || !list.length) return { error: 'entities 배열이 비어 있습니다.' };
    if (list.length > LIMITS.perCall) return { error: '한 번에 최대 ' + LIMITS.perCall + '개까지 생성할 수 있습니다.' };
    if (turnCreated + list.length > LIMITS.perTurn) return { error: '한 요청에서 생성할 수 있는 개체는 최대 ' + LIMITS.perTurn + '개입니다. 사용자에게 나눠서 요청하도록 안내하세요.' };
    if (B().state.entities.length + list.length > LIMITS.drawingMax) return { error: '도면 개체 수 상한(' + LIMITS.drawingMax + ')을 초과합니다.' };
    ensureUndo();
    const ids = [], errors = [];
    for (const spec of list) {
      try {
        const e = buildEntity(spec);
        if (typeof e === 'string') { errors.push(e); continue; }
        ids.push(e.id);
      } catch (err) { errors.push(String(err && err.message || err)); }
    }
    turnCreated += ids.length;
    return { created: ids.length, ids, errors: errors.length ? errors.slice(0, 10) : undefined };
  }
  const fin = v => typeof v === 'number' && isFinite(v) && Math.abs(v) <= 1e7; // 유한 + ±10km(1e7mm) 이내
  function buildEntity(s) {
    const t = String(s.type || '').toUpperCase();
    let base = null;
    if (t === 'LINE') {
      if (![s.x1, s.y1, s.x2, s.y2].every(fin)) return 'LINE 좌표 누락';
      base = { type: 'LINE', x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 };
      if (fin(s.z1) || fin(s.z2)) { base.z1 = s.z1 || 0; base.z2 = s.z2 || 0; }
    } else if (t === 'LWPOLYLINE') {
      if (!Array.isArray(s.points) || s.points.length < 2 || !s.points.every(p => Array.isArray(p) && fin(p[0]) && fin(p[1]))) return 'LWPOLYLINE points 형식 오류';
      base = { type: 'LWPOLYLINE', points: s.points.map(p => [p[0], p[1]]), closed: !!s.closed };
    } else if (t === 'CIRCLE') {
      if (![s.cx, s.cy, s.r].every(fin) || s.r <= 0) return 'CIRCLE cx,cy,r 오류';
      base = { type: 'CIRCLE', cx: s.cx, cy: s.cy, r: s.r };
    } else if (t === 'ARC') {
      if (![s.cx, s.cy, s.r, s.startAngle, s.endAngle].every(fin) || s.r <= 0) return 'ARC 필드 오류';
      base = { type: 'ARC', cx: s.cx, cy: s.cy, r: s.r, startAngle: s.startAngle, endAngle: s.endAngle };
    } else if (t === 'TEXT') {
      if (![s.x, s.y].every(fin) || !s.text) return 'TEXT 필드 오류';
      base = { type: 'TEXT', x: s.x, y: s.y, text: String(s.text), height: fin(s.height) ? s.height : 250 };
    } else if (t === 'SPHERE') {
      if (![s.cx, s.cy, s.cz, s.r].every(fin) || s.r <= 0) return 'SPHERE 필드 오류';
      base = { type: 'MESH', tris: B().meshSphere(s.cx, s.cy, s.cz, s.r, 24, 12), name: 'sphere' };
    } else if (t === 'CONE') {
      if (![s.cx, s.cy, s.base_z, s.r, s.h].every(fin) || s.r <= 0 || s.h <= 0) return 'CONE 필드 오류';
      base = { type: 'MESH', tris: B().meshCone(s.cx, s.cy, s.base_z, s.r, s.h, 24), name: 'cone' };
    } else if (t === 'OPENING') { // 문/창: 호스트 벽 위 자동 배치 (좌표 계산 불필요)
      const wall = B().state.entities.find(x => x.id === s.wall_id);
      if (!wall || wall.type !== 'LINE' || !wall.bim || wall.bim.kind !== 'wall') return 'OPENING: wall_id가 LINE 벽이 아닙니다';
      if (![s.offset, s.width].every(fin) || s.width <= 0) return 'OPENING offset/width 오류';
      const L = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
      if (L < s.width) return 'OPENING: 폭(' + s.width + ')이 벽 길이(' + Math.round(L) + ')보다 큽니다';
      const ux = (wall.x2 - wall.x1) / L, uy = (wall.y2 - wall.y1) / L;
      const off = Math.max(s.width / 2, Math.min(L - s.width / 2, s.offset));
      const ocx = wall.x1 + ux * off, ocy = wall.y1 + uy * off;
      const ot = s.ot === 'door' ? 'door' : 'window';
      try { B().ensureLayer('개구부', '#ff9f0a'); } catch (err) {}
      const eo = B().addEntity({ type: 'LINE', layer: '개구부',
        x1: ocx - ux * s.width / 2, y1: ocy - uy * s.width / 2, x2: ocx + ux * s.width / 2, y2: ocy + uy * s.width / 2 });
      eo.bim = { kind: 'opening', ot, h: fin(s.h) ? s.h : (ot === 'door' ? 2100 : 1200), sill: fin(s.sill) ? s.sill : (ot === 'door' ? 0 : 900), t: wall.bim.t || 100 };
      return eo;
    } else return '지원하지 않는 type: ' + t;
    if (s.layer) base.layer = String(s.layer);
    const e = B().addEntity(base);
    if (s.color && /^#[0-9a-fA-F]{6}$/.test(s.color)) e.color = s.color;
    if (s.bim && typeof s.bim === 'object' && s.bim.kind) {
      const ok = (s.bim.kind === 'wall' && t === 'LINE') ||
                 (s.bim.kind === 'column' && (t === 'LWPOLYLINE' || t === 'CIRCLE')) ||
                 (s.bim.kind === 'slab' && t === 'LWPOLYLINE') ||
                 (s.bim.kind === 'roof' && t === 'LWPOLYLINE') ||
                 (s.bim.kind === 'stair' && t === 'LINE');
      if (ok) e.bim = JSON.parse(JSON.stringify(s.bim));
      if (e.bim && e.bim.kind === 'wall') { if (!fin(e.bim.h)) e.bim.h = 2400; if (!fin(e.bim.t)) e.bim.t = 100; if (!fin(e.bim.base)) e.bim.base = 0; }
      if (e.bim && e.bim.kind === 'column') { if (!fin(e.bim.h)) e.bim.h = 2400; if (!fin(e.bim.base)) e.bim.base = 0; }
      if (e.bim && e.bim.kind === 'slab') { if (!fin(e.bim.t)) e.bim.t = 150; if (!fin(e.bim.top)) e.bim.top = 0; }
      if (e.bim && e.bim.kind === 'roof') {
        if (!fin(e.bim.eave)) e.bim.eave = 2400;
        if (!fin(e.bim.rise)) e.bim.rise = 900;
        if (!['flat', 'shed', 'gable'].includes(e.bim.rtype)) e.bim.rtype = 'gable';
      }
      if (e.bim && e.bim.kind === 'stair') {
        if (!fin(e.bim.h)) e.bim.h = 3000; if (!fin(e.bim.base)) e.bim.base = 0;
        if (!fin(e.bim.w)) e.bim.w = 1200; if (!fin(e.bim.riser)) e.bim.riser = 180;
      }
    }
    return e;
  }

  function byIds(ids) {
    const S = B().state;
    return (ids || []).map(id => S.entities.find(e => e.id === id)).filter(Boolean);
  }
  function toolUpdateEntities(inp) {
    const ups = (inp && inp.updates) || [];
    if (!ups.length) return { error: 'updates가 비어 있습니다.' };
    ensureUndo();
    let done = 0; const missing = [], invalid = [];
    for (const u of ups) {
      const e = B().state.entities.find(x => x.id === u.id);
      if (!e) { missing.push(u.id); continue; }
      const set = u.set || {};
      if (!validSet(set)) { invalid.push(u.id); continue; } // 금지 키(id/type/tris 등)·비정상 수치 차단
      for (const k of Object.keys(set)) {
        if (k === 'bim' && typeof set.bim === 'object' && e.bim) Object.assign(e.bim, set.bim);
        else e[k] = set[k];
      }
      done++;
    }
    return { updated: done, missing: missing.length ? missing : undefined, rejected: invalid.length ? { ids: invalid, reason: '금지 필드(id/type/tris) 또는 비정상 수치(무한대·±1e7 초과)' } : undefined };
  }
  function toolDeleteEntities(inp) {
    const ids = new Set((inp && inp.ids) || []);
    if (!ids.size) return { error: 'ids가 비어 있습니다.' };
    const S = B().state;
    const n = S.entities.filter(e => ids.has(e.id)).length;
    const total = S.entities.length;
    // 대량 삭제 가드: 10개 이상 또는 도면의 절반 이상이면 사용자에게 직접 확인
    if (n >= 10 || (n >= 2 && n >= total * 0.5)) {
      const ok = window.confirm('🤖 AI 코워커가 개체 ' + n + '개(전체 ' + total + '개 중)를 삭제하려 합니다.\n\n허용하시겠습니까? (실행취소 Ctrl+Z로 원복 가능)');
      if (!ok) return { error: '사용자가 삭제를 거부했습니다. 삭제를 강행하지 말고 대안을 제시하세요.' };
    }
    ensureUndo();
    const before = S.entities.length;
    S.entities = S.entities.filter(e => !ids.has(e.id));
    for (const id of ids) S.selection.delete(id);
    return { deleted: before - S.entities.length };
  }
  function toolTransform(inp) {
    const ents = byIds(inp.ids);
    if (!ents.length) return { error: '대상 개체를 찾지 못했습니다.' };
    for (const k of ['dx', 'dy', 'dz', 'deg']) if (inp[k] != null && !fin(inp[k])) return { error: k + ' 값이 비정상입니다(유한값·±1e7 이내만 허용).' };
    ensureUndo();
    if (inp.op === 'move') {
      for (const e of ents) B().move3DEnt(e, inp.dx || 0, inp.dy || 0, inp.dz || 0);
      return { moved: ents.length, dx: inp.dx || 0, dy: inp.dy || 0, dz: inp.dz || 0 };
    }
    if (inp.op === 'rotate') {
      if (![inp.cx, inp.cy, inp.deg].every(fin)) return { error: 'rotate에는 cx,cy,deg가 필요합니다.' };
      for (const e of ents) B().gumRotate(e, 'z', inp.cx, inp.cy, 0, inp.deg);
      return { rotated: ents.length, deg: inp.deg };
    }
    return { error: '지원하지 않는 op' };
  }
  function toolBoolean(inp) {
    const keep = byIds(inp.keep_ids), cut = byIds(inp.cutter_ids);
    if (!keep.length || !cut.length) return { error: 'keep/cutter 개체를 찾지 못했습니다.' };
    const bad = keep.concat(cut).filter(e => !B().isBoolable(e));
    if (bad.length) return { error: '불리언 불가 개체: ' + bad.map(e => e.id + '(' + e.type + ')').join(', ') + ' — BIM 솔리드/메시만 가능' };
    let tris = 0; // 브라우저 정지 가드: 거대 메시 불리언 차단
    for (const e of keep.concat(cut)) if (e.type === 'MESH') tris += e.tris.length;
    if (tris > LIMITS.boolTris) return { error: '메시가 너무 큽니다(삼각형 ' + tris + '개 > ' + LIMITS.boolTris + ') — 브라우저가 멈출 수 있어 차단했습니다.' };
    B().runBoolean(inp.op, keep, cut); // 내부에서 pushUndo
    const sel = [...B().state.selection];
    return { op: inp.op, resultIds: sel };
  }
  function feedCmd(s) {
    const inp = document.getElementById('cmdInput');
    if (!inp) return false;
    inp.value = s;
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  }
  function toolSetView(inp) {
    const is3 = B().is3D();
    if (inp.mode === '3d' && !is3) feedCmd('3d');
    if (inp.mode === '2d' && is3) feedCmd('3d');
    if (inp.fit) feedCmd('zoom');
    return { view: B().is3D() ? '3d' : '2d' };
  }
  function toolSelect(inp) {
    const S = B().state;
    S.selection.clear();
    let n = 0;
    for (const e of byIds(inp.ids)) { S.selection.add(e.id); n++; }
    return { selected: n };
  }
  function toolScreenshot() { // 현재 뷰 캡처 → 모델에 이미지로 전달 (자가 검증용)
    const cv = B().is3D() ? document.getElementById('b3cv') : document.getElementById('cv');
    if (!cv || cv.width < 8) return { error: '캔버스를 캡처할 수 없습니다.' };
    const scale = Math.min(1, 1024 / cv.width);
    const oc = document.createElement('canvas');
    oc.width = Math.max(1, Math.round(cv.width * scale));
    oc.height = Math.max(1, Math.round(cv.height * scale));
    const c2 = oc.getContext('2d');
    c2.fillStyle = '#0d1117'; c2.fillRect(0, 0, oc.width, oc.height); // JPEG 투명 배경 방지
    c2.drawImage(cv, 0, 0, oc.width, oc.height);
    const data = oc.toDataURL('image/jpeg', 0.72).split(',')[1];
    return { __image: data, __media: 'image/jpeg', note: (B().is3D() ? '3D' : '2D 평면') + ' 뷰 스크린샷' };
  }
  function toolMeasure(inp) {
    inp = inp || {};
    if (Array.isArray(inp.from) && Array.isArray(inp.to)) {
      const d = Math.hypot((inp.to[0] || 0) - (inp.from[0] || 0), (inp.to[1] || 0) - (inp.from[1] || 0), (inp.to[2] || 0) - (inp.from[2] || 0));
      return { distance_mm: Math.round(d * 100) / 100 };
    }
    if (Array.isArray(inp.ids) && inp.ids.length) {
      const out = [];
      for (const e of byIds(inp.ids)) {
        const o = { id: e.id, type: e.type };
        try { const L = B().entityLength(e); if (isFinite(L)) o.length_mm = Math.round(L); } catch (err) {}
        if (e.type === 'CIRCLE') o.area_mm2 = Math.round(Math.PI * e.r * e.r);
        else if (e.type === 'LWPOLYLINE' && e.closed) { try { o.area_mm2 = Math.round(Math.abs(B().polyArea(e.points))); } catch (err) {} }
        const bb = safeBBox(e); if (bb) o.bbox = [bb.xmin, bb.ymin, bb.xmax, bb.ymax].map(Math.round);
        if (e.bim) o.bim = e.bim;
        out.push(o);
      }
      return { entities: out };
    }
    const S = B().state; let bb = null;
    for (const e of S.entities) {
      const b = safeBBox(e); if (!b) continue;
      bb = bb ? { xmin: Math.min(bb.xmin, b.xmin), ymin: Math.min(bb.ymin, b.ymin), xmax: Math.max(bb.xmax, b.xmax), ymax: Math.max(bb.ymax, b.ymax) } : Object.assign({}, b);
    }
    return { totalEntities: S.entities.length, bbox: bb ? [bb.xmin, bb.ymin, bb.xmax, bb.ymax].map(Math.round) : null };
  }

  // ---------- 이미지 → 도면 도구들 ----------
  let lastImg = null; // 사용자가 채팅에 첨부한 최신 이미지 {dataUrl, w, h(px)} — set_underlay 가 쓴다
  let lastConcept = null; // 마지막 다동 배치 spec — "6동 2층으로 다시" 같은 후속 수정에 쓴다
  function toolSetUnderlay(inp) {
    if (!lastImg) return { error: '첨부된 이미지가 없습니다. 사용자에게 도면 이미지를 채팅에 첨부해 달라고 요청하세요(📎 버튼 또는 붙여넣기).' };
    if (!fin(inp.width_mm) || inp.width_mm <= 0) return { error: 'width_mm(이미지의 실제 폭)가 필요합니다.' };
    ensureUndo();
    const S = B().state;
    // 기존 밑그림 IMAGE 는 교체 (같은 이미지를 다시 깔며 중복되지 않게)
    const olds = S.entities.filter(e => e.type === 'IMAGE' && e.layer === '밑그림');
    if (olds.length) { const ids = new Set(olds.map(e => e.id)); S.entities = S.entities.filter(e => !ids.has(e.id)); }
    const lay = B().ensureLayer('밑그림', '#8a8a94'); lay.locked = false;
    const w = inp.width_mm, h = w * lastImg.h / lastImg.w;
    const op = fin(inp.opacity) ? Math.min(1, Math.max(0.1, inp.opacity)) : 0.55;
    const e = B().addEntity({ type: 'IMAGE', layer: '밑그림', x: fin(inp.x) ? inp.x : 0, y: fin(inp.y) ? inp.y : 0,
      w, h, src: lastImg.dataUrl, rot: 0, op, sat: 1, bri: 1 });
    return { id: e.id, w_mm: Math.round(w), h_mm: Math.round(h), replaced: olds.length || undefined,
      note: '이미지 좌하단=(x,y), 우상단=(x+w_mm, y+h_mm). 이 좌표계 위에 벽 중심선을 그리세요.' };
  }
  function toolMakeViews(inp) {
    const S = B().state;
    // 모델 bbox (BIM 개체 기준)
    let bb = null;
    for (const e of S.entities) {
      if (!e.bim) continue;
      const b = safeBBox(e); if (!b) continue;
      bb = bb ? { xmin: Math.min(bb.xmin, b.xmin), ymin: Math.min(bb.ymin, b.ymin), xmax: Math.max(bb.xmax, b.xmax), ymax: Math.max(bb.ymax, b.ymax) } : Object.assign({}, b);
    }
    if (!bb) return { error: 'BIM 개체(벽·슬래브 등)가 없습니다 — 먼저 모델을 만드세요.' };
    const depth = fin(inp.depth) && inp.depth > 0 ? inp.depth : 30000;
    const M = 2000; // 절단선을 모델 밖에 두는 여유
    let p1, u, nrm, L;
    if (inp.kind === 'elevation') {
      const edge = inp.edge || 'front';
      if (edge === 'front')      { p1 = { x: bb.xmin, y: bb.ymin - M }; u = { x: 1, y: 0 }; nrm = { x: 0, y: 1 }; L = bb.xmax - bb.xmin; }
      else if (edge === 'back')  { p1 = { x: bb.xmax, y: bb.ymax + M }; u = { x: -1, y: 0 }; nrm = { x: 0, y: -1 }; L = bb.xmax - bb.xmin; }
      else if (edge === 'left')  { p1 = { x: bb.xmin - M, y: bb.ymax }; u = { x: 0, y: -1 }; nrm = { x: 1, y: 0 }; L = bb.ymax - bb.ymin; }
      else                       { p1 = { x: bb.xmax + M, y: bb.ymin }; u = { x: 0, y: 1 }; nrm = { x: -1, y: 0 }; L = bb.ymax - bb.ymin; }
    } else {
      const axis = inp.axis || 'y';
      if (axis === 'y') { // y=at 가로 절단선 — 북쪽(+y)을 바라봄
        const at = fin(inp.at) ? inp.at : (bb.ymin + bb.ymax) / 2;
        p1 = { x: bb.xmin, y: at }; u = { x: 1, y: 0 }; nrm = { x: 0, y: 1 }; L = bb.xmax - bb.xmin;
      } else {            // x=at 세로 절단선 — 동쪽(+x)을 바라봄
        const at = fin(inp.at) ? inp.at : (bb.xmin + bb.xmax) / 2;
        p1 = { x: at, y: bb.ymin }; u = { x: 0, y: 1 }; nrm = { x: 1, y: 0 }; L = bb.ymax - bb.ymin;
      }
    }
    if (!(L > 0)) return { error: '모델 크기를 판단할 수 없습니다.' };
    // genSectionView 는 결과를 '새 도면 탭' 으로 만든다 — 생성 후 원본 탭으로 복귀해야
    // 이어지는 도구들(벽 추가·문 배치 등)이 계속 원본 도면에서 작동한다.
    const home = B().getCurDoc();
    B().genSectionView(p1, u, nrm, L, depth, inp.kind === 'elevation');
    const nowDoc = B().getCurDoc();
    if (nowDoc === home) return { error: '생성된 요소가 없습니다 — BIM 개체가 있는지, 절단선이 모델과 만나는지 확인하세요.' };
    const viewName = B().getDocName();
    const made = S.entities.length;              // 새 탭 = 방금 만든 뷰 요소들뿐
    B().switchDoc(home);                          // 원본 도면으로 복귀
    return { kind: inp.kind, edge: inp.edge, axis: inp.axis, created: made, tab: viewName,
      note: `'${viewName}' 새 도면 탭에 생성되었습니다(화면 하단 탭에서 열람). 지금은 원본 도면 탭으로 복귀한 상태 — 계속 작업 가능합니다.` };
  }
  const LAYER_RULES = [ // [레이어명, 색, 판정]
    ['밑그림', '#8a8a94', e => e.type === 'IMAGE'],
    ['벽',     '#cfc7ba', e => e.bim && e.bim.kind === 'wall'],
    ['기둥',   '#8fa3c8', e => e.bim && e.bim.kind === 'column'],
    ['슬래브', '#9aa2af', e => e.bim && e.bim.kind === 'slab'],
    ['지붕',   '#b08968', e => e.bim && e.bim.kind === 'roof'],
    ['계단',   '#c8b273', e => e.bim && e.bim.kind === 'stair'],
    ['난간',   '#9c8fc8', e => e.bim && e.bim.kind === 'railing'],
    ['개구부', '#ff9f0a', e => e.bim && e.bim.kind === 'opening'],
    ['문자',   '#d0d0d8', e => e.type === 'TEXT'],
    ['치수',   '#5dff8f', e => /^DIM/.test(e.type) || e.type === 'LEADER'],
  ];
  function toolOrganizeLayers() {
    const S = B().state;
    ensureUndo();
    const moved = {};
    for (const e of S.entities) {
      for (const [name, color, test] of LAYER_RULES) {
        if (!test(e)) continue;
        if (e.layer !== name) { B().ensureLayer(name, color); e.layer = name; moved[name] = (moved[name] || 0) + 1; }
        break;   // 첫 매칭 규칙만
      }
    }
    // 치수·문자·기본('0') 외에 남은 비BIM 도형은 건드리지 않는다 — 사용자의 의도적 배치일 수 있다
    try { B().renderLayers(); } catch (e) {}
    return { moved, note: 'BIM 종류·타입이 분명한 개체만 이동했습니다. 가구 등 일반 도형은 "가구" 레이어를 직접 지정해 생성하세요(add_entities layer 필드).' };
  }

  function toolNodeGraph(inp) { // 파라메트릭 노드 그래프 (nodes.js 연동)
    const N = window.WEBCAD_NODES;
    if (!N) return { error: '노드 에디터 모듈이 로드되지 않았습니다.' };
    inp = inp || {};
    if (inp.action === 'get') return N.getGraph();
    if (inp.action === 'bake') return N.bake();
    if (inp.action === 'clear') return N.clearGraph();
    if (inp.action === 'replace') {
      if (!Array.isArray(inp.nodes) || !inp.nodes.length) return { error: 'replace에는 nodes 배열이 필요합니다.' };
      if (inp.nodes.length > 60) return { error: '노드는 최대 60개까지 가능합니다.' };
      return N.setGraph(inp.nodes);
    }
    return { error: '지원하지 않는 action: ' + inp.action };
  }

  function execTool(name, input) {
    try {
      switch (name) {
        case 'get_drawing': return toolGetDrawing(input);
        case 'add_entities': return toolAddEntities(input);
        case 'update_entities': return toolUpdateEntities(input);
        case 'delete_entities': return toolDeleteEntities(input);
        case 'transform_entities': return toolTransform(input);
        case 'boolean_op': return toolBoolean(input);
        case 'set_view': return toolSetView(input);
        case 'select_entities': return toolSelect(input);
        case 'get_screenshot': return toolScreenshot();
        case 'measure': return toolMeasure(input);
        case 'set_underlay': return toolSetUnderlay(input || {});
        case 'set_sketch_params': {
          const S3 = window.WEBCAD_SKETCH;
          if (!S3 || !S3.setParams) return { error: '스케치 모듈이 없습니다.' };
          return S3.setParams(input || {});
        }
        case 'make_views': return toolMakeViews(input || {});
        case 'organize_layers': return toolOrganizeLayers();
        case 'edit_node_graph': return toolNodeGraph(input);
        default: return { error: '알 수 없는 도구: ' + name };
      }
    } catch (err) {
      return { error: String(err && err.message || err) };
    }
  }

  let busy = false;
  const TOOL_KO = { get_drawing: '도면 파악', add_entities: '개체 생성', update_entities: '속성 수정', delete_entities: '삭제', transform_entities: '이동/회전', boolean_op: '불리언', set_view: '뷰 전환', select_entities: '선택 표시', get_screenshot: '화면 확인', measure: '측정', edit_node_graph: '노드 그래프', set_underlay: '밑그림 삽입', make_views: '입면/단면 생성', organize_layers: '레이어 정리' };

  // ---------- UI ----------
  const css = `
  /* AI 코워커 토글: 하단 탭 라인의 모듈 탭(.modTab — skin.css) — 노드 탭과 같은 디자인 */
  #aiFab{gap:6px;}
  #aiPanel{position:fixed;right:14px;bottom:68px;z-index:9001;width:360px;max-width:calc(100vw - 28px);height:500px;max-height:calc(100vh - 90px);
    display:none;flex-direction:column;background:#111a30;border:1px solid #33406a;border-radius:12px;overflow:hidden;
    box-shadow:0 10px 34px rgba(0,0,0,.55);font:13px/1.5 -apple-system,system-ui,sans-serif;color:#dbe6ff;
    user-select:text;-webkit-user-select:text;}  /* 앱 전역 user-select:none 재정의 — 채팅은 드래그로 긁어 복사할 수 있어야 (오류 공유 등) */
  #aiMsgs .aiM{cursor:text}
  #aiHead{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#16213c;border-bottom:1px solid #2a3760;}
  #aiHead b{flex:1;font-size:13px}
  #aiHead button{background:none;border:none;color:#8fa4d4;font-size:14px;cursor:pointer;padding:2px 5px}
  #aiHead button:hover{color:#fff}
  #aiMsgs{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px}
  .aiM{max-width:92%;padding:7px 10px;border-radius:10px;white-space:pre-wrap;word-break:break-word}
  .aiM.user{align-self:flex-end;background:#2a54b0;color:#fff;border-bottom-right-radius:3px}
  .aiM.ai{align-self:flex-start;background:#1b2748;border:1px solid #2a3760;border-bottom-left-radius:3px}
  .aiM.tool{align-self:flex-start;background:none;color:#7f95c8;font-size:11.5px;padding:0 4px}
  .aiM.err{align-self:flex-start;background:#3a1b22;border:1px solid #6a2a38;color:#ffb9c4}
  #aiAtt{display:none;gap:6px;padding:6px 8px 0;background:#16213c;align-items:center}
  #aiAtt img{height:44px;border-radius:6px;border:1px solid #2a3760}
  #aiAtt button{background:#3a1b22;border:1px solid #6a2a38;color:#ffb9c4;border-radius:6px;font-size:11px;cursor:pointer;padding:2px 6px}
  #aiInRow{display:flex;gap:6px;padding:8px;border-top:1px solid #2a3760;background:#16213c}
  #aiClip{flex:0 0 auto;width:34px;border:1px solid #2a3760;border-radius:8px;background:#0e1730;color:#cfe0ff;font-size:15px;cursor:pointer}
  #aiClip:hover{background:#1d2b4f}
  #aiIn{flex:1;resize:none;height:38px;background:#0e1730;color:#eaf2ff;border:1px solid #2a3760;border-radius:8px;padding:7px 9px;font:13px/1.4 inherit}
  #aiSend{width:60px;border:none;border-radius:8px;background:#2a54b0;color:#fff;font-weight:700;cursor:pointer}
  #aiSend:disabled{opacity:.45;cursor:default}
  /* ── 라이트 테마 (html.light) — 앱 화면 필터를 따라간다 ── */
  /* (#aiFab 는 테마 변수 기반이라 라이트 전용 재정의 불필요) */
  html.light #aiPanel{background:#f7f8fc;border-color:rgba(20,40,90,.25);color:#1c2440;
    box-shadow:0 10px 34px rgba(30,50,100,.28)}
  html.light #aiHead{background:#e9edf5;border-bottom:1px solid rgba(20,40,90,.13)}
  html.light #aiHead button{color:#51617f}
  html.light #aiHead button:hover{color:#10162c}
  html.light .aiM.user{background:#0071e3;color:#fff}
  html.light .aiM.ai{background:#eef1f7;border-color:rgba(20,40,90,.15);color:#1c2440}
  html.light .aiM.tool{color:#5a6a92}
  html.light .aiM.err{background:#fdeaea;border-color:#e5b5bb;color:#9c2b3a}
  html.light #aiAtt{background:#e9edf5}
  html.light #aiAtt img{border-color:rgba(20,40,90,.2)}
  html.light #aiAtt button{background:#fdeaea;border-color:#e5b5bb;color:#9c2b3a}
  html.light #aiInRow{background:#e9edf5;border-top:1px solid rgba(20,40,90,.13)}
  html.light #aiClip{background:#fff;color:#20305c;border-color:rgba(20,40,90,.25)}
  html.light #aiClip:hover{background:#e8f0fe}
  html.light #aiIn{background:#fff;color:#151a2c;border-color:rgba(20,40,90,.25)}
  html.light #aiSend{background:#0071e3}
  `;

  function h(tag, attrs, html) {
    const el = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]);
    if (html != null) el.innerHTML = html;
    return el;
  }
  let panel, msgsEl, inEl, sendBtn, attEl;
  // ---------- 이미지 첨부 (비전) ----------
  let pendingImgs = []; // [{data(base64), media, w, h}] — 다음 전송에 실릴 이미지 (최대 3)
  function attachImage(file) {
    if (!file) return;
    if (pendingImgs.length >= 3) { addMsg('err', '이미지는 한 번에 최대 3장까지 첨부할 수 있습니다.'); return; }
    const rd = new FileReader();
    rd.onload = () => {
      const img = new Image();
      img.onload = () => {
        // Claude 비전 권장 크기로 축소 (긴 변 1568px) — 토큰·전송량 절약, 도면 판독에는 충분
        const k = Math.min(1, 1568 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
        const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); // PNG 투명부는 흰 종이로
        g.drawImage(img, 0, 0, c.width, c.height);
        const dataUrl = c.toDataURL('image/jpeg', 0.85);
        pendingImgs.push({ data: dataUrl.split(',')[1], media: 'image/jpeg', w: c.width, h: c.height, dataUrl });
        renderAtt();
      };
      img.onerror = () => addMsg('err', '이미지를 읽지 못했습니다.');
      img.src = rd.result;
    };
    rd.readAsDataURL(file);
  }
  function renderAtt() {
    if (!attEl) return;
    attEl.innerHTML = '';
    if (!pendingImgs.length) { attEl.style.display = 'none'; return; }
    attEl.style.display = 'flex';
    pendingImgs.forEach((p, i) => {
      const im = document.createElement('img'); im.src = p.dataUrl; attEl.appendChild(im);
      const x = h('button', { title: '첨부 취소' }, '✕');
      x.addEventListener('click', () => { pendingImgs.splice(i, 1); renderAtt(); });
      attEl.appendChild(x);
    });
    const hint = h('span', { style: 'font-size:11px;color:#8fa4d4' }, '보내기를 누르면 이 도면을 분석해 작도합니다');
    attEl.appendChild(hint);
  }
  function buildUI() {
    document.head.appendChild(h('style', null, css));
    // 이모지 대신 라인 아이콘(봇) — 상단바 다른 버튼과 같은 스트로크 문법
    const IC_BOT = '<svg class="ic" viewBox="0 0 24 24"><rect x="4.5" y="9" width="15" height="10" rx="2.5"/><circle cx="12" cy="4.3" r="1.1"/><path d="M12 9V5.8M9.3 13v2M14.7 13v2M2 13.5v2M22 13.5v2"/></svg>';
    const fab = h('button', { id: 'aiFab', title: 'AI 코워커 (자연어 작도)' });
    fab.innerHTML = IC_BOT;
    fab.addEventListener('click', () => {
      panel.style.display = panel.style.display === 'flex' ? 'none' : 'flex';
      fab.classList.toggle('on', panel.style.display === 'flex');   // 열림=활성 pill
      if (panel.style.display === 'flex') inEl.focus();
    });
    panel = h('div', { id: 'aiPanel' });
    // 패널 안의 키 입력은 앱 전역 단축키로 새지 않게 — 채팅 텍스트를 긁어 Ctrl+C 하면
    // 브라우저 기본 복사가 되어야 한다 (전역 핸들러는 Ctrl+C 를 '개체 복사' 로 가로챈다)
    panel.addEventListener('keydown', (e) => e.stopPropagation());
    const head = h('div', { id: 'aiHead' });
    const headTitle = h('b');
    headTitle.innerHTML = IC_BOT + ' AI 코워커';
    head.appendChild(headTitle);
    const clrBtn = h('button', { title: '대화 초기화' });
    clrBtn.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><path d="M4.5 7h15M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7M6.5 7l1 12.5h9L17.5 7M10 10.5v6M14 10.5v6"/></svg>';
    clrBtn.addEventListener('click', () => { msgsEl.innerHTML = ''; greet(); });
    head.appendChild(clrBtn);
    const closeBtn = h('button', { title: '닫기' }, '✕');
    closeBtn.addEventListener('click', () => { panel.style.display = 'none'; });
    head.appendChild(closeBtn);
    panel.appendChild(head);
    if (window.webcadPopupDrag) window.webcadPopupDrag(panel, head); // 제목줄을 잡고 위치 이동
    msgsEl = h('div', { id: 'aiMsgs' });
    panel.appendChild(msgsEl);
    // 첨부 미리보기 칩 (이미지 → 도면 워크플로의 입구)
    attEl = h('div', { id: 'aiAtt' });
    panel.appendChild(attEl);
    const row = h('div', { id: 'aiInRow' });
    const clipBtn = h('button', { id: 'aiClip', title: '도면 이미지 첨부 (붙여넣기 Ctrl+V·드래그도 가능)' });
    clipBtn.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><path d="M20.5 11.5l-8 8a5.2 5.2 0 0 1-7.4-7.4l8.6-8.6a3.5 3.5 0 0 1 4.9 4.9l-8.6 8.6a1.75 1.75 0 0 1-2.5-2.5l8-8"/></svg>';
    const fileIn = h('input', { type: 'file', accept: 'image/*', style: 'display:none' });
    clipBtn.addEventListener('click', () => fileIn.click());
    fileIn.addEventListener('change', () => { if (fileIn.files && fileIn.files[0]) attachImage(fileIn.files[0]); fileIn.value = ''; });
    inEl = h('textarea', { id: 'aiIn', placeholder: '예: 5000×4000 방 그려줘 · 도면 이미지를 첨부하면 그대로 모델링해 드립니다' });
    inEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
      e.stopPropagation(); // 앱 전역 단축키와 충돌 방지
    });
    inEl.addEventListener('paste', (e) => { // 클립보드 이미지 붙여넣기
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (const it of items) if (it.type && it.type.startsWith('image/')) { e.preventDefault(); attachImage(it.getAsFile()); return; }
    });
    panel.addEventListener('dragover', (e) => { e.preventDefault(); });
    panel.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f && f.type.startsWith('image/')) attachImage(f);
    });
    sendBtn = h('button', { id: 'aiSend' }, '보내기');
    sendBtn.addEventListener('click', () => { if (!busy) submit(); });
    row.appendChild(clipBtn); row.appendChild(inEl); row.appendChild(sendBtn);
    panel.appendChild(row);
    // AI 토글은 하단 탭 라인(팝업창 줄) — 노드 왼쪽 (2026-07-20, 상단바에서 이동)
    fab.classList.add('modTab');
    fab.innerHTML = IC_BOT + ' <span class="tl">코워커</span>';
    const dtBar = document.getElementById('docTabs');
    if (dtBar) {
      dtBar.insertBefore(fab, window.__nodeTabBtn && window.__nodeTabBtn.parentNode === dtBar ? window.__nodeTabBtn : dtBar.firstChild);
      window.__aiTabBtn = fab;
      if (window.__syncBottomTabs) window.__syncBottomTabs();
    } else document.body.appendChild(fab); // 폴백
    document.body.appendChild(panel);
    greet();
  }
  function greet() {
    // ★대화는 저장하지 않는다 — 새로고침하면 사라진다(로컬 모드의 원래 동작).
    // ★연결 상태는 여기서 말하지 않는다. greet 은 패널을 만들 때 한 번 돌고 브리지는 그 뒤에
    //   붙으므로, 여기서 판정하면 이미 연결됐는데 "MCP 를 쓰세요"라고 하는 어긋남이 생긴다.
    //   연결됐다는 사실은 mcp.js 가 붙는 순간 직접 알린다(notify).
    addMsg('ai', '안녕하세요! 지금은 **로컬 모드**입니다 — 키 없이 건축 지식 알고리즘으로 바로 씁니다.\n'
      + '예) "10평 원룸 그려줘" · "25평 투룸" · 도면 이미지를 첨부하고 "이 도면 따라 그려줘" · "건물화해줘"\n'
      + '무엇을 할 수 있는지 궁금하면 "도움말" 이라고 보내 주세요.\n\n'
      + '💡 자유로운 자연어 대화는 **MCP** 로 합니다 — Claude 가 이 도면을 직접 만집니다 '
      + '(parti-mcp/README.md).');
  }
  function addMsg(kind, text) {
    if (!msgsEl) return;
    const d = h('div', { class: 'aiM ' + kind });
    d.textContent = text;
    msgsEl.appendChild(d);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }
  let busyEl = null;
  function setBusy(on) {
    if (sendBtn) { sendBtn.textContent = on ? '⏹ 중단' : '보내기'; sendBtn.disabled = false; }
    if (on) { busyEl = h('div', { class: 'aiM tool' }, '⋯ 작업 중'); msgsEl.appendChild(busyEl); msgsEl.scrollTop = msgsEl.scrollHeight; }
    else if (busyEl) { busyEl.remove(); busyEl = null; }
  }
  // ============================================================
  //  로컬 코워커 — API 키 없이, 건축 지식 알고리즘만으로 작도·모델링
  //  (arch.js 평면 생성 · vision.js 이미지 벡터화 · 기존 sketch/bimify 파이프라인 재사용)
  // ============================================================
  const numOf = (s, re) => { const m = String(s).match(re); return m ? parseFloat(m[1]) : null; };
  function wallsTarget() {                      // 선택이 있으면 선택, 없으면 전체 벽
    const S = B().state;
    const sel = [...S.selection].map(id => S.entities.find(e => e.id === id)).filter(e => e && e.bim && e.bim.kind === 'wall');
    return sel.length ? sel : S.entities.filter(e => e.bim && e.bim.kind === 'wall');
  }
  const LOCAL_HELP = '지금은 **로컬 모드**입니다 — API 키 없이 건축 지식 알고리즘으로 동작합니다.\n\n'
    + '· "10평 원룸 그려줘" / "25평 투룸" / "84㎡ 쓰리룸" — 평면 자동 생성(벽·문·창·실명)\n'
    + '· 도면 이미지 첨부 후 "이 도면 따라 그려줘" — 이미지를 선으로 벡터화\n'
    + '· 건물 사진 첨부 후 "이 건물 매스로 만들어줘" — 층수·베이를 읽어 매스 근사\n'
    + '· "박공 5동 1층 원형 배치로 세워줘" — 여러 동 + 지붕 + 원형 마당 (콘셉트 스케치 구성)\n'
    + '· "기운 상자" "텐트" "쐐기" "각뿔" "원뿔" "원통" "톱니 지붕" "좁아지는 매스" — 임의 형상 매스\n'
    + '· "인식해줘" / "건물화해줘" — 스케치를 도형·3D 건물로\n'
    + '· "벽 높이 2700" / "벽 두께 200" — 벽 속성 변경\n'
    + '· "3D 보여줘" / "평면" / "4분할" · "단면 만들어줘" / "입면"\n'
    + '· "선이 자꾸 곡선으로 인식돼" — 스케치 보정값 조정\n\n'
    + 'API 키를 넣으면(⚙) 자유로운 자연어 대화로 확장됩니다.';

  // 문장에서 다동 배치 지시를 뽑는다. 이미지 자동 판독과 합칠 때 '명시 지시가 이긴다'.
  // (지정 안 한 항목은 undefined 로 남겨 호출 측이 판독값·기본값을 채우게 한다)
  function parseComplexSpec(t) {
    const o = {};
    const n = numOf(t, /(\d+)\s*동/); if (n) o.count = n;
    // ── 층별 구성 — "1층은 상가", "2층 사무실" ──
    // ★이 구절의 '1층'은 층수가 아니다. 먼저 떼어 내지 않으면 "5동 4층, 1층은 상가" 에서
    //   층수를 1로 읽는다(가장 먼저 나온 숫자+층을 집는 규칙이라).
    const fpm = {};
    let t2 = t;
    const reF = /(\d+)\s*층\s*(?:은|는|을|를|에|:)?\s*(상가|점포|근린생활|근생|리테일|필로티|피로티|사무실|오피스|원룸|투룸|쓰리룸|작업실|공방)/g;
    let mF;
    while ((mF = reF.exec(t))) {
      const pg = window.PARTI_ARCH && window.PARTI_ARCH.programOf(mF[2]);
      if (pg) { fpm[+mF[1]] = pg; t2 = t2.replace(mF[0], ' '); }
    }
    if (Object.keys(fpm).length) o.floorProgram = fpm;
    const f = numOf(t2, /(\d+)\s*층/); if (f) o.floors = f;
    const w = numOf(t, /(\d+(?:\.\d+)?)\s*[x×]\s*\d+(?:\.\d+)?\s*m/);
    const d = numOf(t, /\d+(?:\.\d+)?\s*[x×]\s*(\d+(?:\.\d+)?)\s*m/);
    if (w) o.w = w * 1000; if (d) o.d = d * 1000;
    if (/평지붕|평평|플랫/.test(t)) o.roof = 'flat';
    else if (/외쪽|한쪽|시드/.test(t)) o.roof = 'shed';
    else if (/박공|게이블|맞배/.test(t)) o.roof = 'gable';
    if (/일렬|한 ?줄|나란|선형/.test(t)) o.arrange = 'row';
    else if (/원형|중정|마당 ?둘레|둥글게/.test(t)) o.arrange = 'circle';
    if (/유리 ?없|창 ?없/.test(t)) o.glass = false;
    // 발코니·처마 — "발코니 없이", "처마 깊게", "처마 600"
    if (/발코니\s*(없|빼|제외)/.test(t)) o.balcony = false;
    else if (/발코니/.test(t)) o.balcony = true;
    const em = numOf(t, /처마\s*(\d{3,4})/);
    if (em) o.eaveOvh = em;
    else if (/처마\s*(?:를)?\s*(?:더\s*)?(깊게|길게|넓게|많이)/.test(t)) o.eaveOvh = 600;
    // 동별 깊이 — "깊이 8,12,12,14,20m" 처럼 쉼표로 나열하면 그대로 쓴다.
    // (단일 투시에서 깊이는 자동으로 못 읽는다 — 판독기가 재려 했다가 잡음만 재서 철회했다)
    const dm = t.match(/깊이\s*([\d.,\s\/]+)\s*m/);
    if (dm) {
      const list = dm[1].split(/[,\/\s]+/).map(v => parseFloat(v)).filter(v => v > 0);
      if (list.length > 1) o.depths = list.map(v => Math.round(v * 1000));
      // ★단일 깊이를 새로 말하면 이전 '나열'을 지워야 한다 — 안 그러면 후속 병합 때
      //   옛 목록이 살아남아 새 지시가 먹히지 않는다(실측).
      else if (list.length === 1) { o.d = Math.round(list[0] * 1000); o.depths = null; }
    }
    return o;
  }

  async function localReply(text, imgs) {
    const t = String(text || '').trim();
    const SKm = window.WEBCAD_SKETCH;
    // ⓪ 직전 결과에 대한 후속 지시 — "매스로 만들어줘", "6동 2층 한 동 10×14m 로 다시"
    // ★이미지 없이 온 이 문장들이 '이해 못 함'으로 떨어지던 게 실사용 실패 지점이었다.
    //   재구성 판정: 동 수를 다시 말했거나(가장 확실한 신호), 다시/바꿔 + 바뀐 항목이 있을 때.
    //   ('3층 단면 만들어줘' 처럼 층수만 스친 문장이 배치를 갈아엎지 않도록 이 두 경우로 한정)
    if ((!imgs || !imgs.length) && window.PARTI_ARCH) {
      const exp = parseComplexSpec(t);
      const has = exp.count || exp.floors || exp.w || exp.d || exp.roof || exp.arrange
        || exp.glass != null || (exp.depths && exp.depths.length) || exp.floorProgram
        || exp.balcony != null || exp.eaveOvh;
      if (lastConcept && (exp.count || (has && /다시|바꿔|변경|수정|말고/.test(t)))) {
        const spec = Object.assign({}, lastConcept, exp);
        const r = window.PARTI_ARCH.buildComplex(spec);
        if (r) {
          lastConcept = spec;
          execTool('set_view', { mode: '3d' });
          const roofKo = { gable: '박공지붕', flat: '평지붕', shed: '외쪽지붕' }[spec.roof] || spec.roof;
          return `다시 세웠습니다 — **${r.n}동 · ${spec.floors}층 · ${roofKo} · `
            + `${spec.arrange === 'circle' ? '원형 마당' : '일렬'} 배치**, 각 동 ${(spec.w / 1000).toFixed(0)}×${(spec.d / 1000).toFixed(0)}m.\n`
            + '(되돌리기: Ctrl+Z)';
        }
      }
    }
    if ((!imgs || !imgs.length) && lastImg && window.PARTI_VISION
        && /매스|매싱|그래도|어쨌든|일단|다시 세|그대로 세|세워|만들어/.test(t)) {
      const exp = parseComplexSpec(t);
      if (/매스|매싱|파사드|외관/.test(t) && window.PARTI_ARCH) {
        const f = await window.PARTI_VISION.traceFacade(lastImg.dataUrl,
          { floorH: numOf(t, /층고\s*(\d{3,5})/) || 3000 });
        const m = window.PARTI_ARCH.buildMassing({ floors: exp.floors || f.floors, bays: f.bays,
          windows: f.windows, widthMM: f.meta.widthMM, depthMM: f.meta.depthMM, floorH: f.meta.floorH });
        execTool('set_view', { mode: '3d' });
        return `직전 이미지로 매스를 세웠습니다 — **${f.floors}층 · ${f.bays}베이**, `
          + `${(m.W / 1000).toFixed(1)}×${(m.D / 1000).toFixed(1)}×${(m.H / 1000).toFixed(1)}m (창 ${m.counts.window}개).\n`
          + `창 격자 신뢰도가 낮았으니(${Math.round((f.meta.conf || 0) * 100)}%) 치수는 참고용입니다.`;
      }
      void exp;
    }
    // ① 이미지 처리 — 붙어 있으면 최우선. 전 장 처리(마지막 한 장만 쓰던 것 수정).
    // ★도면/사진 판별은 픽셀로 한다(classifyImage). 문장 키워드로 하면 "건물의 도면
    //   만들어줘"의 '건물' 때문에 도면 이미지가 매싱 경로로 오판된다(실사용 보고).
    //   문장은 '매스로/매싱' 처럼 명시적으로 매싱을 요구할 때만 우선한다.
    if (imgs && imgs.length && window.PARTI_VISION) {
      const V = window.PARTI_VISION;
      lastImg = imgs[imgs.length - 1];
      const wmm = numOf(t, /(\d{3,6})\s*mm/) || (numOf(t, /(?:폭|가로)?\s*(\d+(?:\.\d+)?)\s*m\b/) || 0) * 1000 || 10000;
      const forceMass = /매스|매싱|볼륨|파사드|외관/.test(t);
      const forcePlan = /평면도|도면 (그대로|따라)|트레이스/.test(t);
      const fh = numOf(t, /층고\s*(\d{3,5})/) || 3000;
      const exp = parseComplexSpec(t);        // 문장의 명시 지시 — 자동 판독보다 우선한다
      const lines = []; let planN = 0, massN = 0, cpxN = 0, cursorX = 0, nearPlanSaid = false;
      const allStrokes = [];
      for (const img of imgs) {
        const cls = await V.classifyImage(img.dataUrl);
        // ★라우팅을 분류기에 맡기지 않는다. 전역 통계로 미리 맞히려던 방식이 실물에서 두 번
        //   뒤집혔다(스케치를 사진으로, 다음엔 도면으로 → 손그림 획이 벽 52개가 됐다).
        //   대신 '실제로 해석해 보고 증거가 뒷받침될 때만 채택'한다. 분류 결과는 설명용.
        //   도면 채택 근거 3가지 — 무채색(도면은 색이 없다) · 잉크 설명률 · 이중선 쌍의 존재.
        // ★사선이 지배적이면 직교 도면도, 정면 파사드도 아니다 — 투시로 그린 그림이다.
        //   이 한 기준이 두 오판(손그림→벽 52개 / 손그림→2층 박스)을 모두 막는다.
        const orthoish = (cls.diagRatio || 0) < 0.35;
        if (!forceMass) {
          const r = await V.traceImage(img.dataUrl, { widthMM: wmm });
          const vd = planVerdict(r, cls, forcePlan);
          const isPlan = vd.isPlan;
          if (isPlan) {
            for (const s of r.strokes) { for (const p of s.pts) p[0] += cursorX; allStrokes.push(s); }
            cursorX += r.meta.widthMM + 4000; planN++;
            lines.push(`· 도면 → 벽 ${r.meta.walls} · 참고선 ${r.meta.guides} · 문 후보 ${r.meta.doors} (가로 ${(r.meta.widthMM / 1000).toFixed(1)}m 가정)`);
            continue;
          }
          // ★도면인데 관문에 걸린 경우를 조용히 넘기지 않는다.
          //   실제 1:50 평면도(가구·해칭·표제란·색 채움이 있는)를 넣어 보니 이중선 쌍은 53개나
          //   찾았는데 '잉크 설명률'이 0.43 이라 도면으로 채택되지 않고 매싱으로 갔다
          //   ("1동 박공"으로 읽혔다). 임계를 낮추면 UI 목업 같은 직교 그림까지 도면이 되므로
          //   자동 채택은 그대로 두고, 대신 '왜 안 됐는지'와 '어떻게 강제하는지'를 알려 준다.
          if (vd.nearPlan && !nearPlanSaid) {
            nearPlanSaid = true;
            lines.push('· ⚠ 도면일 수 있습니다 — 이중선 쌍 ' + r.meta.paired + '개를 찾았지만'
              + ' 잉크 설명률 ' + r.meta.coverage + (cls.chromaRatio >= 0.05 ? ' · 채색 ' + cls.chromaRatio : '')
              + ' 라서 도면으로 자동 채택하지 않았습니다.'
              + ' 도면 그대로 읽으려면 **"도면 그대로"** 라고 덧붙여 주세요.');
          }
        }
        // 도면이 아니다 → 정면 사진처럼 창 격자가 또렷하면 파사드 매싱.
        // ★단, 마당을 낀 여러 동이 읽히면 그건 '한 덩어리 파사드'가 아니라 배치 스케치다.
        //   (평지붕 4동 + 앞마당이 파사드 격자로 잡혀 한 채로 뭉치던 문제 — 실측)
        const pre = await V.traceConcept(img.dataUrl).catch(() => null);
        const isComplex = pre && pre.masses >= 2 && pre.meta.courtyard;
        if (window.PARTI_ARCH && (orthoish || forceMass) && !isComplex) {
          const f = await V.traceFacade(img.dataUrl, { floorH: fh,
            depthMM: numOf(t, /(?:깊이|안길이)\s*(\d+(?:\.\d+)?)\s*m/) * 1000 || null });
          if (forceMass || (f.meta.conf || 0) >= 0.45) {
            const m = window.PARTI_ARCH.buildMassing({ floors: exp.floors || f.floors, bays: f.bays, windows: f.windows,
              widthMM: f.meta.widthMM, depthMM: f.meta.depthMM, floorH: f.meta.floorH, ox: cursorX });
            cursorX += m.W + 4000; massN++;
            lines.push(`· 사진 → 매스 ${f.floors}층·${f.bays}베이, ${(m.W / 1000).toFixed(1)}×${(m.D / 1000).toFixed(1)}×${(m.H / 1000).toFixed(1)}m (창 ${m.counts.window})`);
            continue;
          }
        }
        // ★여기까지 왔으면 '정확히는 모르는 이미지'(콘셉트 스케치 / 비정면 사진).
        //   예전엔 여기서 포기하고 되물었지만, 그러면 이미지 한 장으로 아무것도 못 만든다.
        //   구성(동 수·지붕·배치·유리)만 읽어 일단 세우고, 한 문장으로 고치게 한다.
        if (!window.PARTI_ARCH) continue;
        const c = pre || await V.traceConcept(img.dataUrl);
        const spec = {
          count: exp.count || c.masses, floors: exp.floors || c.floors || 1,
          w: exp.w || 8000, d: exp.d || 12000,
          roof: exp.roof || c.roof, arrange: exp.arrange || c.arrange,
          // 측면 음영으로 잰 깊이가 있으면 반영 (없으면 기본 12m)
          d: exp.d || (c.depthRatio ? Math.round(8000 * c.depthRatio / 100) * 100 : 12000),
          glass: exp.glass != null ? exp.glass : c.glass, floorH: fh,
          // 동별 폭·높이 비율과 인접 여부까지 전달 — 균일 배치는 스케치와 전혀 다른 그림이 된다
          massList: (!exp.count || exp.count === c.masses) ? c.massList : null,
          attached: c.attached, lean: c.lean || 0,
        };
        const allWins = (spec.massList || []).reduce((a, m) => a.concat((m && m.wins) || []), []);
        const winN = allWins.length;
        // 판독한 창 종류 요약 — 확신이 있는 것만 이름을 밝힌다.
        // (표시를 안 그린 창은 붙박이 기본값일 뿐 '읽어서 확신한 값'이 아니다)
        const KO = { fix: '붙박이', wswing: '여닫이', wslide: '미서기', hung: '오르내리',
          swing: '여닫이문', dswing: '쌍여닫이문', slide: '미서기문', fold: '접이문' };
        const tally = {};
        allWins.forEach(q => {
          // 밑변에 닿은 개구부는 문이 된다 — 문 종류로 센다 (arch.js 의 승격 조건과 같다)
          const isDoorish = (q.v - (q.hFrac || 0) / 2) <= 0.08;
          const k = isDoorish ? q.dkind : q.kind, cf = isDoorish ? q.dkindConf : q.kindConf;
          if ((cf || 0) >= 0.4 && k) tally[k] = (tally[k] || 0) + 1;
        });
        const kindTxt = Object.keys(tally).map(k => (KO[k] || k) + ' ' + tally[k]).join('·');
        // 판독한 재료 — 채색한 면만 나온다(안 칠한 면은 종이색과 구분할 수 없어 기본값으로 둔다)
        const MKO = { brick: '벽돌', wood: '목재', concrete: '콘크리트', metal: '금속', glass: '유리' };
        const mTally = {};
        (spec.massList || []).forEach(m => {
          if (m && m.mat && (m.matConf || 0) >= 0.3) mTally[m.mat] = (mTally[m.mat] || 0) + 1;
        });
        const matTxt = Object.keys(mTally)
          .map(k => (MKO[k] || k) + ' ' + mTally[k] + '동').join('·');
        const r = window.PARTI_ARCH.buildComplex(spec);
        if (!r) continue;
        cpxN++; lastConcept = spec;
        const roofKo = { gable: '박공지붕', flat: '평지붕', shed: '외쪽지붕' }[spec.roof] || spec.roof;
        const arrKo = { arc: '부채꼴로 늘어서고 마당은 그 앞', circle: '마당을 둘러싼 배치', row: '일렬 배치' }[spec.arrange] || spec.arrange;
        // ★판독기가 스스로 '범위 밖'이라고 말한 것을 삼키지 않는다.
        //   값은 그대로 내되, 왜 못 미더운지 먼저 밝힌다 — 조용히 틀린 답보다 낫다.
        if ((c.conf != null && c.conf < 0.6) && (c.why || []).length) {
          lines.push('⚠ **이 그림은 제가 읽을 수 있는 종류가 아닐 수 있습니다** (확신도 '
            + Math.round(c.conf * 100) + '%) — ' + c.why.join(' · ')
            + '. 아래는 그래도 세워 본 것이니, 틀렸으면 말로 고쳐 주세요 (예: "3동 2층 일렬로 다시").');
        }
        lines.push(`· 스케치 판독 → **${r.n}동 · ${spec.floors}층 · ${roofKo} · ${arrKo}**`
          + (spec.glass ? ' · 마당 쪽 전면 유리' : '')
          + `  (봉우리 ${c.masses}개${c.attached ? ' · 서로 붙은 덩어리' : ''}${c.meta.courtyard ? ' · 마당 초록 검출' : ''}`
          + (Math.abs(c.lean || 0) > 0.05 ? ` · 기울기 ${(Math.atan(c.lean) * 180 / Math.PI).toFixed(0)}도` : '')
          + (c.depthRatio ? ` · 측면 음영으로 잰 깊이 ${(spec.d / 1000).toFixed(1)}m` : '')
          + (winN ? ` · 그림에서 창 ${winN}개 자리 그대로` : '')
          + (kindTxt ? ` · 종류 ${kindTxt}` : '')
          + (matTxt ? ` · 재료 ${matTxt}` : '')
          + (r.counts && r.counts.room ? ` · 내부 실 ${r.counts.room}개 구획` : '')
          + `, 동 폭 ${r.widths.map(v => (v / 1000).toFixed(0)).join('/')}m)`);
      }
      // ── ★한 문장으로 도면 일습 ──
      // 판독·생성은 됐는데 그 다음이 전부 수동 명령이었다. "도면 한 장 만들어줘" 한 마디로
      // 치수 → 창호일람표 → 면적표 → 단면·입면 → 시트까지 이어 준다.
      // ★순서가 중요하다: 치수·표는 모델 도면에 얹혀야 시트가 그걸 모아 갈 수 있고,
      //   단면은 BIM 을 보므로 치수와 무관하며, 시트는 맨 마지막이어야 모든 탭이 모인다.
      if ((cpxN || massN || planN) && /도면\s*(한\s*장|세트|일습|일체|전부)|한\s*장으로|풀\s*세트|도면화|도면까지|일습/.test(t)) {
        const br = B(), steps = [];
        const run = (fn, label) => {
          if (typeof fn !== 'function') return;
          try { const r2 = fn(); if (r2 !== false) steps.push(label); }
          catch (e) { steps.push(label + '(실패: ' + String(e.message || e).slice(0, 40) + ')'); }
        };
        run(() => br.cmdAutoDim && br.cmdAutoDim(''), '치수');
        run(() => br.cmdOwSchedule && br.cmdOwSchedule(''), '창호일람표');
        run(() => br.cmdAreaTable && br.cmdAreaTable(''), '면적표');
        run(() => br.cmdAutoSection && br.cmdAutoSection(''), '단면·입면');
        // 용지·PDF 는 문장에서 읽는다 — "A3 로", "PDF 로 뽑아줘"
        const paper = ((t.match(/(?:^|[^A-Za-z0-9])(A[0-4])(?![0-9])/i) || [])[1] || '');
        const wantPdf = /pdf|피디에프|인쇄|출력|뽑아/i.test(t);
        const sArg = [paper.toUpperCase(), wantPdf ? 'pdf' : ''].filter(Boolean).join(' ');
        // 한 장이냐 세트냐 — 문장에서 읽는다. 세트면 종류마다 장을 나누고 번호를 붙인다.
        const wantSet = /세트|여러\s*장|장별|나눠|나누어|일습|낱장/.test(t);
        let sheet = null, set = null;
        if (wantSet) {
          try { set = br.cmdSheetSet && br.cmdSheetSet(sArg); if (set) steps.push(wantPdf ? '도면 세트 + PDF' : '도면 세트'); }
          catch (e) { steps.push('도면 세트(실패)'); }
        } else {
          try { sheet = br.cmdSheet && br.cmdSheet(sArg); if (sheet) steps.push(wantPdf ? '도면 한 장 + PDF' : '도면 한 장'); }
          catch (e) { steps.push('도면 한 장(실패)'); }
        }
        if (steps.length) {
          const tail = set
            ? `  (${set.size} · ${set.count}장 — ${set.sheets.map(x => x.no).join(' ')}`
              + (wantPdf ? ' · PDF 한 파일로 내려받음' : ' — 하단 탭에 있습니다') + ')'
            : sheet ? `  (${sheet.size} · 축척 1:${sheet.denom} · 뷰 ${sheet.views.length}개`
              + (wantPdf ? ' · PDF 내려받음 — 1:1 인쇄하면 도면의 축척이 실제로 맞습니다' : ' — 지금 그 탭입니다') + ')'
            : '';
          lines.push('· 도면 일습 → ' + steps.join(' → ') + tail);
        }
      }
      let builtFromPlan = null;
      if (allStrokes.length && SKm && SKm.importStrokes) {
        SKm.importStrokes(allStrokes);
        if (SKm.SK && !SKm.SK.on && SKm.enter) SKm.enter();
        if (SKm.recognize) { try { SKm.recognize(); } catch (e) {} }
        if (SKm.fitView) SKm.fitView();
        // '모델링까지' 요청했으면 건물화도 바로 — 한 문장으로 끝나야 한다는 게 요구사항.
        // (축척 어시스트 프롬프트를 띄우지 않으려고 전처리·건물화를 직접 호출한다)
        if (/모델링|모델|3d|입체|건물화|매스/i.test(t)) {
          try {
            const P2 = window.WEBCAD_PREP, BF2 = window.WEBCAD_BIMIFY;
            if (P2 && BF2) {
              const an = P2.analyze(allStrokes, SKm.getParams ? SKm.getParams() : {});
              const ro = BF2.heuristic(an);
              builtFromPlan = await BF2.build(an, ro);
              execTool('set_view', { mode: '3d' });
            }
          } catch (e) { builtFromPlan = null; }
        }
      }
      if ((massN || cpxN) && !planN) execTool('set_view', { mode: '3d' });
      let tail = '';
      if (planN && builtFromPlan) {
        const b2 = builtFromPlan;
        tail = `\n모델링까지 만들었습니다 — 벽 ${b2.wall || 0} · 문 ${b2.door || 0} · 창 ${b2.window || 0}`
          + (b2.slab ? ` · 슬래브 ${b2.slab}` : '') + '.\n'
          + `가로를 ${(wmm / 1000).toFixed(1)}m 로 가정했습니다 — 실제 치수를 알면 "가로 12m" 처럼 알려주시면 다시 만듭니다.`;
      } else if (planN) tail = '\n도면은 스케치로 올렸습니다 — **건물화(🏠)** 를 누르면 3D 까지 만들어지고, 틀린 선은 유령선을 탭해 고칠 수 있어요. 실제 치수를 알면 "가로 12m" 처럼 알려주세요.';
      if (massN) tail += '\n매스는 초기 검토용입니다 — 깊이(폭×0.6)·층고(' + fh + 'mm)는 가정값이라 "깊이 12m 층고 3300" 처럼 알려주시면 다시 세웁니다.';
      if (cpxN) tail += '\n\n투시 스케치라 **치수는 읽을 수 없어** 동 크기 8×12m·층고 ' + fh + 'mm 로 세웠습니다(구성만 판독).\n'
        + '한 문장으로 고칠 수 있어요 — 예) **"6동 2층 한 동 10×14m 로 다시"**, "일렬 배치로", "평지붕으로".';
      return `이미지 ${imgs.length}장을 처리했습니다:\n` + lines.join('\n') + tail;
    }
    // ①-a 범용 형상 — "기운 상자 만들어줘", "톱니 지붕 6개", "육각 각뿔 높이 12m"
    // 고정 유형이 아니라 임의 다면체를 세우는 경로. '어떤 형상이든' 요청에 대응한다.
    if (window.PARTI_ARCH && window.PARTI_ARCH.shapeOf) {
      const sh = window.PARTI_ARCH.shapeOf(t);
      if (sh && /만들|세워|그려|생성|해줘|추가/.test(t)) {
        const mm = (re, def) => { const v = numOf(t, re); return v ? v * 1000 : def; };
        const r = window.PARTI_ARCH.buildShape({
          shape: sh,
          w: mm(/(?:폭|가로)\s*(\d+(?:\.\d+)?)\s*m/, 0) || mm(/(\d+(?:\.\d+)?)\s*[x×]\s*\d+/, 0) || 10000,
          d: mm(/(?:깊이|세로|안길이)\s*(\d+(?:\.\d+)?)\s*m/, 0) || mm(/\d+(?:\.\d+)?\s*[x×]\s*(\d+(?:\.\d+)?)\s*m/, 0) || 8000,
          h: mm(/(?:높이|층고)\s*(\d+(?:\.\d+)?)\s*m/, 0) || (numOf(t, /(?:높이|층고)\s*(\d{3,5})/) || 0) || 6000,
          sides: numOf(t, /(\d+)\s*각/) || 6,
          n: numOf(t, /(\d+)\s*(?:개|산|골)/) || 4,
          twist: numOf(t, /(\d+)\s*도\s*(?:비틀|회전)/) || 0,
          rot: numOf(t, /(\d+)\s*도\s*(?:돌려|틀어)/) || 0,
        });
        if (r) {
          execTool('set_view', { mode: '3d' });
          return `**${r.ko}** 를 세웠습니다 — ${(r.w / 1000).toFixed(1)}×${(r.d / 1000).toFixed(1)}×${(r.h / 1000).toFixed(1)}m`
            + (r.count > 1 ? ` (조각 ${r.count})` : '') + '.\n'
            + '만들 수 있는 형상: ' + Object.keys(window.PARTI_ARCH.SHAPES).map(k => window.PARTI_ARCH.SHAPES[k].ko).join(' · ')
            + '. 크기는 "폭 12m 깊이 9m 높이 7m" 처럼, 회전은 "30도 돌려서" 처럼 말하면 됩니다.';
        }
      }
    }
    // ①-b 다동 배치 — "박공 5동 1층 원형 배치" (투시 스케치 후속 대화 or 직접 요청)
    if (window.PARTI_ARCH && /(\d+)\s*동/.test(t) && /배치|세워|만들|박공|지어/.test(t)) {
      const e2 = parseComplexSpec(t);
      const spec = { count: e2.count || 5, floors: e2.floors || 1, w: e2.w || 8000, d: e2.d || 12000, depths: e2.depths || null,
        roof: e2.roof || 'gable', arrange: e2.arrange || 'circle', floorProgram: e2.floorProgram || null,
        balcony: e2.balcony, eaveOvh: e2.eaveOvh || 0,
        glass: e2.glass != null ? e2.glass : true, floorH: numOf(t, /층고\s*(\d{3,5})/) || 3000 };
      const r = window.PARTI_ARCH.buildComplex(spec);
      if (!r) return '배치를 만들지 못했습니다.';
      lastConcept = spec;
      execTool('set_view', { mode: '3d' });
      const roofKo = { gable: '박공지붕', flat: '평지붕', shed: '외쪽지붕' }[spec.roof];
      return `${r.n}동을 ${spec.arrange === 'row' ? '일렬로' : '원형 마당(반지름 ' + (r.R / 1000).toFixed(1) + 'm) 둘레에'} 세웠습니다 — `
        + `각 동 ${(spec.w / 1000).toFixed(0)}×${(spec.d / 1000).toFixed(0)}m · ${spec.floors}층(${(r.H / 1000).toFixed(1)}m) · ${roofKo}`
        + (r.counts.window ? ' · 마당 쪽 전면 유리' : '') + '.\n'
        + '동 수·크기·지붕·배치는 같은 문장으로 다시 말하면 새로 세웁니다. (되돌리기: Ctrl+Z)';
    }
    // ② 평면 생성 — "N평/N㎡ + 실 구성"
    const prog = window.PARTI_ARCH && window.PARTI_ARCH.programOf(t);
    const py = numOf(t, /(\d+(?:\.\d+)?)\s*평/);
    const m2 = numOf(t, /(\d+(?:\.\d+)?)\s*(?:㎡|m2|m²|제곱미?터?)/i);
    if (window.PARTI_ARCH && (prog || py || m2) && /그려|만들|생성|평면|배치|plan/i.test(t + (prog ? ' 평면' : ''))) {
      const areaM2 = m2 || (py ? py * 3.3058 : 33);
      const h = numOf(t, /(?:층고|천장|높이)\s*(\d{3,5})/) || undefined;
      const r = window.PARTI_ARCH.buildPlan({ areaM2, program: prog || 'oneroom', h });
      if (!r) return '평면을 만들지 못했습니다.';
      const rooms = r.cells.map(c => `${c.name} ${(c.w * c.h / 1e6).toFixed(1)}㎡`).join(' · ');
      return `${r.program} 평면을 만들었습니다 — 전체 ${r.areaM2.toFixed(1)}㎡(${(r.areaM2 / 3.3058).toFixed(1)}평), ${r.W}×${r.D}mm\n`
        + `${rooms}\n벽 ${r.counts.wall} · 문 ${r.counts.door} · 창 ${r.counts.window} 생성. "3D 보여줘" 라고 하시면 입체로 확인할 수 있어요.`;
    }
    // ③ 스케치 보정값 — ★'인식이 이상하다'는 불만은 '인식해줘' 명령보다 먼저 걸러야 한다
    //   ("선이 자꾸 곡선으로 인식돼" 가 인식 명령으로 잡히던 버그)
    if (SKm && SKm.setParams) {
      if (/곡선으로.*인식|자꾸 곡선|직선인데|곡선이 아닌/.test(t)) { const p = SKm.setParams({ corner: 0.45 }); return `모서리 민감도를 ${p.corner} 로 낮췄습니다 — 완만한 꺾임도 이제 꺾은선으로 인식됩니다. 다시 그려 보세요.`; }
      if (/꺾은선으로.*인식|자꾸 꺾|각지게/.test(t)) { const p = SKm.setParams({ corner: 0.85 }); return `모서리 민감도를 ${p.corner} 로 높였습니다 — 완만한 꺾임은 이제 곡선으로 봅니다.`; }
      if (/보정.*(세|강|많)|너무 반듯|내 선.*살/.test(t)) { const p = SKm.setParams({ preset: 'fine' }); return `정밀 모드로 바꿨습니다 — 보정 강도 ${p.fitK}, 원본 선을 최대한 살립니다.`; }
      if (/보정.*(약|안 되|부족)|반듯하게 (해|정리)|대충 그려도/.test(t)) { const p = SKm.setParams({ preset: 'rough' }); return `러프 모드로 바꿨습니다 — 보정 강도 ${p.fitK}, 대충 그려도 반듯하게 정리됩니다.`; }
      if (/끝점.*(안 붙|안붙|안 닿)/.test(t)) { const p = SKm.setParams({ snap: 20 }); return `끝점 흡착을 ${p.snap}px 로 넓혔습니다.`; }
      if (/끝점.*(자꾸 붙|너무 붙)/.test(t)) { const p = SKm.setParams({ snap: 5 }); return `끝점 흡착을 ${p.snap}px 로 좁혔습니다.`; }
      if (/기울.*(수평|반듯)|자꾸 수평/.test(t)) { const p = SKm.setParams({ ortho: 3 }); return `수평·수직 정리각을 ${p.ortho}° 로 줄였습니다 — 기울여 그린 선이 유지됩니다.`; }
    }
    // ④ 스케치 인식 / 건물화
    if (/건물화|모델링|3d\s*로|입체로|세워/i.test(t) && SKm && SKm.buildBuilding) {
      if (!SKm.getPreview || !SKm.getPreview()) { try { SKm.recognize(); } catch (e) {} }
      const c = await SKm.buildBuilding();
      if (!c) return '건물화할 스케치가 없습니다 — 먼저 평면을 그려 주세요.';
      const KO = { wall: '벽', door: '문', window: '창', column: '기둥', furniture: '가구', slab: '슬래브' };
      return '건물로 만들었습니다 — ' + Object.entries(c).filter(([, n]) => n > 0).map(([k, n]) => KO[k] + ' ' + n).join(' · ') + '. 3D 로 확인해 보세요.';
    }
    if (/인식|알아봐|정리해|반듯/i.test(t) && SKm && SKm.recognize) {
      const p = SKm.recognize();
      if (!p) return '인식할 스케치가 없습니다.';
      const KN = { line: '선', polyline: '꺾은선', rect: '사각형', polygon: '다각형', circle: '원', arc: '호', curve: '곡선', dot: '점' };
      return '인식했습니다 — ' + Object.entries(p.counts).map(([k, n]) => (KN[k] || k) + ' ' + n).join(' · ')
        + (p.regions.length ? ` · 닫힌 영역 ${p.regions.length}개` : '') + '. 유령선을 탭하면 종류를 바꿀 수 있어요.';
    }
    // ④ 벽 속성
    const wh = numOf(t, /(?:벽)?\s*(?:높이|층고)\s*(\d{3,5})/), wt = numOf(t, /(?:벽)?\s*두께\s*(\d{2,4})/);
    if (wh || wt) {
      const ws = wallsTarget();
      if (!ws.length) return '벽이 없습니다 — 먼저 평면을 만들거나 벽을 그려 주세요.';
      B().pushUndo();
      for (const w of ws) { if (wh) w.bim.h = wh; if (wt) w.bim.t = wt; }
      B().refresh();
      return `벽 ${ws.length}개를 ${[wh ? '높이 ' + wh : null, wt ? '두께 ' + wt : null].filter(Boolean).join(' · ')}(으)로 바꿨습니다.`;
    }
    // ⑤ 뷰 / 도면
    if (/4\s*분할|사분할/.test(t)) { execTool('set_view', { mode: 'quad' }); return '4분할로 전환했습니다.'; }
    if (/3d|입체|아이소/i.test(t)) { execTool('set_view', { mode: '3d' }); return '3D 로 전환했습니다.'; }
    if (/평면\s*(보여|전환|으로)/.test(t)) { execTool('set_view', { mode: 'plan' }); return '평면으로 전환했습니다.'; }
    if (/단면/.test(t)) { const r = execTool('make_views', { kind: 'section', axis: /세로|x/i.test(t) ? 'x' : 'y' }); return r && r.error ? '단면 생성 실패: ' + r.error : '단면 도면을 새 탭에 만들었습니다.'; }
    if (/입면/.test(t)) { const r = execTool('make_views', { kind: 'elevation', edge: /뒤|북/.test(t) ? 'back' : /좌|서/.test(t) ? 'left' : /우|동/.test(t) ? 'right' : 'front' }); return r && r.error ? '입면 생성 실패: ' + r.error : '입면 도면을 새 탭에 만들었습니다.'; }
    // ⑦ 도움말 / 미해석
    if (/도움|뭐 할|무엇|help|사용법|기능/i.test(t) || !t) return LOCAL_HELP;
    return '로컬 모드에서는 아직 이 요청을 이해하지 못했습니다.\n\n' + LOCAL_HELP;
  }
  async function runLocal(text, imgs) {
    busy = true; setBusy(true);
    try { addMsg('ai', await localReply(text, imgs)); }
    catch (e) { addMsg('err', '로컬 처리 중 오류: ' + (e && e.message ? e.message : e)); }
    finally { busy = false; setBusy(false); }
  }

  function submit() {
    const t = (inEl.value || '').trim();
    if ((!t && !pendingImgs.length) || busy) return;
    inEl.value = '';
    addMsg('user', (pendingImgs.length ? '📷 이미지 ' + pendingImgs.length + '장' + (t ? '\n' : '') : '') + t);
    const imgs = pendingImgs.slice(); pendingImgs = []; renderAtt();
    // ★첨부 이미지는 여기서도 lastImg 에 걸어 둔다.
    //   원래는 API 분기에서만 걸었는데, 그 분기가 사라지면 localReply 가 비전 경로를 타지 않는
    //   문장(예: "이거 밑그림으로 깔아줘")에서 set_underlay 가 '이미지 없음'을 내게 된다.
    if (imgs.length) lastImg = imgs[imgs.length - 1];
    runLocal(t, imgs);
  }

  function init() {
    if (!window.WEBCAD_AI_BRIDGE) { setTimeout(init, 300); return; }
    buildUI();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // 테스트 훅
  // ── 도면 채택 판정 ──
  // 실물 이미지를 시험에 넣어둘 수 없으므로(사용자 개인 파일) 판정식을 함수로 떼어
  // '실제 도면에서 잰 숫자'로 회귀를 건다. 실측(1:50 평면도, 가구·해칭·표제란·색 채움):
  //   쌍 53 · 설명률 0.425 · 사선 0.298 · 채색 0.054 → 자동 채택은 안 되지만 경고는 떠야 한다.
  // ※임계를 낮춰 자동 채택하게 만들지 않은 이유: 같은 조건(직교 + 쌍 다수)을 UI 목업 같은
  //   그림도 만족한다(실측: 쌍 113). 잘못 채택하면 손그림이 벽 52개가 되던 사고의 재판이다.
  function planVerdict(r, cls, forcePlan) {
    const ortho = (cls.diagRatio || 0) < 0.35;
    const has = !!(r && r.strokes && r.strokes.length && r.meta);
    const isPlan = !!forcePlan || (has && cls.chromaRatio < 0.05 && ortho
      && r.meta.coverage >= 0.5 && r.meta.paired >= 2);
    // 채택은 못 해도 '도면일 수 있다'는 신호 — 이중선 쌍이 넉넉하고 직교면 알려 준다.
    const nearPlan = !isPlan && has && ortho && r.meta.paired >= 8;
    return { isPlan, nearPlan, ortho };
  }

  // ── 외부 도구 계층 진입점 ───────────────────────────────────────────────
  // ★beginTurn 이 없으면 두 번째 호출부터 pushUndo 가 영영 안 걸린다.
  //   turnPushed 리셋은 원래 send()(API 에이전트 루프) 안에만 있었다 — 그 루프를 타지 않는
  //   호출자(MCP 브리지)는 매 호출 앞에서 직접 이것을 불러야 '호출 1건 = undo 1단계'가 된다.
  function beginTurn() { turnPushed = false; turnCreated = 0; }

  // TOOL_KO 는 도구 이름의 한국어 표기 — MCP 브리지가 명령 로그에 무슨 도구가 돌았는지 적을 때 쓴다.
  window.WEBCAD_AI = { execTool, beginTurn, TOOLS, TOOL_KO, localReply,
    notify: (kind, text) => addMsg(kind, text),   // mcp.js 가 연결·도구 실행을 채팅에 알린다
    get lastImg() { return lastImg; }, setLastImg: (v) => { lastImg = v; } };

  window.__WEBCAD_AI_TEST__ = { execTool, beginTurn, attachImage, localReply, parseComplexSpec, planVerdict,
    get lastImg() { return lastImg; }, setLastImg: (v) => { lastImg = v; },
    get pendingImgs() { return pendingImgs; },
    addMsg: (k, t) => addMsg(k, t) };
})();
