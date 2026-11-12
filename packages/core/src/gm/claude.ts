import Anthropic from "@anthropic-ai/sdk";
import type { NarrationModel, NarrationStopReason } from "./types.ts";

export const DEFAULT_GM_MODEL = "claude-opus-5-5";

export type ClaudeNarrationOptions = {
  client?: Anthropic;
  model?: string;
  maxTokens?: number;
};

/**
 * Claude API로 서술을 스트리밍하는 NarrationModel.
 * - 거절(refusal) 시 서버 측 fallback으로 다른 모델이 이어받는다
 * - 시스템 프롬프트는 캐시한다
 */
export function createClaudeNarrationModel(options: ClaudeNarrationOptions = {}): NarrationModel {
  const client = options.client ?? new Anthropic();
  const model = options.model ?? DEFAULT_GM_MODEL;
  const maxTokens = options.maxTokens ?? 16000;

  return async function* claudeNarration(request, callOptions) {
    try {
      const stream = client.beta.messages.stream(
        {
          model,
          max_tokens: maxTokens,
          output_config: { effort: "medium" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
          messages: request.messages,
        },
        { signal: callOptions?.signal },
      );

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        }
      }

      const final = await stream.finalMessage();
      yield { type: "done", stopReason: toStopReason(final.stop_reason) };
    } catch (err) {
      if (callOptions?.signal?.aborted) return;
      yield { type: "error", message: describeError(err) };
    }
  };
}

function toStopReason(reason: string | null): NarrationStopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "Claude API 인증에 실패했습니다. .env의 ANTHROPIC_API_KEY를 확인하세요.";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "Claude API 요청 한도에 걸렸습니다. 잠시 후 다시 시도하세요.";
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "Claude API에 연결하지 못했습니다. 네트워크를 확인하세요.";
  }
  if (err instanceof Anthropic.APIError) {
    return `Claude API 오류 (${err.status ?? "알 수 없음"}): ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
