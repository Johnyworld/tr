import type { Content } from "../content/schemas.ts";
import { personaSummary } from "../engine/persona.ts";
import { worldInfo } from "../content/packs.ts";
import { abilitySpend, creationRules, MAX_NAME_WIDTH, pastOf } from "./creation.ts";
import {
  abilityTiers,
  ageFloor,
  collectDraft,
  describeSkills,
  describeStats,
  currentStep,
  stepIndex,
  stepOptions,
  traitChoices,
  type AbilityTier,
  type CreationStepId,
  type StepOption,
} from "./creationFlow.ts";
import { draftContent, newGameStep, type NewGameDraft } from "./newGame.ts";
import { scenarioChoices, type ScenarioChoice } from "./startChoice.ts";

/**
 * 상태 화면의 새 게임·새 캐릭터 만들기 (12-67). GM 안내(describeNewGameStep)와 같은 초안을 화면이 그릴 수 있게 나눈 모습.
 * 답은 채팅과 같은 말(answerNewGame)로 돌려받는다. 계산·검증은 모두 core가 한다
 */
export type NewGameView = {
  mode: NewGameDraft["mode"];
  step: "world" | "scenario" | "content" | "dialogue" | CreationStepId;
  /** 월드 고르기: 이름, 한 줄 소개, 짧은 설명 */
  worlds?: { id: string; title: string; tagline: string; description: string }[];
  /** 고른 월드 */
  world?: { title: string };
  /** 시나리오 고르기 (잠긴 것도 해금 조건과 함께) */
  scenarios?: ScenarioChoice[];
  content?: { adultAge: number };
  character?: CharacterStepView;
};

export type CharacterStepView = {
  index: { at: number; total: number };
  roleLabel: string;
  startSkills: { label: string; value: number }[];
  /** 지금까지 정한 것. past: 과거 배경 이름, skills: 고른 스킬 */
  chosen: {
    past: string | null;
    portrait: string | null;
    name: string | null;
    gender: string | null;
    age: number | null;
    abilities: { label: string; value: number }[];
    skills: { label: string; value: number }[] | null;
    traits: string[] | null;
    /** 성격 축 요약 ("다혈질 2, 과묵함 1" / "보통"). 아직 안 정했으면 null */
    persona: string | null;
  };
  /** 과거 배경 고르기 (12-84): 배경마다 스킬·능력·물건 */
  pasts: { id: string; label: string; summary: string; skills: string; stats: string; items: string; minAge: number | null }[];
  /** 계급 기본 훈련 (12-87): 과거 배경의 스킬과 따로 더해진다. 없으면 빈 글 */
  rankSkills: string;
  /** 고친 능력·스킬의 처음 값: 고른 과거 배경의 것 */
  pastDefaults: { stats: Record<string, number>; skills: Record<string, number> } | null;
  /** 스킬 고치기: 고를 수 있는 스킬과 규칙 */
  /** stats: 이 스킬과 함께 쓰는 능력 (예: 근력·민첩) */
  moves: { id: string; label: string; category: string; description: string; stats: string }[];
  skillRule: { points: number; max: number } | null;
  options: StepOption[];
  /** 이름 폭 상한 (한글 2, 영문 1로 센다) */
  nameMax: number;
  /** 나이 고르기 (월드가 범위를 열었을 때). default: 시나리오의 나이 */
  age: { min: number; max: number; default: number } | null;
  stats: { id: string; label: string; description: string }[];
  /** 직접 정하기의 등급 (없으면 포인트 나누기: points) */
  tiers: AbilityTier[] | null;
  points: { total: number; cost: { value: number; cost: number }[]; maxLow: number } | null;
  /** 이 단계에서 고를 수 있는 트레잇 */
  traits: { id: string; label: string; kind: "positive" | "negative" | "personality"; cost: number; description: string; opposites: string[] }[];
  traitLimits: { max_positive: number; max_negative: number; max_personality?: number } | null;
  /** 확인 단계: 쓰지 않은 능력 포인트 */
  unusedPoints: number;
  /** 성격 축 (12-99). 없는 월드는 빈 목록 */
  personaAxes: { id: string; low: string; high: string; romance: boolean }[];
};

