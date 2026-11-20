import { josa } from "../text.ts";
import type { Content, RoleContent } from "../content/schemas.ts";
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
import type { CharacterChoice } from "./state.ts";
import type { DialogueStyle } from "../engine/storyletTools.ts";
import { scenarioChoices, scenarioOpen } from "./startChoice.ts";

/**
 * 새 게임 (기획서 4.2): 월드 → 시나리오 → 캐릭터 만들기(creationFlow, 과거 배경부터) → 수위 → 서술 방식 → 시작.
 * 시나리오는 월드에 준비된 것(roles/*.yaml 중 목록에 있는 것)에서만 고른다. 플레이어가 직접 쓰는 단계는 없다 (시작의 허들을 낮춘다).
 * 잠긴 시나리오는 보이지만 고를 수 없다 (해금 조건은 카드에 쓰여 있다).
 * 사망 뒤 새 캐릭터는 같은 월드·시나리오라 바로 캐릭터 만들기부터 (heir).
 * 코드의 scenario 팩 = 플레이어의 "월드", 팩 안의 role = 플레이어의 "시나리오"
 */
export type NewGameDraft = {
  mode: CreationDraft["mode"];
  packId: string | null;
  roleId: string | null;
  /** 코드가 만든 역할 (사망 뒤 새 캐릭터의 자리가 콘텐츠에 없을 때) */
  customRole?: RoleContent | null;
  /** 사망 뒤 새 캐릭터: 고른 후보 id (new:<세력>:<계급>). 다 만들면 이것으로 이어 간다 */
  heirOption?: string;
  character: CreationDraft;
  /** 다 만든 캐릭터 (새 게임이면 그 뒤에 수위·서술 방식을 묻는다) */
  choice?: CharacterChoice;
  /** 이 세계의 수위 (12-57)와 서술 방식 (12-85). 캐릭터를 다 만든 뒤에 묻는다 */
  options?: { mature?: boolean; dialogue?: DialogueStyle } | null;
  /** 고른 월드가 수위 설정을 여는지 */
  contentRating?: boolean;
  /** 월드별로 열린 해금 (모든 판에 남는 것, 기획서 9.12). 잠긴 시나리오를 가린다 */
  unlocked?: Record<string, string[]>;
};

export type NewGameStep = "world" | "scenario" | "character" | "content" | "dialogue";

export function newGameDraft(unlocked: Record<string, string[]> = {}): NewGameDraft {
  return { mode: "new_world", packId: null, roleId: null, character: newCreationDraft("new_world"), unlocked };
}

/** 사망 뒤 같은 세계의 새 캐릭터 (기획서 12.4.1): 고른 무리·계급의 자리(역할)는 정해져 있고 캐릭터 만들기부터 */
export function heirDraft(packId: string, option: string, role: RoleContent, custom: boolean, minAge?: number): NewGameDraft {
  return { mode: "heir", packId, roleId: role.id, customRole: custom ? role : null, heirOption: option, character: { ...newCreationDraft("heir"), minAge, seat: { rank: role.rank, occupation: role.occupation ?? null } } };
}

/** 시나리오를 골랐다: 계급의 최소 나이를 캐릭터 만들기에 건다 */
function pickRole(content: Content, draft: NewGameDraft, roleId: string): NewGameDraft {
  const role = content.roles[roleId];
  const minAge = content.scenario.creation?.rank_min_age[role?.rank ?? ""];
  // 자리가 주는 전문 기술 (4.2.1)
  const seat = role ? { rank: role.rank, occupation: role.occupation ?? null } : undefined;
  return { ...draft, roleId, character: { ...draft.character, minAge, seat } };
}

export function newGameStep(draft: NewGameDraft): NewGameStep {
  if (!draft.packId) return "world";
  if (!draft.roleId) return "scenario";
  if (!draft.choice) return "character";
  if (draft.mode === "new_world" && draft.options?.mature === undefined && draft.contentRating) return "content";
  if (draft.mode === "new_world" && draft.options?.dialogue === undefined) return "dialogue";
  // 여기까지 오면 끝났다 (answerNewGame이 done을 돌려준다)
  return "dialogue";
}

