/**
 * 공통 규칙 8: 곁의 사람 (docs/design.md "공통 규칙").
 *
 * 누가 곁에 있는지는 여기서 정하고, 곁의 사람이 하는 일도 여기서 정한다:
 * - 돕는다 (helperFor): 곁의 사람 동행 가운데 그 판정을 잘하는 사람(스킬 1 이상)이 있으면 +1 (플레이 테스트 13: 분대원 보정이 근접전·사격에만 붙었다)
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

/** 이 판정을 도울 사람: 그 스킬이 1 이상인 곁의 사람 가운데 가장 잘하는 사람. 없으면 null */
export function helperFor(state: GameState, content: Content, move: string): { id: string; bonus: number } | null {
  let best: { id: string; skill: number } | null = null;
  for (const id of peopleHere(state, content)) {
    const skill = effectiveSkill(content, state.characters[id]!, move);
    if (skill >= 1 && (!best || skill > best.skill)) best = { id, skill };
  }
  return best ? { id: best.id, bonus: 1 } : null;
}

/** 피해 1단계를 대신 받을 곁의 사람: 치명상 아래인 사람 동행 (먼저 들어온 사람부터). 없으면 null */
export function shareHarmWith(state: GameState, content: Content): string | null {
  const track = harmTrack(content.scenario);
  const critical = track.levels.findIndex((l) => l.id === content.scenario.recovery?.surgery?.from);
  for (const id of peopleHere(state, content)) {
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
