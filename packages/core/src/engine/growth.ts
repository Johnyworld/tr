import { josa } from "../text.ts";
import { occupationOf } from "../game/occupation.ts";
import type { CheckOutcome } from "../rules/check.ts";
import { xpMultiplier } from "./traits.ts";
import { dayOf } from "../rules/time.ts";
import { moveOf, raiseCost, skillTierLabel } from "../scenario/scenario.ts";
import type { Scenario } from "../scenario/schema.ts";
import { z } from "zod";
import { idEnum } from "../scenario/schema.ts";
import { moveIds } from "../scenario/scenario.ts";
import type { ToolContext, ToolOutcome } from "./toolkit.ts";
import { learned } from "../rules/skill.ts";

/**
 * 경험치와 레벨업 (기획서 4.2). 수치는 시나리오 `growth`. 없으면 성장하지 않는다.
 * 레벨은 1부터 시작한다. 레벨 n에 필요한 누적 경험치: first + (first+step) + … (n-1번, 레벨마다 step씩 더 든다)
 */
export const FIRST_LEVEL = 1;

export function xpForLevel(s: Scenario, level: number): number {
  const g = s.growth;
  if (!g || level <= FIRST_LEVEL) return 0;
  let total = 0;
  for (let i = 0; i < level - FIRST_LEVEL; i++) total += Math.round((g.first + g.step * i) * (g.ratio ?? 1) ** i);
  return total;
}

/** 버팀 확률 (12-109): 레벨 2부터 그 레벨이 속한 구간의 per를 더해 간다. 1을 넘지 않는다 */
export function resilienceOf(s: Scenario, level: number): number {
  const tiers = s.growth?.resilience ?? [];
  let r = 0;
  for (let l = FIRST_LEVEL + 1; l <= level; l++) {
    let per = 0;
    for (const t of tiers) if (t.from <= l) per = t.per;
    r += per;
  }
  return Math.min(1, Math.round(r * 1000) / 1000);
}

/** 최대 레벨이면 true (12-109) */
export function atMaxLevel(s: Scenario, level: number): boolean {
  const max = s.growth?.max_level;
  return max !== undefined && level >= max;
}

/** 나빠지는 steps단계를 한 단계씩 버팀으로 굴려 남는 단계 수 (12-109) */
export function resistSteps(s: Scenario, level: number, steps: number, rng: () => number): number {
  const r = resilienceOf(s, level);
  if (r <= 0 || steps <= 0) return steps;
  let kept = 0;
  for (let i = 0; i < steps; i++) if (rng() >= r) kept++;
  return kept;
}

export function levelForXp(s: Scenario, xp: number): number {
  if (!s.growth) return FIRST_LEVEL;
  let level = FIRST_LEVEL;
  while (!atMaxLevel(s, level) && xpForLevel(s, level + 1) <= xp) level += 1;
  return level;
}

/** 경험치를 준다. 레벨이 오르면 GM에게 알릴 문장을 돌려준다 */
function grant(ctx: ToolContext, characterId: string, amount: number, source: "check" | "merit"): string | null {
  const s = ctx.content.scenario;
  const c = ctx.store.getState().characters[characterId];
  if (!c || c.dead || amount <= 0) return null;
  const level = levelForXp(s, c.xp + amount);
  ctx.store.append({ type: "xp_gained", characterId, amount, source, level });
  if (level <= c.level) return null;
  return `${c.name}의 레벨이 올랐다 (레벨 ${level}, 스킬 포인트 +${level - c.level}). 올릴 스킬을 플레이어에게 물어 learn_skill로 올린다 (모아 둘 수도 있다).`;
}

/** 판정 경험치 (하루 상한까지) */
export function gainCheckXp(ctx: ToolContext, characterId: string, outcome: CheckOutcome): string | null {
  const g = ctx.content.scenario.growth;
  if (!g) return null;
  const state = ctx.store.getState();
  const today = state.xpToday.day === dayOf(state.time) ? state.xpToday.amount : 0;
  const c = state.characters[characterId];
  const base = c ? Math.round(g.xp[outcome] * xpMultiplier(ctx.content, c)) : g.xp[outcome];
  const amount = Math.min(base, g.daily_check_cap - today);
  return grant(ctx, characterId, amount, "check");
}

/** 공적 경험치 (얻은 공적만, 잃은 공적은 경험치를 빼지 않는다) */
export function gainMeritXp(ctx: ToolContext, characterId: string, merit: number): string | null {
  const g = ctx.content.scenario.growth;
  if (!g || merit <= 0) return null;
  const c = ctx.store.getState().characters[characterId];
  return grant(ctx, characterId, Math.round(merit * g.xp.merit * (c ? xpMultiplier(ctx.content, c) : 1)), "merit");
}

/** 다짐을 이룬 보상 (12-164): 정해진 경험치 (트레잇 배수를 탄다) */
export function gainResolveXp(ctx: ToolContext, characterId: string, amount: number): string | null {
  const c = ctx.store.getState().characters[characterId];
  return grant(ctx, characterId, Math.round(amount * (c ? xpMultiplier(ctx.content, c) : 1)), "merit");
}

