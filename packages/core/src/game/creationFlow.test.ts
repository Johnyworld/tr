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
  draftChoice,
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
  it("첫 단계는 시나리오의 지금 상황과 이름. 사망 뒤 새 캐릭터는 그 없이", () => {
    const first = describeCreationStep(content, newCreationDraft("new_world"), roleId);
    expect(first).toContain("지금 상황");
    expect(first).toContain("분대장 강태호");
    expect(first).toContain("1/6: 이름");
    expect(first).not.toContain("<!--");
    const heir = describeCreationStep(content, newCreationDraft("heir"), roleId);
    expect(heir).not.toContain("지금 상황");
    expect(heir).toContain("이름");
  });

  it("이름 → 성별 → 나이 → 능력 한 번에 → 트레잇(약점·강점 → 성격) → 확인 순서로, 고른 그대로 만든다", () => {
    const { draft } = run(["한서진", "여성", "30", "manual"]);
    expect(currentStep(s, draft)).toBe("ability_set");
    const step = describeCreationStep(content, draft, roleId);
    expect(step).toContain("가장 자신 있는 것(+2) 1개, 잘하는 것(+1) 2개, 자신 없는 것(-1) 1개");
    expect(step).toContain("1. 근력 — 힘, 완력");
    expect(step).toContain("7. 지능");
    expect(step).not.toContain("포인트를 나눠");
    const abilities = run(["한서진", "여성", "30", "manual", "2 / 4, 7 / 6"]);
    expect(currentStep(s, abilities.draft)).toBe("traits");
    const traits = run(["한서진", "female", "30", "manual", "민첩\n감각 지능\n매력", "manual", ["허약 체질", "beautiful"], "없음"]);
    expect(currentStep(s, traits.draft)).toBe("confirm");
    const done = run(["한서진", "female", "30", "manual", "+2: agility / +1: 감각, 7 / -1: 매력", "manual", "허약 체질, beautiful", "없음", "start"]);
    expect(done.choice).toEqual({
      name: "한서진",
      gender: "female",
      abilities: { strength: 0, agility: 2, vitality: 0, senses: 1, nerve: 0, charm: -1, intellect: 1 },
      portrait: null,
      traits: ["frail", "beautiful"],
      age: 30,
    });
  });

  it("나이는 월드의 범위 안의 숫자만 (12-69)", () => {
    const { draft } = run(["서진", "male"]);
    expect(currentStep(s, draft)).toBe("age");
    expect(describeCreationStep(content, draft, roleId)).toContain("16~65세");
    for (const bad of ["15", "66", "스무 살", "30.5"]) expect(answerCreation(s, draft, bad, createSeededRng(1)).ok, bad).toBe(false);
    const ok = answerCreation(s, draft, "42세", createSeededRng(1));
    expect(ok.ok && draftChoice(ok.draft).age).toBe(42);
    // 이미 정한 나이(직접 쓰는 시나리오)가 있으면 묻지 않는다
    const preset = run(["서진", "male"], { ...newCreationDraft("new_world"), presetAge: 50 }).draft;
    expect(currentStep(s, preset)).toBe("abilities");
    expect(draftChoice(preset).age).toBe(50);
  });

  it("능력 등급은 개수가 맞아야 하고, 없는 능력·겹친 능력은 오류 (초안은 그대로)", () => {
    const { draft } = run(["서진", "male", "30", "manual"]);
    expect(stepOptions(s, draft, currentStep(s, draft))).toEqual([]);
    const bad = (a: string) => {
      const r = answerCreation(s, draft, a, createSeededRng(1));
      return r.ok ? "" : r.error;
    };
    expect(bad("2 / 4")).toContain("등급 순서");
    expect(bad("2 / 4 / 6")).toContain("2개를 고른다");
    expect(bad("2 / 4, 8 / 6")).toContain("없다");
    expect(bad("2 / 4, 마력 / 6")).toContain("없다");
    expect(bad("2 / 2, 4 / 6")).toContain("두 번");
  });

  it("ability_array가 없는 월드는 포인트 배분 글로 받는다", () => {
    const s0 = { ...s, ability_array: undefined };
    let draft = newCreationDraft("new_world");
    for (const a of ["서진", "male", "30", "manual"]) {
      const r = answerCreation(s0, draft, a, createSeededRng(1));
      if (r.ok) draft = r.draft;
    }
    const bad = (a: string) => {
      const r = answerCreation(s0, draft, a, createSeededRng(1));
      return r.ok ? "" : r.error;
    };
    expect(bad("근력 2, 민첩 2")).toContain("넘게"); // 6포인트
    expect(bad("근력 -1, 민첩 -1, 감각 -1")).toContain("2개까지");
    expect(bad("근력 3")).toContain("고를 수 있는 값");
    expect(bad("마력 1")).toContain("없다");
    expect(bad("근력 1, 근력 0")).toContain("두 번");
    expect(bad("근력 높게")).toContain("쉼표");
    const ok = answerCreation(s0, draft, "근력 2, 민첩 1, 체력 -1, 냉정 1", createSeededRng(1));
    expect(ok.ok && currentStep(s0, ok.draft)).toBe("traits");
  });

  it("강점은 약점으로 얻은 포인트만큼만, 반대 트레잇은 함께 못 고른다", () => {
    const { draft } = run(["서진", "male", "30", "random", "manual"]);
    expect(answerCreation(s, draft, "느린 학습, quick_learner", createSeededRng(1)).ok).toBe(false); // 반대
    const r = answerCreation(s, draft, "marksman", createSeededRng(1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("모자란다");
    expect(answerCreation(s, draft, "느린 학습, marksman", createSeededRng(1)).ok).toBe(true);
  });

  it("약점·강점은 한 표(약점 먼저)로 보여 주고, 표의 번호로 고를 수 있다", () => {
    const { draft } = run(["서진", "male", "30", "random", "manual"]);
    expect(currentStep(s, draft)).toBe("traits_pick");
    const step = describeCreationStep(content, draft, roleId);
    expect(step).toContain("| 번호 | 종류 | 이름 | 포인트 | 효과 |");
    const rows = step.split("\n").filter((l) => /^\| \d+ \|/.test(l));
    const frailRow = rows.find((l) => l.includes("허약 체질"))!;
    const marksmanRow = rows.find((l) => l.includes("사격 감각"))!;
    expect(frailRow).toContain("| 약점 |");
    expect(frailRow).toContain("| +2 |");
    expect(marksmanRow).toContain("| 강점 |");
    expect(rows.indexOf(frailRow)).toBeLessThan(rows.indexOf(marksmanRow));
    const num = (row: string) => row.split("|")[1]!.trim();
    const r = answerCreation(s, draft, `${num(frailRow)}, ${num(marksmanRow)}`, createSeededRng(1));
    expect(r.ok).toBe(true);
    if (r.ok) expect(draftChoice(r.draft).traits).toEqual(["frail", "marksman"]);
    expect(answerCreation(s, draft, String(rows.length + 1), createSeededRng(1)).ok).toBe(false);
    // 성격은 따로, 번호 목록으로
    const personality = describeCreationStep(content, r.ok ? r.draft : draft, roleId);
    expect(personality).toContain("트레잇: 성격");
    expect(personality).toMatch(/\n1\. /);
  });

  it("운에 맡기면 규칙에 맞는 값을 바로 굴려 확인 단계에서 보여 준다", () => {
    const { draft } = run(["서진", "male", "30", "random", "random"]);
    expect(currentStep(s, draft)).toBe("confirm");
    const done = run(["서진", "male", "30", "random", "random", "이대로 시작"]);
    expect(checkCharacterChoice(s, done.choice!)).toEqual([]);
    expect(describeCreationStep(content, draft, roleId)).toContain("능력: 근력");
  });

  it("뒤로 가기와 처음부터 다시", () => {
    const { draft } = run(["서진", "male", "30", "random", "none"]);
    expect(currentStep(s, backCreation(draft))).toBe("traits");
    const back = answerCreation(s, draft, "back", createSeededRng(1));
    expect(back.ok && currentStep(s, back.draft)).toBe("traits");
    const restart = answerCreation(s, draft, "restart", createSeededRng(1));
    expect(restart.ok && restart.draft.answers).toEqual([]);
  });
});
