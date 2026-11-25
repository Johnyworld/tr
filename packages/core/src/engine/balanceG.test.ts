import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { idleDays } from "../game/missions.ts";
import { nextSegmentStart } from "../rules/time.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";

/** 균형 G (플레이 테스트 11): 섬의 쓸모, 붉은연합 점호 */
const content = loadRealContent();
const open = (role: string) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-g-")), content, rngFactory: () => () => 0.5 }).create("mcp", role);

describe("균형 G", () => {
  it("여울섬: 사흘 동안 임무를 끝내지 않으면 배급이 줄었다는 까닭으로 배가 고파진다", () => {
    const w = open("role_y_islander");
    const s = w.state();
    s.runStartedAt = s.time - 3 * 24 * 60;
    expect(idleDays(s, s.playerId)).toBeGreaterThanOrEqual(3);
    const out = w.runCheat("~time +1d");
    expect(out.ok).toBe(true);
    const lines = w.ctx().store.events().filter((e) => e.type === "condition_changed" && ((e as { cause?: string }).cause ?? "").startsWith("일하지 않아 배급이 줄었다"));
    expect(lines.length).toBeGreaterThan(0);
  });

  it("붉은연합: 거점에서 자면 점호 시각에 동료가 깨우고, 다시 자면 불복종 행적이 남는다 (12-251)", () => {
    const w = open("role_c_raider");
    const before = Object.values(w.state().deeds).length;
    w.state().characters[w.state().playerId]!.conditions.fatigue = "weary"; // 지쳐 있으면 오래 잔다 (E4)
    const first = w.executeTool("take_action", { intent: "잔다", activity: { kind: "sleep", until: "dawn" } });
    expect(JSON.stringify(first)).toContain("점호 시각이라 동료가 깨웠다");
    expect(Object.values(w.state().deeds).slice(before).some((d) => d.summary.includes("점호"))).toBe(false);
    w.executeTool("take_action", { intent: "다시 잔다", activity: { kind: "sleep", until: "dawn" } });
    const deeds = Object.values(w.state().deeds).slice(before);
    expect(deeds.some((d) => d.summary.includes("점호"))).toBe(true);
  });

  it("붉은연합: 깨어 있던 활동이 점호 시각에 끝난 뒤 자는 것은 점호에 나간 것이다 (12-312)", () => {
    const w = open("role_c_raider");
    const before = Object.values(w.state().deeds).length;
    // 깨어 기다리다 저녁 점호 시각이 된다 (막사에서 "저녁까지 쉬기"가 17:00에 끝난 것과 같다)
    const call = nextSegmentStart(w.state().time, "evening");
    expect(w.runCheat("~time evening").ok).toBe(true);
    expect(w.state().time).toBe(call);
    w.executeTool("take_action", { intent: "잔다", activity: { kind: "sleep", hours: 2 }, ignore_story: true });
    expect(Object.values(w.state().deeds).slice(before).some((d) => d.summary.includes("점호"))).toBe(false);
  });
});

