import { z } from "zod";
import {
  CHECK_OUTCOME_LABELS,
  DIFFICULTY_LABELS,
  DIFFICULTY_MODIFIER,
  difficultySchema,
  roll2d6,
  type CheckOutcome,
} from "../rules/check.ts";
import {
  HARM_LABELS,
  harmSeveritySchema,
  INJURY_LABELS,
  INJURY_PENALTY,
  worsenInjury,
  type InjuryLevel,
} from "../rules/injury.ts";
import { MOVE_LABELS, MOVE_STATS, moveSchema } from "../rules/moves.ts";
import { STAT_LABELS, statSchema } from "../rules/stats.ts";
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
import { fastForward } from "../sim/fastForward.ts";
import { BELIEF_SOURCE_LABELS, beliefSourceSchema } from "../game/belief.ts";
import { findHolderInventory, SCENE_HOLDER, type GameEvent, type GameState } from "../game/state.ts";
import type { ToolSpec } from "./model.ts";
import { defineTool, signed, STRICT_UNSUPPORTED_KEYS, type ToolContext, type ToolOutcome } from "./toolkit.ts";

export { STRICT_UNSUPPORTED_KEYS } from "./toolkit.ts";
import { MISSION_TOOLS } from "./missionTools.ts";
import { REPUTATION_TOOLS } from "./reputationTools.ts";
import { rollPlayerCheck } from "./checks.ts";

export type { ToolContext, ToolDisplayEvent, ToolOutcome } from "./toolkit.ts";

const OUTCOME_GUIDE: Record<CheckOutcome, string> = {
  success: "의도한 대로 이루어진다. 깔끔하게 성공한 장면을 서술하라.",
  partial:
    "이루어지지만 대가가 따른다. 피해, 시간·자원 손실, 상황의 복잡화, 어려운 선택 중 하나를 붙여 서술하라. 대가가 몸을 다치는 것이라면 apply_harm을 호출하라.",
  miss: "실패한다. 상황이 악화된다. 몸을 다친다면 apply_harm을 호출하고, 아니면 새로운 위협이나 손실을 서술하라.",
};

const requestCheck = defineTool({
  name: "request_check",
  description:
    "플레이어 캐릭터가 결과가 불확실하고 실패하면 대가가 있는 행동을 시도할 때 2d6 판정을 요청한다. " +
    "사소하거나 확실한 행동에는 쓰지 않는다. 판정 결과는 시스템이 정하며, 그 결과에 맞춰 서술해야 한다. " +
    "행동별 능력치: fight=strength|agility, search=sense, sense_danger=sense, stealth=agility, endure=cool, persuade=persuasion.",
  schema: z.strictObject({
    move: moveSchema.describe(
      "기본 행동. fight 싸우기, search 수색하기, sense_danger 위험 감지, stealth 은밀 행동, endure 버티기(압박·공포·고통), persuade 설득·압박",
    ),
    stat: statSchema.describe("사용할 능력치. 행동에 허용된 것만 고를 수 있다"),
    difficulty: difficultySchema.describe("상황의 난이도. 대부분은 normal"),
    intent: z.string().min(1).max(200).describe("캐릭터가 이루려는 것 한 문장 (예: 잠긴 사물함을 비틀어 연다)"),
  }),
  run(input, ctx) {
    const result = rollPlayerCheck(input, ctx);
    if (!result.ok) return result;
    return {
      ok: true,
      resultText:
        `판정 ${result.checkId}: ${CHECK_OUTCOME_LABELS[result.outcome]} (${result.outcome}). ` +
        `주사위 ${result.dice[0]}+${result.dice[1]}, 보정 ${signed(result.modifier)}, 합계 ${result.total}.\n` +
        OUTCOME_GUIDE[result.outcome],
      display: result.display,
    };
  },
});

/** 대가 있는 성공은 최대 1단계, 실패는 강도에 따라 1~2단계 악화 (임시값) */
export function harmSteps(outcome: CheckOutcome, severity: "light" | "heavy"): number {
  if (outcome === "partial") return 1;
  return severity === "heavy" ? 2 : 1;
}

