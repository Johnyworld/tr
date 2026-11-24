import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { castCandidates } from "../story/storylets.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { hasPlotRole, shouldImprovise } from "./improvStory.ts";

/** PT29 뒤 사용자 결정 (12-306): 이야기 간격 4~8시간, 즉흥 자리는 쓰인 이야기와 번갈아, 거점 안 분대 명령은 배역에 남김 */
const content = loadRealContent();
const world = (role = "role_a_grunt") => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-306-")), content, rngFactory: () => createSeededRng(7) }).create("mcp", role);

describe("이야기 간격 (12-306)", () => {
  it("4~8시간", () => {
    expect(content.scenario.storylet_pacing.min_gap_hours).toBe(4);
    expect(content.scenario.storylet_pacing.max_gap_hours).toBe(8);
  });
});

describe("즉흥 자리는 쓰인 이야기와 번갈아 (12-306)", () => {
  it("판의 첫 자리, 그리고 즉흥 자리 뒤에는 쓰인 이야기가 한 편 열린 뒤에만 즉흥 자리가 열린다", () => {
    const w = world();
    const filler = Object.values(content.storylets).find((s) => s.repeatable && !s.urgent && !s.essential && !s.bedside && !s.when.mission && !s.fright && !s.ambush && !hasPlotRole(s) && !s.tags.includes("infected"))!;
    const s = structuredClone(w.state());
    s.storyletLog = {};
    s.lastImprovSlotAt = null;
    expect(shouldImprovise(s, content, filler, s.time)).toBe(false);
    s.storyletLog.other = { fired: 1, lastFiredAt: s.time };
    expect(shouldImprovise(s, content, filler, s.time + 60)).toBe(true);
    // 즉흥 자리가 열렸다: 하루가 지나도 쓰인 이야기가 열리기 전에는 다시 열지 않는다
    s.lastImprovSlotAt = s.time + 60;
    const later = s.time + 60 + 24 * 60;
    expect(shouldImprovise(s, content, filler, later)).toBe(false);
    s.storyletLog.another = { fired: 1, lastFiredAt: s.time + 120 };
    expect(shouldImprovise(s, content, filler, later)).toBe(true);
  });
});

describe("분대 명령 거름 (12-306)", () => {
  it("구역을 정해 밖에 보낸 분대원만 배역에서 빠지고, 거점 안 보초·쉬기는 남는다", () => {
    const w = world("role_a_squad_leader");
    const mates = castCandidates(w.state(), content, { faction: "own", enter: false } as never);
    expect(mates.length).toBeGreaterThanOrEqual(2);
    const tasks = content.scenario.command!.squad_tasks;
    const inside = tasks.find((t) => !t.needs_zone && t.kind !== "follow")!;
    const outside = tasks.find((t) => t.needs_zone)!;
    const zone = w.state().playerZone!;
    w.ctx().store.append({ type: "squad_order_given", npcId: mates[0]!, task: inside.id, zone, until: w.state().time + 600 });
    w.ctx().store.append({ type: "squad_order_given", npcId: mates[1]!, task: outside.id, zone, until: w.state().time + 600 });
    const after = castCandidates(w.state(), content, { faction: "own", enter: false } as never);
    expect(after).toContain(mates[0]);
    expect(after).not.toContain(mates[1]);
  });
});
