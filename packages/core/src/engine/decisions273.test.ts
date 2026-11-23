import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { depthAt } from "../rules/place.ts";
import { heldSeenTopic } from "../rules/held.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";

/** 구역·장소 설계 ③ 잠입 깊이와 장소 (12-273). 실제 콘텐츠로 본다 */
const content = { ...loadRealContent(), storylets: {} };
const make = (roll = 0.99) => {
  const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-273-")), content, rngFactory: () => () => roll }).create("mcp", "role_a_grunt", { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] } as never);
  expect(w.runCheat("~goto c_warehouse").ok).toBe(true);
  return w;
};
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true, ...input });
const go = (w: ReturnType<typeof make>, action: string, goal: string | null = null, place: string | null = null) => w.executeTool("infiltrate", { action, goal, place });

describe("잠입 깊이와 장소 (12-273)", () => {
  it("깊이는 장소에서: 막 들어선 자리 담 밖, 바깥 장소 담 안, 실내 장소 깊은 곳", () => {
    const s = make().state();
    expect(depthAt(s, content, null)).toBe(0);
    expect(depthAt(s, content, "yard")).toBe(1);
    expect(depthAt(s, content, "stockade")).toBe(2);
    const bare = Object.keys(content.locations).find((z) => !content.locations[z]!.places.length)!;
    expect(depthAt({ ...s, playerZone: bare }, content, null)).toBeNull();
  });

  it("적 땅에서 드러내 놓고는 한 깊이씩만 옮긴다", () => {
    const w = make();
    const jump = w.executeTool("take_action", act({ place_to: "stockade" }));
    expect(jump.ok).toBe(false);
    expect(!jump.ok && jump.error).toContain("한 깊이씩");
    expect(w.state().playerPlace).toBeNull();
  });

  it("잠입은 지금 장소의 깊이에서 시작하고, 잠입 중에는 place_to를 막는다", () => {
    const w = make();
    w.ctx().store.append({ type: "place_moved", from: null, to: "yard" });
    expect(go(w, "start", "steal").ok).toBe(true);
    expect(w.state().infiltration?.depth).toBe(1);
    const moved = w.executeTool("take_action", act({ place_to: "entry" }));
    expect(!moved.ok && moved.error).toContain("infiltrate");
  });

  it("갇힌 사람 풀어 주기의 가장 깊은 곳은 가두는 곳이다", () => {
    const w = make();
    // 우리 무리 정찰조가 이곳 수용소에 갇힌 것을 안다
    const captive = Object.values(w.state().characters).find((c) => c.captive?.by === "faction_c" && c.captive.zone === "c_warehouse")!.id;
    w.ctx().store.append({ type: "belief_added", characterId: w.state().playerId, belief: { id: `b_${w.state().nextBeliefNo}`, fact: "수용소에 갇혀 있다", source: "seen", accuracy: "exact", learnedAt: w.state().time, topic: heldSeenTopic(captive, "c_warehouse") } });
    w.ctx().store.append({ type: "place_moved", from: null, to: "yard" });
    expect(go(w, "start", "free").ok).toBe(true);
    go(w, "advance");
    expect(w.state().playerPlace).toBe("stockade");
  });
});
