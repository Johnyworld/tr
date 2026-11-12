import type { RelationDelta } from "../game/reputation.ts";
import type { ToolContext } from "./toolkit.ts";

/** 매력의 수동 효과 (기획서 4.2). 판정 밖에서 관계에 작용한다. 시나리오 `charm`이 없으면 아무 일도 없다 */

function playerCharm(ctx: ToolContext): number | null {
  const charm = ctx.content.scenario.charm;
  const state = ctx.store.getState();
  const player = state.characters[state.playerId];
  if (!charm || !player) return null;
  return player.stats[charm.ability] ?? 0;
}

/** 플레이어를 향한 관계 변화: 호감이 오르면 매력이 높은 사람은 조금 더 오른다 */
export function withCharm(ctx: ToolContext, to: string, delta: RelationDelta): RelationDelta {
  const charm = ctx.content.scenario.charm;
  const value = playerCharm(ctx);
  if (!charm || value === null || to !== ctx.store.getState().playerId) return delta;
  return delta.affection > 0 && value >= charm.bonus_at ? { ...delta, affection: delta.affection + 1 } : delta;
}

/** 처음 만난 NPC (아직 플레이어를 향한 관계가 없다): 호감 시작값에 매력이 더해진다. 매력이 낮아도 빼지는 않는다 */
export function firstImpression(ctx: ToolContext, npcId: string): void {
  const charm = ctx.content.scenario.charm;
  const value = playerCharm(ctx);
  const state = ctx.store.getState();
  if (!charm || value === null || state.relations[npcId]?.[state.playerId]) return;
  const bonus = Math.floor(value / charm.first_impression_per);
  if (bonus <= 0) return;
  ctx.store.append({ type: "relation_changed", from: npcId, to: state.playerId, delta: { trust: 0, affection: bonus, respect: 0 }, reason: "첫인상" });
}
