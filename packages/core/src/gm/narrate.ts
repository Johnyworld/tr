import type { ChatTurn, NarrationEvent, NarrationModel, NarrationRequest } from "./types.ts";
import { GM_SYSTEM_PROMPT } from "./prompt.ts";

/** 플레이어 한 번의 입력 최대 길이 (문자 수) */
export const MAX_INPUT_LENGTH = 2000;

/** 프롬프트에 넣을 최근 대화 턴 수. 이후 단계에서 턴 요약으로 대체한다. */
export const MAX_HISTORY_TURNS = 40;

export class InvalidPlayerInputError extends Error {
  override name = "InvalidPlayerInputError";
}

export function normalizePlayerInput(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new InvalidPlayerInputError("입력이 비어 있습니다.");
  }
  if (trimmed.length > MAX_INPUT_LENGTH) {
    throw new InvalidPlayerInputError(`입력은 ${MAX_INPUT_LENGTH}자 이하여야 합니다.`);
  }
  return trimmed;
}

/**
 * 대화 기록과 새 입력으로 LLM 요청을 만든다.
 * - 최근 MAX_HISTORY_TURNS 턴만 남긴다
 * - 첫 메시지는 반드시 user여야 하므로 앞쪽의 GM 턴은 버린다
 * - 같은 역할이 연속되면 하나로 합친다 (중단된 스트림 등으로 생길 수 있다)
 */
export function buildNarrationRequest(history: ChatTurn[], input: string): NarrationRequest {
  const playerInput = normalizePlayerInput(input);
  const recent = history.slice(-MAX_HISTORY_TURNS).filter((turn) => turn.text.trim().length > 0);

  const messages: NarrationRequest["messages"] = [];
  for (const turn of [...recent, { role: "player" as const, text: playerInput }]) {
    const role = turn.role === "player" ? "user" : "assistant";
    if (messages.length === 0 && role === "assistant") continue;
    const last = messages.at(-1);
    if (last && last.role === role) {
      last.content = `${last.content}\n\n${turn.text}`;
    } else {
      messages.push({ role, content: turn.text });
    }
  }

  return { system: GM_SYSTEM_PROMPT, messages };
}

/** 플레이어 입력을 받아 GM 서술을 스트리밍한다. */
export async function* narrate(
  model: NarrationModel,
  history: ChatTurn[],
  input: string,
  options?: { signal?: AbortSignal },
): AsyncGenerator<NarrationEvent> {
  const request = buildNarrationRequest(history, input);
  yield* model(request, options);
}
