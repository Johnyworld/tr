import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import type { GameWorld } from "../world/world.ts";
import { loadRealContent } from "../testing.ts";
import { runCommand } from "../commands/commands.ts";
import { buildPlayerView } from "../views/player.ts";
import { applyEffect } from "./storyletTools.ts";
import { currentResolve, resolveChronicle } from "./resolve.ts";
import type { StoryletEffect } from "../content/schemas.ts";

/** 다짐 (12-164) */
const content = { ...loadRealContent(), storylets: {} };
const make = (role: string) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-resolve-")), content, rngFactory: () => () => 0.99 }).create("mcp", role);
const look = (w: GameWorld) => w.executeTool("take_action", { intent: "둘러본다", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false });
const me = (w: GameWorld) => w.state().characters[w.state().playerId]!;

describe("다짐", () => {
  it("시나리오의 배경(원수)이 첫 판정 때 다짐이 되고, 상태 화면·?임무·GM 상태에 보인다", () => {
    const w = make("role_a_grunt");
    const r = look(w);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resultText).toContain("새 다짐");
    const v = currentResolve(w.state())!;
    expect(v.kind).toBe("revenge");
    expect(v.target).toBe("c_cheolgu");
    expect(v.source).toBe("scenario");
    // 이름을 모르는 원수: 호칭으로 부른다 (비극의 고리, 이름은 이야기로 알게 된다)
    expect(buildPlayerView(w.state(), content).resolve).toContain("화상 자국");
    expect(buildPlayerView(w.state(), content).resolve).not.toContain("염철구");
    expect(runCommand("?임무", { state: w.state(), content, summaries: [] })).toContain("다짐");
    expect(w.sceneForGm()).toContain("주인공의 다짐");
    // 한 번만 세운다
    look(w);
    expect(w.state().resolveLog).toHaveLength(0);
  });

  it("원수가 죽으면 이룬 다짐: 경험치와 기록", () => {
    const w = make("role_a_grunt");
    look(w);
    const xp = me(w).xp;
    expect(w.runCheat("~kill c_cheolgu").ok).toBe(true);
    const r = look(w);
    if (r.ok) expect(r.resultText).toContain("다짐을 이뤘다");
    expect(currentResolve(w.state())).toBeNull();
    expect(me(w).xp).toBeGreaterThan(xp);
    expect(resolveChronicle(w.state(), content, me(w).id)[0]).toContain("이룬 다짐");
  });

  it("갚기는 내려놓을 수 있고, 이룬 것으로 친다", () => {
    const w = make("role_a_grunt");
    look(w);
    const xp = me(w).xp;
    const r = w.executeTool("resolve", { action: "let_go", why: "그의 딸을 보았다" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(me(w).xp).toBeGreaterThan(xp);
    expect(w.state().resolveLog[0]).toMatchObject({ outcome: "let_go", note: "그의 딸을 보았다" });
  });

  it("역할에 적은 다짐을 쓰고, 내려놓을 수 없는 다짐은 내려놓지 못한다", () => {
    const w = make("role_b_guard");
    look(w);
    expect(currentResolve(w.state())).toMatchObject({ kind: "rise", target: "squad_leader" });
    expect(w.executeTool("resolve", { action: "let_go", why: "지쳤다" }).ok).toBe(false);
  });

  it("지키던 사람이 죽으면 꺾인다", () => {
    const w = make("role_a_squad_leader");
    look(w);
    expect(currentResolve(w.state())).toMatchObject({ kind: "protect", target: "a_haneul" });
    expect(w.runCheat("~kill a_haneul").ok).toBe(true);
    const r = look(w);
    if (r.ok) expect(r.resultText).toContain("다짐이 꺾였다");
    expect(w.state().resolveLog[0]?.outcome).toBe("broken");
  });

  it("이야기 효과가 새 다짐을 건네고, 지금 다짐을 바꾼다", () => {
    const w = make("role_a_grunt");
    look(w);
    const out = applyEffect(w.ctx(), { resolve: { kind: "journey", target: "yeoul_isle", target2: null, n: null, text: "{zone}을 떠나 섬에 간다" } } as StoryletEffect, {}, { zone: "거점" }, "테스트");
    expect(out.line).toContain("새 다짐");
    expect(currentResolve(w.state())).toMatchObject({ kind: "journey", target: "yeoul_isle", source: "story", text: "거점을 떠나 섬에 간다" });
  });
});

describe("다짐의 단계 (12-164)", () => {
  it("다짐 갈래·단계로 이야기가 열리고, resolve_step이 단계를 올려 상태 화면 줄에 붙는다", async () => {
    const full = loadRealContent();
    const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-resolve-step-")), content: full, rngFactory: () => () => 0.99 }).create("mcp", "role_a_grunt");
    look(w);
    const { conditionsMet, castCandidates, storyletVars } = await import("../story/storylets.ts");
    expect(w.runCheat("~time evening").ok).toBe(true);
    const rumor = full.storylets.rp_revenge_rumor!;
    const glimpse = full.storylets.rp_revenge_glimpse!;
    expect(conditionsMet(w.state(), full, rumor, w.state().time)).toBe(true);
    expect(storyletVars(w.state(), full, {}).target).toBe("목에 화상 자국 있는 약탈조장");
    // 그 이름을 알게 된다
    const named = applyEffect(w.ctx(), { reveal_name: { who: "foe" } } as StoryletEffect, { foe: "c_cheolgu" }, {}, "테스트");
    expect(named.line).toContain("염철구");
    expect(storyletVars(w.state(), full, {}).target).toBe("염철구");
    const out = applyEffect(w.ctx(), { resolve_step: { text: "{target:이/가} 어디 있는지 말을 들었다" } } as StoryletEffect, {}, storyletVars(w.state(), full, {}), "테스트");
    expect(out.line).toContain("한 걸음");
    expect(currentResolve(w.state())).toMatchObject({ stage: 1, step: "염철구가 어디 있는지 말을 들었다" });
    expect(conditionsMet(w.state(), full, rumor, w.state().time)).toBe(false); // 0단계 이야기는 닫힌다
    expect(conditionsMet(w.state(), full, glimpse, w.state().time)).toBe(true);
    expect(buildPlayerView(w.state(), full).resolve).toBe("염철구에게 갚는다 — 염철구가 어디 있는지 말을 들었다");
    const role = { resolve_target: true } as Parameters<typeof castCandidates>[2];
    expect(castCandidates(w.state(), full, role)).toEqual(["c_cheolgu"]);
    // 다른 갈래의 이야기는 열리지 않는다
    expect(conditionsMet(w.state(), full, full.storylets.rs_journey_boat!, w.state().time)).toBe(false);
  });
});

describe("닿는 다짐 (플레이 테스트에서 고침)", () => {
  it("처음부터 그곳에 있으면 이루지 않고, 떠났다가 닿아야 이룬다", () => {
    const w = make("role_l_wanderer");
    const target = content.roles.role_l_wanderer!.resolve!.target!;
    // 목표 구역에서 다짐이 세워진다
    w.ctx().store.append({ type: "zone_moved", from: w.state().playerZone, to: target });
    look(w);
    expect(currentResolve(w.state())).toMatchObject({ kind: "homecoming", target });
    look(w);
    expect(currentResolve(w.state())).not.toBeNull();
    w.ctx().store.append({ type: "zone_moved", from: target, to: "old_town" });
    look(w);
    w.ctx().store.append({ type: "zone_moved", from: "old_town", to: target });
    const r = look(w);
    if (r.ok) expect(r.resultText).toContain("다짐을 이뤘다");
    expect(currentResolve(w.state())).toBeNull();
  });
});
