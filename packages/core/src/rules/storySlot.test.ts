import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StoryletContent } from "../content/schemas.ts";
import { createSeededRng } from "../rng.ts";
import { fastForward } from "../sim/fastForward.ts";
import { storyletAllowed, storyletWindow } from "../story/storylets.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { storyPlaceOnEntry, storyPlaces } from "./place.ts";
import { pacingBlocks, slotOpensBetween, storyletGapMinutes, storyText, storyTier } from "./storySlot.ts";

const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };
const world = (roleId: string) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-slot-")), content, rngFactory: () => createSeededRng(5) }).create("mcp", roleId, choice);
const story = (id: string) => content.storylets[id]!;
const fake = (over: Partial<StoryletContent>): StoryletContent => ({ ...story("y_soup"), essential: false, urgent: false, tags: ["world"], ...over }) as StoryletContent;

describe("공통 규칙 17: 이야기의 자리 (12-254)", () => {
  it("이야기마다 등급 하나: 꼭 > 급한 위협 > 급함 > 시나리오 > 공통", () => {
    expect(storyTier(content, story("wy_landing"))).toBe("must");
    expect(storyTier(content, fake({ urgent: true, ambush: true } as Partial<StoryletContent>))).toBe("urgent_threat");
    expect(storyTier(content, fake({ urgent: true }))).toBe("urgent");
    expect(storyTier(content, fake({ tags: ["y_islander"] }))).toBe("role");
    expect(storyTier(content, story("yl_haesol_questions"))).toBe("common");
  });

  it("앞 이야기와 최소 간격 안이면 급한 위협만 연다 (위협 아닌 급한 이야기는 기다린다)", () => {
    const w = world("role_a_grunt");
    const s = { ...w.state(), lastStoryletAt: w.state().time + 600, storyletLog: {} };
    const at = s.lastStoryletAt + 60;
    const win = storyletWindow(s, content, at);
    expect(win).toBe("threat_only");
    expect(storyletAllowed(s, content, fake({ urgent: true }), win, at)).toBe(false);
    expect(storyletAllowed(s, content, fake({ urgent: true, ambush: true } as Partial<StoryletContent>), win, at)).toBe(true);
    expect(storyletAllowed(s, content, fake({ essential: true }), win, at)).toBe(true);
    // 최소 간격이 지나면 급한 이야기, 긴 간격이 지나면 모두
    expect(storyletWindow(s, content, s.lastStoryletAt + 150)).toBe("urgent_only");
    expect(storyletWindow(s, content, s.lastStoryletAt + storyletGapMinutes(content, s.lastStoryletAt))).toBe("open");
  });

  it("시작 장면 대기는 시작한 구역에서만: 다른 구역으로 옮기면 바로 풀린다", () => {
    const w = world("role_a_grunt");
    const s = w.state();
    expect(s.runStartZone).toBe(s.playerZone);
    expect(storyletWindow(s, content, s.time + 10)).toBe("closed");
    expect(storyletWindow({ ...s, playerZone: "old_town" }, content, s.time + 10)).toBe("open");
  });

  it("같은 장소 하루 하나: 공통 이야기가 쓴 장소는 시나리오 이야기를 막지 않고, 시나리오 이야기가 쓴 장소는 공통 이야기를 막는다", () => {
    const w = world("role_y_islander");
    const s = w.state();
    // 같은 장소를 말하는 공통 이야기와 시나리오 이야기를 실제 콘텐츠에서 고른다
    const here = Object.values(content.storylets).filter((x) => x.when.zones?.includes(s.playerZone!) && !x.essential && !x.urgent && !x.when.mission);
    const placesOf = (x: StoryletContent) => storyPlaces(s, content, x.when.places, storyText(x));
    const common = here.find((x) => storyTier(content, x) === "common" && placesOf(x).length)!;
    const role = here.find((x) => storyTier(content, x) === "role" && placesOf(x).some((p) => placesOf(common).includes(p)))!;
    expect(common && role).toBeTruthy();
    const firedAt = s.time;
    const after = (id: string) => ({ ...s, storyletLog: { [id]: { fired: 1, lastFiredAt: firedAt } } });
    expect(pacingBlocks(after(common.id), content, role, firedAt + 60)).toBe(false);
    expect(pacingBlocks(after(role.id), content, common, firedAt + 60)).toBe(true);
  });

  it("장소 맞추기는 제목도 본다 (그물 창고의 기도는 제목에만 장소가 있다)", () => {
    const w = world("role_y_islander");
    const s = w.state();
    const st = story("fr_nur_missing");
    expect(storyPlaces(s, content, st.when.places, [st.setup, ...(st.variants ?? [])].join(" "))).toEqual([]);
    expect(storyPlaces(s, content, st.when.places, storyText(st))).toContain("farm_shore");
  });

  it("길(구역에 막 들어온 자리)에서 이야기가 장소 하나를 말하면 그 장소, 길 아닌 장소에 있거나 여럿이면 없음", () => {
    const w = world("role_y_islander");
    const s = { ...w.state(), playerZone: "yeoul_isle", playerPlace: "dock", justArrived: true };
    expect(storyPlaceOnEntry(s, content, ["quarters"], "")).toBe("quarters");
    // 구역 안에서 길로 나선 것은 막 들어온 것이 아니다 (PT21), 길 위의 이야기도 옮기지 않는다
    expect(storyPlaceOnEntry({ ...s, justArrived: false }, content, ["quarters"], "")).toBeNull();
    expect(storyPlaceOnEntry(s, content, ["quarters"], "", false, undefined, true)).toBeNull();
    expect(storyPlaceOnEntry({ ...s, playerPlace: "quarters" }, content, ["farm_shore"], "")).toBeNull();
    expect(storyPlaceOnEntry(s, content, ["quarters", "farm_shore"], "")).toBeNull();
  });

  it("빨리감기는 자리가 열리는 시각에 꼭 멈춰 검사한다 (한 시간씩 건너뛰어 늦게 열리지 않게)", () => {
    const w = world("role_a_grunt");
    const s = { ...w.state(), lastStoryletAt: w.state().time };
    const gapEnd = s.lastStoryletAt + storyletGapMinutes(content, s.lastStoryletAt);
    const stops = slotOpensBetween(s, content, s.time + 10, gapEnd + 600);
    expect(stops).toContain(gapEnd);
    expect(stops).toContain(s.lastStoryletAt + content.scenario.storylet_pacing.min_any_gap_hours * 60);
    const seen: number[] = [];
    const r = fastForward({ state: s, start: s.time + 10, until: gapEnd + 600, rng: createSeededRng(1), stops, checks: [({ to }) => (seen.push(to), to === gapEnd ? { kind: "storylet", detail: "일", at: to } : null)] });
    expect(r.end).toBe(gapEnd);
  });
});
