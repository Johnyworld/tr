/**
 * 공통 규칙 14: 소식이 닿는 길 (docs/design.md "공통 규칙").
 *
 * 세계에서 일어난 일이 주인공에게 닿는지, 닿으면 소식(전해 들음)인지 소문인지는 여기서 정한다
 * (12-243: 교전·태도 변화·이름 있는 대원·탈영·전쟁 포로 소식이 각자 판단해, 교전 소식만 갇혀 있어도 들어왔고 소문 확률이 두 곳에 따로 있었다):
 * - 그 자리에서 겪었으면(seen) 직접 본 것이다 (갇혀 있어도)
 * - 주인공이 죽었거나 갇혀 있으면 닿지 않는다 (공통 규칙 1, 12-212)
 * - 우리 무리의 일이거나 가까이서 일어난 일(near)이면 소식으로 닿는다
 * - 남의 일이면 소문으로, 시나리오의 rumor_chance 확률로 (always면 늘). 사람에 대한 일이면 만난 적 있는 사람만
 * 소식·소문의 출처는 이 모듈로만 정한다 (rules/guards.test.ts).
 */
import type { GameState } from "../game/state.ts";
import { BELIEF_SOURCE_LABELS, type Belief } from "../game/belief.ts";
import type { ToolContext, ToolDisplayEvent } from "../engine/toolkit.ts";
import { playerHeld } from "./held.ts";
import { isAcquaintanceMemory } from "../game/acquaintance.ts";
import { START_TIME } from "./time.ts";

export type News = {
  fact: string;
  /** 이 일에 낀 무리들 (그중 하나가 주인공의 무리면 우리 일) */
  factions: readonly (string | null | undefined)[];
  /** 사람에 대한 일이면 그 사람 (남의 일이면 만난 적 있어야 소문이 닿는다) */
  person?: string;
  /** 남의 일도 늘 소문으로 닿는다 (무리의 태도가 바뀐 것처럼 크게 도는 말) */
  always?: boolean;
  /** 우리 일만 화면에 띄운다 (남의 일은 믿음에만) */
  showOursOnly?: boolean;
  topic?: string;
  accuracy?: Belief["accuracy"];
  /** 그 자리에서 겪었다 */
  seen?: boolean;
  /** 가까이서 일어났다 (우리 일이 아니어도 소식으로) */
  near?: boolean;
  /** 결과 글에 붙일 안내 */
  note?: string;
  /** 같은 말을 이미 들었으면 다시 남기지 않는다 */
  once?: boolean;
};

/** 이 소식이 닿는가: 출처 (닿지 않으면 null) */
export function newsSource(ctx: ToolContext, news: News): Belief["source"] | null {
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!me || me.dead) return null;
  if (news.seen) return "seen";
  if (playerHeld(state)) return null;
  if (news.near || (!!me.factionId && news.factions.includes(me.factionId))) return "report";
  if (news.person && !met(state, news.person)) return null;
  const chance = ctx.content.scenario.war?.felt?.rumor_chance ?? 0.4;
  return news.always || ctx.rng() < chance ? "rumor" : null;
}

/** 닿으면 믿음으로 남기고 화면에 띄울 것을 돌려준다 */
export function hearNews(ctx: ToolContext, news: News): ToolDisplayEvent[] {
  const source = newsSource(ctx, news);
  if (!source) return [];
  const now = ctx.store.getState();
  if (news.once && (now.beliefs[now.playerId] ?? []).some((b) => b.fact === news.fact)) return [];
  ctx.store.append({
    type: "belief_added",
    characterId: now.playerId,
    belief: { id: `b_${now.nextBeliefNo}`, fact: news.fact, source, accuracy: news.accuracy ?? "approximate", learnedAt: now.time, ...(news.topic ? { topic: news.topic } : {}) },
  });
  if (news.showOursOnly && source !== "report") return [];
  return [{ type: "belief", fact: news.fact, sourceLabel: BELIEF_SOURCE_LABELS[source], ...(news.note ? { note: news.note } : {}) }];
}

const met = (state: GameState, id: string) => (state.met[state.playerId] ?? []).includes(id) || (state.known[state.playerId] ?? []).includes(id);

/**
 * 수다로 옮길 만한 말인가 (성격의 새어 나감·얻어들음, engine/persona.ts). 소식이 사람 사이로 옮겨 가는 길이라 여기서 정한다.
 * - 만남·이름 기억("○○와 마주쳤다. 겉모습: …", "○○의 이름은 …")은 시스템이 남긴 기억이라 옮기지 않는다 (PT14: 대사로 옮기기 어려운 문장이 새었다)
 * - 주인공 자신의 지난 삶(세계가 열리기 전의 기억)은 성격의 새어 나감으로 흘리지 않는다 (털어놓기는 GM이 장면으로)
 * - 주인공이 듣는 쪽이면 주인공 자신에 대한 말은 얻어듣지 않는다 (PT14: 주인공 이름이 "[전해 들음] 약탈조원의 이름은 한동구"로 들어왔다)
 */
export function worthPassing(state: GameState, belief: Pick<Belief, "fact" | "learnedAt">, to: "player" | "npc"): boolean {
  if (isAcquaintanceMemory(belief.fact)) return false;
  if (belief.learnedAt < START_TIME) return false;
  const me = state.characters[state.playerId];
  if (to === "player" && me && belief.fact.includes(me.name)) return false;
  return true;
}
