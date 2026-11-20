import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { levelForXp } from "../engine/growth.ts";
import { createSeededRng } from "../rng.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { upgradeSkills } from "./state.ts";

/** 세이브 80 (4.2.1): 스킬 개편 이전 세이브 옮기기 */
const content = loadRealContent();
const s = content.scenario;

describe("upgradeSkills", () => {
  it("과거 배경에 없던 최저값 전문 기술은 못 함으로, 나머지는 그대로, 레벨은 새 곡선으로 다시 센다", () => {
    const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-upskill-")), content, rngFactory: () => createSeededRng(1) }).create("mcp", "role_t_visitor", {
      name: "서진",
      gender: "female",
      abilities: null,
      portrait: null,
      traits: [],
      past: "police",
    } as never);
    const old = structuredClone(w.state());
    w.close();
    const me = old.characters[old.playerId]!;
    expect(me.past?.id).toBe("police");
    me.skills.surgery = -1; // 옛 기본값으로 적혀 있던 전문 기술 → 지운다
    me.skills.mechanics = 1; // 올려 둔 전문 기술 → 그대로
    me.skills.fight = 1; // 누구나 하는 일 → 그대로
    me.xp = 200;
    me.level = 2;
    me.skillPoints = 1;
    const next = upgradeSkills(old, s, (xp) => levelForXp(s, xp));
    const up = next.characters[next.playerId]!;
    expect(up.skills.surgery).toBeUndefined();
    expect(up.skills).toMatchObject({ mechanics: 1, fight: 1, shoot: me.skills.shoot });
    const level = levelForXp(s, 200);
    expect(up.level).toBe(level);
    expect(up.skillPoints).toBe(Math.max(0, 1 + level - 2));
    // 원래 상태는 고치지 않는다
    expect(me.skills.surgery).toBe(-1);
  });
});
