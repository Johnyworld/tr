import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ableNow } from "../rules/company.ts";
import { heldSeenTopic } from "../rules/held.ts";
import { sceneLeavesAt, whereIs } from "../rules/place.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { welcomeRescued } from "../rules/held.ts";
import { fireStorylet } from "./storyletTools.ts";

/** PT23 뒤 고친 것 (12-289). 실제 콘텐츠로 본다 */
const content = loadRealContent();
const make = (role: string, roll = 0.99) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-289-")), content, rngFactory: () => () => roll }).create("mcp", role, { name: "하람", gender: "female", abilities: null, portrait: null, traits: [], past: "farmer" } as never);

describe("PT23 뒤 고친 것 (12-289)", () => {
  it("규율 회의는 불려 갈 자리로 불러 가고 시간이 들며, 회의를 연 상관은 그 짓을 안다", () => {
    const w = make("role_y_islander");
    const s = w.state();
    const mate = Object.values(content.npcs).find((n) => n.faction === "faction_y" && whereIs(s, content, n.id)?.zone === s.playerZone && n.id !== content.roles.role_y_islander!.commander)!.id;
    const id = `d_${s.nextDeedNo}`;
    w.ctx().store.append({ type: "deed_recorded", deed: { id, actorId: s.playerId, summary: "궤짝에서 먹을 것을 챙겼다", tags: ["theft"], severity: 2, at: s.time, witnesses: [{ npcId: mate, hidden: false }], searched: false } });
    w.ctx().store.append({ type: "time_advanced", activity: "wait", from: s.time, to: s.time + 180 });
    const boss = content.roles.role_y_islander!.commander!;
    const t = w.state().time;
    fireStorylet(w.ctx(), content.storylets.disc_y_council!, { boss });
    expect(w.state().playerPlace).toBe("stone_wall");
    expect(w.state().time).toBeGreaterThanOrEqual(t);
    expect(w.state().deedKnowledge[boss]?.[id]).toBeTruthy();
  });

  it("다른 구역에서 함께 온 사람과 쓰러진 주인공 곁의 사람은 시간대가 바뀌어도 남는다", () => {
    const w = make("role_d_medic");
    const mate = Object.values(content.npcs).find((n) => n.faction === "faction_d" && n.id !== content.roles.role_d_medic!.commander && !n.roams?.length)!.id;
    w.executeTool("npc_presence", { npc_id: mate, action: "enter" });
    w.executeTool("take_action", { intent: "간다", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true, move_to: "old_town", with: [mate] });
    expect(w.state().scene.present).toContain(mate);
    const from = w.state().time - 6 * 60;
    expect(sceneLeavesAt(w.state(), content, from)).not.toContain(mate);
  });

  it("기절시켜 둔 사람은 깨어날 때까지 움직이지 못한다", () => {
    const w = make("role_a_grunt");
    const s = w.state();
    const someone = Object.keys(content.npcs).find((id) => id !== s.playerId)!;
    w.ctx().store.append({ type: "npc_knocked_out", npcId: someone, until: s.time + 240 });
    expect(ableNow(w.state(), content, someone)).toBe(false);
    w.ctx().store.append({ type: "time_advanced", activity: "wait", from: w.state().time, to: w.state().time + 300 });
    expect(ableNow(w.state(), content, someone)).toBe(true);
  });

  it("꺼내 온 사람은 더는 붙잡혀 있다고 믿지 않는다", () => {
    const w = make("role_a_grunt");
    const captive = Object.values(w.state().characters).find((c) => c.captive?.by === "faction_c")!.id;
    const zone = w.state().characters[captive]!.captive!.zone;
    w.ctx().store.append({ type: "belief_added", characterId: w.state().playerId, belief: { id: `b_${w.state().nextBeliefNo}`, fact: "갇혀 있다", source: "seen", accuracy: "exact", learnedAt: w.state().time, topic: heldSeenTopic(captive, zone) } });
    w.ctx().store.append({ type: "npc_released", npcId: captive });
    welcomeRescued(w.ctx(), [captive]);
    expect((w.state().beliefs[w.state().playerId] ?? []).some((b) => b.topic === heldSeenTopic(captive, zone))).toBe(false);
  });

  it("복무 일수는 날짜로 센다", () => {
    const w = make("role_y_islander");
    const t = w.state().time;
    w.ctx().store.append({ type: "time_advanced", activity: "wait", from: t, to: t + (3 * 1440 - (t % 1440)) + 4 * 60 });
    return w.runCommand("?상태").then((text) => expect(text).toMatch(/4일차[^\n]*복무 4일째/));
  });

});
