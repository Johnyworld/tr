import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Content } from "../content/schemas.ts";
import { checkTraits, randomTraits, traitBalance } from "../game/creation.ts";
import { hiddenWitnessChance } from "../game/reputation.ts";
import { createSeededRng } from "../rng.ts";
import { TEST_CONTENT } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { describePlayerState } from "./context.ts";
import { affectionTraitBonus, attractionCheckBonus, bodyTraits, looksImpression, traitLabels, xpMultiplier } from "./traits.ts";

function content(): Content {
  const c = structuredClone(TEST_CONTENT);
  c.scenario.creation = {
    points: 4,
    cost: { "-1": -1, "0": 0, "1": 1, "2": 3 },
    max_low: 2,
    genders: [{ id: "male", label: "남성" }, { id: "female", label: "여성" }],
    traits: { max_positive: 3, max_negative: 3, max_personality: 2 },
  };
  c.scenario.growth = { first: 10, step: 5, xp: { success: 1, partial: 1, miss: 2, merit: 2 }, daily_check_cap: 6 };
  for (const f of Object.values(c.factions)) f.aggression = 0;
  return c;
}

function world(c: Content, choice: { gender?: string; traits?: string[] }, rng = () => 0.5) {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-traits-")), content: c, rngFactory: () => rng });
  return m.create("web", undefined, { name: "윤하", gender: choice.gender ?? "female", abilities: {}, portrait: null, traits: choice.traits ?? [] });
}

const npc = (w: ReturnType<typeof world>, id = "npc_leader") => w.state().characters[id]!;
const player = (w: ReturnType<typeof world>) => w.state().characters[w.state().playerId]!;

describe("트레잇 고르기", () => {
  const s = content().scenario;
  it("긍정은 부정으로 얻은 포인트만큼, 반대끼리는 안 된다, 종류별 최대", () => {
    expect(checkTraits(s, ["quick"]).join()).toContain("모자란다");
    expect(checkTraits(s, ["quick", "frail"])).toEqual([]); // 2 ≤ 2
    expect(checkTraits(s, ["sturdy", "frail"]).join()).toContain("함께 가질 수 없다");
    expect(checkTraits(s, ["warm", "talkative", "flirt"]).join()).toContain("성격 트레잇은 2개까지");
    expect(traitBalance(s, ["quick", "frail", "warm"])).toMatchObject({ spent: 2, earned: 2, personality: 1 });
  });

  it("무작위 트레잇은 언제나 규칙에 맞는다", () => {
    for (let seed = 1; seed < 100; seed++) expect(checkTraits(s, randomTraits(s, createSeededRng(seed)))).toEqual([]);
  });

  it("규칙에 맞지 않으면 세계를 만들지 않는다", () => {
    expect(() => world(content(), { traits: ["quick"] })).toThrow("모자란다");
  });
});

describe("트레잇 효과", () => {
  it("스킬 보정은 판정에, 경험치 배수는 성장에 들어간다", () => {
    const w = world(content(), { traits: ["eagle", "quick", "coward", "ugly"] }, () => 0); // 긍정 3 ≤ 부정 3
    const base = { intent: "살핀다", activity: null, deed: null, target: null, narration_summary: null, for_mission: false };
    const out = w.executeTool("take_action", { ...base, check: { move: "sense_danger", stat: "sense", difficulty: "normal", harm_on_failure: "none", harm_cause: "" } });
    expect(out.ok && out.display.type === "check" && out.display.modifiers.skill).toBe(1);
    expect(player(w).xp).toBe(3); // 실패 2 × 1.5
    expect(xpMultiplier(w.content, player(w))).toBe(1.5);
  });

  it("몸 상태·목격 배수", () => {
    const w = world(content(), { traits: ["frail", "eagle"] });
    expect(bodyTraits(w.content, player(w))).toMatchObject({ disease: 2, infection: 1.5 });
    const base = { privacy: "public" as const, time: 600, noisy: false, senseStat: 0, stealth: null };
    expect(hiddenWitnessChance({ ...base, traitFactor: 1.3 })).toBeCloseTo(hiddenWitnessChance(base) * 1.3);
  });

  it("외모와 끌림: 보통은 외모만큼, 끌리는 이성은 두 배, 끌리는 동성은 질투", () => {
    const w = world(content(), { gender: "female", traits: ["pretty", "frail"] });
    const p = player(w);
    const n = { ...npc(w), gender: "male", traits: [] as string[] };
    expect(looksImpression(w.content, n, p)).toBe(2);
    expect(looksImpression(w.content, { ...n, traits: ["flirt"] }, p)).toBe(4);
    expect(looksImpression(w.content, { ...n, gender: "female", traits: ["flirt"] }, p)).toBe(-2);
    expect(affectionTraitBonus(w.content, { ...n, traits: ["flirt"] }, p)).toBe(1);
    expect(affectionTraitBonus(w.content, { ...n, gender: "female", traits: ["flirt"] }, p)).toBe(-1);
    // 끌리는 이성을 설득하면 쉬워진다 (아름다우면 +2)
    expect(attractionCheckBonus(w.content, p, { ...n, traits: ["flirt"] }, "persuade")).toBe(2);
    expect(attractionCheckBonus(w.content, p, { ...n, traits: ["flirt"] }, "fight")).toBe(0);
    expect(attractionCheckBonus(w.content, p, n, "persuade")).toBe(0);
  });

  it("첫인상: 이성에게 끌리는 NPC를 처음 만나면 외모의 두 배로 호감이 시작된다", () => {
    const c = content();
    c.npcs.npc_leader!.traits = ["flirt"];
    c.npcs.npc_leader!.gender = "male";
    c.roles.role_test!.known_npcs = [];
    const w = world(c, { gender: "female", traits: ["pretty", "frail"] });
    w.executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" });
    expect(w.state().relations.npc_leader?.player?.affection).toBe(4);
  });

  it("GM에게 트레잇 연기 지침과 끌림이 보인다", () => {
    const c = content();
    c.npcs.npc_leader!.traits = ["flirt", "warm"];
    c.npcs.npc_leader!.gender = "male";
    const w = world(c, { gender: "female", traits: ["coward", "eagle"] });
    w.executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" });
    const text = describePlayerState(w.state(), c);
    expect(text).toContain("트레잇 (서술에 반영한다): 겁쟁이(위험 앞에서 망설인다), 매의 눈");
    expect(text).toContain("이성편력(이성 앞에서 허세를 부린다)");
    expect(text).toContain("끌림: 이 인물은 이성인 당신에게 끌린다");
    expect(traitLabels(c, npc(w), { visibleOnly: true })).toEqual(["이성편력", "다정함"]);
  });
});
