import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import type { Content } from "../content/schemas.ts";
import { checkCustomStart, describeCustomStartOptions } from "../game/customStart.ts";
import { answerNewGame, describeNewGameStep, newGameDraft } from "../game/newGame.ts";
import { createSeededRng, type Rng } from "../rng.ts";
import { initialWarWorld, simulateWarDay } from "../sim/war.ts";
import { WorldManager } from "../world/manager.ts";

/** 여울섬: 닫힌 낙원 (기획서 9.12) */
const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const packs = new Map<string, Content>([[content.scenario.id, content]]);
const act = (intent: string, extra: Record<string, unknown> = {}) => ({ intent, check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...extra });
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };
const crossCheck = { move: "survival", stat: "senses", difficulty: "hard", harm_on_failure: "heavy", harm_cause: "밤바다", infected_source: false, target_harm: "none" };

function atRiverside(savesDir: string, rng: () => Rng = () => createSeededRng(3)) {
  const m = new WorldManager({ savesDir, content, rngFactory: rng });
  const w = m.create("mcp", "role_a_grunt", choice);
  // 시작 직후 몇 시간은 이야기를 열지 않는다 (storylet_pacing.first_after_hours)
  w.runCheat("~time +8h");
  w.runCheat("~goto riverside");
  expect(w.state().playerZone).toBe("riverside");
  return { m, w };
}

function scenarioStep(unlocked: Record<string, string[]>): string {
  const d = answerNewGame(packs, newGameDraft(unlocked), "post_apoc", createSeededRng(1));
  if (!d.ok) throw new Error(d.error);
  return describeNewGameStep(packs, d.draft);
}

describe("여울섬은 시작할 수 없다", () => {
  it("처음 시나리오 고르기와 직접 쓰기에 없다", () => {
    expect(scenarioStep({})).not.toContain("여울섬의 새 식구");
    const custom = { faction: "faction_y", rank: "grunt", title: "섬사람", location: "yeoul_isle", kit: "fighter", skills: {}, age: 30, opening: "o", background: [] };
    expect(checkCustomStart(content, custom).join()).toContain("시작할 수 없다");
    expect(describeCustomStartOptions(content)).not.toContain("여울섬(faction_y)");
  });

  it("어느 구역과도 맞닿아 있지 않아 전쟁에 끼지 않는다", () => {
    let world = initialWarWorld(content);
    const rng = createSeededRng(5);
    for (let d = 0; d < 60; d++) {
      const r = simulateWarDay(world, content, rng);
      expect(r.clashes.some((c) => c.attacker === "faction_y" || c.defender === "faction_y")).toBe(false);
      world = { factions: r.factions, zones: r.zones, clocks: r.clocks };
    }
    expect(world.zones.yeoul_isle?.owner).toBe("faction_y");
  });
});

