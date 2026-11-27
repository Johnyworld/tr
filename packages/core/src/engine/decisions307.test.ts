import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRealContent } from "../testing.ts";
import { itemSources } from "../content/sources.ts";
import { WorldManager } from "../world/manager.ts";

/** PT30 뒤 고침·사용자 결정 (12-307) */
const content = loadRealContent();
const make = (roleId: string, roll = 0.5) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-307-")), content, rngFactory: () => () => roll }).create("mcp", roleId, { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] } as never);
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true, ...input });
const check = (move: string, stat: string) => ({ move, stat, difficulty: "normal", harm_on_failure: "none", harm_cause: "", harm_kind: null, infected_source: false, target_harm: "none", distance: null });

describe("매복 길목에서 되돌아가기 (12-307)", () => {
  it("걸음을 돌리는 데 성공하면 떠나온 구역으로 길만큼 걸려 돌아가고, 매복자는 장면에 남지 않는다", () => {
    const w = make("role_a_grunt", 0.99);
    const home = w.state().playerZone!;
    w.ctx().store.append({ type: "zone_moved", from: home, to: "riverside", place: null });
    expect(w.state().lastRoute).toEqual({ from: home, to: "riverside" });
    expect(w.runCheat("~storylet rd_ambush").ok).toBe(true);
    const raider = w.state().activeStorylet!.cast.raider!;
    const t0 = w.state().time;
    const move = content.storylets.rd_ambush!.choices.find((c) => c.id === "back_off")!.check!;
    w.executeTool("take_action", { ...act({ intent: "걸음을 돌린다" }), ignore_story: false, check: check(move, content.scenario.moves.find((m) => m.id === move)!.stats[0]!) });
    const r = w.executeTool("resolve_storylet", { choice_id: "back_off" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().playerZone).toBe(home);
    expect(w.state().scene.present).not.toContain(raider);
    expect(w.state().time - t0).toBeGreaterThanOrEqual(30);
    expect(r.ok && r.resultText).toContain("돌아왔다");
  });
});

describe("우리 땅 수색 (12-307 사용자 결정)", () => {
  const searchHere = (w: ReturnType<typeof make>) => {
    const move = content.scenario.exploration!.search_move;
    const mate = Object.values(content.npcs).find((n) => w.state().characters[n.id]?.factionId === w.state().characters[w.state().playerId]!.factionId && n.zone === w.state().playerZone)!.id;
    w.executeTool("npc_presence", { npc_id: mate, action: "enter" });
    return w.executeTool("take_action", act({ intent: "뒤진다", activity: { kind: "search", until: null }, check: check(move, content.scenario.moves.find((m) => m.id === move)!.stats[0]!) }));
  };
  const thefts = (w: ReturnType<typeof make>) => Object.values(w.state().deeds).filter((d) => d.actorId === w.state().playerId && d.tags.includes("theft")).length;

  it("우리 거점에서 뒤져 챙기면 도둑질이고, 의뢰의 구할 곳으로 거점 뒤지기를 권하지 않는다", () => {
    const w = make("role_a_grunt", 0.99);
    const r = searchHere(w);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(thefts(w)).toBe(1);
    for (const item of Object.keys(content.items)) for (const where of itemSources(content, item)) expect(where).not.toMatch(/거점 뒤지기/);
  });
});

describe("우리 땅 수색: 거점이 아니면 도둑질이 아니다 (12-307)", () => {
  it("거점 아닌 우리 땅(남쪽 텃밭)에서 무리 사람 앞에서 뒤져도 행적이 없다", () => {
    const w = make("role_a_grunt", 0.99);
    w.runCheat("~goto south_fields");
    const move = content.scenario.exploration!.search_move;
    const mate = Object.values(content.npcs).find((n) => w.state().characters[n.id]?.factionId === "faction_a" && !w.state().characters[n.id]?.dead)!.id;
    w.runCheat(`~summon ${mate}`);
    const r = w.executeTool("take_action", act({ intent: "뒤진다", activity: { kind: "search", until: null }, check: check(move, content.scenario.moves.find((m) => m.id === move)!.stats[0]!) }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(Object.values(w.state().deeds).filter((d) => d.tags.includes("theft")).length).toBe(0);
  });
});

describe("적 땅 길끼리 (12-307)", () => {
  it("물류창고의 길끼리는 초소를 지나지 않고 이어지고, 거절 글은 가장 짧은 길의 다음 칸만 알린다", () => {
    const w = make("role_a_grunt");
    w.runCheat("~goto c_warehouse");
    w.ctx().store.append({ type: "place_moved", from: w.state().playerPlace, to: "to_west" });
    w.ctx().store.append({ type: "place_learned", zone: "c_warehouse", place: "to_north" }); // 가 본 길 (길은 지나 봐야 안다, 12-353)
    const r = w.executeTool("take_action", act({ place_to: "to_north" }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("rail_side");
    expect(!r.ok && r.error).not.toContain("checkpoint_3");
  });
});

describe("콘텐츠 자리 (12-307)", () => {
  it("분대장 첫 장면은 첫날 실내에서 시작해도 열린다", () => {
    const w = make("role_a_squad_leader");
    for (let i = 0; i < 6 && !w.state().storyletLog.a_sl_first_muster; i++) {
      if (w.state().activeStorylet) w.ctx().store.append({ type: "storylet_expired", storyletId: w.state().activeStorylet!.id });
      w.executeTool("take_action", act({ intent: "기다린다", activity: { kind: "wait", hours: 1, until: null } }));
    }
    expect(w.state().storyletLog.a_sl_first_muster).toBeTruthy();
  });

  it("결과 조건을 임무 이야기로 채우는 임무는 받을 때 목표를 찾을 자리를 알린다", () => {
    const w = make("role_d_medic");
    const commander = content.roles.role_d_medic!.commander!;
    w.executeTool("npc_presence", { npc_id: commander, action: "enter" });
    w.ctx().store.append({ type: "missions_offered", day: Math.floor(w.state().time / 1440) + 1, templateIds: ["d_riverside_wounded"] });
    const r = w.executeTool("assign_mission", { template_id: "d_riverside_wounded" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.ok && r.resultText).toContain("목표를 찾을 자리: 그곳의 건물 안");
  });
});
