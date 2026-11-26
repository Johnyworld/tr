## 13. 기술 스택과 구조

| 영역 | 선택 |
|---|---|
| 언어 | TypeScript |
| UI | Vite + React (SPA) |
| MCP | `@modelcontextprotocol/sdk`, stdio transport. 상태 화면은 같은 프로세스의 로컬 HTTP(SSE) |
| DB | SQLite + Drizzle (나중에 Postgres 전환 가능하게 저장소 레이어 분리) |
| 검증 | zod |
| LLM | Claude 앱 세션이 GM (구독 사용량). 프로젝트 코드는 LLM을 부르지 않는다 |
| 임베딩 | bge-m3 로컬 실행 (transformers.js, ONNX q8). `Embedder` 인터페이스로 교체 가능 |
| 벡터 검색 | SQLite + sqlite-vec |
| 키워드 검색 | SQLite FTS5. 벡터 결과와 RRF로 병합 |
| 패키지 | pnpm workspaces 모노레포 |

```
trpg/
├── CLAUDE.md
├── docs/design.md          # 이 문서
├── packages/
│   ├── core/               # 엔진: 판정, 시뮬레이션, 상태, 저장, RAG, 정보 필터, 명령어 (LLM 호출 없음)
│   ├── mcp/                # MCP 서버 어댑터 (core만 사용, stdio) + 상태 화면 서버
│   └── ui/                 # 상태 화면 (캐릭터 시트, status.html)
└── content/
    └── scenarios/
        └── post_apoc/          # 시나리오 팩 (12.3)
            ├── scenario.yaml   # 자원·능력치·행동·상태 트랙·등급 사다리·화법·톤
            ├── factions/  npcs/  locations/  roles/  items/  storylets/
            ├── lore/           # RAG lore 컬렉션 원문 (*.md)
            ├── speech/         # 화법 규칙
            ├── prompts/        # GM 톤 프롬프트
            └── eval/           # RAG 검색 평가 세트
```

- `core`는 UI, 서버, LLM을 모른다. 나중에 Electron이든 호스팅 웹이든 껍데기만 바꿔 끼운다
- 어댑터(`mcp`)에는 게임 로직을 두지 않는다
- `.env`(로컬 설정)는 Git에 올리지 않는다