export function newGameView(packs: ReadonlyMap<string, Content>, draft: NewGameDraft): NewGameView {
  const step = newGameStep(draft);
  if (step === "world") return { mode: draft.mode, step, worlds: [...packs.values()].map(worldInfo) };
  const pack = packs.get(draft.packId!)!;
  const world = { title: worldInfo(pack).title };
  if (step === "scenario") return { mode: draft.mode, step, world, scenarios: scenarioChoices(pack, draft.unlocked?.[pack.scenario.id] ?? []) };
  if (step === "content") return { mode: draft.mode, step, world, content: { adultAge: pack.scenario.content_rating?.adult_age ?? 18 } };
  if (step === "dialogue" && draft.choice) return { mode: draft.mode, step, world };

  const content = draftContent(packs, draft);
  const s = content.scenario;
  const roleId = draft.roleId!;
  const rules = creationRules(content, roleId);
  const cstep = currentStep(s, draft.character);
  const d = collectDraft(draft.character);
  const role = content.roles[roleId];
  const { spent } = abilitySpend(s, d.abilities);
  const left = (s.creation?.points ?? 0) - spent;
  return {
    mode: draft.mode,
    step: cstep,
    world,
    character: {
      index: stepIndex(s, draft.character),
      roleLabel: rules?.roleLabel ?? role?.label ?? "",
      startSkills: rules?.startSkills ?? [],
      chosen: {
        past: pastOf(s, d.past)?.label ?? null,
        portrait: d.portrait ?? null,
        name: d.name ?? null,
        gender: d.gender !== undefined ? (s.creation?.genders.find((g) => g.id === d.gender)?.label ?? d.gender) : null,
        age: s.creation?.age ? (d.age ?? null) : null,
        abilities: s.stats.filter((x) => d.abilities[x.id] !== undefined).map((x) => ({ label: x.label, value: d.abilities[x.id]! })),
        skills: chosenSkills(s, d),
        traits:
          d.traitMethod !== undefined && (d.traitMethod !== "manual" || d.traitSteps.has("traits_pick"))
            ? d.traits.map((id) => s.traits.find((t) => t.id === id)?.label ?? id)
            : null,
        persona: d.persona !== undefined ? personaSummary(s, d.persona) : null,
      },
      options: stepOptions(s, draft.character, cstep, (id) => content.items[id]?.name ?? id),
      pasts: (s.creation?.pasts ?? []).map((p) => ({
        id: p.id,
        label: p.label,
        summary: p.summary,
        skills: describeSkills(s, p.skills),
        stats: describeStats(s, p.stats),
        items: p.items.map((i) => content.items[i]?.name ?? i).join(" · "),
        minAge: p.min_age ?? null,
      })),
      rankSkills: describeSkills(s, s.creation?.rank_skills[role?.rank ?? ""] ?? {}).replace(/^없음$/, ""),
      pastDefaults: pastOf(s, d.past) ? { stats: { ...pastOf(s, d.past)!.stats }, skills: { ...pastOf(s, d.past)!.skills } } : null,
      moves: s.moves.map((m) => ({
        id: m.id,
        label: m.label,
        category: m.category ?? "",
        description: m.description ?? "",
        stats: (m.stats ?? []).map((id) => s.stats.find((x) => x.id === id)?.label ?? id).join("·"),
      })),
      skillRule: s.creation?.skills ?? null,
      nameMax: MAX_NAME_WIDTH,
      age: s.creation?.age ? { min: ageFloor(s, draft.character), max: s.creation.age.max, default: Math.max(role?.age ?? s.creation.age.min, ageFloor(s, draft.character)) } : null,
      stats: s.stats.map((x) => ({ id: x.id, label: x.label, description: x.description ?? "" })),
      tiers: abilityTiers(s),
      points: rules ? { total: rules.points, cost: rules.cost, maxLow: rules.maxLow } : null,
      traits:
        cstep === "traits_pick" || cstep === "traits_personality"
          ? traitChoices(s, draft.character, cstep).map((t) => ({ id: t.id, label: t.label, kind: t.kind, cost: t.cost, description: t.description, opposites: t.opposites }))
          : [],
      traitLimits: rules?.traitLimits ?? null,
      personaAxes: (s.persona?.axes ?? []).map((a) => ({ id: a.id, low: a.low, high: a.high, romance: !!a.romance })),
      unusedPoints: cstep === "confirm" && d.abilityMethod === "manual" && Number.isFinite(spent) && left > 0 ? left : 0,
    },
  };
}

/**
 * 맨 위 카드의 스킬: 고른 스킬에 트레잇이 주는 스킬을 더한다 (게임 안의 effectiveSkill과 같은 셈).
 * 스킬도 트레잇도 아직 안 정했으면 null
 */
function chosenSkills(s: Content["scenario"], d: ReturnType<typeof collectDraft>): { label: string; value: number }[] | null {
  const skillsSet = d.skillMethod !== undefined && (d.skillMethod !== "manual" || d.skillsSet);
  const bonus: Record<string, number> = {};
  for (const id of d.traits) for (const [m, v] of Object.entries(s.traits.find((t) => t.id === id)?.effects.skills ?? {})) bonus[m] = (bonus[m] ?? 0) + v;
  if (!skillsSet && !Object.keys(bonus).length) return null;
  const base = skillsSet ? d.skills : {};
  return s.moves
    .filter((m) => base[m.id] !== undefined || bonus[m.id] !== undefined)
    .map((m) => ({ label: m.label, value: (base[m.id] ?? m.default) + (bonus[m.id] ?? 0) }))
    .filter((x) => x.value !== 0);
}
