import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import type { GameWorld } from "../world/world.ts";
import { gearModifiers, planCraft } from "./gear.ts";
import { loadRealContent } from "../testing.ts";

/** 사거리 (12-93): 상대와의 거리에 따라 닿는지와 판정 보정 */
const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };
const act = (intent: string, extra: Record<string, unknown> = {}) => ({ intent, check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...extra });
const strike = (move: string, stat: string, distance: string | null, harm = "light") => ({
  move,
  stat,
  difficulty: "normal",
  harm_on_failure: "none",
  harm_cause: "",
  harm_kind: null,
  infected_source: false,
  target_harm: harm,
  distance,
});

function armed(weapon: string | null, ammo?: string): GameWorld {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-range-")), content, rngFactory: () => () => 0.5 });
  const w = m.create("mcp", "role_b_guard", choice);
  w.runCheat("~goto subway_hub");
  w.runCheat("~summon c_cheolgu");
  if (weapon) {
    w.runCheat(`~give ${weapon}`);
    if (ammo) w.runCheat(`~give ${ammo} 3`);
    expect(w.executeTool("equip", { item_id: weapon, slot: null }).ok).toBe(true);
  } else w.executeTool("equip", { item_id: null, slot: "weapon" });
  return w;
}
const hit = (w: GameWorld, check: ReturnType<typeof strike>) => (lastResult = w.executeTool("take_action", act("친다", { target: "c_cheolgu", check })));
/** 그 판정의 장비·거리 보정 (판정 표시에서) */
let lastResult: ReturnType<GameWorld["executeTool"]> | null = null;
const lastGear = (_w: GameWorld) => {
  const r = lastResult!;
  if (!r.ok) throw new Error(r.error);
  const d = [r.display, ...(r.extra ?? [])].find((x) => x.type === "check");
  return d && d.type === "check" ? d.modifiers.gear : undefined;
};

describe("사거리", () => {
  it("장면의 인물을 치면 거리를 골라야 하고, 근접은 맞붙어야 한다", () => {
    const w = armed("machete");
    const none = hit(w, strike("fight", "strength", null));
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toContain("check.distance");
    const near = hit(w, strike("fight", "strength", "near"));
    expect(near.ok).toBe(false);
    if (!near.ok) expect(near.error).toContain("칠 수 없다");
    expect(hit(w, strike("fight", "strength", "close")).ok).toBe(true);
    w.close();
  });

  it("엽총은 맞붙으면 +1, 가까우면 0, 멀면 닿지 않는다", () => {
    const w = armed("shotgun", "shells");
    expect(hit(w, strike("shoot", "agility", "close")).ok).toBe(true);
    expect(lastGear(w)).toBe(1);
    expect(hit(w, strike("shoot", "agility", "near")).ok).toBe(true);
    expect(lastGear(w)).toBe(0);
    expect(hit(w, strike("shoot", "agility", "far")).ok).toBe(false);
    w.close();
  });

  it("소총은 멀리서도 쏘고, 맞붙으면 -1", () => {
    const w = armed("old_rifle", "rifle_rounds");
    expect(hit(w, strike("shoot", "agility", "far")).ok).toBe(true);
    expect(lastGear(w)).toBe(0);
    expect(hit(w, strike("shoot", "agility", "close")).ok).toBe(true);
    expect(lastGear(w)).toBe(-1);
    w.close();
  });

  it("나무 활: 화살로 가까운 거리까지, 가벼운 피해까지만. 양궁 활은 멀리서도 (-1) 무거운 피해까지", () => {
    const bow = armed("wooden_bow", "arrows");
    expect(hit(bow, strike("shoot", "agility", "near")).ok).toBe(true);
    expect(bow.state().characters[bow.state().playerId]!.inventory.arrows).toBe(2);
    expect(hit(bow, strike("shoot", "agility", "near", "heavy")).ok).toBe(false);
    expect(hit(bow, strike("shoot", "agility", "far")).ok).toBe(false);
    bow.close();

    const recurve = armed("recurve_bow", "arrows");
    expect(hit(recurve, strike("shoot", "agility", "far", "heavy")).ok).toBe(true);
    expect(lastGear(recurve)).toBe(-1);
    recurve.close();
  });

  it("전투 나이프: 맞붙으면 +1, 지니고만 있어도 생존 +1, 부엌칼 대신 화살을 깎는다", () => {
    const w = armed("combat_knife");
    expect(hit(w, strike("fight", "strength", "close")).ok).toBe(true);
    expect(lastGear(w)).toBe(1);
    expect(hit(w, strike("fight", "strength", "close", "heavy")).ok).toBe(false);
    const me = w.state().characters[w.state().playerId]!;
    expect(gearModifiers(w.content, me, "survival").skill).toBe(1);
    // 부엌칼 없이 나이프만으로 화살을 깎는다
    const kitchen = me.inventory.kitchen_knife ?? 0;
    if (kitchen > 0) w.ctx().store.append({ type: "item_consumed", holder: me.id, itemId: "kitchen_knife", quantity: kitchen });
    expect(planCraft(w.content, w.state().characters[me.id]!, { recipe: "whittle_arrows", repair: null }, "carpentry")).toContain("판자");
    w.runCheat("~give planks");
    w.runCheat("~give scrap_metal");
    expect(planCraft(w.content, w.state().characters[w.state().playerId]!, { recipe: "whittle_arrows", repair: null }, "carpentry")).toBeNull();
    w.close();
  });
});
