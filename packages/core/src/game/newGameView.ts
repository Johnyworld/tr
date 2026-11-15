import { rankName } from "./ranks.ts";
import type { Content } from "../content/schemas.ts";
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
import { describeHistoryPart } from "./background.ts";
import { draftContent, GAME_PREMISE, introShownBefore, newGameStep, type NewGameDraft } from "./newGame.ts";
import { MAX_STORY_TEXT, motivesOf } from "./storyStart.ts";
import { checkGroup, groupRules, memberLabel } from "./startGroup.ts";
import { factionChoices, lonerAllowed, LONER, roleChoices, type FactionChoice, type RolePreset } from "./startChoice.ts";

/**
 * 상태 화면의 새 게임·새 캐릭터 만들기 (12-67). GM 안내(describeNewGameStep)와 같은 초안을 화면이 그릴 수 있게 나눈 모습.
 * 답은 채팅과 같은 말(answerNewGame)로 돌려받는다. 계산·검증은 모두 core가 한다
 */
export type NewGameView = {
  mode: NewGameDraft["mode"];
  step: "world" | "faction" | "companion" | "group" | "role" | "motive" | "story" | "story_setup" | "story_confirm" | "content" | "dialogue" | CreationStepId;
  /** 월드 고르기 */
  /** intro: 월드 이야기 (고르기 전에 펼쳐 읽는다) */
  worlds?: { id: string; title: string; tagline: string; description: string; intro: string }[];
  /** 어느 월드든 같은 게임 규칙 (core가 말한다) */
  premise?: string;
  /** 고른 월드 */
  world?: { title: string; intro: string };
  /** 무리 고르기 (12-77). loner: 떠돌이를 고를 수 있으면 그 답 */
  factions?: { list: FactionChoice[]; loner: string | null };
  /** 동기와 이야기 (12-77 2단계). motives: 고를 동기, motive: 고른 동기, text: 쓴 글, result: 옮긴 것(확인 단계) */
  story?: {
    title: string;
    motives: { id: string; label: string; summary: string; prompt: string; example: string | null }[];
    /** 고른 동기 id */
    motive: string | null;
    maxLength: number;
    /** 쓴 글 (다시 쓰기면 앞의 글) */
    text: string | null;
    /** 쓰기 도움: 이 도시의 무리와 이 사람이 알 만한 사람 */
    help: StoryHelp;
    /** 옮긴 것. opening은 떠돌이만 (준비된 시나리오는 시나리오의 첫 장면 그대로) */
    result: { opening: string | null; history: string[]; background: string[] } | null;
    /** 준비된 시나리오·새 캐릭터면 그 시나리오의 지금 상황 (이야기가 어긋나지 않게, 12-86). 떠돌이면 null */
    situation: string | null;
  };
  /** 떠돌이 동행 */
  companions?: { id: "pet" | "group" | "alone"; label: string; summary: string }[];
  /** 지금 고른 동행 (돌아왔을 때) */
  companion?: "pet" | "group" | "alone" | null;
  /** 떠돌이의 소규모 무리 고치기 (12-77 3단계). problems: 모두에 걸친 것, 사람마다는 members[].problems */
  group?: {
    me: { age: number; gender: string; problems: string[] };
    members: { relation: string; label: string; name: string; age: number; gender: string; problems: string[] }[];
    problems: string[];
    relations: { id: string; label: string; age: [number, number] }[];
    genders: { id: string; label: string }[];
    max: number;
    meAge: { min: number; max: number };
    nameMax: number;
  };
  /** 계급 고르기: 고른 무리의 계급과 그 자리의 시나리오 (12-84) */
  role?: { presets: RolePreset[]; faction: string; factionName: string };
  content?: { adultAge: number };
  character?: CharacterStepView;
};

