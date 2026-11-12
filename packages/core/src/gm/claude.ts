import Anthropic from "@anthropic-ai/sdk";
import type {
  AssistantBlock,
  LanguageModel,
  ModelMessage,
  ModelResponse,
  ModelStopReason,
  ToolSpec,
} from "./model.ts";

type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type BetaTool = Anthropic.Beta.Messages.BetaTool;

export const DEFAULT_GM_MODEL = "claude-opus-5-5";

export type ClaudeModelOptions = {
  client?: Anthropic;
  model?: string;
  maxTokens?: number;
};

/** API 오류를 사람이 읽을 메시지로 바꾼 예외 */
export class ModelError extends Error {
  override name = "ModelError";
}

/**
 * Claude API 어댑터.
 * - 거절(refusal) 시 서버 측 fallback으로 다른 모델이 이어받는다
 * - tools + system 앞부분과 대화 기록을 프롬프트 캐시한다
 * - 같은 턴의 tool 루프에서는 원본 응답(thinking 블록 포함)을 그대로 돌려보낸다
 */
export function createClaudeModel(options: ClaudeModelOptions = {}): LanguageModel {
  const client = options.client ?? new Anthropic();
  const model = options.model ?? DEFAULT_GM_MODEL;
  const maxTokens = options.maxTokens ?? 16000;

  return async function* claude(request, callOptions): AsyncGenerator<string, ModelResponse> {
    try {
      const stream = client.beta.messages.stream(
        {
          model,
          max_tokens: maxTokens,
          output_config: { effort: "medium" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          cache_control: { type: "ephemeral" },
          system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
          tools: request.tools.map(toClaudeTool),
          messages: request.messages.map(toClaudeMessage),
        },
        { signal: callOptions?.signal },
      );

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield event.delta.text;
        }
      }

      const final = await stream.finalMessage();
      const content: AssistantBlock[] = [];
      for (const block of final.content) {
        if (block.type === "text") content.push({ type: "text", text: block.text });
        else if (block.type === "tool_use") {
          content.push({ type: "tool_call", id: block.id, name: block.name, input: block.input });
        }
      }
      return { stopReason: toStopReason(final.stop_reason), content, raw: final.content };
    } catch (err) {
      if (callOptions?.signal?.aborted) throw err;
      throw new ModelError(describeError(err), { cause: err });
    }
  };
}

function toClaudeTool(spec: ToolSpec): BetaTool {
  return {
    name: spec.name,
    description: spec.description,
    input_schema: spec.inputSchema,
    strict: true,
    // 스트리밍 중 tool 입력을 버퍼링 없이 받는다. 입력 검증은 core(zod)가 한다
    eager_input_streaming: true,
  };
}

function toClaudeMessage(message: ModelMessage): BetaMessageParam {
  if (message.role === "assistant") {
    if (message.raw) return { role: "assistant", content: message.raw as BetaContentBlockParam[] };
    return {
      role: "assistant",
      content: message.content.map((block): BetaContentBlockParam =>
        block.type === "text"
          ? { type: "text", text: block.text }
          : { type: "tool_use", id: block.id, name: block.name, input: block.input },
      ),
    };
  }
  return {
    role: "user",
    content: message.content.map((block): BetaContentBlockParam =>
      block.type === "text"
        ? { type: "text", text: block.text }
        : {
            type: "tool_result",
            tool_use_id: block.toolCallId,
            content: block.content,
            ...(block.isError ? { is_error: true } : {}),
          },
    ),
  };
}

function toStopReason(reason: string | null): ModelStopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "tool_use":
      return "tool_use";
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
