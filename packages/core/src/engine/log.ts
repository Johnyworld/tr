import type { ToolDisplayEvent } from "./toolkit.ts";

/**
 * 대화 기록 (두 모드가 같이 쓰는 세이브의 transcript).
 * - player: 플레이어 입력. prompt는 웹 앱 모드에서 실제로 GM에 보낸 user 메시지 (다음 턴 기록 재사용)
 * - gm: 웹 앱 모드의 GM 서술
 * - note: MCP 모드에서 GM이 남긴 서술 요약 (서술 원문은 Claude 앱에만 있다)
 * - tool: 판정·시간 같은 시스템 결과 카드
 */
export type TranscriptEntry =
  | { kind: "player"; text: string; prompt?: string }
  | { kind: "gm"; text: string }
  | { kind: "note"; text: string }
  | { kind: "tool"; display: ToolDisplayEvent };

/** 모드 전환 때 이야기가 끊기지 않게 남기는 요약 (기획서 11.5) */
export type SummaryKind = "turn" | "scene";
export type PlayMode = "web" | "mcp";

/** RAG 검색 기록 (디버깅). 무엇을 왜 넣었는지 */
export type RetrievalRecord = {
  turn: number;
  time: number;
  mode: PlayMode;
  collection: "lore" | "memory";
  /** gm_context: 웹 앱 GM 컨텍스트 조립, recall: GM이 직접 찾음 */
  purpose: "gm_context" | "recall";
  trace: unknown;
};

export type TurnSummary = {
  kind: SummaryKind;
  text: string;
  /** 요약을 남긴 시점의 턴 번호와 게임 시각 */
  turn: number;
  time: number;
  mode: PlayMode;
  /** 요약을 남긴 시점의 플레이어 캐릭터. 캐릭터가 바뀌면 이전 캐릭터의 기억은 검색되지 않는다 */
  characterId: string;
};
