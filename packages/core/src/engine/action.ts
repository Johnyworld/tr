import { applyBuild, planBuild } from "./facilities.ts";
import { applyTrain, planTrain } from "./training.ts";
import { applyLesson, planLesson } from "./teaching.ts";
import { planBroadcast, runBroadcast } from "./broadcast.ts";
import { ambushDifficulty, applyAmbush, isConfused, leaveAmbush, planAmbush } from "./ambush.ts";
import { templateKind } from "../game/kinds.ts";
import { activeCompanions } from "../game/companions.ts";
import { forage, forageProblem, handleTrap, trapProblem } from "./forage.ts";
import { buryRemains } from "./remains.ts";
import { resistSteps } from "./growth.ts";
import { breakTruceIfAny } from "./diplomacy.ts";
import { exposeToFatigue } from "./fatigue.ts";
import { deliverPrisoners, escapeRule, releasePlayer } from "./captivity.ts";
import { BELIEF_SOURCE_LABELS } from "../game/belief.ts";
import { rollBlowup, rollHear, rollLeak } from "./persona.ts";
import { exposeToCold, changeClothes, soak } from "./climate.ts";
import { opponentHarm } from "./opposition.ts";
import { calmAfterSleep, fearTagIds, frighten, FRIGHT_CAUSES } from "./fear.ts";
import { runAlarm, runInfestedArrival, runRoadEvent } from "./storyletTools.ts";
import { CAMP_INTERRUPT, createCampCheck, runCampEvent, deepSleepReason } from "./camp.ts";
import { shakeNerves, sleepNerves } from "./body.ts";
import { afterAttack, applyCraft, armorAbsorb, armorBlocksInfection, carriedWeight, encumbrance, planAttack, planCraft, rangeProblem } from "./gear.ts";
import { scavenge } from "./scavenge.ts";
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
import { activeMissionOf, atMissionPlace, MISSION_CHECK_TRIES, MISSION_FAIL_MINUTES } from "../game/missions.ts";
import { neighbors } from "../sim/war.ts";
import { endBattle, playBattleRound, validateBattleAction } from "./battleTools.ts";
import { bleedFromHarm, woundKind } from "./bleeding.ts";
import { scarFromHarm } from "./scars.ts";
import { createStoryletCheck, endActiveStorylet, resolveStorylet, storyTitle } from "./storyletTools.ts";
import { choiceAvailable } from "../story/storylets.ts";
import { recordDeath } from "./succession.ts";
import { incapacitatingSymptom } from "../scenario/scenario.ts";
import { applyTreatment, drinkWater, healFromSleep, itemUseProblem, maybeInfect, refillWater, treatmentProblem, useItem } from "./body.ts";
import { dayOf, MINUTES_PER_DAY } from "../rules/time.ts";
import { DEATH_GUIDE, signed, type ToolContext, type ToolDisplayEvent } from "./toolkit.ts";

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
        harm_cause: z.string().max(120).describe("다친다면 그 원인 한 문장 (위험이 none이면 빈 문자열)"),
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
            "맞서는 상대 인물 id (장면에 있어야 한다): 숨는 나를 찾는 사람, 덤벼드는 사람, 속이려는 상대. 공격이면 비워도 target이 상대다 (설득처럼 함께하는 말은 target만으로 상대가 되지 않는다. 맞서는 흥정이면 여기에 둔다). " +
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
        until: timeSegmentSchema.nullable().default(null).describe("sleep·wait 전용: 이 시간대가 시작될 때까지. 다른 활동은 null"),
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
          ? "이번 턴에 플레이어 캐릭터가 겁먹을 일이 드러났는데 이야기·인물 데이터로 잡히지 않는 순간일 때만: startle 깜짝 놀람(기습, 갑자기 튀어나옴), dread 압도됨(떼, 끔찍한 광경). 오를지·얼마나는 시스템이 정한다. 대부분 none"
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
        who: z.string().describe("상태의 '묻히지 않은 유해' 줄의 보관 위치"),
        words: z.string().max(60).nullable().describe("묘비에 새길 짧은 말 (플레이어가 정했으면 그대로, 아니면 null). 주인공이었던 사람은 연대기의 묘비명을 쓴다"),
      })
      .nullable()
      .default(null)
      .describe("이 구역의 유해를 묻는다 (두 시간 작업). 같은 무리 사람이면 사기·지켜본 사람의 호감은 시스템이 정한다. 아니면 null"),
    drink: z
      .boolean()
      .default(false)
      .describe("물이 있는 곳(상태의 \"물\" 줄)에서 플레이어가 물을 마시겠다고 하면 true. 얼마나 풀리는지, 거점에서 보급을 받는지는 시스템이 정한다"),
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
        target: z
          .string()
          .nullable()
          .default(null)
          .describe("다른 사람을 치료하면 그 사람 id (장면에 있어야 한다. 아이템 없이는 의무병이나 응급처치를 익힌 사람만. 피만 멎게 하는 맨손 지혈은 누구나: check move를 응급처치로 함께). 주인공 자신이면 null"),
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
      .describe("수행 중인 임무를 위한 행동이면 true. true일 때만 판정과 활동이 임무 진행으로 집계된다 (임무 장소·목적과 맞는 행동만)"),
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
const WALK_AWAY_CHOICES = ["leave", "ignore", "look_away", "pass", "walk_away", "move_on", "let_go", "decline", "refuse", "turn_away", "walk_on", "leave_it", "let_be", "say_nothing", "silent", "nothing", "shrug", "later", "hold_back", "stay_out", "not_now", "stay_silent", "back_off", "away"];

