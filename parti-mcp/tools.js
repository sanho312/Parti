// ─────────────────────────────────────────────────────────────────────────────
// tools.js — MCP 도구 목록 (parti-mcp 의 tools/list 응답 원본)
//
// ★두 벌이 존재한다는 사실을 잊지 말 것
//   여기의 ①~⑮ 는 브라우저 ai.js 의 TOOLS 배열과 같은 도구다. 실행은 브라우저의
//   execTool 이 하고, 스키마 선언만 여기에 있다. 둘이 어긋나면 Claude 가 있지도 않은
//   인자를 보내고 조용히 무시된다 — tests.html 이 이 파일을 받아 ai.js TOOLS 와
//   이름·필수인자를 대조한다(회귀 'MCP 도구 목록이 ai.js 와 일치').
//
// ⑯~ 는 MCP 에만 있는 도구다(브라우저 mcp.js 의 OWN 에 구현).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const num = { type: 'number' };
const ids = { type: 'array', items: num };

const TOOLS = [
  // ── ①~⑮ ai.js 도구 (execTool 로 위임) ────────────────────────────────────
  {
    name: 'get_drawing',
    description: '현재 도면 상태(레이어·층·선택·개체 목록)를 요약해 반환. 기존 도면을 다루기 전에 먼저 호출할 것.',
    inputSchema: { type: 'object', properties: { detail: { type: 'boolean', description: 'true 면 개체별 좌표 포함(최대 150개)' } } },
  },
  {
    name: 'add_entities',
    description: '개체를 생성한다(호출당 최대 200개). 개체 스키마와 bim 필드는 서버 instructions 참고. 반환: 생성된 id 목록.',
    inputSchema: {
      type: 'object', required: ['entities'],
      properties: { entities: { type: 'array', items: { type: 'object' }, description: 'instructions 의 개체 스키마를 따르는 객체 배열' } },
    },
  },
  {
    name: 'update_entities',
    description: '개체 속성 수정(얕은 병합, bim 은 필드 단위 병합). 예: bim.h 변경, layer 이동. id/type 등 내부 필드는 거부된다.',
    inputSchema: {
      type: 'object', required: ['updates'],
      properties: { updates: { type: 'array', items: { type: 'object', required: ['id', 'set'], properties: { id: num, set: { type: 'object' } } } } },
    },
  },
  {
    name: 'delete_entities',
    description: '개체 삭제. 대량 삭제는 브라우저가 사용자에게 확인창을 띄운다 — 사용자가 거부하면 강행하지 말 것.',
    inputSchema: { type: 'object', required: ['ids'], properties: { ids } },
  },
  {
    name: 'transform_entities',
    description: '개체 이동/회전. move: dx,dy,dz(mm). rotate: 중심(cx,cy) 기준 deg 도(수평 회전).',
    inputSchema: {
      type: 'object', required: ['ids', 'op'],
      properties: { ids, op: { type: 'string', enum: ['move', 'rotate'] }, dx: num, dy: num, dz: num, cx: num, cy: num, deg: num },
    },
  },
  {
    name: 'boolean_op',
    description: '3D 불리언. keep(베이스)에 cutter 를 합/차/교집합. 대상은 BIM 솔리드 또는 메시.',
    inputSchema: {
      type: 'object', required: ['op', 'keep_ids', 'cutter_ids'],
      properties: { op: { type: 'string', enum: ['union', 'subtract', 'intersect'] }, keep_ids: ids, cutter_ids: ids },
    },
  },
  {
    name: 'set_view',
    description: '뷰 전환/맞춤. mode 2d(평면)|3d(아이소)|quad(4분할), fit=전체보기. 3D 결과물을 만든 뒤에는 {mode:"3d", fit:true} 로 보여 줄 것. 반환의 view 는 실제로 보고 있는 것을 적는다.',
    inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['2d', '3d', 'quad'] }, fit: { type: 'boolean' } } },
  },
  {
    name: 'select_entities',
    description: '개체를 선택 상태로 표시(사용자에게 무엇을 가리키는지 보여 주기용).',
    inputSchema: { type: 'object', required: ['ids'], properties: { ids } },
  },
  {
    name: 'get_screenshot',
    description: '현재 뷰(2D 평면 또는 3D)를 이미지로 반환. 만든 결과를 눈으로 검증할 때 — 겹침·이상한 배치는 좌표만 봐서는 보이지 않는다. 찍기 전에 set_view {fit:true} 로 화면을 맞출 것.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'measure',
    description: '측정. ids → 개체별 길이(mm)·면적(mm²)·bbox / from·to([x,y] 또는 [x,y,z]) → 두 점 거리 / 인자 없음 → 도면 전체 bbox·개수. 좌표 암산 대신 이것을 쓸 것.',
    inputSchema: { type: 'object', properties: { ids, from: { type: 'array', items: num }, to: { type: 'array', items: num } } },
  },
  {
    name: 'set_sketch_params',
    description: '스케치 보정·인식 패스값 조정. 사용자가 "선이 자꾸 곡선으로 인식돼", "보정이 너무 세다", "끝점이 자꾸 붙는다" 같은 손그림 인식 불만을 말할 때. preset(rough=대충 그려도 반듯 | basic | fine=원본 존중) 또는 개별값: fitK(0.3~2.5 보정 강도), smooth(0~4 손떨림 제거), ortho(0~15 수평수직 정리각°), snap(0~30 끝점 흡착px), corner(0.35~1.0 모서리 판정각rad). 반환: 적용된 전체 값.',
    inputSchema: {
      type: 'object',
      properties: { preset: { type: 'string', enum: ['rough', 'basic', 'fine'] }, fitK: num, smooth: num, ortho: num, snap: num, corner: num },
    },
  },
  {
    name: 'set_underlay',
    description: '사용자가 Parti 채팅에 첨부한 최신 이미지를 도면 밑그림(IMAGE 개체, "밑그림" 레이어)으로 삽입. width_mm=이미지의 실제 폭(스케일) — 세로는 비율 자동. 원점(0,0)이 이미지 좌하단. 반환 {id,w_mm,h_mm} 가 이후 트레이스의 좌표 기준이 된다.',
    inputSchema: {
      type: 'object', required: ['width_mm'],
      properties: { width_mm: num, x: { ...num, description: '좌하단 x (기본 0)' }, y: { ...num, description: '좌하단 y (기본 0)' }, opacity: { ...num, description: '0.1~1 (기본 0.55)' } },
    },
  },
  {
    name: 'make_views',
    description: 'BIM 모델에서 입면/단면 도면을 자동 생성해 새 탭에 만든다. kind "elevation"+edge(front=남/back=북/left=서/right=동에서 바라봄) 또는 kind "section"+axis("x"=세로로 절단해 동서를 봄, "y"=가로로 절단해 남북을 봄)+at(절단 위치, 생략=중앙). 벽·슬래브 등 BIM 개체가 있어야 한다.',
    inputSchema: {
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
    name: 'organize_layers',
    description: '도면 전체를 표준 레이어 체계(벽/기둥/슬래브/지붕/계단/난간/개구부/가구/문자/치수/밑그림)로 자동 정리. BIM 종류·개체 타입으로 분류. 반환: 레이어별 이동 개수.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'edit_node_graph',
    description: '파라메트릭 노드 그래프(그래스호퍼형) 편집. ★반복·배열·패턴(루버·기둥열·격자·타워 층)은 add_entities 로 낱개 복제하지 말고 반드시 이것으로 만들 것 — 그래야 사용자가 슬라이더로 조절할 수 있다. action "replace"=nodes 스펙으로 전체 교체(라이브 프리뷰 + 슬라이더 노출), "get"=현재 그래프 조회, "bake"=영구 개체로 확정, "clear"=삭제. 노드 어휘·예제는 get_node_reference 로 먼저 확인할 것.',
    inputSchema: {
      type: 'object', required: ['action'],
      properties: {
        action: { type: 'string', enum: ['replace', 'get', 'bake', 'clear'] },
        nodes: { type: 'array', items: { type: 'object' }, description: 'replace 용 노드 스펙 배열 — get_node_reference 참고' },
      },
    },
  },

  // ── ⑯~ MCP 전용 도구 (mcp.js 의 OWN 에 구현) ──────────────────────────────
  {
    name: 'inspect',
    description: '도면에서 순수하게 읽기만 하는 조회(아무것도 바꾸지 않는다). what: '
      + 'area=면적 원자료(건축면적·연면적·층별·실별·용도별·발코니·필로티) / '
      + 'windows=창호 원자료(부호·종류·개폐방식·W·H·창대·개소, conf<0.4 는 개폐방식을 추정한 것) / '
      + 'floors=층 구성(층수·지붕 유무·층고) / '
      + 'sections=자동 단면 후보 절단선 / '
      + 'details=상세도 후보 목록 / '
      + 'docs=탭 목록과 현재 탭 / '
      + 'layers=레이어 목록. '
      + '표를 그리기 전에 이것으로 값을 먼저 확인하면 잘못된 표를 그리고 되돌리는 일이 없다.',
    inputSchema: {
      type: 'object', required: ['what'],
      properties: { what: { type: 'string', enum: ['area', 'windows', 'floors', 'sections', 'details', 'docs', 'layers'] },
        site_m2: { ...num, description: 'area 일 때 대지면적(m²) — 주면 건폐율·용적률도 함께 계산된다' } },
    },
  },
  {
    name: 'run_command',
    description: '도면 산출물 명령을 실행한다. command 는 한국어 명령어 + 선택 인자. '
      + '도면세트[A0~A4][1:100][pdf] = 평면·입면·단면·상세를 번호 붙은 시트 여러 장으로(탭이 장마다 생기고 마지막 시트에 머문다) / '
      + '도면묶기[A0~A4] = 한 장으로 / '
      + '상세도 = 처마·기단·창 상세를 새 탭에(건물이 있어야 함) / '
      + '면적표[대지 500][csv] · 창호일람표[csv] · 치수자동[전체만] = 현재 탭에 표·치수를 그린다 / '
      + '단면자동[횡|종|입면] = 절단면마다 새 탭(원래 탭으로 돌아온다) / '
      + '층보기 2 · 층보기 지붕 · 층보기 전체 = 평면 층 필터(개체를 바꾸지 않는 화면 필터). '
      + '★면적표·창호일람표·치수자동은 두 번 부르면 표·치수가 겹쳐 쌓인다 — 다시 그리려면 먼저 undo. '
      + '반환: 명령의 결과 객체 + 개체 수·탭 변화.',
    inputSchema: { type: 'object', required: ['command'], properties: { command: { type: 'string' } } },
  },
  {
    name: 'build_massing',
    description: '건물 동(棟)을 생성한다 — Parti 의 건축 생성기. 벽·슬래브·지붕·계단·난간·창·실 구획·대지·주차까지 한 번에 만든다. '
      + '기존 내용을 지우지 않고 그 위에 얹으며, 호출 1건이 undo 1단계다. '
      + '★같은 문서에서 두 번 부르면 실번호가 101 부터 다시 시작해 중복되고, 앞 건물의 창이 새 실의 창 판정을 방해한다 — 여러 동을 세우려면 한 번의 호출에 count 로 넘길 것.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { ...num, description: '동 수 1~12 (기본 1). 13 이상은 12로 잘린다' },
        floors: { ...num, description: '층수 (기본 2)' },
        w: { ...num, description: '동 폭 mm — d 와 반드시 쌍으로 줄 것(하나만 주면 둘 다 무시되고 면적에서 재계산된다)' },
        d: { ...num, description: '동 깊이 mm. 3000 미만이면 내부가 통째로 생략되어 껍데기만 남는다' },
        roof: { type: 'string', enum: ['gable', 'shed', 'flat'], description: '지붕 형태 (기본 gable)' },
        arrange: { type: 'string', enum: ['arc', 'row', 'ring'], description: '배치 (기본 arc). row 는 마당·진입계단이 생기지 않고 lean 이 무시된다' },
        program: { type: 'string', description: "용도 — 'oneroom'|'office'|'school'|'house' 등. ★'piloti' 는 전역 program 으로 쓸 수 없다(조용히 oneroom 이 된다) — floorProgram 으로 층에만 줄 것" },
        floorProgram: { type: 'object', description: '층별 용도 {"1":"piloti","2":"office"} — 1층 필로티 같은 구성' },
        attached: { type: 'boolean', description: '동끼리 붙일지 (기본 false)' },
        glass: { type: 'boolean', description: '유리 외피' },
        lean: { ...num, description: '기울기 -1~1 — arrange:"arc" 에서만 적용된다' },
        balcony: { type: 'boolean', description: '발코니(연면적 제외 슬래브 + 난간)' },
        eaveOvh: { ...num, description: '처마 내밀기 mm (기본 300)' },
        rooms: { type: 'boolean', description: '내부 실 구획 (기본 true). false 면 계단도 안 생겨 2층 이상인데 올라갈 방법이 없는 건물이 된다' },
        site: { type: 'boolean', description: '대지 슬래브 (기본 true). false 면 parking 값과 무관하게 주차·도로까지 사라진다' },
        parking: { type: 'boolean', description: '주차구획·차로를 그린다(대수 산정은 하지 않는다 — 조례 사안)' },
      },
    },
  },
  {
    name: 'trace_concept',
    description: '손그림(투시·개념 스케치)을 전처리해 구조를 읽는다. ★이미지를 주고받지 않는다 — 브라우저가 이미 가진 그림(채팅 첨부 또는 밑그림)을 알고리즘으로 판독해 작은 JSON 만 돌려준다. '
      + '반환: masses(동 수)·floors(층수)·roof·arrange(배치)·lean(기울기)·massList(동별 폭·창)·glass·peaks, 그리고 ★conf(0~1 확신도)와 why(확신이 깎인 이유 목록). '
      + '★conf 가 낮거나 why 가 비어 있지 않으면 그 값들을 사실처럼 쓰지 말고 사용자에게 확인할 것 — why 를 버리면 헤지된 판독이 자신만만한 거짓말이 된다. '
      + '판독 결과를 그대로 build_massing 인자로 넘기면 스케치가 건물이 된다.',
    inputSchema: {
      type: 'object',
      properties: { source: { type: 'string', enum: ['attachment', 'underlay'], description: 'attachment=채팅에 첨부된 최신 이미지(기본), underlay=도면에 깔린 밑그림' } },
    },
  },
  {
    name: 'get_node_reference',
    description: 'edit_node_graph 의 노드 어휘 사전을 꺼낸다 — 노드 종류별 인자, 묘사→로직 번역표(“가까울수록 커지게”→dist·remap 등), 예제 스펙. edit_node_graph 로 replace 하기 전에 한 번 읽을 것.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'switch_doc',
    description: '탭 전환. 탭 목록은 inspect {what:"docs"} 로 확인. 시트·단면·상세도 명령이 새 탭을 만들기 때문에 자주 필요하다.',
    inputSchema: { type: 'object', required: ['index'], properties: { index: { ...num, description: '0부터' } } },
  },
  {
    name: 'undo',
    description: '실행취소 1단계. 도구 호출 1건이 곧 1단계다. 표·치수를 잘못 그렸을 때 다시 그리기 전에 이것으로 되돌릴 것. ★시트·단면·상세도가 만든 탭은 undo 대상이 아니다.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'export_drawing',
    description: '현재 탭을 파일 텍스트로 내보낸다. format dxf|svg|pdf. ★PDF 의 글꼴은 Helvetica 뿐이라 한글은 "?" 로 나간다 — 한글이 든 도면은 dxf 나 svg 를 쓸 것.',
    inputSchema: {
      type: 'object', required: ['format'],
      properties: {
        format: { type: 'string', enum: ['dxf', 'svg', 'pdf'] },
        paper: { type: 'string', description: 'pdf 일 때 a4|a3|a2|a1|a0 (기본 a3)' },
        scale_denom: { ...num, description: 'pdf 축척 분모, 0=페이지에 맞춤 (기본 100). 시트 탭이면 1 을 줄 것' },
      },
    },
  },
];

module.exports = { TOOLS };
