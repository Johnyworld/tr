import { describeHistoryPart, type HistoryPart } from "./background.ts";
import type { Content } from "../content/schemas.ts";
import { scenarioInfos, worldInfo } from "../content/packs.ts";
import type { Rng } from "../rng.ts";
import {
  answerCreation,
  backCreation,
  currentStep,
  describeCreationStep,
  newCreationDraft,
  type CreationDraft,
  type CreationReply,
} from "./creationFlow.ts";
import { CUSTOM_ROLE_ID, type CharacterChoice } from "./state.ts";
import type { RoleContent } from "../content/schemas.ts";
import {
  buildCustomRole,
  checkCustomStart,
  describeCustomRole,
  describeCustomStartOptions,
  MAX_STORY_LENGTH,
  type CustomStartInput,
} from "./customStart.ts";

/**
 * 새 게임 (기획서 4.2, 12-15): 월드 고르기 → 시나리오(시작 역할) 고르기 → 캐릭터 만들기(creationFlow).
 * 사망 뒤 새 캐릭터는 같은 월드·시나리오라 바로 캐릭터 만들기부터 (heir).
 * 코드의 scenario 팩 = 플레이어의 "월드", 팩 안의 role = 플레이어의 "시나리오"
 */
export type NewGameDraft = {
  mode: CreationDraft["mode"];
  packId: string | null;
  roleId: string | null;
  /** 자유 시나리오 (roleId가 CUSTOM_ROLE_ID): 플레이어가 쓴 글 → GM이 옮긴 고르기 → 확인 (기획서 12.5) */
  custom?: { story: string | null; input: CustomStartInput | null; confirmed: boolean };
  /** 확인된 자유 시나리오의 역할 (사망 뒤 새 캐릭터면 세이브에 든 것) */
  customRole?: RoleContent | null;
  character: CreationDraft;
  /** 이 세계의 수위 (12-57). 새 세계면 캐릭터 만들기 전에 묻는다 (월드가 content_rating을 열었을 때) */
  options?: { mature: boolean } | null;
  /** 고른 월드가 수위 설정을 여는지 */
  contentRating?: boolean;
  /** 월드별로 열린 해금 (모든 판에 남는 것, 기획서 9.12). 해금이 필요한 시나리오를 보여 줄지 정한다 */
  unlocked?: Record<string, string[]>;
};

export type NewGameStep = "world" | "scenario" | "custom_story" | "custom_setup" | "custom_confirm" | "content" | "character";

export function newGameDraft(unlocked: Record<string, string[]> = {}): NewGameDraft {
  return { mode: "new_world", packId: null, roleId: null, character: newCreationDraft("new_world"), unlocked };
}

/** 사망 뒤 같은 세계의 새 캐릭터: 월드·시나리오는 정해져 있다 (자유 시나리오였으면 그 역할 그대로) */
export function heirDraft(packId: string, roleId: string, customRole: RoleContent | null = null): NewGameDraft {
  return { mode: "heir", packId, roleId, customRole, character: newCreationDraft("heir") };
}

export function newGameStep(draft: NewGameDraft): NewGameStep {
  if (!draft.packId) return "world";
  if (!draft.roleId) return "scenario";
  if (draft.roleId === CUSTOM_ROLE_ID && draft.mode === "new_world") {
    if (!draft.custom?.story) return "custom_story";
    if (!draft.custom.input) return "custom_setup";
    if (!draft.custom.confirmed) return "custom_confirm";
  }
  if (draft.mode === "new_world" && draft.options === undefined && draft.contentRating) return "content";
  return "character";
}

/** 이 초안의 월드 콘텐츠 (자유 시나리오의 역할을 넣어서) */
export function draftContent(packs: ReadonlyMap<string, Content>, draft: NewGameDraft): Content {
  const content = packs.get(draft.packId!)!;
  const role = draft.customRole;
  return role ? { ...content, roles: { ...content.roles, [role.id]: role } } : content;
}

export type NewGameReply =
  | { ok: true; draft: NewGameDraft; done: false }
  | {
      ok: true;
      draft: NewGameDraft;
      done: true;
      packId: string;
      roleId: string;
      choice: CharacterChoice;
      /** 이 세계의 수위 (12-57) */
      options: { mature: boolean };
      /** 자유 시나리오면 만든 역할과 캐릭터의 지난 삶 기억 */
      custom: { role: RoleContent; background: string[]; history: HistoryPart[] } | null;
    }
  | { ok: false; error: string };

const norm = (x: string) => x.trim().toLowerCase();

