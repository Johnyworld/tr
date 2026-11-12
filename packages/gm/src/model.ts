import type { ToolSpec } from "@trpg/core";

/**
 * 공급자와 무관한 LLM 인터페이스 (웹 앱 모드 전용).
 * GM 루프는 이 형태만 알고, Claude 어댑터(claude.ts)가 API 형식으로 바꾼다.
 */

export type { ToolSpec };

export type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown };

export type UserBlock =
  | { type: "text"; text: string }
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean };

export type ModelMessage =
  | { role: "user"; content: UserBlock[] }
  | {
      role: "assistant";
      content: AssistantBlock[];
      /**
       * 공급자 원본 응답 내용. 같은 턴의 tool 루프 안에서는 이것을 그대로 돌려보낸다
       * (Claude의 thinking 블록은 수정 없이 돌려보내야 한다).
       */
      raw?: unknown;
    };

export type ModelRequest = {
  system: string;
  tools: ToolSpec[];
  messages: ModelMessage[];
};

export type ModelStopReason = "end" | "tool_use" | "max_tokens" | "refusal" | "other";

export type ModelResponse = {
  stopReason: ModelStopReason;
  content: AssistantBlock[];
  raw?: unknown;
};

/**
 * 한 번의 모델 호출. 텍스트 조각을 yield하고, 끝나면 전체 응답을 return한다.
 * 실패하면 예외를 던진다.
 */
export type LanguageModel = (
  request: ModelRequest,
  options?: { signal?: AbortSignal },
) => AsyncGenerator<string, ModelResponse>;
