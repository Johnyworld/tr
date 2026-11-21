import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import { loadRealContent } from "../testing.ts";
import { buildMapView, renderMapAscii, visitedZones } from "./map.ts";
import { runCommand } from "../commands/commands.ts";

/** 지도 (12-201): 가 본 곳과 그 이웃만 */
const content = { ...loadRealContent(), storylets: {} };
const make = () => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-map-")), content, rngFactory: () => () => 0.5 }).create("mcp", "role_l_wanderer");

describe("지도 (12-201)", () => {
  it("처음에는 지금 있는 곳과 맞닿은 곳만, 가 본 곳이 늘면 함께 늘어난다", () => {
    const w = make();
    const start = w.state().playerZone!;
    const first = buildMapView(w.state(), content)!;
    expect(first.nodes.find((n) => n.id === start)?.state).toBe("here");
    expect(first.nodes.filter((n) => n.state !== "seen").map((n) => n.id)).toEqual([start]);
    // 가 보지 않은 먼 곳은 싣지 않는다
    expect(first.nodes.some((n) => n.id === "prison")).toBe(false);
    const next = first.nodes.find((n) => n.state === "seen")!.id;
    w.ctx().store.append({ type: "zone_moved", from: start, to: next });
    const after = buildMapView(w.state(), content)!;
    expect(after.nodes.find((n) => n.id === start)?.state).toBe("visited");
    expect(after.nodes.find((n) => n.id === next)?.state).toBe("here");
    expect(visitedZones(w.state())).toEqual(expect.arrayContaining([start, next]));
  });

  it("가 보지 않은 곳은 이름도 거점 표시도 없고, 길은 가 본 곳에 닿은 것만", () => {
    const w = make();
    const map = buildMapView(w.state(), content)!;
    for (const n of map.nodes) if (n.state === "seen") expect([n.base, n.name, n.label]).toEqual([false, "", ""]);
    const known = new Set(map.nodes.filter((n) => n.state !== "seen").map((n) => n.id));
    for (const [a, b] of map.edges) expect(known.has(a) || known.has(b)).toBe(true);
  });

  it("?지도에 가 본 곳 목록이 나온다", () => {
    const w = make();
    const text = runCommand("?지도", { state: w.state(), content, summaries: [] });
    expect(text).toContain("가 본 곳");
    expect(text).toContain(content.locations[w.state().playerZone!]!.name);
  });

  it("글자 지도: 지금 여기는 @, 가 보지 않은 곳은 이름 없이 ?", () => {
    const w = make();
    const view = buildMapView(w.state(), content)!;
    const art = renderMapAscii(view);
    expect(art).toContain("@");
    expect(art).toContain("?");
    for (const n of view.nodes) if (n.state === "seen") expect(art).not.toContain(content.locations[n.id]!.map!.label ?? content.locations[n.id]!.name);
    // 채팅 ?지도에는 글자 그림 대신 가 본 곳 목록이 나온다 (12-239)
    const text = runCommand("?지도", { state: w.state(), content, summaries: [] });
    expect(text).not.toContain(art);
    expect(text).toContain("가 본 곳 (주인은 본 대로 · 맞닿은 곳)");
  });
});
