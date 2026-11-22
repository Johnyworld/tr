import { storyletOf } from "../story/storylets.ts";
import { restDays } from "../rules/rest.ts";
import { capturedDuringMission, missionExcuse } from "../rules/blame.ts";
import { heldOf, pausedWhileHeld } from "../rules/held.ts";
import { maskUnknownNames } from "./storyletTools.ts";
import { rankName } from "../game/ranks.ts";
import { describePromotionOffer, offerPromotion } from "./promotion.ts";
import { harmTrack, incapacitatingSymptom} from "../scenario/scenario.ts";
import { infestationOf, worstOverrun } from "../game/infestation.ts";
import { occupationOf } from "../game/occupation.ts";
import { changeStanding } from "./growth.ts";
import { issueArmory, returnArmory } from "./armory.ts";
import { playerCalls } from "../game/acquaintance.ts";
import { assignBuddy, releaseBuddies } from "./companionTools.ts";
import { disciplineOf, hasAccess } from "../game/culture.ts";
import { josa } from "../text.ts";
import { neighbors } from "../sim/war.ts";
import { gainMeritXp } from "./growth.ts";
import { z } from "zod";
import { CHECK_OUTCOME_LABELS } from "../rules/check.ts";
import { moveLabel } from "../scenario/scenario.ts";
import type { Scenario } from "../scenario/schema.ts";
import { ACTIVITY_COSTS, ACTIVITY_LABELS, dayOf, formatDuration, formatTime, MINUTES_PER_DAY } from "../rules/time.ts";
import type { Content, MissionRequirement } from "../content/schemas.ts";
import { baseOf } from "./captivity.ts";
import { whereLabel } from "../rules/place.ts";
import type { GameState } from "../game/state.ts";
import {
  activeMissionOf,
  atMissionPlace,
  evaluateMission,
  isRequirementMet,
  MERIT,
  MISSION_STATUS_LABELS,
  missionStatusLabel,
  MISSION_CHECK_TRIES,
  MISSIONS_PER_DAY,
  pickDailyOffers,
  type MissionInstance,
  commanderOf as commanderIdOf,
} from "../game/missions.ts";
import { defineTool, signed, type ToolContext, type ToolDisplayEvent } from "./toolkit.ts";
import { recordDeed } from "./reputationTools.ts";
import { grantRewards } from "./rewards.ts";
import { itemResource } from "./market.ts";
import { cargoOf, entrustedHeld } from "../rules/entrusted.ts";
import { ownedBy } from "../rules/home.ts";
import { storyTitle } from "./storyletTools.ts";
import { learned } from "../rules/skill.ts";

const resourceLabel = (s: Scenario, id: string) => s.resources.find((r) => r.id === id)?.label ?? id;

/** 요구 조건 한 줄 설명 */
export function describeRequirement(s: Scenario, requirement: MissionRequirement, progress: number, fails = 0): string {
  const done = isRequirementMet(requirement, progress) ? "충족" : "미충족";
  if ("activity" in requirement) {
    return `${ACTIVITY_LABELS[requirement.activity]} ${formatDuration(requirement.minutes)} (지금까지 ${formatDuration(progress)}, ${done})`;
  }
  if ("goal" in requirement) return `${requirement.goal} (${done})`;
  if ("check" in requirement && fails >= MISSION_CHECK_TRIES && progress < 1) return `${moveLabel(s, requirement.check)} 판정 ${CHECK_OUTCOME_LABELS[requirement.min_outcome]} 이상 (${MISSION_CHECK_TRIES}번 빗나가 닫힘)`;
  if ("check" in requirement && fails > 0 && progress < 1) return `${moveLabel(s, requirement.check)} 판정 ${CHECK_OUTCOME_LABELS[requirement.min_outcome]} 이상 (미충족, 빗나감 ${fails}/${MISSION_CHECK_TRIES})`;
  if ("bring" in requirement) return `${resourceLabel(s, requirement.bring)} ${requirement.quantity}개를 구해 와 건네기 (보고할 때 소지품에서 센다)`;
  if ("deliver" in requirement) return `짐 ${requirement.quantity}개를 임무 자리에 넘기기 (${done})`;
  const altIds = (requirement as { alts?: string[] }).alts ?? [];
  const alts = altIds.length ? `(또는 ${altIds.map((m) => moveLabel(s, m)).join("·")})` : "";
  return `${moveLabel(s, requirement.check)}${alts} 판정 ${CHECK_OUTCOME_LABELS[requirement.min_outcome]} 이상 (${done})`;
}

/** 받기 전의 요구 조건 (진행 없이). 플레이 테스트 11: 버티기 판정이 필요한 줄 모르고 받았다 */
function requirementLabel(s: Scenario, requirement: MissionRequirement): string {
  if ("activity" in requirement) return `${ACTIVITY_LABELS[requirement.activity]} ${formatDuration(requirement.minutes)}`;
  if ("goal" in requirement) return requirement.goal;
  if ("bring" in requirement) return `${resourceLabel(s, requirement.bring)} ${requirement.quantity}개 구해 오기`;
  if ("deliver" in requirement) return `짐 ${requirement.quantity}개 넘기기`;
  return `${moveLabel(s, requirement.check)} 판정 ${CHECK_OUTCOME_LABELS[requirement.min_outcome]} 이상`;
}

export function describeMission(s: Scenario, mission: MissionInstance): string {
  const reqs = mission.requirements.map((r, i) => `  - ${describeRequirement(s, r, mission.progress[i] ?? 0, mission.fails?.[i] ?? 0)}`).join("\n");
  const place = mission.place ? `\n  장소: ${mission.place.label}${mission.place.zone ? ` (${mission.place.zone})` : ""} (그 자리에서 한 판정·활동만 임무로 센다)` : "";
  const unseen = mission.unseen ? `\n  - 들키지 않기 (${mission.spotted ? "깨짐: 들켰다. 다른 조건을 채워도 일부 완수까지" : "지키는 중"})` : "";
  return `${mission.title} (id: ${mission.id}, 기한 ${formatTime(mission.deadline)})\n  ${mission.briefing}${place}\n${reqs}${unseen}`;
}