/** 이 초안의 월드 콘텐츠 (코드가 만든 역할을 넣어서) */
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
      /** 사망 뒤 새 캐릭터면 고른 후보 id */
      heirOption?: string;
      /** 이 세계의 수위 (12-57)와 서술 방식 (12-85) */
      options: { mature: boolean; dialogue: DialogueStyle };
    }
  | { ok: false; error: string };

const norm = (x: string) => x.trim().toLowerCase();

/** 다 정했으면 끝 (새 게임은 수위·서술 방식까지, 새 캐릭터는 캐릭터까지) */
function settle(draft: NewGameDraft): NewGameReply {
  const finished = draft.choice && (draft.mode === "heir" || (draft.options?.dialogue !== undefined && (draft.options?.mature !== undefined || !draft.contentRating)));
  if (!finished) return { ok: true, draft, done: false };
  return {
    ok: true,
    draft,
    done: true,
    packId: draft.packId!,
    roleId: draft.roleId!,
    choice: draft.choice!,
    ...(draft.heirOption ? { heirOption: draft.heirOption } : {}),
    options: { mature: draft.options?.mature ?? false, dialogue: draft.options?.dialogue ?? "novel" },
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
  if (step === "scenario") {
    const v = norm(text);
    const role = Object.values(content.roles).find((r) => r.scenario?.order !== undefined && (norm(r.id) === v || norm(r.scenario.title) === v));
    const choices = scenarioChoices(content, unlocked);
    if (!role) return { ok: false, error: `시나리오는 ${choices.filter((c) => !c.locked).map((c) => c.title).join(", ")} 중 하나다.` };
    if (!scenarioOpen(role, unlocked)) return { ok: false, error: `${josa(role.scenario!.title, "은/는")} 아직 잠겨 있다. 해금 조건: ${role.scenario!.unlock!.text}` };
    return { ok: true, draft: pickRole(content, draft, role.id), done: false };
  }
  if (step === "content") {
    const v = norm(text);
    if (["on", "켜기", "켠다", "예", "네"].includes(v)) return settle({ ...draft, options: { ...draft.options, mature: true } });
    if (["off", "끄기", "끈다", "아니오", "아니요"].includes(v)) return settle({ ...draft, options: { ...draft.options, mature: false } });
    return { ok: false, error: "켜기(on) 또는 끄기(off) 중에서 고른다." };
  }
  if (step === "dialogue" && draft.choice) {
    const v = norm(text);
    if (["novel", "소설", "소설식"].includes(v)) return settle({ ...draft, options: { ...draft.options, dialogue: "novel" } });
    if (["script", "대본", "대본식"].includes(v)) return settle({ ...draft, options: { ...draft.options, dialogue: "script" } });
    return { ok: false, error: "소설식(novel) 또는 대본식(script) 중에서 고른다." };
  }
  // 캐릭터 만들기. 나이를 "기본"으로 답하면 시나리오(역할)의 나이 (계급·과거 배경의 최소 나이보다 어리면 그 나이)
  const role = draftContent(packs, draft).roles[draft.roleId!];
  const ageDefault = currentStep(content.scenario, draft.character) === "age" && role && ["기본", "default", "상관없음", "아무거나"].includes(norm(text));
  const r: CreationReply = answerCreation(content.scenario, draft.character, ageDefault ? String(Math.max(role.age, ageFloor(content.scenario, draft.character))) : answer, rng);
  if (!r.ok) return r;
  if (!r.done) return { ok: true, draft: { ...draft, character: r.draft }, done: false };
  return settle({ ...draft, character: r.draft, choice: r.choice });
}

/** 한 단계 뒤로 (서술 방식 → 수위 → 캐릭터 만들기 → 시나리오 → 월드) */
export function backNewGame(draft: NewGameDraft): NewGameDraft {
  if (draft.mode === "new_world" && draft.options?.dialogue !== undefined) return { ...draft, options: { ...draft.options, dialogue: undefined } };
  if (draft.mode === "new_world" && draft.options?.mature !== undefined && draft.contentRating) return { ...draft, options: { ...draft.options, mature: undefined } };
  // 다 만든 캐릭터에서 뒤로: 캐릭터 확인 단계로
  if (draft.choice) return { ...draft, choice: undefined };
  if (draft.character.answers.length > 0) return { ...draft, character: backCreation(draft.character) };
  if (draft.mode === "heir") return draft;
  if (draft.roleId) return { ...draft, roleId: null, character: { ...draft.character, minAge: undefined, seat: undefined } };
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
      "물을 것: 어느 월드에서 시작할지. 월드마다 이름과 한 줄 소개, 짧은 설명만 보여 주고 고르게 한다 (월드가 하나여도 소개하고 고르게 한다). 세계 배경을 길게 풀지 않는다.",
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
    const choices = scenarioChoices(content, draft.unlocked?.[content.scenario.id] ?? []);
    const open = choices.filter((c) => !c.locked);
    return [
      `## 새 게임: ${worldInfo(content).title} — 어떤 시나리오로 시작할까요?`,
      "물을 것: 시나리오. 목록 순서대로 이름과 짧은 설명을 보여 주고 고르게 한다. 잠긴 시나리오도 이름과 해금 조건을 함께 보여 준다 (고를 수는 없다). 처음이면 튜토리얼을 권한다. 세계 배경을 따로 길게 풀지 않는다.",
      "",
      ...choices.map((c) =>
        c.locked ? `### 🔒 ${c.title} (잠김)\n해금 조건: ${c.locked}` : `### ${c.title} (${c.who})\n${c.pitch}${c.goal ? `\n클리어 목표: ${c.goal}` : ""}`,
      ),
      "",
      `보기 (클릭으로 고르는 도구가 있으면 그것으로): ${open.map((c) => `${c.title} → "${c.roleId}"`).join(" / ")}`,
      "",
      FOOTER,
    ].join("\n");
  }
  if (step === "content") {
    const age = content.scenario.content_rating?.adult_age ?? 18;
    return [
      "## 새 게임: 수위",
      "물을 것: 이 세계에서 성인 주제를 다룰지. 짧게 설명하고 고르게 한다. 연애는 어느 쪽이든 나온다는 것도 알린다.",
      `- 켜기: 성인 사이의 잠자리(장면은 암전으로 넘긴다), 성적인 농담·괴롭힘·위협(시도까지만, 행위는 그리지 않는다)이 이야기에 나올 수 있다. ${age}세 미만은 주인공이든 인물이든 어떤 경우에도 그 대상이 되지 않는다. 노골적인 묘사는 하지 않는다.`,
      `- 끄기: 그런 이야기는 나오지 않는다 (기본). 연애는 나오지만 연인 사이도 손잡기·입맞춤까지다. 폭력과 죽음, 생존의 잔혹함은 어느 쪽이든 나온다.`,
      "게임 중에도 바꿀 수 있다 (상태 화면의 설정, 또는 플레이어가 말하면 set_content_options).",
      '보기 (클릭으로 고르는 도구가 있으면 그것으로): 끄기 → "off" / 켜기 → "on"',
      "",
      FOOTER,
    ].join("\n");
  }
  if (step === "dialogue" && draft.choice) {
    return [
      "## 새 게임: 서술 방식",
      "물을 것: 이야기를 소설식으로 들을지 대본식으로 들을지. 짧게 설명하고 고르게 한다. 이것이 마지막이다: 고르면 바로 첫 장면이다.",
      '- 소설식: 대사가 서술 속에 녹아 있다 (예: 강태호가 담배를 비벼 끄며 "오늘은 동쪽이다"라고 말했다.)',
      '- 대본식: 대사를 "이름: 대사" 줄로 따로 뗀다 (예: 강태호: "오늘은 동쪽이다.")',
      "게임 중에도 바꿀 수 있다 (상태 화면의 설정, 또는 플레이어가 말하면 set_content_options의 dialogue).",
      '보기 (클릭으로 고르는 도구가 있으면 그것으로): 소설식 → "novel" / 대본식 → "script"',
      "",
      FOOTER,
    ].join("\n");
  }
  return describeCreationStep(draftContent(packs, draft), draft.character, draft.roleId!);
}

export { currentStep };
