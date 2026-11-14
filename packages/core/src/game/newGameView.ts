import type { Content } from "../content/schemas.ts";
import { worldInfo } from "../content/packs.ts";
import { abilitySpend, creationRules, MAX_NAME_WIDTH } from "./creation.ts";
import {
  abilityTiers,
  collectDraft,
  currentStep,
  stepIndex,
  stepOptions,
  traitChoices,
  type AbilityTier,
  type CreationStepId,
  type StepOption,
} from "./creationFlow.ts";
import { describeCustomRole, buildCustomRole, MAX_STORY_LENGTH } from "./customStart.ts";
import { describeHistoryPart } from "./background.ts";
import { CUSTOM_ROLE_ID } from "./state.ts";
import { draftContent, GAME_PREMISE, newGameStep, scenarioOptions, type NewGameDraft } from "./newGame.ts";

/**
 * 상태 화면의 새 게임·새 캐릭터 만들기 (12-67). GM 안내(describeNewGameStep)와 같은 초안을 화면이 그릴 수 있게 나눈 모습.
 * 답은 채팅과 같은 말(answerNewGame)로 돌려받는다. 계산·검증은 모두 core가 한다
 */
export type NewGameView = {
  mode: NewGameDraft["mode"];
  step: "world" | "scenario" | "custom_story" | "custom_setup" | "custom_confirm" | "content" | CreationStepId;
  /** 월드 고르기 */
  worlds?: { id: string; title: string; tagline: string; description: string }[];
  /** 어느 월드든 같은 게임 규칙 (core가 말한다) */
  premise?: string;
  /** 고른 월드 */
  world?: { title: string; intro: string };
  scenarios?: { id: string; title: string; pitch: string; custom: boolean }[];
  custom?: { maxLength: number; occupations: { label: string; summary: string }[]; story: string | null; result: string[] | null };
  content?: { adultAge: number };
  character?: CharacterStepView;
};

export type CharacterStepView = {
  index: { at: number; total: number };
  roleLabel: string;
  /** 새 게임의 첫 단계에서 보여 줄 지금 상황 (시나리오 소개) */
  situation: string | null;
  startSkills: { label: string; value: number }[];
  /** 지금까지 정한 것 */
  chosen: { portrait: string | null; name: string | null; gender: string | null; age: number | null; abilities: { label: string; value: number }[]; traits: string[] | null };
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
  traitLimits: { max_positive: number; max_negative: number; max_personality: number } | null;
  /** 확인 단계: 쓰지 않은 능력 포인트 */
  unusedPoints: number;
};

export function newGameView(packs: ReadonlyMap<string, Content>, draft: NewGameDraft): NewGameView {
  const step = newGameStep(draft);
  if (step === "world") {
    return { mode: draft.mode, step, worlds: [...packs.values()].map(worldInfo), premise: GAME_PREMISE };
  }
  const pack = packs.get(draft.packId!)!;
  const info = worldInfo(pack);
  const world = { title: info.title, intro: pack.scenario.introText ?? `${info.tagline}\n${info.description}` };
  if (step === "scenario") {
    const scenarios = scenarioOptions(pack, draft.unlocked?.[pack.scenario.id] ?? []).map((r) => ({ ...r, custom: r.id === CUSTOM_ROLE_ID }));
    return { mode: draft.mode, step, world, scenarios };
  }
  if (step === "custom_story" || step === "custom_setup" || step === "custom_confirm") {
    let result: string[] | null = null;
    if (step === "custom_confirm") {
      const input = draft.custom!.input!;
      result = [
        describeCustomRole(pack, buildCustomRole(pack, input)),
        ...(input.history?.length ? [`세계에 남는 지난 일: ${input.history.map((p) => describeHistoryPart(pack, p)).join(" / ")}`] : []),
        ...(input.background.length ? [`지난 삶: ${input.background.join(" / ")}`] : []),
      ];
    }
    return {
      mode: draft.mode,
      step,
      world,
      custom: {
        maxLength: MAX_STORY_LENGTH,
        occupations: pack.scenario.occupations.map((o) => ({ label: o.label, summary: o.summary })),
        story: draft.custom?.story ?? null,
        result,
      },
    };
  }
  if (step === "content") return { mode: draft.mode, step, world, content: { adultAge: pack.scenario.content_rating?.adult_age ?? 18 } };

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
      situation: draft.mode === "new_world" ? (role?.scenario?.intro ?? role?.opening_scene ?? null) : null,
      startSkills: rules?.startSkills ?? [],
      chosen: {
        portrait: d.portrait ?? null,
        name: d.name ?? null,
        gender: d.gender !== undefined ? (s.creation?.genders.find((g) => g.id === d.gender)?.label ?? d.gender) : null,
        age: s.creation?.age ? (d.age ?? null) : null,
        abilities: s.stats.filter((x) => d.abilities[x.id] !== undefined).map((x) => ({ label: x.label, value: d.abilities[x.id]! })),
        traits:
          d.traitMethod !== undefined && (d.traitMethod !== "manual" || d.traitSteps.has("traits_pick"))
            ? d.traits.map((id) => s.traits.find((t) => t.id === id)?.label ?? id)
            : null,
      },
      options: stepOptions(s, draft.character, cstep),
      nameMax: MAX_NAME_WIDTH,
      age: s.creation?.age ? { ...s.creation.age, default: role?.age ?? s.creation.age.min } : null,
      stats: s.stats.map((x) => ({ id: x.id, label: x.label, description: x.description ?? "" })),
      tiers: abilityTiers(s),
      points: rules ? { total: rules.points, cost: rules.cost, maxLow: rules.maxLow } : null,
      traits:
        cstep === "traits_pick" || cstep === "traits_personality"
          ? traitChoices(s, draft.character, cstep).map((t) => ({ id: t.id, label: t.label, kind: t.kind, cost: t.cost, description: t.description, opposites: t.opposites }))
          : [],
      traitLimits: rules?.traitLimits ?? null,
      unusedPoints: cstep === "confirm" && d.abilityMethod === "manual" && Number.isFinite(spent) && left > 0 ? left : 0,
    },
  };
}
