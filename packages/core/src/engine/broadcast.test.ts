import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import type { GameWorld } from "../world/world.ts";
import { loadRealContent } from "../testing.ts";

/** 무전 송출 (12-173) */
const real = loadRealContent();
const onlyCalls = { ...real, storylets: Object.fromEntries(Object.entries(real.storylets).filter(([, s]) => s.tags.includes("radio_call"))) };
const make = (roll: number, content = onlyCalls) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-radio-")), content, rngFactory: () => () => roll }).create("mcp", "role_l_wanderer");
const send = (w: GameWorld) => w.executeTool("take_action", { intent: "무전으로 부른다", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, broadcast: true });

describe("무전 송출", () => {
  it("무전기가 없으면 송출하지 못한다", () => {
    const w = make(0.1);
    if ((w.state().characters[w.state().playerId]!.inventory.radio ?? 0) > 0) return;
    expect(send(w).ok).toBe(false);
  });

  it("응답이 오면 radio_call 이야기가 열리고 30분이 흐른다. 하루 한 번", () => {
    const w = make(0.1);
    expect(w.runCheat("~give radio 1").ok).toBe(true);
    const t = w.state().time;
    const r = send(w);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().time - t).toBeGreaterThanOrEqual(30);
    const active = w.state().activeStorylet;
    expect(active && real.storylets[active.id]?.tags).toContain("radio_call");
    expect(w.state().lastBroadcastDay).not.toBeNull();
  });

  it("확률에 못 미치면 잡음뿐이다. 같은 날 다시 하지 못한다", () => {
    const w = make(0.99);
    expect(w.runCheat("~give radio 1").ok).toBe(true);
    const r = send(w);
    expect(r.ok && r.resultText).toContain("아무도 응답하지 않았다");
    expect(w.state().activeStorylet).toBeNull();
    expect(send(w).ok).toBe(false);
  });
});
