import { describe, expect, it } from "vitest";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { MINUTES_PER_DAY } from "../rules/time.ts";
import { describeExtraTemplates } from "./extras.ts";
import { runHelpless } from "./helpless.ts";
import { executeTool } from "./tools.ts";
import { loadRealContent } from "../testing.ts";

/** 감염체에게 몸을 준다 (12-111): 엑스트라 틀 kind: infected */
const content = loadRealContent();
const quiet = { ...content, storylets: {} };

function setup(zone = "old_town") {
  const roll = { value: 0.5 };
  const store = new InMemoryGameStore([createWorldEvent(quiet, "role_l_wanderer", "world_inf", () => 0.5)]);
  const ctx = { store, rng: () => roll.value, content: quiet };
  const s = store.getState();
  s.time = Math.floor(s.time / MINUTES_PER_DAY) * MINUTES_PER_DAY + 12 * 60;
  s.weather = null;
  s.companions = [];
  s.scene.present = [];
  s.playerZone = zone;
  const me = s.characters[s.playerId]!;
  me.traits = [];
  me.equipped = { ...me.equipped, body: null, head: null, arms: null, outer: null, back: null };
  const spawn = (template = "infected_hungry", label = "감염체") => {
    const out = executeTool("spawn_extra", { template, label }, ctx);
    expect(out.ok).toBe(true);
    return store.getState().scene.present.at(-1)!;
  };
  return { store, ctx, roll, me, spawn };
}

const act = (check: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  intent: "행동", activity: null, deed: null, target: null, narration_summary: null, for_mission: false,
  check: { stat: "strength", difficulty: "normal", harm_on_failure: "none", harm_cause: "", ...check },
  ...extra,
});
const lineOf = (out: ReturnType<typeof executeTool>) => (out.ok && out.display.type === "check" ? out.display.line ?? "" : "");
const infectionStart = content.scenario.condition_tracks.find((t) => t.id === "infection")!.levels[0]!.id;

