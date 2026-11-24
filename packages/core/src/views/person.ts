import type { Content } from "../content/schemas.ts";
import { traitLabels } from "../engine/traits.ts";
import { aliasOf, headingAs, isAcquaintanceMemory, knowsName, knowsReputation, withKnownNames } from "../game/acquaintance.ts";
import { BELIEF_SOURCE_LABELS } from "../game/belief.ts";
import { NEUTRAL_RELATION, RELATION_AXES, RELATION_AXIS_LABELS, relationLabel } from "../game/reputation.ts";
import type { GameState } from "../game/state.ts";
import { rankName } from "../game/ranks.ts";
import { formatAgo } from "../rules/time.ts";
import { playerSecretName, secretKnownBy } from "../rules/self.ts";
import { personFactLines, personFacts } from "../engine/personFacts.ts";
import { beliefText } from "../rules/lens.ts";

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
  /** 만나 본 사람의 파는 물건·가르칠 수 있는 것 (사람 정보, 12-241). 꺼내지 않은 부탁은 보이지 않는다 */
  offers: string[];
  /** 이 사람이 아는 내 비밀의 이름 (털어놓은 상대·그 자리에 있던 사람, 12-260). 모르면 null */
  knowsMySecret: string | null;
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
    // 평판은 그 인물을 아는 사람이 아는 모습이다: 이름만 막 들은 사이면 아직 모른다 (PT14)
    reputation: npc && knowsReputation(state, content, id) ? npc.reputation : null,
    // 겉으로 보이는 트레잇만 (외모, 드러나는 성격). 처음 만나기 전엔 소문으로 아는 외모만
    traits: met ? shown : [],
    attitude: met ? RELATION_AXES.map((axis) => ({ axis, label: RELATION_AXIS_LABELS[axis], word: relationLabel(r[axis]), value: r[axis] })) : null,
    facts: (state.beliefs[state.playerId] ?? [])
      // 만남·이름 기억은 머리(이름·호칭)와 겉모습이 이미 보여 준다: "이름은 모른다"가 이름을 안 뒤에도 남았다 (PT14)
      .filter((b) => !isAcquaintanceMemory(b.fact) && ((named && b.fact.includes(c.name)) || b.fact.includes(alias)))
      .slice(-5)
      .map((b) => ({ source: `${BELIEF_SOURCE_LABELS[b.source]} · ${formatAgo(state.time, b.learnedAt)}`, fact: withKnownNames(state, content, beliefText(state, b)) })),
    knowsMySecret: secretKnownBy(state, state.playerId).includes(id) ? (playerSecretName(content, state) ?? null) : null,
    offers: met ? personFactLines(personFacts(state, content, id, false)).map((l) => l.replace(" (take_action.lesson)", "")) : [],
  };
}
