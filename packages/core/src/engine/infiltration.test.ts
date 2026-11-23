import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import { loadRealContent } from "../testing.ts";

/** 잠입 장면 (12-154) */
const content = { ...loadRealContent(), storylets: {} };
const make = (roll: number) => {
  const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-infil-")), content, rngFactory: () => () => roll }).create("mcp", "role_a_grunt");
  expect(w.runCheat("~goto c_warehouse").ok).toBe(true);
  return w;
};
type World = ReturnType<typeof make>;
const go = (w: World, action: string, goal: string | null = null, place: string | null = null) => w.executeTool("infiltrate", { action, goal, place });
const text = (o: ReturnType<typeof go>) => (o.ok ? o.resultText : o.error);

describe("잠입", () => {
  it("우리 땅에서는 시작할 수 없다", () => {
    const w = make(0.99);
    expect(w.runCheat("~goto a_base").ok).toBe(true);
    expect(go(w, "start", "steal").ok).toBe(false);
  });

  it("들어가고, 목표를 하고, 아무도 모르게 나온다", () => {
    const w = make(0.99);
    const food = w.state().factions.faction_c!.resources.food!;
    expect(go(w, "start", "steal").ok).toBe(true);
    // 담 안의 장소가 여럿이면 고른다 (B③)
    expect(text(go(w, "advance"))).toContain("place로 고른다");
    const first = go(w, "advance", null, "yard");
    expect(text(first)).toContain("판정 줄");
    expect(w.state().playerPlace).toBe("yard");
    go(w, "advance", null, "command");
    expect(w.state().infiltration?.depth).toBe(2);
    expect(w.state().playerPlace).toBe("command");
    expect(go(w, "advance").ok).toBe(false); // 더 깊은 곳은 없다
    expect(go(w, "act").ok).toBe(true);
    expect(w.state().factions.faction_c!.resources.food).toBe(food - 10);
    expect(w.state().characters[w.state().playerId]!.inventory.canned_food ?? 0).toBeGreaterThanOrEqual(2);
    expect(text(go(w, "leave"))).toContain("아무도 모르게");
    expect(w.state().infiltration).toBeNull();
    expect(w.state().playerPlace).toBeNull();
  });

  it("잠입 중에는 다른 구역으로 옮기지 못한다", () => {
    const w = make(0.99);
    go(w, "start", "eavesdrop");
    const out = w.executeTool("take_action", { intent: "이동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, move_to: "overpass" });
    expect(out.ok).toBe(false);
  });

  it("거듭 실패하면 들키고, 그 뒤로는 빠지기만 되고, 빠지다 실패하면 붙잡힌다", () => {
    const w = make(0);
    go(w, "start", "steal");
    go(w, "advance", null, "yard");
    expect(w.state().infiltration?.alarm).toBe(2);
    const caughtText = text(go(w, "advance", null, "yard"));
    expect(caughtText).toContain("들켰다");
    expect(go(w, "advance", null, "yard").ok).toBe(false);
    go(w, "leave");
    expect(w.state().infiltration).toBeNull();
    expect(w.state().characters[w.state().playerId]!.captive?.by).toBe("faction_c");
  });
});
