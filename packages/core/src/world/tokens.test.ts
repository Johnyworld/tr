import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { describeZonePeople, ZONE_PEOPLE_IN_PROMPT } from "../engine/context.ts";
import { createSeededRng } from "../rng.ts";
import { WorldManager } from "./manager.ts";

/** 장면 토큰 (기획서 11.6, 12-42) */
const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const open = () => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-tok-")), content, rngFactory: () => createSeededRng(1) }).create("mcp", "role_d_medic");

describe("장면 토큰", () => {
  it("이 구역의 낯선 사람은 몇 명만 싣고 나머지는 수로 알린다", () => {
    const w = open();
    w.runCheat("~goto e_market");
    const text = describeZonePeople(w.state(), w.content);
    const lines = text.split("\n").filter((l) => l.startsWith("- ("));
    expect(lines.length).toBeLessThanOrEqual(ZONE_PEOPLE_IN_PROMPT);
    if (lines.length === ZONE_PEOPLE_IN_PROMPT) expect(text).toMatch(/이 밖에 \d+명/);
  });

  it("이야기가 열려도 장면 전체를 다시 보내지 않는다 (바뀐 덩어리만)", () => {
    const w = open();
    w.sceneForGm();
    w.runCheat("~storylet w_body_letter");
    const update = w.sceneUpdate();
    expect(update).toContain("그대로라 다시 싣지 않음");
    expect(update).toContain("진행 중인 이야기");
  });
});
