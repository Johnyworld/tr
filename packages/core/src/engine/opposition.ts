import { josa } from "../text.ts";
import { canUseSkill, effectiveSkill } from "./traits.ts";
import type { Content } from "../content/schemas.ts";
import { playerCalls } from "../game/acquaintance.ts";
import type { Character } from "../game/character.ts";
import type { GameState } from "../game/state.ts";
import { darknessOf } from "../rules/darkness.ts";
import { darkHere, peopleHere } from "../rules/place.ts";
import { ableNow, fightingAllies } from "../rules/company.ts";
import { weatherNow } from "../sim/weather.ts";
import { isCreature, isInfected } from "../game/kinds.ts";
import { changeCondition, isIncapacitated } from "./body.ts";
import type { ToolContext } from "./toolkit.ts";
import { isConfused } from "./ambush.ts";
import { opposedLabel } from "../rules/skill.ts";

/**
 * 상대와 상황 (기획서 4.1.1, 12-104): 주사위는 주인공만 굴린다. 상대의 실력·지켜보는 눈·어둠은 코드가 판정 보정으로 바꾼다.
 * - 상대 보정: 상대가 이 스킬에 맞서는 스킬(opposition.moves)의 능력 + 스킬 점수가 높으면 어렵고, 낮으면 쉽다
 * - 지켜보는 눈: 장면에 함께 있는 사람(동행 빼고)이 많으면 숨기 어렵다
 * - 어둠·날씨: 밤이나 안개·비면 숨기 쉽다
 * - 상대의 몫: 판정이 나빠 다칠 때, 싸움 실력이 좋은 상대는 한 단계 더, 서툰 상대는 한 단계 덜 다치게 한다
 * GM은 상황(지형, 거리, 엄폐)만 난이도로 고르고, 상대와 사람 수와 밝기는 고르지 않는다 (원칙 2)
 */

export type Part = { label: string; value: number };

const rules = (content: Content) => content.scenario.opposition;

/** 능력 + 스킬 (상한까지): 이 사람이 그 스킬로 얼마나 잘하는가 */
export function skillScore(content: Content, c: Character, moveId: string): number {
  const move = content.scenario.moves.find((m) => m.id === moveId);
  if (!move) return 0;
  const stat = Math.max(...move.stats.map((s) => c.stats[s] ?? 0));
  return Math.min(content.scenario.ranges.cap, stat + effectiveSkill(content, c, moveId));
}

/** 상대 점수 → 판정 보정: 0~1 그대로, 2~3 -1, 4 -2, 음수면 +1 */
export function opposeModifier(score: number): number {
  return Math.max(-2, Math.min(1, -Math.floor(score / 2)));
}

