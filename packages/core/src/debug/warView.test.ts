import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import { loadRealContent } from "../testing.ts";
import { buildWarMapView } from "./warView.ts";

/** 전황 지도 (디버그 전용): 모든 구역과 주인, 움직이는 부대의 지금 자리 */
const content = { ...loadRealContent(), storylets: {} };
const make = () => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-war-view-")), content, rngFactory: () => () => 0.5 }).create("mcp", "role_l_wanderer");

describe("전황 지도 (디버그)", () => {
  it("좌표 있는 구역을 모두 싣고, 주인·거점·주인공 자리를 그대로 보인다", () => {
    const w = make();
    const state = w.state();
    const view = buildWarMapView(state, content);
    const located = Object.values(content.locations).filter((l) => l.map);
    expect(view.zones.length).toBe(located.length);
    for (const z of view.zones) expect(z.owner).toBe(state.zones[z.id]?.owner ?? null);
    expect(view.zones.filter((z) => z.here).map((z) => z.id)).toEqual([state.playerZone]);
    const ids = new Set(view.zones.map((z) => z.id));
    for (const [a, b] of view.edges) expect(ids.has(a) && ids.has(b)).toBe(true);
    expect(view.factions.reduce((n, f) => n + f.zones, 0)).toBe(view.zones.filter((z) => z.owner).length);
  });

  it("부대는 지금 시각에 있는 구역에 놓인다", () => {
    const w = make();
    const state = w.state();
    const zone = state.playerZone!;
    const faction = Object.keys(state.factions)[0]!;
    const party = { id: "p1", faction, kind: "raid" as const, size: 6, leader: null, home: zone, goal: zone, legs: [{ zone, from: state.time - 10, to: state.time + 60 }], back: [], task: { kind: "watch" as const }, done: false, holds: 0, carry: {}, met: [], routedAt: null };
    const view = buildWarMapView({ ...state, parties: [party, { ...party, id: "gone", legs: [{ zone, from: state.time - 100, to: state.time - 50 }] }] }, content);
    expect(view.parties.map((p) => [p.id, p.zone, p.size, p.task])).toEqual([["p1", zone, 6, "watch"]]);
  });
});
