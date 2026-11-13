import { runRoadEvent } from "./storyletTools.ts";
import { shakeNerves } from "./body.ts";
import { afterAttack, applyCraft, armorAbsorb, armorBlocksInfection, carriedWeight, encumbrance, planAttack, planCraft } from "./gear.ts";
import { scavenge } from "./scavenge.ts";
import { josa, sentence } from "../text.ts";
import { playerCalls } from "../game/acquaintance.ts";
import { changeCondition, isIncapacitated } from "./body.ts";
import { z } from "zod";
import { CHECK_OUTCOME_LABELS, difficultySchema, type CheckOutcome } from "../rules/check.ts";
import { HARM_LABELS, type HarmSeverity } from "../rules/harm.ts";
import {
  ACTIVITY_COSTS,
  ACTIVITY_LABELS,
  activitySchema,
  formatDuration,
  formatTime,
  MAX_FAST_FORWARD_MINUTES,
  MIN_TURN_MINUTES,
  nextSegmentStart,
  rollActivityMinutes,
  SEGMENT_LABELS,
  segmentOf,
  timeSegmentSchema,
  type Activity,
  type TimeSegment,
} from "../rules/time.ts";
import { DEED_TAG_LABELS, deedTagSchema, privacySchema } from "../game/reputation.ts";
import { idEnum, type Scenario } from "../scenario/schema.ts";
import { conditionPenalty, harmTrack, levelOf, moveIds, statIds, worsen } from "../scenario/scenario.ts";
import { createInterruptChecks, fastForward } from "../sim/fastForward.ts";
import { rollPlayerCheck } from "./checks.ts";
import { recordDeed } from "./reputationTools.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";
import { SQUAD_REPORT_PREFIX } from "./command.ts";
import { activeMissionOf } from "../game/missions.ts";
import { neighbors } from "../sim/war.ts";
import { endBattle, playBattleRound, validateBattleAction } from "./battleTools.ts";
import { createStoryletCheck, endActiveStorylet } from "./storyletTools.ts";
import { recordDeath } from "./succession.ts";
import { applyTreatment, maybeInfect, useItem } from "./body.ts";
import { dayOf, MINUTES_PER_DAY } from "../rules/time.ts";
import { DEATH_GUIDE, signed, type ToolContext, type ToolDisplayEvent } from "./toolkit.ts";

/**
 * 턴 진행의 유일한 입구 (기획서 11.6 take_action). 두 플레이 모드가 같은 함수를 쓴다.
 * 한 턴의 판정·피해·행적·시간을 한 번에 받아 코드가 정해진 순서로 처리한다.
 * 피해는 판정 전에 위험으로 선언하고, 결과가 나오면 코드가 적용한다 (AI가 결과를 보고 수위를 고르지 않는다).
 */

/** 대가 있는 성공은 최대 1단계, 실패는 선언한 위험에 따라 1~2단계 악화 (임시값) */
export function harmSteps(outcome: CheckOutcome, severity: HarmSeverity): number {
  if (outcome === "partial") return 1;
  return severity === "heavy" ? 2 : 1;
}

