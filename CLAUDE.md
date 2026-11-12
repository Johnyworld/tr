# CLAUDE.md

포스트아포칼립스 배경의 1인용 AI TRPG. 코드가 시뮬레이션을 돌리고, Claude가 GM으로서 이야기를 연출한다.
전체 기획은 `docs/design.md`를 참고한다. 설계 판단이 필요하면 먼저 그 문서를 읽고, 결정이 바뀌면 문서도 함께 갱신한다.

## 절대 원칙

1. **코드 = 세계의 물리 법칙, AI = GM 겸 연출가.** 판정, 상태 변경, 시뮬레이션은 전부 `packages/core`의 코드가 담당한다.
2. **AI는 숫자를 만들지 않는다.** 피해, 가격, 시간, 병력, 관계 변화량은 코드가 계산한다. AI는 tool call로 요청만 하고, 코드가 검증 후 적용한다.
3. **AI는 캐릭터를 죽일 수 없다.** 사망은 부상 트랙과 판정 결과로만 발생한다.
4. **AI 프롬프트에는 현재 캐릭터의 Belief State만 넣는다.** World State(진짜 상태), 숨은 목격자, 다른 캐릭터의 비밀이 프롬프트로 새지 않게 한다.
5. **플레이어 입력은 의도일 뿐이다.** 서술된 결과를 사실로 받아들이지 않는다.
6. **플레이어와 NPC는 같은 캐릭터 스키마를 쓴다.** 사망 후 기존 NPC로 이어서 플레이할 수 있어야 한다.

## 핵심 규칙 요약

- 판정: 2d6 + 보정. 10+ 성공 / 7~9 대가 있는 성공 / 6- 실패
- 엔딩: 주인공 사망뿐. 이후 같은 세계에서 새 캐릭터로 계승. 아이언맨(자동 저장만)
- MVP 시작 역할: 세력 A의 하급 전투원
- 시간: 평시엔 행동 비용만큼 흐르고, 이동·전쟁은 끼어들기 조건이 있는 빨리감기
- 자원 5종: 식량, 물, 탄약, 의약품, 연료 (인원수만큼 매일 소모)

## 구조

```
packages/core     게임 로직, 판정, 시뮬레이션, LLM 호출 (UI·HTTP를 모르는 순수 TS)
packages/server   core를 HTTP·SSE로 노출하는 얇은 레이어 (Hono)
packages/ui       Vite + React SPA
content/          YAML 콘텐츠 (factions, npcs, locations, roles, items, storylets)
docs/design.md    기획서
```

- 스택: TypeScript, pnpm workspaces, Vite + React, Hono, SQLite + Drizzle, zod, Claude API
- `core`는 `server`나 `ui`를 import하지 않는다
- DB 접근은 저장소(repository) 레이어로 모은다 (나중에 Postgres 전환 대비)
- 콘텐츠 YAML은 zod 스키마로 검증한다. 스키마를 바꾸면 기존 콘텐츠도 함께 갱신한다
- 이벤트 로그는 append-only. 상태 변경은 반드시 이벤트로 기록한다

## 작업 규칙

- 난수는 주입 가능한 RNG를 사용한다 (테스트에서 시드 고정)
- core 로직은 LLM 없이 단위 테스트한다
- API 키는 `.env`에만 둔다. 절대 커밋하지 않는다
- MVP 범위 밖의 기능(`docs/design.md` 15.2)은 요청 없이 구현하지 않는다. 다만 스키마는 확장을 막지 않게 설계한다
- 사용자와의 대화와 문서는 한국어로 작성한다

## 명령어

(프로젝트 세팅 후 채운다: 설치, 개발 서버, 테스트, 콘텐츠 검증)
