import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { WorldManager } from "../world/manager.ts";
import { loadRealContent } from "../testing.ts";

/** 얼굴 고르기 기회 (12-139): 얼굴 없이 만든 주인공은 시트에서 얼굴을 한 번 고른다 */
const content = loadRealContent();
const manager = () => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-portrait-")), content, rngFactory: () => createSeededRng(1) });
const open = (portrait: string | null, gender = "female") =>
  manager().create("mcp", "role_a_grunt", { name: "서진", gender, abilities: null, portrait, traits: [] });

describe("얼굴 고르기 기회", () => {
  it("얼굴이 없으면 그 성별의 얼굴을 보이고, 하나를 고르면 정해지며 다시 고를 수 없다", () => {
    const w = open(null);
    const choices = w.playerView().portraitChoices;
    expect(choices?.flatMap((s) => s.faces)).toContain("d_f1");
    expect(choices?.flatMap((s) => s.faces)).not.toContain("d_m1");
    expect(w.choosePortrait("d_m1").ok).toBe(false); // 다른 성별
    expect(w.choosePortrait("../x").ok).toBe(false);
    expect(w.choosePortrait("d_f1")).toEqual({ ok: true });
    expect(w.playerView().portrait).toBe("d_f1");
    expect(w.playerView().portraitChoices).toBeNull();
    expect(w.choosePortrait("d_f2").ok).toBe(false); // 한 번만
    w.close();
  });

  it("이미 얼굴이 있으면 고를 기회가 없다", () => {
    const w = open("d_f1");
    expect(w.playerView().portraitChoices).toBeNull();
    expect(w.choosePortrait("d_f2").ok).toBe(false);
    w.close();
  });

  it("고른 얼굴은 세이브에 남는다", () => {
    const m = manager();
    const w = m.create("mcp", "role_a_grunt", { name: "서진", gender: "male", abilities: null, portrait: null, traits: [] });
    const id = w.id;
    expect(w.choosePortrait("d_m1").ok).toBe(true);
    w.close();
    const again = m.open(id, "mcp");
    expect(again.playerView().portrait).toBe("d_m1");
    again.close();
  });
});

/** 장비 착용·해제 (12-139): 상태 화면에서 GM의 equip tool과 같은 규칙으로 */
describe("화면에서 장비 착용·해제", () => {
  it("소지품의 무기·방어구에 자리(wear)가 붙고, 들고 벗을 수 있다", () => {
    const w = open(null);
    w.runCheat("~give leather_jacket");
    const jacket = w.playerView().inventory.find((i) => i.id === "leather_jacket");
    expect(jacket?.wear).toBeTruthy();
    expect(w.equip({ itemId: "leather_jacket" }).ok).toBe(true);
    const worn = w.playerView().gear!.armor.find((g) => g.id === "leather_jacket");
    expect(worn?.slot).toBe(jacket!.wear);
    expect(w.playerView().inventory.some((i) => i.id === "leather_jacket")).toBe(false);
    expect(w.equip({ slot: worn!.slot }).ok).toBe(true);
    expect(w.playerView().gear!.armor.some((g) => g.id === "leather_jacket")).toBe(false);
    expect(w.equip({ itemId: "no_such_item" }).ok).toBe(false);
    expect(w.equip({}).ok).toBe(false);
    w.close();
  });
});

/** 스킬 올리기 (12-139): 상태 화면에서 GM의 learn_skill tool과 같은 규칙으로 */
describe("화면에서 스킬 올리기", () => {
  it("레벨업이 있으면 스킬을 한 단계 올리고, 없으면 못 올린다", () => {
    const w = open(null);
    // 누구나 하는 일(생존)로 본다. 전문 기술은 배우기 전엔 올릴 수 없다 (4.2.1)
    w.ctx().store.append({ type: "skill_trained", characterId: w.state().playerId, skill: "survival", to: -1 });
    expect(w.learnSkill({ skill: "survival" }).ok).toBe(false); // 레벨업 없음
    w.runCheat("~xp 1000");
    const before = w.playerView();
    expect(before.growth!.skillPoints).toBeGreaterThan(0);
    expect(before.growth!.skillMax).toBeGreaterThan(0);
    expect(before.skills.find((s) => s.id === "survival")?.value).toBe(-1);
    expect(w.learnSkill({ skill: "survival" }).ok).toBe(true);
    const after = w.playerView();
    expect(after.skills.find((s) => s.id === "survival")?.value).toBe(0);
    expect(after.growth!.skillPoints).toBe(before.growth!.skillPoints - 1); // -1→0은 1점
    expect(w.learnSkill({ skill: "no_such_skill" }).ok).toBe(false);
    expect(w.learnSkill({}).ok).toBe(false);
    w.close();
  });
});
