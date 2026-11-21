/**
 * 치료: 격리 (docs/design.md 12-238).
 *
 * 무리 문화에 quarantine_days가 있으면, 감염체에게 다친 뒤 그 날수 안에 그 무리의 치료(치료사·수술·무리 돌봄)를 받은 사람은
 * 그 무리 거점의 격리실에 갇힌다 (누구든: 하얀매 규칙 "물리거나 긁힌 사람은 누구든 격리실에서 사흘").
 * 갇힘은 공통 규칙 1 그대로다 (임무는 탓하지 않고, 갇힌 곳의 이야기만 열린다). 다만 붙잡힘이 아니라서 무리 사이가 나빠지지 않고
 * 빼앗는 것이 없고, 먹이는 쪽이 끼니를 제대로 준다. 날수가 지나면 풀려나고, 그사이 감염 열이 드러났으면 내릴 때까지 갇혀 있다
 * (플레이 테스트 13: 물린 것을 털어놓아도, 감염된 채 수술을 받아도 그대로 임무를 받고 다녔다).
 */
import { heldOf } from "../../rules/held.ts";
import { ownedBy } from "../../rules/home.ts";
import { MINUTES_PER_DAY } from "../../rules/time.ts";
import type { ToolContext } from "../toolkit.ts";
import { shownIndex } from "../body.ts";
import { releasePlayer } from "../captivity.ts";

const daysOf = (ctx: ToolContext, factionId: string | null | undefined) => (factionId ? ctx.content.factions[factionId]?.culture?.quarantine_days : undefined);

/** 이 무리의 치료를 받은 뒤: 격리할 사람이면 가두고 알릴 줄을 낸다 */
export function quarantineAfterCare(ctx: ToolContext, factionId: string | null | undefined): string | null {
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  const days = daysOf(ctx, factionId);
  const zone = state.playerZone;
  if (!days || !factionId || !me || me.dead || heldOf(me) || !zone) return null;
  // 그 무리의 거점에서만 (격리실이 있는 곳)
  if (ctx.content.locations[zone]?.kind !== "base" || !ownedBy(state, zone, factionId)) return null;
  const at = state.exposedAt?.[me.id];
  if (at === undefined || state.time - at > days * MINUTES_PER_DAY) return null;
  ctx.store.append({ type: "player_captured", by: factionId, zone, held: {}, quarantine: true });
  const name = ctx.content.factions[factionId]?.name ?? factionId;
  const fact = `감염체에게 다친 상처를 보고 ${name}이(가) 격리실에 들였다. ${days}일 동안 나가지 못한다 (그사이 열이 오르면 내릴 때까지)`;
  ctx.store.append({ type: "belief_added", characterId: state.playerId, belief: { id: `b_${ctx.store.getState().nextBeliefNo}`, fact, source: "seen", accuracy: "exact", learnedAt: state.time } });
  return `${fact}. 갇힌 동안의 임무는 탓하지 않는다. 끼니는 그쪽이 준다.`;
}

/** 격리가 끝났으면 풀어 준다. 시간이 흐른 뒤마다 */
export function runQuarantine(ctx: ToolContext): string[] {
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  const held = heldOf(me);
  if (!me || me.dead || !held?.quarantine) return [];
  const days = daysOf(ctx, held.by) ?? 0;
  if (state.time - (held.since ?? state.time) < days * MINUTES_PER_DAY) return [];
  const infection = ctx.content.scenario.body?.infection;
  if (infection && shownIndex(ctx, state, me.id, infection.track) > 0) return [];
  const line = releasePlayer(ctx, true);
  return line ? [`격리가 끝났다: ${line}`] : [];
}
