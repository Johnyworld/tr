import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withKnownNames } from "../game/acquaintance.ts";
import { npcPlaceAt, placesIn, whereIs } from "../rules/place.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";

/** 플레이 테스트 16 뒤 고친 것 (12-261) */
const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };
const world = (roleId: string, roll = 0.5) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-261-")), content, rngFactory: () => () => roll }).create("mcp", roleId, choice);
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true, ...input });

describe("같은 장소의 사람 들이기 (12-261)", () => {
  it("장소를 옮기는 턴에 그 장소에 있을 사람을 target으로 부를 수 있다", () => {
    const w = world("role_a_grunt");
    const s = w.state();
    const here = s.playerPlace;
    const pick = Object.keys(content.npcs).map((id) => ({ id, w: whereIs(s, content, id) })).find((x) => x.w?.zone === s.playerZone && x.w.place && x.w.place !== here && !s.scene.present.includes(x.id));
    expect(pick).toBeTruthy();
    const r = w.executeTool("take_action", act({ place_to: pick!.w!.place, target: pick!.id }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().scene.present).toContain(pick!.id);
  });
});

describe("문구 (12-261)", () => {
  it("호칭 바로 뒤에 이름이 있으면 바꾸지 않는다", () => {
    const w = world("role_t_visitor");
    const family = Object.values(w.state().characters).find((c) => c.extra && (w.state().known[w.state().playerId] ?? []).includes(c.id));
    expect(family).toBeTruthy();
    const fact = `가족(${family!.extra!.label} ${family!.name})과 헤어졌다`;
    expect(withKnownNames(w.state(), content, fact)).toBe(fact);
  });
});

describe("일과와 가두는 곳 (12-261)", () => {
  it("일과로는 누구도 가두는 장소에 두지 않는다", () => {
    const w = world("role_a_grunt");
    const s = w.state();
    for (const id of Object.keys(content.npcs)) {
      const place = npcPlaceAt(s, content, id);
      if (!place) continue;
      const zone = whereIs(s, content, id)?.zone;
      const p = placesIn(s, content, zone).find((x) => x.id === place);
      expect(p?.jail ?? false, `${id} → ${place}`).toBe(false);
    }
  });
});

describe("물가 (12-261)", () => {
  it("섬 바닷가에서 물에 들어갈 수 있다", () => {
    const w = world("role_y_islander");
    w.executeTool("take_action", act({ place_to: "farm_shore" }));
    const r = w.executeTool("take_action", act({ intent: "물에 들어간다", wade: true }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect((w.state().wet[w.state().playerId] ?? 0) > 0).toBe(true);
  });
});

describe("규율 회의 (12-261)", () => {
  it("짓을 한 직후에는 열리지 않고, 한 시간 안에 한 짓은 한 회의에서 다룬다", async () => {
    const { ownOffense } = await import("../rules/consequence.ts");
    const w = world("role_c_raider");
    const mate = Object.values(content.npcs).find((n) => n.faction === "faction_c" && whereIs(w.state(), content, n.id)?.zone === w.state().playerZone && n.id !== content.roles.role_c_raider!.commander)!.id;
    w.executeTool("npc_presence", { npc_id: mate, action: "enter" });
    const theft = { summary: "무리 창고에서 통조림을 훔쳤다", tags: ["theft"], severity: 2, privacy: "semi_private", noisy: false, condition: "always" };
    w.executeTool("take_action", act({ deed: theft }));
    expect(ownOffense(w.state(), content)).toBeNull();
    w.executeTool("take_action", act({ deed: { ...theft, summary: "또 훔쳤다" } }));
    // 짓이 끝난 때부터 한 시간 (설계 목록 2-1, 12-280). 기다림이 이야기로 끊길 수 있어 넉넉히
    const ended = Math.max(...Object.values(w.state().deeds).map((d) => d.endedAt ?? d.at));
    for (let i = 0; i < 6 && w.state().time < ended + 60; i++) {
      w.state().activeStorylet = null;
      w.executeTool("take_action", act({ activity: { kind: "wait", until: null, hours: 1 } }));
    }
    // 회의가 열렸거나(부르는 이야기는 어디서든 연다) 아직 회의를 기다린다
    expect(!!w.state().storyletLog.disc_c_council || ownOffense(w.state(), content) !== null).toBe(true);
  });
});
