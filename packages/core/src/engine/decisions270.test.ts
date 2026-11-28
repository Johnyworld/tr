import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkNpcRoutines } from "../content/loader.ts";
import { darkHere, storyPlaceFits, storyPlaces } from "../rules/place.ts";
import { segmentOf } from "../rules/time.ts";
import type { GameState } from "../game/state.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";

/** 구역·장소 설계 ① 장소 맞추기 (12-270): 이야기의 실내외·별칭, 일과 검사, 어둠·손전등. 실제 콘텐츠로 본다 */
const content = loadRealContent();
const make = () =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-270-")), content, rngFactory: () => () => 0.5 }).create("mcp", "role_a_grunt", { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] } as never);

/** 그 시간대가 되는 첫 시각 (그날 안에서) */
const at = (s: GameState, segment: string) => {
  const day = s.time - (s.time % 1440);
  for (let t = day; t < day + 1440; t += 30) if (segmentOf(t) === segment) return t;
  throw new Error(segment);
};

describe("장소 맞추기 (12-270)", () => {
  it("길(구역에 막 들어온 자리)은 바깥: 실내 장소를 말하지 않는 실내 이야기는 열리지 않는다", () => {
    const s = { ...make().state(), playerZone: "a_base", playerPlace: "to_old_town" };
    expect(storyPlaceFits(s, content, false)).toBe(true);
    expect(storyPlaceFits(s, content, true, {}, "누군가 문을 두드린다")).toBe(false);
    // 실내 장소를 말해도 데려가지 않는다 (이동 기획: 이야기는 주인공을 옮기지 않는다). 부르는 이야기만 그 장소로
    expect(storyPlaceFits(s, content, true, {}, "의무실 침대에서 신음이 들린다")).toBe(false);
    expect(storyPlaceFits(s, content, true, { summons: true }, "의무실 침대에서 신음이 들린다")).toBe(true);
    // 길이 아닌 바깥 장소에서는 데려가지 않는다
    expect(storyPlaceFits({ ...s, playerPlace: "yard_gate" }, content, true, {}, "의무실 침대에서 신음이 들린다")).toBe(false);
  });

  it("글자로 맞춘 장소는 이야기의 실내외와 같아야 한다 (바위 위 '저장고 아래'가 식당이 아니다)", () => {
    const s = { ...make().state(), playerZone: "yeoul_isle", playerPlace: null };
    expect(storyPlaces(s, content, undefined, "저장고 아래 바위")).toEqual(["council_hall"]);
    expect(storyPlaces(s, content, undefined, "저장고 아래 바위", false)).toEqual([]);
    // 12-300: 장소 id 대신 종류로 (섬의 field는 farm_shore 하나)
    expect(storyPlaces(s, content, content.storylets.y2_low_tide!.when, "")).toEqual(["farm_shore"]);
  });

  it("떠돌지 않는 인물의 일과는 모두 장소로 정해지거나 구역 밖이다", () => {
    expect(checkNpcRoutines(content)).toEqual([]);
    const npc = Object.values(content.npcs).find((n) => !n.roams?.length && content.locations[n.zone ?? ""]?.places.length)!;
    const bad = { ...content, npcs: { [npc.id]: { ...npc, routine: { day: "하늘 보기" } } } };
    expect(checkNpcRoutines(bad as never)).toHaveLength(1);
  });

  it("불이 타는 지붕 아래는 어둡지 않다", () => {
    const base = make().state();
    const night = at(base, "night");
    const inside = { ...base, playerZone: "a_base", playerPlace: "barracks", time: night };
    const segments = content.scenario.opposition!.dark!.segments;
    expect(darkHere(inside, content, segments)).toBe(true);
    expect(darkHere({ ...inside, fires: { "a_base@barracks": night + 600 } }, content, segments)).toBe(false);
    expect(darkHere({ ...inside, playerPlace: "yard_gate", fires: { "a_base@yard_gate": night + 600 } }, content, segments)).toBe(true);
  });

});