/** 임무 템플릿의 where를 이 판의 장소로 (배정할 때 정해 둔다) */
export function missionPlace(content: Content, where: string | undefined, factionId: string | null): MissionInstance["place"] {
  if (!where) return null;
  const zoneName = (id: string) => content.locations[id]?.name ?? id;
  if (where === "outside") {
    const base = factionId ? baseOf(content, factionId) : undefined;
    return base ? { zone: null, notZone: base, enemyOf: null, label: `${zoneName(base)} 밖` } : null;
  }
  // 거점과 맞닿은 곳 (12-237: 쪽문 밖 발자국을 쫓는데 쪽문 앞에서 한 일은 세지 않았다)
  if (where === "near") {
    const base = factionId ? baseOf(content, factionId) : undefined;
    return base ? { zone: null, notZone: null, enemyOf: null, zones: [base, ...neighbors(content, base)], label: `${josa(zoneName(base), "과/와")} 맞닿은 곳` } : null;
  }
  if (where === "enemy") return factionId ? { zone: null, notZone: null, enemyOf: factionId, label: "적대하는 무리의 땅" } : null;
  return { zone: where, notZone: null, enemyOf: null, label: zoneName(where) };
}

/** 이야기가 열려 있으면 임무를 받거나 보고하기 전에 먼저 받는다 (12-240, A1: 같은 묶음의 보고가 이야기보다 먼저 끝났다) */
function storyOpenError(ctx: ToolContext): string | null {
  const active = ctx.store.getState().activeStorylet;
  if (!active) return null;
  const s = storyletOf(ctx.store.getState(), ctx.content, active.id);
  const title = s ? storyTitle(ctx.store.getState(), ctx.content, s) : active.id;
  return `이야기 "${title}"${josa(title, "이/가").slice(title.length)} 열려 있다. 먼저 장면으로 연출하고 resolve_storylet으로 고르거나, 플레이어가 두고 가기로 했으면 take_action에 ignore_story: true를 넣은 뒤 다시 (시간은 흐르지 않았다).`;
}

/** 플레이어의 직속 상관. 살아 있지 않으면 undefined */
function commanderOf(state: GameState, ctx: ToolContext) {
  const id = commanderIdOf(state, ctx.content);
  const commander = id ? state.characters[id] : undefined;
  return commander && !commander.dead && !commander.away && !heldOf(commander) ? commander : undefined;
}

const assignMission = defineTool({
  name: "assign_mission",
  description:
    "상관이 플레이어 캐릭터에게 오늘의 임무를 내린다. 상관이 장면에 있어야 하고, <상태>의 '오늘 받을 수 있는 임무' 중에서만 고를 수 있다. " +
    "한 번에 하나의 임무만 맡는다. 기한과 해야 할 일은 시스템이 정한다.",
  schema: z.strictObject({
    template_id: z.string().describe("오늘 받을 수 있는 임무의 id"),
  }),
  run(input, ctx) {
    const state = ctx.store.getState();
    const player = state.characters[state.playerId];
    if (!player || player.dead) return { ok: false, error: "사망한 캐릭터는 임무를 받을 수 없습니다." };
    if (pausedWhileHeld(state, "assign")) return { ok: false, error: "갇혀 있어 임무를 받을 수 없다." };
    { const open = storyOpenError(ctx); if (open) return { ok: false, error: open }; }
    const commander = commanderOf(state, ctx);
    if (!commander) return { ok: false, error: "임무를 내릴 상관이 없습니다." };
    if (!state.scene.present.includes(commander.id)) {
      return { ok: false, error: `임무는 상관(${commander.name})이 직접 내린다. 먼저 npc_presence로 등장시키세요.` };
    }
    const current = activeMissionOf(state.missions, player.id);
    if (current) return { ok: false, error: `이미 수행 중인 임무가 있습니다: ${current.title}` };
    if (state.offers?.day !== dayOf(state.time) || !state.offers.templateIds.includes(input.template_id)) {
      return { ok: false, error: `오늘 받을 수 있는 임무가 아닙니다: ${input.template_id}` };
    }
    const template = ctx.content.missions[input.template_id];
    if (!template) return { ok: false, error: `알 수 없는 임무: ${input.template_id}` };
    // 하루에 받을 수 있는 임무 수 (플레이 테스트 11, C3: 하루 셋)
    const today = Object.values(state.missions).filter((m) => m.assigneeId === player.id && dayOf(m.assignedAt) === dayOf(state.time)).length;
    if (today >= MISSIONS_PER_DAY) return { ok: false, error: `오늘은 이미 임무를 ${today}개 받았다 (하루 ${MISSIONS_PER_DAY}개까지). 내일 받는다.` };

    const mission: MissionInstance = {
      id: `m_${state.nextMissionNo}`,
      templateId: template.id,
      // 이름 모르는 사람은 호칭으로 (플레이 테스트 11: "우물지기 탁순례")
      title: maskUnknownNames(state, ctx.content, template.title),
      briefing: maskUnknownNames(state, ctx.content, template.briefing),
      assigneeId: player.id,
      giverId: commander.id,
      assignedAt: state.time,
      deadline: state.time + template.deadline_hours * 60 + travelAllowance(ctx, template.where, player.factionId),
      // 서로 바꿔 쓸 수 있는 판정을 적어 둔다 (교섭 ↔ 위협·거짓말)
      requirements: structuredClone(template.requirements).map((r) => {
        if (!("check" in r)) return r;
        const group = ctx.content.scenario.mission_move_groups.find((g) => g.includes(r.check));
        return group ? { ...r, alts: group.filter((m) => m !== r.check) } : r;
      }),
      place: missionPlace(ctx.content, template.where, player.factionId),
      progress: template.requirements.map(() => 0),
      fails: template.requirements.map(() => 0),
      ...(template.unseen ? { unseen: true } : {}),
      status: "active",
    };
    ctx.store.append({ type: "mission_assigned", mission });
    // 배달 일감의 짐 (F5): 상관이 건넨다
    const cargo = Object.entries(template.carries ?? {});
    for (const [id, q] of cargo) ctx.store.append({ type: "item_granted", to: player.id, itemId: id, quantity: q });
    if (cargo.length) ctx.store.append({ type: "cargo_set", missionId: mission.id, items: Object.fromEntries(cargo) });
    const collects = Object.entries(template.collects ?? {});
    const cargoLine =
      (cargo.length ? `\n짐을 받았다: ${cargo.map(([id, q]) => `${ctx.content.items[id]?.name ?? id} ×${q}`).join(", ")} (맡은 짐이다. 임무 자리에서 일을 하면 넘긴다)` : "") +
      (collects.length ? `\n받아 올 값: ${collects.map(([id, q]) => `${ctx.content.items[id]?.name ?? id} ×${q}`).join(", ")} (${cargo.length ? "짐을 넘기면" : "임무 판정에 성공하면"} 상대가 건넨다. 보고 때 상관에게 넘겨야 완수, 지니지 않았으면 일부 완수)` : "");
    // 2인 1조: 같은 무리 동료 하나가 짝으로 붙는다 (기획서 7.9)
    const buddy = template.buddy ? assignBuddy(ctx, mission.id, commander.id) : null;
    // 작전이면 무기고가 무기·탄약을 빌려준다 (기획서 4.8)
    const armoryLine = issueArmory(ctx, mission);
    const buddyLine = (armoryLine ? `\n${armoryLine}` : "") + (buddy ? `\n짝: ${josa(`${playerCalls(ctx.store.getState(), ctx.content, buddy)}(${buddy})`, "이/가")} 이 임무 동안 함께 다닌다 (2인 1조). 임무가 끝나면 자기 자리로 돌아간다.` : "");
    // 가는 길 (플레이 테스트 11: "남쪽 텃밭"이 어디로 이어지는지 몰라 반나절을 헤맸다)
    const route = mission.place?.zone && state.playerZone ? routeBetween(ctx.content, state.playerZone, mission.place.zone) : null;
    const routeLine = route && route.length > 1 ? `\n가는 길: ${route.map((z) => `${ctx.content.locations[z]?.name ?? z}(${z})`).join(" → ")}` : mission.place?.zone && route === null ? "\n가는 길: 지금 아는 길로는 닿지 않는다" : "";
    return {
      ok: true,
      resultText:
        `임무 배정: ${describeMission(ctx.content.scenario, mission)}${routeLine}${buddyLine}${cargoLine}\n` +
        `상관(${playerCalls(state, ctx.content, commander.id)})이 임무를 지시하는 장면을 서술하라. 해야 할 일과 기한(대략적인 표현으로)을 상관의 말투로 전한다. 보고도 이 사람에게 한다.`,
      display: { type: "mission", event: "assigned", title: mission.title, detail: `기한 ${formatTime(mission.deadline)}` },
    };
  },
});