export function createTakeActionSchema(s: Scenario) {
  return z.strictObject({
    intent: z.string().min(1).max(300).describe("플레이어 캐릭터가 이번 턴에 하려는 것 한두 문장"),
    check: z
      .strictObject({
        move: idEnum(moveIds(s)).describe(
          `스킬. ${s.moves.map((m) => `${m.id} ${m.label}${m.description ? `(${m.description})` : ""}`).join(", ")}. ` +
            "지식 스킬 판정은 아는가/떠올리는가만 정한다. 사실은 검색 결과와 상태에서만 가져오고 지어내지 않는다",
        ),
        stat: idEnum(statIds(s)).describe(
          `능력. 스킬마다 쓸 수 있는 능력 중 상황에 맞는 하나: ${s.moves.map((m) => `${m.id}=${m.stats.join("|")}`).join(", ")}`,
        ),
        difficulty: difficultySchema.describe("상황의 난이도. 대부분은 normal. very_easy +2 / easy +1 / normal 0 / hard -1 / very_hard -2"),
        harm_on_failure: z
          .enum(["none", "light", "heavy"])
          .describe("판정 전에 선언하는 몸의 위험. 실패·대가 있는 성공이면 시스템이 적용한다. none은 몸을 다칠 위험이 없는 행동"),
        harm_cause: z.string().max(120).describe("다친다면 그 원인 한 문장 (위험이 none이면 빈 문자열)"),
        target_harm: z
          .enum(["none", "light", "heavy"])
          .default("none")
          .describe(
            "target(장면의 인물)을 다치게 하려는 공격이면 판정 전에 선언하는 상대의 피해. 성공이면 선언한 만큼, 대가 있는 성공이면 1단계, 실패면 없음. " +
              "상대가 중상 이상이면 무력화되어 소지품을 뒤질 수 있다. 공격이 아니면 none",
          ),
        infected_source: z
          .boolean()
          .default(false)
          .describe("그 위험이 감염체에게 물리거나 긁히는 것이면 true. 다치면 시스템이 감염 여부를 정한다 (캐릭터는 바로 알지 못한다)"),
      })
      .nullable()
      .describe("결과가 불확실하고 실패하면 대가가 있는 행동일 때만. 사소하거나 확실한 행동은 null"),
    activity: z
      .strictObject({
        kind: activitySchema.exclude(["travel", "combat"]).describe(
          "brief 잠깐의 행동, talk 대화, eat 식사, treat 응급처치, search 수색, work 작업·정비, rest 휴식, guard_duty 보초, sleep 잠, wait 기다림",
        ),
        until: timeSegmentSchema.nullable().describe("sleep·wait 전용: 이 시간대가 시작될 때까지. 다른 활동은 null"),
      })
      .nullable()
      .describe("이번 턴에 시간이 드는 주된 활동. null이면 잠깐의 행동(5분)"),
    deed: z
      .strictObject({
        summary: z.string().min(1).max(120).describe("플레이어가 한 행동 한 문장. 들켰는지 같은 결과는 쓰지 않는다"),
        tags: z.array(deedTagSchema).min(1).max(3).describe(
          `행동의 성격: ${Object.entries(DEED_TAG_LABELS)
            .map(([k, v]) => `${k} ${v}`)
            .join(", ")}`,
        ),
        severity: z.number().int().min(1).max(3).describe("1 사소함, 2 눈에 띔, 3 중대함"),
        privacy: privacySchema.describe("public 사람이 많은 곳, semi_private 한적한 곳, private 아무도 없을 만한 곳"),
        noisy: z.boolean().describe("총성·비명·큰 소리가 났는지"),
        condition: z.enum(["always", "on_success"]).describe("always: 시도만으로 평판이 걸린 일, on_success: 판정이 성공·대가 있는 성공일 때만 일어난 일"),
      })
      .nullable()
      .describe("남들이 알면 평판이 달라질 행동일 때만. 이미 기록된 행적은 다시 넣지 않는다"),
    target: z.string().nullable().describe("행동의 상대 인물 id (장면에 있어야 한다). 없으면 null"),
    move_to: z
      .string()
      .nullable()
      .default(null)
      .describe("이번 턴에 인접한 다른 구역으로 옮겨 가면 그 구역 id (상태의 인접 구역 목록). 이동에 30~60분이 든다. 전투 중에는 쓸 수 없다. 아니면 null"),
    prepare: z
      .string()
      .nullable()
      .default(null)
      .describe(
        `전투에 대비해 지금 구역(우리 땅)에 준비물을 설치하면 그 id. ${(s.battle?.preparations ?? []).map((p) => `${p.id} ${p.label}(${p.description})`).join(", ") || "없음"}. 판정(check)이 필요하고, 성공·대가 있는 성공이면 설치된다. 아니면 null`,
      ),
    use_item: z
      .string()
      .nullable()
      .default(null)
      .describe("몸 상태가 나아지는 물건을 쓰면 그 아이템 id (먹을 것, 구급상자, 약 등. 가진 것만). 효과는 시스템이 정한다. 아니면 null"),
    treatment: z
      .strictObject({
        item: z.string().nullable().describe("치료에 쓸 아이템 id (구급상자 등). 장면에 있는 치료사에게 받거나, 다른 사람을 아이템 없이 돌보면 null"),
        target: z
          .string()
          .nullable()
          .default(null)
          .describe("다른 사람을 치료하면 그 사람 id (장면에 있어야 한다. 아이템 없이는 의무병이나 응급처치를 익힌 사람만). 주인공 자신이면 null"),
      })
      .nullable()
      .default(null)
      .describe("장면의 치료사에게 치료받으면 {item: null} (하루 한 번). 아이템은 use_item을 쓴다. 얼마나 낫는지는 시스템이 정한다. 아니면 null"),
    craft: z
      .strictObject({
        recipe: z.string().nullable().describe(`만드는 것 (제작 법 id): ${(s.crafting?.recipes ?? []).map((r) => `${r.id} ${r.label}(${r.move})`).join(", ") || "없음"}. 아니면 null`),
        repair: z.string().nullable().describe("고치는 물건 (가진 아이템 id). 아니면 null"),
      })
      .nullable()
      .default(null)
      .describe("물건을 만들거나 고치면 (기획서 4.8). 판정(check: 그 제작 법·물건의 스킬)이 필요하고, 재료와 결과는 시스템이 정한다. 아니면 null"),
    battle: z
      .strictObject({
        effect: z.string().describe("상태의 '지금 쓸 수 있는 전투 효과' 중 하나의 id"),
        objective: z.string().nullable().describe("목표물을 노리는 효과면 남은 목표물 id, 아니면 null"),
      })
      .nullable()
      .default(null)
      .describe("전투 중일 때만: 이번 라운드에 하려는 전투 효과. 판정과 몸의 위험을 반드시 함께 선언한다. 전투가 아니면 null"),
    for_mission: z
      .boolean()
      .describe("수행 중인 임무를 위한 행동이면 true. true일 때만 판정과 활동이 임무 진행으로 집계된다 (임무 장소·목적과 맞는 행동만)"),
    narration_summary: z
      .string()
      .max(1000)
      .nullable()
      .describe("MCP 모드 전용: 직전 턴에 서술한 내용의 짧은 요약 (모드 전환 대비). 웹 앱 모드에서는 null (시스템이 자동 저장)"),
  });
}
export type TakeActionInput = z.infer<ReturnType<typeof createTakeActionSchema>>;
/** 도구 입력 형태 (기본값이 있는 필드는 생략할 수 있다) */
export type TakeActionArgs = z.input<ReturnType<typeof createTakeActionSchema>>;

