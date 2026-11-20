import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { idleDays } from "../game/missions.ts";
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

  it("붉은연합: 점호 시각을 자면서 넘기면 불복종 행적이 남는다", () => {
    const w = open("role_c_raider");
    const before = Object.values(w.state().deeds).length;
    w.state().characters[w.state().playerId]!.conditions.fatigue = "weary"; // 지쳐 있으면 오래 잔다 (E4)
    w.executeTool("take_action", { intent: "잔다", activity: { kind: "sleep", until: "dawn" } });
    const deeds = Object.values(w.state().deeds).slice(before);
    expect(deeds.some((d) => d.summary.includes("점호"))).toBe(true);
  });
});
