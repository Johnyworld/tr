/**
 * 공통 규칙 1: 갇힘 (docs/design.md "공통 규칙").
 *
 * 누가 갇혀 있는지는 이 모듈로만 읽는다 (rules/held.test.ts가 다른 곳에서 `.captive`를 직접 읽으면 실패시킨다).
 * 갇혀 있는 동안 멈추는 바깥의 셈은 HELD_PAUSES에 모아 둔다. 새 기능이 갇힌 동안 멈춰야 하면 여기에 이름을 더하고 pausedWhileHeld로 묻는다.
 * 쓰는 곳은 세이브의 기록(game/state.ts의 리듀서)만 직접 고친다.
 */

import type { ToolContext } from "../engine/toolkit.ts";
import { hasMet, playerCalls } from "../game/acquaintance.ts";
import { josa } from "../text.ts";

/** 갇힌 사람의 기록 (붙잡은 무리, 갇힌 구역, 노역, 갇힌 시각, 탈출 실패로 쌓인 감시, 우리 무리의 격리, 저절로 풀리는 시각(우리 무리의 벌, 12-257)) */
export type Held = { by: string; zone: string; labor?: boolean | undefined; since?: number | undefined; watch?: number | undefined; quarantine?: boolean | undefined; releaseAt?: number | undefined };

/** 이 사람이 갇혀 있으면 그 기록, 아니면 null */
export function heldOf(c: { captive?: Held | null } | null | undefined): Held | null {
  return c?.captive ?? null;
}

/** 주인공이 갇혀 있으면 그 기록 */
export function playerHeld(state: { playerId: string; characters: Record<string, { captive?: Held | null } | undefined> }): Held | null {
  return heldOf(state.characters[state.playerId]);
}

/**
 * 갇혀 있는 동안 멈추는 바깥의 셈 (플레이 테스트 12·13에서 하나씩 빠져 나온 것들):
 * - mission: 임무 진행·임무 판정·기한 탓 (붙잡혀 못 마침)
 * - resolve_reach: 다짐의 "그곳에 닿았다"
 * - ration: 우리 무리 배급 (풀려나 그날 거점에 닿으면 받는다)
 * - guest: 남의 거점의 손님 대접 (불 땐 거처)
 * - strangers: 마주칠 낯선 사람 (같이 갇힌 사람·치료사만)
 * - alarm: 적 땅 경보 (다시 끌려온다)
 * - assign: 임무 받기
 * - helpless: 쓰러진 동안 곁의 사람이 할 일
 */
export const HELD_PAUSES = ["mission", "resolve_reach", "ration", "guest", "strangers", "alarm", "assign", "helpless"] as const;
export type HeldPause = (typeof HELD_PAUSES)[number];

/** 주인공이 갇혀 있어 이 셈이 멈췄는가 */
export function pausedWhileHeld(state: Parameters<typeof playerHeld>[0], _what: HeldPause): boolean {
  return playerHeld(state) !== null;
}

/** 주인공이 마지막으로 풀려난(빠져나온) 시각. 한 번도 없으면 null */
export function lastFreedAt(state: { lastFreedAt?: number | null }): number | null {
  return state.lastFreedAt ?? null;
}

/**
 * 갇힌 사람을 그 자리에서 본 기억의 주제 (12-259, PT15 졸병: 수용소에서 본 남궁혁이 거점에 돌아오자 "행방 모름"이 됐다).
 * 갇힌 인물이 장면에 있으면 "[직접 봄] ○○은 ○○에 붙잡혀 있다" 믿음을 남기고, 그 자리를 떠난 뒤에도 아는 인물 줄은 그 믿음으로 보인다
 */
export const heldSeenTopic = (id: string, zone: string) => `held_seen:${id}@${zone}`;

/** 주인공이 마지막으로 이 사람이 갇혀 있는 것을 본 구역 (본 적 없으면 null) */
export function heldSeenZone(state: { playerId: string; beliefs: Record<string, readonly { topic?: string | undefined }[] | undefined> }, id: string): string | null {
  const prefix = `held_seen:${id}@`;
  const seen = (state.beliefs[state.playerId] ?? []).filter((b) => b.topic?.startsWith(prefix));
  return seen.length ? seen.at(-1)!.topic!.slice(prefix.length) : null;
}

