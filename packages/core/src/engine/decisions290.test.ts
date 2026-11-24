import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { lapseImprovSlot, openImprovSlot } from "./improvStory.ts";

/** 쓰지 않은 즉흥 자리 (12-290). 실제 콘텐츠로 본다 */
const content = loadRealContent();
const make = () => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-290-")), content, rngFactory: () => () => 0.5 }).create("mcp", "role_a_grunt");

describe("쓰지 않은 즉흥 자리 (12-290)", () => {
  it("열린 이야기 기한만큼 열려 있고, 쓰지 않고 닫히면 이야기 사이 간격을 앞 이야기 시각으로 돌린다", () => {
    const w = make();
    const before = w.state().lastStoryletAt;
    openImprovSlot(w.ctx());
    const slot = w.state().improvSlot!;
    expect(slot.expiresAt - slot.openedAt).toBe(content.scenario.storylet_pacing.expire_hours * 60);
    expect(w.state().lastStoryletAt).toBe(slot.openedAt);
    w.ctx().store.append({ type: "time_advanced", activity: "wait", from: w.state().time, to: slot.expiresAt + 5 });
    lapseImprovSlot(w.ctx());
    expect(w.state().improvSlot).toBeNull();
    expect(w.state().lastStoryletAt).toBe(before);
  });
});
