import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { WorldManager } from "../world/manager.ts";
import { describePlayerState } from "./context.ts";
import { attractionOf, hasInterest, loversOf, romanceCast, runRomance } from "./romance.ts";

/** 연애와 삼각관계 (12-58) */
const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };
const open = (mature = true, rng: () => number = () => 0.99) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-love-")), content, rngFactory: () => rng }).create("mcp", "role_a_grunt", choice, undefined, undefined, { mature });
type W = ReturnType<typeof open>;
const like = (w: W, from: string, to: string, affection: number, trust = 3) =>
  w.ctx().store.append({ type: "relation_changed", from, to, delta: { trust, affection, respect: 0 }, reason: "test" });
const enter = (w: W, id: string) => { if (!w.state().scene.present.includes(id)) w.ctx().store.append({ type: "npc_entered", npcId: id } as never); };
/** 주인공(여성)에게 끌리는 성인 남성 둘 */
const men = (w: W) =>
  Object.values(w.state().characters)
    .filter((c) => c.gender === "male" && (c.age ?? 0) >= 18 && content.npcs[c.id] && !c.captive && attractionOf(w.state(), content, c).includes("female"))
    .map((c) => c.id)
    .sort()
    .slice(0, 3);

describe("연애", () => {
  it("수위가 꺼져 있으면 연애를 다루지 않는다", () => {
    const w = open(false);
    const [m] = men(w);
    enter(w, m!);
    const out = w.executeTool("romance", { target: m, action: "confess", approach: null, stat: null });
    expect(!out.ok && out.error).toContain("수위");
  });

  it("끌림은 인물마다 다르고 판마다 같다", () => {
    const a = open();
    const b = open();
    for (const c of Object.values(a.state().characters).slice(0, 20)) expect(attractionOf(a.state(), content, c)).toEqual(attractionOf(b.state(), content, b.state().characters[c.id]!));
  });

  it("호감이 쌓이면 낌새가 보이고, 고백을 받아들이면 연인이 된다", () => {
    const w = open();
    const [m] = men(w);
    enter(w, m!);
    const early = w.executeTool("romance", { target: m, action: "confess", approach: null, stat: null });
    expect(early.ok && early.resultText).toContain("받아들이지 않았다");
    like(w, m!, "player", 5);
    expect(hasInterest(w.state(), content, m!, "player")).toBe(true);
    const yes = w.executeTool("romance", { target: m, action: "confess", approach: null, stat: null });
    expect(yes.ok && yes.resultText).toContain("연인이다");
    expect(loversOf(w.state(), content, "player")).toContain(m);
    expect(describePlayerState(w.state(), content)).toContain("연인:");
  });

  it("삼각관계: 연인이 보는 앞에서 다른 사람에게 다가가면 질투하고, 많이 식으면 떠난다", () => {
    const w = open(false ? false : true, () => 0.01);
    const [a, b] = men(w);
    like(w, a!, "player", 6);
    like(w, b!, "player", 6);
    enter(w, a!);
    enter(w, b!);
    w.executeTool("romance", { target: a, action: "confess", approach: null, stat: null });
    // 둘이 한자리에서 주인공을 보면 서로 앙금
    runRomance(w.ctx());
    expect((w.state().relations[a!]?.[b!]?.trust ?? 0) + (w.state().relations[b!]?.[a!]?.trust ?? 0)).toBeLessThan(0);
    const flirt = w.executeTool("romance", { target: b, action: "flirt", approach: "persuade", stat: "charm" });
    expect(flirt.ok && flirt.resultText).toContain("그 모습을 봤다");
    expect(romanceCast(w.state(), content, "jealous")).toContain(a);
    w.executeTool("romance", { target: b, action: "confess", approach: null, stat: null });
    like(w, a!, "player", -5, 0);
    runRomance(w.ctx());
    expect(loversOf(w.state(), content, "player")).not.toContain(a);
  });

  it("다른 사람의 연인을 빼앗으면 버림받은 쪽이 원망하고, 연인이 죽으면 마음이 무너진다", async () => {
    const w = open();
    const [a, b] = men(w);
    // a와 b'는 원래 연인 (정해진 관계 대신 연애 상태로)
    const other = Object.values(w.state().characters).find((c) => c.gender === "female" && (c.age ?? 0) >= 18 && content.npcs[c.id] && !c.captive)!.id;
    w.ctx().store.append({ type: "romance_changed", a: a!, b: other, stage: "lovers" });
    like(w, a!, other, 2);
    like(w, a!, "player", 6);
    enter(w, a!);
    w.executeTool("romance", { target: a, action: "flirt", approach: "persuade", stat: "charm" });
    expect(romanceCast(w.state(), content, "rival_lover")).toContain(other);
    const out = w.executeTool("romance", { target: a, action: "confess", approach: null, stat: null });
    expect(out.ok && out.resultText).toContain("원망한다");
    expect(w.state().relations[other]?.player?.trust).toBeLessThan(0);
    expect(b).toBeTruthy();
    const { onLoverDeath } = await import("./romance.ts");
    onLoverDeath(w.ctx(), a!);
    expect(w.state().characters.player!.conditions.nerves).toBe("frayed");
  });
});

describe("성적 위협 (12-59)", () => {
  it("데이터에 있는 자만, 수위가 켜져 있고 그 자가 주인공에게 끌릴 때만 배역이 되고 GM에게 알린다", async () => {
    const { castCandidates } = await import("../story/storylets.ts");
    const role = { commander: false, known: false, enter: true, optional: false, here: false, menace: ["harass", "coerce", "assault"] } as never;
    const on = open(true);
    const me = on.state().characters.player!;
    const menaces = Object.values(on.state().characters).filter((c) => c.menace).map((c) => c.id);
    expect(menaces.length).toBeGreaterThan(0);
    const picked = castCandidates(on.state(), content, role);
    for (const id of picked) expect(attractionOf(on.state(), content, on.state().characters[id]!)).toContain(me.gender);
    const off = open(false);
    expect(castCandidates(off.state(), content, role)).toEqual([]);
    if (picked[0]) {
      enter(on, picked[0]);
      expect(describePlayerState(on.state(), content)).toContain("[GM 전용, 성인 주제]");
      enter(off, picked[0]);
      expect(describePlayerState(off.state(), content)).not.toContain("[GM 전용, 성인 주제]");
    }
  });

  it("위협한 자를 원수로 삼으면 배경의 원수가 된다", async () => {
    const { createContentSchemas } = await import("../content/schemas.ts");
    const { fireStorylet } = await import("./storyletTools.ts");
    const w = open(true);
    const s = createContentSchemas(content.scenario).storylet.parse({ id: "g", title: "g", tags: ["world"], cast: { foe: { ids: ["c_gyeongsu"], enter: false } }, setup: "x", choices: [{ id: "a", label: "a", effects: [{ grudge: { who: "foe", why: "나를 위협했다" } }] }] });
    const ctx = { ...w.ctx(), content: { ...w.content, storylets: { g: s } } };
    fireStorylet(ctx, s, { foe: "c_gyeongsu" });
    w.executeTool("resolve_storylet", { choice_id: "a" });
    const { executeTool } = await import("./tools.ts");
    executeTool("resolve_storylet", { choice_id: "a" }, ctx);
    expect(w.state().background.some((e) => e.part.kind === "enemy" && e.part.target === "c_gyeongsu")).toBe(true);
    expect(w.state().flags.player).toContain("bg_enemy_person");
  });
});
