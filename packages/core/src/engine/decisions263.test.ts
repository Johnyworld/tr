import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { heldOf } from "../rules/held.ts";
import { whereIs } from "../rules/place.ts";
import { eligibleStorylets } from "../story/storylets.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { capturePlayer } from "./captivity.ts";

/** 적 수용소의 출구 (12-263, PT17 졸병: 치명상·기아로 엿새 동안 나갈 길이 없었다). 실제 경로(하루가 지나는 셈)로 본다 */
const content = loadRealContent();
const make = (roleId: string, extra: Record<string, unknown> = {}) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-263-")), content, rngFactory: () => () => 0.5 }).create("mcp", roleId, { name: "서진", gender: "female", abilities: null, portrait: null, traits: [], ...extra } as never);
const harmOf = (w: ReturnType<typeof make>) => w.state().characters[w.state().playerId]!.conditions[content.scenario.harm_track];

describe("붙잡은 쪽 치료사 (12-263)", () => {
  it("붙잡은 무리의 치료사가 하루에 한 단계 돌본다 (의약품은 그 무리 것)", () => {
    const w = make("role_a_grunt");
    expect(capturePlayer(w.ctx(), "faction_c")).toBeTruthy();
    w.runCheat("~harm 서진 serious");
    const before = w.state().factions.faction_c!.resources.medicine ?? 0;
    w.runCheat("~time +1d");
    expect(heldOf(w.state().characters[w.state().playerId])).toBeTruthy();
    expect(harmOf(w)).toBe("light");
    expect(w.state().factions.faction_c!.resources.medicine ?? 0).toBeLessThan(before + 1);
  });

  it("수술감이면 수술할 줄 아는 사람만 손댄다 (못 하면 상처는 그대로, 거듭 다치지도 않는다)", () => {
    const w = make("role_a_grunt");
    capturePlayer(w.ctx(), "faction_c");
    w.runCheat("~harm 서진 critical");
    w.runCheat("~time +1d");
    expect(["serious", "critical"]).toContain(harmOf(w));
  });
});

describe("오래 갇힌 날의 출구 (12-263)", () => {
  it("무리가 있으면 닷새 뒤 몸값 이야기, 없으면 내다 버리는 이야기가 후보가 된다", () => {
    const grunt = make("role_a_grunt");
    capturePlayer(grunt.ctx(), "faction_c");
    const at = grunt.state().time + 5 * 24 * 60 + 60;
    const ids = (w: ReturnType<typeof make>) => eligibleStorylets(w.state(), content, at).map((s) => s.id);
    expect(ids(grunt)).toContain("cp_long_ransom");
    expect(ids(grunt)).not.toContain("cp_long_mouth");
    expect(eligibleStorylets(grunt.state(), content, grunt.state().time + 60).map((s) => s.id)).not.toContain("cp_long_ransom");

    const visitor = make("role_t_visitor", { name: "민재", gender: "male" });
    capturePlayer(visitor.ctx(), "faction_c");
    expect(ids(visitor)).toContain("cp_long_mouth");
    expect(ids(visitor)).not.toContain("cp_long_ransom");
  });

  it("몸값을 받아들이면 풀려나 우리 거점으로 돌아가고 무리의 탄약이 준다", () => {
    const w = make("role_a_grunt");
    capturePlayer(w.ctx(), "faction_c");
    const ammo = w.state().factions.faction_a!.resources.ammo ?? 0;
    expect(w.runCheat("~storylet cp_long_ransom").ok).toBe(true);
    const r = w.executeTool("resolve_storylet", { choice_id: "go_home" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(heldOf(w.state().characters[w.state().playerId])).toBeFalsy();
    expect(w.state().playerZone).toBe("a_base");
    expect(w.state().factions.faction_a!.resources.ammo ?? 0).toBeLessThan(ammo);
  });
});

describe("구하러 오는 이야기 (12-264)", () => {
  const rescue = (w: ReturnType<typeof make>, days: number) => {
    const s = w.state();
    let at = s.time + days * 24 * 60;
    while (Math.floor((at % (24 * 60)) / 60) !== 1) at += 60; // 새벽 1시 (밤)
    return eligibleStorylets(s, content, at).some((x) => x.id === "cp_rescue_word");
  };

  it("우리 무리 사람이 곁에서 붙잡히는 것을 봤으면 하루 뒤 밤에 열린다", () => {
    const w = make("role_a_grunt");
    const mate = Object.values(content.npcs).find((n) => n.faction === "faction_a" && whereIs(w.state(), content, n.id)?.zone === w.state().playerZone)!.id;
    w.executeTool("npc_presence", { npc_id: mate, action: "enter" });
    expect(w.state().scene.present).toContain(mate);
    capturePlayer(w.ctx(), "faction_c");
    expect(rescue(w, 0)).toBe(false);
    expect(rescue(w, 1)).toBe(true);
  });

  it("아무도 못 봤으면 열리지 않고, 풀려나면 플래그를 걷는다", () => {
    const w = make("role_a_grunt");
    for (const id of [...w.state().scene.present]) w.executeTool("npc_presence", { npc_id: id, action: "leave" });
    capturePlayer(w.ctx(), "faction_c");
    expect(rescue(w, 1)).toBe(false);

    const seen = make("role_a_grunt");
    capturePlayer(seen.ctx(), "faction_c");
    seen.runCheat("~storylet cp_long_ransom");
    seen.executeTool("resolve_storylet", { choice_id: "go_home" });
    expect(seen.state().flags[seen.state().playerId] ?? []).not.toContain(content.scenario.captivity!.known_flag);
  });
});
