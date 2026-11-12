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
    traits: z.array(z.string()).max(10).nullable().optional().describe("트레잇 id 목록. null이면 무작위, 생략하면 없음"),
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
  if (choice.traits) problems.push(...checkTraits(s, choice.traits));
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

/** 고른 트레잇의 포인트: 긍정 비용 합(spent), 부정 보상 합(earned), 종류별 개수 */
export function traitBalance(s: Scenario, traits: readonly string[]) {
  const defs = traits.map((id) => s.traits.find((t) => t.id === id)).filter((t) => t !== undefined);
  const count = (kind: string) => defs.filter((t) => t.kind === kind).length;
  return {
    spent: defs.filter((t) => t.kind === "positive").reduce((n, t) => n + t.cost, 0),
    earned: defs.filter((t) => t.kind === "negative").reduce((n, t) => n + t.cost, 0),
    positive: count("positive"),
    negative: count("negative"),
    personality: count("personality"),
  };
}

/** 트레잇 고르기 규칙 (기획서 4.6): 아는 것·고를 수 있는 것, 겹치지 않기, 반대끼리 안 됨, 종류별 최대, 긍정 비용 ≤ 부정 보상 */
export function checkTraits(s: Scenario, traits: readonly string[]): string[] {
  const problems: string[] = [];
  const limits = s.creation?.traits ?? { max_positive: 3, max_negative: 3, max_personality: 2 };
  if (new Set(traits).size !== traits.length) problems.push("같은 트레잇을 두 번 고를 수 없다.");
  for (const id of traits) {
    const t = s.traits.find((x) => x.id === id);
    if (!t) problems.push(`알 수 없는 트레잇: ${id}`);
    else if (!t.selectable) problems.push(`${t.label}은(는) 고를 수 없는 트레잇이다.`);
    for (const o of t?.opposites ?? []) {
      if (traits.includes(o)) problems.push(`${t!.label}과(와) ${s.traits.find((x) => x.id === o)?.label ?? o}은(는) 함께 가질 수 없다.`);
    }
  }
  const b = traitBalance(s, traits);
  if (b.positive > limits.max_positive) problems.push(`긍정 트레잇은 ${limits.max_positive}개까지다.`);
  if (b.negative > limits.max_negative) problems.push(`부정 트레잇은 ${limits.max_negative}개까지다.`);
  if (b.personality > limits.max_personality) problems.push(`성격 트레잇은 ${limits.max_personality}개까지다.`);
  if (b.spent > b.earned) problems.push(`트레잇 포인트가 ${b.spent - b.earned} 모자란다 (긍정 ${b.spent} > 부정 ${b.earned}). 부정 트레잇을 더 고르거나 긍정을 뺀다.`);
  // 반대끼리는 양쪽에서 한 번씩 걸리므로 하나로
  return [...new Set(problems)];
}

/** 규칙에 맞는 무작위 트레잇 (부정 0~2개, 그만큼 긍정, 성격 0~2개) */
export function randomTraits(s: Scenario, rng: Rng): string[] {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rng() * xs.length)];
  const pool = s.traits.filter((t) => t.selectable);
  for (let attempt = 0; attempt < 100; attempt++) {
    const chosen: string[] = [];
    const add = (kind: string, n: number) => {
      for (let i = 0; i < n; i++) {
        const t = pick(pool.filter((x) => x.kind === kind && !chosen.includes(x.id)));
        if (t) chosen.push(t.id);
      }
    };
    add("negative", Math.floor(rng() * 3));
    add("positive", Math.floor(rng() * 3));
    add("personality", Math.floor(rng() * 3));
    if (checkTraits(s, chosen).length === 0) return chosen;
  }
  return [];
}

