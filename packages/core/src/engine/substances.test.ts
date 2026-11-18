import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Rng } from "../rng.ts";
import { WorldManager } from "../world/manager.ts";
import type { GameWorld } from "../world/world.ts";
import { loadRealContent } from "../testing.ts";
import { conditionPenalty } from "../scenario/scenario.ts";

/** 술·진통제·각성제: 기운, 가리기, 의존, 끊기 (12-157) */
const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };
const act = (intent: string, extra: Record<string, unknown> = {}) => ({ intent, check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...extra });

function world(): { w: GameWorld; roll: { value: number } } {
  const roll = { value: 0.99 };
  const rng: Rng = () => roll.value;
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-subst-")), content, rngFactory: () => rng });
  return { w: m.create("mcp", "role_b_guard", choice), roll };
}
const me = (w: GameWorld) => w.state().characters[w.state().playerId]!;
const use = (w: GameWorld, item: string) => w.executeTool("take_action", act(`${item}을 쓴다`, { use_item: item }));

describe("술·진통제·각성제", () => {
  it("진통제는 몇 시간 동안 고통의 보정을 가리고, 기운이 빠지면 돌아온다", () => {
    const { w } = world();
    expect(w.runCheat("~harm me serious").ok).toBe(true);
    const before = conditionPenalty(content.scenario, me(w));
    expect(before).toBeLessThan(0);
    expect(w.runCheat("~give painkiller").ok).toBe(true);
    const r = use(w, "painkiller");
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(me(w).conditions.numb).toBe("numbed");
    expect(conditionPenalty(content.scenario, me(w))).toBeGreaterThan(before);
    expect(me(w).conditions.harm).toBe("serious"); // 상처는 그대로
    expect(w.runCheat("~time +5h").ok).toBe(true);
    w.executeTool("take_action", act("주위를 둘러본다"));
    expect(me(w).conditions.numb).toBe("none");
    w.close();
  });

  it("술은 나아질 데가 없어도 마실 수 있고, 취하면 판정이 어려워진다", () => {
    const { w } = world();
    expect(w.runCheat("~give moonshine").ok).toBe(true);
    const r = use(w, "moonshine");
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(me(w).conditions.drink).toBe("drunk");
    expect(conditionPenalty(content.scenario, me(w))).toBe(-1);
    w.close();
  });

  it("쓸 때마다 확률로 버릇이 붙는다", () => {
    const { w, roll } = world();
    roll.value = 0;
    expect(w.runCheat("~give morphine").ok).toBe(true);
    const r = use(w, "morphine");
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(me(w).traits).toContain("pill_habit");
    if (r.ok) expect(r.resultText).toContain("진통제 의존");
    w.close();
  });

  it("버릇의 끝 단계를 quit_days 동안 버티면 끊는다", () => {
    const { w } = world();
    expect(w.runCheat("~trait add pill_habit").ok).toBe(true);
    const quit = content.scenario.traits.find((t) => t.id === "pill_habit")!.effects.habit!.quit_days!;
    expect(w.runCheat("~time +1d").ok).toBe(true);
    expect(w.runCheat("~time +1d").ok).toBe(true);
    expect(me(w).conditions.craving_pills).toBe("withdrawal");
    expect(me(w).dead).toBe(false);
    for (let i = 0; i < quit; i++) {
      w.runCheat("~set thirst quenched");
      w.runCheat("~set hunger fed");
      expect(w.runCheat("~time +1d").ok).toBe(true);
    }
    expect(me(w).traits).not.toContain("pill_habit");
    expect(me(w).conditions.craving_pills).toBe("satisfied");
    w.close();
  });
});
