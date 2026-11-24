/**
 * 공통 규칙 21: 보여 주기 (docs/design.md "공통 규칙", docs/mature-plan.md, 12-297, 사용자 결정).
 *
 * 성인 옵션(options.mature)은 세계를 바꾸지 않고 보이는 것만 바꾼다 (렌즈). 같은 시드면 같은 세계이고,
 * 껐다 켜도 사람이 사라지거나 직업이 바뀌지 않는다. 숨겨진 성인 내용이 있다는 표시는 두지 않는다.
 * 세계에는 늘 순화한 겉 글이 기본으로 있고, 성인 글은 따로 칸(mature)에 둔다. 켜져 있을 때만 그 칸을 보인다:
 * - 직업: 성인 직업(occupations.mature)은 겉 직업(cover, NPC 카드의 occupation_cover가 덮어쓴다)으로 보인다
 * - 인물 카드: 성인 줄(npc.mature)은 켜져 있을 때만 겉모습·한 줄에 더한다
 * - 믿음·행적·소문: mature 글이 있으면 켜져 있을 때만 그것으로
 * - 이야기 선택지: mature 표시면 꺼져 있을 때 숨긴다
 * - 진행 중인 성인 이야기: 끈 뒤에도 끝까지 가되 GM에게 수위를 낮추라고 알린다
 * - 성적 위협(menace): 늘 굴리고, 꺼져 있으면 일반 위협(괴롭힘·강탈)으로 보인다
 * 정보 필터(공통 규칙 7 "본 대로")와 같은 자리: GM 프롬프트·상태 화면·정보 명령어로 나가는 글만 이 모듈을 거친다
 */
import type { Content } from "../content/schemas.ts";
import type { Character } from "../game/character.ts";
import { occupationOf } from "../game/occupation.ts";
import type { GameState } from "../game/state.ts";

/** 성인 옵션이 켜져 있는가 */
export function matureShown(state: Pick<GameState, "options">): boolean {
  return !!state.options?.mature;
}

/** 성인 글 칸이 있으면 켜져 있을 때만 그것, 아니면 겉 글 */
export function shownText(state: Pick<GameState, "options">, x: { mature?: string | null }, cover: string): string {
  return x.mature && matureShown(state) ? x.mature : cover;
}

/** 믿음의 글 (소문·소식 포함) */
export function beliefText(state: Pick<GameState, "options">, b: { fact: string; mature?: string }): string {
  return shownText(state, b, b.fact);
}

/** 행적의 글 */
export function deedText(state: Pick<GameState, "options">, d: { summary: string; mature?: string }): string {
  return shownText(state, d, d.summary);
}

/** 보이는 직업 (이름·설명). 직업이 없으면 null */
export function shownOccupation(state: GameState, content: Content, c: Pick<Character, "occupation" | "id"> | undefined): { label: string; summary: string } | null {
  const o = occupationOf(content, c);
  if (!o) return null;
  if (!o.mature || matureShown(state) || !o.cover) return { label: o.label, summary: o.summary };
  const own = c ? content.npcs[c.id]?.occupation_cover : undefined;
  return own ? { label: own, summary: o.cover.summary } : o.cover;
}

/** 보이는 직업 이름 */
export function shownOccupationTitle(state: GameState, content: Content, c: Pick<Character, "occupation" | "id"> | undefined): string | null {
  return shownOccupation(state, content, c)?.label ?? null;
}

/** 인물 카드의 성인 줄 (켜져 있을 때만): 겉모습에 더할 글과 한 줄 */
export function matureCard(state: GameState, content: Content, id: string): { look?: string; note?: string } | null {
  if (!matureShown(state)) return null;
  return content.npcs[id]?.mature ?? null;
}

/** 이야기 선택지가 보이는가 (mature 표시면 켜져 있을 때만, 열린 이야기도 지금 옵션을 따른다) */
export function choiceShown(state: Pick<GameState, "options">, choice: { mature?: boolean }): boolean {
  return !choice.mature || matureShown(state);
}

/** 진행 중인 성인 이야기를 끈 뒤의 GM 안내 (켜져 있거나 성인 이야기가 아니면 null) */
export function toneDownLine(state: Pick<GameState, "options">, mature: boolean): string | null {
  return mature && !matureShown(state) ? "성인 주제가 꺼졌다: 이 이야기는 끝까지 가되, 수위를 낮춰 암시와 장면 전환으로 연출한다. 글은 바꾸지 않는다." : null;
}

/** 성적 위협이 꺼져 있을 때 보이는 일반 위협 */
export const MENACE_COVER = "거칠게 시비를 걸고 빼앗으려 든다 (괴롭힘·강탈)";
