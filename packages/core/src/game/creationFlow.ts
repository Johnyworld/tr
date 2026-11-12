import type { Content } from "../content/schemas.ts";
import type { Rng } from "../rng.ts";
import type { Scenario } from "../scenario/schema.ts";
import {
  abilitySpend,
  checkCharacterChoice,
  checkTraits,
  creationRules,
  MAX_NAME_LENGTH,
  randomAbilityBuy,
  randomTraits,
  traitBalance,
  type CreationRules,
} from "./creation.ts";
import type { CharacterChoice } from "./state.ts";

/**
 * 대화로 하는 캐릭터 생성 (기획서 4.2, 11.6): 한 번에 하나씩, 정해진 순서로 묻는다.
 * 세계 소개 → 이름 → 성별 → 능력(직접 하나씩 / 무작위) → 트레잇(부정 → 긍정 → 성격 / 무작위 / 없이) → 확인.
 * 답은 모두 코드가 검증하고 포인트를 계산한다 (GM은 숫자를 만들지 않는다, 원칙 2).
 * 초안은 세이브에 쓰지 않는다. 확인을 마쳐야 세계(또는 새 캐릭터)를 만든다.
 */

export type CreationAnswer =
  | { step: "name"; value: string }
  | { step: "gender"; value: string }
  | { step: "abilities"; value: "manual" | "random"; rolled?: Record<string, number> }
  | { step: "ability"; stat: string; value: number }
  | { step: "traits"; value: "manual" | "random" | "none"; rolled?: string[] }
  | { step: "traits_negative" | "traits_positive" | "traits_personality"; value: string[] };

export type CreationDraft = {
  /** new_world: 새 게임 (세계 소개부터) / heir: 사망 뒤 같은 세계의 새 캐릭터 */
  mode: "new_world" | "heir";
  answers: CreationAnswer[];
};

export type CreationStepId =
  | "name"
  | "gender"
  | "abilities"
  | `ability:${string}`
  | "traits"
  | "traits_negative"
  | "traits_positive"
  | "traits_personality"
  | "confirm";

export type StepOption = { value: string; label: string; description?: string };

export function newCreationDraft(mode: CreationDraft["mode"]): CreationDraft {
  return { mode, answers: [] };
}

const TRAIT_KIND_STEP = {
  traits_negative: "negative",
  traits_positive: "positive",
  traits_personality: "personality",
} as const;

/** 지금까지의 답에서 정해진 것 */
function collect(draft: CreationDraft) {
  let name: string | undefined;
  let gender: string | undefined;
  let abilityMethod: "manual" | "random" | undefined;
  const abilities: Record<string, number> = {};
  let traitMethod: "manual" | "random" | "none" | undefined;
  const traits: string[] = [];
  const traitSteps = new Set<string>();
  for (const a of draft.answers) {
    if (a.step === "name") name = a.value;
    else if (a.step === "gender") gender = a.value;
    else if (a.step === "abilities") {
      abilityMethod = a.value;
      if (a.rolled) Object.assign(abilities, a.rolled);
    } else if (a.step === "ability") abilities[a.stat] = a.value;
    else if (a.step === "traits") {
      traitMethod = a.value;
      if (a.rolled) traits.push(...a.rolled);
    } else {
      traitSteps.add(a.step);
      traits.push(...a.value);
    }
  }
  return { name, gender, abilityMethod, abilities, traitMethod, traits, traitSteps };
}

/** 다음에 물을 단계 */
export function currentStep(s: Scenario, draft: CreationDraft): CreationStepId {
  const d = collect(draft);
  if (d.name === undefined) return "name";
  if (d.gender === undefined) return "gender";
  if (d.abilityMethod === undefined) return "abilities";
  if (d.abilityMethod === "manual") {
    const next = s.stats.find((x) => d.abilities[x.id] === undefined);
    if (next) return `ability:${next.id}`;
  }
  if (d.traitMethod === undefined) return "traits";
  if (d.traitMethod === "manual") {
    for (const step of ["traits_negative", "traits_positive", "traits_personality"] as const) {
      if (!d.traitSteps.has(step)) return step;
    }
  }
  return "confirm";
}

/** 고른 것 (확인 단계 요약, 세계 만들기) */
export function draftChoice(draft: CreationDraft): CharacterChoice {
  const d = collect(draft);
  return { name: d.name ?? "", gender: d.gender ?? null, abilities: d.abilities, portrait: null, traits: d.traits };
}

