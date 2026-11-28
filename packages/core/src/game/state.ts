// immer의 배포용 빌드를 바로 쓴다: 기본 진입점은 NODE_ENV가 없으면 검사가 많은 개발용 빌드를 골라 두 배 느리다
import type * as Immer from "immer";
// @ts-ignore 배포용 빌드는 타입 선언이 따로 없다 (API는 "immer"와 같다)
import * as immerProduction from "../../node_modules/immer/dist/immer.production.mjs";
const { produce, setAutoFreeze } = immerProduction as typeof Immer;

// 상태를 얼리지 않는다: 리듀서 밖에서 고치지 않는 것은 규칙으로 지킨다 (테스트가 상태를 직접 만지기도 한다)
setAutoFreeze(process.env.TRPG_FREEZE === "1");
import { historyPartSchema } from "./background.ts";
import { TIE_KINDS } from "./ties.ts";
import { z } from "zod";
import { josa } from "../text.ts";
import type { Rng } from "../rng.ts";
import { CHECK_OUTCOMES, difficultySchema } from "../rules/check.ts";
import { harmSeveritySchema } from "../rules/harm.ts";
import { deedKind } from "../rules/regard.ts";
import { activitySchema, dayOf, MINUTES_PER_DAY, segmentEnd, START_TIME } from "../rules/time.ts";
import { interruptSchema } from "../sim/fastForward.ts";
import type { Content, NpcContent, RoleContent } from "../content/schemas.ts";
import { idEnum, type Scenario } from "../scenario/schema.ts";
import { initialConditions, moveIds, rankIds, statIds, trackIds } from "../scenario/scenario.ts";
import { beliefSchema, beliefSourceSchema, type Belief } from "./belief.ts";
import { activeMissionOf, atMissionPlace, markMissionMet, isRequirementClosed, isRequirementMet, missionInstanceSchema, outcomeAtLeast } from "./missions.ts";
import {
  applyRelationDelta,
  deedSchema,
  NEUTRAL_RELATION,
  relationDeltaSchema,
  relationSchema,
  type RelationDelta,
} from "./reputation.ts";
import { createCharacterSchema, inventorySchema, type Character, type Inventory } from "./character.ts";
import { startingSkills } from "./creation.ts";

/**
 * 세이브 형식 버전. GameState나 GameEvent를 호환되지 않게 바꾸면 올리고,
 * 이전 세이브를 옮기는 방법을 함께 만든다.
 * 필드 추가는 기본값(.default)을 주면 이전 세이브와 호환되므로 올리지 않는다.
 * - 2: 시나리오 팩 분리. 능력치 ID 변경, injury → conditions, scenarioId
 * - 7: 인물을 아는 것을 만남(met)과 이름(known)으로 나눴다 (기획서 6.3). 엑스트라는 처음부터 이름이 있고 사라지지 않는다.
 *   extra_named·extra_gone 이벤트가 없어져 이전 세이브는 읽지 않는다
 * - 80: 스킬 개편 (4.2.1). 전문 기술은 적혀 있어야 할 수 있다. 이전 세이브는 upgradeSkills로 옮긴다
 */
// 109: 길목 다섯 (12-302). 구역과 맞닿음이 바뀌어 이전 세이브는 보관함으로
// 110: 받아들임·들어갈 자리 (12-308~311). 손님·자리·복무 시작 상태와 주민 계급 id(resident)가 바뀌어 이전 세이브는 보관함으로
// 111: 길목 더 늘리기와 길목·구역 합치기 (12-313). 구역 32곳, 맞닿음이 바뀌어 이전 세이브는 보관함으로
// 112: 움직이는 부대 ① (docs/war-parties-plan.md). 상태 parties·nextPartyNo, war_day_simulated.parties
// 113: 움직이는 부대 ② (12-315). 부대 met·routedAt, 세력 seen, partiesUpTo·partySightings, 이벤트 party_sighted
// 114: 움직이는 부대 ③-1 (12-316). 닿을 때 계산(이벤트 parties_advanced), recentClashes.party
// 115: 움직이는 부대 ③-2 (12-317). partyFights, battle.party, 세력 defeats, 이벤트 party_engaged·party_fight_ended
// 116: 움직이는 부대 ③-3 (12-318). 클락 credits, 교전·부대 할 일 credits·surprise, 이벤트 clock_credited
// 117: PT32 고침 (12-320). 마주침 기록 열쇠에 방문, parties_advanced.nextPartyNo
// 118: 파트 13·14 (12-322). 이벤트 zone_heard, 부서진 시설(wrecked), 의무실 부상자(wounded)
// 119: 움직이는 부대 ④ (12-324). 부대 할 일 intercept, 구역 alerted, partiesSeen·partyAlerts, 이벤트 party_alerted·party_alert_settled, Clash.squad
// 120: PT34 고침 (12-325). garrisonSeen, 이벤트 party_reported
// 121: PT35 고침 (12-326). partyAlerts.closed, party_reported.gone, 할 일 occupy.credits, war_day_simulated 클락 target
// 122: 알리기 구조 (12-327). partyIntel, partyAlerts.until, party_alerted.until
// 126: 지도에 아는 전황 (12-336). partyIntel.zone (본·전해 들은 곳)
// 127: 큰 이야기 (공통 규칙 24, docs/saga-plan.md). sagas, 이벤트 saga_*
// 128: 큰 이야기 인물 (offstage, 이벤트 npc_arrived)
// 130: 필수품 (공통 규칙 25, 12-357). traps.item, trap_set.item
// 131: 가방 (공통 규칙 26, 12-358). bags, bagSeq, equipped.back, 이벤트 bag_packed·item_transferred.bagId·item_stashed.bagId·item_equipped.bagId
// 133: 함께 걷던 사람 (12-368). walkingWith. 기한이 지나도 남는 임무 (12-369): mission_reported.disobedience, 이벤트 walkers_released
export const SAVE_SCHEMA_VERSION = 133;

/** 계획 목표가 바뀌면 그 목표에 쌓인 공(credits)을 비운다: 다른 목표의 "덕분에"로 옮겨 붙지 않게 (PT37 약탈조원) */
function retarget(clock: { target: string; credits?: unknown }, target: string): void {
  if (clock.target !== target) delete clock.credits;
  clock.target = target;
}
/** 이 버전보다 앞선 세이브는 스킬을 옮긴다 (upgradeSkills) */
export const SKILL_REWORK_VERSION = 80;

/**
 * 스킬 개편 이전 세이브 옮기기 (4.2.1): 스킬 값의 뜻이 바뀌었다.
 * - 전문 기술이 최저값(-1)이고 시작 스킬(과거 배경의 배치)에 없던 것은 "못 함"으로 (지우기)
 * - 누구나 하는 일의 값과 나머지 값은 그대로 (이미 쓴 점수로 본다)
 * - 쌓인 레벨업은 새 곡선으로 다시 센다: 레벨이 달라진 만큼 스킬 포인트를 더하거나 뺀다 (0 아래로는 가지 않는다)
 */
export function upgradeSkills(state: GameState, s: Scenario, levelForXp: (xp: number) => number): GameState {
  const next = structuredClone(state);
  const min = s.ranges.skill.min;
  for (const c of Object.values(next.characters)) {
    const pastSkills = c.past ? (s.creation?.pasts.find((p) => p.id === c.past!.id)?.skills ?? {}) : {};
    for (const m of s.moves) {
      if (m.kind === "expert" && (c.skills[m.id] ?? min) <= min && pastSkills[m.id] === undefined) delete c.skills[m.id];
    }
    const level = levelForXp(c.xp);
    if (level !== c.level) {
      c.skillPoints = Math.max(0, c.skillPoints + level - c.level);
      c.level = level;
    }
  }
  return next;
}
/** 이 버전부터의 세이브는 이벤트를 스키마 기본값으로 올려 읽는다 */
export const MIN_READABLE_SAVE_VERSION = 7;

/** 장면의 물건 보관 위치. 캐릭터 id 또는 "scene"(현재 장면 바닥) */
export const SCENE_HOLDER = "scene";

/** 자유 시나리오의 역할 id (콘텐츠의 역할 id와 겹치지 않는다) */
export const CUSTOM_ROLE_ID = "custom";

/** 자유 시나리오의 역할. 코드가 검증된 고르기로 만들어 세이브에 넣는다 (game/customStart.ts) */
const customRoleSchema = z.custom<RoleContent>((v) => typeof v === "object" && v !== null && typeof (v as { id?: unknown }).id === "string");

/** 지금 주인공의 역할: 콘텐츠의 역할, 자유 시나리오면 세이브에 든 역할 */
export function roleOf(content: Content, state: Pick<GameState, "roleId" | "customRole">): RoleContent | undefined {
  return content.roles[state.roleId] ?? state.customRole ?? undefined;
}

const checkOutcomeSchema = z.enum(CHECK_OUTCOMES);

/** 세력의 지금 상태 (기획서 9.1). 진짜 값이므로 UI·프롬프트에는 정보 필터를 거쳐 대략만 보낸다 */
export const factionStateSchema = z.strictObject({
  population: z.number().int().min(0),
  combatants: z.number().int().min(0),
  resources: z.record(z.string(), z.number().int().min(0)),
  morale: z.number().int().min(-3).max(3),
  cohesion: z.number().int().min(-3).max(3),
  /** 다른 세력에 대한 지금 태도 (-3 ~ +3). 없으면 콘텐츠의 시작값 (이전 세이브). 이야기·클락(shift)으로 바뀐다 */
  disposition: z.record(z.string(), z.number().int().min(-3).max(3)).optional(),
  /** 무리 방침 (주제 id → 선택지 id, 기획서 9.11). 없는 주제는 시나리오의 default */
  policy: z.record(z.string(), z.string()).optional(),
  /** AI 무리끼리 맺은 휴전 (12-146): 상대 무리 id → 남은 날, 끝나면 돌릴 이 무리의 태도 */
  truces: z.record(z.string(), z.strictObject({ days: z.number().int().min(0), restore: z.number().int().min(-3).max(3) })).optional(),
  /** 이 무리의 부대가 본 다른 무리의 빈틈 (7-2): 상대 무리 id → 이 시각까지 그 무리를 노린다 */
  seen: z.record(z.string(), z.number().int()).optional(),
  /** 최근에 진 시각 (6-3 기세): 사흘 안에 두 번 지면 사기 -1 */
  defeats: z.array(z.number().int()).optional(),
});
export type FactionState = z.infer<typeof factionStateSchema>;

/** 함께 다니는 이유 (기획서 7.9) */
export const BOND_KINDS = ["animal", "buddy", "squad", "purpose", "kin", "prisoner"] as const;
export type BondKind = (typeof BOND_KINDS)[number];
/** 목적 동행이 끝나는 조건 (하나라도 차면 갈림길) */
/**
 * 의뢰의 목표 (12-291). kind: 찾아오기(물건은 약속의 item)·사람 찾기·붙잡아 오기·처치하기.
 * template: 목표 엑스트라 틀(찾아오기는 null), target: 받은 뒤 세계에 둔 엑스트라 id, zone·place: 목표가 있는 곳, pay: 해내면 받을 보수
 */
export const questSchema = z.strictObject({
  kind: z.enum(["fetch", "find", "capture", "kill"]),
  template: z.string().nullable(),
  target: z.string().nullable(),
  zone: z.string(),
  place: z.string().nullable(),
  hops: z.number().int().min(0),
  pay: z.strictObject({ id: z.string(), quantity: z.number().int().positive() }).nullable(),
  /** 찾아오기: 의뢰인에게 이미 건넨 수 (나눠 건네도 센다, 12-292) */
  delivered: z.number().int().min(0).default(0),
  /** 기한 날수: 내놓을 때 정한다 (받을 때 같은 날수, 12-293. 0이면 받을 때 굴린다) */
  days: z.number().int().min(0).default(0),
});

export const bondUntilSchema = z.strictObject({
  flag: z.string().optional(),
  zone: z.string().optional(),
  at: z.number().int().optional(),
});
export const bondSchema = z.strictObject({
  kind: z.enum(BOND_KINDS),
  since: z.number().int(),
  /** 임무 짝: 이 임무가 끝나면 돌아간다 */
  missionId: z.string().optional(),
  until: bondUntilSchema.optional(),
  /** 목적을 이뤄 갈림길에 섰다 (lean: 남고 싶어 하는지, decideBy: 정하지 않으면 이 시각에 기울기대로) */
  crossroads: z.strictObject({ lean: z.enum(["stay", "leave"]), decideBy: z.number().int() }).optional(),
  /** 잠시 떨어져 있다: zone에서 기다리거나(until null), 볼일을 보고 until에 돌아온다(zone null) */
  /** left: 주인공이 남겨 둔 구역을 한 번 떠났나. false면 아직 그 자리라 합류하지 않는다 (플레이 테스트 12: 남겨 두자마자 다시 따라왔다). 이전 세이브는 없음 = 떠난 것으로 */
  /** place: 기다리는 장소 (null·없음 = 구역에 막 들어선 자리). 같은 구역 안에서 그 장소를 떠났다 돌아오면 합류한다 (PT14 떠돌이: 같은 구역에서 다시 합류하지 않아 개를 잃었다) */
  apart: z.strictObject({ zone: z.string().nullable(), until: z.number().int().nullable(), since: z.number().int(), left: z.boolean().optional(), place: z.string().nullable().optional() }).optional(),
});
export type Bond = z.infer<typeof bondSchema>;

/** 인물 사이의 관계 한 줄: a는 b의 kind (기획서 7.10) */
export const tieRecordSchema = z.strictObject({
  a: z.string(),
  b: z.string(),
  kind: z.enum(TIE_KINDS),
  secret: z.strictObject({ reveal_when: z.string(), min_trust: z.number().int() }).nullable(),
});

/** 세력 클락: 다 차면 목표 구역을 총공격한다 */
export const clockStateSchema = z.strictObject({
  factionId: z.string(),
  label: z.string(),
  target: z.string(),
  filled: z.number().int().min(0),
  max: z.number().int().positive(),
  /** 이 계획을 앞당긴 일 (움직이는 부대 파트 11): 누가·어떤 임무로·정찰이었는지. 공세가 터지면 소식에 실리고 비운다 */
  credits: z.array(z.strictObject({ by: z.string(), mission: z.string(), scout: z.boolean() })).optional(),
});
export type ClockState = z.infer<typeof clockStateSchema>;

/** 하루 전쟁 틱에서 일어난 교전 */
export const clashSchema = z.strictObject({
  kind: z.enum(["raid", "skirmish", "assault", "occupy"]),
  attacker: z.string(),
  /** 빈 구역 차지(occupy)는 null */
  defender: z.string().nullable(),
  zone: z.string(),
  success: z.boolean(),
  attackerLosses: z.number().int().min(0),
  defenderLosses: z.number().int().min(0),
  /** 세력 클락이 다 차서 벌어진 총공격이면 그 클락 id */
  plan: z.string().optional(),
  /** 습격으로 빼앗은 자원 */
  loot: z.record(z.string(), z.number().int().min(0)).optional(),
  /** 이 공세를 앞당긴 일 (파트 11): 누가·어떤 임무로 */
  credits: z.array(z.strictObject({ by: z.string(), mission: z.string() })).optional(),
  /** 분대 가로막기의 맞붙음 (5-4): 우리 쪽 손실은 분대원의 다침이라 의무실 부상자로 셈하지 않는다 */
  squad: z.boolean().optional(),
});
export type Clash = z.infer<typeof clashSchema>;

/**
 * 움직이는 부대 (docs/war-parties-plan.md 파트 1~3). 무리 전투원에서 빠져나가 길을 걷고, 목표에 닿으면 할 일(task)을 하고 돌아온다.
 * 위치는 legs(구역마다 머무는 시각 범위)로 언제든 다시 센다. 진짜 위치·규모·목적은 GM에게 나가지 않는다 (원칙 4)
 */
export const partyLegSchema = z.strictObject({ zone: z.string(), from: z.number().int(), to: z.number().int() });
export const partyTaskSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("clash"),
    clash: z.enum(["raid", "skirmish", "assault"]),
    defender: z.string(),
    plan: z.string().optional(),
    /** 이 공세를 앞당긴 일 (파트 11) */
    credits: z.array(z.strictObject({ by: z.string(), mission: z.string() })).optional(),
    /** 정찰로 적 배치를 알고 치는 기습 (파트 11): 첫 교환 화력 배수 */
    surprise: z.boolean().optional(),
  }),
  z.strictObject({ kind: z.literal("occupy"), plan: z.string().optional(), credits: z.array(z.strictObject({ by: z.string(), mission: z.string() })).optional() }),
  z.strictObject({ kind: z.literal("trade"), partner: z.string(), give: z.record(z.string(), z.number().int().min(0)), get: z.record(z.string(), z.number().int().min(0)) }),
  /** 정찰·순찰: 가서 보고 돌아온다. plan이 있으면 그 공세를 앞두고 나간 정찰 */
  z.strictObject({ kind: z.literal("watch"), plan: z.string().optional() }),
  /**
   * 가로막기 (5-3·5-4): 목표 구역에 숨어 until까지 기다리다 지나가는 적대 부대를 친다 (남의 땅에서도 매복).
   * squad: 분대 가로막기면 그 분대원(이름 있는 사람, 쓰러지면 인원이 아니라 다침으로), by: 이 부대를 내게 한 주인공, result: 맞붙은 결과
   */
  z.strictObject({
    kind: z.literal("intercept"),
    until: z.number().int(),
    squad: z.array(z.string()).default([]),
    by: z.string().nullable().default(null),
    result: z.strictObject({ enemy: z.string(), faction: z.string(), size: z.number().int(), won: z.boolean(), losses: z.number().int().min(0) }).optional(),
    /** 이 계획의 공세가 올 때까지 머문다 (공세 계획의 정찰을 설득해 낸 부대, PT40 사용자 결정): 그 사이 다른 무리를 이겨도 돌아가지 않는다 */
    hold: z.string().optional(),
  }),
]);
export const partySchema = z.strictObject({
  id: z.string(),
  faction: z.string(),
  kind: z.enum(["scout", "raid", "assault", "supply", "patrol"]),
  size: z.number().int().min(0),
  /** 이끄는 이름 있는 인물 (습격·공세만, 파트 1-3). 아직 정하지 않았으면 null */
  leader: z.string().nullable().default(null),
  home: z.string(),
  goal: z.string(),
  /** 가는 길 (마지막 칸이 goal, 그 to가 닿는 시각) */
  legs: z.array(partyLegSchema).min(1),
  task: partyTaskSchema,
  /** 할 일을 마쳤으면 true (돌아오는 길) */
  done: z.boolean().default(false),
  /** 돌아오는 길 (마지막 칸의 to가 거점에 닿는 시각). 할 일을 마친 뒤에 정한다 */
  back: z.array(partyLegSchema).default([]),
  /** 나르는 것 (교역 짐·약탈물) */
  carry: z.record(z.string(), z.number().int().min(0)).default({}),
  /** 이미 마주친 부대 (한 짝은 한 번만 마주친다, 공통 규칙 23) */
  met: z.array(z.string()).default([]),
  /** 마주쳐 지고 달아난 시각. 같은 날 또 지면 남은 사람이 붙잡힌다 (4-4) */
  routedAt: z.number().int().nullable().default(null),
});
export type PartyLeg = z.infer<typeof partyLegSchema>;
export type PartyTask = z.infer<typeof partyTaskSchema>;
export type Party = z.infer<typeof partySchema>;

/** 플레이어가 낄 교전: 그날 새벽으로 예정해 두고, 그때 그 자리에 있으면 전투 장면으로 연다 (기획서 9.5) */
export const pendingClashSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(["raid", "skirmish", "assault"]),
  attacker: z.string(),
  defender: z.string(),
  zone: z.string(),
  at: z.number().int(),
  plan: z.string().optional(),
  /** 움직이는 부대가 닿아 벌어진 교전: 실제로 온 인원 (PT36 졸병: 적 38로 시작했다, 본 부대는 21명) */
  force: z.number().int().min(1).optional(),
});
export type PendingClash = z.infer<typeof pendingClashSchema>;

/**
 * 큰 이야기 하나의 상태 (공통 규칙 24). 세계의 것이라 주인공이 바뀌어도 남는다.
 * act: 지금 막 (open = 문이 열려 시작 사건을 기다림, ended = 끝남), days: 이 막의 기한(일, 모른 척이면 절반), lapsed: 기한을 넘겨 세계가 넘긴 막,
 * engaged: 큰 이야기의 이야기를 겪은 캐릭터, scenes: GM에게 보이는 지난 장면 몇 줄, notedFlags: 실마리 표에서 이미 쓴 플래그
 */
export const sagaStateSchema = z.strictObject({
  act: z.string(),
  openedAt: z.number().int(),
  actStartedAt: z.number().int(),
  days: z.number().nullable(),
  ending: z.string().nullable(),
  endedAt: z.number().int().nullable(),
  endedByLapse: z.boolean(),
  note: z.string().nullable(),
  noteZone: z.string().nullable(),
  marked: z.string().nullable(),
  lapsed: z.array(z.string()),
  engaged: z.array(z.string()),
  scenes: z.array(z.string()),
  notedFlags: z.array(z.string()),
});
export type SagaState = z.infer<typeof sagaStateSchema>;

/** 연대기: 죽은 캐릭터 한 명의 기록 (기획서 3.2). 플레이어(사람)가 보는 기록이고, 다음 캐릭터의 지식은 아니다 */
/** 다짐 (12-164): 갈래(kind), 대상, 둘째 대상(휴전의 상대), 수, 한 줄, 세운 때, 출처, 무리·구역 다짐에서 주인공이 그 전투에 꼈는지 */
export const resolveSchema = z.strictObject({
  kind: z.string(),
  target: z.string().nullable(),
  target2: z.string().nullable(),
  n: z.number().int().nullable(),
  text: z.string(),
  since: z.number().int(),
  source: z.enum(["scenario", "story"]),
  involved: z.boolean(),
  /** 단계 (이야기가 올린다)와 지금 어디까지 왔는지 한 줄 */
  stage: z.number().int().min(0).default(0),
  step: z.string().nullable().default(null),
  /** 코드가 단계를 올린 마지막 날, 빚 다짐이 마지막으로 본 빚 (플레이 테스트 12: 이야기가 열리지 않으면 며칠이 지나도 0단계) */
  autoDay: z.number().int().optional(),
  mark: z.number().int().optional(),
});

