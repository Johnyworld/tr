/**
 * 공통 규칙 19: 관계 오름 (docs/design.md "공통 규칙", 12-295).
 *
 * 주인공을 보는 마음이 오르는 길은 모두 여기를 거친다. 확률 없이 정해진다:
 * - 같은 사람·같은 축·같은 까닭(kind)으로 window_days 안에 다시 오르면 0 (PT23 섬: 판결 수용을 되풀이해 상관 신뢰가 사흘에 +4)
 * - 한 사람·한 축은 하루 daily_cap까지. 무거운 까닭(시나리오 relation_gain.heavy)과 이야기 효과는 상한을 넘는다 (같은 까닭 간격은 그대로)
 * - 내리막(-)은 줄이지 않는다. 세계를 만들 때의 시작 관계(startRelation)와 NPC끼리의 관계는 거르지 않는다
 * - 막히면 GM 결과 글에만 한 줄(regardNote). 플레이어 화면에는 보이지 않는다
 * 행적으로 오르는 관계(reputationTools.learn)도 같은 셈을 쓴다: 까닭 열쇠는 행적 꼬리표(deedKind), 같은 까닭 간격은 주인공의 행적만.
 * 셈하는 상태(regardGained·regardLast)는 이 모듈과 리듀서만 읽는다 (rules/guards.test.ts).
 * relation_changed는 이 모듈과 리듀서, 치트만 남긴다.
 */
import type { Content } from "../content/schemas.ts";
import { playerCalls } from "../game/acquaintance.ts";
import type { Deed, RelationDelta } from "../game/reputation.ts";
import type { GameState } from "../game/state.ts";
import type { GameStore } from "../game/store.ts";
import { josa } from "../text.ts";
import { dayOf, MINUTES_PER_DAY } from "./time.ts";

export const REGARD_AXES = ["trust", "affection", "respect"] as const;
export type RegardAxis = (typeof REGARD_AXES)[number];
type PartialDelta = Partial<Record<RegardAxis, number>>;

/** 코드가 남기는 까닭 열쇠. 무거운지는 시나리오 relation_gain.heavy가 정한다 (원칙 7) */
export const REGARD_KINDS = {
  rescue: "rescue",
  release: "release",
  squadRisky: "squad_risky",
  squadRest: "squad_rest",
  requestDone: "request_done",
  promiseKept: "promise_kept",
  promise: "promise",
  gift: "gift",
  reward: "reward",
  burial: "burial",
  coax: "coax",
  romance: "romance",
  persona: "persona",
  barter: "barter",
  leverage: "leverage",
  harm: "harm",
  captivity: "captivity",
  council: "council",
  death: "death",
  start: "start",
} as const;

type Ctx = { store: GameStore; content: Content };

export type RegardBlock = { why: "same" | "daily"; reason: string };

function rules(content: Content) {
  return content.scenario.relation_gain;
}

/** 행적의 까닭 열쇠: 꼬리표 묶음 */
export function deedKind(deed: Pick<Deed, "tags">): string {
  return `deed:${[...deed.tags].sort().join("+")}`;
}

function heavyKind(content: Content, kind: string): boolean {
  return rules(content).heavy.includes(kind);
}

/**
 * 오르는 몫을 규칙대로 깎는다 (내리막은 그대로). 상태를 바꾸지 않는다.
 * sameWindow가 false면 같은 까닭 간격을 보지 않는다 (NPC의 행적)
 */
export function gateRegard(
  state: GameState,
  content: Content,
  from: string,
  to: string,
  kind: string,
  delta: PartialDelta,
  opts: { heavy?: boolean; sameWindow?: boolean; reason: string },
): { delta: RelationDelta; blocked: RegardBlock | null } {
  const r = rules(content);
  const heavy = opts.heavy ?? heavyKind(content, kind);
  const day = dayOf(state.time);
  const today = state.regardGained.day === day ? (state.regardGained.by[from]?.[to] ?? {}) : {};
  const last = state.regardLast[from]?.[to] ?? {};
  const out: RelationDelta = { trust: delta.trust ?? 0, affection: delta.affection ?? 0, respect: delta.respect ?? 0 };
  let blocked: RegardBlock | null = null;
  for (const axis of REGARD_AXES) {
    if (out[axis] <= 0) continue;
    const at = last[`${kind}|${axis}`];
    if (opts.sameWindow !== false && at !== undefined && state.time - at < r.window_days * MINUTES_PER_DAY) {
      out[axis] = 0;
      blocked = { why: "same", reason: opts.reason };
      continue;
    }
    if (heavy) continue;
    const room = Math.max(0, r.daily_cap - (today[axis] ?? 0));
    if (out[axis] > room) {
      out[axis] = room;
      if (room === 0) blocked ??= { why: "daily", reason: opts.reason };
    }
  }
  return { delta: out, blocked };
}

/** 막힌 오름의 GM 한 줄 (플레이어 화면에는 보이지 않는다) */
export function regardNote(state: GameState, content: Content, from: string, b: RegardBlock): string {
  const name = josa(playerCalls(state, content, from), "은/는");
  return b.why === "same"
    ? `(${name} 같은 일로는 더 마음이 움직이지 않는다: ${b.reason}, ${rules(content).window_days}일 안)`
    : `(${name} 오늘은 더 마음이 움직이지 않는다: ${b.reason})`;
}

/**
 * 관계를 바꾼다. 주인공을 보는 마음의 오름만 규칙대로 깎고, NPC끼리는 그대로 남긴다.
 * 바뀐 것이 없으면 이벤트를 남기지 않는다. 막혔으면 note에 GM 한 줄
 */
export function changeRelation(
  ctx: Ctx,
  input: { from: string; to: string; delta: PartialDelta; reason: string; kind: string; known?: boolean; heavy?: boolean },
): { delta: RelationDelta; note: string | null } {
  const state = ctx.store.getState();
  const raw: RelationDelta = { trust: input.delta.trust ?? 0, affection: input.delta.affection ?? 0, respect: input.delta.respect ?? 0 };
  const gated = input.to === state.playerId ? gateRegard(state, ctx.content, input.from, input.to, input.kind, raw, { heavy: input.heavy, reason: input.reason }) : { delta: raw, blocked: null };
  const d = gated.delta;
  if (d.trust || d.affection || d.respect) {
    ctx.store.append({ type: "relation_changed", from: input.from, to: input.to, delta: d, reason: input.reason, kind: input.kind, ...(input.known ? { known: true } : {}) });
  }
  return { delta: d, note: gated.blocked ? regardNote(state, ctx.content, input.from, gated.blocked) : null };
}

/** 시작 관계 (세계·가족·첫인상·이미 맺은 연인): 거르지 않는다 */
export function startRelation(ctx: Ctx, input: { from: string; to: string; delta: RelationDelta; reason: string; known?: boolean }): void {
  ctx.store.append({ type: "relation_changed", from: input.from, to: input.to, delta: input.delta, reason: input.reason, kind: REGARD_KINDS.start, ...(input.known ? { known: true } : {}) });
}

/**
 * 이야기 효과의 까닭 열쇠: kind가 없으면 이야기 id. 이야기는 하루 상한을 받지 않는다 (사용자 결정, 12-295):
 * 이야기 사이 간격이 이미 횟수를 막고, 작가가 정한 크기를 그대로 둔다. 같은 까닭 간격만 받는다
 */
export function storyRegard(storyletId: string, effect: { kind?: string }): { kind: string; heavy: boolean } {
  return { kind: effect.kind ?? `story:${storyletId}`, heavy: true };
}
