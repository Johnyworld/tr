import { describe, expect, it } from "vitest";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { loadRealContent } from "../testing.ts";
import { storySetup } from "./storyletTools.ts";

/** 상황 문장의 변주 (12-139): 되풀이될 때마다 setup → variants 차례로 */
const content = loadRealContent();

describe("상황 문장의 변주", () => {
  it("열린 횟수에 따라 돌아가며 쓰고, 변주가 없으면 늘 setup", () => {
    const store = new InMemoryGameStore([createWorldEvent(content, "role_a_grunt", "w_var", () => 0.5)]);
    const state = store.getState();
    const s = content.storylets.w_wave_night_wall!;
    expect(s.variants.length).toBe(2);
    const seen = [1, 2, 3, 4].map((n) => {
      state.storyletLog[s.id] = { fired: n, lastFiredAt: 0 };
      return storySetup(state, s);
    });
    expect(seen[0]).toBe(s.setup);
    expect(seen[1]).toBe(s.variants[0]);
    expect(seen[2]).toBe(s.variants[1]);
    expect(seen[3]).toBe(s.setup);
    const plain = Object.values(content.storylets).find((x) => !x.variants.length)!;
    state.storyletLog[plain.id] = { fired: 5, lastFiredAt: 0 };
    expect(storySetup(state, plain)).toBe(plain.setup);
  });
});
