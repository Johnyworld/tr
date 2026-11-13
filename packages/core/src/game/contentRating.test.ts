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
import { answerNewGame, describeNewGameStep, newGameDraft, newGameStep } from "./newGame.ts";

/** 수위와 나이 제한 (12-57) */
const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const parse = createContentSchemas(content.scenario).storylet.parse;
const open = (options?: { mature: boolean }) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-rating-")), content, rngFactory: () => createSeededRng(2) }).create("mcp", "role_a_grunt", undefined, undefined, undefined, options);
const story = (cast: Record<string, unknown>) => parse({ id: "m", title: "m", tags: ["world", "mature"], cast, setup: "x", choices: [{ id: "a", label: "a", effects: [] }] });

describe("수위", () => {
  it("새 게임에서 시나리오 다음에 묻고, 기본은 끔이다", () => {
    const packs = new Map([[content.scenario.id, content]]);
    let d = newGameDraft();
    for (const a of ["post_apoc", "role_a_grunt"]) {
      const r = answerNewGame(packs, d, a, createSeededRng(1));
      if (!r.ok) throw new Error(r.error);
      d = r.draft;
    }
    expect(newGameStep(d)).toBe("content");
    expect(describeNewGameStep(packs, d)).toContain("성인 주제");
    const r = answerNewGame(packs, d, "on", createSeededRng(1));
    expect(r.ok && newGameStep(r.draft)).toBe("character");
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
