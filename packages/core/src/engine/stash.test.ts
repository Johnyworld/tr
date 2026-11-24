import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import { stepToRoad, loadRealContent } from "../testing.ts";
import { buildPlayerView } from "../views/player.ts";

/** 내 물건 보관 (12-149) */
const content = { ...loadRealContent(), storylets: {} };
const make = (role = "role_a_grunt") => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-stash-")), content, rngFactory: () => () => 0.99 }).create("mcp", role);
type World = ReturnType<typeof make>;
const go = (w: World, to: string) =>
  (stepToRoad(w, to), w.executeTool("take_action", { intent: "이동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, move_to: to }));
const stash = (w: World, action: string, items: { item_id: string; quantity: number }[] = []) => w.executeTool("stash", { action, items });
const me = (w: World) => w.state().characters[w.state().playerId]!;
const give = (w: World, item: string, n: number) => expect(w.runCheat(`~give ${item} ${n}`).ok).toBe(true);

describe("무리의 사물함", () => {
  it("우리 거점에서 넣고 꺼낸다. 다른 곳에서는 넣지 못한다", () => {
    const w = make();
    const item = "canned_food";
    give(w, item, 2);
    const before = me(w).inventory[item]!;
    const put = stash(w, "put", [{ item_id: item, quantity: 1 }]);
    expect(put.ok).toBe(true);
    expect(me(w).inventory[item] ?? 0).toBe(before - 1);
    expect(w.state().stashes[me(w).id]?.[w.state().playerZone!]?.[item]).toBe(1);
    expect(buildPlayerView(w.state(), content).stash?.canPut).toBe(true);

    go(w, "old_town");
    // 상태 화면은 넣을 수 있는 자리(canPut)에서만 창고를 보인다
    expect(buildPlayerView(w.state(), content).stash?.canPut ?? false).toBe(false);
    expect(stash(w, "put", [{ item_id: item, quantity: 1 }]).ok).toBe(false);
    expect(stash(w, "take", [{ item_id: item, quantity: 1 }]).ok).toBe(false);
    go(w, "a_base");
    expect(stash(w, "take", [{ item_id: item, quantity: 1 }]).ok).toBe(true);
    expect(me(w).inventory[item]).toBe(before);
    expect(w.state().stashes[me(w).id]?.[w.state().playerZone!]).toBeUndefined();
  });

  it("가진 것보다 많이는 못 넣고, 걸친 것은 먼저 벗어야 맡긴다", () => {
    const w = make();
    const worn = me(w).equipped?.weapon;
    if (worn) {
      const out = stash(w, "put", [{ item_id: worn, quantity: me(w).inventory[worn]! }]);
      expect(out.ok).toBe(false);
      expect(!out.ok && out.error).toContain("걸친 것은 먼저 벗어야");
    }
    expect(stash(w, "put", [{ item_id: "canned_food", quantity: 99 }]).ok).toBe(false);
  });
});

describe("떠돌이의 거처", () => {
  const drifter = () => make("role_l_wanderer");

  it("거처가 없으면 넣지 못하고, 정하면 거기에 넣는다. 거처를 옮겨도 예전 물건은 거기 남아 꺼낼 수 있다", () => {
    const w = drifter();
    expect(me(w).factionId).toBe("");
    expect(w.runCheat("~goto old_town").ok).toBe(true);
    give(w, "canned_food", 2);
    expect(stash(w, "put", [{ item_id: "canned_food", quantity: 1 }]).ok).toBe(false);
    expect(stash(w, "settle").ok).toBe(true);
    expect(stash(w, "put", [{ item_id: "canned_food", quantity: 2 }]).ok).toBe(true);
    expect(w.runCheat("~goto riverside").ok).toBe(true);
    expect(stash(w, "settle").ok).toBe(true);
    expect(stash(w, "put", [{ item_id: "canned_food", quantity: 1 }]).ok).toBe(false);
    expect(w.runCheat("~goto old_town").ok).toBe(true);
    expect(stash(w, "put", [{ item_id: "water_bottle", quantity: 1 }]).ok).toBe(false);
    expect(stash(w, "take", [{ item_id: "canned_food", quantity: 2 }]).ok).toBe(true);
  });

  it("무리에 든 사람은 거처를 정하지 않는다", () => {
    const w = make();
    go(w, "old_town");
    expect(stash(w, "settle").ok).toBe(false);
  });
});

describe("짐이 무거울 때 창고 안내", () => {
  it("한도를 넘으면 한 번만 알린다", () => {
    const w = make();
    give(w, "planks", 40);
    let n = 0;
    const look = () => w.executeTool("add_belief", { fact: `짐을 내려다본다 ${++n}`, source: "seen" });
    const first = look();
    const again = look();
    const text = (o: typeof first) => (o.ok ? o.resultText : "");
    expect(text(first)).toContain("사물함");
    expect(text(again)).not.toContain("짐이 한도를 넘었다");
  });
});