/** 이번 단계에 답한다 */
export function answerNewGame(packs: ReadonlyMap<string, Content>, draft: NewGameDraft, answer: string | string[], rng: Rng): NewGameReply {
  const text = Array.isArray(answer) ? answer.join(", ") : answer;
  const step = newGameStep(draft);
  if (step === "world") {
    const hit = [...packs.values()].map(worldInfo).find((w) => norm(w.id) === norm(text) || norm(w.title) === norm(text));
    if (!hit) return { ok: false, error: `월드는 ${[...packs.values()].map((c) => worldInfo(c).title).join(", ")} 중 하나다.` };
    return { ok: true, draft: { ...draft, packId: hit.id, contentRating: !!packs.get(hit.id)?.scenario.content_rating }, done: false };
  }
  const content = packs.get(draft.packId!)!;
  if (step === "scenario") {
    const options = scenarioOptions(content, draft.unlocked?.[content.scenario.id] ?? []);
    const hit = options.find((r) => norm(r.id) === norm(text) || norm(r.title) === norm(text));
    if (!hit) return { ok: false, error: `시나리오는 ${options.map((r) => r.title).join(", ")} 중 하나다.` };
    return { ok: true, draft: { ...draft, roleId: hit.id, ...(hit.id === CUSTOM_ROLE_ID ? { custom: { story: null, input: null, confirmed: false } } : {}) }, done: false };
  }
  if (step === "custom_story") {
    const story = text.trim();
    if (!story || story.length > MAX_STORY_LENGTH) return { ok: false, error: `시작 이야기는 1~${MAX_STORY_LENGTH}자로 쓴다.` };
    return { ok: true, draft: { ...draft, custom: { story, input: null, confirmed: false } }, done: false };
  }
  if (step === "custom_setup") {
    return { ok: false, error: "이 단계는 플레이어의 글을 옮겨 create_character(custom_start: {...})로 넘긴다." };
  }
  if (step === "content") {
    const v = norm(text);
    if (["on", "켜기", "켠다", "예", "네"].includes(v)) return { ok: true, draft: { ...draft, options: { mature: true } }, done: false };
    if (["off", "끄기", "끈다", "아니오", "아니요"].includes(v)) return { ok: true, draft: { ...draft, options: { mature: false } }, done: false };
    return { ok: false, error: "켜기(on) 또는 끄기(off) 중에서 고른다." };
  }
  if (step === "custom_confirm") {
    const v = norm(text);
    if (["confirm", "이대로", "좋아"].includes(v)) {
      const role = buildCustomRole(content, draft.custom!.input!);
      return { ok: true, draft: { ...draft, custom: { ...draft.custom!, confirmed: true }, customRole: role }, done: false };
    }
    if (["remap", "다시 옮기기"].includes(v)) return { ok: true, draft: { ...draft, custom: { ...draft.custom!, input: null } }, done: false };
    if (["rewrite", "다시 쓰기"].includes(v)) return { ok: true, draft: { ...draft, custom: { story: null, input: null, confirmed: false } }, done: false };
    return { ok: false, error: "이대로(confirm), 다시 옮기기(remap), 다시 쓰기(rewrite) 중에서 고른다." };
  }
  const r: CreationReply = answerCreation(content.scenario, draft.character, answer, rng);
  if (!r.ok) return r;
  const next = { ...draft, character: r.draft };
  if (!r.done) return { ok: true, draft: next, done: false };
  const custom =
    draft.mode === "new_world" && draft.customRole
      ? { role: draft.customRole, background: draft.custom?.input?.background ?? [], history: draft.custom?.input?.history ?? [] }
      : null;
  return { ok: true, draft: next, done: true, packId: draft.packId!, roleId: draft.roleId!, choice: r.choice, custom, options: draft.options ?? { mature: false } };
}

/** 자유 시나리오: GM이 플레이어의 글을 옮긴 고르기. 코드가 검증한다 */
export function setCustomStart(packs: ReadonlyMap<string, Content>, draft: NewGameDraft, input: CustomStartInput): NewGameReply {
  if (newGameStep(draft) !== "custom_setup") return { ok: false, error: "지금은 자유 시나리오를 옮기는 단계가 아니다." };
  const problems = checkCustomStart(packs.get(draft.packId!)!, input);
  if (problems.length) return { ok: false, error: problems.join(" ") };
  return { ok: true, draft: { ...draft, custom: { ...draft.custom!, input, confirmed: false } }, done: false };
}

