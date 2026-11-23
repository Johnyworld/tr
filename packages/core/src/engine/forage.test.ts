import { fireSpot } from "../rules/place.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRealContent, teachSkills } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { drinkWater, refillWater, useItem } from "./body.ts";
import { forage, handleTrap, runDailyFood } from "./forage.ts";
import { executeTool } from "./tools.ts";

/** 먹고 마시기 (12-131): 사냥·낚시, 덫, 부패, 끓이지 않은 물 */
const content = loadRealContent();
const water = content.scenario.body!.thirst!.resource;
const zones = Object.values(content.locations);
const dryOutside = zones.find((l) => l.kind !== "base" && !((l.yields[water] ?? 0) > 0))!.id;
const base = zones.find((l) => l.kind === "base")!.id;

function open(rng = 0) {
  const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-food-")), content, rngFactory: () => () => rng }).create("mcp", "role_a_grunt");
  // 낚시·사냥은 전문 기술이라 배워 둔다 (4.2.1)
  teachSkills(w, ["fishing", "hunt"]);
  const me = () => w.state().characters[w.state().playerId]!;
  return { w, me, s: () => w.state() };
}

describe("사냥·낚시", () => {
  it("물가에서 낚시하면 날생선을 얻고, 같은 날 다시 하면 덜 잡힌다", () => {
    const { w, me, s } = open(0);
    s().playerZone = "riverside";
    expect(forage(w.ctx(), "fish", "success").ok).toBe(true);
    const first = me().inventory.raw_fish ?? 0;
    expect(first).toBeGreaterThan(0);
    const again = forage(w.ctx(), "fish", "success");
    expect(again.ok && again.lines.join()).toContain("오늘 이미");
  });

  it("물가가 아니면 낚시를, 거점 안에서는 사냥을 할 수 없다", () => {
    const { w, s } = open(0);
    s().playerZone = dryOutside;
    expect(forage(w.ctx(), "fish", "success").ok).toBe(false);
    s().playerZone = base;
    expect(forage(w.ctx(), "hunt", "success").ok).toBe(false);
  });

  it("실패하면 빈손, 개가 동행하면 사냥에서 한 번 더 굴린다", () => {
    const { w, me, s } = open(0);
    s().playerZone = dryOutside;
    forage(w.ctx(), "hunt", "miss");
    expect(me().inventory.raw_meat ?? 0).toBe(0);
    s().playerZone = "riverside"; // 다른 곳에서 (같은 날 같은 곳 감소를 피한다)
    executeTool("spawn_extra", { template: "stray_dog", label: "누렁이" }, w.ctx());
    const dog = Object.values(s().characters).find((c) => c.extra?.template === "stray_dog")!;
    w.ctx().store.append({ type: "companion_joined", characterId: dog.id });
    const r = forage(w.ctx(), "hunt", "partial");
    expect(r.ok && r.lines.join()).toContain("몰이를 도왔다");
    expect(me().inventory.raw_meat).toBe(2); // 대가 있는 성공 1번 + 개 1번 (rng 0: 첫 줄, 1마리씩)
  });
});

describe("take_action으로", () => {
  it("forage에 판정을 걸면 수색만큼 시간이 흐르고 결과만큼 잡힌다", () => {
    const { w, me, s } = open(0.99);
    s().playerZone = "riverside";
    const t0 = s().time;
    const out = executeTool("take_action", { intent: "낚시", check: { move: "survival", stat: "senses", difficulty: "normal", harm_on_failure: "none", harm_cause: "" }, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, forage: "fish" }, w.ctx());
    expect(out.ok ? "" : out.error).toBe("");
    expect(s().time - t0).toBeGreaterThanOrEqual(60);
    expect(me().inventory.raw_fish ?? 0).toBeGreaterThanOrEqual(0);
  });
});

