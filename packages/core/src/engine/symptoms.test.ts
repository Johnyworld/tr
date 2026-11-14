import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { createSeededRng } from "../rng.ts";
import { conditionPenalty, visibleSymptoms } from "../scenario/scenario.ts";
import { WorldManager } from "../world/manager.ts";
import { changeCondition } from "./body.ts";

/** 증상 (12-74): 원인은 숨기고 증상만, 겹치는 증상은 하나, 판정 보정은 보이는 증상의 합 */
const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const s = content.scenario;
const labels = (conditions: Record<string, string>) => visibleSymptoms(s, { conditions }).map((x) => x.label);
const base = { harm: "none", hunger: "fed", infection: "clean", cold: "warm", disease: "healthy", nerves: "steady" };

describe("증상", () => {
  it("감염과 질병의 고열은 하나로, 같은 묶음은 큰 것만, 잠복은 보이지 않는다", () => {
    expect(labels({ ...base, infection: "fever", disease: "sick" })).toEqual(["고열"]);
    expect(labels({ ...base, infection: "grave", cold: "cold" })).toEqual(["고열", "메스꺼움"]);
    expect(labels({ ...base, infection: "incubating", disease: "incubating" })).toEqual([]);
    expect(labels({ ...base, harm: "impaired", hunger: "unconscious" })).toEqual(["극심한 고통", "의식불명"]);
    expect(labels({ ...base, nerves: "low" })).toEqual(["우울함"]);
  });

  it("판정 보정은 가장 큰 증상 그대로 + 나머지 합의 반(올림) (겹치면 한 번, 바닥 없음)", () => {
    expect(conditionPenalty(s, { conditions: { ...base, infection: "fever", disease: "sick" } })).toBe(-3);
    // 고통 1 + 허기짐 1 → -2 (괴로움은 보정이 없어 세지 않는다)
    expect(conditionPenalty(s, { conditions: { ...base, harm: "light", hunger: "hungry", nerves: "shaken" } })).toBe(-2);
    // 고열 3 + 메스꺼움 1 → -4
    expect(conditionPenalty(s, { conditions: { ...base, infection: "grave" } })).toBe(-4);
    // 고통 1 + 굶주림 2 + 고열 3 + 멘탈붕괴 3 → -6
    expect(conditionPenalty(s, { conditions: { ...base, harm: "light", hunger: "starving", infection: "fever", nerves: "broken" } })).toBe(-6);
    // 1+1+1+1 → -3, 3+2 → -4
    expect(conditionPenalty(s, { conditions: { ...base, harm: "light", hunger: "hungry", cold: "cold", nerves: "low" } })).toBe(-3);
    expect(conditionPenalty(s, { conditions: { ...base, harm: "critical", hunger: "starving" } })).toBe(-4);
  });

  it("단계 이름은 증상에서 나온다 (GM에게는 트랙 이름과 함께)", () => {
    const infection = s.condition_tracks.find((t) => t.id === "infection")!;
    expect(infection.levels.find((l) => l.id === "grave")).toMatchObject({ label: "고열 · 메스꺼움", penalty: -4 });
    expect(infection.levels[0]!.label).toBe("이상 없음");
  });

  it("굶주림과 추위는 부상 없이 그 트랙 끝에서 죽는다", () => {
    for (const track of ["hunger", "cold"]) {
      const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-sym-")), content, rngFactory: () => createSeededRng(1) }).create("mcp", "role_a_grunt");
      const r = changeCondition(w.ctx(), "player", track, 10, "test", "시험");
      expect(r?.died, track).toBe(true);
      expect(w.state().characters.player).toMatchObject({ dead: true, conditions: { harm: "none" } });
      w.close();
    }
  });
});