/** 시나리오 보기: 콘텐츠의 시나리오들 + 자유 시나리오(월드가 열었으면) */
function scenarioOptions(content: Content, unlocked: readonly string[] = []): { id: string; title: string; pitch: string }[] {
  const list = scenarioInfos(content, unlocked).map((r) => ({ ...r, title: r.title }));
  // 직접 만들기가 먼저, 정해진 시나리오는 추천 시작으로 (기획서 12.6)
  if (content.scenario.custom_start) {
    const occ = content.scenario.occupations.map((o) => o.label);
    list.unshift({
      id: CUSTOM_ROLE_ID,
      title: "직접 만들기",
      pitch:
        `어느 무리에서 무슨 일을 하는 사람인지(${occ.length ? `직분: ${occ.join(", ")} 등` : "자리"}), 어떤 지난 일을 안고 있는지 직접 쓴다. ` +
        "잃은 가족, 원수, 진 빚, 도망쳐 나온 무리 같은 지난 일은 이 세계의 역사로 남는다. 한 자리뿐인 지도부는 될 수 없다.",
    });
  }
  return list;
}

/** 한 단계 뒤로 (캐릭터 만들기의 처음에서 뒤로 가면 시나리오(자유 시나리오면 그 확인 → 옮기기 → 글), 그다음 월드) */
export function backNewGame(draft: NewGameDraft): NewGameDraft {
  if (draft.character.answers.length > 0) return { ...draft, character: backCreation(draft.character) };
  if (draft.mode === "heir") return draft;
  if (draft.options !== undefined && draft.contentRating) return { ...draft, options: undefined };
  const c = draft.custom;
  if (draft.roleId === CUSTOM_ROLE_ID && c) {
    if (c.confirmed) return { ...draft, custom: { ...c, confirmed: false }, customRole: null };
    if (c.input) return { ...draft, custom: { ...c, input: null } };
    if (c.story) return { ...draft, custom: { ...c, story: null } };
  }
  if (draft.roleId) return { ...draft, roleId: null, custom: undefined, customRole: null };
  return { ...draft, packId: null };
}

const FOOTER =
  "한 번에 이 단계 하나만 묻는다. 대신 정하지 않는다. 플레이어의 답을 create_character(answer)로 넘긴다 (보기의 값). 되돌리려면 create_character(back: true).";

