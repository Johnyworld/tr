import type { Content } from "../content/schemas.ts";
import type { Rng } from "../rng.ts";
import type { Scenario } from "../scenario/schema.ts";
import {
  abilitySpend,
  checkAbilities,
  checkAge,
  checkCharacterChoice,
  checkTraits,
  creationRules,
  checkName,
  checkSkills,
  pastOf,
  randomAbilityBuy,
  randomTraits,
  type CreationRules,
} from "./creation.ts";
import type { CharacterChoice } from "./state.ts";
import { PORTRAIT_ID } from "./character.ts";

/**
 * 대화로 하는 캐릭터 생성 (기획서 4.2, 11.6): 한 번에 하나씩, 정해진 순서로 묻는다.
 * 세계 소개 → 과거 배경(12-84) → 이름 → 얼굴(상태 화면에서 만들 때) → 성별 → 나이(월드가 범위를 열었으면) → 능력(배경대로 / 고치기 / 무작위) → 스킬(배경대로 / 고치기) → 트레잇(약점·강점 한 표 → 성격 / 무작위 / 없이) → 확인.
 * 답은 모두 코드가 검증하고 포인트를 계산한다 (GM은 숫자를 만들지 않는다, 원칙 2).
 * 초안은 세이브에 쓰지 않는다. 확인을 마쳐야 세계(또는 새 캐릭터)를 만든다.
 */

export type CreationAnswer =
  | { step: "past"; value: string }
  | { step: "name"; value: string }
  | { step: "portrait"; value: string | null }
  | { step: "gender"; value: string }
  | { step: "age"; value: number }
  | { step: "abilities"; value: "manual" | "random" | "past"; rolled?: Record<string, number> }
  | { step: "ability_set"; values: Record<string, number> }
  | { step: "skills"; value: "manual" | "past"; values?: Record<string, number> }
  | { step: "skill_set"; values: Record<string, number> }
  | { step: "traits"; value: "manual" | "random" | "none"; rolled?: string[] }
  | { step: "traits_pick" | "traits_personality"; value: string[] };

export type CreationDraft = {
  /** new_world: 새 게임 (세계 소개부터) / heir: 사망 뒤 같은 세계의 새 캐릭터 */
  mode: "new_world" | "heir";
  answers: CreationAnswer[];
  /** 이미 정해진 나이 (직접 쓰는 시나리오에서 플레이어가 쓴 나이). 있으면 나이를 묻지 않는다 */
  presetAge?: number;
  /** 계급의 최소 나이 (12-87, 간부 등). 과거 배경의 최소 나이와 함께 나이의 아래 끝이 된다 */
  minAge?: number;
  /** 이미 정해진 성별 (떠돌이의 소규모 무리에서 정했다, 12-77). 있으면 성별을 묻지 않는다 */
  presetGender?: string;
  /** 얼굴(초상화) 단계를 묻는다: 그림을 보여 줄 수 있는 상태 화면에서 만들 때만 (채팅으로만 만들면 실루엣) */
  withPortrait?: boolean;
};

export type CreationStepId =
  | "past"
  | "name"
  | "portrait"
  | "gender"
  | "age"
  | "abilities"
  | "ability_set"
  | "skills"
  | "skill_set"
  | "traits"
  | "traits_pick"
  | "traits_personality"
  | "confirm";

export type StepOption = { value: string; label: string; description?: string };

export function newCreationDraft(mode: CreationDraft["mode"]): CreationDraft {
  return { mode, answers: [] };
}

/** 트레잇 단계마다 고르는 종류: 약점·강점은 한 표에서 같이, 성격은 따로 */
const TRAIT_KIND_STEP = {
  traits_pick: ["negative", "positive"],
  traits_personality: ["personality"],
} as const satisfies Record<string, readonly ("negative" | "positive" | "personality")[]>;
type TraitStep = keyof typeof TRAIT_KIND_STEP;

/** 지금까지의 답에서 정해진 것 */
export function collectDraft(draft: CreationDraft) {
  let past: string | undefined;
  let name: string | undefined;
  let gender: string | undefined = draft.presetGender;
  let portrait: string | null | undefined;
  let age: number | undefined = draft.presetAge;
  let abilityMethod: "manual" | "random" | "past" | undefined;
  let abilitiesSet = false;
  const abilities: Record<string, number> = {};
  let skillMethod: "manual" | "past" | undefined;
  let skillsSet = false;
  let skills: Record<string, number> = {};
  let traitMethod: "manual" | "random" | "none" | undefined;
  const traits: string[] = [];
  const traitSteps = new Set<string>();
  for (const a of draft.answers) {
    if (a.step === "past") past = a.value;
    else if (a.step === "skills") {
      skillMethod = a.value;
      skills = { ...(a.values ?? {}) };
    } else if (a.step === "skill_set") {
      skillsSet = true;
      skills = { ...a.values };
    } else if (a.step === "name") name = a.value;
    else if (a.step === "gender") gender = a.value;
    else if (a.step === "portrait") portrait = a.value;
    else if (a.step === "age") age = a.value;
    else if (a.step === "abilities") {
      abilityMethod = a.value;
      if (a.rolled) Object.assign(abilities, a.rolled);
    } else if (a.step === "ability_set") {
      abilitiesSet = true;
      Object.assign(abilities, a.values);
    }
    else if (a.step === "traits") {
      traitMethod = a.value;
      if (a.rolled) traits.push(...a.rolled);
    } else {
      traitSteps.add(a.step);
      traits.push(...a.value);
    }
  }
  return { past, name, gender, portrait, age, abilityMethod, abilitiesSet, abilities, skillMethod, skillsSet, skills, traitMethod, traits, traitSteps };
}