/** 채우지 못한 결과 조건 (일부 완수·실패의 까닭을 보인다) */
function unmetLines(s: Scenario, mission: MissionInstance): string[] {
  const unmet = mission.requirements.filter((r, i) => !isRequirementMet(r, mission.progress[i] ?? 0));
  return unmet.length ? [`채우지 못한 것: ${unmet.map((r) => requirementLabel(s, r)).join(" · ")}`] : [];
}

const reportMission = defineTool({
  name: "report_mission",
  description:
    "플레이어 캐릭터가 수행 중인 임무를 상관에게 보고한다. 상관이 장면에 있어야 한다. " +
    "결과(완수·일부 완수·실패)와 공적은 지금까지 실제로 한 일(시간 소비·판정)로 시스템이 판정한다. 플레이어의 말로 결과가 바뀌지 않는다. " +
    "다시 해 볼 수 있는 판정 조건이 남았으면 한 번 되묻는다: 그래도 보고하면 final: true.",
  schema: z.strictObject({
    final: z.boolean().default(false).describe("다시 해 볼 수 있는 조건이 남았는데도 지금 보고하면 true (플레이어가 그만두기로 했을 때)"),
  }),
  run(input, ctx) {
    const state = ctx.store.getState();
    const mission = activeMissionOf(state.missions, state.playerId);
    if (!mission) return { ok: false, error: "수행 중인 임무가 없습니다." };
    { const open = storyOpenError(ctx); if (open) return { ok: false, error: open }; }
    // 다시 해 볼 수 있는 판정이 남았으면 한 번 되묻는다 (12-240, A4: 빗나감 1/3에서 바로 보고해 일부 완수가 쌓이고 진급이 막혔다)
    if (!input.final && state.time < mission.deadline) {
      const retry = mission.requirements
        .map((r, i) => ({ r, i }))
        .filter(({ r, i }) => "check" in r && !isRequirementMet(r, mission.progress[i] ?? 0) && (mission.fails?.[i] ?? 0) < MISSION_CHECK_TRIES)
        .map(({ r, i }) => `${requirementLabel(ctx.content.scenario, r)} (빗나감 ${mission.fails?.[i] ?? 0}/${MISSION_CHECK_TRIES})`);
      if (retry.length) {
        const left = Math.round((mission.deadline - state.time) / 60);
        return { ok: false, error: `아직 다시 해 볼 수 있다: ${retry.join(" · ")}, 기한까지 약 ${left}시간. 플레이어가 그만두고 보고하기로 했으면 final: true로 다시 (시간은 흐르지 않았다).` };
      }
    }
    const giver = state.characters[mission.giverId];
    if (!giver || !state.scene.present.includes(giver.id)) {
      return { ok: false, error: `보고는 임무를 준 ${giver?.name ?? "상관"}에게 직접 한다. 먼저 npc_presence로 등장시키세요.` };
    }

    // 찾아오기 (플레이 테스트 11): 지닌 물건 가운데 그 자원에 속하는 것을 상관에게 건넨다. 모자라면 건네지 않고 미충족
    const handed: string[] = [];
    mission.requirements.forEach((r, i) => {
      if (!("bring" in r) || isRequirementMet(r, mission.progress[i] ?? 0)) return;
      const inv = ctx.store.getState().characters[state.playerId]!.inventory;
      const matching = Object.entries(inv).filter(([id, q]) => q > 0 && itemResource(ctx.content, id) === r.bring);
      if (matching.reduce((n, [, q]) => n + q, 0) < r.quantity) return;
      let left = r.quantity;
      for (const [id, q] of matching) {
        if (left <= 0) break;
        const take = Math.min(q, left);
        // 상관 개인 소지품이 아니라 무리 창고 몫이다 (플레이 테스트 13: 조장 주머니에 붕대가 쌓였다). 창고의 셈은 아래 supplies가 한다
        ctx.store.append({ type: "item_consumed", holder: state.playerId, itemId: id, quantity: take });
        handed.push(`${ctx.content.items[id]?.name ?? id} ×${take}`);
        left -= take;
      }
      ctx.store.append({ type: "mission_requirement_met", missionId: mission.id, index: i });
    });
    // 맡은 짐·받아 온 값은 상관에게 넘긴다 (공통 규칙 10). 받아 올 값이 모자라면 일부 완수까지 (12-237)
    const returned: string[] = [];
    const toCollect = ctx.content.missions[mission.templateId]?.collects ?? {};
    let short = false;
    for (const [id, q] of Object.entries(cargoOf(ctx.store.getState(), mission.id))) {
      const give = Math.min(q, ctx.store.getState().characters[state.playerId]!.inventory[id] ?? 0);
      if (give > 0) {
        ctx.store.append({ type: "item_consumed", holder: state.playerId, itemId: id, quantity: give });
        returned.push(`${ctx.content.items[id]?.name ?? id} ×${give}`);
      }
      if (toCollect[id] && give < q) short = true;
    }
    ctx.store.append({ type: "cargo_set", missionId: mission.id, items: {} });
    const reported = ctx.store.getState().missions[mission.id]!;
    const result = evaluateMission(reported, state.time, short);
    ctx.store.append({ type: "mission_reported", missionId: mission.id, ...result });
    // 완수는 상관이 보고로 확인한 성실함으로 남는다 (관계 변화는 상관의 가치관으로 계산).
    // 판정이 걸린 임무(위험한 일)를 다 해냈을 때만 상관의 믿음과 존중이 오른다. 시간만 채우는 보초·일부 완수는 오르지 않는다 (플레이 테스트 13: 신뢰가 13일 내내 0이라 진급이 막혔다)
    const risky = reported.requirements.some((r) => "check" in r);
    if (result.outcome === "success" && risky) {
      // 상관은 그 자리에 없었다. 보고로 듣는다 (플레이 테스트 11: 다른 구역에서 한 일이 "직접 봄"으로 남았다)
      recordDeed(
        ctx,
        { summary: `임무 완수: ${mission.title}`, tags: ["diligence"], severity: 1, privacy: "public", noisy: false },
        // 하루 한 사람 축마다 +1까지라 빠르게 쌓이지는 않는다 (플레이 테스트 11, C6에서 존중만으로 줄였던 것을 13에서 되돌림)
        { npcId: giver.id, source: "report", only: ["trust", "respect"] },
      );
    }
    // 빚 갚는 일감: 임무를 준 무리에 진 빚이 준다 (기획서 9.10)
    const repay = ctx.content.missions[mission.templateId]?.repays_debt;
    const lender = giver.factionId;
    const owed = ctx.store.getState().characters[mission.assigneeId]?.debts[lender] ?? 0;
    let repaid = 0;
    if (repay && owed > 0 && result.outcome !== "failed") {
      repaid = Math.min(owed, result.outcome === "success" ? repay : Math.max(1, Math.trunc(repay / 2)));
      ctx.store.append({ type: "debt_changed", characterId: mission.assigneeId, factionId: lender, delta: -repaid });
    }
    // 전선 임무는 우리 무리의 계획(세력 클락)을 앞당긴다. 일부 완수는 절반
    const advances = ctx.content.missions[mission.templateId]?.advances;
    if (advances && ctx.store.getState().clocks[advances.clock] && result.outcome !== "failed") {
      const delta = result.outcome === "success" ? advances.delta : Math.trunc(advances.delta / 2);
      if (delta !== 0) ctx.store.append({ type: "clock_adjusted", clockId: advances.clock, delta });
    }
    // 담을 메우는 일감은 그 무리 거점을 보강한다 (12-48)
    const fortifies = ctx.content.missions[mission.templateId]?.fortifies;
    const base = Object.values(ctx.content.locations).find((l) => l.owner === lender && l.kind === "base")?.id;
    const fortSteps = fortifies ? (result.outcome === "success" ? fortifies : result.outcome === "partial" ? Math.trunc(fortifies / 2) : 0) : 0;
    if (fortSteps > 0 && base && ownedBy(ctx.store.getState(), base, lender)) ctx.store.append({ type: "zone_fortified", zone: base, delta: fortSteps });
    // 소탕 일감은 그 무리 땅에서 감염체가 가장 많이 몰려든 곳을 쓸어 낸다 (12-120). 일부 완수는 절반
    const clears = ctx.content.missions[mission.templateId]?.clears;
    const clearSteps = clears ? (result.outcome === "success" ? clears : result.outcome === "partial" ? Math.trunc(clears / 2) : 0) : 0;
    let cleared: string | null = null;
    const worst = clearSteps > 0 ? worstOverrun(ctx.content, ctx.store.getState(), lender) : null;
    if (worst) {
      const now = infestationOf(ctx.content, ctx.store.getState(), worst.zone);
      ctx.store.append({ type: "infestation_changed", zone: worst.zone, level: Math.max(0, now - clearSteps), cause: "소탕" });
      cleared = ctx.content.locations[worst.zone]?.name ?? worst.zone;
    }
    // 수색·채집 일감은 구해 온 몫이 그 무리 창고로 들어간다. 일부 완수는 절반
    const supplied: string[] = [];
    const supplies = ctx.content.missions[mission.templateId]?.supplies;
    // 같이 나선 사람(임무 짝)이 있거나 구해 온 것을 건넸을 때만 (플레이 테스트 12: 혼자 빈손으로 왔는데 창고가 늘었다)
    // 건네기 조건이 있는 일감도 실제로 건넨 것이 있어야 한다 (플레이 테스트 13: 빈손 일부 완수에 창고가 늘었다)
    const party = Object.values(ctx.store.getState().bonds ?? {}).some((b) => b.kind === "buddy" && b.missionId === mission.id) || handed.length > 0;
    if (supplies && party && result.outcome !== "failed" && ctx.store.getState().factions[lender]) {
      for (const [resource, amount] of Object.entries(supplies)) {
        const delta = result.outcome === "success" ? amount! : Math.trunc(amount! / 2);
        if (delta <= 0) continue;
        ctx.store.append({ type: "faction_resource_changed", factionId: lender, resource, delta });
        supplied.push(ctx.content.scenario.resources.find((r) => r.id === resource)?.label ?? resource);
      }
    }
    // 직분의 일감을 해내면 직분의 평판이 오른다 (기획서 12.6)
    const occ = occupationOf(ctx.content, ctx.store.getState().characters[mission.assigneeId]);
    const occNote = occ?.missions.includes(mission.templateId) && result.outcome === "success" ? changeStanding(ctx, mission.assigneeId, 1, `일감: ${mission.title}`) : null;
    // 완수하면 알게 되는 것 (12-237)
    const learns = result.outcome === "success" ? ctx.content.missions[mission.templateId]?.learns : undefined;
    if (learns) {
      const now = ctx.store.getState();
      ctx.store.append({ type: "belief_added", characterId: mission.assigneeId, belief: { id: `b_${now.nextBeliefNo}`, fact: learns, source: "seen", accuracy: "exact", learnedAt: now.time } });
    }
    const label = MISSION_STATUS_LABELS[result.outcome === "success" ? "completed" : result.outcome];
    const lines = [
      `임무 보고: ${mission.title} — ${label}${result.late ? " (기한을 넘겨 보고)" : ""}. 공적 ${signed(result.merit)}.${repaid ? ` 빚을 갚았다 (장부에서 ${repaid} 줄었다).` : ""}`,
      ...(handed.length ? [`구해 온 것을 상관에게 건넸다: ${handed.join(", ")}`] : []),
      ...(returned.length ? [`맡은 짐·받아 온 값을 상관에게 넘겼다: ${returned.join(", ")}`] : []),
      ...(learns ? [`알게 된 것 (임무로 확인했다, 상관에게도 보고했다): ${learns}`] : []),
      ...(short ? ["받아 올 값이 모자라 일부 완수까지다."] : []),
      ...unmetLines(ctx.content.scenario, reported),
      ...(supplies && !party && result.outcome !== "failed" ? ["혼자 나간 일이라 무리 창고에 따로 든 것은 없다. 찾은 것은 소지품에 그대로 있다."] : []),
      `상관(${giver.name})이 결과에 맞게 반응하는 장면을 서술하라.`,
      // 주인공이 실제로 찾은 물건과는 따로 셈한다 (플레이 테스트 11: 약을 못 찾았는데 "구해 온 의약품"이라고 했다)
      ...(supplied.length
        ? [
            mission.requirements.some((r) => "bring" in r)
              ? `이 일감의 몫으로 무리 창고의 ${josa(supplied.join("·"), "이/가")} 조금 늘었다 (건넨 것과 같이 나선 사람들의 몫까지 장부에 셈한 것).`
              : `이 일감의 몫으로 무리 창고의 ${josa(supplied.join("·"), "이/가")} 조금 늘었다 (같이 나선 사람들의 몫까지 장부에 셈한 것. 주인공이 찾은 물건은 소지품에 그대로 있고, 내놓을지는 플레이어가 정한다).`,
          ]
        : []),
      ...(cleared ? [`${cleared}에 몰려든 감염체를 쓸어 냈다. 한동안 조용할 것이다.`] : []),
      ...releaseBuddies(ctx, mission.id),
      ...[returnArmory(ctx, mission.id, { excused: capturedDuringMission(ctx.store.getState(), mission) })].filter((l): l is string => !!l),
      ...(occNote ? [occNote] : []),
    ];
    const growthNote = gainMeritXp(ctx, mission.assigneeId, result.merit);
    if (growthNote) lines.push(growthNote);
    // 포상 (12-171): 공적이 무리의 포상 문턱을 새로 넘으면
    if (result.merit > 0) lines.push(...grantRewards(ctx, mission.assigneeId, giver.id));

    const after = ctx.store.getState();
    const player = after.characters[after.playerId]!;
    const extra: ToolDisplayEvent[] = [];
    const commander = commanderOf(after, ctx);
    const commanderTrust = commander ? (after.relations[commander.id]?.[player.id]?.trust ?? 0) : null;
    // 진급은 제안으로 (12-190): 받을지는 플레이어가 정한다 (promotion accept·decline)
    const offered = offerPromotion(ctx, commanderTrust);
    if (offered) lines.push(offered);
    return {
      ok: true,
      resultText: lines.join("\n"),
      display: { type: "mission", event: "reported", title: mission.title, detail: label, merit: result.merit },
      extra,
    };
  },
});

