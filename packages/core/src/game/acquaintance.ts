import { josa, type JosaPair } from "../text.ts";
import { rankName } from "./ranks.ts";
import { isCreature, kindOf, KIND_LABELS } from "./kinds.ts";
import type { Content } from "../content/schemas.ts";
import type { GameState } from "./state.ts";

/**
 * 인물을 아는 것 (기획서 6.3): 만남(met)과 이름(known).
 * 인물의 이름은 처음부터 있고, 바뀌는 것은 "누가 그 이름을 아는가"뿐이다.
 * 이름을 모르는 사람에게는 호칭(엑스트라의 label, NPC의 alias)으로 보인다.
 * 프롬프트·명령어·화면에 인물을 부를 때는 character.name 대신 여기의 함수를 쓴다 (원칙 4)
 */

/** viewer가 target의 이름을 아는지. 자기 자신은 안다 */
export function knowsName(state: GameState, viewer: string, target: string): boolean {
  return viewer === target || (state.known[viewer]?.includes(target) ?? false);
}

/** viewer가 target을 만난 적이 있는지 (얼굴을 안다). 이름을 알면 만난 것으로 본다 */
export function hasMet(state: GameState, viewer: string, target: string): boolean {
  return knowsName(state, viewer, target) || (state.met[viewer]?.includes(target) ?? false);
}

/** 이름을 모르는 사람이 부르는 말: 엑스트라는 호칭, 콘텐츠 NPC는 alias, 그 밖(플레이어 캐릭터)은 소속과 계급 */
export function aliasOf(state: GameState, content: Content, id: string): string {
  const c = state.characters[id];
  if (!c) return id;
  // 변이한 감염체 (12-117): 지금 주인공이 그 사람 이름을 알면 이름, 모르면 그 사람의 호칭
  if (c.extra?.turnedFrom) {
    const from = c.extra.turnedFrom;
    const who = state.characters[from] && knowsName(state, state.playerId, from) ? state.characters[from]!.name : aliasOf(state, content, from);
    return `변이한 ${who}`;
  }
  if (c.extra) return c.extra.label;
  const npc = content.npcs[id];
  if (npc) return npc.alias;
  const faction = c.factionId ? content.factions[c.factionId]?.name : undefined;
  return [faction, rankName(content, c.factionId, c.rank)].filter(Boolean).join(" ");
}

/** viewer가 target을 부르는 말: 이름을 알면 이름, 모르면 호칭 */
export function nameAs(state: GameState, content: Content, viewer: string, target: string): string {
  const c = state.characters[target];
  if (!c) return target;
  return knowsName(state, viewer, target) ? c.name : aliasOf(state, content, target);
}

/** 인물 카드·목록의 머리: 이름을 알면 "이름 (호칭)"(엑스트라) 또는 "이름", 모르면 "호칭 (이름 모름)" */
export function headingAs(state: GameState, content: Content, viewer: string, target: string): string {
  const c = state.characters[target];
  if (!c) return target;
  // 동물·감염체는 이름을 나누지 않는다 (호칭이 이름, 12-111)
  if (c.extra && isCreature(content, c)) return `${aliasOf(state, content, target)} · ${KIND_LABELS[kindOf(content, c)]}`;
  if (!knowsName(state, viewer, target)) return `${aliasOf(state, content, target)} (이름 모름)`;
  return c.extra ? `${c.name} (${c.extra.label})` : c.name;
}

/** 현재 플레이어 캐릭터가 부르는 말 (가장 흔한 경우) */
export const playerCalls = (state: GameState, content: Content, target: string) => nameAs(state, content, state.playerId, target);

/**
 * 주인공이 그 사람의 죽음을 아는가 (원칙 4, 플레이 테스트 4): 유해가 지금 구역에 있거나, 같은 무리 사람이거나(거점에 소식이 돈다),
 * 그 죽음을 전하는 믿음이 있다. 모르면 GM에게도 살아 있는 것처럼 보인다
 */
