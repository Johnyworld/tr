/**
 * 공통 규칙 8: 곁의 사람 (docs/design.md "공통 규칙").
 *
 * 누가 곁에 있는지는 여기서 정하고, 곁의 사람이 하는 일도 여기서 정한다:
 * - 돕는다 (helperFor): 곁의 사람 동행 가운데 그 판정을 잘하는 사람(스킬 1 이상)이 있으면 +1 (플레이 테스트 13: 분대원 보정이 근접전·사격에만 붙었다).
 *   맞서 싸우는 판정은 with로 함께 싸우는 사람이 스킬이 없어도 +1 (12-256)
 * - 지혈한다 (staunchHelper): 피 흘리는 주인공을 곁의 사람이 묶는다. 위협이 없으면 그 행동이 끝날 때 (12-256)
 * - 위험을 나눈다 (shareHarmWith): 상대가 있는 판정이 실패해 2단계를 다치게 되면 곁의 사람 하나가 1단계를 대신 받는다 (플레이 테스트 13: 분대원 넷 곁에서 혼자 싸우다 죽었다)
 * 동물 동행의 재주(companion_bonus, 가르친 재주)는 그대로 동물의 몫이다.
 */
import type { Content } from "../content/schemas.ts";
import { activeCompanions } from "../game/companions.ts";
import { isCreature } from "../game/kinds.ts";
import type { GameState } from "../game/state.ts";
import { effectiveSkill } from "../engine/traits.ts";
import { harmTrack, incapacitatingSymptom } from "../scenario/scenario.ts";
import { tiesOf } from "../game/ties.ts";
import { heldOf } from "./held.ts";
import { threatInScene } from "./situation.ts";
import { roleOf } from "../game/state.ts";
import { squadMembers } from "../engine/command.ts";

/** 곁에 있는 동행 (함께 다니고 지금 장면에 있는 사람·동물) */
export function companionsHere(state: GameState): string[] {
  return activeCompanions(state).filter((id) => state.scene.present.includes(id));
}

/** 곁에 있고 움직일 수 있는 사람 동행 */
export function peopleHere(state: GameState, content: Content): string[] {
  return companionsHere(state).filter((id) => {
    const c = state.characters[id];
    return !!c && !c.dead && !isCreature(content, c) && !incapacitatingSymptom(content.scenario, c);
  });
}

/**
 * 내 편: 함께 다니는 동행, 주인공의 분대, 같은 분대 동료, 이번 행동을 함께하는 사람(take_action.with, 사용자 결정 PT14) (플레이 테스트 14: 구해 주는 분대원을 target으로 두자 맞서는 상대로 셌다).
 * target으로 들어와도 판정의 상대가 아니다. 내 편과 맞서려면 check.opponent로 분명히 한다
 */
export function onMySide(state: GameState, content: Content, id: string, allies: readonly string[] = []): boolean {
  return allies.includes(id) || activeCompanions(state).includes(id) || squadMembers(state, content).includes(id) || (roleOf(content, state)?.squad_mates ?? []).includes(id);
}

/** 이 판정을 도울 사람: 그 스킬이 1 이상인 곁의 사람 가운데 가장 잘하는 사람. 없으면 null */
export function helperFor(state: GameState, content: Content, move: string, allies: readonly string[] = [], exclude: readonly (string | null | undefined)[] = []): { id: string; bonus: number } | null {
  let best: { id: string; skill: number } | null = null;
  // 이번 행동의 상대, 함께하지(with) 않는 대상은 돕지 않는다 (12-265, PT18 분대장: 맞는 임동욱이 때리는 판정을 "도움 +1")
  const out = new Set(exclude.filter((x): x is string => !!x));
  // 곁의 사람과 이번 행동을 함께하는 사람(with, 의식이 있는 사람만)
  const withHere = allies.filter((id) => {
    const c = state.characters[id];
    return !!c && !c.dead && !isCreature(content, c) && !incapacitatingSymptom(content.scenario, c) && state.scene.present.includes(id) && !out.has(id);
  });
  // 돕는 사람은 그 일을 함께하는 사람만: with와 곁의 동행 (설계 목록 4-1, PT19·PT20: 같은 장소에 있기만 한 사람·시키지 않은 동행이 도왔다).
  // 몰래 하는 일(시나리오의 은밀)은 시킨 사람(with)만. 움직일 수 없는 사람은 돕지 않는다
  const stealthy = move === content.scenario.move_roles.stealth;
  const mates = stealthy ? [] : companyHere(state, content).filter((id) => state.scene.present.includes(id) && !isCreature(content, state.characters[id]));
  for (const id of [...new Set([...mates, ...withHere])].filter((id) => !out.has(id) && ableNow(state, content, id))) {
    const skill = effectiveSkill(content, state.characters[id]!, move);
    if (skill >= 1 && (!best || skill > best.skill)) best = { id, skill };
  }
  if (best) return { id: best.id, bonus: 1 };
  // 맞서 싸우는 판정(시나리오의 attack_moves)은 with로 함께 싸우는 사람이 스킬이 없어도 숫자로 돕는다 (12-256, PT15 분대장: 분대원 셋을 with에 넣었는데 감염체 하나에 치명상)
  const fighting = content.scenario.gear?.attack_moves.includes(move) ?? false;
  return fighting && withHere[0] ? { id: withHere[0], bonus: 1 } : null;
}

