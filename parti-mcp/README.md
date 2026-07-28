# parti-mcp

Parti 전용 MCP 서버. Claude(Claude Code·Desktop)가 브라우저에 열린 Parti 도면을 직접 만지게 한다.

의존성 없음 — `npm install` 하지 않는다. Node 18 이상이면 `node parti-mcp/server.js` 한 줄로 돈다.

## 쓰는 법

**1. Claude Code 에 등록** — 이 저장소에는 `.mcp.json` 이 들어 있어서, `C:\Parti` 에서 Claude Code 를
열면 `parti` 서버를 쓸지 물어본다. 승인하면 끝이다. 수동으로 붙이려면:

```bash
claude mcp add parti -- node C:/Parti/parti-mcp/server.js
```

**2. 브라우저에서 Parti 를 연다**

```
http://127.0.0.1:7391/
```

서버가 직접 서빙하는 주소다. 우측 하단 상태바의 **MCP** 칩이 초록이면 연결된 것이다.
칩을 누르면 다시 연결한다.

이제 Claude 에게 그냥 말하면 된다 — "3층짜리 두 동 세우고 도면세트 뽑아 줘".

## 구조

```
Claude Code
   ↕ stdio (개행 구분 JSON-RPC 2.0)
server.js ──── HTTP 127.0.0.1:7391 ──┬── Parti 정적 서빙 (작업본 그대로)
                                     └── 브리지: SSE(내려보내기) + POST(결과 회신)
   ↕
mcp.js (브라우저) → WEBCAD_AI.execTool · __CADTEST__ 명령 · PARTI_ARCH · PARTI_VISION
```

**왜 브리지가 Parti 를 직접 서빙하나.** `https://` 페이지에서 `http://127.0.0.1` 로 붙는 것은
혼합 콘텐츠라 브라우저마다 막히는 정도가 다르다(사파리는 차단). 서버가 로컬 작업본을 서빙하면
동일 출처가 되어 그 문제가 없어지고, 파일을 고치면 새로고침만으로 반영된다.

**왜 WebSocket 이 아닌가.** Node 에 WebSocket *서버*가 없다. 서버→브라우저는 SSE,
브라우저→서버는 `fetch` POST 로 하면 둘 다 표준 내장이라 의존성이 0 이 된다.

**stdout 은 MCP 채널이다.** server.js 에서 `console.log` 를 쓰면 JSON-RPC 스트림이 오염되어
클라이언트가 파싱에 실패한다. 진단 출력은 전부 stderr(`log()`)로 나간다.

## 도구

`initialize` 응답의 `instructions` 에 좌표계·개체 스키마·BIM 필드·표준 레이어·안전 수칙이 실린다
(ai.js 의 SYSTEM 프롬프트가 있던 자리). 노드 그래프 어휘처럼 길고 가끔 쓰는 것은 상주시키지 않고
`get_node_reference` 로 꺼내 쓴다.

| 갈래 | 도구 |
|---|---|
| 읽기 | `get_drawing` `measure` `get_screenshot` `inspect` |
| 개체 | `add_entities` `update_entities` `delete_entities` `transform_entities` `boolean_op` `select_entities` `organize_layers` `undo` |
| 뷰·탭 | `set_view` `switch_doc` |
| 생성 | `build_massing` `make_views` `edit_node_graph` `get_node_reference` |
| 도면화 | `run_command` (도면세트·상세도·면적표·창호일람표·치수자동·단면자동·층보기) |
| 손그림 | `trace_concept` `set_underlay` `set_sketch_params` |
| 내보내기 | `export_drawing` (dxf·svg·pdf) |

**`trace_concept` 은 이미지를 주고받지 않는다.** 브라우저가 이미 가진 손그림을 알고리즘으로
전처리해 작은 JSON(동 수·층수·지붕·배치 + `conf`·`why`)만 돌려준다. 손그림을 통째로 LLM 에
보내지 않는 것이 이 프로젝트의 제1원칙이고, MCP 배선이 그것을 강제한다.

## 스키마가 두 벌이라는 것

도구 스키마는 `parti-mcp/tools.js`(서버 선언)와 `ai.js` 의 `TOOLS`(브라우저 실행) 두 곳에 있다.
어긋나면 Claude 가 있지도 않은 인자를 보내고 조용히 무시된다. `tests.html` 의
**"MCP 도구 목록 — parti-mcp/tools.js 가 ai.js TOOLS 와 일치한다"** 가 양방향으로 못박는다:

- ai.js 의 도구가 전부 tools.js 에 있고 필수·선택 인자 이름이 같은가
- tools.js 의 MCP 전용 도구가 전부 `mcp.js` 의 `OWN` 에 구현이 있는가
- 구현만 있고 선언이 없는 도구는 없는가

## 알아둘 것

- **탭 하나만 활성.** Parti 탭을 여러 개 열면 마지막에 연 탭이 브리지를 가져가고, 밀려난 탭은
  `다른 Parti 탭이 브리지를 쓰고 있습니다` 로 바뀐다. 칩을 눌러 되찾는다.
- **도구 호출 1건 = 실행취소 1단계.** Claude 가 뭘 했든 Ctrl+Z 한 번이면 그 걸음이 되돌아간다.
  단 시트·단면·상세도가 만든 **탭**은 undo 대상이 아니다.
- **면적표·창호일람표·치수자동은 두 번 부르면 겹쳐 쌓인다.** 다시 그리기 전에 `undo`.
- **배포본에서는 동작하지 않는다.** `mcp.js` 는 `127.0.0.1`/`localhost` 에서 열렸을 때만 붙고,
  https://sanho312.github.io/Parti/ 에서는 즉시 return 한다. 아이패드 단독으로는 쓸 수 없다
  (데스크톱 Node 프로세스가 필요하다).
- 포트를 바꾸려면 `PARTI_MCP_PORT=7500 node parti-mcp/server.js`. 서빙 루트는 `PARTI_ROOT`.
