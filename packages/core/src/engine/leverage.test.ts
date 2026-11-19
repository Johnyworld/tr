import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import { loadRealContent } from "../testing.ts";
import { bribePrice, leveragesOn } from "./leverage.ts";

/** 뇌물·협박·폭로 (12-153) */
const content = { ...loadRealContent(), storylets: {} };
const rules = content.scenario.leverage!.bribe;
const make = (roll: number) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-leverage-")), content, rngFactory: () => () => roll }).create("mcp", "role_a_grunt");
type World = ReturnType<typeof make>;
const me = (w: World) => w.state().characters[w.state().playerId]!;
const npcs = Object.values(content.npcs);
const principled = npcs.find((n) => (n.values[rules.scruple] ?? 0) >= rules.refuse_at && (n.values[rules.greed] ?? 0) <= 0)!;
const greedy = npcs.find((n) => (n.values[rules.greed] ?? 0) >= 1 && (n.values[rules.scruple] ?? 0) < rules.refuse_at)!;
const summon = (w: World, id: string) => expect(w.runCheat(`~summon ${id}`).ok).toBe(true);
const bribe = (w: World, npc: string, give: Record<string, number>) => w.executeTool("bribe", { npc_id: npc, give, favor: "오늘 밤 창고 뒷문을 잠그지 않는다" });

describe("뇌물", () => {
  it("넉넉하면 받고, 그 일은 그 사람의 약점이 된다", () => {
    const w = make(0.99);
    summon(w, greedy.id);
    const price = bribePrice(content, w.state(), greedy.id)!;
    expect(w.runCheat(`~give serum ${Math.ceil(price / 60) + 1}`).ok).toBe(true);
    const n = Math.ceil(price / 60);
    expect(bribe(w, greedy.id, { serum: n }).ok).toBe(true);
    expect(w.state().characters[greedy.id]!.inventory.serum).toBeGreaterThanOrEqual(n);
    expect(leveragesOn(w.state(), content, greedy.id).map((l) => l.key)).toContain("bribe:0");
  });

  it("욕심이 클수록 싸다", () => {
    const w = make(0.99);
    const rank = w.state().characters[greedy.id]!.rank;
    expect(bribePrice(content, w.state(), greedy.id)!).toBeLessThan(rules.prices[rank] ?? rules.prices.default!);
  });

  it("원칙을 지키는 사람은 값과 상관없이 거절하고 기억한다", () => {
    const w = make(0.99);
    summon(w, principled.id);
    expect(w.runCheat("~give serum 3").ok).toBe(true);
    expect(bribe(w, principled.id, { serum: 3 }).ok).toBe(true);
    expect(me(w).inventory.serum).toBe(3);
    expect(w.state().bribes).toHaveLength(0);
    const deed = Object.values(w.state().deeds).find((d) => d.actorId === me(w).id)!;
    expect(w.state().deedKnowledge[principled.id]?.[deed.id]).toBe("seen");
  });

  it("턱없이 모자라면 받지 않는다", () => {
    const w = make(0.99);
    summon(w, greedy.id);
    expect(w.runCheat("~give empty_bottle 1").ok).toBe(true);
    expect(bribe(w, greedy.id, { empty_bottle: 1 }).ok).toBe(true);
    expect(w.state().bribes).toHaveLength(0);
  });
});

describe("협박과 폭로", () => {
  function bribed(roll: number) {
    const w = make(roll);
    summon(w, greedy.id);
    expect(w.runCheat("~give serum 2").ok).toBe(true);
    // 판정 없이 받도록 넉넉하게 (값이 60을 넘는 계급이 없다)
    expect(bribe(w, greedy.id, { serum: 2 }).ok).toBe(true);
    return w;
  }

  it("쥔 약점이 없으면 협박할 수 없다", () => {
    const w = make(0.99);
    summon(w, greedy.id);
    expect(w.executeTool("blackmail", { npc_id: greedy.id, action: "demand", leverage: "secret", demand: "입을 다물어라" }).ok).toBe(false);
  });

  it("약점을 쥐고 협박하면 들어주고, 약점을 잡힌 사이가 된다", () => {
    const w = bribed(0.99);
    expect(w.executeTool("blackmail", { npc_id: greedy.id, action: "demand", leverage: "bribe:0", demand: "정찰 일정을 알려 달라" }).ok).toBe(true);
    expect(w.state().blackmails).toEqual([expect.objectContaining({ npcId: greedy.id, grudge: false })]);
  });

  it("폭로하면 그 사람의 행적으로 퍼지고 다시 쓸 수 없다", () => {
    const w = bribed(0.99);
    const listener = npcs.find((n) => n.id !== greedy.id && n.faction === "faction_a" && !w.state().scene.present.includes(n.id))!;
    summon(w, listener.id);
    expect(w.executeTool("blackmail", { npc_id: greedy.id, action: "expose", leverage: "bribe:0", demand: null }).ok).toBe(true);
    const deed = Object.values(w.state().deeds).find((d) => d.actorId === greedy.id)!;
    expect(w.state().deedKnowledge[listener.id]?.[deed.id]).toBe("report");
    // 플레이어가 쓴 부탁 문장이 아니라 그 사람이 한 일로 퍼진다 (플레이 테스트 5)
    expect(deed.summary).toBe(`뇌물을 받고 부탁을 들어주었다 ("오늘 밤 창고 뒷문을 잠그지 않는다")`);
    expect(leveragesOn(w.state(), content, greedy.id)).toHaveLength(0);
  });

  it("되갚는 사람에게 사과가 통하면 원한이 풀리고 약점도 내려놓는다 (플레이 테스트 5)", () => {
    const full = loadRealContent();
    const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-leverage-")), content: full, rngFactory: () => () => 0.99 }).create("mcp", "role_a_grunt");
    summon(w, greedy.id);
    expect(w.runCheat("~give serum 2").ok).toBe(true);
    expect(bribe(w, greedy.id, { serum: 2 }).ok).toBe(true);
    w.ctx().store.append({ type: "blackmailed", npcId: greedy.id, by: w.state().playerId, leverage: "bribe:0", grudge: true });
    const sc = w.runCheat("~storylet lv_payback"); expect(sc.ok, sc.ok ? "" : sc.error).toBe(true);
    w.executeTool("take_action", { intent: "사과한다", check: { move: "persuade", stat: "charm", difficulty: "normal", harm_on_failure: "none", harm_cause: "", harm_kind: null, infected_source: false, target_harm: "none", distance: "close" }, activity: null, deed: null, target: null, narration_summary: null, for_mission: false });
    const r = w.executeTool("resolve_storylet", { choice_id: "apologize" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().blackmails).toEqual([]);
    expect(leveragesOn(w.state(), full, greedy.id)).toEqual([]);
    expect(w.runCheat("~storylet lv_payback").ok).toBe(false);
  });
});

describe("누명", () => {
  it("들킨 누명도 같은 사람에 대해 하루 한 번이다 (플레이 테스트 5)", () => {
    const w = make(0);
    const listener = npcs.find((n) => n.id !== "a_taeho" && n.faction === "faction_a")!;
    summon(w, listener.id);
    const rumor = () => w.executeTool("spread_rumor", { about: "a_taeho", summary: "창고에서 통조림을 빼돌렸다", tags: ["theft"], severity: 2 });
    const first = rumor();
    expect(first.ok && first.resultText).toContain("거짓말인 것이 드러났다");
    const again = rumor();
    expect(again.ok).toBe(false);
  });
});