/** learn_skill: 스킬 포인트로 스킬 하나를 한 단계 올린다 (4.2.1, 단계마다 값이 다르다). 게임 시간을 쓰지 않는다 */
export function learnSkill(input: { skill: string }, ctx: ToolContext): ToolOutcome {
  const s = ctx.content.scenario;
  const state = ctx.store.getState();
  const player = state.characters[state.playerId];
  if (!player || player.dead) return { ok: false, error: "플레이어 캐릭터가 없습니다." };
  const move = moveOf(s, input.skill);
  if (!move) return { ok: false, error: `알 수 없는 스킬: ${input.skill}` };
  const from = learned(s, player.skills, input.skill);
  if (from === null) return { ok: false, error: `${josa(move.label, "은/는")} 전문 기술이라 먼저 배워야 한다. 그 스킬을 익힌 사람(+1 이상)에게 배운다 (take_action.lesson).` };
  if (from >= s.ranges.skill.max) return { ok: false, error: `${josa(move.label, "은/는")} 이미 최고 단계다.` };
  const cost = raiseCost(s, from);
  if (player.skillPoints < cost) return { ok: false, error: `스킬 포인트가 모자란다 (${move.label} ${signed(from)} → ${signed(from + 1)}에 ${cost}점, 가진 것 ${player.skillPoints}점).` };
  ctx.store.append({ type: "skill_learned", characterId: player.id, skill: input.skill, from, to: from + 1, cost });
  const left = player.skillPoints - cost;
  return {
    ok: true,
    resultText: `${move.label}: ${skillLevelLabel(s, input.skill, from)} → ${skillLevelLabel(s, input.skill, from + 1)} (${cost}점).` + (left > 0 ? ` 남은 스킬 포인트 ${left}.` : ""),
    display: { type: "growth", name: player.name, skill: move.label, from: skillLevelLabel(s, input.skill, from), to: skillLevelLabel(s, input.skill, from + 1) },
  };
}

const signed = (v: number) => `${v >= 0 ? "+" : ""}${v}`;

/** 스킬 단계 이름과 값: "숙련 +1", "못 함" (4.2.1) */
export function skillLevelLabel(s: Scenario, id: string, value: number | null): string {
  const tier = skillTierLabel(s, id, value);
  return value === null ? tier : `${tier} ${signed(value)}`;
}

export const createLearnSkillTool = (s: Scenario) => ({
  name: "learn_skill",
  description:
    "스킬 포인트로 스킬 하나를 한 단계 올린다 (최고 단계까지). 단계마다 드는 점수가 다르고 시스템이 센다. 고르는 것은 플레이어다: 레벨이 오르면 플레이어에게 물어보고 고른 스킬로 호출한다. 배우지 않은 전문 기술은 올릴 수 없다 (먼저 사람에게 배운다, take_action.lesson). 게임 시간을 쓰지 않는다. 능력은 오르지 않는다.",
  schema: z.strictObject({ skill: idEnum(moveIds(s)).describe("올릴 스킬 id") }),
  run: learnSkill,
});

/** 스킬을 분류별 한 줄씩: "전투  근접전 +1 · 사격 -1 · 손질 못 함" (보여 줄 때 쓴다) */
export function skillLines(s: Scenario, skills: Partial<Record<string, number>>): string[] {
  const groups = new Map<string, string[]>();
  for (const m of s.moves) {
    const key = m.category ?? "스킬";
    const value = learned(s, skills, m.id);
    const list = groups.get(key) ?? [];
    list.push(`${m.label} ${value === null ? "못 함" : signed(value)}`);
    groups.set(key, list);
  }
  return [...groups].map(([k, list]) => `${k}  ${list.join(" · ")}`);
}

/** 레벨·경험치 한 줄 (성장 규칙이 없으면 null) */
export function growthLine(s: Scenario, c: { level: number; xp: number; skillPoints: number }): string | null {
  if (!s.growth) return null;
  const xp = atMaxLevel(s, c.level) ? `경험치 ${c.xp} (최대 레벨)` : `경험치 ${c.xp}/${xpForLevel(s, c.level + 1)}`;
  return `레벨 ${c.level} · ${xp}` + (c.skillPoints > 0 ? ` · 스킬 포인트 ${c.skillPoints}점` : "");
}

/**
 * 직분의 평판 ± (기획서 12.6). 직분에는 사다리가 없어 평판은 숫자로만 쌓인다 (12-83). 돌려줄 줄은 없다.
 * 직분이 없으면 아무 일도 없다
 */
export function changeStanding(ctx: ToolContext, characterId: string, delta: number, reason: string): string | null {
  const before = ctx.store.getState().characters[characterId];
  if (!before?.occupation || !occupationOf(ctx.content, before) || delta === 0) return null;
  ctx.store.append({ type: "occupation_standing_changed", characterId, delta, reason });
  return null;
}
