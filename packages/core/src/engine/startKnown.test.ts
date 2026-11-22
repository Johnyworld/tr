import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { buildPlayerView } from "../views/player.ts";
import { WorldManager } from "../world/manager.ts";
import { effectiveSkill } from "./traits.ts";
import { loadRealContent } from "../testing.ts";

const content = loadRealContent();
const manager = () => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-known-")), content, rngFactory: () => createSeededRng(2) });

describe("시작할 때 원래 알던 사이", () => {
  it("튜토리얼의 가족은 장면 밖에 있어도 주인공이 그 태도(깊은 사이)를 안다", () => {
    const w = manager().create("mcp", "role_t_visitor");
    const s = w.state();
    const family = (s as unknown as { family: string[] }).family;
    expect(family.length).toBeGreaterThan(0);
    for (const id of family) {
      expect(s.scene.present).not.toContain(id);
      expect(s.perceived[id]).toEqual({ trust: 10, affection: 10, respect: 8 });
    }
  });
});

describe("트레잇이 주는 스킬", () => {
  it("판정 밖(시트·지식 문턱)에서도 트레잇 보정이 더해진다", () => {
    const w = manager().create("mcp", "role_t_visitor");
    const me = w.state().characters[w.state().playerId]!;
    const base = effectiveSkill(content, me, "sense_danger");
    me.traits = [...me.traits, "eagle_eye"];
    expect(effectiveSkill(content, me, "sense_danger")).toBe(base + 1);
    const view = buildPlayerView(w.state(), content);
    expect(view.skills.find((x) => x.id === "sense_danger")?.value ?? -1).toBe(base + 1 >= 0 ? base + 1 : -1);
  });
});
