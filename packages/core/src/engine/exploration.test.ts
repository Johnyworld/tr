import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Rng } from "../rng.ts";
import { WorldManager } from "../world/manager.ts";
import type { GameWorld } from "../world/world.ts";
import { loadRealContent } from "../testing.ts";
import { findRuin } from "./exploration.ts";

/** 탐험할 곳 (12-162) */
const content = { ...loadRealContent(), storylets: {} };

function world(): { w: GameWorld; roll: { value: number } } {
  const roll = { value: 0.01 };
  const rng: Rng = () => roll.value;
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-explore-")), content, rngFactory: () => rng });
  return { w: m.create("mcp", "role_l_wanderer"), roll };
}
const explore = (w: GameWorld, action: string, ruin: string | null = null) => w.executeTool("explore", { action, ruin });

describe("탐험할 곳", () => {
  it("수색하다 숨은 곳을 찾고, 그 캐릭터만 안다", () => {
    const { w } = world();
    expect(w.runCheat("~goto hospital_ruins").ok).toBe(true);
    expect(explore(w, "start", "hospital_basement").ok).toBe(false); // 아직 모른다
    expect(w.sceneForGm()).not.toContain("hospital_basement");
    // 수색 판정의 결과로 정한다 (12-220): 실패면 없고, 대가 있는 성공이면 낌새만, 성공이면 찾는다
    expect(findRuin(w.ctx(), "miss")).toBeNull();
    expect(findRuin(w.ctx(), "partial")).toContain("낌새");
    expect(w.state().ruinsFound[w.state().playerId] ?? []).toEqual([]);
    const line = findRuin(w.ctx(), "success");
    expect(line).toContain("옛 병원 지하 약제실");
    expect(w.state().ruinsFound[w.state().playerId]).toEqual(["hospital_basement"]);
    expect(w.sceneForGm()).toContain("hospital_basement");
    // 이미 찾은 곳은 다시 찾지 않는다
    expect(findRuin(w.ctx(), "success")).toBeNull();
  });

  it("내려가고 뒤지고 나온다. 깊을수록 다른 표에서 나온다", () => {
    const { w, roll } = world();
    expect(w.runCheat("~goto hospital_ruins").ok).toBe(true);
    w.ctx().store.append({ type: "ruin_found", characterId: w.state().playerId, ruin: "hospital_basement" });
    expect(w.sceneForGm()).toContain("hospital_basement");
    roll.value = 0.99; // 판정 성공 (6+6), 고르기는 표의 끝
    expect(explore(w, "start", "hospital_basement").ok).toBe(true);
    const s1 = explore(w, "search");
    expect(s1.ok, s1.ok ? "" : s1.error).toBe(true);
    expect(explore(w, "search").ok).toBe(false); // 칸마다 한 번
    expect(explore(w, "deeper").ok).toBe(true);
    expect(explore(w, "deeper").ok).toBe(true);
    expect(w.state().exploration?.depth).toBe(2);
    const before = w.state().characters[w.state().playerId]!.inventory.sealed_med_case ?? 0;
    expect(explore(w, "search").ok).toBe(true);
    expect(w.state().characters[w.state().playerId]!.inventory.sealed_med_case ?? 0).toBeGreaterThan(before);
    expect(explore(w, "deeper").ok).toBe(false); // 가장 깊다
    expect(explore(w, "leave").ok).toBe(true);
    expect(w.state().exploration).toBeNull();
  });

  it("실패하면 다치고 소리가 쌓여 감염체가 깨어난다", () => {
    const { w, roll } = world();
    expect(w.runCheat("~goto hospital_ruins").ok).toBe(true);
    w.ctx().store.append({ type: "ruin_found", characterId: w.state().playerId, ruin: "hospital_basement" });
    expect(explore(w, "start", "hospital_basement").ok).toBe(true);
    roll.value = 0; // 1+1 실패
    for (let i = 0; i < 3; i++) explore(w, "deeper");
    expect(w.state().characters[w.state().playerId]!.conditions.harm).not.toBe("none");
    expect(w.state().exploration?.noise).toBe(3);
    const infected = w.state().scene.present.filter((id) => w.state().characters[id]?.extra?.template?.startsWith("infected"));
    expect(infected.length).toBeGreaterThan(0);
    // 깨어난 것이 앞에 있으면 더 들어가거나 뒤지지 못하고, 나오기만 된다
    const blocked = explore(w, "deeper");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toContain("깨어난 것들");
    expect(explore(w, "search").ok).toBe(false);
  });
});