/** 판정에 붙는 상대·상황 보정의 내역 (0인 것은 빼고) */
export function oppositionParts(content: Content, state: GameState, moveId: string, opponentId: string | null, distance?: string | null, allies: readonly string[] = []): Part[] {
  const r = rules(content);
  if (!r) return [];
  const parts: Part[] = [];
  const opposing = r.moves[moveId];
  const opponent = opponentId ? state.characters[opponentId] : undefined;
  // 혼란에 빠진 상대는 맞서지 못한다 (12-177)
  if (opposing && opponent && !opponent.dead && !isConfused(state, opponent.id)) {
    // 상대가 그 전문 기술을 못 하면 서툰 상대와 같다 (4.2.1)
    const value = canUseSkill(content, opponent, opposing) ? opposeModifier(skillScore(content, opponent, opposing)) : 1;
    const label = content.scenario.moves.find((m) => m.id === opposing)?.label ?? opposing;
    // 방향과 누구인지, 0이어도 보인다 (공통 규칙 12, 12-241: "+1(○○의 교섭)"이 거든 것처럼 보였고 0이면 줄이 없었다)
    parts.push({ label: opposedLabel(value, label, playerCalls(state, content, opponent.id)), value });
  }
  if (r.crowd?.moves.includes(moveId)) {
    const eyes = watchers(state, content, opponent, moveId === content.scenario.move_roles.stealth).length;
    const value = -r.crowd.at.filter((n) => eyes >= n).length;
    // 수는 보이지 않는다 (플레이 테스트 11: "지켜보는 눈 3"이 아직 서술되지 않은 감염체 셋을 드러냈다)
    if (value) parts.push({ label: "지켜보는 눈", value });
  }
  // 수에 밀림 (12-111): 맞서는 감염체가 여럿이면 맞붙기 어렵다
  const outnumbered = r.mindless?.outnumbered;
  if (outnumbered?.moves.includes(moveId)) {
    const pack = infectedFoes(content, state).length;
    // 함께 싸우는 내 편 수만큼 덜어 낸다 (설계 목록 4-1, 공통 규칙 8 fightingAllies)
    const side = fightingAllies(state, content, allies, [opponentId]).filter((id) => !isInfected(content, state.characters[id])).length;
    const value = -outnumbered.at.filter((n) => pack - side >= n).length;
    if (value) parts.push({ label: side ? `감염체 ${pack} 대 우리 ${side + 1}` : `감염체 ${pack}`, value });
  }
  // 거리 (12-121): 숨을 때 상대가 멀면 쉽고 가까우면 어렵다
  if (r.distance?.moves.includes(moveId) && distance) {
    const value = r.distance.values[distance] ?? 0;
    const label = content.scenario.gear?.distances?.find((d) => d.id === distance)?.label.replace(/\s*\(.*\)$/, "") ?? distance;
    if (value) parts.push({ label, value });
  }
  // 불 켠 지붕 아래는 어둡지 않다 (공통 규칙 15 darkHere, B①)
  // 불빛을 켠 사람은 어둠에 숨지 못한다 (공통 규칙 27)
  if (r.dark?.moves.includes(moveId) && darkHere(state, content, r.dark.segments) && !darknessOf(state, content).glare) parts.push({ label: "어둠", value: r.dark.value });
  if (r.visibility?.moves.includes(moveId)) {
    const weather = weatherNow(content.scenario, state);
    if (weather && weather.visibility < r.visibility.below) parts.push({ label: weather.label, value: r.visibility.value });
  }
  return parts.filter((p) => p.value !== 0);
}

/** 장면에서 아직 덤빌 수 있는 감염체 (쓰러진 것은 빼고, 12-111) */
export function infectedFoes(content: Content, state: GameState): string[] {
  return state.scene.present.filter((id) => {
    const c = state.characters[id];
    return !!c && !c.dead && isInfected(content, c) && !isIncapacitated(content, c);
  });
}

/**
 * 우리 편이 감염체를 처리한다 (PT28 분대장: 감염체 하나가 거점 의무실에 9시간 넘게 머물렀고, 그 뒤 소탕 임무가 "쓸어 냈다").
 * 구역(들)에 남은 감염체 엑스트라를 쓰러뜨린다. 처리한 감염체의 호칭을 돌려준다
 */
export function putDownInfected(ctx: ToolContext, zones: readonly string[], cause: string, only?: readonly string[]): string[] {
  const { store, content } = ctx;
  const state = store.getState();
  const harm = content.scenario.condition_tracks.find((t) => t.id === content.scenario.harm_track)!;
  const done: string[] = [];
  for (const c of Object.values(state.characters)) {
    if (c.dead || !c.extra || !isInfected(content, c)) continue;
    if (only ? !only.includes(c.id) : !zones.includes(c.extra.zone ?? "")) continue;
    const name = playerCalls(store.getState(), content, c.id);
    const ch = changeCondition(ctx, c.id, harm.id, harm.levels.length, "attack", cause);
    if (ch?.died) done.push(name);
  }
  return done;
}

/** 무거운 피해를 낼 수 있는 무기 (든 것 먼저, 아니면 지닌 것). 탄약을 쓰는 무기는 탄약이 있거나 탄약 없이 쓰는 스킬이 있어야 */
export function heavyWeapon(content: Content, c: Character, move?: string): string | null {
  const ids = [c.equipped?.weapon, ...Object.keys(c.inventory)].filter((id): id is string => !!id && (c.inventory[id] ?? 0) > 0);
  for (const id of ids) {
    const w = content.items[id]?.weapon;
    if (!w || w.max_harm !== "heavy") continue;
    // 무기로 맞서는 판정(근접전·사격)이면 그 판정에 쓰는 무기만 센다: 맞붙는 판정에 상대가 지닌 총은 세지 않는다 (플레이 테스트 11: 막대 대련에 상대의 소총이 피해를 올렸다)
    if (move && content.scenario.opposition?.harm?.moves.includes(move) && w.moves[0] !== move) continue;
    const loaded = !w.ammo || (c.inventory[w.ammo] ?? 0) > 0 || w.moves.some((m) => !(w.ammo_moves ?? w.moves).includes(m));
    if (loaded) return id;
  }
  return null;
}

