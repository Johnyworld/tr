import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { soak } from "./climate.ts";
import { waterHere } from "./body.ts";

/** 균형 E (플레이 테스트 11): 한파 낌새, 방수복, 잠, 물류창고의 물 */
const content = loadRealContent();
const open = (role: string) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-e-")), content, rngFactory: () => () => 0.5 }).create("mcp", role);

describe("균형 E", () => {
  it("방수복을 입으면 물일에 젖지 않는다 (물에 빠지면 젖는다)", () => {
    const w = open("role_y_islander");
    const me = () => w.state().characters[w.state().playerId]!;
    me().inventory.oilskin = 1;
    expect(w.executeTool("equip", { item_id: "oilskin", slot: null }).ok).toBe(true);
    soak(w.ctx(), me().id, "그물을 걷다 젖었다", true);
    expect(w.state().wet?.[me().id] ?? 0).toBe(0);
    soak(w.ctx(), me().id, "물에 빠졌다");
    expect(w.state().wet?.[me().id] ?? 0).toBeGreaterThan(0);
  });

  it("내일이 한파면 오늘 낌새가 보인다", () => {
    const w = open("role_a_grunt");
    const today = Math.floor(w.state().time / 1440) + 1;
    w.ctx().store.append({ type: "weather_forecast", day: today + 1, weatherId: "cold_snap" });
    expect(w.sceneForGm()).toContain("낌새");
  });

  it("붉은연합 사람은 물류창고에서도 물 보급을 받는다", () => {
    const w = open("role_c_comrades");
    w.state().playerZone = "c_warehouse";
    expect(waterHere(content, w.state())?.kind).toBe("supply");
  });
});