/** 포인트를 남김없이 쓰는 무작위 배분 (생성 화면의 "무작위" 버튼, 고르지 않은 MCP 새 게임) */
export function randomAbilityBuy(s: Scenario, rng: Rng): Record<string, number> {
  const c = s.creation;
  const zero = (): Record<string, number> => Object.fromEntries(s.stats.map((x) => [x.id, 0]));
  if (!c) return zero();
  const values = Object.keys(c.cost).map(Number).sort((a, b) => a - b);
  let best = zero();
  for (let attempt = 0; attempt < 50; attempt++) {
    const abilities = zero();
    for (let guard = 0; guard < 100; guard++) {
      const stat = s.stats[Math.floor(rng() * s.stats.length)]!;
      const now = abilities[stat.id]!;
      const next = values[values.indexOf(now) + (rng() < 0.8 ? 1 : -1)];
      if (next === undefined) continue;
      const trial = { ...abilities, [stat.id]: next };
      const { spent, low } = abilitySpend(s, trial);
      if (spent <= c.points && low <= c.max_low) Object.assign(abilities, trial);
      if (abilitySpend(s, abilities).spent === c.points) return abilities;
    }
    if (abilitySpend(s, abilities).spent > abilitySpend(s, best).spent) best = abilities;
  }
  return best;
}

export type CreationRules = {
  defaultName: string;
  /** 시작 역할 이름 (예: 청솔형제단 하급 전투원) */
  roleLabel: string;
  points: number;
  cost: { value: number; cost: number }[];
  maxLow: number;
  genders: { id: string; label: string }[];
  abilities: { id: string; label: string; description: string }[];
  startSkills: { label: string; value: number }[];
  /** 고를 수 있는 트레잇과 종류별 최대 개수 */
  traits: { id: string; label: string; kind: "positive" | "negative" | "personality"; cost: number; description: string; opposites: string[] }[];
  traitLimits: { max_positive: number; max_negative: number; max_personality: number };
};

/** 생성 화면·MCP 안내에 쓰는 규칙 */
export function creationRules(content: Content, roleId: string): CreationRules | null {
  const s = content.scenario;
  const role = content.roles[roleId];
  if (!s.creation || !role) return null;
  return {
    defaultName: role.default_name,
    roleLabel: role.label,
    points: s.creation.points,
    cost: Object.entries(s.creation.cost).map(([v, cost]) => ({ value: Number(v), cost })).sort((a, b) => a.value - b.value),
    maxLow: s.creation.max_low,
    genders: s.creation.genders.map((g) => ({ id: g.id, label: g.label })),
    abilities: s.stats.map((x) => ({ id: x.id, label: x.label, description: x.description ?? "" })),
    startSkills: Object.entries(role.start_skills).map(([id, v]) => ({ label: s.moves.find((m) => m.id === id)?.label ?? id, value: v ?? 0 })),
    traits: s.traits
      .filter((t) => t.selectable)
      .map((t) => ({ id: t.id, label: t.label, kind: t.kind, cost: t.cost, description: t.description, opposites: t.opposites })),
    traitLimits: s.creation.traits,
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
    `- 트레잇 (traits, 고르지 않아도 된다): 긍정은 부정으로 얻은 포인트만큼만 고른다. 긍정 ${rules.traitLimits.max_positive}개·부정 ${rules.traitLimits.max_negative}개·성격 ${rules.traitLimits.max_personality}개까지. 반대끼리는 함께 고를 수 없다`,
    ...(["positive", "negative", "personality"] as const).map(
      (kind) =>
        `  - ${{ positive: "긍정 (비용)", negative: "부정 (보상)", personality: "성격 (0)" }[kind]}: ` +
        rules.traits
          .filter((t) => t.kind === kind)
          .map((t) => `${t.label}(${t.id}${kind === "personality" ? "" : ` ${t.cost}`}: ${t.description})`)
          .join(", "),
    ),
    '플레이어가 "알아서"·"무작위"라고 하면 abilities(또는 traits)를 null로 보낸다. 코드가 규칙에 맞게 무작위로 정한다.',
    "트레잇 목록은 한꺼번에 다 읽어 주지 말고, 플레이어가 원하면 종류별로 보여 준다.",
  ].join("\n");
}