const abandonMission = defineTool({
  name: "abandon_mission",
  description:
    "플레이어 캐릭터가 수행 중인 임무를 거부하거나 포기한다. 무리의 규율에 따라 불복종으로 기록되고 공적이 깎인다 (자유로운 무리면 불이익이 적거나 없다). " +
    "플레이어가 분명히 임무를 거부·포기하는 행동을 할 때만 쓴다.",
  schema: z.strictObject({
    reason: z.string().min(1).max(200).describe("포기한 사정 한 문장"),
  }),
  run(input, ctx) {
    const state = ctx.store.getState();
    const mission = activeMissionOf(state.missions, state.playerId);
    if (!mission) return { ok: false, error: "수행 중인 임무가 없습니다." };
    const d = disciplineOf(ctx.content, state.characters[state.playerId]?.factionId);
    ctx.store.append({ type: "mission_abandoned", missionId: mission.id, merit: d.abandonMerit, reason: input.reason, disobedience: d.countsDisobedience });
    if (d.deedSeverity > 0) {
      recordDeed(
        ctx,
        { summary: `임무 포기: ${mission.title} (${input.reason})`, tags: ["disobedience"], severity: d.deedSeverity, privacy: "public", noisy: false },
        { npcId: mission.giverId, source: state.scene.present.includes(mission.giverId) ? "seen" : "report" },
      );
    }
    const label = d.countsDisobedience ? "불복종" : "포기";
    return {
      ok: true,
      resultText:
        `임무 포기: ${mission.title}. 이 무리(규율: ${d.label})에서 ${josa(d.orderWord, "을/를")} 버린 것이다. ` +
        (d.countsDisobedience ? "불복종으로 기록되고 " : "불복종으로 치지는 않고 ") +
        `공적 ${signed(d.abandonMerit)}. ` +
        (d.deedSeverity > 0 ? "이 일은 상관과 동료의 시선에 영향을 줄 수 있다." : "이 무리에서는 크게 문제 삼지 않는다.") +
        releaseBuddies(ctx, mission.id).map((l) => ` ${l}`).join("") +
        ((r) => (r ? ` ${r}` : ""))(returnArmory(ctx, mission.id, { excused: capturedDuringMission(state, mission) })),
      display: { type: "mission", event: "abandoned", title: mission.title, detail: `포기 (${label})`, merit: d.abandonMerit },
    };
  },
});

