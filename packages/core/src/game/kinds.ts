import type { Content, ExtraContent } from "../content/schemas.ts";
import type { Character } from "./character.ts";

/**
 * 인물이 무엇인가 (12-111): 사람, 동물, 감염체. 엑스트라 틀의 kind에서 온다 (콘텐츠 NPC는 모두 사람).
 * 동물·감염체는 이름을 나누지 않는다. 감염체는 말이 통하지 않아 사람의 일에서 빠진다
 */
export type CreatureKind = ExtraContent["kind"];

/** 틀의 kind (적지 않았으면 사람) */
export function templateKind(t: Pick<ExtraContent, "kind"> | undefined | null): CreatureKind {
  return t?.kind ?? "person";
}

export function kindOf(content: Content, c: Character | undefined | null): CreatureKind {
  const template = c?.extra?.template ? content.extras[c.extra.template] : undefined;
  return templateKind(template);
}

export const isAnimal = (content: Content, c: Character | undefined | null) => kindOf(content, c) === "animal";
export const isInfected = (content: Content, c: Character | undefined | null) => kindOf(content, c) === "infected";
/** 사람이 아니다 (동물·감염체): 이름·계급·사람의 사정을 쓰지 않는다 */
export const isCreature = (content: Content, c: Character | undefined | null) => kindOf(content, c) !== "person";

export const KIND_LABELS: Record<CreatureKind, string> = { person: "사람", animal: "동물", infected: "감염체" };