export type TakeActionResult =
  | { ok: true; resultText: string; displays: ToolDisplayEvent[]; outcome: CheckOutcome | null; dead: boolean }
  | { ok: false; error: string };

const OUTCOME_GUIDE: Record<CheckOutcome, string> = {
  success: "의도한 대로 이루어진다. 깔끔하게 성공한 장면을 서술하라.",
  partial:
    "이루어지지만 대가가 따른다. 몸의 피해는 시스템이 이미 적용했다(있다면 아래). 그 밖의 대가(시간·자원 손실, 상황의 복잡화, 어려운 선택)를 하나 붙여 서술하라.",
  miss: "실패한다. 상황이 악화된다. 몸의 피해는 시스템이 이미 적용했다(있다면 아래). 새로운 위협이나 손실을 서술하라.",
};

export function takeAction(input: TakeActionInput, ctx: ToolContext): TakeActionResult {
  const { store, content } = ctx;
  const scenario = content.scenario;
  const start = store.getState();
  const player = start.characters[start.playerId];
  if (!player) return { ok: false, error: "플레이어 캐릭터가 없습니다." };
  if (player.dead) return { ok: false, error: "캐릭터가 사망했습니다." };
  if (input.target && !start.scene.present.includes(input.target)) {
    return { ok: false, error: `${josa(input.target, "은/는")} 지금 장면에 없습니다. 먼저 npc_presence로 등장시키세요.` };
  }
  if (input.activity) {
    const cost = ACTIVITY_COSTS[input.activity.kind];
    if (input.activity.until && !(cost.kind === "long" && cost.allowUntil)) {
      return { ok: false, error: `${input.activity.kind}에는 until을 쓸 수 없습니다. null을 넣으세요.` };
    }
  }

  // 전투·이동·준비 검사 (기획서 9.5)
  const inBattle = start.battle !== null;
  // 물건 (기획서 4.8): 공격은 손에 든 무기로, 탄약이 있어야 쏜다. 제작·수리는 재료와 판정. 너무 무거우면 옮겨 가지 못한다
  const gearRules = content.scenario.gear;
  const attacking = !!input.check && !!gearRules && ((!!input.target && input.check.target_harm !== "none") || (inBattle && gearRules.attack_moves.includes(input.check.move)));
  const attack = attacking ? planAttack(content, player, input.check!.move, input.check!.target_harm) : null;
  if (typeof attack === "string") return { ok: false, error: attack };
  if (input.craft) {
    if (!input.check) return { ok: false, error: "만들거나 고치려면 판정(check)이 필요하다." };
    const why = planCraft(content, player, input.craft, input.check.move);
    if (why) return { ok: false, error: why };
  }
  if (input.move_to && gearRules && encumbrance(content, player) === 2) {
    return { ok: false, error: `짐이 너무 무겁다 (${carriedWeight(content, player).toFixed(1)}kg). 내려놓아야(transfer_item to scene) 옮겨 갈 수 있다.` };
  }
  if (inBattle) {
    if (input.activity && input.activity.kind !== "brief") return { ok: false, error: "전투 중에는 잠·보초·기다림 같은 활동을 할 수 없다. activity는 null로 둔다 (한 라운드가 흐른다)." };
    if (input.move_to) return { ok: false, error: "전투 중에는 구역을 옮길 수 없다. 빠지려면 물러나는 전투 효과를 쓴다." };
    if (input.prepare) return { ok: false, error: "전투 중에는 준비물을 설치할 수 없다." };
    if (input.treatment || input.use_item) return { ok: false, error: "전투 중에는 치료하거나 물건을 쓸 수 없다. 먼저 물러난다." };
    if (input.battle && !input.check) return { ok: false, error: "전투 효과에는 판정(check)을 함께 선언한다." };
    const effect = input.battle ? scenario.battle?.effects.find((e) => e.id === input.battle!.effect) : undefined;
    const HARM_RANK = { none: 0, light: 1, heavy: 2 } as const;
    if (effect && input.check && HARM_RANK[input.check.harm_on_failure] < HARM_RANK[effect.min_harm]) {
      return { ok: false, error: `${effect.label}에는 몸의 위험을 ${effect.min_harm} 이상으로 선언한다 (harm_on_failure).` };
    }
  }
  const battleAction = validateBattleAction(ctx, input.battle);
  if (typeof battleAction === "string") return { ok: false, error: battleAction };
  // 건너가기 (기획서 9.12): 맞닿지 않은 곳이라도 crossing.from에서는 배로 건넌다. 표(pass_flags)가 없으면 위험한 시도
  let crossingAttempt = false;
  if (input.move_to) {
    const here = start.playerZone;
    const dest = content.locations[input.move_to];
    if (!dest) return { ok: false, error: `알 수 없는 구역: ${input.move_to}` };
    const crossing = dest.crossing && here && dest.crossing.from.includes(here) ? dest.crossing : null;
    if (!here || (!neighbors(content, here).includes(input.move_to) && !crossing)) {
      return { ok: false, error: `${input.move_to}은(는) 지금 구역과 맞닿아 있지 않다. 인접 구역: ${here ? neighbors(content, here).join(", ") : "없음"}` };
    }
    if (input.activity) return { ok: false, error: "이동하는 턴에는 activity를 null로 둔다 (이동 시간은 시스템이 정한다)." };
    if (crossing && !neighbors(content, here).includes(input.move_to)) {
      const flags = new Set(start.flags[start.playerId] ?? []);
      if (!crossing.pass_flags.some((f) => flags.has(f))) {
        if (!input.check || !crossing.attempt.moves.includes(input.check.move) || input.check.harm_on_failure !== "heavy") {
          return {
            ok: false,
            error:
              `${dest.name}(으)로 건너갈 표가 없다. 직접 건너려면 ${crossing.attempt.label}: check.move는 ${crossing.attempt.moves.join("/")} 중 하나, ` +
              "harm_on_failure는 heavy로 위험을 먼저 선언한다 (실패하면 다치고 되돌아온다). 아니면 이야기로 건너는 길을 얻는다.",
          };
        }
        crossingAttempt = true;
      }
    }
  }
  const prep = input.prepare ? scenario.battle?.preparations.find((p) => p.id === input.prepare) : null;
  if (input.prepare) {
    if (!prep) return { ok: false, error: `알 수 없는 준비물: ${input.prepare}` };
    const zone = start.playerZone;
    if (!zone || start.zones[zone]?.owner !== player.factionId) return { ok: false, error: "준비물은 우리 무리의 구역에만 설치할 수 있다." };
    if (prep.requires_item && (player.inventory[prep.requires_item] ?? 0) < 1) return { ok: false, error: `${prep.label}에는 ${josa(content.items[prep.requires_item]?.name ?? prep.requires_item, "이/가")} 필요하다.` };
    if (!input.check) return { ok: false, error: `${prep.label} 설치에는 판정(check)이 필요하다.` };
  }

  store.append({ type: "turn_started", turn: start.turn + 1, input: input.intent });
  const forMission = input.for_mission ? (activeMissionOf(start.missions, start.playerId)?.id ?? null) : null;
  const lines: string[] = [];
  const displays: ToolDisplayEvent[] = [];
  let outcome: CheckOutcome | null = null;

  // 1. 판정과 선언한 위험
  if (input.check) {
    const roll = rollPlayerCheck(
      { move: input.check.move, stat: input.check.stat, difficulty: input.check.difficulty, intent: input.intent },
      ctx,
      { target: input.target, forMission },
    );
    if (!roll.ok) {
      // 턴은 이미 시작됐으므로 잠깐의 시간만 흐르게 하고 오류를 알린다
      advanceTime(ctx, "brief", null);
      return { ok: false, error: roll.error };
    }
    outcome = roll.outcome;
    displays.push(roll.display);
    lines.push(
      `판정 ${roll.checkId}: ${CHECK_OUTCOME_LABELS[roll.outcome]} (${roll.outcome}). ` +
        `주사위 ${roll.dice[0]}+${roll.dice[1]}, 보정 ${signed(roll.modifier)}, 합계 ${roll.total}.`,
      OUTCOME_GUIDE[roll.outcome],
    );
    if (roll.growthNote) lines.push(roll.growthNote);
    // 무기: 탄약·소음·닳음 (기획서 4.8)
    if (attack) lines.push(...afterAttack(ctx, attack, roll.outcome).lines);
    // 상대를 다치게 한다 (기획서 7.5). 사망은 부상 트랙으로만 (원칙 3)
    if (input.check.target_harm !== "none" && input.target) {
      const hit = hitTarget(ctx, input.target, input.check.target_harm, roll.outcome, input.intent);
      lines.push(...hit.lines);
      displays.push(...hit.displays);
    }
    if (roll.outcome !== "success" && input.check.harm_on_failure !== "none") {
      const harm = applyHarm(ctx, roll.checkId, input.check.harm_on_failure, input.check.harm_cause || input.intent);
      lines.push(harm.text);
      displays.push(harm.display);
      // 감염체에게 입은 상처는 감염될 수 있다 (잠복기는 캐릭터도 GM도 모른다)
      // 입은 방어구가 물림·긁힘을 막을 수 있다 (기획서 4.8)
      // 크게 다치면 마음도 흔들린다 (12-48)
      const nerves = ctx.content.scenario.body?.nerves;
      if (!harm.fatal && nerves && input.check.harm_on_failure === "heavy") {
        const shaken = shakeNerves(ctx, nerves.heavy_harm, `크게 다쳤다 (${input.check.harm_cause || input.intent})`);
        if (shaken?.line) lines.push(shaken.line);
      }
      if (!harm.fatal && input.check.infected_source) {
        if (armorBlocksInfection(ctx)) lines.push("입은 것이 물림을 막아 냈다. 살갗까지 닿지 않았다.");
        else maybeInfect(ctx, input.check.harm_on_failure);
      }
      if (harm.fatal) {
        // 연대기 기록 (전투 중이면 그 자리를 원인에 붙인다), 남은 전투는 코드가 굴린다
        const battle = store.getState().battle;
        recordDeath(ctx, input.check.harm_cause || input.intent, battle ? (content.locations[battle.zone]?.name ?? battle.zone) + " 전투" : null);
        if (battle) {
          const end = endBattle(ctx, false);
          lines.push(...end.lines.filter((l) => !l.startsWith("결과에 맞게")));
          displays.push(...end.displays);
        }
        return { ok: true, resultText: lines.join("\n"), displays, outcome, dead: true };
      }
    }
  }

  // 1-0-1. 제작·수리 (기획서 4.8)
  if (input.craft && outcome) lines.push(...applyCraft(ctx, input.craft, outcome));

  // 1-0. 수색: 그 구역에서 찾을 거리를 코드가 굴린다 (기획서 4.7)
  if (input.activity?.kind === "search" && !inBattle) {
    const found = scavenge(ctx, outcome);
    lines.push(...found.lines);
    displays.push(...found.displays);
  }

  // 1-1. 준비물 설치 (아이템은 판정 결과와 관계없이 쓴다)
  if (prep) {
    if (prep.requires_item) store.append({ type: "item_consumed", holder: start.playerId, itemId: prep.requires_item, quantity: 1 });
    if (outcome !== "miss") {
      store.append({ type: "preparation_set", zone: start.playerZone!, preparation: prep.id });
      lines.push(`${josa(prep.label, "을/를")} 이 구역에 설치했다. 이 구역에서 전투가 벌어지면 쓸 수 있다.`);
    } else {
      lines.push(`${prep.label} 설치에 실패했다. 재료는 못 쓰게 됐다.`);
    }
  }

  // 1-1-1. 치료 (낫는 정도는 시스템이 정한다)
  for (const [request, run] of [
    [input.treatment, () => applyTreatment(ctx, input.treatment!.item, input.treatment!.target)],
    [input.use_item, () => useItem(ctx, input.use_item!)],
  ] as const) {
    if (!request) continue;
    const t = run();
    if (t.ok) {
      lines.push(...t.lines);
      displays.push(...t.displays);
    } else {
      lines.push(`몸을 돌보지 못했다: ${t.error}`);
    }
  }

  // 1-2. 전투 한 라운드 (판정이 없어도 라운드는 흐른다)
  if (inBattle) {
    const round = playBattleRound(
      ctx,
      battleAction && input.check ? { ...battleAction, outcome: outcome!, checkId: lastCheckId(ctx) } : null,
    );
    lines.push(...round.lines);
    displays.push(...round.displays);
  }

  // 2. 행적과 목격자
  if (input.deed) {
    const happened = input.deed.condition === "always" || outcome === null || outcome !== "miss";
    if (happened) {
      const { deed, visible } = recordDeed(ctx, input.deed);
      lines.push(
        `행적 ${deed.id} 기록: ${sentence(deed.summary)} ` +
          (visible.length > 0 ? `장면에 있던 ${josa(visible.join(", "), "이/가")} 보았다. 그들의 반응을 서술에 반영하라.` : "장면에 아무도 없었다.") +
          " 숨은 목격자가 있었는지는 아무도 모른다.",
      );
      displays.push({
        type: "deed",
        summary: deed.summary,
        tagLabels: deed.tags.map((t) => DEED_TAG_LABELS[t]),
        visibleWitnesses: visible,
      });
    }
  }

  // 3. 시간 경과 (빨리감기와 끼어들기 포함)
  const activity: Activity = inBattle ? "combat" : input.move_to ? "travel" : (input.activity?.kind ?? (input.treatment ? "treat" : input.use_item ? "eat" : input.craft ? "work" : "brief"));
  const time = advanceTime(ctx, activity, input.activity?.until ?? null, forMission);
  lines.push(time.text);
  if (input.activity || input.move_to) displays.push(time.display);
  displays.push(...time.extra);
  lines.push(...bodyLines(time.extra));
  // 건너기 시도가 실패하면 물살에 밀려 되돌아온다 (시간과 위험은 이미 치렀다)
  const sweptBack = crossingAttempt && outcome === "miss";
  if (sweptBack) lines.push(`${content.locations[input.move_to!]?.name ?? input.move_to}에 닿지 못하고 되돌아왔다. 되돌아온 장면을 서술한다.`);
  if (input.move_to && !time.interrupted && !sweptBack) {
    // 자리를 뜨면 그 자리의 이야기는 끝난다 (장면의 인물도 따라오지 않는다)
    displays.push(...endActiveStorylet(ctx, "자리를 떴다"));
    const deposited = start.playerZone ? store.getState().deposits?.[start.playerZone] : undefined;
    store.append({ type: "zone_moved", from: start.playerZone, to: input.move_to });
    if (deposited) lines.push(`맡겨 둔 것을 돌려받고 떠났다: ${Object.entries(deposited).map(([id, n]) => `${content.items[id]?.name ?? id}${n > 1 ? ` ×${n}` : ""}`).join(", ")}.`);
    lines.push(`${content.locations[input.move_to]?.name ?? input.move_to}에 도착했다. 함께 있던 인물은 따라오지 않는다 (같이 왔다면 npc_presence로 다시 등장시킨다).`);
    // 길 위의 일 (12-53): 오는 길에 일이 생겼으면, 도착 직전 길 위의 장면으로 연출한다
    for (const d of runRoadEvent(ctx)) {
      displays.push(d);
      if (d.type === "storylet" && d.event === "started") lines.push(`오는 길에 일이 생겼다: "${d.title}". 도착하기 전, 길 위의 장면으로 연출하라 (상태의 '진행 중인 이야기').`);
    }
    // 처음 들어온 곳이면 해금 (모든 판에 남는다)
    const unlock = content.locations[input.move_to]?.unlocks;
    if (unlock && !store.getState().unlocked.includes(unlock)) {
      store.append({ type: "unlock_earned", id: unlock, inherited: false });
      const roles = Object.values(content.roles).filter((r) => r.unlock === unlock).map((r) => r.scenario?.title ?? r.label);
      if (roles.length) lines.push(`(게임 밖 알림: 새 시나리오가 열렸다 — ${roles.join(", ")}. 이제 어느 판에서든 새 게임과 다음 캐릭터로 고를 수 있다. 장면 서술과 섞지 말고 짧게 알린다)`);
    }
  }

  // 4. 시간이 흐른 뒤 세계 처리 (임무 기한, 오늘의 임무, 소문, 전쟁, 예정된 교전)
  const after = runAfterTimeAdvance(ctx);
  lines.push(...bodyLines(after));
  for (const display of after) {
    displays.push(display);
    if (display.type === "presence" && display.note) lines.push(display.note);
    if (display.type === "mission" && display.title.startsWith(SQUAD_REPORT_PREFIX)) {
      lines.push(`${display.title}: ${display.detail}. 보고 내용은 상태의 '분대' 섹션에 있다. 분대원이 돌아와(또는 전령으로) 보고하는 장면을 짧게 서술한다. 보고에 없는 것을 지어내지 않는다.`);
    } else if (display.type === "mission") lines.push(`임무 ${display.title}: ${display.detail}.`);
    if (display.type === "storylet" && display.event === "started") {
      lines.push(`새 이야기가 시작됐다: "${display.title}". 상태의 '진행 중인 이야기'를 보고 장면으로 연출하라.`);
    }
    if (display.type === "battle" && display.event === "started") {
      lines.push(`전투가 시작됐다: ${display.detail} 상태의 '전투 중' 정보를 보고 첫 장면을 서술한 뒤 플레이어의 행동을 기다려라.`);
    }
  }

  return { ok: true, resultText: lines.join("\n"), displays, outcome, dead: false };
}

