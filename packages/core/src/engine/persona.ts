import type { Content } from "../content/schemas.ts";
import type { Character } from "../game/character.ts";
import type { Scenario } from "../scenario/schema.ts";
import { josa } from "../text.ts";
import { traitsOf } from "./traits.ts";
import type { ToolContext } from "./toolkit.ts";

/**
 * 성격 축 (기획서 4.6.1, 12-99). 축마다 -2(low 쪽) ~ +2(high 쪽).
 * - 주인공: 만들 때 정한 값 (Character.persona)
 * - NPC: Character.persona가 없으면 성격 트레잇의 persona를 더해 -2~2로 자른다 (콘텐츠를 다시 쓰지 않고 같은 틀, 원칙 6)
 * - 말투·태도는 GM이 연기한다. 결과가 남는 순간(발끈, 말 새어 나감, 궁합, 연애 문턱)은 여기서 코드가 정하고 🎭 줄로 알린다
 */

export type PersonaRules = NonNullable<Scenario["persona"]>;
export type PersonaAxis = PersonaRules["axes"][number];

const clamp = (n: number) => Math.max(-2, Math.min(2, n));

/** 인물 id와 축에서 정해지는 0 ~ 1 (판마다 같다) */
function seeded(id: string, axis: string): number {
  let h = 2166136261;
  for (const ch of `${id}:${axis}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 빈 축을 무게대로 뽑는다 */
function fillAxis(weights: Partial<Record<string, number>>, roll: number): number {
  const entries = (["-2", "-1", "0", "1", "2"] as const).map((k) => [Number(k), weights[k] ?? 0] as const);
  const total = entries.reduce((n, [, w]) => n + w, 0);
  if (total <= 0) return 0;
  let acc = 0;
  for (const [v, w] of entries) {
    acc += w / total;
    if (roll < acc) return v;
  }
  return 0;
}

/**
 * 이 캐릭터의 축 값 (0인 축은 빠질 수 있다).
 * 주인공처럼 persona가 있으면 그것. NPC는 성격 트레잇의 합이고, 트레잇이 정하지 않은 축은 fill의 무게로 인물 id에서 뽑는다
 */
export function personaOf(content: Content, c: Pick<Character, "id" | "traits" | "persona">): Record<string, number> {
  const rules = content.scenario.persona;
  if (!rules) return {};
  if (c.persona) return c.persona;
  const sum: Record<string, number> = {};
  for (const t of traitsOf(content, c)) for (const [axis, v] of Object.entries(t.persona ?? {})) sum[axis] = (sum[axis] ?? 0) + v;
  for (const [axis, weights] of Object.entries(rules.fill ?? {})) if (sum[axis] === undefined) sum[axis] = fillAxis(weights, seeded(c.id, axis));
  return Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, clamp(v)]).filter(([, v]) => v !== 0));
}

/** 축 값 하나의 이름: 다혈질 2, 과묵함 1 */
function sideLabel(axis: PersonaAxis, value: number): string {
  return `${value > 0 ? axis.high : axis.low} ${Math.abs(value)}`;
}

/** "다혈질 2(같은 지시도 거칠게…), 과묵함 1(…)". acting이면 연기 지침을 붙인다. 0인 축은 뺀다 */
export function describePersona(content: Content, c: Pick<Character, "id" | "traits" | "persona">, options: { acting?: boolean } = {}): string {
  const rules = content.scenario.persona;
  if (!rules) return "";
  const p = personaOf(content, c);
  return rules.axes
    .filter((a) => (p[a.id] ?? 0) !== 0)
    .map((a) => {
      const v = p[a.id]!;
      const acting = (v > 0 ? a.high_acting : a.low_acting)[Math.abs(v) - 1];
      return options.acting ? `${sideLabel(a, v)}(${acting})` : sideLabel(a, v);
    })
    .join(", ");
}

const DEFAULT_WORDS = ["기본", "default", "없음", "none", "보통", "상관없음", "0", ""];

/**
 * 플레이어의 답 → 축 값. "다혈질 2, 과묵함 1", "temper 2", 숫자 없이 이름만이면 1. "기본"이면 모두 0.
 * 쓰지 않은 축은 0
 */
export function parsePersona(s: Scenario, text: string): { ok: true; values: Record<string, number> } | { ok: false; error: string } {
  const rules = s.persona;
  if (!rules) return { ok: true, values: {} };
  const values: Record<string, number> = {};
  if (DEFAULT_WORDS.includes(text.trim().toLowerCase())) return { ok: true, values };
  for (const part of text.split(/[,，、/\n]+/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^(.+?)\s*[:=]?\s*([+-]?\d+)?$/.exec(part);
    const name = (m?.[1] ?? part).trim();
    const n = m?.[2] !== undefined ? Number(m[2]) : 1;
    const hit = rules.axes.flatMap((a) => [
      { axis: a, sign: 1, names: [a.high] },
      { axis: a, sign: -1, names: [a.low] },
      { axis: a, sign: 0, names: [a.id] },
    ]).find((x) => x.names.some((w) => w === name || w.toLowerCase() === name.toLowerCase()));
    if (!hit) return { ok: false, error: `"${name}"이라는 성격은 없다. 고를 수 있는 것: ${rules.axes.map((a) => `${a.low} ↔ ${a.high}`).join(", ")}` };
    const value = hit.sign === 0 ? n : hit.sign * Math.abs(n);
    if (!Number.isInteger(value) || value < -2 || value > 2) return { ok: false, error: `${name}은(는) 1이나 2로 적는다 (축마다 -2 ~ +2).` };
    if (values[hit.axis.id] !== undefined) return { ok: false, error: `${hit.axis.low} ↔ ${hit.axis.high}을(를) 두 번 적었다.` };
    if (value !== 0) values[hit.axis.id] = value;
  }
  return { ok: true, values };
}

/** 확인 단계·요약의 한 줄: "다혈질 2, 과묵함 1" (모두 0이면 "보통") */
export function personaSummary(s: Scenario, values: Record<string, number>): string {
  const rules = s.persona;
  if (!rules) return "";
  return rules.axes.filter((a) => values[a.id]).map((a) => sideLabel(a, values[a.id]!)).join(", ") || "보통";
}

/** 처음 만날 때 성격 궁합으로 생기는 호감 (rapport): 같은 쪽 축마다 same, 반대쪽마다 opposite. 합은 -2~2 */
export function rapportImpression(content: Content, viewer: Character, target: Character): number {
  const r = content.scenario.persona?.rapport;
  if (!r) return 0;
  const a = personaOf(content, viewer);
  const b = personaOf(content, target);
  let total = 0;
  for (const axis of r.axes) {
    const x = a[axis] ?? 0;
    const y = b[axis] ?? 0;
    if (!x || !y) continue;
    total += Math.sign(x) === Math.sign(y) ? r.same : r.opposite;
  }
  return clamp(total);
}

/** 연애 문턱을 올리고 내리는 양 (+면 마음이 늦다). 연애 규칙이 없으면 0 */
export function romanceShift(content: Content, c: Character): number {
  const r = content.scenario.persona?.romance;
  if (!r) return 0;
  return (personaOf(content, c)[r.axis] ?? 0) * r.per_level;
}

/** 🎭 줄 (판정 줄처럼 GM이 서술 끝에 그대로 옮긴다) */
const persona = (axis: PersonaAxis, value: number, what: string) => `🎭 ${sideLabel(axis, value)}: ${what}`;

/**
 * 도발당했을 때 발끈하는지 (blowup). 주인공의 +쪽 단계만큼 굴린다. 터지면 상대(target)의 관계가 바뀐다.
 * 돌려주는 줄은 GM이 그대로 옮겨 적는다. 안 터지면 null
 */
export function rollBlowup(ctx: ToolContext, targetId: string | null): string | null {
  const rule = ctx.content.scenario.persona?.blowup;
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!rule || !me || me.dead) return null;
  const axis = ctx.content.scenario.persona!.axes.find((a) => a.id === rule.axis)!;
  const v = personaOf(ctx.content, me)[rule.axis] ?? 0;
  if (v <= 0 || ctx.rng() >= rule.chance[v - 1]!) return null;
  const target = targetId ? state.characters[targetId] : undefined;
  if (target && !target.dead && state.scene.present.includes(target.id)) {
    ctx.store.append({ type: "relation_changed", from: target.id, to: me.id, delta: rule.delta, reason: `${me.name}이(가) 발끈했다` });
    const parts = [rule.delta.trust && `신뢰 ${rule.delta.trust > 0 ? "+" : ""}${rule.delta.trust}`, rule.delta.affection && `호감 ${rule.delta.affection > 0 ? "+" : ""}${rule.delta.affection}`, rule.delta.respect && `존중 ${rule.delta.respect > 0 ? "+" : ""}${rule.delta.respect}`].filter(Boolean);
    return persona(axis, v, `발끈했다 · ${target.name}의 ${parts.join(", ")}`);
  }
  return persona(axis, v, "발끈했다");
}

/**
 * 장면의 인물과 이야기하다 아는 사실 하나가 새어 나가는지 (leak). 주인공의 +쪽 단계만큼 굴린다.
 * 터지면 주인공이 아는 사실(믿음) 중 하나를 그 인물이 알게 된다 (주인공이 아는 것만이라 정보 필터를 지킨다, 원칙 4). 안 터지면 null
 */
export function rollLeak(ctx: ToolContext, targetId: string | null): string | null {
  const rule = ctx.content.scenario.persona?.leak;
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  const target = targetId ? state.characters[targetId] : undefined;
  if (!rule || !me || me.dead || !target || target.dead || !state.scene.present.includes(target.id)) return null;
  const axis = ctx.content.scenario.persona!.axes.find((a) => a.id === rule.axis)!;
  const v = personaOf(ctx.content, me)[rule.axis] ?? 0;
  if (v <= 0 || ctx.rng() >= rule.chance[v - 1]!) return null;
  const theirs = new Set((state.beliefs[target.id] ?? []).map((b) => b.fact));
  const mine = (state.beliefs[me.id] ?? []).filter((b) => !theirs.has(b.fact));
  if (!mine.length) return null;
  const fact = mine[Math.floor(ctx.rng() * mine.length)]!;
  ctx.store.append({
    type: "belief_added",
    characterId: target.id,
    belief: { id: `b_${state.nextBeliefNo}`, fact: fact.fact, source: "report", accuracy: fact.accuracy, learnedAt: state.time, ...(fact.topic ? { topic: fact.topic } : {}) },
  });
  return persona(axis, v, `무심코 말해 버렸다 · ${josa(target.name, "이/가")} 알게 됐다: "${fact.fact}"`);
}
