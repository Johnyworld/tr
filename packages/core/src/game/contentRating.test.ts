import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { createContentSchemas } from "../content/schemas.ts";
import { describePlayerState } from "../engine/context.ts";
import { createSeededRng } from "../rng.ts";
import { eligibleStorylets } from "../story/storylets.ts";
import { WorldManager } from "../world/manager.ts";
import { answerNewGame, backNewGame, describeNewGameStep, newGameDraft, newGameStep } from "./newGame.ts";

/** 수위와 나이 제한 (12-57) */
const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const parse = createContentSchemas(content.scenario).storylet.parse;
const open = (options?: { mature: boolean }) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-rating-")), content, rngFactory: () => createSeededRng(2) }).create("mcp", "role_a_grunt", undefined, undefined, undefined, options);
const story = (cast: Record<string, unknown>) => parse({ id: "m", title: "m", tags: ["world", "mature"], cast, setup: "x", choices: [{ id: "a", label: "a", effects: [] }] });

describe("수위", () => {
  it("새 게임에서 캐릭터를 다 만든 다음에 묻고, 기본은 끔이다", () => {
    const packs = new Map([[content.scenario.id, content]]);
    let d = newGameDraft();
    for (const a of ["post_apoc", "role_t_visitor", "police", "서진", "female", "30", "random", "past", "none", "기본", "start"]) {
      const r = answerNewGame(packs, d, a, createSeededRng(1));
      if (!r.ok) throw new Error(r.error);
      d = r.draft;
    }
    expect(newGameStep(d)).toBe("content");
    expect(describeNewGameStep(packs, d)).toContain("성인 주제");
    const r = answerNewGame(packs, d, "on", createSeededRng(1));
    // 수위 다음은 서술 방식 (12-85): 소설식 / 대본식
    expect(r.ok && newGameStep(r.draft)).toBe("dialogue");
    if (!r.ok) return;
    expect(answerNewGame(packs, r.draft, "모르는 방식", createSeededRng(1)).ok).toBe(false);
    // 서술 방식이 마지막: 고르면 끝난다
    const s2 = answerNewGame(packs, r.draft, "대본식", createSeededRng(1));
    expect(s2.ok && s2.done && s2.options).toEqual({ mature: true, dialogue: "script" });
    expect(newGameStep(backNewGame(r.draft))).toBe("content");
  });

  it("꺼져 있으면 성인 주제 이야기가 열리지 않고, 켜져 있어도 미성년자는 배역이 되지 않는다", () => {
    const off = open();
    const s = story({ who: { ids: ["a_jiho", "pb_yunjae"] } });
    expect(eligibleStorylets(off.state(), { ...off.content, storylets: { m: s } })).toHaveLength(0);
    expect(describePlayerState(off.state(), off.content)).toContain("성인 주제 꺼짐");
    const on = open({ mature: true });
    expect(on.state().options.mature).toBe(true);
    expect(describePlayerState(on.state(), on.content)).toContain("어떤 경우에도 연애·성적인 대상이 아니다");
    const minor = Object.values(on.state().characters).find((c) => c.age !== null && c.age < 18 && c.id !== on.state().playerId)!;
    expect(minor).toBeTruthy();
    expect(eligibleStorylets(on.state(), { ...on.content, storylets: { m: story({ who: { ids: [minor.id] } }) } })).toHaveLength(0);
    const adult = Object.values(on.state().characters).find((c) => (c.age ?? 0) >= 18 && content.npcs[c.id] && !c.captive && c.id !== on.state().playerId)!;
    expect(eligibleStorylets(on.state(), { ...on.content, storylets: { m: story({ who: { ids: [adult.id] } }) } })).toHaveLength(1);
  });

  it("주인공이 미성년자면 켜져 있어도 열리지 않는다", () => {
    const w = open({ mature: true });
    w.state().characters[w.state().playerId]!.age = 17;
    expect(eligibleStorylets(w.state(), { ...w.content, storylets: { m: story({}) } })).toHaveLength(0);
  });

  it("게임 중에 플레이어가 바꿀 수 있다", () => {
    const w = open();
    expect(w.executeTool("set_content_options", { mature: true }).ok).toBe(true);
    expect(w.state().options.mature).toBe(true);
  });
});

describe("대화 형식 (12-63)", () => {
  it("기본은 소설. 설정 창(setOptions)이나 tool로 대본으로 바꾸면 GM 장면 정보에 실린다", () => {
    const w = open();
    expect(w.options()).toEqual({ mature: false, dialogue: "novel" });
    expect(describePlayerState(w.state(), w.content)).toContain("대화 형식: 소설");
    w.sceneForGm();
    const r = w.setOptions({ dialogue: "script" });
    expect(r.ok && r.changed).toEqual(["대화 형식을 대본(으)로 바꿨다. 다음 서술부터 그 형식으로 쓴다."]);
    expect(w.state().options).toEqual({ mature: false, dialogue: "script" });
    // 다음 장면 정보(바뀐 덩어리만)에 실린다
    expect(w.sceneUpdate()).toContain('대화 형식: 대본. 인물의 대사는 서술 문장에 섞지 않고 따로 떼어 한 줄씩 쓴다: **이름**: "대사"');
    // 같은 값이면 이벤트를 남기지 않는다
    const same = w.setOptions({ dialogue: "script", mature: false });
    expect(same.ok && same.changed).toEqual([]);
    expect(w.setOptions({}).ok).toBe(false);
    expect(w.setOptions({ dialogue: "poem" }).ok).toBe(false);
    expect(w.executeTool("set_content_options", { dialogue: "novel" }).ok).toBe(true);
    expect(w.state().options.dialogue).toBe("novel");
  });
});
