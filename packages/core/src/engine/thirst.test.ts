import { fireSpot } from "../rules/place.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import { capturePlayer } from "./captivity.ts";
import { describePlayerState } from "./context.ts";
import { changeCondition, drinkWater, refillWater, runDailyBody, useItem } from "./body.ts";
import { loadRealContent } from "../testing.ts";

/** 갈증 (12-97) */
const content = loadRealContent();

function open() {
  const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-thirst-")), content, rngFactory: () => () => 0.99 }).create("mcp", "role_a_grunt");
  const me = () => w.state().characters[w.state().playerId]!;
  return { w, me, thirst: () => me().conditions.thirst ?? "quenched" };
}

describe("갈증", () => {
  it("하루마다 한 단계 마르고, 우리 땅 밖에서 마시지 않으면 닷새째 죽는다", () => {
    const { w, me, thirst } = open();
    w.state().playerZone = "overpass";
    runDailyBody(w.ctx());
    expect(thirst()).toBe("thirsty");
    for (let i = 0; i < 4 && !me().dead; i++) runDailyBody(w.ctx());
    expect(me().dead).toBe(true);
  });

  it("거점에 있어도 깨어 있으면 저절로 마시지 않는다. 목말라 쓰러지면 무리 사람이 먹인다 (12-303)", () => {
    const { w, me, thirst } = open();
    runDailyBody(w.ctx());
    expect(thirst()).toBe("thirsty");
    for (let i = 0; i < 6 && !me().dead; i++) runDailyBody(w.ctx());
    expect(me().dead).toBeFalsy();
    expect(thirst()).not.toBe("dead");
  });

  it("우리 땅에서 스스로 못 움직이게 쓰러져 있으면 무리 치료사가 하루 한 번 돌본다, 깨어 있으면 돌보지 않는다 (12-303)", () => {
    const down = open();
    changeCondition(down.w.ctx(), down.me().id, "harm", 5, "test", "테스트");
    const before = down.me().conditions.harm;
    runDailyBody(down.w.ctx());
    expect(down.me().conditions.harm).not.toBe(before);
    const awake = open();
    changeCondition(awake.w.ctx(), awake.me().id, "harm", 1, "test", "테스트");
    const light = awake.me().conditions.harm;
    runDailyBody(awake.w.ctx());
    expect(awake.me().conditions.harm).toBe(light);
  });

  it("우리 무리의 벌로 갇히면 가둔 쪽이 물을 준다, 적에게 붙잡히면 그대로 (12-303)", () => {
    const own = open();
    // 규율 회의의 벌과 같이 (disc_*_council의 가두기)
    own.w.ctx().store.append({ type: "player_captured", by: "faction_a", zone: "a_base", held: {}, place: "stockade", releaseAt: own.w.state().time + 2880 });
    expect(own.me().captive?.by).toBe("faction_a");
    own.me().conditions.thirst = "parched";
    runDailyBody(own.w.ctx());
    expect(own.thirst()).toBe("quenched");
    const enemy = open();
    capturePlayer(enemy.w.ctx(), "faction_c", "c_warehouse", "테스트");
    enemy.me().conditions.thirst = "thirsty";
    runDailyBody(enemy.w.ctx());
    expect(enemy.thirst()).not.toBe("quenched");
  });

  it("바깥의 물이 나는 곳: 마시면 3단계, 채우기는 따로. 빈 물병이 있으면 GM이 언급한다", () => {
    const { w, me, thirst } = open();
    w.state().playerZone = "riverside";
    w.state().fires[fireSpot(w.state())!] = w.state().time + 60; // 불이 있으면 끓여서 깨끗한 물 (12-131)
    me().conditions.thirst = "severe";
    me().inventory.empty_bottle = 2;
    const full = me().inventory.water_bottle ?? 0;
    expect(describePlayerState(w.state(), w.content)).toContain("물을 채우면 될 것 같다");
    expect(drinkWater(w.ctx()).ok).toBe(true);
    expect(thirst()).toBe("quenched");
    expect(me().inventory.empty_bottle).toBe(2); // 마셔도 저절로 채워지지 않는다
    expect(refillWater(w.ctx()).ok).toBe(true);
    expect(me().inventory.empty_bottle ?? 0).toBe(0);
    expect(me().inventory.water_bottle).toBe(full + 2);
  });

  it("거점: 보급을 받으면 채우면서 마신다. 물이 모자라면 조금만, 바닥이면 거절", () => {
    const { w, me, thirst } = open();
    const f = w.state().factions[me().factionId]!;
    me().conditions.thirst = "severe";
    me().inventory.empty_bottle = 2;
    expect(describePlayerState(w.state(), w.content)).toContain("물 보급을 받아야 할 것 같다");
    f.resources.water = 5; // 하루치도 안 된다
    expect(refillWater(w.ctx()).ok).toBe(true);
    expect(thirst()).toBe("parched"); // 한 모금
    expect(me().inventory.empty_bottle).toBe(1); // 하나만
    f.resources.water = 0;
    expect(refillWater(w.ctx()).ok).toBe(false);
    expect(describePlayerState(w.state(), w.content)).toContain("물 보급을 받아야 할 것 같다"); // 창고 사정과 상관없이 언급
    f.resources.water = 500;
    expect(refillWater(w.ctx()).ok).toBe(true);
    expect(thirst()).toBe("quenched");
    expect(me().inventory.empty_bottle ?? 0).toBe(0);
  });

  it("물이 나지 않는 곳에서는 마실 수 없고, 목도 안 마르고 빈 물병도 없으면 언급하지 않는다", () => {
    const { w, me } = open();
    me().conditions.thirst = "parched";
    w.state().playerZone = "hospital_ruins"; // 12-251: 물 뜰 곳(stream)이 없는 마른 구역
    expect(drinkWater(w.ctx()).ok).toBe(false);
    expect(describePlayerState(w.state(), w.content)).not.toContain("물이 충분하다");
    w.state().playerZone = "riverside";
    me().conditions.thirst = "quenched";
    me().inventory.empty_bottle = 0;
    expect(describePlayerState(w.state(), w.content)).not.toContain("물이 충분하다");
  });

  it("물병은 갈증을 풀고 빈 물병이 남는다. 짠 음식은 목을 마르게 한다", () => {
    const { w, me, thirst } = open();
    me().conditions.thirst = "parched";
    me().inventory.water_bottle = 1;
    me().inventory.empty_bottle = 0;
    expect(useItem(w.ctx(), "water_bottle").ok).toBe(true);
    expect(thirst()).toBe("quenched");
    expect(me().inventory.water_bottle ?? 0).toBe(0);
    expect(me().inventory.empty_bottle).toBe(1);
    me().conditions.hunger = "starving";
    me().inventory.dried_fish = 1;
    expect(useItem(w.ctx(), "dried_fish").ok).toBe(true);
    expect(thirst()).toBe("thirsty");
    me().conditions.hunger = "fed";
    me().inventory.salted_meat = 1;
    expect(useItem(w.ctx(), "salted_meat").ok).toBe(false);
  });
});
