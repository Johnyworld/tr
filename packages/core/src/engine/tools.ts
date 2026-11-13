import { josa } from "../text.ts";
import { playerCalls } from "../game/acquaintance.ts";
import type { Content } from "../content/schemas.ts";
import { isIncapacitated } from "./body.ts";
import { enterScene, EXTRA_TOOLS } from "./extras.ts";
import { z } from "zod";
import {
  CHECK_OUTCOME_LABELS,
  DIFFICULTY_LABELS,
  DIFFICULTY_MODIFIER,
  difficultySchema,
  roll2d6,
  type CheckOutcome,
} from "../rules/check.ts";
import { HARM_LABELS, harmSeveritySchema } from "../rules/harm.ts";
import { idEnum, type Scenario } from "../scenario/schema.ts";
import { conditionPenalty, harmTrack, levelOf, moveIds, statIds, worsen } from "../scenario/scenario.ts";
import {
  ACTIVITY_COSTS,
  ACTIVITY_LABELS,
  activitySchema,
  formatDuration,
  formatTime,
  MAX_FAST_FORWARD_MINUTES,
  nextSegmentStart,
  rollActivityMinutes,
  SEGMENT_LABELS,
  segmentOf,
  timeSegmentSchema,
} from "../rules/time.ts";
import { createInterruptChecks, fastForward } from "../sim/fastForward.ts";
import { BELIEF_SOURCE_LABELS, beliefSourceSchema } from "../game/belief.ts";
import { findHolderInventory, SCENE_HOLDER, type GameEvent, type GameState } from "../game/state.ts";
import { defineTool, signed, STRICT_UNSUPPORTED_KEYS, type ToolContext, type ToolOutcome, type ToolSpec } from "./toolkit.ts";

export { STRICT_UNSUPPORTED_KEYS } from "./toolkit.ts";
import { MISSION_TOOLS } from "./missionTools.ts";
import { REPUTATION_TOOLS } from "./reputationTools.ts";
import { STORYLET_TOOLS } from "./storyletTools.ts";
import { SUCCESSION_TOOLS } from "./succession.ts";
import { createLearnSkillTool } from "./growth.ts";
import { createTakeActionSchema, takeAction, type TakeActionInput } from "./action.ts";

export type { ToolContext, ToolDisplayEvent, ToolOutcome, ToolSpec } from "./toolkit.ts";

const transferItem = defineTool({
  name: "transfer_item",
  description:
    "아이템을 옮긴다: 건네기, 내려놓기(to=scene), 장면에 놓인 것을 줍기(from=scene). " +
    "보관 위치는 플레이어, 장면에 있는 NPC의 id, 또는 scene. 없는 아이템이나 가진 것보다 많은 수량은 옮길 수 없다. 새 아이템을 만들어 내는 데는 쓸 수 없다. " +
    "NPC의 물건을 가져오려면 근거가 필요하다: 이번 턴 take_action에서 그 NPC를 target으로 한 판정(설득, 은밀 행동 등)이 성공·대가 있는 성공이었거나, 그 NPC가 플레이어를 충분히 믿어야 한다 (기꺼이 건네주는 경우).",
  schema: z.strictObject({
    from: z.string().describe("보내는 쪽: 캐릭터 id 또는 scene"),
    to: z.string().describe("받는 쪽: 캐릭터 id 또는 scene"),
    item_id: z.string().describe("아이템 id (상태에 표시된 것)"),
    quantity: z.number().int().min(1).describe("옮길 수량 (1 이상의 정수)"),
  }),
  run(input, { store, content }) {
    const state = store.getState();
    if (input.from === input.to) return { ok: false, error: "보내는 쪽과 받는 쪽이 같습니다." };
    for (const holder of [input.from, input.to]) {
      const reachable = holder === SCENE_HOLDER || holder === state.playerId || state.scene.present.includes(holder);
      if (!reachable) return { ok: false, error: `${josa(holderName(state, content, holder), "은/는")} 지금 장면에 없습니다. 먼저 npc_presence로 등장시키세요.` };
    }
    const fromInv = findHolderInventory(state, input.from);
    if (!fromInv) return { ok: false, error: `알 수 없는 보관 위치: ${input.from}` };
    if (!findHolderInventory(state, input.to)) return { ok: false, error: `알 수 없는 보관 위치: ${input.to}` };
    // NPC의 물건은 근거 없이 가져올 수 없다 (원칙 2: AI는 요청만 하고 코드가 검증)
    const fromNpc = input.from !== SCENE_HOLDER && input.from !== state.playerId;
    if (fromNpc) {
      const earned = Object.values(state.checks).some(
        (c) => c.turn === state.turn && c.actorId === state.playerId && c.target === input.from && c.outcome !== "miss",
      );
      const trust = state.relations[input.from]?.[state.playerId]?.trust ?? 0;
      // 무력화된(중상 이상·사망) 인물은 판정 없이 뒤진다 (기획서 7.5)
      const holderChar = state.characters[input.from];
      const helpless = holderChar ? isIncapacitated(content, holderChar) : false;
      if (!earned && trust < GIFT_TRUST && !helpless) {
        return {
          ok: false,
          error:
            `${holderName(state, content, input.from)}의 물건을 가져올 근거가 없습니다. ` +
            "이번 턴 take_action에서 그 인물을 target으로 한 판정(설득, 은밀 행동 등)이 성공하거나, 그 인물이 당신을 충분히 믿어야 합니다.",
        };
      }
    }
    const item = content.items[input.item_id];
    if (!item) return { ok: false, error: `알 수 없는 아이템: ${input.item_id}` };
    const have = fromInv[input.item_id] ?? 0;
    if (have < input.quantity) {
      return { ok: false, error: `${holderName(state, content, input.from)}에게 ${josa(item.name, "이/가")} ${have}개뿐입니다.` };
    }

    store.append({
      type: "item_transferred",
      from: input.from,
      to: input.to,
      itemId: item.id,
      quantity: input.quantity,
    });
    return {
      ok: true,
      resultText: `${item.name} ${input.quantity}개: ${holderName(state, content, input.from)} → ${holderName(state, content, input.to)}.`,
      display: {
        type: "item",
        fromName: holderName(state, content, input.from),
        toName: holderName(state, content, input.to),
        itemName: item.name,
        quantity: input.quantity,
      },
    };
  },
});

