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

/** 평판으로 오른 사다리의 칸 (0부터) */
export function occupationStep(o: Occupation, standing: number): number {
  let step = 0;
  o.ladder.forEach((rung, i) => {
    if (standing >= rung.standing) step = i;
  });
  return step;
}

/** "요리사 · 부엌 반장" */
export function occupationTitle(content: Content, c: Pick<Character, "occupation"> | undefined): string | null {
  const o = occupationOf(content, c);
  if (!o) return null;
  const rung = o.ladder[occupationStep(o, c!.occupation!.standing)]!;
  return rung.label === o.label ? o.label : `${o.label} · ${rung.label}`;
}