/**
 * 함께 싸우는 내 편의 수 (설계 목록 4-1, PT16~20 분대장: 분대 여섯이 감염체 셋에 "수에 밀림"을 받았다): 이번 행동의 with와 곁의 동행 가운데
 * 장면에 있고 움직일 수 있는 사람(짐승도 센다). 수에 밀림은 맞서는 수에서 이 수를 뺀 것으로 센다
 */
export function fightingAllies(state: GameState, content: Content, allies: readonly string[] = [], exclude: readonly (string | null | undefined)[] = []): string[] {
  const out = new Set(exclude.filter((x): x is string => !!x));
  return [...new Set([...activeCompanions(state), ...allies])].filter((id) => id !== state.playerId && !out.has(id) && state.scene.present.includes(id) && ableNow(state, content, id) && state.bonds[id]?.kind !== "prisoner");
}

/**
 * 피 흘리는 주인공을 묶어 줄 곁의 사람 (12-256, 공통 규칙 8): 곁의 동행이나 같은 무리의 장면 사람, 움직일 수 있고 갇히지 않은 사람.
 * 적대하는 위협이 장면에 있으면 아직 못 한다 (blocked). 사람이 없으면 null
 * (PT15 분대장: 분대원 넷 곁에서 45분을 피 흘리다 의무실로 옮긴 뒤에야 지혈됐다. 언제 도는지 알 수 없었다)
 */
export function staunchHelper(state: GameState, content: Content, bleeder: string): { id: string; blocked: boolean } | null {
  const me = state.characters[bleeder];
  if (!me) return null;
  const id = [...activeCompanions(state), ...state.scene.present].find((h) => {
    const x = state.characters[h];
    return !!x && h !== bleeder && !x.dead && !heldOf(x) && !isCreature(content, x) && !incapacitatingSymptom(content.scenario, x) && (activeCompanions(state).includes(h) || (!!me.factionId && x.factionId === me.factionId));
  });
  if (!id) return null;
  return { id, blocked: !!state.battle || threatInScene(state, content).length > 0 };
}

/**
 * 피해 1단계를 대신 받을 곁의 사람: 장면에 있는 동행과 같은 무리 사람 가운데 움직일 수 있고 치명상 아래인 사람 (먼저 들어온 사람부터). 없으면 null.
 * (같은 장소에 있기만 한 장면 밖 사람이 막아서던 것을 고침, 설계 목록 4-1·4-2)
 */
export function shareHarmWith(state: GameState, content: Content): string | null {
  const track = harmTrack(content.scenario);
  const critical = track.levels.findIndex((l) => l.id === content.scenario.recovery?.surgery?.from);
  const mine = state.characters[state.playerId]?.factionId ?? null;
  const side = state.scene.present.filter((id) => {
    const c = state.characters[id];
    return !!c && !isCreature(content, c) && ableNow(state, content, id) && (activeCompanions(state).includes(id) || (!!mine && c.factionId === mine));
  });
  for (const id of side) {
    const at = track.levels.findIndex((l) => l.id === state.characters[id]!.conditions[track.id]);
    if (critical < 0 || at < critical - 1) return id;
  }
  return null;
}

