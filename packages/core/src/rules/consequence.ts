/**
 * 공통 규칙 3: 위험을 건 실패와 들킴은 상태에 남는다 (docs/design.md "공통 규칙").
 *
 * 들킴·붙잡힘이 무엇을 남기는지는 여기서 정한다. 결과가 말로만 끝나지 않게 (플레이 테스트 13: 붙잡혀도 무리 사이가 끝까지 "중립").
 * - 들킴 (onSpotted): 들키지 않기 임무가 깨지고, "침입" 행적이 남는다 (같은 날 같은 땅이면 한 번)
 * - 붙잡힘 (onCaptured): 들킴의 결과에 더해, 붙잡은 무리가 우리 무리를 보는 태도가 한 단계 내려간다
 * - 위협 이야기의 실패는 위협 배역이 장면에 남는다 (threatStaysOnMiss, storyletTools가 묻는다)
 */
import type { Content } from "../content/schemas.ts";
import { activeMissionOf, commanderOf } from "../game/missions.ts";
import { playerCalls } from "../game/acquaintance.ts";
import { josa } from "../text.ts";
import { absenceExcused } from "./blame.ts";
import type { GameState } from "../game/state.ts";
import { disposition } from "../sim/war.ts";
import { recordDeed, recordDeedIfSeen } from "../engine/reputationTools.ts";
import type { ToolContext } from "../engine/toolkit.ts";
import { dayOf } from "./time.ts";
import { ownedBy } from "./home.ts";

/** 들키지 않기가 조건인 임무가 깨졌다. 알릴 줄 (이미 깨졌거나 그런 임무가 아니면 null) */
function spoilUnseenMission(ctx: ToolContext): string | null {
  const state = ctx.store.getState();
  const m = activeMissionOf(state.missions, state.playerId);
  if (!m?.unseen || m.spotted) return null;
  ctx.store.append({ type: "mission_spotted", missionId: m.id });
  return `임무 "${m.title}"의 들키지 않기가 깨졌다: 다른 조건을 채워도 일부 완수까지다.`;
}

/** 남의 땅에서 들켰다 (owner: 그 땅의 무리). 알릴 줄 */
export function onSpotted(ctx: ToolContext, owner: string | null): string[] {
  const lines: string[] = [];
  const spoiled = spoilUnseenMission(ctx);
  if (spoiled) lines.push(spoiled);
  if (owner) {
    const state = ctx.store.getState();
    const summary = `${ctx.content.factions[owner]?.name ?? owner}의 땅에 몰래 들어갔다 들켰다`;
    const today = dayOf(state.time);
    const already = Object.values(state.deeds).some((d) => d.actorId === state.playerId && d.summary === summary && dayOf(d.at) === today);
    if (!already) recordDeed(ctx, { summary, tags: ["trespass"], severity: 1, privacy: "semi_private", noisy: true });
  }
  return lines;
}

/** 붙잡혔다 (by: 붙잡은 무리). 알릴 줄 */
export function onCaptured(ctx: ToolContext, by: string): string[] {
  const lines = onSpotted(ctx, by);
  const state = ctx.store.getState();
  const own = state.characters[state.playerId]?.factionId;
  if (own && own !== by && state.factions[by] && ctx.content.factions[own]) {
    const now = disposition(ctx.content, by, own, state);
    const value = Math.max(-3, now - 1);
    if (value !== now) ctx.store.append({ type: "faction_disposition_changed", from: by, to: own, value });
  }
  return lines;
}

/**
 * 자리 비움: 임무 없이 무리 문화의 absence_hours보다 오래 우리 땅 밖에 있다 돌아오면 상관이 안다 (플레이 테스트 13: 섬을 무단으로 떠났다 와도 아무도 몰랐다).
 * 붙잡혔다 풀려났거나 그동안 임무가 있었으면 탓하지 않는다 (공통 규칙 2). 시간이 흐른 뒤마다
 */
export function onReturnedHome(ctx: ToolContext): string[] {
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  const left = state.leftHomeAt;
  if (!me?.factionId || left === null || !state.playerZone || !ownedBy(state, state.playerZone, me.factionId)) return [];
  ctx.store.append({ type: "returned_home" });
  const hours = ctx.content.factions[me.factionId]?.culture?.absence_hours;
  if (!hours || state.time - left < hours * 60 || absenceExcused(state, left)) return [];
  const commander = commanderOf(state, ctx.content);
  const away = Math.round((state.time - left) / 60);
  recordDeed(ctx, { summary: `허락 없이 ${away}시간 자리를 비웠다`, tags: ["disobedience"], severity: 1, privacy: "public", noisy: false }, commander ? { npcId: commander, source: "report" } : undefined);
  return [`허락 없이 ${away}시간 자리를 비운 것을 ${commander ? josa(playerCalls(state, ctx.content, commander), "이/가") : "무리가"} 알았다 (명령 불복종으로 남았다).`];
}

/** 우리 땅에서 몰래 하다 들켰다 (숨기 판정 실패): 장면의 사람이 본다 (플레이 테스트 13: 의회 저장고를 엿보다 실패해도 아무 일이 없었다) */
export function onSpottedAtHome(ctx: ToolContext): string[] {
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!me?.factionId || !state.playerZone || !ownedBy(state, state.playerZone, me.factionId)) return [];
  // 본 사람이 있을 때만 들킨 것이다 (PT15 졸병: 아무도 없는 창고에서 "들켰다"가 남았다)
  const { deed, visible } = recordDeedIfSeen(ctx, { summary: "우리 땅에서 수상한 짓을 하다 들켰다", tags: ["disobedience"], severity: 1, privacy: "semi_private", noisy: true });
  if (!deed) return ["숨는 데는 서툴렀지만 다행히 본 사람이 없는 것 같다."];
  return [visible.length ? `${visible.join(", ")}에게 수상한 낌새를 들켰다 (명령 불복종으로 남았다).` : "누군가 수상한 낌새를 보았다 (명령 불복종으로 남았다)."];
}

/** 위협 이야기(겁을 주는 이야기·매복)를 실패하면 위협 배역이 장면에 남는다 */
export function threatStaysOnMiss(content: Content, storyletId: string, outcome: string | null): boolean {
  const s = content.storylets[storyletId];
  return outcome === "miss" && !!s && ((s.fright ?? 0) > 0 || !!s.ambush);
}

/** 이 땅이 들킬 수 있는 남의 땅인가 (주인 무리) */
export function ownerOf(state: GameState, zone: string | null): string | null {
  return zone ? (state.zones[zone]?.owner ?? null) : null;
}
