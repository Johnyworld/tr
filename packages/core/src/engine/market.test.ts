import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import { loadRealContent } from "../testing.ts";
import { describeMarket, itemResource, marketValue, resourceFactor } from "./market.ts";

/** 시세 (12-155) */
const content = { ...loadRealContent(), storylets: {} };
const startFood = content.factions.faction_e!.resources.food!;
const make = () => {
  const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-market-")), content, rngFactory: () => () => 0.5 }).create("mcp", "role_a_grunt");
  expect(w.runCheat("~goto e_market").ok).toBe(true);
  return w;
};
type World = ReturnType<typeof make>;
const setFood = (w: World, n: number) => expect(w.runCheat(`~faction faction_e food ${n}`).ok).toBe(true);
const factor = (w: World) => resourceFactor(content, w.state(), "food");

describe("시세", () => {
  it("물건은 종류나 resource로 무리 자원을 따른다", () => {
    expect(itemResource(content, "canned_food")).toBe("food");
    expect(itemResource(content, "rifle_rounds")).toBe("ammo");
    expect(itemResource(content, "bandage")).toBe("medicine");
    expect(itemResource(content, "cigarettes")).toBeNull();
  });

  it("그 땅 주인의 창고가 모자라면 비싸고, 넉넉하면 싸다", () => {
    const w = make();
    // 식량에는 계절 배수가 없다
    setFood(w, startFood);
    expect(factor(w)).toBe(1);
    setFood(w, Math.floor(startFood * 0.2));
    expect(factor(w)).toBe(1.5);
    setFood(w, startFood * 3);
    expect(factor(w)).toBe(0.7);
  });

  it("흥정 값에 닿는다: 모자란 곳에서는 같은 통조림이 더 값지다", () => {
    const w = make();
    setFood(w, startFood * 3);
    const cheap = marketValue(content, w.state(), { canned_food: 10 });
    setFood(w, Math.floor(startFood * 0.2));
    const dear = marketValue(content, w.state(), { canned_food: 10 });
    expect(dear).toBeGreaterThan(cheap);
    // 자원과 이어지지 않은 물건은 그대로다
    expect(marketValue(content, w.state(), { cigarettes: 5 })).toBe(content.items.cigarettes!.value! * 5);
  });

  it("주인 없는 땅에는 시세가 없다", () => {
    const w = make();
    expect(w.runCheat("~goto old_town").ok).toBe(true);
    expect(resourceFactor(content, w.state(), "food")).toBe(1);
    expect(describeMarket(content, w.state())).toBeNull();
  });

  it("장터에서는 눈에 띄게 비싼 것을 말로 알린다 (숫자 없이)", () => {
    const w = make();
    setFood(w, Math.floor(startFood * 0.2));
    const line = describeMarket(content, w.state())!;
    expect(line).toContain("식량");
    expect(line).toContain("비싸다");
    expect(line).not.toMatch(/\d/);
  });
});
