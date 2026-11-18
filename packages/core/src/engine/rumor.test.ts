import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import { loadRealContent } from "../testing.ts";
import { memoryItemsOf } from "../rag/memory.ts";

/** 소문 조작: 거짓 소문·누명 (12-151) */
const content = { ...loadRealContent(), storylets: {} };
const make = (roll: number) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-rumor-")), content, rngFactory: () => () => roll }).create("mcp", "role_a_grunt");
type World = ReturnType<typeof make>;

/** 이름을 아는 같은 무리 사람 셋: 누명을 쓸 사람 하나, 듣는 사람 둘 (서로 이어지지 않은 사람으로) */
function setup(w: World) {
  const s = w.state();
  const known = (s.known[s.playerId] ?? []).filter((id) => content.npcs[id] && !s.characters[id]!.dead);
  const [target, ...rest] = known;
  const listeners = rest.filter((id) => !(content.npcs[id]!.ties ?? []).some((t) => t.to === target) && !(content.npcs[target!]!.ties ?? []).some((t) => t.to === id)).slice(0, 2);
  for (const id of listeners) if (!w.state().scene.present.includes(id)) expect(w.runCheat(`~summon ${id}`).ok).toBe(true);
  return { target: target!, listeners };
}
const rumor = (w: World, about: string) => w.executeTool("spread_rumor", { about, summary: "보급 창고에서 통조림을 빼돌렸다", tags: ["theft"], severity: 2 });

describe("거짓 소문", () => {
  it("믿으면 지어낸 행적이 그 사람의 것으로 기록되고, 듣는 사람이 전해 들은 것으로 안다", () => {
    const w = make(0.99);
    const { target, listeners } = setup(w);
    expect(listeners.length).toBeGreaterThan(0);
    const out = rumor(w, target);
    expect(out.ok).toBe(true);
    const deed = Object.values(w.state().deeds).find((d) => d.fabricatedBy === w.state().playerId)!;
    expect(deed.actorId).toBe(target);
    for (const id of listeners) expect(w.state().deedKnowledge[id]?.[deed.id]).toBe("report");
    // 주인공의 행적 목록에는 들어가지 않는다
    expect(Object.values(w.state().deeds).filter((d) => d.actorId === w.state().playerId)).toHaveLength(0);
    // 같은 사람에게는 하루 한 번
    expect(rumor(w, target).ok).toBe(false);
  });

  it("누명을 쓴 사람의 기억에는 들어가지 않고, 지어낸 사람은 거짓인 줄 안다", () => {
    const w = make(0.99);
    const { target } = setup(w);
    rumor(w, target);
    const items = memoryItemsOf(w.state(), content, []);
    const fake = items.filter((i) => i.text.includes("통조림을 빼돌렸다"));
    expect(fake.some((i) => (i.knownBy ?? []).includes(target))).toBe(false);
    expect(fake.some((i) => (i.knownBy ?? []).includes(w.state().playerId) && i.text.includes("지어낸"))).toBe(true);
  });

  it("실패하면 아무도 믿지 않고, 그 자리 사람들이 주인공의 거짓말을 본다", () => {
    const w = make(0);
    const { target, listeners } = setup(w);
    expect(rumor(w, target).ok).toBe(true);
    expect(Object.values(w.state().deeds).some((d) => d.fabricatedBy)).toBe(false);
    const lie = Object.values(w.state().deeds).find((d) => d.actorId === w.state().playerId)!;
    expect(lie.tags).toContain("deceit");
    for (const id of listeners) expect(w.state().deedKnowledge[id]?.[lie.id]).toBe("seen");
  });

  it("듣는 사람이 없으면 퍼뜨릴 수 없다", () => {
    const w = make(0.99);
    const target = (w.state().known[w.state().playerId] ?? []).find((id) => content.npcs[id])!;
    for (const id of w.state().scene.present) w.executeTool("npc_presence", { npc_id: id, action: "leave" });
    expect(rumor(w, target).ok).toBe(false);
  });
});
