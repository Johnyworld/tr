import { describe, expect, it } from "vitest";
import { createWorldEvent } from "./state.ts";
import { InMemoryGameStore } from "./store.ts";
import { fameOf, stanceOf } from "./fame.ts";
import { npcZoneAt } from "./whereabouts.ts";
import { spreadRumors } from "../engine/reputationTools.ts";
import { castCandidates } from "../story/storylets.ts";
import { MINUTES_PER_DAY } from "../rules/time.ts";
import { loadRealContent } from "../testing.ts";

/** 명성, 퍼지는 길, 왜곡, 팬·안티 (12-127) */
const content = { ...loadRealContent(), storylets: {} };
const NO_DELTA = { trust: 0, affection: 0, respect: 0 };

function setup() {
  const store = new InMemoryGameStore([createWorldEvent(content, "role_a_grunt", "world_fame", () => 0.5)]);
  const ctx = { store, rng: () => 0, content };
  const s = store.getState();
  const witness = (s.known[s.playerId] ?? []).find((id) => s.characters[id]?.factionId === "faction_a")!;
  /** 주인공의 행적 하나 (목격자: 청솔 동료) */
  let no = 0;
  const deed = (severity: number) => {
    const id = `d_t${++no}`;
    store.append({
      type: "deed_recorded",
      deed: { id, actorId: s.playerId, summary: `큰일 ${no}`, tags: ["bravery"], severity, privacy: "public", turn: 0, time: s.time, witnesses: [{ npcId: witness, hidden: false }], searched: false },
    } as never);
    store.append({ type: "deed_learned", deedId: id, npcId: witness, source: "seen", delta: NO_DELTA });
    return id;
  };
  const days = (n: number) => {
    spreadRumors(ctx);
    for (let i = 0; i < n; i++) {
      store.getState().time += MINUTES_PER_DAY;
      spreadRumors(ctx);
    }
  };
  const knowers = (deedId: string) => Object.entries(store.getState().deedKnowledge).filter(([, k]) => k[deedId]).map(([id]) => id);
  return { store, ctx, deed, days, knowers, witness, state: () => store.getState() };
}

describe("명성", () => {
  it("남에게 보인 행적의 크기가 쌓여 단계가 오른다. 한두 번으로는 무명", () => {
    const { deed, state } = setup();
    deed(2);
    expect(fameOf(state(), content).tier).toBe(0);
    deed(3);
    deed(3);
    expect(fameOf(state(), content).tier).toBe(1);
    expect(fameOf(state(), content).label).toBe(content.scenario.fame!.tiers[1]!.label);
  });

  it("무명이면 목격자의 무리 안에서만 돈다. 알려지면 말이 모이는 곳을 거쳐 다른 무리로 넘어간다", () => {
    const quiet = setup();
    const small = quiet.deed(1);
    quiet.days(3);
    const outsiders = (w: ReturnType<typeof setup>, id: string) => w.knowers(id).filter((n) => w.state().characters[n]!.factionId !== "faction_a");
    expect(outsiders(quiet, small)).toEqual([]);

    const known = setup();
    known.deed(3);
    known.deed(3);
    const big = known.deed(1);
    known.days(3);
    const out = outsiders(known, big);
    expect(out.length).toBeGreaterThan(0);
    // 다른 무리 사람은 말이 모이는 곳(장터 등)에서 들은 사람이거나, 그 사람의 무리 동료다
    const talk = content.scenario.war!.talk!.rumor!.zones;
    expect(out.some((n) => talk[npcZoneAt(content.npcs[n]!, known.state().time) ?? ""])).toBe(true);
  });
});

describe("팬과 안티", () => {
  it("소문으로만 알고 호감·존중이 크게 기운 사람이 팬·안티다. 직접 본 사람은 아니다", () => {
    const { store, deed, state, witness } = setup();
    const d = deed(2);
    const s = state();
    const stranger = Object.keys(content.npcs).find((id) => s.characters[id]!.factionId === "faction_c" && !s.characters[id]!.dead)!;
    store.append({ type: "deed_learned", deedId: d, npcId: stranger, source: "rumor", delta: { trust: 0, affection: 3, respect: 0 } });
    expect(stanceOf(state(), content, stranger)).toBe("fan");
    store.append({ type: "relation_changed", from: stranger, to: s.playerId, delta: { trust: 0, affection: -7, respect: 0 }, reason: "테스트" });
    expect(stanceOf(state(), content, stranger)).toBe("anti");
    // 직접 본 사람은 팬·안티가 아니다
    store.append({ type: "relation_changed", from: witness, to: s.playerId, delta: { trust: 0, affection: 5, respect: 0 }, reason: "테스트" });
    expect(stanceOf(state(), content, witness)).toBeNull();
    // 이야기 배역 stance로 고를 수 있다
    expect(castCandidates(state(), content, { stance: "anti", commander: false, known: false, enter: true } as never)).toContain(stranger);
  });
});