export const runRecordSchema = z.strictObject({
  characterId: z.string(),
  name: z.string(),
  factionId: z.string(),
  rank: z.string(),
  startedAt: z.number().int(),
  diedAt: z.number().int(),
  merit: z.number().int(),
  cause: z.string(),
  /** 남은 행적 (중대한 것부터) */
  deeds: z.array(z.string()),
  /** AI가 쓰는 짧은 회고·묘비명 */
  epitaph: z.string().nullable(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

/**
 * 유해와 무덤 (12-130). of: 누구의 유해인지, holder: 짐을 지닌 캐릭터 (보통 그 사람, 변이했다 쓰러졌으면 그 감염체).
 * buriedAt이 있으면 무덤이고 marker가 묘비에 적힌 말이다
 */
export const remainsSchema = z.strictObject({
  of: z.string(),
  holder: z.string(),
  zone: z.string(),
  diedAt: z.number().int(),
  buriedAt: z.number().int().nullable(),
  marker: z.string().nullable(),
  /** 구역 안의 자리 (장소 id, 숨은 곳이면 "ruin:<id>"). 뒤지기·묻기는 그 자리에서만 (PT22 하얀매: 닿지 못한 지하의 시신을 바깥 길에서 뒤졌다). 없으면 구역 어디서나 */
  spot: z.string().nullable().default(null),
});
export type Remains = z.infer<typeof remainsSchema>;

/** 진행 중인 전투 장면. 전세는 플레이어 편 기준 (+면 우리가 이기고 있다) */
export const battleStateSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(["raid", "skirmish", "assault"]),
  attacker: z.string(),
  defender: z.string(),
  zone: z.string(),
  plan: z.string().optional(),
  /** 플레이어가 공격 쪽인지 방어 쪽인지 */
  side: z.enum(["attack", "defense"]),
  ours: z.strictObject({ faction: z.string(), committed: z.number().int().min(0), losses: z.number().int().min(0) }),
  theirs: z.strictObject({ faction: z.string(), committed: z.number().int().min(0), losses: z.number().int().min(0) }),
  momentum: z.number().int(),
  alarm: z.number().int().min(0),
  position: z.string(),
  round: z.number().int().min(0),
  /** 아직 남은 적 목표물 */
  objectives: z.array(z.string()),
  /** 플레이어 행동이 바꾼 전세의 합 (공적 계산) */
  contribution: z.number().int(),
  startedAt: z.number().int(),
  /** 바리케이드가 남은 막기 (12-176): 지키는 쪽이 배경 교전에서 밀릴 때 이만큼 막는다 */
  holds: z.number().int().min(0).default(0),
  /** 길 위의 부대와 맞붙은 전투 (움직이는 부대 ③): 결과는 그 부대에 (무리 전투원이 아니라) */
  party: z.string().optional(),
});
export type BattleState = z.infer<typeof battleStateSchema>;

/**
 * 세계 상태와 이벤트 스키마. 능력치·행동·등급·상태 트랙 ID는 시나리오에서 오므로
 * 시나리오를 받아 만든다 (기획서 12.3). 세이브를 불러올 때도 이 스키마로 검증한다.
 */
/** 구역 상태: 주인과 보강 (12-48, 목수가 메운 담·망루. 빼앗기면 사라진다) */
const zoneStateSchema = z.strictObject({
  owner: z.string().nullable(),
  fort: z.number().int().min(0).max(3).optional(),
  /** 이야기로 늘린 산출 (씨앗, 우물. 12-54) */
  boost: z.record(z.string(), z.number().int()).optional(),
  /** 큰 재난으로 이날까지 산출이 멈춘다 (12-169) */
  stalledUntil: z.number().int().optional(),
  /** 다가오는 부대를 알려 이 무리가 지키는 병력을 늘렸다 (움직이는 부대 5-3). 그 구역에서 교전이 나거나 그 부대가 물러가면 지운다 */
  alerted: z.string().optional(),
});

export function createGameSchemas(s: Scenario) {
  const character = createCharacterSchema(s);
  const move = idEnum(moveIds(s));
  // 이름이 바뀐 능력은 새 id로 읽는다 (이전 세이브의 판정 기록)
  const stat = z.preprocess((v) => (typeof v === "string" ? (s.renamed.abilities[v] ?? v) : v), idEnum(statIds(s)));
  const rank = idEnum(rankIds(s));
  const track = idEnum(trackIds(s));

  const checkRecord = z.strictObject({
    checkId: z.string(),
    turn: z.number().int(),
    actorId: z.string(),
    /** 은밀 행동이 목격 확률을 낮춘다 */
    move: move.optional(),
    /** 판정의 상대 인물 (그 인물의 물건을 옮길 근거가 된다) */
    target: z.string().optional(),
    /** 맞선 상대 (은밀이 대가 있는 성공이면 이 사람만 본다, PT15) */
    opponent: z.string().optional(),
    /** 시스템이 굴린 버티는 판정 (12-267) */
    reaction: z.boolean().optional(),
    outcome: checkOutcomeSchema,
    /** 이 판정의 대가로 이미 피해를 적용했는지 */
    harmApplied: z.boolean(),
    /** 이 판정으로 남에게 입힌 피해 (인물 id → 단계). 같은 판정으로 푼 이야기가 같은 사람을 또 다치게 하면 더하지 않고 큰 쪽만 (사용자 결정, PT14 신병 T75) */
    dealt: z.record(z.string(), z.number().int().positive()).optional(),
    /** 굴린 시각 (12-258: 방금 빗나간 상대에게 다시 하는 임무 판정) */
    at: z.number().int().optional(),
  });

  /** 세계의 진짜 상태 (World State). 콘텐츠(아이템 정의 등)는 넣지 않고 id로만 참조한다 */
  const state = z.strictObject({
    scenarioId: z.string(),
    worldId: z.string(),
    /** 세계의 날마다 정해지는 것(기온의 들쭉날쭉)의 씨앗. 세계의 RNG에서 뽑는다 (같은 시드면 같은 세계). 없으면(이전 세이브) worldId */
    worldSeed: z.number().int().nullable().default(null),
    roleId: z.string(),
    /** 자유 시나리오로 시작했으면 그때 코드가 만든 역할 (콘텐츠에 없다, 기획서 12.5). roleId는 CUSTOM_ROLE_ID */
    customRole: customRoleSchema.nullable().default(null),
    /** 주인공과 함께 다니는 인물·동물 (기획서 7.8). 구역을 옮겨도 따라오고 장면에 남는다 */
    companions: z.array(z.string()).default([]),
    /** 동적으로 생긴 인물 사이의 관계 (세계를 만들 때, 인물이 자랄 때, 기획서 7.10). 정해진 관계는 콘텐츠에 있다 */
    dynamicTies: z.array(tieRecordSchema).default([]),
    /** 작전에 빌린 장비 (임무 id → 아이템 → 수량, 기획서 4.8). 임무가 끝나면 반납한다 */
    loans: z.record(z.string(), z.record(z.string(), z.number().int().min(1))).default({}),
    /** 임무로 맡은 짐과 받아 온 대금 (임무 id → 아이템 → 수량, 공통 규칙 10 rules/entrusted.ts). 임무 자리에서 넘기고 보고 때 상관에게 넘긴다 */
    cargo: z.record(z.string(), z.record(z.string(), z.number().int().min(1))).default({}),
    /** 감염체에게 마지막으로 다친 시각 (인물 id → 시각, 격리의 근거, 12-238) */
    exposedAt: z.record(z.string(), z.number().int()).default({}),
    /** 이 시각까지는 위험 임무를 내지 않는다 (무리에 막 들어온 유예, 12-239) */
    missionGraceUntil: z.number().int().nullable().default(null),
    /**
     * 손님으로 들인 무리 (공통 규칙 22 받아들임, rules/admission.ts): 무소속이 무리에 들 때는 먼저 손님으로 지내고,
     * offerAt 뒤 그 거점에서 대표가 면담해 권하면 그때 들어간다. rank·title·graceDays는 들일 때 이야기가 정한 자리
     */
    admission: z
      .strictObject({
        factionId: z.string(),
        rank: z.string().optional(),
        title: z.string().optional(),
        /** 대표가 권할 자리 (직분, 12-309). 이야기가 정한 것이면 rank·title이 그 자리의 것 */
        post: z.string().optional(),
        graceDays: z.number().int().optional(),
        since: z.number().int(),
        offerAt: z.number().int(),
        offers: z.number().int().min(0),
      })
      .nullable()
      .default(null),
    /** 세계의 일이 죽게 할 뻔했으나 한 번 봐준 공들인 관계 (12-242). 두 번째는 죽을 수 있다 */
    sparedOnce: z.array(z.string()).default([]),
    /** 설정을 거스른 굴림 (설정 id → 자리·시각·이겨 냈나, 공통 규칙 16). 같은 장면에서 같은 설정은 한 번 */
    /** 주인공·인물의 비밀(설정)을 아는 사람 (주인 id → 아는 사람들, 공통 규칙 16) */
    secretKnownBy: z.record(z.string(), z.array(z.string())).default({}),
    settingRolls: z.record(z.string(), z.strictObject({ spot: z.string(), at: z.number().int(), won: z.boolean(), turn: z.number().int().optional() })).default({}),
    /** 구역마다 오늘의 소음 (기획서 4.8) */
    zoneNoise: z.record(z.string(), z.strictObject({ day: z.number().int(), level: z.number().int() })).default({}),
    /** 소리를 듣고 몰려오는 감염체 (infestation.swarm_hours): 구역 → 그날 소리(day)에 몰려드는 시각(at), 이미 왔는지(done) */
    /** met: 몰려든 뒤 주인공이 그 구역에서 마주쳤다 (처음 들어서면 반드시 한 번, 플레이 테스트 13) */
    swarms: z.record(z.string(), z.strictObject({ day: z.number().int(), at: z.number().int(), done: z.boolean(), met: z.boolean().optional() })).default({}),
    /** 주인공이 마지막으로 그 구역에 갔을 때 본 주인 (플레이 테스트 12: 점령 변화가 소문 없이 인접 목록에 바로 보였다) */
    zoneSeen: z.record(z.string(), z.string().nullable()).default({}),
    /** 구역마다 바닥에 놓인 물건 (장면을 떠나면 그 구역에 남는다, 플레이 테스트 13: 내려놓은 고철이 구역을 옮겨도 따라왔다) */
    groundItems: z.record(z.string(), inventorySchema).default({}),
    /**
     * 가방 개체 (공통 규칙 26, docs/bags-plan.md): 안에 든 것이 있거나 메고 있는 가방만. 내용물은 가방만 가진다 (그 자리 소지품에는 가방 물건 하나).
     * at: 가방이 있는 곳 (캐릭터 id, "scene" 장면 바닥, "ground:<자리>" 구역 바닥, "stash:<사람>:<구역>" 창고). rules/bags.ts와 리듀서만 읽는다
     */
    bags: z.record(z.string(), z.strictObject({ item: z.string(), at: z.string(), contents: inventorySchema, worn: z.boolean().optional() })).default({}),
    /** 다음 가방 개체 번호 */
    bagSeq: z.number().int().min(0).default(0),
    /** 구역 안에서 지금 있는 장소 (12-244, 공통 규칙 15). null이면 구역의 장소를 정하지 않은 곳 (들어선 자리) */
    playerPlace: z.string().nullable().default(null),
    /** GM이 즉흥으로 만든 장소 (장소 id → 구역·이름·실내·주인). 세이브에 남아 다시 쓴다 */
    spawnedPlaces: z.record(z.string(), z.strictObject({ zone: z.string(), name: z.string(), indoor: z.boolean(), owner: z.string().nullable(), at: z.string().nullable().default(null), shop: z.string().nullable().default(null) })).default({}),
    /**
     * 머무는 자리 (12-253, 공통 규칙 15): 장면에 있다가 주인공이 두고 떠난 인물은 그 시간대가 끝날 때(until)까지 그 자리에 있다.
     * 그 뒤엔 일과로 돌아간다 (PT15: 교무실에 부른 상관이 주인공이 나가자마자 일과의 보급 창고로 순간이동했다). 읽기는 rules/place.ts로만
     */
    npcStays: z.record(z.string(), z.strictObject({ zone: z.string(), place: z.string().nullable(), until: z.number().int() })).default({}),
    /** 원하던 선물을 마지막으로 받은 날 (12-257, 인물 id → 일차) */
    giftWelcomedDay: z.record(z.string(), z.number().int()).default({}),
    /** 대가 있는 성공의 대가를 시간("일이 꼬여 30분")으로 치른 마지막 날 (12-258) */
    timeCostDay: z.number().int().nullable().default(null),
    /** 상인이 마지막으로 물건을 채운 날 */
    restockedDay: z.record(z.string(), z.number().int()).default({}),
    /** 이 세계에서 열린 해금: 시나리오(역할) id (여기서 얻었거나, 다른 판에서 얻어 세계를 열 때 옮겨 온 것, 기획서 12.4.1, 9.12) */
    unlocked: z.array(z.string()).default([]),
    /**
     * 지금 주인공이 플레이하는 시나리오(목록의 역할 id, 기획서 12.4.1). 무리에 들어 역할(roleId)이 바뀌어도 그대로다.
     * 클리어 목표와 시나리오의 연출 지침은 이것을 본다. 다음 캐릭터가 새 시나리오로 시작하면 바뀐다
     */
    scenarioRole: z.string().default(""),
    /** 이 세계에서 클리어 목표를 이룬 시나리오(역할) id (기획서 12.4.1) */
    cleared: z.array(z.string()).default([]),
    /** 주인공이 찾는 가족 (역할의 family로 코드가 만든 인물 id, 튜토리얼) */
    family: z.array(z.string()).default([]),
    /** 주인공이 털어놓음을 들은 숨은 관계 (tieKey) */
    revealedTies: z.array(z.string()).default([]),
    /** 함께 다니는 이유 (NPC id → 이유, 기획서 7.9). 지금 곁에 있는 사람(companions)과 잠시 떨어져 있는 사람 모두 */
    bonds: z.record(z.string(), bondSchema).default({}),
    /** 주인공이 맡은 분대 (12-190). null이면 역할의 분대(role.squad). 진급해서 꾸린 분대와 새로 배치된 사람 */
    squad: z.array(z.string()).nullable().default(null),
    /** 상관이 내놓은 진급 제안 (12-190). 거절해도 열려 있어 나중에 맡겠다고 할 수 있다 */
    promotionOffer: z.strictObject({ to: z.string(), at: z.number().int(), declined: z.boolean() }).nullable().default(null),
    /** 분대원에게 맡긴 일 (NPC id → 명령, 기획서 9.11). follow는 동행으로 다루고 여기 넣지 않는다 */
    squadOrders: z
      .record(z.string(), z.strictObject({ task: z.string(), zone: z.string(), startedAt: z.number().int(), until: z.number().int() }))
      .default({}),
    /** 분대원의 마지막 보고 (NPC id → 문장). 화면 밖 일의 결과는 이것으로만 안다 */
    squadReports: z.record(z.string(), z.strictObject({ text: z.string(), at: z.number().int() })).default({}),
    /** 회의 기록 (주제 id → 마지막으로 안을 올린 날, 기각되면 다시 올릴 수 있는 시각) */
    council: z.record(z.string(), z.strictObject({ day: z.number().int(), blockedUntil: z.number().int() })).default({}),
    /** 이야기가 이름표로 기억해 둔 인물 (cast keep → recall). 이름 없는 인물도, 이름 있는 NPC도 */
    keptExtras: z.record(z.string(), z.string()).default({}),
    /** 주인공의 지난 일 중 세계의 사실이 된 것 (배경 부품, 기획서 12.6). 코드가 만든 인물은 characterId */
    background: z.array(z.strictObject({ part: historyPartSchema(), characterId: z.string().optional() })).default([]),
    /** 연애 (12-58): 두 사람(키 a|b) 사이. lovers 연인, ended 끝남 */
    romances: z
      .record(z.string(), z.strictObject({ a: z.string(), b: z.string(), stage: z.enum(["lovers", "ended"]), since: z.number().int() }))
      .default({}),
    /** 오늘 이미 다가간 상대 (사람 id → 날) */
    flirtDay: z.record(z.string(), z.number().int()).default({}),
    /**
     * 이 세계의 설정. 게임 중 상태 화면의 설정이나 대화로 바꾼다.
     * mature: 수위 (12-57). 성인 주제(잠자리, 성적 농담·괴롭힘·위협)를 다룬다. 연애는 이것과 상관없다. 기본은 끔
     * dialogue: 대화 형식 (12-63). novel 소설(대사를 서술에 녹인다) / script 대본(대사를 "이름: 대사" 줄로 뗀다)
     */
    options: z
      .strictObject({ mature: z.boolean().default(false), dialogue: z.enum(["novel", "script"]).default("novel") })
      .default({ mature: false, dialogue: "novel" }),
    /** 캐릭터별 메모 (12-75). 플레이어가 적는 기록이라 세계의 사실이 아니다 */
    memos: z.record(z.string(), z.string()).default({}),
    /** 맡긴 물건 (12-196): 주인공이 남에게 맡긴 것과 그 조건. 맡긴 사람에게서는 근거 없이 돌려받는다 */
    entrusted: z.array(z.strictObject({ owner: z.string(), holder: z.string(), itemId: z.string(), quantity: z.number().int().positive(), note: z.string(), at: z.number().int() })).default([]),
    /** 내 물건 보관 (12-149): 캐릭터 → 구역 → 맡긴 물건. 무리 거점의 사물함이나 떠돌이의 거처에 둔다 */
    stashes: z.record(z.string(), z.record(z.string(), z.record(z.string(), z.number().int().positive()))).default({}),
    /** 떠돌이의 거처 (12-149): 캐릭터 → 구역 */
    homes: z.record(z.string(), z.string()).default({}),
    /** 잠입 중 (12-154). depth: 깊이 칸, alarm: 경보 0~3 (주인공도 GM도 정확히는 모른다), done: 목표를 마쳤다 */
    infiltration: z
      .strictObject({ zone: z.string(), owner: z.string(), goal: z.string(), depth: z.number().int().min(0), alarm: z.number().int().min(0).max(3), done: z.boolean(), since: z.number().int() })
      .nullable()
      .default(null),
    /** 큰 재난 (12-169): 잡힌 재난 (전조 omen → 덮침 struck), 마지막 재난이 덮친 날 */
    disaster: z
      .strictObject({
        kind: z.string(),
        zone: z.string().nullable(),
        faction: z.string().nullable(),
        day: z.number().int(),
        phase: z.enum(["omen", "struck"]),
        until: z.number().int(),
        prepared: z.number().int().min(0),
      })
      .nullable()
      .default(null),
    lastDisasterDay: z.number().int().nullable().default(null),
    /** 인물의 자기 일 (12-168): 인물마다 지금 몇 번째 일(index)이고 몇 칸 찼는지 */
    agendas: z.record(z.string(), z.strictObject({ index: z.number().int().min(0), filled: z.number().int().min(0) })).default({}),
    /** 거점 손보기 (12-167): 구역마다 지어진 시설 id */
    facilities: z.record(z.string(), z.array(z.string())).default({}),
    /** 부서진 채 남은 시설 (파트 13 보수): 다시 지으면 빠진다 */
    wrecked: z.record(z.string(), z.array(z.string())).default({}),
    /** 의무실의 이름 없는 부상자 (파트 13-2): 교전에서 다친 우리 무리 사람. 돌보면 돌아가고, 사흘 동안 아무도 돌보지 않으면 절반이 죽는다 */
    wounded: z.array(z.strictObject({ id: z.string(), faction: z.string(), zone: z.string(), at: z.number().int() })).default([]),
    /** 다짐 (12-164): 캐릭터마다 지금 품은 다짐, 시나리오의 다짐을 세웠는지, 끝난 다짐의 기록 */
    resolves: z.record(z.string(), resolveSchema.nullable()).default({}),
    resolveSeeded: z.array(z.string()).default([]),
    /** 내려놓은 까닭 (resolve_ended에 붙인다) */
    resolveNote: z.string().nullable().default(null),
    resolveLog: z
      .array(z.strictObject({ characterId: z.string(), text: z.string(), outcome: z.enum(["achieved", "let_go", "broken", "by_others"]), at: z.number().int(), note: z.string().nullable() }))
      .default([]),
    /** 큰 이야기 (공통 규칙 24): 문이 열린 큰 이야기마다. 이 상태는 rules/saga.ts로만 읽는다 (rules/guards.test.ts) */
    sagas: z.record(z.string(), sagaStateSchema).default({}),
    /** 탐험할 곳 (12-162): 캐릭터마다 찾은 숨은 곳, 지금 탐험 중인 곳 (깊이, 소음 0~3, 뒤진 칸) */
    ruinsFound: z.record(z.string(), z.array(z.string())).default({}),
    exploration: z
      .strictObject({ ruin: z.string(), depth: z.number().int().min(0), noise: z.number().int().min(0).max(3), searched: z.array(z.number().int()), since: z.number().int() })
      .nullable()
      .default(null),
    /** 뇌물을 받은 사람 (12-153): 그 사람의 약점이 된다 (주인공만 안다). by: 준 사람 */
    bribes: z.array(z.strictObject({ npcId: z.string(), by: z.string(), favor: z.string(), at: z.number().int() })).default([]),
    /** 약속 (12-160): 주인공이 한 약속. due는 기한 날(그날까지) */
    promises: z
      .array(
        z.strictObject({
          id: z.string(),
          by: z.string(),
          to: z.string(),
          what: z.string(),
          due: z.number().int(),
          item: z.strictObject({ id: z.string(), quantity: z.number().int().positive() }).nullable(),
          made: z.number().int(),
          /** asked: 인물이 부탁을 꺼냈고 아직 답하지 않았다 (due는 꺼낼 기한). declined·lapsed: 거절했거나 꺼내지 못하고 접혔다 */
          status: z.enum(["asked", "open", "kept", "broken", "folded", "declined", "lapsed"]),
          /** 인물의 부탁에서 온 약속이면 그 부탁의 콘텐츠 id (12-174, 12-181) */
          favor: z.string().nullable().default(null),
          /** 의뢰 (12-291): 틀로 만든 일거리. 판정은 rules/request.ts로만 */
          quest: questSchema.nullable().default(null),
        }),
      )
      .default([]),
    /** 포상 (12-171): 캐릭터마다 받은 포상 횟수 */
    rewardsGiven: z.record(z.string(), z.number().int().min(0)).default({}),
    /** 개 기르기 (12-172): 동물마다 배운 재주, 반쯤 배운 재주, 마지막으로 가르친 날 */
    tricks: z.record(z.string(), z.strictObject({ learned: z.array(z.string()), half: z.array(z.string()), lastDay: z.number().int() })).default({}),
    /** 무전 송출 (12-173): 마지막으로 송출한 날 */
    lastBroadcastDay: z.number().int().nullable().default(null),
    /** 매복 (12-177): 주인공이 자리를 잡은 매복 (bonus: 첫 공격 보정, until까지) */
    ambush: z.strictObject({ zone: z.string(), until: z.number().int(), bonus: z.number().int().min(1), confuse: z.boolean() }).nullable().default(null),
    /** 매복당함 (12-177): 다음 판정 하나에 붙는 불리함, until이 지나면 사라진다 */
    ambushed: z.strictObject({ until: z.number().int() }).nullable().default(null),
    /** 자세가 무너졌다 (싸움의 대가 있는 성공, 플레이 테스트 13): 이 시각까지 다음 판정 하나에 -1 */
    offBalanceUntil: z.number().int().nullable().default(null),
    /** 혼란 (12-177): 다음 판정 하나 동안 흔들린 사람 (주인공은 -1, 상대는 맞서지 못한다) */
    confused: z.array(z.string()).default([]),
    /** 협박당한 사람 (12-153). grudge: 되갚을 마음을 품었다 */
    blackmails: z.array(z.strictObject({ npcId: z.string(), by: z.string(), leverage: z.string(), at: z.number().int(), grudge: z.boolean() })).default([]),
    /** 폭로해서 더는 쥘 수 없는 약점 (12-153, "by|약점 키") */
    exposed: z.array(z.string()).default([]),
    /** 짐이 무거울 때 창고를 한 번 알렸다 (12-149, 캐릭터마다) */
    stashHinted: z.array(z.string()).default([]),
    /** 쌓인 냉기 (12-98, 캐릭터마다). per_step을 넘으면 추위 트랙이 오르고, 음수로 per_step만큼 빠지면 풀린다 */
    coldLoad: z.record(z.string(), z.number()).default({}),
    /** 젖은 옷 (12-121, 12-186): 캐릭터 → 불 곁에서 마르기까지 남은 분. 없으면 마른 옷 */
    wet: z.record(z.string(), z.number()).default({}),
    /** 쌓인 피로 (깨어 있은 시간, 12-114). 캐릭터마다 */
    fatigueLoad: z.record(z.string(), z.number()).default({}),
    /** 피워 둔 모닥불 (12-98): 구역 → 꺼지는 시각 */
    fires: z.record(z.string(), z.number().int()).default({}),
    /** 구역에 맡겨 둔 물건 (구역 id → 아이템 → 수량). 그 구역을 떠날 때 돌려받는다 (12-54) */
    deposits: z.record(z.string(), z.record(z.string(), z.number().int().positive())).default({}),
    /** 캐릭터마다 가 본 구역 (12-201: 지도에 가 본 곳만 그린다). 구역 이동에서 모은다 */
    visited: z.record(z.string(), z.array(z.string())).default({}),
    /** 캐릭터마다 있어 본 장소 ("구역:장소", 설계 목록 C-1). 모르는 장소는 GM에게도 '알 수 없는 문'으로만 보인다 (공통 규칙 15 knowsPlace) */
    knownPlaces: z.record(z.string(), z.array(z.string())).default({}),
    /** 기절시켜 둔 사람 → 깨어나는 시각 (PT23 졸병: 기절시킨 간수가 멀쩡히 남아 다시 붙잡혔다). 그때까지 보지도 움직이지도 못한다 (공통 규칙 8 ableNow) */
    knockedOut: z.record(z.string(), z.number().int()).default({}),
    /** 마지막으로 오간 길 (길 위의 이야기, 12-53) */
    lastRoute: z.strictObject({ from: z.string(), to: z.string() }).nullable().default(null),
    /** 바로 앞 이동(구역·장소)에 with로 함께 온 사람 (12-368, 유소진 판: with를 빠뜨려 하늘을 두고 떠났다). 다음 이동에서 with·leave로 정해야 한다 (공통 규칙 15) */
    walkingWith: z.array(z.string()).default([]),
    /** 구역마다 오늘 뒤진 횟수 (수색, 기획서 4.7) */
    /** 오늘 뒤진 곳: count는 뒤진 양(수색 범위가 있으면 deplete_minutes 단위, 12-355), hurt는 그날 그곳 수색으로 다쳤는지 (다시 다치지 않는다) */
    zoneSearches: z.record(z.string(), z.strictObject({ day: z.number().int(), count: z.number().int(), hurt: z.boolean().optional() })).default({}),
    /**
     * 무리 사이 협정 (12-126). truce: until까지 서로 치지 않는다 (그동안 두 무리의 태도를 적대 기준 위로 올려 두고, 끝나면 restore로 돌린다)
     */
    pacts: z
      .array(z.strictObject({ id: z.string(), kind: z.literal("truce"), a: z.string(), b: z.string(), until: z.number().int(), restore: z.strictObject({ ab: z.number().int(), ba: z.number().int() }) }))
      .default([]),
    /** 협상이 거절된 무리 → 다시 꺼낼 수 있는 때 (12-126) */
    negotiationBlocked: z.record(z.string(), z.number().int()).default({}),
    /** 구역의 감염체 압력 0~3 (12-112). 없는 구역은 그 구역의 위험(danger)이 기준값이다 */
    infested: z.record(z.string(), z.number().int().min(0).max(3)).default({}),
    turn: z.number().int().nonnegative(),
    /** 게임 시간 (1일차 00:00부터 흐른 분) */
    time: z.number().int().nonnegative(),
    playerId: z.string(),
    characters: z.record(z.string(), character),
    scene: z.strictObject({
      items: inventorySchema,
      /** 플레이어와 같은 장면에 있는 NPC id */
      present: z.array(z.string()),
    }),
    checks: z.record(z.string(), checkRecord),
    nextCheckNo: z.number().int().positive(),
    /** 치트를 쓴 적이 있는지 (슬롯에 표시) */
    cheated: z.boolean().default(false),
    /** 다음 엑스트라 번호 (ex_N) */
    nextExtraNo: z.number().int().positive().default(1),
    /** 오늘 판정으로 얻은 경험치 (하루 상한, 기획서 4.2) */
    xpToday: z.strictObject({ day: z.number().int(), amount: z.number().int() }).default({ day: 0, amount: 0 }),
    /** 가르침 (4.2.1): 주인공이 배우는 중인 전문 기술 → 채운 시간 */
    lessons: z.record(z.string(), z.number().int()).default({}),
    /** 캐릭터별 Belief State */
    beliefs: z.record(z.string(), z.array(beliefSchema)),
    /** 캐릭터별로 이름까지 아는 인물 id (기획서 6.3). 방향이 있다: known[A]에 B가 있으면 A가 B의 이름을 안다 */
    known: z.record(z.string(), z.array(z.string())),
    /** 캐릭터별로 만난(얼굴을 아는) 인물 id. 이름은 모를 수 있다 (이름을 알면 known에도 있다) */
    met: z.record(z.string(), z.array(z.string())).default({}),
    nextBeliefNo: z.number().int().positive(),
    missions: z.record(z.string(), missionInstanceSchema),
    /** 오늘 상관이 내놓은 임무 후보 */
    offers: z.strictObject({ day: z.number().int(), templateIds: z.array(z.string()) }).nullable(),
    nextMissionNo: z.number().int().positive(),
    /** 지금 캐릭터의 런이 시작된 시각 (복무 기간은 serviceSince가 없을 때 이것부터) */
    runStartedAt: z.number().int(),
    /** 지금 무리에 든 시각 (12-310, PT 받아들임: 3일차에 들었는데 "복무 3일째"). null이면 판을 시작할 때부터 그 무리 사람이다. game/missions.ts serviceStart로 읽는다 */
    serviceSince: z.number().int().nullable().default(null),
    /** 거점 밖에 사는 상관이 마지막으로 들른 날 (12-311, rules/admission.ts chiefVisits만 읽는다) */
    chiefVisitDay: z.number().int().nullable().default(null),
    /** 지금 캐릭터가 시작한 구역 (시작 장면 대기는 이 구역에서만, 공통 규칙 17, 12-254) */
    runStartZone: z.string().nullable().default(null),
    /** 주인공 이름과 겹쳐 이 세계에서만 바꾼 월드 인물의 이름 (인물 id → 원래·바꾼 이름, 12-260). 콘텐츠의 글에도 반영한다 */
    nameSwaps: z.record(z.string(), z.strictObject({ from: z.string(), to: z.string() })).default({}),
    /** 행적. 숨은 목격자가 들어 있으므로 UI·프롬프트로 그대로 보내지 않는다 */
    deeds: z.record(z.string(), deedSchema),
    /** NPC가 어떤 행적을 어떤 출처로 알고 있는지: npcId → deedId → source */
    deedKnowledge: z.record(z.string(), z.record(z.string(), beliefSourceSchema)),
    /** 관계: fromId → toId → 신뢰·호감·존중 */
    relations: z.record(z.string(), z.record(z.string(), relationSchema)),
    /**
     * 플레이어가 느끼는 NPC의 태도. 그 NPC와 같은 장면에 있을 때만 갱신된다.
     * 진짜 관계(relations)를 바로 보여 주면 숨은 목격자가 드러나므로 UI는 이것만 쓴다
     */
    perceived: z.record(z.string(), relationSchema),
    /** 비밀을 털어놓은 NPC */
    revealedSecrets: z.array(z.string()),
    /** 소문이 마지막으로 퍼진 날 */
    lastSpreadDay: z.number().int().nullable(),
    nextDeedNo: z.number().int().positive(),
    /** 세력 상태 (9단계). 이전 세이브는 세계를 열 때 콘텐츠의 시작값으로 채운다 */
    factions: z.record(z.string(), factionStateSchema).default({}),
    /** 움직이는 부대 (docs/war-parties-plan.md) */
    parties: z.array(partySchema).default([]),
    nextPartyNo: z.number().int().min(0).default(0),
    /** 부대끼리의 마주침을 여기까지 셌다 (공통 규칙 23) */
    partiesUpTo: z.number().int().default(0),
    /** 주인공이 부대와 마주친 기록 (공통 규칙 23): "부대id@구역" → 누가 봤는지. 한 구역에서 한 번 굴린다 */
    partySightings: z.record(z.string(), z.strictObject({ at: z.number().int(), player: z.boolean(), party: z.boolean() })).default({}),
    /** 주인공이 본 부대와 마지막으로 본 때 (구역을 떠나도 남는다: 알리기 5-3) */
    partiesSeen: z.record(z.string(), z.number().int()).default({}),
    /** 본·전해 안 부대의 기록 (알리기, 12-327): 그 부대가 돌아가 사라져도 하루 동안 알릴 수 있게 무리·종류·목표·계획을 남긴다 */
    partyIntel: z.record(z.string(), z.strictObject({ faction: z.string(), kind: z.string(), goal: z.string(), plan: z.string().nullable(), size: z.number().int(), at: z.number().int(), /** 본 곳·전해 들은 곳 (지도, 12-336). 이전 세이브는 없다 */ zone: z.string().optional() })).default({}),
    /** 우리 땅을 지키는 사람이 이미 알아챈 적 부대 (PT34 사용자 결정, 한 부대에 한 번) */
    garrisonSeen: z.array(z.string()).default([]),
    /** 주인공이 무리에 알린 부대 (5-3): 같은 부대로 다시 조르지 못하고, 그 부대가 막히면 공적 */
    partyAlerts: z.array(z.strictObject({ partyId: z.string(), faction: z.string(), zone: z.string(), at: z.number().int(), persuaded: z.enum(["none", "success", "partial", "miss"]), credited: z.boolean().default(false), closed: z.boolean().default(false), /** 더 지키는 때 (12-327: 하루, 계획 정찰은 그 공세가 끝날 때까지 길어도 사흘) */ until: z.number().int().default(0), /** 계획 정찰이면 그 계획 (그 공세가 끝나면 거둔다, PT37 사용자 결정) */ plan: z.string().nullable().default(null) })).default([]),
    /** 주인공이 맞붙은 부대 (움직이는 부대 ③): 부대 id → 장면에 들인 부대원(엑스트라·우두머리)과 구역 */
    partyFights: z.record(z.string(), z.strictObject({ members: z.array(z.string()), zone: z.string(), at: z.number().int() })).default({}),
    /** 구역 소유 */
    zones: z.record(z.string(), zoneStateSchema).default({}),
    clocks: z.record(z.string(), clockStateSchema).default({}),
    /** 전쟁 틱이 마지막으로 돈 날 */
    lastWarDay: z.number().int().nullable().default(null),
    /** 플레이어가 있는 전선 구역 (9-1). 이전 세이브는 세계를 열 때 정한다 */
    playerZone: z.string().nullable().default(null),
    /** 구역별 설치된 준비물 (함정 등) */
    preparations: z.record(z.string(), z.array(z.string())).default({}),
    /** 예정된 교전 (플레이어가 낄 수 있는 것) */
    pendingClashes: z.array(pendingClashSchema).default([]),
    battle: battleStateSchema.nullable().default(null),
    nextBattleNo: z.number().int().positive().default(1),
    /** 캐릭터별 시나리오 플래그 (스토리렛이 세운다. 비밀 lore의 secret:<flag>도 이것을 본다) */
    flags: z.record(z.string(), z.array(z.string())).default({}),
    /** 스토리렛 발동 기록 */
    /** lastEnd: 마지막으로 어떻게 끝났는지 (miss·expired면 꼭 열리는 이야기는 하루 뒤 다시 열린다, 12-262) */
    storyletLog: z.record(z.string(), z.strictObject({ fired: z.number().int().min(0), lastFiredAt: z.number().int(), lastEnd: z.string().optional() })).default({}),
    /** 진행 중인 스토리렛 */
    activeStorylet: z
      .strictObject({
        id: z.string(),
        cast: z.record(z.string(), z.string()),
        firedAt: z.number().int(),
        expiresAt: z.number().int(),
        /** GM이 지은 즉흥 이야기 (12-247): 코드가 만든 스토리렛 정의. 콘텐츠에 없고 끝나면 남지 않는다 */
        improvised: z.record(z.string(), z.unknown()).optional(),
      })
      .nullable()
      .default(null),
    lastStoryletAt: z.number().int().nullable().default(null),
    /** 열려 있는 즉흥 이야기 자리 (12-247): 이때까지 GM이 improvise_storylet로 채울 수 있다 */
    /** prevLast: 자리를 열기 전의 앞 이야기 시각. 쓰지 않고 닫히면 간격을 그때로 돌린다 (PT23: 쓰지 않은 즉흥 자리가 반나절을 막았다) */
    improvSlot: z.strictObject({ openedAt: z.number().int(), expiresAt: z.number().int(), prevLast: z.number().int().nullable().optional() }).nullable().default(null),
    /** 마지막으로 즉흥 이야기 자리가 열린 때 (하루 상한) */
    lastImprovSlotAt: z.number().int().nullable().default(null),
    /** 주인공이 마지막으로 한 일 (이야기 조건 when.activities, 플레이 테스트 11). 이전 세이브는 null */
    lastActivity: z.string().nullable().default(null),
    /** 마지막으로 잠에서 깬 시각 (플레이 테스트 13: "한밤에 막 깬 때"가 깬 뒤 행동 하나로 풀렸다) */
    lastWokeAt: z.number().int().nullable().default(null),
    /** 지난 잠(이어진 잠 전체)이 시작된 시각 */
    lastSleptFrom: z.number().int().nullable().default(null),
    /** 최근 하루의 잠 (설계 목록 3-1·3-2: 푹 잔 것은 지난 24시간 동안 잔 시간을 더해 본다. 쪼개 자도 된다) */
    sleepLog: z.array(z.strictObject({ from: z.number().int(), to: z.number().int() })).default([]),
    /** 잠으로 마음이 마지막으로 가라앉은 때 (그 앞의 잠은 다시 세지 않는다) */
    nervesSleepSpentAt: z.number().int().nullable().default(null),
    /** 주인공이 우리 땅을 떠난 시각 (돌아오면 지운다) */
    leftHomeAt: z.number().int().nullable().default(null),
    /** 사람이 마지막으로 이야기 배역으로 나온 시각 (같은 사람이 이야기마다 나오지 않게) */
    castUsedAt: z.record(z.string(), z.number().int()).default({}),
    /** 무기고가 맨손인 주인공에게 근접 무기를 마지막으로 내준 시각 */
    spareIssuedAt: z.number().int().nullable().default(null),
    /** 갇혀서 그날 배급을 못 받은 날 (플레이 테스트 13: 풀려나 거점에 왔는데 그날 내내 굶주렸다). 그날 우리 거점에 닿으면 늦게라도 받는다 */
    missedRationDay: z.number().int().nullable().default(null),
    /** 주인공이 마지막으로 풀려난(빠져나온) 시각 (플레이 테스트 13: 갇혔다 나와 거점까지 걷는 사이 기한이 지나 불복종) */
    lastFreedAt: z.number().int().nullable().default(null),
    /** 불복종이 마지막으로 늘거나 지워진 때 (C8: 7일마다 하나씩 지워진다) */
    disobedienceAt: z.record(z.string(), z.number().int()).default({}),
    /** 이 사람이 주인공을 덜 믿게 된 마지막 때 (플레이 테스트 11, C5: 의심받은 직후 진급 제안이 왔다) */
    trustDroppedAt: z.record(z.string(), z.number().int()).default({}),
    /** 그 까닭 (공통 규칙 9, 플레이 테스트 13: 무엇 때문에 진급이 막혔는지 몰랐다) */
    trustDroppedWhy: z.record(z.string(), z.string()).default({}),
    /** 오늘 오른 관계 (공통 규칙 19, rules/regard.ts): 한 사람이 한 사람을 보는 축마다. day가 바뀌면 다시 센다 */
    regardGained: z
      .strictObject({ day: z.number().int(), by: z.record(z.string(), z.record(z.string(), z.record(z.string(), z.number()))) })
      .default({ day: -1, by: {} }),
    /** 까닭별 마지막 오름 시각 (공통 규칙 19): from → to → "까닭|축" → 시각 */
    regardLast: z.record(z.string(), z.record(z.string(), z.record(z.string(), z.number().int()))).default({}),
    /** 의식불명 중 곁의 사람이 할 일을 정한 때 (12-90). 정신이 들면 비운다. 한 번 쓰러질 때 한 번만 정한다 */
    helplessAt: z.number().int().nullable().default(null),
    /** 회복 기준 시각: 마지막으로 다치거나 나은 때, 마지막으로 치료사에게 치료받은 날 */
    recovery: z
      .strictObject({
        lastChangeAt: z.record(z.string(), z.number().int()),
        lastHealerDay: z.record(z.string(), z.number().int()),
        /** 주인공의 응급처치·간호를 마지막으로 한 날 (치료사 칸과 따로, engine/care/slots.ts) */
        lastAidDay: z.record(z.string(), z.number().int()).default({}),
        /** 그 돌봄 직후의 몸 상태 (그 뒤로 상처가 깊어졌으면 같은 날 다시 받는다) */
        healerSnap: z.record(z.string(), z.record(z.string(), z.string())).default({}),
        aidSnap: z.record(z.string(), z.record(z.string(), z.string())).default({}),
        /** 트랙별로 마지막으로 바뀐(또는 출혈이 부상을 키운) 때: "인물:트랙" → 시각 (12-91) */
        trackAt: z.record(z.string(), z.number().int()).default({}),
        /** 감염을 늦추는 약(항생제)이 듣는 하루: 인물 → 날 (그날로 넘어가는 하루치 진행에 듣는다) (12-106) */
        slowDay: z.record(z.string(), z.number().int()).default({}),
        /** 약 덕분에 감염이 멈춘 마지막 날: 인물 → 날. 멈춘 다음 날은 진행한다 (절반 속도) */
        heldDay: z.record(z.string(), z.number().int()).default({}),
      })
      .default({ lastChangeAt: {}, lastHealerDay: {}, lastAidDay: {}, healerSnap: {}, aidSnap: {}, trackAt: {}, slowDay: {}, heldDay: {} }),
    /** 오늘의 날씨 (12-3) */
    weather: z.strictObject({ day: z.number().int(), id: z.string() }).nullable().default(null),
    /** 내일의 날씨 (E2: 하루 전에 정해 낌새로 알린다) */
    forecast: z.strictObject({ day: z.number().int(), id: z.string() }).nullable().default(null),
    /** 최근 교전 (오래된 것부터, 최대 RECENT_CLASHES). 계승한 캐릭터가 직전 전황을 듣는 데 쓴다 */
    /** party: 움직이는 부대가 닿아 시간이 흐르는 사이에 일어난 교전 (다음 날 감염체 압력에 센다) */
    recentClashes: z.array(z.strictObject({ clash: clashSchema, at: z.number().int(), party: z.boolean().optional() })).default([]),
    /** 죽은 캐릭터들의 기록 (오래된 것부터) */
    chronicle: z.array(runRecordSchema).default([]),
    /** 유해와 무덤 (12-130) */
    remains: z.array(remainsSchema).default([]),
    /** 현상금 (12-136): 무리마다 주인공이 죽인 것을 아는 사람 수, 현상금을 건 무리 (먼저 건 것부터) */
    killsKnown: z.record(z.string(), z.number().int().min(0)).default({}),
    bounties: z.array(z.string()).default([]),
    /** 주인공에게 복수를 다짐한 사람 (12-135): 주인공이 죽인 사람(victim)의 가족·친구(avenger) */
    vendettas: z.array(z.strictObject({ avenger: z.string(), victim: z.string(), since: z.number().int() })).default([]),
    /** 놓아 둔 덫 (12-131). caught: 걸린 아이템 (아직이면 null) */
    /** item: 놓은 덫 물건 (12-357: 철사 뭉치·쥐덫, 거두면 돌아온다) */
    traps: z.array(z.strictObject({ zone: z.string(), setAt: z.number().int(), caught: z.string().nullable(), qty: z.number().int().min(0).default(0), item: z.string().optional() })).default([]),
  });

  /** 상태 변경은 반드시 이벤트로 기록한다 (append-only). 상태는 이벤트를 차례로 적용한 결과다 */
  const event = z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("world_created"),
      scenarioId: z.string().min(1),
      worldId: z.string().min(1),
      worldSeed: z.number().int().nullable().default(null),
      roleId: z.string().min(1),
      customRole: customRoleSchema.nullable().default(null),
      player: character,
      npcs: z.array(character),
      beliefs: z.record(z.string(), z.array(beliefSchema)),
      known: z.record(z.string(), z.array(z.string())),
      /** 처음부터 태도를 아는 사람: 직속 상관과 같은 분대 (PT15 졸병: 같은 분대 분대장을 "만나 본 적이 없다") */
      perceived: z.array(z.string()).optional(),
      /** 주인공 이름과 겹쳐 바꾼 월드 인물의 이름 (12-260). 캐릭터와 믿음에는 이미 바꾼 이름이 들어 있다 */
      renames: z.record(z.string(), z.strictObject({ from: z.string(), to: z.string() })).optional(),
    }),
    z.strictObject({ type: z.literal("npc_entered"), npcId: z.string() }),
    z.strictObject({ type: z.literal("zone_searched"), zone: z.string(), day: z.number().int(), units: z.number().int().min(1).optional(), hurt: z.boolean().optional() }),
    z.strictObject({ type: z.literal("extra_kept"), key: z.string(), characterId: z.string() }),
    /** NPC의 계급이 바뀐다 (지도부 교체, 강등) */
    z.strictObject({ type: z.literal("npc_rank_changed"), npcId: z.string(), rank: z.string() }),
    /** 연애 (12-58): 연인이 되거나 끝난다 / 다른 연인을 알아챘다 / 오늘 다가갔다 */
    z.strictObject({ type: z.literal("romance_changed"), a: z.string(), b: z.string(), stage: z.enum(["lovers", "ended"]) }),
    // 예전 세이브의 질투 (12-58, 12-185에 뺐다). 읽기만 하고 무시한다
    z.strictObject({ type: z.literal("romance_jealousy"), who: z.string(), about: z.string() }),
    z.strictObject({ type: z.literal("flirted"), target: z.string(), day: z.number().int() }),
    /** 수위를 정한다 (새 게임에서, 또는 플레이어가 바꾸면, 12-57) */
    z.strictObject({ type: z.literal("content_options_set"), mature: z.boolean().optional(), dialogue: z.enum(["novel", "script"]).optional() }),
    z.strictObject({ type: z.literal("memo_written"), characterId: z.string(), text: z.string().max(4000) }),
    /** 얼굴이 없는 주인공이 시트에서 얼굴을 고른다 (12-139, 한 번만) */
    z.strictObject({ type: z.literal("portrait_chosen"), characterId: z.string(), portrait: z.string() }),
    /** 내 물건을 창고에 넣거나(put) 꺼낸다(take) (12-149). zone: 창고가 있는 구역 */
    z.strictObject({ type: z.literal("item_stashed"), characterId: z.string(), zone: z.string(), itemId: z.string(), quantity: z.number().int().positive(), direction: z.enum(["put", "take"]), bagId: z.string().optional() }),
    /** 떠돌이가 이 구역을 거처로 삼았다 (12-149) */
    z.strictObject({ type: z.literal("home_settled"), characterId: z.string(), zone: z.string() }),
    /** 잠입을 시작했다 / 상태가 바뀌었다 / 끝났다 (12-154) */
    z.strictObject({ type: z.literal("infiltration_started"), zone: z.string(), owner: z.string(), goal: z.string() }),
    z.strictObject({ type: z.literal("infiltration_changed"), depth: z.number().int().min(0), alarm: z.number().int().min(0).max(3), done: z.boolean(), /** 그 자리에서 바꾼 목표 (PT23) */ goal: z.string().optional() }),
    z.strictObject({ type: z.literal("infiltration_ended"), how: z.enum(["out", "caught", "gone"]) }),
    /** 얼굴만 안다 (이름은 모른다): 배경의 원수처럼 장면 밖에서 아는 얼굴 */
    z.strictObject({ type: z.literal("face_known"), characterId: z.string(), targetId: z.string() }),
    // 큰 재난 (12-169)
    z.strictObject({ type: z.literal("disaster_scheduled"), kind: z.string(), zone: z.string().nullable(), faction: z.string().nullable(), day: z.number().int() }),
    z.strictObject({ type: z.literal("disaster_prepared") }),
    z.strictObject({ type: z.literal("disaster_struck"), until: z.number().int(), stall: z.array(z.string()), collapsed: z.boolean() }),
    z.strictObject({ type: z.literal("disaster_ended") }),
    // 인물의 자기 일 (12-168)
    z.strictObject({ type: z.literal("agenda_filled"), npcId: z.string(), delta: z.number().int() }),
    z.strictObject({ type: z.literal("agenda_finished"), npcId: z.string() }),
    // 거점 손보기 (12-167)
    z.strictObject({ type: z.literal("facility_built"), zone: z.string(), facility: z.string() }),
    z.strictObject({ type: z.literal("facility_broken"), zone: z.string(), facility: z.string() }),
    /** 교전에서 다친 사람이 의무실에 들어왔다 (파트 13-2). 사람은 extra_spawned(unseen)로 먼저 만든다 */
    z.strictObject({ type: z.literal("wounded_arrived"), faction: z.string(), zone: z.string(), ids: z.array(z.string()) }),
    /** 의무실 부상자의 끝: recovered 나아 제자리로(인원·전투원 +1), survived 혼자 버텨 일어남(인원 +1), died 숨짐 */
    z.strictObject({ type: z.literal("wounded_settled"), id: z.string(), outcome: z.enum(["recovered", "survived", "died"]) }),
    // 다짐 (12-164)
    z.strictObject({ type: z.literal("resolve_set"), characterId: z.string(), resolve: resolveSchema }),
    z.strictObject({ type: z.literal("resolve_ended"), characterId: z.string(), outcome: z.enum(["achieved", "let_go", "broken", "by_others"]), text: z.string().optional() }),
    z.strictObject({ type: z.literal("resolve_involved"), characterId: z.string() }),
    z.strictObject({ type: z.literal("resolve_stepped"), characterId: z.string(), text: z.string() }),
    /** 다짐을 코드가 지켜본 것 (자동 단계의 날, 빚의 기준) */
    z.strictObject({ type: z.literal("resolve_tracked"), characterId: z.string(), day: z.number().int().optional(), mark: z.number().int().optional() }),
    z.strictObject({ type: z.literal("resolve_note"), characterId: z.string(), note: z.string() }),
    z.strictObject({ type: z.literal("resolve_seeded"), characterId: z.string() }),
    // 큰 이야기 (공통 규칙 24)
    z.strictObject({ type: z.literal("saga_opened"), sagaId: z.string() }),
    /** 막을 넘겼다 (lapsed: 기한을 넘겨 세계가 넘겼다) */
    z.strictObject({ type: z.literal("saga_advanced"), sagaId: z.string(), act: z.string(), days: z.number().nullable(), lapsed: z.boolean() }),
    z.strictObject({ type: z.literal("saga_ended"), sagaId: z.string(), ending: z.string(), lapsed: z.boolean() }),
    /** 실마리 한 줄 (flag: 실마리 표에서 온 것이면 그 플래그) */
    z.strictObject({ type: z.literal("saga_noted"), sagaId: z.string(), text: z.string(), zone: z.string().nullable(), flag: z.string().optional() }),
    z.strictObject({ type: z.literal("saga_marked"), sagaId: z.string(), characterId: z.string().nullable() }),
    z.strictObject({ type: z.literal("saga_engaged"), sagaId: z.string(), characterId: z.string() }),
    z.strictObject({ type: z.literal("saga_scene"), sagaId: z.string(), line: z.string() }),
    /** 떠나 있던 사람이 도시에 들어온다 (큰 이야기의 arrive) */
    z.strictObject({ type: z.literal("npc_arrived"), npcId: z.string() }),
    // 탐험할 곳 (12-162)
    z.strictObject({ type: z.literal("ruin_found"), characterId: z.string(), ruin: z.string() }),
    z.strictObject({ type: z.literal("exploration_started"), ruin: z.string() }),
    z.strictObject({ type: z.literal("exploration_changed"), depth: z.number().int().min(0), noise: z.number().int().min(0).max(3), searched: z.array(z.number().int()) }),
    z.strictObject({ type: z.literal("exploration_ended") }),
    /** 뇌물을 받았다 (12-153). 물건은 item_transferred로 따로 옮긴다 */
    z.strictObject({ type: z.literal("bribe_taken"), npcId: z.string(), by: z.string(), favor: z.string() }),
    // 약속 (12-160)
    z.strictObject({
      type: z.literal("promise_made"),
      id: z.string(),
      by: z.string(),
      to: z.string(),
      what: z.string(),
      due: z.number().int(),
      item: z.strictObject({ id: z.string(), quantity: z.number().int().positive() }).nullable(),
      favor: z.string().nullable().default(null),
    }),
    // 부탁 (12-181): 인물이 꺼낼 부탁도 약속 목록에 asked로 든다. 받으면 promise_accepted
    z.strictObject({
      type: z.literal("promise_asked"),
      id: z.string(),
      by: z.string(),
      to: z.string(),
      what: z.string(),
      due: z.number().int(),
      item: z.strictObject({ id: z.string(), quantity: z.number().int().positive() }).nullable(),
      favor: z.string(),
    }),
    // 의뢰 (12-291): 물어서 받은 일거리. 받으면 request_accepted (목표 엑스트라를 세계에 둔 뒤)
    z.strictObject({ type: z.literal("request_offered"), id: z.string(), by: z.string(), to: z.string(), what: z.string(), due: z.number().int(), item: z.strictObject({ id: z.string(), quantity: z.number().int().positive() }).nullable(), quest: questSchema }),
    z.strictObject({ type: z.literal("request_accepted"), id: z.string(), due: z.number().int(), target: z.string().nullable() }),
    z.strictObject({ type: z.literal("request_delivered"), id: z.string(), quantity: z.number().int().positive() }),
    /** 엑스트라가 머무는 자리를 옮긴다 (의뢰로 데려온 사람, 12-291) */
    z.strictObject({ type: z.literal("extra_rehomed"), characterId: z.string(), zone: z.string(), place: z.string().nullable() }),
    z.strictObject({
      type: z.literal("promise_accepted"),
      id: z.string(),
      what: z.string(),
      due: z.number().int(),
      item: z.strictObject({ id: z.string(), quantity: z.number().int().positive() }).nullable(),
    }),
    // 예전 부탁 이벤트 (12-174, 세이브 71까지). 읽을 때 약속 목록으로 옮긴다
    z.strictObject({ type: z.literal("favor_offered"), id: z.string(), npc: z.string(), favor: z.string() }),
    z.strictObject({ type: z.literal("favor_settled"), id: z.string(), status: z.enum(["accepted", "declined", "lapsed", "kept", "broken"]) }),
    // 포상 (12-171). itemId가 없으면 말뿐인 포상
    z.strictObject({ type: z.literal("reward_given"), characterId: z.string(), itemId: z.string().nullable() }),
    // 개 기르기 (12-172)
    z.strictObject({ type: z.literal("trick_trained"), animalId: z.string(), trick: z.string(), result: z.enum(["learned", "half", "miss"]), day: z.number().int() }),
    // 무전 송출 (12-173)
    z.strictObject({ type: z.literal("radio_broadcast"), day: z.number().int() }),
    // 매복 (12-177)
    z.strictObject({ type: z.literal("ambush_changed"), ambush: z.strictObject({ zone: z.string(), until: z.number().int(), bonus: z.number().int().min(1), confuse: z.boolean() }).nullable() }),
    z.strictObject({ type: z.literal("ambushed_changed"), until: z.number().int().nullable() }),
    z.strictObject({ type: z.literal("off_balance_changed"), until: z.number().int().nullable() }),
    z.strictObject({ type: z.literal("confusion_changed"), characterId: z.string(), on: z.boolean() }),
    z.strictObject({ type: z.literal("promise_settled"), id: z.string(), status: z.enum(["kept", "broken", "folded", "declined", "lapsed"]) }),
    /** 약점을 쥐고 협박했다 (12-153) */
    z.strictObject({ type: z.literal("blackmailed"), npcId: z.string(), by: z.string(), leverage: z.string(), grudge: z.boolean() }),
    /** 약점을 폭로했다 (12-153) */
    z.strictObject({ type: z.literal("leverage_exposed"), by: z.string(), key: z.string() }),
    // 협박이 끝났다 (12-182): 원한이 풀리고, keys의 약점은 내려놓는다 (exposed처럼 다시 쓰지 못한다)
    z.strictObject({ type: z.literal("blackmail_ended"), npcId: z.string(), by: z.string(), keys: z.array(z.string()) }),
    /** 짐이 무거울 때 창고 안내를 했다 (12-149) */
    z.strictObject({ type: z.literal("stash_hinted"), characterId: z.string() }),
    // 유품 (12-158): 죽은 사람의 사물함·거처의 짐이 가까운 사람에게 간다
    z.strictObject({ type: z.literal("stash_inherited"), from: z.string(), to: z.string() }),
    z.strictObject({ type: z.literal("fear_exposed"), characterId: z.string() }),
    z.strictObject({ type: z.literal("cold_load_set"), characterId: z.string(), load: z.number() }),
    /** 옷이 젖었다 / 말랐다 (until이 지금 이하면 마름, 12-121) */
    z.strictObject({ type: z.literal("soaked"), characterId: z.string(), until: z.number().int() }),
    // 젖은 옷 (12-186): left는 불 곁에서 마르기까지 남은 분. 0이면 말랐다
    z.strictObject({ type: z.literal("wet_set"), characterId: z.string(), left: z.number().min(0), cause: z.string() }),
    z.strictObject({ type: z.literal("fatigue_load_set"), characterId: z.string(), load: z.number() }),
    z.strictObject({ type: z.literal("fire_lit"), zone: z.string(), until: z.number().int(), itemId: z.string() }),
    /** 주인공이 붙잡혔다 / 풀려났다, 포로를 노역에 부린다 (12-55). held: 빼앗긴 물건 (풀려나면 돌려받는다) */
    // place: 갇히는 장소 (없으면 같은 구역이면 지금 자리, 다른 구역이면 막 들어선 자리)
    z.strictObject({ type: z.literal("player_captured"), by: z.string(), zone: z.string(), held: z.record(z.string(), z.number().int().positive()), quarantine: z.boolean().optional(), place: z.string().nullable().optional(), releaseAt: z.number().int().optional() }),
    /** 감염체에게 다쳤다 (격리의 근거, 12-238). 감염이 됐는지와 따로 */
    z.strictObject({ type: z.literal("infection_exposed"), characterId: z.string() }),
    /** 공들인 관계의 첫 죽음을 봐줬다 (12-242) */
    z.strictObject({ type: z.literal("npc_spared"), npcId: z.string() }),
    /** 설정을 거슬러 굴렸다 (공통 규칙 16) */
    /** 비밀(설정)을 털어놓았다: 그 자리에 있던 사람이 안다 */
    z.strictObject({ type: z.literal("secret_told"), owner: z.string(), to: z.array(z.string()) }),
    z.strictObject({ type: z.literal("setting_rolled"), setting: z.string(), spot: z.string(), won: z.boolean() }),
    z.strictObject({ type: z.literal("player_released"), returned: z.boolean() }),
    z.strictObject({ type: z.literal("prisoner_labor"), npcId: z.string(), labor: z.boolean() }),
    /** 맡긴다 / 구역의 산출이 는다 / 이야기로 배운다 (12-54) */
    z.strictObject({ type: z.literal("items_deposited"), zone: z.string(), items: z.record(z.string(), z.number().int().positive()) }),
    z.strictObject({ type: z.literal("zone_boosted"), zone: z.string(), resource: z.string(), delta: z.number().int() }),
    z.strictObject({ type: z.literal("skill_trained"), characterId: z.string(), skill: z.string(), to: z.number().int() }),
    /** 구역 보강 ± (12-48) */
    z.strictObject({ type: z.literal("zone_fortified"), zone: z.string(), delta: z.number().int() }),
    /** 땅 주인이 바뀐 소식을 들었다 (파트 14-3): 지도에 들은 대로 */
    z.strictObject({ type: z.literal("zone_heard"), zone: z.string(), owner: z.string().nullable() }),
    /**
     * 본 것이 아니라 전해 안 부대 (PT34): 분대 정찰 보고(squad), 우리 땅을 지키는 사람이 알아챔(garrison: 그 구역을 더 지키고 무리에 소식).
     * 알릴 수 있는 무리가 된다
     */
    z.strictObject({ type: z.literal("party_reported"), partyId: z.string(), via: z.enum(["squad", "garrison"]), zone: z.string(), faction: z.string().optional(), /** 이미 왔다 간 뒤에 알게 됐다: 알릴 무리도 더 지킬 곳도 아니다 */ gone: z.boolean().optional() }),
    /** 본 부대를 무리에 알렸다 (5-3): 그 부대가 노리는 구역을 더 지킨다. persuaded: 맞받아치자고 설득한 결과 */
    z.strictObject({ type: z.literal("party_alerted"), partyId: z.string(), faction: z.string(), zone: z.string(), persuaded: z.enum(["none", "success", "partial", "miss"]), until: z.number().int().optional(), plan: z.string().optional() }),
    /** 알린 부대의 끝 (5-3): credited 막아 내 공적을 받았다, clear 더 지키던 것을 거둔다 */
    z.strictObject({ type: z.literal("party_alert_settled"), partyId: z.string(), zone: z.string(), credited: z.boolean(), clear: z.boolean() }),
    /** 배경 부품이 세계의 사실이 되었다 (기획서 12.6) */
    z.strictObject({ type: z.literal("background_set"), entries: z.array(z.strictObject({ part: historyPartSchema(), characterId: z.string().optional() })) }),
    /** 직분의 평판 ± (기획서 12.6) */
    z.strictObject({ type: z.literal("occupation_standing_changed"), characterId: z.string(), delta: z.number().int(), reason: z.string() }),
    z.strictObject({ type: z.literal("npc_captured"), npcId: z.string(), by: z.string(), zone: z.string() }),
    z.strictObject({ type: z.literal("npc_released"), npcId: z.string() }),
    /** 인물 사이의 관계가 생겼다 (세계를 만들 때 무작위로) */
    z.strictObject({ type: z.literal("ties_generated"), ties: z.array(tieRecordSchema) }),
    /** 이름 없는 인물이 자랐다 (프로필은 틀의 재료에서 코드가 골랐다) */
    z.strictObject({ type: z.literal("extra_promoted"), characterId: z.string(), profile: z.custom<NonNullable<Character["profile"]>>((v) => typeof v === "object" && v !== null), ties: z.array(tieRecordSchema).default([]) }),
    /** 무기를 들거나 방어구를 입었다 (null이면 벗었다) */
    z.strictObject({ type: z.literal("item_equipped"), characterId: z.string(), slot: z.enum(["weapon", "body", "head", "arms", "outer", "back"]), itemId: z.string().nullable(), /** 등 칸: 멘 가방 개체 (없으면 빈 가방) */ bagId: z.string().optional() }),
    /** 물건이 닳았다 (delta 음수면 고쳤다) */
    z.strictObject({ type: z.literal("item_worn"), characterId: z.string(), itemId: z.string(), delta: z.number().int() }),
    /** 물건이 망가졌다: 하나 줄고, 닳은 것은 처음으로, into가 있으면 그것이 남는다 */
    z.strictObject({ type: z.literal("item_broken"), characterId: z.string(), itemId: z.string(), into: z.string().nullable() }),
    /** 소리가 났다 (총소리 등): 그 구역의 오늘 소음 */
    z.strictObject({ type: z.literal("noise_made"), zone: z.string(), level: z.number().int().min(1), day: z.number().int() }),
    /** 소리를 듣고 감염체가 몰려온다 (at에 닿는다) / 닿았다 (done) */
    /** 갇힌 주인공의 탈출이 실패해 감시가 심해졌다 */
    z.strictObject({ type: z.literal("captive_watch_raised") }),
    /** 그날 배급을 못 받았다 (day) / 늦게 받았다 (null) */
    /** 들키지 않기가 조건인 임무 중에 들켰다 */
    z.strictObject({ type: z.literal("mission_spotted"), missionId: z.string() }),
    z.strictObject({ type: z.literal("armory_spare_issued") }),
    /** 우리 땅에 돌아왔다: 자리 비움을 셈하고 지운다 */
    z.strictObject({ type: z.literal("returned_home") }),
    z.strictObject({ type: z.literal("ration_missed"), day: z.number().int().nullable() }),
    /** 판정의 대가를 다치는 대신 다른 것(시간)으로 치렀다: 그 판정을 이어받는 이야기는 "다친다"를 겹쳐 붙이지 않는다 (플레이 테스트 12) */
    /** timeDay: 시간으로 대가를 치른 날 (12-258: 같은 날 두 번째부터는 소리) */
    z.strictObject({ type: z.literal("check_cost_paid"), checkId: z.string(), timeDay: z.number().int().optional() }),
    /** 판정으로 상대에게 피해를 입혔다 (이야기의 같은 피해를 겹치지 않게) */
    z.strictObject({ type: z.literal("check_harm_dealt"), checkId: z.string(), targetId: z.string(), steps: z.number().int().positive() }),
    z.strictObject({ type: z.literal("swarm_set"), zone: z.string(), day: z.number().int(), at: z.number().int(), done: z.boolean(), met: z.boolean().optional() }),
    /** 구역의 감염체 압력이 바뀌었다 (12-112): 소음·시체로 오르고, 소탕으로 내리고, 날이 가며 기준값으로 돌아간다 */
    z.strictObject({ type: z.literal("infestation_changed"), zone: z.string(), level: z.number().int().min(0).max(3), cause: z.string() }),
    /** 무기고가 작전 장비를 빌려줬다 (무리 창고의 탄약 resource가 cost만큼 준다) */
    /** 임무로 맡은 짐·대금의 기록을 바꾼다 (지닌 물건은 item_granted·item_consumed가 바꾼다, 공통 규칙 10) */
    z.strictObject({ type: z.literal("cargo_set"), missionId: z.string(), items: z.record(z.string(), z.number().int().min(1)) }),
    z.strictObject({ type: z.literal("armory_issued"), missionId: z.string(), factionId: z.string(), items: z.record(z.string(), z.number().int().min(1)), resource: z.string(), cost: z.number().int().min(0) }),
    /** 빌린 장비를 반납했다 (returned: 돌려준 것. 모자란 것은 잃어버린 것) */
    z.strictObject({ type: z.literal("armory_returned"), missionId: z.string(), returned: z.record(z.string(), z.number().int().min(1)) }),
    /** 상인이 물건을 다시 채웠다 */
    z.strictObject({ type: z.literal("merchant_restocked"), npcId: z.string(), day: z.number().int(), items: z.record(z.string(), z.number().int().min(1)) }),
    /** 해금을 얻었다 (inherited: 다른 판에서 얻은 것을 옮겨 왔다) */
    z.strictObject({ type: z.literal("unlock_earned"), id: z.string(), inherited: z.boolean().default(false) }),
    /** 지금 시나리오의 클리어 목표를 이뤘다 (기획서 12.4.1). 게임은 끝나지 않는다: 플레이어가 계속할지 정한다 */
    z.strictObject({ type: z.literal("scenario_cleared"), roleId: z.string() }),
    /** 주인공이 찾는 가족이 정해졌다 (세계를 만들 때, 역할의 family) */
    z.strictObject({ type: z.literal("family_set"), ids: z.array(z.string()) }),
    /** 의식불명 중 곁의 사람이 할 일을 정했다 (12-90). outcome: tended 돌봄, carried 옮겨짐, captured 붙잡힘, killed 죽임, bitten 감염체, none 아무 일 없음 */
    z.strictObject({ type: z.literal("helpless_resolved"), outcome: z.enum(["tended", "carried", "captured", "killed", "bitten", "none"]), by: z.string().nullable() }),
    z.strictObject({ type: z.literal("helpless_cleared") }),
    /** 출혈이 부상을 키웠다: 그 트랙의 시계를 다시 센다 (12-91) */
    z.strictObject({ type: z.literal("nerves_sleep_spent") }),
    z.strictObject({ type: z.literal("track_clock_reset"), characterId: z.string(), track: z.string() }),
    /** 숨은 관계를 털어놓았다 */
    z.strictObject({ type: z.literal("tie_revealed"), key: z.string() }),
    /** 함께 다니기 시작했다. kind가 없으면 이전 세이브 (코드가 틀로 정한다) */
    z.strictObject({ type: z.literal("companion_joined"), characterId: z.string(), kind: z.enum(BOND_KINDS).optional(), missionId: z.string().optional(), until: bondUntilSchema.optional() }),
    /** 헤어졌다 (함께 다니는 이유가 끝났다) */
    z.strictObject({ type: z.literal("companion_left"), characterId: z.string(), reason: z.string().optional() }),
    /** 잠시 떨어진다: zone에서 기다리거나, until에 돌아온다 */
    z.strictObject({ type: z.literal("companion_parted"), characterId: z.string(), zone: z.string().nullable(), until: z.number().int().nullable(), place: z.string().nullable().optional() }),
    /** 떨어져 있던 동행이 다시 곁에 왔다 */
    z.strictObject({ type: z.literal("companion_rejoined"), characterId: z.string() }),
    /** 목적을 이뤄 갈림길에 섰다 */
    z.strictObject({ type: z.literal("companion_crossroads"), characterId: z.string(), lean: z.enum(["stay", "leave"]), decideBy: z.number().int() }),
    /** 함께 다니는 이유가 바뀌었다 (목적 → 연고, 목적 연장) */
    z.strictObject({ type: z.literal("companion_bond_changed"), characterId: z.string(), kind: z.enum(BOND_KINDS), until: bondUntilSchema.optional() }),
    z.strictObject({ type: z.literal("debt_changed"), characterId: z.string(), factionId: z.string(), delta: z.number().int() }),
    /** 분대원에게 일을 맡겼다 (기획서 9.11). 시각은 코드가 정한다 */
    z.strictObject({ type: z.literal("squad_order_given"), npcId: z.string(), task: z.string(), zone: z.string(), until: z.number().int() }),
    /** 분대원이 명령을 거절했다 */
    z.strictObject({ type: z.literal("squad_order_refused"), npcId: z.string(), task: z.string() }),
    /** 맡긴 일이 끝났다 (결과는 코드가 굴렸다). report: 주인공이 듣는 보고 */
    z.strictObject({ type: z.literal("squad_order_done"), npcId: z.string(), task: z.string(), outcome: checkOutcomeSchema.nullable(), report: z.string() }),
    /** 원하던 선물을 받았다 (12-257): 같은 사람에게 하루 한 번만 마음이 움직인다 */
    z.strictObject({ type: z.literal("gift_welcomed"), npcId: z.string(), day: z.number().int() }),
    /** 지도부 회의에 안을 올렸다 */
    z.strictObject({ type: z.literal("council_proposed"), topic: z.string(), option: z.string(), outcome: checkOutcomeSchema, day: z.number().int(), blockedUntil: z.number().int() }),
    /** 무리 방침이 바뀌었다 */
    z.strictObject({ type: z.literal("faction_policy_set"), factionId: z.string(), topic: z.string(), option: z.string() }),
    /** NPC가 떠난다: toFaction이면 그 세력으로 넘어가고(도시에 남는다), null이면 도시를 떠난다 (기획서 10.4) */
    z.strictObject({ type: z.literal("npc_departed"), npcId: z.string(), toFaction: z.string().nullable() }),
    z.strictObject({ type: z.literal("faction_resource_changed"), factionId: z.string(), resource: z.string(), delta: z.number().int() }),
    /** 무리의 사람 수가 바뀌었다 (12-133) */
    z.strictObject({ type: z.literal("faction_population_changed"), factionId: z.string(), delta: z.number().int() }),
    /** 세력 사이 태도가 바뀐다 (값은 코드가 계산한 새 값) */
    z.strictObject({ type: z.literal("faction_disposition_changed"), from: z.string(), to: z.string(), value: z.number().int().min(-3).max(3) }),
    /** 협정을 맺었다 (12-126). 포로 교환은 그 자리에서 끝나므로 기록만 남는다 (until 없음) */
    z.strictObject({
      type: z.literal("pact_made"),
      id: z.string(),
      kind: z.enum(["truce", "exchange"]),
      a: z.string(),
      b: z.string(),
      until: z.number().int().optional(),
      restore: z.strictObject({ ab: z.number().int(), ba: z.number().int() }).optional(),
    }),
    /** 휴전이 끝났다 (기한이 됐거나 깨졌다) */
    z.strictObject({ type: z.literal("pact_ended"), id: z.string(), broken: z.boolean() }),
    /** 협상이 거절됐다: until까지 그 무리에 다시 꺼내지 못한다 */
    z.strictObject({ type: z.literal("negotiation_refused"), factionId: z.string(), until: z.number().int() }),
    /**
     * 주인공이 무리에 들어간다 (무소속이면 가입, 무리에 있으면 옮김). 역할은 코드가 만든다 (game/customStart.ts joinRole, 기획서 12.5).
     * beliefs: 그 무리에서 처음 듣는 사정 (같은 계급 시나리오의 시작 지식)
     */
    z.strictObject({ type: z.literal("player_joined_faction"), factionId: z.string(), rank: z.string(), role: customRoleSchema, beliefs: z.array(beliefSchema).default([]), graceUntil: z.number().int().optional() }),
    /** 무소속 주인공을 손님으로 들였다 (공통 규칙 22): 대표의 면담은 offerAt 뒤. rank·title·graceDays는 받아들일 때 쓴다 */
    z.strictObject({ type: z.literal("player_admitted"), factionId: z.string(), rank: z.string().optional(), title: z.string().optional(), post: z.string().optional(), graceDays: z.number().int().optional(), offerAt: z.number().int() }),
    /** 대표의 권유를 사양했다: 손님으로 남고 offerAt에 다시 권한다 (공통 규칙 22) */
    z.strictObject({ type: z.literal("admission_deferred"), offerAt: z.number().int() }),
    /** 거점 밖에 사는 상관이 우리 거점에 들렀다 (12-311) */
    z.strictObject({ type: z.literal("chief_visited"), day: z.number().int() }),
    z.strictObject({ type: z.literal("npc_left"), npcId: z.string() }),
    z.strictObject({ type: z.literal("belief_added"), characterId: z.string(), belief: beliefSchema }),
    /** 낡은 믿음을 지운다 (PT15 튜토리얼: 가족을 다시 만났는데 "어디 있는지 모른다"가 남았다) */
    z.strictObject({ type: z.literal("belief_dropped"), characterId: z.string(), beliefId: z.string() }),
    z.strictObject({ type: z.literal("missions_offered"), day: z.number().int(), templateIds: z.array(z.string()) }),
    z.strictObject({ type: z.literal("mission_assigned"), mission: missionInstanceSchema }),
    z.strictObject({
      type: z.literal("mission_reported"),
      missionId: z.string(),
      outcome: z.enum(["success", "partial", "failed"]),
      late: z.boolean(),
      merit: z.number().int(),
      /** 기한을 넘겨 빈손으로 보고했고 탓할 까닭이 없어 무리의 규율이 불복종으로 친다 (12-369, 예전의 기한 초과) */
      disobedience: z.boolean().optional(),
    }),
    /** 함께 걷던 사람을 놓아준다 (12-369, 임무 보고: 임무로 함께 다니던 사람은 더 따라오지 않는다) */
    z.strictObject({ type: z.literal("walkers_released") }),
    /** disobedience: 무리의 규율이 이것을 불복종으로 치는지 (기획서 9.9). 이전 세이브는 true */
    /** 판정·활동이 아닌 결과 조건(goal, bring)을 채웠다 (플레이 테스트 11) */
    z.strictObject({ type: z.literal("mission_requirement_met"), missionId: z.string(), index: z.number().int().min(0) }),
    z.strictObject({ type: z.literal("mission_abandoned"), missionId: z.string(), merit: z.number().int(), reason: z.string(), disobedience: z.boolean().default(true) }),
    z.strictObject({ type: z.literal("mission_expired"), missionId: z.string(), merit: z.number().int(), disobedience: z.boolean().default(true), excused: z.string().optional() }),
    /** 오래된 불복종 하나가 지워졌다 (C8) */
    z.strictObject({ type: z.literal("disobedience_forgiven"), characterId: z.string() }),
    z.strictObject({ type: z.literal("promoted"), characterId: z.string(), from: rank, to: rank }),
    // 진급 제안과 분대 (12-190)
    z.strictObject({ type: z.literal("promotion_offered"), to: rank }),
    z.strictObject({ type: z.literal("promotion_declined") }),
    z.strictObject({ type: z.literal("squad_set"), members: z.array(z.string()) }),
    z.strictObject({ type: z.literal("squad_joined"), characterId: z.string() }),
    z.strictObject({ type: z.literal("deed_recorded"), deed: deedSchema }),
    /** 짓이 끝난 때와 가져온 물건 (설계 목록 2-1·2-4) */
    z.strictObject({ type: z.literal("deed_settled"), deedId: z.string(), endedAt: z.number().int(), items: z.record(z.string(), z.number().int().positive()).optional() }),
    z.strictObject({ type: z.literal("deed_returned"), deedId: z.string() }),
    z.strictObject({
      type: z.literal("deed_learned"),
      deedId: z.string(),
      npcId: z.string(),
      source: beliefSourceSchema,
      /** 이 NPC의 행위자에 대한 관계 변화 (코드가 계산) */
      delta: relationDeltaSchema,
      /** 예전 세이브의 부풀려 들은 크기 (12-127, 12-181에 왜곡을 뺐다). 읽기만 하고 쓰지 않는다 */
      heardAs: z.number().int().min(1).max(3).optional(),
    }),
    z.strictObject({ type: z.literal("witnesses_searched"), deedId: z.string() }),
    z.strictObject({ type: z.literal("rumors_spread"), day: z.number().int() }),
    z.strictObject({
      type: z.literal("factions_initialized"),
      day: z.number().int(),
      factions: z.record(z.string(), factionStateSchema),
      zones: z.record(z.string(), zoneStateSchema),
      clocks: z.record(z.string(), clockStateSchema),
    }),
    /** 하루 전쟁 틱의 결과 (코드가 계산). 세력·구역·클락의 새 값과 일어난 교전 */
    z.strictObject({
      type: z.literal("war_day_simulated"),
      day: z.number().int(),
      factions: z.record(z.string(), factionStateSchema),
      zones: z.record(z.string(), zoneStateSchema),
      /** target: 바뀐 목표 (빼앗아 우리 땅이 된 목표를 다시 고른 것, 정찰 보고로 바꾼 것) */
      clocks: z.record(z.string(), z.strictObject({ filled: z.number().int().min(0), target: z.string().optional() })),
      clashes: z.array(clashSchema),
      /** 플레이어가 낄 수 있어 미뤄 둔 교전 */
      scheduled: z.array(pendingClashSchema).default([]),
      /** 움직이는 부대의 새 목록 (없으면 그대로) */
      parties: z.array(partySchema).optional(),
      nextPartyNo: z.number().int().min(0).optional(),
      partiesUpTo: z.number().int().optional(),
    }),
    /** 움직이는 부대가 시간이 흐르는 사이에 닿고 마주치고 돌아왔다 (닿을 때 계산). 세력·구역·클락·부대의 새 값과 일어난 교전 */
    z.strictObject({
      type: z.literal("parties_advanced"),
      factions: z.record(z.string(), factionStateSchema),
      zones: z.record(z.string(), zoneStateSchema),
      /** target: 땅이 바뀌어 다시 고른 목표 (PT36) */
      clocks: z.record(z.string(), z.strictObject({ filled: z.number().int().min(0), target: z.string().optional() })),
      parties: z.array(partySchema),
      partiesUpTo: z.number().int(),
      /** 새로 낸 부대가 있으면 다음 부대 번호 */
      nextPartyNo: z.number().int().min(0).optional(),
      clashes: z.array(clashSchema),
      scheduled: z.array(pendingClashSchema).default([]),
    }),
    /** 임무가 세력 클락을 앞당겼다 (파트 11 기여 기록) */
    z.strictObject({ type: z.literal("clock_credited"), clockId: z.string(), by: z.string(), mission: z.string(), scout: z.boolean() }),
    /** 주인공이 길 위의 부대와 맞붙었다 (움직이는 부대 ③): 장면에 들인 부대원 */
    z.strictObject({ type: z.literal("party_engaged"), partyId: z.string(), members: z.array(z.string()), zone: z.string() }),
    z.strictObject({ type: z.literal("party_fight_ended"), partyId: z.string() }),
    /** 주인공이 부대와 마주쳤다 (공통 규칙 23). player: 주인공이 봤다, party: 부대가 주인공을 봤다 */
    z.strictObject({ type: z.literal("party_sighted"), key: z.string(), player: z.boolean(), party: z.boolean() }),

    z.strictObject({ type: z.literal("zone_moved"), from: z.string().nullable(), to: z.string(), with: z.array(z.string()).optional(), /** with 가운데 GM이 고른 함께 걷는 사람 (12-368) */ walking: z.array(z.string()).optional(), /** 도착하는 장소 (장소 개편: 길). 장소가 없는 구역이면 null */ place: z.string().nullable().optional() }),
    /** 같은 구역 안에서 장소를 옮겼다 (12-244). null이면 구역의 장소를 정하지 않은 곳 */
    // with: 동행 말고 함께 옮겨 가는 장면의 인물 (공통 규칙 15 comesAlong)
    /** 가 보지 않고 장소를 알게 됐다 (설계 목록 C-1: 들은 단편·테스트). 있어 본 곳은 applyEvent가 저절로 기록한다 */
    z.strictObject({ type: z.literal("place_learned"), zone: z.string(), place: z.string() }),
    z.strictObject({ type: z.literal("npc_knocked_out"), npcId: z.string(), until: z.number().int() }),
    z.strictObject({ type: z.literal("place_moved"), from: z.string().nullable(), to: z.string().nullable(), with: z.array(z.string()).optional(), walking: z.array(z.string()).optional() }),
    /** GM이 즉흥 장소를 만들었다 (12-244) */
    z.strictObject({ type: z.literal("place_spawned"), id: z.string(), zone: z.string(), name: z.string(), indoor: z.boolean(), owner: z.string().nullable(), at: z.string().nullable().optional(), shop: z.string().optional() }),
    z.strictObject({ type: z.literal("weather_set"), day: z.number().int(), weatherId: z.string() }),
    z.strictObject({ type: z.literal("weather_forecast"), day: z.number().int(), weatherId: z.string() }),
    z.strictObject({ type: z.literal("character_died"), record: runRecordSchema }),
    /** 죽은 사람의 유해가 그 구역에 남았다 (12-130) */
    z.strictObject({ type: z.literal("remains_left"), remains: remainsSchema }),
    /** 그 무리가 주인공이 자기 사람을 죽인 것을 알았다 / 현상금을 걸었다 / 거뒀다 (12-136) */
    z.strictObject({ type: z.literal("kill_known"), factionId: z.string() }),
    z.strictObject({ type: z.literal("bounty_posted"), factionId: z.string() }),
    z.strictObject({ type: z.literal("bounty_cleared"), factionId: z.string() }),
    /** 주인공에게 복수를 다짐했다 / 원한이 풀렸다 (12-135) */
    z.strictObject({ type: z.literal("vendetta_sworn"), avenger: z.string(), victim: z.string() }),
    z.strictObject({ type: z.literal("vendetta_settled"), avenger: z.string() }),
    /** 덫을 놓았다 / 덫에 걸렸다 / 덫을 거뒀다 (12-131) */
    z.strictObject({ type: z.literal("trap_set"), zone: z.string(), at: z.number().int(), item: z.string().optional() }),
    z.strictObject({ type: z.literal("trap_caught"), zone: z.string(), item: z.string(), qty: z.number().int().min(1) }),
    z.strictObject({ type: z.literal("trap_collected"), zone: z.string() }),
    /** 유해를 묻었다. marker: 묘비에 적힌 말 (12-130) */
    z.strictObject({ type: z.literal("remains_buried"), holder: z.string(), at: z.number().int(), marker: z.string() }),
    /**
     * 몸 상태 트랙이 바뀌었다 (12-1: 치료, 소모품, 배급에 따른 허기, 감염 진행, 굶주림·감염의 부상).
     * 판정에 묶인 피해는 harm_applied를 쓴다. by: healer | rest | daily | infection | 아이템 id
     */
    z.strictObject({
      type: z.literal("condition_changed"),
      targetId: z.string(),
      track: z.string(),
      from: z.string(),
      to: z.string(),
      fatal: z.boolean(),
      by: z.string(),
      cause: z.string(),
      day: z.number().int(),
      /** 부상 트랙이면 회복 기준 시각을 새로 잡는다 */
      harmTrack: z.boolean(),
    }),
    /** 감염을 늦추는 약을 썼다: day로 넘어가는 하루치 진행에 듣는다 (12-106) */
    z.strictObject({ type: z.literal("infection_slowed"), targetId: z.string(), day: z.number().int() }),
    /** 약 덕분에 day로 넘어가며 감염이 퍼지지 않았다 (12-106) */
    z.strictObject({ type: z.literal("infection_held"), targetId: z.string(), day: z.number().int() }),
    /** (이전 형식) 부상이 나았다. 새 기록은 condition_changed를 쓴다 */
    z.strictObject({
      type: z.literal("harm_healed"),
      targetId: z.string(),
      track: z.string(),
      from: z.string(),
      to: z.string(),
      by: z.string(),
      day: z.number().int(),
    }),
    z.strictObject({ type: z.literal("epitaph_written"), index: z.number().int().min(0), text: z.string().min(1).max(300) }),
    /** 다음 캐릭터로 이어 간다. 새로 만든 캐릭터면 character가 있다 */
    z.strictObject({
      type: z.literal("character_switched"),
      characterId: z.string(),
      /** 다른 역할로 이어 갈 때: 다른 시나리오의 새 캐릭터, 또는 이어받는 인물의 자리 (기획서 12.4.1) */
      roleId: z.string().optional(),
      /** 그 자리가 콘텐츠에 없어 코드가 만든 역할 (roleId는 그 역할의 id) */
      customRole: customRoleSchema.optional(),
      /** 이제 플레이하는 시나리오. 빈 글이면 시나리오 없이 (두 번째 주인공부터는 세계만 이어 간다, 기획서 12.4.1). 없으면 roleId */
      scenarioRole: z.string().optional(),
      character: character.optional(),
      known: z.array(z.string()),
    }),
    z.strictObject({
      type: z.literal("storylet_fired"),
      storyletId: z.string(),
      cast: z.record(z.string(), z.string()),
      expiresAt: z.number().int(),
      /** 즉흥 이야기 (12-247): 코드가 GM의 글과 보상 등급으로 만든 스토리렛 정의 */
      improvised: z.record(z.string(), z.unknown()).optional(),
    }),
    /** 즉흥 이야기 자리가 열렸다·닫혔다 (12-247) */
    z.strictObject({ type: z.literal("improv_slot_opened"), expiresAt: z.number().int() }),
    z.strictObject({ type: z.literal("improv_slot_closed"), /** 쓰지 않고 닫혔다 (기한이 지남) */ unused: z.boolean().optional() }),
    z.strictObject({
      type: z.literal("storylet_resolved"),
      storyletId: z.string(),
      choiceId: z.string(),
      outcome: checkOutcomeSchema.nullable(),
    }),
    z.strictObject({ type: z.literal("storylet_expired"), storyletId: z.string() }),
    z.strictObject({ type: z.literal("flag_set"), characterId: z.string(), flag: z.string() }),
    z.strictObject({ type: z.literal("flag_cleared"), characterId: z.string(), flag: z.string() }),
    /** 스토리렛 효과 등으로 관계가 바뀌었다 (from이 to를 보는 관계) */
    /** known: 주인공이 장면 밖에서도 그 태도를 안다 (가족·오랜 동료처럼 원래 알던 사이) */
    /** kind: 까닭 열쇠 (공통 규칙 19, rules/regard.ts). 예전 세이브에는 없다 */
    z.strictObject({ type: z.literal("relation_changed"), from: z.string(), to: z.string(), delta: relationDeltaSchema, reason: z.string(), kind: z.string().optional(), known: z.boolean().optional() }),
    z.strictObject({ type: z.literal("merit_awarded"), characterId: z.string(), delta: z.number().int(), reason: z.string() }),
    /** 경험치를 얻었다. level은 얻은 뒤의 레벨 (코드가 계산), source가 check면 하루 상한에 센다 */
    z.strictObject({
      type: z.literal("xp_gained"),
      characterId: z.string(),
      amount: z.number().int().positive(),
      source: z.enum(["check", "merit", "cheat"]),
      level: z.number().int().min(1),
    }),
    /** 치트 (개발 모드, 기획서 17.2): 플레이어가 친 명령. 한 번이라도 쓰면 이 세이브는 치트를 쓴 것으로 남는다 */
    z.strictObject({ type: z.literal("cheat_used"), command: z.string() }),
    /** 치트: 캐릭터의 능력·스킬·트레잇을 바꾼다 (준 것만) */
    z.strictObject({
      type: z.literal("character_patched"),
      characterId: z.string(),
      stats: z.record(z.string(), z.number().int()).optional(),
      skills: z.record(z.string(), z.number().int()).optional(),
      traits: z.array(z.string()).optional(),
    }),
    /** 치트: 세력의 자원을 바꾼다 (준 것만) */
    z.strictObject({ type: z.literal("faction_patched"), factionId: z.string(), resources: z.record(z.string(), z.number()) }),
    /** 이름 없는 인물이 주인공과 엮여 캐릭터가 됐다 (기획서 7.5). 장면에 들어온다 */
    /** unseen: 주인공이 보지 않은 곳에서 생겼다 (변이, 12-117). 장면에 넣지 않고 만난 것으로 치지 않는다 */
    z.strictObject({ type: z.literal("extra_spawned"), character, unseen: z.boolean().optional() }),
    /** characterId가 targetId의 이름을 알게 됐다 (기획서 6.3) */
    z.strictObject({ type: z.literal("name_learned"), characterId: z.string(), targetId: z.string() }),
    /** 레벨업으로 스킬 하나를 올렸다 */
    /** 스킬 포인트로 한 단계 올렸다. cost: 쓴 점수 (4.2.1, 이전 이벤트는 1) */
    z.strictObject({ type: z.literal("skill_learned"), characterId: z.string(), skill: z.string(), from: z.number().int(), to: z.number().int(), cost: z.number().int().min(1).default(1) }),
    /** 가르침 (4.2.1): 전문 기술을 배우는 시간을 채웠다. 다 채우면 skill_trained가 따른다 */
    z.strictObject({ type: z.literal("skill_lesson"), characterId: z.string(), skill: z.string(), teacherId: z.string(), hours: z.number().int().positive() }),
    z.strictObject({ type: z.literal("item_granted"), to: z.string(), itemId: z.string(), quantity: z.number().int().positive() }),
    z.strictObject({ type: z.literal("clock_adjusted"), clockId: z.string(), delta: z.number().int() }),
    z.strictObject({ type: z.literal("faction_morale_changed"), factionId: z.string(), delta: z.number().int() }),
    z.strictObject({ type: z.literal("preparation_set"), zone: z.string(), preparation: z.string() }),
    z.strictObject({ type: z.literal("item_consumed"), holder: z.string(), itemId: z.string(), quantity: z.number().int().positive() }),
    /** 예정된 교전을 화면 밖에서 계산했다 (플레이어가 자리에 없었다) */
    z.strictObject({
      type: z.literal("clash_resolved"),
      pendingId: z.string(),
      clash: clashSchema,
      factions: z.record(z.string(), factionStateSchema),
      zones: z.record(z.string(), zoneStateSchema),
      /** 땅이 바뀌어 다시 고른 계획 목표 */
      targets: z.record(z.string(), z.string()).optional(),
    }),
    /** barrierUsed: 이 전투에서 막기로 쓰고 부서지는 준비물 (바리케이드, 12-176) */
    z.strictObject({ type: z.literal("battle_started"), pendingId: z.string(), battle: battleStateSchema, barrierUsed: z.array(z.string()).default([]) }),
    z.strictObject({
      type: z.literal("battle_round"),
      effect: z.string().nullable(),
      checkId: z.string().nullable(),
      momentum: z.number().int(),
      alarm: z.number().int().min(0),
      position: z.string(),
      objectives: z.array(z.string()),
      ourLosses: z.number().int().min(0),
      theirLosses: z.number().int().min(0),
      contribution: z.number().int(),
      /** 쓴 준비물 (구역에서 빠진다) */
      preparationUsed: z.string().optional(),
      /** 바리케이드가 남은 막기 (12-176) */
      holds: z.number().int().min(0).optional(),
    }),
    z.strictObject({
      type: z.literal("battle_ended"),
      /** 우리 편이 이겼는지 (방어는 버텼는지, 공격은 목적을 이뤘는지) */
      won: z.boolean(),
      withdrew: z.boolean(),
      clash: clashSchema,
      factions: z.record(z.string(), factionStateSchema),
      zones: z.record(z.string(), zoneStateSchema),
      merit: z.number().int().min(0),
      /** 땅이 바뀌어 다시 고른 계획 목표 */
      targets: z.record(z.string(), z.string()).optional(),
    }),
    z.strictObject({ type: z.literal("secret_revealed"), npcId: z.string() }),
    z.strictObject({ type: z.literal("turn_started"), turn: z.number().int().positive(), input: z.string() }),
    z.strictObject({
      type: z.literal("check_rolled"),
      checkId: z.string(),
      turn: z.number().int(),
      actorId: z.string(),
      move,
      stat,
      difficulty: difficultySchema,
      intent: z.string(),
      dice: z.tuple([z.number().int().min(1).max(6), z.number().int().min(1).max(6)]),
      /** condition: 상태 트랙(부상 등)에서 오는 보정 */
      /** stat: 능력, skill: 스킬 (능력 + 스킬은 상한까지), condition: 몸 상태 */
      modifiers: z.strictObject({
        stat: z.number().int(),
        skill: z.number().int().default(0),
        difficulty: z.number().int(),
        condition: z.number().int(),
        /** 트레잇의 상황 보정 (끌림 등) */
        trait: z.number().int().default(0),
        /** 물건의 불리함 (입은 방어구, 무거운 짐, 기획서 4.8) */
        gear: z.number().int().default(0),
        /** 상대와 상황 (상대의 실력, 지켜보는 눈, 어둠, 12-104) */
        opposition: z.number().int().default(0),
      }),
      /** 맞선 상대 인물 id (12-104) */
      opponent: z.string().optional(),
      total: z.number().int(),
      outcome: checkOutcomeSchema,
      /** 상대 인물 id */
      target: z.string().optional(),
      /** 이 판정이 수행 중인 임무를 위한 것이면 그 임무 id (임무 진행으로 집계) */
      forMission: z.string().optional(),
      /** 옮겨 가며 건 판정이면 가는 곳 (플레이 테스트 12: 잠입하며 건 은밀이 출발 구역 기준이라 임무로 세지 않았다) */
      dest: z.string().optional(),
      /** 이야기 선택지 판정: 성공하면 임무로 세고, 빗나가도 임무 빗나감으로 세지 않는다 (12-258) */
      story: z.boolean().optional(),
      /** 닥친 일에 버티는 판정(공포·마음 다잡기 등, 시스템이 굴림). 이야기 선택지의 판정으로 쓰지 않는다 (12-267) */
      reaction: z.boolean().optional(),
    }),
    z.strictObject({
      type: z.literal("harm_applied"),
      targetId: z.string(),
      checkId: z.string(),
      track,
      severity: harmSeveritySchema,
      steps: z.number().int().positive(),
      from: z.string(),
      to: z.string(),
      /** to가 치명 단계(사망)인지. 코드가 시나리오 트랙으로 계산한다 */
      fatal: z.boolean(),
      cause: z.string(),
    }),
    z.strictObject({
      type: z.literal("time_advanced"),
      activity: activitySchema,
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
      /** 빨리감기가 중간에 멈췄다면 그 이유 */
      interrupt: interruptSchema.optional(),
      /** 이 활동이 수행 중인 임무를 위한 것이면 그 임무 id (임무 진행으로 집계) */
      forMission: z.string().optional(),
      /** 이동이면 가는 곳 (거점에서 나서는 이동도 "거점 밖" 임무로 센다, 플레이 테스트 8) */
      dest: z.string().optional(),
    }),
    z.strictObject({
      type: z.literal("item_transferred"),
      from: z.string(),
      to: z.string(),
      itemId: z.string(),
      quantity: z.number().int().positive(),
      /** 주인공이 맡긴 것이면 맡긴 조건 (예: "나갈 때 돌려준다", 12-196) */
      deposit: z.string().optional(),
      /** 가방이면 그 가방 개체째 (공통 규칙 26). 없으면 빈 가방부터 */
      bagId: z.string().optional(),
    }),
    /** 가방에 넣기·꺼내기 (공통 규칙 26). bagId가 아직 없으면 그 가방 물건으로 새 개체를 만든다 */
    z.strictObject({ type: z.literal("bag_packed"), characterId: z.string(), bagId: z.string(), bagItem: z.string(), itemId: z.string(), quantity: z.number().int().positive(), direction: z.enum(["pack", "unpack"]), /** 새 개체를 메고 있는 가방으로 만든다 */ worn: z.boolean().optional() }),
  ]);

  return { character, checkRecord, state, event };
}