/** 주인공이 우리 무리의 벌로 갇혀 있는가 (12-257 confineByOwn). 적에게 붙잡힌 것과 글·이야기가 다르다 (12-261, PT16 졸병) */
export function heldByOwn(state: { playerId: string; characters: Record<string, { captive?: Held | null; factionId?: string } | undefined> }): boolean {
  const me = state.characters[state.playerId];
  const held = heldOf(me);
  return !!held && !!me?.factionId && held.by === me.factionId;
}

/**
 * 주인공이 어떻게 갇혀 있는가 (12-269, 우회 점검: 부르는 쪽이 quarantine 표시를 직접 읽어 격리·벌을 적의 포로처럼 다뤘다).
 * - enemy: 다른 무리에 붙잡힘 (빼앗김·겨우 먹임·탈출은 용기)
 * - own: 우리 무리의 벌 (지닌 것 그대로, 우리 배급, 달아나면 벌을 어김)
 * - quarantine: 치료사 무리의 격리 (지닌 것 그대로, 그쪽이 먹임)
 * 갇혀 있지 않으면 null
 */
export type HeldKind = "enemy" | "own" | "quarantine";
export function heldKind(state: Parameters<typeof heldByOwn>[0]): HeldKind | null {
  const held = playerHeld(state);
  if (!held) return null;
  if (held.quarantine) return "quarantine";
  return heldByOwn(state) ? "own" : "enemy";
}

/** 그 사람이 격리로 갇혀 있는가 (주인공이 아닌 사람 포함) */
export function inQuarantine(c: { captive?: Held | null } | null | undefined): boolean {
  return !!heldOf(c)?.quarantine;
}

/**
 * 갇힌 곳에서 꺼내 온 사람 (설계 목록 2-12, PT20·PT21 졸병: 탈출로 데려온 동료에게 관계·공적·무리 반응이 없었다).
 * 잠입으로 풀어 주든 함께 달아나든 여기로: 얼굴을 마주했으니 만난 사이, 고마워한다(신뢰·호감 +2), 우리 무리 사람이면 공적 +1
 */
export function welcomeRescued(ctx: ToolContext, ids: readonly string[]): string[] {
  const lines: string[] = [];
  for (const id of ids) {
    const s = ctx.store.getState();
    const c = s.characters[id];
    if (!c || c.dead || id === s.playerId) continue;
    // 같은 무리 사람은 처음부터 met이라 들고 나기를 건너뛰었다: 아는 마음(perceived)도 갱신한다 (12-265, PT18 졸병)
    if (!hasMet(s, s.playerId, id) && !s.scene.present.includes(id)) {
      ctx.store.append({ type: "npc_entered", npcId: id });
      ctx.store.append({ type: "npc_left", npcId: id });
    }
    ctx.store.append({ type: "relation_changed", from: id, to: s.playerId, delta: { trust: 2, affection: 2, respect: 0 }, reason: "갇힌 곳에서 꺼내 줬다", known: true });
    // 꺼내 왔으니 "붙잡혀 있다"는 기억을 지운다 (PT21·PT23 졸병: 구해 낸 사람을 계속 붙잡혀 있다고 믿었다)
    for (const b of ctx.store.getState().beliefs[s.playerId] ?? []) if (b.topic?.startsWith(`held_seen:${id}@`)) ctx.store.append({ type: "belief_dropped", characterId: s.playerId, beliefId: b.id });
    const mine = s.characters[s.playerId]?.factionId;
    if (mine && c.factionId === mine) ctx.store.append({ type: "merit_awarded", characterId: s.playerId, delta: 1, reason: `갇힌 ${playerCalls(s, ctx.content, id)}을 데려왔다` });
    lines.push(`${josa(playerCalls(s, ctx.content, id), "이/가")} 고마워한다 (신뢰·호감 +2${mine && c.factionId === mine ? ", 우리 무리 사람이라 공적 +1" : ""}).`);
  }
  return lines;
}
