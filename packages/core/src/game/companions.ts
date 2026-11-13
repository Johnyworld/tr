import type { Content } from "../content/schemas.ts";
import type { GameState } from "./state.ts";

/**
 * 동행 (기획서 7.8): 주인공과 함께 다니는 인물·동물. 살아 있고, 떠나지 않았고, 붙잡히지 않은 사람만 함께 있다
 */
export function activeCompanions(state: GameState): string[] {
  return state.companions.filter((id) => {
    const c = state.characters[id];
    return c && !c.dead && !c.away && !c.captive;
  });
}

/** 동행이 주는 스킬 보정 (엑스트라 틀의 companion_bonus). 같은 스킬은 가장 큰 것 하나만 */
export function companionSkillMod(state: GameState, content: Content, move: string): number {
  let best = 0;
  for (const id of activeCompanions(state)) {
    const template = state.characters[id]?.extra?.template;
    const bonus = template ? (content.extras[template]?.companion_bonus?.[move] ?? 0) : 0;
    if (bonus > best) best = bonus;
  }
  return best;
}

/** GM에게 보여 줄 동행 줄 */
export function describeCompanions(state: GameState, content: Content): string {
  const list = activeCompanions(state);
  if (!list.length) return "";
  const items = list.map((id) => {
    const c = state.characters[id]!;
    const template = c.extra?.template ? content.extras[c.extra.template] : undefined;
    const bonus = Object.entries(template?.companion_bonus ?? {})
      .map(([m, v]) => `${content.scenario.moves.find((x) => x.id === m)?.label ?? m} +${v}`)
      .join(", ");
    return `${c.extra?.label ?? c.name} (${id})${template?.animal ? " · 동물" : ""}${bonus ? ` · 함께 있으면 ${bonus}` : ""}`;
  });
  return `동행 (구역을 옮겨도 따라온다. 떼어 놓으면 companion_leave): ${items.join(", ")}`;
}