const npcPresence = defineTool({
  name: "npc_presence",
  description:
    "이름 있는 인물(NPC)이 플레이어와 같은 장면에 들어오거나(enter) 떠날 때(leave) 알린다. " +
    "장면에 있는 인물만 대화하고 물건을 주고받을 수 있으며, 들어온 인물의 성격·말투·아는 것이 다음 상태에 나타난다. " +
    "엑스트라(ex_N)도 다시 등장시키거나 내보낼 수 있다. 처음 엮이는 이름 없는 인물은 spawn_extra로 만든다. 목록에 없는 이름 있는 인물을 지어내지 않는다.",
  schema: z.strictObject({
    npc_id: z.string().describe("인물 id (상태의 '알고 있는 인물'이나 '함께 있는 인물'에 표시된 것)"),
    action: z.enum(["enter", "leave"]),
  }),
  run(input, ctx) {
    const { store, content } = ctx;
    const state = store.getState();
    const npc = content.npcs[input.npc_id];
    const character = state.characters[input.npc_id];
    // 엑스트라(이름 없이 만든 인물)도 나가고 들어올 수 있다. 사라진 엑스트라는 안 된다
    const extra = character?.extra ?? null;
    if ((!npc && !extra) || !character || input.npc_id === state.playerId) {
      return { ok: false, error: `알 수 없는 인물: ${input.npc_id}. 이름 없는 인물이 엮이면 spawn_extra로 만든다.` };
    }
    // 이름을 모르는 인물은 호칭으로 (기획서 6.3)
    const name = playerCalls(state, content, character.id);
    const present = state.scene.present.includes(character.id);
    if (input.action === "enter") {
      if (present) return { ok: false, error: `${josa(name, "은/는")} 이미 장면에 있습니다.` };
      if (character.dead) return { ok: false, error: `${josa(name, "은/는")} 사망했습니다.` };
      if (character.away) return { ok: false, error: `${josa(name, "은/는")} 도시를 떠났습니다.` };
      enterScene(ctx, character.id);
    } else {
      if (!present) return { ok: false, error: `${josa(name, "은/는")} 장면에 없습니다.` };
      store.append({ type: "npc_left", npcId: character.id });
    }
    const look = npc ? `${npc.look} 말투: ${npc.voice.style}` : extra!.look;
    return {
      ok: true,
      resultText:
        input.action === "enter"
          ? `${josa(name, "이/가")} 장면에 들어왔다. 이 인물의 프로필은 다음 턴 상태에 나타난다. 지금은 외모와 말투만 반영해 서술하라: ${look}`
          : `${josa(name, "이/가")} 장면을 떠났다.`,
      display: { type: "presence", npcName: name, action: input.action },
    };
  },
});

const addBelief = defineTool({
  name: "add_belief",
  description:
    "플레이어 캐릭터가 장면에서 새로 알게 된 중요한 정보를 기억에 기록한다 (직접 본 것, 누군가에게 들은 것, 소문). " +
    "사소한 묘사는 기록하지 않는다. 캐릭터가 실제로 보거나 들은 것만 기록한다. 진위는 시스템이 판단하지 않는다.",
  schema: z.strictObject({
    fact: z.string().min(1).max(200).describe("캐릭터가 알게 된 내용 한두 문장. 누구에게 들었는지 포함"),
    source: beliefSourceSchema.describe("seen 직접 봄, report 누군가에게 직접 들음, rumor 출처가 불분명한 소문"),
  }),
  run(input, { store }) {
    const state = store.getState();
    const fact = input.fact.trim();
    if ((state.beliefs[state.playerId] ?? []).some((b) => b.fact === fact)) {
      return { ok: false, error: "이미 알고 있는 내용입니다." };
    }
    store.append({
      type: "belief_added",
      characterId: state.playerId,
      belief: {
        id: `b_${state.nextBeliefNo}`,
        fact,
        source: input.source,
        accuracy: "unknown",
        learnedAt: state.time,
      },
    });
    return {
      ok: true,
      resultText: `기억했다: ${fact}`,
      display: { type: "belief", fact, sourceLabel: BELIEF_SOURCE_LABELS[input.source] },
    };
  },
});

