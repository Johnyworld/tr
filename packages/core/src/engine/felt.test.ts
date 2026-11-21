import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { createSeededRng } from "../rng.ts";
import { casualtiesToPeople, routeCause, tracesHere } from "./felt.ts";
import { invested } from "../rules/company.ts";
import type { Clash } from "../game/state.ts";
import { hearNews } from "../rules/news.ts";
import { protectedFromWorld } from "../rules/company.ts";
import { warCaptures } from "./captivity.ts";

const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };
const world = (roleId: string) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-felt-")), content, rngFactory: () => createSeededRng(5) }).create("mcp", roleId, choice);
const clash = (zone: string, attacker: string, defender: string): Clash => ({ kind: "assault", attacker, defender, zone, success: true, attackerLosses: 1, defenderLosses: 1 });

describe("세계가 움직인 느낌 (12-242)", () => {
  it("흔적: 교전이 있던 구역에 며칠 흔적이 남는다", () => {
    const w = world("role_a_grunt");
    const zone = w.state().playerZone!;
    expect(tracesHere(w.state(), content)).toBeNull();
    w.state().recentClashes.push({ clash: clash(zone, "faction_c", "faction_a"), at: w.state().time - 60 });
    expect(tracesHere(w.state(), content)).toContain("교전의 흔적");
    w.state().time += 3 * 1440;
    expect(tracesHere(w.state(), content)).toBeNull();
  });

  it("결과가 사람에게: 이름 있는 대원이 죽으면 우리 무리 소식으로 듣는다. 공들인 관계는 첫 죽음을 봐준다", () => {
    const w = world("role_a_grunt");
    const ctx = { ...w.ctx(), rng: () => 0 };
    const me = w.state().playerId;
    const mates = Object.values(content.npcs).filter((n) => n.faction === "faction_a" && w.state().characters[n.id]).map((n) => n.id);
    // 처음 뽑힐 사람을 공들인 관계로 만든다 (신뢰 4)
    const out1 = casualtiesToPeople(ctx, [{ ...clash("a_east_post", "faction_c", "faction_a"), attackerLosses: 0 }]);
    expect(out1.length).toBeGreaterThan(0);
    const fact1 = (w.state().beliefs[me] ?? []).at(-1)!;
    expect(fact1.source).toBe("report");
    const victim = mates.find((id) => w.state().characters[id]!.dead);
    expect(victim, fact1.fact).toBeDefined();

    const w2 = world("role_a_grunt");
    const ctx2 = { ...w2.ctx(), rng: () => 0 };
    const pick = mates.find((id) => w2.state().characters[id] && !w2.state().characters[id]!.dead && !w2.state().companions.includes(id))!;
    for (const id of mates) if (id !== pick) w2.state().characters[id]!.away = true;
    w2.state().relations[pick] = { ...(w2.state().relations[pick] ?? {}), [me]: { trust: 4, affection: 0, respect: 0 } };
    expect(invested(w2.state(), content, pick)).toBe(true);
    casualtiesToPeople(ctx2, [{ ...clash("a_east_post", "faction_c", "faction_a"), attackerLosses: 0 }]);
    expect(w2.state().characters[pick]!.dead).toBe(false);
    expect((w2.state().beliefs[me] ?? []).at(-1)!.fact).toContain("살아 돌아왔다");
    casualtiesToPeople(ctx2, [{ ...clash("a_east_post", "faction_c", "faction_a"), attackerLosses: 0 }]);
    expect(w2.state().characters[pick]!.dead).toBe(true);
  });

  it("원인 있는 만남: 그 길 끝에서 하루 안에 교전이 있었으면 까닭을 댄다", () => {
    const w = world("role_a_grunt");
    w.state().lastRoute = { from: "a_base", to: "a_east_post" };
    expect(routeCause(w.state(), content)).toBeNull();
    w.state().recentClashes.push({ clash: clash("a_east_post", "faction_c", "faction_a"), at: w.state().time - 60 });
    expect(routeCause(w.state(), content)).toContain("교전");
  });

  it("소식이 닿는 길: 갇혀 있으면 우리 무리 소식도 닿지 않는다 (12-243)", () => {
    const w = world("role_a_grunt");
    expect(hearNews(w.ctx(), { fact: "우리 일", factions: ["faction_a"] }).length).toBe(1);
    w.state().characters[w.state().playerId]!.captive = { by: "faction_c", zone: "c_base" };
    expect(hearNews(w.ctx(), { fact: "우리 일 2", factions: ["faction_a"] })).toEqual([]);
  });

  it("세계가 건드리지 않는 사람: 분대원은 전쟁 포로로 끌려가지 않는다 (12-243)", () => {
    const w = world("role_a_squad_leader");
    const squad = content.roles.role_a_squad_leader!.squad!;
    for (const id of squad) expect(protectedFromWorld(w.state(), content, id)).toBe(true);
    const ctx = { ...w.ctx(), rng: () => 0 };
    for (let i = 0; i < 5; i++) warCaptures(ctx, [{ kind: "assault", attacker: "faction_c", defender: "faction_a", zone: "a_east_post", success: true, attackerLosses: 0, defenderLosses: 2 }]);
    for (const id of squad) expect(w.state().characters[id]!.captive).toBeNull();
  });
});