/**
 * 기한에 얹는 오가는 시간 (플레이 테스트 12: 첫 임무가 이동 + 4시간 보초 + 빗나감으로 기한을 넘겨 진급이 막혔다).
 * 지금 구역에서 임무 자리까지 가장 짧은 길의 구역 수 × 이동 한 번의 가장 긴 시간, 오가는 것으로 두 배
 */
function travelAllowance(ctx: ToolContext, where: string | null | undefined, factionId: string | null): number {
  const state = ctx.store.getState();
  const start = state.playerZone;
  const place = missionPlace(ctx.content, where ?? undefined, factionId);
  if (!start || !place) return 0;
  const probe = { place } as MissionInstance;
  const seen = new Set([start]);
  let frontier = [start];
  for (let hops = 0; hops <= Object.keys(ctx.content.locations).length; hops++) {
    if (frontier.some((z) => atMissionPlace(probe, z, state.zones, state.factions))) return hops * 2 * ACTIVITY_COSTS.travel.max;
    // 맞닿음은 한쪽에만 적혀 있을 수 있어 neighbors로 (플레이 테스트 13: 진료소에서 강변까지 오가는 시간이 0이었다)
    frontier = frontier.flatMap((z) => neighbors(ctx.content, z)).filter((z) => !seen.has(z) && seen.add(z));
    if (!frontier.length) return 0;
  }
  return 0;
}