/** 장면에서 주인공을 볼 수 있는 사람: 살아 있고, 함께 다니는 사람이 아니다 */
/**
 * 숨는 것을 볼 수 있는 사람. 무리 밖의 상대에게서 숨을 때는 우리 무리 사람(아군)은 세지 않는다 (플레이 테스트 11: 적 초소를 상대로 한 은밀에 곁의 조원 셋이 눈으로 셌다)
 */
export function watchers(state: GameState, content: Content, opponent?: Character, placeToo = false): string[] {
  const own = state.characters[state.playerId]?.factionId ?? null;
  const allyOnly = !!opponent && !!own && opponent.factionId !== own;
  // 숨을 때는 같은 장소에 있을 사람도 눈이다 (B②, 공통 규칙 15 peopleHere). 장소를 옮기는 턴이면 판정 전에 옮겨 있어 도착한 장소의 사람이다.
  // 장면 밖 사람은 움직일 수 있는 사람만 (공통 규칙 8 ableNow). 속이기는 말을 듣는 장면의 사람만 센다
  const placed = !placeToo ? [] : peopleHere(state, content).filter((id) => ableNow(state, content, id) && !isCreature(content, state.characters[id]));
  return [...state.scene.present, ...placed].filter(
    (id) => id !== state.playerId && !state.characters[id]?.dead && !state.companions.includes(id) && !(allyOnly && state.characters[id]?.factionId === own),
  );
}

/**
 * 상대의 몫: 판정이 나빠 주인공이 다칠 때 상대의 싸움 실력으로 피해 단계를 고친다.
 * 돌려주는 것: 더하거나 뺄 단계와 한 줄 (상대가 없으면 null)
 */
export function opponentHarm(content: Content, state: GameState, opponentId: string | null, move?: string): { delta: number; line: string } | null {
  const r = rules(content)?.harm;
  const opponent = opponentId ? state.characters[opponentId] : undefined;
  if (!r || !opponent || opponent.dead) return null;
  // 그 스킬을 쓸 수 있는 것만: 맨손으로 되는 것이거나 그 스킬의 무기를 지녔을 때 (플레이 테스트 13: 들개가 "사격 +1"로 더 아프게 했다)
  const unarmed = content.scenario.gear?.unarmed.moves ?? [];
  const usable = (m: string) => unarmed.includes(m) || Object.entries(opponent.inventory).some(([id, q]) => q > 0 && !!content.items[id]?.weapon?.moves.includes(m));
  const best = r.moves
    .filter((m) => !content.scenario.gear || usable(m))
    .map((m) => ({ m, score: skillScore(content, opponent, m) }))
    .sort((a, b) => b.score - a.score)[0];
  if (!best) return null;
  const skill = best.score >= r.strong ? 1 : best.score <= r.weak ? -1 : 0;
  // 무거운 무기를 지녔으면 더 아프다 (12-121). 실력과 합쳐 -1 ~ +1
  const weapon = r.armed ? heavyWeapon(content, opponent, move) : null;
  const delta = Math.max(-1, Math.min(1, skill + (weapon ? r.armed : 0)));
  const label = content.scenario.moves.find((m) => m.id === best.m)?.label ?? best.m;
  const who = playerCalls(state, content, opponent.id);
  const signed = best.score >= 0 ? `+${best.score}` : `${best.score}`;
  const why = [skill > 0 ? "솜씨가 좋다" : skill < 0 ? "서툴다" : "", weapon ? `${josa(content.items[weapon]?.name ?? weapon, "을/를")} 들었다` : ""].filter(Boolean).join(", ");
  return {
    delta,
    // 판정 줄의 상대 보정과 다른 숫자다: 이것은 피해를 정하는 상대의 솜씨 (플레이 테스트 13: "+2"와 판정 줄 "-1"이 어긋나 보였다)
    line: `피해에 붙는 상대의 몫: ${who} (${label} 솜씨 ${signed}${weapon ? `, ${content.items[weapon]?.name ?? weapon}` : ""})${why ? ` → ${why}` : ""}${delta > 0 ? ". 한 단계 더" : delta < 0 ? ". 한 단계 덜" : ""}`,
  };
}
