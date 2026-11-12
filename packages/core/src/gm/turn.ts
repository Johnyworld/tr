import type { Rng } from "../rng.ts";
import type { GameStore } from "../game/store.ts";
import type { Content } from "../content/schemas.ts";
import { buildPlayerPrompt } from "./context.ts";
import type { LanguageModel, ModelMessage, ModelStopReason, UserBlock } from "./model.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { MIN_TURN_MINUTES } from "../rules/time.ts";
import { executeTool, gmToolSpecs, type ToolDisplayEvent } from "./tools.ts";
import { runStartOfTurn } from "./turnStart.ts";

/** 플레이어 한 번의 입력 최대 길이 (문자 수) */
export const MAX_INPUT_LENGTH = 2000;

/** 프롬프트에 넣을 최근 플레이어 턴 수. 이후 단계에서 턴 요약으로 대체한다 */
export const MAX_HISTORY_TURNS = 20;

/** 한 턴에서 tool 호출 → 결과 반환을 반복할 최대 횟수 */
export const MAX_TOOL_ROUNDS = 6;

/** 대화 기록. UI 표시와 다음 턴 프롬프트 조립에 함께 쓴다 */
export type TranscriptEntry =
  | { kind: "player"; text: string; /** 실제로 모델에 보낸 user 메시지 */ prompt: string }
  | { kind: "gm"; text: string }
  | { kind: "tool"; display: ToolDisplayEvent };

export type TurnStopReason = "end" | "max_tokens" | "refusal" | "other";

/** 턴 진행 중에 흘러나오는 이벤트 */
export type TurnEvent =
  | { type: "text"; text: string }
  | { type: "tool"; display: ToolDisplayEvent }
  | { type: "done"; stopReason: TurnStopReason }
  | { type: "error"; message: string };

export class InvalidPlayerInputError extends Error {
  override name = "InvalidPlayerInputError";
}

export function normalizePlayerInput(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new InvalidPlayerInputError("입력이 비어 있습니다.");
  if (trimmed.length > MAX_INPUT_LENGTH) {
    throw new InvalidPlayerInputError(`입력은 ${MAX_INPUT_LENGTH}자 이하여야 합니다.`);
  }
  return trimmed;
}

export function isPlayerDead(store: GameStore): boolean {
  const state = store.getState();
  return state.characters[state.playerId]?.dead === true;
}

/**
 * 지난 대화를 모델 메시지로 바꾼다.
 * - 지난 턴은 텍스트만 남긴다 (thinking 블록은 모두 빼도 된다)
 * - user 메시지는 당시 보낸 그대로 넣어 기록이 append-only가 되게 한다 (프롬프트 캐시 유지)
 */
export function buildHistoryMessages(transcript: readonly TranscriptEntry[]): ModelMessage[] {
  const playerIndexes = transcript.flatMap((e, i) => (e.kind === "player" ? [i] : []));
  const start =
    playerIndexes.length > MAX_HISTORY_TURNS ? playerIndexes[playerIndexes.length - MAX_HISTORY_TURNS]! : 0;

  const messages: ModelMessage[] = [];
  for (const entry of transcript.slice(start)) {
    if (entry.kind === "tool") continue;
    const role = entry.kind === "player" ? "user" : "assistant";
    const text = entry.kind === "player" ? entry.prompt : entry.text;
    if (!text.trim()) continue;
    if (messages.length === 0 && role === "assistant") continue; // 첫 메시지는 user여야 한다
    const last = messages.at(-1);
    if (last && last.role === role) {
      last.content.push({ type: "text", text });
    } else {
      messages.push({ role, content: [{ type: "text", text }] } as ModelMessage);
    }
  }
  return messages;
}

export type RunTurnOptions = {
  model: LanguageModel;
  store: GameStore;
  content: Content;
  transcript: readonly TranscriptEntry[];
  input: string;
  rng: Rng;
  signal?: AbortSignal;
};