/** 시간이 흐르며 바뀐 몸 상태(허기, 감염, 저절로 낫기)를 GM에게 알린다 */
function bodyLines(displays: readonly ToolDisplayEvent[]): string[] {
  return displays.flatMap((d) =>
    d.type === "heal"
      ? [`${d.targetName}의 ${d.trackLabel}: ${d.fromLabel} → ${d.toLabel} (${d.byLabel}).`]
      : d.type === "harm" && d.trackLabel !== ""
        ? [`${d.targetName}의 ${d.trackLabel}: ${d.fromLabel} → ${d.toLabel} (${d.cause}). 몸의 변화를 서술에 반영하라.${d.fatal ? DEATH_GUIDE : ""}`]
        : [],
  );
}

/** 상대에게 피해: 성공 = 선언한 만큼(light 1, heavy 2), 대가 있는 성공 = 1, 실패 = 0. 무력화되면 지닌 것을 알린다 */
function hitTarget(ctx: ToolContext, targetId: string, severity: "light" | "heavy", outcome: CheckOutcome, cause: string) {
  const state = ctx.store.getState();
  const target = state.characters[targetId];
  const lines: string[] = [];
  const displays: ToolDisplayEvent[] = [];
  if (!target || targetId === state.playerId || !state.scene.present.includes(targetId)) {
    return { lines: [`상대 피해 없음: ${targetId}는 장면에 있는 인물이 아니다.`], displays };
  }
  // 이름을 모르는 상대는 호칭으로 부른다 (기획서 6.3)
  const called = playerCalls(state, ctx.content, targetId);
  if (target.dead) return { lines: [`${josa(called, "은/는")} 이미 죽었다.`], displays };
  const steps = outcome === "success" ? (severity === "heavy" ? 2 : 1) : outcome === "partial" ? 1 : 0;
  if (steps === 0) return { lines: [`${josa(called, "은/는")} 다치지 않았다.`], displays };
  const change = changeCondition(ctx, targetId, ctx.content.scenario.harm_track, steps, "attack", cause);
  if (change?.line) lines.push(change.line);
  if (change?.display) displays.push(change.display);
  const after = ctx.store.getState().characters[targetId]!;
  if (after.dead) lines.push(`${josa(called, "이/가")} 죽었다. 죽음을 서술에 반영하라.`);
  if (isIncapacitated(ctx.content, after)) {
    const items = Object.entries(after.inventory).map(([i, q]) => `${ctx.content.items[i]?.name ?? i}(${i}) ×${q}`);
    lines.push(
      `${josa(called, "은/는")} ${after.dead ? "쓰러져 움직이지 않는다" : "무력화됐다 (더 맞서지 못한다)"}. ` +
        `뒤지면 나오는 것: ${items.join(", ") || "없음"}. 가져가려면 transfer_item (판정 없이).`,
    );
  }
  return { lines, displays };
}