/** GM에게 줄 이번 단계 안내 */
export function describeNewGameStep(packs: ReadonlyMap<string, Content>, draft: NewGameDraft): string {
  const step = newGameStep(draft);
  if (step === "world") {
    const worlds = [...packs.values()].map(worldInfo);
    return [
      "## 새 게임: 월드 고르기",
      "물을 것: 어느 월드에서 시작할지. 월드마다 이름과 한 줄 소개, 짧은 설명을 보여 주고 고르게 한다 (월드가 하나여도 소개하고 고르게 한다).",
      "",
      ...worlds.map((w) => `### ${w.title}\n${w.tagline}\n${w.description}`),
      "",
      `보기 (클릭으로 고르는 도구가 있으면 그것으로): ${worlds.map((w) => `${w.title} → "${w.id}"`).join(" / ")}`,
      "",
      FOOTER,
    ].join("\n");
  }
  const content = packs.get(draft.packId!)!;
  if (step === "scenario") {
    const world = worldInfo(content);
    const scenarios = scenarioOptions(content, draft.unlocked?.[content.scenario.id] ?? []);
    return [
      `## 새 게임: ${world.title} — 시나리오 고르기`,
      "먼저: 아래 월드 이야기를 바탕으로, 이 세계가 어떻게 무너졌고 지금 어떤 곳인지 GM의 목소리로 들려준다 (서너 문단, 목록 말고 이야기로). 소개에 없는 사실은 만들지 않는다. 그다음 시나리오를 고르게 한다.",
      "",
      content.scenario.introText ?? `${world.tagline}\n${world.description}`,
      "",
      "물을 것: 어떤 사람으로 시작할지. '직접 만들기'를 먼저 소개하고, 나머지는 '추천 시작'으로 묶어 이름과 소개를 보여 준다.",
      "",
      ...scenarios.map((r) => `### ${r.title}\n${r.pitch}`),
      "",
      `보기 (클릭으로 고르는 도구가 있으면 그것으로): ${scenarios.map((r) => `${r.title} → "${r.id}"`).join(" / ")}`,
      "",
      FOOTER,
    ].join("\n");
  }
  if (step === "custom_story") {
    return [
      `## 새 게임: ${worldInfo(content).title} — 직접 쓰는 시나리오`,
      "물을 것: 누구로 시작하는지 플레이어가 직접 쓴다 (서너 문장). 무엇을 쓰면 좋은지 짧게 알려 준다: 어느 무리 사람인지(또는 무리 없이 떠도는지), 무리에서 무슨 일을 하는지(직분), 어떤 자리인지(계급), 몇 살쯤인지, 그리고 지난 일 (잃은 사람, 원수, 살아 있는 가족, 찾는 사람, 진 빚, 도망쳐 나온 무리 등).",
      `고를 수 있는 직분: ${content.scenario.occupations.map((o) => `${o.label} — ${o.summary}`).join(" / ") || "없음"}`,
      "지난 일 중 일부는 이 세계의 역사로 남는다 (원수가 이 도시의 실제 인물이면 그 사람이 정말 그 일을 한 것이 된다). 나머지는 이 사람의 기억으로 남는다.",
      "이 월드에 있는 세력·장소 안에서 정해진다는 것과, 한 자리뿐인 지도부(무리의 우두머리)는 될 수 없다는 것을 함께 알린다. 대신 쓰지 않는다.",
      "",
      `플레이어의 글을 그대로 create_character(answer)로 넘긴다 (${MAX_STORY_LENGTH}자 안). 되돌리려면 create_character(back: true).`,
    ].join("\n");
  }
  if (step === "custom_setup") {
    return [
      `## 새 게임: 직접 쓴 시나리오 옮기기`,
      "플레이어가 쓴 시작:",
      `> ${draft.custom!.story!.replace(/\n/g, "\n> ")}`,
      "",
      "할 일: 이 글을 아래 목록 안에서 옮겨 create_character(custom_start: {...})로 넘긴다. 목록에 없는 세력·장소·물건을 만들지 않는다. 글에 없는 것은 글의 분위기에 가장 맞는 것으로 고르고, 글과 다르게 옮긴 것(지도부를 원했다 등)은 다음 단계에서 플레이어에게 알린다. 숫자(나이·훈련)는 글에 있으면 범위 안에서 그대로, 없으면 무난하게.",
      "",
      describeCustomStartOptions(content),
      "",
      "opening은 시작 장소에서 이야기가 시작되는 순간을 2인칭으로 한두 문장, background는 플레이어가 쓴 지난 삶을 캐릭터의 기억 몇 문장으로 (세계의 사실이 아니라 이 사람의 기억이다).",
    ].join("\n");
  }
  if (step === "content") {
    const age = content.scenario.content_rating?.adult_age ?? 18;
    return [
      "## 새 게임: 수위",
      "물을 것: 이 세계에서 성인 주제를 다룰지. 짧게 설명하고 고르게 한다.",
      `- 켜기: 성인 사이의 끌림과 연애(장면은 암전으로 넘긴다), 성적인 농담·괴롭힘·위협(시도까지만, 행위는 그리지 않는다)이 이야기에 나올 수 있다. ${age}세 미만은 주인공이든 인물이든 어떤 경우에도 그 대상이 되지 않는다. 노골적인 묘사는 하지 않는다.`,
      "- 끄기: 그런 이야기는 나오지 않는다 (기본). 폭력과 죽음, 생존의 잔혹함은 어느 쪽이든 나온다.",
      "게임 중에도 바꿀 수 있다 (플레이어가 말하면 set_content_options).",
      '보기 (클릭으로 고르는 도구가 있으면 그것으로): 끄기 → "off" / 켜기 → "on"',
      "",
      FOOTER,
    ].join("\n");
  }
  if (step === "custom_confirm") {
    const role = buildCustomRole(content, draft.custom!.input!);
    return [
      "## 새 게임: 직접 쓴 시나리오 확인",
      "옮긴 결과 (코드가 정한 상관·아는 사람·임무 포함):",
      describeCustomRole(content, role),
      ...(draft.custom!.input!.history?.length ? [`세계에 남는 지난 일: ${draft.custom!.input!.history.map((p) => describeHistoryPart(content, p)).join(" / ")}`] : []),
      ...(draft.custom!.input!.background.length ? [`지난 삶 (캐릭터의 기억): ${draft.custom!.input!.background.join(" / ")}`] : []),
      "",
      "물을 것: 이대로 갈지. 글과 다르게 옮긴 것이 있으면 이유와 함께 알린다.",
      '보기 (클릭으로 고르는 도구가 있으면 그것으로): 이대로 → "confirm" / 다시 옮기기 → "remap" / 다시 쓰기 → "rewrite"',
      "",
      FOOTER,
    ].join("\n");
  }
  return describeCreationStep(draftContent(packs, draft), draft.character, draft.roleId!);
}

export { currentStep };
