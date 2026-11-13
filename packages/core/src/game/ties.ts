import type { Content } from "../content/schemas.ts";
import type { GameState } from "./state.ts";

/**
 * 인물 사이의 관계 (기획서 7.10). 정해진 관계(NPC의 ties)와 동적인 관계(state.dynamicTies)를 합쳐 본다.
 * 한쪽에만 적어도 양쪽으로 본다 (부모 ↔ 자식)
 */
export const TIE_KINDS = ["parent", "child", "sibling", "spouse", "friend", "rival"] as const;
export type TieKind = (typeof TIE_KINDS)[number];
export const FAMILY_KINDS: readonly TieKind[] = ["parent", "child", "sibling", "spouse"];

/** a가 b에게 kind면, b는 a에게 무엇인가 */
export const TIE_INVERSE: Record<TieKind, TieKind> = { parent: "child", child: "parent", sibling: "sibling", spouse: "spouse", friend: "friend", rival: "rival" };

/** "X는 Y의 <말>" 할 때의 말: a가 b의 부모면 a는 b의 "부모" */
export const TIE_LABELS: Record<TieKind, string> = { parent: "부모", child: "자식", sibling: "형제자매", spouse: "배우자", friend: "친구", rival: "앙숙" };

export type TieSecret = { reveal_when: string; min_trust: number };
/** 저장된 관계 한 줄: a는 b의 kind */
export type TieRecord = { a: string; b: string; kind: TieKind; secret: TieSecret | null };
/** 한 사람 쪽에서 본 관계: 이 사람은 other의 kind */
export type TieView = { other: string; kind: TieKind; secret: TieSecret | null; key: string };

export const tieKey = (a: string, b: string) => [a, b].sort().join("|");

/** 모든 관계 (정해진 것 + 동적인 것) */
export function allTies(state: Pick<GameState, "dynamicTies">, content: Content): TieRecord[] {
  const out: TieRecord[] = [];
  for (const npc of Object.values(content.npcs)) {
    for (const t of npc.ties ?? []) out.push({ a: npc.id, b: t.to, kind: t.kind, secret: t.secret ?? null });
  }
  for (const t of state.dynamicTies ?? []) out.push(t);
  return out;
}

/** 이 사람의 관계 (이 사람 쪽에서 본 것). 같은 상대는 한 번만 */
export function tiesOf(state: Pick<GameState, "dynamicTies">, content: Content, id: string): TieView[] {
  const seen = new Set<string>();
  const out: TieView[] = [];
  for (const t of allTies(state, content)) {
    const view = t.a === id ? { other: t.b, kind: t.kind } : t.b === id ? { other: t.a, kind: TIE_INVERSE[t.kind] } : null;
    if (!view || seen.has(view.other)) continue;
    seen.add(view.other);
    out.push({ ...view, secret: t.secret, key: tieKey(id, view.other) });
  }
  return out;
}

/** 주인공이 아는 관계인가: 드러난 관계이거나 털어놓은 관계 */
export function tieKnown(state: Pick<GameState, "revealedTies">, tie: TieView): boolean {
  return !tie.secret || (state.revealedTies ?? []).includes(tie.key);
}
