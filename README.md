# 1인용 AI TRPG

포스트아포칼립스 세계에서, 코드가 돌리는 시뮬레이션 위에 Claude가 GM으로서 이야기를 연출하는 1인용 TRPG.
기획은 [docs/design.md](docs/design.md), 개발 규칙은 [CLAUDE.md](CLAUDE.md)를 참고한다.

## 플레이 방식

Claude 앱(Claude Code 또는 Claude 데스크톱) 세션이 GM이고, 이 저장소의 로컬 MCP 서버가 게임 엔진이다. 판정·상태·시간은 모두 엔진이 정하고, GM은 채팅에 이야기를 쓴다.
claude.ai 구독으로 플레이한다. API 키는 필요 없다.

(처음에는 브라우저에서 하는 웹 앱 모드도 있었지만 폐기했다. 기획서 11.5)

## 준비

```bash
pnpm install
```

Node 22 이상, pnpm 10이 필요하다. 로컬 설정이 필요하면 `cp .env.example .env` (RAG, 상태 화면, 치트).

세계 배경과 지난 기억 검색(RAG)에 쓰는 임베딩 모델 bge-m3(약 570MB)는 처음 실행할 때 `.cache/models/`에 내려받는다. 받지 않으려면 `.env`에 `RAG=off`.
세계마다 기억 색인 `saves/worlds/<세계>.memory.db`가 생긴다. 지워도 세계를 열 때 세이브에서 다시 만든다.

## 플레이

Claude Code에서는 **`/play`**(저장된 게임 번호 목록 → 고르기, 0번이 새 게임, `/play 2`·`/play 0`도 된다), 끝낼 때는 **`/quit`**. Claude 데스크톱에서는 `play` 프롬프트를 고르거나 "TRPG 시작해 줘"라고 하면 된다.
진행은 행동마다 자동 저장된다. 같은 세계를 두 세션에서 동시에 열 수는 없다 (잠금 파일 `<세계>.db.lock`).
새 게임은 **월드 → 시나리오 → 캐릭터** 순서로 고른다. 월드는 세계관·시대(지금은 "무너진 도시, 가람" 하나. 앞으로 중세 판타지·사이버펑크처럼 시대가 다른 월드를 더한다), 시나리오는 그 월드에서 어떤 사람으로 어디서 시작하는지("청솔형제단의 하급 전투원")다. **직접 쓰기**를 고르면 시작을 글로 쓰고, GM이 월드에 있는 세력·계급·장소·소지품으로 옮긴다 (무리의 우두머리 자리는 안 된다). GM이 월드 이야기와 지금 상황을 들려주고, 캐릭터는 채팅에서 한 단계씩(이름 → 성별 → 능력 → 트레잇 → 확인) 만든다. 사망 뒤 새 캐릭터는 같은 월드에서 캐릭터 만들기부터 한다.
게임을 열면 GM이 **상태 화면** 주소(`http://127.0.0.1:8790`, 세션마다 다음 포트)를 알려 준다. 앱의 브라우저 패널에 띄워 두면 캐릭터 시트가 바로바로 갱신된다. Claude Code에서는 저장소의 훅(`.claude/settings.json`)이 답변이 끝난 뒤에 시트를 갱신해, 채팅에 결과가 나온 다음 화면이 바뀐다. `TRPG_STATUS=off`로 끈다.

## MCP 서버 등록

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

