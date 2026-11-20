import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Rng } from "../rng.ts";
import { WorldManager } from "../world/manager.ts";
import type { GameWorld } from "../world/world.ts";
import { loadRealContent } from "../testing.ts";

/** 수술: 치명상 이상을 돌보는 것은 판정이다 (12-159) */
const content = { ...loadRealContent(), storylets: {} };
const act = (intent: string, extra: Record<string, unknown> = {}) => ({ intent, check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...extra });
const chk = (move: string, stat: string) => ({ move, stat, difficulty: "normal", harm_on_failure: "none", harm_cause: "", harm_kind: null, infected_source: false, target_harm: "none", distance: "close" });

function world(): { w: GameWorld; roll: { value: number } } {
  const roll = { value: 0.99 };
  const rng: Rng = () => roll.value;
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-surgery-")), content, rngFactory: () => rng });
  return { w: m.create("mcp", "role_a_grunt"), roll };
}
const me = (w: GameWorld) => w.state().characters[w.state().playerId]!;
const treat = (w: GameWorld) => w.executeTool("take_action", act("치료를 받는다", { treatment: { item: null, target: null } }));

describe("수술", () => {
  it("치명상이면 치료사가 굴리고, 잘되면 한 단계 낫는다", () => {
    const { w } = world();
    expect(w.runCheat("~harm me critical").ok).toBe(true);
    expect(w.runCheat("~summon a_chaewon").ok).toBe(true);
    const r = treat(w);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    if (r.ok) expect(r.resultText).toContain("🩺 수술");
    expect(me(w).conditions.harm).toBe("serious");
  });

  it("거점 의무실의 수술은 잘못돼도 상처가 깊어지지 않고, 그날 치료는 받은 것으로 친다 (플레이 테스트 13)", () => {
    const { w, roll } = world();
    expect(w.runCheat("~harm me critical").ok).toBe(true);
    expect(w.runCheat("~summon a_chaewon").ok).toBe(true);
    roll.value = 0;
    const r = treat(w);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    if (r.ok) expect(r.resultText).toContain("뜻대로 되지 않았다");
    expect(me(w).conditions.harm).toBe("critical");
    const again = treat(w);
    expect(again.ok && again.resultText).not.toContain("🩺");
  });

  it("중상까지는 굴리지 않는다", () => {
    const { w } = world();
    expect(w.runCheat("~harm me serious").ok).toBe(true);
    expect(w.runCheat("~summon a_chaewon").ok).toBe(true);
    const r = treat(w);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resultText).not.toContain("🩺");
    expect(me(w).conditions.harm).toBe("light");
  });

  it("주인공이 치명상인 사람을 돌보려면 수술을 배웠어야 하고, 수술 판정이 있어야 한다", () => {
    const { w } = world();
    expect(w.runCheat("~skill first_aid 2").ok).toBe(true);
    expect(w.runCheat("~summon a_chaewon").ok).toBe(true);
    expect(w.runCheat("~harm a_chaewon critical").ok).toBe(true);
    expect(w.runCheat("~set bleeding none a_chaewon").ok).toBe(true);
    const untrained = w.executeTool("take_action", act("상처를 꿰맨다", { treatment: { item: null, target: "a_chaewon" }, check: chk("first_aid", "intellect") }));
    expect(!untrained.ok && untrained.error).toContain("수술을 배우지 않아");
    expect(w.runCheat("~skill surgery 1").ok).toBe(true);
    const no = w.executeTool("take_action", act("상처를 꿰맨다", { treatment: { item: null, target: "a_chaewon" } }));
    expect(!no.ok && no.error).toContain("check(move: surgery)");
    expect(w.state().characters.a_chaewon!.conditions.harm).toBe("critical");
    const r = w.executeTool("take_action", act("상처를 꿰맨다", { treatment: { item: null, target: "a_chaewon" }, check: chk("surgery", "intellect") }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().characters.a_chaewon!.conditions.harm).toBe("serious");
  });
});
