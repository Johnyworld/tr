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
    expect(leveragesOn(w.state(), content, greedy.id)).toHaveLength(0);
  });
});