- tool: `start_session`, `load_world`, `list_worlds`, `end_session`, `delete_world`(목록을 보고 있을 때만), `get_scene`, `take_action`, `fast_forward`, `recall`, `record_turn_summary`, `run_command`, `get_chronicle`, `choose_next_character`, `create_character`(새 게임·직접 쓰는 시나리오 포함), `learn_skill`, `spawn_extra`, `learn_name`, 장면 정리 tool(`npc_presence`, `transfer_item`, `add_belief`, 임무, 목격자, 비밀, `resolve_storylet`, `write_epitaph`), 지휘 tool(`squad_order` 분대장, `council_propose` 간부), 동행 tool(`companion_part` 떨어지기·헤어지기, `companion_crossroads` 갈림길), 인물 tool(`promote_extra` 이름 없는 인물 자라기, `reveal_tie` 숨은 관계 털어놓기)
- prompt: `play` (GM 지침 + 세션 시작 안내)
- 로그는 stderr로만 쓴다. stdout은 MCP 프로토콜 전용이다
- 월드 팩: `content/scenarios/` 아래 폴더마다 하나. 모두 읽는다 (`SCENARIO=<id>`로 하나만). 새 월드를 더하는 법은 기획서 12.4
- 환경 변수: `SCENARIO`, `SAVES_DIR`(기본 `saves`)

## 게임 밖 이야기

플레이 중 GM에게 게임 밖으로 묻고 싶으면 `(( ))`로 감싼다. 예: `((방금 왜 실패한 거야?))`. GM은 서술·판정 없이 답한다. 게임 코드나 콘텐츠 수정은 게임 세션이 아닌 별도의 Claude Code 세션에서 한다.

## 치트 (개발 모드)

테스트용. `.env`에 `TRPG_DEBUG=1`을 넣고 Claude 세션을 새로 열면, `~`로 시작하는 명령으로 상태를 바꿀 수 있다 (`~help`로 목록). 예: `~kill me`, `~stat strength 2`, `~give shotgun`, `~summon extra c_sentry_shotgun`, `~time +2d`. 치트를 쓴 세이브에는 "🛠 치트" 표시가 남는다.

## 정보 명령어

읽기 전용이고 시간이 흐르지 않는다. 행동은 명령어가 아니라 자연어로 한다.
**`?상태`** 처럼 `?`로 시작한다. Claude 앱은 줄 맨 앞의 `!`를 셸 명령으로 바꿔 터미널에서 실행하기 때문이다 (`!`도 받는다).

| 명령어 | 내용 |
|---|---|
| `?상태` | 능력, 스킬, 레벨·경험치, 몸 상태, 소속과 등급, 평판 |
| `?소지품` | 가진 물건과 주변에 놓인 물건 |
| `?지도` | 현재 구역, 맞닿은 구역과 그 주인, 설치해 둔 것 |
| `?시간` | 날짜, 시각 |
| `?인물 [이름]` | 아는 인물 목록 / 그 인물에 대해 아는 것과 관계 |
| `?세력` | 소속 무리 분위기·배급, 다른 무리의 평판과 관계, 최근 전황 |
| `?임무` | 현재 임무와 목표 |
| `?배급` | 오늘 배급, 무리 창고 사정 (들리는 말) |
| `?소문` | 최근 들은 소문 |
| `?일지 [검색어]` | 지난 일 기록. 검색어가 있으면 현재 캐릭터의 기억을 의미 검색 |
| `?연대기` | 죽은 캐릭터들의 기록, 사망했다면 다음 캐릭터 후보 |
| `?도움말` | 명령어 목록 |

## 개발

```bash
pnpm test            # 단위 테스트 (LLM 호출 없음)
pnpm typecheck       # 전체 타입 체크
pnpm content:check   # 모든 월드 팩 검증 (검색 평가 세트 포함)
pnpm war:sim post_apoc # 월드 팩의 세력 전쟁을 90일 미리 돌려 보기 (--days, --seeds)
pnpm rag:eval        # RAG 검색 평가 (--compare: 설정 비교, --hash: 모델 없이)
pnpm mcp             # MCP 서버 직접 실행 (stdio)
```

패키지 구조:

```
packages/core     엔진: 판정, 시뮬레이션, 상태, 저장, 정보 필터, 명령어, 캐릭터 생성 흐름 (LLM을 모른다)
packages/mcp      MCP 서버 어댑터 + 상태 화면 서버
packages/ui       상태 화면 (캐릭터 시트)
content/scenarios/<id>/   월드 팩 (코드에서는 시나리오 팩. 그 안의 roles/가 플레이어에게 보이는 시나리오)
```
