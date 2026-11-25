import { createPartyCheck, PARTY_INTERRUPT, runPartyInterrupt, runPartySightings } from "./partySight.ts";
import {heldOf, heldKind, welcomeRescued } from "../rules/held.ts";
import { applyBuild, planBuild } from "./facilities.ts";
import { applyTrain, planTrain } from "./training.ts";
import { applyLesson, planLesson } from "./teaching.ts";
import { planBroadcast, runBroadcast } from "./broadcast.ts";
import { ambushDifficulty, applyAmbush, isConfused, leaveAmbush, planAmbush } from "./ambush.ts";
import { templateKind } from "../game/kinds.ts";
import { activeCompanions } from "../game/companions.ts";
import { forage, forageParts, forageProblem, handleTrap, trapProblem } from "./forage.ts";
import { buryRemains } from "./remains.ts";
import { resistSteps } from "./growth.ts";
import { breakTruceIfAny } from "./diplomacy.ts";
import { exposeToFatigue } from "./fatigue.ts";
import { deliverPrisoners, escapeRule, releasePlayer } from "./captivity.ts";
import { BELIEF_SOURCE_LABELS } from "../game/belief.ts";
import { againstSetting, rollBlowup, rollHear, rollLeak } from "../rules/self.ts";
import { exposeToCold, changeClothes, soak } from "./climate.ts";
import { opponentHarm } from "./opposition.ts";
import { calmAfterSleep, fearTagIds, frighten, FRIGHT_CAUSES } from "./fear.ts";
import { hostileHere, hostileZone, raiseAlarm, runAlarm, runInfestedArrival, runRoadEvent } from "./storyletTools.ts";
import { atStake } from "../rules/stakes.ts";
import { shareHarmWith } from "../rules/company.ts";
import { onSpottedAtHome } from "../rules/consequence.ts";
import { situationOf, threatInScene } from "../rules/situation.ts";
import { playerHeld } from "../rules/held.ts";
import { withoutBlame } from "../rules/blame.ts";
import { CAMP_INTERRUPT, createCampCheck, runCampEvent, deepSleepReason } from "./camp.ts";
import { shakeNerves, sleepNerves } from "./body.ts";
import { withoutWear } from "./gear.ts";
import { afterAttack, applyCraft, armorAbsorb, armorBlocksInfection, carriedWeight, encumbrance, planAttack, planCraft, rangeProblem } from "./gear.ts";
import { scavenge, scavengeParts } from "./scavenge.ts";
import { josa, sentence } from "../text.ts";
import { isInfected } from "../game/kinds.ts";
import { playerCalls } from "../game/acquaintance.ts";
import { moveLabel } from "../scenario/scenario.ts";
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
  activityTarget,
  HOURS_ACTIVITIES,
  sleepCapMinutes,
  rollActivityMinutes,
  routeMinutes,
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
import { recordDeed, spottedEntering } from "./reputationTools.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";
import { chaseParties, fightMembersHere } from "./partyTools.ts";
import { SQUAD_REPORT_PREFIX } from "./command.ts";
import { activeMissionOf, atMissionPlace, commanderOf as commanderIdOf, MISSION_CHECK_TRIES, MISSION_FAIL_MINUTES } from "../game/missions.ts";
import { neighbors } from "../sim/war.ts";
import { endBattle, playBattleRound, validateBattleAction } from "./battleTools.ts";
import { bleedFromHarm, staunch, woundKind } from "./bleeding.ts";
import { scarFromHarm } from "./scars.ts";
import { createStoryletCheck, endActiveStorylet, resolveStorylet, storyTitle } from "./storyletTools.ts";
import { slotOpensBetween } from "../rules/storySlot.ts";
import { choiceAvailable, storyletOf } from "../story/storylets.ts";
import { recordDeath } from "./succession.ts";
import { incapacitatingSymptom } from "../scenario/scenario.ts";
import { sleepChainStart } from "../game/state.ts";
import { healersHere } from "./care/kinds.ts";
import { applyTreatment, type FeeChoice, drinkWater, healFromSleep, sleepHealBlocker, itemUseProblem, maybeInfect, refillWater, treatmentProblem, useItem, wadeIn } from "./body.ts";
import { dayOf, MINUTES_PER_DAY } from "../rules/time.ts";
import { DEATH_GUIDE, signed, type ToolContext, type ToolDisplayEvent } from "./toolkit.ts";
import { cargoOf } from "../rules/entrusted.ts";
import { baseOfNow, ownedBy } from "../rules/home.ts";
import { runPendingClashes } from "./battleTools.ts";
import type { GameState } from "../game/state.ts";
import { hurtResentment, reduceHarm, wrongedResentment } from "../rules/damage.ts";
import { enterScene } from "./extras.ts";
import {comesAlong, pursuers, directionTo, knowsZone, roadTo, currentPlace, nearestRoad, peopleAt, placeById, placeChoices, resolvePlace, unknownDoors, doorLabel, knowsPlace, stepsBetween, whereIs, npcPlaceAt, type Place, whereLabel, arrivalPlace, movePlayer } from "../rules/place.ts";

/**
 * 턴 진행의 유일한 입구 (기획서 11.6 take_action). 두 플레이 모드가 같은 함수를 쓴다.
 * 한 턴의 판정·피해·행적·시간을 한 번에 받아 코드가 정해진 순서로 처리한다.
 * 피해는 판정 전에 위험으로 선언하고, 결과가 나오면 코드가 적용한다 (AI가 결과를 보고 수위를 고르지 않는다).
 */

/** 대가 있는 성공은 최대 1단계, 실패는 선언한 위험에 따라 1~2단계 악화 (임시값) */
/** 판정 결과별 피해 단계. 대가 있는 성공은 실패보다 한 단계 덜 (플레이 테스트 11: 수색 두 번에 고통이 두 단계 쌓였다). 가벼운 위험의 대가 있는 성공은 0 (시간을 잃는다) */
export function harmSteps(outcome: CheckOutcome, severity: HarmSeverity): number {
  const miss = severity === "heavy" ? 2 : 1;
  return outcome === "partial" ? miss - 1 : miss;
}