/** NPC가 판정 없이도 기꺼이 물건을 건네는 신뢰 (임시값) */
export const GIFT_TRUST = 2;

/** 턴 진행 tool (두 모드 공통). 실제 처리는 action.ts의 takeAction */
const createTakeActionTool = (s: Scenario) => ({
  name: "take_action",
  description:
    "플레이어 행동마다 한 번 호출하는 턴 진행의 입구. 판정(필요할 때만), 판정 전에 선언한 몸의 위험, 평판이 걸린 행적, 시간이 드는 활동을 " +
    "한 번에 넘기면 시스템이 판정 → 피해 → 행적·목격자 → 시간 경과(끼어들기 포함) 순서로 처리하고 결과를 돌려준다. " +
    "결과를 보기 전에 서술로 결과를 확정하지 않는다.",
  schema: createTakeActionSchema(s),
  run: (input: TakeActionInput, ctx: ToolContext): ToolOutcome => {
    const result = takeAction(input, ctx);
    if (!result.ok) return result;
    const [first, ...rest] = result.displays;
    return first
      ? { ok: true, resultText: result.resultText, display: first, extra: rest }
      : { ok: true, resultText: result.resultText, display: { type: "time", activityLabel: "잠깐의 행동", durationLabel: "", fromLabel: "", toLabel: "" }, silent: true };
  },
});

type AnyTool = { name: string; description: string; schema: z.ZodType; run: (input: never, ctx: ToolContext) => ToolOutcome };

const toolCache = new WeakMap<Scenario, readonly AnyTool[]>();

/** 시나리오에 맞춘 GM tool 목록 (같은 시나리오면 같은 목록을 돌려준다: 프롬프트 캐시 유지) */
export function gmTools(s: Scenario): readonly AnyTool[] {
  let tools = toolCache.get(s);
  if (!tools) {
    tools = [
      createTakeActionTool(s),
      transferItem,
      npcPresence,
      addBelief,
      createLearnSkillTool(s),
      ...MISSION_TOOLS,
      ...REPUTATION_TOOLS,
      ...STORYLET_TOOLS,
      ...SUCCESSION_TOOLS,
      ...EXTRA_TOOLS,
    ] as readonly AnyTool[];
    toolCache.set(s, tools);
  }
  return tools;
}

const specCache = new WeakMap<Scenario, ToolSpec[]>();

/** LLM에 넘길 tool 명세 (JSON Schema) */
export function gmToolSpecs(s: Scenario): ToolSpec[] {
  let specs = specCache.get(s);
  if (!specs) {
    specs = gmTools(s).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toToolJsonSchema(tool.schema),
    }));
    specCache.set(s, specs);
  }
  return specs;
}

/** tool 호출을 검증하고 실행한다. 입력이 스키마에 맞지 않으면 실행하지 않는다 */
export function executeTool(name: string, input: unknown, ctx: ToolContext): ToolOutcome {
  const tool = gmTools(ctx.content.scenario).find((t) => t.name === name);
  if (!tool) return { ok: false, error: `알 수 없는 tool: ${name}` };
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: `입력이 올바르지 않습니다: ${z.prettifyError(parsed.error)}` };
  }
  // 각 tool의 run은 자기 스키마로 파싱된 입력만 받는다
  return (tool.run as (input: unknown, ctx: ToolContext) => ToolOutcome)(parsed.data, ctx);
}


/**
 * zod 스키마를 strict tool용 JSON Schema로 바꾼다.
 * 숫자 범위 같은 제약은 strict 모드가 지원하지 않을 수 있어 지우고, 검증은 zod가 한다.
 */
function toToolJsonSchema(schema: z.ZodType): ToolSpec["inputSchema"] {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  return stripKeys(json, STRICT_UNSUPPORTED_KEYS) as ToolSpec["inputSchema"];
}

function stripKeys(value: unknown, keys: string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => stripKeys(v, keys));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !keys.includes(k))
        .map(([k, v]) => [k, stripKeys(v, keys)]),
    );
  }
  return value;
}

function holderName(state: GameState, content: Content, holder: string): string {
  if (holder === SCENE_HOLDER) return "장면";
  return playerCalls(state, content, holder);
}


export type { GameEvent };
