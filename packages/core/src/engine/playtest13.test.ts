import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activeMissionOf } from "../game/missions.ts";
import { stanceOf } from "../game/fame.ts";
import { createSeededRng } from "../rng.ts";
import { storyletAllowed } from "../story/storylets.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { maybeInfect } from "./body.ts";
import { runMissionStartOfTurn } from "./missionTools.ts";
import { hostileHere, maskUnknownNames } from "./storyletTools.ts";
import { recordDeed } from "./reputationTools.ts";

/** 긴 판 열 (플레이 테스트 13, docs/playtests/2026-11-20-mcp-13-long.md)의 확실한 버그 */
const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };

function world(roleId: string, seed = 5) {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-pt13-")), content, rngFactory: () => createSeededRng(seed) });
  return m.create("mcp", roleId, choice);
}

const act = (input: Record<string, unknown> = {}) => ({
  intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input,
});

describe("플레이 테스트 13 버그", () => {
  it("물린 감염은 레벨의 버팀으로 막지 못한다", () => {
    const w = world("role_d_medic");
    const s = w.state();
    s.characters[s.playerId]!.level = 30;
    const track = content.scenario.body!.infection!.track;
    maybeInfect({ ...w.ctx(), rng: () => 0 }, "bite");
    expect(w.state().characters[s.playerId]!.conditions[track]).not.toBe(content.scenario.condition_tracks.find((t) => t.id === track)!.levels[0]!.id);
  });

  it("무소속에게 중립 거점은 적대하는 땅이 아니고, 낯선 사람을 잡아가는 무리의 땅은 적대하는 땅이다", () => {
    const w = world("role_l_wanderer");
    const ctx = w.ctx();
    const prey = content.scenario.helpless!.prey_on_strangers;
    const neutralBase = Object.values(content.locations).find((l) => l.kind === "base" && l.owner && !prey.includes(l.owner))!.id;
    ctx.store.append({ type: "zone_moved", from: w.state().playerZone, to: neutralBase });
    expect(hostileHere(ctx)).toBe(false);
    const preyZone = Object.keys(content.locations).find((z) => prey.includes(w.state().zones[z]?.owner ?? ""))!;
    ctx.store.append({ type: "zone_moved", from: neutralBase, to: preyZone });
    expect(hostileHere(ctx)).toBe(true);
  });

  it("꼭 열려야 하는 이야기는 급한 이야기의 하루 상한에도 막히지 않는다", () => {
    const w = world("role_t_visitor");
    const s = structuredClone(w.state());
    const essential = Object.values(content.storylets).find((x) => x.essential)!;
    const urgent = Object.values(content.storylets).filter((x) => x.urgent && !x.essential).slice(0, 5);
    for (const u of urgent) s.storyletLog[u.id] = { fired: 1, lastFiredAt: s.time };
    expect(storyletAllowed(s, content, essential, "urgent_only", s.time)).toBe(true);
  });

  it("얼굴을 맞댄 사람은 소문으로만 아는 팬이 아니다", () => {
    const w = world("role_a_grunt");
    const s = w.state();
    const commander = content.roles.role_a_grunt!.commander!;
    w.ctx().store.append({ type: "relation_changed", from: commander, to: s.playerId, delta: { trust: 0, affection: 5, respect: 5 }, reason: "테스트" });
    recordDeed(w.ctx(), { summary: "임무 완수", tags: ["diligence"], severity: 1, privacy: "public", noisy: false }, { npcId: commander, source: "report" });
    w.executeTool("npc_presence", { npc_id: commander, action: "enter" });
    expect(stanceOf(w.state(), content, commander)).toBeNull();
  });

  it("거절된 행동의 요약은 일지에 남지 않는다", () => {
    const w = world("role_a_grunt");
    const r = w.executeTool("take_action", act({ move_to: "없는_구역", narration_summary: "구시가로 빠져나왔다" }));
    expect(r.ok).toBe(false);
    expect(w.summaries().some((x) => x.text.includes("빠져나왔다"))).toBe(false);
  });

  it("바닥에 내려놓은 물건은 그 구역에 남는다", () => {
    const w = world("role_a_grunt");
    const ctx = w.ctx();
    const here = w.state().playerZone!;
    const next = content.locations[here]!.adjacent[0]!;
    const item = Object.keys(w.state().characters[w.state().playerId]!.inventory)[0]!;
    expect(w.executeTool("transfer_item", { from: w.state().playerId, to: "scene", item_id: item, quantity: 1 }).ok).toBe(true);
    ctx.store.append({ type: "zone_moved", from: here, to: next });
    expect(w.state().scene.items[item] ?? 0).toBe(0);
    ctx.store.append({ type: "zone_moved", from: next, to: here });
    expect(w.state().scene.items[item]).toBe(1);
  });

  it("임무 기한에 오가는 시간이 얹힌다 (맞닿음이 한쪽에만 적혀 있어도)", () => {
    const w = world("role_d_medic");
    const commander = content.roles.role_d_medic!.commander!;
    w.executeTool("npc_presence", { npc_id: commander, action: "enter" });
    w.ctx().store.append({ type: "missions_offered", day: Math.floor(w.state().time / 1440) + 1, templateIds: ["d_riverside_wounded"] });
    const r = w.executeTool("assign_mission", { template_id: "d_riverside_wounded" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const m = activeMissionOf(w.state().missions, w.state().playerId)!;
    expect((m.deadline - m.assignedAt) / 60).toBeGreaterThan(content.missions.d_riverside_wounded!.deadline_hours);
  });

  it("이야기 글에서 만난 적 없고 장면에도 없는 사람은 누군가다", () => {
    const w = world("role_l_wanderer");
    const npc = Object.values(content.npcs).find((n) => !(w.state().known[w.state().playerId] ?? []).includes(n.id) && !(w.state().met[w.state().playerId] ?? []).includes(n.id))!;
    expect(maskUnknownNames(w.state(), content, `${npc.name}을 몰아세운다`, { story: true })).toBe("누군가를 몰아세운다");
  });
});

describe("플레이 테스트 13 뒤 정한 것", () => {
  it("조건을 기한 안에 다 채웠으면 활동이 기한을 넘겨 끝나도 기한 초과가 아니다", () => {
    const w = world("role_a_grunt");
    const commander = content.roles.role_a_grunt!.commander!;
    w.executeTool("npc_presence", { npc_id: commander, action: "enter" });
    const guard = Object.values(content.missions).find((m) => content.roles.role_a_grunt!.missions.includes(m.id) && m.requirements.every((r) => "activity" in r && r.activity === "guard_duty") && !m.where)
      ?? Object.values(content.missions).find((m) => m.requirements.every((r) => "activity" in r && r.activity === "guard_duty") && !m.where)!;
    w.ctx().store.append({ type: "missions_offered", day: Math.floor(w.state().time / 1440) + 1, templateIds: [guard.id] });
    expect(w.executeTool("assign_mission", { template_id: guard.id }).ok).toBe(true);
    const m = activeMissionOf(w.state().missions, w.state().playerId)!;
    const need = (m.requirements[0] as { minutes: number }).minutes;
    const ctx = w.ctx();
    // 조건이 찬 시각은 기한 안, 활동은 기한 뒤까지
    const start = m.deadline - need - 10;
    ctx.store.append({ type: "time_advanced", activity: "wait", from: w.state().time, to: start });
    ctx.store.append({ type: "time_advanced", activity: "guard_duty", from: start, to: m.deadline + 60, forMission: m.id } as never);
    expect(w.state().missions[m.id]!.metAt).toBe(start + need);
    runMissionStartOfTurn(ctx);
    expect(w.state().missions[m.id]!.status).toBe("active");
    const r = w.executeTool("report_mission", {});
    expect(r.ok && r.resultText).not.toContain("기한을 넘겨");
  });
});
