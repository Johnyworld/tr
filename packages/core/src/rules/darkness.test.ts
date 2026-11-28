import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GameState } from "../game/state.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { scavengeParts } from "../engine/scavenge.ts";
import { darknessOf, darkSearchMinutes } from "./darkness.ts";
import { segmentOf } from "./time.ts";

/** 공통 규칙 27: 어둠 속 눈 (12-360). 실제 콘텐츠로 본다 */
const content = loadRealContent();
const make = () =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-dark-")), content, rngFactory: () => () => 0.5 }).create("mcp", "role_a_grunt", { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] } as never);

const at = (s: GameState, segment: string) => {
  const day = s.time - (s.time % 1440);
  for (let t = day; t < day + 1440; t += 30) if (segmentOf(t) === segment) return t;
  throw new Error(segment);
};

/** 바깥(구역 길바닥)에서 시각·트레잇·소지품을 정한 상태 */
function situation(segment: string, opts: { traits?: string[]; inventory?: Record<string, number> } = {}): GameState {
  const base = make().state();
  const me = { ...base.characters[base.playerId]!, traits: opts.traits ?? [], inventory: opts.inventory ?? {} };
  return { ...base, playerZone: "a_base", playerPlace: "yard_gate", time: at(base, segment), characters: { ...base.characters, [base.playerId]: me } };
}

describe("어둠 속 눈 (공통 규칙 27)", () => {
  it("낮에는 아무것도 없다", () => {
    expect(darknessOf(situation("day"), content)).toEqual({ dark: false, penalty: 0, searchTime: 1, glare: false });
  });

  it("밤 맨몸: 감점 1, 수색 시간 ×1.5, 불빛 없음", () => {
    const d = darknessOf(situation("night"), content);
    expect(d).toEqual({ dark: true, penalty: 1, searchTime: 1.5, glare: false });
    expect(darkSearchMinutes(15, d)).toBe(25);
    expect(darkSearchMinutes(60, d)).toBe(90);
  });

  it("손전등은 감점과 시간을 지우고 눈에 띈다", () => {
    const d = darknessOf(situation("night", { inventory: { flashlight: 1 } }), content);
    expect(d).toEqual({ dark: true, penalty: 0, searchTime: 1, glare: true });
    expect(darkSearchMinutes(60, d)).toBe(60);
  });

  it("어둠에 익숙함: 맨몸이어도, 손전등을 들어도 감점도 눈에 띔도 없다", () => {
    for (const inventory of [{}, { flashlight: 1 }] as Record<string, number>[]) {
      expect(darknessOf(situation("night", { traits: ["dark_adapted"], inventory }), content)).toEqual({ dark: true, penalty: 0, searchTime: 1, glare: false });
    }
  });

  it("야맹증: 감점 2, 시간 ×2. 손전등이 있으면 보통 사람과 같다", () => {
    expect(darknessOf(situation("night", { traits: ["night_blind"] }), content)).toEqual({ dark: true, penalty: 2, searchTime: 2, glare: false });
    expect(darknessOf(situation("night", { traits: ["night_blind"], inventory: { flashlight: 1 } }), content)).toEqual({ dark: true, penalty: 0, searchTime: 1, glare: true });
  });

  it("수색 판정 줄에 '어둠'이 붙는다 (밤 맨몸만)", () => {
    // scavengeParts는 구역의 loot가 있어야 한다
    const zone = Object.values(content.locations).find((l) => l.loot)?.id;
    const night = { ...situation("night"), playerZone: zone!, playerPlace: null };
    const ctx = (state: GameState) => ({ content, store: { getState: () => state } }) as never;
    expect(scavengeParts(ctx(night)).find((p) => p.label === "어둠")?.value).toBe(-1);
    const lit = { ...night, characters: { ...night.characters, [night.playerId]: { ...night.characters[night.playerId]!, inventory: { flashlight: 1 } } } };
    expect(scavengeParts(ctx(lit)).find((p) => p.label === "어둠")).toBeUndefined();
    expect(scavengeParts(ctx({ ...night, time: at(night, "day") })).find((p) => p.label === "어둠")).toBeUndefined();
  });

  it("두 트레잇은 함께 고르지 못한다", () => {
    const t = (id: string) => content.scenario.traits.find((x) => x.id === id)!;
    expect(t("night_blind").opposites).toContain("dark_adapted");
    expect(t("dark_adapted").opposites).toContain("night_blind");
  });
});
