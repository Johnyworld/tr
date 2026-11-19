import { describe, expect, it } from "vitest";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { describePlayerState } from "./context.ts";
import { factionTroubles, heardRumors, spreadTroubleRumors, troubleAttitude, troubleLine } from "./factionTalk.ts";
import { npcZoneAt } from "../game/whereabouts.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";
import { loadRealContent } from "../testing.ts";

/** 무리 형편 (12-105) */
const content = loadRealContent();

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

  it("들은 말은 지금 형편 그대로다. 멀쩡한 무리의 헛소문은 없다 (12-185)", () => {
    const { store, state, me } = setup();
    for (const f of Object.values(state().factions)) {
      f.morale = 1;
      for (const r of Object.keys(f.resources)) f.resources[r] = 99999;
    }
    state().playerZone = "cathedral";
    expect(spreadTroubleRumors({ store, rng: () => 0, content })).toEqual([]);
    const other = Object.keys(state().factions).find((f) => f !== me().factionId)!;
    state().factions[other]!.morale = -1;
    spreadTroubleRumors({ store, rng: () => 0, content });
    const b = (state().beliefs[me().id] ?? []).find((x) => x.topic === `faction_trouble:${other}`)!;
    expect(b.accuracy).toBe("exact");
    expect(b.fact).toContain("가라앉음");
  });

  it("말이 모이는 곳에 머무는 사람은 기록 없이 지금 형편을 안다 (12-124, 12-185)", () => {
    const { state, me } = setup();
    const other = Object.keys(state().factions).find((f) => f !== me().factionId)!;
    const merchant = Object.values(content.npcs).find((n) => npcZoneAt(n, state().time) === "e_market" && n.faction !== other && !state().characters[n.id]!.captive)!;
    expect(heardRumors(state(), content, merchant.id).some((h) => h.startsWith(content.factions[other]!.name))).toBe(false);
    state().factions[other]!.morale = -3;
    expect(heardRumors(state(), content, merchant.id).some((h) => h.startsWith(content.factions[other]!.name))).toBe(true);
    expect((state().beliefs[merchant.id] ?? []).filter((b) => b.topic?.startsWith("faction_trouble"))).toEqual([]);
  });
});