function lastCheckId(ctx: ToolContext): string {
  const checks = Object.values(ctx.store.getState().checks);
  return checks[checks.length - 1]!.checkId;
}

/** 판정 결과에 따른 피해 (원칙 3: 사망은 부상 트랙과 판정 결과로만) */
function applyHarm(ctx: ToolContext, checkId: string, severity: HarmSeverity, cause: string) {
  const { store, content } = ctx;
  const state = store.getState();
  const track = harmTrack(content.scenario);
  const target = state.characters[state.playerId]!;
  const check = state.checks[checkId]!;
  // 입은 방어구가 피해를 줄인다 (기획서 4.8)
  const absorbed = armorAbsorb(ctx, harmSteps(check.outcome, severity));
  const steps = absorbed.steps;
  const from = target.conditions[track.id] ?? track.levels[0]!.id;
  if (steps <= 0) {
    // 방어구가 다 막았다 (기획서 4.8)
    const label = levelOf(track, from).label;
    return {
      fatal: false,
      text: `${absorbed.lines.join(" ")} ${target.name}은(는) 다치지 않았다. 막아 낸 순간을 서술한다.`.trim(),
      display: { type: "harm" as const, targetName: target.name, trackLabel: track.label, severityLabel: HARM_LABELS[severity], fatal: false, fromLabel: label, toLabel: label, cause },
    };
  }
  const { to, fatal } = worsen(track, from, steps);
  store.append({
    type: "harm_applied",
    targetId: target.id,
    checkId,
    track: track.id,
    severity,
    steps,
    from,
    to,
    fatal,
    cause,
  });
  const after = store.getState().characters[target.id]!;
  const fromLabel = levelOf(track, from).label;
  const toLabel = levelOf(track, to).label;
  const note = fatal
    ? `${DEATH_GUIDE} 장면을 끝내고 더 이상 행동을 제시하지 마라.`
    : ` 앞으로 판정에 ${signed(conditionPenalty(content.scenario, after))} 보정을 받는다. 다친 감각을 서술에 반영하라.`;
  return {
    fatal,
    text: `${absorbed.lines.length ? absorbed.lines.join(" ") + " " : ""}${target.name}의 ${track.label}: ${fromLabel} → ${toLabel} (${cause}).${note}`,
    display: {
      type: "harm" as const,
      targetName: target.name,
      trackLabel: track.label,
      severityLabel: HARM_LABELS[severity],
      fatal,
      fromLabel,
      toLabel,
      cause,
    },
  };
}