/** 다음에 물을 단계 */
export function currentStep(s: Scenario, draft: CreationDraft): CreationStepId {
  const d = collectDraft(draft);
  if (s.creation?.pasts.length && d.past === undefined) return "past";
  if (d.name === undefined) return "name";
  if (draft.withPortrait && d.portrait === undefined) return "portrait";
  if (d.gender === undefined) return "gender";
  if (s.creation?.age && d.age === undefined) return "age";
  if (d.abilityMethod === undefined) return "abilities";
  if (d.abilityMethod === "manual" && !d.abilitiesSet) return "ability_set";
  if (s.creation?.skills && d.skillMethod === undefined) return "skills";
  if (d.skillMethod === "manual" && !d.skillsSet) return "skill_set";
  if (d.traitMethod === undefined) return "traits";
  if (d.traitMethod === "manual") {
    for (const step of ["traits_pick", "traits_personality"] as const) {
      if (!d.traitSteps.has(step)) return step;
    }
  }
  return "confirm";
}

/** 고른 것 (확인 단계 요약, 세계 만들기) */
export function draftChoice(draft: CreationDraft): CharacterChoice {
  const d = collectDraft(draft);
  return {
    name: d.name ?? "",
    gender: d.gender ?? null,
    abilities: d.abilities,
    portrait: d.portrait ?? null,
    traits: d.traits,
    age: d.age ?? null,
    ...(d.past !== undefined ? { past: d.past } : {}),
    ...(d.skillMethod !== undefined ? { skills: d.skills } : {}),
  };
}

export type AbilityTier = { value: number; count: number; label: string };

/**
 * 직접 정하기의 능력 등급: 시나리오의 ability_array(NPC·무작위 캐릭터와 같은 무게)를 값별로 묶는다.
 * 플레이어는 포인트를 계산하지 않고 "가장 자신 있는 것 / 잘하는 것 / 자신 없는 것"을 고른다. 0(보통)은 고르지 않은 나머지.
 * ability_array가 없으면 null (포인트 구매 글로 받는다)
 */
export function abilityTiers(s: Scenario): AbilityTier[] | null {
  const arr = s.ability_array;
  if (!arr) return null;
  const values = [...new Set(arr.filter((v) => v !== 0))].sort((a, b) => b - a);
  const pos = values.filter((v) => v > 0);
  const neg = values.filter((v) => v < 0);
  return values.map((value) => ({
    value,
    count: arr.filter((v) => v === value).length,
    label:
      value > 0
        ? pos.length > 1 && value === pos[0]
          ? "가장 자신 있는 것"
          : "잘하는 것"
        : neg.length > 1 && value === neg.at(-1)
          ? "가장 자신 없는 것"
          : "자신 없는 것",
  }));
}

/**
 * 등급별로 고른 능력 → 능력 id → 값. 등급 순서대로 "/"(또는 줄)로 나누고, 등급 안은 쉼표로.
 * 능력은 번호(능력 목록 순서)·이름·id 어느 것이든. 예: "2 / 4, 7 / 6", "+2: 민첩 / +1: 감각, 지능 / -1: 매력"
 */
export function parseAbilityTiers(
  s: Scenario,
  tiers: readonly AbilityTier[],
  text: string,
): { ok: true; values: Record<string, number> } | { ok: false; error: string } {
  const format = `등급 순서(${tiers.map((t) => `${t.label} ${t.count}개`).join(" / ")})대로 "/"로 나눠 번호나 이름을 적는다 (예: ${exampleTiers(tiers)}).`;
  const groups = text
    .split(/[/\n;|]/)
    .map((g) => g.replace(/^[^:：]*[:：]/, "").trim())
    .filter((g) => g.length > 0);
  if (groups.length !== tiers.length) return { ok: false, error: format };
  const values: Record<string, number> = {};
  for (const [i, tier] of tiers.entries()) {
    const items = groups[i]!.split(/[,，、\s]+/).filter((x) => x.length > 0);
    if (items.length !== tier.count) return { ok: false, error: `${tier.label}은(는) ${tier.count}개를 고른다. ${format}` };
    for (const item of items) {
      const n = /^\d+\.?$/.test(item) ? Number.parseInt(item, 10) : NaN;
      const stat = Number.isNaN(n) ? s.stats.find((x) => x.label === item || x.id.toLowerCase() === item.toLowerCase()) : s.stats[n - 1];
      if (!stat) return { ok: false, error: `"${item}"라는 능력은 없다. 능력: ${s.stats.map((x, k) => `${k + 1}. ${x.label}`).join(", ")}` };
      if (values[stat.id] !== undefined) return { ok: false, error: `${stat.label}을(를) 두 번 골랐다.` };
      values[stat.id] = tier.value;
    }
  }
  return { ok: true, values };
}

