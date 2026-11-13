import { z } from "zod";
import type { Content } from "../content/schemas.ts";
import { playerCalls } from "../game/acquaintance.ts";
import type { Character } from "../game/character.ts";
import { NEUTRAL_RELATION } from "../game/reputation.ts";
import type { GameState } from "../game/state.ts";
import { tiesOf } from "../game/ties.ts";
import { CHECK_OUTCOME_LABELS } from "../rules/check.ts";
import { dayOf } from "../rules/time.ts";
import { isAdult } from "../story/storylets.ts";
import { josa, sentence } from "../text.ts";
import { changeCondition } from "./body.ts";
import { withCharm } from "./charm.ts";
import { rollPlayerCheck } from "./checks.ts";
import { defineTool, type ToolContext, type ToolDisplayEvent, type ToolOutcome } from "./toolkit.ts";

/**
 * 연애 (12-58). 수위가 켜져 있고 둘 다 성인일 때만 (12-57).
 * - 끌림은 인물 데이터 (attracted_to). 없으면 월드의 비율로 인물 id에서 정해진다 (판마다 같다). 성별만으로 정하지 않는다
 * - 마음: 끌리고 호감이 interest_affection 이상이면 마음이 있다. GM에게는 낌새(눈길)로만 보인다 (속마음을 말하지 않는다, 원칙 4)
 * - 다가가기(flirt)는 판정, 고백(confess)을 받아들일지는 코드가 정한다 (끌림·호감·신뢰, 이미 마음을 둔 사람이 있는지)
 * - 삼각관계: 연인이 있는 사람에게 다가가면 그 연인이 질투한다 / 연인이 둘이면 먼저 연인이 알아챈다 / 둘이 주인공에게 마음이 있으면 서로 앙금이 생긴다
 * - 연인이 죽으면 마음이 무너진다
 */

const rules = (content: Content) => content.scenario.romance;
const key = (a: string, b: string) => [a, b].sort().join("|");

/** 문자열에서 0~1 사이 수 (판마다 같은 끌림) */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

/** 이 사람이 끌리는 성별들 */
export function attractionOf(state: GameState, content: Content, c: Character): string[] {
  const genders = content.scenario.creation?.genders.map((g) => g.id) ?? [];
  if (c.id === state.playerId) return genders; // 주인공의 마음은 플레이어가 정한다
  if (c.attraction) return c.attraction;
  const o = rules(content)?.orientation;
  if (!o || !c.gender) return genders.filter((g) => g !== c.gender);
  const total = o.other + o.both + o.same + o.none || 1;
  const r = hash01(`attraction:${c.id}`) * total;
  if (r < o.other) return genders.filter((g) => g !== c.gender);
  if (r < o.other + o.both) return genders;
  if (r < o.other + o.both + o.same) return [c.gender];
  return [];
}

/** 연애가 가능한가: 수위가 켜져 있고 둘 다 성인이고 살아 있다 */
export function romanceAllowed(state: GameState, content: Content, a: string, b: string): boolean {
  const ca = state.characters[a];
  const cb = state.characters[b];
  return !!rules(content) && !!state.options?.mature && !!ca && !!cb && !ca.dead && !cb.dead && a !== b && isAdult(content, ca) && isAdult(content, cb);
}

/** from이 to에게 끌리는가 */
export function attracted(state: GameState, content: Content, from: string, to: string): boolean {
  const f = state.characters[from];
  const t = state.characters[to];
  return !!f && !!t && !!t.gender && attractionOf(state, content, f).includes(t.gender);
}

/** from이 to에게 마음이 있는가 (끌리고 호감이 문턱 이상) */
export function hasInterest(state: GameState, content: Content, from: string, to: string): boolean {
  const r = rules(content);
  if (!r || !romanceAllowed(state, content, from, to) || !attracted(state, content, from, to)) return false;
  return (state.relations[from]?.[to] ?? NEUTRAL_RELATION).affection >= r.interest_affection;
}

