import { playerCalls } from "../game/acquaintance.ts";
import { assignBuddy, releaseBuddies } from "./companionTools.ts";
import { disciplineOf, hasAccess } from "../game/culture.ts";
import { josa } from "../text.ts";
import { gainMeritXp } from "./growth.ts";
import { z } from "zod";
import { CHECK_OUTCOME_LABELS } from "../rules/check.ts";
import { moveLabel, rankLabel } from "../scenario/scenario.ts";
import type { Scenario } from "../scenario/schema.ts";
import { ACTIVITY_LABELS, dayOf, formatDuration, formatTime } from "../rules/time.ts";
import type { MissionRequirement } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import {
  activeMissionOf,
  checkPromotion,
  evaluateMission,
  isRequirementMet,
  MERIT,
  MISSION_STATUS_LABELS,
  pickDailyOffers,
  type MissionInstance,
  commanderOf as commanderIdOf,
} from "../game/missions.ts";
import { defineTool, signed, type ToolContext, type ToolDisplayEvent } from "./toolkit.ts";
import { recordDeed } from "./reputationTools.ts";

/** 요구 조건 한 줄 설명 */
export function describeRequirement(s: Scenario, requirement: MissionRequirement, progress: number): string {
  const done = isRequirementMet(requirement, progress) ? "충족" : "미충족";
  if ("activity" in requirement) {
    return `${ACTIVITY_LABELS[requirement.activity]} ${formatDuration(requirement.minutes)} (지금까지 ${formatDuration(progress)}, ${done})`;
  }
  return `${moveLabel(s, requirement.check)} 판정 ${CHECK_OUTCOME_LABELS[requirement.min_outcome]} 이상 (${done})`;
}

export function describeMission(s: Scenario, mission: MissionInstance): string {
  const reqs = mission.requirements.map((r, i) => `  - ${describeRequirement(s, r, mission.progress[i] ?? 0)}`).join("\n");
  return `${mission.title} (id: ${mission.id}, 기한 ${formatTime(mission.deadline)})\n  ${mission.briefing}\n${reqs}`;
}

/** 플레이어의 직속 상관. 살아 있지 않으면 undefined */
function commanderOf(state: GameState, ctx: ToolContext) {
  const id = commanderIdOf(state, ctx.content);
  const commander = id ? state.characters[id] : undefined;
  return commander && !commander.dead && !commander.away && !commander.captive ? commander : undefined;
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

    const mission: MissionInstance = {
      id: `m_${state.nextMissionNo}`,
      templateId: template.id,
      title: template.title,
      briefing: template.briefing,
      assigneeId: player.id,
      giverId: commander.id,
      assignedAt: state.time,
      deadline: state.time + template.deadline_hours * 60,
      requirements: structuredClone(template.requirements),
      progress: template.requirements.map(() => 0),
      status: "active",
    };
    ctx.store.append({ type: "mission_assigned", mission });
    // 2인 1조: 같은 무리 동료 하나가 짝으로 붙는다 (기획서 7.9)
    const buddy = template.buddy ? assignBuddy(ctx, mission.id, commander.id) : null;
    const buddyLine = buddy ? `\n짝: ${playerCalls(ctx.store.getState(), ctx.content, buddy)}(${buddy})가 이 임무 동안 함께 다닌다 (2인 1조). 임무가 끝나면 자기 자리로 돌아간다.` : "";
    return {
      ok: true,
      resultText:
        `임무 배정: ${describeMission(ctx.content.scenario, mission)}${buddyLine}\n` +
        "상관이 임무를 지시하는 장면을 서술하라. 해야 할 일과 기한(대략적인 표현으로)을 상관의 말투로 전한다.",
      display: { type: "mission", event: "assigned", title: mission.title, detail: `기한 ${formatTime(mission.deadline)}` },
    };
  },
});

