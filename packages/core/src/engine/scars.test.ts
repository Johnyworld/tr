import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Rng } from "../rng.ts";
import { WorldManager } from "../world/manager.ts";
import type { GameWorld } from "../world/world.ts";
import { loadRealContent } from "../testing.ts";

/** 몸에 남는 상처 (12-156) */
const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };
const act = (intent: string, extra: Record<string, unknown> = {}) => ({ intent, check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...extra });
const chk = (move: string, stat: string, extra: Record<string, unknown> = {}) => ({ move, stat, difficulty: "normal", harm_on_failure: "none", harm_cause: "", harm_kind: null, infected_source: false, target_harm: "none", distance: "close", ...extra });

function world(): { w: GameWorld; roll: { value: number } } {
  const roll = { value: 0 };
  const rng: Rng = () => roll.value;
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-scar-")), content, rngFactory: () => rng });
  return { w: m.create("mcp", "role_b_guard", choice), roll };
}
const me = (w: GameWorld) => w.state().characters[w.state().playerId]!;
const scars = new Set(content.scenario.scars!.traits.map((x) => x.trait));

describe("몸에 남는 상처", () => {
  it("치명상에 이르는 상처는 상처 종류에 맞는 흔적을 남길 수 있다", () => {
    const { w } = world();
    expect(w.runCheat("~harm me serious").ok).toBe(true);
    const r = w.executeTool("take_action", act("총구를 막는다", { check: chk("fight", "strength", { harm_on_failure: "light", harm_cause: "총에 맞았다", harm_kind: "gunshot" }) }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const got = me(w).traits.filter((t) => scars.has(t));
    expect(got).toHaveLength(1);
    const rule = content.scenario.scars!.traits.find((x) => x.trait === got[0])!;
    expect(rule.wounds.length === 0 || rule.wounds.includes("gunshot")).toBe(true);
    if (r.ok) expect(r.resultText).toContain("흔적");
    w.close();
  });

  it("가벼운 상처는 흔적을 남기지 않는다", () => {
    const { w } = world();
    w.executeTool("take_action", act("칼을 막는다", { check: chk("fight", "strength", { harm_on_failure: "light", harm_cause: "칼", harm_kind: "cut" }) }));
    expect(me(w).conditions.harm).toBe("light");
    expect(me(w).traits.some((t) => scars.has(t))).toBe(false);
    w.close();
  });

  it("한 사람에 max개까지만", () => {
    const { w } = world();
    const max = content.scenario.scars!.max;
    const ids = [...scars].slice(0, max);
    for (const id of ids) expect(w.runCheat(`~trait add ${id}`).ok).toBe(true);
    expect(w.runCheat("~harm me serious").ok).toBe(true);
    w.executeTool("take_action", act("총구를 막는다", { check: chk("fight", "strength", { harm_on_failure: "light", harm_cause: "총", harm_kind: "gunshot" }) }));
    expect(me(w).traits.filter((t) => scars.has(t))).toHaveLength(max);
    w.close();
  });
});
