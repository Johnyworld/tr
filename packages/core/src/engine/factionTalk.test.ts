import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { describePlayerState } from "./context.ts";
import { factionTroubles, troubleAttitude, troubleLine } from "./factionTalk.ts";
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
});