export type CharacterStepView = {
  index: { at: number; total: number };
  roleLabel: string;
  /** 새 게임의 첫 단계에서 보여 줄 지금 상황 (시나리오 소개) */
  situation: string | null;
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
  };
  /** 과거 배경 고르기 (12-84): 배경마다 스킬·능력·물건 */
  pasts: { id: string; label: string; summary: string; skills: string; stats: string; items: string; minAge: number | null }[];
  /** 계급 기본 훈련 (12-87): 과거 배경의 스킬과 따로 더해진다. 없으면 빈 글 */
  rankSkills: string;
  /** 고친 능력·스킬의 처음 값: 고른 과거 배경의 것 */
  pastDefaults: { stats: Record<string, number>; skills: Record<string, number> } | null;
  /** 스킬 고치기: 고를 수 있는 스킬과 규칙 */
  moves: { id: string; label: string; category: string; description: string }[];
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
  traitLimits: { max_positive: number; max_negative: number; max_personality: number } | null;
  /** 확인 단계: 쓰지 않은 능력 포인트 */
  unusedPoints: number;
};

export type StoryHelp = {
  factions: { name: string; about: string }[];
  /** 이름이 알려진 사람: 자기 무리 사람들(무리에 속하면)과 각 무리의 우두머리 */
  people: { name: string; who: string }[];
};

/**
 * 이야기 쓰기 도움 (12-77). 시작하는 사람이 알 만한 것만: 무리 소개(월드 이야기와 같은 말),
 * 자기 무리 사람들, 각 무리의 우두머리. 비밀·숨은 관계는 넣지 않는다 (원칙 4)
 */
function storyHelp(content: Content, faction: string | null): StoryHelp {
  const top = content.scenario.rank_ladder.reduce((a, b) => (b.level > a.level ? b : a)).id;
  const people = Object.values(content.npcs)
    // 붙잡혀 있는 사람은 빼 둔다 (어디 있는지는 시작하는 사람이 모른다)
    .filter((n) => n.faction && !n.start_captive && content.factions[n.faction]?.startable !== false && (n.faction === faction || n.rank === top))
    .sort((a, b) => Number(b.faction === faction) - Number(a.faction === faction) || (a.faction ?? "").localeCompare(b.faction ?? ""))
    .map((n) => ({ name: n.name, who: `${content.factions[n.faction!]?.name ?? ""} ${rankName(content, n.faction, n.rank)}${n.faction === faction ? ` · ${n.reputation}` : ""}` }));
  return { factions: Object.values(content.factions).filter((f) => f.startable !== false).map((f) => ({ name: f.name, about: f.public })), people };
}