/** 최근 사흘 안에 주인공이 받은 일감 (같은 일감이 되풀이되지 않게, 플레이 테스트 13) */
function recentTemplates(state: GameState, content: Content): string[] {
  const since = state.time - restDays(content, "mission") * MINUTES_PER_DAY;
  return Object.values(state.missions).filter((m) => m.assigneeId === state.playerId && m.assignedAt >= since).map((m) => m.templateId);
}

export const MISSION_TOOLS = [assignMission, reportMission, abandonMission] as const;

/** 임무를 준 사람의 무리가 맡은 사람의 무리와 달라졌는가 (주인공이 무리를 옮겼거나, 상관이 옮겼다) */
function leftBehind(state: GameState, mission: MissionInstance): boolean {
  const giver = state.characters[mission.giverId];
  const assignee = state.characters[mission.assigneeId];
  return !!giver && !!assignee && (giver.factionId ?? "") !== (assignee.factionId ?? "");
}

/**
 * 무리를 떠나면 예전 무리의 임무는 거기서 끝난다 (플레이 테스트 14, 방문자 T51~T63: 청솔 심부름이 붉은연합에 든 뒤에도 남아 새 임무를 막았고,
 * 보고는 적이 된 상관에게만 할 수 있었고, 조건을 다 채운 임무라 기한이 지나도 끝나지 않았고, 포기하자 붉은연합 군율의 불복종·공적 -3이 됐다).
 * 지금 무리의 공적·불복종에는 넣지 않는다 (공적 0, 불복종 아님). 준 무리의 규율이 문제 삼으면 준 상관에게 행적으로만 남는다
 * (조건을 다 채운 임무, 턴 시작에 찾은 임무는 행적을 남기지 않는다). 빌린 장비는 거둬들이되 잃은 것을 탓하지 않는다.
 * 무리를 옮기기 직전(join_faction·expel)에 부르면 지금 수행 중인 임무를 모두, 턴 시작에는 무리가 달라진 임무만 끝낸다.
 */
export function leaveMissionsBehind(ctx: ToolContext, onlyLeftBehind = false): { lines: string[]; displays: ToolDisplayEvent[] } {
  const state = ctx.store.getState();
  const lines: string[] = [];
  const displays: ToolDisplayEvent[] = [];
  const list = Object.values(state.missions).filter((m) => m.status === "active" && m.assigneeId === state.playerId && (!onlyLeftBehind || leftBehind(state, m)));
  for (const mission of list) {
    const from = state.characters[mission.giverId]?.factionId || null;
    const name = from ? (ctx.content.factions[from]?.name ?? from) : "예전 무리";
    ctx.store.append({ type: "mission_expired", missionId: mission.id, merit: 0, disobedience: false, excused: `무리를 떠나 끝남 (${name})` });
    const d = disciplineOf(ctx.content, from);
    // 턴 시작에 찾은 것은 누가 옮겼는지 모르니(상관이 옮겼을 수도) 행적을 남기지 않는다
    if (!onlyLeftBehind && d.deedSeverity > 0 && mission.metAt === undefined) {
      recordDeed(
        ctx,
        { summary: `${name}의 임무를 마치지 않고 무리를 떠났다: ${mission.title}`, tags: ["disobedience"], severity: d.deedSeverity, privacy: "semi_private", noisy: false },
        { npcId: mission.giverId, source: "report" },
      );
    }
    const returned = returnArmory(ctx, mission.id, { excused: true });
    // 빌린 장비는 무리를 떠나기 전에 돌려준다 (사용자 결정): GM은 반납하는 장면을 짧게 연출한다
    const tail = [returned ? `${returned} (떠나기 전에 빌린 장비를 무기고에 돌려주는 장면을 짧게 서술한다)` : null, ...releaseBuddies(ctx, mission.id)].filter((l): l is string => !!l);
    lines.push(`${name}에서 받은 임무 "${mission.title}"는 거기서 끝났다 (예전 무리의 기록으로만 남고, 지금 무리의 공적·불복종에는 들지 않는다).${tail.map((l) => ` ${l}`).join("")}`);
    displays.push({ type: "mission", event: "expired", title: mission.title, detail: "무리를 떠나 끝남", merit: 0 });
  }
  return { lines, displays };
}

