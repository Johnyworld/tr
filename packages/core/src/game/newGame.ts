import { describeHistoryPart, type HistoryPart } from "./background.ts";
import type { Content } from "../content/schemas.ts";
import { worldInfo } from "../content/packs.ts";
import type { Rng } from "../rng.ts";
import {
  answerCreation,
  backCreation,
  ageFloor,
  currentStep,
  describeCreationStep,
  newCreationDraft,
  type CreationDraft,
  type CreationReply,
} from "./creationFlow.ts";
import { CUSTOM_ROLE_ID, type CharacterChoice } from "./state.ts";
import type { DialogueStyle } from "../engine/storyletTools.ts";
import type { RoleContent } from "../content/schemas.ts";
import { buildCustomRole, type CustomStartInput } from "./customStart.ts";
import { buildLonerRole, factionChoices, LONER, lonerAllowed, roleChoices } from "./startChoice.ts";
import { checkGroup, describeGroup, editGroup, groupRules, newGroup, type StartGroup } from "./startGroup.ts";
import { checkRoleStory, checkStoryStart, describeStoryOptions, guardedPeople, MAX_STORY_TEXT, motivesOf, withStory, type StartMotive, type StoryStartInput } from "./storyStart.ts";

/**
 * 새 게임 (기획서 4.2, 12-15, 12-77, 12-84): 월드 고르기 → 소속(무리 또는 떠돌이) → 계급(그 무리·계급의 시나리오), 떠돌이면 동행 → 캐릭터 만들기(creationFlow, 과거 배경부터).
 * 무리에 속하면 그 무리의 준비된 시나리오(roles/*.yaml) 중에서 고른다.
 * 떠돌이는 시나리오도 계급도 직분도 없다. 코드가 역할을 만든다 (startChoice.ts). 스킬은 누구나 과거 배경에서 온다.
 * 떠돌이면 동기를 고르고 이야기를 쓴다 → GM이 옮긴다 → 확인 (2단계). 이야기는 세계의 역사로 남는다.
 * 사망 뒤 새 캐릭터는 같은 월드·시나리오라 바로 캐릭터 만들기부터 (heir).
 * 코드의 scenario 팩 = 플레이어의 "월드", 팩 안의 role = 플레이어의 "시나리오"
 */
export type NewGameDraft = {
  mode: CreationDraft["mode"];
  packId: string | null;
  roleId: string | null;
  /** 떠돌이로 코드가 만든 역할의 고르기 (roleId가 CUSTOM_ROLE_ID, 12-77). 콘텐츠 시나리오면 없다 */
  built?: CustomStartInput | null;
  /** 고른 무리 (null이면 떠돌이, undefined면 아직, 12-77) */
  faction?: string | null;
  /**
   * 동기와 이야기 (12-77 2단계, 떠돌이만): motive null이면 이야기 없이 시작.
   * text: 플레이어의 글, mapped: GM이 옮긴 것, confirmed: 확인했다
   */
  story?: {
    motive: string | null;
    text: string | null;
    mapped: StoryStartInput | null;
    confirmed: boolean;
    /** 확인 전의 역할 (뒤로 가면 되돌린다) */
    baseRole?: RoleContent | null;
    /** 다시 쓰기 전의 글 (이어 고쳐 쓰게) */
    previous?: string | null;
    /** 묻지 않고 건너뛰었다 (월드에 동기가 없다) */
    auto?: boolean;
  };
  /** 떠돌이의 동행: pet(반려견) / alone (12-77) */
  companion?: "pet" | "group" | "alone";
  /** 떠돌이의 소규모 무리 (companion이 group일 때, 12-77 3단계). confirmed면 다 고쳤다 */
  group?: StartGroup;
  /** 코드가 만든 역할 (사망 뒤 새 캐릭터면 세이브에 든 것) */
  customRole?: RoleContent | null;
  character: CreationDraft;
  /** 이 세계의 수위 (12-57). 새 세계면 캐릭터 만들기 전에 묻는다 (월드가 content_rating을 열었을 때) */
  options?: { mature?: boolean; dialogue?: DialogueStyle } | null;
  /** 고른 월드가 수위 설정을 여는지 */
  contentRating?: boolean;
  /** 월드별로 열린 해금 (모든 판에 남는 것, 기획서 9.12). 해금이 필요한 시나리오를 보여 줄지 정한다 */
  unlocked?: Record<string, string[]>;
};

export type NewGameStep = "world" | "faction" | "companion" | "group" | "role" | "motive" | "story" | "story_setup" | "story_confirm" | "content" | "dialogue" | "character";

export function newGameDraft(unlocked: Record<string, string[]> = {}): NewGameDraft {
  return { mode: "new_world", packId: null, roleId: null, character: newCreationDraft("new_world"), unlocked };
}

