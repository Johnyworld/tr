import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import type { Content } from "../content/schemas.ts";
import { createSeededRng } from "../rng.ts";
import { WorldManager } from "../world/manager.ts";
import { answerNewGame, backNewGame, describeNewGameStep, newGameDraft, newGameStep, type NewGameDraft } from "./newGame.ts";
import { newGameView } from "./newGameView.ts";
import { checkGroup, editGroup, memberLabel, memberTemplate, newGroup, randomMember, type StartGroup } from "./startGroup.ts";

/** 떠돌이의 소규모 무리 (12-77 3단계) */
const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const packs = new Map<string, Content>([[content.scenario.id, content]]);

function run(answers: (string | string[])[], draft: NewGameDraft = newGameDraft()) {
  const rng = createSeededRng(9);
  let d = draft;
  for (const a of answers) {
    const r = answerNewGame(packs, d, a, rng);
    if (!r.ok) throw new Error(`${JSON.stringify(a)}: ${r.error}`);
    if (r.done) return r;
    d = r.draft;
  }
  return { ok: true as const, draft: d, done: false as const };
}

const g = (me: StartGroup["me"], members: StartGroup["members"]): StartGroup => ({ me, members, confirmed: false });

describe("소규모 무리 규칙", () => {
  it("무작위로 만든 무리는 언제나 규칙에 맞는다 (부모·자식 나이 차, 배우자 성별, 관계 상한)", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rng = createSeededRng(seed);
      const group = newGroup(content, rng);
      expect(group.members).toHaveLength(3);
      for (let i = 0; i < 2; i++) {
        const m = randomMember(content, group, rng);
        if (m) group.members.push(m);
      }
      expect(group.members.length).toBeLessThanOrEqual(5);
      expect(checkGroup(content, group), `seed ${seed}`).toEqual([]);
      expect(randomMember(content, group, rng)).toBeNull(); // 5명이면 더할 수 없다
    }
  });

  it("부모·자식은 18살 이상 차이, 같은 성별의 배우자는 안 된다, 배우자는 하나", () => {
    const me = { age: 30, gender: "male" };
    const problems = (members: StartGroup["members"]) => checkGroup(content, g(me, members)).map((p) => p.problem).join(" ");
    expect(problems([{ relation: "parent", name: "김영자", age: 45, gender: "female" }])).toContain("18살 이상 많다");
    expect(problems([{ relation: "parent", name: "김영자", age: 48, gender: "female" }])).toBe("");
    expect(problems([{ relation: "child", name: "김민지", age: 13, gender: "female" }])).toContain("18살 이상 어리다");
    expect(problems([{ relation: "child", name: "김민지", age: 12, gender: "female" }])).toBe("");
    expect(problems([{ relation: "spouse", name: "박지훈", age: 30, gender: "male" }])).toContain("다른 성별");
    expect(
      problems([
        { relation: "spouse", name: "박지은", age: 30, gender: "female" },
        { relation: "spouse", name: "최수아", age: 29, gender: "female" },
      ]),
    ).toContain("1명까지");
    expect(problems([{ relation: "sibling", name: "김 하나", age: 20, gender: "female" }])).toContain("띄어쓰기");
  });

  it("부르는 말과 틀은 관계·성별·나이에서 나온다", () => {
    const me = { age: 30, gender: "female" };
    const label = (m: StartGroup["members"][number]) => memberLabel(content, { me }, m);
    expect(label({ relation: "sibling", name: "a", age: 33, gender: "male" })).toBe("오빠");
    expect(label({ relation: "sibling", name: "a", age: 25, gender: "female" })).toBe("여동생");
    expect(label({ relation: "spouse", name: "a", age: 31, gender: "male" })).toBe("남편");
    expect(label({ relation: "comrade", name: "a", age: 40, gender: "male" })).toBe("길동무");
    expect(memberTemplate(content, { relation: "child", name: "a", age: 9, gender: "male" })).toBe("kin_young");
    expect(memberTemplate(content, { relation: "parent", name: "a", age: 60, gender: "male" })).toBe("kin_elder");
    expect(memberTemplate(content, { relation: "spouse", name: "a", age: 30, gender: "male" })).toBe("kin_partner");
  });

  it("고치기: add / remove N / edit N 관계=.. / me 나이=..", () => {
    const rng = createSeededRng(3);
    const base = g({ age: 30, gender: "male" }, [{ relation: "sibling", name: "김하나", age: 27, gender: "female" }]);
    const edited = editGroup(content, base, "edit 1 관계=자식 이름=김두리 나이=8 성별=여성", rng);
    expect(edited).toMatchObject({ ok: true, group: { members: [{ relation: "child", name: "김두리", age: 8, gender: "female" }] } });
    expect(editGroup(content, base, "me 나이=40 성별=female", rng)).toMatchObject({ ok: true, group: { me: { age: 40, gender: "female" } } });
    expect(editGroup(content, base, "remove 1", rng)).toMatchObject({ ok: true, group: { members: [] } });
    expect(editGroup(content, base, "remove 3", rng).ok).toBe(false);
    expect(editGroup(content, base, "edit 1 키=180", rng).ok).toBe(false);
    const added = editGroup(content, base, "add", rng);
    expect(added.ok && added.group.members).toHaveLength(2);
  });
});

