import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { createSeededRng } from "../rng.ts";
import { WorldManager } from "../world/manager.ts";
import { buildPlayerView } from "./player.ts";

/** 상태 화면: 새 기능이 보이고, 모르는 것은 보이지 않는다 (원칙 4) */
const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };
const open = (role: string) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-view-")), content, rngFactory: () => createSeededRng(3) }).create("mcp", role, choice);

describe("상태 화면의 새 항목", () => {
  it("장비·짐, 빌린 장비, 빚, 방침이 보인다", () => {
    const w = open("role_a_grunt");
    w.ctx().store.append({ type: "debt_changed", characterId: "player", factionId: "faction_e", delta: 5 });
    w.executeTool("npc_presence", { npc_id: "a_taeho", action: "enter" });
    w.ctx().store.append({ type: "missions_offered", day: Math.floor(w.state().time / 1440) + 1, templateIds: ["front_recon"] });
    w.executeTool("assign_mission", { template_id: "front_recon" });
    const v = buildPlayerView(w.state(), w.content);
    expect(v.gear?.weapon?.name).toBe("낡은 소총");
    expect(v.gear?.weapon?.ammo).toContain("소총탄");
    expect(v.gear?.capacity).toBeGreaterThan(0);
    expect(v.loan.join()).toContain("낡은 소총");
    expect(v.debts).toEqual([{ name: "나루상단", amount: 5 }]);
    expect(v.policy.map((p) => p.label)).toEqual(["배급", "태세", "교역"]);
    expect(v.squad).toBeNull();
  });

  it("분대장은 분대가, 동행이 있으면 동행이 보인다", () => {
    const w = open("role_a_squad_leader");
    w.executeTool("squad_order", { members: ["a_byungchul"], task: "guard", zone: null });
    const v = buildPlayerView(w.state(), w.content);
    expect(v.squad?.find((m) => m.id === "a_byungchul")?.doing).toContain("보초");
    w.executeTool("spawn_extra", { template: "stray_dog", label: "누렁이" });
    const dog = w.state().scene.present.at(-1)!;
    w.ctx().store.append({ type: "companion_joined", characterId: dog, kind: "animal" });
    const after = buildPlayerView(w.state(), w.content);
    expect(after.companions).toEqual([{ id: dog, name: "누렁이", bondLabel: "동물", note: null, apart: false }]);
    expect(after.present.find((p) => p.id === dog)?.rankLabel).toBe("");
  });

  it("숨은 관계는 털어놓기 전에는 화면에 없다", () => {
    const w = open("role_a_grunt");
    const has = () => buildPlayerView(w.state(), w.content).ties.some((t) => t.text.includes("오정빈"));
    expect(has()).toBe(false);
    w.ctx().store.append({ type: "tie_revealed", key: ["a_jeongbin", "a_jiho"].sort().join("|") });
    expect(has()).toBe(true);
  });
});