/**
 * 사망 뒤 같은 세계의 새 캐릭터: 월드·시나리오는 정해져 있다 (자유 시나리오였으면 그 역할 그대로).
 * askStory: 동기와 이야기를 묻는다 (월드에 동기가 있을 때, 12-86)
 */
export function heirDraft(packId: string, roleId: string, customRole: RoleContent | null = null, askStory = false, minAge?: number): NewGameDraft {
  return { mode: "heir", packId, roleId, customRole, character: { ...newCreationDraft("heir"), minAge }, ...(askStory ? {} : { story: { ...AUTO_SKIPPED_STORY } }) };
}

/** 지금 상황(새 캐릭터면 다른 사람의 삶)을 동기 단계에서 이미 들려줬는지: 준비된 시나리오·새 캐릭터에서 동기를 물었을 때 */
export function introShownBefore(draft: NewGameDraft): boolean {
  return !draft.built && !!draft.story && !draft.story.auto;
}

/** 준비된 시나리오를 골랐다: 동기와 이야기를 물을지 (월드에 동기가 없으면 건너뛴다, 12-86) */
function pickRole(content: Content, draft: NewGameDraft, roleId: string): NewGameDraft {
  const minAge = content.scenario.creation?.rank_min_age[content.roles[roleId]?.rank ?? ""];
  return {
    ...draft,
    roleId,
    story: motivesOf(content).length ? undefined : { ...AUTO_SKIPPED_STORY },
    character: { ...draft.character, minAge },
  };
}

export function newGameStep(draft: NewGameDraft): NewGameStep {
  if (!draft.packId) return "world";
  if (!draft.roleId) {
    if (draft.faction === undefined) return "faction";
    if (draft.faction === null && draft.companion === undefined) return "companion";
    if (draft.faction === null && draft.companion === "group" && !draft.group?.confirmed) return "group";
    return "role";
  }
  // 동기와 이야기 (12-77, 12-86): 떠돌이, 준비된 시나리오, 사망 뒤 새 캐릭터 모두. 건너뛸 수 있다
  {
    const st = draft.story;
    if (!st) return "motive";
    if (!st.confirmed) {
      if (!st.text) return "story";
      if (!st.mapped) return "story_setup";
      return "story_confirm";
    }
  }
  if (draft.mode === "new_world" && draft.options?.mature === undefined && draft.contentRating) return "content";
  // 서술 방식 (12-85): 소설식 / 대본식. 수위 다음에 묻는다
  if (draft.mode === "new_world" && draft.options?.dialogue === undefined) return "dialogue";
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
      options: { mature: boolean; dialogue: DialogueStyle };
      /** 코드가 만든 역할이면 그 역할과 이야기: 캐릭터의 지난 삶 기억, 세계에 남는 배경 부품, 동기 */
      custom: { role: RoleContent; background: string[]; history: HistoryPart[]; motive: StartMotive | null } | null;
      /** 동기와 이야기 (12-86): 캐릭터의 기억, 세계에 남는 배경 부품, 동기. 준비된 시나리오·새 캐릭터도 */
      story: { background: string[]; history: HistoryPart[]; motive: StartMotive | null };
    }
  | { ok: false; error: string };

const norm = (x: string) => x.trim().toLowerCase();
const SKIPPED_STORY = { motive: null, text: null, mapped: null, confirmed: true } as const satisfies NonNullable<NewGameDraft["story"]>;
/** 묻지 않고 건너뛴 이야기 (월드에 동기가 없을 때). 뒤로 가도 이야기 단계로 돌아가지 않는다 */
const AUTO_SKIPPED_STORY = { ...SKIPPED_STORY, auto: true } as const;
const SKIP_WORDS = ["skip", "건너뛰기", "이야기 없이", "없음", "none"];

/** 떠돌이의 동행 고르기 (소규모 무리면 코드가 무리를 만든다) */
function pickCompanion(content: Content, draft: NewGameDraft, answer: string, rng: Rng): { ok: true; draft: NewGameDraft } | { ok: false; error: string } {
  const v = norm(answer);
  if (["pet", "반려견", "개", "반려견과 함께"].includes(v)) return { ok: true, draft: { ...draft, companion: "pet", group: undefined } };
  if (["alone", "혼자"].includes(v)) return { ok: true, draft: { ...draft, companion: "alone", group: undefined } };
  if (groupRules(content) && ["group", "소규모 무리", "무리"].includes(v)) {
    // 이미 고치던 무리가 있으면 그대로 둔다
    const group = draft.companion === "group" && draft.group ? { ...draft.group, confirmed: false } : newGroup(content, rng);
    return { ok: true, draft: { ...draft, companion: "group", group } };
  }
  return { ok: false, error: `반려견과 함께(pet)${groupRules(content) ? ", 소규모 무리(group)" : ""}, 혼자(alone) 중에서 고른다.` };
}

