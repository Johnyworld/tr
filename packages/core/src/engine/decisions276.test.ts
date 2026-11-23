import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { storySummonsTo, whereIs } from "../rules/place.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { quarantineAfterCare } from "./care/quarantine.ts";
import { healersHere } from "./care/kinds.ts";
import { capturePlayer } from "./captivity.ts";

/** PT20 뒤 고칠 것 (12-276). 실제 콘텐츠·실제 시작 흐름으로 본다 */
const content = loadRealContent();
const make = (roleId: string, roll = 0.5) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-276-")), content, rngFactory: () => () => roll }).create("mcp", roleId, { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] } as never);
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true, ...input });

describe("PT20 뒤 고칠 것 (12-276)", () => {
  it("적 땅에서는 이야기가 담 안으로 데려가지 않고, 정문 이야기는 담 밖 초소에서 열린다", () => {
    const w = make("role_a_grunt");
    w.runCheat("~goto c_warehouse");
    // 담 밖 길에서 글이 "망루"(감시탑·담, gate)를 말해도 데려가지 않는다
    expect(storySummonsTo(w.state(), content, undefined, "망루 위에서 확성기가 지직거린다", false)).toBeNull();
    expect(content.storylets.tv_gate!.when.places).toEqual(["checkpoint"]);
  });

  it("달아나기에 성공하면 가장 가까운 길로 빠져나오고, 믿음은 다쳤다고 못 박지 않는다", () => {
    const w = make("role_a_grunt", 0.99);
    w.runCheat("~goto c_warehouse");
    w.ctx().store.append({ type: "place_moved", from: w.state().playerPlace, to: "checkpoint_3" });
    w.ctx().store.append({ type: "place_moved", from: "checkpoint_3", to: "yard" });
    expect(w.runCheat("~storylet al_patrol_any").ok).toBe(true);
    w.executeTool("take_action", { ...act({ intent: "왔던 길로 뛴다" }), ignore_story: false, check: { move: "athletics", stat: "agility", difficulty: "normal", harm_on_failure: "none", harm_cause: "", harm_kind: null, infected_source: false, target_harm: "none", distance: null } });
    const r = w.executeTool("resolve_storylet", { choice_id: "flee" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(content.locations.c_warehouse!.places.find((p) => p.id === w.state().playerPlace)?.road).toBe(true);
    const flee = content.storylets.al_patrol_any!.choices.find((c) => c.id === "flee")!;
    expect(JSON.stringify(flee.outcomes?.partial)).not.toContain("다쳤다");
    expect(flee.escapes).toBe(true);
  });

  it("적 땅에서는 길이 아닌 곳에서 곧장 구역을 떠나지 못한다", () => {
    const w = make("role_a_grunt");
    w.runCheat("~goto c_warehouse");
    w.ctx().store.append({ type: "place_moved", from: w.state().playerPlace, to: "checkpoint_3" });
    w.ctx().store.append({ type: "place_moved", from: "checkpoint_3", to: "yard" });
    const r = w.executeTool("take_action", act({ move_to: "riverside" }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("길로 나가야");
  });

  it("같은 방 사람은 같이 갇힌 포로다", () => {
    const w = make("role_a_grunt");
    capturePlayer(w.ctx(), "faction_c");
    expect(w.runCheat("~storylet cp_cellmate").ok).toBe(true);
    const mate = w.state().activeStorylet!.cast.mate!;
    expect(w.state().characters[mate]?.captive?.by).toBe("faction_c");
  });

  it("수소문 전에는 장소 목록에 가족 집이 뜨지 않는다 (실제 시작 흐름)", () => {
    const w = make("role_t_visitor");
    const parents = w.state().family.map((id) => w.state().characters[id]!.name);
    expect(parents.length).toBeGreaterThan(0);
    w.runCheat("~goto b_base");
    const places = w.sceneForGm().split("\n").filter((l) => l.startsWith("- blocks"));
    for (const name of parents) expect(places.join("\n")).not.toContain(name);
  });

  it("치료를 부르면 치료사는 한 사람만, 크게 다친 치료사는 빼고 들인다", () => {
    const w = make("role_d_medic");
    w.ctx().store.append({ type: "place_moved", from: w.state().playerPlace, to: "ward" });
    const healers = Object.values(content.npcs).filter((n) => n.healer && whereIs(w.state(), content, n.id)?.place === "ward").map((n) => n.id);
    expect(healersHere(w.ctx()).length).toBeLessThanOrEqual(1);
    if (healers[0]) expect(healersHere(w.ctx(), healers[0])).toEqual([healers[0]]);
  });

  it("격리되면 격리 장소로 옮겨진다", () => {
    const w = make("role_d_medic");
    w.state().exposedAt[w.state().playerId] = w.state().time;
    const line = quarantineAfterCare(w.ctx(), "faction_d");
    expect(line).toContain("격리실");
    expect(w.state().playerPlace).toBe("quarantine");
  });

  it("받아 온 값은 따로 건네지 않고 보고로 넘긴다, 첫눈은 눈 오는 날 바깥에서", () => {
    expect(content.storylets.lt_first_snow!.when.weather).toEqual(["snow"]);
    expect(content.storylets.lt_first_snow!.when.indoor).toBe(false);
  });
});
