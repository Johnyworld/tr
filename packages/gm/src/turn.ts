import {
  buildPlayerPrompt,
  formatLoreHits,
  InvalidPlayerInputError,
  normalizePlayerInput,
  type GameWorld,
  type ToolDisplayEvent,
  type TranscriptEntry,
} from "@trpg/core";
import type { LanguageModel, ModelMessage, ModelStopReason, UserBlock } from "./model.ts";
import type { Summarizer } from "./summarizer.ts";

/** 프롬프트에 넣을 최근 플레이어 턴 수. 그 이전은 장면 요약(recap)으로 대신한다 */
export const MAX_HISTORY_TURNS = 20;

/** 한 턴에서 tool 호출 → 결과 반환을 반복할 최대 횟수 */
export const MAX_TOOL_ROUNDS = 6;

/** 턴 요약 몇 개마다 장면 요약을 만들지 */
export const SCENE_SUMMARY_EVERY = 5;

/** 턴 요약에 남길 서술의 최대 길이 */
export const TURN_SUMMARY_MAX_LENGTH = 600;

export type TurnStopReason = "end" | "max_tokens" | "refusal" | "other";

/** 턴 진행 중에 흘러나오는 이벤트 */
export type TurnEvent =
  | { type: "text"; text: string }
  | { type: "tool"; display: ToolDisplayEvent }
  | { type: "done"; stopReason: TurnStopReason }
  | { type: "error"; message: string };

/**
 * 지난 대화를 모델 메시지로 바꾼다.
 * - 지난 턴은 텍스트만 남긴다 (thinking 블록은 모두 빼도 된다)
 * - user 메시지는 당시 보낸 그대로 넣어 기록이 append-only가 되게 한다 (프롬프트 캐시 유지)
 * - MCP 모드에서 쌓인 기록(note, prompt 없는 player)도 이어지게 넣는다
 */
