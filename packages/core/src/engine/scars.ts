import { harmTrack } from "../scenario/scenario.ts";
import { playerCalls } from "../game/acquaintance.ts";
import { josa } from "../text.ts";
import { traitIdsOf } from "./traits.ts";
import type { ToolContext } from "./toolkit.ts";

/**
 * 몸에 남는 상처 (기획서 4.4.1, 12-156).
 * 부상이 scars.at 단계 이상인 상처를 입으면 chance로 오래 가는 약점 트레잇이 하나 붙는다.
 * 상처 종류에 맞는 것 중 아직 없는 것, 반대 트레잇과 겹치지 않는 것만. 한 사람에 max개까지. 플레이어와 NPC가 같다 (원칙 6)
 * 무엇이 붙는지는 코드가 정하고(원칙 2), GM은 그 흔적을 서술한다
 */
export function scarFromHarm(ctx: ToolContext, characterId: string, kind: string | null | undefined): string | null {
  const rules = ctx.content.scenario.scars;
  const state = ctx.store.getState();
  const c = state.characters[characterId];
  if (!rules || !c || c.dead) return null;
  const track = harmTrack(ctx.content.scenario);
  const at = track.levels.findIndex((l) => l.id === rules.at);
  const now = track.levels.findIndex((l) => l.id === c.conditions[track.id]);
  if (at < 0 || now < at || track.levels[now]?.fatal) return null;
  const have = traitIdsOf(ctx.content, c);
  const scarIds = new Set(rules.traits.map((x) => x.trait));
  if (have.filter((t) => scarIds.has(t)).length >= rules.max) return null;
  if (ctx.rng() >= rules.chance) return null;
  const defs = ctx.content.scenario.traits;
  const blocked = new Set(have.flatMap((t) => defs.find((d) => d.id === t)?.opposites ?? []));
  const pool = rules.traits.filter(
    (x) => !have.includes(x.trait) && !blocked.has(x.trait) && (x.wounds.length === 0 || (kind != null && x.wounds.includes(kind))),
  );
  if (!pool.length) return null;
  const pick = pool[Math.floor(ctx.rng() * pool.length)]!;
  const def = defs.find((d) => d.id === pick.trait)!;
  ctx.store.append({ type: "character_patched", characterId, traits: [...have, pick.trait] });
  const who = playerCalls(state, ctx.content, characterId);
  return characterId === state.playerId
    ? `이 상처는 아물어도 흔적을 남길 것이다: ${def.label} — ${def.description}.`
    : `${josa(who, "은/는")} 이 상처의 흔적을 오래 안고 갈 것이다: ${def.label}.`;
}
