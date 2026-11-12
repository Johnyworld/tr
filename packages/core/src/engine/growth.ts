import type { CheckOutcome } from "../rules/check.ts";
import { dayOf } from "../rules/time.ts";
import { moveOf } from "../scenario/scenario.ts";
import type { Scenario } from "../scenario/schema.ts";
import { z } from "zod";
import { idEnum } from "../scenario/schema.ts";
import { moveIds } from "../scenario/scenario.ts";
import type { ToolContext, ToolOutcome } from "./toolkit.ts";

/**
 * 경험치와 레벨업 (기획서 4.2). 수치는 시나리오 `growth`. 없으면 성장하지 않는다.
 * 레벨 n에 필요한 누적 경험치: first + (first+step) + … (레벨마다 step씩 더 든다)
 */
export function xpForLevel(s: Scenario, level: number): number {
  const g = s.growth;
  if (!g || level <= 0) return 0;
  let total = 0;
  for (let i = 0; i < level; i++) total += g.first + g.step * i;
  return total;
}

export function levelForXp(s: Scenario, xp: number): number {
  if (!s.growth) return 0;
  let level = 0;
  while (xpForLevel(s, level + 1) <= xp) level += 1;
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
  return `${c.name}의 레벨이 올랐다 (레벨 ${level}). 올릴 스킬을 플레이어에게 물어 learn_skill로 올린다.`;
}

/** 판정 경험치 (하루 상한까지) */
export function gainCheckXp(ctx: ToolContext, characterId: string, outcome: CheckOutcome): string | null {
  const g = ctx.content.scenario.growth;
  if (!g) return null;
  const state = ctx.store.getState();
  const today = state.xpToday.day === dayOf(state.time) ? state.xpToday.amount : 0;
  const amount = Math.min(g.xp[outcome], g.daily_check_cap - today);
  return grant(ctx, characterId, amount, "check");
}

/** 공적 경험치 (얻은 공적만, 잃은 공적은 경험치를 빼지 않는다) */
export function gainMeritXp(ctx: ToolContext, characterId: string, merit: number): string | null {
  const g = ctx.content.scenario.growth;
  if (!g || merit <= 0) return null;
  return grant(ctx, characterId, merit * g.xp.merit, "merit");
}

/** learn_skill: 쌓인 레벨업으로 스킬 하나를 +1 (스킬 상한까지). 게임 시간을 쓰지 않는다 */
export function learnSkill(input: { skill: string }, ctx: ToolContext): ToolOutcome {
  const s = ctx.content.scenario;
  const state = ctx.store.getState();
  const player = state.characters[state.playerId];
  if (!player || player.dead) return { ok: false, error: "플레이어 캐릭터가 없습니다." };
  if (player.skillPoints < 1) return { ok: false, error: "올릴 수 있는 레벨업이 없다." };
  const move = moveOf(s, input.skill);
  if (!move) return { ok: false, error: `알 수 없는 스킬: ${input.skill}` };
  const from = player.skills[input.skill] ?? move.default;
  if (from >= s.ranges.skill.max) return { ok: false, error: `${move.label}은(는) 이미 최고 단계다.` };
  ctx.store.append({ type: "skill_learned", characterId: player.id, skill: input.skill, from, to: from + 1 });
  const left = player.skillPoints - 1;
  return {
    ok: true,
    resultText: `${move.label}: ${skillLevelLabel(from)} → ${skillLevelLabel(from + 1)}.` + (left > 0 ? ` 남은 레벨업 ${left}.` : ""),
    display: { type: "growth", name: player.name, skill: move.label, from: skillLevelLabel(from), to: skillLevelLabel(from + 1) },
  };
}

const SKILL_LEVEL_LABELS: Record<number, string> = { [-1]: "할 줄 모름", 0: "아마추어", 1: "숙련", 2: "마스터" };
export function skillLevelLabel(value: number): string {
  return `${SKILL_LEVEL_LABELS[value] ?? "?"} ${value >= 0 ? "+" : ""}${value}`;
}

export const createLearnSkillTool = (s: Scenario) => ({
  name: "learn_skill",
  description:
    "쌓인 레벨업으로 스킬 하나를 한 단계 올린다 (최고 단계까지). 고르는 것은 플레이어다: 레벨이 오르면 플레이어에게 물어보고 고른 스킬로 호출한다. 게임 시간을 쓰지 않는다. 능력은 오르지 않는다.",
  schema: z.strictObject({ skill: idEnum(moveIds(s)).describe("올릴 스킬 id") }),
  run: learnSkill,
});

/** 스킬을 분류별 한 줄씩: "전투  근접전 +1 · 사격 +1" (보여 줄 때 쓴다) */
export function skillLines(s: Scenario, skills: Record<string, number>): string[] {
  const groups = new Map<string, string[]>();
  for (const m of s.moves) {
    const key = m.category ?? "스킬";
    const value = skills[m.id] ?? m.default;
    const list = groups.get(key) ?? [];
    list.push(`${m.label} ${value >= 0 ? "+" : ""}${value}`);
    groups.set(key, list);
  }
  return [...groups].map(([k, list]) => `${k}  ${list.join(" · ")}`);
}

/** 레벨·경험치 한 줄 (성장 규칙이 없으면 null) */
export function growthLine(s: Scenario, c: { level: number; xp: number; skillPoints: number }): string | null {
  if (!s.growth) return null;
  return `레벨 ${c.level} · 경험치 ${c.xp}/${xpForLevel(s, c.level + 1)}` + (c.skillPoints > 0 ? ` · 올릴 수 있는 스킬 ${c.skillPoints}개 (레벨업)` : "");
}
