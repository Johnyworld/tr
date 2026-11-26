import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { gearModifiers } from "./gear.ts";
import { personNoticeBonus } from "../rules/encounter.ts";

const content = loadRealContent();
const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-range-")), content, rngFactory: () => createSeededRng(3) }).create("mcp", "role_a_grunt");
const me = w.state().characters[w.state().playerId]!;
const armed = (weapon: string, traits: string[]) => ({ ...me, traits, inventory: { ...me.inventory, [weapon]: 1 }, equipped: { ...me.equipped, weapon } });
const far = (weapon: string, traits: string[]) => gearModifiers(content, armed(weapon, traits), "shoot", "far", w.state()).penalty;

describe("저격수·서툰 조준: 먼 거리 사격 보정 (트레잇 range, 2026-11-26)", () => {
  it("저격수는 먼 거리에서 +1, 서툰 조준은 -1. 무기의 거리 보정에 더한다 (상한 밖)", () => {
    expect(far("old_rifle", [])).toBe(0);
    expect(far("old_rifle", ["marksman"])).toBe(1);
    expect(far("old_rifle", ["poor_aim"])).toBe(-1);
    const parts = gearModifiers(content, armed("old_rifle", ["marksman"]), "shoot", "far", w.state()).penaltyParts;
    expect(parts).toContainEqual({ label: "저격수", value: 1 });
  });

  it("가까운 거리에는 붙지 않는다", () => {
    expect(gearModifiers(content, armed("old_rifle", ["marksman"]), "shoot", "near", w.state()).penalty).toBe(0);
  });
});

describe("매의 눈·둔한 감각의 경계 보정은 부대 알아채기에도 든다", () => {
  it("트레잇의 경계 보정을 더한다 (빠져 있던 것)", () => {
    // 경계 1에 감각 0인 사람 (음수 스킬은 0으로 셈한다)
    const watcher = { ...me, stats: { ...me.stats, senses: 0, nerve: 0 }, skills: { ...me.skills, sense_danger: 1 } };
    const base = personNoticeBonus(content, { ...watcher, traits: [] });
    expect(personNoticeBonus(content, { ...watcher, traits: ["eagle_eye"] })).toBe(base + 1);
    expect(personNoticeBonus(content, { ...watcher, traits: ["dull_senses"] })).toBe(base - 1);
  });
});