export function buildHistoryMessages(transcript: readonly TranscriptEntry[]): ModelMessage[] {
  const playerIndexes = transcript.flatMap((e, i) => (e.kind === "player" ? [i] : []));
  const start =
    playerIndexes.length > MAX_HISTORY_TURNS ? playerIndexes[playerIndexes.length - MAX_HISTORY_TURNS]! : 0;

  const messages: ModelMessage[] = [];
  for (const entry of transcript.slice(start)) {
    if (entry.kind === "tool") continue;
    const role = entry.kind === "player" ? "user" : "assistant";
    const text =
      entry.kind === "player" ? (entry.prompt ?? entry.text) : entry.kind === "note" ? `[서술 요약] ${entry.text}` : entry.text;
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

export type RunGmTurnOptions = {
  model: LanguageModel;
  world: GameWorld;
  input: string;
  /** 장면 요약을 만들 작은 모델. 없으면 턴 요약만 남긴다 */
  summarizer?: Summarizer;
  signal?: AbortSignal;
};

const NO_ACTION = { check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false };

/**
 * 웹 앱 모드의 플레이어 입력 하나를 처리한다.
 * GM(Claude)이 tool을 요청하면 core가 검증·실행하고, 결과를 돌려준 뒤 서술을 이어 간다.
 * 한 입력에 take_action이 한 번도 없으면 잠깐의 행동으로 자동 처리해 세계가 멈추지 않게 한다 (MCP 모드와 같은 결과).
 * 대화 기록은 생기는 대로 세이브에 남긴다 (중단·오류 시에도).
 */
export async function* runGmTurn(options: RunGmTurnOptions): AsyncGenerator<TurnEvent, void> {
  const { model, world, summarizer, signal } = options;
  const input = normalizePlayerInput(options.input);
  if (world.isPlayerDead()) throw new InvalidPlayerInputError("캐릭터가 사망했습니다.");

  const transcript = world.transcript();
  const history = buildHistoryMessages(transcript);
  // RAG: 플레이어 입력 + 장면 요약 + 함께 있는 인물로 lore를 찾는다 (캐릭터가 볼 수 있는 것만)
  const lore = await world.searchLore(world.contextQuery(input), "gm_context");
  const prompt = buildPlayerPrompt(
    world.state(),
    world.content,
    input,
    needsRecap(transcript) ? world.recap() : "",
    formatLoreHits(lore.hits),
  );
  world.appendTranscript([{ kind: "player", text: input, prompt }]);

  const messages: ModelMessage[] = [...history, { role: "user", content: [{ type: "text", text: prompt }] }];
  const system = world.guide();
  const tools = world.toolSpecs();

  let stopReason: ModelStopReason = "other";
  let actionTaken = false;
  let narration = "";
  let segment = "";
  let failure: string | null = null;
  const endSegment = () => {
    if (segment) {
      world.appendTranscript([{ kind: "gm", text: segment }]);
      narration += (narration ? "\n\n" : "") + segment;
    }
    segment = "";
  };

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const call = model({ system, tools, messages }, { signal });
      let step = await call.next();
      while (!step.done) {
        segment += step.value;
        yield { type: "text", text: step.value };
        step = await call.next();
      }
      const response = step.value;
      stopReason = response.stopReason;
      endSegment();
      messages.push({ role: "assistant", content: response.content, raw: response.raw });

      // tool은 모델이 정상적으로 tool_use로 멈췄을 때만 실행한다 (잘리거나 거절된 입력은 실행하지 않음)
      if (stopReason !== "tool_use") break;

      const results: UserBlock[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_call") continue;
        const outcome = world.executeTool(block.name, block.input);
        if (outcome.ok) {
          if (block.name === "take_action") actionTaken = true;
          for (const display of [...(outcome.silent ? [] : [outcome.display]), ...(outcome.extra ?? [])]) {
            yield { type: "tool", display };
          }
          results.push({ type: "tool_result", toolCallId: block.id, content: outcome.resultText });
        } else {
          results.push({ type: "tool_result", toolCallId: block.id, content: outcome.error, isError: true });
        }
      }
      messages.push({ role: "user", content: results });
    }
    if (stopReason === "tool_use") failure = "GM이 tool을 너무 많이 호출해 이번 턴을 멈췄습니다.";
  } catch (err) {
    endSegment();
    if (!signal?.aborted) failure = err instanceof Error ? err.message : String(err);
  }

  // GM이 턴을 진행하지 않았으면 잠깐의 행동으로 처리한다 (시간이 멈추지 않게)
  if (!actionTaken && !world.isPlayerDead()) {
    const outcome = world.executeTool("take_action", { intent: input, ...NO_ACTION });
    if (outcome.ok) {
      for (const display of [...(outcome.silent ? [] : [outcome.display]), ...(outcome.extra ?? [])]) {
        yield { type: "tool", display };
      }
    }
  }

  // 모드 전환 대비 요약 (기획서 11.5)
  if (narration) {
    world.recordSummary("turn", truncate(narration, TURN_SUMMARY_MAX_LENGTH));
    if (summarizer && !signal?.aborted) await summarizeScene(world, summarizer);
  }

  if (failure) yield { type: "error", message: failure };
  else if (!signal?.aborted) yield { type: "done", stopReason: stopReason === "tool_use" ? "other" : stopReason };
}

/** 마지막 장면 요약 이후 턴 요약이 SCENE_SUMMARY_EVERY개 쌓이면 장면 요약을 만든다 */
async function summarizeScene(world: GameWorld, summarizer: Summarizer) {
  const lastScene = world.summaries({ kind: "scene", limit: 1 })[0];
  const turns = world.summaries({ kind: "turn" }).filter((t) => !lastScene || t.turn > lastScene.turn);
  if (turns.length < SCENE_SUMMARY_EVERY) return;
  try {
    const text = await summarizer(turns.map((t) => t.text));
    if (text) world.recordSummary("scene", text);
  } catch (err) {
    // 요약 실패는 게임 진행을 막지 않는다. 다음 턴에 다시 시도한다
    console.error(`[gm] 장면 요약 실패: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 지난 이야기 요약이 필요한지: 웹 앱 모드의 GM 서술이 대화 기록에 아직 없거나,
 * 마지막 기록이 MCP 모드에서 온 것(서술 원문 없이 요약만 있음)일 때.
 */
export function needsRecap(transcript: readonly TranscriptEntry[]): boolean {
  const lastText = [...transcript].reverse().find((e) => e.kind !== "tool");
  if (!lastText) return true;
  if (lastText.kind === "note" || (lastText.kind === "player" && !lastText.prompt)) return true;
  return !transcript.some((e) => e.kind === "gm");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
