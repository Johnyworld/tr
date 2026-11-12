import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Content } from "../content/schemas.ts";
import { createSeededRng } from "../rng.ts";
import { TEST_CONTENT } from "../testing.ts";
import { CharacterChoiceError, WorldManager } from "../world/manager.ts";
import { describePlayerState } from "../engine/context.ts";
import { abilitySpend, checkCharacterChoice, creationRules, describeCreationRules, randomAbilityBuy } from "./creation.ts";

function content(): Content {
  const c = structuredClone(TEST_CONTENT);
  c.scenario.creation = {
    points: 4,
    cost: { "-1": -1, "0": 0, "1": 1, "2": 3 },
    max_low: 2,
    genders: [{ id: "male", label: "남성" }, { id: "female", label: "여성" }],
  };
  return c;
}

const base = { name: "한서진", gender: "female", portrait: "p3" };

describe("캐릭터 생성", () => {
  it("포인트 구매: +1은 1, +2는 3, -1은 1을 돌려받는다", () => {
    const s = content().scenario;
    expect(abilitySpend(s, { strength: 2, agility: 1, cool: -1 })).toEqual({ spent: 3, low: 1 });
  });

  it("규칙에 맞지 않으면 문제를 모두 알려 준다", () => {
    const s = content().scenario;
    expect(checkCharacterChoice(s, { ...base, abilities: { strength: 2, agility: 2 } }).join()).toContain("넘게 썼다");
    expect(checkCharacterChoice(s, { ...base, abilities: { strength: 3 } }).join()).toContain("고를 수 있는 값");
    expect(checkCharacterChoice(s, { ...base, abilities: { cool: -1, sense: -1, persuasion: -1 } }).join()).toContain("2개까지");
    expect(checkCharacterChoice(s, { ...base, gender: "robot", abilities: {} }).join()).toContain("성별");
    expect(checkCharacterChoice(s, { ...base, name: " ", abilities: {} }).join()).toContain("이름");
    expect(checkCharacterChoice(s, { ...base, abilities: { strength: 2, agility: 1 } })).toEqual([]);
  });

  it("무작위 배분은 언제나 규칙에 맞고 포인트를 남김없이 쓴다", () => {
    const s = content().scenario;
    for (let seed = 1; seed < 200; seed++) {
      const abilities = randomAbilityBuy(s, createSeededRng(seed));
      expect(checkCharacterChoice(s, { ...base, abilities })).toEqual([]);
      expect(abilitySpend(s, abilities).spent).toBe(4);
    }
  });

  it("고른 대로 새 세계의 주인공이 된다. 슬롯에 성별·초상화가 보인다. 규칙 위반이면 만들지 않는다", () => {
    const c = content();
    const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-create-")), content: c, rngFactory: () => createSeededRng(3) });
    expect(() => m.create("web", undefined, { ...base, abilities: { strength: 2, agility: 2 } })).toThrow(CharacterChoiceError);
    expect(m.listWorlds()).toHaveLength(0);
    const w = m.create("web", undefined, { ...base, abilities: { strength: 2, agility: 1 } });
    const p = w.state().characters[w.state().playerId]!;
    expect(p).toMatchObject({ name: "한서진", gender: "female", portrait: "p3", stats: { strength: 2, agility: 1, cool: 0 } });
    w.saveSnapshot();
    w.close();
    expect(m.listSlots()[0]!.hero).toMatchObject({ name: "한서진", genderLabel: "여성", portrait: "p3" });

    const random = m.create("mcp", undefined, { ...base, abilities: null });
    const stats = random.state().characters[random.state().playerId]!.stats;
    expect(abilitySpend(c.scenario, stats).spent).toBeLessThanOrEqual(4);
    random.close();
  });

  it("NPC 성별이 GM에게 보인다 (이전 세이브처럼 캐릭터에 없으면 콘텐츠에서)", () => {
    const c = content();
    c.npcs.npc_leader!.gender = "male";
    const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-create-")), content: c, rngFactory: () => createSeededRng(3) });
    const w = m.create("web", undefined, { ...base, abilities: {} });
    w.executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" });
    expect(describePlayerState(w.state(), c)).toMatch(/### 강분대 \(npc_leader\) · [^\n]*· 남성/);
    expect(describePlayerState(w.state(), c)).toContain("· 여성");
    w.state().characters.npc_leader!.gender = null;
    expect(describePlayerState(w.state(), c)).toMatch(/### 강분대 \(npc_leader\) · [^\n]*· 남성/);
    w.close();
  });

  it("MCP 안내에 성별·비용·능력·시작 훈련이 나온다", () => {
    const rules = creationRules(content(), "role_test")!;
    const text = describeCreationRules(rules);
    expect(text).toContain("여성(female)");
    expect(text).toContain("+2=3");
    expect(text).toContain("4포인트");
  });
});