type GameSchemas = ReturnType<typeof createGameSchemas>;
export type CheckRecord = z.infer<GameSchemas["checkRecord"]>;
export type GameState = z.infer<GameSchemas["state"]>;
export type GameEvent = z.infer<GameSchemas["event"]>;

/** 세계가 만들어지기 전의 빈 상태. 첫 이벤트는 반드시 world_created다 */
export const EMPTY_STATE: GameState = {
  scenarioId: "",
  worldId: "",
  worldSeed: null,
  roleId: "",
  customRole: null,
  zoneSearches: {},
  pacts: [],
  negotiationBlocked: {},
  infested: {},
  keptExtras: {},
  lastRoute: null,
  walkingWith: [],
  options: { mature: false, dialogue: "novel" },
  memos: {},
  stashes: {},
  entrusted: [],
  homes: {},
  stashHinted: [],
  infiltration: null,
  ruinsFound: {},
  resolves: {},
  facilities: {},
  wrecked: {},
  wounded: [],
  agendas: {},
  disaster: null,
  lastDisasterDay: null,
  resolveSeeded: [],
  resolveNote: null,
  resolveLog: [],
  sagas: {},
  exploration: null,
  bribes: [],
  promises: [],
  rewardsGiven: {},
  tricks: {},
  lastBroadcastDay: null,
  ambush: null,
  ambushed: null,
  offBalanceUntil: null,
  confused: [],
  blackmails: [],
  exposed: [],
  coldLoad: {},
  wet: {},
  fatigueLoad: {},
  fires: {},
  romances: {},
  flirtDay: {},
  deposits: {},
  visited: {},
  knownPlaces: {},
  knockedOut: {},
  background: [],
  companions: [],
  bonds: {},
  dynamicTies: [],
  revealedTies: [],
  unlocked: [],
  scenarioRole: "",
  cleared: [],
  family: [],
  zoneNoise: {},
  swarms: {},
  zoneSeen: {},
  groundItems: {},
  bags: {},
  bagSeq: 0,
  playerPlace: null,
  spawnedPlaces: {},
  npcStays: {},
  giftWelcomedDay: {},
  timeCostDay: null,
  loans: {},
  cargo: {},
  exposedAt: {},
  missionGraceUntil: null,
  admission: null,
  sparedOnce: [],
  settingRolls: {},
  secretKnownBy: {},
  restockedDay: {},
  squad: null,
  promotionOffer: null,
  squadOrders: {},
  squadReports: {},
  council: {},
  turn: 0,
  time: START_TIME,
  playerId: "",
  characters: {},
  scene: { items: {}, present: [] },
  checks: {},
  nextCheckNo: 1,
  nextExtraNo: 1,
  cheated: false,
  xpToday: { day: 0, amount: 0 },
  lessons: {},
  beliefs: {},
  known: {},
  met: {},
  nextBeliefNo: 1,
  missions: {},
  offers: null,
  nextMissionNo: 1,
  runStartedAt: START_TIME,
  serviceSince: null,
  chiefVisitDay: null,
  runStartZone: null,
  nameSwaps: {},
  deeds: {},
  deedKnowledge: {},
  relations: {},
  perceived: {},
  revealedSecrets: [],
  lastSpreadDay: null,
  nextDeedNo: 1,
  factions: {},
  parties: [],
  nextPartyNo: 0,
  partiesUpTo: 0,
  partySightings: {},
  partiesSeen: {},
  partyIntel: {},
  garrisonSeen: [],
  partyAlerts: [],
  partyFights: {},
  zones: {},
  clocks: {},
  lastWarDay: null,
  playerZone: null,
  preparations: {},
  pendingClashes: [],
  battle: null,
  nextBattleNo: 1,
  flags: {},
  storyletLog: {},
  activeStorylet: null,
  lastStoryletAt: null,
  improvSlot: null,
  lastImprovSlotAt: null,
  lastActivity: null,
  lastWokeAt: null,
  lastSleptFrom: null,
  sleepLog: [],
  nervesSleepSpentAt: null,
  leftHomeAt: null,
  castUsedAt: {},
  spareIssuedAt: null,
  missedRationDay: null,
  lastFreedAt: null,
  regardGained: { day: -1, by: {} },
  regardLast: {},
  trustDroppedAt: {},
  trustDroppedWhy: {},
  disobedienceAt: {},
  helplessAt: null,
  recovery: { lastChangeAt: {}, lastHealerDay: {}, lastAidDay: {}, healerSnap: {}, aidSnap: {}, trackAt: {}, slowDay: {}, heldDay: {} },
  weather: null,
  forecast: null,
  recentClashes: [],
  remains: [],
  traps: [],
  vendettas: [],
  killsKnown: {},
  bounties: [],
  chronicle: [],
};

