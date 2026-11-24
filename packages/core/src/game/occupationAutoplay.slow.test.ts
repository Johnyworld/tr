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
      // 직분 이야기는 첫 주인공이 살아 있는 동안만 열린다. 시드에 따라 일찍 죽거나 거점 밖을 떠돌면 못 볼 수 있어 네 판 중 하나에서 본다 (이야기 간격 6~12시간, 플레이 테스트 12.
      // 12-238: 배급을 우리 땅에서만 받게 하자 동선이 바뀌어 두 판 모두에서 빠졌다. 바뀌기 전에도 두 판 중 한 판에 하나뿐이었다)
      const tag = `occ_${occupation}`;
      let seen = false;
      // 이동 기획(12-287) 뒤로는 이야기가 주인공이 있는 자리에서만 열려 여섯 판 중 하나에서 본다 (요리사: 시드 27·33에서 열림)
      // 12-300: 장소 종류 뒤 길이 바뀌어 처음 여덟 판에서 빠졌다 (요리사 이야기가 열리는 자리는 그대로이거나 넓어졌고, 바꾸기 전에도 여덟 판 중 두세 판).
      // 판을 늘리되 한 번 보면 멈춘다
      for (const seed of [3, 9, 15, 21, 27, 33, 39, 45, 51, 57, 63, 69, 75, 81, 87, 93]) {
        if (seen) break;
        const w = open({ ...cook, faction, rank, occupation, location });
        const stats = autoplay(w, w.content, createSeededRng(seed), 500);
        w.close();
        expect(stats.errors).toEqual([]);
        seen ||= Object.keys(stats.storyletsFired).some((id) => content.storylets[id]?.tags.includes(tag));
      }
      expect(seen).toBe(true);
    }, 300_000); // 판이 많아(한 번 보면 멈춤) 다른 느린 테스트와 함께 돌면 오래 걸린다. 판 여섯이라 다른 느린 테스트와 함께 돌면 60초를 넘긴다 (12-241)
  }
});
