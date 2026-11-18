import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import type { GameWorld } from "../world/world.ts";
import { loadRealContent } from "../testing.ts";
import { runCommand } from "../commands/commands.ts";

/** 플레이 테스트 4 (docs/playtests/2026-11-18-mcp-4.md)에서 고친 것 */
const real = loadRealContent();
const content = { ...real, storylets: {} };
const make = (role: string, roll = 0.99, c = content) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-pt4-")), content: c, rngFactory: () => () => roll }).create("mcp", role);
const look = (w: GameWorld) => w.executeTool("take_action", { intent: "둘러본다", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false });
const chk = (move: string, stat: string) => ({ move, stat, difficulty: "normal", harm_on_failure: "none", harm_cause: "", harm_kind: null, infected_source: false, target_harm: "none", distance: "close" });

describe("플레이 테스트 4", () => {
  it("얼굴만 아는 원수: 배경 믿음에는 '(이름은 모른다)'를 남기지 않는다. 지난 일 줄에는 그때그때 붙는다", () => {
    const w = make("role_a_grunt");
    const facts = (w.state().beliefs[w.state().playerId] ?? []).map((b) => b.fact);
    expect(facts.some((f) => f.startsWith("원수: 목에 화상 자국"))).toBe(true);
    expect(facts.some((f) => f.includes("(이름은 모른다)"))).toBe(false);
    expect(w.sceneForGm()).toContain("원수: 목에 화상 자국 있는 약탈조장 (이름은 모른다)");
  });

  it("실종 정찰조의 평판은 갇힌 곳을 말하지 않는다 (원칙 4)", () => {
    for (const id of ["a_jeongbin", "a_gicheol_scout"]) expect(real.npcs[id]!.reputation).not.toContain("수용소");
  });

  it("되풀이되는 이야기가 같은 믿음을 또 남기지 않는다", () => {
    const w = make("role_a_grunt", 0.5, real);
    look(w);
    const count = () => (w.state().beliefs[w.state().playerId] ?? []).filter((b) => b.fact.includes("아직 살아 있다는 말이 돈다")).length;
    for (let i = 0; i < 2; i++) {
      expect(w.runCheat("~storylet rp_revenge_rumor").ok).toBe(true);
      // 대가 있는 성공: "살아 있다는 말이 돈다"
      w.executeTool("take_action", { intent: "듣는다", check: chk("sense_danger", "senses"), activity: null, deed: null, target: null, narration_summary: null, for_mission: false });
      w.executeTool("resolve_storylet", { choice_id: "listen" });
    }
    expect(count()).toBe(1);
  });

  it("묶어 끌고 다니는 포로는 관계가 바닥이어도 떠나지 않는다", () => {
    const w = make("role_a_grunt");
    w.ctx().store.append({ type: "zone_moved", from: w.state().playerZone, to: "old_town" });
    expect(w.runCheat("~summon c_cheolgu").ok).toBe(true);
    expect(w.runCheat("~harm c_cheolgu serious").ok).toBe(true);
    expect(w.executeTool("take_prisoner", { target: "c_cheolgu" }).ok).toBe(true);
    expect(w.runCheat("~relation c_cheolgu trust -3").ok).toBe(true);
    look(w);
    expect(w.state().companions).toContain("c_cheolgu");
  });

  it("떠돌이는 가진 가죽 재킷을 입고 시작한다", () => {
    const w = make("role_l_wanderer");
    expect(w.state().characters[w.state().playerId]!.equipped.body).toBe("leather_jacket");
  });

  it("죽은 사람은 '별일 없는 사이' 목록이 아니라 사망 표시와 함께 나온다", () => {
    const w = make("role_a_grunt");
    expect(w.runCheat("~kill a_mansu").ok).toBe(true);
    const gm = w.sceneForGm();
    expect(gm).toMatch(/박만수 \(a_mansu\)[^\n]*· 사망/);
    expect(gm).not.toMatch(/별일 없는 사이\)[^\n]*박만수/);
  });

  it("시설이 오래 걸리면 더 든 시간을 알린다", () => {
    const w = make("role_l_wanderer");
    expect(w.executeTool("stash", { action: "settle" }).ok).toBe(true);
    for (const g of ["~give planks 2", "~give wire_roll 1", "~give hen 2"]) expect(w.runCheat(g).ok).toBe(true);
    const r = w.executeTool("take_action", { intent: "닭장을 짓는다", check: chk("carpentry", "intellect"), activity: null, deed: null, target: null, narration_summary: null, for_mission: false, build: "coop" });
    expect(r.ok && r.resultText).toContain("짓는 데 1시간이 더 들었다");
  });

  it("지키는 전투의 막기는 월드 팩의 준비물 이름으로 부른다", () => {
    const w = make("role_a_grunt");
    for (const g of ["~give planks 3", "~give scrap_metal 2"]) expect(w.runCheat(g).ok).toBe(true);
    expect(w.executeTool("take_action", { intent: "막는다", check: chk("carpentry", "strength"), activity: null, deed: null, target: null, narration_summary: null, for_mission: false, prepare: "road_barricade" }).ok).toBe(true);
    expect(w.runCheat("~battle").ok).toBe(true);
    expect(w.sceneForGm()).toContain("길목 바리케이드가 버티는 중");
    const r = w.executeTool("take_action", { intent: "엄폐", check: chk("fight", "strength"), activity: null, deed: null, target: null, narration_summary: null, for_mission: false, battle: { effect: "cover_hold", objective: null } });
    expect(!r.ok && r.error).toContain("모래주머니 엄폐가 없다");
  });

  it("?인물 검색어가 따옴표로 감싸여도 조사가 맞다", () => {
    const w = make("role_a_grunt");
    expect(runCommand("?인물 염철구", { state: w.state(), content, summaries: [] })).toContain(`"염철구"가 없습니다`);
  });
});
