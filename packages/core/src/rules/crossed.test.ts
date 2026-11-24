import { describe, expect, it } from "vitest";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { runAfterTimeAdvance } from "../engine/turnStart.ts";
import { personFacts } from "../engine/personFacts.ts";
import { castCandidates } from "../story/storylets.ts";
import { loadRealContent } from "../testing.ts";
import { crossedLine, factionsAtWar, keepsAway, sparesPlayer } from "./crossed.ts";
import { reduceHarm } from "./damage.ts";
import { startRelation } from "./regard.ts";

/** 공통 규칙 20: 무리 사이와 사람 사이 (전쟁 중 각별함, 전쟁 아님 원수) */
const content = loadRealContent();

function setup() {
  const store = new InMemoryGameStore([createWorldEvent(content, "role_a_grunt", "world_crossed", () => 0.5)]);
  const ctx = { store, rng: () => 0.99, content };
  runAfterTimeAdvance(ctx);
  const s = store.getState();
  const me = s.characters[s.playerId]!;
  const pick = (faction: string) => Object.values(s.characters).find((c) => c.id !== me.id && !c.dead && c.factionId === faction && content.npcs[c.id])!.id;
  const foe = pick("faction_c");
  const mate = pick(me.factionId!);
  const set = (id: string, d: { trust?: number; affection?: number }) => {
    const r = store.getState().relations[id]?.[me.id] ?? { trust: 0, affection: 0, respect: 0 };
    startRelation(ctx, { from: id, to: me.id, delta: { trust: (d.trust ?? r.trust) - r.trust, affection: (d.affection ?? r.affection) - r.affection, respect: 0 }, reason: "테스트" });
  };
  return { store, ctx, me, foe, mate, set };
}

describe("무리 사이와 사람 사이", () => {
  it("무리 사이는 지금 태도로 읽는다: 휴전하면 바로 전쟁이 아니다", () => {
    const { store, foe, me } = setup();
    expect(factionsAtWar(store.getState(), content, foe)).toBe(true);
    store.append({ type: "faction_disposition_changed", from: "faction_c", to: me.factionId!, value: -1 });
    store.append({ type: "faction_disposition_changed", from: me.factionId!, to: "faction_c", value: -1 });
    expect(factionsAtWar(store.getState(), content, foe)).toBe(false);
  });

  it("전쟁 중 + 각별함: 먼저 치지 않고, 그 사람이 낸 상처는 치명상 바로 앞에서 멈춘다", () => {
    const { store, ctx, foe, me, set } = setup();
    expect(sparesPlayer(store.getState(), content, foe)).toBe(false);
    set(foe, { affection: 4 });
    expect(sparesPlayer(store.getState(), content, foe)).toBe(true);
    expect(crossedLine(store.getState(), content, foe)).toContain("전쟁 중 · 개인적으로 각별함");
    expect(personFacts(store.getState(), content, foe, true).crossed).toContain("먼저 치지 않는다");
    expect(personFacts(store.getState(), content, foe, false).crossed).toBeFalsy();
    // 다치지 않은 몸에 2단계: 중상(2단계)까지는 그대로
    const track = content.scenario.harm_track;
    store.getState().characters[me.id]!.conditions[track] = "light";
    const r = reduceHarm(ctx, { who: me.id, raw: 2, attack: false, shareable: false, cause: "테스트", track, opponent: foe });
    expect(r.steps).toBe(1); // 경상 → 중상에서 멈춘다
    expect(r.lines.join(" ")).toContain("목숨을 빼앗을 생각은 없다");
    // 각별하지 않은 적은 그대로
    set(foe, { affection: 0 });
    expect(reduceHarm(ctx, { who: me.id, raw: 2, attack: false, shareable: false, cause: "테스트", track, opponent: foe }).steps).toBe(2);
  });

  it("전쟁 아님 + 원수: 이야기 배역으로 뽑지 않는다 (사람을 정해 둔 배역은 그대로)", () => {
    const { store, mate, set } = setup();
    const role = { faction: "own" } as never;
    expect(castCandidates(store.getState(), content, role)).toContain(mate);
    set(mate, { trust: -4 });
    expect(keepsAway(store.getState(), content, mate)).toBe(true);
    expect(crossedLine(store.getState(), content, mate)).toContain("개인적으로 원수");
    expect(castCandidates(store.getState(), content, role)).not.toContain(mate);
    expect(castCandidates(store.getState(), content, { faction: "own", ids: [mate] } as never)).toContain(mate);
  });

  it("전쟁 중인 원수는 이 규칙이 아니다 (적은 원래 적)", () => {
    const { store, foe, set } = setup();
    set(foe, { trust: -5 });
    expect(keepsAway(store.getState(), content, foe)).toBe(false);
    expect(crossedLine(store.getState(), content, foe)).toBeNull();
  });
});
