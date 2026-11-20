import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { autoplay } from "../sim/autoplay.ts";
import { WorldManager } from "../world/manager.ts";
import { buildCustomRole, type CustomStartInput } from "./customStart.ts";
import { loadRealContent } from "../testing.ts";

/** 직분마다 실제 콘텐츠로 자동 플레이를 돌려 직분 이야기가 열리는지 본다 (기획서 12.6). 느려서 `pnpm test:slow`에서만 돈다 */
const content = loadRealContent();
const cook: CustomStartInput = {
  faction: "faction_a",
  rank: "grunt",
  occupation: "cook",
  title: "청솔형제단 요리사",
  location: "a_base",
  kit: "trader",
  skills: { persuade: 1 },
  age: 34,
  opening: "새벽 식당 천막, 솥에 물이 끓는다.",
  background: [],
};
const open = (input: CustomStartInput) => {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-occ-")), content, rngFactory: () => createSeededRng(5) });
  const role = buildCustomRole(content, input);
  return m.create("mcp", undefined, undefined, undefined, { role, background: input.background, history: input.history ?? [] });
};

describe("직분 자동 플레이", () => {
  for (const [occupation, faction, rank] of [
    ["cook", "faction_c", "grunt"],
    ["mechanic", "faction_e", "staff"],
    ["trader", null, "loner"],
  ] as const) {
    it(`${occupation}: 오류 없이 돌고, 직분 이야기가 열린다`, () => {
      const location = faction ? Object.values(content.locations).find((l) => l.owner === faction && l.kind === "base")!.id : "old_town";
      // 직분 이야기는 첫 주인공이 살아 있는 동안만 열린다. 시드에 따라 일찍 죽으면 못 볼 수 있어 두 판 중 하나에서 본다 (이야기 간격 6~12시간, 플레이 테스트 12)
      const tag = `occ_${occupation}`;
      let seen = false;
      for (const seed of [3, 9]) {
        const w = open({ ...cook, faction, rank, occupation, location });
        const stats = autoplay(w, w.content, createSeededRng(seed), 500);
        w.close();
        expect(stats.errors).toEqual([]);
        seen ||= Object.keys(stats.storyletsFired).some((id) => content.storylets[id]?.tags.includes(tag));
      }
      expect(seen).toBe(true);
    }, 60_000);
  }
});