describe("감염체", () => {
  it("이름이 없고 사람의 사정(첫인상·이름 모름)이 붙지 않는다", () => {
    const { store, spawn } = setup();
    const id = spawn();
    const s = store.getState();
    expect(s.characters[id]!.name).toBe("감염체");
    expect(s.relations[id]?.[s.playerId]).toBeUndefined();
    expect((s.beliefs[s.playerId] ?? []).some((b) => b.fact.includes("감염체와 마주쳤다") && !b.fact.includes("이름은 모른다"))).toBe(true);
  });

  it("맞서는 판정에서 다치면 감염 위험과 그 틀의 상처 종류가 저절로 붙는다", () => {
    const { ctx, roll, store, spawn } = setup();
    const foe = spawn();
    roll.value = 0; // 주사위 1+1 (실패), 감염 굴림은 맞는다
    const out = executeTool("take_action", act({ move: "fight", harm_on_failure: "light", harm_cause: "물렸다", opponent: foe }), ctx);
    expect(out.ok).toBe(true);
    const me = store.getState().characters[store.getState().playerId]!;
    expect(me.conditions.infection).not.toBe(infectionStart);
    // 물림(피가 난다)이라 출혈도 따른다
    expect(me.conditions.bleeding).not.toBe("none");
  });

  it("무는 감염체: 가벼운 위험에 지면 찢김(25%), 무거운 위험에 지면 물림(반드시 감염)", () => {
    for (const [risk, infected] of [["light", false], ["heavy", true]] as const) {
      const { ctx, roll, store, spawn } = setup();
      const foe = spawn();
      roll.value = 0.3; // 주사위 2+2 (실패), 감염 굴림 0.3 (찢김 25%는 피하고 물림은 못 피한다)
      const out = executeTool("take_action", act({ move: "fight", harm_on_failure: risk, harm_cause: "덮쳐 온다", opponent: foe }), ctx);
      expect(out.ok).toBe(true);
      const me = store.getState().characters[store.getState().playerId]!;
      expect(me.conditions.infection !== infectionStart, risk).toBe(infected);
    }
  });

  it("말로 하는 스킬은 감염체에게 쓸 수 없다", () => {
    const { ctx, spawn } = setup();
    const foe = spawn();
    const out = executeTool("take_action", act({ move: "intimidate", stat: "nerve", opponent: foe }), ctx);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("말이 통하지 않는다");
  });

  it("덤빌 수 있는 감염체가 여럿이면 맞붙기 어렵다 (둘 -1, 넷 -2). 쓰러진 것은 세지 않는다", () => {
    const { ctx, store, spawn } = setup();
    const a = spawn();
    expect(lineOf(executeTool("take_action", act({ move: "fight", opponent: a }), ctx))).not.toContain("감염체 1");
    spawn();
    expect(lineOf(executeTool("take_action", act({ move: "fight", opponent: a }), ctx))).toContain("-1(감염체 2)");
    spawn();
    const d = spawn();
    expect(lineOf(executeTool("take_action", act({ move: "fight", opponent: a }), ctx))).toContain("-2(감염체 4)");
    store.getState().characters[d]!.dead = true;
    expect(lineOf(executeTool("take_action", act({ move: "fight", opponent: a }), ctx))).toContain("-1(감염체 3)");
    // 숨기에는 붙지 않는다
    expect(lineOf(executeTool("take_action", act({ move: "stealth", stat: "agility", opponent: a }), ctx))).not.toMatch(/\(감염체 \d\)/);
  });

  it("흥정·포로·이름 알기·연애의 상대가 될 수 없다", () => {
    const { ctx, spawn } = setup();
    const foe = spawn();
    expect(executeTool("barter", { npc_id: foe, give: {}, get: { cloth: 1 }, move: null, stat: null }, ctx).ok).toBe(false);
    expect(executeTool("handle_prisoner", { target: foe, action: "bind" }, ctx).ok).toBe(false);
    expect(executeTool("learn_name", { target: foe, who: "player" }, ctx).ok).toBe(false);
  });

  it("행적을 보지 않는다 (보이는 목격자에서 빠진다)", () => {
    const { ctx, store, spawn } = setup();
    spawn();
    executeTool("take_action", act({ move: "fight" }, { check: null, deed: { summary: "시체를 뒤졌다", tags: ["theft"], severity: 1, privacy: "public", noisy: false, condition: "always" } }), ctx);
    const deeds = Object.values(store.getState().deeds);
    expect(deeds.length).toBeGreaterThan(0);
    for (const d of deeds as { witnesses: { npcId: string }[] }[]) expect(d.witnesses.every((w) => !store.getState().characters[w.npcId]?.extra?.template.startsWith("infected"))).toBe(true);
  });

  it("쓰러져 있는데 곁에 감염체가 있고 지켜 줄 사람이 없으면 반드시 물린다", () => {
    const { ctx, store, spawn } = setup("a_base");
    const foe = spawn();
    store.getState().characters[store.getState().playerId]!.conditions.harm = "unconscious";
    const out = runHelpless({ ...ctx, rng: () => 0.99 });
    // 의식불명에서 한 단계 더 다치면 죽는다 (지금의 부상 트랙)
    expect(out.some((d) => d.type === "harm" && d.cause?.includes("감염체에게 물렸다"))).toBe(true);
    expect(ctx.store.getState().helplessAt).not.toBeNull();
    expect(foe).toBeTruthy();
  });

  it("GM 틀 목록에는 위험한 구역에서만 나온다", () => {
    const { store } = setup("a_base");
    expect(describeExtraTemplates(store.getState(), quiet)).not.toContain("infected_hungry");
    const danger = Object.values(quiet.locations).find((l) => l.danger >= 2 && !l.isolated)!;
    store.getState().playerZone = danger.id;
    expect(describeExtraTemplates(store.getState(), quiet)).toContain("infected_hungry: 굶주린 감염체 (감염체)");
  });
});