describe("건너가기", () => {
  it("표가 없으면 무거운 위험을 걸고 판정해야 하고, 실패하면 다치고 되돌아온다 (주사위가 늘 1)", () => {
    const { w } = atRiverside(mkdtempSync(join(tmpdir(), "trpg-y-")), () => () => 0);
    expect(w.executeTool("take_action", act("섬으로 간다", { move_to: "yeoul_isle" })).ok).toBe(false);
    const light = w.executeTool("take_action", act("섬으로 간다", { move_to: "yeoul_isle", check: { ...crossCheck, harm_on_failure: "light" } }));
    expect(light.ok).toBe(false);
    const harm = () => w.state().characters.player!.conditions[w.content.scenario.harm_track];
    const before = harm();
    const r = w.executeTool("take_action", act("밤바다로 배를 띄운다", { move_to: "yeoul_isle", check: crossCheck }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.ok && r.resultText).toContain("닿지 못하고 되돌아왔다");
    expect(w.state().playerZone).toBe("riverside");
    expect(harm()).not.toBe(before);
    w.close();
  });

  it("건너는 데 성공하면 섬에 닿고, 해금이 모든 판의 기록에 남고, 입도 심사가 열린다 (주사위가 늘 6)", () => {
    const dir = mkdtempSync(join(tmpdir(), "trpg-y-"));
    const { w } = atRiverside(dir, () => () => 0.999);
    const r = w.executeTool("take_action", act("밤바다로 배를 띄운다", { move_to: "yeoul_isle", check: crossCheck }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().playerZone).toBe("yeoul_isle");
    expect(r.ok && r.resultText).toContain("새 시나리오가 열렸다");
    expect(w.state().unlocked).toContain("yeoul");
    expect(existsSync(join(dir, "unlocks.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "unlocks.json"), "utf8"))).toEqual({ post_apoc: ["yeoul"] });
    expect(w.state().activeStorylet?.id).toBe("wy_landing");
    // 쓸모를 보이면 받아들여진다
    const pitch = w.executeTool("take_action", act("총 솜씨를 보인다", { check: { move: "persuade", stat: "charm", difficulty: "normal", harm_on_failure: "none", harm_cause: "", infected_source: false, target_harm: "none" } }));
    expect(pitch.ok, pitch.ok ? "" : pitch.error).toBe(true);
    const res = w.executeTool("resolve_storylet", { choice_id: "prove" });
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    expect(w.state().characters.player!.factionId).toBe("faction_y");
    w.close();
  });

  it("건너는 표가 있으면 위험 없이 건너고, 섬에서 나오는 길도 같다", () => {
    const { w } = atRiverside(mkdtempSync(join(tmpdir(), "trpg-y-")));
    w.ctx().store.append({ type: "flag_set", characterId: "player", flag: "y_passage" });
    expect(w.executeTool("take_action", act("거래선을 탄다", { move_to: "yeoul_isle" })).ok).toBe(true);
    expect(w.state().playerZone).toBe("yeoul_isle");
    // 섬의 허락 없이 나가려면 다시 위험한 시도 (y_passage는 들어가는 표다)
    w.ctx().store.append({ type: "flag_cleared", characterId: "player", flag: "y_passage" });
    expect(w.executeTool("take_action", act("강변으로 돌아간다", { move_to: "riverside" })).ok).toBe(false);
    w.ctx().store.append({ type: "flag_set", characterId: "player", flag: "y_leave_pass" });
    expect(w.executeTool("take_action", act("강변으로 돌아간다", { move_to: "riverside" })).ok).toBe(true);
    expect(w.state().playerZone).toBe("riverside");
    w.close();
  });
});

describe("해금은 모든 판에 남는다", () => {
  it("한 판에서 섬에 들어가면 새 게임의 시나리오 고르기에 섬사람이 나오고, 새 세계에도 해금이 옮겨진다", () => {
    const dir = mkdtempSync(join(tmpdir(), "trpg-y-"));
    const { w } = atRiverside(dir);
    w.ctx().store.append({ type: "flag_set", characterId: "player", flag: "y_passage" });
    w.executeTool("take_action", act("거래선을 탄다", { move_to: "yeoul_isle" }));
    w.close();
    const m = new WorldManager({ savesDir: dir, content, rngFactory: () => createSeededRng(4) });
    expect(m.unlocks()).toEqual({ post_apoc: ["yeoul"] });
    expect(scenarioStep(m.unlocks())).toContain("여울섬의 새 식구");
    const fresh = m.create("mcp", "role_b_guard", choice);
    expect(fresh.state().unlocked).toEqual(["yeoul"]);
    fresh.close();
    const islander = m.create("mcp", "role_y_islander", choice);
    expect(islander.state().playerZone).toBe("yeoul_isle");
    expect(islander.state().characters.player!.factionId).toBe("faction_y");
    islander.close();
  });

  it("같은 판에서 죽은 뒤 다음 캐릭터로 섬사람을 고를 수 있다", () => {
    const dir = mkdtempSync(join(tmpdir(), "trpg-y-"));
    const { w } = atRiverside(dir);
    w.ctx().store.append({ type: "flag_set", characterId: "player", flag: "y_passage" });
    w.executeTool("take_action", act("거래선을 탄다", { move_to: "yeoul_isle" }));
    w.runCheat("~kill me");
    expect(w.successionOptions().map((o) => o.id)).toContain("new:role_y_islander");
    const r = w.chooseNextCharacter("new:role_y_islander", "섬사람");
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().roleId).toBe("role_y_islander");
    expect(w.state().characters[w.state().playerId]!.factionId).toBe("faction_y");
    w.executeTool("take_action", act("부두를 둘러본다"));
    expect(w.state().playerZone).toBe("yeoul_isle");
    w.close();
  });
});

describe("외딴곳", () => {
  it("섬에서는 도시 공통 이야기가 열리지 않고, 엑스트라 틀은 섬 주민만 나온다", async () => {
    const { eligibleStorylets } = await import("../story/storylets.ts");
    const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-y-")), content, rngFactory: () => createSeededRng(3) });
    const w = m.create("mcp", "role_y_islander", choice);
    w.runCheat("~time +2d");
    const open = eligibleStorylets(w.state(), w.content);
    expect(open.filter((s) => s.tags.includes("world"))).toEqual([]);
    const scene = w.sceneForGm();
    expect(scene).toContain("y_villager");
    expect(scene).not.toContain("refugee");
    w.close();
  });
});
