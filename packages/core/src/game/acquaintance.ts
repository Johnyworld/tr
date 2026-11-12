import type { Content } from "../content/schemas.ts";
import { rankLabel } from "../scenario/scenario.ts";
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
  if (c.extra) return c.extra.label;
  const npc = content.npcs[id];
  if (npc) return npc.alias;
  const faction = c.factionId ? content.factions[c.factionId]?.name : undefined;
  return [faction, rankLabel(content.scenario, c.rank)].filter(Boolean).join(" ");
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
  if (!knowsName(state, viewer, target)) return `${aliasOf(state, content, target)} (이름 모름)`;
  return c.extra ? `${c.name} (${c.extra.label})` : c.name;
}

/** 현재 플레이어 캐릭터가 부르는 말 (가장 흔한 경우) */
export const playerCalls = (state: GameState, content: Content, target: string) => nameAs(state, content, state.playerId, target);
