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
    const again = m.open(id);
    expect(again.playerView().portrait).toBe("d_m1");
    again.close();
  });
});
