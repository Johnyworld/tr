import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";

/** 외부인 찾기 (12-140): 분대원이 담 밖에서 떠도는 사람을 데려오면 무리 인원이 는다 */
const content = loadRealContent();

describe("외부인 찾기", () => {
  it("성공하면 무리 인원이 둘 늘고, 보고가 돌아온다", () => {
    // 주사위를 높게 고정해 성공시킨다
    const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-out-")), content, rngFactory: () => () => 0.99 }).create("mcp", "role_a_squad_leader");
    const f = () => w.state().factions.faction_a!;
    const pop = f().population;
    const r = w.executeTool("squad_order", { members: ["a_byungchul"], task: "outsiders", zone: "old_town" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.runCheat("~time +9h").ok).toBe(true);
    expect(w.state().squadReports.a_byungchul?.text).toContain("데려왔다");
    expect(f().population).toBeGreaterThanOrEqual(pop + 2);
    w.close();
  });
});