/** 최근 교전 기록에 남길 수 */
export const RECENT_CLASHES = 12;

/** 바닥 물건을 두는 자리: 구역, 장소가 있으면 구역#장소 (12-244) */
export function spotKey(zone: string, place: string | null): string {
  return place ? `${zone}#${place}` : zone;
}

/** 떠나는 자리에 바닥 물건을 두고, 가는 자리에 있던 것을 장면에 둔다 */
/** 두고 떠난 인물은 그 시간대가 끝날 때까지 그 자리에 머문다 (12-253, 공통 규칙 15). 끝난 머묾은 이때 치운다 */
function leaveBehind(next: GameState, ids: readonly string[], zone: string, place: string | null, now: number) {
  for (const [id, stay] of Object.entries(next.npcStays)) if (stay.until <= now) delete next.npcStays[id];
  const until = segmentEnd(now);
  for (const id of ids) {
    const c = next.characters[id];
    if (!c || c.dead || c.away || c.captive) continue;
    next.npcStays[id] = { zone, place, until };
  }
}

function swapGround(next: GameState, from: string | null, to: string) {
  // 가방 개체도 바닥을 따라간다 (공통 규칙 26)
  for (const b of Object.values(next.bags ?? {})) if (from !== null && b.at === SCENE_HOLDER) b.at = `ground:${from}`;
  for (const b of Object.values(next.bags ?? {})) if (b.at === `ground:${to}`) b.at = SCENE_HOLDER;
  const ground = { ...next.groundItems };
  if (from !== null && Object.keys(next.scene.items).length) ground[from] = { ...next.scene.items };
  else if (from !== null) delete ground[from];
  // 아직 구역이 없던 장면(세계를 막 만든 때)에 내려놓은 것은 처음 들어서는 구역의 바닥에 그대로 둔다
  // (12-265, PT18 튜토리얼: 세계 만들기에서 내려놓은 시작 짐 담요가 첫 이동에서 사라졌다)
  const carried = from === null ? next.scene.items : {};
  const items: Record<string, number> = { ...(ground[to] ?? {}) };
  for (const [id, n] of Object.entries(carried)) items[id] = (items[id] ?? 0) + n;
  next.scene = { ...next.scene, items };
  delete ground[to];
  next.groundItems = ground;
}

