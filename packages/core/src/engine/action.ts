import { josa, sentence } from "../text.ts";
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
import { activeMissionOf } from "../game/missions.ts";
import { neighbors } from "../sim/war.ts";
import { endBattle, playBattleRound, validateBattleAction } from "./battleTools.ts";
import { createStoryletCheck } from "./storyletTools.ts";
import { recordDeath } from "./succession.ts";
import { applyTreatment } from "./recovery.ts";
import { dayOf, MINUTES_PER_DAY } from "../rules/time.ts";
import { signed, type ToolContext, type ToolDisplayEvent } from "./toolkit.ts";

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
          `기본 행동. ${s.moves.map((m) => `${m.id} ${m.label}${m.description ? `(${m.description})` : ""}`).join(", ")}`,
        ),
        stat: idEnum(statIds(s)).describe(
          `능력치. 행동별 허용: ${s.moves.map((m) => `${m.id}=${m.stats.join("|")}`).join(", ")}`,
        ),
        difficulty: difficultySchema.describe("상황의 난이도. 대부분은 normal"),
        harm_on_failure: z
          .enum(["none", "light", "heavy"])
          .describe("판정 전에 선언하는 몸의 위험. 실패·대가 있는 성공이면 시스템이 적용한다. none은 몸을 다칠 위험이 없는 행동"),
        harm_cause: z.string().max(120).describe("다친다면 그 원인 한 문장 (위험이 none이면 빈 문자열)"),
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
    treatment: z
      .strictObject({
        item: z.string().nullable().describe("치료에 쓸 아이템 id (구급상자 등). 장면에 있는 치료사에게 받으면 null"),
      })
      .nullable()
      .default(null)
      .describe("다친 데를 치료하면. 아이템을 쓰거나 장면의 치료사에게 받는다(하루 한 번). 얼마나 낫는지는 시스템이 정한다. activity는 treat로 둔다. 아니면 null"),
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
  if (inBattle) {
    if (input.activity && input.activity.kind !== "brief") return { ok: false, error: "전투 중에는 잠·보초·기다림 같은 활동을 할 수 없다. activity는 null로 둔다 (한 라운드가 흐른다)." };
    if (input.move_to) return { ok: false, error: "전투 중에는 구역을 옮길 수 없다. 빠지려면 물러나는 전투 효과를 쓴다." };
    if (input.prepare) return { ok: false, error: "전투 중에는 준비물을 설치할 수 없다." };
    if (input.treatment) return { ok: false, error: "전투 중에는 치료할 수 없다. 먼저 물러난다." };
    if (input.battle && !input.check) return { ok: false, error: "전투 효과에는 판정(check)을 함께 선언한다." };
    const effect = input.battle ? scenario.battle?.effects.find((e) => e.id === input.battle!.effect) : undefined;
    const HARM_RANK = { none: 0, light: 1, heavy: 2 } as const;
    if (effect && input.check && HARM_RANK[input.check.harm_on_failure] < HARM_RANK[effect.min_harm]) {
      return { ok: false, error: `${effect.label}에는 몸의 위험을 ${effect.min_harm} 이상으로 선언한다 (harm_on_failure).` };
    }
  }
  const battleAction = validateBattleAction(ctx, input.battle);
  if (typeof battleAction === "string") return { ok: false, error: battleAction };
  if (input.move_to) {
    const here = start.playerZone;
    if (!content.locations[input.move_to]) return { ok: false, error: `알 수 없는 구역: ${input.move_to}` };
    if (!here || !neighbors(content, here).includes(input.move_to)) {
      return { ok: false, error: `${input.move_to}은(는) 지금 구역과 맞닿아 있지 않다. 인접 구역: ${here ? neighbors(content, here).join(", ") : "없음"}` };
    }
    if (input.activity) return { ok: false, error: "이동하는 턴에는 activity를 null로 둔다 (이동 시간은 시스템이 정한다)." };
  }
  const prep = input.prepare ? scenario.battle?.preparations.find((p) => p.id === input.prepare) : null;
  if (input.prepare) {
    if (!prep) return { ok: false, error: `알 수 없는 준비물: ${input.prepare}` };
    const zone = start.playerZone;
    if (!zone || start.zones[zone]?.owner !== player.factionId) return { ok: false, error: "준비물은 우리 무리의 구역에만 설치할 수 있다." };
    if (prep.requires_item && (player.inventory[prep.requires_item] ?? 0) < 1) return { ok: false, error: `${prep.label}에는 ${prep.requires_item}이(가) 필요하다.` };
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
    if (roll.outcome !== "success" && input.check.harm_on_failure !== "none") {
      const harm = applyHarm(ctx, roll.checkId, input.check.harm_on_failure, input.check.harm_cause || input.intent);
      lines.push(harm.text);
      displays.push(harm.display);
      if (harm.fatal) {
        // 연대기 기록 (전투 중이면 그 자리를 원인에 붙인다), 남은 전투는 코드가 굴린다
        const battle = store.getState().battle;
        recordDeath(ctx, input.check.harm_cause || input.intent, battle ? (content.locations[battle.zone]?.name ?? battle.zone) + " 전투" : null);
        if (battle) displays.push(...endBattle(ctx, false).displays);
        return { ok: true, resultText: lines.join("\n"), displays, outcome, dead: true };
      }
    }
  }

  // 1-1. 준비물 설치 (아이템은 판정 결과와 관계없이 쓴다)
  if (prep) {
    if (prep.requires_item) store.append({ type: "item_consumed", holder: start.playerId, itemId: prep.requires_item, quantity: 1 });
    if (outcome !== "miss") {
      store.append({ type: "preparation_set", zone: start.playerZone!, preparation: prep.id });
      lines.push(`${prep.label}을(를) 이 구역에 설치했다. 이 구역에서 전투가 벌어지면 쓸 수 있다.`);
    } else {
      lines.push(`${prep.label} 설치에 실패했다. 재료는 못 쓰게 됐다.`);
    }
  }

  // 1-1-1. 치료 (낫는 정도는 시스템이 정한다)
  if (input.treatment) {
    const t = applyTreatment(ctx, input.treatment.item);
    if (t.ok) {
      lines.push(`${t.line} ${t.display.type === "heal" ? `${t.display.trackLabel}: ${t.display.fromLabel} → ${t.display.toLabel}.` : ""}`);
      displays.push(t.display);
    } else {
      lines.push(`치료하지 못했다: ${t.error}`);
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
  const activity: Activity = inBattle ? "combat" : input.move_to ? "travel" : (input.activity?.kind ?? (input.treatment ? "treat" : "brief"));
  const time = advanceTime(ctx, activity, input.activity?.until ?? null, forMission);
  lines.push(time.text);
  if (input.activity || input.move_to) displays.push(time.display);
  displays.push(...time.extra);
  if (input.move_to && !time.interrupted) {
    store.append({ type: "zone_moved", from: start.playerZone, to: input.move_to });
    lines.push(`${content.locations[input.move_to]?.name ?? input.move_to}에 도착했다.`);
  }

  // 4. 시간이 흐른 뒤 세계 처리 (임무 기한, 오늘의 임무, 소문, 전쟁, 예정된 교전)
  for (const display of runAfterTimeAdvance(ctx)) {
    displays.push(display);
    if (display.type === "mission") lines.push(`임무 ${display.title}: ${display.detail}.`);
    if (display.type === "storylet" && display.event === "started") {
      lines.push(`새 이야기가 시작됐다: "${display.title}". 상태의 '진행 중인 이야기'를 보고 장면으로 연출하라.`);
    }
    if (display.type === "battle" && display.event === "started") {
      lines.push(`전투가 시작됐다: ${display.detail} 상태의 '전투 중' 정보를 보고 첫 장면을 서술한 뒤 플레이어의 행동을 기다려라.`);
    }
  }

  return { ok: true, resultText: lines.join("\n"), displays, outcome, dead: false };
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
  const steps = harmSteps(check.outcome, severity);
  const from = target.conditions[track.id] ?? track.levels[0]!.id;
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
    ? " 캐릭터가 사망했다. 죽음의 순간을 담담하게 서술하고 장면을 끝내라. 더 이상 행동을 제시하지 마라. 서술한 뒤 write_epitaph로 한두 문장의 묘비명을 남긴다."
    : ` 앞으로 판정에 ${signed(conditionPenalty(content.scenario, after))} 보정을 받는다. 다친 감각을 서술에 반영하라.`;
  return {
    fatal,
    text: `${target.name}의 ${track.label}: ${fromLabel} → ${toLabel} (${cause}).${note}`,
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
      const result = fastForward({ state: store.getState(), start: cursor, until: segmentEnd, rng, checks: createInterruptChecks(content.scenario, [createStoryletCheck(content)]) });
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
