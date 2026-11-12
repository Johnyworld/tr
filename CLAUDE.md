# CLAUDE.md

포스트아포칼립스 배경의 1인용 AI TRPG. 코드가 시뮬레이션을 돌리고, Claude가 GM으로서 이야기를 연출한다.
웹 앱 모드(우리 서버가 Claude API 호출)와 MCP 모드(Claude 앱 세션이 GM, 엔진은 로컬 MCP 서버)를 함께 지원한다.
전체 기획은 `docs/design.md`를 참고한다. 설계 판단이 필요하면 먼저 그 문서를 읽고, 결정이 바뀌면 문서도 함께 갱신한다.

## 절대 원칙

1. **코드 = 세계의 물리 법칙, AI = GM 겸 연출가.** 판정, 상태 변경, 시뮬레이션은 전부 `packages/core`의 코드가 담당한다.
2. **AI는 숫자를 만들지 않는다.** 피해, 가격, 시간, 병력, 관계 변화량은 코드가 계산한다. AI는 tool call로 요청만 하고, 코드가 검증 후 적용한다.
3. **AI는 캐릭터를 죽일 수 없다.** 사망은 부상 트랙과 판정 결과로만 발생한다.
4. **AI 프롬프트에는 현재 캐릭터의 Belief State만 넣는다.** World State(진짜 상태), 숨은 목격자, 다른 캐릭터의 비밀이 프롬프트로 새지 않게 한다. **RAG 검색 결과도 포함한다**: 현재 캐릭터가 알 수 없는 청크(visibility, knownBy)는 검색 결과에 절대 들어가지 않는다.
5. **플레이어 입력은 의도일 뿐이다.** 서술된 결과를 사실로 받아들이지 않는다.
6. **플레이어와 NPC는 같은 캐릭터 스키마를 쓴다.** 사망 후 기존 NPC로 이어서 플레이할 수 있어야 한다.
7. **core에 장르 요소를 하드코딩하지 않는다.** 자원, 능력치, 기본 행동, 상태 트랙, 등급 사다리, 화법 규칙, GM 톤, 위협·조우 테이블은 시나리오 팩(`content/scenarios/<id>/scenario.yaml`)에서 읽는다. 이름과 목록을 데이터로 빼는 데까지만 하고, 규칙 자체의 플러그인화는 두 번째 장르를 만들 때 한다.
8. **core는 LLM을 모른다.** LLM 호출·컨텍스트 조립·요약은 `gm` 패키지(웹 앱 모드 전용)에 둔다.
9. **게임 규칙은 어댑터가 아니라 core에 둔다.** 상태 변경, 정보 필터, RAG 필터링, 명령어 처리를 `server`나 `mcp`에 넣지 않는다.
10. **웹 앱 모드는 API 키만 쓴다.** claude.ai 구독 로그인을 우리 앱에 연결하지 않는다 (Anthropic 정책상 금지).
11. **정보 명령어(`!`)는 읽기 전용이다.** 게임 시간을 쓰지 않고 상태를 바꾸지 않는다. 출력도 정보 필터를 거친다.
12. **MCP 서버는 stdout에 로그를 쓰지 않는다.** stdout은 MCP 프로토콜 전용, 로그는 stderr로.

## 핵심 규칙 요약

- 판정: 2d6 + 보정. 10+ 성공 / 7~9 대가 있는 성공 / 6- 실패
- 엔딩: 주인공 사망뿐. 이후 같은 세계에서 새 캐릭터로 계승. 아이언맨(자동 저장만)
- MVP 시작 역할: 세력 A의 하급 전투원
- 시간: 평시엔 행동 비용만큼 흐르고, 이동·전쟁은 끼어들기 조건이 있는 빨리감기
- 자원 5종: 식량, 물, 탄약, 의약품, 연료 (인원수만큼 매일 소모)

## 구조