/** 본·전해 안 부대를 기록한다 (알리기, 12-327) */
function rememberParty(next: GameState, id: string, at: number, zone: string | null) {
  const p = next.parties.find((x) => x.id === id);
  if (!p) return;
  const plan = p.task.kind === "clash" || p.task.kind === "occupy" || p.task.kind === "watch" ? (p.task.plan ?? null) : null;
  next.partyIntel = { ...next.partyIntel, [id]: { faction: p.faction, kind: p.kind, goal: p.goal, plan, size: p.size, at, ...(zone ? { zone } : {}) } };
}

/** 주인공이 있는 구역의 주인이 그 자리에서 바뀌었으면 본 대로 안다 (PT32 졸병: 붉은 다리를 차지하는 것을 봤는데 떠난 뒤 지도는 "주인 없음") */
function seeHereOwner(next: GameState) {
  const zone = next.playerZone;
  if (!zone) return;
  const owner = next.zones[zone]?.owner ?? null;
  if ((next.zoneSeen[zone] ?? undefined) !== owner) next.zoneSeen = { ...next.zoneSeen, [zone]: owner };
}

function rememberClashes(next: GameState, clashes: readonly Clash[], at: number, party = false) {
  next.recentClashes.push(...clashes.map((clash) => ({ clash: structuredClone(clash), at, ...(party ? { party } : {}) })));
  next.recentClashes = next.recentClashes.slice(-RECENT_CLASHES);
}

export function applyEvent(state: GameState, event: GameEvent): GameState {
  if (event.type !== "world_created" && !state.worldId) {
    throw new Error(`세계가 만들어지기 전에 ${event.type} 이벤트를 적용할 수 없습니다.`);
  }
  // 바뀐 부분만 새로 만든다 (구조 공유, 기획서 11.6). 이전 상태는 그대로 남는다
  const out = produce(state, (next: GameState) => {
    const r = reduce(state, next, event) as GameState | undefined;
    // 가방 개체를 그 자리 물건 수에 맞춘다 (공통 규칙 26): 가방이 없어진 자리는 내용물을 쏟는다
    const target = r ?? next;
    if (target.bags && Object.keys(target.bags).length) syncBags(target);
    return r;
  });
  // 있어 본 장소는 안다 (설계 목록 C-1): 어떤 일로 옮겨졌든(걸어서·이야기·붙잡힘·잠입) 그 자리에 놓이면 기록한다.
  // 함께 있던 사람(동행·장면 사람)도 그곳을 안다: 그 사람을 이어받으면 아는 곳이다 (PT22 하얀매: 함께 간 병원을 계승한 동료가 몰랐다)
  if (!out.playerZone || !out.playerPlace || !out.playerId) return out;
  const key = `${out.playerZone}:${out.playerPlace}`;
  const who = [out.playerId, ...out.companions, ...out.scene.present].filter((id) => !(out.knownPlaces?.[id] ?? []).includes(key));
  if (!who.length) return out;
  return produce(out, (next: GameState) => {
    const known = { ...(next.knownPlaces ?? {}) };
    for (const id of who) known[id] = [...(known[id] ?? []), key];
    next.knownPlaces = known;
  });
}