/** 떠돌이가 동행(·무리)을 다 골랐으면 역할을 만든다 (떠돌이는 시나리오 단계가 없다) */
function settleLoner(content: Content, draft: NewGameDraft): NewGameReply {
  if (draft.faction !== null || draft.roleId || newGameStep(draft) !== "role") return { ok: true, draft, done: false };
  const r = buildLonerRole(content, {
    pet: draft.companion === "pet",
    group: draft.companion === "group" ? (draft.group ?? null) : null,
  });
  if (!r.ok) return r;
  return {
    ok: true,
    draft: {
      ...draft,
      roleId: CUSTOM_ROLE_ID,
      customRole: r.role,
      built: r.input,
      // 동기가 없는 월드는 이야기 없이
      story: motivesOf(content).length ? undefined : { ...AUTO_SKIPPED_STORY },
    },
    done: false,
  };
}

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
  const unlocked = draft.unlocked?.[content.scenario.id] ?? [];
  if (step === "faction") {
    const v = norm(text);
    if ([LONER, "떠돌이", "무소속"].includes(v)) {
      if (!lonerAllowed(content)) return { ok: false, error: "이 월드에서는 떠돌이로 시작할 수 없다." };
      return { ok: true, draft: { ...draft, faction: null }, done: false };
    }
    const f = factionChoices(content, unlocked).find((x) => norm(x.id) === v || norm(x.name) === v);
    if (f) return { ok: true, draft: { ...draft, faction: f.id }, done: false };
    // 콘텐츠 시나리오 이름·id를 바로 대도 된다 (무리와 역할을 함께 고른다)
    const preset = Object.values(content.roles).find((r) => (!r.unlock || unlocked.includes(r.unlock)) && (norm(r.id) === v || norm(r.scenario?.title ?? r.label) === v));
    if (preset) return { ok: true, draft: pickRole(content, { ...draft, faction: preset.faction || null }, preset.id), done: false };
    const names = [...factionChoices(content, unlocked).map((x) => x.name), ...(lonerAllowed(content) ? ["떠돌이"] : [])];
    return { ok: false, error: `무리는 ${names.join(", ")} 중 하나다.` };
  }
  if (step === "companion") {
    const picked = pickCompanion(content, draft, text, rng);
    if (!picked.ok) return picked;
    return settleLoner(content, picked.draft);
  }
  if (step === "group") {
    const v = norm(text);
    const group = draft.group!;
    // 사실 난 혼자였다
    if (["alone", "혼자", "사실 난 혼자였다"].includes(v)) return settleLoner(content, { ...draft, companion: "alone", group: undefined });
    if (["done", "이대로", "확인"].includes(v)) {
      if (group.members.length === 0) return { ok: false, error: "무리에 아무도 없다. 사람을 더하거나, 혼자였다면 alone." };
      const problems = checkGroup(content, group);
      if (problems.length) return { ok: false, error: problems.map((p) => (p.at >= 0 ? `${p.at + 1}번: ${p.problem}` : p.problem)).join(" ") };
      // 주인공의 나이·성별은 여기서 정했으니 캐릭터 만들기에서 묻지 않는다
      return settleLoner(content, {
        ...draft,
        group: { ...group, confirmed: true },
        character: { ...draft.character, presetAge: group.me.age, presetGender: group.me.gender },
      });
    }
    const r = editGroup(content, group, text, rng);
    if (!r.ok) return r;
    return { ok: true, draft: { ...draft, group: r.group }, done: false };
  }
  if (step === "role") {
    const presets = roleChoices(content, draft.faction!, unlocked);
    const v = norm(text);
    // 계급(id나 이 무리에서 부르는 이름)으로 고른다. 시나리오 이름·id도 된다
    const preset = presets.find((p) => [p.rank, p.rankLabel, p.roleId, p.title].some((x) => norm(x) === v));
    if (!preset) return { ok: false, error: `계급은 ${presets.map((p) => `${p.rankLabel}(${p.rank})`).join(", ")} 중 하나다.` };
    return { ok: true, draft: pickRole(content, draft, preset.roleId), done: false };
  }
  if (step === "motive" || step === "story") {
    // [동기, 이야기]를 한 번에 줘도 된다 (상태 화면은 한 화면에서 고르고 쓴다)
    const pair = Array.isArray(answer) && answer.length === 2 ? answer : null;
    const motiveText = pair ? pair[0]! : step === "motive" ? text : null;
    const storyText = pair ? pair[1]! : step === "story" ? text : null;
    if (SKIP_WORDS.includes(norm(motiveText ?? storyText ?? ""))) return { ok: true, draft: { ...draft, story: { ...SKIPPED_STORY } }, done: false };
    let motive = draft.story?.motive ?? null;
    if (motiveText !== null) {
      const m = motivesOf(content).find((x) => norm(x.id) === norm(motiveText) || norm(x.label) === norm(motiveText));
      if (!m) return { ok: false, error: `동기는 ${motivesOf(content).map((x) => x.label).join(", ")} 중 하나다 (이야기 없이 시작하려면 skip).` };
      motive = m.id;
    }
    const prev = draft.story?.previous ?? null;
    if (storyText === null) return { ok: true, draft: { ...draft, story: { motive, text: null, mapped: null, confirmed: false, previous: prev } }, done: false };
    const story = storyText.trim();
    if (!story || story.length > MAX_STORY_TEXT) return { ok: false, error: `이야기는 1~${MAX_STORY_TEXT}자로 쓴다.` };
    return { ok: true, draft: { ...draft, story: { motive, text: story, mapped: null, confirmed: false, previous: prev } }, done: false };
  }
  if (step === "story_setup") {
    return { ok: false, error: "이 단계는 플레이어의 이야기를 옮겨 create_character(story_start: {...})로 넘긴다." };
  }
  if (step === "story_confirm") {
    const v = norm(text);
    if (["confirm", "이대로", "좋아"].includes(v)) {
      // 떠돌이(코드가 만든 역할)면 첫 장면을 역할에 얹는다. 준비된 시나리오는 그 첫 장면 그대로
      if (!draft.built) return { ok: true, draft: { ...draft, story: { ...draft.story!, confirmed: true } }, done: false };
      const role = buildCustomRole(content, withStory(draft.built, draft.story!.mapped));
      return { ok: true, draft: { ...draft, story: { ...draft.story!, confirmed: true, baseRole: draft.customRole ?? null }, customRole: role }, done: false };
    }
    if (["remap", "다시 옮기기"].includes(v)) return { ok: true, draft: { ...draft, story: { ...draft.story!, mapped: null } }, done: false };
    if (["rewrite", "다시 쓰기"].includes(v)) return { ok: true, draft: { ...draft, story: { ...draft.story!, text: null, mapped: null, previous: draft.story!.text } }, done: false };
    return { ok: false, error: "이대로(confirm), 다시 옮기기(remap), 다시 쓰기(rewrite) 중에서 고른다." };
  }
  if (step === "content") {
    const v = norm(text);
    if (["on", "켜기", "켠다", "예", "네"].includes(v)) return { ok: true, draft: { ...draft, options: { ...draft.options, mature: true } }, done: false };
    if (["off", "끄기", "끈다", "아니오", "아니요"].includes(v)) return { ok: true, draft: { ...draft, options: { ...draft.options, mature: false } }, done: false };
    return { ok: false, error: "켜기(on) 또는 끄기(off) 중에서 고른다." };
  }
  if (step === "dialogue") {
    const v = norm(text);
    if (["novel", "소설", "소설식"].includes(v)) return { ok: true, draft: { ...draft, options: { ...draft.options, dialogue: "novel" } }, done: false };
    if (["script", "대본", "대본식"].includes(v)) return { ok: true, draft: { ...draft, options: { ...draft.options, dialogue: "script" } }, done: false };
    return { ok: false, error: "소설식(novel) 또는 대본식(script) 중에서 고른다." };
  }
  // 나이를 "기본"으로 답하면 시나리오(역할)의 나이 (계급·과거 배경의 최소 나이보다 어리면 그 나이)
  const role = draftContent(packs, draft).roles[draft.roleId!];
  const ageDefault = currentStep(content.scenario, draft.character) === "age" && role && ["기본", "default", "상관없음", "아무거나"].includes(norm(text));
  const r: CreationReply = answerCreation(content.scenario, draft.character, ageDefault ? String(Math.max(role.age, ageFloor(content.scenario, draft.character))) : answer, rng);
  if (!r.ok) return r;
  const next = { ...draft, character: r.draft };
  if (!r.done) return { ok: true, draft: next, done: false };
  // 동기와 이야기: 기억·배경 부품·동기 (떠돌이·준비된 시나리오·새 캐릭터 모두, 12-86)
  const m = draft.story?.motive ? motivesOf(content).find((x) => x.id === draft.story!.motive) : undefined;
  const mapped = draft.story?.confirmed ? draft.story.mapped : null;
  const story = {
    background: mapped?.background ?? [],
    history: mapped?.history ?? [],
    motive: m ? { id: m.id, label: m.label, summary: m.summary } : null,
  };
  const custom = draft.mode === "new_world" && draft.customRole ? { role: draft.customRole, ...story } : null;
  return { ok: true, draft: next, done: true, packId: draft.packId!, roleId: draft.roleId!, choice: r.choice, custom, story, options: { mature: draft.options?.mature ?? false, dialogue: draft.options?.dialogue ?? "novel" } };
}

