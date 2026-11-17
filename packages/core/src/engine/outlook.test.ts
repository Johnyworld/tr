import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { describePolicyForGm } from "./command.ts";

/** 회의 안내의 창고 전망 (12-139): 지금 방침대로면 며칠, 안을 바꾸면 며칠 */
const content = loadRealContent();

describe("창고 전망", () => {
  it("간부는 줄어드는 자원이 며칠 가는지, 안마다 어떻게 바뀌는지 본다. 간부가 아니면 보지 않는다", () => {
    const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-ol-")), content, rngFactory: () => createSeededRng(4) }).create("mcp", "role_a_officer");
    w.state().time += 10 * 1440; // 겨울
    const text = describePolicyForGm(w.state(), content);
    expect(text).toContain("창고 전망");
    const fuelLine = text.split("\n").find((l) => l.startsWith("- fuel"))!;
    const now = Number(/연료 약 (\d+)일/.exec(text.split("\n").find((l) => l.startsWith("창고 전망"))!)![1]);
    const warm = Number(/warm[^/]*연료 약 (\d+)일/.exec(fuelLine)![1]);
    expect(warm).toBeLessThan(now);
    expect(fuelLine).toContain("줄지 않음"); // 아끼면 겨울에도 줄지 않는다
    const grunt = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-ol-")), content, rngFactory: () => createSeededRng(4) }).create("mcp", "role_a_grunt");
    expect(describePolicyForGm(grunt.state(), content)).not.toContain("창고 전망");
  });
});