function reduce(state: GameState, next: GameState, event: GameEvent): GameState | void {
  switch (event.type) {
    case "world_created": {
      if (state.worldId) throw new Error("세계가 이미 만들어졌습니다.");
      const characters: Record<string, Character> = { [event.player.id]: structuredClone(event.player) };
      for (const npc of event.npcs) {
        if (characters[npc.id]) throw new Error(`캐릭터 id 중복: ${npc.id}`);
        characters[npc.id] = structuredClone(npc);
      }
      const beliefCount = Object.values(event.beliefs).reduce((n, list) => n + list.length, 0);
      const created: GameState = {
        // 빈 상태의 안쪽 객체를 새 세계와 나누지 않는다 (구조 공유라 한쪽을 고치면 다른 세계에 샌다)
        ...structuredClone(EMPTY_STATE),
        scenarioId: event.scenarioId,
        worldId: event.worldId,
        worldSeed: event.worldSeed,
        roleId: event.roleId,
        scenarioRole: event.roleId,
        customRole: event.customRole ? structuredClone(event.customRole) : null,
        playerId: event.player.id,
        characters,
        beliefs: structuredClone(event.beliefs),
        known: structuredClone(event.known),
        met: structuredClone(event.known),
        nextBeliefNo: beliefCount + 1,
        nameSwaps: structuredClone(event.renames ?? {}),
      };
      // 처음부터 아는 사람들(같은 무리 동료)은 주인공도 이름까지 안다
      for (const id of event.known[event.player.id] ?? []) acquaint(created, id, event.player.id, true);
      for (const id of event.perceived ?? []) if (created.characters[id]) perceive(created, id);
      return created;
    }
    case "npc_departed": {
      next.companions = next.companions.filter((id) => id !== event.npcId);
      delete next.bonds[event.npcId];
      const npc = mustGet(next.characters, event.npcId, "캐릭터");
      if (event.toFaction !== null) npc.factionId = event.toFaction;
      else npc.away = true;
      next.scene.present = next.scene.present.filter((id) => id !== event.npcId);
      return next;
    }
    case "player_admitted":
      next.admission = { factionId: event.factionId, ...(event.rank ? { rank: event.rank } : {}), ...(event.title ? { title: event.title } : {}), ...(event.post ? { post: event.post } : {}), ...(event.graceDays ? { graceDays: event.graceDays } : {}), since: state.time, offerAt: event.offerAt, offers: 0 };
      return next;
    case "chief_visited":
      next.chiefVisitDay = event.day;
      return next;
    case "admission_deferred":
      if (next.admission) next.admission = { ...next.admission, offerAt: event.offerAt, offers: next.admission.offers + 1 };
      return next;
    case "player_joined_faction": {
      const player = mustGet(next.characters, next.playerId, "캐릭터");
      if (player.factionId === event.factionId) throw new Error("이미 그 무리에 속해 있습니다.");
      player.factionId = event.factionId;
      player.rank = event.rank;
      // 들어간 자리의 직분 (12-309): 직분이 바뀌면 평판은 새로 쌓는다
      if (event.role.occupation && player.occupation?.id !== event.role.occupation) player.occupation = { id: event.role.occupation, standing: 0 };
      next.missionGraceUntil = event.graceUntil ?? null;
      next.serviceSince = state.time;
      next.admission = null;
      next.roleId = event.role.id;
      next.customRole = structuredClone(event.role);
      // 옛 분대·회의는 옛 무리의 것이다
      next.squadOrders = {};
      next.squadReports = {};
      next.squad = null;
      next.promotionOffer = null;
      next.council = {};
      // 무리 사람들과 서로 이름을 안다 (같은 무리 동료, 기획서 6.3)
      for (const id of event.role.known_npcs) {
        acquaint(next, next.playerId, id, true);
        acquaint(next, id, next.playerId, true);
      }
      next.beliefs[next.playerId] = [...(next.beliefs[next.playerId] ?? []), ...structuredClone(event.beliefs)];
      next.nextBeliefNo += event.beliefs.length;
      return next;
    }
    case "pact_made":
      if (event.kind === "truce" && event.until !== undefined && event.restore) {
        next.pacts.push({ id: event.id, kind: "truce", a: event.a, b: event.b, until: event.until, restore: event.restore });
      }
      return next;
    case "pact_ended":
      next.pacts = next.pacts.filter((p) => p.id !== event.id);
      return next;
    case "negotiation_refused":
      next.negotiationBlocked[event.factionId] = event.until;
      return next;
    case "faction_disposition_changed": {
      const f = next.factions[event.from];
      if (!f) return next;
      f.disposition = { ...(f.disposition ?? {}), [event.to]: event.value };
      return next;
    }
    case "faction_population_changed": {
      const f = mustGet(next.factions, event.factionId, "세력");
      f.population = Math.max(0, f.population + event.delta);
      // 떠난 사람만큼 싸울 사람도 준다
      if (event.delta < 0) f.combatants = Math.min(f.combatants, f.population);
      break;
    }
    case "faction_resource_changed": {
      const f = next.factions[event.factionId];
      if (!f) return next;
      f.resources[event.resource] = Math.max(0, (f.resources[event.resource] ?? 0) + event.delta);
      return next;
    }
    case "npc_captured": {
      next.companions = next.companions.filter((id) => id !== event.npcId);
      delete next.bonds[event.npcId];
      const npc = mustGet(next.characters, event.npcId, "캐릭터");
      npc.captive = { by: event.by, zone: event.zone };
      next.scene.present = next.scene.present.filter((id) => id !== event.npcId);
      return next;
    }
    case "ties_generated":
      next.dynamicTies = [...next.dynamicTies, ...structuredClone(event.ties)];
      return next;
    case "extra_promoted": {
      const c = mustGet(next.characters, event.characterId, "캐릭터");
      c.profile = structuredClone(event.profile);
      next.dynamicTies = [...next.dynamicTies, ...structuredClone(event.ties)];
      return next;
    }
    case "item_equipped": {
      const c = mustGet(next.characters, event.characterId, "캐릭터");
      c.equipped = { ...c.equipped, [event.slot]: event.itemId };
      // 등 칸: 멘 가방 개체 (공통 규칙 26)
      if (event.slot === "back") {
        for (const b of Object.values(next.bags)) if (b.at === c.id && b.worn) b.worn = false;
        if (event.bagId) {
          const b = next.bags[event.bagId];
          if (!b || b.at !== c.id || b.item !== event.itemId) throw new Error(`멜 수 없는 가방: ${event.bagId}`);
          b.worn = true;
        }
      }
      return next;
    }
    case "bag_packed": {
      const c = mustGet(next.characters, event.characterId, "캐릭터");
      let bag = next.bags[event.bagId];
      if (!bag) {
        const have = c.inventory[event.bagItem] ?? 0;
        const used = Object.values(next.bags).filter((b) => b.at === c.id && b.item === event.bagItem).length;
        if (have <= used) throw new Error(`빈 가방이 없다: ${event.bagItem}`);
        bag = next.bags[event.bagId] = { item: event.bagItem, at: c.id, contents: {}, ...(event.worn ? { worn: true } : {}) };
        next.bagSeq = (next.bagSeq ?? 0) + 1;
      }
      if (bag.at !== c.id) throw new Error(`지닌 가방이 아니다: ${event.bagId}`);
      const [from, to] = event.direction === "pack" ? [c.inventory, bag.contents] : [bag.contents, c.inventory];
      const left = (from[event.itemId] ?? 0) - event.quantity;
      if (left < 0) throw new Error(`수량 부족: ${event.itemId} (${event.direction})`);
      if (left === 0) delete from[event.itemId];
      else from[event.itemId] = left;
      to[event.itemId] = (to[event.itemId] ?? 0) + event.quantity;
      for (const slot of ["weapon", "body", "head", "arms", "outer", "back"] as const) if (c.equipped?.[slot] === event.itemId && !c.inventory[event.itemId]) c.equipped = { ...c.equipped, [slot]: null };
      return next;
    }
    case "item_worn": {
      const c = mustGet(next.characters, event.characterId, "캐릭터");
      const now = Math.max(0, (c.wear[event.itemId] ?? 0) + event.delta);
      if (now === 0) delete c.wear[event.itemId];
      else c.wear[event.itemId] = now;
      return next;
    }
    case "item_broken": {
      const c = mustGet(next.characters, event.characterId, "캐릭터");
      pullFromBags(next, c.id, event.itemId, 1);
      const have = c.inventory[event.itemId] ?? 0;
      if (have <= 1) delete c.inventory[event.itemId];
      else c.inventory[event.itemId] = have - 1;
      delete c.wear[event.itemId];
      if (event.into) c.inventory[event.into] = (c.inventory[event.into] ?? 0) + 1;
      for (const slot of ["weapon", "body", "head", "arms", "outer", "back"] as const) if (c.equipped[slot] === event.itemId && !c.inventory[event.itemId]) c.equipped = { ...c.equipped, [slot]: null };
      return next;
    }
    case "check_cost_paid":
      mustGet(next.checks, event.checkId, "판정").harmApplied = true;
      if (event.timeDay !== undefined) next.timeCostDay = event.timeDay;
      return next;
    case "check_harm_dealt": {
      const check = mustGet(next.checks, event.checkId, "판정");
      check.dealt = { ...(check.dealt ?? {}), [event.targetId]: (check.dealt?.[event.targetId] ?? 0) + event.steps };
      return next;
    }
    case "mission_spotted": {
      const m = next.missions[event.missionId];
      if (m) m.spotted = true;
      return next;
    }
    case "returned_home":
      next.leftHomeAt = null;
      return next;
    case "armory_spare_issued":
      next.spareIssuedAt = state.time;
      return next;
    case "ration_missed":
      next.missedRationDay = event.day;
      return next;
    case "captive_watch_raised": {
      const me = mustGet(next.characters, next.playerId, "캐릭터");
      // 감시는 -3까지 (플레이 테스트 13 뒤 정한 것). 대신 갇힌 동안 이야기로 빠져나갈 틈이 온다 (cp_gap)
      if (me.captive) me.captive = { ...me.captive, watch: Math.min(3, (me.captive.watch ?? 0) + 1) };
      return next;
    }
    case "swarm_set":
      next.swarms = { ...next.swarms, [event.zone]: { day: event.day, at: event.at, done: event.done, ...(event.met ? { met: true } : {}) } };
      return next;
    case "noise_made": {
      const prev = next.zoneNoise[event.zone];
      next.zoneNoise[event.zone] = { day: event.day, level: (prev && prev.day === event.day ? prev.level : 0) + event.level };
      return next;
    }
    case "cargo_set": {
      const cargo = { ...(next.cargo ?? {}) };
      if (Object.keys(event.items).length) cargo[event.missionId] = { ...event.items };
      else delete cargo[event.missionId];
      next.cargo = cargo;
      return next;
    }
    case "armory_issued": {
      const me = mustGet(next.characters, next.playerId, "캐릭터");
      for (const [item, qty] of Object.entries(event.items)) me.inventory[item] = (me.inventory[item] ?? 0) + qty;
      next.loans[event.missionId] = { ...event.items };
      const f = next.factions[event.factionId];
      if (f && event.cost > 0) f.resources[event.resource] = Math.max(0, (f.resources[event.resource] ?? 0) - event.cost);
      return next;
    }
    case "armory_returned": {
      const me = mustGet(next.characters, next.playerId, "캐릭터");
      for (const [item, qty] of Object.entries(event.returned)) {
        const left = (me.inventory[item] ?? 0) - qty;
        if (left > 0) me.inventory[item] = left;
        else delete me.inventory[item];
      }
      delete next.loans[event.missionId];
      return next;
    }
    case "merchant_restocked": {
      const c = mustGet(next.characters, event.npcId, "캐릭터");
      for (const [item, qty] of Object.entries(event.items)) c.inventory[item] = (c.inventory[item] ?? 0) + qty;
      next.restockedDay[event.npcId] = event.day;
      return next;
    }
    case "unlock_earned":
      if (!next.unlocked.includes(event.id)) next.unlocked = [...next.unlocked, event.id];
      return next;
    case "scenario_cleared":
      if (!next.cleared.includes(event.roleId)) next.cleared = [...next.cleared, event.roleId];
      return next;
    case "helpless_resolved":
      next.helplessAt = state.time;
      break;
    case "helpless_cleared":
      next.helplessAt = null;
      break;
    case "nerves_sleep_spent":
      next.nervesSleepSpentAt = state.time;
      break;
    case "track_clock_reset":
      next.recovery.trackAt = { ...next.recovery.trackAt, [`${event.characterId}:${event.track}`]: state.time };
      break;
    case "family_set":
      next.family = [...event.ids];
      return next;
    case "tie_revealed":
      if (!next.revealedTies.includes(event.key)) next.revealedTies = [...next.revealedTies, event.key];
      return next;
    case "companion_joined": {
      if (!next.companions.includes(event.characterId)) next.companions.push(event.characterId);
      if (!next.scene.present.includes(event.characterId)) next.scene.present.push(event.characterId);
      if (event.kind) {
        next.bonds[event.characterId] = {
          kind: event.kind,
          since: state.time,
          ...(event.missionId ? { missionId: event.missionId } : {}),
          ...(event.until ? { until: event.until } : {}),
        };
      }
      return next;
    }
    case "companion_left": {
      next.companions = next.companions.filter((id) => id !== event.characterId);
      delete next.bonds[event.characterId];
      // 자기 자리로 돌아가 옷을 갈아입는다 (플레이 테스트 12: 동행이던 사람의 젖은 옷이 이틀 넘게 마르지 않았다)
      if (next.wet?.[event.characterId]) {
        next.wet = { ...next.wet };
        delete next.wet[event.characterId];
      }
      return next;
    }
    case "companion_parted": {
      next.companions = next.companions.filter((id) => id !== event.characterId);
      next.scene.present = next.scene.present.filter((id) => id !== event.characterId);
      const bond = next.bonds[event.characterId];
      if (bond) bond.apart = { zone: event.zone, until: event.until, since: state.time, left: false, ...(event.place !== undefined ? { place: event.place } : {}) };
      return next;
    }
    case "companion_rejoined": {
      if (!next.companions.includes(event.characterId)) next.companions.push(event.characterId);
      if (!next.scene.present.includes(event.characterId)) next.scene.present.push(event.characterId);
      const bond = next.bonds[event.characterId];
      if (bond) delete bond.apart;
      return next;
    }
    case "companion_crossroads": {
      const bond = next.bonds[event.characterId];
      if (bond) bond.crossroads = { lean: event.lean, decideBy: event.decideBy };
      return next;
    }
    case "companion_bond_changed": {
      const bond = next.bonds[event.characterId];
      if (!bond) return next;
      bond.kind = event.kind;
      delete bond.crossroads;
      if (event.until) bond.until = event.until;
      else delete bond.until;
      return next;
    }
    case "squad_order_given": {
      next.squadOrders[event.npcId] = { task: event.task, zone: event.zone, startedAt: state.time, until: event.until };
      next.companions = next.companions.filter((id) => id !== event.npcId);
      delete next.bonds[event.npcId];
      next.scene.present = next.scene.present.filter((id) => id !== event.npcId);
      return next;
    }
    case "squad_order_refused":
      return next;
    case "squad_order_done": {
      delete next.squadOrders[event.npcId];
      next.squadReports[event.npcId] = { text: event.report, at: state.time };
      // 돌아와 보고하는 것은 얼굴을 보는 일이다: 보고로 바뀐 마음이 ?인물에도 보인다 (12-257, PT15 분대장)
      if (event.outcome !== null && next.characters[event.npcId] && !next.characters[event.npcId]!.dead) perceive(next, event.npcId);
      return next;
    }
    case "gift_welcomed":
      next.giftWelcomedDay = { ...next.giftWelcomedDay, [event.npcId]: event.day };
      return next;
    case "council_proposed": {
      next.council[event.topic] = { day: event.day, blockedUntil: event.blockedUntil };
      return next;
    }
    case "faction_policy_set": {
      const f = next.factions[event.factionId];
      if (!f) return next;
      f.policy = { ...(f.policy ?? {}), [event.topic]: event.option };
      return next;
    }
    case "debt_changed": {
      const c = mustGet(next.characters, event.characterId, "캐릭터");
      const now = Math.max(0, (c.debts[event.factionId] ?? 0) + event.delta);
      if (now === 0) delete c.debts[event.factionId];
      else c.debts[event.factionId] = now;
      return next;
    }
    case "npc_released": {
      const npc = mustGet(next.characters, event.npcId, "캐릭터");
      npc.captive = null;
      next.scene.present = next.scene.present.filter((id) => id !== event.npcId);
      return next;
    }
    case "romance_changed": {
      const key = [event.a, event.b].sort().join("|");
      next.romances[key] = { a: event.a, b: event.b, stage: event.stage, since: state.time };
      return next;
    }
    case "romance_jealousy":
      return next;
    case "flirted":
      next.flirtDay[event.target] = event.day;
      return next;
    case "memo_written":
      next.memos = { ...next.memos, [event.characterId]: event.text };
      return next;
    case "portrait_chosen": {
      const who = next.characters[event.characterId];
      if (!who) throw new Error(`알 수 없는 캐릭터: ${event.characterId}`);
      next.characters = { ...next.characters, [who.id]: { ...who, portrait: event.portrait } };
      return next;
    }
    case "item_stashed": {
      const holder = next.characters[event.characterId];
      if (!holder) throw new Error(`알 수 없는 캐릭터: ${event.characterId}`);
      if (event.direction === "put") pullFromBags(next, holder.id, event.itemId, event.quantity);
      const stashKey = `stash:${event.characterId}:${event.zone}`;
      if (event.direction === "put") moveBags(next, holder.id, stashKey, event.itemId, event.quantity, holder.inventory[event.itemId] ?? 0, event.bagId);
      else moveBags(next, stashKey, holder.id, event.itemId, event.quantity, next.stashes[event.characterId]?.[event.zone]?.[event.itemId] ?? 0, event.bagId);
      const places = { ...(next.stashes[event.characterId] ?? {}) };
      const box = { ...(places[event.zone] ?? {}) };
      const [from, to] = event.direction === "put" ? [holder.inventory, box] : [box, holder.inventory];
      const left = (from[event.itemId] ?? 0) - event.quantity;
      if (left < 0) throw new Error(`수량 부족: ${event.characterId}의 ${event.itemId} (${event.direction})`);
      if (left === 0) delete from[event.itemId];
      else from[event.itemId] = left;
      to[event.itemId] = (to[event.itemId] ?? 0) + event.quantity;
      if (Object.keys(box).length) places[event.zone] = box;
      else delete places[event.zone];
      next.stashes = { ...next.stashes, [event.characterId]: places };
      return next;
    }
    case "home_settled":
      next.homes = { ...next.homes, [event.characterId]: event.zone };
      return next;
    case "infiltration_started":
      next.infiltration = { zone: event.zone, owner: event.owner, goal: event.goal, depth: 0, alarm: 0, done: false, since: state.time };
      return next;
    case "infiltration_changed":
      if (next.infiltration) next.infiltration = { ...next.infiltration, depth: event.depth, alarm: event.alarm, done: event.done, ...(event.goal ? { goal: event.goal } : {}) };
      return next;
    case "infiltration_ended":
      next.infiltration = null;
      return next;
    case "face_known": {
      const had = next.met[event.characterId] ?? [];
      if (!had.includes(event.targetId)) next.met = { ...next.met, [event.characterId]: [...had, event.targetId] };
      return next;
    }
    case "disaster_scheduled":
      next.disaster = { kind: event.kind, zone: event.zone, faction: event.faction, day: event.day, phase: "omen", until: event.day, prepared: 0 };
      return next;
    case "disaster_prepared":
      if (next.disaster) next.disaster = { ...next.disaster, prepared: next.disaster.prepared + 1 };
      return next;
    case "disaster_struck": {
      const d = next.disaster;
      if (!d) return next;
      next.disaster = { ...d, phase: "struck", until: event.until };
      next.lastDisasterDay = d.day;
      for (const z of event.stall) if (next.zones[z]) next.zones[z] = { ...next.zones[z]!, stalledUntil: event.until };
      if (event.collapsed && d.zone && next.zones[d.zone]) next.zones[d.zone] = { ...next.zones[d.zone]!, owner: null };
      return next;
    }
    case "disaster_ended":
      next.disaster = null;
      return next;
    case "agenda_filled": {
      const at = next.agendas?.[event.npcId] ?? { index: 0, filled: 0 };
      next.agendas = { ...(next.agendas ?? {}), [event.npcId]: { index: at.index, filled: Math.max(0, at.filled + event.delta) } };
      return next;
    }
    case "agenda_finished": {
      const at = next.agendas?.[event.npcId] ?? { index: 0, filled: 0 };
      next.agendas = { ...(next.agendas ?? {}), [event.npcId]: { index: at.index + 1, filled: 0 } };
      return next;
    }
    case "facility_built": {
      if (next.wrecked[event.zone]?.includes(event.facility)) next.wrecked = { ...next.wrecked, [event.zone]: next.wrecked[event.zone]!.filter((x) => x !== event.facility) };
      const had = next.facilities?.[event.zone] ?? [];
      if (!had.includes(event.facility)) next.facilities = { ...(next.facilities ?? {}), [event.zone]: [...had, event.facility] };
      return next;
    }
    case "facility_broken":
      next.facilities = { ...(next.facilities ?? {}), [event.zone]: (next.facilities?.[event.zone] ?? []).filter((x) => x !== event.facility) };
      next.wrecked = { ...next.wrecked, [event.zone]: [...(next.wrecked[event.zone] ?? []).filter((x) => x !== event.facility), event.facility] };
      return next;
    case "wounded_arrived":
      next.wounded = [...next.wounded, ...event.ids.map((id) => ({ id, faction: event.faction, zone: event.zone, at: state.time }))];
      return next;
    case "wounded_settled": {
      const w = next.wounded.find((x) => x.id === event.id);
      next.wounded = next.wounded.filter((x) => x.id !== event.id);
      const f = w ? next.factions[w.faction] : undefined;
      if (f && event.outcome !== "died") {
        f.population += 1;
        if (event.outcome === "recovered") f.combatants += 1;
      }
      const c = next.characters[event.id];
      if (c && event.outcome !== "died") c.away = true;
      next.scene.present = next.scene.present.filter((id) => id !== event.id);
      return next;
    }
    case "resolve_set":
      next.resolves = { ...(next.resolves ?? {}), [event.characterId]: { ...event.resolve } };
      next.resolveNote = null;
      return next;
    case "resolve_ended": {
      const r = next.resolves?.[event.characterId];
      if (r) next.resolveLog = [...(next.resolveLog ?? []), { characterId: event.characterId, text: event.text ?? r.text, outcome: event.outcome, at: state.time, note: next.resolveNote ?? null }];
      next.resolves = { ...(next.resolves ?? {}), [event.characterId]: null };
      next.resolveNote = null;
      return next;
    }
    case "resolve_involved": {
      const r = next.resolves?.[event.characterId];
      if (r) next.resolves = { ...next.resolves, [event.characterId]: { ...r, involved: true } };
      return next;
    }
    case "resolve_stepped": {
      const r = next.resolves?.[event.characterId];
      if (r) next.resolves = { ...next.resolves, [event.characterId]: { ...r, stage: (r.stage ?? 0) + 1, step: event.text } };
      return next;
    }
    case "resolve_tracked": {
      const r = next.resolves?.[event.characterId];
      if (r) next.resolves = { ...next.resolves, [event.characterId]: { ...r, ...(event.day !== undefined ? { autoDay: event.day } : {}), ...(event.mark !== undefined ? { mark: event.mark } : {}) } };
      return next;
    }
    case "resolve_note":
      next.resolveNote = event.note;
      return next;
    case "saga_opened":
      next.sagas = {
        ...(next.sagas ?? {}),
        [event.sagaId]: { act: "open", openedAt: state.time, actStartedAt: state.time, days: null, ending: null, endedAt: null, endedByLapse: false, note: null, noteZone: null, marked: null, lapsed: [], engaged: [], scenes: [], notedFlags: [] },
      };
      return next;
    case "saga_advanced": {
      const g = next.sagas?.[event.sagaId];
      if (g) next.sagas = { ...next.sagas, [event.sagaId]: { ...g, act: event.act, actStartedAt: state.time, days: event.days, lapsed: event.lapsed ? [...g.lapsed, g.act] : g.lapsed } };
      return next;
    }
    case "saga_ended": {
      const g = next.sagas?.[event.sagaId];
      if (g) next.sagas = { ...next.sagas, [event.sagaId]: { ...g, act: "ended", ending: event.ending, endedAt: state.time, endedByLapse: event.lapsed, days: null, lapsed: event.lapsed ? [...g.lapsed, g.act] : g.lapsed } };
      return next;
    }
    case "saga_noted": {
      const g = next.sagas?.[event.sagaId];
      if (g) next.sagas = { ...next.sagas, [event.sagaId]: { ...g, note: event.text, noteZone: event.zone, notedFlags: event.flag ? [...g.notedFlags, event.flag] : g.notedFlags } };
      return next;
    }
    case "saga_marked": {
      const g = next.sagas?.[event.sagaId];
      if (g) next.sagas = { ...next.sagas, [event.sagaId]: { ...g, marked: event.characterId } };
      return next;
    }
    case "saga_engaged": {
      const g = next.sagas?.[event.sagaId];
      if (g && !g.engaged.includes(event.characterId)) next.sagas = { ...next.sagas, [event.sagaId]: { ...g, engaged: [...g.engaged, event.characterId] } };
      return next;
    }
    case "npc_arrived": {
      const c = next.characters[event.npcId];
      if (c && !c.dead) c.away = false;
      return next;
    }
    case "saga_scene": {
      const g = next.sagas?.[event.sagaId];
      if (g) next.sagas = { ...next.sagas, [event.sagaId]: { ...g, scenes: [...g.scenes, event.line].slice(-3) } };
      return next;
    }
    case "resolve_seeded":
      if (!(next.resolveSeeded ?? []).includes(event.characterId)) next.resolveSeeded = [...(next.resolveSeeded ?? []), event.characterId];
      return next;
    case "ruin_found": {
      // 곁의 동행·장면 사람도 함께 찾았다 (PT22 하얀매: 이어받은 동료가 함께 찾은 지하 약제실을 몰랐다)
      const found = { ...(next.ruinsFound ?? {}) };
      for (const id of [event.characterId, ...(event.characterId === state.playerId ? [...state.companions, ...state.scene.present] : [])]) {
        const had = found[id] ?? [];
        if (!had.includes(event.ruin)) found[id] = [...had, event.ruin];
      }
      next.ruinsFound = found;
      return next;
    }
    case "exploration_started":
      next.exploration = { ruin: event.ruin, depth: 0, noise: 0, searched: [], since: state.time };
      return next;
    case "exploration_changed":
      if (next.exploration) next.exploration = { ...next.exploration, depth: event.depth, noise: event.noise, searched: [...event.searched] };
      return next;
    case "exploration_ended":
      next.exploration = null;
      return next;
    case "promise_made": {
      // 예전 세이브: 받은 부탁(f_N)에서 맺은 약속이면 부탁 자리를 지우고 콘텐츠 id를 옮긴다
      const legacy = event.favor ? (next.promises ?? []).find((p) => p.id === event.favor) : undefined;
      const rest = legacy ? (next.promises ?? []).filter((p) => p !== legacy) : (next.promises ?? []);
      next.promises = [...rest, { id: event.id, by: event.by, to: event.to, what: event.what, due: event.due, item: event.item, made: state.time, status: "open", favor: legacy ? legacy.favor : (event.favor ?? null), quest: null }];
      return next;
    }
    case "promise_asked":
      next.promises = [...(next.promises ?? []), { id: event.id, by: event.by, to: event.to, what: event.what, due: event.due, item: event.item, made: state.time, status: "asked", favor: event.favor, quest: null }];
      return next;
    case "request_offered":
      next.promises = [...(next.promises ?? []), { id: event.id, by: event.by, to: event.to, what: event.what, due: event.due, item: event.item, made: state.time, status: "asked", favor: null, quest: structuredClone(event.quest) }];
      break;
    case "request_accepted":
      next.promises = (next.promises ?? []).map((p) => (p.id === event.id && p.status === "asked" && p.quest ? { ...p, status: "open", due: event.due, made: state.time, quest: { ...p.quest, target: event.target } } : p));
      break;
    case "request_delivered":
      next.promises = (next.promises ?? []).map((p) => (p.id === event.id && p.quest ? { ...p, quest: { ...p.quest, delivered: (p.quest.delivered ?? 0) + event.quantity } } : p));
      break;
    case "extra_rehomed": {
      const c = mustGet(next.characters, event.characterId, "캐릭터");
      if (c.extra) c.extra = { ...c.extra, zone: event.zone, place: event.place };
      break;
    }
    case "promise_accepted":
      next.promises = (next.promises ?? []).map((p) => (p.id === event.id && p.status === "asked" ? { ...p, status: "open", what: event.what, due: event.due, item: event.item, made: state.time } : p));
      return next;
    case "favor_offered":
      next.promises = [...(next.promises ?? []), { id: event.id, by: state.playerId, to: event.npc, what: "", due: 0, item: null, made: state.time, status: "asked", favor: event.favor, quest: null }];
      return next;
    case "favor_settled":
      // 받은 것(accepted)은 뒤따르는 promise_made가 옮긴다. 지키고 어긴 것은 약속 쪽에 이미 남는다
      if (event.status === "declined" || event.status === "lapsed") {
        const status = event.status;
        next.promises = (next.promises ?? []).map((p) => (p.id === event.id ? { ...p, status } : p));
      }
      return next;
    case "reward_given":
      next.rewardsGiven = { ...(next.rewardsGiven ?? {}), [event.characterId]: (next.rewardsGiven?.[event.characterId] ?? 0) + 1 };
      return next;
    case "trick_trained": {
      const had = next.tricks?.[event.animalId] ?? { learned: [], half: [], lastDay: 0 };
      const learned = event.result === "learned" && !had.learned.includes(event.trick) ? [...had.learned, event.trick] : had.learned;
      const half = event.result === "half" ? [...new Set([...had.half, event.trick])] : event.result === "learned" ? had.half.filter((t) => t !== event.trick) : had.half;
      next.tricks = { ...(next.tricks ?? {}), [event.animalId]: { learned, half, lastDay: event.day } };
      return next;
    }
    case "radio_broadcast":
      next.lastBroadcastDay = event.day;
      return next;
    case "ambush_changed":
      next.ambush = event.ambush ? { ...event.ambush } : null;
      return next;
    case "off_balance_changed":
      next.offBalanceUntil = event.until;
      return next;
    case "ambushed_changed":
      next.ambushed = event.until === null ? null : { until: event.until };
      return next;
    case "confusion_changed": {
      const rest = (next.confused ?? []).filter((id) => id !== event.characterId);
      next.confused = event.on ? [...rest, event.characterId] : rest;
      return next;
    }
    case "promise_settled":
      next.promises = (next.promises ?? []).map((p) => (p.id === event.id ? { ...p, status: event.status } : p));
      return next;
    case "bribe_taken":
      next.bribes = [...next.bribes, { npcId: event.npcId, by: event.by, favor: event.favor, at: state.time }];
      return next;
    case "blackmailed": {
      const rest = next.blackmails.filter((b) => !(b.npcId === event.npcId && b.by === event.by));
      const was = next.blackmails.find((b) => b.npcId === event.npcId && b.by === event.by);
      next.blackmails = [...rest, { npcId: event.npcId, by: event.by, leverage: event.leverage, at: state.time, grudge: event.grudge || !!was?.grudge }];
      return next;
    }
    case "blackmail_ended":
      next.blackmails = next.blackmails.filter((b) => !(b.npcId === event.npcId && b.by === event.by));
      next.exposed = [...next.exposed, ...event.keys.map((k) => `${event.by}|${event.npcId}:${k}`).filter((k) => !next.exposed.includes(k))];
      return next;
    case "leverage_exposed":
      if (!next.exposed.includes(`${event.by}|${event.key}`)) next.exposed = [...next.exposed, `${event.by}|${event.key}`];
      return next;
    case "stash_inherited": {
      const from = next.stashes[event.from] ?? {};
      const places = { ...(next.stashes[event.to] ?? {}) };
      for (const [zone, items] of Object.entries(from)) {
        const box = { ...(places[zone] ?? {}) };
        for (const [item, n] of Object.entries(items)) box[item] = (box[item] ?? 0) + n;
        places[zone] = box;
      }
      const rest = { ...next.stashes, [event.to]: places };
      delete rest[event.from];
      next.stashes = rest;
      for (const b of Object.values(next.bags)) if (b.at.startsWith(`stash:${event.from}:`)) b.at = `stash:${event.to}:${b.at.slice(`stash:${event.from}:`.length)}`;
      return next;
    }
    case "stash_hinted":
      if (!next.stashHinted.includes(event.characterId)) next.stashHinted = [...next.stashHinted, event.characterId];
      return next;
    case "fear_exposed":
      // 예전 세이브의 노출 (12-95, 12-185에 둔감해짐을 뺐다). 읽기만 하고 무시한다
      return next;
    case "fatigue_load_set":
      next.fatigueLoad = { ...next.fatigueLoad, [event.characterId]: event.load };
      return next;
    case "soaked":
      // 예전 세이브 (12-121): 시간이 남은 젖음은 불 곁 두 시간으로 옮긴다
      if (event.until > state.time) next.wet = { ...next.wet, [event.characterId]: 120 };
      else {
        const { [event.characterId]: _, ...rest } = next.wet;
        next.wet = rest;
      }
      return next;
    case "wet_set": {
      const { [event.characterId]: _, ...rest } = next.wet;
      next.wet = event.left > 0 ? { ...rest, [event.characterId]: event.left } : rest;
      return next;
    }
    case "cold_load_set":
      next.coldLoad = { ...next.coldLoad, [event.characterId]: event.load };
      return next;
    case "fire_lit":
      next.fires = { ...next.fires, [event.zone]: Math.max(next.fires[event.zone] ?? 0, event.until) };
      return next;
    case "content_options_set":
      next.options = {
        ...next.options,
        ...(event.mature !== undefined ? { mature: event.mature } : {}),
        ...(event.dialogue !== undefined ? { dialogue: event.dialogue } : {}),
      };
      return next;
    case "player_captured": {
      const me = mustGet(next.characters, next.playerId, "캐릭터");
      me.captive = { by: event.by, zone: event.zone, since: state.time, ...(event.quarantine ? { quarantine: true } : {}), ...(event.releaseAt !== undefined ? { releaseAt: event.releaseAt } : {}) };
      for (const [item, n] of Object.entries(event.held)) {
        const left = (me.inventory[item] ?? 0) - n;
        if (left < 0) throw new Error(`빼앗을 것이 모자란다: ${item}`);
        if (left === 0) delete me.inventory[item];
        else me.inventory[item] = left;
        for (const slot of ["weapon", "body", "head", "arms", "outer", "back"] as const) if (me.equipped?.[slot] === item && !me.inventory[item]) me.equipped = { ...me.equipped, [slot]: null };
      }
      next.deposits[`held:${event.by}`] = { ...(next.deposits[`held:${event.by}`] ?? {}), ...event.held };
      // 갇힌 곳으로 끌려간다. 동행은 따라오지 못한다 (그 자리에서 기다린다)
      // 바닥의 물건은 붙잡힌 자리에 남는다 (PT14 방문자: 물류창고에 던진 쇠지렛대가 거점 감방까지 "장면에 놓인 물건"으로 따라왔다)
      const place = event.place !== undefined ? event.place : event.zone === state.playerZone ? state.playerPlace : null;
      if (state.playerZone) swapGround(next, spotKey(state.playerZone, state.playerPlace), spotKey(event.zone, place));
      next.playerZone = event.zone;
      next.playerPlace = place;
      next.scene.present = [];
      return next;
    }
    case "secret_told": {
      const known = next.secretKnownBy?.[event.owner] ?? [];
      next.secretKnownBy = { ...(next.secretKnownBy ?? {}), [event.owner]: [...known, ...event.to.filter((id) => !known.includes(id))] };
      return next;
    }
    case "setting_rolled":
      next.settingRolls = { ...(next.settingRolls ?? {}), [event.setting]: { spot: event.spot, at: state.time, won: event.won, turn: state.turn } };
      return next;
    case "npc_spared":
      next.sparedOnce = [...(next.sparedOnce ?? []), event.npcId];
      return next;
    case "infection_exposed":
      next.exposedAt = { ...(next.exposedAt ?? {}), [event.characterId]: state.time };
      return next;
    case "player_released": {
      const me = mustGet(next.characters, next.playerId, "캐릭터");
      const key = me.captive ? `held:${me.captive.by}` : null;
      if (event.returned && key && next.deposits[key]) {
        for (const [item, n] of Object.entries(next.deposits[key]!)) me.inventory[item] = (me.inventory[item] ?? 0) + n;
      }
      if (key) delete next.deposits[key];
      // 격리가 끝나면 그 상처로 다시 격리하지 않는다 (12-238)
      if (me.captive?.quarantine && next.exposedAt?.[me.id] !== undefined) {
        const exposed = { ...next.exposedAt };
        delete exposed[me.id];
        next.exposedAt = exposed;
      }
      me.captive = null;
      next.lastFreedAt = state.time;
      // 갇혀 있는 동안 같은 구역에서 기다리던 동행은 풀려나면 바로 합류한다 (플레이 테스트 13)
      for (const b of Object.values(next.bonds ?? {})) if (b.apart && b.apart.left === false) b.apart = { ...b.apart, left: true };
      // 동물 동행은 주인공이 빠져나가면 반나절 안에 스스로 찾아온다 (플레이 테스트 13: 개를 데리러 같은 적 땅을 세 번 드나들었다)
      if (!event.returned) for (const b of Object.values(next.bonds ?? {})) if (b.apart && b.kind === "animal") b.apart = { ...b.apart, until: state.time + ANIMAL_FIND_MINUTES };
      return next;
    }
    case "prisoner_labor": {
      const c = mustGet(next.characters, event.npcId, "캐릭터");
      if (c.captive) c.captive = { ...c.captive, labor: event.labor };
      return next;
    }
    case "items_deposited": {
      const me = mustGet(next.characters, next.playerId, "캐릭터");
      const box = (next.deposits[event.zone] ??= {});
      for (const [item, n] of Object.entries(event.items)) {
        pullFromBags(next, me.id, item, n);
        const have = me.inventory[item] ?? 0;
        if (have < n) throw new Error(`맡길 것이 모자란다: ${item}`);
        if (have === n) delete me.inventory[item];
        else me.inventory[item] = have - n;
        box[item] = (box[item] ?? 0) + n;
        for (const slot of ["weapon", "body", "head", "arms", "outer", "back"] as const) if (me.equipped?.[slot] === item && !me.inventory[item]) me.equipped = { ...me.equipped, [slot]: null };
      }
      return next;
    }
    case "zone_boosted": {
      const z = next.zones[event.zone];
      if (z) z.boost = { ...(z.boost ?? {}), [event.resource]: Math.max(0, (z.boost?.[event.resource] ?? 0) + event.delta) };
      return next;
    }
    case "skill_trained":
      mustGet(next.characters, event.characterId, "캐릭터").skills[event.skill] = event.to;
      if (next.lessons[event.skill] !== undefined) {
        next.lessons = { ...next.lessons };
        delete next.lessons[event.skill];
      }
      return next;
    case "skill_lesson":
      next.lessons = { ...next.lessons, [event.skill]: (state.lessons[event.skill] ?? 0) + event.hours };
      return next;
    case "zone_heard":
      next.zoneSeen = { ...next.zoneSeen, [event.zone]: event.owner };
      return next;
    case "zone_fortified": {
      const z = next.zones[event.zone];
      if (z) z.fort = Math.max(0, Math.min(3, (z.fort ?? 0) + event.delta));
      return next;
    }
    case "background_set":
      next.background = structuredClone(event.entries);
      return next;
    case "occupation_standing_changed": {
      const c = mustGet(next.characters, event.characterId, "캐릭터");
      if (c.occupation) c.occupation = { ...c.occupation, standing: Math.max(0, c.occupation.standing + event.delta) };
      return next;
    }
    case "npc_rank_changed":
      mustGet(next.characters, event.npcId, "캐릭터").rank = event.rank;
      return next;
    case "extra_kept": {
      next.keptExtras[event.key] = event.characterId;
      return next;
    }
    case "infestation_changed":
      next.infested[event.zone] = event.level;
      return next;
    case "zone_searched": {
      const prev = next.zoneSearches[event.zone];
      const same = !!prev && prev.day === event.day;
      const hurt = (same && !!prev!.hurt) || !!event.hurt;
      next.zoneSearches[event.zone] = { day: event.day, count: (same ? prev!.count : 0) + (event.units ?? 1), ...(hurt ? { hurt: true } : {}) };
      return next;
    }
    case "npc_entered": {
      const npc = mustGet(next.characters, event.npcId, "캐릭터");
      if (npc.id === state.playerId) throw new Error("플레이어는 NPC로 등장할 수 없습니다.");
      if (npc.dead) throw new Error(`사망한 인물: ${npc.id}`);
      if (next.scene.present.includes(npc.id)) throw new Error(`이미 장면에 있음: ${npc.id}`);
      next.scene.present.push(npc.id);
      delete next.npcStays[npc.id];
      perceive(next, npc.id);
      if (npc.extra) npc.extra.lastSeenAt = state.time;
      // 만나면 서로 얼굴을 안다. 이름은 밝히거나 불려야 안다 (name_learned)
      acquaint(next, state.playerId, npc.id, false);
      acquaint(next, npc.id, state.playerId, false);
      break;
    }
    case "npc_left":
      if (!next.scene.present.includes(event.npcId)) throw new Error(`장면에 없음: ${event.npcId}`);
      perceive(next, event.npcId);
      next.scene.present = next.scene.present.filter((id) => id !== event.npcId);
      next.walkingWith = (next.walkingWith ?? []).filter((id) => id !== event.npcId);
      // 스스로 자리를 뜬 사람은 일과로 돌아간다 (머무는 자리 없음)
      delete next.npcStays[event.npcId];
      {
        const c = next.characters[event.npcId];
        if (c?.extra) c.extra.lastSeenAt = state.time;
      }
      break;
    case "belief_added":
      mustGet(next.characters, event.characterId, "캐릭터");
      (next.beliefs[event.characterId] ??= []).push(structuredClone(event.belief));
      next.nextBeliefNo += 1;
      break;
    case "belief_dropped":
      next.beliefs[event.characterId] = (next.beliefs[event.characterId] ?? []).filter((b) => b.id !== event.beliefId);
      break;
    case "turn_started":
      next.turn = event.turn;
      break;
    case "check_rolled": {
      // 임무를 위한 판정만 임무 진행으로 센다 (거점 안의 사적인 행동이 정찰 조건을 채우지 않게)
      const mission = activeMissionOf(next.missions, event.actorId);
      const at = (zone: string | null | undefined) => !!mission && atMissionPlace(mission, zone ?? null, next.zones, next.factions);
      // 갇혀 있는 동안의 판정은 임무로 세지 않는다 (플레이 테스트 13: 감방 창틈으로 본 것이 정찰 완수가 됐다)
      const held = !!next.characters[event.actorId]?.captive;
      if (!held && mission && mission.id === event.forMission && (at(next.playerZone) || (!!event.dest && at(event.dest)))) mission.requirements.forEach((r, i) => {
        if (!("check" in r) || (r.check !== event.move && !r.alts?.includes(event.move)) || (mission.progress[i] ?? 0) >= 1 || isRequirementClosed(mission, i)) return;
        if (outcomeAtLeast(event.outcome, r.min_outcome)) {
          mission.progress[i] = 1;
          markMissionMet(mission, state.time);
        }
        else {
          // 빗나간 시도를 센다 (C2): 세 번이면 닫힌다. 이야기 선택지 판정은 세지 않는다 (12-258, PT15 분대장: 이야기 실패에 임무 빗나감 30분까지 붙었다)
          if (event.story) return;
          const fails = [...(mission.fails ?? [])];
          fails[i] = (fails[i] ?? 0) + 1;
          mission.fails = fails;
        }
      });
      next.checks[event.checkId] = {
        checkId: event.checkId,
        turn: event.turn,
        actorId: event.actorId,
        move: event.move,
        ...(event.target ? { target: event.target } : {}),
        ...(event.opponent ? { opponent: event.opponent } : {}),
        ...(event.reaction ? { reaction: true } : {}),
        outcome: event.outcome,
        harmApplied: false,
        at: state.time,
      };
      next.nextCheckNo += 1;
      break;
    }
    case "harm_applied": {
      const target = mustGet(next.characters, event.targetId, "캐릭터");
      target.conditions[event.track] = event.to;
      if (event.fatal) target.dead = true;
      next.recovery.lastChangeAt[event.targetId] = state.time;
      next.recovery.trackAt = { ...next.recovery.trackAt, [`${event.targetId}:${event.track}`]: state.time };
      mustGet(next.checks, event.checkId, "판정").harmApplied = true;
      break;
    }
    case "time_advanced":
      if (event.from !== state.time) throw new Error(`시간이 어긋납니다: 현재 ${state.time}, 이벤트 ${event.from}`);
      if (event.to <= event.from) throw new Error("시간은 앞으로만 흐릅니다.");
      next.time = event.to;
      next.lastActivity = event.activity;
      if (event.activity === "sleep") {
        // 깬 지 얼마 안 돼 다시 자면 앞의 잠에 이어진다 (플레이 테스트 13: 끊긴 잠 두 조각이 각각 6시간이 안 돼 상처가 아물지 않았다)
        next.lastSleptFrom = sleepChainStart(state, event.from);
        next.lastWokeAt = event.to;
        next.sleepLog = [...(state.sleepLog ?? []).filter((s) => s.to > event.to - MINUTES_PER_DAY), { from: event.from, to: event.to }];
      }
      {
        const mission = activeMissionOf(next.missions, state.playerId);
        const placed = (zone: string | null) => !!mission && atMissionPlace(mission, zone, next.zones, next.factions);
        if (!next.characters[state.playerId]?.captive && mission && mission.id === event.forMission && (placed(next.playerZone) || (!!event.dest && placed(event.dest)))) mission.requirements.forEach((r, i) => {
          if ("activity" in r && r.activity === event.activity && !isRequirementMet(r, mission.progress[i] ?? 0)) {
            const before = mission.progress[i] ?? 0;
            mission.progress[i] = before + (event.to - event.from);
            // 활동 도중 조건이 찬 그 시각 (4시간 보초 중 3시간째)
            if (isRequirementMet(r, mission.progress[i]!)) markMissionMet(mission, event.from + Math.max(0, r.minutes - before));
          }
        });
      }
      break;
    case "missions_offered":
      next.offers = { day: event.day, templateIds: [...event.templateIds] };
      break;
    case "mission_assigned": {
      const m = event.mission;
      mustGet(next.characters, m.assigneeId, "캐릭터");
      if (next.missions[m.id]) throw new Error(`임무 id 중복: ${m.id}`);
      if (activeMissionOf(next.missions, m.assigneeId)) throw new Error("이미 수행 중인 임무가 있습니다.");
      next.missions[m.id] = structuredClone(m);
      next.nextMissionNo += 1;
      // 받은 임무는 그날 후보에서 빠진다 (같은 임무를 하루에 여러 번 받지 않게)
      if (next.offers) next.offers.templateIds = next.offers.templateIds.filter((id) => id !== m.templateId);
      break;
    }
    case "walkers_released":
      next.walkingWith = [];
      break;
    case "disobedience_forgiven": {
      const c = mustGet(next.characters, event.characterId, "캐릭터");
      c.disobedience = Math.max(0, c.disobedience - 1);
      next.disobedienceAt = { ...next.disobedienceAt, [c.id]: state.time };
      break;
    }
    case "mission_requirement_met": {
      const mission = mustGet(next.missions, event.missionId, "임무");
      if (mission.status !== "active") throw new Error(`이미 끝난 임무: ${mission.id}`);
      mission.progress[event.index] = 1;
      markMissionMet(mission, state.time);
      break;
    }
    case "mission_reported":
    case "mission_abandoned":
    case "mission_expired": {
      const mission = mustGet(next.missions, event.missionId, "임무");
      if (mission.status !== "active") throw new Error(`이미 끝난 임무: ${mission.id}`);
      const assignee = mustGet(next.characters, mission.assigneeId, "캐릭터");
      assignee.merit += event.merit;
      if (event.type === "mission_reported") {
        mission.status = event.outcome === "success" ? "completed" : event.outcome;
        if (event.disobedience) {
          assignee.disobedience += 1;
          next.disobedienceAt = { ...next.disobedienceAt, [assignee.id]: state.time };
        }
      } else {
        mission.status = event.type === "mission_abandoned" ? "abandoned" : "expired";
        if (event.type === "mission_expired" && event.excused) mission.excused = event.excused;
        if (event.disobedience) {
          assignee.disobedience += 1;
          next.disobedienceAt = { ...next.disobedienceAt, [assignee.id]: state.time };
        }
      }
      break;
    }
    case "deed_settled": {
      const deed = mustGet(next.deeds, event.deedId, "행적");
      deed.endedAt = event.endedAt;
      if (event.items && Object.keys(event.items).length) deed.items = { ...event.items };
      break;
    }
    case "deed_returned": {
      mustGet(next.deeds, event.deedId, "행적").returned = true;
      break;
    }
    case "deed_recorded": {
      const deed = event.deed;
      mustGet(next.characters, deed.actorId, "캐릭터");
      if (next.deeds[deed.id]) throw new Error(`행적 id 중복: ${deed.id}`);
      next.deeds[deed.id] = structuredClone(deed);
      next.nextDeedNo += 1;
      break;
    }
    case "deed_learned": {
      const deed = mustGet(next.deeds, event.deedId, "행적");
      mustGet(next.characters, event.npcId, "캐릭터");
      const known = (next.deedKnowledge[event.npcId] ??= {});
      if (known[deed.id]) throw new Error(`이미 아는 행적: ${event.npcId} ${deed.id}`);
      known[deed.id] = event.source;
      const toward = (next.relations[event.npcId] ??= {});
      toward[deed.actorId] = applyRelationDelta(toward[deed.actorId] ?? NEUTRAL_RELATION, event.delta);
      if (deed.actorId === state.playerId && (event.delta.trust ?? 0) < 0) {
        next.trustDroppedAt = { ...next.trustDroppedAt, [event.npcId]: state.time };
        // 행적이 있던 날과 알게 된 날이 다르면 둘 다 (PT14: 1일차 거짓말이 "2일차: …"로 보였다)
        const why = dayOf(deed.at) === dayOf(state.time) ? deed.summary : `${dayOf(deed.at)}일차의 일 — ${deed.summary}`;
        next.trustDroppedWhy = { ...next.trustDroppedWhy, [event.npcId]: why };
      }
      recordRegard(next, state.time, event.npcId, deed.actorId, deedKind(deed), event.delta);
      if (next.scene.present.includes(event.npcId)) perceive(next, event.npcId);
      break;
    }
    case "witnesses_searched":
      mustGet(next.deeds, event.deedId, "행적").searched = true;
      break;
    case "rumors_spread":
      next.lastSpreadDay = event.day;
      break;
    case "factions_initialized":
      if (Object.keys(state.factions).length) throw new Error("세력이 이미 정해졌습니다.");
      next.factions = structuredClone(event.factions);
      next.zones = structuredClone(event.zones);
      next.clocks = structuredClone(event.clocks);
      next.lastWarDay = event.day;
      break;
    case "war_day_simulated":
      if (state.lastWarDay !== null && event.day <= state.lastWarDay) throw new Error(`이미 지난 날: ${event.day}일차`);
      next.factions = structuredClone(event.factions);
      next.zones = structuredClone(event.zones);
      for (const [id, clock] of Object.entries(event.clocks)) {
        const c = mustGet(next.clocks, id, "세력 클락");
        // 다 차서 다시 시작한 계획은 기여 기록을 비운다 (그 공세에 실려 나갔다)
        if (clock.filled < c.filled) delete c.credits;
        c.filled = clock.filled;
        if (clock.target !== undefined) retarget(c, clock.target);
      }
      next.lastWarDay = event.day;
      next.pendingClashes.push(...structuredClone(event.scheduled));
      rememberClashes(next, event.clashes, state.time);
      next.nextBattleNo += event.scheduled.length;
      if (event.parties) next.parties = structuredClone(event.parties);
      if (event.nextPartyNo !== undefined) next.nextPartyNo = event.nextPartyNo;
      if (event.partiesUpTo !== undefined) next.partiesUpTo = event.partiesUpTo;
      seeHereOwner(next);
      if (event.parties) {
        // 사라진 부대의 마주침 기록은 지운다
        const alive = new Set(event.parties.map((p) => p.id));
        for (const key of Object.keys(next.partySightings)) if (!alive.has(key.split("@")[0]!)) delete next.partySightings[key];
      }
      break;
    case "parties_advanced": {
      next.factions = structuredClone(event.factions);
      next.zones = structuredClone(event.zones);
      for (const [id, clock] of Object.entries(event.clocks)) {
        const c = mustGet(next.clocks, id, "세력 클락");
        c.filled = clock.filled;
        if (clock.target !== undefined) retarget(c, clock.target);
      }
      next.parties = structuredClone(event.parties);
      next.partiesUpTo = event.partiesUpTo;
      if (event.nextPartyNo !== undefined) next.nextPartyNo = event.nextPartyNo;
      next.pendingClashes.push(...structuredClone(event.scheduled));
      next.nextBattleNo += event.scheduled.length;
      rememberClashes(next, event.clashes, state.time, true);
      seeHereOwner(next);
      const alive = new Set(event.parties.map((p) => p.id));
      for (const key of Object.keys(next.partySightings)) if (!alive.has(key.split("@")[0]!)) delete next.partySightings[key];
      break;
    }
    case "clock_credited": {
      const clock = next.clocks[event.clockId];
      if (clock) clock.credits = [...(clock.credits ?? []), { by: event.by, mission: event.mission, scout: event.scout }];
      break;
    }
    case "party_engaged":
      next.partyFights[event.partyId] = { members: [...event.members], zone: event.zone, at: state.time };
      break;
    case "party_fight_ended":
      delete next.partyFights[event.partyId];
      break;
    case "party_sighted":
      next.partySightings[event.key] = { at: state.time, player: event.player, party: event.party };
      if (event.player) {
        const id = event.key.split("@")[0]!;
        next.partiesSeen = { ...next.partiesSeen, [id]: state.time };
        // 마주침은 주인공이 있는 구역에서만 굴린다 (열쇠의 둘째 칸)
        rememberParty(next, id, state.time, event.key.split("@")[1] ?? next.playerZone);
      }
      break;
    case "party_reported": {
      // 왔다 간 뒤에 안 무리도 하루 동안은 알릴 수 있다 (12-327: 정찰은 공세의 예고)
      rememberParty(next, event.partyId, state.time, event.zone);
      if (event.gone) {
        next.garrisonSeen = [...next.garrisonSeen, event.partyId];
        break;
      }
      next.partiesSeen = { ...next.partiesSeen, [event.partyId]: state.time };
      if (event.via === "garrison") {
        next.garrisonSeen = [...next.garrisonSeen, event.partyId];
        const z = next.zones[event.zone];
        if (z && event.faction && z.owner === event.faction) z.alerted = event.faction;
      }
      break;
    }
    case "party_alerted": {
      // 알린 무리를 다시 부르면(설득) 설득 결과만 고친다
      if (next.partyAlerts.some((a) => a.partyId === event.partyId)) {
        next.partyAlerts = next.partyAlerts.map((a) => (a.partyId === event.partyId ? { ...a, persuaded: event.persuaded } : a));
        break;
      }
      next.partyAlerts = [...next.partyAlerts, { partyId: event.partyId, faction: event.faction, zone: event.zone, at: state.time, persuaded: event.persuaded, credited: false, closed: false, until: event.until ?? 0, plan: event.plan ?? null }];
      const z = next.zones[event.zone];
      if (z && z.owner === event.faction) z.alerted = event.faction;
      break;
    }
    case "party_alert_settled": {
      next.partyAlerts = next.partyAlerts.map((a) => (a.partyId === event.partyId ? { ...a, credited: a.credited || event.credited, closed: true } : a));
      const z = next.zones[event.zone];
      if (z && event.clear) delete z.alerted;
      break;
    }

    case "weather_set":
      next.weather = { day: event.day, id: event.weatherId };
      break;
    case "weather_forecast":
      next.forecast = { day: event.day, id: event.weatherId };
      break;
    case "place_moved": {
      // 바닥의 물건은 장소마다 (12-244). 장면의 인물은 동행과 함께 가는 사람(with)만 따라온다
      const zone = next.playerZone;
      if (!zone) return next;
      swapGround(next, spotKey(zone, event.from), spotKey(zone, event.to));
      next.playerPlace = event.to;
      // 자리를 옮기면 무너진 자세도 풀린다 (12-251, 플레이 테스트 14: 장소를 옮겨도 다음 판정에 남았다)
      if (event.to !== state.playerPlace) next.offBalanceUntil = null;
      for (const id of next.scene.present) perceive(next, id);
      const along = event.with ?? [];
      next.walkingWith = (event.walking ?? []).filter((id) => !next.companions.includes(id));
      const keep = (id: string) => next.companions.includes(id) || along.includes(id);
      // 두고 온 사람은 그 시간대가 끝날 때까지 그 자리에 머문다 (12-253)
      leaveBehind(next, next.scene.present.filter((id) => !keep(id)), zone, event.from, state.time);
      next.scene = { ...next.scene, present: next.scene.present.filter(keep) };
      // 같은 구역의 한 장소에 남겨 둔 동행: 그 장소를 떠나면 돌아왔을 때 합류한다
      for (const b of Object.values(next.bonds)) if (b.apart?.zone === zone && (b.apart.place ?? null) === event.from) b.apart.left = true;
      return next;
    }
    case "npc_knocked_out":
      next.knockedOut = { ...(next.knockedOut ?? {}), [event.npcId]: event.until };
      return next;
    case "place_learned": {
      const key = `${event.zone}:${event.place}`;
      const mine = next.knownPlaces[next.playerId] ?? [];
      if (!mine.includes(key)) next.knownPlaces = { ...next.knownPlaces, [next.playerId]: [...mine, key] };
      return next;
    }
    case "place_spawned":
      next.spawnedPlaces = { ...next.spawnedPlaces, [event.id]: { zone: event.zone, name: event.name, indoor: event.indoor, owner: event.owner, at: event.at ?? null, shop: event.shop ?? null } };
      return next;
    case "zone_moved": {
      // 시작하는 시각에 놓인 구역이 시작한 구역이다 (새 세계·이어받기)
      if (state.time === state.runStartedAt) next.runStartZone = event.to;
      for (const b of Object.values(next.bonds)) if (b.apart?.zone && b.apart.zone === event.from) b.apart.left = true;
      // 우리 땅을 떠난 시각 (공통 규칙 3의 자리 비움)
      const mine = next.characters[next.playerId]?.factionId;
      if (mine && next.leftHomeAt === null && next.zones[event.to]?.owner !== mine) next.leftHomeAt = state.time;
      next.zoneSeen = { ...next.zoneSeen, [event.to]: next.zones[event.to]?.owner ?? null };
      // 떠난 구역의 부대 마주침은 잊는다: 다시 들어서면 새로 굴린다 (PT32 분대장)
      if (event.from && event.from !== event.to) for (const key of Object.keys(next.partySightings)) if (key.split("@")[1] === event.from) delete next.partySightings[key];
      // 바닥의 물건은 그 구역에 남기고, 가는 구역에 남아 있던 것을 장면에 둔다
      if (event.from !== event.to) {
        swapGround(next, event.from === null ? null : spotKey(event.from, state.playerPlace), spotKey(event.to, event.place ?? null));
        next.playerPlace = event.place ?? null;
      } else if (event.place !== undefined && event.place !== null) next.playerPlace = event.place;
      // 잠입하던 곳을 떠나면 잠입은 끝난다 (12-154)
      next.infiltration = null;
      next.exploration = null;
      if (state.battle) throw new Error("전투 중에는 구역을 옮길 수 없습니다.");
      next.lastRoute = event.from !== null ? { from: event.from, to: event.to } : null;
      // 떠나는 구역에 맡겨 둔 것을 돌려받는다 (12-54)
      if (event.from !== null && next.deposits[event.from]) {
        const me = next.characters[next.playerId];
        if (me) for (const [item, n] of Object.entries(next.deposits[event.from]!)) me.inventory[item] = (me.inventory[item] ?? 0) + n;
        delete next.deposits[event.from];
      }
      // 장면의 인물은 따라오지 않는다 (같이 가려면 도착한 뒤 다시 등장시킨다). 처음 자리를 정할 때(from 없음)는 그대로
      if (event.from !== null) {
        for (const id of next.scene.present) {
          perceive(next, id);
          const c = next.characters[id];
          if (c?.extra) c.extra.lastSeenAt = state.time;
        }
        // 동행은 따라온다 (살아 있고 붙잡히지 않았을 때). 함께 가는 사람(with)도 이번 이동만 따라온다 (PT15: 업고 나온 동료·데려가던 가족이 남았다)
        // 함께 달아난 사람은 풀려난다 (탈출에 함께 갇혀 있던 사람을 데려갔다)
        for (const id of event.with ?? []) {
          const c = next.characters[id];
          if (c?.captive) c.captive = null;
        }
        const along = (event.with ?? []).filter((id) => !next.companions.includes(id));
        next.walkingWith = (event.walking ?? []).filter((id) => !next.companions.includes(id));
        // 두고 온 사람은 떠난 구역의 그 자리에 머문다 (12-253)
        leaveBehind(next, next.scene.present.filter((id) => !next.companions.includes(id) && !along.includes(id)), event.from, state.playerPlace, state.time);
        next.scene.present = [...next.companions, ...along].filter((id) => {
          const c = next.characters[id];
          return c && !c.dead && !c.away && !c.captive;
        });
      }
      next.playerZone = event.to;
      next.offBalanceUntil = null;
      {
        const seen = next.visited[next.playerId] ?? [];
        if (!seen.includes(event.to)) next.visited = { ...next.visited, [next.playerId]: [...seen, event.to] };
      }
      break;
    }

    case "condition_changed": {
      const target = mustGet(next.characters, event.targetId, "캐릭터");
      if (target.dead) throw new Error("사망한 캐릭터의 상태는 바뀌지 않습니다.");
      target.conditions[event.track] = event.to;
      if (event.fatal) target.dead = true;
      if (event.harmTrack) next.recovery.lastChangeAt[event.targetId] = state.time;
      next.recovery.trackAt = { ...next.recovery.trackAt, [`${event.targetId}:${event.track}`]: state.time };
      if (event.by === "healer") {
        next.recovery.lastHealerDay[event.targetId] = event.day;
        next.recovery.healerSnap = { ...next.recovery.healerSnap, [event.targetId]: { ...target.conditions } };
      }
      if (event.by === "aid") {
        next.recovery.lastAidDay = { ...next.recovery.lastAidDay, [event.targetId]: event.day };
        next.recovery.aidSnap = { ...next.recovery.aidSnap, [event.targetId]: { ...target.conditions } };
      }
      break;
    }
    case "infection_slowed":
      mustGet(next.characters, event.targetId, "캐릭터");
      next.recovery.slowDay = { ...next.recovery.slowDay, [event.targetId]: event.day };
      break;
    case "infection_held":
      mustGet(next.characters, event.targetId, "캐릭터");
      next.recovery.heldDay = { ...next.recovery.heldDay, [event.targetId]: event.day };
      break;
    case "harm_healed": {
      const target = mustGet(next.characters, event.targetId, "캐릭터");
      if (target.dead) throw new Error("사망한 캐릭터는 낫지 않습니다.");
      target.conditions[event.track] = event.to;
      next.recovery.lastChangeAt[event.targetId] = state.time;
      if (event.by === "healer") {
        next.recovery.lastHealerDay[event.targetId] = event.day;
        next.recovery.healerSnap = { ...next.recovery.healerSnap, [event.targetId]: { ...target.conditions } };
      }
      if (event.by === "aid") {
        next.recovery.lastAidDay = { ...next.recovery.lastAidDay, [event.targetId]: event.day };
        next.recovery.aidSnap = { ...next.recovery.aidSnap, [event.targetId]: { ...target.conditions } };
      }
      break;
    }
    case "character_died":
      if (event.record.characterId !== state.playerId) throw new Error("현재 캐릭터의 기록이 아닙니다.");
      if (!state.characters[state.playerId]?.dead) throw new Error("캐릭터가 아직 살아 있습니다.");
      next.chronicle.push(structuredClone(event.record));
      break;
    case "kill_known":
      next.killsKnown = { ...next.killsKnown, [event.factionId]: (next.killsKnown[event.factionId] ?? 0) + 1 };
      break;
    case "bounty_posted":
      if (!next.bounties.includes(event.factionId)) next.bounties = [...next.bounties, event.factionId];
      break;
    case "bounty_cleared":
      next.bounties = next.bounties.filter((f) => f !== event.factionId);
      // 거두면 셈도 처음부터 (다시 죽이면 다시 쌓인다)
      next.killsKnown = { ...next.killsKnown, [event.factionId]: 0 };
      break;
    case "vendetta_sworn":
      if (next.vendettas.some((v) => v.avenger === event.avenger)) break;
      next.vendettas.push({ avenger: event.avenger, victim: event.victim, since: state.time });
      break;
    case "vendetta_settled":
      next.vendettas = next.vendettas.filter((v) => v.avenger !== event.avenger);
      break;
    case "trap_set":
      if (next.traps.some((t) => t.zone === event.zone)) throw new Error(`이미 덫이 있다: ${event.zone}`);
      next.traps.push({ zone: event.zone, setAt: event.at, caught: null, qty: 0, ...(event.item ? { item: event.item } : {}) });
      break;
    case "trap_caught": {
      const t = next.traps.find((x) => x.zone === event.zone);
      if (!t) throw new Error(`없는 덫: ${event.zone}`);
      t.caught = event.item;
      t.qty = event.qty;
      break;
    }
    case "trap_collected":
      next.traps = next.traps.filter((t) => t.zone !== event.zone);
      break;
    case "remains_left":
      if (next.remains.some((r) => r.holder === event.remains.holder)) throw new Error(`이미 남은 유해: ${event.remains.holder}`);
      next.remains.push(structuredClone(event.remains));
      break;
    case "remains_buried": {
      const r = next.remains.find((x) => x.holder === event.holder);
      if (!r) throw new Error(`없는 유해: ${event.holder}`);
      if (r.buriedAt !== null) throw new Error("이미 묻었습니다.");
      r.buriedAt = event.at;
      r.marker = event.marker;
      break;
    }
    case "epitaph_written": {
      const record = next.chronicle[event.index];
      if (!record) throw new Error(`없는 연대기: ${event.index}`);
      record.epitaph = event.text;
      break;
    }
    case "character_switched": {
      if (!state.characters[state.playerId]?.dead) throw new Error("살아 있는 캐릭터는 바꿀 수 없습니다.");
      if (event.character) {
        if (next.characters[event.character.id]) throw new Error(`캐릭터 id 중복: ${event.character.id}`);
        next.characters[event.character.id] = structuredClone(event.character);
      }
      const successor = mustGet(next.characters, event.characterId, "캐릭터");
      if (successor.dead) throw new Error(`사망한 인물: ${successor.id}`);
      next.playerId = successor.id;
      next.runStartedAt = state.time;
      next.serviceSince = null;
      next.runStartZone = next.playerZone;
      next.admission = null;
      // 앞 주인공이 잃은 상관의 믿음은 물려받지 않는다 (플레이 테스트 12: 계승한 주인공의 진급이 막혔다)
      next.trustDroppedAt = {};
      next.trustDroppedWhy = {};
      if (event.roleId) {
        next.roleId = event.roleId;
        next.customRole = event.customRole ? structuredClone(event.customRole) : null;
      }
      const playing = event.scenarioRole ?? event.roleId;
      if (playing !== undefined) next.scenarioRole = playing;
      // 이어받는 인물이 원래 알던 사람은 그대로 알고, 같은 무리 동료와는 서로 이름을 안다
      for (const id of event.known) {
        acquaint(next, successor.id, id, true);
        acquaint(next, id, successor.id, true);
      }
      // 장면과 플레이어 기준 상태를 새로 시작한다 (새 캐릭터는 다른 곳에서 하루를 시작한다).
      // 이어받는 사람이 그 장면에 있었으면 장면은 그대로 이어진다: 맞붙은 감염체도 그 자리에 (PT22 하얀매: 지하에서 이어받았는데 바깥 길에 혼자 섰다)
      next.scene.present = state.scene.present.includes(successor.id) ? state.scene.present.filter((id) => id !== successor.id && id !== state.playerId) : [];
      // 이어받는 사람이 곁에 있었으면 앞 주인공을 만난 사이다 (PT23 졸병·하얀매: 구해 준 사람·함께 싸운 사람을 "만나 본 적 없다")
      const beside = state.scene.present.includes(successor.id) || state.companions.includes(successor.id);
      if (beside) acquaint(next, successor.id, state.playerId, true);
      // 만난 사람의 마음은 이어받는 사람이 아는 대로 (만남 기록에서), 가 본 구역은 아는 장소에서 (함께 다닌 곳)
      next.perceived = {};
      for (const id of next.met[successor.id] ?? []) if (next.characters[id]) next.perceived[id] = { ...(next.relations[id]?.[successor.id] ?? NEUTRAL_RELATION) };
      const zones = [...new Set((next.knownPlaces?.[successor.id] ?? []).map((k) => k.split(":")[0]!))];
      next.visited = { ...next.visited, [successor.id]: [...new Set([...(next.visited[successor.id] ?? []), ...zones])] };
      // 동행은 죽은 사람을 따라다녔다. 다음 캐릭터는 새로 사귄다 (기획서 7.8).
      // 이름 없는 동행(동물·연고)은 죽은 그 자리에 남아, 다음 주인공이 그곳에서 만날 수 있다 (12-239, 플레이 테스트 13: 누렁이가 주인이 죽은 뒤 어디에도 없었다)
      for (const id of state.companions) {
        const c = next.characters[id];
        if (c?.extra && !c.dead && state.playerZone) c.extra = { ...c.extra, zone: state.playerZone };
      }
      next.companions = [];
      next.bonds = {};
      // 앞 주인공이 놓은 덫은 다음 주인공이 모른다 (플레이 테스트 13)
      next.traps = [];
      next.leftHomeAt = null;
      next.squadOrders = {};
      next.squadReports = {};
      next.squad = null;
      next.promotionOffer = null;
      next.council = {};
      next.offers = null;
      next.playerZone = null;
      next.battle = null;
      next.activeStorylet = null;
      next.improvSlot = null;
      break;
    }
    case "storylet_fired": {
      if (state.activeStorylet) throw new Error("이미 진행 중인 스토리렛이 있습니다.");
      next.activeStorylet = { id: event.storyletId, cast: { ...event.cast }, firedAt: state.time, expiresAt: event.expiresAt, ...(event.improvised ? { improvised: event.improvised } : {}) };
      // GM이 즉흥 자리를 채웠으면 닫는다. 다른 이야기(규율 회의 등)가 먼저 와도 자리는 기한까지 남아, 그 이야기가 끝난 뒤 쓸 수 있다
      // (12-265, PT17·PT18 분대장: 상태엔 13:47까지라 했는데 회의가 열린 뒤 알림 없이 사라졌다)
      if (event.improvised) next.improvSlot = null;
      const log = (next.storyletLog[event.storyletId] ??= { fired: 0, lastFiredAt: state.time });
      log.fired += 1;
      log.lastFiredAt = state.time;
      next.lastStoryletAt = state.time;
      next.castUsedAt = { ...(next.castUsedAt ?? {}) };
      for (const id of Object.values(event.cast)) next.castUsedAt[id] = state.time;
      break;
    }
    case "improv_slot_opened":
      next.improvSlot = { openedAt: state.time, expiresAt: event.expiresAt, prevLast: state.lastStoryletAt };
      next.lastImprovSlotAt = state.time;
      next.lastStoryletAt = state.time;
      break;
    case "improv_slot_closed":
      // 쓰지 않은 즉흥 자리는 이야기 사이 간격을 잡지 않는다: 앞 이야기 시각으로 돌린다 (PT23 졸병: 오후 자리가 다음 날 새벽까지 간격을 잡았다)
      if (event.unused && state.improvSlot && state.lastStoryletAt === state.improvSlot.openedAt) next.lastStoryletAt = state.improvSlot.prevLast ?? null;
      next.improvSlot = null;
      break;
    case "storylet_resolved":
    case "storylet_expired": {
      if (state.activeStorylet?.id !== event.storyletId) throw new Error(`진행 중인 스토리렛이 아닙니다: ${event.storyletId}`);
      next.activeStorylet = null;
      const log = next.storyletLog[event.storyletId];
      if (log) next.storyletLog = { ...next.storyletLog, [event.storyletId]: { ...log, lastEnd: event.type === "storylet_expired" ? "expired" : (event.outcome ?? "chosen") } };
      break;
    }
    case "flag_set": {
      const flags = (next.flags[event.characterId] ??= []);
      if (!flags.includes(event.flag)) flags.push(event.flag);
      break;
    }
    case "flag_cleared":
      next.flags[event.characterId] = (next.flags[event.characterId] ?? []).filter((f) => f !== event.flag);
      break;
    case "relation_changed": {
      mustGet(next.characters, event.from, "캐릭터");
      if (event.to === state.playerId && (event.delta.trust ?? 0) < 0) {
        next.trustDroppedAt = { ...next.trustDroppedAt, [event.from]: state.time };
        next.trustDroppedWhy = { ...next.trustDroppedWhy, [event.from]: event.reason };
      }
      const toward = (next.relations[event.from] ??= {});
      toward[event.to] = applyRelationDelta(toward[event.to] ?? NEUTRAL_RELATION, event.delta);
      if (event.kind && event.kind !== "start") recordRegard(next, state.time, event.from, event.to, event.kind, event.delta);
      if (event.to === state.playerId && (event.known || next.scene.present.includes(event.from))) perceive(next, event.from);
      break;
    }
    case "merit_awarded":
      mustGet(next.characters, event.characterId, "캐릭터").merit += event.delta;
      break;
    case "xp_gained": {
      const c = mustGet(next.characters, event.characterId, "캐릭터");
      c.xp += event.amount;
      if (event.level > c.level) {
        c.skillPoints += event.level - c.level;
        c.level = event.level;
      }
      if (event.source === "check") {
        const day = dayOf(state.time);
        next.xpToday = { day, amount: (state.xpToday.day === day ? state.xpToday.amount : 0) + event.amount };
      }
      break;
    }
    case "cheat_used":
      next.cheated = true;
      break;
    case "character_patched": {
      const c = mustGet(next.characters, event.characterId, "캐릭터");
      if (event.stats) Object.assign(c.stats, event.stats);
      if (event.skills) Object.assign(c.skills, event.skills);
      if (event.traits) c.traits = [...event.traits];
      break;
    }
    case "faction_patched": {
      const f = mustGet(next.factions, event.factionId, "세력");
      Object.assign(f.resources, event.resources);
      break;
    }
    case "extra_spawned": {
      const c = event.character;
      if (next.characters[c.id]) throw new Error(`캐릭터 id 중복: ${c.id}`);
      if (!c.extra) throw new Error("엑스트라 정보가 없습니다.");
      next.characters[c.id] = structuredClone(c);
      next.nextExtraNo += 1;
      if (event.unseen) break;
      next.scene.present.push(c.id);
      perceive(next, c.id);
      acquaint(next, state.playerId, c.id, false);
      acquaint(next, c.id, state.playerId, false);
      break;
    }
    case "name_learned": {
      mustGet(next.characters, event.characterId, "캐릭터");
      mustGet(next.characters, event.targetId, "캐릭터");
      if (event.characterId === event.targetId) throw new Error("자기 이름은 이미 안다.");
      if (next.known[event.characterId]?.includes(event.targetId)) throw new Error(`이미 이름을 안다: ${event.characterId} → ${event.targetId}`);
      acquaint(next, event.characterId, event.targetId, true);
      break;
    }
    case "skill_learned": {
      const c = mustGet(next.characters, event.characterId, "캐릭터");
      if (c.skillPoints < event.cost) throw new Error("스킬 포인트가 모자랍니다.");
      if ((c.skills[event.skill] ?? event.from) !== event.from) throw new Error(`스킬 값이 어긋납니다: ${event.skill}`);
      c.skillPoints -= event.cost;
      c.skills[event.skill] = event.to;
      break;
    }
    case "item_granted": {
      const inv = holderInventory(next, event.to);
      inv[event.itemId] = (inv[event.itemId] ?? 0) + event.quantity;
      break;
    }
    case "clock_adjusted": {
      const clock = mustGet(next.clocks, event.clockId, "세력 클락");
      // 다 차서 이미 일어난 일(태도가 바뀐 shift 클락)은 되돌리지 않는다
      if (clock.filled >= clock.max) break;
      clock.filled = Math.max(0, Math.min(clock.max - 1, clock.filled + event.delta));
      break;
    }
    case "faction_morale_changed": {
      const f = mustGet(next.factions, event.factionId, "세력");
      f.morale = Math.max(-3, Math.min(3, f.morale + event.delta));
      break;
    }
    case "preparation_set":
      (next.preparations[event.zone] ??= []).push(event.preparation);
      break;
    case "item_consumed": {
      if (next.characters[event.holder]) pullFromBags(next, event.holder, event.itemId, event.quantity);
      const inv = holderInventory(next, event.holder);
      const left = (inv[event.itemId] ?? 0) - event.quantity;
      if (left < 0) throw new Error(`수량 부족: ${event.holder}의 ${event.itemId}`);
      if (left === 0) delete inv[event.itemId];
      else inv[event.itemId] = left;
      break;
    }
    case "clash_resolved":
      next.pendingClashes = next.pendingClashes.filter((p) => p.id !== event.pendingId);
      next.factions = structuredClone(event.factions);
      next.zones = structuredClone(event.zones);
      for (const [id, target] of Object.entries(event.targets ?? {})) if (next.clocks[id]) retarget(next.clocks[id]!, target);
      rememberClashes(next, [event.clash], state.time);
      seeHereOwner(next);
      break;
    case "battle_started":
      if (state.battle) throw new Error("이미 전투 중입니다.");
      next.pendingClashes = next.pendingClashes.filter((p) => p.id !== event.pendingId);
      next.battle = structuredClone(event.battle);
      for (const used of event.barrierUsed ?? []) {
        const list = next.preparations[event.battle.zone] ?? [];
        const i = list.indexOf(used);
        if (i >= 0) list.splice(i, 1);
      }
      break;
    case "battle_round": {
      const b = next.battle;
      if (!b) throw new Error("진행 중인 전투가 없습니다.");
      b.round += 1;
      b.momentum = event.momentum;
      b.alarm = event.alarm;
      b.position = event.position;
      b.objectives = [...event.objectives];
      b.ours.losses = event.ourLosses;
      b.theirs.losses = event.theirLosses;
      b.contribution = event.contribution;
      if (event.holds !== undefined) b.holds = event.holds;
      if (event.preparationUsed) {
        const list = next.preparations[b.zone] ?? [];
        const i = list.indexOf(event.preparationUsed);
        if (i < 0) throw new Error(`설치된 준비물이 없습니다: ${event.preparationUsed}`);
        list.splice(i, 1);
      }
      break;
    }
    case "battle_ended": {
      if (!state.battle) throw new Error("진행 중인 전투가 없습니다.");
      next.battle = null;
      next.factions = structuredClone(event.factions);
      next.zones = structuredClone(event.zones);
      for (const [id, target] of Object.entries(event.targets ?? {})) if (next.clocks[id]) retarget(next.clocks[id]!, target);
      mustGet(next.characters, state.playerId, "캐릭터").merit += event.merit;
      rememberClashes(next, [event.clash], state.time);
      break;
    }
    case "secret_revealed":
      mustGet(next.characters, event.npcId, "캐릭터");
      if (next.revealedSecrets.includes(event.npcId)) throw new Error(`이미 공개된 비밀: ${event.npcId}`);
      next.revealedSecrets.push(event.npcId);
      break;
    case "promoted": {
      const character = mustGet(next.characters, event.characterId, "캐릭터");
      if (character.rank !== event.from) throw new Error(`등급이 어긋납니다: ${character.rank} ≠ ${event.from}`);
      character.rank = event.to;
      if (event.characterId === state.playerId) next.promotionOffer = null;
      break;
    }
    case "promotion_offered":
      next.promotionOffer = { to: event.to, at: state.time, declined: false };
      break;
    case "promotion_declined":
      if (next.promotionOffer) next.promotionOffer = { ...next.promotionOffer, declined: true };
      break;
    case "squad_set":
      next.squad = [...event.members];
      break;
    case "squad_joined":
      next.squad = [...(next.squad ?? []), event.characterId];
      break;
    case "item_transferred": {
      if (next.characters[event.from]) pullFromBags(next, event.from, event.itemId, event.quantity);
      moveBags(next, event.from, event.to, event.itemId, event.quantity, findHolderInventory(next, event.from)?.[event.itemId] ?? 0, event.bagId);
      const from = holderInventory(next, event.from);
      const to = holderInventory(next, event.to);
      const remaining = (from[event.itemId] ?? 0) - event.quantity;
      if (remaining < 0) throw new Error(`수량 부족: ${event.from}의 ${event.itemId}`);
      if (remaining === 0) delete from[event.itemId];
      else from[event.itemId] = remaining;
      to[event.itemId] = (to[event.itemId] ?? 0) + event.quantity;
      // 맡긴 물건 (12-196): 맡기면 적고, 맡은 사람이 그 주인에게 돌려주면 지운다
      if (event.deposit) next.entrusted = [...(next.entrusted ?? []), { owner: event.from, holder: event.to, itemId: event.itemId, quantity: event.quantity, note: event.deposit, at: state.time }];
      else if ((next.entrusted ?? []).some((d) => d.holder === event.from && d.owner === event.to && d.itemId === event.itemId)) {
        let left = event.quantity;
        next.entrusted = (next.entrusted ?? []).flatMap((d) => {
          if (left <= 0 || d.holder !== event.from || d.owner !== event.to || d.itemId !== event.itemId) return [d];
          const take = Math.min(left, d.quantity);
          left -= take;
          return d.quantity > take ? [{ ...d, quantity: d.quantity - take }] : [];
        });
      }
      break;
    }
  }
  return next;
}