export function newGameView(packs: ReadonlyMap<string, Content>, draft: NewGameDraft): NewGameView {
  const step = newGameStep(draft);
  if (step === "world") {
    return {
      mode: draft.mode,
      step,
      worlds: [...packs.values()].map((c) => {
        const w = worldInfo(c);
        return { ...w, intro: c.scenario.introText ?? `${w.tagline}\n${w.description}` };
      }),
      premise: GAME_PREMISE,
    };
  }
  const pack = packs.get(draft.packId!)!;
  const info = worldInfo(pack);
  const world = { title: info.title, intro: pack.scenario.introText ?? `${info.tagline}\n${info.description}` };
  const unlocked = draft.unlocked?.[pack.scenario.id] ?? [];
  if (step === "faction") {
    return {
      mode: draft.mode,
      step,
      world,
      factions: { list: factionChoices(pack, unlocked), loner: lonerAllowed(pack) ? LONER : null },
    };
  }
  if (step === "companion") {
    const pet = pack.scenario.custom_start?.pet;
    return {
      mode: draft.mode,
      step,
      world,
      companion: draft.companion ?? null,
      companions: [
        ...(pet ? [{ id: "pet" as const, label: "반려견과 함께", summary: `${pack.extras[pet]?.label ?? "개"} 한 마리가 곁을 지킨다.` }] : []),
        ...(groupRules(pack) ? [{ id: "group" as const, label: "소규모 무리", summary: "가족이나 길동무 몇 사람과 함께 다닌다." }] : []),
        { id: "alone" as const, label: "혼자", summary: "아무도 없이, 혼자 버텨 왔다." },
      ],
    };
  }
  if (step === "group") {
    const rules = groupRules(pack)!;
    const g = draft.group!;
    const problems = checkGroup(pack, g);
    const at = (i: number) => problems.filter((p) => p.at === i).map((p) => p.problem);
    // 주인공 줄의 문제와 모두에 걸친 문제를 나눈다 (주인공 나이·성별에 관한 것은 주인공 줄에)
    const meProblems = at(-1).filter((p) => p.startsWith("주인공"));
    return {
      mode: draft.mode,
      step,
      world,
      group: {
        me: { ...g.me, problems: meProblems },
        members: g.members.map((m, i) => ({ ...m, label: memberLabel(pack, g, m), problems: at(i) })),
        problems: at(-1).filter((p) => !p.startsWith("주인공")),
        relations: rules.relations.map((r) => ({ id: r.id, label: r.label, age: r.age })),
        genders: pack.scenario.creation?.genders ?? [],
        max: rules.max,
        meAge: pack.scenario.custom_start?.age ?? { min: 16, max: 65 },
        nameMax: MAX_NAME_WIDTH,
      },
    };
  }
  if (step === "role") {
    const faction = draft.faction!;
    return {
      mode: draft.mode,
      step,
      world,
      role: { presets: roleChoices(pack, faction, unlocked), faction, factionName: pack.factions[faction]?.name ?? faction },
    };
  }
  if (step === "motive" || step === "story" || step === "story_setup" || step === "story_confirm") {
    const motives = motivesOf(pack);
    const st = draft.story;
    const m = motives.find((x) => x.id === st?.motive) ?? null;
    const mapped = step === "story_confirm" ? st!.mapped! : null;
    const role = draftContent(packs, draft).roles[draft.roleId!]!;
    return {
      mode: draft.mode,
      step,
      world,
      story: {
        title: draft.built?.title ?? role.scenario?.title ?? role.label,
        motives: motives.map((x) => ({ id: x.id, label: x.label, summary: x.summary, prompt: x.prompt, example: x.example ?? null })),
        motive: m?.id ?? null,
        maxLength: MAX_STORY_TEXT,
        text: st?.text ?? st?.previous ?? null,
        help: storyHelp(pack, draft.built ? draft.built.faction : role.faction || null),
        situation: draft.built ? null : (role.scenario?.intro ?? role.opening_scene),
        result: mapped ? { opening: mapped.opening ?? null, history: mapped.history.map((p) => describeHistoryPart(pack, p)), background: mapped.background } : null,
      },
    };
  }
  if (step === "content") return { mode: draft.mode, step, world, content: { adultAge: pack.scenario.content_rating?.adult_age ?? 18 } };
  if (step === "dialogue") return { mode: draft.mode, step, world };

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
      // 동기 단계에서 이미 보여 줬으면 다시 보여 주지 않는다
      situation: draft.mode === "new_world" && !introShownBefore(draft) ? (role?.scenario?.intro ?? role?.opening_scene ?? null) : null,
      startSkills: rules?.startSkills ?? [],
      chosen: {
        past: pastOf(s, d.past)?.label ?? null,
        portrait: d.portrait ?? null,
        name: d.name ?? null,
        gender: d.gender !== undefined ? (s.creation?.genders.find((g) => g.id === d.gender)?.label ?? d.gender) : null,
        age: s.creation?.age ? (d.age ?? null) : null,
        abilities: s.stats.filter((x) => d.abilities[x.id] !== undefined).map((x) => ({ label: x.label, value: d.abilities[x.id]! })),
        skills:
          d.skillMethod !== undefined && (d.skillMethod !== "manual" || d.skillsSet)
            ? Object.entries(d.skills).map(([id, v]) => ({ label: s.moves.find((m) => m.id === id)?.label ?? id, value: v }))
            : null,
        traits:
          d.traitMethod !== undefined && (d.traitMethod !== "manual" || d.traitSteps.has("traits_pick"))
            ? d.traits.map((id) => s.traits.find((t) => t.id === id)?.label ?? id)
            : null,
      },
      options: stepOptions(s, draft.character, cstep),
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
      moves: s.moves.map((m) => ({ id: m.id, label: m.label, category: m.category ?? "", description: m.description ?? "" })),
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
      unusedPoints: cstep === "confirm" && d.abilityMethod === "manual" && Number.isFinite(spent) && left > 0 ? left : 0,
    },
  };
}
