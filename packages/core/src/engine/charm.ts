import type { RelationDelta } from "../game/reputation.ts";
import { affectionTraitBonus, looksImpression } from "./traits.ts";
import type { ToolContext } from "./toolkit.ts";

/** 매력의 수동 효과 (기획서 4.2). 판정 밖에서 관계에 작용한다. 시나리오 `charm`이 없으면 아무 일도 없다 */

function playerCharm(ctx: ToolContext): number | null {
  const charm = ctx.content.scenario.charm;
  const state = ctx.store.getState();
  const player = state.characters[state.playerId];
  if (!charm || !player) return null;
  return player.stats[charm.ability] ?? 0;
}

/**
 * from이 플레이어(to)를 보는 관계 변화: 호감이 오르면 매력이 높은 사람은 조금 더 오른다.
 * 트레잇: from이 이성에게 끌리면 이성인 플레이어에게 +1, 동성인데 플레이어의 외모가 좋으면 질투로 -1 (호감 상승은 0 밑으로 내리지 않는다)
 */
export function withCharm(ctx: ToolContext, from: string, to: string, delta: RelationDelta): RelationDelta {
  const state = ctx.store.getState();
  if (to !== state.playerId || delta.affection <= 0) return delta;
  const charm = ctx.content.scenario.charm;
  const value = playerCharm(ctx);
  let affection = delta.affection;
  if (charm && value !== null && value >= charm.bonus_at) affection += 1;
  const viewer = state.characters[from];
  const player = state.characters[to];
  if (viewer && player) affection = Math.max(0, affection + affectionTraitBonus(ctx.content, viewer, player));
  return affection === delta.affection ? delta : { ...delta, affection };
}

/**
 * 처음 만난 NPC (아직 플레이어를 향한 관계가 없다): 호감 시작값에 매력과 외모가 더해진다.
 * 매력은 낮아도 빼지 않는다. 외모(트레잇)는 험악하면 빼고, 이성에게 끌리는 이성은 두 배, 끌리는 동성은 질투로 뺀다 (기획서 4.6)
 */
export function firstImpression(ctx: ToolContext, npcId: string): void {
  const charm = ctx.content.scenario.charm;
  const value = playerCharm(ctx);
  const state = ctx.store.getState();
  if (state.relations[npcId]?.[state.playerId]) return;
  const viewer = state.characters[npcId];
  const player = state.characters[state.playerId];
  if (!viewer || !player) return;
  const charmBonus = charm && value !== null ? Math.max(0, Math.floor(value / charm.first_impression_per)) : 0;
  const total = charmBonus + looksImpression(ctx.content, viewer, player);
  if (total === 0) return;
  ctx.store.append({ type: "relation_changed", from: npcId, to: state.playerId, delta: { trust: 0, affection: total, respect: 0 }, reason: "첫인상" });
}
