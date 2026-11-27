import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { arrivalPlace, closeness, currentPlace, depthAt, placesIn, routineAway, stepsBetween, whereIs, whereLabel } from "../rules/place.ts";
import { segmentOf } from "../rules/time.ts";
import type { GameState } from "../game/state.ts";
import { stepToRoad, loadRealContent, walkToPlace } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";

/** 장소 개편 (12-274, docs/places-v2-plan.md): 길에 도착, 이웃 칸수, gate 깊이, 근처 목격, 구역 밖 일과. 실제 콘텐츠로 본다 */
const content = loadRealContent();
const make = (roleId = "role_a_grunt") =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-274-")), content, rngFactory: () => () => 0.5 }).create("mcp", roleId, { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] } as never);
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true, ...input });
const at = (s: GameState, segment: string) => {
  const day = s.time - (s.time % 1440);
  for (let t = day; t < day + 1440; t += 30) if (segmentOf(t) === segment) return t;
  throw new Error(segment);
};

describe("장소 개편 (12-274)", () => {
  it("모든 구역에 길이 있고, 구역에 들어오면 떠나온 쪽 길에 도착한다", () => {
    const w = make();
    for (const zone of Object.keys(content.locations)) expect(placesIn(w.state(), content, zone).some((p) => p.road), zone).toBe(true);
    expect(arrivalPlace(w.state(), content, "a_base", "bus_depot")).toBe("to_old_town");
    expect(arrivalPlace(w.state(), content, "a_base", "drain_canal")).toBe("to_riverside");
    stepToRoad(w, "bus_depot");
    w.executeTool("take_action", act({ move_to: "bus_depot" }));
    expect(w.state().playerZone).toBe("bus_depot");
    expect(currentPlace(w.state(), content)?.id).toBe("to_pine");
  });

  it("장소는 이웃으로 한 칸씩만 옮긴다: 이웃은 5분, 이웃이 아니면 시간 없이 거절, 걸어가면 칸마다 5분", () => {
    const w = make();
    w.ctx().store.append({ type: "place_moved", from: w.state().playerPlace, to: "to_old_town" });
    const s = w.state();
    expect(stepsBetween(s, content, "to_old_town", "wall_path")).toBe(1);
    expect(stepsBetween(s, content, "to_old_town", "barracks")).toBe(3); // 둘레길 → 뒷담 쪽문 → 막사
    const t = s.time;
    const far = w.executeTool("take_action", act({ place_to: "barracks" }));
    expect(far.ok).toBe(false);
    expect(far.ok ? "" : far.error).toContain("이웃 장소로 한 칸씩");
    expect(far.ok ? "" : far.error).toContain("시간은 흐르지 않았다");
    expect(w.state().time).toBe(t);
    expect(currentPlace(w.state(), content)?.id).toBe("to_old_town");
    const near = w.executeTool("take_action", act({ place_to: "wall_path" }));
    expect(near.ok, near.ok ? "" : near.error).toBe(true);
    expect(w.state().time - t).toBe(5);
    expect(walkToPlace(w, "barracks")).toBe(true);
    expect(currentPlace(w.state(), content)?.id).toBe("barracks");
    expect(w.state().time - t).toBe(15); // 둘레길 5분 + 쪽문 5분 + 막사 5분
  });

  it("즉흥 장소는 만든 자리의 이웃이 된다", () => {
    const w = make();
    w.ctx().store.append({ type: "place_moved", from: w.state().playerPlace, to: "barracks" });
    const r = w.executeTool("spawn_place", { name: "막사의 내 자리", indoor: true, owner: null });
    expect(r.ok).toBe(true);
    const mine = placesIn(w.state(), content, "a_base").find((p) => p.name === "막사의 내 자리")!;
    expect(mine.near).toEqual(["barracks"]);
    expect(placesIn(w.state(), content, "a_base").find((p) => p.id === "barracks")!.near).toContain(mine.id);
  });

  it("담 있는 거점의 깊이는 gate에서 센다", () => {
    const s = make().state();
    expect(depthAt(s, content, "to_old_town")).toBe(0);
    expect(depthAt(s, content, "checkpoint")).toBe(0);
    expect(depthAt(s, content, "yard_gate")).toBe(1);
    expect(depthAt(s, content, "back_gap")).toBe(1);
    expect(depthAt(s, content, "barracks")).toBe(2);
  });

  it("일과가 구역 밖에 나간 시간이면 구역에 없고, 숨은 목격자도 아니다. 들이려 하면 알린다", () => {
    const w = make();
    const day = { ...w.state(), time: at(w.state(), "day") };
    // 버들마을의 본식: 낮 "구시가 수색"
    expect(routineAway(day, content, "b_bonsik")).toContain("수색");
    expect(whereIs(day, content, "b_bonsik")).toEqual({ zone: null, place: null });
    expect(whereLabel(day, content, "b_bonsik")).toContain("나가 있다");
    expect(closeness({ ...day, playerZone: "b_base", playerPlace: "gate" }, content, "b_bonsik")).toBe(0);
    // 밤에는 돌아와 있다
    const night = { ...w.state(), time: at(w.state(), "night") };
    expect(routineAway(night, content, "b_bonsik")).toBeNull();
    expect(whereIs(night, content, "b_bonsik")?.zone).toBe("b_base");
  });

  it("주인공의 분대원은 일과가 구역 밖이어도 구역에 있다", () => {
    const w = make("role_b_squad_leader");
    const squad = content.roles.role_b_squad_leader?.squad ?? [];
    const day = { ...w.state(), time: at(w.state(), "day") };
    for (const id of squad) expect(routineAway(day, content, id)).toBeNull();
  });
});
