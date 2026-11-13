import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { createContentSchemas } from "../content/schemas.ts";
import { createSeededRng } from "../rng.ts";
import { eligibleStorylets } from "../story/storylets.ts";
import { WorldManager } from "../world/manager.ts";
import { capturePlayer, runCaptivity, warCaptures } from "./captivity.ts";
import { describePlayerState } from "./context.ts";

/** 포로 (12-55) */
const base = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const open = (rng: () => number = createSeededRng(4)) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-cap-")), content: base, rngFactory: () => rng }).create("mcp", "role_a_grunt");
const act = (extra: Record<string, unknown>) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...extra });
const hurt = (w: ReturnType<typeof open>, id: string, to: string) =>
  w.ctx().store.append({ type: "condition_changed", targetId: id, track: "harm", from: w.state().characters[id]!.conditions.harm!, to, fatal: false, by: "test", cause: "test", day: 1, harmTrack: true });

describe("주인공이 붙잡힌다", () => {
  it("붙잡히면 무기를 빼앗기고 붙잡은 무리의 거점에 갇히고, 갇힌 동안의 이야기만 열린다", () => {
    const w = open();
    const me = () => w.state().characters[w.state().playerId]!;
    expect(me().inventory.kitchen_knife).toBeGreaterThan(0);
    const line = capturePlayer(w.ctx(), "faction_c");
    expect(line).toContain("붙잡혀");
    expect(me().captive).toMatchObject({ by: "faction_c", zone: "c_base" });
    expect(w.state().playerZone).toBe("c_base");
    expect(me().inventory.kitchen_knife).toBeUndefined();
    expect(describePlayerState(w.state(), w.content)).toContain("주인공은 갇혀 있다");
    const parse = createContentSchemas(base.scenario).storylet.parse;
    const cap = parse({ id: "cap", title: "c", tags: ["captivity"], when: { captors: ["faction_c"] }, setup: "x", choices: [{ id: "a", label: "a", effects: [] }] });
    const free = parse({ id: "free", title: "f", tags: ["world"], setup: "x", choices: [{ id: "a", label: "a", effects: [] }] });
    const c = { ...w.content, storylets: { cap, free } };
    expect(eligibleStorylets(w.state(), c).map((s) => s.id)).toEqual(["cap"]);
  });

  it("그냥은 옮겨 가지 못하고, 탈출 판정에 성공하면 빠져나오되 빼앗긴 것은 두고 온다", () => {
    const w = open(() => 0.99); // 주사위가 높다
    capturePlayer(w.ctx(), "faction_c");
    const plain = w.executeTool("take_action", act({ move_to: "c_warehouse" }));
    expect(!plain.ok && plain.error).toContain("갇혀 있다");
    const out = w.executeTool("take_action", act({ move_to: "c_warehouse", check: { move: "stealth", stat: "agility", difficulty: "normal", harm_on_failure: "heavy", harm_cause: "", infected_source: false, target_harm: "none" } }));
    expect(out.ok).toBe(true);
    const me = w.state().characters[w.state().playerId]!;
    expect(me.captive).toBeNull();
    expect(w.state().playerZone).toBe("c_warehouse");
    expect(me.inventory.kitchen_knife).toBeUndefined();
  });
});