describe("소규모 무리: 새 게임 흐름", () => {
  it("떠돌이 → 소규모 무리 → 고치기 → done → 역할, 주인공 나이·성별은 다시 묻지 않는다", () => {
    const group = run(["post_apoc", "loner", "group"]).draft;
    expect(newGameStep(group)).toBe("group");
    expect(group.group?.members).toHaveLength(3);
    expect(describeNewGameStep(packs, group)).toContain("나 (주인공)");
    expect(newGameView(packs, group).group?.members[0]?.label).toBeTruthy();
    // 규칙에 어긋나면 done이 막힌다
    const bad = run(["edit 1 관계=parent 나이=20"], group).draft;
    expect(newGameView(packs, bad).group?.members[0]?.problems.join()).toContain("18살 이상");
    expect(answerNewGame(packs, bad, "done", createSeededRng(1)).ok).toBe(false);
    // 다 고치면 떠돌이는 역할 단계 없이 바로 역할이 만들어진다
    const built = run(["me 나이=36 성별=female", "done"], group).draft;
    expect(newGameStep(built)).toBe("motive");
    expect(built.character).toMatchObject({ presetAge: 36, presetGender: "female" });
    expect(newGameStep(backNewGame(built))).toBe("group");
    expect(backNewGame(built).character.presetAge).toBeUndefined();
    expect(newGameStep(backNewGame(backNewGame(built)))).toBe("companion");
    expect(built.customRole?.start_companions).toHaveLength(3);
    expect(built.customRole?.age).toBe(36);
  });

  it("모두 빼면 혼자였다(alone)로, 아무도 없이 done은 안 된다", () => {
    const group = run(["post_apoc", "loner", "group", "remove 1", "remove 1", "remove 1"]).draft;
    expect(group.group?.members).toEqual([]);
    expect(answerNewGame(packs, group, "done", createSeededRng(1)).ok).toBe(false);
    const alone = run(["alone"], group).draft;
    expect(alone).toMatchObject({ companion: "alone", group: undefined });
    expect(newGameStep(alone)).toBe("motive");
  });

  it("세계를 만들면 무리가 정한 이름·나이·성별로 처음부터 함께 다닌다", () => {
    const d = run(["post_apoc", "loner", "group"]).draft;
    const members = d.group!.members;
    const done = run(["done", "skip", "off", "novel", "police", "윤하", "random", "past", "none", "start"], d);
    expect(done.done).toBe(true);
    if (!done.done) return;
    expect(done.choice).toMatchObject({ gender: d.group!.me.gender, age: d.group!.me.age });
    const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-group-")), content, rngFactory: () => createSeededRng(5) });
    const w = m.create("mcp", done.roleId, done.choice, done.packId, done.custom ?? undefined, done.options);
    const state = w.state();
    const companions = Object.keys(state.bonds ?? {}).map((id) => state.characters[id]!);
    expect(companions.map((c) => [c.name, c.age, c.gender]).sort()).toEqual(members.map((x) => [x.name, x.age, x.gender]).sort());
    w.close();
  });
});
