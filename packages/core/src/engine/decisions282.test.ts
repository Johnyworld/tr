import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { heldSeenTopic } from "../rules/held.ts";
import { knowsPlace, placeById, unknownDoors, whereIs, whereLabel } from "../rules/place.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { crowdStep } from "./infiltration.ts";

/** 설계 목록 C-1 잠입 1단계 (12-282): 주인공이 아는 장소만 보이고, 모르는 이웃은 '알 수 없는 문'. 실제 콘텐츠로 본다 */
const content = { ...loadRealContent(), storylets: {} };
const make = (role = "role_a_grunt", roll = 0.99) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-282-")), content, rngFactory: () => () => roll }).create("mcp", role, { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] } as never);
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true, ...input });
const sceneText = (w: ReturnType<typeof make>) => w.sceneForGm();
const doorOf = (w: ReturnType<typeof make>, id: string) => `문${unknownDoors(w.state(), content).findIndex((p) => p.id === id) + 1}`;

describe("모르는 장소 (12-282)", () => {
  it("우리 땅은 다 알고, 남의 땅은 길·담 문·담 밖만 안다", () => {
    const w = make();
    const s = w.state();
    for (const p of content.locations[s.playerZone!]!.places) expect(knowsPlace(s, content, s.playerZone, p.id)).toBe(true);
    w.runCheat("~goto c_warehouse");
    const t = w.state();
    expect(knowsPlace(t, content, "c_warehouse", "checkpoint_3")).toBe(true); // 담 밖
    expect(knowsPlace(t, content, "c_warehouse", "yard")).toBe(true); // 담 문
    expect(knowsPlace(t, content, "c_warehouse", "stockade")).toBe(false);
    expect(knowsPlace(t, content, "c_warehouse", "command")).toBe(false);
  });

  it("GM 상태에는 아는 곳만 이름으로, 모르는 이웃은 문으로 나온다. 모르는 id로는 옮기지 못하고 문으로 들어서면 알게 된다", () => {
    const w = make();
    w.runCheat("~goto c_warehouse");
    w.ctx().store.append({ type: "place_moved", from: w.state().playerPlace, to: "yard" });
    const text = sceneText(w);
    expect(text).toContain("- yard");
    expect(text).not.toContain("stockade");
    expect(text).not.toContain("수용소");
    expect(text).toContain("문1 (알 수 없는 곳");
    const byId = w.executeTool("take_action", act({ place_to: "command" }));
    expect(byId.ok).toBe(false);
    expect(!byId.ok && byId.error).not.toContain("지휘소");
    const door = w.executeTool("take_action", act({ place_to: doorOf(w, "command") }));
    expect(door.ok && door.resultText).toContain("처음 들어선 곳");
    expect(w.state().playerPlace).toBe("command");
    // 떠나도 안다
    w.ctx().store.append({ type: "place_moved", from: "command", to: "yard" });
    expect(knowsPlace(w.state(), content, "c_warehouse", "command")).toBe(true);
    expect(sceneText(w)).toMatch(/- (\S+쪽: )?command/); // 12-304: 방향이 앞에 붙는다
  });

  it("모르는 장소에 있는 사람의 자리는 '이 구역 어딘가'로만", () => {
    const w = make();
    w.runCheat("~goto c_warehouse");
    const s = w.state();
    const inside = Object.keys(content.npcs).find((id) => {
      const at = whereIs(s, content, id);
      return at?.zone === "c_warehouse" && !!at.place && !knowsPlace(s, content, "c_warehouse", at.place) && !s.scene.present.includes(id);
    });
    expect(inside).toBeTruthy();
    expect(whereLabel(s, content, inside!)).toBe("이 구역 어딘가");
  });

  it("spawn_place로 모르는 곳의 id를 알아내지 못한다", () => {
    const w = make();
    w.runCheat("~goto c_warehouse");
    const spawned = w.executeTool("spawn_place", { name: "수용소", indoor: true, owner: null });
    expect(spawned.ok).toBe(false);
    expect(!spawned.ok && spawned.error).not.toContain("stockade");
  });

  it("사람이 없는 곳은 쉽고, 셋 이상 있는 곳은 어렵다 (굴림은 늘 한다)", () => {
    const w = make();
    w.runCheat("~goto c_warehouse");
    const s = w.state();
    const empty = content.locations.c_warehouse!.places.find((p) => crowdStep(s, content, placeById(s, content, p.id)) === -1);
    expect(empty).toBeTruthy();
    expect(crowdStep(s, content, null)).toBe(0);
  });

  it("갇힌 사람 풀어 주기는 그 사람이 갇힌 자리에서만, 숨어든 곳에서 갇힌 사람을 보면 목표를 바꿔 풀어 준다", () => {
    const w = make();
    w.runCheat("~goto c_warehouse");
    const captive = Object.values(w.state().characters).find((c) => c.captive?.by === "faction_c" && c.captive.zone === "c_warehouse")!.id;
    w.ctx().store.append({ type: "place_moved", from: w.state().playerPlace, to: "yard" });
    expect(w.executeTool("infiltrate", { action: "start", goal: "steal", place: null }).ok).toBe(true);
    const into = w.executeTool("infiltrate", { action: "advance", goal: null, place: doorOf(w, "stockade") });
    expect(w.state().playerPlace).toBe("stockade");
    expect(into.ok && into.resultText).toContain("갇혀 있는 사람이 보인다");
    expect(w.state().beliefs[w.state().playerId]!.some((b) => b.topic === heldSeenTopic(captive, "c_warehouse"))).toBe(true);
    const freed = w.executeTool("infiltrate", { action: "act", goal: "free", place: null });
    expect(freed.ok && freed.resultText).toContain("풀어 냈다");
  });

  it("갇힌 곳이 아니면 풀어 주기를 하지 못한다", () => {
    const w = make();
    w.runCheat("~goto c_warehouse");
    const captive = Object.values(w.state().characters).find((c) => c.captive?.by === "faction_c" && c.captive.zone === "c_warehouse")!.id;
    w.ctx().store.append({ type: "belief_added", characterId: w.state().playerId, belief: { id: `b_${w.state().nextBeliefNo}`, fact: "갇혀 있다", source: "rumor", accuracy: "exact", learnedAt: w.state().time, topic: heldSeenTopic(captive, "c_warehouse") } });
    w.ctx().store.append({ type: "place_moved", from: w.state().playerPlace, to: "yard" });
    expect(w.executeTool("infiltrate", { action: "start", goal: "free", place: null }).ok).toBe(true);
    w.executeTool("infiltrate", { action: "advance", goal: null, place: doorOf(w, "command") });
    expect(w.state().playerPlace).toBe("command");
    const r = w.executeTool("infiltrate", { action: "act", goal: null, place: null });
    expect(!r.ok && r.error).toContain("갇혀 있지 않다");
  });
});