/** 이 사람의 연인들 (주인공과의 연애 + 정해진 관계의 연인·배우자) */
export function loversOf(state: GameState, content: Content, id: string): string[] {
  const out = new Set<string>();
  for (const r of Object.values(state.romances ?? {})) {
    if (r.stage !== "lovers") continue;
    if (r.a === id) out.add(r.b);
    if (r.b === id) out.add(r.a);
  }
  for (const t of tiesOf(state, content, id)) {
    if ((t.kind === "lover" || t.kind === "spouse") && !state.characters[t.other]?.dead && state.romances?.[key(id, t.other)]?.stage !== "ended") out.add(t.other);
  }
  return [...out].filter((x) => state.characters[x] && !state.characters[x]!.dead).sort();
}

/** 이야기 배역 (12-58): lover 주인공의 연인, suitor 주인공에게 마음이 있는 사람(연인이 아닌), jealous 다른 연인을 알아챈 연인, rival_lover 주인공이 마음을 둔 사람의 다른 연인 */
export function romanceCast(state: GameState, content: Content, kind: "lover" | "suitor" | "jealous" | "rival_lover"): string[] {
  const me = state.playerId;
  const lovers = loversOf(state, content, me);
  if (kind === "lover") return lovers;
  if (kind === "jealous") return lovers.filter((id) => state.romances[key(me, id)]?.jealousOf.length);
  if (kind === "suitor") {
    return Object.keys(state.characters)
      .filter((id) => id !== me && !lovers.includes(id) && !state.characters[id]!.captive && !state.characters[id]!.away && hasInterest(state, content, id, me))
      .sort();
  }
  // 주인공이 다가간 사람(또는 연인)의 다른 연인
  const out = new Set<string>();
  for (const id of new Set([...lovers, ...Object.keys(state.flirtDay ?? {})])) for (const other of loversOf(state, content, id)) if (other !== me) out.add(other);
  return [...out].filter((id) => !state.characters[id]!.captive && !state.characters[id]!.away).sort();
}

/** 다른 연인이 생겼을 때: 하루마다 확률로 알아챈다 (함께 장면에 있으면 반드시). 알아채면 마음이 식고, 많이 식으면 떠난다 */
export function runRomance(ctx: ToolContext): ToolDisplayEvent[] {
  const r = rules(ctx.content);
  const state = ctx.store.getState();
  const me = state.playerId;
  if (!r || !state.options?.mature) return [];
  const lovers = loversOf(state, ctx.content, me).filter((id) => state.romances[key(me, id)]?.stage === "lovers");
  const displays: ToolDisplayEvent[] = [];
  // 둘이 주인공에게 마음이 있고 한자리에 있으면 서로 앙금이 생긴다 (삼각관계)
  const suitors = state.scene.present.filter((id) => hasInterest(state, ctx.content, id, me));
  for (const x of suitors) for (const y of suitors) {
    if (x < y && ctx.rng() < 0.5) {
      ctx.store.append({ type: "relation_changed", from: x, to: y, delta: { trust: -1, affection: -1, respect: 0 }, reason: "같은 사람을 본다" });
      ctx.store.append({ type: "relation_changed", from: y, to: x, delta: { trust: -1, affection: -1, respect: 0 }, reason: "같은 사람을 본다" });
    }
  }
  for (const a of lovers) {
    const romance = ctx.store.getState().romances[key(me, a)]!;
    for (const b of lovers) {
      if (a === b || romance.jealousOf.includes(b)) continue;
      // 나중에 생긴 연인만 질투의 대상이다
      if ((ctx.store.getState().romances[key(me, b)]?.since ?? 0) < romance.since) continue;
      const together = state.scene.present.includes(a) && state.scene.present.includes(b);
      if (!together && ctx.rng() >= r.jealousy_chance) continue;
      noticeRival(ctx, a, b);
    }
    const rel = ctx.store.getState().relations[a]?.[me] ?? NEUTRAL_RELATION;
    if (ctx.store.getState().romances[key(me, a)]?.jealousOf.length && rel.affection <= -1) {
      ctx.store.append({ type: "romance_changed", a: me, b: a, stage: "ended" });
      const fact = sentence(`${playerCalls(state, ctx.content, a)}이(가) 떠났다. 다른 사람이 있다는 것을 알았다`);
      ctx.store.append({ type: "belief_added", characterId: me, belief: { id: `b_${ctx.store.getState().nextBeliefNo}`, fact, source: "seen", accuracy: "exact", learnedAt: state.time } });
      displays.push({ type: "belief", fact, sourceLabel: "본 것" });
    }
  }
  return displays;
}