/** 플레이어가 지금 이 NPC의 태도를 느낀다 (같은 장면에 있을 때) */
/** a가 b를 만났다(얼굴을 안다). withName이면 이름까지 안다 (기획서 6.3) */
function acquaint(state: GameState, a: string, b: string, withName: boolean) {
  if (a === b) return;
  const met = (state.met[a] ??= []);
  if (!met.includes(b)) met.push(b);
  if (!withName) return;
  const known = (state.known[a] ??= []);
  if (!known.includes(b)) known.push(b);
}

/** 오른 관계를 센다 (공통 규칙 19, rules/regard.ts): 오늘 오른 양과 까닭별 마지막 시각 */
function recordRegard(next: GameState, time: number, from: string, to: string, kind: string, delta: RelationDelta) {
  const up = (["trust", "affection", "respect"] as const).filter((a) => delta[a] > 0);
  if (!up.length) return;
  const day = dayOf(time);
  if (next.regardGained.day !== day) next.regardGained = { day, by: {} };
  const g = ((next.regardGained.by[from] ??= {})[to] ??= {});
  const last = ((next.regardLast[from] ??= {})[to] ??= {});
  for (const a of up) {
    g[a] = (g[a] ?? 0) + delta[a];
    last[`${kind}|${a}`] = time;
  }
}

