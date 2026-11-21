import { heldOf } from "../rules/held.ts";
import { npcZoneAt } from "../game/whereabouts.ts";
import { marketValue } from "./market.ts";
import { RESOLVE_TOOLS } from "./resolve.ts";
import { EXPLORATION_TOOLS } from "./exploration.ts";
import { incapacitatingSymptom } from "../scenario/scenario.ts";
import { DIPLOMACY_TOOLS } from "./diplomacy.ts";
import { fearAfterTool, watchFear, type FearResult } from "./fear.ts";
import { takeReactionChecks } from "./checks.ts";
import { ROMANCE_TOOLS } from "./romance.ts";
import { CAPTIVITY_TOOLS } from "./captivity.ts";
import { carriedWeight, carryCapacity, DEFAULT_WEIGHT, GEAR_TOOLS } from "./gear.ts";
import { PEOPLE_TOOLS } from "./people.ts";
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
import { defineTool, signed, STRICT_UNSUPPORTED_KEYS, type ToolContext, type ToolDisplayEvent, type ToolOutcome, type ToolSpec } from "./toolkit.ts";

export { STRICT_UNSUPPORTED_KEYS } from "./toolkit.ts";
import { MISSION_TOOLS } from "./missionTools.ts";
import { COMMAND_TOOLS } from "./command.ts";
import { COMPANION_TOOLS, isAwayCompanion } from "./companionTools.ts";
import { REPUTATION_TOOLS } from "./reputationTools.ts";
import { STORYLET_TOOLS, storyTitle } from "./storyletTools.ts";
import { SUCCESSION_TOOLS } from "./succession.ts";
import { createLearnSkillTool } from "./growth.ts";
import { bodyLines, createTakeActionSchema, takeAction, worldLines, type TakeActionInput } from "./action.ts";
import { afterTimeCaughtUp, runAfterTimeAdvance } from "./turnStart.ts";
import { stashHint, stashTool } from "./stash.ts";
import { LEVERAGE_TOOLS } from "./leverage.ts";
import { keepByGift, PROMISE_TOOLS } from "./promises.ts";
import { PROMOTION_TOOLS } from "./promotion.ts";
import { INFILTRATION_TOOLS } from "./infiltration.ts";
import { leaveRemainsForNewDeaths, livingIds, remainsHere } from "./remains.ts";

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
    deposit: z
      .string()
      .max(60)
      .nullable()
      .optional()
      .describe("주인공이 물건을 남에게 맡기는 것이면 맡긴 조건 (예: \"나갈 때 돌려준다\"). 검문에서 무기를 받아 가는 것도 맡김이다: 땅에 내려놓기(to=scene)가 아니라 받아 간 사람에게 이것과 함께 넘긴다. 맡긴 물건은 근거 없이 돌려받는다"),
    repay: z
      .boolean()
      .optional()
      .describe("플레이어가 빚을 갚으려고 건네는 것이면 true: 받는 사람의 무리에 진 빚이 물건 값만큼 준다. 없으면 선물이다 (빚은 그대로)"),
  }),
  run(input, ctx) {
    const { store, content } = ctx;
    const state = store.getState();
    if (input.from === input.to) return { ok: false, error: "보내는 쪽과 받는 쪽이 같습니다." };
    for (const holder of [input.from, input.to]) {
      // 이 구역의 묻히지 않은 유해도 뒤질 수 있다 (12-130)
      const reachable = holder === SCENE_HOLDER || holder === state.playerId || state.scene.present.includes(holder) || remainsHere(state).some((r) => r.holder === holder);
      if (!reachable) return { ok: false, error: `${josa(holderName(state, content, holder), "은/는")} 지금 장면에 없습니다. 먼저 npc_presence로 등장시키세요.` };
    }
    // 진행 중인 이야기의 배역에게, 그 이야기 선택지가 내놓게 하는 물건을 먼저 건네면 선택지가 잠긴다 (플레이 테스트 11: 담요를 덮어 준 뒤 "고를 수 없는 선택지")
    const story = state.activeStorylet;
    if (story && input.from === state.playerId && Object.values(story.cast).includes(input.to)) {
      const choice = content.storylets[story.id]?.choices.find((c) => choiceUsesItem(c, input.item_id));
      if (choice) return { ok: false, error: `이 물건은 진행 중인 이야기의 선택지로 건넨다: resolve_storylet ${choice.id} ("${choice.label}"). 선택지가 효과를 함께 처리한다.` };
    }
    const fromInv = findHolderInventory(state, input.from);
    if (!fromInv) return { ok: false, error: `알 수 없는 보관 위치: ${input.from}` };
    if (!findHolderInventory(state, input.to)) return { ok: false, error: `알 수 없는 보관 위치: ${input.to}` };
    // NPC의 물건은 근거 없이 가져올 수 없다 (원칙 2: AI는 요청만 하고 코드가 검증)
    const fromNpc = input.from !== SCENE_HOLDER && input.from !== state.playerId;
    // 맡긴 물건은 돌려받을 근거가 있다 (12-196)
    const deposited = (state.entrusted ?? []).some((d) => d.holder === input.from && d.owner === input.to && d.itemId === input.item_id);
    if (fromNpc && !deposited) {
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

    // 너무 무거우면 더 받지 못한다 (기획서 4.8)
    if (input.to === state.playerId && content.scenario.gear) {
      const me = state.characters[state.playerId]!;
      const after = carriedWeight(content, me) + (item.weight ?? DEFAULT_WEIGHT) * input.quantity;
      if (after > carryCapacity(content, me, state) * content.scenario.gear.carry.hard_limit) {
        return { ok: false, error: `${item.name}까지 들면 너무 무겁다 (${after.toFixed(1)}kg). 먼저 무언가를 내려놓는다.` };
      }
    }
    store.append({
      type: "item_transferred",
      from: input.from,
      to: input.to,
      itemId: item.id,
      quantity: input.quantity,
      ...(input.deposit && input.from === state.playerId && input.to !== SCENE_HOLDER ? { deposit: input.deposit } : {}),
    });
    // 약속한 물건을 그 사람에게 건넸으면 약속을 지킨 것이다 (12-174 부탁)
    const kept = input.from === state.playerId ? keepByGift(ctx, input.to, item.id, input.quantity) : [];
    // 빚진 무리 사람에게 갚는다고 건네면 그 값만큼 빚이 준다 (플레이 테스트 11, F6: 고철을 건네도 빚이 그대로였다).
    // 갚는다고 하지 않으면 선물이다 (12-237, 플레이 테스트 13: 건네기만 해도 빚이 줄어 이틀에 끝났다). 맡긴 것은 갚은 것이 아니다
    if (input.repay && input.from === state.playerId && !input.deposit && input.to !== SCENE_HOLDER) {
      const lender = state.characters[input.to]?.factionId;
      const owed = lender ? (state.characters[state.playerId]?.debts[lender] ?? 0) : 0;
      if (lender && owed > 0) {
        // 물건으로 갚으면 시세의 75%로 쳐준다 (플레이 테스트 13: 시작 소지품만으로 사흘 만에 빚이 끝났다)
        const worth = marketValue(content, state, { [item.id]: input.quantity });
        const paid = Math.min(owed, worth > 0 ? Math.max(1, Math.floor(worth * DEBT_ITEM_RATE)) : 0);
        if (paid > 0) {
          store.append({ type: "debt_changed", characterId: state.playerId, factionId: lender, delta: -paid });
          kept.push(`물건 값으로 빚을 갚았다: ${paid} 줄어 ${owed - paid} 남았다.`);
        }
      }
    }
    return {
      ok: true,
      resultText: [`${item.name} ${input.quantity}개: ${holderName(state, content, input.from)} → ${holderName(state, content, input.to)}.`, ...kept].join("\n"),
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

/** 빚을 물건으로 갚을 때 시세에서 쳐주는 몫 */
const DEBT_ITEM_RATE = 0.75;

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
      if (isAwayCompanion(state, character.id)) {
        return { ok: false, error: `${josa(name, "은/는")} 동행에서 잠시 떨어져 있다 (상태의 '떨어져 있는 동행'). 기다리는 곳에 가거나 돌아올 때까지 장면에 들이지 않는다.` };
      }
      if (state.squadOrders?.[character.id]) {
        return { ok: false, error: `${josa(name, "은/는")} 분대 명령으로 나가 있다 (${formatTime(state.squadOrders[character.id]!.until)}쯤 끝난다).` };
      }
      if (heldOf(character) && heldOf(character)!.zone !== state.playerZone) {
        return { ok: false, error: `${josa(name, "은/는")} 지금 장면에 들일 수 없다 (캐릭터는 이 사람의 행방을 모른다).` };
      }
      enterScene(ctx, character.id);
    } else {
      if (!present) return { ok: false, error: `${josa(name, "은/는")} 장면에 없습니다.` };
      store.append({ type: "npc_left", npcId: character.id });
    }
    const look = npc ? `${npc.look} 말투: ${npc.voice.style}` : extra!.look;
    // 보통 다른 구역에 있는 사람이면 알린다 (플레이 테스트 13: 거점의 상관이 강변 장면에 들어왔다). 동행·이야기 배역·갇힌 사람은 빼고
    const s1 = store.getState();
    const home = npc && input.action === "enter" ? npcZoneAt(npc, s1.time) : undefined;
    const away = !!home && home !== s1.playerZone && !s1.companions.includes(character.id) && !heldOf(character) && !Object.values(s1.activeStorylet?.cast ?? {}).includes(character.id);
    const where = away ? ` 이 사람은 보통 지금 ${content.locations[home!]?.name ?? home}에 있다: 여기 와 있는 까닭을 서술하라 (상관이 장면에 들어온 것이 아니라 주인공이 찾아갔다면 그 구역으로 옮겨 가야 한다).` : "";
    return {
      ok: true,
      resultText:
        input.action === "enter"
          ? `${josa(name, "이/가")} 장면에 들어왔다. 이 인물의 프로필은 다음 턴 상태에 나타난다. 지금은 외모와 말투만 반영해 서술하라: ${look}${where}`
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
      stashTool,
      npcPresence,
      addBelief,
      createLearnSkillTool(s),
      ...MISSION_TOOLS,
      ...COMMAND_TOOLS,
      ...DIPLOMACY_TOOLS,
      ...COMPANION_TOOLS,
      ...PEOPLE_TOOLS,
      ...GEAR_TOOLS,
      ...REPUTATION_TOOLS,
      ...LEVERAGE_TOOLS,
      ...PROMISE_TOOLS,
      ...PROMOTION_TOOLS,
      ...RESOLVE_TOOLS,
      ...INFILTRATION_TOOLS,
      ...EXPLORATION_TOOLS,
      ...STORYLET_TOOLS,
      ...SUCCESSION_TOOLS,
      ...EXTRA_TOOLS,
      ...CAPTIVITY_TOOLS,
      ...ROMANCE_TOOLS,
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
/** 의식불명 등 스스로 아무것도 못 하는 동안에도 쓰는 tool: 시간 흐르기·돌봄(take_action이 가린다), 누가 오고 가는 것, 묘비명, 설정 */
const WHILE_INCAPACITATED = new Set(["take_action", "npc_presence", "spawn_extra", "write_epitaph", "set_content_options"]);

export function executeTool(name: string, input: unknown, ctx: ToolContext): ToolOutcome {
  const tool = gmTools(ctx.content.scenario).find((t) => t.name === name);
  if (!tool) return { ok: false, error: `알 수 없는 tool: ${name}` };
  // 의식불명 등 스스로 아무것도 못 하는 동안은 플레이어의 행동이 되는 tool을 막는다 (시간 흐르기·돌봄은 take_action, 장면 정리 일부만)
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  const out = me && !me.dead ? incapacitatingSymptom(ctx.content.scenario, me) : undefined;
  if (out && !WHILE_INCAPACITATED.has(name)) {
    return { ok: false, error: `${josa(me!.name, "은/는")} ${out.label} 상태라 이 일을 할 수 없다 (${name}). 이야기와 대화는 깨어난 뒤에. take_action의 activity(wait 또는 sleep)로 시간만 흐르게 한다.` };
  }
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: `입력이 올바르지 않습니다: ${z.prettifyError(parsed.error)}` };
  }
  // 각 tool의 run은 자기 스키마로 파싱된 입력만 받는다
  const before = watchFear(state);
  const living = livingIds(state);
  takeReactionChecks(ctx.store);
  let outcome = (tool.run as (input: unknown, ctx: ToolContext) => ToolOutcome)(parsed.data, ctx);
  // 시간을 쓴 도구는 끝에 "시간이 흐른 뒤" 처리를 한 번 거친다 (12-240, A11). 이미 돌았으면 다시 돌리지 않는다
  if (ctx.store.getState().time > state.time && !afterTimeCaughtUp(ctx)) {
    const after = runAfterTimeAdvance(ctx);
    if (outcome.ok && after.length) {
      const lines = [...bodyLines(after), ...worldLines(after)];
      outcome = { ...outcome, resultText: [outcome.resultText, ...lines].filter(Boolean).join("\n"), extra: [...(outcome.extra ?? []), ...after] };
    }
  }
  // 이번에 죽은 사람은 그 자리에 유해를 남긴다 (12-130)
  leaveRemainsForNewDeaths(ctx, living);
  // 짐이 한도를 넘으면 창고를 한 번 알린다 (12-149)
  const hint = outcome.ok ? [stashHint(ctx), storyStillOpen(state, name, ctx)].filter(Boolean).join("\n") : null;
  const hinted = hint && outcome.ok ? { ...outcome, resultText: [outcome.resultText, hint].filter(Boolean).join("\n") } : outcome;
  return withCheckLines(withFear(hinted, fearAfterTool(ctx, before)), takeReactionChecks(ctx.store));
}

/** 이야기가 열린 채로 다른 일을 마무리하는 tool을 쓰면 알린다 (플레이 테스트 11, 막지는 않는다) */
const STORY_SIDE_TOOLS = new Set(["report_mission", "assign_mission", "abandon_mission", "barter", "learn_skill", "squad_order"]);
function storyStillOpen(before: GameState, name: string, ctx: ToolContext): string | null {
  const active = ctx.store.getState().activeStorylet;
  if (!STORY_SIDE_TOOLS.has(name) || !active || before.activeStorylet?.id !== active.id) return null;
  const storylet = ctx.content.storylets[active.id];
  return storylet ? `(진행 중인 이야기 「${storyTitle(ctx.store.getState(), ctx.content, storylet)}」가 아직 열려 있다. 그 장면을 resolve_storylet으로 매듭짓거나 떠나는 서술을 잊지 않는다)` : null;
}

/** 이 tool로 무서운 것이 나타났으면(인물·이야기·전투) 공포가 오른 결과를 붙인다 (12-95) */
function withFear(outcome: ToolOutcome, fear: FearResult): ToolOutcome {
  if (!outcome.ok || !fear.lines.length) return outcome;
  return { ...outcome, resultText: [outcome.resultText, ...fear.lines].filter(Boolean).join("\n"), extra: [...(outcome.extra ?? []), ...fear.displays] };
}

/** 이번 tool에서 굴린 판정의 한 줄(🎲)을 결과 끝에 붙인다. GM은 이 줄을 고치지 않고 서술 끝에 옮겨 적는다 */
/** reactions: 어디서든 굴린 버티는 판정 (마음 다잡기, 12-220). 결과에 없는 것만 붙인다 */
function withCheckLines(outcome: ToolOutcome, reactions: ToolDisplayEvent[] = []): ToolOutcome {
  if (!outcome.ok) return outcome;
  const shown = new Set([outcome.display, ...(outcome.extra ?? [])].flatMap((d) => (d?.type === "check" ? [d.checkId] : [])));
  const missing = reactions.filter((d) => d.type === "check" && !shown.has(d.checkId));
  if (missing.length) outcome = { ...outcome, extra: [...(outcome.extra ?? []), ...missing] };
  const lines = [outcome.display, ...(outcome.extra ?? [])].flatMap((d) => (d?.type === "check" && d.line ? [d.line] : []));
  if (!lines.length) return outcome;
  return { ...outcome, resultText: [outcome.resultText, `판정 줄 (서술 끝에 그대로 옮겨 적는다):`, ...lines.map((l) => `\`${l}\``)].filter(Boolean).join("\n") };
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

/** 선택지가 이 물건을 내놓게 하거나(take_item) 지녔는지 묻는지 */
function choiceUsesItem(choice: { when?: { has_items?: string[]; has_items_any?: string[] }; effects?: unknown[]; outcomes?: Record<string, unknown[] | undefined> }, item: string): boolean {
  if (choice.when?.has_items?.includes(item) || choice.when?.has_items_any?.includes(item)) return true;
  const effects = [...(choice.effects ?? []), ...Object.values(choice.outcomes ?? {}).flatMap((e) => e ?? [])];
  return effects.some((e) => typeof e === "object" && e !== null && "take_item" in e && (e as { take_item: { item: string } }).take_item.item === item);
}
