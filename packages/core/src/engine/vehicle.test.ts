import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRealContent } from "../testing.ts";
import { neighbors } from "../sim/war.ts";
import { WorldManager } from "../world/manager.ts";
import { executeTool } from "./tools.ts";

/** 이동 수단 (12-137): 타면 빨라지고, 오토바이는 기름을 먹고 소리를 낸다. 사람과 걸으면 맞춘다 */
const content = loadRealContent();

function open() {
  const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-vh-")), content, rngFactory: () => () => 0.99 }).create("mcp", "role_a_grunt");
  const s = () => w.state();
  const me = () => s().characters[s().playerId]!;
  s().companions = [];
  const move = (ride: string | null) => {
    const to = neighbors(content, s().playerZone!).find((z) => !content.locations[z]?.crossing)!;
    const t0 = s().time;
    const out = executeTool("take_action", { intent: "이동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, move_to: to, ride }, w.ctx());
    return { out, minutes: s().time - t0, to };
  };
  return { w, s, me, move };
}

describe("이동 수단", () => {
  it("걸으면 rng 0.99로 거의 한 시간, 자전거면 그 절반쯤, 오토바이면 그보다 빠르다", () => {
    const walk = open().move(null).minutes;
    const bike = open();
    bike.me().inventory.bicycle = 1;
    const b = bike.move("bicycle");
    expect(b.out.ok && b.out.resultText).toContain("자전거");
    expect(b.minutes).toBeLessThan(walk);
    const moto = open();
    moto.me().inventory.motorbike = 1;
    moto.me().inventory.fuel_bottle = 1;
    const m = moto.move("motorbike");
    expect(m.minutes).toBeLessThan(b.minutes);
    expect(moto.me().inventory.fuel_bottle ?? 0).toBe(0);
    // 엔진 소리가 도착한 구역에 남는다
    expect(moto.s().zoneNoise[m.to]?.level).toBeGreaterThan(0);
  });

  it("기름이 없거나, 갖고 있지 않거나, 사람과 함께 걸으면 걸어간다", () => {
    const noFuel = open();
    noFuel.me().inventory.motorbike = 1;
    noFuel.me().inventory.fuel_bottle = 0;
    const r = noFuel.move("motorbike");
    expect(r.out.ok && r.out.resultText).toContain("타지 못하고 걸었다");
    const none = open().move("bicycle");
    expect(none.out.ok && none.out.resultText).toContain("타지 못하고 걸었다");
    const withFriend = open();
    withFriend.me().inventory.bicycle = 1;
    withFriend.s().companions = ["a_jiho"];
    const f = withFriend.move("bicycle");
    expect(f.out.ok && f.out.resultText).toContain("걸음에 맞췄다");
  });
});