function perceive(state: GameState, npcId: string) {
  state.perceived[npcId] = { ...(state.relations[npcId]?.[state.playerId] ?? NEUTRAL_RELATION) };
}

/** 보관 위치의 인벤토리. 없으면 undefined */
export function findHolderInventory(state: GameState, holder: string): Inventory | undefined {
  if (holder === SCENE_HOLDER) return state.scene.items;
  return state.characters[holder]?.inventory;
}

/** 가방이 있는 곳의 소지품 (공통 규칙 26): 캐릭터, 장면 바닥, 구역 바닥, 창고 */
export function bagPlaceInventory(state: GameState, at: string): Inventory | undefined {
  if (at === SCENE_HOLDER) return state.scene.items;
  if (at.startsWith("ground:")) return state.groundItems[at.slice("ground:".length)];
  if (at.startsWith("stash:")) {
    const [, who, ...zone] = at.split(":");
    return state.stashes[who!]?.[zone.join(":")];
  }
  return state.characters[at]?.inventory;
}

/**
 * 가방이 옮겨 간다 (공통 규칙 26): 물건이 from에서 to로 qty만큼 갈 때, 그 물건이 가방이면 개체도 옮긴다 (연결만, 내용물은 가방이 가진다).
 * 고르는 차례: 집은 가방(bagId), 빈 가방, 든 가방, 멘 가방. countBefore: 옮기기 전 from의 그 물건 수
 */
function moveBags(next: GameState, from: string, to: string, itemId: string, qty: number, countBefore: number, bagId?: string) {
  const here = Object.entries(next.bags ?? {}).filter(([, b]) => b.at === from && b.item === itemId);
  if (!here.length) return;
  let left = qty;
  const move = (id: string) => {
    const b = next.bags[id]!;
    b.at = to;
    if (b.worn) {
      b.worn = false;
      const c = next.characters[from];
      if (c?.equipped?.back === itemId) c.equipped = { ...c.equipped, back: null };
    }
    left--;
  };
  if (bagId && here.some(([id]) => id === bagId)) move(bagId);
  left -= Math.min(left, Math.max(0, countBefore - here.length));
  const rest = here.filter(([id]) => id !== bagId).sort(([, a], [, b]) => Number(!!a.worn) - Number(!!b.worn));
  for (const [id] of rest) if (left > 0) move(id);
}

/** 맨몸에 모자라면 지닌 가방에서 덜어 낸다 (공통 규칙 26: 쓰고 주고 빼앗기는 것은 가방 속에서도 나간다). 멘 가방은 맨 나중 */
function pullFromBags(next: GameState, charId: string, itemId: string, need: number) {
  const c = next.characters[charId];
  if (!c) return;
  let short = need - (c.inventory[itemId] ?? 0);
  if (short <= 0) return;
  const bags = Object.values(next.bags ?? {}).filter((b) => b.at === charId && (b.contents[itemId] ?? 0) > 0).sort((a, b) => Number(!!a.worn) - Number(!!b.worn));
  for (const b of bags) {
    if (short <= 0) break;
    const take = Math.min(short, b.contents[itemId] ?? 0);
    const left = (b.contents[itemId] ?? 0) - take;
    if (left === 0) delete b.contents[itemId];
    else b.contents[itemId] = left;
    c.inventory[itemId] = (c.inventory[itemId] ?? 0) + take;
    short -= take;
  }
}

/** 가방 개체를 그 자리 물건 수에 맞춘다: 가방이 없어졌으면(망가짐·잃음) 내용물을 그 자리에 쏟고, 비고 메지 않은 개체는 지운다 */
function syncBags(next: GameState) {
  const groups = new Map<string, string[]>();
  for (const [id, b] of Object.entries(next.bags)) {
    const c = next.characters[b.at];
    if (b.worn && c && c.equipped?.back !== b.item) b.worn = false;
    if (!b.worn && !Object.keys(b.contents).length) {
      delete next.bags[id];
      continue;
    }
    const key = `${b.at}\u0000${b.item}`;
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  for (const ids of groups.values()) {
    const first = next.bags[ids[0]!]!;
    const inv = bagPlaceInventory(next, first.at);
    const extra = ids.length - (inv?.[first.item] ?? 0);
    if (extra <= 0) continue;
    const spill = [...ids].sort((a, b) => Number(!!next.bags[a]!.worn) - Number(!!next.bags[b]!.worn)).slice(0, extra);
    for (const id of spill) {
      const b = next.bags[id]!;
      const dest = inv ?? (b.at.startsWith("ground:") ? (next.groundItems[b.at.slice("ground:".length)] = {}) : undefined);
      if (dest) for (const [item, n] of Object.entries(b.contents)) dest[item] = (dest[item] ?? 0) + n;
      delete next.bags[id];
    }
  }
}

function holderInventory(state: GameState, holder: string): Inventory {
  const inventory = findHolderInventory(state, holder);
  if (!inventory) throw new Error(`알 수 없는 보관 위치: ${holder}`);
  return inventory;
}

function mustGet<T>(record: Record<string, T>, key: string, label: string): T {
  const value = record[key];
  if (!value) throw new Error(`알 수 없는 ${label}: ${key}`);
  return value;
}

function toInventory(itemIds: readonly string[]): Inventory {
  const inventory: Inventory = {};
  for (const itemId of itemIds) inventory[itemId] = (inventory[itemId] ?? 0) + 1;
  return inventory;
}

/** 역할 콘텐츠로 시작 캐릭터를 만든다 (기획서 3.4: 역할 = 초기값 묶음) */
/**
 * 새 캐릭터의 능력: 역할에 정해져 있으면 그것, 아니면 시나리오의 능력 배열을 섞어서 (능력은 계급과 무관, 기획서 4.2).
 * rng가 없으면 섞지 않는다 (테스트·결정적 생성)
 */
export function rollAbilities(s: Scenario, rng?: Rng): Record<string, number> {
  const array = [...(s.ability_array ?? s.stats.map(() => 0))];
  if (rng) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [array[i], array[j]] = [array[j]!, array[i]!];
    }
  }
  return Object.fromEntries(s.stats.map((x, i) => [x.id, array[i] ?? 0]));
}

/** 플레이어가 캐릭터 생성에서 고른 것 (검증은 creation.ts의 checkCharacterChoice) */
export type CharacterChoice = {
  name: string;
  gender: string | null;
  abilities: Record<string, number> | null;
  portrait: string | null;
  /** 트레잇 id. null이면 무작위 (MCP의 "알아서"), 없으면 빈 목록 */
  traits?: string[] | null;
  /** 나이 (12-69). 없으면 시나리오(역할)의 나이 */
  age?: number | null;
  /** 과거 배경 id (12-84). 그 배경의 물건을 지니고, 캐릭터에 남는다 */
  past?: string | null;
  /** 시작 스킬 (12-84, 과거 배경이 기본값을 준다). 없으면 과거 배경의 스킬 */
  skills?: Record<string, number> | null;
  /** 성격 축 값 (12-99). 없으면 성격 트레잇에서 계산한다 */
  persona?: Record<string, number> | null;
  /** 캐릭터 설정 (4.6.4, 12-246). 없으면 없이 */
  settings?: string[] | null;
};

/** 고른 트레잇의 성격 축 합 (-2~2로 자른다, 0인 축은 뺀다) */
function traitPersona(s: Scenario, traits: readonly string[]): Record<string, number> {
  const sum: Record<string, number> = {};
  for (const t of s.traits.filter((x) => traits.includes(x.id))) for (const [axis, v] of Object.entries(t.persona ?? {})) sum[axis] = (sum[axis] ?? 0) + v;
  return Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, Math.max(-2, Math.min(2, v))]).filter(([, v]) => v !== 0));
}

export function createCharacterFromRole(s: Scenario, role: RoleContent, id = "player", rng?: Rng, choice?: CharacterChoice): Character {
  const past = choice?.past ? s.creation?.pasts.find((p) => p.id === choice.past) : undefined;
  // 스킬 (4.2.1): 시나리오의 것 위에 계급·직분이 주는 전문 기술(배운 상태)과 고른 배치(없으면 과거 배경의 것)를 얹는다. 남긴 점수는 스킬 포인트로
  const layout = choice?.skills ?? past?.skills ?? null;
  const { skills, unspent } = startingSkills(s, { rank: role.rank, occupation: role.occupation ?? null }, role.start_skills, layout);
  return createCharacterSchema(s).parse({
    id,
    name: choice?.name.trim() || role.default_name,
    gender: choice?.gender ?? null,
    // 설정이 함께 주는 트레잇 (약에 기대는 비밀 → 진통제 의존, 4.6.4 뒷받침)
    traits: [...new Set([...(choice?.traits ?? []), ...(choice?.settings ?? []).flatMap((id) => s.settings?.items.find((x) => x.id === id)?.backing?.trait ?? [])])],
    // 주인공의 성격 축은 고른 것과 고른 성격 트레잇에서만 (플레이 테스트 12: 비워 두면 id "player"로 뽑혀 모든 판의 첫 주인공이 같은 숨은 성격이었다).
    // 성격 규칙이 없는 월드는 그대로 null
    persona: choice?.persona ?? (s.persona ? traitPersona(s, choice?.traits ?? []) : null),
    settings: choice?.settings ?? [],
    portrait: choice?.portrait ?? null,
    factionId: role.faction,
    rank: role.rank,
    occupation: role.occupation ? { id: role.occupation, standing: 0 } : null,
    age: choice?.age ?? role.age,
    stats: choice?.abilities ?? role.start_stats ?? rollAbilities(s, rng),
    skills,
    skillPoints: unspent,
    past: past ? { id: past.id, label: past.label, summary: past.summary } : null,
    conditions: initialConditions(s),
    // 과거 배경의 물건 중 시나리오가 이미 주는 것은 겹쳐 주지 않는다
    inventory: habitStart(s, choice?.traits ?? [], toInventory([...role.start_inventory, ...(past?.items ?? []).filter((i) => !role.start_inventory.includes(i))])),
    debts: { ...(role.start_debt ?? {}) },
  });
}

/** 버릇 트레잇(12-129)이 있으면 그 아이템을 start만큼 쥐고 시작한다 (가진 것과 합쳐 그만큼까지) */
function habitStart(s: Scenario, traits: string[], inventory: Record<string, number>): Record<string, number> {
  for (const t of s.traits) {
    const h = t.effects.habit;
    if (!h || !h.start || !traits.includes(t.id)) continue;
    const item = h.items[0]!;
    inventory[item] = Math.max(inventory[item] ?? 0, h.start);
  }
  return inventory;
}

/** NPC 프로필로 캐릭터를 만든다. 플레이어와 같은 스키마다 (CLAUDE.md 원칙 6) */
export function createCharacterFromNpc(s: Scenario, npc: NpcContent): Character {
  return createCharacterSchema(s).parse({
    id: npc.id,
    name: npc.name,
    factionId: npc.faction ?? "",
    rank: npc.rank,
    occupation: npc.occupation ? { id: npc.occupation, standing: 0 } : null,
    attraction: npc.attracted_to ?? null,
    menace: npc.menace ?? null,
    age: npc.age,
    stats: npc.stats,
    skills: npc.skills,
    gender: npc.gender ?? null,
    traits: npc.traits,
    settings: npc.settings ?? [],
    // 콘텐츠가 정한 시작 몸 상태 (npc.starts, 플레이 테스트 14)
    conditions: { ...initialConditions(s), ...(npc.starts ?? {}) },
    inventory: toInventory(npc.start_inventory),
    captive: npc.start_captive ?? null,
    away: npc.offstage ?? false,
  });
}

/**
 * 새 세계를 여는 첫 이벤트. 시작 캐릭터, 모든 NPC, 시작 지식을 담는다.
 * customRole을 주면 콘텐츠의 역할 대신 그것으로 시작한다 (자유 시나리오, roleId는 CUSTOM_ROLE_ID)
 */
export function createWorldEvent(
  content: Content,
  roleId: string,
  worldId: string,
  rng?: Rng,
  choice?: CharacterChoice,
  customRole?: RoleContent,
  background?: string[],
  motive?: { id: string; label: string; summary: string } | null,
): GameEvent {
  const role = customRole ?? content.roles[roleId];
  if (!role) throw new Error(`알 수 없는 역할: ${roleId}`);
  const player = { ...createCharacterFromRole(content.scenario, role, "player", rng, choice), ...(motive ? { motive } : {}) };
  const npcs = Object.values(content.npcs).map((npc) => createCharacterFromNpc(content.scenario, npc));

  let no = 0;
  const belief = (fact: string, source: Belief["source"], accuracy: Belief["accuracy"], learnedAt: number = START_TIME): Belief => ({
    id: `b_${++no}`,
    fact,
    source,
    accuracy,
    learnedAt,
  });
  // 자기 자신에 대한 기억(지난 삶·동기·출신)은 세계가 시작되기 전의 일이다: "어제"로 보이지 않게 (플레이 테스트 13)
  const LONG_AGO = START_TIME - 1;
  const beliefs: Record<string, Belief[]> = {};
  const preset = role.beliefs_preset ? content.beliefs[role.beliefs_preset] : undefined;
  beliefs[player.id] = (preset?.beliefs ?? []).map((b) => belief(b.fact, b.source, b.accuracy));
  // 자유 시나리오에서 플레이어가 쓴 지난 삶: 캐릭터 자신의 기억이다 (세계의 사실로 확정되지 않는다)
  for (const fact of background ?? []) beliefs[player.id]!.push(belief(fact, "seen", "approximate", LONG_AGO));
  // 고른 동기도 자기 자신에 대한 기억으로 (12-77)
  if (motive) beliefs[player.id]!.push(belief(`내가 버티는 이유: ${motive.label}. ${motive.summary}`, "seen", "exact", LONG_AGO));
  // 과거 배경도 자기 자신에 대한 기억으로 (12-84)
  if (player.past) beliefs[player.id]!.push(belief(`붕괴 전에 나는 ${josa(player.past.label, "이었다/였다")}. ${player.past.summary}.`, "seen", "exact", LONG_AGO));
  for (const npc of Object.values(content.npcs)) {
    beliefs[npc.id] = [...npc.knows, ...npc.keeps].map((fact) => belief(fact, "seen", "exact"));
  }

  return {
    type: "world_created",
    scenarioId: content.scenario.id,
    worldId,
    // 다른 무작위를 흔들지 않게 맨 끝에 뽑는다
    worldSeed: rng ? Math.floor(rng() * 2 ** 31) : null,
    roleId: customRole ? CUSTOM_ROLE_ID : roleId,
    customRole: customRole ?? null,
    player,
    npcs,
    beliefs,
    // 같은 무리 동료는 처음부터 서로 이름을 안다 (기획서 6.3, 계승과 같은 셈). 역할의 known_npcs(다른 무리의 아는 사람 포함)에 더한다
    // (PT14: 같은 무리 의무실 보조·대원이 known_npcs에 없어 끝까지 "이름 모름")
    known: { [player.id]: [...new Set([...role.known_npcs, ...npcs.filter((n) => !!player.factionId && n.factionId === player.factionId).map((n) => n.id)])] },
    perceived: [...new Set([role.commander, ...(role.squad ?? []), ...(role.squad_mates ?? [])].filter((id): id is string => !!id && npcs.some((n) => n.id === id)))],
  };
}

/** 이만큼(분) 안에 다시 잠들면 앞의 잠과 이어진 한 밤의 잠이다 (플레이 테스트 13) */
export const SLEEP_CHAIN_MINUTES = 60;

/** from에 시작하는 잠이 이어지는 잠의 시작 시각 (이어지지 않으면 from) */
/** since부터 now까지(지난 24시간 안) 잔 시간 (분) */
export function sleptSince(state: { sleepLog?: readonly { from: number; to: number }[] }, since: number, now: number): number {
  const start = Math.max(since, now - MINUTES_PER_DAY);
  return (state.sleepLog ?? []).reduce((n, s) => n + Math.max(0, Math.min(s.to, now) - Math.max(s.from, start)), 0);
}

export function sleepChainStart(state: { lastWokeAt: number | null; lastSleptFrom: number | null }, from: number): number {
  return state.lastWokeAt !== null && state.lastSleptFrom !== null && from >= state.lastWokeAt && from - state.lastWokeAt < SLEEP_CHAIN_MINUTES ? state.lastSleptFrom : from;
}

/** 빠져나간 주인공을 동물 동행이 찾아오기까지 (분) */
export const ANIMAL_FIND_MINUTES = 12 * 60;
