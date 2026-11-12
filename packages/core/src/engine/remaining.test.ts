import { describe, expect, it } from "vitest";
import type { Content } from "../content/schemas.ts";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { hiddenWitnessChance } from "../game/reputation.ts";
import { runCommand } from "../commands/commands.ts";
import { createSeededRng } from "../rng.ts";
import { MINUTES_PER_DAY } from "../rules/time.ts";
import { rollWeather } from "../sim/weather.ts";
import { createTestWorld, TEST_CONTENT } from "../testing.ts";
import { describePlayerState } from "./context.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";

function withWeather(): Content {
  const c = structuredClone(TEST_CONTENT);
  c.scenario.weather = {
    kinds: [
      { id: "clear", label: "맑음", description: "잘 보인다", visibility: 1 },
      { id: "fog", label: "안개", description: "앞이 안 보인다", visibility: 0.4 },
    ],
    by_season: {},
    default: { fog: 1 },
  };
  return c;
}

describe("날씨 (12-3)", () => {
  it("하루에 한 번 정해지고, 같은 시드면 같다", () => {
    const c = withWeather();
    expect(rollWeather(c.scenario, 1, createSeededRng(1))).toBe("fog");
    c.scenario.weather!.default = { clear: 1, fog: 1 };
    const a = [1, 2, 3, 4, 5].map((d) => rollWeather(c.scenario, d, createSeededRng(d)));
    const b = [1, 2, 3, 4, 5].map((d) => rollWeather(c.scenario, d, createSeededRng(d)));
    expect(a).toEqual(b);
  });

  it("세계를 열면 오늘 날씨가 정해지고, 날이 바뀌면 새로 정한다. GM 컨텍스트와 !시간에 보인다", () => {
    const c = withWeather();
    const store = new InMemoryGameStore([createWorldEvent(c, "role_test", "w")]);
    const ctx = { store, rng: createSeededRng(1), content: c };
    runAfterTimeAdvance(ctx);
    expect(store.getState().weather).toEqual({ day: 1, id: "fog" });
    const s = store.getState();
    store.append({ type: "time_advanced", activity: "wait", from: s.time, to: s.time + MINUTES_PER_DAY });
    runAfterTimeAdvance(ctx);
    expect(store.getState().weather?.day).toBe(2);
    expect(describePlayerState(store.getState(), c)).toContain("날씨: 안개 (앞이 안 보인다)");
    expect(runCommand("!시간", { state: store.getState(), content: c, summaries: [] })).toContain("날씨  안개 — 앞이 안 보인다");
  });

  it("시야가 나쁘면 숨은 목격자가 줄어든다", () => {
    const base = { privacy: "semi_private" as const, time: 600, noisy: false, senseStat: 1, stealth: null };
    expect(hiddenWitnessChance({ ...base, visibility: 0.4 })).toBeCloseTo(hiddenWitnessChance(base) * 0.4);
  });
});

describe("계승한 동료의 직전 전황 (P24)", () => {
  it("같은 무리면 지난 하루 우리 무리가 낀 교전을 보고로 듣는다", () => {
    const world = createTestWorld("mcp", () => 0);
    const ctx = world.ctx();
    const s = ctx.store.getState();
    ctx.store.append({
      type: "war_day_simulated",
      day: 2,
      factions: s.factions,
      zones: s.zones,
      clocks: {},
      clashes: [{ kind: "assault", attacker: "faction_c", defender: "faction_a", zone: "a_post", success: true, attackerLosses: 1, defenderLosses: 4 }],
      scheduled: [],
    });
    const deadly = { move: "fight", stat: "strength", difficulty: "hard", harm_on_failure: "heavy", harm_cause: "총상" };
    const act = { intent: "돌격", check: deadly, activity: null, deed: null, target: null, narration_summary: null, for_mission: false };
    for (let i = 0; i < 3 && !world.isPlayerDead(); i++) world.executeTool("take_action", act);
    expect(world.chooseNextCharacter("npc_leader").ok).toBe(true);
    const facts = (world.state().beliefs.npc_leader ?? []).filter((b) => b.topic === "war").map((b) => `${b.source}:${b.fact}`);
    expect(facts).toContain("report:세력 C가 초소를 빼앗았다. 우리 무리 사상자 몇 명.");
  });
});
