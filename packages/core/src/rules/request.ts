import type { Content } from "../content/schemas.ts";
import { hasMet, knowsDeath } from "../game/acquaintance.ts";
import type { GameState } from "../game/state.ts";
import { heldOf } from "./held.ts";

/**
 * 의뢰 (12-291, 공통 규칙 "의뢰"): 의뢰 기록의 목표(quest)는 이 모듈로만 읽는다 (rules/guards.test.ts).
 * - 진행 중인 의뢰는 한 번에 하나: 인물이 꺼낸 부탁(favor)을 받은 것과 물어서 받은 의뢰(quest)를 함께 센다. 주인공이 먼저 한 약속은 따로
 * - 해냈는가: 찾아오기는 물건을 건넬 때(약속의 item), 사람 찾기는 만났거나 죽은 것을 알 때(곁에 데려오면 brought),
 *   붙잡아 오기는 묶어 끌고 와 곁에 있거나 의뢰인의 무리에 갇혔을 때, 처치하기는 목표가 죽었을 때
 */

type PromiseRecord = GameState["promises"][number];
export type Quest = NonNullable<PromiseRecord["quest"]>;
export type QuestKind = Quest["kind"];

export const questOf = (p: PromiseRecord | null | undefined): Quest | null => p?.quest ?? null;

/** 의뢰로 치는 기록인가 (부탁 또는 틀로 만든 의뢰) */
export const isRequest = (p: PromiseRecord): boolean => !!p.favor || !!p.quest;

/** 지금 진행 중인 의뢰 (한 번에 하나) */
export function activeRequest(state: GameState): PromiseRecord | null {
  return (state.promises ?? []).find((p) => p.by === state.playerId && p.status === "open" && isRequest(p)) ?? null;
}

/** 이 사람이 내놓았고 아직 답하지 않은 틀 의뢰 (부탁 favors는 빼고) */
export function offeredQuests(state: GameState, to?: string): PromiseRecord[] {
  return (state.promises ?? []).filter((p) => p.by === state.playerId && p.status === "asked" && !!p.quest && (!to || p.to === to));
}

/** 인물이 품은 부탁만 (틀 의뢰는 빼고): 먼저 꺼내는 부탁 줄에 쓴다 */
export const isFavorAsk = (p: PromiseRecord): boolean => !p.quest;

/** 의뢰 목표 엑스트라 (받은 뒤에 세계에 둔 사람·짐승·감염체) */
export const questTarget = (p: PromiseRecord): string | null => p.quest?.target ?? null;

/** 의뢰 목표인 엑스트라인가 (진행 중인 의뢰) */
export function isQuestTarget(state: GameState, id: string): boolean {
  return (state.promises ?? []).some((p) => p.status === "open" && p.quest?.target === id);
}

/** 찾아오기: 의뢰인에게 이미 건넨 수 */
export const questDelivered = (p: PromiseRecord): number => p.quest?.delivered ?? 0;

/** 이 의뢰를 받을 때 남긴 믿음의 열쇠 (끝나면 내려놓는다) */
export const questTopic = (id: string) => `request:${id}`;

/** 이 사람을 처치하라고 맡긴 의뢰인 (진행 중인 처치하기의 목표면) */
export function killQuestGiver(state: GameState, id: string): string | null {
  return (state.promises ?? []).find((p) => p.status === "open" && p.quest?.kind === "kill" && p.quest.target === id)?.to ?? null;
}

export type QuestProgress = { done: boolean; brought: boolean; left: string };

/**
 * 해냈는가 (보고 때). 찾아오기는 물건을 건네는 쪽(promises.ts)이 보므로 여기서는 늘 미완 — 건네면 끝난다.
 * here: 의뢰인 앞에 함께 있는 사람(장면·곁)
 */
export function questProgress(state: GameState, content: Content, p: PromiseRecord, here: readonly string[]): QuestProgress {
  const q = p.quest;
  if (!q) return { done: false, brought: false, left: "의뢰가 아니다" };
  const me = state.playerId;
  const t = q.target ? state.characters[q.target] : undefined;
  switch (q.kind) {
    case "fetch":
      return { done: false, brought: false, left: "물건을 의뢰인에게 건넨다 (transfer_item 또는 request report)" };
    case "find": {
      if (!t) return { done: false, brought: false, left: "찾을 사람이 없다" };
      if (t.dead) return knowsDeath(state, content, t.id) ? { done: true, brought: false, left: "" } : { done: false, brought: false, left: "그 사람을 아직 찾지 못했다" };
      if (here.includes(t.id)) return { done: true, brought: true, left: "" };
      return hasMet(state, me, t.id) ? { done: true, brought: false, left: "" } : { done: false, brought: false, left: "그 사람을 아직 찾지 못했다 (그 자리에 가서 만난다)" };
    }
    case "capture": {
      if (!t || t.dead) return { done: false, brought: false, left: "붙잡을 사람이 죽었다. 산 채로 데려오는 의뢰다" };
      const giverFaction = state.characters[p.to]?.factionId;
      if (giverFaction && heldOf(t)?.by === giverFaction) return { done: true, brought: false, left: "" };
      const towed = state.companions.includes(t.id) && state.bonds[t.id]?.kind === "prisoner";
      if (towed && here.includes(t.id)) return { done: true, brought: true, left: "" };
      return { done: false, brought: false, left: "쓰러뜨려 묶은 뒤(handle_prisoner bind) 의뢰인 앞으로 끌고 온다" };
    }
    case "kill":
      return t?.dead ? { done: true, brought: false, left: "" } : { done: false, brought: false, left: "목표가 아직 살아 있다" };
  }
}