const applyHarm = defineTool({
  name: "apply_harm",
  description:
    "이번 턴의 판정이 실패(miss)했거나 대가 있는 성공(partial)의 대가로 캐릭터가 몸을 다쳤을 때 부상을 적용한다. " +
    "반드시 그 원인이 된 판정의 check_id를 넘긴다. 판정 하나에 한 번만 쓸 수 있다. 부상이 얼마나 악화될지는 시스템이 정한다.",
  schema: z.strictObject({
    target: z.string().describe("다친 캐릭터 id. 판정을 한 캐릭터여야 한다"),
    check_id: z.string().describe("원인이 된 이번 턴 판정의 id (예: chk_3)"),
    severity: harmSeveritySchema.describe("light: 베이거나 맞음, heavy: 총상·깊은 자상·추락 등"),
    cause: z.string().min(1).max(200).describe("부상 원인 한 문장"),
  }),
  run(input, { store }) {
    const state = store.getState();
    const target = state.characters[input.target];
    if (!target) return { ok: false, error: `알 수 없는 캐릭터: ${input.target}` };
    const check = state.checks[input.check_id];
    if (!check) return { ok: false, error: `알 수 없는 판정: ${input.check_id}` };
    if (check.turn !== state.turn) return { ok: false, error: "이번 턴의 판정만 피해의 근거가 될 수 있습니다." };
    if (check.actorId !== target.id) return { ok: false, error: "판정을 한 캐릭터에게만 피해를 줄 수 있습니다." };
    if (check.outcome === "success") return { ok: false, error: "성공한 판정으로는 피해를 줄 수 없습니다." };
    if (check.harmApplied) return { ok: false, error: "이 판정의 피해는 이미 적용되었습니다." };
    if (target.injury === "dead") return { ok: false, error: "이미 사망한 캐릭터입니다." };

    const steps = harmSteps(check.outcome, input.severity);
    const to = worsenInjury(target.injury, steps);
    store.append({
      type: "harm_applied",
      targetId: target.id,
      checkId: check.checkId,
      severity: input.severity,
      steps,
      from: target.injury,
      to,
      cause: input.cause,
    });

    const deathNote =
      to === "dead"
        ? " 캐릭터가 사망했다. 죽음의 순간을 담담하게 서술하고 장면을 끝내라. 더 이상 행동을 제시하지 마라."
        : ` 앞으로 판정에 ${signed(INJURY_PENALTY[to])} 보정을 받는다. 부상의 감각을 서술에 반영하라.`;
    return {
      ok: true,
      resultText: `${target.name}의 부상: ${INJURY_LABELS[target.injury]} → ${INJURY_LABELS[to]}.${deathNote}`,
      display: {
        type: "harm",
        targetName: target.name,
        severityLabel: HARM_LABELS[input.severity],
        from: target.injury,
        to,
        fromLabel: INJURY_LABELS[target.injury],
        toLabel: INJURY_LABELS[to],
        cause: input.cause,
      },
    };
  },
});

const transferItem = defineTool({
  name: "transfer_item",
  description:
    "아이템을 옮긴다: 건네기, 내려놓기(to=scene), 장면에 놓인 것을 줍기(from=scene). " +
    "보관 위치는 플레이어, 장면에 있는 NPC의 id, 또는 scene. 없는 아이템이나 가진 것보다 많은 수량은 옮길 수 없다. 새 아이템을 만들어 내는 데는 쓸 수 없다.",
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
      if (!reachable) return { ok: false, error: `${holder}은(는) 지금 장면에 없습니다. 먼저 npc_presence로 등장시키세요.` };
    }
    const fromInv = findHolderInventory(state, input.from);
    if (!fromInv) return { ok: false, error: `알 수 없는 보관 위치: ${input.from}` };
    if (!findHolderInventory(state, input.to)) return { ok: false, error: `알 수 없는 보관 위치: ${input.to}` };
    const item = content.items[input.item_id];
    if (!item) return { ok: false, error: `알 수 없는 아이템: ${input.item_id}` };
    const have = fromInv[input.item_id] ?? 0;
    if (have < input.quantity) {
      return { ok: false, error: `${holderName(state, input.from)}에게 ${item.name}이(가) ${have}개뿐입니다.` };
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
      resultText: `${item.name} ${input.quantity}개: ${holderName(state, input.from)} → ${holderName(state, input.to)}.`,
      display: {
        type: "item",
        fromName: holderName(state, input.from),
        toName: holderName(state, input.to),
        itemName: item.name,
        quantity: input.quantity,
      },
    };
  },
});

