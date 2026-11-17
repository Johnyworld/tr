import { describe, expect, it } from "vitest";
import { createWorldEvent, type Clash } from "./state.ts";
import { InMemoryGameStore } from "./store.ts";
import { baseInfestation, infestationDay, infestationOf, infestationSign } from "./infestation.ts";
import { routeDanger } from "../story/storylets.ts";
import { describeExtraTemplates } from "../engine/extras.ts";
import { dayOf } from "../rules/time.ts";
import { loadRealContent } from "../testing.ts";

/** 구역의 감염체 압력 (12-112) */
const content = { ...loadRealContent(), storylets: {} };
const zones = Object.values(content.locations);
const calm = zones.find((l) => l.danger === 0 && !l.isolated)!;
const wild = zones.find((l) => l.danger === 2 && !l.isolated)!;

function setup() {
  const store = new InMemoryGameStore([createWorldEvent(content, "role_l_wanderer", "world_infest", () => 0.5)]);
  return { store, state: () => store.getState() };
}
const clash = (zone: string, losses: number): Clash => ({ kind: "skirmish", attacker: "faction_c", defender: "faction_a", zone, success: false, attackerLosses: losses, defenderLosses: 0 });

describe("감염체 압력", () => {
  it("기준값은 구역의 위험이다", () => {
    const { state } = setup();
    expect(infestationOf(content, state(), wild.id)).toBe(wild.danger);
    expect(baseInfestation(content, calm.id)).toBe(0);
  });

  it("전날의 총소리와 그날의 시체로 오른다 (최대 3). 기준값에 있는 구역은 난수를 쓰지 않는다", () => {
    const { store, state } = setup();
    const day = dayOf(state().time) + 1;
    store.append({ type: "noise_made", zone: calm.id, level: 2, day: day - 1 });
    let rolls = 0;
    const changes = infestationDay(content, state(), day, [clash(calm.id, 3), clash(wild.id, 1)], () => (rolls++, 0.5));
    expect(changes).toEqual([{ zone: calm.id, level: 2, cause: "소음·시체" }]);
    expect(rolls).toBe(0);
    // 이틀 전 소음은 세지 않는다
    expect(infestationDay(content, state(), day + 1, [], () => 0.99)).toEqual([]);
  });

  it("아무 일 없는 날은 확률로 기준값 쪽으로 한 단계 돌아간다 (위로도 아래로도)", () => {
    const { store, state } = setup();
    store.append({ type: "infestation_changed", zone: calm.id, level: 2, cause: "소음" });
    store.append({ type: "infestation_changed", zone: wild.id, level: 0, cause: "소탕" });
    const day = dayOf(state().time) + 1;
    expect(infestationDay(content, state(), day, [], () => 0.99)).toEqual([]);
    expect(infestationDay(content, state(), day, [], () => 0)).toEqual(
      expect.arrayContaining([
        { zone: calm.id, level: 1, cause: "흩어짐" },
        { zone: wild.id, level: 1, cause: "흩어짐" },
      ]),
    );
  });

  it("날이 바뀌면 하루 틱이 압력을 바꾼다", async () => {
    const { WorldManager } = await import("../world/manager.ts");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createSeededRng } = await import("../rng.ts");
    const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-infest-")), content, rngFactory: () => createSeededRng(3) });
    const w = m.create("mcp", "role_l_wanderer", { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] });
    const zone = w.state().playerZone!;
    const before = infestationOf(content, w.state(), zone);
    w.ctx().store.append({ type: "noise_made", zone, level: 3, day: dayOf(w.state().time) });
    w.runCheat("~time +1d");
    expect(infestationOf(content, w.state(), zone)).toBeGreaterThan(Math.min(before, 2));
    w.close();
  });

  it("길의 위험과 감염체 틀 등장에 더해진다", () => {
    const { store, state } = setup();
    const s = state();
    s.lastRoute = { from: calm.id, to: calm.id };
    expect(routeDanger(content, s)).toBe(0);
    store.append({ type: "infestation_changed", zone: calm.id, level: 3, cause: "소음" });
    const t = state();
    t.lastRoute = { from: calm.id, to: calm.id };
    expect(routeDanger(content, t)).toBe(3);
    t.playerZone = calm.id;
    expect(describeExtraTemplates(t, content)).toContain("infected_hungry");
  });

  it("GM에게는 숫자 대신 그 구역에서 보이는 흔적만 간다", () => {
    const { store, state } = setup();
    expect(infestationSign(content, state(), calm.id)).toBeNull();
    store.append({ type: "infestation_changed", zone: calm.id, level: 1, cause: "소음" });
    expect(infestationSign(content, state(), calm.id)).toContain("평소보다 많다");
    store.append({ type: "infestation_changed", zone: wild.id, level: 0, cause: "소탕" });
    expect(infestationSign(content, state(), wild.id)).toContain("드물다");
    expect(infestationSign(content, state(), wild.id)).not.toMatch(/\d/);
  });
});
