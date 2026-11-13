import { describe, expect, it } from "vitest";
import { TEST_CONTENT } from "../testing.ts";
import { GameWorld } from "../world/world.ts";
import { InMemoryRepository } from "../persistence/repository.ts";
import { createWorldEvent } from "./state.ts";
import { createSeededRng } from "../rng.ts";
import { npcZoneAt } from "./whereabouts.ts";
import { MINUTES_PER_DAY } from "../rules/time.ts";

describe("무리 없는 인물과 떠도는 인물 (기획서 7.11)", () => {
  it("떠도는 인물은 날마다 roams 중 한 곳에 있고, 같은 날이면 늘 같은 곳이다", () => {
    const npc = { id: "lone_peddler", zone: undefined, roams: ["old_town", "riverside", "e_market"] };
    const seen = new Set<string>();
    for (let d = 0; d < 9; d++) {
      const z = npcZoneAt(npc, d * MINUTES_PER_DAY + 60);
      expect(npc.roams).toContain(z);
      expect(npcZoneAt(npc, d * MINUTES_PER_DAY + 600)).toBe(z);
      seen.add(z!);
    }
    expect(seen.size).toBe(3);
    expect(npcZoneAt({ id: "x", zone: "a_base" }, 0)).toBe("a_base");
  });

  it("무리 없는 이름 있는 인물은 무리가 빈 채로 세계에 들어온다", () => {
    const content = structuredClone(TEST_CONTENT);
    const base = Object.values(content.npcs)[0]!;
    content.npcs.lone_test = { ...structuredClone(base), id: "lone_test", name: "떠돌이 시험", faction: null, rank: "loner" };
    const repo = new InMemoryRepository();
    const world = new GameWorld({ content, repo, mode: "mcp", rng: createSeededRng(1) });
    repo.append(createWorldEvent(content, "role_test", "world_test"));
    expect(world.state().characters.lone_test?.factionId).toBe("");
  });
});
