import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import type { Rng } from "../rng.ts";
import { WorldManager } from "../world/manager.ts";
import type { GameWorld } from "../world/world.ts";

/** 상처 종류와 출혈 (12-91) */
const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };
const act = (intent: string, extra: Record<string, unknown> = {}) => ({ intent, check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...extra });
const chk = (move: string, stat: string, extra: Record<string, unknown> = {}) => ({ move, stat, difficulty: "normal", harm_on_failure: "none", harm_cause: "", harm_kind: null, infected_source: false, target_harm: "none", ...extra });

/** 주사위를 조절할 수 있는 세계: roll.value가 0이면 늘 1, 0.99면 늘 6 */
function world(): { w: GameWorld; roll: { value: number } } {
  const roll = { value: 0.5 };
  const rng: Rng = () => roll.value;
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-bleed-")), content, rngFactory: () => rng });
  return { w: m.create("mcp", "role_b_guard", choice), roll };
}
const me = (w: GameWorld) => w.state().characters[w.state().playerId]!;

describe("상처 종류와 출혈", () => {
  it("몸의 위험을 걸면 상처 종류를 골라야 한다", () => {
    const { w } = world();
    const r = w.executeTool("take_action", act("덤빈다", { check: chk("fight", "strength", { harm_on_failure: "light", harm_cause: "칼", harm_kind: null }) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("harm_kind");
    const bad = w.executeTool("take_action", act("덤빈다", { check: chk("fight", "strength", { harm_on_failure: "light", harm_cause: "칼", harm_kind: "laser" }) }));
    expect(bad.ok).toBe(false);
    w.close();
  });

  it("날붙이에 크게 다치면 피가 나고, 둔기는 피가 나지 않는다", () => {
    const { w, roll } = world();
    roll.value = 0;
    const r = w.executeTool("take_action", act("칼을 막는다", { check: chk("fight", "strength", { harm_on_failure: "heavy", harm_cause: "칼에 베였다", harm_kind: "cut" }) }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(me(w).conditions.harm).toBe("serious");
    expect(me(w).conditions.bleeding).toBe("bleeding");
    if (r.ok) expect(r.resultText).toContain("지혈하지 않으면");
    expect(w.sceneForGm()).toContain("피를 흘리고 있다");
    w.close();

    const blunt = world();
    blunt.roll.value = 0;
    blunt.w.executeTool("take_action", act("몽둥이를 막는다", { check: chk("fight", "strength", { harm_on_failure: "heavy", harm_cause: "몽둥이", harm_kind: "blunt" }) }));
    expect(me(blunt.w).conditions.harm).toBe("serious");
    expect(me(blunt.w).conditions.bleeding).toBe("none");
    blunt.w.close();
  });

  it("지혈하지 않으면 시간이 흐르며 부상이 깊어지고 저절로 낫지 않는다. 긁힘은 저절로 멎는다", () => {
    const { w } = world();
    expect(w.runCheat("~harm me serious").ok).toBe(true);
    expect(w.runCheat("~set bleeding bleeding").ok).toBe(true);
    expect(w.runCheat("~time +7h").ok).toBe(true);
    expect(me(w).conditions.harm).toBe("critical");
    expect(me(w).conditions.bleeding).toBe("bleeding");
    w.close();

    const s = world();
    expect(s.w.runCheat("~set bleeding scratch").ok).toBe(true);
    expect(s.w.runCheat("~time +2h").ok).toBe(true);
    expect(me(s.w).conditions.bleeding).toBe("none");
    s.w.close();
  });

  it("붕대로 멎는다", () => {
    const { w } = world();
    w.runCheat("~harm me serious");
    w.runCheat("~set bleeding heavy");
    expect(w.runCheat("~give bandage").ok).toBe(true);
    const r = w.executeTool("take_action", act("붕대를 감는다", { treatment: { item: "bandage", target: null } }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(me(w).conditions.bleeding).toBe("none");
    w.close();
  });

  it("맨손 지혈은 응급처치 판정으로: 판정 없이는 안 되고, 성공하면 멎고, 대가 있는 성공이면 한 단계 준다", () => {
    const { w, roll } = world();
    w.runCheat("~set bleeding heavy");
    const none = w.executeTool("take_action", act("옷을 찢어 누른다", { treatment: { item: null, target: null } }));
    expect(none.ok).toBe(true);
    if (none.ok) expect(none.resultText).toContain("first_aid");
    roll.value = 0.99;
    const r = w.executeTool("take_action", act("옷을 찢어 누른다", { treatment: { item: null, target: null }, check: chk("first_aid", "intellect") }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(me(w).conditions.bleeding).toBe("none");
    w.close();
  });

  it("피를 흘리며 의식을 잃으면 6시간이 지나도 깨어나지 못하고, 곁의 사람이 돌보면 피부터 멎는다", () => {
    const { w } = world();
    w.runCheat("~harm me unconscious");
    w.runCheat("~set bleeding bleeding");
    // 곁의 사람 규칙이 개입하지 않게 이미 정한 것으로
    w.ctx().store.append({ type: "helpless_resolved", outcome: "none", by: null });
    expect(w.runCheat("~time +5h").ok).toBe(true);
    expect(me(w).conditions.harm).toBe("unconscious");
    // 6시간이 되면 피를 흘려 죽는다 (의식불명 → 사망)
    w.runCheat("~time +2h");
    expect(me(w).dead).toBe(true);
    w.close();

    const helped = world();
    helped.w.runCheat("~goto subway_hub");
    helped.w.runCheat("~summon b_myeongsuk");
    helped.w.runCheat("~harm me unconscious");
    helped.w.runCheat("~set bleeding heavy");
    helped.w.executeTool("take_action", act("의식이 없다", { activity: { kind: "wait", until: null } }));
    expect(me(helped.w).conditions.bleeding).toBe("none");
    expect(me(helped.w).conditions.harm).toBe("impaired");
    helped.w.close();
  });
});
