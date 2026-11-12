import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { createSeededRng } from "../rng.ts";
import { checkCharacterChoice } from "./creation.ts";
import {
  answerCreation,
  backCreation,
  currentStep,
  describeCreationStep,
  newCreationDraft,
  stepOptions,
  type CreationDraft,
} from "./creationFlow.ts";

const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const s = content.scenario;
const roleId = Object.keys(content.roles)[0]!;

/** 답을 차례로 넣는다. 오류가 나면 실패 */
function run(answers: (string | string[])[], draft = newCreationDraft("new_world")) {
  const rng = createSeededRng(5);
  let d: CreationDraft = draft;
  for (const a of answers) {
    const r = answerCreation(s, d, a, rng);
    if (!r.ok) throw new Error(`${String(a)}: ${r.error}`);
    if (r.done) return { draft: r.draft, choice: r.choice };
    d = r.draft;
  }
  return { draft: d, choice: null };
}

describe("대화로 하는 캐릭터 생성", () => {
  it("첫 단계는 세계 소개와 이름. 사망 뒤 새 캐릭터는 세계 소개 없이", () => {
    const first = describeCreationStep(content, newCreationDraft("new_world"), roleId);
    expect(first).toContain("세계와 지금 상황");
    expect(first).toContain("청솔형제단");
    expect(first).toContain("1/5: 이름");
    const heir = describeCreationStep(content, newCreationDraft("heir"), roleId);
    expect(heir).not.toContain("세계와 지금 상황");
    expect(heir).toContain("이름");
  });

  it("이름 → 성별 → 능력 하나씩 → 트레잇(약점 → 강점 → 성격) → 확인 순서로, 고른 그대로 만든다", () => {
    const { draft } = run(["한서진", "여성", "manual"]);
    expect(currentStep(s, draft)).toBe("ability:strength");
    expect(describeCreationStep(content, draft, roleId)).toContain("남은 포인트 4");
    const abilities = run(["한서진", "여성", "manual", "0", "+2", "0", "1", "0", "0", "0"]);
    expect(currentStep(s, abilities.draft)).toBe("traits");
    const traits = run(["한서진", "female", "manual", "0", "2", "0", "1", "0", "0", "0", "manual", ["허약 체질"], "beautiful", "없음"]);
    expect(currentStep(s, traits.draft)).toBe("confirm");
    const done = run(["한서진", "female", "manual", "0", "2", "0", "1", "0", "0", "0", "manual", ["허약 체질"], "beautiful", "없음", "start"]);
    expect(done.choice).toEqual({
      name: "한서진",
      gender: "female",
      abilities: { strength: 0, agility: 2, vitality: 0, senses: 1, nerve: 0, charm: 0, intellect: 0 },
      portrait: null,
      traits: ["frail", "beautiful"],
    });
  });

  it("포인트를 넘는 값은 보기에 없고, 고르면 오류 (초안은 그대로)", () => {
    const { draft } = run(["서진", "male", "manual", "2"]); // 3포인트 썼다. 남은 1
    expect(stepOptions(s, draft, currentStep(s, draft)).map((o) => o.value)).toEqual(["-1", "0", "1"]);
    const r = answerCreation(s, draft, "2", createSeededRng(1));
    expect(r.ok).toBe(false);
  });

  it("강점은 약점으로 얻은 포인트만큼만, 반대 트레잇은 함께 못 고른다", () => {
    const { draft } = run(["서진", "male", "random", "manual", "느린 학습"]);
    expect(answerCreation(s, draft, ["quick_learner"], createSeededRng(1)).ok).toBe(false); // 반대
    const { draft: none } = run(["서진", "male", "random", "manual", "없음"]);
    const r = answerCreation(s, none, "marksman", createSeededRng(1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("모자란다");
  });

  it("운에 맡기면 규칙에 맞는 값을 바로 굴려 확인 단계에서 보여 준다", () => {
    const { draft } = run(["서진", "male", "random", "random"]);
    expect(currentStep(s, draft)).toBe("confirm");
    const done = run(["서진", "male", "random", "random", "이대로 시작"]);
    expect(checkCharacterChoice(s, done.choice!)).toEqual([]);
    expect(describeCreationStep(content, draft, roleId)).toContain("능력: 근력");
  });

  it("뒤로 가기와 처음부터 다시", () => {
    const { draft } = run(["서진", "male", "random", "none"]);
    expect(currentStep(s, backCreation(draft))).toBe("traits");
    const back = answerCreation(s, draft, "back", createSeededRng(1));
    expect(back.ok && currentStep(s, back.draft)).toBe("traits");
    const restart = answerCreation(s, draft, "restart", createSeededRng(1));
    expect(restart.ok && restart.draft.answers).toEqual([]);
  });
});