/** 동기와 이야기: GM이 플레이어의 이야기를 옮긴 것. 코드가 검증한다 */
export function setStoryStart(packs: ReadonlyMap<string, Content>, draft: NewGameDraft, input: StoryStartInput): NewGameReply {
  if (newGameStep(draft) !== "story_setup") return { ok: false, error: "지금은 이야기를 옮기는 단계가 아니다." };
  const content = draftContent(packs, draft);
  const problems = draft.built ? checkStoryStart(content, draft.built, input) : checkRoleStory(content, content.roles[draft.roleId!]!, input);
  if (problems.length) return { ok: false, error: problems.join(" ") };
  return { ok: true, draft: { ...draft, story: { ...draft.story!, mapped: input } }, done: false };
}

/** 한 단계 뒤로 (캐릭터 만들기의 처음에서 뒤로 가면 시나리오(자유 시나리오면 그 확인 → 옮기기 → 글), 그다음 월드) */
export function backNewGame(draft: NewGameDraft): NewGameDraft {
  if (draft.character.answers.length > 0) return { ...draft, character: backCreation(draft.character) };
  if (draft.mode === "new_world" && draft.options?.dialogue !== undefined) return { ...draft, options: { ...draft.options, dialogue: undefined } };
  if (draft.mode === "new_world" && draft.options?.mature !== undefined && draft.contentRating) return { ...draft, options: { ...draft.options, mature: undefined } };
  const st = draft.story;
  if (draft.roleId && st && !st.auto) {
    if (st.confirmed && st.mapped) return { ...draft, story: { ...st, confirmed: false, baseRole: null }, ...(draft.built ? { customRole: st.baseRole ?? draft.customRole } : {}) };
    if (st.mapped) return { ...draft, story: { ...st, mapped: null } };
    if (st.text) return { ...draft, story: { ...st, text: null } };
    if (st.motive !== null || st.confirmed) return { ...draft, story: undefined };
  }
  if (draft.mode === "heir") return draft;
  if (draft.roleId) {
    // 시나리오 단계로. 떠돌이는 시나리오 단계가 없으니 그 앞(무리 고치기, 동행)까지 한 번 더
    const cleared = { ...draft, roleId: null, built: undefined, customRole: null, story: undefined, character: { ...draft.character, minAge: undefined } };
    return draft.faction === null && draft.companion !== undefined ? backNewGame(cleared) : cleared;
  }
  if (draft.faction === null && draft.companion === "group" && draft.group?.confirmed) {
    return { ...draft, group: { ...draft.group, confirmed: false }, character: { ...draft.character, presetAge: undefined, presetGender: undefined } };
  }
  // 무리 고치기 → 동행
  if (draft.faction === null && draft.companion !== undefined) return { ...draft, companion: undefined, group: undefined };
  if (draft.faction !== undefined) return { ...draft, faction: undefined, companion: undefined, group: undefined };
  return { ...draft, packId: null };
}

