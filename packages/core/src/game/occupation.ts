import type { Content } from "../content/schemas.ts";
import type { Character } from "./character.ts";

/** 직분 (기획서 12.6): 무리 안에서 맡은 일. 계급과 따로다 */
export type Occupation = Content["scenario"]["occupations"][number];

export function occupationById(content: Content, id: string | null | undefined): Occupation | undefined {
  return id ? content.scenario.occupations.find((o) => o.id === id) : undefined;
}

export function occupationOf(content: Content, c: Pick<Character, "occupation"> | undefined): Occupation | undefined {
  return occupationById(content, c?.occupation?.id);
}

/** 직분 이야기의 태그 */
export function occupationTag(o: Occupation): string {
  return o.storylet_tag ?? `occ_${o.id}`;
}

/**
 * 이 사람이 직분 안에서 오른 칸 (이야기 조건 occupation_step_gte). 직분에는 사다리가 없고 계급이 곧 사다리다 (12-82, 12-83):
 * 첫 진급 전의 계급(promotion.from, 분대원)과 그 아래·같은 단계(주민)가 0, 분대장 1, 간부 2
 */
export function careerStep(content: Content, c: Pick<Character, "occupation" | "rank">): number {
  if (!occupationOf(content, c)) return 0;
  const ladder = content.scenario.rank_ladder;
  const base = ladder.find((r) => r.id === content.scenario.promotion.from)?.level ?? 0;
  return Math.max(0, (ladder.find((r) => r.id === c.rank)?.level ?? base) - base);
}

/** 직분 이름 ("요리사") */
export function occupationTitle(content: Content, c: Pick<Character, "occupation"> | undefined): string | null {
  return occupationOf(content, c)?.label ?? null;
}
