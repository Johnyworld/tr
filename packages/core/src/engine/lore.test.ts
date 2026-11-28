import { describe, expect, it } from "vitest";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { scavenge, scavengeParts } from "./scavenge.ts";
import { runDailyBody } from "./body.ts";
import { loadRealContent } from "../testing.ts";

/** 잘 안 쓰이던 스킬·트레잇에 붙인 쓰임새 */
const content = loadRealContent();

function world(rng: () => number, c = content) {
  const store = new InMemoryGameStore([createWorldEvent(c, "role_l_wanderer", "w", () => 0.5)]);
  const me = () => store.getState().characters[store.getState().playerId]!;
  return { ctx: { store, rng, content: c }, me, store };
}

describe("수색 판정의 상황 보정 (12-220)", () => {
  it("넉넉함·다시 뒤짐·역사가 판정 보정으로 붙는다", () => {
    const poor = Object.values(content.locations).find((l) => l.loot && l.loot.modifier < 0)!;
    const w = world(() => 0.5);
    w.store.getState().playerZone = poor.id;
    w.store.getState().time = 9 * 60; // 낮: 어둠 속 눈(공통 규칙 27)이 붙지 않게
    w.me().skills.history = -1;
    expect(scavengeParts(w.ctx)).toEqual([{ label: "털린 구역", value: poor.loot!.modifier }]);
    const day = Math.floor(w.store.getState().time / 1440) + 1;
    w.store.append({ type: "zone_searched", zone: poor.id, day });
    w.me().skills.history = 1;
    expect(scavengeParts(w.ctx)).toEqual([
      { label: "털린 구역", value: poor.loot!.modifier },
      { label: "오늘 다시 뒤짐", value: -1 },
      { label: "역사: 옛 건물 쓰임을 앎", value: 1 },
    ]);
  });

  it("판정 결과만큼 찾는다: 성공 2, 대가 있는 성공 1, 실패·판정 없음 0", () => {
    const zone = Object.values(content.locations).find((l) => l.loot?.items.length)!;
    const found = (outcome: "success" | "partial" | "miss" | null) => {
      const w = world(() => 0.99); // 굴림이 높아도 숨은 확률로 빠지지 않는다
      w.store.getState().playerZone = zone.id;
      return scavenge(w.ctx, outcome).displays.length;
    };
    expect(found("success")).toBeGreaterThanOrEqual(1); // 같은 물건이 둘이면 한 줄로 합친다
    expect(found("partial")).toBe(1);
    expect(found("miss")).toBe(0);
    expect(found(null)).toBe(0);
  });
});

describe("튼튼한 위장: 앓아도 빨리 낫는다", () => {
  it("같은 굴림에서 튼튼한 위장만 낫는다", () => {
    // 질병만 본다: 허기·추위 규칙은 끈다 (배부르고 따뜻한 날)
    const c = structuredClone(content);
    delete c.scenario.body!.hunger;
    delete c.scenario.body!.cold;
    const sick = (traits: string[]) => {
      const w = world(() => 0.45, c);
      w.me().traits = traits;
      w.me().stats.vitality = 0;
      w.me().conditions.disease = "chill";
      w.me().conditions.hunger = "fed";
      w.me().conditions.cold = "warm";
      runDailyBody(w.ctx);
      return w.me().conditions.disease;
    };
    expect(sick([])).not.toBe("healthy");
    expect(sick(["iron_gut"])).toBe("healthy");
  });
});