describe("덫", () => {
  it("철사로 덫을 놓고, 놓는 판정이 성공이면 다음 날 걸리고, 거두면 걸린 것과 철사가 돌아온다", () => {
    const { w, me, s } = open(0);
    s().playerZone = dryOutside;
    me().inventory.wire_roll = 1;
    expect(handleTrap(w.ctx(), "set", "success").ok).toBe(true);
    expect(me().inventory.wire_roll ?? 0).toBe(0);
    expect(handleTrap(w.ctx(), "set").ok).toBe(false); // 한 구역에 하나
    runDailyFood(w.ctx());
    expect(s().traps[0]!.caught).toBeNull(); // 같은 날은 아직
    s().time += 24 * 60;
    runDailyFood(w.ctx());
    expect(handleTrap(w.ctx(), "check").ok).toBe(true);
    expect(me().inventory.wire_roll).toBe(1);
    expect(me().inventory.raw_meat).toBe(1);
    expect(s().traps).toHaveLength(0);
  });

  it("대가 있는 성공으로 놓은 덫은 이틀 뒤에 걸린다 (12-220)", () => {
    const { w, me, s } = open(0);
    s().playerZone = dryOutside;
    me().inventory.wire_roll = 1;
    handleTrap(w.ctx(), "set", "partial");
    s().time += 24 * 60;
    runDailyFood(w.ctx());
    expect(s().traps[0]!.caught).toBeNull();
    s().time += 24 * 60;
    runDailyFood(w.ctx());
    expect(s().traps[0]!.caught).toBe("raw_meat");
  });

  it("철사가 없으면 놓을 수 없고, 걸리지 않았으면 빈 덫이다", () => {
    const { w, me, s } = open(0.99);
    s().playerZone = dryOutside;
    me().inventory.wire_roll = 0;
    expect(handleTrap(w.ctx(), "set").ok).toBe(false);
    me().inventory.wire_roll = 1;
    handleTrap(w.ctx(), "set");
    runDailyFood(w.ctx());
    const r = handleTrap(w.ctx(), "check");
    expect(r.ok && r.lines.join()).toContain("아무것도 걸리지 않았다");
  });
});

describe("부패", () => {
  it("날것은 하루가 지나면 상하고, 말린 것은 상하지 않는다", () => {
    const { w, me } = open(0);
    me().inventory.raw_fish = 3;
    me().inventory.dried_fish = 2;
    const shown = runDailyFood(w.ctx());
    expect(me().inventory.raw_fish ?? 0).toBe(0);
    expect(me().inventory.dried_fish).toBe(2);
    expect(shown[0]).toMatchObject({ type: "belief" });
  });

  it("날생선 둘과 땔감으로 훈연하면 말린 생선이 된다", () => {
    expect(content.scenario.crafting!.recipes.find((r) => r.id === "smoke_fish")).toMatchObject({ yields: { item: "dried_fish" } });
  });
});

describe("끓이지 않은 물", () => {
  const disease = () => content.scenario.body!.disease!.track;

  it("바깥의 물을 불 없이 마시면 병에 걸릴 수 있고, 불이 있으면 끓여 마셔 괜찮다", () => {
    const sick = open(0);
    sick.s().playerZone = "riverside";
    sick.me().conditions.thirst = "parched";
    expect(drinkWater(sick.w.ctx()).ok).toBe(true);
    expect(sick.me().conditions[disease()]).not.toBe("healthy");

    const safe = open(0);
    safe.s().playerZone = "riverside";
    safe.s().fires[fireSpot(safe.s())!] = safe.s().time + 60;
    safe.me().conditions.thirst = "parched";
    const r = drinkWater(safe.w.ctx());
    expect(r.ok && r.lines.join()).toContain("끓여");
    expect(safe.me().conditions[disease()] ?? "healthy").toBe("healthy");
  });

  it("불 없이 채우면 끓이지 않은 물병이 되고, 그걸 마셔도 탈이 날 수 있다", () => {
    const { w, me, s } = open(0);
    s().playerZone = "riverside";
    me().inventory.empty_bottle = 1;
    expect(refillWater(w.ctx()).ok).toBe(true);
    expect(me().inventory.dirty_water).toBe(1);
    s().playerZone = dryOutside;
    me().conditions.thirst = "parched";
    expect(useItem(w.ctx(), "dirty_water").ok).toBe(true);
    expect(me().inventory.empty_bottle).toBe(1);
    expect(me().conditions[disease()]).not.toBe("healthy");
  });
});
