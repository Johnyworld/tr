import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { createSeededRng, type Rng } from "../rng.ts";
import { eligibleStorylets } from "../story/storylets.ts";
import { WorldManager } from "../world/manager.ts";
import { carriedWeight, carryCapacity, encumbrance, equippedItem, gearModifiers } from "./gear.ts";

/** 물건 (기획서 4.8) */
const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const act = (intent: string, extra: Record<string, unknown> = {}) => ({ intent, check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...extra });
const choice = { name: "서진", gender: "female" as const, abilities: { strength: 0, agility: 1, senses: 1, nerve: 1 }, portrait: null, traits: [] };
const chk = (move: string, stat: string, extra: Record<string, unknown> = {}) => ({ move, stat, difficulty: "normal", harm_on_failure: "none", harm_cause: "", infected_source: false, target_harm: "none", ...extra });

function open(roleId = "role_a_grunt", rng: () => Rng = () => createSeededRng(3)) {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-gear-")), content, rngFactory: rng });
  const w = m.create("mcp", roleId, choice);
  w.runCheat("~time +8h");
  return w;
}
type World = ReturnType<typeof open>;
const me = (w: World) => w.state().characters[w.state().playerId]!;
const give = (w: World, item: string, quantity = 1) => w.ctx().store.append({ type: "item_granted", to: w.state().playerId, itemId: item, quantity });
const spawnFoe = (w: World) => {
  w.executeTool("spawn_extra", { template: "refugee", label: "떠돌이" });
  return w.state().scene.present.at(-1)!;
};

