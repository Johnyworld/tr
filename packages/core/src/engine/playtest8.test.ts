import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import type { GameWorld } from "../world/world.ts";
import { loadRealContent } from "../testing.ts";
import { recordDeed } from "./reputationTools.ts";
import { npcZoneAt } from "../game/whereabouts.ts";
import { maskUnknownNames } from "./storyletTools.ts";
import { gearModifiers } from "./gear.ts";
import { exposeToCold } from "./climate.ts";
import { eligibleStorylets } from "../story/storylets.ts";

/** 플레이 테스트 8 (docs/playtests/2026-11-19-mcp-8-long.md, 긴 판 둘)에서 고친 것 */
const real = loadRealContent();
const content = { ...real, storylets: {} };
const make = (role: string, roll = 0.99, c = content) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-pt8-")), content: c, rngFactory: () => () => roll }).create("mcp", role);
const act = (w: GameWorld, extra: Record<string, unknown>) =>
  w.executeTool("take_action", { intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...extra });

describe("플레이 테스트 8", () => {
  it("B3: 앞 주인공의 임무는 계승 뒤 조용히 끝난다. 이어받은 사람에게 불복종·행적·장비 반납을 묻지 않는다", () => {
    const w = make("role_a_grunt");
    const day = Math.floor(w.state().time / 1440) + 1;
    w.ctx().store.append({ type: "missions_offered", day, templateIds: ["guard_east_post"] });
    expect(w.executeTool("npc_presence", { npc_id: "a_taeho", action: "enter" }).ok).toBe(true);
    expect(w.executeTool("assign_mission", { template_id: "guard_east_post" }).ok).toBe(true);
    expect(w.runCheat("~kill me").ok).toBe(true);
    const heirId = w.successionOptions().find((o) => !o.id.startsWith("new:"))?.id;
    expect(heirId).toBeTruthy();
    expect(w.chooseNextCharacter(heirId!).ok).toBe(true);
    const heir = () => w.state().characters[w.state().playerId]!;
    const before = { ...heir().inventory };
    const disobedience = heir().disobedience;
    w.runCheat("~time +2d");
    expect(Object.values(w.state().missions).every((m) => m.status !== "active")).toBe(true);
    expect(heir().disobedience).toBe(disobedience);
    expect(Object.values(w.state().deeds).some((d) => d.actorId === heir().id && d.summary.startsWith("임무 기한 초과"))).toBe(false);
    for (const [id, n] of Object.entries(before)) expect(heir().inventory[id] ?? 0).toBeGreaterThanOrEqual(Math.min(n, 1));
  });

  it("B4: 숨은 목격자는 그 시각 같은 구역에 있던 사람만이다", () => {
    const w = make("role_a_grunt", 0);
    recordDeed(w.ctx(), { summary: "창고에서 통조림을 훔쳤다", tags: ["theft"], severity: 2, privacy: "public", noisy: false });
    const s = w.state();
    const deed = Object.values(s.deeds).at(-1)!;
    expect(deed.witnesses.length).toBeGreaterThan(0);
    for (const wit of deed.witnesses.filter((x) => x.hidden)) expect(npcZoneAt(real.npcs[wit.npcId]!, s.time)).toBe(s.playerZone);
  });

  it("B5: 이야기 문장에 적힌 이름 중 모르는 것은 호칭으로 바뀐다", () => {
    const w = make("role_l_wanderer");
    const npc = Object.values(real.npcs).find((n) => n.name === "주옥희")!;
    const text = maskUnknownNames(w.state(), real, "주옥희는 짐꾼 수를 두 번 셌다");
    expect(text).not.toContain("주옥희");
    w.ctx().store.append({ type: "name_learned", characterId: w.state().playerId, targetId: npc.id });
    expect(maskUnknownNames(w.state(), real, "주옥희는 짐꾼 수를 두 번 셌다")).toContain("주옥희");
  });

  it("B9: 낚시 도구는 낚시에만 보정을 준다", () => {
    const w = make("role_l_wanderer");
    // 떠돌이는 낚시 도구 없이 시작한다 (플레이 테스트 12: 낚시를 못 하는데 들고 있었다). 쥐여 주고 본다
    w.ctx().store.append({ type: "item_granted", to: w.state().playerId, itemId: "fishing_kit", quantity: 1 });
    const me = w.state().characters[w.state().playerId]!;
    expect(me.inventory.fishing_kit).toBeGreaterThan(0);
    // 4.2.1: 낚시는 따로 된 전문 기술(fishing)이 됐고, 낚시 도구의 보정도 그 스킬에 붙는다
    expect(gearModifiers(real, me, "fishing", null, w.state(), "fish").skill).toBe(1);
    expect(gearModifiers(real, me, "fishing", null, w.state(), "hunt").skill).toBe(0);
    expect(gearModifiers(real, me, "fishing", null, w.state(), null).skill).toBe(0);
    expect(gearModifiers(real, me, "survival", null, w.state(), "fish").skill).toBe(0);
  });

  it("B10: 없는 물건을 쓰려 하면 시간을 흘리지 않고 막는다", () => {
    const w = make("role_l_wanderer");
    const t = w.state().time;
    const r = act(w, { use_item: "antibiotics" });
    expect(r.ok).toBe(false);
    expect(w.state().time).toBe(t);
  });

  it("B13: 함께 다니는 동물이 있으면 '따라오는 누렁이'가 열리지 않는다", () => {
    const w = make("role_l_wanderer", 0.99, real);
    const s = w.state();
    const day = s.time - (s.time % 1440) + 30 * 1440 + 10 * 60; // 거점 밖, 낮
    expect(s.companions.length).toBeGreaterThan(0); // 떠돌이는 누렁이와 시작한다
    expect(eligibleStorylets(s, real, day).map((x) => x.id)).not.toContain("w_stray_dog");
    expect(eligibleStorylets({ ...s, companions: [] }, real, day).map((x) => x.id)).toContain("w_stray_dog");
  });

  it("B15: 불 땐 거처(우리 거점)에서 두 시간 있으면 젖은 옷이 마른다", () => {
    const w = make("role_a_grunt");
    w.ctx().store.append({ type: "wet_set", characterId: w.state().playerId, left: 120, cause: "test" });
    const t = w.state().time;
    exposeToCold(w.ctx(), "rest", t, t + 120);
    expect(w.state().wet[w.state().playerId]).toBeUndefined();
  });
});