const reportMission = defineTool({
  name: "report_mission",
  description:
    "플레이어 캐릭터가 수행 중인 임무를 상관에게 보고한다. 상관이 장면에 있어야 한다. " +
    "결과(완수·일부 완수·실패)와 공적은 지금까지 실제로 한 일(시간 소비·판정)로 시스템이 판정한다. 플레이어의 말로 결과가 바뀌지 않는다.",
  schema: z.strictObject({}),
  run(_input, ctx) {
    const state = ctx.store.getState();
    const mission = activeMissionOf(state.missions, state.playerId);
    if (!mission) return { ok: false, error: "수행 중인 임무가 없습니다." };
    const giver = state.characters[mission.giverId];
    if (!giver || !state.scene.present.includes(giver.id)) {
      return { ok: false, error: `보고는 임무를 준 ${giver?.name ?? "상관"}에게 직접 한다. 먼저 npc_presence로 등장시키세요.` };
    }

    const result = evaluateMission(mission, state.time);
    ctx.store.append({ type: "mission_reported", missionId: mission.id, ...result });
    // 완수는 상관이 직접 확인한 성실함으로 남는다 (관계 변화는 상관의 가치관으로 계산)
    if (result.outcome === "success") {
      recordDeed(
        ctx,
        { summary: `임무 완수: ${mission.title}`, tags: ["diligence"], severity: 1, privacy: "public", noisy: false },
        { npcId: giver.id, source: "seen" },
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
    const label = MISSION_STATUS_LABELS[result.outcome === "success" ? "completed" : result.outcome];
    const lines = [
      `임무 보고: ${mission.title} — ${label}${result.late ? " (기한을 넘겨 보고)" : ""}. 공적 ${signed(result.merit)}.${repaid ? ` 빚을 갚았다 (장부에서 ${repaid} 줄었다).` : ""}`,
      `상관(${giver.name})이 결과에 맞게 반응하는 장면을 서술하라.`,
      ...releaseBuddies(ctx, mission.id),
    ];
    const growthNote = gainMeritXp(ctx, mission.assigneeId, result.merit);
    if (growthNote) lines.push(growthNote);

    const after = ctx.store.getState();
    const player = after.characters[after.playerId]!;
    const extra: ToolDisplayEvent[] = [];
    const commander = commanderOf(after, ctx);
    const commanderTrust = commander ? (after.relations[commander.id]?.[player.id]?.trust ?? 0) : null;
    const scenario = ctx.content.scenario;
    const promotion = scenario.promotion;
    if (checkPromotion(player, promotion, after.time, after.runStartedAt, commanderTrust, disciplineOf(ctx.content, player.factionId).maxDisobedience).eligible) {
      ctx.store.append({ type: "promoted", characterId: player.id, from: promotion.from, to: promotion.to });
      const fromLabel = rankLabel(scenario, promotion.from);
      const toLabel = rankLabel(scenario, promotion.to);
      lines.push(`진급: ${josa(player.name, "이/가")} ${fromLabel}에서 ${josa(toLabel, "으로/로")} 진급했다. 상관이 이를 알리는 장면을 서술하라.`);
      extra.push({ type: "promotion", name: player.name, fromLabel, toLabel });
    }
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
        `임무 포기: ${mission.title}. 이 무리(규율: ${d.label})에서 ${d.orderWord}을(를) 버린 것이다. ` +
        (d.countsDisobedience ? "불복종으로 기록되고 " : "불복종으로 치지는 않고 ") +
        `공적 ${signed(d.abandonMerit)}. ` +
        (d.deedSeverity > 0 ? "이 일은 상관과 동료의 시선에 영향을 줄 수 있다." : "이 무리에서는 크게 문제 삼지 않는다.") +
        releaseBuddies(ctx, mission.id).map((l) => ` ${l}`).join(""),
      display: { type: "mission", event: "abandoned", title: mission.title, detail: `포기 (${label})`, merit: d.abandonMerit },
    };
  },
});

export const MISSION_TOOLS = [assignMission, reportMission, abandonMission] as const;

/**
 * 임무의 턴 시작 처리 (코드가 하는 일, AI 요청 없음).
 * - 기한이 지난 임무는 기한 초과(명령 불이행)로 끝낸다
 * - 날이 바뀌면 상관이 오늘의 임무 후보를 정한다
 */
export function runMissionStartOfTurn(ctx: ToolContext): ToolDisplayEvent[] {
  const displays: ToolDisplayEvent[] = [];
  const state = ctx.store.getState();
  for (const mission of Object.values(state.missions)) {
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
    }
  }
  if (commanderOf(state, ctx) && hasAccess(ctx.content, state, "mission_board")) {
    const offers = pickDailyOffers(ctx.content, state.roleId, state.time, state.offers?.day ?? null, ctx.rng);
    if (offers) ctx.store.append({ type: "missions_offered", ...offers });
  }
  return displays;
}

/** GM에게 보여 줄 임무 상황 */
export function describeMissionsForGm(state: GameState, ctx: Pick<ToolContext, "content">): string {
  const player = state.characters[state.playerId];
  if (!player) return "";
  const active = activeMissionOf(state.missions, player.id);
  // 무소속은 복무·공적·불복종이 없다
  const lines = [player.factionId ? `복무: ${rankLabel(ctx.content.scenario, player.rank)} · 공적 ${player.merit} · 명령 불복종 ${player.disobedience}회` : `무소속 (${rankLabel(ctx.content.scenario, player.rank)}). 상관·임무·배급이 없다. 먹을 것은 지닌 것과 수색으로 구한다`];
  if (active) {
    lines.push(`수행 중인 임무 (보고는 상관에게 report_mission):\n${describeMission(ctx.content.scenario, active)}`);
  } else if (state.offers?.day === dayOf(state.time) && state.offers.templateIds.length > 0) {
    const offers = state.offers.templateIds
      .map((id) => ctx.content.missions[id])
      .filter((m) => m !== undefined)
      .map((m) => `  - ${m.id}: ${m.title} — ${m.briefing}`);
    lines.push(`오늘 받을 수 있는 임무 (상관이 장면에 있을 때 assign_mission):\n${offers.join("\n")}`);
  } else {
    lines.push("수행 중인 임무 없음");
  }
  const ended = Object.values(state.missions).filter((m) => m.status !== "active").slice(-3);
  if (ended.length > 0) {
    lines.push(`최근 임무: ${ended.map((m) => `${m.title}(${MISSION_STATUS_LABELS[m.status]})`).join(", ")}`);
  }
  return lines.join("\n");
}
