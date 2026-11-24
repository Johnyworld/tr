import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { loadRealContent } from "../testing.ts";
import { buildPlaceMapView, placeListLines } from "../views/map.ts";
import { WorldManager } from "../world/manager.ts";
import { currentPlace, directionTo, knowsZone, placeCoord, placesIn, roadTo } from "./place.ts";

/** 맵 늘리기 3단계 (12-304): 장소 좌표·8방위, 아는 구역·처음 가는 구역, 구역 안 지도 */
const content = loadRealContent();
const world = (role = "role_a_grunt") => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-pmap-")), content, rngFactory: () => createSeededRng(3) }).create("mcp", role);
const act = (input: Record<string, unknown>) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true, ...input });

describe("장소 좌표와 방향 (12-304)", () => {
  it("모든 장소에 좌표가 있고(콘텐츠 또는 담 깊이로 저절로), 8방위는 위가 북쪽이다", () => {
    const w = world();
    const s = w.state();
    for (const zone of Object.keys(content.locations)) for (const p of placesIn(s, content, zone)) expect(placeCoord(s, content, p.id, zone), `${zone}.${p.id}`).not.toBeNull();
    // 좌표를 직접 주어 방위를 본다
    const zone = s.playerZone!;
    const [a, b] = placesIn(s, content, zone);
    const fake = structuredClone(content);
    fake.locations[zone]!.places.find((p) => p.id === a!.id)!.map = { x: 50, y: 50 };
    const set = (x: number, y: number) => (fake.locations[zone]!.places.find((p) => p.id === b!.id)!.map = { x, y });
    set(50, 20);
    expect(directionTo(s, fake, a!.id, b!.id, zone)).toBe("북쪽");
    set(80, 80);
    expect(directionTo(s, fake, a!.id, b!.id, zone)).toBe("남동쪽");
    set(20, 50);
    expect(directionTo(s, fake, a!.id, b!.id, zone)).toBe("서쪽");
    expect(directionTo(s, fake, a!.id, a!.id, zone)).toBeNull();
  });
});

describe("이동 규칙 (12-304)", () => {
  it("아는 구역: 가 본 구역·우리 무리 땅·시작 구역. 소문으로 들은 구역은 아니다", () => {
    const w = world();
    const s = w.state();
    expect(knowsZone(s, content, s.playerZone!)).toBe(true);
    expect(knowsZone(s, content, "c_base")).toBe(false);
  });

  it("처음 가는 구역은 그 구역으로 가는 길에서만 떠난다. 거절 글에 길을 알린다. 판정을 건 달아나기는 예외", () => {
    const w = world();
    const s = w.state();
    const here = currentPlace(s, content)!;
    const dest = placesIn(s, content, s.playerZone).flatMap((p) => (p.road ? p.to : [])).find((z) => !knowsZone(s, content, z))!;
    const road = roadTo(s, content, dest)!;
    expect(here.id).not.toBe(road.id);
    const r = w.executeTool("take_action", act({ move_to: dest }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain(`place_to로 ${road.name}(${road.id})`);
    expect(w.executeTool("take_action", act({ place_to: road.id })).ok).toBe(true);
    expect(w.executeTool("take_action", act({ move_to: dest })).ok).toBe(true);
    expect(w.state().playerZone).toBe(dest);
  });

  it("아는 구역은 어디서든 선언 한 번으로 가고, 그 길까지 걷는 칸 수만큼 시간이 더 든다", () => {
    const w = world();
    const s = w.state();
    const home = s.playerZone!;
    const dest = placesIn(s, content, home).flatMap((p) => (p.road ? p.to : [])).find((z) => knowsZone(s, content, z) && z !== home);
    if (!dest) return; // 시작 구역에 맞닿은 아는 구역이 없으면 볼 것이 없다
    const t0 = w.state().time;
    const r = w.executeTool("take_action", act({ move_to: dest }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().time - t0).toBeGreaterThan(0);
  });
});

describe("구역 안 지도 (12-304)", () => {
  it("아는 장소와 지금 자리의 모르는 문만 싣고, ?지도는 글 목록으로 보인다", () => {
    const w = world();
    const view = buildPlaceMapView(w.state(), content)!;
    expect(view.nodes.some((n) => n.state === "here")).toBe(true);
    // 문은 지금 자리와만 잇는다
    for (const [a, b] of view.edges) if (a.startsWith("door") || b.startsWith("door")) expect([a, b]).toContain(currentPlace(w.state(), content)!.id);
    const lines = placeListLines(w.state(), content);
    expect(lines[0]).toContain("★");
    expect(lines.join("\n")).not.toMatch(/[|\\/]{3,}/); // 글자 그림이 아니다
  });
});
