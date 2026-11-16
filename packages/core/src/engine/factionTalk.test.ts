import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { describePlayerState } from "./context.ts";
import { factionTroubles, spreadTroubleRumors, troubleAttitude, troubleLine } from "./factionTalk.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";

/** 무리 형편 (12-105) */
const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));

function setup() {
  const store = new InMemoryGameStore([createWorldEvent(content, "role_b_guard", "world_talk", () => 0.5)]);
  runAfterTimeAdvance({ store, rng: () => 0.5, content });
  const state = () => store.getState();
  const me = () => state().characters[state().playerId]!;
  return { store, state, me };
}

describe("무리 형편", () => {
  it("넉넉하고 분위기가 괜찮으면 도는 말이 없다", () => {
    const { state, me } = setup();
    const own = state().factions[me().factionId]!;
    own.morale = 1;
    for (const r of Object.keys(own.resources)) own.resources[r] = 99999;
    expect(factionTroubles(state(), content)).toEqual([]);
    expect(describePlayerState(state(), content)).not.toContain("무리 사람들 사이에 도는 말");
  });

  it("창고가 바닥나고 분위기가 가라앉으면 도는 말이 되고, GM 상태에 실린다", () => {
    const { state, me } = setup();
    const own = state().factions[me().factionId]!;
    own.morale = -2;
    own.resources.food = 0;
    const troubles = factionTroubles(state(), content);
    expect(troubles.join()).toContain("분위기가 흉흉함");
    expect(troubles.some((t) => t.startsWith("식량"))).toBe(true);
    expect(describePlayerState(state(), content)).toContain("무리 사람들 사이에 도는 말");
  });

  it("인물의 트레잇으로 태도가 갈리고, 같은 무리 사람만 카드에 붙는다", () => {
    const { state, me } = setup();
    state().factions[me().factionId]!.morale = -2;
    // 콘텐츠 인물은 콘텐츠의 트레잇을 쓰므로, 같은 무리의 이름 없는 사람으로 본다
    const named = Object.values(state().characters).find((c) => c.id !== me().id && c.factionId === me().factionId && !c.dead)!;
    const mate = { ...named, id: "ex_test" };
    mate.traits = ["cynical"];
    expect(troubleAttitude(content, mate)?.label).toBe("투덜댄다");
    mate.traits = ["warm", "eager"];
    expect(troubleAttitude(content, mate)?.label).toBe("다독인다");
    mate.traits = [];
    expect(troubleAttitude(content, mate)?.label).toBe("조심스럽게 입에 올린다");
    expect(troubleLine(state(), content, mate)).toContain("무리 형편에 대해");
    const stranger = Object.values(state().characters).find((c) => c.factionId && c.factionId !== me().factionId)!;
    expect(troubleLine(state(), content, stranger)).toBeNull();
  });

  it("다른 무리의 형편은 말이 모이는 곳에서만 소문으로 들리고, 사흘 안에 같은 말은 다시 듣지 않는다", () => {
    const { store, state, me } = setup();
    const other = Object.keys(state().factions).find((f) => f !== me().factionId)!;
    state().factions[other]!.morale = -3;
    const ctx = { store, rng: () => 0, content };
    state().playerZone = "south_fields";
    expect(spreadTroubleRumors(ctx)).toEqual([]);
    state().playerZone = "e_market";
    const heard = spreadTroubleRumors(ctx).filter((d) => d.type === "belief");
    expect(heard.some((d) => d.type === "belief" && d.fact.startsWith(content.factions[other]!.name))).toBe(true);
    const again = spreadTroubleRumors(ctx).filter((d) => d.type === "belief" && d.fact.startsWith(content.factions[other]!.name));
    expect(again).toEqual([]);
    // 우리 무리 것은 소문이 아니라 도는 말로
    expect(spreadTroubleRumors(ctx).some((d) => d.type === "belief" && d.fact.startsWith(content.factions[me().factionId]!.name))).toBe(false);
  });

  /** 굴림을 차례로 돌려주는 난수 (다 쓰면 마지막 값) */
  const seq = (...xs: number[]) => () => (xs.length > 1 ? xs.shift()! : xs[0]!);
  const heardAbout = (state: ReturnType<ReturnType<typeof setup>["state"]>, me: string, f: string) =>
    (state.beliefs[me] ?? []).filter((b) => b.topic === `faction_trouble:${f}`);

  it("성당에서는 부풀려 듣고 (정확도 approximate), 장터에서는 그대로 듣는다 (exact)", () => {
    for (const [zone, expected] of [["cathedral", "approximate"], ["e_market", "exact"]] as const) {
      const { store, state, me } = setup();
      const other = Object.keys(state().factions).find((f) => f !== me().factionId)!;
      for (const f of Object.values(state().factions)) for (const r of Object.keys(f.resources)) f.resources[r] = 99999;
      state().factions[other]!.morale = -1;
      state().playerZone = zone;
      // 듣는다(0) → 고른다(0) → 부풀릴지 굴림 0.3 (성당 0.5보다 작고, 장터 0.1보다 크다) → 나머지 무리는 듣지 않는다(0.99)
      spreadTroubleRumors({ store, rng: seq(0, 0, 0.3, 0.99), content });
      const b = heardAbout(state(), me().id, other)[0]!;
      expect(b.accuracy).toBe(expected);
      expect(b.fact).toContain(expected === "exact" ? "가라앉음" : "흉흉함");
    }
  });

  it("멀쩡한 무리도 헛소문이 돈다 (정확도 false, 실제로 겪지 않는 어려움)", () => {
    const { store, state, me } = setup();
    for (const f of Object.values(state().factions)) {
      f.morale = 1;
      for (const r of Object.keys(f.resources)) f.resources[r] = 99999;
    }
    state().playerZone = "e_market";
    spreadTroubleRumors({ store, rng: () => 0, content });
    const other = Object.keys(state().factions).find((f) => f !== me().factionId)!;
    const b = heardAbout(state(), me().id, other)[0]!;
    expect(b.accuracy).toBe("false");
    expect(b.fact.startsWith(content.factions[other]!.name)).toBe(true);
  });
});
