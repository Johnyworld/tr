import { z } from "zod";
import type { Content } from "../content/schemas.ts";
import type { Rng } from "../rng.ts";
import type { Scenario } from "../scenario/schema.ts";
import { PORTRAIT_ID } from "./character.ts";
import type { CharacterChoice } from "./state.ts";

/**
 * 캐릭터 생성 (기획서 4.2, 12-6): 이름, 성별, 능력(포인트 구매), 초상화.
 * 규칙 수치는 시나리오 `creation`. 직업·출신 선택은 아직 없다 (역할이 정한다).
 */

export const MAX_NAME_LENGTH = 20;

export function characterChoiceSchema() {
  return z.strictObject({
    name: z.string().trim().min(1).max(MAX_NAME_LENGTH).describe("캐릭터 이름"),
    gender: z.string().nullable().describe("성별 id"),
    abilities: z.record(z.string(), z.number().int()).nullable().describe("능력 id → 값 (포인트 구매). null이면 무작위로 배분"),
    portrait: z.string().regex(PORTRAIT_ID).nullable().describe("초상화 id (웹 화면에서 고른다. MCP에서는 null)"),
  });
}

/** 이 능력 배분에 드는 포인트와 기본값(0)보다 낮춘 능력 수 */
export function abilitySpend(s: Scenario, abilities: Record<string, number>): { spent: number; low: number } {
  const cost = s.creation?.cost ?? {};
  let spent = 0;
  let low = 0;
  for (const stat of s.stats) {
    const v = abilities[stat.id] ?? 0;
    spent += cost[String(v)] ?? Infinity;
    if (v < 0) low += 1;
  }
  return { spent, low };
}

/** 고른 것이 규칙에 맞는지. 문제 목록 (비면 통과) */
export function checkCharacterChoice(s: Scenario, choice: CharacterChoice): string[] {
  const problems: string[] = [];
  const c = s.creation;
  if (!c) return ["이 시나리오에는 캐릭터 생성 규칙이 없다."];
  const name = choice.name.trim();
  if (!name || name.length > MAX_NAME_LENGTH) problems.push(`이름은 1~${MAX_NAME_LENGTH}자다.`);
  if (choice.gender !== null && !c.genders.some((g) => g.id === choice.gender)) {
    problems.push(`성별은 ${c.genders.map((g) => `${g.id}(${g.label})`).join(", ")} 중 하나다.`);
  }
  if (choice.portrait !== null && !PORTRAIT_ID.test(choice.portrait)) problems.push("초상화 id 형식이 올바르지 않다.");
  if (choice.abilities === null) return problems;
  for (const key of Object.keys(choice.abilities)) {
    if (!s.stats.some((x) => x.id === key)) problems.push(`알 수 없는 능력: ${key}`);
  }
  for (const stat of s.stats) {
    const v = choice.abilities[stat.id] ?? 0;
    if (c.cost[String(v)] === undefined) problems.push(`${stat.label} ${v}: 고를 수 있는 값은 ${Object.keys(c.cost).join(", ")}`);
  }
  const { spent, low } = abilitySpend(s, choice.abilities);
  if (Number.isFinite(spent) && spent > c.points) problems.push(`포인트를 ${spent - c.points}만큼 넘게 썼다 (${spent}/${c.points}).`);
  if (low > c.max_low) problems.push(`기본보다 낮출 수 있는 능력은 ${c.max_low}개까지다.`);
  return problems;
}

/** 포인트를 다 쓰는 무작위 배분 (생성 화면의 "무작위" 버튼, 고르지 않은 MCP 새 게임) */
export function randomAbilityBuy(s: Scenario, rng: Rng): Record<string, number> {
  const c = s.creation;
  const abilities: Record<string, number> = Object.fromEntries(s.stats.map((x) => [x.id, 0]));
  if (!c) return abilities;
  const values = Object.keys(c.cost).map(Number).sort((a, b) => a - b);
  for (let guard = 0; guard < 200; guard++) {
    const stat = s.stats[Math.floor(rng() * s.stats.length)]!;
    const up = rng() < 0.8;
    const now = abilities[stat.id]!;
    const next = values[values.indexOf(now) + (up ? 1 : -1)];
    if (next === undefined) continue;
    const trial = { ...abilities, [stat.id]: next };
    const { spent, low } = abilitySpend(s, trial);
    if (spent <= c.points && low <= c.max_low) Object.assign(abilities, trial);
    if (abilitySpend(s, abilities).spent === c.points && rng() < 0.3) break;
  }
  return abilities;
}

export type CreationRules = {
  defaultName: string;
  points: number;
  cost: { value: number; cost: number }[];
  maxLow: number;
  genders: { id: string; label: string }[];
  abilities: { id: string; label: string; description: string }[];
  startSkills: { label: string; value: number }[];
};

/** 생성 화면·MCP 안내에 쓰는 규칙 */
export function creationRules(content: Content, roleId: string): CreationRules | null {
  const s = content.scenario;
  const role = content.roles[roleId];
  if (!s.creation || !role) return null;
  return {
    defaultName: role.default_name,
    points: s.creation.points,
    cost: Object.entries(s.creation.cost).map(([v, cost]) => ({ value: Number(v), cost })).sort((a, b) => a.value - b.value),
    maxLow: s.creation.max_low,
    genders: s.creation.genders.map((g) => ({ id: g.id, label: g.label })),
    abilities: s.stats.map((x) => ({ id: x.id, label: x.label, description: x.description ?? "" })),
    startSkills: Object.entries(role.start_skills).map(([id, v]) => ({ label: s.moves.find((m) => m.id === id)?.label ?? id, value: v ?? 0 })),
  };
}

/** MCP용 안내: GM이 플레이어에게 물을 것 */
export function describeCreationRules(rules: CreationRules): string {
  const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  return [
    "캐릭터 생성 (플레이어에게 물어서 정한다. 대신 정하지 않는다):",
    `- 이름 (1~${MAX_NAME_LENGTH}자, 비우면 "${rules.defaultName}")`,
    `- 성별: ${rules.genders.map((g) => `${g.label}(${g.id})`).join(", ")}`,
    `- 능력: 모두 0에서 시작해 ${rules.points}포인트를 나눠 쓴다. 값별 비용 ${rules.cost.map((c) => `${signed(c.value)}=${c.cost}`).join(", ")} (낮추면 돌려받는다). 0보다 낮출 수 있는 능력은 ${rules.maxLow}개까지`,
    ...rules.abilities.map((a) => `  - ${a.label}(${a.id}): ${a.description}`),
    `- 시작 훈련 (역할이 정한다): ${rules.startSkills.map((x) => `${x.label} ${signed(x.value)}`).join(", ")}`,
    '플레이어가 "알아서"·"무작위"라고 하면 abilities를 null로 보낸다. 코드가 포인트를 무작위로 배분한다.',
  ].join("\n");
}