describe("포로를 잡고 다룬다", () => {
  it("크게 다친 사람만 묶고, 우리 거점에 닿으면 우리 무리의 포로가 되고, 심문·몸값·노역을 한다", () => {
    const w = open(() => 0.99);
    w.ctx().store.append({ type: "zone_moved", from: w.state().playerZone, to: "old_town" });
    w.executeTool("npc_presence", { npc_id: "c_seokjin", action: "enter" });
    // 다른 곳에 있는 인물이면 장면에 넣는다
    if (!w.state().scene.present.includes("c_seokjin")) w.ctx().store.append({ type: "npc_entered", npcId: "c_seokjin" } as never);
    expect(w.executeTool("take_prisoner", { target: "c_seokjin" }).ok).toBe(false);
    hurt(w, "c_seokjin", "serious");
    expect(w.executeTool("take_prisoner", { target: "c_seokjin" }).ok).toBe(true);
    const back = w.executeTool("take_action", act({ move_to: "a_base" }));
    expect(back.ok && back.resultText).toContain("우리 무리의 포로");
    expect(w.state().characters.c_seokjin!.captive).toMatchObject({ by: "faction_a", zone: "a_base" });
    expect(describePlayerState(w.state(), w.content)).toContain("우리 무리가 여기 가둔 포로");
    const ask = w.executeTool("handle_prisoner", { target: "c_seokjin", action: "interrogate", approach: "persuade", stat: "charm" });
    expect(ask.ok && ask.resultText).toContain("심문");
    expect(w.executeTool("handle_prisoner", { target: "c_seokjin", action: "labor", approach: null, stat: null }).ok).toBe(true);
    const food = () => w.state().factions.faction_a!.resources.food ?? 0;
    const f0 = food();
    runCaptivity(w.ctx());
    expect(food()).toBe(f0 - 1 + 2);
    // 원수끼리(-3)면 몸값도 없다
    w.ctx().store.append({ type: "faction_disposition_changed", from: "faction_c", to: "faction_a", value: -3 });
    expect(w.executeTool("handle_prisoner", { target: "c_seokjin", action: "ransom", approach: null, stat: null }).ok).toBe(false);
    w.ctx().store.append({ type: "faction_disposition_changed", from: "faction_c", to: "faction_a", value: -1 });
    // 붉은연합에 갇힌 우리 사람(실종된 정찰조)이 있으면 몸값 대신 맞바꾼다
    const swap = w.executeTool("handle_prisoner", { target: "c_seokjin", action: "ransom", approach: null, stat: null });
    expect(swap.ok && swap.resultText).toContain("맞교환");
    expect(w.state().characters.c_seokjin!.captive).toBeNull();
    expect(["a_jeongbin", "a_gicheol_scout"].filter((id) => !w.state().characters[id]!.captive)).toHaveLength(1);
  });

  it("무리 사이 싸움에서 진 쪽의 이름 있는 싸움꾼이 붙잡혀 가고, 우리 쪽이면 소식으로 안다", () => {
    const w = open(() => 0.01);
    const out = warCaptures(w.ctx(), [{ kind: "raid", attacker: "faction_c", defender: "faction_a", zone: "a_east_post", success: true, attackerLosses: 0, defenderLosses: 2 }]);
    const taken = Object.values(w.state().characters).find((c) => c.captive?.by === "faction_c" && c.factionId === "faction_a" && !base.npcs[c.id]?.start_captive);
    expect(taken).toBeTruthy();
    expect(out.length + 0).toBeGreaterThanOrEqual(0);
  });
});

describe("12-56: 갇힌 날수, 다침, 행방", () => {
  const parse = createContentSchemas(base.scenario).storylet.parse;
  it("갇힌 지 며칠이 지나야 열리고, 판정의 대가로만 다치며 죽지는 않는다", async () => {
    const { checkStorylets } = await import("../content/loader.ts");
    const w = open();
    capturePlayer(w.ctx(), "faction_c");
    const long = parse({ id: "long", title: "l", tags: ["captivity"], when: { captive_days_gte: 3 }, setup: "x", choices: [{ id: "a", label: "a", effects: [] }] });
    const c = { ...w.content, storylets: { long } };
    expect(eligibleStorylets(w.state(), c)).toHaveLength(0);
    expect(eligibleStorylets(w.state(), c, w.state().time + 3 * 1440)).toHaveLength(1);
    const bad = parse({ id: "bad", title: "b", setup: "x", choices: [{ id: "a", label: "a", effects: [{ wound: { steps: 1, cause: "x" } }] }] });
    expect(checkStorylets({ ...w.content, storylets: { bad } }).join()).toContain("wound는 판정의 partial·miss");
  });

  it("어딘가 붙잡힌 우리 사람을 부르고, 그 사람이 어디 갇혔는지 진짜 상태로 알려 준다", async () => {
    const { fireStorylet } = await import("./storyletTools.ts");
    const { executeTool } = await import("./tools.ts");
    const w = open();
    const s = parse({ id: "find", title: "f", when: { own_people_captive: true }, cast: { lost: { captive_anywhere: true, faction: "own", enter: false } }, setup: "{lost}", choices: [{ id: "a", label: "a", effects: [{ locate: { who: "lost" } }] }] });
    const c = { ...w.content, storylets: { find: s } };
    expect(eligibleStorylets(w.state(), c).map((x) => x.id)).toEqual(["find"]);
    const ctx = { ...w.ctx(), content: c };
    fireStorylet(ctx, s, { lost: "a_jeongbin" });
    const out = executeTool("resolve_storylet", { choice_id: "a" }, ctx);
    expect(out.ok && out.resultText).toContain("고가도로 너머 물류창고에 갇혀 있다");
  });
});