function exampleTiers(tiers: readonly AbilityTier[]): string {
  let n = 0;
  return tiers.map((t) => Array.from({ length: t.count }, () => String(((n++ * 3) % 7) + 1)).join(", ")).join(" / ");
}

/**
 * (ability_array가 없는 월드) 능력 배분 글 → 능력 id → 값. "근력 1, 민첩 +2, 감각 -1"처럼 이름(또는 id)과 값을 짝지어 쓴다.
 * 쓰지 않은 능력은 0(기본). 모르는 능력, 겹친 능력, 읽을 수 없는 글은 오류
 */
export function parseAbilities(s: Scenario, text: string): { ok: true; values: Record<string, number> } | { ok: false; error: string } {
  const values: Record<string, number> = {};
  const pattern = /([^\d\s,，、:=+\-/]+)\s*[:=]?\s*([+-]?\d+)/g;
  for (const m of text.matchAll(pattern)) {
    const key = m[1]!.trim();
    const stat = s.stats.find((x) => x.label === key || x.id.toLowerCase() === key.toLowerCase());
    if (!stat) return { ok: false, error: `"${key}"라는 능력은 없다. 능력: ${s.stats.map((x) => x.label).join(", ")}` };
    if (values[stat.id] !== undefined) return { ok: false, error: `${stat.label}을(를) 두 번 적었다.` };
    values[stat.id] = Number(m[2]);
  }
  const rest = text.replace(pattern, "").replace(/[\s,，、/]+/g, "");
  if (rest.length > 0 || Object.keys(values).length === 0) {
    return { ok: false, error: `"능력 값"을 쉼표로 이어 적는다 (예: ${s.stats.slice(0, 2).map((x, i) => `${x.label} ${i === 0 ? "+1" : "0"}`).join(", ")}). 적지 않은 능력은 0.` };
  }
  return { ok: true, values };
}

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
const RANDOM_WORDS = ["random", "무작위", "알아서", "랜덤"];
const NONE_WORDS = ["none", "없음", "없이", "안 고름", "고르지 않음", ""];

/** 나이의 아래 끝: 월드의 범위, 계급의 최소 나이, 과거 배경의 최소 나이 중 큰 것 (12-87) */
export function ageFloor(s: Scenario, draft: CreationDraft): number {
  return Math.max(s.creation?.age?.min ?? 0, draft.minAge ?? 0, pastOf(s, collectDraft(draft).past)?.min_age ?? 0);
}

function ageFloorReason(s: Scenario, draft: CreationDraft): string {
  const past = pastOf(s, collectDraft(draft).past);
  const floor = ageFloor(s, draft);
  return past?.min_age === floor ? `과거 배경 ${past.label}` : "이 계급";
}

/** "근력 +2, 체력 +1, 냉정 +1, 지능 -1" */
export function describeStats(s: Scenario, stats: Record<string, number>): string {
  return s.stats.filter((x) => stats[x.id]).sort((a, b) => (stats[b.id] ?? 0) - (stats[a.id] ?? 0)).map((x) => `${x.label} ${signed(stats[x.id]!)}`).join(", ");
}

/** "버티기 +1, 근접전 +1" */
export function describeSkills(s: Scenario, skills: Record<string, number>): string {
  return Object.entries(skills).filter(([, v]) => v).map(([id, v]) => `${s.moves.find((m) => m.id === id)?.label ?? id} ${signed(v)}`).join(", ") || "없음";
}

/** 과거 배경이 주는 것 한 줄: "버티기 +1, 근접전 +1 · 근력 +2 … · 쇠지렛대" */
export function pastGains(s: Scenario, p: NonNullable<ReturnType<typeof pastOf>>, itemName: (id: string) => string = (id) => id): string {
  return [describeSkills(s, p.skills), describeStats(s, p.stats), p.items.map(itemName).join("·")].filter(Boolean).join(" · ");
}

