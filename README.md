# 1인용 AI TRPG

포스트아포칼립스 세계에서, 코드가 돌리는 시뮬레이션 위에 Claude가 GM으로서 이야기를 연출하는 1인용 TRPG.
기획은 [docs/design.md](docs/design.md), 개발 규칙은 [CLAUDE.md](CLAUDE.md)를 참고한다.

## 두 가지 플레이 모드

| | 웹 앱 모드 | MCP 모드 |
|---|---|---|
| GM | 이 프로젝트의 서버가 Claude API를 호출 | Claude 데스크톱 / Claude Code 세션 |
| 비용 | Anthropic API 키 (Console 결제) | claude.ai 구독 사용량 |
| 화면 | 브라우저 (서술, 판정 카드, 캐릭터 시트) | Claude 채팅 + `!` 정보 명령어 |
| 용도 | 개발·테스트 | 실제 장기 플레이 |

두 모드는 같은 세이브(`saves/worlds/`)를 쓴다. 한쪽에서 하던 세계를 다른 쪽에서 이어서 할 수 있다.
같은 세계를 **동시에** 열 수만 없다 (잠금 파일 `<세계>.db.lock`). 모드를 바꿀 때는 다른 쪽을 닫는다.

## 준비

```bash
pnpm install
```

Node 22 이상, pnpm 10이 필요하다.

세계 배경 검색(RAG)에 쓰는 임베딩 모델 bge-m3(약 570MB)는 처음 실행할 때 `.cache/models/`에 내려받는다. 받지 않으려면 `.env`에 `RAG=off`.

## 웹 앱 모드

```bash
cp .env.example .env   # ANTHROPIC_API_KEY를 채운다
pnpm dev               # http://localhost:5173
```

- 웹 앱 모드는 API 키만 쓴다. claude.ai 구독 로그인은 연결하지 않는다 (Anthropic 정책)
- 입력창에 `!`로 시작하는 명령어를 쓰면 GM에게 보내지 않고 정보만 본다 (시간이 흐르지 않는다)
- `pnpm dev`가 켜져 있는 동안에는 그 세계가 잠겨 있어 MCP 모드에서 열 수 없다

## MCP 모드

MCP 서버는 Claude 앱이 직접 실행한다. 아래처럼 등록한 뒤 Claude에서 **`play` 프롬프트**를 고르거나 "TRPG 시작해 줘"라고 하면 된다.
API 키는 필요 없다.

### Claude Code

저장소 루트의 `.mcp.json`에 등록돼 있다. 이 폴더에서 Claude Code 세션을 새로 시작하면 서버 사용을 허용할지 묻는다.

```json
{
  "mcpServers": {
    "trpg": {
      "command": "pnpm",
      "args": ["--silent", "mcp"]
    }
  }
}
```

### Claude 데스크톱

Claude 데스크톱은 터미널의 `PATH`(nvm 등)를 모를 수 있으므로 **절대 경로**로 등록한다.
경로는 `which node`와 이 저장소 위치로 바꾼다.

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "trpg": {
      "command": "/절대/경로/node",
      "args": [
        "/절대/경로/trpg/packages/mcp/node_modules/tsx/dist/cli.mjs",
        "/절대/경로/trpg/packages/mcp/src/index.ts"
      ]
    }
  }
}
```

설정을 바꾼 뒤 Claude 데스크톱을 다시 시작한다.

### MCP 서버가 여는 것

- tool: `start_session`, `load_world`, `list_worlds`, `get_scene`, `take_action`, `fast_forward`, `recall`, `record_turn_summary`, `run_command`, 장면 정리 tool(`npc_presence`, `transfer_item`, `add_belief`, 임무, 목격자, 비밀)
- prompt: `play` (GM 지침 + 세션 시작 안내)
- 로그는 stderr로만 쓴다. stdout은 MCP 프로토콜 전용이다
- 환경 변수: `SCENARIO`(기본 `post_apoc`), `SAVES_DIR`(기본 `saves`)

## 정보 명령어

두 모드 모두 같은 명령어를 쓴다. 읽기 전용이고 시간이 흐르지 않는다. 행동은 명령어가 아니라 자연어로 한다.

| 명령어 | 내용 |
|---|---|
| `!상태` | 능력치, 몸 상태, 소속과 등급, 평판 |
| `!소지품` | 가진 물건과 주변에 놓인 물건 |
| `!지도` | 현재 위치, 아는 장소 (장소 시스템 단계에서 추가) |
| `!시간` | 날짜, 시각 |
| `!인물 [이름]` | 아는 인물 목록 / 그 인물에 대해 아는 것과 관계 |
| `!세력` | 아는 세력 정보 (세력 단계에서 추가) |
| `!임무` | 현재 임무와 목표 |
| `!배급` | 배급과 자원 (자원 단계에서 추가) |
| `!소문` | 최근 들은 소문 |
| `!일지 [검색어]` | 지난 일 기록 |
| `!연대기` | 죽은 캐릭터들의 기록 (사망·계승 단계에서 추가) |
| `!도움말` | 명령어 목록 |

## 개발

```bash
pnpm test            # 단위 테스트 (LLM 호출 없음)
pnpm typecheck       # 전체 타입 체크
pnpm content:check   # 시나리오 팩 검증
pnpm mcp             # MCP 서버 직접 실행 (stdio)
```

패키지 구조:

```
packages/core     엔진: 판정, 시뮬레이션, 상태, 저장, 정보 필터, 명령어 (LLM을 모른다)
packages/gm       웹 앱 모드의 GM 호출·요약 (Claude API)
packages/server   웹 앱용 HTTP·SSE 어댑터
packages/mcp      MCP 서버 어댑터
packages/ui       웹 앱 화면
content/scenarios/<id>/   시나리오 팩
```