export function knowsDeath(state: GameState, content: Content, id: string): boolean {
  const c = state.characters[id];
  if (!c?.dead) return false;
  if (state.remains.some((r) => r.of === id && r.zone === state.playerZone)) return true;
  const me = state.characters[state.playerId];
  if (me?.factionId && c.factionId === me.factionId) return true;
  const names = [c.name, playerCalls(state, content, id)];
  return (state.beliefs[state.playerId] ?? []).some((b) => names.some((n) => b.fact.includes(n)) && /죽|숨졌|숨을 거|시신|유해/.test(b.fact));
}

/**
 * 만남·이름 기억인가: "○○와 마주쳤다. 이름은 모른다. 겉모습: …", "○○의 이름은 김철수" (기획서 6.3).
 * 호칭과 이름을 잇는 시스템 기억이라, 아는 사실 목록(?인물)·남에게 옮기는 말(수다)에는 쓰지 않는다 (PT14)
 */
export function isAcquaintanceMemory(fact: string): boolean {
  return /마주쳤다\.( 이름은 모른다\.)?( 겉모습: .*)?$/.test(fact) || /^.+의 이름은 [^.]+\.?$/.test(fact);
}

/**
 * 주인공이 그 인물의 평판(소개)을 아는가: 이름을 알고, 원래 알던 사이(같은 무리, 놀이 중에 이름을 들은 기억이 없음)이거나
 * 사이가 가까워졌을 때(신뢰·호감 4 이상, *임시*). 만난 지 한 시간 된 사람의 지난 삶까지 보이지 않게 (PT14, 원칙 4)
 */
export function knowsReputation(state: GameState, content: Content, id: string): boolean {
  const c = state.characters[id];
  if (!c || !knowsName(state, state.playerId, id)) return false;
  const me = state.characters[state.playerId];
  if (me?.factionId && c.factionId === me.factionId) return true;
  const r = state.perceived[id];
  if (r && (r.trust >= 4 || r.affection >= 4)) return true;
  const heardName = (state.beliefs[state.playerId] ?? []).some((b) => b.fact.includes(`의 이름은 ${c.name}`));
  return !heardName;
}

const ALIAS_PARTICLES: Record<string, JosaPair> = { 은: "은/는", 는: "은/는", 이: "이/가", 가: "이/가", 을: "을/를", 를: "을/를", 과: "과/와", 와: "과/와" };

/**
 * 믿음 글을 보여 줄 때 이름을 알게 된 사람의 호칭을 지금 아는 이름으로 바꾼다 (12-259, PT15 튜토리얼: 강태호 이름을 안 뒤에도
 * "귀가 반쯤 없는 분대장은 …"). 기록은 그대로 두고 보여 주는 글만. 만남·이름 기억은 호칭과 이름을 잇는 글이라 그대로
 */
export function withKnownNames(state: GameState, content: Content, fact: string): string {
  if (isAcquaintanceMemory(fact)) return fact;
  let out = fact;
  const known = (state.known[state.playerId] ?? []).filter((id) => state.characters[id] && id !== state.playerId);
  // 같은 호칭을 쓰는 사람이 여럿이면(형제자매 둘) 누구인지 모르니 바꾸지 않는다 (12-261)
  const aliasCount = new Map<string, number>();
  for (const id of known) aliasCount.set(aliasOf(state, content, id), (aliasCount.get(aliasOf(state, content, id)) ?? 0) + 1);
  for (const id of known) {
    const c = state.characters[id]!;
    const alias = aliasOf(state, content, id);
    if ((aliasCount.get(alias) ?? 0) > 1) continue;
    if (!alias || alias === c.name || !out.includes(alias)) continue;
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const named = c.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 호칭 바로 뒤에 이름이 이미 있으면("아버지 임재석") 그대로 둔다 (12-261, PT16 튜토리얼: "임재석 임재석")
    out = out.replace(new RegExp(`${escaped}(?!\\s*${named})(은|는|을|를|과|와|(?:이|가)(?!다))?`, "g"), (_m, p?: string) => (p ? josa(c.name, ALIAS_PARTICLES[p]!) : c.name));
  }
  return out;
}