/** 활동만큼 시간을 흘린다. 보초·잠·기다림은 빨리감기로, 도중에 끼어들기가 생기면 멈춘다 */
export function advanceTime(ctx: ToolContext, activity: Activity, until: TimeSegment | null, forMission: string | null = null) {
  const { store, rng, content } = ctx;
  const state = store.getState();
  const cost = ACTIVITY_COSTS[activity];
  const from = state.time;
  let to: number;
  let interrupt: ReturnType<typeof fastForward>["interrupt"] = null;

  const extra: ToolDisplayEvent[] = [];
  if (cost.kind === "long") {
    const target = Math.min(until && cost.allowUntil ? nextSegmentStart(from, until) : from + cost.minutes, from + MAX_FAST_FORWARD_MINUTES);
    // 자정을 넘기면 자정에서 하루 처리(전쟁 틱)를 돌린 뒤 이어 간다. 그래야 새벽 교전에서 멈출 수 있다
    let cursor = from;
    for (;;) {
      const midnight = dayOf(cursor) * MINUTES_PER_DAY;
      const segmentEnd = Math.min(target, midnight);
      const result = fastForward({ state: store.getState(), start: cursor, until: segmentEnd, rng, checks: createInterruptChecks(content.scenario, [createStoryletCheck(content, { asleep: activity === "sleep" })]) });
      store.append({
        type: "time_advanced",
        activity,
        from: cursor,
        to: result.end,
        ...(result.interrupt ? { interrupt: result.interrupt } : {}),
        ...(forMission ? { forMission } : {}),
      });
      cursor = result.end;
      interrupt = result.interrupt;
      if (interrupt || cursor >= target) break;
      extra.push(...runAfterTimeAdvance(ctx));
      if (store.getState().battle) break;
    }
    to = cursor;
  } else {
    to = from + (activity === "combat" ? (content.scenario.battle?.round_minutes ?? ACTIVITY_COSTS.combat.minutes) : Math.max(MIN_TURN_MINUTES, rollActivityMinutes(cost, rng)));
    store.append({
      type: "time_advanced",
      activity,
      from,
      to,
      ...(forMission ? { forMission } : {}),
    });
  }

  const label = ACTIVITY_LABELS[activity];
  const lines = [`${label}: ${formatDuration(to - from)} 경과. 현재 ${formatTime(to)}.`];
  if (segmentOf(from) !== segmentOf(to)) {
    lines.push(`시간대가 ${SEGMENT_LABELS[segmentOf(from)]}에서 ${josa(SEGMENT_LABELS[segmentOf(to)], "으로/로")} 바뀌었다. 빛과 소리의 변화를 서술에 반영하라.`);
  }
  if (interrupt?.kind === "storylet") {
    lines.push(`${josa(label, "이/가")} 끊겼다: 무언가 일이 생겼다.`);
  } else if (interrupt?.kind === "battle") {
    lines.push(`${josa(label, "이/가")} 끊겼다: 무언가 벌어지고 있다.`);
  } else if (interrupt) {
    lines.push(
      `${josa(label, "이/가")} 중간에 끊겼다: ${interrupt.detail}. 정체는 아직 모른다. ` +
        "캐릭터가 이를 알아차리는 장면으로 서술하고, 정체를 확정하지 말고 플레이어의 반응을 기다려라.",
    );
  }
  return {
    text: lines.join("\n"),
    extra,
    interrupted: interrupt !== null,
    display: {
      type: "time" as const,
      activityLabel: label,
      durationLabel: formatDuration(to - from),
      fromLabel: formatTime(from),
      toLabel: formatTime(to),
      ...(interrupt ? { interruptDetail: interrupt.detail } : {}),
    },
  };
}