/** a가 주인공의 다른 연인 b를 알아챈다 */
function noticeRival(ctx: ToolContext, a: string, b: string) {
  const me = ctx.store.getState().playerId;
  ctx.store.append({ type: "romance_jealousy", who: a, about: b });
  ctx.store.append({ type: "relation_changed", from: a, to: me, delta: { trust: -2, affection: -3, respect: -1 }, reason: "다른 연인" });
  ctx.store.append({ type: "relation_changed", from: a, to: b, delta: { trust: -2, affection: -2, respect: 0 }, reason: "질투" });
}

/** 연인이 죽었다 (people.onPersonDeath에서) */
export function onLoverDeath(ctx: ToolContext, id: string): void {
  const r = rules(ctx.content);
  const state = ctx.store.getState();
  if (!r || state.romances?.[key(state.playerId, id)]?.stage !== "lovers") return;
  const nerves = ctx.content.scenario.body?.nerves?.track;
  if (nerves && r.grief_nerves > 0) changeCondition(ctx, state.playerId, nerves, r.grief_nerves, "grief", `${playerCalls(state, ctx.content, id)}을(를) 잃었다`);
}

/** GM 상태: 연인, 그리고 장면에서 보이는 낌새 (속마음 대신 겉으로 보이는 것) */
export function describeRomanceForGm(state: GameState, content: Content): string {
  if (!rules(content) || !state.options?.mature) return "";
  const me = state.playerId;
  const lines: string[] = [];
  const lovers = loversOf(state, content, me).filter((id) => state.romances[key(me, id)]?.stage === "lovers");
  if (lovers.length) {
    lines.push(
      `연인: ${lovers
        .map((id) => {
          const j = state.romances[key(me, id)]!.jealousOf.map((x) => playerCalls(state, content, x));
          return `${playerCalls(state, content, id)} (${id})${j.length ? ` · ${j.join(", ")}을(를) 알고 질투한다` : ""}`;
        })
        .join(", ")}`,
    );
  }
  const glances = state.scene.present.filter((id) => !lovers.includes(id) && hasInterest(state, content, id, me));
  if (glances.length) lines.push(`눈길 (겉으로 보이는 낌새만 서술한다, 속마음을 말하지 않는다): ${glances.map((id) => playerCalls(state, content, id)).join(", ")}이(가) 자꾸 당신을 본다`);
  return lines.join("\n");
}

