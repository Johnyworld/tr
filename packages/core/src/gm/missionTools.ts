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
  const id = ctx.content.roles[state.roleId]?.commander;
  const commander = id ? state.characters[id] : undefined;
  return commander && !commander.dead ? commander : undefined;
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
    return {
      ok: true,
      resultText:
        `임무 배정: ${describeMission(ctx.content.scenario, mission)}\n` +
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
    const label = MISSION_STATUS_LABELS[result.outcome === "success" ? "completed" : result.outcome];
    const lines = [
      `임무 보고: ${mission.title} — ${label}${result.late ? " (기한을 넘겨 보고)" : ""}. 공적 ${signed(result.merit)}.`,
      `상관(${giver.name})이 결과에 맞게 반응하는 장면을 서술하라.`,
    ];

    const after = ctx.store.getState();
    const player = after.characters[after.playerId]!;
    const extra: ToolDisplayEvent[] = [];
    const commander = commanderOf(after, ctx);
    const commanderTrust = commander ? (after.relations[commander.id]?.[player.id]?.trust ?? 0) : null;
    const scenario = ctx.content.scenario;
    const promotion = scenario.promotion;
    if (checkPromotion(player, promotion, after.time, after.runStartedAt, commanderTrust).eligible) {
      ctx.store.append({ type: "promoted", characterId: player.id, from: promotion.from, to: promotion.to });
      const fromLabel = rankLabel(scenario, promotion.from);
      const toLabel = rankLabel(scenario, promotion.to);
      lines.push(`진급: ${player.name}이(가) ${fromLabel}에서 ${toLabel}(으)로 진급했다. 상관이 이를 알리는 장면을 서술하라.`);
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
    "플레이어 캐릭터가 수행 중인 임무를 거부하거나 포기한다. 명령 불복종으로 기록되고 공적이 깎인다. " +
    "플레이어가 분명히 임무를 거부·포기하는 행동을 할 때만 쓴다.",
  schema: z.strictObject({
    reason: z.string().min(1).max(200).describe("포기한 사정 한 문장"),
  }),
  run(input, ctx) {
    const state = ctx.store.getState();
    const mission = activeMissionOf(state.missions, state.playerId);
    if (!mission) return { ok: false, error: "수행 중인 임무가 없습니다." };
    ctx.store.append({ type: "mission_abandoned", missionId: mission.id, merit: MERIT.abandoned, reason: input.reason });
    recordDeed(
      ctx,
      { summary: `임무 포기: ${mission.title} (${input.reason})`, tags: ["disobedience"], severity: 2, privacy: "public", noisy: false },
      { npcId: mission.giverId, source: state.scene.present.includes(mission.giverId) ? "seen" : "report" },
    );
    return {
      ok: true,
      resultText:
        `임무 포기: ${mission.title}. 명령 불복종으로 기록되고 공적 ${signed(MERIT.abandoned)}. ` +
        "이 일은 상관과 동료의 시선에 영향을 줄 수 있다.",
      display: { type: "mission", event: "abandoned", title: mission.title, detail: "포기 (불복종)", merit: MERIT.abandoned },
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
      ctx.store.append({ type: "mission_expired", missionId: mission.id, merit: MERIT.expired });
      recordDeed(
        ctx,
        { summary: `임무 기한 초과: ${mission.title}`, tags: ["disobedience"], severity: 2, privacy: "public", noisy: false },
        { npcId: mission.giverId, source: "report" },
      );
      displays.push({ type: "mission", event: "expired", title: mission.title, detail: "기한 초과 (불복종)", merit: MERIT.expired });
    }
  }
  if (commanderOf(state, ctx)) {
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
  const lines = [`복무: ${rankLabel(ctx.content.scenario, player.rank)} · 공적 ${player.merit} · 명령 불복종 ${player.disobedience}회`];
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