describe("무기와 탄약", () => {
  it("시작하면 가진 무기를 손에 든다. 분대장은 탄약이 있는 소총", () => {
    expect(equippedItem(me(open()), "weapon")).toBe("kitchen_knife");
    expect(equippedItem(me(open("role_a_squad_leader")), "weapon")).toBe("old_rifle");
  });

  it("부엌칼로는 무거운 피해를 노릴 수 없고, 맨손으로는 쏠 수 없다", () => {
    const w = open();
    const foe = spawnFoe(w);
    const heavy = w.executeTool("take_action", act("찌른다", { target: foe, check: chk("fight", "strength", { target_harm: "heavy" }) }));
    expect(heavy.ok).toBe(false);
    const shoot = w.executeTool("take_action", act("쏜다", { target: foe, check: chk("shoot", "agility", { target_harm: "light" }) }));
    expect(shoot.ok).toBe(false);
    expect(w.executeTool("take_action", act("찌른다", { target: foe, check: chk("fight", "strength", { target_harm: "light" }) })).ok).toBe(true);
  });

  it("총은 쏠 때마다 탄약을 쓰고, 총소리는 구역의 소음이 되어 물결을 부른다", () => {
    const w = open("role_a_squad_leader");
    w.runCheat("~goto old_town");
    const foe = spawnFoe(w);
    const before = me(w).inventory.rifle_rounds!;
    const r = w.executeTool("take_action", act("쏜다", { target: foe, check: chk("shoot", "agility", { target_harm: "heavy" }) }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(me(w).inventory.rifle_rounds ?? 0).toBe(before - 1);
    expect(r.ok && r.resultText).toContain("총소리가 멀리 퍼졌다");
    expect(w.state().zoneNoise.old_town?.level).toBeGreaterThanOrEqual(2);
    expect(eligibleStorylets(w.state(), w.content).map((s) => s.id)).toContain("wg_gunshot_wave");
  });

  it("탄약이 떨어지면 쏠 수 없지만, 개머리판으로는 칠 수 있다", () => {
    const w = open("role_a_squad_leader");
    w.ctx().store.append({ type: "item_consumed", holder: "player", itemId: "rifle_rounds", quantity: 3 });
    const foe = spawnFoe(w);
    expect(w.executeTool("take_action", act("쏜다", { target: foe, check: chk("shoot", "agility", { target_harm: "heavy" }) })).ok).toBe(false);
    expect(w.executeTool("take_action", act("개머리판으로 친다", { target: foe, check: chk("fight", "strength", { target_harm: "light" }) })).ok).toBe(true);
  });

  it("무기로 공격하다 실패하면 닳고, 다 닳으면 망가져 고철이 남는다 (주사위가 늘 1)", () => {
    const w = open("role_a_grunt", () => () => 0);
    const foe = spawnFoe(w);
    for (let i = 0; i < 6; i++) w.executeTool("take_action", act("찌른다", { target: foe, check: chk("fight", "strength", { target_harm: "light" }) }));
    expect(me(w).inventory.kitchen_knife ?? 0).toBe(0);
    expect(me(w).inventory.scrap_metal).toBe(1);
    expect(equippedItem(me(w), "weapon")).toBeNull();
  });
});

describe("방어구와 도구", () => {
  it("방탄 조끼는 받는 피해를 한 단계 줄이고 닳는다. 입으면 은밀이 불리하다 (주사위가 늘 1)", () => {
    const w = open("role_a_grunt", () => () => 0);
    give(w, "kevlar_vest");
    expect(w.executeTool("equip", { item_id: "kevlar_vest", slot: null }).ok).toBe(true);
    expect(gearModifiers(w.content, me(w), "stealth").penalty).toBe(-1);
    const r = w.executeTool("take_action", act("뛰어든다", { check: chk("endure", "vitality", { harm_on_failure: "heavy", harm_cause: "총상" }) }));
    expect(r.ok && r.resultText).toContain("방탄 조끼이(가) 피해를 1단계 막았다");
    expect(me(w).wear.kevlar_vest).toBe(1);
  });

  it("지닌 도구는 판정에 보정을 준다 (쇠지렛대로 뒤지기, 쌍안경으로 살피기)", () => {
    const w = open();
    expect(gearModifiers(w.content, me(w), "scavenge").skill).toBe(0);
    give(w, "crowbar");
    expect(gearModifiers(w.content, me(w), "scavenge").skill).toBe(1);
  });
});

describe("무게", () => {
  it("들 수 있는 무게를 넘으면 은밀·근접이 불리하고, 너무 무거우면 옮겨 가지 못하고 더 받지 못한다", () => {
    const w = open();
    expect(carryCapacity(w.content, me(w))).toBe(12);
    expect(encumbrance(w.content, me(w))).toBe(0);
    give(w, "scrap_metal", 11); // 지닌 것 1.8kg + 11kg
    expect(encumbrance(w.content, me(w))).toBe(1);
    expect(gearModifiers(w.content, me(w), "stealth").penalty).toBe(-1);
    give(w, "scrap_metal", 7);
    expect(carriedWeight(w.content, me(w))).toBeGreaterThan(18);
    expect(encumbrance(w.content, me(w))).toBe(2);
    expect(w.executeTool("take_action", act("구시가로 간다", { move_to: "old_town" })).ok).toBe(false);
    expect(w.executeTool("transfer_item", { from: "player", to: "scene", item_id: "scrap_metal", quantity: 10 }).ok).toBe(true);
    expect(w.executeTool("take_action", act("구시가로 간다", { move_to: "old_town" })).ok).toBe(true);
  });
});

describe("수리와 제작", () => {
  it("재료와 도구가 있으면 재생탄을 만든다 (주사위가 늘 6). 도구가 없으면 못 만든다", () => {
    const w = open("role_a_grunt", () => () => 0.999);
    give(w, "casings", 2);
    give(w, "gunpowder", 1);
    const craft = { recipe: "reload_rounds", repair: null };
    expect(w.executeTool("take_action", act("탄을 만든다", { check: chk("mechanics", "intellect"), craft })).ok).toBe(false);
    give(w, "toolkit");
    const r = w.executeTool("take_action", act("탄을 만든다", { check: chk("mechanics", "intellect"), craft }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(me(w).inventory.rifle_rounds).toBe(3);
    expect(me(w).inventory.casings ?? 0).toBe(0);
  });

  it("닳은 무기를 고친다", () => {
    const w = open("role_a_grunt", () => () => 0.999);
    w.ctx().store.append({ type: "item_worn", characterId: "player", itemId: "kitchen_knife", delta: 3 });
    give(w, "scrap_metal");
    // 칼·총은 손질로 고친다
    expect(w.executeTool("take_action", act("칼을 간다", { check: chk("mechanics", "intellect"), craft: { recipe: null, repair: "kitchen_knife" } })).ok).toBe(false);
    const r = w.executeTool("take_action", act("칼을 간다", { check: chk("maintenance", "intellect"), craft: { recipe: null, repair: "kitchen_knife" } }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(me(w).wear.kitchen_knife ?? 0).toBe(0);
  });
});

describe("값과 흥정", () => {
  function atMerchant(rng: () => Rng = () => createSeededRng(3)) {
    const w = open("role_e_porter", rng);
    w.executeTool("npc_presence", { npc_id: "e_bongsu", action: "enter" });
    return w;
  }

  it("넉넉하면 그냥 바꾸고, 턱없이 모자라면 거절한다. 상인은 값을 더 받는다", () => {
    const w = atMerchant();
    give(w, "cigarettes", 6);
    // 통조림 하나(3) × 상인 1.25 = 4 → 담배 둘(4)이면 된다
    const ok = w.executeTool("barter", { npc_id: "e_bongsu", give: { cigarettes: 2 }, get: { canned_food: 1 }, move: null, stat: null });
    expect(ok.ok && ok.resultText).toContain("바꿨다");
    const no = w.executeTool("barter", { npc_id: "e_bongsu", give: { cigarettes: 1 }, get: { canned_food: 2 }, move: null, stat: null });
    expect(no.ok && no.resultText).toContain("턱없이 모자란다");
  });

  it("조금 모자라면 흥정 판정을 해야 한다 (주사위가 늘 6)", () => {
    const w = atMerchant(() => () => 0.999);
    give(w, "cigarettes", 6);
    expect(w.executeTool("barter", { npc_id: "e_bongsu", give: { cigarettes: 3 }, get: { canned_food: 2 }, move: null, stat: null }).ok).toBe(false);
    const r = w.executeTool("barter", { npc_id: "e_bongsu", give: { cigarettes: 3 }, get: { canned_food: 2 }, move: "persuade", stat: "charm" });
    expect(r.ok && r.resultText).toContain("바꿨다");
  });

  it("상인은 날마다 물건을 다시 채운다", () => {
    const w = atMerchant();
    give(w, "cigarettes", 20);
    w.executeTool("barter", { npc_id: "e_bongsu", give: { cigarettes: 15 }, get: { canned_food: 2, rifle_rounds: 2 }, move: null, stat: null });
    const left = w.state().characters.e_bongsu!.inventory.canned_food ?? 0;
    w.runCheat("~time +1d");
    expect(w.state().characters.e_bongsu!.inventory.canned_food).toBeGreaterThan(left);
    expect(w.state().characters.e_bongsu!.inventory.canned_food).toBe(8);
  });
});

describe("급조와 손질", () => {
  it("급조로 사제 무기·방어구를 만든다: 손목 보호대는 팔에 차서 물림을 막는다 (주사위가 늘 6)", () => {
    const w = open("role_a_grunt", () => () => 0.999);
    give(w, "cloth");
    give(w, "scrap_metal");
    give(w, "duct_tape");
    expect(w.executeTool("take_action", act("보호대를 감는다", { check: chk("carpentry", "intellect"), craft: { recipe: "arm_guards", repair: null } })).ok).toBe(false);
    const r = w.executeTool("take_action", act("보호대를 감는다", { check: chk("improvise", "intellect"), craft: { recipe: "arm_guards", repair: null } }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.executeTool("equip", { item_id: "arm_guards", slot: null }).ok).toBe(true);
    expect(equippedItem(me(w), "arms")).toBe("arm_guards");
  });

  it("배낭 틀을 지니면 더 들 수 있다", () => {
    const w = open();
    const before = carryCapacity(w.content, me(w));
    give(w, "pack_frame");
    expect(carryCapacity(w.content, me(w))).toBe(before + 6);
  });

  it("손질을 잘하면 무기가 덜 닳는다 (주사위가 늘 1: 공격은 실패하지만 손질 2는 닳음을 피한다)", () => {
    const w = open("role_a_grunt", () => () => 0);
    const foe = spawnFoe(w);
    const swing = () => w.executeTool("take_action", act("찌른다", { target: foe, check: chk("fight", "strength", { target_harm: "light" }) }));
    swing();
    expect(me(w).wear.kitchen_knife).toBe(1);
    w.runCheat("~skill maintenance 2");
    swing();
    swing();
    expect(me(w).wear.kitchen_knife).toBe(1);
  });
});