const spendTime = defineTool({
  name: "spend_time",
  description:
    "캐릭터의 활동으로 게임 시간을 흘려보낸다. 한 턴의 주된 활동마다 한 번 호출한다 (호출하지 않으면 잠깐의 행동으로 본다). " +
    "걸리는 시간은 시스템이 정한다. guard_duty, sleep, wait는 빨리감기로 진행되며 도중에 무슨 일이 생기면 멈춘다. " +
    "until은 sleep과 wait에서만 쓸 수 있다 (그 시간대가 시작될 때까지). 다른 활동은 until에 null을 넣는다.",
  schema: z.strictObject({
    activity: activitySchema.describe(
      "brief 잠깐의 행동(둘러보기·몇 마디), talk 대화, eat 식사, treat 응급처치, search 수색, work 작업·정비, rest 휴식, guard_duty 보초, sleep 잠, wait 기다림",
    ),
    until: timeSegmentSchema
      .nullable()
      .describe("sleep·wait 전용. dawn 새벽, morning 아침, day 낮, evening 저녁, night 밤이 시작될 때까지"),
  }),
  run(input, { store, rng }) {
    const state = store.getState();
    if (state.characters[state.playerId]?.injury === "dead") {
      return { ok: false, error: "사망한 캐릭터의 시간은 흐르지 않습니다." };
    }
    const cost = ACTIVITY_COSTS[input.activity];
    const from = state.time;
    let to: number;
    let interrupt: ReturnType<typeof fastForward>["interrupt"] = null;

    if (cost.kind === "long") {
      if (input.until && !cost.allowUntil) {
        return { ok: false, error: `${input.activity}에는 until을 쓸 수 없습니다. null을 넣으세요.` };
      }
      const target = input.until ? nextSegmentStart(from, input.until) : from + cost.minutes;
      const result = fastForward({ state, start: from, until: Math.min(target, from + MAX_FAST_FORWARD_MINUTES), rng });
      to = result.end;
      interrupt = result.interrupt;
    } else {
      if (input.until) return { ok: false, error: `${input.activity}에는 until을 쓸 수 없습니다. null을 넣으세요.` };
      to = from + rollActivityMinutes(cost, rng);
    }

    store.append({
      type: "time_advanced",
      activity: input.activity,
      from,
      to,
      ...(interrupt ? { interrupt } : {}),
    });

    const label = ACTIVITY_LABELS[input.activity];
    const lines = [`${label}: ${formatDuration(to - from)} 경과. 현재 ${formatTime(to)}.`];
    if (segmentOf(from) !== segmentOf(to)) {
      lines.push(`시간대가 ${SEGMENT_LABELS[segmentOf(from)]}에서 ${SEGMENT_LABELS[segmentOf(to)]}(으)로 바뀌었다. 빛과 소리의 변화를 서술에 반영하라.`);
    }
    if (interrupt) {
      lines.push(
        `${label}이(가) 중간에 끊겼다: ${interrupt.detail}. 정체는 아직 모른다. ` +
          "캐릭터가 이를 알아차리는 장면으로 서술하고, 정체를 확정하지 말고 플레이어의 반응을 기다려라.",
      );
    }
    return {
      ok: true,
      resultText: lines.join("\n"),
      display: {
        type: "time",
        activityLabel: label,
        durationLabel: formatDuration(to - from),
        fromLabel: formatTime(from),
        toLabel: formatTime(to),
        ...(interrupt ? { interruptDetail: interrupt.detail } : {}),
      },
    };
  },
});

const npcPresence = defineTool({
  name: "npc_presence",
  description:
    "이름 있는 인물(NPC)이 플레이어와 같은 장면에 들어오거나(enter) 떠날 때(leave) 알린다. " +
    "장면에 있는 인물만 대화하고 물건을 주고받을 수 있으며, 들어온 인물의 성격·말투·아는 것이 다음 상태에 나타난다. " +
    "이름 없는 엑스트라(지나가는 보초 등)에는 쓰지 않는다. 목록에 없는 이름 있는 인물을 지어내지 않는다.",
  schema: z.strictObject({
    npc_id: z.string().describe("인물 id (상태의 '알고 있는 인물'이나 '함께 있는 인물'에 표시된 것)"),
    action: z.enum(["enter", "leave"]),
  }),
  run(input, { store, content }) {
    const state = store.getState();
    const npc = content.npcs[input.npc_id];
    const character = state.characters[input.npc_id];
    if (!npc || !character || input.npc_id === state.playerId) {
      return { ok: false, error: `알 수 없는 인물: ${input.npc_id}. 이름 없는 인물은 서술로만 다룬다.` };
    }
    const present = state.scene.present.includes(npc.id);
    if (input.action === "enter") {
      if (present) return { ok: false, error: `${npc.name}은(는) 이미 장면에 있습니다.` };
      if (character.injury === "dead") return { ok: false, error: `${npc.name}은(는) 사망했습니다.` };
      store.append({ type: "npc_entered", npcId: npc.id });
    } else {
      if (!present) return { ok: false, error: `${npc.name}은(는) 장면에 없습니다.` };
      store.append({ type: "npc_left", npcId: npc.id });
    }
    return {
      ok: true,
      resultText:
        input.action === "enter"
          ? `${npc.name}이(가) 장면에 들어왔다. 이 인물의 프로필은 다음 턴 상태에 나타난다. 지금은 외모와 말투만 반영해 서술하라: ${npc.look} 말투: ${npc.voice.style}`
          : `${npc.name}이(가) 장면을 떠났다.`,
      display: { type: "presence", npcName: npc.name, action: input.action },
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

const TOOLS = [requestCheck, applyHarm, transferItem, spendTime, npcPresence, addBelief, ...MISSION_TOOLS, ...REPUTATION_TOOLS] as const;

/** LLM에 넘길 tool 명세 (JSON Schema) */
export const GM_TOOL_SPECS: ToolSpec[] = TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: toToolJsonSchema(tool.schema),
}));

/** tool 호출을 검증하고 실행한다. 입력이 스키마에 맞지 않으면 실행하지 않는다 */
export function executeTool(name: string, input: unknown, ctx: ToolContext): ToolOutcome {
  const tool = TOOLS.find((t) => t.name === name);
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

function holderName(state: GameState, holder: string): string {
  if (holder === SCENE_HOLDER) return "장면";
  return state.characters[holder]?.name ?? holder;
}


export type { GameEvent };
