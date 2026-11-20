import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { WorldManager } from "../world/manager.ts";
import { buildCustomRole } from "../game/customStart.ts";
import { scavenge, scavengeParts } from "./scavenge.ts";
import { loadRealContent } from "../testing.ts";

const content = loadRealContent();

function worldAt(location: string) {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-scav-")), content, rngFactory: () => createSeededRng(5) });
  const role = buildCustomRole(content, {
    faction: null, rank: "loner", title: "떠돌이", location, kit: "wanderer", skills: { scavenge: 1 }, age: 30, opening: "폐허에서 눈을 뜬다.", background: [],
  });
  return m.create("mcp", undefined, { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] }, undefined, { role, background: [] });
}

describe("수색으로 물건 찾기", () => {
  it("성공이면 구역의 표에서 찾아 소지품에 넣고, 같은 날 다시 뒤지면 판정이 어려워진다 (12-220)", () => {
    const w = worldAt("old_town");
    const count = () => Object.values(w.state().characters.player!.inventory).reduce((n, q) => n + q, 0);
    const before = count();
    expect(scavengeParts(w.ctx()).some((p) => p.label === "다시 뒤짐")).toBe(false);
    const first = scavenge({ ...w.ctx(), rng: () => 0.4 }, "success");
    expect(count()).toBeGreaterThan(before);
    expect(first.lines[0]).toContain("찾아 챙겼다");
    expect(scavengeParts(w.ctx())).toContainEqual({ label: "다시 뒤짐", value: -1 });
    const second = scavenge({ ...w.ctx(), rng: () => 0.4 }, "partial");
    expect(second.lines[0]).toContain("이미 뒤진 곳");
    w.close();
  });

  it("실패면 아무것도 없고, 표가 없는 곳은 나올 것이 없다고 알린다", () => {
    const w = worldAt("riverside");
    expect(scavenge({ ...w.ctx(), rng: () => 0 }, "miss").lines[0]).toContain("찾지 못했다");
    w.close();
  });

  it("take_action의 search 활동이 수색을 굴린다", () => {
    const w = worldAt("hospital_ruins");
    const r = w.executeTool("take_action", {
      intent: "약제실 선반을 뒤진다", check: { move: "scavenge", stat: "senses", difficulty: "normal", harm_on_failure: "none", harm_cause: "" },
      activity: { kind: "search", until: null }, deed: null, target: null, narration_summary: null, for_mission: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resultText).toMatch(/찾아 챙겼다|찾지 못했다/);
    expect(w.state().zoneSearches.hospital_ruins?.count).toBe(1);
    w.close();
  });
});