/**
 * 공들인 관계 (12-242): 표시(연인·피붙이·배우자·친구·다짐 대상·찾는 가족)가 있거나, 그 인물이 주인공에게 품은 신뢰나 호감이
 * 시나리오의 invested_from(기본 4) 이상. 세계의 일이 이 사람을 죽게 할 때 첫 번째는 크게 다치는 것으로 봐준다
 */
export function invested(state: GameState, content: Content, id: string): boolean {
  const me = state.playerId;
  if ((state.family ?? []).includes(id)) return true;
  if (Object.values(state.romances ?? {}).some((r) => r.stage === "lovers" && ((r.a === me && r.b === id) || (r.b === me && r.a === id)))) return true;
  if (tiesOf(state, content, me).some((t) => t.other === id && CLOSE_TIES.includes(t.kind))) return true;
  const r = state.resolves?.[me];
  if (r && (r.target === id || r.target2 === id)) return true;
  const from = content.scenario.war?.felt?.invested_from ?? 4;
  const rel = state.relations[id]?.[me];
  return !!rel && (rel.trust >= from || rel.affection >= from);
}

const CLOSE_TIES: readonly string[] = ["parent", "child", "sibling", "spouse", "friend", "lover"];

/**
 * 세계의 일(무리 사이 싸움의 사상자·포로 등)이 데려가지 않는 사람 (12-243): 주인공, 주인공의 분대·같은 분대 동료, 동행,
 * 진행 중인 이야기의 배역, 무리 우두머리(사다리 맨 위), 이미 죽었거나 떠났거나 갇힌 사람
 */
export function protectedFromWorld(state: GameState, content: Content, id: string): boolean {
  const c = state.characters[id];
  if (!c || c.dead || c.away || heldOf(c) || id === state.playerId) return true;
  if (activeCompanions(state).includes(id) || squadMembers(state, content).includes(id) || (roleOf(content, state)?.squad_mates ?? []).includes(id)) return true;
  if (Object.values(state.activeStorylet?.cast ?? {}).includes(id)) return true;
  const top = content.scenario.rank_ladder.reduce((a, b) => (b.level > a.level ? b : a)).id;
  return c.rank === top;
}

/**
 * 이 사람과 말을 주고받을 수 있는가 (약속·뇌물·협박 같은 말의 도구가 함께 쓴다). 안 되면 까닭.
 * 중상이어도 의식이 있으면 말은 한다 (사용자 결정, 플레이 테스트 14: 다리를 판자로 묶은 실종자가 "대답할 수 없는 상태"였다).
 * 의식을 잃었을 때(의식장애 같은 증상)만 막는다
 */
export function talkProblem(state: GameState, content: Content, id: string, verb: string): string | null {
  const c = state.characters[id];
  if (!c || c.dead || id === state.playerId || !state.scene.present.includes(id)) return "그 사람이 장면에 없다.";
  if (isCreature(content, c)) return `사람에게만 ${verb}.`;
  if (incapacitatingSymptom(content.scenario, c)) return "그 사람은 의식이 없어 대답할 수 없다.";
  return null;
}

/**
 * 곁에서 말을 주고받고 일을 할 수 있는 사람인가 (12-269, 우회 점검: 목격자·치료사·곁의 동행을 저마다 골라 죽은 사람·기절한 사람·갇힌 사람이 섞였다).
 * 살아 있고, 스스로 움직일 수 있고(의식불명 증상 없음), 갇혀 있지 않은 사람. 동물·감염체인지는 부르는 쪽이 따로 본다
 */
export function ableNow(state: GameState, content: Content, id: string): boolean {
  const c = state.characters[id];
  return !!c && !c.dead && !c.away && !heldOf(c) && !incapacitatingSymptom(content.scenario, c);
}

/** 곁에 있는 동행 (공포가 가라앉고 마음이 쉬는 몫): 장면에 있고 움직일 수 있는 동행. 끌고 가는 포로는 빼고 */
export function companyHere(state: GameState, content: Content): string[] {
  return activeCompanions(state).filter((id) => state.bonds[id]?.kind !== "prisoner" && ableNow(state, content, id));
}