/** 능력 하나에 고를 수 있는 값: 비용이 있고, 앞서 쓴 포인트와 합쳐 넘지 않고, 낮출 수 있는 개수 안 */
export function abilityValues(s: Scenario, draft: CreationDraft, statId: string): number[] {
  const c = s.creation;
  if (!c) return [];
  const so = collect(draft).abilities;
  return Object.keys(c.cost)
    .map(Number)
    .sort((a, b) => a - b)
    .filter((v) => {
      const { spent, low } = abilitySpend(s, { ...so, [statId]: v });
      return spent <= c.points && low <= c.max_low;
    });
}

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
const RANDOM_WORDS = ["random", "무작위", "알아서", "랜덤"];
const NONE_WORDS = ["none", "없음", "없이", "안 고름", "고르지 않음", ""];

/** 보기에서 고르기: value나 label이 같으면 그것 */
function pick(options: StepOption[], answer: string): string | null {
  const a = answer.trim().toLowerCase();
  return options.find((o) => o.value.toLowerCase() === a || o.label.toLowerCase() === a)?.value ?? null;
}

/** 단계의 보기 (보기가 정해진 단계만) */
export function stepOptions(s: Scenario, draft: CreationDraft, step: CreationStepId): StepOption[] {
  if (step === "gender") return (s.creation?.genders ?? []).map((g) => ({ value: g.id, label: g.label }));
  if (step === "abilities") {
    return [
      { value: "manual", label: "하나씩 정하기", description: `능력 ${s.stats.length}가지를 차례로 정한다` },
      { value: "random", label: "운에 맡기기", description: "포인트를 규칙대로 무작위로 나눈다" },
    ];
  }
  if (step.startsWith("ability:")) {
    const statId = step.slice("ability:".length);
    const cost = s.creation?.cost ?? {};
    return abilityValues(s, draft, statId).map((v) => ({
      value: String(v),
      label: signed(v),
      description: cost[String(v)]! > 0 ? `${cost[String(v)]}포인트` : cost[String(v)]! < 0 ? `${-cost[String(v)]!}포인트 돌려받음` : "기본",
    }));
  }
  if (step === "traits") {
    return [
      { value: "manual", label: "직접 고르기", description: "약점 → 강점 → 성격 순서로 고른다" },
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

/** 트레잇 이름이나 id 목록 → id. 모르는 것은 오류 */
function parseTraits(s: Scenario, kind: string, answer: string | string[]): { ok: true; ids: string[] } | { ok: false; error: string } {
  const raw = (Array.isArray(answer) ? answer : answer.split(/[,，、\n]/)).map((x) => x.trim()).filter((x) => x.length > 0);
  if (raw.length === 1 && NONE_WORDS.includes(raw[0]!.toLowerCase())) return { ok: true, ids: [] };
  const ids: string[] = [];
  for (const r of raw) {
    const t = s.traits.find((x) => x.selectable && (x.id === r || x.label === r));
    if (!t) return { ok: false, error: `"${r}"라는 트레잇은 없다.` };
    if (t.kind !== kind) return { ok: false, error: `${t.label}은(는) 이 단계에서 고르는 트레잇이 아니다.` };
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

  if (step === "name") {
    const name = text.trim();
    if (!name || name.length > MAX_NAME_LENGTH) return { ok: false, error: `이름은 1~${MAX_NAME_LENGTH}자다.` };
    return add({ step: "name", value: name });
  }
  if (step === "gender") {
    const v = fromOptions();
    return v ? add({ step: "gender", value: v }) : { ok: false, error: `성별은 ${options.map((o) => o.label).join(", ")} 중 하나다.` };
  }
  if (step === "abilities") {
    const v = fromOptions();
    if (v === "random") return add({ step: "abilities", value: "random", rolled: randomAbilityBuy(s, rng) });
    if (v === "manual") return add({ step: "abilities", value: "manual" });
    return { ok: false, error: "하나씩 정할지(manual) 운에 맡길지(random) 고른다." };
  }
  if (step.startsWith("ability:")) {
    const statId = step.slice("ability:".length);
    const v = Number(text.trim().replace(/^\+/, ""));
    if (!Number.isInteger(v) || !options.some((o) => Number(o.value) === v)) {
      return { ok: false, error: `지금 고를 수 있는 값은 ${options.map((o) => o.label).join(", ")}이다.` };
    }
    return add({ step: "ability", stat: statId, value: v });
  }
  if (step === "traits") {
    const v = fromOptions() ?? (NONE_WORDS.includes(text.trim().toLowerCase()) ? "none" : null);
    if (v === "random") return add({ step: "traits", value: "random", rolled: randomTraits(s, rng) });
    if (v === "manual" || v === "none") return add({ step: "traits", value: v });
    return { ok: false, error: "직접 고를지(manual), 운에 맡길지(random), 없이 갈지(none) 고른다." };
  }
  if (step === "traits_negative" || step === "traits_positive" || step === "traits_personality") {
    const parsed = parseTraits(s, TRAIT_KIND_STEP[step], answer);
    if (!parsed.ok) return parsed;
    const problems = checkTraits(s, [...collect(draft).traits, ...parsed.ids]);
    if (problems.length) return { ok: false, error: problems.join(" ") };
    return add({ step, value: parsed.ids });
  }
  // 확인
  const v = pick(options, text);
  if (v === "back") return { ok: true, draft: backCreation(draft), done: false };
  if (v === "restart") return { ok: true, draft: newCreationDraft(draft.mode), done: false };
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
  const d = collect(draft);
  const lines: string[] = [];
  if (d.name !== undefined) lines.push(`이름: ${d.name}`);
  if (d.gender !== undefined) lines.push(`성별: ${s.creation?.genders.find((g) => g.id === d.gender)?.label ?? d.gender}`);
  const shown = s.stats.filter((x) => d.abilities[x.id] !== undefined);
  if (shown.length) lines.push(`능력: ${shown.map((x) => `${x.label} ${signed(d.abilities[x.id]!)}`).join(", ")}`);
  if (d.traitMethod !== undefined) {
    lines.push(`트레잇: ${d.traits.length ? d.traits.map((id) => s.traits.find((t) => t.id === id)?.label ?? id).join(", ") : "없음"}`);
  }
  return lines;
}

const STEP_TITLE: Record<string, string> = {
  name: "이름",
  gender: "성별",
  abilities: "능력",
  traits: "트레잇",
  traits_negative: "트레잇: 약점",
  traits_positive: "트레잇: 강점",
  traits_personality: "트레잇: 성격",
  confirm: "확인",
};

/**
 * GM에게 줄 이번 단계 안내: 무엇을 묻는지, 보기(있으면), 서술 힌트.
 * 첫 단계(새 게임)면 세계 소개를 먼저 들려주게 한다
 */
export function describeCreationStep(content: Content, draft: CreationDraft, roleId: string): string {
  const s = content.scenario;
  const rules = creationRules(content, roleId);
  const step = currentStep(s, draft);
  const options = stepOptions(s, draft, step);
  const narration = s.creation?.narration ?? {};
  const lines: string[] = [];

  if (draft.answers.length === 0 && step === "name") {
    if (draft.mode === "new_world") {
      lines.push(
        "## 먼저: 지금 상황",
        "월드 이야기는 이미 들려줬다. 아래를 바탕으로 주인공이 지금 어디에 어떤 처지로 있는지 GM의 목소리로 들려준다 (두세 문단, 목록 말고 이야기로). 소개에 없는 사실은 만들지 않는다. 그다음 이름을 묻는다.",
        "",
        content.roles[roleId]?.scenario?.intro ?? content.roles[roleId]?.opening_scene ?? "",
        "",
        `시작 역할: ${rules?.roleLabel ?? ""}. 시작 훈련: ${rules?.startSkills.map((x) => `${x.label} ${signed(x.value)}`).join(", ") ?? ""}`,
        "",
      );
    } else {
      lines.push(
        "## 먼저: 다른 사람의 삶",
        "같은 세계에서 다른 사람으로 이어 간다. 이전 주인공의 죽음 뒤, 같은 무리의 막사에서 누군가가 눈을 뜬다는 느낌으로 짧게 운을 띄운다. 새 캐릭터는 이전 캐릭터가 알던 것을 모른다. 그다음 이름을 묻는다.",
        "",
      );
    }
  }

  const index = stepIndex(s, draft);
  lines.push(`## 캐릭터 만들기 ${index.at}/${index.total}: ${step.startsWith("ability:") ? `능력: ${s.stats.find((x) => `ability:${x.id}` === step)?.label}` : STEP_TITLE[step]}`);
  const done = summary(s, draft);
  if (done.length) lines.push(`지금까지: ${done.join(" · ")}`);

  if (step === "name") {
    lines.push(`물을 것: 주인공의 이름 (1~${MAX_NAME_LENGTH}자, 자유롭게 입력). 보기 없이 글로 묻는다.`);
    if (narration.name) lines.push(`서술 힌트: ${narration.name}`);
  } else if (step === "gender") {
    lines.push("물을 것: 성별.");
    if (narration.gender) lines.push(`서술 힌트: ${narration.gender}`);
  } else if (step === "abilities") {
    lines.push(
      `물을 것: 타고난 능력을 어떻게 정할지. 모두 0(보통)에서 시작해 ${rules?.points ?? 0}포인트를 나눠 쓴다. 값별 비용 ${rules?.cost.map((c) => `${signed(c.value)}=${c.cost}`).join(", ")} (0보다 낮추면 포인트를 돌려받고, ${rules?.maxLow ?? 0}개까지 낮출 수 있다).`,
      `능력: ${s.stats.map((x) => `${x.label}(${x.description ?? ""})`).join(", ")}`,
    );
    if (narration.abilities) lines.push(`서술 힌트: ${narration.abilities}`);
  } else if (step.startsWith("ability:")) {
    const stat = s.stats.find((x) => `ability:${x.id}` === step)!;
    const { spent } = abilitySpend(s, collect(draft).abilities);
    const left = (s.creation?.points ?? 0) - (Number.isFinite(spent) ? spent : 0);
    lines.push(`물을 것: ${stat.label} — ${stat.description ?? ""}. 남은 포인트 ${left}.`);
    if (narration.ability) lines.push(`서술 힌트: ${narration.ability}`);
  } else if (step === "traits") {
    const lim = rules?.traitLimits;
    lines.push(
      `물을 것: 트레잇(타고난 기질과 버릇)을 어떻게 정할지. 강점은 약점으로 얻은 포인트만큼만 가질 수 있다. 약점 ${lim?.max_negative}개·강점 ${lim?.max_positive}개·성격 ${lim?.max_personality}개까지.`,
    );
    if (narration.traits) lines.push(`서술 힌트: ${narration.traits}`);
  } else if (step === "traits_negative" || step === "traits_positive" || step === "traits_personality") {
    const kind = TRAIT_KIND_STEP[step];
    const b = traitBalance(s, collect(draft).traits);
    const chosen = collect(draft).traits;
    const list = (rules?.traits ?? []).filter((t) => t.kind === kind && !chosen.includes(t.id) && !t.opposites.some((o) => chosen.includes(o)));
    const affordable = kind === "positive" ? list.filter((t) => t.cost <= b.earned - b.spent) : list;
    lines.push(
      kind === "negative"
        ? "물을 것: 약점 (0개 이상). 고른 약점의 포인트만큼 다음 단계에서 강점을 가질 수 있다."
        : kind === "positive"
          ? `물을 것: 강점 (0개 이상). 쓸 수 있는 포인트 ${b.earned - b.spent}.`
          : "물을 것: 성격 (0개 이상, 포인트 없음).",
      "목록을 짧게 보여 주고(이름과 한 줄 설명) 글로 답하게 한다. 여러 개면 쉼표로, 없으면 \"없음\".",
      `고를 수 있는 것: ${affordable.length ? affordable.map((t) => `${t.label}${kind === "personality" ? "" : `(${t.cost})`}: ${t.description}`).join(" / ") : "(없다. \"없음\"으로 넘어간다)"}`,
    );
  } else {
    lines.push("물을 것: 이대로 시작할지. 정한 것을 한 사람의 모습으로 그려 보여 준 뒤 묻는다.");
    const { spent } = abilitySpend(s, collect(draft).abilities);
    const left = (s.creation?.points ?? 0) - spent;
    if (collect(draft).abilityMethod === "manual" && Number.isFinite(spent) && left > 0) {
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
      "되돌리려면 create_character(back: true). 서술은 짧게, 이야기 속 장면처럼.",
  );
  return lines.join("\n");
}

/** 이번 단계가 몇 번째인지 (능력·트레잇을 하나씩 고르면 단계가 늘어난다) */
function stepIndex(s: Scenario, draft: CreationDraft): { at: number; total: number } {
  const d = collect(draft);
  const abilitySteps = d.abilityMethod === "manual" ? s.stats.length : 0;
  const traitSteps = d.traitMethod === "manual" ? 3 : 0;
  const total = 5 + abilitySteps + traitSteps;
  return { at: Math.min(draft.answers.length + 1, total), total };
}

export type { CreationRules };