/**
 * 임무의 턴 시작 처리 (코드가 하는 일, AI 요청 없음).
 * - 기한이 지난 임무는 기한 초과(명령 불이행)로 끝낸다
 * - 날이 바뀌면 상관이 오늘의 임무 후보를 정한다
 */
export function runMissionStartOfTurn(ctx: ToolContext): ToolDisplayEvent[] {
  const displays: ToolDisplayEvent[] = [];
  // 무리가 달라진 채 남은 임무 (예전 세이브, 상관이 무리를 옮김): 벌 없이 끝낸다 (플레이 테스트 14)
  displays.push(...leaveMissionsBehind(ctx, true).displays);
  const state = ctx.store.getState();
  for (const mission of Object.values(state.missions)) {
    // 앞 주인공의 임무 (계승 뒤): 조용히 끝낸다. 지금 주인공에게 불복종·행적·장비 반납을 묻지 않는다 (플레이 테스트 8)
    if (mission.status === "active" && mission.assigneeId !== state.playerId) {
      ctx.store.append({ type: "mission_expired", missionId: mission.id, merit: 0, disobedience: false });
      continue;
    }
    // 조건을 기한 안에 다 채운 임무는 기한이 지나도 끝내지 않는다: 보고하면 된다 (플레이 테스트 13: 3시간 보초를 기한 안에 채웠는데 4시간 활동이 끝난 뒤라 기한 초과)
    if (mission.status === "active" && mission.metAt !== undefined && mission.metAt <= mission.deadline) continue;
    // 탓할 수 없는 까닭이 있으면 불복종이 아니다 (공통 규칙 2, rules/blame.ts)
    const excuse = mission.status === "active" && state.time > mission.deadline ? missionExcuse(state, ctx.content, mission) : null;
    if (excuse) {
      ctx.store.append({ type: "mission_expired", missionId: mission.id, merit: 0, disobedience: false, excused: excuse.label });
      displays.push({ type: "mission", event: "expired", title: mission.title, detail: excuse.label, merit: 0 });
      // 붙잡혀 빼앗긴 장비는 잃어버린 것으로 치지 않는다
      returnArmory(ctx, mission.id, { excused: excuse.cause === "captured" });
      releaseBuddies(ctx, mission.id);
      continue;
    }
    if (mission.status === "active" && state.time > mission.deadline) {
      const d = disciplineOf(ctx.content, state.characters[mission.assigneeId]?.factionId);
      ctx.store.append({ type: "mission_expired", missionId: mission.id, merit: d.expireMerit, disobedience: d.countsDisobedience });
      if (d.deedSeverity > 0) {
        recordDeed(
          ctx,
          { summary: `임무 기한 초과: ${mission.title}`, tags: ["disobedience"], severity: d.deedSeverity, privacy: "public", noisy: false },
          { npcId: mission.giverId, source: "report" },
        );
      }
      displays.push({ type: "mission", event: "expired", title: mission.title, detail: `기한 초과${d.countsDisobedience ? " (불복종)" : ""}`, merit: d.expireMerit });
      // 기한이 지나도 빌린 장비는 거둬들인다
      returnArmory(ctx, mission.id);
      releaseBuddies(ctx, mission.id);
    }
  }
  // 오래된 불복종은 하나씩 지워진다 (C8): 마지막 불복종(또는 지운 때)에서 FORGIVE_DAYS가 지나면 하나
  const me0 = ctx.store.getState().characters[state.playerId];
  if (me0 && me0.disobedience > 0 && state.time - (ctx.store.getState().disobedienceAt[me0.id] ?? state.runStartedAt) >= DISOBEDIENCE_FORGIVE_DAYS * MINUTES_PER_DAY) {
    ctx.store.append({ type: "disobedience_forgiven", characterId: me0.id });
  }
  if (commanderOf(state, ctx) && hasAccess(ctx.content, state, "mission_board")) {
    const occ = occupationOf(ctx.content, state.characters[state.playerId]);
    const me = state.characters[state.playerId];
    const overrun = !!me?.factionId && !!worstOverrun(ctx.content, state, me.factionId);
    // 진급하면 같은 무리에서 그 계급으로 시작하는 역할의 일감도 받는다 (플레이 테스트 11, G3: 나루상단 분대장에게 "신병 훈련·총기 손질"만 나왔다)
    const startRank = ctx.content.roles[state.roleId]?.rank;
    const rankRole = me && me.rank !== startRank ? Object.values(ctx.content.roles).find((r) => r.faction === me.factionId && r.rank === me.rank) : undefined;
    const extra = [...(occ?.missions ?? []), ...(rankRole?.missions ?? [])];
    // 막 들어온 유예 동안이나 중상 이상이면 위험 임무를 내지 않는다 (12-239, 플레이 테스트 13: 입단 첫날 적 땅 털기, 중상인 부하에게 보급 털기)
    const harm = harmTrack(ctx.content.scenario);
    const unfitFrom = ctx.content.scenario.mission_unfit_from;
    const at = (lv: string | undefined) => harm.levels.findIndex((l) => l.id === lv);
    const unfit = !!me && !!unfitFrom && at(me.conditions[harm.id]) >= at(unfitFrom) && at(unfitFrom) >= 0;
    const safeOnly = (state.missionGraceUntil ?? 0) > state.time || unfit;
    const offers = pickDailyOffers(ctx.content, state.roleId, state.time, state.offers?.day ?? null, ctx.rng, extra, overrun, { factionId: me?.factionId ?? null, owners: state.zones }, me?.rank, (move) => !me || learned(ctx.content.scenario, me.skills, move) !== null, recentTemplates(state, ctx.content), safeOnly);
    if (offers) ctx.store.append({ type: "missions_offered", ...offers });
  }
  return displays;
}

