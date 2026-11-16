import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { scavenge } from "./scavenge.ts";
import { runDailyBody } from "./body.ts";

/** 잘 안 쓰이던 스킬·트레잇에 붙인 쓰임새 */
const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));

function world(rng: () => number, c = content) {
  const store = new InMemoryGameStore([createWorldEvent(c, "role_l_wanderer", "w", () => 0.5)]);
  const me = () => store.getState().characters[store.getState().playerId]!;
  return { ctx: { store, rng, content: c }, me, store };
}

describe("역사: 옛 지도를 아는 사람은 더 잘 찾는다", () => {
  it("같은 굴림이라도 역사 2면 찾고, 역사가 없으면 못 찾는다", () => {
    const zone = Object.values(content.locations).find((l) => l.loot && l.loot.chance < 0.66)!;
    const roll = zone.loot!.chance * 1.2; // 기본 확률은 넘고, 역사 2(+50%)면 들어온다
    const plain = world(() => roll);
    plain.store.getState().playerZone = zone.id;
    plain.me().skills.history = -1;
    expect(scavenge(plain.ctx, "partial").displays).toEqual([]);
    const learned = world(() => roll);
    learned.store.getState().playerZone = zone.id;
    learned.me().skills.history = 2;
    expect(scavenge(learned.ctx, "partial").displays.length).toBe(1);
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