/**
 * 플레이어 입력 하나를 처리한다.
 * GM이 tool을 요청하면 코드가 검증·실행하고 결과를 돌려준 뒤 서술을 이어 간다.
 * 이벤트를 yield하고, 이번 턴에 새로 생긴 대화 기록을 return한다 (중단·오류 시에도).
 */
export async function* runTurn(options: RunTurnOptions): AsyncGenerator<TurnEvent, TranscriptEntry[]> {
  const { model, store, content, transcript, rng, signal } = options;
  const input = normalizePlayerInput(options.input);
  if (isPlayerDead(store)) throw new InvalidPlayerInputError("캐릭터가 사망했습니다.");

  store.append({ type: "turn_started", turn: store.getState().turn + 1, input });
  // 코드가 하는 턴 시작 처리 (임무 기한 만료, 오늘의 임무 후보)
  const startDisplays = runStartOfTurn({ store, rng, content });
  const prompt = buildPlayerPrompt(store.getState(), content, input);
  const entries: TranscriptEntry[] = [{ kind: "player", text: input, prompt }];
  for (const display of startDisplays) {
    entries.push({ kind: "tool", display });
    yield { type: "tool", display };
  }

  const messages: ModelMessage[] = [
    ...buildHistoryMessages(transcript),
    { role: "user", content: [{ type: "text", text: prompt }] },
  ];

  // 한 세계 안에서 바뀌지 않는 부분 (프롬프트 캐시)
  const system = buildSystemPrompt(content.scenario, content.roles[store.getState().roleId]);
  const tools = gmToolSpecs(content.scenario);
  let stopReason: ModelStopReason = "other";
  let timeSpent = false;
  /** 지금 받고 있는 서술 조각. 중단·오류 시에도 기록에 남긴다 */
  let segment = "";
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      segment = "";
      const call = model({ system, tools, messages }, { signal });
      let step = await call.next();
      while (!step.done) {
        segment += step.value;
        yield { type: "text", text: step.value };
        step = await call.next();
      }
      const response = step.value;
      stopReason = response.stopReason;
      if (segment) entries.push({ kind: "gm", text: segment });
      segment = "";
      messages.push({ role: "assistant", content: response.content, raw: response.raw });

      // tool은 모델이 정상적으로 tool_use로 멈췄을 때만 실행한다 (잘리거나 거절된 입력은 실행하지 않음)
      if (stopReason !== "tool_use") break;

      const results: UserBlock[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_call") continue;
        const outcome = executeTool(block.name, block.input, { store, rng, content });
        if (outcome.ok) {
          if (block.name === "spend_time") timeSpent = true;
          for (const display of [outcome.display, ...(outcome.extra ?? [])]) {
            entries.push({ kind: "tool", display });
            yield { type: "tool", display };
          }
          results.push({ type: "tool_result", toolCallId: block.id, content: outcome.resultText });
        } else {
          results.push({ type: "tool_result", toolCallId: block.id, content: outcome.error, isError: true });
        }
      }
      messages.push({ role: "user", content: results });
    }

    if (stopReason === "tool_use") {
      yield { type: "error", message: "GM이 tool을 너무 많이 호출해 이번 턴을 멈췄습니다." };
      return entries;
    }
    // GM이 시간을 쓰지 않았으면 잠깐의 행동으로 본다 (기획서 5.1: 평시엔 행동 비용만큼 흐른다)
    if (!timeSpent && !isPlayerDead(store)) {
      const now = store.getState().time;
      store.append({ type: "time_advanced", activity: "brief", from: now, to: now + MIN_TURN_MINUTES });
    }
    yield { type: "done", stopReason: stopReason === "end" ? "end" : stopReason };
  } catch (err) {
    if (segment) entries.push({ kind: "gm", text: segment });
    if (!signal?.aborted) {
      yield { type: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }
  return entries;
}