/** 스킬 고르기 글 → 스킬 id → 값. "사격, 경계" 또는 "사격 +1, 경계 1". 값을 빼면 +1 */
export function parseSkills(s: Scenario, text: string): { ok: true; values: Record<string, number> } | { ok: false; error: string } {
  const values: Record<string, number> = {};
  if (NONE_WORDS.includes(text.trim().toLowerCase())) return { ok: true, values };
  for (const part of text.split(/[,，、/\n]+/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^(.+?)\s*[:=]?\s*([+-]?\d+)?$/.exec(part);
    const key = m?.[1]?.trim() ?? part;
    const move = s.moves.find((x) => x.label === key || x.id.toLowerCase() === key.toLowerCase());
    if (!move) return { ok: false, error: `"${key}"라는 스킬은 없다. 스킬: ${s.moves.map((x) => x.label).join(", ")}` };
    if (values[move.id] !== undefined) return { ok: false, error: `${move.label}을(를) 두 번 적었다.` };
    values[move.id] = m?.[2] ? Number(m[2]) : 1;
  }
  return { ok: true, values };
}

/** 보기에서 고르기: value나 label이 같으면 그것 */
function pick(options: StepOption[], answer: string): string | null {
  const a = answer.trim().toLowerCase();
  return options.find((o) => o.value.toLowerCase() === a || o.label.toLowerCase() === a)?.value ?? null;
}

/** 단계의 보기 (보기가 정해진 단계만) */
export function stepOptions(s: Scenario, draft: CreationDraft, step: CreationStepId): StepOption[] {
  if (step === "gender") return (s.creation?.genders ?? []).map((g) => ({ value: g.id, label: g.label }));
  if (step === "past")
    return (s.creation?.pasts ?? []).map((p) => ({ value: p.id, label: p.label, description: `${p.summary}. ${pastGains(s, p)}${p.min_age ? ` (${p.min_age}세부터)` : ""}` }));
  const past = pastOf(s, collectDraft(draft).past);
  if (step === "skills") {
    return [
      { value: "past", label: "배경대로", description: past ? describeSkills(s, past.skills) : "스킬 없이" },
      { value: "manual", label: "고치기", description: `${s.creation?.skills?.points ?? 0}포인트를 스킬마다 +${s.creation?.skills?.max ?? 1}까지 나눈다` },
    ];
  }
  if (step === "abilities") {
    return [
      ...(past ? [{ value: "past", label: "배경대로", description: describeStats(s, past.stats) }] : []),
      { value: "manual", label: past ? "고치기" : "직접 정하기", description: `능력 ${s.stats.length}가지를 한 번에 정한다` },
      { value: "random", label: "운에 맡기기", description: past ? "과거 배경과 상관없이 규칙대로 무작위로 나눈다" : "규칙대로 무작위로 나눈다" },
    ];
  }
  if (step === "traits") {
    return [
      { value: "manual", label: "직접 고르기", description: "약점·강점을 한 표에서 고르고, 성격을 고른다" },
      { value: "random", label: "운에 맡기기", description: "규칙에 맞게 무작위로" },
      { value: "none", label: "없이", description: "트레잇 없이 시작한다" },
    ];
  }
  if (step === "confirm") {
    return [
      { value: "start", label: "이대로 시작" },
      { value: "back", label: "한 단계 뒤로" },
      { value: "restart", label: "처음부터 다시" },
    ];
  }
  return [];
}

/**
 * 이 트레잇 단계에서 보여 줄 목록 (번호 순서: 약점 다음 강점). 이미 고른 것과 그 반대는 뺀다.
 * 플레이어는 이 번호로 답할 수 있다
 */
export function traitChoices(s: Scenario, draft: CreationDraft, step: TraitStep) {
  const chosen = collectDraft(draft).traits;
  const kinds: readonly string[] = TRAIT_KIND_STEP[step];
  return kinds.flatMap((kind) =>
    s.traits.filter((t) => t.selectable && t.kind === kind && !chosen.includes(t.id) && !t.opposites.some((o) => chosen.includes(o))),
  );
}

/** 트레잇 번호·이름·id 목록 → id. 번호는 traitChoices의 순서. 모르는 것은 오류 */
function parseTraits(
  s: Scenario,
  kinds: readonly string[],
  answer: string | string[],
  numbered: readonly { id: string }[],
): { ok: true; ids: string[] } | { ok: false; error: string } {
  const raw = (Array.isArray(answer) ? answer : answer.split(/[,，、\n]/))
    .flatMap((x) => (/^[\d\s]+$/.test(x.trim()) ? x.trim().split(/\s+/) : [x]))
    .map((x) => x.trim().replace(/\.$/, ""))
    .filter((x) => x.length > 0);
  if (raw.length === 1 && NONE_WORDS.includes(raw[0]!.toLowerCase())) return { ok: true, ids: [] };
  const ids: string[] = [];
  for (const r of raw) {
    if (/^\d+$/.test(r)) {
      const n = numbered[Number(r) - 1];
      if (!n) return { ok: false, error: `${r}번은 목록에 없다 (1~${numbered.length}).` };
      ids.push(n.id);
      continue;
    }
    const t = s.traits.find((x) => x.selectable && (x.id === r || x.label === r));
    if (!t) return { ok: false, error: `"${r}"라는 트레잇은 없다.` };
    if (!kinds.includes(t.kind)) return { ok: false, error: `${t.label}은(는) 이 단계에서 고르는 트레잇이 아니다.` };
    ids.push(t.id);
  }
  return { ok: true, ids };
}

export type CreationReply =
  | { ok: true; draft: CreationDraft; done: false }
  | { ok: true; draft: CreationDraft; done: true; choice: CharacterChoice }
  | { ok: false; error: string };

/** 지금 단계에 답한다. 답이 맞지 않으면 그 이유 (초안은 그대로) */
export function answerCreation(s: Scenario, draft: CreationDraft, answer: string | string[], rng: Rng): CreationReply {
  const step = currentStep(s, draft);
  const text = Array.isArray(answer) ? answer.join(", ") : answer;
  const add = (a: CreationAnswer): CreationReply => ({ ok: true, draft: { ...draft, answers: [...draft.answers, a] }, done: false });
  const options = stepOptions(s, draft, step);
  const fromOptions = (): string | null => pick(options, text) ?? (RANDOM_WORDS.includes(text.trim().toLowerCase()) ? pick(options, "random") : null);

  if (step === "past") {
    const v = fromOptions();
    if (!v) return { ok: false, error: `과거 배경은 ${options.map((o) => o.label).join(", ")} 중 하나다.` };
    // 나이를 이미 정했으면 (떠돌이의 소규모 무리) 그 나이에 했을 수 있는 일이어야 한다
    const min = pastOf(s, v)?.min_age ?? 0;
    if (draft.presetAge !== undefined && draft.presetAge < min) return { ok: false, error: `${pastOf(s, v)!.label}은(는) ${min}세 이상이어야 한다 (정한 나이 ${draft.presetAge}세).` };
    return add({ step: "past", value: v });
  }
  if (step === "skills") {
    const v = fromOptions();
    const past = pastOf(s, collectDraft(draft).past);
    if (v === "past") return add({ step: "skills", value: "past", values: { ...(past?.skills ?? {}) } });
    if (v === "manual") return add({ step: "skills", value: "manual" });
    return { ok: false, error: "배경대로(past) 할지 고칠지(manual) 고른다." };
  }
  if (step === "skill_set") {
    const parsed = parseSkills(s, text);
    if (!parsed.ok) return parsed;
    const problems = checkSkills(s, parsed.values);
    if (problems.length) return { ok: false, error: problems.join(" ") };
    return add({ step: "skill_set", values: parsed.values });
  }
  if (step === "name") {
    const name = text.trim();
    const problem = checkName(name);
    if (problem) return { ok: false, error: problem };
    return add({ step: "name", value: name });
  }
  if (step === "portrait") {
    const v = text.trim();
    if (NONE_WORDS.includes(v.toLowerCase())) return add({ step: "portrait", value: null });
    if (!PORTRAIT_ID.test(v)) return { ok: false, error: "초상화 id 형식이 올바르지 않다." };
    return add({ step: "portrait", value: v });
  }
  if (step === "age") {
    const n = Number.parseInt(text.trim().replace(/세$/, ""), 10);
    const floor = ageFloor(s, draft);
    const problems =
      Number.isNaN(n) || !/^\d+\s*세?$/.test(text.trim())
        ? [`나이는 숫자로 적는다 (${floor}~${s.creation!.age!.max}).`]
        : n < floor
          ? [`이 사람은 ${floor}세 이상이다 (${ageFloorReason(s, draft)}). 나이는 ${floor}~${s.creation!.age!.max}세.`]
          : checkAge(s, n);
    if (problems.length) return { ok: false, error: problems.join(" ") };
    return add({ step: "age", value: n });
  }
  if (step === "gender") {
    const v = fromOptions();
    return v ? add({ step: "gender", value: v }) : { ok: false, error: `성별은 ${options.map((o) => o.label).join(", ")} 중 하나다.` };
  }
  if (step === "abilities") {
    const v = fromOptions();
    if (v === "random") return add({ step: "abilities", value: "random", rolled: randomAbilityBuy(s, rng) });
    if (v === "manual") return add({ step: "abilities", value: "manual" });
    const past = pastOf(s, collectDraft(draft).past);
    if (v === "past" && past) return add({ step: "abilities", value: "past", rolled: Object.fromEntries(s.stats.map((x) => [x.id, past.stats[x.id] ?? 0])) });
    return { ok: false, error: `${past ? "배경대로(past), " : ""}직접 정할지(manual), 운에 맡길지(random) 고른다.` };
  }
  if (step === "ability_set") {
    const tiers = abilityTiers(s);
    const parsed = tiers ? parseAbilityTiers(s, tiers, text) : parseAbilities(s, text);
    if (!parsed.ok) return parsed;
    const problems = checkAbilities(s, parsed.values);
    if (problems.length) return { ok: false, error: problems.join(" ") };
    return add({ step: "ability_set", values: Object.fromEntries(s.stats.map((x) => [x.id, parsed.values[x.id] ?? 0])) });
  }
  if (step === "traits") {
    const v = fromOptions() ?? (NONE_WORDS.includes(text.trim().toLowerCase()) ? "none" : null);
    if (v === "random") return add({ step: "traits", value: "random", rolled: randomTraits(s, rng) });
    if (v === "manual" || v === "none") return add({ step: "traits", value: v });
    return { ok: false, error: "직접 고를지(manual), 운에 맡길지(random), 없이 갈지(none) 고른다." };
  }
  if (step === "traits_pick" || step === "traits_personality") {
    const parsed = parseTraits(s, TRAIT_KIND_STEP[step], answer, traitChoices(s, draft, step));
    if (!parsed.ok) return parsed;
    const problems = checkTraits(s, [...collectDraft(draft).traits, ...parsed.ids]);
    if (problems.length) return { ok: false, error: problems.join(" ") };
    return add({ step, value: parsed.ids });
  }
  // 확인
  const v = pick(options, text);
  if (v === "back") return { ok: true, draft: backCreation(draft), done: false };
  if (v === "restart") return { ok: true, draft: { ...newCreationDraft(draft.mode), withPortrait: draft.withPortrait, presetAge: draft.presetAge, presetGender: draft.presetGender, minAge: draft.minAge }, done: false };
  if (v !== "start") return { ok: false, error: "이대로 시작(start), 한 단계 뒤로(back), 처음부터 다시(restart) 중에서 고른다." };
  const choice = draftChoice(draft);
  const problems = checkCharacterChoice(s, choice);
  return problems.length ? { ok: false, error: problems.join(" ") } : { ok: true, draft, done: true, choice };
}

/** 한 단계 뒤로 */
export function backCreation(draft: CreationDraft): CreationDraft {
  return { ...draft, answers: draft.answers.slice(0, -1) };
}

/** 지금까지 정한 것 (한 줄씩) */
function summary(s: Scenario, draft: CreationDraft): string[] {
  const d = collectDraft(draft);
  const lines: string[] = [];
  const past = pastOf(s, d.past);
  if (past) lines.push(`과거: ${past.label}`);
  if (d.name !== undefined) lines.push(`이름: ${d.name}`);
  if (d.gender !== undefined) lines.push(`성별: ${s.creation?.genders.find((g) => g.id === d.gender)?.label ?? d.gender}`);
  if (d.age !== undefined && s.creation?.age) lines.push(`나이: ${d.age}세`);
  const shown = s.stats.filter((x) => d.abilities[x.id] !== undefined);
  if (shown.length) lines.push(`능력: ${shown.map((x) => `${x.label} ${signed(d.abilities[x.id]!)}`).join(", ")}`);
  if (d.skillMethod !== undefined && (d.skillMethod !== "manual" || d.skillsSet)) lines.push(`스킬: ${describeSkills(s, d.skills)}`);
  if (d.traitMethod !== undefined && (d.traitMethod !== "manual" || d.traitSteps.has("traits_pick"))) {
    lines.push(`트레잇: ${d.traits.length ? d.traits.map((id) => s.traits.find((t) => t.id === id)?.label ?? id).join(", ") : "없음"}`);
  }
  return lines;
}

const STEP_TITLE: Record<string, string> = {
  past: "과거 배경",
  name: "이름",
  portrait: "얼굴",
  gender: "성별",
  age: "나이",
  abilities: "능력",
  ability_set: "능력 정하기",
  skills: "스킬",
  skill_set: "스킬 정하기",
  traits: "트레잇",
  traits_pick: "트레잇: 약점·강점",
  traits_personality: "트레잇: 성격",
  confirm: "확인",
};

/**
 * GM에게 줄 이번 단계 안내: 무엇을 묻는지, 보기(있으면), 서술 힌트.
 * 첫 단계(새 게임)면 세계 소개를 먼저 들려주게 한다
 */
/** introShown: 지금 상황(새 캐릭터면 다른 사람의 삶)을 앞 단계(동기와 이야기)에서 이미 들려줬다 (12-86) */
export function describeCreationStep(content: Content, draft: CreationDraft, roleId: string, introShown = false): string {
  const s = content.scenario;
  const rules = creationRules(content, roleId);
  const step = currentStep(s, draft);
  const options = stepOptions(s, draft, step);
  const narration = s.creation?.narration ?? {};
  const lines: string[] = [];

  if (draft.answers.length === 0 && !introShown) {
    // 새 게임의 지금 상황은 캐릭터를 다 만든 뒤 첫 장면 앞에서 들려준다 (MCP 어댑터가 붙인다)
    if (draft.mode === "heir") {
      lines.push(
        "## 먼저: 다른 사람의 삶",
        "같은 세계에서 다른 사람으로 이어 간다. 이전 주인공의 죽음 뒤, 같은 무리의 막사에서 누군가가 눈을 뜬다는 느낌으로 짧게 운을 띄운다. 새 캐릭터는 이전 캐릭터가 알던 것을 모른다. 그다음 아래 단계를 묻는다.",
        "",
      );
    }
  }

  const index = stepIndex(s, draft);
  lines.push(`## 캐릭터 만들기 ${index.at}/${index.total}: ${STEP_TITLE[step]}`);
  const done = summary(s, draft);
  if (done.length) lines.push(`지금까지: ${done.join(" · ")}`);

  if (step === "past") {
    lines.push(
      "물을 것: 붕괴 전에 무엇을 하던 사람이었는지 (과거 배경). 배경마다 이름과 한 줄, 받는 것(스킬·능력·물건)을 보여 주고 고르게 한다. 능력과 스킬은 배경이 기본값을 주고, 뒤에서 같은 포인트 안에서 고칠 수 있다.",
    );
    if (narration.past) lines.push(`서술 힌트: ${narration.past}`);
  } else if (step === "skills") {
    const sk = s.creation?.skills;
    const rankSkills = describeSkills(s, s.creation?.rank_skills[content.roles[roleId]?.rank ?? ""] ?? {});
    lines.push(
      `물을 것: 스킬을 과거 배경대로 둘지 고칠지. 고치면 ${sk?.points ?? 0}포인트를 스킬마다 +${sk?.max ?? 1}까지 나눈다.${rankSkills !== "없음" ? ` 계급 기본 훈련(${rankSkills})은 따로 더해진다.` : ""}`,
    );
    if (narration.skills) lines.push(`서술 힌트: ${narration.skills}`);
  } else if (step === "skill_set") {
    const sk = s.creation?.skills;
    lines.push(
      `물을 것: 스킬 ${sk?.points ?? 0}포인트를 한 번에 (스킬마다 +${sk?.max ?? 1}까지). 아래 목록을 보여 주고 글로 답하게 한다 (보기 없이).`,
      `스킬: ${s.moves.map((m) => `${m.label}(${m.description ?? ""})`).join(" / ")}`,
      '답 형식: 스킬 이름을 쉼표로 (예: 사격, 경계). 받은 답은 그대로 넘긴다.',
    );
  } else if (step === "name") {
    lines.push("물을 것: 주인공의 이름 (한글 8자, 영문 16자까지, 자유롭게 입력). 보기 없이 글로 묻는다.");
    if (narration.name) lines.push(`서술 힌트: ${narration.name}`);
  } else if (step === "portrait") {
    lines.push('물을 것: 얼굴(초상화). 그림은 상태 화면에서만 고를 수 있다. 채팅으로 이어 하면 묻지 말고 "none"을 넘긴다 (실루엣).');
  } else if (step === "gender") {
    lines.push("물을 것: 성별.");
    if (narration.gender) lines.push(`서술 힌트: ${narration.gender}`);
  } else if (step === "age") {
    const range = s.creation!.age!;
    const floor = ageFloor(s, draft);
    const base = content.roles[roleId]?.age;
    lines.push(
      `물을 것: 나이 (${floor}~${range.max}세, 숫자로${floor > range.min ? `. ${ageFloorReason(s, draft)} 때문에 ${floor}세부터` : ""}). 보기 없이 글로 묻는다.${base ? ` 이 시나리오의 기본은 ${Math.max(base, floor)}세다. 플레이어가 상관없다고 하면 "기본"을 넘긴다.` : ""}`,
    );
    if (narration.age) lines.push(`서술 힌트: ${narration.age}`);
  } else if (step === "abilities") {
    const tiers = abilityTiers(s);
    lines.push(
      tiers
        ? `물을 것: 타고난 능력을 어떻게 정할지. 직접 정하면 ${tiers.map((t) => `${t.label}(${signed(t.value)}) ${t.count}개`).join(", ")}를 고르고 나머지는 보통(0)이다.`
        : `물을 것: 타고난 능력을 어떻게 정할지. 모두 0(보통)에서 시작해 ${rules?.points ?? 0}포인트를 나눠 쓴다. 값별 비용 ${rules?.cost.map((c) => `${signed(c.value)}=${c.cost}`).join(", ")} (0보다 낮추면 포인트를 돌려받고, ${rules?.maxLow ?? 0}개까지 낮출 수 있다).`,
      `능력: ${s.stats.map((x) => `${x.label}(${x.description ?? ""})`).join(", ")}`,
    );
    if (narration.abilities) lines.push(`서술 힌트: ${narration.abilities}`);
  } else if (step === "ability_set" && abilityTiers(s)) {
    const tiers = abilityTiers(s)!;
    lines.push(
      `물을 것: 능력 ${s.stats.length}가지 중 ${tiers.map((t) => `${t.label}(${signed(t.value)}) ${t.count}개`).join(", ")}를 한 번에 고르게 한다. 나머지는 보통(0). 포인트 계산은 보여 주지 않는다. 능력마다 따로 묻거나 장면을 붙이지 않는다.`,
      "아래 능력 목록을 번호 그대로 번호 목록으로 보여 주고, 등급을 안내한 뒤 글로 답하게 한다 (보기 없이).",
      "",
      ...s.stats.map((x, i) => `${i + 1}. ${x.label} — ${x.description ?? ""}`),
      "",
      `답 형식: 등급 순서대로 "/"로 나눠 번호나 이름 (예: ${exampleTiers(tiers)}). 받은 답은 그대로 넘긴다. 운에 맡기고 싶다고 하면 create_character(back: true) 뒤 "random".`,
    );
  } else if (step === "ability_set") {
    lines.push(
      `물을 것: 능력 ${s.stats.length}가지를 한 번에. 능력마다 따로 묻거나 능력마다 장면을 붙이지 않는다. 아래 표와 규칙을 한 번에 보여 주고 글로 답하게 한다 (보기 없이).`,
      `규칙: 모두 0(보통)에서 시작해 ${rules?.points ?? 0}포인트를 나눠 쓴다. 값별 비용 ${rules?.cost.map((c) => `${signed(c.value)}=${c.cost}`).join(", ")}. 0보다 낮추면 포인트를 돌려받고, ${rules?.maxLow ?? 0}개까지 낮출 수 있다.`,
      `능력 표: ${s.stats.map((x) => `${x.label}(${x.description ?? ""})`).join(" / ")}`,
      `답 형식: 올리거나 낮출 능력만 "이름 값"으로 쉼표로 이어 적는다 (예: ${s.stats[0]?.label ?? ""} +1, ${s.stats[1]?.label ?? ""} +2). 적지 않은 능력은 0. 운에 맡기고 싶다고 하면 create_character(back: true) 뒤 "random".`,
    );
  } else if (step === "traits") {
    const lim = rules?.traitLimits;
    lines.push(
      `물을 것: 트레잇(타고난 기질과 버릇)을 어떻게 정할지. 강점은 약점으로 얻은 포인트만큼만 가질 수 있다. 약점 ${lim?.max_negative}개·강점 ${lim?.max_positive}개까지${lim?.max_personality !== undefined ? `, 성격 ${lim.max_personality}개까지` : ", 성격은 몇 개든"}. 반대되는 것끼리는 함께 가질 수 없다.`,
    );
    if (narration.traits) lines.push(`서술 힌트: ${narration.traits}`);
  } else if (step === "traits_pick") {
    const lim = rules?.traitLimits;
    const list = traitChoices(s, draft, step);
    lines.push(
      `물을 것: 약점과 강점을 한 번에 (각각 0개 이상, 약점 ${lim?.max_negative}개·강점 ${lim?.max_positive}개까지). 약점은 포인트를 얻고 강점은 포인트를 쓴다. 강점에 쓴 포인트 합이 약점으로 얻은 포인트 합을 넘으면 안 된다.`,
      "아래 표를 번호 그대로 마크다운 표로 보여 주고 글로 답하게 한다. 번호나 이름으로, 여러 개면 쉼표로(예: 2, 5, 14), 없으면 \"없음\". 답은 받은 그대로 넘긴다 (번호를 이름으로 바꾸지 않아도 된다).",
      "",
      "| 번호 | 종류 | 이름 | 포인트 | 효과 |",
      "|---|---|---|---|---|",
      ...list.map((t, i) => `| ${i + 1} | ${t.kind === "negative" ? "약점" : "강점"} | ${t.label} | ${t.kind === "negative" ? `+${t.cost}` : `-${t.cost}`} | ${t.description} |`),
      "",
    );
  } else if (step === "traits_personality") {
    const list = traitChoices(s, draft, step);
    lines.push(
      `물을 것: 성격 (0개 이상, 포인트 없음, ${rules?.traitLimits.max_personality !== undefined ? `${rules.traitLimits.max_personality}개까지` : "몇 개든"}). 성격은 서술의 연기 힌트다. 반대되는 성격끼리는 함께 가질 수 없다.`,
      "목록을 아래 번호 그대로 번호 목록(1. 2. 3.)으로 짧게 보여 주고 글로 답하게 한다. 번호나 이름으로, 여러 개면 쉼표로, 없으면 \"없음\". 답은 받은 그대로 넘긴다.",
      list.length ? `고를 수 있는 것:\n${list.map((t, i) => `${i + 1}. ${t.label}: ${t.description}`).join("\n")}` : "고를 수 있는 것: (없다. \"없음\"으로 넘어간다)",
    );
  } else {
    lines.push("물을 것: 이대로 시작할지. 정한 것을 한 사람의 모습으로 그려 보여 준 뒤 묻는다.");
    const { spent } = abilitySpend(s, collectDraft(draft).abilities);
    const left = (s.creation?.points ?? 0) - spent;
    if (collectDraft(draft).abilityMethod === "manual" && Number.isFinite(spent) && left > 0) {
      lines.push(`능력 포인트 ${left}을(를) 쓰지 않았다. 이대로 시작하면 사라진다고 알려 주고, 쓰고 싶으면 "처음부터 다시"나 뒤로 가기로 고치게 한다.`);
    }
  }

  if (options.length) {
    lines.push(
      `보기 (클릭으로 고르는 도구가 있으면 그것으로. 없으면 번호 목록): ${options.map((o) => `${o.label}${o.description ? ` (${o.description})` : ""} → "${o.value}"`).join(" / ")}`,
    );
  }
  lines.push(
    "",
    "한 번에 이 단계 하나만 묻는다. 대신 정하지 않는다. 플레이어의 답을 create_character(answer)로 넘긴다 (보기가 있으면 그 값). " +
      "되돌리려면 create_character(back: true). 묻는 말은 존댓말로 짧게 (게임 밖 안내다).",
  );
  return lines.join("\n");
}

/** 이번 단계가 몇 번째인지 (능력·트레잇을 하나씩 고르면 단계가 늘어난다) */
export function stepIndex(s: Scenario, draft: CreationDraft): { at: number; total: number } {
  const d = collectDraft(draft);
  const abilitySteps = d.abilityMethod === "manual" ? 1 : 0;
  const pastStep = s.creation?.pasts.length ? 1 : 0;
  const skillSteps = s.creation?.skills ? (d.skillMethod === "manual" ? 2 : 1) : 0;
  const traitSteps = d.traitMethod === "manual" ? 2 : 0;
  const ageStep = s.creation?.age && draft.presetAge === undefined ? 1 : 0;
  const portraitStep = draft.withPortrait ? 1 : 0;
  const genderStep = draft.presetGender === undefined ? 1 : 0;
  const total = 4 + pastStep + skillSteps + genderStep + portraitStep + ageStep + abilitySteps + traitSteps;
  return { at: Math.min(draft.answers.length + 1, total), total };
}

export type { CreationRules };
