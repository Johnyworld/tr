/**
 * 공통 규칙 3: 위험을 건 실패와 들킴은 상태에 남는다 (docs/design.md "공통 규칙").
 *
 * 들킴·붙잡힘이 무엇을 남기는지는 여기서 정한다. 결과가 말로만 끝나지 않게 (플레이 테스트 13: 붙잡혀도 무리 사이가 끝까지 "중립").
 * - 들킴 (onSpotted): 들키지 않기 임무가 깨지고, "침입" 행적이 남는다 (같은 날 같은 땅이면 한 번)
 * - 붙잡힘 (onCaptured): 들킴의 결과에 더해, 붙잡은 무리가 우리 무리를 보는 태도가 한 단계 내려간다
 * - 위협 이야기의 실패는 위협 배역이 장면에 남는다 (threatStaysOnMiss, storyletTools가 묻는다)
 */
import type { Content } from "../content/schemas.ts";
import { activeMissionOf } from "../game/missions.ts";
import type { GameState } from "../game/state.ts";
import { disposition } from "../sim/war.ts";
import { recordDeed } from "../engine/reputationTools.ts";
import type { ToolContext } from "../engine/toolkit.ts";
import { dayOf } from "./time.ts";

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

/** 위협 이야기(겁을 주는 이야기·매복)를 실패하면 위협 배역이 장면에 남는다 */
export function threatStaysOnMiss(content: Content, storyletId: string, outcome: string | null): boolean {
  const s = content.storylets[storyletId];
  return outcome === "miss" && !!s && ((s.fright ?? 0) > 0 || !!s.ambush);
}

/** 이 땅이 들킬 수 있는 남의 땅인가 (주인 무리) */
export function ownerOf(state: GameState, zone: string | null): string | null {
  return zone ? (state.zones[zone]?.owner ?? null) : null;
}
