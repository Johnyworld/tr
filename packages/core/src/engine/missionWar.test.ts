import { describe, expect, it } from "vitest";
import type { Content } from "../content/schemas.ts";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { createSeededRng } from "../rng.ts";
import { loadRealContent, TEST_CONTENT } from "../testing.ts";
import { advanceParties, arrivalOf } from "../sim/parties.ts";
import { initialWarWorld, simulateWarDay } from "../sim/war.ts";
import { executeTool } from "./tools.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";
import { afterClashes } from "./warTools.ts";

/** 임무와 전쟁 (docs/war-parties-plan.md 파트 11, 움직이는 부대 ③-3) */
describe("임무와 전쟁 (파트 11)", () => {
  const setup = () => {
    const c: Content = structuredClone(TEST_CONTENT);
    for (const f of Object.values(c.factions)) f.aggression = 0;
    c.factions.faction_a!.plans = [{ id: "a_plan", label: "반격 준비", target_rule: "fixed", target: "c_home", days: 9 }];
    c.missions.m_scout!.scouts = true;
    c.missions.m_scout!.advances = { clock: "a_plan", delta: 2 };
    c.missions.m_scout!.sabotages = { faction: "faction_c", take: { food: 30 } };
    const store = new InMemoryGameStore([createWorldEvent(c, "role_test", "world_mission_war")]);
    const ctx = { store, rng: () => 0.99, content: c };
    runAfterTimeAdvance(ctx);
    store.append({ type: "missions_offered", day: 1, templateIds: ["m_scout"] });
    executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" }, ctx);
    executeTool("assign_mission", { template_id: "m_scout" }, ctx);
    const check = (move: string) => ({ move, stat: move === "stealth" ? "agility" : "sense", difficulty: "normal", harm_on_failure: "none", harm_cause: "" });
    const act = (move: string) => ({ intent: "정찰", check: check(move), activity: null, deed: null, target: null, narration_summary: null, for_mission: true });
    executeTool("take_action", act("sense_danger"), ctx);
    executeTool("take_action", act("stealth"), ctx);
    return { c, store, ctx };
  };

  it("해낸 임무의 전쟁 효과를 결과에 한 줄로 알리고, 기여를 클락에 적고, 파괴공작은 적 창고를 깎는다", () => {
    const { store, ctx } = setup();
    const food = store.getState().factions.faction_c!.resources.food!;
    const out = executeTool("report_mission", {}, ctx);
    expect(out.ok && out.resultText).toContain("반격 준비가 앞당겨졌다");
    expect(out.ok && out.resultText).toContain("창고에 구멍을 냈다");
    expect(store.getState().factions.faction_c!.resources.food).toBe(food - 30);
    expect(store.getState().clocks.a_plan!.credits).toEqual([{ by: store.getState().playerId, mission: "고가도로 정찰", scout: true }]);
  });

  it("기여가 적힌 계획의 공세는 기습이 되고, 그 교전에 기여가 실리며, 주인공에게 '덕분에' 소식이 닿는다", () => {
    const real = loadRealContent();
    const w = initialWarWorld(real);
    const clock = w.clocks.a_counteroffensive!;
    clock.filled = clock.max - 1;
    clock.target = "c_warehouse";
    clock.credits = [{ by: "me", mission: "전선 정찰", scout: true }];
    const rng = createSeededRng(3);
    const r = simulateWarDay(w, real, rng, { day: 1, resolveUpTo: 0 });
    const assault = (r.parties ?? []).find((p) => p.kind === "assault" && p.faction === "faction_a")!;
    expect(assault).toBeTruthy();
    expect(assault.task).toMatchObject({ kind: "clash", surprise: true, credits: [{ by: "me", mission: "전선 정찰" }] });
    const world = { ...r };
    const { clashes } = advanceParties(world, real, rng, arrivalOf(assault));
    expect(clashes.find((x) => x.kind === "assault")?.credits).toEqual([{ by: "me", mission: "전선 정찰" }]);
  });

  it("주인공이 앞당긴 공세 소식은 주인공의 일과 이어져 닿는다", () => {
    const { store, ctx } = setup();
    const me = store.getState().playerId;
    const shown = afterClashes(ctx, [{ kind: "assault", attacker: "faction_a", defender: "faction_c", zone: "a_post", success: true, attackerLosses: 0, defenderLosses: 1, credits: [{ by: me, mission: "고가도로 정찰" }] }]);
    expect(shown.some((d) => d.type === "belief" && d.fact.includes("'고가도로 정찰' 덕분에"))).toBe(true);
  });
});

describe("길 위 이야기를 실제 부대에 묶기 (5-2)", () => {
  it("party_near는 이 구역이나 맞닿은 구역에 그 무리 부대가 있을 때만, party_trace_hours는 이 구역에서 부대끼리 부딪친 뒤에만", async () => {
    const { conditionsMet } = await import("../story/storylets.ts");
    const { WorldManager } = await import("../world/manager.ts");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const real = loadRealContent();
    const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-52-")), content: real, rngFactory: () => createSeededRng(1) }).create("mcp", "role_a_grunt");
    const s = w.state();
    const near = { ...real.storylets.rd_hostile_patrol!, when: { party_near: { faction: "faction_c" } } } as typeof real.storylets.rd_hostile_patrol;
    const trace = { ...real.storylets.cr_patrol_traces!, when: { party_trace_hours: 24 } } as typeof real.storylets.cr_patrol_traces;
    const at = { ...s, playerZone: "a_east_post" };
    expect(conditionsMet(at, real, near!, s.time)).toBe(false);
    const p = { id: "pc", faction: "faction_c", kind: "patrol" as const, size: 4, leader: null, home: "c_base", goal: "rail_embankment", legs: [{ zone: "c_base", from: s.time - 60, to: s.time - 60 }, { zone: "rail_embankment", from: s.time - 60, to: s.time + 60 }], task: { kind: "watch" as const }, done: false, back: [], carry: {}, met: [], routedAt: null };
    expect(conditionsMet({ ...at, parties: [p] }, real, near!, s.time)).toBe(true);
    expect(conditionsMet({ ...at, parties: [{ ...p, faction: "faction_b" }] }, real, near!, s.time)).toBe(false);
    expect(conditionsMet(at, real, trace!, s.time)).toBe(false);
    const clash = { kind: "skirmish" as const, attacker: "faction_a", defender: "faction_c", zone: "a_east_post", success: true, attackerLosses: 0, defenderLosses: 1 };
    expect(conditionsMet({ ...at, recentClashes: [{ clash, at: s.time - 60, party: true }] }, real, trace!, s.time)).toBe(true);
    w.close();
  });
});

describe("content:check 부대 이야기 (PT31)", () => {
  it("다른 무리의 부대원이 나오는 길 위·야영 이야기에 party_near가 없으면 잡는다", async () => {
    const { checkPartyStories } = await import("../content/loader.ts");
    const real = loadRealContent();
    expect(checkPartyStories(real)).toEqual([]);
    const broken = structuredClone(real);
    delete (broken.storylets.rd_ambush!.when as { party_near?: unknown }).party_near;
    expect(checkPartyStories(broken).join()).toContain("storylets.rd_ambush");
  });
});
