import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { createSeededRng } from "../rng.ts";
import { eligibleStorylets } from "../story/storylets.ts";
import { WorldManager } from "../world/manager.ts";
import { buildCustomRole } from "./customStart.ts";

const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));

function pineWorld() {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-captive-")), content, rngFactory: () => createSeededRng(4) });
  const role = buildCustomRole(content, {
    faction: "faction_a", rank: "grunt", title: "청솔형제단 정찰병", location: "a_base", kit: "scout", skills: { stealth: 1, sense_danger: 1 }, age: 25, opening: "막사에서.", background: [],
  });
  return m.create("mcp", undefined, { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] }, undefined, { role, background: [] });
}

describe("포로 (붙잡힌 인물)", () => {
  it("정찰조는 처음부터 붉은연합 물류창고에 갇혀 있고, 그곳에 있지 않으면 행방을 모른다 (원칙 4)", () => {
    const w = pineWorld();
    expect(w.state().characters.a_jeongbin?.captive).toEqual({ by: "faction_c", zone: "c_warehouse" });
    const scene = w.sceneForGm();
    expect(scene).toMatch(/오정빈 \(a_jeongbin\)[^\n]*행방 모름/);
    expect(scene).not.toContain("붙잡혀");
    expect(w.executeTool("npc_presence", { npc_id: "a_jeongbin", action: "enter" }).ok).toBe(false);
    w.close();
  });

  it("물류창고에서는 만날 수 있고, 구출 이야기가 열리며, 풀려나면 무리로 돌아간다", () => {
    const w = pineWorld();
    const store = w.ctx().store;
    store.append({ type: "zone_moved", from: w.state().playerZone, to: "c_warehouse" });
    store.append({ type: "flag_set", characterId: "player", flag: "scouts_captured" });
    const s = w.state();
    const evening = s.time - (s.time % 1440) + 18 * 60;
    expect(eligibleStorylets(s, w.content, evening).map((x) => x.id)).toContain("wc_rescue_raid");
    expect(w.sceneForGm()).toMatch(/오정빈[^\n]*여기 붙잡혀 있다|창살에 얼굴을 붙인 젊은 정찰병/);
    expect(w.executeTool("npc_presence", { npc_id: "a_jeongbin", action: "enter" }).ok).toBe(true);
    store.append({ type: "npc_released", npcId: "a_jeongbin" });
    expect(w.state().characters.a_jeongbin?.captive).toBeNull();
    expect(w.state().scene.present).not.toContain("a_jeongbin");
    expect(eligibleStorylets(w.state(), w.content, evening).map((x) => x.id)).not.toContain("wc_quiet_release");
    w.close();
  });
});
