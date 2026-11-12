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
import type { CharacterChoice } from "./state.ts";

/**
 * 새 게임 (기획서 4.2, 12-15): 월드 고르기 → 시나리오(시작 역할) 고르기 → 캐릭터 만들기(creationFlow).
 * 사망 뒤 새 캐릭터는 같은 월드·시나리오라 바로 캐릭터 만들기부터 (heir).
 * 코드의 scenario 팩 = 플레이어의 "월드", 팩 안의 role = 플레이어의 "시나리오"
 */
export type NewGameDraft = {
  mode: CreationDraft["mode"];
  packId: string | null;
  roleId: string | null;
  character: CreationDraft;
};

export type NewGameStep = "world" | "scenario" | "character";

export function newGameDraft(): NewGameDraft {
  return { mode: "new_world", packId: null, roleId: null, character: newCreationDraft("new_world") };
}

/** 사망 뒤 같은 세계의 새 캐릭터: 월드·시나리오는 정해져 있다 */
export function heirDraft(packId: string, roleId: string): NewGameDraft {
  return { mode: "heir", packId, roleId, character: newCreationDraft("heir") };
}

export function newGameStep(draft: NewGameDraft): NewGameStep {
  if (!draft.packId) return "world";
  if (!draft.roleId) return "scenario";
  return "character";
}

export type NewGameReply =
  | { ok: true; draft: NewGameDraft; done: false }
  | { ok: true; draft: NewGameDraft; done: true; packId: string; roleId: string; choice: CharacterChoice }
  | { ok: false; error: string };

const norm = (x: string) => x.trim().toLowerCase();

/** 이번 단계에 답한다 */
export function answerNewGame(packs: ReadonlyMap<string, Content>, draft: NewGameDraft, answer: string | string[], rng: Rng): NewGameReply {
  const text = Array.isArray(answer) ? answer.join(", ") : answer;
  const step = newGameStep(draft);
  if (step === "world") {
    const hit = [...packs.values()].map(worldInfo).find((w) => norm(w.id) === norm(text) || norm(w.title) === norm(text));
    if (!hit) return { ok: false, error: `월드는 ${[...packs.values()].map((c) => worldInfo(c).title).join(", ")} 중 하나다.` };
    return { ok: true, draft: { ...draft, packId: hit.id }, done: false };
  }
  const content = packs.get(draft.packId!)!;
  if (step === "scenario") {
    const hit = scenarioInfos(content).find((r) => norm(r.id) === norm(text) || norm(r.title) === norm(text));
    if (!hit) return { ok: false, error: `시나리오는 ${scenarioInfos(content).map((r) => r.title).join(", ")} 중 하나다.` };
    return { ok: true, draft: { ...draft, roleId: hit.id }, done: false };
  }
  const r: CreationReply = answerCreation(content.scenario, draft.character, answer, rng);
  if (!r.ok) return r;
  const next = { ...draft, character: r.draft };
  return r.done ? { ok: true, draft: next, done: true, packId: draft.packId!, roleId: draft.roleId!, choice: r.choice } : { ok: true, draft: next, done: false };
}

/** 한 단계 뒤로 (캐릭터 만들기의 처음에서 뒤로 가면 시나리오, 그다음 월드) */
export function backNewGame(draft: NewGameDraft): NewGameDraft {
  if (draft.character.answers.length > 0) return { ...draft, character: backCreation(draft.character) };
  if (draft.mode === "heir") return draft;
  if (draft.roleId) return { ...draft, roleId: null };
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
    const scenarios = scenarioInfos(content);
    return [
      `## 새 게임: ${world.title} — 시나리오 고르기`,
      "먼저: 아래 월드 이야기를 바탕으로, 이 세계가 어떻게 무너졌고 지금 어떤 곳인지 GM의 목소리로 들려준다 (서너 문단, 목록 말고 이야기로). 소개에 없는 사실은 만들지 않는다. 그다음 시나리오를 고르게 한다.",
      "",
      content.scenario.introText ?? `${world.tagline}\n${world.description}`,
      "",
      "물을 것: 어떤 사람으로, 어디서 시작할지 (시나리오). 이름과 소개를 보여 주고 고르게 한다 (하나여도 소개하고 고르게 한다).",
      "",
      ...scenarios.map((r) => `### ${r.title}\n${r.pitch}`),
      "",
      `보기 (클릭으로 고르는 도구가 있으면 그것으로): ${scenarios.map((r) => `${r.title} → "${r.id}"`).join(" / ")}`,
      "",
      FOOTER,
    ].join("\n");
  }
  return describeCreationStep(content, draft.character, draft.roleId!);
}

export { currentStep };
