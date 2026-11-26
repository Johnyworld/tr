import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { eligibleStorylets } from "./storylets.ts";
import { WorldManager } from "../world/manager.ts";
import { loadRealContent } from "../testing.ts";

const content = loadRealContent();

/** 발전소 목장 (docs/cannibal-plan.md 2): 회처리장 창고에서 열리고, 진행에 따라 다음 이야기로 넘어간다 */
describe("발전소 목장", () => {
  const open = () => {
    const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-ranch-")), content, rngFactory: () => createSeededRng(3) });
    const w = m.create("mcp", "role_l_wanderer");
    const store = w.ctx().store;
    store.append({ type: "zone_moved", from: w.state().playerZone, to: "power_plant" });
    store.append({ type: "place_moved", from: w.state().playerPlace, to: "ash_pens" });
    const day = Math.floor(w.state().time / 1440) + 1;
    return { w, store, night: day * 1440 + 23 * 60, noon: day * 1440 + 12 * 60 };
  };
  const ids = (w: ReturnType<typeof open>["w"], at: number) => eligibleStorylets(w.state(), w.content, at).map((x) => x.id);

  it("회처리장 창고의 밤에는 컨테이너 이야기, 본 뒤에는 구출 이야기가 열린다", () => {
    const { w, store, night } = open();
    expect(ids(w, night)).toContain("rn_pens");
    expect(ids(w, night)).not.toContain("rn_rescue");
    store.append({ type: "flag_set", characterId: "player", flag: "rn_pens_seen" });
    expect(ids(w, night)).not.toContain("rn_pens");
    w.close();
  });

  it("컨테이너를 본 뒤에만 낮에 목장주가 고기를 권하고, 목장이 끝나면 아무것도 열리지 않는다", () => {
    const { w, store, noon, night } = open();
    store.append({ type: "flag_set", characterId: "player", flag: "rn_lead" });
    // 단서만으로는 열리지 않는다 (PT41: 컨테이너보다 먼저 열려 거래 선택지 없이 쓰였다)
    expect(ids(w, noon)).not.toContain("rn_dosu_offer");
    store.append({ type: "flag_set", characterId: "player", flag: "rn_pens_seen" });
    expect(ids(w, noon)).toContain("rn_dosu_offer");
    store.append({ type: "flag_set", characterId: "player", flag: "rn_closed" });
    expect(ids(w, noon).filter((x) => x.startsWith("rn_"))).toEqual([]);
    expect(ids(w, night).filter((x) => x.startsWith("rn_"))).toEqual([]);
    w.close();
  });

  it("장터 좌판에서 값싼 훈제육을 팔고, 목장과 거래를 트면 고기를 떼다 판다. 목장이 끝나면 좌판도 닫힌다", () => {
    const { w, store, noon } = open();
    store.append({ type: "zone_moved", from: w.state().playerZone, to: "e_market" });
    store.append({ type: "place_moved", from: w.state().playerPlace, to: "stalls" });
    expect(ids(w, noon)).toContain("mk_stall");
    expect(ids(w, noon)).not.toContain("mk_peddle");
    store.append({ type: "flag_set", characterId: "player", flag: "rn_dealer" });
    expect(ids(w, noon)).toContain("mk_peddle");
    store.append({ type: "flag_set", characterId: "player", flag: "rn_closed" });
    expect(ids(w, noon).filter((x) => x === "mk_stall" || x === "mk_peddle")).toEqual([]);
    w.close();
  });

  it("시체 수레는 이 구역에 사상자가 난 교전이 이틀 안에 있었을 때만 온다 (battle_days_lte)", () => {
    const { w, store, noon } = open();
    store.append({ type: "zone_moved", from: w.state().playerZone, to: "overpass" });
    store.append({ type: "place_moved", from: w.state().playerPlace, to: "deck" });
    const morning = noon - 3 * 60;
    const clash = (zone: string, losses: number, daysAgo: number) => ({
      clash: { kind: "skirmish" as const, attacker: "faction_a", defender: "faction_c", zone, success: true, attackerLosses: losses, defenderLosses: 0 },
      at: morning - daysAgo * 1440,
    });
    const at = (recent: ReturnType<typeof clash>[]) => eligibleStorylets({ ...w.state(), recentClashes: recent }, w.content, morning).map((x) => x.id);
    expect(at([])).not.toContain("cc_cart");
    expect(at([clash("overpass", 2, 1)])).toContain("cc_cart");
    expect(at([clash("overpass", 0, 1)])).not.toContain("cc_cart");
    expect(at([clash("overpass", 2, 3)])).not.toContain("cc_cart");
    expect(at([clash("riverside", 2, 1)])).not.toContain("cc_cart");
    w.close();
  });

  it("굶주린 겨울: 주인 없는 땅의 폐건물에서 굶주림 이상일 때만 먼저 얼어 죽은 사람을 만난다", () => {
    const { w, store } = open();
    store.append({ type: "zone_moved", from: w.state().playerZone, to: "overpass" });
    store.append({ type: "place_moved", from: w.state().playerPlace, to: "roadside_shops" });
    // 시작은 늦가을(가을 14일째), 겨울은 7일째부터 20일 (scenario.seasons)
    const winterNight = 10 * 1440 + 22 * 60;
    const autumnNight = 2 * 1440 + 22 * 60;
    const withHunger = (level: string) => {
      const s = w.state();
      const me = s.characters[s.playerId]!;
      return { ...s, characters: { ...s.characters, [s.playerId]: { ...me, conditions: { ...me.conditions, hunger: level } } } };
    };
    const ids = (s: ReturnType<typeof withHunger>, at: number) => eligibleStorylets(s, w.content, at).map((x) => x.id);
    expect(ids(withHunger("starving"), winterNight)).toContain("wf_frozen_dead");
    expect(ids(withHunger("hungry"), winterNight)).not.toContain("wf_frozen_dead");
    expect(ids(withHunger("starving"), autumnNight)).not.toContain("wf_frozen_dead");
    w.close();
  });
});