export function takeAction(input: TakeActionInput, ctx: ToolContext): TakeActionResult {
  const { store, content } = ctx;
  const scenario = content.scenario;
  const start = store.getState();
  const player = start.characters[start.playerId];
  if (!player) return { ok: false, error: "플레이어 캐릭터가 없습니다." };
  if (player.dead) return { ok: false, error: "캐릭터가 사망했습니다." };
  // 마시기·채우기는 지금 있는 곳의 물로 한다: 이동과 함께 오면 출발지에서 물을 찾았다 (플레이 테스트 11)
  if (input.move_to && input.refill) return { ok: false, error: "이동과 물 채우기는 한 번에 하지 않는다. 먼저 옮긴 뒤, 도착한 곳에서 refill을 따로 한다 (시간은 흐르지 않았다)." };
  // 진행 중인 이야기를 두고 떠나거나 오래 머물면 결과 없이 사라졌다 (플레이 테스트 11: 깔린 동료를 두고 갔는데 아무 일 없었다).
  // 외면하는 선택지(leave·ignore 등, 판정 없는 것)가 있으면 그것을 고른 것으로 풀고, 없으면 지나갔다고 분명히 알린다
  // 수색·일·쉬기는 이야기 안에서도 하는 일이라 넣지 않는다 (선택지의 판정을 거기서 굴린다)
  const long = !!input.move_to || (!!input.activity && ["sleep", "wait", "guard_duty", "travel"].includes(input.activity.kind));
  // 길 위의 일은 도착하기 전의 장면이다: 판정 없이 다른 일을 하면 길에서 두고 온 것으로 친다 (플레이 테스트 11: 붉은연합 순찰조원이 우리 거점 장면에 남아 목격자가 됐다)
  const roadTag = scenario.travel?.tag;
  const onRoad = !!roadTag && !!start.activeStorylet && !!content.storylets[start.activeStorylet.id]?.tags.includes(roadTag) && !input.check && (!!input.deed || (!!input.activity && input.activity.kind !== "talk"));
  const leftLines: string[] = [];
  if (start.activeStorylet && (long || onRoad) && !isIncapacitated(ctx.content, player)) {
    const s = content.storylets[start.activeStorylet.id];
    const pick = s?.choices.find((c) => WALK_AWAY_CHOICES.includes(c.id) && !c.check && choiceAvailable(start, c, start.activeStorylet!.cast));
    const r = pick ? resolveStorylet.run({ choice_id: pick.id, improvised_move: null }, ctx) : null;
    if (r?.ok) leftLines.push(`(이야기 "${storyTitle(start, ctx.content, s!)}"를 두고 자리를 떠, "${pick!.label}"를 고른 것으로 처리했다)`, r.resultText ?? "");
    else {
      endActiveStorylet(ctx, "외면하고 떠났다");
      leftLines.push(`이야기 "${s ? storyTitle(start, ctx.content, s) : start.activeStorylet.id}"를 외면하고 자리를 떴다. 그 일은 그대로 지나갔다 (이야기 속 사람들은 그것을 기억할 수 있다).`);
    }
  }
  // 혼란은 그 자리의 일이다: 자리를 옮기거나 오래 쉬면 가신다 (플레이 테스트 11: 매복의 혼란이 14시간 잠 뒤 판정에 붙었다)
  if (long && isConfused(start, start.playerId)) store.append({ type: "confusion_changed", characterId: start.playerId, on: false });
  // 잠입 중 (12-154): 옮기거나 오래 머물지 않는다. 잠입은 infiltrate로 (빠지기부터)
  if (start.infiltration && (input.move_to || (input.activity && ["sleep", "rest", "wait", "guard_duty", "search", "work"].includes(input.activity.kind)))) {
    return { ok: false, error: "잠입 중이다. 옮기거나 오래 머물려면 먼저 infiltrate leave로 빠져나온다." };
  }
  // 의식불명 등: 스스로 아무것도 하지 못한다. 시간이 흐르게 하거나(기다림·잠·휴식) 남이 돌보는(treatment, 치료사에게 받기) 것만
  const out = incapacitatingSymptom(scenario, player);
  if (out) {
    const acts = !!input.check || !!input.move_to || !!input.target || !!input.prepare || !!input.use_item || !!input.bury || !!input.forage || !!input.trap || input.drink || input.refill || input.change_clothes || !!input.craft || !!input.build || !!input.train || !!input.lesson || input.broadcast || input.ambush || !!input.battle || !!input.deed || (input.treatment && (input.treatment.item || input.treatment.target));
    const passive = !input.activity || ["wait", "sleep", "rest"].includes(input.activity.kind);
    if (acts || !passive) {
      return {
        ok: false,
        error: `${josa(player.name, "은/는")} ${out.label} 상태라 스스로 아무것도 할 수 없다. 판정·이동·말·물건 쓰기 없이 activity(wait 또는 sleep, 전투 중이면 null)로 시간만 흐르게 한다. 장면의 치료사가 돌보면 treatment {item: null}. 서술은 흐릿한 감각의 조각만 짧게.`,
      };
    }
  }
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
  // 사거리 (12-93): 장면의 인물을 치면 거리를 고르고, 무기가 닿는 거리여야 한다. 전투 라운드의 공격은 거리를 고르면 보정만
  const strikes = !!input.check && !!input.target && input.check.target_harm !== "none";
  if (input.check && (strikes || input.check.distance)) {
    const far = rangeProblem(content, player, input.check.move, input.check.distance);
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
  if (input.move_to && start.characters[start.playerId]?.captive) {
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
    if (!zone || start.zones[zone]?.owner !== player.factionId) return { ok: false, error: "준비물은 우리 무리의 구역에만 설치할 수 있다." };
    if (prep.requires_item && (player.inventory[prep.requires_item] ?? 0) < 1) return { ok: false, error: `${prep.label}에는 ${josa(content.items[prep.requires_item]?.name ?? prep.requires_item, "이/가")} 필요하다.` };
    const short = Object.entries(prep.materials ?? {}).filter(([id, n]) => (player.inventory[id] ?? 0) < n);
    if (short.length) return { ok: false, error: `${prep.label}에는 재료가 모자라다: ${short.map(([id, n]) => `${content.items[id]?.name ?? id} ${n}개`).join(", ")}.` };
    if (!input.check) return { ok: false, error: `${prep.label} 설치에는 판정(check)이 필요하다.` };
  }

  const unknownTag = input.fright_tags.find((t) => !fearTagIds(scenario).includes(t));
  if (unknownTag) return { ok: false, error: `알 수 없는 fright_tags: ${unknownTag} (가능: ${fearTagIds(scenario).join(", ") || "없음"})` };
  if (input.check?.opponent) {
    const o = start.characters[input.check.opponent];
    if (!o || o.dead || !start.scene.present.includes(input.check.opponent)) return { ok: false, error: `맞서는 상대 ${josa(input.check.opponent, "은/는")} 장면에 없다. check.opponent는 장면에 있는 인물 id다.` };
  }

  store.append({ type: "turn_started", turn: start.turn + 1, input: input.intent });
  const forMission = input.for_mission ? (activeMissionOf(start.missions, start.playerId)?.id ?? null) : null;
  const lines: string[] = [];
  lines.push(...leftLines.filter(Boolean));
  // 임무의 장소가 아니면 임무로 치지 않는다 (플레이 테스트 4: 거점 안에서 초소 보초를 마쳤다)
  {
    const m = forMission ? start.missions[forMission] : undefined;
    if (m?.place && !input.move_to && !atMissionPlace(m, start.playerZone, start.zones, start.factions)) lines.push(`(여기는 임무의 장소(${m.place.label})가 아니라 이번 행동은 임무로 치지 않는다.)`);
  }
  const displays: ToolDisplayEvent[] = [];
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
  // 할 수 없는 일은 판정·시간 전에 막는다 (플레이 테스트 11: 쓸 필요 없는 붕대, 치료사 아닌 사람의 치료, 거점 안 사냥이 판정과 30분을 쓴 뒤 거절됐다)
  {
    const fuel = !!input.use_item && !!scenario.body?.cold?.climate?.fire?.items[input.use_item];
    const problem =
      (input.use_item && !fuel ? itemUseProblem(ctx, input.use_item) : null) ??
      (input.treatment ? treatmentProblem(ctx, input.treatment.item, input.treatment.target, input.check?.move ?? null) : null) ??
      (input.forage && !input.move_to ? forageProblem(ctx, input.forage) : null) ??
      (input.trap ? trapProblem(ctx, input.trap) : null);
    if (problem) return { ok: false, error: `${problem} (시간은 흐르지 않았다)` };
  }

  // 1. 판정과 선언한 위험
  if (input.check) {
    const roll = rollPlayerCheck(
      { move: input.check.move, stat: input.check.stat, difficulty: input.ambush ? ambushDifficulty(input.check.difficulty) : input.check.difficulty, intent: input.intent, distance: input.check.distance, opponent: input.check.opponent },
      ctx,
      { target: input.target, forMission, noTools: !!input.train, forage: input.forage },
    );
    if (!roll.ok) {
      // 턴은 이미 시작됐으므로 잠깐의 시간만 흐르게 하고 오류를 알린다
      advanceTime(ctx, "brief", null);
      return { ok: false, error: roll.error };
    }
    outcome = roll.outcome;
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
    displays.push(roll.display);
    // 임무 판정이 빗나가면 30분을 더 쓴다 (플레이 테스트 11, C2: 5분마다 다시 굴려 채웠다). 같은 조건은 세 번 빗나가면 닫힌다
    {
      const m = forMission ? store.getState().missions[forMission] : undefined;
      const i = m ? m.requirements.findIndex((r) => "check" in r && r.check === input.check!.move) : -1;
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
    // 적대하는 땅에서 숨기가 실패하면 들킨다 (플레이 테스트 11, D6)
    if (roll.outcome === "miss") {
      for (const d of runAlarm(ctx, input.check.move)) {
        displays.push(d);
        if (d.type === "storylet" && d.event === "started") lines.push(`들켰다: "${d.title}". 그 장면으로 이어 연출하라 (상태의 '진행 중인 이야기').`);
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
      const harm = applyHarm(ctx, roll.checkId, input.check.harm_on_failure, input.check.harm_cause || input.intent, opponent, input.check.harm_kind ?? null);
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
        const shaken = shakeNerves(ctx, nerves.heavy_harm, `크게 다쳤다 (${input.check.harm_cause || input.intent})`);
        if (shaken?.line) lines.push(shaken.line);
      }
      // 감염은 살갗이 찢긴 상처(피가 나는 종류)일 때만 (12-91). 출혈 규칙이 없는 월드면 그대로
      const broken = !scenario.wounds || !!woundKind(ctx, input.check.harm_kind)?.bleeds;
      if (!harm.fatal && hurt && input.check.infected_source && broken) {
        const guard = armorBlocksInfection(ctx);
        if (guard.blocked) lines.push(...guard.lines);
        else maybeInfect(ctx, input.check.harm_kind ?? null);
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
  if (input.activity?.kind === "search" && !inBattle) {
    const found = scavenge(ctx, outcome);
    lines.push(...found.lines);
    displays.push(...found.displays);
  }

  // 1-0-1. 먹을 것 구하기와 덫 (12-131)
  for (const [request, run] of [
    [input.forage, () => forage(ctx, input.forage!, outcome)],
    [input.trap, () => handleTrap(ctx, input.trap!)],
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
    [input.treatment, () => applyTreatment(ctx, input.treatment!.item, input.treatment!.target, input.check && outcome ? { move: input.check.move, outcome } : null)],
    [input.use_item, () => useItem(ctx, input.use_item!)],
    [input.drink || null, () => drinkWater(ctx)],
    [input.refill || null, () => refillWater(ctx)],
    [input.change_clothes || null, () => changeClothes(ctx)],
    [input.bury, () => buryRemains(ctx, input.bury!.who, input.bury!.words)],
  ] as const) {
    if (!request) continue;
    const t = run();
    if (t.ok) {
      lines.push(...t.lines);
      displays.push(...t.displays);
    } else {
      lines.push(`${request === input.bury ? "묻지 못했다" : request === input.change_clothes ? "갈아입지 못했다" : request === input.drink ? "물을 마시지 못했다" : request === input.refill ? "물을 채우지 못했다" : "몸을 돌보지 못했다"}: ${t.error}`);
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
  const activity: Activity = inBattle ? "combat" : input.move_to ? "travel" : (input.activity?.kind ?? (input.treatment ? "treat" : input.use_item ? ((content.scenario.consumables[input.use_item]?.hunger ?? 0) > 0 ? "eat" : "brief") : input.drink || input.refill || input.change_clothes ? "brief" : input.craft || input.build || input.train || input.lesson || input.bury || input.trap === "set" ? "work" : input.forage ? "search" : input.broadcast ? "talk" : "brief"));
  // 이동 수단 (12-137): 타고 가면 이동 시간이 줄고, 연료를 쓰고, 도착한 곳에 소리가 난다
  const ride = input.move_to && input.ride ? planRide(ctx, input.ride, !!crossingAttempt || escapeAttempt) : null;
  if (ride && !ride.ok) lines.push(`타지 못하고 걸었다: ${ride.error}`);
  const rideUsed = ride?.ok ? ride : null;
  if (rideUsed?.fuel) store.append({ type: "item_consumed", holder: start.playerId, itemId: rideUsed.fuel, quantity: 1 });
  // 무전 송출은 30분 (대화 ×3, 12-173)
  // 사냥·낚시·채집은 바깥 일이다 (플레이 테스트 11: activity work로 낚시해 실내로 쳐져 비 오는 날 옷이 말랐다)
  const exposure: Activity = input.forage && !["travel", "guard_duty", "combat"].includes(activity) ? "search" : activity;
  const timeBefore = store.getState().time;
  const time = advanceTime(ctx, activity, input.activity?.until ?? null, forMission, rideUsed?.speed ?? (input.broadcast && activity === "talk" ? 3 : 1), input.move_to ?? null, exposure);
  // 물일 임무 (E3): 임무 자리에서 그 일을 하면 옷이 젖는다. 방수복을 입으면 젖지 않는다
  if (forMission && !input.move_to && activity !== "brief") {
    const m = store.getState().missions[forMission];
    if (m && content.missions[m.templateId]?.wets && atMissionPlace(m, store.getState().playerZone, store.getState().zones, store.getState().factions)) {
      displays.push(...soak(ctx, start.playerId, "물일을 하다 옷이 젖었다", true));
    }
  }
  lines.push(time.text);
  if (input.activity || input.move_to) displays.push(time.display);
  // 가르침 (4.2.1): 흐른 시간만큼 배운다
  if (input.lesson && !inBattle) lines.push(...applyLesson(ctx, input.lesson, store.getState().time - timeBefore));
  displays.push(...time.extra);
  lines.push(...bodyLines(time.extra));
  // 긴 활동이 자정을 넘으며 생긴 일(분대 보고, 동행이 떠남, 임무 기한, 어긴 약속)도 글로 알린다 (플레이 테스트 11: 잠든 사이의 분대 보고가 빠졌다)
  lines.push(...worldLines(time.extra));
  // 자고 나면 공포가 가라앉고 (12-95), 끊기지 않고 푹 자면 마음도 가라앉을 수 있다
  if (activity === "sleep") {
    const calm = calmAfterSleep(ctx);
    lines.push(...calm.lines);
    displays.push(...calm.displays);
    const rested = time.interrupted ? null : sleepNerves(ctx, store.getState().time - start.time);
    if (rested?.display) {
      lines.push(rested.line);
      displays.push(rested.display);
    }
  }
  // 건너기 시도가 실패하면 물살에 밀려 되돌아온다 (시간과 위험은 이미 치렀다)
  const sweptBack = crossingAttempt && outcome === "miss";
  const escapeFailed = escapeAttempt && outcome === "miss";
  if (escapeFailed) lines.push("빠져나가지 못했다. 다시 붙잡혀 갇힌 곳으로 끌려왔다. 감시가 더 심해졌다.");
  if (sweptBack) lines.push(`${content.locations[input.move_to!]?.name ?? input.move_to}에 닿지 못하고 되돌아왔다. 되돌아온 장면을 서술한다.`);
  if (input.move_to && !time.interrupted && !sweptBack && !escapeFailed) {
    if (escapeAttempt) {
      const freed = releasePlayer(ctx, false);
      if (freed) lines.push(freed);
    }
    // 자리를 뜨면 그 자리의 이야기는 끝난다 (장면의 인물도 따라오지 않는다)
    displays.push(...endActiveStorylet(ctx, "자리를 떴다"));
    const deposited = start.playerZone ? store.getState().deposits?.[start.playerZone] : undefined;
    leaveAmbush(ctx);
    store.append({ type: "zone_moved", from: start.playerZone, to: input.move_to });
    if (deposited) lines.push(`맡겨 둔 것을 돌려받고 떠났다: ${Object.entries(deposited).map(([id, n]) => `${content.items[id]?.name ?? id}${n > 1 ? ` ×${n}` : ""}`).join(", ")}.`);
    // 끌고 온 포로: 우리 무리의 거점에 닿으면 우리 무리의 포로가 된다 (12-55)
    lines.push(...deliverPrisoners(ctx));
    // 동행은 따라온다. 그 밖의 장면 인물만 남는다 (플레이 테스트 11: 동행이 왔는데 "따라오지 않는다"가 늘 나왔다)
    const came = activeCompanions(store.getState()).map((id) => playerCalls(store.getState(), content, id));
    lines.push(`${content.locations[input.move_to]?.name ?? input.move_to}에 도착했다.${came.length ? ` 동행(${came.join(", ")})은 함께 왔다.` : ""} 그 밖에 함께 있던 인물은 따라오지 않는다 (같이 왔다면 npc_presence로 다시 등장시킨다).`);
    if (rideUsed) {
      lines.push(`${josa(rideUsed.name, "을/를")} 타고 왔다.${rideUsed.noise ? " 엔진 소리가 구역에 울렸다. 무언가 몰려들 수 있다." : ""}`);
      if (rideUsed.noise) store.append({ type: "noise_made", zone: input.move_to, level: rideUsed.noise, day: dayOf(store.getState().time) });
    }
    // 길 위의 일 (12-53): 오는 길에 일이 생겼으면, 도착 직전 길 위의 장면으로 연출한다
    for (const d of runRoadEvent(ctx, rideUsed?.roadRisk ?? 1)) {
      displays.push(d);
      if (d.type === "storylet" && d.event === "started") lines.push(`오는 길에 일이 생겼다: "${d.title}". 도착하기 전, 길 위의 장면으로 연출하라 (상태의 '진행 중인 이야기').`);
    }
    // 감염체가 몰려든 구역에 들어섰다 (플레이 테스트 11, D5: 다섯 번 들어가도 마주치지 않았다)
    for (const d of runInfestedArrival(ctx, input.move_to)) {
      displays.push(d);
      if (d.type === "storylet" && d.event === "started") lines.push(`들어서자마자 일이 생겼다: "${d.title}". 도착한 자리의 장면으로 연출하라 (상태의 '진행 중인 이야기').`);
    }
  }

  // 무전 송출 (12-173): 시간이 흐른 뒤 누가 응답하는지
  if (input.broadcast && !time.interrupted && !store.getState().activeStorylet) {
    const sent = runBroadcast(ctx);
    lines.push(...sent.lines);
    displays.push(...sent.displays);
  }

  // 4. 시간이 흐른 뒤 세계 처리 (임무 기한, 오늘의 임무, 소문, 전쟁, 예정된 교전)
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
function worldLines(displays: readonly ToolDisplayEvent[]): string[] {
  const lines: string[] = [];
  for (const display of displays) {
    if ((display.type === "presence" || display.type === "belief") && display.note) lines.push(display.note);
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
  return lines;
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
  if (change?.line) lines.push(change.line);
  if (change?.display) displays.push(change.display);
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

function lastCheckId(ctx: ToolContext): string {
  const checks = Object.values(ctx.store.getState().checks);
  return checks[checks.length - 1]!.checkId;
}

/** 판정 결과에 따른 피해 (원칙 3: 사망은 부상 트랙과 판정 결과로만) */
function applyHarm(ctx: ToolContext, checkId: string, severity: HarmSeverity, cause: string, opponentId: string | null = null, kind: string | null = null) {
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
  if (base === 0) {
    // 가벼운 위험의 대가 있는 성공: 다치지 않고 시간을 잃는다
    store.append({ type: "time_advanced", activity: "brief", from: state.time, to: state.time + PARTIAL_TIME_COST });
    const label = levelOf(track, target.conditions[track.id] ?? track.levels[0]!.id).label;
    return {
      fatal: false,
      text: `다치지는 않았지만 일이 꼬여 ${PARTIAL_TIME_COST}분을 더 썼다. 대가를 치른 모습을 서술한다.`,
      display: { type: "harm" as const, targetName: target.name, trackLabel: track.label, severityLabel: HARM_LABELS[severity], fatal: false, fromLabel: label, toLabel: label, cause },
    };
  }
  const raw = Math.max(1, base + (against?.delta ?? 0));
  // 입은 방어구가 피해를 줄인다 (기획서 4.8). 맞서는 상대(사람·짐승·감염체)가 낸 상처만: 삐끗·덫·무너진 선반은 막지 않는다 (플레이 테스트 11: 덧댄 갑옷이 허리 삐끗을 막다 4시간 만에 부서졌다)
  const attack = !!content.scenario.wounds?.kinds.find((k) => k.id === kind)?.attack;
  const absorbed = (opponentId && kind !== "other") || attack ? armorAbsorb(ctx, raw) : { steps: raw, lines: [] };
  if (against) absorbed.lines.unshift(`${against.line}.`);
  // 버팀 (12-109): 레벨만큼 단계를 피한다
  const steps = resistSteps(content.scenario, target.level ?? 1, absorbed.steps, ctx.rng);
  if (steps < absorbed.steps) absorbed.lines.push(`${josa(target.name, "은/는")} ${absorbed.steps - steps}단계를 버텨 냈다.`);
  const from = target.conditions[track.id] ?? track.levels[0]!.id;
  if (steps <= 0) {
    // 방어구가 다 막았다 (기획서 4.8)
    const label = levelOf(track, from).label;
    return {
      fatal: false,
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
export function advanceTime(ctx: ToolContext, activity: Activity, until: TimeSegment | null, forMission: string | null = null, speed = 1, dest: string | null = null, exposure: Activity = activity) {
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
  if (cost.kind === "long") {
    // 잠은 한 번에 16시간까지 (아침에 "새벽까지"면 21시간을 잤다, 플레이 테스트 8). 기다림은 하루까지
    // 피곤하지 않으면 덜 잔다 (E4)
    const fatigue = content.scenario.body?.fatigue;
    const rested = !!fatigue?.rested_sleep_hours && (() => {
      const me = state.characters[state.playerId];
      const levels = content.scenario.condition_tracks.find((t) => t.id === fatigue.track)?.levels ?? [];
      return levels.findIndex((l) => l.id === me?.conditions[fatigue.track]) <= 0;
    })();
    const cap = activity === "sleep" ? (rested ? fatigue!.rested_sleep_hours! * 60 : MAX_SLEEP_MINUTES) : MAX_FAST_FORWARD_MINUTES;
    const wanted = until && cost.allowUntil ? nextSegmentStart(from, until) : from + cost.minutes;
    const target = Math.min(wanted, from + cap);
    capped = wanted > target;
    // 자정을 넘기면 자정에서 하루 처리(전쟁 틱)를 돌린 뒤 이어 간다. 그래야 새벽 교전에서 멈출 수 있다
    let cursor = from;
    for (;;) {
      const midnight = dayOf(cursor) * MINUTES_PER_DAY;
      const segmentEnd = Math.min(target, midnight);
      const result = fastForward({ state: store.getState(), start: cursor, until: segmentEnd, rng, checks: createInterruptChecks(content.scenario, [createCampCheck(content, activity, deep), createStoryletCheck(content, { asleep: activity === "sleep", activity })]) });
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
    }
    to = cursor;
    if (activity === "sleep" && to - from >= (content.scenario.body?.fatigue?.min_sleep_hours ?? 0) * 60) extra.push(...exposeToFatigue(ctx, "sleep", from, to));
    // 푹 잔 밤에 상처가 아문다 (플레이 테스트 11, A1)
    if (activity === "sleep") extra.push(...healFromSleep(ctx, from, to));
  } else {
    to = from + (activity === "combat" ? (content.scenario.battle?.round_minutes ?? ACTIVITY_COSTS.combat.minutes) : Math.max(MIN_TURN_MINUTES, Math.round(rollActivityMinutes(cost, rng) * speed)));
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

  const label = ACTIVITY_LABELS[activity];
  const lines = [`${label}: ${formatDuration(to - from)} 경과. 현재 ${formatTime(to)}.`];
  if (segmentOf(from) !== segmentOf(to)) {
    lines.push(`시간대가 ${SEGMENT_LABELS[segmentOf(from)]}에서 ${josa(SEGMENT_LABELS[segmentOf(to)], "으로/로")} 바뀌었다. 빛과 소리의 변화를 서술에 반영하라.`);
  }
  // 야영지에 다가온 것 (12-148): 끊긴 시각에 야영의 이야기를 연다
  const camp = interrupt?.detail === CAMP_INTERRUPT ? runCampEvent(ctx, activity, deep) : null;
  if (camp?.line) {
    lines.push(`${josa(label, "이/가")} 끊겼다. ${camp.line}`);
    extra.push(...camp.displays);
  } else if (interrupt?.kind === "storylet") {
    // 깊은 잠 (12-188): 지쳐서·아파서 깊이 잠들었으면 늦게 깼다고 알린다 (이야기는 그대로 열린다)
    lines.push(`${josa(label, "이/가")} 끊겼다: 무언가 일이 생겼다.${deep ? ` ${deep} 탓에 깊이 잠들어 있어 몸이 무거워 늦게 깼다. 이미 일이 가까이 와 있다고 서술하라.` : ""}`);
  } else if (interrupt?.kind === "battle") {
    lines.push(`${josa(label, "이/가")} 끊겼다: 무언가 벌어지고 있다.`);
  } else if (!interrupt && capped) {
    // C12 (플레이 테스트 10): 상한에 걸려 말없이 03시에 깼다
    lines.push(activity === "sleep" ? "잠은 한 번에 16시간까지다. 정한 시각 전에 깼다." : "한 번에 흘려보낼 수 있는 시간은 하루까지다. 정한 시각 전에 멈췄다.");
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