/** 불복종 하나가 지워지는 날 수 (C8) */
export const DISOBEDIENCE_FORGIVE_DAYS = 7;

/** GM에게 보여 줄 임무 상황 */
export function describeMissionsForGm(state: GameState, ctx: Pick<ToolContext, "content">): string {
  const player = state.characters[state.playerId];
  if (!player) return "";
  const active = activeMissionOf(state.missions, player.id);
  // 무소속은 복무·공적·불복종이 없다
  // 무리에 들 때 맡은 일 (플레이 테스트 11: "버들마을 경비병"으로 들었는데 복무 줄은 "정찰대원"뿐이었다)
  const joinedAs = state.customRole && player.factionId && state.customRole.rank === player.rank && !state.customRole.label.includes(rankName(ctx.content, player.factionId, player.rank)) ? ` (맡은 일: ${state.customRole.label})` : "";
  const lines = [player.factionId ? `복무: ${rankName(ctx.content, player.factionId, player.rank)}${joinedAs} · 공적 ${player.merit} · 임무 불복종 ${player.disobedience}회` : `무소속 (${rankName(ctx.content, player.factionId, player.rank)}). 상관·임무·배급이 없다. 먹을 것은 지닌 것과 수색으로 구한다`];
  // 상관이 지금 어디 있는지 (12-253, PT15 분대장: 보급 창고에 있을 상관을 교무실에 불러 임무를 받았다)
  const boss = player.factionId ? commanderIdOf(state, ctx.content) : null;
  const bossAt = boss ? whereLabel(state, ctx.content, boss) : null;
  if (boss && bossAt) lines.push(`상관 ${playerCalls(state, ctx.content, boss)}(${boss}): 지금 ${bossAt}`);
  const offer = describePromotionOffer(ctx.content, state);
  if (offer) lines.push(offer);
  if (active) {
    lines.push(`수행 중인 임무 (보고는 상관에게 report_mission):\n${describeMission(ctx.content.scenario, active)}`);
    // 남은 시간만 서는 길 (12-255, PT15 섬: 30분 더 서려다 다음 시간대까지 7시간을 섰다)
    const left = active.requirements.flatMap((r, i) => ("activity" in r && r.minutes > (active.progress[i] ?? 0) ? [`${ACTIVITY_LABELS[r.activity]} ${formatDuration(r.minutes - (active.progress[i] ?? 0))}`] : []));
    if (left.length) lines.push(`남은 시간: ${left.join(", ")}. for_mission으로 그 활동을 until·hours 없이 걸면 남은 만큼만 한다`);
    // 지금 지닌 것만 (플레이 테스트 13: 붙잡혀 다 빼앗겼는데 빌린 것 줄이 그대로 남았다). 남의 물건은 공통 규칙 10
    const held = entrustedHeld(state, active.id);
    const list = (xs: [string, number][]) => xs.map(([id, q]) => `${ctx.content.items[id]?.name ?? id} ×${q}`).join(", ");
    if (held.loan.length) lines.push(`무기고에서 빌린 것 (임무가 끝나면 반납): ${list(held.loan)}`);
    if (held.cargo.length) lines.push(`맡은 짐 (내 것이 아니다. 임무 자리에서 넘기거나 보고 때 상관에게 넘긴다): ${list(held.cargo)}`);
  } else if (heldOf(player)) {
    // 갇혀 있으면 임무를 받을 수 없다 (플레이 테스트 12: 갇힌 상태 화면에 오늘의 임무가 그대로 보였다)
    lines.push("갇혀 있어 임무를 받을 수 없다");
  } else if (state.offers?.day === dayOf(state.time) && state.offers.templateIds.length > 0) {
    const offers = state.offers.templateIds
      .map((id) => ctx.content.missions[id])
      .filter((m) => m !== undefined)
      .map((m) => `  - ${m.id}: ${maskUnknownNames(state, ctx.content, m.title)} — ${maskUnknownNames(state, ctx.content, m.briefing)}\n    해야 할 일: ${m.requirements.map((r) => requirementLabel(ctx.content.scenario, r)).join(" · ")}`);
    lines.push(`오늘 받을 수 있는 임무 (상관이 장면에 있을 때 assign_mission):\n${offers.join("\n")}`);
  } else {
    lines.push("수행 중인 임무 없음");
  }
  const ended = Object.values(state.missions).filter((m) => m.status !== "active" && m.assigneeId === state.playerId).slice(-3);
  if (ended.length > 0) {
    lines.push(`최근 임무: ${ended.map((m) => `${m.title}(${missionStatusLabel(m)})`).join(", ")}`);
  }
  return lines.join("\n");
}

/** 두 구역 사이의 가장 짧은 길 (맞닿은 구역으로만). 없으면 null */
function routeBetween(content: ToolContext["content"], from: string, to: string): string[] | null {
  if (from === to) return [from];
  const prev = new Map<string, string>([[from, from]]);
  const queue = [from];
  while (queue.length) {
    const z = queue.shift()!;
    for (const n of neighbors(content, z)) {
      if (prev.has(n)) continue;
      prev.set(n, z);
      if (n === to) {
        const path = [to];
        while (path[0] !== from) path.unshift(prev.get(path[0]!)!);
        return path;
      }
      queue.push(n);
    }
  }
  return null;
}
