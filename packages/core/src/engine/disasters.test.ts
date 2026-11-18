import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Rng } from "../rng.ts";
import { WorldManager } from "../world/manager.ts";
import type { GameWorld } from "../world/world.ts";
import { loadRealContent } from "../testing.ts";
import { dayOf } from "../rules/time.ts";
import { disasterWeather, runDisasters } from "./disasters.ts";

/** 큰 재난 (12-169) */
const content = { ...loadRealContent(), storylets: {} };
function world(value = 0): { w: GameWorld; roll: { value: number } } {
  const roll = { value };
  const rng: Rng = () => roll.value;
  const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-disaster-")), content, rngFactory: () => rng }).create("mcp", "role_a_grunt");
  return { w, roll };
}
const today = (w: GameWorld) => dayOf(w.state().time);
const schedule = (w: GameWorld, kind: string, zone: string | null, faction: string | null) =>
  w.ctx().store.append({ type: "disaster_scheduled", kind, zone, faction, day: today(w) + 3 });

describe("큰 재난", () => {
  it("확률이 맞으면 계절에 맞는 재난을 사흘 뒤로 잡고, 가까이 있으면 GM 상태에 낌새만 보인다", () => {
    const { w } = world(0);
    runDisasters(w.ctx(), today(w));
    const d = w.state().disaster!;
    expect(d.phase).toBe("omen");
    expect(d.day).toBe(today(w) + 3);
    // 앞 재난이 있는 동안은 새로 잡지 않는다
    runDisasters(w.ctx(), today(w));
    expect(w.state().disaster!.kind).toBe(d.kind);
  });

  it("때가 되면 덮친다: 자원·인원이 줄고, 산출이 멈추고, 소식이 온다. 지나가면 끝난다", () => {
    const { w, roll } = world(0.99);
    const zone = w.state().playerZone!;
    const f = w.state().zones[zone]!.owner!;
    schedule(w, "fire", zone, f);
    expect(w.sceneForGm()).toContain("낌새");
    const before = w.state().factions[f]!;
    const fuel = before.resources.fuel ?? 0;
    const pop = before.population;
    runDisasters(w.ctx(), today(w) + 3);
    const after = w.state().factions[f]!;
    expect(after.resources.fuel ?? 0).toBeLessThan(fuel);
    expect(after.population).toBeLessThan(pop);
    expect(w.state().disaster!.phase).toBe("struck");
    expect(w.state().zones[zone]!.stalledUntil).toBeGreaterThan(today(w));
    expect(w.state().zones[zone]!.owner).toBe(f); // 0.99라 무너지지 않았다
    expect((w.state().beliefs[w.state().playerId] ?? []).some((b) => b.fact.includes("큰불"))).toBe(true);
    void roll;
    runDisasters(w.ctx(), w.state().disaster!.until + 1);
    expect(w.state().disaster).toBeNull();
    expect(w.state().lastDisasterDay).not.toBeNull();
  });

  it("대비하면 피해가 줄고, 운이 나쁘면 거점을 잃는다", () => {
    const a = world(0.99);
    const zone = a.w.state().playerZone!;
    const f = a.w.state().zones[zone]!.owner!;
    schedule(a.w, "fire", zone, f);
    const fuel = a.w.state().factions[f]!.resources.fuel ?? 0;
    runDisasters(a.w.ctx(), today(a.w) + 3);
    const lostPlain = fuel - (a.w.state().factions[f]!.resources.fuel ?? 0);

    const b = world(0.99);
    schedule(b.w, "fire", zone, f);
    b.w.ctx().store.append({ type: "disaster_prepared" });
    b.w.ctx().store.append({ type: "disaster_prepared" });
    runDisasters(b.w.ctx(), today(b.w) + 3);
    const lostPrepared = fuel - (b.w.state().factions[f]!.resources.fuel ?? 0);
    expect(lostPrepared).toBeLessThan(lostPlain);

    const c = world(0);
    schedule(c.w, "fire", zone, f);
    runDisasters(c.w.ctx(), today(c.w) + 3);
    expect(c.w.state().zones[zone]!.owner).toBeNull();
  });

  it("혹한은 그동안 날씨를 한파로 묶는다", () => {
    const { w } = world(0.99);
    schedule(w, "cold", null, null);
    runDisasters(w.ctx(), today(w) + 3);
    expect(disasterWeather(content, w.state(), today(w) + 4)).toBe("cold_snap");
  });

  it("돌림병은 그 무리의 이름 있는 사람과 주인공을 앓게 한다", () => {
    const { w } = world(0);
    const f = w.state().characters[w.state().playerId]!.factionId;
    schedule(w, "plague", null, f);
    runDisasters(w.ctx(), today(w) + 3);
    const sick = Object.values(w.state().characters).filter((c) => c.factionId === f && content.npcs[c.id] && c.conditions.disease !== "healthy");
    expect(sick.length).toBeGreaterThan(0);
  });
});