/** 가벼운 위험의 대가 있는 성공에서 다치는 대신 잃는 시간 (분) */
export const PARTIAL_TIME_COST = 30;

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
          .describe(
            "판정 전에 선언하는 몸의 위험. 실패·대가 있는 성공이면 시스템이 적용한다. none은 몸을 다칠 위험이 없는 행동. " +
              "플레이어가 고른 행동이 부르는 위험만 선언한다: 이번 턴에 처음 드러나는 상대의 피해는 걸지 않는다 (드러난 위협에 대한 대응은 플레이어가 고른 뒤 판정한다)",
          ),
        harm_cause: z.string().max(120).default("").describe("다친다면 그 원인 한 문장 (위험이 none이면 생략, PT15: none인데도 빠뜨리면 오류였다)"),
        harm_kind: z
          .string()
          .nullable()
          .default(null)
          .describe(
            s.wounds
              ? `몸의 위험을 걸면 반드시 고르는 상처 종류: ${s.wounds.kinds.map((k) => `${k.id} ${k.label}${k.bleeds ? " (피가 난다)" : ""}`).join(", ")}. 피가 나는 종류로 다치면 시스템이 출혈을 정한다. 위험이 none이면 null`
              : "이 월드에서는 쓰지 않는다. null",
          ),
        target_harm: z
          .enum(["none", "light", "heavy"])
          .default("none")
          .describe(
            "target(장면의 인물)을 다치게 하려는 공격이면 판정 전에 선언하는 상대의 피해. 성공이면 선언한 만큼, 대가 있는 성공이면 1단계, 실패면 없음. " +
              "상대가 중상 이상이면 무력화되어 소지품을 뒤질 수 있다. 공격이 아니면 none",
          ),
        unarmed: z.boolean().default(false).describe("손에 든 무기를 쓰지 않고 맨손으로 치면 true (주먹·멱살·밀치기). 무기 보정·탄·내구도를 쓰지 않는다 (12-256)"),
        distance: z
          .string()
          .nullable()
          .default(null)
          .describe(
            s.gear?.distances?.length
              ? `장면의 인물을 칠 때(target_harm) 반드시 고르는 상대와의 거리: ${s.gear.distances.map((d) => `${d.id} ${d.label}`).join(", ")}. 무기마다 닿는 거리와 보정이 다르다 (근접은 맞붙어야 한다). 숨거나 몰래 지나갈 때(stealth)도 그 상대와의 거리를 고른다 (멀면 쉽고 맞붙으면 어렵다). 둘 다 아니면 null`
              : "이 월드에서는 쓰지 않는다. null",
          ),
        opponent: z
          .string()
          .nullable()
          .default(null)
          .describe(
            "맞서는 상대 인물 id (장면에 있어야 한다): 숨는 나를 찾는 사람, 덤벼드는 사람, 속이려는 상대. 공격이면 비워도 target이 상대다 (설득처럼 함께하는 말은 target만으로 상대가 되지 않는다. 맞서는 흥정이면 여기에 둔다. 동행·분대 같은 내 편은 target이어도 상대가 아니다: 함께 숨은 동료·구해 줄 사람이 아니라 맞서는 쪽을 여기에). " +
              "상대의 실력, 지켜보는 눈의 수, 어둠은 시스템이 판정 보정으로 바꾸므로 난이도에 넣지 않는다. 판정이 나빠 다치면 이 상대의 솜씨가 피해에 붙는다. 없으면 null",
          ),
        infected_source: z
          .boolean()
          .default(false)
          .describe("그 위험이 감염체에게 물리거나 긁히는 것이면 true. 장면의 감염체를 opponent·target으로 두면 시스템이 저절로 켠다. 다치면 시스템이 감염 여부를 정한다 (캐릭터는 바로 알지 못한다)"),
      })
      .nullable()
      .default(null)
      .describe("결과가 불확실하고 실패하면 대가가 있는 행동일 때만. 사소하거나 확실한 행동은 null"),
    activity: z
      .strictObject({
        kind: activitySchema.exclude(["travel", "combat"]).describe(
          "brief 잠깐의 행동, talk 대화, eat 식사, treat 응급처치, search 수색, work 작업·정비, rest 휴식, guard_duty 보초, sleep 잠, wait 기다림",
        ),
        until: timeSegmentSchema.nullable().default(null).describe("sleep·wait·rest·guard_duty·treat 전용: 이 시간대가 시작될 때까지. 다른 활동은 null. 임무 보초는 until·hours 없이 걸면 임무에 남은 시간만큼 선다"),
        hours: z.number().min(0.5).max(12).multipleOf(0.5).nullable().default(null).describe("sleep·wait·rest·guard_duty·treat·work: 몇 시간 할지 (0.5 단위, until 대신). 없으면 null"),
      })
      .nullable()
      .default(null)
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
      .default(null)
      .describe("남들이 알면 평판이 달라질 행동일 때만. 이미 기록된 행적은 다시 넣지 않는다"),
    target: z.string().nullable().default(null).describe("행동의 상대 인물 id (장면에 있어야 한다). 없으면 null"),
    ignore_story: z
      .boolean()
      .default(false)
      .describe("진행 중인 이야기를 고르지 않고 외면할 때 true (플레이어가 그 일을 모른 척하기로 했을 때만). 효과 없이 지나간다. 이야기가 열려 있으면 자리를 옮기거나 시간을 들이는 일에 이것이 있어야 한다 (옮기면 떠나는 선택지로 푼다). 대부분 false"),
    provoked: z
      .boolean()
      .default(false)
      .describe(
        s.persona?.blowup
          ? "이번 턴에 누군가 주인공을 도발·모욕·조롱했으면 true (그 사람을 target으로). 성격(다혈질)에 따라 발끈할지는 시스템이 정한다. 대부분 false"
          : "이 월드에서는 쓰지 않는다. false",
      ),
    fright: z
      .enum(["none", "startle", "dread"])
      .default("none")
      .describe(
        s.body?.fear
          ? "이번 턴에 플레이어 캐릭터가 겁먹을 일이 드러났는데 이야기·인물 데이터로 잡히지 않는 순간일 때만: startle 깜짝 놀람(기습, 갑자기 튀어나옴), dread 압도됨(떼, 끔찍한 광경). 오를지·얼마나는 시스템이 정한다. 무서운 것을 장면에 들여(spawn_extra·npc_presence) 이미 공포가 올랐으면 고르지 않는다 (같은 순간에는 다시 오르지 않는다). 대부분 none"
          : "이 월드에서는 쓰지 않는다. none",
      ),
    fright_tags: z
      .array(z.string())
      .max(4)
      .default([])
      .describe(
        s.body?.fear
          ? `이번 턴 장면에 있는 것 중 공포를 부를 수 있는 것 (이야기·인물 데이터에 없는 즉흥 장면일 때만): ${fearTagIds(s).join(", ")}. 공포증이 있는 캐릭터는 fright가 none이어도 겁먹는다. 시스템이 정한다. 없으면 빈 목록`
          : "이 월드에서는 쓰지 않는다. 빈 목록",
      ),
    move_to: z
      .string()
      .nullable()
      .default(null)
      .describe("이번 턴에 인접한 다른 구역으로 옮겨 가면 그 구역 id (상태의 인접 구역 목록). 이동에 30~60분이 든다. 전투 중에는 쓸 수 없다. 아니면 null"),
    against_setting: z
      .string()
      .nullable()
      .default(null)
      .describe("이 행동이 주인공의 설정(이상·금기·결점)을 거스르면 그 설정 id. 먼저 서술로 확인하고(\"복종을 신념으로 가진 ○○은 이 선택이 마음에 걸린다. 정말 이렇게 해야 할까?\") 플레이어가 그래도 하겠다고 할 때만 넣는다. 시스템이 정신력으로 굴린다. 아니면 null"),
    place_to: z
      .string()
      .nullable()
      .default(null)
      .describe(`이번 턴에 같은 구역 안의 다른 장소로 옮기면 그 장소 id (상태의 '이 구역의 장소', 즉흥 장소는 spawn_place로 만든 id). 주인공이 모르는 곳은 상태의 '문1'처럼 문 번호로 (들어서면 그곳을 안다). 구역 밖으로 나가는 길(road)도 장소다. 이웃 장소는 5분, 한 칸 더 멀 때마다 5분. 구역을 옮기는 move_to와 함께 쓰지 않는다. 아니면 null`),
    with: z
      .array(z.string())
      .default([])
      .describe("이번 행동을 함께하는 장면의 인물 id (같이 숨는 사람, 같이 싸우는 사람, 업거나 부축해 데려가는 사람, 같이 걷는 사람). target은 행동을 하는 대상이고, with는 곁에서 함께하는 사람이다. with의 사람은 맞서는 상대가 되지 않고, 그 일을 잘하면 판정을 돕고(+1, 한 사람), place_to와 함께면 같이 옮겨 간다. 동행·분대는 넣지 않아도 내 편이다. 아니면 []"),
    prepare: z
      .string()
      .nullable()
      .default(null)
      .describe(
        `전투에 대비해 지금 구역(우리 땅)에 준비물을 설치하면 그 id. ${(s.battle?.preparations ?? []).map((p) => `${p.id} ${p.label}(${p.description}${Object.keys(p.materials ?? {}).length ? `; 재료 ${Object.entries(p.materials!).map(([id, n]) => `${id}×${n}`).join("·")}` : ""})`).join(", ") || "없음"}. 판정(check)이 필요하고, 성공·대가 있는 성공이면 설치된다. 아니면 null`,
      ),
    use_item: z
      .string()
      .nullable()
      .default(null)
      .describe("몸 상태가 나아지는 물건을 쓰면 그 아이템 id (먹을 것, 구급상자, 약 등. 가진 것만). 효과는 시스템이 정한다. 아니면 null"),
    ride: z
      .string()
      .nullable()
      .default(null)
      .describe("move_to와 함께: 타고 가는 이동 수단 (가진 아이템 id, 자전거·오토바이 등). 빨라지는 정도·연료·소음은 시스템이 정한다. 함께 걷는 사람이 있으면 그 걸음에 맞춘다. 걸으면 null"),
    forage: z
      .string()
      .nullable()
      .default(null)
      .describe(
        `먹을 것을 구하면 그 일의 id: ${(s.foraging?.kinds ?? []).map((k) => `${k.id} ${k.label}${k.water ? "(물가에서)" : "(거점 밖에서)"} 판정 ${k.move ?? s.foraging?.move ?? "생존"}`).join(", ") || "없음"}. 그 판정을 걸면 결과만큼 잡힌다 (판정 없으면 덜). 무엇을 얼마나 얻는지는 시스템이 정한다. 아니면 null`,
      ),
    trap: z
      .enum(["set", "check"])
      .nullable()
      .default(null)
      .describe("덫을 놓으면 set (철사 같은 덫 재료가 있어야 한다), 이 구역에 놓아 둔 덫을 거두면 check. 걸리는 것은 하루가 지날 때 시스템이 정한다. 아니면 null"),
    bury: z
      .strictObject({
        who: z.string().describe("상태의 '묻히지 않은 유해' 줄의 from= 뒤 id"),
        words: z.string().max(60).nullable().describe("묘비에 새길 짧은 말 (플레이어가 정했으면 그대로, 아니면 null). 주인공이었던 사람은 연대기의 묘비명을 쓴다"),
      })
      .nullable()
      .default(null)
      .describe("이 구역의 유해를 묻는다 (두 시간 작업). 같은 무리 사람이면 사기·지켜본 사람의 호감은 시스템이 정한다. 아니면 null"),
    drink: z
      .boolean()
      .default(false)
      .describe("물이 있는 곳(상태의 \"물\" 줄)에서 플레이어가 물을 마시겠다고 하면 true. 얼마나 풀리는지, 거점에서 보급을 받는지는 시스템이 정한다"),
    wade: z
      .boolean()
      .default(false)
      .describe("개천·강가처럼 물이 나는 바깥 물가에서 물에 들어가면(헤엄, 옷 입은 채 뛰어듦) true. 옷이 흠뻑 젖는다 (12-255)"),
    change_clothes: z
      .boolean()
      .default(false)
      .describe("젖은 옷을 마른 옷으로 갈아입으면 true (12-186). 갈아입을 옷이 있는 곳(우리 무리의 거점, 내 거처, 옷이 남은 곳)에서만. 곁의 사람도 함께 갈아입는다. 장비 칸을 바꾸는 equip과는 다르다"),
    refill: z
      .boolean()
      .default(false)
      .describe("물이 있는 곳에서 플레이어가 빈 물병을 채우겠다고(거점이면 물 보급을 받겠다고) 하면 true. 거점 보급은 마시기까지 한다. 저절로 채워지지 않는다"),
    treatment: z
      .strictObject({
        item: z.string().nullable().describe("치료에 쓸 아이템 id (구급상자 등). 장면에 있는 치료사에게 받거나, 다른 사람을 아이템 없이 돌보면 null"),
        healer: z.string().nullable().default(null).describe("치료사를 고를 때 그 치료사 id (장면에 있어야 한다). null이면 코드가 고른다: 수술감이면 수술할 줄 아는 사람, 아니면 솜씨 좋은 사람"),
        target: z
          .string()
          .nullable()
          .default(null)
          .describe("다른 사람을 치료하면 그 사람 id (장면에 있어야 한다. 아이템 없이는 의무병이나 응급처치를 익힌 사람만. 피만 멎게 하는 맨손 지혈은 누구나: check move를 응급처치로 함께). 주인공 자신이면 null"),
        pay: z
          .union([z.literal("auto"), z.array(z.strictObject({ item: z.string(), quantity: z.number().int() }))])
          .nullable()
          .default(null)
          .describe("치료사가 값을 받을 때 낼 물건: null이면 정해 둔 것을 보여 주고 거절된다(시간은 흐르지 않는다), \"auto\"면 그대로 내고, [{item, quantity}]면 플레이어가 고른 것을 낸다"),
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
    build: z
      .string()
      .nullable()
      .default(null)
      .describe("시설을 지으면 (12-167): 상태의 '지을 수 있는 시설' id. 판정(check: 그 시설의 move)이 필요하고, 재료·시간·결과는 시스템이 정한다. 아니면 null"),
    ambush: z
      .boolean()
      .default(false)
      .describe("이 구역에 자리를 잡고 매복하면 true (12-177, 플레이어가 숨어 기다렸다 치겠다고 할 때만). 판정(check: 은밀)이 필요하고 어렵게 굴린다. 기다리려면 activity wait를 함께"),
    broadcast: z
      .boolean()
      .default(false)
      .describe("무전기로 열린 주파수에 송출하면 true (12-173, 플레이어가 무전으로 부르겠다고 할 때만). 30분, 하루 한 번. 누가 응답하는지는 시스템이 정한다"),
    train: z
      .strictObject({ companion: z.string().describe("곁에 있는 동물 id (동행 줄)"), trick: z.string().describe("동행 줄의 '가르칠 수 있는 재주' id") })
      .nullable()
      .default(null)
      .describe("곁의 동물에게 재주를 가르치면 (12-172). 판정(check: 그 재주의 move)이 필요하고, 결과는 시스템이 정한다. 동물마다 하루 한 번. 아니면 null"),
    lesson: z
      .strictObject({ teacher: z.string().describe("가르치는 사람 id (장면에 있어야 한다)"), skill: z.string().describe("배울 전문 기술 id") })
      .nullable()
      .default(null)
      .describe(
        "전문 기술을 사람에게 배우면 (4.2.1, 플레이어가 배우겠다고 할 때만). 판정 없이 시간(작업)이 들고, 채운 시간과 값은 시스템이 센다. 다 채우면 배운다. 아니면 null",
      ),
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
      .default(false)
      .describe("수행 중인 임무를 위한 행동이면 true. 임무의 요건과 맞는 행동(그 판정·그 활동·이동)을 임무 장소에서 하면 넣지 않아도 저절로 센다. 임무 장소 밖이면 true일 때 거절된다"),
    narration_summary: z
      .string()
      .max(1000)
      .nullable()
      .default(null)
      .describe("MCP 모드 전용: 직전 턴에 서술한 내용의 짧은 요약. 일지에 쌓이므로 평서체(~했다)로 쓴다. 웹 앱 모드에서는 null (시스템이 자동 저장)"),
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

/** 이야기를 두고 떠날 때 고른 것으로 치는 선택지 (판정 없는 것만) */
// 플레이 테스트 11: 외면하는 선택지 이름이 여럿이라 많은 이야기가 결과 없이 사라졌다 (무기고의 빈 자리의 say_nothing 등)
// 플레이 테스트 12: 말로 거절하는 것(refuse·decline)은 외면이 아니라 태도라 뺀다 (파이프를 내려놓는 선택지를 대신 골라 관계가 바뀌었다)
const WALK_AWAY_CHOICES = ["leave", "ignore", "look_away", "pass", "walk_away", "move_on", "let_go", "turn_away", "walk_on", "leave_it", "let_be", "say_nothing", "silent", "nothing", "shrug", "later", "hold_back", "stay_out", "not_now", "stay_silent", "back_off", "away"];

/** 같은 구역 안의 장소를 옮기는 데 드는 시간 (분, 12-244) */
export const PLACE_MOVE_MINUTES = 5;

/**
 * 같은 구역 안의 장소로 옮긴다 (공통 규칙 15). along: 동행 말고 함께 가는 장면의 인물 (comesAlong).
 * 바닥의 물건은 장소마다 남는다. 돌려줄 한 줄
 */
function movePlace(ctx: ToolContext, to: Place | null, along: string[], involved: readonly string[] = [], pending: readonly string[] = []): string {
  const { store, content } = ctx;
  const s0 = store.getState();
  const from = currentPlace(s0, content)?.id ?? null;
  const ground = Object.keys(s0.scene.items).length > 0;
  // 판정이 정할 사람(물러나는 상대·이야기 배역)은 판정 뒤에 "떨쳐 냈다·쫓아왔다"로 알린다 (PT23 분대장: "남았다"와 "쫓아왔다"가 함께 나왔다)
  const left = s0.scene.present.filter((id) => !along.includes(id) && !s0.companions.includes(id) && !pending.includes(id));
  // 동행은 먼저 동행으로 적는다 (12-261, PT16 분대장: follow로 붙인 분대원을 "가던 참이라 같이 왔다"로 적었다)
  const mates = s0.scene.present.filter((id) => s0.companions.includes(id));
  // 그곳에 있을 사람이라 같이 온 사람과 이번 행동으로 데려온 사람을 나눠 적는다 (PT15 졸병: target이 없는데 "함께 왔다: 강태호")
  const bound = along.filter((id) => !involved.includes(id) && !s0.companions.includes(id));
  // 모르던 곳에 들어서면 그곳이 무엇인지 알게 된다 (설계 목록 C-1)
  const fresh = !!to && !knowsPlace(s0, content, s0.playerZone, to.id);
  movePlayer(ctx, { zone: s0.playerZone!, place: to?.id ?? null }, "walk", { with: along });
  // 이웃 장소 5분, 한 칸 더 멀 때마다 5분 (장소 개편)
  const steps = stepsBetween(s0, content, from, to?.id ?? null);
  const minutes = PLACE_MOVE_MINUTES * (Number.isFinite(steps) ? Math.max(1, steps) : 1);
  store.append({ type: "time_advanced", activity: "brief", from: store.getState().time, to: store.getState().time + minutes });
  const s = store.getState();
  const calls = (ids: string[]) => ids.map((id) => `${playerCalls(s, content, id)}(${id})`).join(", ");
  const people = to ? peopleAt(s, content, s.playerZone, to.id) : [];
  const where = to ? `${josa(to.name, "으로/로")} 옮겼다 (${to.indoor ? "실내" : "바깥"}${to.road ? ", 길" : ""}, ${minutes}분).` : `옮겼다 (${minutes}분).`;
  return [
    where,
    fresh && to ? `처음 들어선 곳이다: ${to.id} ${to.name}${to.description ? ` (${to.description})` : ""}. 이제 이곳을 안다.` : "",
    mates.length ? `동행도 함께 왔다: ${calls(mates)}.` : "",
    along.some((id) => !bound.includes(id) && !s0.companions.includes(id)) ? `함께 왔다: ${calls(along.filter((id) => !bound.includes(id) && !s0.companions.includes(id)))}.` : "",
    bound.length ? `${calls(bound)}도 그곳으로 가던 참이라 같이 왔다.` : "",
    left.length ? `원래 자리에 남았다: ${calls(left)} (함께 데려가려면 with).` : "",
    // 막 들어선 자리에 둔 물건은 그 자리에 남는다 (돌아갈 수 있게 알린다)
    ground && from ? `바닥에 둔 물건은 그 자리에 남았다 (다시 가려면 place_to: ${from}).` : "",
    people.length ? `지금 이곳에 있을 사람: ${calls(people)} (장면에 들이려면 npc_presence).` : "",
  ].filter(Boolean).join(" ");
}

export function takeAction(input: TakeActionInput, ctx: ToolContext): TakeActionResult {
  // 연습 대련 이야기의 판정이면 방어구·무기가 닳지 않는다 (플레이 테스트 13)
  const a = ctx.store.getState().activeStorylet;
  const s = a ? storyletOf(ctx.store.getState(), ctx.content, a.id) : undefined;
  const practice = !!s?.practice && !!input.check && s.choices.some((c) => c.check === input.check!.move);
  const before = ctx.store.getState();
  const result = withoutWear(practice, () => takeActionInner(input, ctx));
  if (result.ok) settleDeeds(ctx, before);
  return result;
}

/**
 * 이번 행동이 남긴 주인공의 짓에 끝난 때와 가져온 물건을 적는다 (설계 목록 2-1·2-4): 규율 회의는 끝난 때부터 세고,
 * 도둑질(시나리오 offense의 theft 등)로 소지품에 새로 들어온 물건은 벌을 받아들이면 돌려놓는다
 */
function settleDeeds(ctx: ToolContext, before: GameState): void {
  const now = ctx.store.getState();
  const fresh = Object.values(now.deeds).filter((d) => d.actorId === now.playerId && !before.deeds[d.id] && !d.fabricatedBy);
  if (!fresh.length) return;
  const offense = new Set<string>(ctx.content.scenario.offense?.tags ?? []);
  const was = before.characters[before.playerId]?.inventory ?? {};
  const is = now.characters[now.playerId]?.inventory ?? {};
  const gained = Object.fromEntries(Object.entries(is).map(([id, q]) => [id, q - (was[id] ?? 0)] as const).filter(([, d]) => d > 0));
  for (const d of fresh) {
    const theft = d.tags.some((t) => offense.has(t) && t === "theft");
    ctx.store.append({ type: "deed_settled", deedId: d.id, endedAt: now.time, ...(theft && Object.keys(gained).length ? { items: gained } : {}) });
  }
}

/**
 * 숨은 목격자 안내: 이 장소에 있을 사람(장면에 들이지 않은)이 있으면 그 사람들이 봤을 수 있다고 알린다
 * (PT27 졸병·섬: "장면에 아무도 없었다"인데 같은 장소의 사람이 보고 규율 회의가 열렸다)
 */
function hiddenWitnessHint(state: GameState, content: ToolContext["content"]): string {
  const here = currentPlace(state, content);
  const around = here ? peopleAt(state, content, state.playerZone, here.id).length : 0;
  return around > 0 ? " 이곳에 있을 사람(장면에 들이지 않은)이 눈치챘을 수 있다. 누가 봤는지는 아무도 모른다." : " 숨은 목격자가 있었는지는 아무도 모른다.";
}

/** 이번 행동이 남긴 주인공의 짓 가운데 끝난 때가 없는 것에 지금을 적는다 (가져온 물건은 settleDeeds가 행동 끝에) */
function markDeedsEnded(ctx: ToolContext, before: GameState): void {
  const now = ctx.store.getState();
  for (const d of Object.values(now.deeds)) {
    if (d.actorId === now.playerId && !before.deeds[d.id] && !d.fabricatedBy && d.endedAt === undefined) ctx.store.append({ type: "deed_settled", deedId: d.id, endedAt: now.time });
  }
}

function takeActionInner(input: TakeActionInput, ctx: ToolContext): TakeActionResult {
  let ignoredLine: string | null = null;
  const { store, content } = ctx;
  const scenario = content.scenario;
  const start = store.getState();
  const player = start.characters[start.playerId];
  if (!player) return { ok: false, error: "플레이어 캐릭터가 없습니다." };
  if (player.dead) return { ok: false, error: "캐릭터가 사망했습니다." };
  // 마시기·채우기는 지금 있는 곳의 물로 한다: 이동과 함께 오면 출발지에서 물을 찾았다 (플레이 테스트 11)
  // 적 땅에서는 길에서만 구역을 떠난다 (PT20 분대장: 달아난 뒤 적 거점 지휘소에서 곧장 구역을 떠났다). 갇힌 채 달아나는 탈출·전투·잠입은 그 장치가 맡는다
  if (input.move_to && !heldOf(player) && !start.battle && !start.infiltration && hostileHere(ctx)) {
    const here = currentPlace(start, content);
    if (here && !here.road) {
      const road = nearestRoad(start, content);
      return { ok: false, error: `적 땅에서는 길로 나가야 구역을 떠날 수 있다. 먼저 place_to로 ${road ? `${placeById(start, content, road)?.name ?? road}(${road}) 쪽으로` : "길로"} 나간다 (적 땅은 이웃 장소로 한 칸씩, 시간은 흐르지 않았다).` };
    }
  }
  if (input.move_to && input.refill) return { ok: false, error: "이동과 물 채우기는 한 번에 하지 않는다. 먼저 옮긴 뒤, 도착한 곳에서 refill을 따로 한다 (시간은 흐르지 않았다)." };
  // 진행 중인 이야기를 두고 떠나거나 오래 머물면 결과 없이 사라졌다 (플레이 테스트 11: 깔린 동료를 두고 갔는데 아무 일 없었다).
  // 외면하는 선택지(leave·ignore 등, 판정 없는 것)가 있으면 그것을 고른 것으로 풀고, 없으면 지나갔다고 분명히 알린다
  // 수색·일·쉬기는 이야기 안에서도 하는 일이라 넣지 않는다 (선택지의 판정을 거기서 굴린다)
  const long = !!input.move_to || (!!input.activity && ["sleep", "wait", "guard_duty", "travel"].includes(input.activity.kind));
  // 같은 자리에서 오래 걸리는 일은 이야기를 두고 하지 않는다: 시간이 흐르기 전에 먼저 고르거나 외면하라고 돌려보낸다 (플레이 테스트 13: 망을 봤는데 "혼자 빠져나온다"를 고른 것이 됐다)
  // 스스로 못 움직이면(부상·열병으로 의식을 잃음) 시간만 흐른다: 막지 않는다 (12-245: 의식불명인 채 기다리기가 막혔다)
  // 자리를 옮기는 것도 같다 (12-240, A1: 이야기가 열린 결과 뒤 같은 턴에 묶어 보낸 이동이 이야기를 외면한 것으로 처리됐다). 판정을 건 행동(맞서기·달아나기)은 이야기 안의 일이다
  // 스스로 움직일 수 없을 때(의식불명)만 막지 않는다. 중상(무력화 문턱)은 걷고 싸우므로 막는다 (12-292, PT24 분대장·섬: 중상이면 이야기를 두고 떠나도 말없이 사라졌다).
  // 구역 이동(move_to)은 판정을 붙여도 막는다: 판정 걸고 물러나기는 place_to다 (PT24 졸병: 깔린 동료를 두고 은밀 판정 이동으로 떠났는데 외면 결과가 없었다)
  // 매복(몸이 붙들린 이야기)은 판정을 걸고 뿌리쳐 달아나는 것이 이야기 안의 일이다: 막지 않는다 (12-302: 아래 매복 규칙은 ignore_story를 막고 이 규칙은 move_to를 막아 달아날 길이 없었다)
  const ambushEscape = !!input.move_to && !!input.check && !!start.activeStorylet && !!storyletOf(start, content, start.activeStorylet.id)?.ambush;
  // 판정을 건 행동이 이야기 안의 일인 것은 그 이야기 선택지의 스킬이거나 판정을 걸고 물러나는 것(place_to)일 때만 (12-305, PT29 튜토리얼:
  // 우는 아이를 버스에 둔 채 수색 판정으로 1시간 30분을 뒤졌다)
  const openStory = start.activeStorylet ? storyletOf(start, content, start.activeStorylet.id) : undefined;
  const storyChoiceCheck = !!input.check && (!!input.place_to || !!openStory?.choices.some((c) => c.check === input.check!.move));
  if (start.activeStorylet && !ambushEscape && (!storyChoiceCheck || !!input.move_to) && !input.ignore_story && (!!input.move_to || !!input.place_to || (!!input.activity && ["sleep", "wait", "guard_duty", "rest", "search", "work", "treat"].includes(input.activity.kind))) && !incapacitatingSymptom(scenario, player) && !heldOf(player)) {
    const s0 = storyletOf(start, content, start.activeStorylet.id);
    const openTitle = s0 ? storyTitle(start, ctx.content, s0) : start.activeStorylet.id;
    return { ok: false, error: `이야기 "${openTitle}"${josa(openTitle, "이/가").slice(openTitle.length)} 열려 있다. 먼저 장면으로 연출하고 플레이어의 선택을 받는다: resolve_storylet으로 고르거나, 플레이어가 두고 다른 일(자리 옮기기 포함)을 하기로 했으면 ignore_story: true를 함께 넣는다 (시간은 흐르지 않았다).` };
  }
  // 위협 앞에서는 오래 걸리는 일을 하지 않는다 (공통 규칙 4, 플레이 테스트 13: 감염체가 곁에 남은 채 두 시간을 뒤졌다)
  // 스스로 못 움직이면 (쓰러져 있으면) 시간만 흐른다: 막지 않는다
  if (!input.move_to && !!input.activity && LONG_IN_THREAT.includes(input.activity.kind) && !isIncapacitated(content, player) && !incapacitatingSymptom(scenario, player) && situationOf(start, content) === "threatened") {
    const near = threatInScene(start, content).map((id) => `${playerCalls(start, content, id)}(${id})`).join(", ");
    return { ok: false, error: `곁에 위협이 있다: ${near}. 오래 걸리는 일(${input.activity.kind})을 하기 전에 먼저 맞서거나(target) 피한다(move_to + 판정) (시간은 흐르지 않았다).` };
  }
  // 몸이 붙들린 매복은 걸어서 벗어날 수 없다 (플레이 테스트 13: "차 밑의 손"이 이동 한 번으로 대가 없이 닫혔다)
  if (start.activeStorylet && ((input.move_to && !input.check) || input.ignore_story) && !heldOf(player) && storyletOf(start, content, start.activeStorylet.id)?.ambush && !isIncapacitated(ctx.content, player)) {
    return { ok: false, error: "매복에 걸려 붙들려 있다. 그냥 걸어 나갈 수 없다: resolve_storylet으로 고르거나, 뿌리치고 달아나려면 move_to와 함께 check(달아나기·맞서기 판정과 위험)를 건다 (시간은 흐르지 않았다)." };
  }
  // 외면 (플레이 테스트 13): 효과 없이 지나간다. 자리를 옮기며 외면하면 아래에서 떠나는 선택지로 푼다
  if (start.activeStorylet && input.ignore_story && !input.move_to) {
    const s0 = storyletOf(start, content, start.activeStorylet.id);
    endActiveStorylet(ctx, "외면했다");
    const title = s0 ? storyTitle(start, ctx.content, s0) : start.activeStorylet.id;
    // 아래 leftLines보다 먼저 정해지므로 따로 담아 둔다
    ignoredLine = `이야기 "${title}"${josa(title, "을/를").slice(title.length)} 모른 척했다. 그 일은 그대로 지나갔다 (이야기 속 사람들은 그것을 기억할 수 있다).`;
  }
  // 길 위의 일은 도착하기 전의 장면이다: 판정 없이 다른 일을 하면 길에서 두고 온 것으로 친다 (플레이 테스트 11: 붉은연합 순찰조원이 우리 거점 장면에 남아 목격자가 됐다)
  const roadTag = scenario.travel?.tag;
  // 판정을 걸어도 길 위 장면과 상관없는 긴 일(수색·일 등)이면 두고 온 것이다 (플레이 테스트 12: 매복자가 장면에 남은 채 역 안을 두 시간 뒤졌다)
  // 길 위 장면을 둔 채 구역 안 다른 장소로 옮겨도 두고 온 것이다 (PT22 하얀매: "벌어지는 상처"가 치료실에서 풀렸다)
  const onRoad = !!roadTag && !!start.activeStorylet && !!storyletOf(start, content, start.activeStorylet.id)?.tags.includes(roadTag) && ((!input.check && !!input.deed) || (!!input.activity && !["talk", "brief"].includes(input.activity.kind)) || (input.place_to !== null && !input.check));
  const leftLines: string[] = [];
  // 갇힌 채 옮겨 가기(탈출)는 자리를 뜨는 것이 아니다: 실패하면 그대로, 성공하면 옮겨 갈 때 닫힌다 (플레이 테스트 13: 실패한 탈출이 포섭 이야기를 닫았다)
  const escaping = !!input.move_to && !!heldOf(player);
  if (ignoredLine) leftLines.push(ignoredLine);
  // 자리를 뜨는 것(옮겨 가기)과 길 위 장면을 두고 하는 일만 외면 선택지로 푼다
  if (store.getState().activeStorylet && (!!input.move_to || onRoad) && !escaping && !incapacitatingSymptom(scenario, player)) leftLines.push(...walkAwayFromStory(ctx, start));
  // 혼란은 그 자리의 일이다: 자리를 옮기거나 오래 쉬면 가신다 (플레이 테스트 11: 매복의 혼란이 14시간 잠 뒤 판정에 붙었다)
  if (long && isConfused(start, start.playerId)) store.append({ type: "confusion_changed", characterId: start.playerId, on: false });
  // 잠입 중 (12-154): 옮기거나 오래 머물지 않는다. 잠입은 infiltrate로 (빠지기부터)
  if (start.infiltration && (input.move_to || (input.activity && ["sleep", "rest", "wait", "guard_duty", "search", "work"].includes(input.activity.kind)))) {
    return { ok: false, error: "잠입 중이다. 옮기거나 오래 머물려면 먼저 infiltrate leave로 빠져나온다." };
  }
  // 의식불명 등: 스스로 아무것도 하지 못한다. 시간이 흐르게 하거나(기다림·잠·휴식) 남이 돌보는(treatment, 치료사에게 받기) 것만
  const out = incapacitatingSymptom(scenario, player);
  if (out) {
    const acts = !!input.check || !!input.move_to || !!input.target || !!input.prepare || !!input.use_item || !!input.bury || !!input.forage || !!input.trap || input.drink || input.refill || input.wade || input.change_clothes || !!input.craft || !!input.build || !!input.train || !!input.lesson || input.broadcast || input.ambush || !!input.battle || !!input.deed || (input.treatment && (input.treatment.item || input.treatment.target));
    const passive = !input.activity || ["wait", "sleep", "rest"].includes(input.activity.kind);
    if (acts || !passive) {
      return {
        ok: false,
        error: `${josa(player.name, "은/는")} ${out.label} 상태라 스스로 아무것도 할 수 없다. 판정·이동·말·물건 쓰기 없이 activity(wait 또는 sleep, 전투 중이면 null)로 시간만 흐르게 한다. 장면의 치료사가 돌보면 treatment {item: null}. 서술은 흐릿한 감각의 조각만 짧게.`,
      };
    }
  }
  // 옮겨 가는 장소에 있을 사람은 옮긴 뒤 장면에 들인다 (12-261, 공통 규칙 15. PT16 세 판: "막사로 가서 한태경에게"가 "장면에 없다")
  const atDest = (id: string) => {
    if (input.place_to === null || start.characters[id]?.dead) return false;
    const w = whereIs(start, content, id);
    return !!w && w.zone === start.playerZone && w.place === input.place_to;
  };
  // 옮겨 가는 장소의 치료사도 (12-262, PT17 분대장·졸병: place_to와 치료를 한 턴에 하면 치료사를 못 찾았다)
  // 치료할 사람을 target으로 두면 그 사람이 치료한다 (PT20 의무병: target으로 청한 권정숙 대신 다른 치료사가 치료했다)
  const chosenHealer = input.treatment ? (input.treatment.healer ?? (input.target && content.npcs[input.target]?.healer ? input.target : null)) : null;
  const destHealers = input.treatment && !input.treatment.item && input.place_to ? healersHere(ctx, chosenHealer, (id) => !start.scene.present.includes(id) && atDest(id)) : [];
  // with로 함께할 사람도 옮겨 가는 장소에 있으면 들인다 (12-268, PT18 섬: target은 되는데 with는 "장면에 없다")
  const arriving = [input.target, input.check?.opponent, ...input.with, ...destHealers].filter((id): id is string => !!id && !start.scene.present.includes(id) && atDest(id));
  if (input.target && !start.scene.present.includes(input.target) && !arriving.includes(input.target)) {
    // 호칭으로 (플레이 테스트 12: 오류 문구에 id가 나왔다). id는 괄호로 함께 둬 GM이 고칠 수 있게
    const who = start.characters[input.target] ? `${playerCalls(start, content, input.target)}(${input.target})` : input.target;
    const where = whereLabel(start, content, input.target);
    return { ok: false, error: `${josa(who, "은/는")} 지금 장면에 없다${input.place_to ? ` (옮겨 가는 곳에도 없다${where ? `. 지금 ${where}` : ""})` : ""}. 먼저 npc_presence로 들이거나 그 사람이 있는 곳으로 간다 (시간은 흐르지 않았다).` };
  }
  if (input.activity) {
    const cost = ACTIVITY_COSTS[input.activity.kind];
    // 이미 그 시간대인데 기다리면 다음 날 그 시간대까지 간다 (플레이 테스트 12: 낮에 "낮까지" 기다려 12시간을 보냈다)
    if (["wait", "rest", "guard_duty"].includes(input.activity.kind) && input.activity.until && segmentOf(start.time) === input.activity.until) {
      return { ok: false, error: `이미 ${SEGMENT_LABELS[input.activity.until]}이다. 기다림은 다음 시간대까지로 정한다 (지금 그대로 두면 하루를 넘긴다). 몇 시간만 하려면 until 대신 hours.` };
    }
    if (input.activity.until && !(cost.kind === "long" && cost.allowUntil)) {
      return { ok: false, error: `${input.activity.kind}에는 until을 쓸 수 없다. null을 넣는다.${HOURS_ACTIVITIES.includes(input.activity.kind) ? " 길이를 정하려면 hours." : ""}` };
    }
    if (input.activity.hours && !HOURS_ACTIVITIES.includes(input.activity.kind)) {
      return { ok: false, error: `${input.activity.kind}에는 hours를 쓸 수 없다 (정해진 길이다). null을 넣는다.` };
    }
    if (input.activity.hours && input.activity.until) return { ok: false, error: "until과 hours는 하나만 쓴다." };
  }

  // 전투·이동·준비 검사 (기획서 9.5)
  const inBattle = start.battle !== null;
  // 물건 (기획서 4.8): 공격은 손에 든 무기로, 탄약이 있어야 쏜다. 제작·수리는 재료와 판정. 너무 무거우면 옮겨 가지 못한다
  const gearRules = content.scenario.gear;
  const attacking = !!input.check && !!gearRules && ((!!input.target && input.check.target_harm !== "none") || (inBattle && gearRules.attack_moves.includes(input.check.move)));
  // 맨손으로 치면 손에 든 무기는 이 판정에 쓰지 않는다 (12-256, PT15 졸병: 주먹을 날렸는데 "+1(야구방망이)")
  const fighter = input.check?.unarmed ? { ...player, equipped: { ...player.equipped, weapon: null } } : player;
  const attack = attacking ? planAttack(content, fighter, input.check!.move, input.check!.target_harm) : null;
  if (typeof attack === "string") return { ok: false, error: attack };
  // 사거리 (12-93): 장면의 인물을 치면 거리를 고르고, 무기가 닿는 거리여야 한다. 전투 라운드의 공격은 거리를 고르면 보정만
  const strikes = !!input.check && !!input.target && input.check.target_harm !== "none";
  if (input.check && (strikes || input.check.distance)) {
    const far = rangeProblem(content, fighter, input.check.move, input.check.distance);
    if (far) return { ok: false, error: far };
  }
  if (input.build) {
    if (!input.check) return { ok: false, error: "시설을 지으려면 판정(check)이 필요하다." };
    const why = planBuild(content, store.getState(), player, input.build, input.check.move);
    if (why) return { ok: false, error: why };
  }
  if (input.ambush) {
    if (!input.check) return { ok: false, error: "매복하려면 판정(check)이 필요하다." };
    const why = planAmbush(content, store.getState(), input.check.move);
    if (why) return { ok: false, error: why };
  }
  if (input.broadcast) {
    const why = planBroadcast(content, store.getState());
    if (why) return { ok: false, error: why };
  }
  if (input.train) {
    if (!input.check) return { ok: false, error: "재주를 가르치려면 판정(check)이 필요하다." };
    const why = planTrain(content, store.getState(), input.train, input.check.move);
    if (why) return { ok: false, error: why };
  }
  if (input.lesson) {
    if (input.check) return { ok: false, error: "배우기에는 판정이 없다. check는 null로 둔다." };
    const why = planLesson(ctx, input.lesson);
    if (why) return { ok: false, error: why };
  }
  if (input.craft) {
    if (!input.check) return { ok: false, error: "만들거나 고치려면 판정(check)이 필요하다." };
    const why = planCraft(content, player, input.craft, input.check.move);
    if (why) return { ok: false, error: why };
  }
  if (input.move_to && gearRules && encumbrance(content, player, store.getState()) === 2) {
    return { ok: false, error: `짐이 너무 무겁다 (${carriedWeight(content, player).toFixed(1)}kg). 내려놓아야(transfer_item to scene) 옮겨 갈 수 있다.` };
  }
  if (inBattle) {
    if (input.activity && input.activity.kind !== "brief") return { ok: false, error: "전투 중에는 잠·보초·기다림 같은 활동을 할 수 없다. activity는 null로 둔다 (한 라운드가 흐른다)." };
    if (input.move_to) return { ok: false, error: "전투 중에는 구역을 옮길 수 없다. 빠지려면 물러나는 전투 효과를 쓴다." };
    if (input.prepare) return { ok: false, error: "전투 중에는 준비물을 설치할 수 없다." };
    if (input.treatment || input.use_item || input.drink || input.refill) return { ok: false, error: "전투 중에는 치료하거나 물건을 쓸 수 없다. 먼저 물러난다." };
    if (input.bury || input.forage || input.trap) return { ok: false, error: "전투 중에는 할 수 없는 일이다. 먼저 싸움을 끝낸다." };
    if (input.battle && !input.check) return { ok: false, error: "전투 효과에는 판정(check)을 함께 선언한다." };
    const effect = input.battle ? scenario.battle?.effects.find((e) => e.id === input.battle!.effect) : undefined;
    const HARM_RANK = { none: 0, light: 1, heavy: 2 } as const;
    if (effect && input.check && HARM_RANK[input.check.harm_on_failure] < HARM_RANK[effect.min_harm]) {
      return { ok: false, error: `${effect.label}에는 몸의 위험을 ${effect.min_harm} 이상으로 선언한다 (harm_on_failure).` };
    }
  }
  let woundAfterRoll = false;
  let missionNote: string | null = null;
  // 동물·감염체가 상대면 (12-111): 말로 하는 스킬은 통하지 않고, 다칠 위험에는 그것의 상처 종류와 감염 위험이 저절로 붙는다
  if (input.check) {
    const foeId = input.check.opponent ?? input.target ?? null;
    const foe = foeId ? start.characters[foeId] : undefined;
    if (foe && isInfected(content, foe)) {
      const refuses = scenario.opposition?.mindless?.refuses ?? [];
      if (refuses.includes(input.check.move)) {
        const label = scenario.moves.find((m) => m.id === input.check!.move)?.label ?? input.check.move;
        return { ok: false, error: `감염체에게는 말이 통하지 않는다 (${label}). 숨기·맞붙기·피하기·버티기처럼 몸으로 하는 판정을 고른다.` };
      }
      if (input.check.harm_on_failure !== "none") input.check.infected_source = true;
    }
    const template = foe?.extra ? content.extras[foe.extra.template] : undefined;
    if (typeof template?.wound === "string" && input.check.harm_on_failure !== "none" && !input.check.harm_kind) input.check.harm_kind = template.wound;
    // 결과로 나뉘는 상처 종류면 판정 뒤에 정한다
    woundAfterRoll = !!template?.wound && typeof template.wound !== "string" && !input.check.harm_kind;
  }
  // 상처 종류 (12-91): 몸의 위험을 걸면 고른다
  if (input.check && scenario.wounds && !woundAfterRoll) {
    // 감염체에게 다칠 위험인데 종류를 비웠으면 기본 종류(물림·할큄)로 본다
    if (!input.check.harm_kind && input.check.infected_source && scenario.wounds.infected_default) input.check.harm_kind = scenario.wounds.infected_default;
    const kind = input.check.harm_kind;
    if (input.check.harm_on_failure !== "none" && !kind) {
      return { ok: false, error: `몸의 위험을 걸면 check.harm_kind(상처 종류)를 고른다: ${scenario.wounds.kinds.map((k) => k.id).join(", ")}` };
    }
    if (kind && !scenario.wounds.kinds.some((k) => k.id === kind)) return { ok: false, error: `알 수 없는 상처 종류: ${kind} (${scenario.wounds.kinds.map((k) => k.id).join(", ")})` };
  }
  const battleAction = validateBattleAction(ctx, input.battle);
  if (typeof battleAction === "string") return { ok: false, error: battleAction };
  // 건너가기 (기획서 9.12): 맞닿지 않은 곳이라도 crossing.from에서는 배로 건넌다. 표(pass_flags)가 없으면 위험한 시도
  let crossingAttempt = false;
  // 갇혀 있으면 옮겨 가는 것은 탈출 시도다 (12-55)
  let escapeAttempt = false;
  let alarmOnArrival: string | null = null;
  if (input.move_to && heldOf(start.characters[start.playerId])) {
    const blocked = escapeRule(start, content, input.check);
    if (blocked) return { ok: false, error: blocked };
    escapeAttempt = true;
  }
  if (input.move_to) {
    const here = start.playerZone;
    const dest = content.locations[input.move_to];
    if (!dest) return { ok: false, error: `알 수 없는 구역: ${input.move_to}${here ? ` (인접 구역: ${neighbors(content, here).join(", ")})` : ""}` };
    if (input.move_to === here) return { ok: false, error: `이미 ${dest.name}에 있다. 이 구역 안에서 자리를 옮기는 것은 move_to 없이 서술한다.` };
    const crossing = dest.crossing && here && dest.crossing.from.includes(here) ? dest.crossing : null;
    if (!here || (!neighbors(content, here).includes(input.move_to) && !crossing)) {
      return { ok: false, error: `${josa(input.move_to, "은/는")} 지금 구역과 맞닿아 있지 않다. 인접 구역: ${here ? neighbors(content, here).join(", ") : "없음"}` };
    }
    if (input.activity) return { ok: false, error: "이동하는 턴에는 activity를 null로 둔다 (이동 시간은 시스템이 정한다)." };
    // 처음 가는 구역은 그 구역으로 가는 길에 서 있어야 간다 (12-304, 공통 규칙 15 knowsZone). 탈출·달아나기(판정을 건 이동)는 예외
    const road = roadTo(start, content, input.move_to);
    const at = currentPlace(start, content);
    if (!escapeAttempt && !input.check && road && at && at.id !== road.id && !knowsZone(start, content, input.move_to)) {
      return { ok: false, error: `${josa(dest.name, "은/는")} 처음 가는 곳이라 그 길로 나가야 떠날 수 있다. 먼저 place_to로 ${road.name}(${road.id}) 쪽으로 나간다 (${directionTo(start, content, at.id, road.id) ?? "가까운 쪽"}, 시간은 흐르지 않았다).` };
    }
    if (crossing && !neighbors(content, here).includes(input.move_to)) {
      const flags = new Set(start.flags[start.playerId] ?? []);
      if (!crossing.pass_flags.some((f) => flags.has(f))) {
        if (!input.check || !crossing.attempt.moves.includes(input.check.move) || input.check.harm_on_failure !== "heavy") {
          return {
            ok: false,
            error:
              `${josa(dest.name, "으로/로")} 건너갈 표가 없다. 직접 건너려면 ${crossing.attempt.label}: check.move는 ${crossing.attempt.moves.join("/")} 중 하나, ` +
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
    if (!zone || !ownedBy(start, zone, player.factionId)) return { ok: false, error: "준비물은 우리 무리의 구역에만 설치할 수 있다." };
    if (prep.requires_item && (player.inventory[prep.requires_item] ?? 0) < 1) return { ok: false, error: `${prep.label}에는 ${josa(content.items[prep.requires_item]?.name ?? prep.requires_item, "이/가")} 필요하다.` };
    const short = Object.entries(prep.materials ?? {}).filter(([id, n]) => (player.inventory[id] ?? 0) < n);
    if (short.length) return { ok: false, error: `${prep.label}에는 재료가 모자라다: ${short.map(([id, n]) => `${content.items[id]?.name ?? id} ${n}개`).join(", ")}.` };
    if (!input.check) return { ok: false, error: `${prep.label} 설치에는 판정(check)이 필요하다.` };
  }

  const unknownTag = input.fright_tags.find((t) => !fearTagIds(scenario).includes(t));
  if (unknownTag) return { ok: false, error: `알 수 없는 fright_tags: ${unknownTag} (가능: ${fearTagIds(scenario).join(", ") || "없음"})` };
  // 무력화된 상대는 더 맞서지 못한다: 맞서는 판정을 받지 않는다 (PT22 하얀매: 무력화된 감염체를 다시 치다 빗나가자 그것이 상대의 몫을 얹어 치명상을 냈다)
  {
    const fightMoves = scenario.opposition?.harm?.moves ?? [];
    const foeId = input.check?.opponent ?? (input.check && fightMoves.includes(input.check.move) ? input.target : null);
    const foe = foeId ? start.characters[foeId] : undefined;
    if (foe && !foe.dead && isIncapacitated(content, foe)) return { ok: false, error: `${josa(playerCalls(start, content, foe.id), "은/는")} 이미 무력화돼 맞서지 못한다. 끝내려면 handle_prisoner(action: kill, 사람이면 knock_out도), 지닌 것은 transfer_item으로 뒤진다 (시간은 흐르지 않았다).` };
  }
  if (input.check?.opponent) {
    const o = start.characters[input.check.opponent];
    if (!o || o.dead || (!start.scene.present.includes(input.check.opponent) && !arriving.includes(input.check.opponent))) return { ok: false, error: `맞서는 상대 ${josa(input.check.opponent, "은/는")} 장면에 없다. check.opponent는 장면에 있는 인물 id다.` };
  }

  // 장소 옮기기 (12-244, 공통 규칙 15): 같은 구역 안에서 5분. 길 위의 일은 없다. 옮긴 장소에서 이번 행동을 한다
  // 검증은 모두 상태를 바꾸기 전에 한다 (PT14 동무조: 들인 사람을 target으로 둔 place_to가 그 사람을 장면에서 빼 다음 호출이 오류가 됐다)
  let placeMove: { to: Place | null; along: string[]; involved: string[] } | null = null;
  if (input.place_to !== null) {
    if (input.move_to) return { ok: false, error: "구역을 옮기는 move_to와 장소를 옮기는 place_to는 함께 쓰지 않는다. 구역을 옮긴 뒤 다음 행동에서 장소를 고른다 (시간은 흐르지 않았다)." };
    // 잠입 중에는 잠입으로만 들고 난다: 잠입 깊이와 지금 장소가 늘 같다 (B③)
    if (start.infiltration) return { ok: false, error: "잠입 중에는 장소를 옮기지 않는다. 더 깊이는 infiltrate advance(place), 나가려면 infiltrate leave (시간은 흐르지 않았다)." };
    if (start.battle || heldOf(player)) return { ok: false, error: "지금은 장소를 옮길 수 없다 (전투 중이거나 갇혀 있다). 시간은 흐르지 않았다." };
    // 아는 장소나 지금 자리의 '문N'만 (설계 목록 C-1): 모르는 장소의 id를 넣어 보는 우회로를 막는다
    const to = resolvePlace(start, content, input.place_to);
    if (to === undefined) {
      return { ok: false, error: `주인공이 아는 장소가 아니다: ${input.place_to}. 갈 수 있는 곳: ${placeChoices(start, content) || "없음"}. 모르는 곳은 문을 지나 찾아가고, 콘텐츠에 없는 곳(누구의 방·화장실 등)이면 spawn_place로 만든다 (시간은 흐르지 않았다).` };
    }
    // 적 땅에서 드러내 놓고 옮기면 이웃 장소로 한 칸씩만 (B③ 12-273, 장소 개편에서 이웃으로. PT16~19 졸병: 담 밖에서 수용소 철망 앞까지 곧장 갔다).
    // 지나는 장소마다 그곳 사람이 알아볼 수 있다 (12-271)
    const herePlace = currentPlace(start, content);
    if (hostileHere(ctx) && herePlace && stepsBetween(start, content, herePlace.id, to.id) > 1) {
      const doors = unknownDoors(start, content);
      // 거칠 칸은 그리로 가는 가장 짧은 길의 다음 칸만 (12-307, PT30 졸병: 이웃을 모두 늘어놓아 방금 떠난 칸까지 "거친다"로 나왔다)
      const left = stepsBetween(start, content, herePlace.id, to.id);
      const next = herePlace.near.map((id) => placeById(start, content, id)).filter((p): p is Place => !!p && !p.jail && stepsBetween(start, content, p.id, to.id) === left - 1);
      // 같은 거리면 담 문·초소가 아닌 칸을 먼저 (담 밖 둘레)
      const open = next.filter((p) => !p.gate && !p.kinds.includes("gate"));
      const via = (open.length ? open : next).map((p) => (doors.some((d) => d.id === p.id) ? doorLabel(start, content, p) : `${p.id}(${p.name})`)).join(" 또는 ");
      return { ok: false, error: `적 땅에서는 이웃 장소로 한 칸씩 지나간다: ${to.name}로 가려면 먼저 ${via || "이웃 장소"}를 거친다${Number.isFinite(left) ? ` (${left}칸)` : ""}. 몰래 가려면 infiltrate (시간은 흐르지 않았다).` };
    }
    // 이번 행동이 겨누는 사람은 함께 간다 (옮긴 자리에서 그 사람에게 이번 행동을 한다)
    // 따돌리려는 은밀의 상대는 함께 가지 않는다: 실패하면 쫓아온다 (PT15 분대장: 따돌리려던 감염체가 판정 전에 "함께 왔다")
    // 판정을 건 이동(물러나기·달아나기)의 상대와 이야기 배역은 옮길 때 따라오지 않는다: 판정이 빗나가면 그때 쫓아온다 (PT22 분대장·졸병: 물러나기에 성공했는데 감염체가 "함께 왔다")
    const involved = [input.target, input.treatment?.target, ...input.with].filter((id): id is string => !!id && id !== input.check?.opponent);
    if ((to?.id ?? null) !== (currentPlace(start, content)?.id ?? null)) placeMove = { to, along: comesAlong(start, content, to?.id ?? null, involved), involved };
  }
  // 함께하는 사람은 장면에 있어야 한다 (공통 규칙 8의 내 편, 사용자 결정 PT14: target 말고 with)
  const strayWith = input.with.find((id) => (!start.scene.present.includes(id) && !arriving.includes(id)) || id === start.playerId);
  if (strayWith) return { ok: false, error: `with의 ${josa(start.characters[strayWith] ? `${playerCalls(start, content, strayWith)}(${strayWith})` : strayWith, "은/는")} 장면에 없다. 함께하는 사람은 장면에 있는 인물이다 (시간은 흐르지 않았다).` };
  // 구역을 옮길 때 with의 사람은 함께 간다 (PT15). 갇힌 사람은 내가 함께 갇혀 달아날 때만 데려간다
  const lockedWith = input.move_to && !heldOf(player) ? input.with.find((id) => !!heldOf(start.characters[id])) : undefined;
  if (lockedWith) return { ok: false, error: `${josa(playerCalls(start, content, lockedWith), "은/는")} 갇혀 있어 데려갈 수 없다. 먼저 풀어 줄 방법을 찾는다 (시간은 흐르지 않았다).` };
  store.append({ type: "turn_started", turn: start.turn + 1, input: input.intent });
  const settingDisplays: ToolDisplayEvent[] = [];
  // 설정 거스르기 (공통 규칙 16): 굴려서 해내지 못하면 이 행동은 일어나지 않는다 (장소 옮기기도, PT14)
  if (input.against_setting) {
    const r = againstSetting(ctx, input.against_setting);
    if (!r.ok) return { ok: false, error: `${r.error} (시간은 흐르지 않았다)` };
    leftLines.push(...r.lines);
    if (!r.proceed) {
      advanceTime(ctx, "brief", null);
      return { ok: true, resultText: leftLines.filter(Boolean).join("\n"), displays: r.displays, outcome: null, dead: false };
    }
    settingDisplays.push(...r.displays);
  }
  // 임무로 세기 (12-240, A3: for_mission을 빠뜨리면 임무 자리의 이동·판정·보초가 조용히 0으로 세졌다):
  // 진행 중인 임무의 요건과 맞는 행동(그 판정, 그 활동, 이동 요건이면 이동)을 임무 장소에서 하면 저절로 임무로 센다
  const autoMission = !input.for_mission ? missionMatch(start, input) : null;
  const forMission = input.for_mission ? (activeMissionOf(start.missions, start.playerId)?.id ?? null) : autoMission;
  const lines: string[] = [];
  lines.push(...leftLines.filter(Boolean));
  if (autoMission) lines.push(`(임무 "${start.missions[autoMission]!.title}"의 요건과 맞는 행동이라 임무로 셌다)`);
  // 임무의 장소가 아니면 임무로 치지 않는다 (플레이 테스트 4: 거점 안에서 초소 보초를 마쳤다)
  {
    const m = forMission ? start.missions[forMission] : undefined;
    // 시간을 쓰기 전에 알린다 (플레이 테스트 12: 탄약 운반 짐을 두 시간 꾸린 뒤에야 "임무로 치지 않는다"가 나왔다)
    if (m?.place && !input.move_to && !atMissionPlace(m, start.playerZone, start.zones, start.factions)) {
      return { ok: false, error: `여기는 임무의 장소(${m.place.label})가 아니라 임무로 치지 않는다. 임무 장소로 옮겨 가서 하거나, 임무와 상관없는 일이면 for_mission: false로 한다 (시간은 흐르지 않았다).` };
    }
  }
  const displays: ToolDisplayEvent[] = [...settingDisplays];
  let outcome: CheckOutcome | null = null;

  // 0. 성격이 결과를 남기는 순간 (12-99): 도발당하면 발끈, 장면의 인물과 이야기하면 말이 새어 나갈 수 있다. 줄은 GM이 그대로 옮긴다
  {
    // 수다는 흘리기도 하고 얻어듣기도 한다 (12-107)
    const talk = input.activity?.kind === "talk";
    const blowup = input.provoked ? rollBlowup(ctx, input.target) : null;
    const leaked = talk ? rollLeak(ctx, input.target) : null;
    const heard = talk ? rollHear(ctx, input.target) : null;
    if (heard) displays.push({ type: "belief", fact: heard.fact, sourceLabel: BELIEF_SOURCE_LABELS.report });
    const moments = [blowup, leaked, heard?.line ?? null].filter((x): x is string => !!x);
    if (moments.length) lines.push("성격 줄 (서술 끝에 그대로 옮겨 적는다. 플레이어가 말하지 않은 반응이니 그 장면을 연출한다):", ...moments.map((m) => `\`${m}\``));
    // 이야기할 사람이 없다 (설계 목록 10-2, PT16 튜토리얼: 빈 장면에서 talk가 그대로 흘렀다)
    const alone = store.getState().scene.present.length === 0;
    // 말 상대(target)를 정했으면 옮긴 자리에서 곧 들인다: 먼저 "아무도 없다"를 찍지 않는다 (12-292, PT24 졸병·하얀매)
    if (talk && alone && !input.broadcast && !input.target) lines.push("장면에 아무도 없다: 혼잣말로 서술하거나, 이야기할 사람을 npc_presence로 들인 뒤 다시 한다.");
  }

  // 0. 겁먹을 일이 드러났으면 공포부터 (이번 판정에 바로 붙는다, 12-95)
  if ((input.fright !== "none" || input.fright_tags.length > 0) && scenario.body?.fear) {
    const fear = frighten(ctx, input.fright === "none" ? 0 : scenario.body.fear.gm[input.fright], input.fright === "none" ? "무서운 것과 마주쳤다" : FRIGHT_CAUSES[input.fright], input.fright_tags);
    lines.push(...fear.lines);
    displays.push(...fear.displays);
  }

  // 없는 물건은 쓰지 못한다: 시간을 흘리기 전에 막는다 (플레이 테스트 8: 오류 없이 30분이 흘렀다)
  if (input.use_item && (player.inventory[input.use_item] ?? 0) < 1) {
    return { ok: false, error: `${josa(content.items[input.use_item]?.name ?? input.use_item, "이/가")} 없다. 가진 물건만 쓴다 (상태의 소지품).` };
  }
  // 물건 없이 치료를 부르면 같은 장소의 치료사를 장면에 들인다 (12-261, 공통 규칙 15)
  const healersIn = input.treatment && !input.treatment.item && !input.place_to && !start.scene.present.some((id) => content.npcs[id]?.healer) ? healersHere(ctx, chosenHealer) : [];
  for (const id of healersIn) enterScene(ctx, id);
  if (healersIn.length) lines.push(`(같은 장소에 있던 ${healersIn.map((id) => playerCalls(store.getState(), content, id)).join(", ")}${josa(playerCalls(store.getState(), content, healersIn.at(-1)!), "을/를").slice(playerCalls(store.getState(), content, healersIn.at(-1)!).length)} 장면에 들였다)`);
  // 할 수 없는 일은 판정·시간 전에 막는다 (플레이 테스트 11: 쓸 필요 없는 붕대, 치료사 아닌 사람의 치료, 거점 안 사냥이 판정과 30분을 쓴 뒤 거절됐다)
  {
    const fuel = !!input.use_item && !!scenario.body?.cold?.climate?.fire?.items[input.use_item];
    const problem =
      (input.use_item && !fuel ? itemUseProblem(ctx, input.use_item) : null) ??
      (input.treatment && !destHealers.length ? treatmentProblem(ctx, input.treatment.item, input.treatment.target, input.check?.move ?? null, feeChoice(input.treatment.pay), chosenHealer) : null) ??
      (input.forage && !input.move_to ? forageProblem(ctx, input.forage) : null) ??
      (input.trap ? trapProblem(ctx, input.trap) : null);
    if (problem) return { ok: false, error: `${problem} (시간은 흐르지 않았다)` };
  }
  // 적대하는 땅에서 시간을 들이는 일 (플레이 테스트 12): 숨은 확률 대신 주인공이 한 번 굴린다. 판정이 없으면 숨기 판정을 건다
  const exposed = !input.move_to && !inBattle && !start.infiltration && !heldOf(start.characters[start.playerId]) && !isIncapacitated(content, player) && !incapacitatingSymptom(scenario, player) && !!scenario.alarm && hostileHere(ctx)
    // 드러내 놓고 말을 거는 일(talk)은 숨을 일이 아니다: 실패해도 "몰래 들어왔다 들켰다"가 아니다 (플레이 테스트 13). 치료·배움은 시간을 들이는 일이다
    && ((!!input.activity && !["brief", "talk"].includes(input.activity.kind)) || !!input.forage || input.trap === "set" || !!input.craft || !!input.build || !!input.treatment || !!input.lesson);
  if (exposed && !input.check) {
    const base = start.playerZone && content.locations[start.playerZone]?.kind === "base";
    return { ok: false, error: `적대하는 땅에서 시간을 들이는 일은 들킬 수 있다. check로 ${scenario.alarm!.moves.join("/")} 판정을 함께 건다 (난이도 ${base ? "hard: 거점 안" : "normal"}). 실패하면 경보가 열린다 (시간은 흐르지 않았다).` };
  }

  // 장소 옮기기: 거절할 일을 모두 거른 뒤에 옮긴다 (막힌 행동의 이동·시간이 남지 않게)
  if (placeMove) lines.push(movePlace(ctx, placeMove.to, placeMove.along, placeMove.involved, input.check ? [input.check.opponent, ...Object.values(start.activeStorylet?.cast ?? {}), ...fightMembersHere(start)].filter((id): id is string => !!id) : []));
  for (const id of arriving) {
    if (store.getState().scene.present.includes(id)) continue;
    enterScene(ctx, id);
    lines.push(`(옮긴 자리에 있던 ${josa(playerCalls(store.getState(), content, id), "을/를")} 장면에 들였다)`);
  }

  // 열린 이야기가 요구하는 판정일 때만 이야기가 걸린 판정이다 (플레이 테스트 13: 길 위 이야기가 열린 사이 위험 없는 5분 경계로 레벨이 올랐다)
  const storyCheck = !!start.activeStorylet && !!input.check && !!storyletOf(start, content, start.activeStorylet.id)?.choices.some((c) => c.check === input.check!.move);
  // 1. 판정과 선언한 위험
  if (input.check) {
    // 탈출은 빈틈을 기다리는 데 시간이 든다 (플레이 테스트 12). 기다린 뒤의 시각(어둠·시간대)으로 굴린다 (PT21 졸병·하얀매: 아침 탈출에 +1(어둠))
    const wait = escapeAttempt ? scenario.captivity?.escape_hours : undefined;
    if (wait) {
      const now = store.getState().time;
      // 5분 단위 (플레이 테스트 13: 그 뒤 시각이 :01·:31로 어긋났다)
      const minutes = Math.round(((wait[0] + ctx.rng() * Math.max(0, wait[1] - wait[0])) * 60) / 5) * 5;
      if (minutes > 0) {
        store.append({ type: "time_advanced", activity: "wait", from: now, to: now + minutes });
        lines.push(`빈틈을 기다리느라 ${formatDuration(minutes)}이 걸렸다.`);
      }
    }
    const roll = rollPlayerCheck(
      { move: input.check.move, stat: input.check.stat, difficulty: input.ambush ? ambushDifficulty(input.check.difficulty) : input.check.difficulty, intent: input.intent, distance: input.check.distance, opponent: input.check.opponent },
      ctx,
      // 응급처치로 피를 멎게 하는 것은 누구나 한다 (배우지 않았으면 미숙 -1, 플레이 테스트 12: 붕대로도 지혈하지 못했다)
      // 수색·먹을 것 구하기의 상황 보정 (12-220): 곳의 넉넉함, 다시 뒤짐. 들킬까 숨는 판정(exposed)에는 붙이지 않는다
      { target: input.target, allies: input.with, forMission, noTools: !!input.train, unarmed: input.check.unarmed, forage: input.forage, purpose: input.treatment ? "staunch" : null, dest: escapeAttempt ? null : input.move_to,
        // 치료 판정은 쓰는 물건의 보정만 (플레이 테스트 12: 붕대를 썼는데 "+1(구급상자)", 물건 없이도 붙었다)
        // 치료 없이 건 응급처치 판정도 도구 없이 (플레이 테스트 13: treatment 없는 응급처치에 "+1(붕대)")
        ...(input.treatment ? { toolItem: input.treatment.item ?? null } : input.check.move === scenario.wounds?.staunch_move ? { toolItem: null } : {}),
        activity: input.activity?.kind ?? null,
        escape: escapeAttempt,
        // 걸린 것: 몸의 위험, 상대, 임무, 진행 중인 이야기, 전투, 치료, 옮겨 가기, 적 땅, 시간을 들이는 일 (5분짜리 맨 판정만 빠진다)
        stakes: atStake({
          harm: input.check.harm_on_failure !== "none",
          opponent: !!input.target || !!input.check.opponent,
          mission: !!forMission,
          storyChoice: storyCheck,
          battle: inBattle,
          treatment: !!input.treatment,
          // 갇혀서 옮겨 가는 것(탈출)은 늘 적 땅을 떠나는 것이다
          travel: !input.move_to ? "none" : escapeAttempt || hostileHere(ctx) || hostileZone({ ...start, playerZone: input.move_to }, content) ? "hostile" : "safe",
          exposed,
          gathering: !!input.forage || !!input.trap,
          activity: !!input.activity && input.activity.kind !== "brief",
        }).stake,
        // 수색할 곳의 보정은 찾을 거리를 정하는 수색 판정에만 (플레이 테스트 14: 뒤지며 굴린 생존 판정에 "+1(넉넉한 곳) +1(역사)")
        situation: [
          ...(exposed || inBattle || input.move_to ? [] : input.activity?.kind === "search" ? (!scenario.exploration?.search_move || input.check.move === scenario.exploration.search_move ? scavengeParts(ctx) : []) : input.forage ? forageParts(ctx, input.forage) : []),
          // 방금 빗나간 상대에게 같은 스킬로 다시 하는 임무 판정은 한 단계 어렵다 (12-258, PT15 섬: 위협 실패 5분 뒤 같은 상대에게 다시 위협해 성공).
          // 맞서는 상대(opponent)에게만: 시범을 보이는 내 편 대상(target)에게는 붙지 않는다 (설계 목록 4-3, PT16·17 분대장)
          ...(forMission && !storyCheck && justMissedAgainst(start, input.check.move, input.check.opponent) ? [{ label: "방금 빗나간 상대", value: -1 }] : []),
        ],
        story: storyCheck,
      },
    );
    if (!roll.ok) {
      // 턴은 이미 시작됐으므로 잠깐의 시간만 흐르게 하고 오류를 알린다
      advanceTime(ctx, "brief", null);
      return { ok: false, error: roll.error };
    }
    outcome = roll.outcome;
    // 옮겨 간 뒤 쫓아오는 것 (공통 규칙 15): 판정이 빗나가면 상대·이야기 배역이 따라오고, 맞으면 남는다. 남겨 두고 왔으면 열린 이야기는 외면으로 풀린다
    if (placeMove) {
      const live = store.getState().activeStorylet;
      const cast = live ? Object.values(live.cast ?? {}) : [];
      // 쓰러졌거나 기어다니는 것(엑스트라 틀 slow)은 쫓아오지 못한다 (PT22·PT23). 맞붙은 부대원도 쫓아온다 (PT32 사용자 결정)
      const foes = [input.check.opponent, ...cast, ...fightMembersHere(start)];
      const chasing = pursuers({ ...store.getState(), scene: start.scene }, content, foes).filter((id) => !store.getState().scene.present.includes(id));
      if (roll.outcome === "miss" && chasing.length) {
        for (const id of chasing) enterScene(ctx, id);
        lines.push(`쫓아왔다: ${chasing.map((id) => playerCalls(store.getState(), content, id)).join(", ")}.`);
      } else {
        const behind = [input.check.opponent, ...cast].filter((id): id is string => !!id && start.scene.present.includes(id) && !store.getState().scene.present.includes(id));
        if (behind.length) lines.push(`떨쳐 내고 왔다: ${[...new Set(behind)].map((id) => playerCalls(store.getState(), content, id)).join(", ")} (원래 자리에 남았다).`);
        if (live && behind.length) lines.push(...walkAwayFromStory(ctx, start));
      }
    }
    // 위험의 무게와 결과로 나뉜 상처 종류 (플레이 테스트 11: 가벼운 위험은 찢김, 무거운 위험에 지면 물림, 대가 있는 성공이면 할큄). GM이 고른 종류가 먼저다
    {
      const foeId = input.check.opponent ?? input.target ?? null;
      const foe = foeId ? start.characters[foeId] : undefined;
      const table = foe?.extra ? content.extras[foe.extra.template]?.wound : undefined;
      if (woundAfterRoll && table && typeof table !== "string" && input.check.harm_on_failure !== "none" && roll.outcome !== "success") {
        const kind = table[input.check.harm_on_failure][roll.outcome] ?? scenario.wounds?.infected_default ?? null;
        if (kind) input.check.harm_kind = kind;
      }
    }
    // 이 행동의 판정이 결과의 첫 줄이다 (앞서 굴린 마음 다잡기보다 앞에, 12-220).
    // 설정을 거스르는 굴림만은 그 앞에: 굴려서 해내야 이 행동을 한다 (PT15 섬: 본문은 거스르기가 먼저인데 판정 줄은 위협 → 버티기)
    displays.splice(settingDisplays.length, 0, roll.display);
    // 임무 판정이 빗나가면 30분을 더 쓴다 (플레이 테스트 11, C2: 5분마다 다시 굴려 채웠다). 같은 조건은 세 번 빗나가면 닫힌다
    {
      const m = forMission ? store.getState().missions[forMission] : undefined;
      const i = m ? m.requirements.findIndex((r) => "check" in r && (r.check === input.check!.move || !!r.alts?.includes(input.check!.move))) : -1;
      const before = forMission ? start.missions[forMission] : undefined;
      if (m && before && i >= 0 && (m.fails?.[i] ?? 0) > (before.fails?.[i] ?? 0)) {
        const now = store.getState().time;
        store.append({ type: "time_advanced", activity: "brief", from: now, to: now + MISSION_FAIL_MINUTES });
        const closed = (m.fails?.[i] ?? 0) >= MISSION_CHECK_TRIES;
        missionNote = `임무 판정이 빗나가 ${MISSION_FAIL_MINUTES}분을 더 썼다 (${closed ? `${MISSION_CHECK_TRIES}번 빗나가 이 조건은 이번 임무에서 닫혔다` : `빗나감 ${m.fails?.[i] ?? 0}/${MISSION_CHECK_TRIES}`}).`;
      }
    }
    lines.push(
      `판정 ${roll.checkId}: ${CHECK_OUTCOME_LABELS[roll.outcome]} (${roll.outcome}). ` +
        `주사위 ${roll.dice[0]}+${roll.dice[1]}, 보정 ${signed(roll.modifier)}, 합계 ${roll.total}.`,
      OUTCOME_GUIDE[roll.outcome],
    );
    if (roll.growthNote) lines.push(roll.growthNote);
    if (missionNote) lines.push(missionNote);
    // 따돌리기에 실패하면 상대가 옮긴 자리까지 쫓아온다
    if (placeMove && roll.outcome === "miss" && input.check.opponent && input.check.move === scenario.move_roles.stealth && !store.getState().scene.present.includes(input.check.opponent)) {
      store.append({ type: "npc_entered", npcId: input.check.opponent });
      lines.push(`${josa(playerCalls(store.getState(), content, input.check.opponent), "이/가")} 따돌리지 못하고 쫓아왔다.`);
    }
    // 적대하는 땅에서 숨기가 실패하면 들킨다 (플레이 테스트 11, D6). 옮겨 가며 건 숨기는 도착한 땅에서 (플레이 테스트 12: 출발한 우리 땅에서 굴려 경보가 없었다)
    if (roll.outcome === "miss" && input.move_to && !escapeAttempt) alarmOnArrival = input.check.move;
    else if (roll.outcome === "miss" && !hostileHere(ctx) && !!scenario.alarm?.moves.includes(input.check.move) && !heldOf(player) && !input.check.opponent && !input.target && !start.activeStorylet && !input.deed) {
      // 우리 땅에서 숨기가 실패하면 수상한 짓으로 들킨다 (공통 규칙 3). 하려던 일(deed)이 있으면 그 일이 본 사람에게 남는다 (PT15 졸병: 도둑질과 "수상한 짓"이 둘 다 남았다)
      lines.push(...onSpottedAtHome(ctx));
    } else if (roll.outcome === "miss") {
      // 적대하는 땅에서 시간을 들인 일의 판정이 실패하면 무엇을 하던 중이든 들킨다 (한 행동에 판정은 하나)
      for (const d of runAlarm(ctx, exposed ? scenario.alarm!.moves[0]! : input.check.move)) {
        displays.push(d);
        if (d.type === "storylet" && d.event === "started") lines.push(`들켰다: "${d.title}". 그 장면으로 이어 연출하라 (상태의 '진행 중인 이야기').`);
        // 경보 이야기 없이 들킨 일도 결과 줄로 (PT35 졸병: 화면 표시에만 있어 결과 글엔 "실패한다"뿐이었다)
        else if (d.type === "belief" && d.fact) lines.push(`${d.fact}.${d.note ? ` ${d.note}` : ""}`);
      }
    }
    lines.push(...roll.ambushNotes);
    // 매복을 놓는다 (12-177)
    if (input.ambush) lines.push(...applyAmbush(ctx, roll.outcome));
    // 무기: 탄약·소음·닳음 (기획서 4.8)
    if (attack) lines.push(...afterAttack(ctx, attack, roll.outcome).lines);
    // 상대를 다치게 한다 (기획서 7.5). 사망은 부상 트랙으로만 (원칙 3)
    if (input.check.target_harm !== "none" && input.target) {
      // 원인은 짧게: 누가 무엇으로 (플레이 테스트 11: 상대의 피해 원인 줄에 플레이어 intent 문장이 통째로 들어갔다)
      const by = attack?.weapon ? content.items[attack.weapon]?.name ?? attack.weapon : null;
      const hitCause = `${playerCalls(store.getState(), content, start.playerId)}의 ${by ? `${by} 공격` : moveLabel(content.scenario, input.check.move)}`;
      const hit = hitTarget(ctx, input.target, input.check.target_harm, roll.outcome, hitCause, attack?.wound ?? null);
      lines.push(...hit.lines);
      displays.push(...hit.displays);
      // 휴전 중인 무리의 사람을 치면 휴전이 깨진다 (12-126)
      const broke = breakTruceIfAny(ctx, input.target);
      if (broke) lines.push(broke);
    }
    // 혼란에 빠진 상대는 주인공을 다치게 하지 못한다 (12-177)
    const harmless = isConfused(start, input.check.opponent ?? input.target ?? null);
    if (harmless && roll.outcome !== "success" && input.check.harm_on_failure !== "none") lines.push("상대가 허둥대느라 반격하지 못했다. 다치지 않았다.");
    if (!harmless && roll.outcome !== "success" && input.check.harm_on_failure !== "none") {
      // 상대의 몫은 맞서 싸우는 판정에서만 (흥정·설득의 target에 근접전 실력이 붙었다, 플레이 테스트 8)
      const fightMoves = content.scenario.opposition?.harm?.moves ?? [];
      const opponent = input.check.opponent ?? (fightMoves.includes(input.check.move) ? input.target : null) ?? null;
      // 까닭을 비웠으면 코드가 짧게 (설계 목록 10-4, PT18 분대장: 피해 줄에 intent 원문이 통째로 나왔다)
      const harmCause = input.check.harm_cause || (opponent && start.characters[opponent] ? `${playerCalls(start, content, opponent)}에게 당했다` : `${moveLabel(scenario, input.check.move)} 중에 다쳤다`);
      const harm = applyHarm(ctx, roll.checkId, input.check.harm_on_failure, harmCause, opponent, input.check.harm_kind ?? null, input.activity && ["search", "work", "guard_duty", "rest", "wait"].includes(input.activity.kind) ? { activity: input.activity.kind as Activity, forMission } : null, !!opponent || !!input.target || inBattle || (!!start.activeStorylet && !!content.storylets[start.activeStorylet.id]?.urgent));
      lines.push(harm.text);
      displays.push(harm.display);
      // 방어구·버팀으로 다치지 않았으면 피도 흉터도 마음의 흔들림도 감염도 없다 (플레이 테스트 8: "다치지 않았다" + 긁힘)
      const hurt = harm.fatal || harm.display.fromLabel !== harm.display.toLabel;
      // 피가 나는 상처면 출혈 (12-91)
      if (!harm.fatal && hurt) {
        const bleed = bleedFromHarm(ctx, start.playerId, input.check.harm_kind, input.check.harm_on_failure === "light");
        if (bleed?.line) lines.push(bleed.display ? `${bleed.line} 지혈하지 않으면 시간이 흐르며 상처가 깊어진다.` : bleed.line);
        if (bleed?.display) displays.push(bleed.display);
        // 크게 다치면 흔적이 남을 수 있다 (12-156)
        const scar = scarFromHarm(ctx, start.playerId, input.check.harm_kind, `${input.check.harm_cause} ${input.intent}`);
        if (scar) lines.push(scar);
      }
      // 감염체에게 입은 상처는 감염될 수 있다 (잠복기는 캐릭터도 GM도 모른다)
      // 입은 방어구가 물림·긁힘을 막을 수 있다 (기획서 4.8)
      // 크게 다치면 마음도 흔들린다 (12-48)
      const nerves = ctx.content.scenario.body?.nerves;
      if (!harm.fatal && hurt && nerves && input.check.harm_on_failure === "heavy") {
        const shaken = shakeNerves(ctx, nerves.heavy_harm, `다쳤다: ${harmCause}`);
        lines.push(...shaken.lines);
        displays.push(...shaken.displays);
      }
      // 감염은 살갗이 찢긴 상처(피가 나는 종류)일 때만 (12-91). 출혈 규칙이 없는 월드면 그대로
      const broken = !scenario.wounds || !!woundKind(ctx, input.check.harm_kind)?.bleeds;
      // 방어구가 피해를 다 받아 내도 물림·할큄이 닿았으면 감염은 굴린다 (플레이 테스트 13: 갑옷만 입으면 기어다니는 감염체가 아무 걱정이 없었다). 방어구의 감염 막음이 먼저
      const reached = hurt || ("armored" in harm && !!harm.armored);
      if (!harm.fatal && reached && input.check.infected_source && broken) {
        const guard = armorBlocksInfection(ctx);
        if (guard.blocked) lines.push(...guard.lines);
        else maybeInfect(ctx, input.check.harm_kind ?? null);
      }
      if (harm.fatal) {
        // 연대기 기록 (전투 중이면 그 자리를 원인에 붙인다), 남은 전투는 코드가 굴린다
        const battle = store.getState().battle;
        recordDeath(ctx, harmCause, battle ? (content.locations[battle.zone]?.name ?? battle.zone) + " 전투" : null);
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
  // 1-0-2. 시설 짓기 (12-167): 시설이 오래 걸리면 그만큼 더 흐른다
  if (input.build && outcome) {
    const built = applyBuild(ctx, input.build, outcome);
    lines.push(...built.lines);
    if (built.extraMinutes > 0) {
      const before = store.getState().time;
      const more = advanceTime(ctx, "work", null, null, built.extraMinutes / 120);
      lines.push(`짓는 데 ${formatDuration(store.getState().time - before)}이 더 들었다 (그만큼 시간이 더 흘렀다).`);
      displays.push(...more.extra);
    }
  }

  // 1-0-3. 동물에게 재주 가르치기 (12-172)
  if (input.train && outcome) lines.push(...applyTrain(ctx, input.train, outcome));

  // 1-0. 수색: 그 구역에서 찾을 거리를 코드가 굴린다 (기획서 4.7)
  // 수색표는 수색 판정이거나 판정 없이 뒤질 때, 적 땅에서 숨어서 뒤질 때만 굴린다. 다른 판정(추적·살피기)은 시간만 수색으로 센다
  // (12-237, 플레이 테스트 13: 발자국을 쫓는 생존 판정에 권총탄이 나왔다. 한 행동에 판정은 하나)
  const searchMove = scenario.exploration?.search_move;
  const lootRoll = !input.check || !searchMove || input.check.move === searchMove || exposed;
  if (input.activity?.kind === "search" && !inBattle && !lootRoll) lines.push(`${moveLabel(scenario, input.check!.move)} 판정이라 뒤져서 찾은 물건은 없다 (찾을 거리는 ${moveLabel(scenario, searchMove!)} 판정으로 뒤질 때 나온다).`);
  if (input.activity?.kind === "search" && !inBattle && lootRoll) {
    // 임무로 찾는 자원 (구해 와 건네기, 아니면 일감의 창고 몫)
    const m = forMission ? store.getState().missions[forMission] : undefined;
    const want = m ? ((m.requirements.find((r) => "bring" in r) as { bring: string } | undefined)?.bring ?? Object.keys(content.missions[m.templateId]?.supplies ?? {})[0] ?? null) : null;
    const found = scavenge(ctx, outcome, want);
    // 적 땅에서는 숨는 판정 하나로 찾는 양까지 정한다 (한 행동에 판정은 하나, 플레이 테스트 13: 수색을 굴리지 않았는데 물건이 나왔다)
    if (exposed && input.check) lines.push(`숨어서 뒤졌다: ${moveLabel(scenario, input.check.move)} 판정 결과로 찾는 양도 정했다.`);
    lines.push(...found.lines);
    // 무리 거점(적대하지 않는 남의 거점, 그리고 우리 거점)에서 뒤져 챙기면 도둑질이다: 그 무리 사람이 곁에 있거나 운이 나쁘면 행적이 남는다
    // (공통 규칙 3, 플레이 테스트 13: 장터 상인 앞에서 뒤져도 뒤끝이 없었다. 12-307 사용자 결정: 우리 땅도 거점이면 무리 몫이라 도둑질, 거점이 아닌 우리 땅은 아니다.
    // PT25~30: 우리 막사를 뒤져 담요를 챙겨도 아무 일이 없었다). 임무로 뒤지는 것(창고 몫·구해 올 것)은 일이라 빼낸다
    {
      const s1 = store.getState();
      const zone = s1.playerZone;
      const owner = zone ? s1.zones[zone]?.owner : null;
      const mine = s1.characters[s1.playerId]?.factionId;
      const tookSomething = found.displays.length > 0;
      if (!exposed && !forMission && tookSomething && zone && content.locations[zone]?.kind === "base" && owner) {
        const watcher = s1.scene.present.some((id) => s1.characters[id]?.factionId === owner);
        if (watcher || ctx.rng() < THEFT_NOTICE_CHANCE) {
          const ours = owner === mine;
          recordDeed(ctx, { summary: ours ? "우리 거점에서 무리 몫을 뒤져 챙겼다" : `${content.factions[owner]?.name ?? owner}의 거점에서 남의 것을 뒤져 챙겼다`, tags: ["theft"], severity: 1, privacy: "semi_private", noisy: false });
          lines.push(ours ? "거점에서 무리 몫을 뒤져 챙긴 것을 누군가 본 것 같다 (도둑질로 남았다)." : "남의 거점에서 뒤져 챙긴 것을 누군가 본 것 같다 (도둑질로 남았다).");
        }
      }
    }
    displays.push(...found.displays);
  }

  // 1-0-1. 먹을 것 구하기와 덫 (12-131)
  for (const [request, run] of [
    [input.forage, () => forage(ctx, input.forage!, outcome)],
    [input.trap, () => handleTrap(ctx, input.trap!, outcome)],
  ] as const) {
    if (!request || inBattle) continue;
    const r = run();
    if (r.ok) {
      lines.push(...r.lines);
      displays.push(...r.displays);
    } else lines.push(`하지 못했다: ${r.error}`);
  }

  // 1-1. 준비물 설치 (아이템은 판정 결과와 관계없이 쓴다)
  if (prep) {
    if (prep.requires_item) store.append({ type: "item_consumed", holder: start.playerId, itemId: prep.requires_item, quantity: 1 });
    for (const [id, n] of Object.entries(prep.materials ?? {})) store.append({ type: "item_consumed", holder: start.playerId, itemId: id, quantity: n });
    if (outcome !== "miss") {
      store.append({ type: "preparation_set", zone: start.playerZone!, preparation: prep.id });
      lines.push(`${josa(prep.label, "을/를")} 이 구역에 설치했다. 이 구역에서 전투가 벌어지면 쓸 수 있다.`);
    } else {
      lines.push(`${prep.label} 설치에 실패했다. 재료는 못 쓰게 됐다.`);
    }
  }

  // 1-1-1. 치료 (낫는 정도는 시스템이 정한다)
  for (const [request, run] of [
    [input.treatment, () => applyTreatment(ctx, input.treatment!.item, input.treatment!.target, input.check && outcome ? { move: input.check.move, outcome } : null, feeChoice(input.treatment!.pay) ?? "default", chosenHealer)],
    [input.use_item, () => useItem(ctx, input.use_item!)],
    [input.drink || null, () => drinkWater(ctx)],
    [input.refill || null, () => refillWater(ctx)],
    [input.change_clothes || null, () => changeClothes(ctx)],
    [input.wade || null, () => wadeIn(ctx)],
    [input.bury, () => buryRemains(ctx, input.bury!.who, input.bury!.words)],
  ] as const) {
    if (!request) continue;
    const t = run();
    if (t.ok) {
      lines.push(...t.lines);
      displays.push(...t.displays);
    } else {
      lines.push(`${request === input.bury ? "묻지 못했다" : request === input.change_clothes ? "갈아입지 못했다" : request === input.wade ? "물에 들어가지 못했다" : request === input.drink ? "물을 마시지 못했다" : request === input.refill ? "물을 채우지 못했다" : "몸을 돌보지 못했다"}: ${t.error}`);
    }
  }

  // 1-2. 전투 한 라운드 (판정이 없어도 라운드는 흐른다). 쓰러져 있으면 남은 전투를 코드가 한 번에 굴려 끝낸다
  const fellInBattle = inBattle && store.getState().battle !== null && !!incapacitatingSymptom(scenario, store.getState().characters[start.playerId]!);
  if (fellInBattle) {
    const end = endBattle(ctx, false);
    lines.push(...end.lines);
    displays.push(...end.displays);
  } else if (inBattle) {
    const round = playBattleRound(
      ctx,
      battleAction && input.check ? { ...battleAction, outcome: outcome!, checkId: lastCheckId(ctx) } : null,
    );
    lines.push(...round.lines);
    displays.push(...round.displays);
  }

  // 말로 묻는 판정이 맞으면 상대가 아는 것을 남기는 길을 알린다 (설계 목록 7-1, PT16·17 섬: 교섭이 성공해도 남는 것이 없었다).
  // 무엇을 물었는지는 코드가 모르므로 고르지 않는다. 말로 하는 스킬은 시나리오의 opposition.mindless.refuses
  // 맞서는 판정(둘러대기·위협으로 맞섬)은 캐묻는 것이 아니다 (PT22 졸병)
  if (input.check && input.target && !input.check.opponent && outcome && outcome !== "miss" && (scenario.ask_moves ?? scenario.opposition?.mindless?.refuses ?? []).includes(input.check.move)) {
    const npc = content.npcs[input.target];
    const mine = new Set((store.getState().beliefs[start.playerId] ?? []).map((b) => b.fact));
    const unknown = npc ? (store.getState().beliefs[input.target] ?? []).filter((b) => !npc.keeps.includes(b.fact) && !mine.has(b.fact)) : [];
    // 부탁·보고하는 판정에도 붙어 헷갈렸다 (PT21 세 판): 무엇을 물으려던 판정일 때만이라고 밝힌다
    if (unknown.length) lines.push(`(무엇을 캐물으려던 판정이었고 ${josa(playerCalls(store.getState(), content, input.target), "이/가")} 그것을 안다면, 그 사람 카드의 "아는 것"에서 골라 add_belief(source: report)로 남긴다. 부탁·보고였으면 넘긴다)`);
  }
  // 지혈하는 스킬로 피 흘리는 사람(target)을 판정했으면 treatment가 없어도 그 판정대로 맨손 지혈한다 (PT28 하얀매 "들것 둘":
  // 응급처치가 성공했는데 treatment를 빠뜨려 둘 다 밤새 피를 흘렸다). 판정 하나로 둘을 멎게 하지는 않는다
  const staunchMove = scenario.wounds?.staunch_move;
  if (input.check && outcome && staunchMove && input.check.move === staunchMove && !input.treatment && input.target && input.target !== start.playerId && !inBattle) {
    const r = staunch(ctx, { move: input.check.move, outcome }, input.target);
    if (r.ok) {
      lines.push(`${playerCalls(store.getState(), content, input.target)}: ${r.lines.join(" ")}`);
      displays.push(...r.displays);
    }
  }
  // 2. 행적과 목격자
  // 적대하는 땅에서 그 땅 주인 무리 사람이 봤으면(행적의 목격자, 공격받은 사람) 그 자리에서 경보가 울린다 (12-266, 사용자 결정. PT16~18 졸병: 대낮에 적 지휘소를 뒤지고 장교를 쳐도 아무 일이 없었다)
  const hostileOwner = !inBattle && !start.infiltration && !heldOf(start.characters[start.playerId]) && hostileHere(ctx) ? (start.zones[start.playerZone ?? ""]?.owner ?? null) : null;
  const ofOwner = (id: string | null | undefined) => !!id && !!hostileOwner && store.getState().characters[id]?.factionId === hostileOwner && !store.getState().characters[id]?.dead;
  let ownerSaw = !!input.check && (scenario.gear?.attack_moves.includes(input.check.move) ?? false) && [input.target, input.check.opponent].some((id) => ofOwner(id) && store.getState().scene.present.includes(id!));
  // 탈출은 코드가 행적으로 남긴다: GM이 같은 일을 deed로 또 남기지 않게 받지 않는다 (PT22 졸병: 같은 탈출이 행적 둘·소문 둘로 겹쳤다)
  if (input.deed && escapeAttempt) lines.push("(탈출은 시스템이 행적으로 남긴다: 넣은 deed는 따로 남기지 않았다)");
  if (input.deed && !escapeAttempt) {
    const happened = input.deed.condition === "always" || outcome === null || outcome !== "miss";
    if (happened) {
      // 속이기가 먹혔으면(거짓말 판정의 성공·대가 있는 성공) 장면의 사람은 속아 넘어가 행적을 알지 못한다. 함께 다니는 사람(동행)은 참을 안다 (PT14)
      const deceived = !!input.check && input.check.move === scenario.move_roles.deceive && (outcome === "success" || outcome === "partial");
      const companionsNow = new Set(activeCompanions(store.getState()));
      // 속는 사람은 거짓말을 들은 상대(opponent, 없으면 target)다. 상대를 정하지 않았으면 장면의 사람 가운데 함께하는 사람(with·동행)을 뺀 사람
      // (12-265, PT18 섬: 감싸 준 당사자까지 "속아 넘어가" 의리 행적을 몰랐다)
      const dupe = input.check?.opponent ?? input.target ?? null;
      const together = new Set([...companionsNow, ...(input.with ?? [])]);
      const fooled = deceived ? store.getState().scene.present.filter((id) => (dupe ? id === dupe : !together.has(id))) : undefined;
      // 당한 사람은 가치관으로 마음이 오르지 않는다 (12-262, PT17 분대장: 원망 -2에 가치관 +1이 섞여 -1)
      const offenseTags = scenario.offense?.tags ?? [];
      const victim = input.target && input.deed.tags.some((t) => offenseTags.includes(t as never)) ? input.target : null;
      const { deed, visible } = recordDeed(ctx, { ...input.deed, byGm: true, victim }, undefined, fooled);
      const fooledNames = (fooled ?? []).map((id) => playerCalls(store.getState(), content, id));
      const wronged = wrongedResentment(ctx, input.target, deed.tags, deed.witnesses.some((w) => w.npcId === input.target));
      lines.push(
        `행적 ${deed.id} 기록: ${sentence(deed.summary)} ` +
          (fooledNames.length > 0 ? `${josa(fooledNames.join(", "), "은/는")} 속아 넘어가 거짓인 줄 모른다 (이 행적을 알지 못한다). ` : "") +
          (visible.length > 0 ? `장면에 있던 ${josa(visible.join(", "), "이/가")} 보았다. 그들의 반응을 서술에 반영하라.` : fooledNames.length > 0 ? "" : "장면에 아무도 없었다.") +
          (deceived ? "" : hiddenWitnessHint(store.getState(), content)) +
          (wronged ? ` ${wronged}` : ""),
      );
      displays.push({
        type: "deed",
        summary: deed.summary,
        tagLabels: deed.tags.map((t) => DEED_TAG_LABELS[t]),
        visibleWitnesses: visible,
      });
      if (deed.witnesses.some((w) => ofOwner(w.npcId))) ownerSaw = true;
    }
  }
  // 적 땅의 장소에 들어서면 그 장소의 땅 주인 무리 사람이 알아볼 수 있다 (B②). 잠입 중이면 잠입 장치가 맡는다
  let spottedBy: string[] = [];
  if (!ownerSaw && hostileOwner && placeMove?.to) {
    spottedBy = spottedEntering(ctx, hostileOwner);
    if (spottedBy.length) ownerSaw = true;
  }
  if (ownerSaw && hostileOwner) {
    if (spottedBy.length) lines.push(`${placeMove!.to!.name}에 들어서자 그곳에 있던 ${josa(spottedBy.map((id) => playerCalls(store.getState(), content, id)).join(", "), "이/가")} 알아보았다.`);
    for (const d of raiseAlarm(ctx)) {
      displays.push(d);
      if (d.type === "storylet" && d.event === "started") lines.push(`${content.factions[hostileOwner]?.name ?? hostileOwner} 사람이 보았다. 경보가 울린다: "${d.title}". 그 장면으로 이어 연출하라 (상태의 '진행 중인 이야기').`);
      else if (d.type === "belief" && d.note) lines.push(d.note);
    }
  }

  // 3-0. 떠나기 전에 예정 시각이 지난 교전은 지금 자리로 판정한다 (12-238, 플레이 테스트 13: 판정의 대가로 흐른 시간에 새벽 공세 시각이 지났는데,
  // 이동까지 마친 뒤 판정해 맞닿은 우리 구역에 있던 주인공이 공세에 끼지 못했다)
  if (input.move_to && !inBattle && store.getState().pendingClashes.some((p) => p.at <= store.getState().time)) {
    const clash = runPendingClashes(ctx);
    displays.push(...clash);
    if (store.getState().battle) {
      lines.push("떠나기 전에 교전이 벌어졌다: 이동하지 않았다. 상태의 전투를 보고 전투 장면을 연출하라.");
      return { ok: true, resultText: lines.join("\n"), displays, outcome, dead: false };
    }
    lines.push(...worldLines(clash));
  }

  // 3. 시간 경과 (빨리감기와 끼어들기 포함)
  const activity: Activity = inBattle ? "combat" : input.move_to ? "travel" : (input.activity?.kind ?? (input.treatment ? "treat" : input.use_item ? ((content.scenario.consumables[input.use_item]?.hunger ?? 0) > 0 ? "eat" : "brief") : input.drink || input.refill || input.wade || input.change_clothes ? "brief" : input.craft || input.build || input.train || input.lesson || input.bury || input.trap === "set" ? "work" : input.forage ? "search" : input.broadcast ? "talk" : "brief"));
  // 이동 수단 (12-137): 타고 가면 이동 시간이 줄고, 연료를 쓰고, 도착한 곳에 소리가 난다
  const ride = input.move_to && input.ride ? planRide(ctx, input.ride, !!crossingAttempt || escapeAttempt) : null;
  if (ride && !ride.ok) lines.push(`타지 못하고 걸었다: ${ride.error}`);
  const rideUsed = ride?.ok ? ride : null;
  if (rideUsed?.fuel) store.append({ type: "item_consumed", holder: start.playerId, itemId: rideUsed.fuel, quantity: 1 });
  // 무전 송출은 30분 (대화 ×3, 12-173)
  // 사냥·낚시·채집·덫 놓기는 바깥 일이다 (플레이 테스트 11: activity work로 낚시해 실내로 쳐져 비 오는 날 옷이 말랐다. 12: 빗속에 덫을 놓다 옷이 말랐다)
  // 물일 임무(wets)도 바깥 일이다 (플레이 테스트 12: 그물 걷기가 실내로 쳐져 "불기 곁에서 말렸다" 뒤에 다시 젖었다)
  const wetWork = (() => {
    const m = forMission && !input.move_to && activity !== "brief" ? start.missions[forMission] : undefined;
    return !!m && !!content.missions[m.templateId]?.wets && atMissionPlace(m, start.playerZone, start.zones, start.factions);
  })();
  // 판정을 걸고 지켜보는 기다림(잠복)은 바깥에서 하는 일이다 (플레이 테스트 13: 빗속 돌담에 엎드려 11시간을 지붕 아래로 셌다)
  const lurking = !!input.check && ["wait", "rest"].includes(activity) && !input.treatment;
  const exposure: Activity = (wetWork || lurking) && !["travel", "combat"].includes(activity) ? "guard_duty" : (input.forage || input.trap === "set") && !["travel", "guard_duty", "combat"].includes(activity) ? "search" : activity;
  const timeBefore = store.getState().time;
  const hours = input.activity?.hours ?? null;
  // 장소를 옮긴 턴의 잠깐 행동(판정 없는 것)은 옮기는 5분에 들어간다 (12-255, PT15 섬: 옮겨 가 한마디에 10분)
  const inMove = !!placeMove && activity === "brief" && !input.check && !inBattle;
  // 임무 작업은 hours 없이 걸면 임무에 남은 만큼 한다 (12-261, PT16 섬: 남은 4시간인데 기본 2시간만 했다)
  const workMinutes = activity === "work" ? (hours ? hours * 60 : missionWorkLeft(store.getState(), forMission)) : null;
  const time = advanceTime(ctx, activity, input.activity?.until ?? null, forMission, rideUsed?.speed ?? (input.broadcast && activity === "talk" ? 3 : 1), input.move_to ?? null, exposure, inMove ? 0 : workMinutes, hours);
  // 배달 (F5): 임무 자리에서 임무 일을 하면 지닌 짐을 넘긴다
  if (forMission && !input.move_to) {
    const m = store.getState().missions[forMission];
    if (m && atMissionPlace(m, store.getState().playerZone, store.getState().zones, store.getState().factions)) {
      // 판정이 빗나간 행동으로는 짐을 넘기지 않는다: 흥정이 틀어졌는데 짐만 건너가지 않게 (플레이 테스트 14, 방문자 T37: 교섭 실패에 "짐을 넘겼다")
      const missed = outcome === "miss";
      // 받는 사람: 이 행동의 상대가 장면에 있으면 그 사람이 짐을 받는다 (방문자 T37: 넘긴 담배가 행상대장 소지품에 없었다)
      const s0 = store.getState();
      const receiver = input.target && input.target !== start.playerId && s0.scene.present.includes(input.target) && !s0.characters[input.target]?.dead ? input.target : null;
      m.requirements.forEach((r, i) => {
        if (!("deliver" in r) || (m.progress[i] ?? 0) >= 1) return;
        if (missed) {
          // 실제로 지닌 수로 말한다 (12-262, PT17 분대장: 이미 건넸는데 "아직 지니고 있다")
          const held = store.getState().characters[start.playerId]!.inventory[r.deliver] ?? 0;
          lines.push(`판정이 빗나가 짐은 넘기지 못했다: ${content.items[r.deliver]?.name ?? r.deliver} ${held ? `×${held}는 아직 맡은 짐으로 지니고 있다` : "은 지금 지니고 있지 않다"}.`);
          return;
        }
        // 받는 사람에게만 넘긴다 (설계 목록 5-2, PT18·19·20 세 판: 임무 장소로 옮기기만 해도, 상대 없는 경계 판정에도 짐이 넘어갔다)
        if (!receiver) {
          lines.push(`짐은 아직 지니고 있다: ${content.items[r.deliver]?.name ?? r.deliver}. 받을 사람을 target으로 두고 건네는 행동(대화·교섭)을 하면 넘어간다.`);
          return;
        }
        const have = store.getState().characters[start.playerId]!.inventory[r.deliver] ?? 0;
        if (have < r.quantity) {
          lines.push(`넘길 짐이 모자란다: ${content.items[r.deliver]?.name ?? r.deliver} ${have}/${r.quantity}.`);
          return;
        }
        store.append({ type: "item_transferred", from: start.playerId, to: receiver, itemId: r.deliver, quantity: r.quantity });
        store.append({ type: "mission_requirement_met", missionId: m.id, index: i });
        lines.push(`짐을 넘겼다: ${content.items[r.deliver]?.name ?? r.deliver} ×${r.quantity}${receiver ? ` (${josa(playerCalls(s0, content, receiver), "이/가")} 받았다)` : ""}.`);
        // 맡은 짐 기록을 줄이고, 받아 올 값을 상대가 건넨다 (공통 규칙 10, 12-237: 대금이 현장에서 오가지 않았다)
        const cargo = { ...cargoOf(store.getState(), m.id) };
        const left = (cargo[r.deliver] ?? 0) - r.quantity;
        if (left > 0) cargo[r.deliver] = left;
        else delete cargo[r.deliver];
        const collects = Object.entries(content.missions[m.templateId]?.collects ?? {});
        for (const [id, q] of collects) {
          store.append({ type: "item_granted", to: start.playerId, itemId: id, quantity: q });
          cargo[id] = (cargo[id] ?? 0) + q;
        }
        store.append({ type: "cargo_set", missionId: m.id, items: cargo });
        if (collects.length) lines.push(`값을 받았다: ${collects.map(([id, q]) => `${content.items[id]?.name ?? id} ×${q}`).join(", ")} (상관에게 넘길 것이다. 보고 때 모자라면 일부 완수까지).`);
      });
      // 걷기 (12-251, 플레이 테스트 14 짐꾼: 빚을 받아 숨기고 "못 받았다"고 해도 완수였다): 넘길 짐 없이 받아 오는 일감은
      // 임무 판정이 이 행동으로 채워지면 상대가 값을 건넨다. 보고 때 건네야 완수, 지니지 않았으면(숨기거나 쓰면) 일부 완수까지
      const collects = Object.entries(content.missions[m.templateId]?.collects ?? {});
      const before = start.missions[m.id];
      const now = store.getState().missions[m.id]!;
      const justMet = m.requirements.some((r, i) => "check" in r && (before?.progress[i] ?? 0) < 1 && (now.progress[i] ?? 0) >= 1);
      if (collects.length && !m.requirements.some((r) => "deliver" in r) && justMet) {
        const cargo = { ...cargoOf(store.getState(), m.id) };
        for (const [id, q] of collects) {
          store.append({ type: "item_granted", to: start.playerId, itemId: id, quantity: q });
          cargo[id] = (cargo[id] ?? 0) + q;
        }
        store.append({ type: "cargo_set", missionId: m.id, items: cargo });
        lines.push(`받아 냈다: ${collects.map(([id, q]) => `${content.items[id]?.name ?? id} ×${q}`).join(", ")} (보고 때 상관에게 건네야 완수다. 건네지 않고 가지면 일부 완수에 그친다).`);
      }
    }
  }
  // 물일 임무 (E3): 임무 자리에서 그 일을 하면 옷이 젖는다. 방수복을 입으면 젖지 않는다
  const workSoaked: ToolDisplayEvent[] = [];
  if (forMission && !input.move_to && activity !== "brief") {
    const m = store.getState().missions[forMission];
    if (m && content.missions[m.templateId]?.wets && atMissionPlace(m, store.getState().playerZone, store.getState().zones, store.getState().factions)) {
      workSoaked.push(...soak(ctx, start.playerId, "물일을 하다 옷이 젖었다", true));
      displays.push(...workSoaked);
    }
  }
  // 판정의 대가·빗나감·탈출의 기다림으로 더 쓴 시간까지 첫 줄에 합쳐 알린다 (플레이 테스트 12·13: "5분 경과. 현재 11:25"인데 35분이 지났다)
  {
    const total = store.getState().time - start.time;
    const spent = store.getState().time - timeBefore;
    const [first0, ...rest] = time.text.split("\n");
    // 실패한 탈출은 이동이 아니다 (플레이 테스트 13: "이동: 45분 경과 … 빠져나가지 못했다")
    const first = escapeAttempt && outcome === "miss" ? first0!.replace(/^이동:/, "달아나다 붙잡혀 끌려옴:") : first0;
    // 옮기는 시간은 칸 수대로라 실제 걸린 시간으로 적는다 (PT20 네 판: 10~20분인데 "5분에 들어갔다")
    if (inMove && spent === 0) lines.push(`${ACTIVITY_LABELS.brief}: 장소를 옮기는 시간에 들어갔다. 현재 ${formatTime(store.getState().time)}.`);
    else lines.push(total > spent ? [first!.replace(/ 경과\. 현재/, ` + 앞서 쓴 ${formatDuration(total - spent)} = 모두 ${formatDuration(total)} 경과. 현재`), ...rest].join("\n") : time.text);
  }
  if (input.activity || input.move_to) displays.push(time.display);
  // 가르침 (4.2.1): 흐른 시간만큼 배운다
  if (input.lesson && !inBattle) lines.push(...applyLesson(ctx, input.lesson, store.getState().time - timeBefore));
  displays.push(...time.extra);
  lines.push(...bodyLines(time.extra));
  // 물일로 젖은 것도 결과 글에 (12-261, PT16 섬: 상태의 기온 줄에만 나왔다)
  lines.push(...bodyLines(workSoaked));
  // 긴 활동이 자정을 넘으며 생긴 일(분대 보고, 동행이 떠남, 임무 기한, 어긴 약속)도 글로 알린다 (플레이 테스트 11: 잠든 사이의 분대 보고가 빠졌다)
  lines.push(...worldLines(time.extra));
  // 자고 나면 공포가 가라앉고 (12-95), 끊기지 않고 푹 자면 마음도 가라앉을 수 있다
  if (activity === "sleep") {
    const calm = calmAfterSleep(ctx);
    lines.push(...calm.lines);
    displays.push(...calm.displays);
    const rested = time.interrupted ? null : sleepNerves(ctx, store.getState().time - start.time);
    if (rested) lines.push(rested.line);
    if (rested?.display) displays.push(rested.display);
  }
  // 감염체가 몰려든 구역에서 오래 머물면 마주칠 수 있다: 들어설 때와 같은 확률로 한 번 (플레이 테스트 13: 몰려든 강변에서 4시간 보초·8시간 야영에 아무 일도 없었다)
  if (!input.move_to && !!input.activity && LONG_IN_THREAT.includes(input.activity.kind) && !store.getState().activeStorylet && !store.getState().battle && store.getState().playerZone && !playerHeld(store.getState())) {
    for (const d of runInfestedArrival(ctx, store.getState().playerZone!)) {
      displays.push(d);
      if (d.type === "storylet" && d.event === "started") lines.push(`머무는 사이 일이 생겼다: "${d.title}". 그 장면으로 이어 연출하라 (상태의 '진행 중인 이야기').`);
    }
  }
  // 건너기 시도가 실패하면 물살에 밀려 되돌아온다 (시간과 위험은 이미 치렀다)
  const sweptBack = crossingAttempt && outcome === "miss";
  const escapeFailed = escapeAttempt && outcome === "miss";
  if (escapeFailed) {
    store.append({ type: "captive_watch_raised" });
    const watch = heldOf(store.getState().characters[start.playerId])?.watch ?? 1;
    lines.push(`빠져나가지 못했다. 다시 붙잡혀 갇힌 곳으로 끌려왔다. 감시가 더 심해졌다 (다음 탈출 판정 -${watch}${watch >= 3 ? ", 더 심해지지는 않는다" : ""}).`);
  }
  if (sweptBack) {
    lines.push(`${content.locations[input.move_to!]?.name ?? input.move_to}에 닿지 못하고 되돌아왔다. 되돌아온 장면을 서술한다.`);
    // 물에 빠졌다 (플레이 테스트 13: 배가 뒤집혀 바다에 빠졌는데 옷이 마른 채였다)
    displays.push(...soak(ctx, start.playerId, "물살에 휩쓸려 물에 빠졌다"));
  }
  if (input.move_to && !time.interrupted && !sweptBack && !escapeFailed) {
    if (escapeAttempt) {
      const captor = heldOf(start.characters[start.playerId])?.by;
      const kind = heldKind(start);
      const freed = releasePlayer(ctx, false);
      if (freed) lines.push(freed);
      // 우리 무리의 벌·격리에서 달아난 것은 용기가 아니다 (12-269, 우회 점검)
      if (captor && kind !== "enemy") {
        const what = kind === "own" ? "무리의 벌을 피해 갇힌 곳에서 달아났다" : `${content.factions[captor]?.name ?? captor}의 격리를 깨고 달아났다`;
        recordDeed(ctx, { summary: what, tags: ["disobedience"], severity: kind === "own" ? 2 : 1, privacy: "semi_private", noisy: true });
        lines.push(`달아난 일은 행적으로 남았다 ([명령 불복종] ${what}). 같은 일을 deed로 따로 남기지 않는다.`);
      }
      // 달아난 일은 붙잡았던 무리에 남는다 (플레이 테스트 12)
      if (captor && kind === "enemy") {
        recordDeed(ctx, { summary: `${content.factions[captor]?.name ?? captor}에 갇혀 있다 달아났다`, tags: ["bravery"], severity: 1, privacy: "semi_private", noisy: true });
        // GM이 같은 일을 deed로 또 남기지 않게 (플레이 테스트 13: "감옥을 부수고 탈옥했다"가 따로 쌓였다)
        lines.push("탈출은 행적으로 남았다 ([용기] 갇혀 있다 달아났다). 같은 일을 deed로 따로 남기지 않는다.");
      }
    }
    // 자리를 뜨면 그 자리의 이야기는 끝난다 (장면의 인물도 따라오지 않는다)
    displays.push(...endActiveStorylet(ctx, "자리를 떴다"));
    const deposited = start.playerZone ? store.getState().deposits?.[start.playerZone] : undefined;
    leaveAmbush(ctx);
    // 판정을 걸고 달아났는데 빗나가면 맞선 상대와 맞붙은 부대원이 쫓아온다 (공통 규칙 15, PT32 사용자 결정: 실패해도 그대로 닿고 아무도 쫓지 않았다)
    const chasing0 = outcome === "miss" && !escapeAttempt && input.check ? pursuers({ ...store.getState(), scene: start.scene }, content, [input.check.opponent, ...fightMembersHere(start)]).filter((id) => !input.with.includes(id)) : [];
    // 우리 거점으로 쫓겨 오면 다른 무리 사람은 따라 들어오지 않는다: 보초들이 나오자 물러간다 (PT33 사용자 결정: 담 안 운동장까지 쫓아와 거기 있던 다섯이 보고만 있었다)
    const myBase = player.factionId ? baseOfNow(store.getState(), content, player.factionId) : null;
    const repelled = input.move_to === myBase ? chasing0.filter((id) => store.getState().characters[id]?.factionId !== player.factionId) : [];
    const chasing = chasing0.filter((id) => !repelled.includes(id));
    const alongZone = [...comesAlong(start, content, null, input.with), ...chasing];
    movePlayer(ctx, { zone: input.move_to, place: arrivalPlace(start, content, input.move_to, start.playerZone) }, "travel", { with: alongZone });
    if (chasing.length && start.playerZone) chaseParties(ctx, start.playerZone, input.move_to, chasing);
    if (deposited) lines.push(`맡겨 둔 것을 돌려받고 떠났다: ${Object.entries(deposited).map(([id, n]) => `${content.items[id]?.name ?? id}${n > 1 ? ` ×${n}` : ""}`).join(", ")}.`);
    // 끌고 온 포로: 우리 무리의 거점에 닿으면 우리 무리의 포로가 된다 (12-55)
    lines.push(...deliverPrisoners(ctx));
    // 동행은 따라온다. 그 밖의 장면 인물만 남는다 (플레이 테스트 11: 동행이 왔는데 "따라오지 않는다"가 늘 나왔다)
    const came = activeCompanions(store.getState()).map((id) => playerCalls(store.getState(), content, id));
    const brought = alongZone.filter((id) => !chasing.includes(id) && store.getState().scene.present.includes(id) && !store.getState().companions.includes(id)).map((id) => playerCalls(store.getState(), content, id));
    const leftBehind = start.scene.present.filter((id) => !alongZone.includes(id) && !start.companions.includes(id)).length > 0;
    // 함께 달아나 갇힌 곳에서 꺼내 온 사람 (공통 규칙 1 welcomeRescued, 설계 목록 2-12)
    const rescued = escapeAttempt ? alongZone.filter((id) => !!heldOf(start.characters[id]) && !heldOf(store.getState().characters[id])) : [];
    lines.push(`${content.locations[input.move_to]?.name ?? input.move_to}에 도착했다.${came.length ? ` 동행(${came.join(", ")})은 함께 왔다.` : ""}${brought.length ? ` 함께 데려왔다: ${brought.join(", ")}${escapeAttempt ? " (함께 달아났다)" : ""}.` : ""}${repelled.length ? ` 뒤를 쫓던 ${repelled.map((id) => playerCalls(store.getState(), content, id)).join(", ")}${josa(playerCalls(store.getState(), content, repelled.at(-1)!), "은/는").slice(playerCalls(store.getState(), content, repelled.at(-1)!).length)} 거점의 보초들이 뛰어나오자 물러갔다 (맞붙음이 끝났다).` : ""}${chasing.length ? ` 달아나지 못하고 쫓아왔다: ${chasing.map((id) => playerCalls(store.getState(), content, id)).join(", ")} (도착한 자리에서 맞붙음이 이어진다).` : ""}${leftBehind ? " 그 밖에 함께 있던 인물은 따라오지 않는다 (데려가려면 with, 같이 왔다면 npc_presence로 다시 등장시킨다)." : ""}`);
    lines.push(...welcomeRescued(ctx, rescued));
    if (rideUsed) {
      lines.push(`${josa(rideUsed.name, "을/를")} 타고 왔다.${rideUsed.noise ? " 엔진 소리가 구역에 울렸다. 몇 시간 안에 무언가 몰려들 수 있다." : ""}`);
      if (rideUsed.noise) store.append({ type: "noise_made", zone: input.move_to, level: rideUsed.noise, day: dayOf(store.getState().time) });
    }
    // 감염체가 몰려든 구역에 들어섰다 (플레이 테스트 11, D5: 다섯 번 들어가도 마주치지 않았다).
    // 길 위의 일보다 먼저 굴린다 (플레이 테스트 12: 길 위의 일이 먼저 열려 몰려든 구역의 마주침을 네 번에 한 번꼴로 막았다)
    if (alarmOnArrival) for (const d of runAlarm(ctx, alarmOnArrival)) {
      displays.push(d);
      if (d.type === "storylet" && d.event === "started") lines.push(`들어서다 들켰다: "${d.title}". 그 장면으로 이어 연출하라 (상태의 '진행 중인 이야기').`);
      else if (d.type === "belief" && d.fact) lines.push(`들어서다 ${d.fact}.`);
    }
    const arrival = runInfestedArrival(ctx, input.move_to);
    for (const d of arrival) {
      displays.push(d);
      if (d.type === "storylet" && d.event === "started") lines.push(`들어서자마자 일이 생겼다: "${d.title}". 도착한 자리의 장면으로 연출하라 (상태의 '진행 중인 이야기').`);
    }
    // 도착한 구역의 부대 (공통 규칙 23, 9-3): 길 위의 일보다 먼저. 마주쳤으면 그 길의 이야기는 열지 않는다
    const metParty = arrival.length ? [] : runPartySightings(ctx);
    displays.push(...metParty);
    // 들어서 보니 이미 있던 무리도 결과 줄로 알린다 (PT34 붉은연합 분대장·PT33 졸병: 상태의 "눈에 띈 무리"에만 있어 놓쳤다)
    for (const d of metParty) if (d.type === "belief" && d.fact) lines.push(`들어서 보니: ${d.fact}.`);
    // 길 위의 일 (12-53): 오는 길에 일이 생겼으면, 도착 직전 길 위의 장면으로 연출한다
    // 쫓겨 왔으면 길 위의 일은 없다: 맞붙음이 이어진다
    if (!arrival.length && !metParty.length && !chasing.length) for (const d of runRoadEvent(ctx, rideUsed?.roadRisk ?? 1)) {
      displays.push(d);
      if (d.type === "storylet" && d.event === "started") lines.push(`오는 길에 일이 생겼다: "${d.title}". 도착하기 전, 길 위의 장면으로 연출하라 (상태의 '진행 중인 이야기').`);
    }
  }

  // 무전 송출 (12-173): 시간이 흐른 뒤 누가 응답하는지
  if (input.broadcast && !time.interrupted && !store.getState().activeStorylet) {
    const sent = runBroadcast(ctx);
    lines.push(...sent.lines);
    displays.push(...sent.displays);
  }

  // 4. 시간이 흐른 뒤 세계 처리 (임무 기한, 오늘의 임무, 소문, 전쟁, 예정된 교전)
  // 이번 행동의 짓은 이야기를 고르기 전에 끝난 때를 적는다: 규율 회의는 끝난 때부터 한 시간 (PT27 졸병: 한 시간 넘는 수색 끝에 회의가 바로 열렸다)
  markDeedsEnded(ctx, start);
  // 이야기 선택지를 판정하는 행동이면 기한을 넘겨 끝나도 이야기를 붙잡아 둔다 (B6)
  const after = runAfterTimeAdvance(ctx, { urgentOnly: time.wokenByStory, actionStartedAt: input.check ? start.time : undefined });
  lines.push(...bodyLines(after));
  displays.push(...after);
  lines.push(...worldLines(after));
  // 끼니 활동만으로는 허기가 풀리지 않는다 (플레이 테스트 11: "끼니를 받아 먹는다" 뒤에도 허기짐)
  if (input.activity?.kind === "eat" && !input.use_item) lines.push("끼니 활동은 시간만 쓴다: 무리의 배급은 하루 한 번 저절로 먹고, 지닌 먹을 것은 use_item으로 먹어야 허기가 풀린다.");

  return { ok: true, resultText: lines.join("\n"), displays, outcome, dead: false };
}

/** 시간이 흐르며 세계에 생긴 일을 GM에게 알린다 (몸의 변화는 bodyLines) */
export function worldLines(displays: readonly ToolDisplayEvent[]): string[] {
  const lines: string[] = [];
  for (const display of displays) {
    if ((display.type === "presence" || display.type === "belief") && display.note) lines.push(display.note);
    if (display.type === "mission" && display.title.startsWith(SQUAD_REPORT_PREFIX)) {
      lines.push(`${display.title}: ${display.detail}. 보고 내용은 상태의 '분대' 섹션에 있다. 분대원이 돌아와(또는 전령으로) 보고하는 장면을 짧게 서술한다. 보고에 없는 것을 지어내지 않는다.`);
    } else if (display.type === "mission") lines.push(`임무 ${display.title}: ${display.detail}.`);
    if (display.type === "storylet" && display.event === "started") {
      lines.push(`새 이야기가 시작됐다: "${display.title}". 상태의 '진행 중인 이야기'를 보고 장면으로 연출하라.`);
    }
    if (display.type === "storylet" && display.event === "moved" && display.note) lines.push(display.note);
    // 시간이 흘러 지나간 이야기도 알린다 (플레이 테스트 13: 잠·휴식 사이에 이야기가 말없이 사라졌다)
    if (display.type === "storylet" && display.event === "expired") {
      lines.push(`이야기 "${display.title}"${josa(display.title, "은/는").slice(display.title.length)} 그대로 지나갔다${display.detail && display.detail !== "지나갔다" ? ` (${display.detail})` : ""}. 이야기 속 사람들은 그것을 기억할 수 있다.`);
    }
    if (display.type === "storylet" && display.event === "improv") {
      lines.push("즉흥 이야기 자리가 열렸다: 상태의 '즉흥 이야기 자리'를 보고, 지금 장면에 맞는 작은 일을 improvise_storylet로 지어 열 수 있다 (반복되던 이야기 대신).");
    }
    if (display.type === "battle" && display.event === "started") {
      lines.push(`전투가 시작됐다: ${display.detail} 상태의 '전투 중' 정보를 보고 첫 장면을 서술한 뒤 플레이어의 행동을 기다려라.`);
    }
  }
  return lines;
}

/** 시간이 흐르며 바뀐 몸 상태(허기, 감염, 저절로 낫기)를 GM에게 알린다 */
export function bodyLines(displays: readonly ToolDisplayEvent[]): string[] {
  return displays.flatMap((d) =>
    d.type === "heal"
      ? [`${d.targetName}의 ${d.trackLabel}: ${d.fromLabel} → ${d.toLabel} (${d.byLabel}).`]
      : d.type === "harm" && d.trackLabel !== ""
        ? [`${d.targetName}의 ${d.trackLabel}: ${d.fromLabel} → ${d.toLabel} (${d.cause}). 몸의 변화를 서술에 반영하라.${d.fatal ? DEATH_GUIDE : ""}`]
        : [],
  );
}

/** 상대에게 피해: 성공 = 선언한 만큼(light 1, heavy 2), 대가 있는 성공 = 1, 실패 = 0. 무력화되면 지닌 것을 알린다 */
function hitTarget(ctx: ToolContext, targetId: string, severity: "light" | "heavy", outcome: CheckOutcome, cause: string, wound: string | null) {
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
  // 이 판정으로 입힌 피해를 남긴다: 같은 판정으로 푸는 이야기가 같은 사람을 또 다치게 하면 큰 쪽만 (PT14)
  if (change) ctx.store.append({ type: "check_harm_dealt", checkId: lastCheckId(ctx), targetId, steps });
  if (change?.line) lines.push(change.line);
  if (change?.display) displays.push(change.display);
  // 맞은 사람의 마음 (공통 규칙 13, 12-257)
  const grudge = change && !change.died ? hurtResentment(ctx, targetId, steps) : null;
  if (grudge) lines.push(grudge);
  // 무기가 낸 상처에서 피가 난다 (12-91)
  if (!change?.died) {
    const bleed = bleedFromHarm(ctx, targetId, wound);
    if (bleed?.line) lines.push(bleed.display ? `${bleed.line} 지혈하지 않으면 시간이 흐르며 상처가 깊어진다.` : bleed.line);
    if (bleed?.display) displays.push(bleed.display);
    const scar = change ? scarFromHarm(ctx, targetId, wound, cause) : null;
    if (scar) lines.push(scar);
  }
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

/** 이 상대에게 이 스킬로 한 시간 안에 빗나간 판정이 있는가 (12-258) */
function justMissedAgainst(state: GameState, move: string, who: string | null | undefined): boolean {
  if (!who) return false;
  return Object.values(state.checks).some((c) => c.actorId === state.playerId && c.move === move && c.outcome === "miss" && c.opponent === who && c.at !== undefined && state.time - c.at <= RETRY_WINDOW_MINUTES);
}
const RETRY_WINDOW_MINUTES = 60;

function lastCheckId(ctx: ToolContext): string {
  const checks = Object.values(ctx.store.getState().checks);
  return checks[checks.length - 1]!.checkId;
}

/** 지금 자리에서 지켜야 하는 점호 시간대 (무리 문화 roll_call, 우리 거점에서 갇히지 않았을 때만) */
function rollCallSegments(ctx: ToolContext): TimeSegment[] {
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  const segments = me?.factionId ? ctx.content.factions[me.factionId]?.culture?.roll_call : undefined;
  if (!me || !segments?.length || heldOf(me) || !ownedBy(state, state.playerZone ?? "", me.factionId)) return [];
  return segments;
}

/** from 뒤 처음 오는 점호 시각 (없으면 null). 자는 주인공을 동료가 이때 깨운다 (12-251) */
function rollCallAt(ctx: ToolContext, from: number): number | null {
  const calls = rollCallSegments(ctx).map((seg) => nextSegmentStart(from, seg));
  return calls.length ? Math.min(...calls) : null;
}

/** 점호를 자면서 넘겼는가 (G2, 무리 문화 roll_call). 넘겼으면 상관에게 알려지는 작은 불복종 행적 */
function missedRollCall(ctx: ToolContext, from: number, to: number, wokeNow: boolean) {
  const segments = rollCallSegments(ctx);
  if (!segments.length || to <= from) return;
  // 쓰러져 있던 사람은 점호에 못 나온 것을 탓하지 않는다 (공통 규칙 2, 12-269 우회 점검: 의식을 잃은 채 sleep으로 시간을 흘려도 불복종이 남았다)
  const me = ctx.store.getState().characters[ctx.store.getState().playerId];
  if (!me || incapacitatingSymptom(ctx.content.scenario, me) || isIncapacitated(ctx.content, me)) return;
  // 점호 시각에 딱 깨면 나간 것으로 친다 (플레이 테스트 12: 04:00에 깼는데 놓친 것으로 셌다).
  // 점호에 깨워졌는데 그 자리에서 다시 자면 빠진 것이다 (12-251). 바로 앞이 잠이었을 때만: 깨어 있던 활동이 점호 시각에 끝난 뒤 자는 것은 나간 것이다
  // (12-312, 받아들임 판: 막사에서 "저녁까지 쉬기"가 17:00에 끝나고 잠들자 점호에 빠진 것으로 셌다)
  const missed = segments.filter((seg) => nextSegmentStart(from, seg) < to || (wokeNow && nextSegmentStart(from - 1, seg) === from));
  if (!missed.length) return;
  const commander = commanderIdOf(ctx.store.getState(), ctx.content);
  recordDeed(
    ctx,
    { summary: `${missed.map((m) => SEGMENT_LABELS[m]).join("·")} 점호에 자느라 나오지 않았다`, tags: ["disobedience"], severity: 1, privacy: "public", noisy: false },
    commander ? { npcId: commander, source: "report" } : undefined,
  );
}

/** 이 행동이 진행 중인 임무의 요건과 맞는가 (맞으면 그 임무 id). 이동 요건은 어디서든, 나머지는 임무 장소에서 */
function missionMatch(state: GameState, input: TakeActionInput): string | null {
  const m = activeMissionOf(state.missions, state.playerId);
  if (!m || heldOf(state.characters[state.playerId])) return null;
  const kind = input.move_to ? "travel" : (input.activity?.kind ?? null);
  const move = input.check?.move ?? null;
  const here = atMissionPlace(m, state.playerZone, state.zones, state.factions);
  const hit = m.requirements.some((r) => {
    if ("activity" in r) return !!kind && r.activity === kind && (kind === "travel" || here);
    if ("check" in r) return !!move && (r.check === move || !!r.alts?.includes(move)) && here;
    return false;
  });
  return hit ? m.id : null;
}

/** take_action의 treatment.pay를 치료 값 고르기로 */
function feeChoice(pay: "auto" | { item: string; quantity: number }[] | null | undefined): FeeChoice {
  if (!pay) return null;
  if (pay === "auto") return "default";
  const out: Record<string, number> = {};
  for (const p of pay) if (p.quantity > 0) out[p.item] = (out[p.item] ?? 0) + p.quantity;
  return out;
}

/** 남의 거점에서 뒤져 챙길 때 그 무리 사람이 곁에 없어도 들키는 확률 */
const THEFT_NOTICE_CHANCE = 0.3;

/** 위협 앞에서 거절하는 오래 걸리는 일 */
const LONG_IN_THREAT = ["sleep", "wait", "guard_duty", "rest", "search", "work"];

/** 판정 하나로 오르는 부상의 최대 단계 */
const MAX_HARM_STEPS = 2;

/** 이만큼(분) 넘게 자면 동행이 아닌 사람은 장면에서 빠진다 */

/** 판정 결과에 따른 피해 (원칙 3: 사망은 부상 트랙과 판정 결과로만) */
function applyHarm(ctx: ToolContext, checkId: string, severity: HarmSeverity, cause: string, opponentId: string | null = null, kind: string | null = null, spend: { activity: Activity; forMission: string | null } | null = null, fightLike = false) {
  const { store, content } = ctx;
  const state = store.getState();
  const track = harmTrack(content.scenario);
  const target = state.characters[state.playerId]!;
  const check = state.checks[checkId]!;
  // 상대의 몫 (12-104): 솜씨 좋은 상대는 한 단계 더, 서툰 상대는 한 단계 덜 (적어도 1단계)
  // 상대의 몫 +1은 실패에만 붙는다 (플레이 테스트 11: 대가 있는 성공에서 두 단계 올랐다). 서툰 상대의 -1은 늘 붙는다
  const found = opponentHarm(content, state, opponentId, check.move);
  const against = found && found.delta > 0 && check.outcome !== "miss" ? null : found;
  const base = harmSteps(check.outcome, severity);
  if (base === 0 && fightLike) {
    // 맞선 상대가 있거나 급한 장면이면 시간 대신 자세를 잃는다: 다음 판정 -1 (플레이 테스트 13: 감염체와 맞붙은 채 "일이 꼬여 30분")
    store.append({ type: "off_balance_changed", until: state.time + 60 });
    store.append({ type: "check_cost_paid", checkId });
    const label = levelOf(track, target.conditions[track.id] ?? track.levels[0]!.id).label;
    return {
      fatal: false,
      text: "다치지는 않았지만 자세가 무너졌다: 다음 판정 -1. 대가를 치른 모습을 서술한다.",
      display: { type: "harm" as const, targetName: target.name, trackLabel: track.label, severityLabel: HARM_LABELS[severity], fatal: false, fromLabel: label, toLabel: label, cause },
    };
  }
  if (base === 0 && state.timeCostDay === dayOf(state.time) && state.playerZone) {
    // 같은 날 두 번째부터는 시간 대신 소리가 난다 (12-258, PT15 튜토리얼: 대가가 거듭 "일이 꼬여 30분")
    store.append({ type: "noise_made", zone: state.playerZone, level: 1, day: dayOf(state.time) });
    store.append({ type: "check_cost_paid", checkId });
    const label = levelOf(track, target.conditions[track.id] ?? track.levels[0]!.id).label;
    return {
      fatal: false,
      text: "다치지는 않았지만 소리를 냈다. 몇 시간 안에 이 구역에 무언가 몰려들 수 있다. 대가를 치른 모습을 서술한다.",
      display: { type: "harm" as const, targetName: target.name, trackLabel: track.label, severityLabel: HARM_LABELS[severity], fatal: false, fromLabel: label, toLabel: label, cause },
    };
  }
  if (base === 0) {
    // 가벼운 위험의 대가 있는 성공: 다치지 않고 시간을 잃는다. 이 판정을 이어받는 이야기는 대가를 또 매기지 않는다 (플레이 테스트 12: 30분 + 경상)
    // 대가로 더 쓴 시간도 그 활동의 시간이다: 임무 수색이면 수색 시간으로 센다 (플레이 테스트 13)
    store.append({ type: "time_advanced", activity: spend?.activity ?? "brief", from: state.time, to: state.time + PARTIAL_TIME_COST, ...(spend?.forMission ? { forMission: spend.forMission } : {}) });
    store.append({ type: "check_cost_paid", checkId, timeDay: dayOf(state.time) });
    const label = levelOf(track, target.conditions[track.id] ?? track.levels[0]!.id).label;
    return {
      fatal: false,
      text: `다치지는 않았지만 일이 꼬여 ${PARTIAL_TIME_COST}분을 더 썼다. 대가를 치른 모습을 서술한다.`,
      display: { type: "harm" as const, targetName: target.name, trackLabel: track.label, severityLabel: HARM_LABELS[severity], fatal: false, fromLabel: label, toLabel: label, cause },
    };
  }
  // 한 판정으로 오르는 부상은 2단계까지 (플레이 테스트 13: 무거운 위험 + 상대의 몫으로 한 번에 경상 → 치명상)
  const raw = Math.min(MAX_HARM_STEPS, Math.max(1, base + (against?.delta ?? 0)));
  // 방어구·버팀·곁의 사람은 공통 규칙 13 (rules/damage.ts). 방어구는 맞서는 상대(사람·짐승·감염체)가 낸 상처만: 삐끗·덫·무너진 선반은 막지 않는다 (플레이 테스트 11)
  const attack = !!content.scenario.wounds?.kinds.find((k) => k.id === kind)?.attack;
  const reduced = reduceHarm(ctx, {
    who: target.id,
    raw,
    attack: (!!opponentId && kind !== "other") || attack,
    shareable: !!opponentId || fightLike,
    cause,
    track: track.id,
    opponent: opponentId,
    hurt: (who, n, why) => {
      const line = changeCondition(ctx, who, track.id, n, "enemy", why)?.line ?? null;
      // 감염체의 상처를 막아선 사람도 감염될 수 있다 (PT22 하얀매: 무는 감염체를 몸으로 받았는데 감염도 격리도 없었다). 살갗이 찢기는 상처일 때만
      const foe = opponentId ? ctx.store.getState().characters[opponentId] : undefined;
      if (foe && isInfected(content, foe) && (!content.scenario.wounds || !!woundKind(ctx, kind)?.bleeds)) maybeInfect(ctx, kind, who);
      return line;
    },
  });
  const absorbed = { steps: reduced.armored ? 0 : raw, lines: reduced.lines };
  if (against) absorbed.lines.unshift(`${against.line}.`);
  const steps = reduced.steps;
  const from = target.conditions[track.id] ?? track.levels[0]!.id;
  if (steps <= 0) {
    // 방어구가 다 막았다 (기획서 4.8). 이야기가 "다친다"를 다시 붙이지 않는다
    store.append({ type: "check_cost_paid", checkId });
    const label = levelOf(track, from).label;
    return {
      fatal: false,
      /** 방어구가 다 받아 냈다 (몸에 닿았다): 물림·할큄이면 감염은 굴린다 */
      armored: absorbed.steps <= 0,
      text: `${absorbed.lines.join(" ")} ${josa(target.name, "은/는")} 다치지 않았다. 막아 낸 순간을 서술한다.`.trim(),
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
    : incapacitatingSymptom(content.scenario, after)
      ? ` ${josa(target.name, "은/는")} 스스로 아무것도 할 수 없다 (${incapacitatingSymptom(content.scenario, after)!.label}). 흐려지는 감각을 서술에 반영하라.`
      : ` 몸 상태 전체의 판정 보정은 이제 ${signed(conditionPenalty(content.scenario, after))} (부상만이 아니라 지금의 모든 상태를 합친 것). 다친 감각을 서술에 반영하라.`;
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

/** 이동 수단을 탈 수 있는가 (12-137). 가진 것, 연료, 함께 걷는 사람, 물을 건너거나 빠져나가는 길 */
function planRide(ctx: ToolContext, itemId: string, blocked: boolean):
  | { ok: true; name: string; speed: number; fuel: string | null; noise: number; roadRisk: number }
  | { ok: false; error: string } {
  const { store, content } = ctx;
  const state = store.getState();
  const me = state.characters[state.playerId]!;
  const item = content.items[itemId];
  if (!item?.vehicle) return { ok: false, error: `${josa(item?.name ?? itemId, "은/는")} 탈 것이 아니다.` };
  if ((me.inventory[itemId] ?? 0) < 1) return { ok: false, error: `${josa(item.name, "이/가")} 없다.` };
  if (blocked) return { ok: false, error: "물을 건너거나 몰래 빠져나가는 길에는 탈 수 없다." };
  // 함께 걷는 사람이 있으면 그 걸음에 맞춘다 (개는 따라 뛴다)
  const walkers = activeCompanions(state).filter((id) => {
    const c = state.characters[id];
    return c && templateKind(c.extra ? content.extras[c.extra.template] : undefined) === "person";
  });
  if (walkers.length) return { ok: false, error: "함께 걷는 사람이 있어 그 걸음에 맞췄다." };
  const fuel = item.vehicle.fuel ?? null;
  if (fuel && (me.inventory[fuel] ?? 0) < 1) return { ok: false, error: `${josa(content.items[fuel]?.name ?? fuel, "이/가")} 없어 ${josa(item.name, "을/를")} 끌고 걸었다.` };
  return { ok: true, name: item.name, speed: item.vehicle.speed, fuel, noise: item.vehicle.noise, roadRisk: item.vehicle.road_risk };
}

/** 활동만큼 시간을 흘린다. 보초·잠·기다림은 빨리감기로, 도중에 끼어들기가 생기면 멈춘다 */
/** 잠 한 번의 최대 길이 (분) */
const MAX_SLEEP_MINUTES = 16 * 60;

/** exposure: 추위·젖음을 따질 때의 활동 (사냥·낚시는 activity가 무엇이든 바깥 일이다) */
/** 임무에 남은 작업 시간 (분, 5분 단위로 올림, 30분 이상). 임무 작업이 아니면 null */
function missionWorkLeft(state: GameState, forMission: string | null): number | null {
  const m = forMission ? state.missions[forMission] : undefined;
  if (!m) return null;
  const left = m.requirements.flatMap((r, i) => ("activity" in r && r.activity === "work" ? [r.minutes - (m.progress[i] ?? 0)] : [])).filter((n) => n > 0);
  return left.length ? Math.max(30, Math.ceil(Math.max(...left) / 5) * 5) : null;
}

export function advanceTime(ctx: ToolContext, activity: Activity, until: TimeSegment | null, forMission: string | null = null, speed = 1, dest: string | null = null, exposure: Activity = activity, fixedMinutes: number | null = null, hours: number | null = null) {
  const { store, rng, content } = ctx;
  const state = store.getState();
  const cost = ACTIVITY_COSTS[activity];
  const from = state.time;
  let to: number;
  let interrupt: ReturnType<typeof fastForward>["interrupt"] = null;
  // 깊은 잠 (12-188): 잠들 때의 몸으로 정한다 (자는 사이 피로가 풀려도 이미 깊이 잠들었다)
  const deep = activity === "sleep" ? deepSleepReason(content, state) : null;

  const extra: ToolDisplayEvent[] = [];
  let capped = false;
  /** 활동이 끝나기로 한 시각 (끝나는 그 시각에 열린 이야기는 "끊겼다"가 아니다) */
  let plannedEnd = Infinity;
  let restedCap = false;
  let napped = false;
  /** 이어진 잠의 시작 (상한은 이어진 잠 전체로 센다) */
  let sleepFrom = from;
  let sleepNote: string | null = null;
  if (cost.kind === "long") {
    // 잠은 한 번에 16시간까지 (아침에 "새벽까지"면 21시간을 잤다, 플레이 테스트 8). 기다림은 하루까지
    // 피곤하지 않으면 덜 잔다 (E4)
    const fatigue = content.scenario.body?.fatigue;
    const rested = !!fatigue?.rested_sleep_hours && (() => {
      const me = state.characters[state.playerId];
      const levels = content.scenario.condition_tracks.find((t) => t.id === fatigue.track)?.levels ?? [];
      return levels.findIndex((l) => l.id === me?.conditions[fatigue.track]) <= 0;
    })();
    // 중상 이상으로 누운 몸은 피곤과 상관없이 오래 잔다, 피곤하지 않은데 저녁 전에 누우면 낮잠 (12-255)
    const hurtLevels = harmTrack(content.scenario)?.levels ?? [];
    const hurtFrom = fatigue?.hurt_sleep_from ? hurtLevels.findIndex((l) => l.id === fatigue.hurt_sleep_from) : -1;
    const hurt = hurtFrom > 0 && hurtLevels.findIndex((l) => l.id === state.characters[state.playerId]?.conditions[content.scenario.harm_track]) >= hurtFrom;
    const sleepCap = activity === "sleep" ? sleepCapMinutes({ rested, hurt, lyingDownAt: from, maxMinutes: MAX_SLEEP_MINUTES, restedHours: fatigue?.rested_sleep_hours ?? 12, napHours: fatigue?.min_sleep_hours ?? 3 }) : null;
    napped = !!sleepCap?.nap;
    const cap = sleepCap ? sleepCap.minutes : MAX_FAST_FORWARD_MINUTES;
    // 임무 활동은 요건을 채우면 끝난다 (until을 걸지 않았으면). 시간을 세는 요건이 있는 활동이면 무엇이든 (PT20·PT21 의무병: 치료·수색은 30분씩이었다)
    const missionLeft = until ? null : missionMinutesLeft(state, forMission, activity);
    const wanted = activityTarget({ from, until: cost.allowUntil ? until : null, hours, missionLeft: hours ? null : missionLeft, defaultMinutes: cost.minutes });
    // 피곤하지 않은 잠의 상한은 이어진 잠 전체로 센다 (깬 지 얼마 안 돼 다시 잤으면 앞의 잠부터)
    const chainFrom = activity === "sleep" ? sleepChainStart(state, from) : from;
    sleepFrom = chainFrom;
    let target = Math.min(wanted, Math.max(from + 30, chainFrom + cap));
    // 점호가 있는 무리의 거점에서 자면 점호 시각에 동료가 깨운다 (12-251, 플레이 테스트 14: "아침까지"가 새벽 점호를 넘겨 불복종이 쌓였다)
    const call = activity === "sleep" ? rollCallAt(ctx, from) : null;
    if (call !== null && call < target) {
      target = call;
      sleepNote = `점호 시각이라 동료가 깨웠다. 더 자면 점호에 빠진 것으로 친다.`;
    }
    plannedEnd = target;
    capped = wanted > target;
    restedCap = capped && activity === "sleep" && rested;
    // 자정을 넘기면 자정에서 하루 처리(전쟁 틱)를 돌린 뒤 이어 간다. 그래야 새벽 교전에서 멈출 수 있다
    let cursor = from;
    for (;;) {
      const midnight = dayOf(cursor) * MINUTES_PER_DAY;
      const segmentEnd = Math.min(target, midnight);
      const stops = slotOpensBetween(store.getState(), content, cursor, segmentEnd);
      const result = fastForward({ state: store.getState(), start: cursor, until: segmentEnd, rng, stops, checks: createInterruptChecks(content.scenario, [createCampCheck(content, activity, deep), createPartyCheck(content, activity), createStoryletCheck(content, { asleep: activity === "sleep", activity })]) });
      store.append({
        type: "time_advanced",
        activity,
        from: cursor,
        to: result.end,
        ...(result.interrupt ? { interrupt: result.interrupt } : {}),
        ...(forMission ? { forMission } : {}),
        ...(dest ? { dest } : {}),
      });
      // 그동안의 기온 (12-98): 자정 전에 재야 그날의 날씨로 잰다
      extra.push(...exposeToCold(ctx, exposure, cursor, result.end));
      // 잠은 다 잔 뒤에 한꺼번에 셈한다: 선잠(min_sleep_hours보다 짧은 잠)은 피로를 풀지 못한다 (E4)
      extra.push(...exposeToFatigue(ctx, activity === "sleep" ? "rest" : activity, cursor, result.end));
      cursor = result.end;
      interrupt = result.interrupt;
      if (interrupt || cursor >= target) break;
      // 자정의 하루 처리. 이야기는 여기서 열지 않는다: 활동이 이어져 보이지 않은 채 만료됐다 (C1, 플레이 테스트 10).
      // 활동 도중의 이야기는 끼어들기 검사(createStoryletCheck)가 활동을 끊고 연다
      extra.push(...runAfterTimeAdvance(ctx, { storylets: false }));
      if (store.getState().battle) break;
      // 하루 처리에서 시간이 흘렀으면(자는 사이 쓰러져 끌려감 등) 그 활동은 거기서 끝난다 (12-273, 자동 플레이: 잠을 이어 가다 "시간이 어긋납니다")
      if (store.getState().time !== cursor) {
        cursor = store.getState().time;
        break;
      }
    }
    to = cursor;
    if (activity === "sleep" && to - from >= (content.scenario.body?.fatigue?.min_sleep_hours ?? 0) * 60) extra.push(...exposeToFatigue(ctx, "sleep", from, to));
    // 푹 잔 밤에 상처가 아문다 (플레이 테스트 11, A1)
    if (activity === "sleep") {
      // 이어진 잠은 한 밤으로 친다 (플레이 테스트 13: 21:45~00:00, 00:15~06:00으로 끊겨 상처가 아물지 않았다)
      const nightFrom = sleepChainStart(state, from);
      const healed = healFromSleep(ctx, nightFrom, to);
      extra.push(...healed);
      if (!healed.length) sleepNote = [sleepNote, sleepHealBlocker(ctx, nightFrom, to)].filter(Boolean).join("\n") || null;
    }
    // 점호 (G2): 무리의 점호 시각을 자면서 넘기면 작은 불복종 행적이 남는다 (한 번 잠에 한 번)
    if (activity === "sleep") missedRollCall(ctx, from, to, state.lastWokeAt === from);
    // 긴 잠 뒤에 흩어지는 사람은 시간대가 바뀔 때 장면을 비우는 규칙이 맡는다 (B④, 공통 규칙 15 sceneLeavesAt)
  } else {
    // 이동은 길마다 정해진 시간, 짐이 무거우면 15분 더 (12-239)
    const me = state.characters[state.playerId];
    // 아는 구역은 어디서든 선언 한 번으로 가지만, 그 구역 가는 길까지 걷는 칸 수만큼 더 든다 (12-304, 칸마다 5분)
    const road = activity === "travel" && dest && state.playerZone ? roadTo(state, content, dest) : null;
    const at = currentPlace(state, content);
    const walk = road && at && road.id !== at.id ? stepsBetween(state, content, at.id, road.id) : 0;
    const toRoad = Number.isFinite(walk) ? walk * PLACE_MOVE_MINUTES : 0;
    const base = activity === "travel" && dest && state.playerZone ? routeMinutes(state.playerZone, dest, content) + toRoad + (me && encumbrance(content, me, state) > 0 ? 15 : 0) : null;
    // 짧은 활동(수색 등)도 임무 요건이 남은 만큼만 (PT22 분대장: 30분 남았는데 1시간 30분)
    const left = missionMinutesLeft(state, forMission, activity);
    to = from + (fixedMinutes ?? (activity === "combat" ? (content.scenario.battle?.round_minutes ?? ACTIVITY_COSTS.combat.minutes) : Math.max(MIN_TURN_MINUTES, Math.round((left ?? base ?? rollActivityMinutes(cost, rng)) * speed))));
    // 0분이면 시간이 흐르지 않는다 (장소 옮기기에 들어간 잠깐 행동)
    if (to > from) {
      store.append({
        type: "time_advanced",
        activity,
        from,
        to,
        ...(forMission ? { forMission } : {}),
        ...(dest ? { dest } : {}),
      });
      extra.push(...exposeToCold(ctx, exposure, from, to));
      extra.push(...exposeToFatigue(ctx, activity, from, to));
    }
  }

  const label = ACTIVITY_LABELS[activity];
  const lines = [`${label}: ${formatDuration(to - from)} 경과. 현재 ${formatTime(to)}.`];
  if (sleepNote) lines.push(sleepNote);
  if (segmentOf(from) !== segmentOf(to)) {
    lines.push(`시간대가 ${SEGMENT_LABELS[segmentOf(from)]}에서 ${josa(SEGMENT_LABELS[segmentOf(to)], "으로/로")} 바뀌었다. 빛과 소리의 변화를 서술에 반영하라.`);
  }
  // 야영지에 다가온 것 (12-148): 끊긴 시각에 야영의 이야기를 연다
  const camp = interrupt?.detail === CAMP_INTERRUPT ? runCampEvent(ctx, activity, deep) : null;
  // 부대가 들어섰다 (공통 규칙 23 마주침): 본 것을 알리고, 덤비면 매복당한 채로
  const partyMet = interrupt?.detail.startsWith(`${PARTY_INTERRUPT}:`) ? runPartyInterrupt(ctx, interrupt.detail) : null;
  if (partyMet) {
    extra.push(...partyMet);
    lines.push(`${josa(label, "이/가")} 끊겼다: 무리가 이 구역에 들어섰다.${activity === "sleep" ? " 곁에서 흔들어 깨웠다." : ""}`);
  } else if (camp?.line) {
    lines.push(`${josa(label, "이/가")} 끊겼다. ${camp.line}`);
    extra.push(...camp.displays);
  } else if (interrupt?.kind === "storylet" && to >= plannedEnd && !deep) {
    // 정한 시각에 끝났고 그때 이야기가 열렸다 (플레이 테스트 13: 정한 시각에 끝났는데 "끊겼다")
    lines.push(`${josa(label, "이/가")} 끝날 무렵 일이 생겼다.`);
  } else if (interrupt?.kind === "storylet") {
    // 깊은 잠 (12-188): 지쳐서·아파서 깊이 잠들었으면 늦게 깼다고 알린다 (이야기는 그대로 열린다)
    lines.push(`${josa(label, "이/가")} 끊겼다: 무언가 일이 생겼다.${deep ? ` ${deep} 탓에 깊이 잠들어 있어 몸이 무거워 늦게 깼다. 이미 일이 가까이 와 있다고 서술하라.` : ""}`);
  } else if (interrupt?.kind === "battle") {
    lines.push(`${josa(label, "이/가")} 끊겼다: 무언가 벌어지고 있다.`);
  } else if (!interrupt && capped) {
    // C12 (플레이 테스트 10): 상한에 걸려 말없이 03시에 깼다
    // 피곤하지 않아 일찍 깬 잠은 그렇다고 알린다 (플레이 테스트 12: 8시간에 깼는데 "16시간까지다")
    // 숫자는 이번에 실제로 잔 시간으로. 깬 지 얼마 안 돼 다시 잤으면 앞의 잠과 합친 시간도 (PT14: 3시간 50분·30분 잔 잠에 "12시간 자고")
    const chained = sleepFrom < from ? ` (조금 전에 깬 잠과 이어져 모두 ${formatDuration(to - sleepFrom)})` : "";
    lines.push(
      activity === "sleep"
        ? restedCap
          ? napped
            ? `피곤하지 않아 낮잠으로 끝났다 (${formatDuration(to - from)})${chained}. 밤잠은 저녁 뒤에.`
            : `피곤하지 않아 ${formatDuration(to - from)} 자고 저절로 깼다${chained}. 더 자려면 지친 뒤에.`
          : `잠은 한 번에 ${MAX_SLEEP_MINUTES / 60}시간까지다. ${formatDuration(to - from)} 자고 정한 시각 전에 깼다${chained}.`
        : "한 번에 흘려보낼 수 있는 시간은 하루까지다. 정한 시각 전에 멈췄다.",
    );
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
    /** 자다가 급한 이야기에 깼다: 깬 뒤에는 급한 이야기만 연다 (12-187) */
    wokenByStory: activity === "sleep" && interrupt?.kind === "storylet",
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

/** 열린 이야기를 두고 자리를 떴다: 외면 선택지가 있으면 그것으로, 없으면 외면하고 떠난 것으로 (공통 규칙 17 "이야기의 자리") */
function walkAwayFromStory(ctx: ToolContext, start: GameState): string[] {
  const { store, content } = ctx;
  const live = store.getState().activeStorylet;
  if (!live) return [];
  const s = storyletOf(start, content, live.id);
  const pick = s?.choices.find((c) => WALK_AWAY_CHOICES.includes(c.id) && !c.check && choiceAvailable(start, c, live.cast));
  const r = pick ? withoutBlame("walked_away", () => resolveStorylet.run({ choice_id: pick.id, improvised_move: null }, ctx)) : null;
  // 따옴표 안 말에 맞춰 조사 (플레이 테스트 13: "낯선 손님의 공책"를)
  const quoted = (t: string) => `"${t}"${josa(t, "을/를").slice(t.length)}`;
  if (r?.ok) return [`(이야기 ${quoted(storyTitle(start, content, s!))} 두고 자리를 떠, ${quoted(pick!.label)} 고른 것으로 처리했다)`, r.resultText ?? ""];
  endActiveStorylet(ctx, "외면하고 떠났다");
  const title = s ? storyTitle(start, content, s) : live.id;
  return [`이야기 "${title}"${josa(title, "을/를").slice(title.length)} 외면하고 자리를 떴다. 그 일은 그대로 지나갔다 (이야기 속 사람들은 그것을 기억할 수 있다).`];
}

/**
 * 임무 활동은 요건이 남은 만큼만 (until·hours를 걸지 않았으면). 시간을 세는 요건이 있는 활동이면 무엇이든, 5분 단위로 올림
 * (PT20·PT21 의무병: 치료·수색은 30분씩, PT22: 25분 남았는데 30분)
 */
function missionMinutesLeft(state: GameState, forMission: string | null | undefined, activity: Activity): number | null {
  if (!forMission || activity === "sleep" || activity === "travel") return null;
  const m = state.missions[forMission];
  if (!m) return null;
  const left = m.requirements.flatMap((r, i) => ("activity" in r && r.activity === activity ? [r.minutes - (m.progress[i] ?? 0)] : [])).filter((n) => n > 0);
  return left.length ? Math.max(5, Math.ceil(Math.max(...left) / 5) * 5) : null;
}
