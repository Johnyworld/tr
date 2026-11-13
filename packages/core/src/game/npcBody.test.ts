import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { createSeededRng } from "../rng.ts";
import { eligibleStorylets } from "../story/storylets.ts";
import { WorldManager } from "../world/manager.ts";

const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const sleep = { intent: "잔다", check: null, activity: { kind: "sleep", until: "morning" }, deed: null, target: null, narration_summary: null, for_mission: false };

function medicWorld() {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-npcbody-")), content, rngFactory: () => createSeededRng(6) });
  const w = m.create("mcp", "role_d_medic");
  w.ctx().store.append({ type: "flag_set", characterId: "player", flag: "d_sori_secret" });
  return w;
}
const ids = (w: ReturnType<typeof medicWorld>, at: number) => eligibleStorylets(w.state(), w.content, at).map((s) => s.id);
const dawnOf = (w: ReturnType<typeof medicWorld>, day: number) => (day - 1) * 1440 + 5 * 60 + 30 + (w.state().time - w.state().time); // 그날 새벽
const morningOf = (day: number) => (day - 1) * 1440 + 8 * 60;

describe("NPC의 몸 (기획서 7.7)", () => {
  it("감염된 인물은 하루에 한 단계씩 나빠지고, 열이 오르면 '새벽의 열'이 열린다", () => {
    const w = medicWorld();
    w.ctx().store.append({ type: "condition_changed", targetId: "d_sori", track: "infection", from: "clean", to: "incubating", fatal: false, by: "test", cause: "긁힘", day: 1, harmTrack: false });
    const day0 = Math.floor(w.state().time / 1440) + 1;
    for (let i = 0; i < 10 && Math.floor(w.state().time / 1440) + 1 < day0 + 1; i++) w.executeTool("take_action", sleep);
    expect(w.state().characters.d_sori!.conditions.infection).toBe("fever");
    expect(ids(w, dawnOf(w, 5))).toContain("d_sori_fever");
    expect(ids(w, morningOf(7))).not.toContain("d_sori_clear");
    w.close();
  });

  it("감염되지 않았으면 열 대신 '아물어 가는 손목'이 열린다", () => {
    const w = medicWorld();
    expect(ids(w, dawnOf(w, 5))).not.toContain("d_sori_fever");
    expect(ids(w, morningOf(7))).toContain("d_sori_clear");
    w.close();
  });
});
