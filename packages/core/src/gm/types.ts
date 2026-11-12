/** 대화 기록의 한 턴. 플레이어 입력(의도)과 GM 서술을 구분한다. */
export type ChatTurn = {
  role: "player" | "gm";
  text: string;
};

/** 서술 스트림에서 흘러나오는 이벤트. */
export type NarrationEvent =
  | { type: "text"; text: string }
  | { type: "done"; stopReason: NarrationStopReason }
  | { type: "error"; message: string };

/**
 * - end: 정상 종료
 * - max_tokens: 길이 제한으로 잘림
 * - refusal: 모델이 응답을 거절함 (fallback 모델까지 모두 거절)
 * - other: 그 밖의 종료 사유
 */
export type NarrationStopReason = "end" | "max_tokens" | "refusal" | "other";

/** LLM에 보낼 요청. 공급자와 무관한 형태로 둔다. */
export type NarrationRequest = {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
};

/**
 * 서술을 스트리밍하는 LLM 어댑터.
 * core 로직은 이 인터페이스만 알고, 테스트에서는 가짜 구현을 주입한다.
 */
export type NarrationModel = (
  request: NarrationRequest,
  options?: { signal?: AbortSignal },
) => AsyncIterable<NarrationEvent>;