const romanceTool = defineTool({
  name: "romance",
  description:
    "연애 (12-58, 수위가 켜져 있고 둘 다 성인일 때만). 플레이어가 그렇게 하기로 했을 때만. " +
    "flirt 다가간다 (approach: 교섭 등 스킬, 하루에 한 사람 한 번), confess 마음을 고백한다 (받아들일지는 시스템이 정한다), break_up 헤어진다. " +
    "상대는 장면에 있어야 한다. 결과를 미리 말하지 않는다. 잠자리는 암전으로 넘긴다.",
  schema: z.strictObject({
    target: z.string(),
    action: z.enum(["flirt", "confess", "break_up"]),
    approach: z.string().nullable().default(null).describe("다가가기에 쓰는 스킬 id (flirt만)"),
    stat: z.string().nullable().default(null).describe("그 스킬의 능력 id (flirt만)"),
  }),
  run(input, ctx): ToolOutcome {
    const { store, content } = ctx;
    const r = rules(content);
    const state = store.getState();
    const me = state.playerId;
    const t = input.target;
    if (!r) return { ok: false, error: "이 월드에는 연애 규칙이 없다." };
    if (!romanceAllowed(state, content, me, t)) return { ok: false, error: "연애는 수위가 켜져 있고 둘 다 성인일 때만 다룬다." };
    if (!state.scene.present.includes(t)) return { ok: false, error: "그 사람이 장면에 없다." };
    const name = playerCalls(state, content, t);
    const lovers = loversOf(state, content, me);
    const romance = state.romances[key(me, t)];
    let display: ToolDisplayEvent = { type: "presence", npcName: name, action: "enter" };
    const lines: string[] = [];
    // 연인이 보는 앞에서 다른 사람에게 다가가면 그 자리에서 알아챈다 (삼각관계)
    const watchers = () => lovers.filter((l) => l !== t && state.scene.present.includes(l));

    if (input.action === "flirt") {
      const day = dayOf(state.time);
      if (state.flirtDay?.[t] === day) return { ok: false, error: "오늘은 이미 다가갔다. 하루에 한 번." };
      if (!input.approach || !input.stat || !r.flirt_moves.includes(input.approach)) return { ok: false, error: `approach는 ${r.flirt_moves.join("/")} 중 하나, stat은 그 스킬의 능력.` };
      const roll = rollPlayerCheck({ move: input.approach, stat: input.stat, difficulty: "normal", intent: `${name}에게 다가간다` }, ctx);
      if (!roll.ok) return roll;
      display = roll.display;
      store.append({ type: "flirted", target: t, day });
      const drawn = attracted(state, content, t, me);
      const gain = roll.outcome === "success" ? 2 : roll.outcome === "partial" ? 1 : -1;
      const delta = drawn ? gain : Math.min(0, gain);
      if (delta !== 0) store.append({ type: "relation_changed", from: t, to: me, delta: withCharm(ctx, t, me, { trust: 0, affection: delta, respect: 0 }), reason: "다가감" });
      lines.push(`다가가기: ${CHECK_OUTCOME_LABELS[roll.outcome]}. ${delta > 0 ? `${josa(name, "이/가")} 싫지 않은 기색이다.` : delta < 0 ? "어색해졌다." : `${josa(name, "은/는")} 친절하지만 그 이상은 아닌 듯하다.`}`);
    } else if (input.action === "confess") {
      if (romance?.stage === "lovers") return { ok: false, error: "이미 연인이다." };
      const rel = state.relations[t]?.[me] ?? NEUTRAL_RELATION;
      const others = loversOf(state, content, t).filter((x) => x !== me);
      // 이미 마음을 둔 사람이 있으면, 그 사람보다 주인공을 더 좋아할 때만
      const fondOfOther = others.some((o) => (state.relations[t]?.[o] ?? NEUTRAL_RELATION).affection >= rel.affection);
      const yes = attracted(state, content, t, me) && rel.affection >= r.accept.affection && rel.trust >= r.accept.trust && !fondOfOther;
      if (yes) {
        store.append({ type: "romance_changed", a: me, b: t, stage: "lovers" });
        lines.push(`${josa(name, "이/가")} 마음을 받아들였다. 이제 연인이다.`);
        // 그 사람의 다른 연인은 버림받는다 (삼각관계)
        for (const o of others) {
          if (state.romances[key(t, o)]?.stage !== "ended") store.append({ type: "romance_changed", a: t, b: o, stage: "ended" });
          store.append({ type: "relation_changed", from: o, to: me, delta: { trust: -3, affection: -3, respect: -1 }, reason: "연인을 빼앗김" });
          store.append({ type: "relation_changed", from: o, to: t, delta: { trust: -2, affection: -2, respect: 0 }, reason: "떠남" });
          lines.push(`${josa(playerCalls(state, content, o), "은/는")} ${name}의 연인이었다. 이제 당신을 원망한다.`);
        }
      } else {
        store.append({ type: "relation_changed", from: t, to: me, delta: { trust: 0, affection: others.length ? 0 : -1, respect: 0 }, reason: "고백을 거절함" });
        lines.push(`${josa(name, "은/는")} 받아들이지 않았다.${others.length ? " 마음을 둔 사람이 따로 있는 듯하다." : ""}`);
      }
    } else {
      if (romance?.stage !== "lovers") return { ok: false, error: "연인이 아니다." };
      store.append({ type: "romance_changed", a: me, b: t, stage: "ended" });
      store.append({ type: "relation_changed", from: t, to: me, delta: { trust: -1, affection: -2, respect: 0 }, reason: "이별" });
      lines.push(`${name}와(과) 헤어졌다.`);
    }
    for (const w of watchers()) {
      if (input.action === "break_up") continue;
      noticeRival(ctx, w, t);
      lines.push(`연인 ${josa(playerCalls(state, content, w), "이/가")} 그 모습을 봤다.`);
    }
    lines.push("이 결과에 맞게 장면을 서술한다. 잠자리는 암전으로 넘긴다. 상대의 속마음을 단정해 말하지 않는다.");
    return { ok: true, resultText: lines.join("\n"), display };
  },
});

export const ROMANCE_TOOLS = [romanceTool] as const;
