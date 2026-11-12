import { describe, expect, it } from "vitest";
import type { Content } from "../content/schemas.ts";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { runCommand } from "../commands/commands.ts";
import { createSeededRng } from "../rng.ts";
import { TEST_CONTENT } from "../testing.ts";
import { frontierTarget, initialWarWorld, simulateWarDay } from "../sim/war.ts";
import { describePlayerState } from "./context.ts";
import { executeTool } from "./tools.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";

/** A의 반격 계획(frontier)을 더한 콘텐츠. C는 공격하지 않는다 */
function content(): Content {
  const c = structuredClone(TEST_CONTENT);
  c.factions.faction_a!.plans = [{ id: "a_push", label: "반격 준비", target_rule: "frontier", days: 3 }];
  c.factions.faction_c!.plans = [];
  for (const f of Object.values(c.factions)) f.aggression = 0;
  c.missions.m_scout!.advances = { clock: "a_push", delta: 2 };
  return c;
}

describe("전선 반격", () => {
  it("frontier 목표: 맞닿은 적 구역 중 원래 우리 땅을 먼저, 거점은 고르지 않는다", () => {
    const c = content();
    const w = initialWarWorld(c);
    // a_post를 C가 빼앗았다고 하자 → A가 맞닿은 곳: a_post(잃은 땅), wild(빈 땅). c_home은 거점
    w.zones.a_post = { owner: "faction_c" };
    expect(frontierTarget(w, c, "faction_a")).toBe("a_post");
    w.zones.a_post = { owner: "faction_a" };
    expect(frontierTarget(w, c, "faction_a")).toBe("wild");
  });

  it("클락이 다 차면 그 목표를 친다 (빈 땅이면 차지한다)", () => {
    const c = content();
    let w = initialWarWorld(c);
    w.zones.a_post = { owner: "faction_c" };
    const rng = createSeededRng(2);
    const clashes = [];
    for (let i = 0; i < 3; i++) {
      const r = simulateWarDay(w, c, rng);
      clashes.push(...r.clashes);
      w = r;
    }
    expect(clashes).toContainEqual(expect.objectContaining({ kind: "assault", attacker: "faction_a", zone: "a_post", plan: "a_push" }));
  });

  it("전선 임무를 완수하면 계획이 앞당겨진다", () => {
    const c = content();
    const store = new InMemoryGameStore([createWorldEvent(c, "role_test", "world_test")]);
    const ctx = { store, rng: () => 0.99, content: c };
    runAfterTimeAdvance(ctx);
    store.append({ type: "missions_offered", day: 1, templateIds: ["m_scout"] });
    executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" }, ctx);
    executeTool("assign_mission", { template_id: "m_scout" }, ctx);
    const check = (move: string) => ({ move, stat: move === "stealth" ? "agility" : "sense", difficulty: "normal", harm_on_failure: "none", harm_cause: "" });
    const act = (move: string) => ({ intent: "정찰", check: check(move), activity: null, deed: null, target: null, narration_summary: null, for_mission: true });
    executeTool("take_action", act("sense_danger"), ctx);
    executeTool("take_action", act("stealth"), ctx);
    const before = store.getState().clocks.a_push!.filled;
    const out = executeTool("report_mission", {}, ctx);
    expect(out.ok && out.resultText).toContain("— 완수");
    expect(store.getState().clocks.a_push!.filled).toBe(before + 2);
  });

  it("우리 무리의 계획은 대략으로만 들린다. 다른 무리의 계획은 들리지 않는다", () => {
    const c = content();
    c.factions.faction_c!.plans = [{ id: "c_secret", label: "비밀 공세", target_rule: "fixed", target: "a_post", days: 5 }];
    const store = new InMemoryGameStore([createWorldEvent(c, "role_test", "world_test")]);
    runAfterTimeAdvance({ store, rng: createSeededRng(1), content: c });
    const state = store.getState();
    const text = [describePlayerState(state, c), runCommand("!세력", { state, content: c, summaries: [] })].join("\n");
    expect(text).toContain("반격 준비 — 말만 돈다 (목표는 빈 땅이라는 말)");
    expect(text).toContain("반격 준비: 말만 돈다");
    expect(text).not.toContain("비밀 공세");
    expect(text).not.toMatch(/a_push|0\/3/);
  });
});
