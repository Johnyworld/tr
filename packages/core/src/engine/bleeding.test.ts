import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Rng } from "../rng.ts";
import { WorldManager } from "../world/manager.ts";
import { armorBlocksInfection } from "./gear.ts";
import type { GameWorld } from "../world/world.ts";
import { loadRealContent, teachSkills } from "../testing.ts";

/** 상처 종류와 출혈 (12-91) */
const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };
const act = (intent: string, extra: Record<string, unknown> = {}) => ({ intent, check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...extra });
const chk = (move: string, stat: string, extra: Record<string, unknown> = {}) => ({ move, stat, difficulty: "normal", harm_on_failure: "none", harm_cause: "", harm_kind: null, infected_source: false, target_harm: "none", distance: "close", ...extra });

/** 주사위를 조절할 수 있는 세계: roll.value가 0이면 늘 1, 0.99면 늘 6 */
function world(): { w: GameWorld; roll: { value: number } } {
  const roll = { value: 0.5 };
  const rng: Rng = () => roll.value;
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-bleed-")), content, rngFactory: () => rng });
  const w = m.create("mcp", "role_b_guard", choice);
  // 응급처치는 전문 기술이라 배워 둔다 (4.2.1)
  teachSkills(w, ["first_aid"]);
  return { w, roll };
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
    // 부상이 깊어진 만큼 출혈도 심해진다 (치명상 → 심한 출혈)
    expect(me(w).conditions.bleeding).toBe("heavy");
    w.close();

    const s = world();
    expect(s.w.runCheat("~set bleeding scratch").ok).toBe(true);
    expect(s.w.runCheat("~time +2h").ok).toBe(true);
    expect(me(s.w).conditions.bleeding).toBe("none");
    s.w.close();
  });

  it("붕대로 하는 응급처치: 판정 없이는 안 되고, 성공하면 피가 멎고 상처가 한 단계 낫고 붕대를 쓴다", () => {
    const { w, roll } = world();
    w.runCheat("~harm me serious");
    w.runCheat("~set bleeding heavy");
    expect(w.runCheat("~give bandage").ok).toBe(true);
    const bare = w.executeTool("take_action", act("붕대를 감는다", { treatment: { item: "bandage", target: null } }));
    expect(bare.ok).toBe(false);
    roll.value = 0.99;
    const r = w.executeTool("take_action", act("붕대를 감는다", { treatment: { item: "bandage", target: null }, check: chk("first_aid", "intellect") }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(me(w).conditions.bleeding).toBe("none");
    expect(me(w).inventory.bandage ?? 0).toBe(0);
    expect(me(w).conditions.harm).toBe("light");
    w.close();
  });

  it("맨손 지혈은 응급처치 판정으로: 판정 없이는 안 되고, 성공하면 멎고, 대가 있는 성공이면 한 단계 준다", () => {
    const { w, roll } = world();
    w.runCheat("~set bleeding heavy");
    const none = w.executeTool("take_action", act("옷을 찢어 누른다", { treatment: { item: null, target: null } }));
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toContain("first_aid");
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

  it("NPC도 흘린다: 날붙이로 친 상처는 피가 나고 맨손은 나지 않는다. 장면에 두면 깊어지고, 맨손 지혈로 멎게 할 수 있다", () => {
    const { w, roll } = world();
    w.runCheat("~goto subway_hub");
    w.runCheat("~summon c_cheolgu");
    w.runCheat("~give machete");
    expect(w.executeTool("equip", { item_id: "machete", slot: null }).ok).toBe(true);
    roll.value = 0.99;
    const hit = w.executeTool("take_action", act("마체테를 휘두른다", { target: "c_cheolgu", check: chk("fight", "strength", { target_harm: "heavy" }) }));
    expect(hit.ok, hit.ok ? "" : hit.error).toBe(true);
    const npc = () => w.state().characters.c_cheolgu!;
    expect(npc().conditions.harm).toBe("serious");
    expect(npc().conditions.bleeding).toBe("bleeding");
    // 장면에 둔 채 시간이 흐르면 깊어진다
    w.runCheat("~time +7h");
    expect(npc().conditions.harm).toBe("critical");
    expect(npc().conditions.bleeding).toBe("heavy");
    // 응급처치 판정으로 남의 피를 멎게 한다
    const aid = w.executeTool("take_action", act("옷을 찢어 상처를 누른다", { treatment: { item: null, target: "c_cheolgu" }, check: chk("first_aid", "intellect") }));
    expect(aid.ok, aid.ok ? "" : aid.error).toBe(true);
    expect(npc().conditions.bleeding).toBe("none");
    w.close();

    const fist = world();
    fist.w.runCheat("~goto subway_hub");
    fist.w.runCheat("~summon c_cheolgu");
    fist.w.executeTool("equip", { item_id: null, slot: "weapon" });
    fist.roll.value = 0.99;
    fist.w.executeTool("take_action", act("주먹을 날린다", { target: "c_cheolgu", check: chk("fight", "strength", { target_harm: "light" }) }));
    expect(fist.w.state().characters.c_cheolgu!.conditions.harm).toBe("light");
    expect(fist.w.state().characters.c_cheolgu!.conditions.bleeding).toBe("none");
    fist.w.close();
  });

  it("장면 밖의 무리 사람은 동료가 지혈한다", () => {
    const { w } = world();
    w.runCheat("~set bleeding heavy c_cheolgu");
    w.runCheat("~time +1h");
    expect(w.state().characters.c_cheolgu!.conditions.bleeding).toBe("none");
    expect(w.state().characters.c_cheolgu!.conditions.harm).toBe("none");
    w.close();
  });

  it("감염체: 종류를 비우면 물림·할큄으로 보고 피가 나며 감염을 굴린다. 넘어뜨려 생긴 둔기 상처로는 감염되지 않는다", () => {
    const bite = world();
    bite.roll.value = 0;
    {
      const r = bite.w.executeTool("take_action", act("감염체를 밀어낸다", { check: chk("fight", "strength", { harm_on_failure: "heavy", harm_cause: "감염체에게 물렸다", infected_source: true }) }));
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
    }
    expect(me(bite.w).conditions.bleeding).toBe("bleeding");
    expect(me(bite.w).conditions.infection).toBe("incubating");
    bite.w.close();

    const shove = world();
    shove.roll.value = 0;
    shove.w.executeTool("take_action", act("감염체를 밀어낸다", { check: chk("fight", "strength", { harm_on_failure: "heavy", harm_cause: "감염체에게 떠밀려 넘어졌다", harm_kind: "blunt", infected_source: true }) }));
    expect(me(shove.w).conditions.harm).toBe("serious");
    expect(me(shove.w).conditions.infection).toBe("clean");
    shove.w.close();
  });

  it("방어구는 덮는 곳마다 따로 물림을 막고(가죽 재킷 0.6, 손목 보호대 0.5), 막아 낸 것은 닳는다", () => {
    const { w } = world();
    w.runCheat("~give leather_jacket");
    w.runCheat("~give arm_guards");
    expect(w.executeTool("equip", { item_id: "leather_jacket", slot: null }).ok).toBe(true);
    expect(w.executeTool("equip", { item_id: "arm_guards", slot: null }).ok).toBe(true);
    /** 굴림을 차례로 (손질로 닳음을 피하는 굴림 0.99 포함) */
    const blocks = (...rolls: number[]) => armorBlocksInfection({ ...w.ctx(), rng: () => rolls.shift() ?? 0.99 });
    // 재킷이 뚫리고(0.7) 손목 보호대가 막는다(0.3): 보호대가 닳는다
    const r = blocks(0.7, 0.3, 0.99);
    expect(r.blocked).toBe(true);
    expect(r.lines[0]).toContain("손목 보호대");
    expect(w.state().characters[w.state().playerId]!.wear.arm_guards).toBe(1);
    // 둘 다 뚫린다
    expect(blocks(0.7, 0.6).blocked).toBe(false);
    w.close();
  });
});