/** 어느 월드든 같은 이 게임의 규칙 (월드 팩이 아니라 core가 말한다). 월드 고르기에서 월드 소개 뒤에 한 번 들려준다 */
export const GAME_PREMISE =
  "판정은 냉정하고 죽음은 갑작스럽다. 하지만 한 사람이 죽어도 이야기는 끝나지 않는다. 같은 세계에서 다음 사람이 그 뒤를 잇는다.";

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
      `어느 월드든 같은 이 게임의 규칙 (월드 소개에 섞지 말고, 월드 목록 뒤에 따로 한 번 전한다): ${GAME_PREMISE}`,
      "",
      `보기 (클릭으로 고르는 도구가 있으면 그것으로): ${worlds.map((w) => `${w.title} → "${w.id}"`).join(" / ")}`,
      "",
      FOOTER,
    ].join("\n");
  }
  const content = packs.get(draft.packId!)!;
  const unlockedHere = draft.unlocked?.[content.scenario.id] ?? [];
  if (step === "faction") {
    const world = worldInfo(content);
    const factions = factionChoices(content, unlockedHere);
    return [
      `## 새 게임: ${world.title} — 어느 무리에 속해 있나요?`,
      "먼저: 아래 월드 이야기를 바탕으로, 이 세계가 어떻게 무너졌고 지금 어떤 곳인지 GM의 목소리로 들려준다 (서너 문단, 목록 말고 이야기로). 소개에 없는 사실은 만들지 않는다. 그다음 무리를 고르게 한다.",
      "",
      content.scenario.introText ?? `${world.tagline}\n${world.description}`,
      "",
      "물을 것: 당신은 어느 무리에 속해 있는지. 무리마다 이름과 소개를 보여 주고, 떠돌이(무리 없이 담 밖에서)도 고를 수 있다고 알린다.",
      "",
      ...factions.map((f) => `- ${f.name}: ${f.about}`),
      ...(lonerAllowed(content) ? ["- 떠돌이: 어느 무리에도 속하지 않고 담 밖에서 버텨 온 사람"] : []),
      "",
      `보기 (클릭으로 고르는 도구가 있으면 그것으로): ${[...factions.map((f) => `${f.name} → "${f.id}"`), ...(lonerAllowed(content) ? [`떠돌이 → "${LONER}"`] : [])].join(" / ")}`,
      "",
      FOOTER,
    ].join("\n");
  }
  if (step === "companion")
    return [
      "## 새 게임: 당신은 누구와 함께 다니고 있나요?",
      `물을 것: 떠돌이로 누구와 다니는지. 반려견과 함께${groupRules(content) ? ", 가족·길동무와 함께 다니는 소규모 무리" : ""}, 또는 혼자. 떠돌이는 무리가 없어 계급도 직분도 없다. 붕괴 전에 무엇을 했는지(과거 배경)는 캐릭터를 만들 때 고른다.`,
      `보기 (클릭으로 고르는 도구가 있으면 그것으로): 반려견과 함께 → "pet"${groupRules(content) ? ' / 소규모 무리 → "group"' : ""} / 혼자 → "alone"`,
      "",
      FOOTER,
    ].join("\n");
  if (step === "group") {
    const rules = groupRules(content)!;
    const group = draft.group!;
    const problems = checkGroup(content, group);
    const genders = content.scenario.creation?.genders ?? [];
    return [
      "## 새 게임: 함께 다니는 사람들",
      `코드가 ${rules.start}명을 무작위로 만들었다. 지금 무리를 그대로 보여 주고, 고칠 것이 있는지 묻는다 (관계·이름·나이·성별, 더하기·빼기, ${rules.max}명까지). 능력과 소지품은 세계를 만들 때 정해진다.`,
      "관계는 주인공 기준이라 주인공의 나이·성별도 여기서 정한다 (캐릭터 만들기에서 다시 묻지 않는다).",
      "",
      ...describeGroup(content, group),
      ...(problems.length ? ["", `맞지 않는 것: ${problems.map((p) => (p.at >= 0 ? `${p.at + 1}번 ${p.problem}` : p.problem)).join(" / ")}`] : []),
      "",
      `규칙: 부모·자식은 주인공과 ${rules.parent_gap}살 이상 차이, 배우자는 주인공과 다른 성별${rules.relations.filter((r) => r.max).map((r) => `, ${r.label} ${r.max}명까지`).join("")}.`,
      `관계: ${rules.relations.map((r) => `${r.label}(${r.id}, ${r.age[0]}~${r.age[1]}세)`).join(", ")}. 성별: ${genders.map((g) => `${g.label}(${g.id})`).join(", ")}`,
      "플레이어의 말을 이렇게 옮겨 create_character(answer)로 넘긴다 (한 번에 하나): 더하기 → \"add\" / 빼기 → \"remove 번호\" / 고치기 → \"edit 번호 관계=child 이름=김민지 나이=10 성별=female\" (바꿀 것만) / 주인공 → \"me 나이=34 성별=male\" / 다 됐으면 → \"done\" / 모두 빼고 혼자였다면 → \"alone\"",
      "",
      FOOTER,
    ].join("\n");
  }
  if (step === "role") {
    const presets = roleChoices(content, draft.faction!, unlockedHere);
    const factionName = content.factions[draft.faction!]?.name ?? draft.faction!;
    return [
      `## 새 게임: ${factionName} — 어떤 계급으로 시작하나요?`,
      "물을 것: 이 무리에서의 계급. 계급마다 그 자리의 시나리오(이름과 소개)를 보여 주고 고르게 한다. 첫 장면과 이야기, 함께 지내는 사람들이 계급마다 정해져 있다. 간부가 아니면 무리의 바깥 일을 맡는 대(이 무리에서 부르는 이름)에 속한다. 계급마다 그 자리에 필요한 솜씨 하나(계급 기본 훈련)를 받고, 나머지 스킬은 다음에 고르는 과거 배경에서 온다.",
      "",
      ...presets.map((p) => `### ${p.rankLabel}: ${p.title}\n${p.pitch}${p.gains ? `\n받는 것 (계급 기본 훈련과 물건): ${p.gains}` : ""}`),
      "",
      `보기 (클릭으로 고르는 도구가 있으면 그것으로): ${presets.map((p) => `${p.rankLabel} → "${p.rank}"`).join(" / ")}`,
      "",
      FOOTER,
    ].join("\n");
  }
  if (step === "motive" || step === "story" || step === "story_setup" || step === "story_confirm") {
    const motives = motivesOf(content);
    const st = draft.story;
    const motive = motives.find((m) => m.id === st?.motive);
    // 떠돌이(코드가 만든 역할)면 첫 장면도 옮기고, 준비된 시나리오·새 캐릭터면 시나리오의 것을 그대로 쓴다 (12-86)
    const loner = !!draft.built;
    const role = draftContent(packs, draft).roles[draft.roleId!]!;
    const title = draft.built?.title ?? role.scenario?.title ?? role.label;
    const heading = draft.mode === "heir" ? "새 캐릭터" : "새 게임";
    if (step === "motive") {
      // 준비된 시나리오·새 캐릭터: 지금 상황(다른 사람의 삶)을 여기서 먼저 들려준다. 캐릭터 만들기에서는 되풀이하지 않는다
      const intro = loner
        ? []
        : draft.mode === "heir"
          ? [
              "## 먼저: 다른 사람의 삶",
              "같은 세계에서 다른 사람으로 이어 간다. 이전 주인공의 죽음 뒤, 같은 무리의 막사에서 누군가가 눈을 뜬다는 느낌으로 짧게 운을 띄운다. 새 캐릭터는 이전 캐릭터가 알던 것을 모른다. 그다음 아래를 묻는다.",
              "",
            ]
          : [
              "## 먼저: 지금 상황",
              "월드 이야기는 이미 들려줬다. 아래를 바탕으로 주인공이 지금 어디에 어떤 처지로 있는지 GM의 목소리로 들려준다 (두세 문단, 목록 말고 이야기로). 소개에 없는 사실은 만들지 않는다. 그다음 아래를 묻는다.",
              "",
              role.scenario?.intro ?? role.opening_scene,
              "",
            ];
      return [
        ...intro,
        `## ${heading}: ${title} — 무엇이 당신을 움직이나요?`,
        `물을 것: 이 사람을 살게 하는 동기. 동기마다 이름과 한 줄을 보여 주고 고르게 한다. 다음 단계에서 그 이야기를 자세히 쓴다 (쓴 이야기 중 일부는 이 세계의 역사로 남는다).${loner ? "" : " 건너뛰어도 된다: 준비된 시나리오라 이야기 없이도 시작할 수 있다고 알린다."}`,
        "",
        ...motives.map((m) => `- ${m.label}: ${m.summary}`),
        "",
        `보기 (클릭으로 고르는 도구가 있으면 그것으로): ${[...motives.map((m) => `${m.label} → "${m.id}"`), '이야기 없이 시작 → "skip"'].join(" / ")}`,
        "",
        FOOTER,
      ].join("\n");
    }
    if (step === "story") {
      return [
        `## ${heading}: ${motive?.label ?? "이야기"} — 당신의 이야기`,
        `물을 것: ${motive?.prompt ?? "지난 이야기를 써 주세요."} (서너 문장)`,
        "이 월드에 있는 무리·장소·사람 안에서 정해진다는 것과, 원수나 잃은 사람이 이 도시의 실제 인물이면 그 일이 이 세계의 사실이 된다는 것을 짧게 알린다. 대신 쓰지 않는다.",
        ...(loner ? [] : [`준비된 시나리오의 이야기 위에 얹는다: 지금 상황(시나리오 소개)과 어긋나지 않게 쓰도록 알린다. 시나리오 소개: ${role.scenario?.intro ?? role.opening_scene}`]),
        "",
        `플레이어의 글을 그대로 create_character(answer)로 넘긴다 (${MAX_STORY_TEXT}자 안). 되돌리려면 create_character(back: true).`,
      ].join("\n");
    }
    if (step === "story_setup") {
      const location = draft.built?.location ?? role.start_location ?? "";
      const place = content.locations[location]?.name ?? location;
      const guarded = [...guardedPeople(content, role)].map((id) => content.npcs[id]?.name ?? id);
      return [
        `## ${heading}: 이야기 옮기기`,
        `역할 (정해져 있다, 바꾸지 않는다): ${title}, ${place}에서 시작.`,
        `동기: ${motive?.label ?? "-"} — ${motive?.summary ?? ""}`,
        "플레이어가 쓴 이야기:",
        `> ${st!.text!.replace(/\n/g, "\n> ")}`,
        "",
        loner
          ? `할 일: 이 글을 첫 장면(opening)·기억(background)·배경 부품(history)으로 옮겨 create_character(story_start: {...})로 넘긴다.${motive?.parts.length ? ` 이 동기에서 자주 나오는 부품: ${motive.parts.join(", ")} (글에 있을 때만).` : ""} 목록에 없는 인물·무리·장소를 만들지 않는다. 글과 다르게 옮긴 것은 다음 단계에서 플레이어에게 알린다.`
          : `할 일: 이 글을 기억(background)·배경 부품(history)으로 옮겨 create_character(story_start: {...})로 넘긴다. 첫 장면(opening)은 넣지 않는다 (시나리오의 첫 장면을 그대로 쓰고, 첫 서술에 동기가 묻어나게 한다).${motive?.parts.length ? ` 이 동기에서 자주 나오는 부품: ${motive.parts.join(", ")} (글에 있을 때만).` : ""} 목록에 없는 인물·무리·장소를 만들지 않는다.`,
        ...(loner
          ? []
          : [
              `시나리오 소개와 어긋나는 것(이 무리에 있었던 기간, 상관, 지금 있는 곳 등)은 옮기지 않는다. ${guarded.length ? `이 시나리오의 상관·분대원·지도부(${guarded.join(", ")})는 원수(enemy)나 가족을 죽인 자(loss.by)로 둘 수 없다.` : ""} 글과 다르게 옮긴 것은 다음 단계에서 이유와 함께 알린다.`,
              `시나리오 소개: ${role.scenario?.intro ?? role.opening_scene}`,
            ]),
        "",
        describeStoryOptions(content),
        "",
        `${loner ? `opening은 ${place}에서 이야기가 시작되는 순간을 2인칭으로 한두 문장 (동기가 느껴지게), ` : ""}background는 플레이어가 쓴 지난 삶을 캐릭터의 기억 몇 문장으로 (세계의 사실이 아니라 이 사람의 기억이다).`,
      ].join("\n");
    }
    const mapped = st!.mapped!;
    return [
      `## ${heading}: 이야기 확인`,
      `동기: ${motive?.label ?? "-"}`,
      ...(mapped.opening ? [`첫 장면: ${mapped.opening}`] : []),
      ...(mapped.history.length ? [`세계에 남는 지난 일: ${mapped.history.map((p) => describeHistoryPart(content, p)).join(" / ")}`] : []),
      ...(mapped.background.length ? [`지난 삶 (캐릭터의 기억): ${mapped.background.join(" / ")}`] : []),
      "",
      "물을 것: 이대로 갈지. 글과 다르게 옮긴 것이 있으면 이유와 함께 알린다.",
      '보기 (클릭으로 고르는 도구가 있으면 그것으로): 이대로 → "confirm" / 다시 옮기기 → "remap" / 다시 쓰기 → "rewrite"',
      "",
      FOOTER,
    ].join("\n");
  }
  if (step === "content") {
    const age = content.scenario.content_rating?.adult_age ?? 18;
    return [
      "## 새 게임: 수위",
      "물을 것: 이 세계에서 성인 주제를 다룰지. 짧게 설명하고 고르게 한다.",
      `- 켜기: 성인 사이의 끌림과 연애(장면은 암전으로 넘긴다), 성적인 농담·괴롭힘·위협(시도까지만, 행위는 그리지 않는다)이 이야기에 나올 수 있다. ${age}세 미만은 주인공이든 인물이든 어떤 경우에도 그 대상이 되지 않는다. 노골적인 묘사는 하지 않는다.`,
      "- 끄기: 그런 이야기는 나오지 않는다 (기본). 폭력과 죽음, 생존의 잔혹함은 어느 쪽이든 나온다.",
      "게임 중에도 바꿀 수 있다 (상태 화면의 설정, 또는 플레이어가 말하면 set_content_options).",
      '보기 (클릭으로 고르는 도구가 있으면 그것으로): 끄기 → "off" / 켜기 → "on"',
      "",
      FOOTER,
    ].join("\n");
  }
  if (step === "dialogue") {
    return [
      "## 새 게임: 서술 방식",
      "물을 것: 이야기를 소설식으로 들을지 대본식으로 들을지. 짧게 설명하고 고르게 한다.",
      '- 소설식: 대사가 서술 속에 녹아 있다 (예: 강태호가 담배를 비벼 끄며 "오늘은 동쪽이다"라고 말했다.)',
      '- 대본식: 대사를 "이름: 대사" 줄로 따로 뗀다 (예: 강태호: "오늘은 동쪽이다.")',
      "게임 중에도 바꿀 수 있다 (상태 화면의 설정, 또는 플레이어가 말하면 set_content_options의 dialogue).",
      '보기 (클릭으로 고르는 도구가 있으면 그것으로): 소설식 → "novel" / 대본식 → "script"',
      "",
      FOOTER,
    ].join("\n");
  }
  return describeCreationStep(draftContent(packs, draft), draft.character, draft.roleId!, introShownBefore(draft));
}

export { currentStep };
