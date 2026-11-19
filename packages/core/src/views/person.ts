import type { Content } from "../content/schemas.ts";
import { traitLabels } from "../engine/traits.ts";
import { aliasOf, headingAs, knowsName } from "../game/acquaintance.ts";
import { BELIEF_SOURCE_LABELS } from "../game/belief.ts";
import { NEUTRAL_RELATION, RELATION_AXES, RELATION_AXIS_LABELS, relationLabel } from "../game/reputation.ts";
import type { GameState } from "../game/state.ts";
import { rankName } from "../game/ranks.ts";
import { formatAgo } from "../rules/time.ts";

/**
 * 한 인물에 대해 플레이어가 아는 것 (?인물 이름, 시트의 이름 툴팁이 같이 쓴다).
 * 플레이어의 Belief State만: 겉모습, 이름을 알면 평판, 만난 뒤에 보이는 트레잇, 마지막으로 본 태도, 아는 사실 (원칙 4)
 */
export type PersonProfile = {
  heading: string;
  rankLabel: string;
  /** 이름을 아는 사람의 나이 (12-195) */
  age: number | null;
  look: string | null;
  reputation: string | null;
  traits: string[];
  /** 마지막으로 만났을 때의 태도. 직접 만나기 전이면 null */
  attitude: { axis: string; label: string; word: string; value: number }[] | null;
  facts: { source: string; fact: string }[];
};

export function personProfile(state: GameState, content: Content, id: string): PersonProfile {
  const c = state.characters[id]!;
  const npc = content.npcs[id];
  const met = state.perceived[id] !== undefined;
  const r = state.perceived[id] ?? NEUTRAL_RELATION;
  const named = knowsName(state, state.playerId, id);
  const alias = aliasOf(state, content, id);
  const shown = traitLabels(content, c, { visibleOnly: true });
  return {
    heading: headingAs(state, content, state.playerId, id),
    rankLabel: rankName(content, c.factionId, c.rank),
    age: named ? c.age : null,
    look: npc?.look ?? c.extra?.look ?? null,
    // 평판은 그 인물을 아는(이름을 아는) 사람이 아는 모습이다
    reputation: npc && named ? npc.reputation : null,
    // 겉으로 보이는 트레잇만 (외모, 드러나는 성격). 처음 만나기 전엔 소문으로 아는 외모만
    traits: met ? shown : [],
    attitude: met ? RELATION_AXES.map((axis) => ({ axis, label: RELATION_AXIS_LABELS[axis], word: relationLabel(r[axis]), value: r[axis] })) : null,
    facts: (state.beliefs[state.playerId] ?? [])
      .filter((b) => (named && b.fact.includes(c.name)) || b.fact.includes(alias))
      .slice(-5)
      .map((b) => ({ source: `${BELIEF_SOURCE_LABELS[b.source]} · ${formatAgo(state.time, b.learnedAt)}`, fact: b.fact })),
  };
}
