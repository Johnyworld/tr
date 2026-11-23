import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activityTarget, sleepCapMinutes } from "../rules/time.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";

/** 플레이 테스트 15 파트 3 (12-255): 시간·활동·몸 */
const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };
const world = (roleId: string) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-255-")), content, rngFactory: () => () => 0.5 }).create("mcp", roleId, choice);
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true, ...input });
const day = 1440;

describe("활동의 길이 (12-255)", () => {
  it("hours > until > 임무에 남은 시간 > 기본 길이", () => {
    expect(activityTarget({ from: 600, until: "evening", hours: 1.5, missionLeft: 30, defaultMinutes: 60 })).toBe(690);
    expect(activityTarget({ from: 600, until: "evening", hours: null, missionLeft: 30, defaultMinutes: 60 })).toBe(17 * 60);
    expect(activityTarget({ from: 600, until: null, hours: null, missionLeft: 30, defaultMinutes: 60 })).toBe(630);
    expect(activityTarget({ from: 600, until: null, hours: null, missionLeft: null, defaultMinutes: 60 })).toBe(660);
  });

  it("잠의 상한: 피곤하면 길게, 피곤하지 않으면 저녁 전엔 낮잠, 저녁 뒤엔 rested, 중상이면 피곤과 상관없이 길게", () => {
    const base = { maxMinutes: 960, restedHours: 12, napHours: 3 };
    expect(sleepCapMinutes({ ...base, rested: false, hurt: false, lyingDownAt: 13 * 60 })).toEqual({ minutes: 960, nap: false });
    expect(sleepCapMinutes({ ...base, rested: true, hurt: false, lyingDownAt: 13 * 60 })).toEqual({ minutes: 180, nap: true });
    expect(sleepCapMinutes({ ...base, rested: true, hurt: false, lyingDownAt: 21 * 60 })).toEqual({ minutes: 720, nap: false });
    expect(sleepCapMinutes({ ...base, rested: true, hurt: true, lyingDownAt: 13 * 60 })).toEqual({ minutes: 960, nap: false });
  });

  it("activity.hours로 몇 시간만 기다리고, 일도 늘인다. 식사에는 hours를 못 쓰고, until과 함께 쓰지 않는다", () => {
    const w = world("role_a_grunt");
    const t0 = w.state().time;
    const r = w.executeTool("take_action", act({ activity: { kind: "wait", until: null, hours: 0.5 } }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().time - t0).toBe(30);
    const t1 = w.state().time;
    const work = w.executeTool("take_action", act({ activity: { kind: "work", until: null, hours: 3 } }));
    expect(work.ok, work.ok ? "" : work.error).toBe(true);
    if (!(work.ok && work.resultText.includes("끊겼다"))) expect(w.state().time - t1).toBe(180);
    const eat = w.executeTool("take_action", act({ activity: { kind: "eat", until: null, hours: 1 } }));
    expect(eat.ok ? "" : eat.error).toContain("hours를 쓸 수 없다");
    const both = w.executeTool("take_action", act({ activity: { kind: "wait", until: "night", hours: 1 } }));
    expect(both.ok ? "" : both.error).toContain("하나만");
  });

  it("장소를 옮긴 턴의 잠깐 행동은 옮기는 5분에 들어간다", () => {
    const w = world("role_a_grunt");
    const t0 = w.state().time;
    const r = w.executeTool("take_action", act({ intent: "운동장으로 나가 둘러본다", place_to: "yard_gate" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().time - t0).toBe(5);
    expect(r.ok && r.resultText).toContain("옮기는 시간에 들어갔다");
  });

  it("피곤하지 않은데 낮에 자면 낮잠으로 끝난다", () => {
    const w = world("role_a_grunt");
    w.runCheat("~time +6h");
    const t0 = w.state().time;
    const r = w.executeTool("take_action", act({ activity: { kind: "sleep", until: "morning", hours: null } }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    if (!(r.ok && r.resultText.includes("끊겼다"))) {
      expect(w.state().time - t0).toBeLessThanOrEqual(180);
      expect(r.ok && r.resultText).toContain("낮잠");
    }
    expect(Math.floor(w.state().time / day)).toBe(Math.floor(t0 / day));
  });
});

describe("물에 들어가기 (12-255)", () => {
  it("물이 나는 바깥 물가에서 물에 들어가면 옷이 젖고, 물이 없는 곳에서는 거절한다", () => {
    const w = world("role_a_grunt");
    const no = w.executeTool("take_action", act({ intent: "물에 뛰어든다", wade: true }));
    expect(no.ok && no.resultText).toContain("물에 들어가지 못했다");
    w.runCheat("~goto riverside");
    const r = w.executeTool("take_action", act({ intent: "옷을 입은 채 강물에 뛰어든다", wade: true }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().wet?.[w.state().playerId] ?? 0).toBeGreaterThan(0);
    expect(r.ok && r.resultText).toContain("흠뻑 젖었다");
  });
});

describe("추위 (12-255)", () => {
  it("녹는 속도는 반으로 (지붕 아래 10, 따뜻한 곳 25)", () => {
    expect(content.scenario.body?.cold?.climate?.mild_rate).toBe(10);
    expect(content.scenario.body?.cold?.climate?.warm_rate).toBe(25);
  });
});
