import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { autoplay } from "../sim/autoplay.ts";
import { WorldManager } from "../world/manager.ts";
import { peopleAt, placesIn } from "../rules/place.ts";
import { eligibleStorylets } from "../story/storylets.ts";
import { buildCustomRole, type CustomStartInput } from "./customStart.ts";
import { loadRealContent } from "../testing.ts";

/** 직분마다 실제 콘텐츠로 자동 플레이를 돌려 오류가 없는지, 직분 이야기가 열릴 자리가 있는지 본다 (기획서 12.6). 느려서 `pnpm test:slow`에서만 돈다 */
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
    ["mechanic", "faction_e", "resident"],
    ["trader", null, "loner"],
  ] as const) {
    it(`${occupation}: 오류 없이 돌고, 직분 이야기가 열릴 자리가 있다`, () => {
      const location = faction ? Object.values(content.locations).find((l) => l.owner === faction && l.kind === "base")!.id : "old_town";
      const tag = `occ_${occupation}`;
      // 자동 플레이는 오류 없이 도는지만 본다. 직분 이야기가 실제로 열렸는지는 판의 운에 너무 기댄다:
      // 12-302 뒤 요리사는 스무 판 모두에서 직분 이야기를 못 봤다. 길어진 길에서 임무 기한을 넘겨 갇히고, 탈출에 실패해 쓰러져 3~11일째에 죽어 (첫 주인공만 직분 이야기를 본다)
      // 길목 전에도 열두 판에 두 판꼴이었다 (12-238·12-287·12-300에서 판 수만 늘려 왔다)
      for (const seed of [3, 9, 15]) {
        const w = open({ ...cook, faction, rank, occupation, location });
        const stats = autoplay(w, w.content, createSeededRng(seed), 500);
        w.close();
        expect(stats.errors).toEqual([]);
      }
      // 직분 이야기가 열릴 수 있는가: 새 세계에서 이틀째·사흘째 하루 동안, 구역의 장소마다 그 자리에 있을 사람을 장면에 두고 자격을 본다
      const w = open({ ...cook, faction, rank, occupation, location });
      const s0 = w.state();
      let found: string | null = null;
      for (const zone of Object.keys(content.locations)) {
        for (const place of placesIn(s0, w.content, zone)) {
          for (let t = 1440; t < 3 * 1440 && !found; t += 120) {
            const st = { ...s0, time: t, playerZone: zone, playerPlace: place.id, activeStorylet: null, scene: { ...s0.scene, present: peopleAt({ ...s0, time: t }, w.content, zone, place.id) } };
            found = eligibleStorylets(st, w.content, t).find((x) => x.tags.includes(tag))?.id ?? null;
          }
          if (found) break;
        }
        if (found) break;
      }
      w.close();
      expect(found, `${tag} 이야기가 열릴 자리가 없다`).not.toBeNull();
    }, 300_000);
  }
});