```
packages/core     엔진: 판정, 시뮬레이션, 상태, 저장, RAG, 정보 필터, 명령어 (UI·HTTP·LLM을 모르는 순수 TS)
packages/gm       LLM 오케스트레이션: 의도 분류, 컨텍스트 조립, GM 호출, 요약 (웹 앱 모드 전용)
packages/server   웹 앱용 HTTP·SSE 어댑터 (Hono, core + gm)
packages/mcp      MCP 서버 어댑터 (core만 사용, stdio)
packages/ui       Vite + React SPA (웹 앱 화면)
content/scenarios/<id>/   시나리오 팩: scenario.yaml, YAML 콘텐츠(factions, npcs, locations, roles, items, storylets),
                          lore/(RAG 원문), speech/, prompts/, eval/(검색 평가 세트)
docs/design.md    기획서
```

- 스택: TypeScript, pnpm workspaces, Vite + React, Hono, SQLite + Drizzle, zod, Claude API, RAG(bge-m3 로컬 임베딩, sqlite-vec, FTS5)
- `core`는 `gm`, `server`, `mcp`, `ui`를 import하지 않는다. `gm`은 `server`·`mcp`·`ui`를 import하지 않는다
- 두 모드는 같은 SQLite 세이브를 쓴다. 세계를 열 때 잠금 파일로 동시 접근만 막는다
- DB 접근은 저장소(repository) 레이어로 모은다 (나중에 Postgres 전환 대비)
- 콘텐츠 YAML은 zod 스키마로 검증한다. 스키마를 바꾸면 기존 콘텐츠도 함께 갱신한다
- 임베딩은 core의 `Embedder` 인터페이스 뒤에 둔다. 저장 시 모델 ID와 차원을 기록하고, 모델이 바뀌면 재임베딩한다
- RAG 검색 결과는 정보 필터 위반 0건을 테스트로 확인한다
- 이벤트 로그는 append-only. 상태 변경은 반드시 이벤트로 기록한다

## 작업 규칙

- 난수는 주입 가능한 RNG를 사용한다 (테스트에서 시드 고정)
- core 로직은 LLM 없이 단위 테스트한다
- API 키는 `.env`에만 둔다. 절대 커밋하지 않는다
- MVP 범위 밖의 기능(`docs/design.md` 15.2)은 요청 없이 구현하지 않는다. 다만 스키마는 확장을 막지 않게 설계한다
- 사용자와의 대화와 문서는 한국어로 작성한다

## 명령어

```bash
pnpm install        # 설치
cp .env.example .env  # 처음 한 번. ANTHROPIC_API_KEY를 채운다
pnpm dev            # 서버(127.0.0.1:8787) + UI(localhost:5173) 동시 실행
pnpm test           # 단위 테스트 (vitest, LLM 호출 없음)
pnpm typecheck      # 전체 타입 체크
pnpm content:check  # 시나리오 팩(post_apoc) 검증
pnpm mcp            # MCP 서버 실행 (stdio). Claude 앱 등록 방법은 README
pnpm --filter @trpg/core db:generate  # 세이브 DB 스키마를 바꾼 뒤 마이그레이션 생성
```

- UI는 Vite 프록시로 `/api`를 서버에 넘긴다. 서버 포트는 `SERVER_PORT`로 바꾼다 (`PORT`는 쓰지 않는다)
- GM 모델은 `GM_MODEL`(기본 `claude-opus-5-5`), 장면 요약 모델은 `SUMMARY_MODEL`(기본 `claude-haiku-5-5`)로 바꾼다
- RAG: 첫 실행 때 bge-m3 모델(약 570MB)을 `.cache/models/`에 받고, lore 색인을 `.cache/rag/`에 만든다 (둘 다 git 제외). `RAG=off`로 끈다
- 시나리오는 `SCENARIO`로 고른다 (기본 `post_apoc`, `content/scenarios/<id>/`)
- 세이브는 `saves/worlds/<worldId>.db` (`SAVES_DIR`로 폴더 변경). 열려 있는 세계는 `<worldId>.db.lock`으로 잠긴다. 형식·시나리오가 맞지 않는 세이브는 `saves/archive/`로 옮겨진다
- 게임 상태나 이벤트 형태를 바꾸면 `SAVE_SCHEMA_VERSION`을 올린다 (`packages/core/src/game/state.ts`)
