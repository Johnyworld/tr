import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { createSeededRng } from "../rng.ts";
import { WorldManager } from "../world/manager.ts";
import { equippedItem } from "./gear.ts";

/** 무기고: 작전에 무기를 빌려주고 거둬들인다 (기획서 4.8) */
const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };

function withMission(roleId: string, template: string) {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-armory-")), content, rngFactory: () => createSeededRng(5) });
  const w = m.create("mcp", roleId, choice);
  const commander = w.content.roles[roleId]!.commander!;
  w.executeTool("npc_presence", { npc_id: commander, action: "enter" });
  w.ctx().store.append({ type: "missions_offered", day: Math.floor(w.state().time / 1440) + 1, templateIds: [template] });
  const r = w.executeTool("assign_mission", { template_id: template });
  expect(r.ok, r.ok ? "" : r.error).toBe(true);
  return { w, text: r.ok ? r.resultText : "" };
}

describe("무기고 (기획서 4.8)", () => {
  it("부엌칼만 든 하급 전투원이 작전을 받으면 낡은 소총과 소총탄을 받아 손에 든다. 보고하면 반납하고 칼을 다시 든다", () => {
    const { w, text } = withMission("role_a_grunt", "front_recon");
    expect(text).toContain("무기고에서");
    const p = w.state().characters.player!;
    expect(p.inventory.old_rifle).toBe(1);
    expect(p.inventory.rifle_rounds).toBe(2);
    expect(equippedItem(p, "weapon")).toBe("old_rifle");
    expect(w.sceneForGm()).toContain("무기고에서 빌린 것");
    const report = w.executeTool("report_mission", {});
    expect(report.ok && report.resultText).toContain("반납했다");
    const after = w.state().characters.player!;
    expect(after.inventory.old_rifle ?? 0).toBe(0);
    expect(equippedItem(after, "weapon")).toBe("kitchen_knife");
  });

  it("빌린 총을 잃어버리면 공적이 깎인다 (탄약은 써도 된다)", () => {
    const { w } = withMission("role_a_grunt", "front_recon");
    w.executeTool("transfer_item", { from: "player", to: "scene", item_id: "old_rifle", quantity: 1 });
    w.ctx().store.append({ type: "item_consumed", holder: "player", itemId: "rifle_rounds", quantity: 2 });
    const merit = w.state().characters.player!.merit;
    const out = w.executeTool("abandon_mission", { reason: "총을 잃었다" });
    expect(out.ok && out.resultText).toContain("돌려주지 못했다");
    expect(w.state().characters.player!.merit).toBeLessThan(merit);
    expect(w.state().loans).toEqual({});
  });

  it("무장이 필요 없는 일에는 빌려주지 않고, 무기고가 없는 무리도 빌려주지 않는다", () => {
    const { w } = withMission("role_a_grunt", "wall_repair");
    expect(w.state().characters.player!.inventory.old_rifle ?? 0).toBe(0);
    const porter = withMission("role_e_porter", "e_road_scout");
    expect(porter.w.state().loans).toEqual({});
  });

  it("이미 총이 있으면 탄약만 채우고, 무리 창고에 탄약이 모자라면 탄약 없이 무기만 준다", () => {
    const sl = withMission("role_a_squad_leader", "a_sl_east_reinforce");
    expect(sl.w.state().characters.player!.inventory.old_rifle).toBe(1);
    const guard = withMission("role_a_grunt", "front_recon");
    expect(guard.w.state().factions.faction_a!.resources.ammo).toBeGreaterThan(0);
    const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-armory-")), content, rngFactory: () => createSeededRng(5) });
    const w = m.create("mcp", "role_a_grunt", choice);
    const f = w.state().factions.faction_a!;
    w.ctx().store.append({ type: "faction_resource_changed", factionId: "faction_a", resource: "ammo", delta: -f.resources.ammo! });
    w.executeTool("npc_presence", { npc_id: "a_taeho", action: "enter" });
    w.ctx().store.append({ type: "missions_offered", day: Math.floor(w.state().time / 1440) + 1, templateIds: ["front_recon"] });
    const r = w.executeTool("assign_mission", { template_id: "front_recon" });
    expect(r.ok && r.resultText).toContain("탄약은 받지 못했다");
    expect(w.state().characters.player!.inventory.old_rifle).toBe(1);
    expect(w.state().characters.player!.inventory.rifle_rounds ?? 0).toBe(0);
  });
});
