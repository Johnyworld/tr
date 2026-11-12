import { existsSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { WorldLockedError, lockPathOf } from "../persistence/lock.ts";
import { SqliteRepository } from "../persistence/sqlite.ts";
import { createTestWorld, TEST_CONTENT, TEST_SCENARIO } from "../testing.ts";
import { WorldManager } from "./manager.ts";

const NO_ACTION = { check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false };

describe("GameWorld", () => {
  it("MCP 모드의 take_action은 플레이어 의도와 서술 요약을 기록에 남긴다", () => {
    const world = createTestWorld("mcp");
    world.executeTool("take_action", { ...NO_ACTION, intent: "주변을 살핀다", narration_summary: "새벽 막사에서 깨어났다." });
    expect(world.transcript().slice(0, 2)).toEqual([
      { kind: "note", text: "새벽 막사에서 깨어났다." },
      { kind: "player", text: "주변을 살핀다" },
    ]);
    expect(world.summaries({ kind: "turn" })).toMatchObject([{ text: "새벽 막사에서 깨어났다.", mode: "mcp" }]);
  });

  it("웹 앱 모드에서는 플레이어 입력을 GM 루프가 남기므로 의도를 따로 기록하지 않는다", () => {
    const world = createTestWorld("web");
    world.executeTool("take_action", { ...NO_ACTION, intent: "주변을 살핀다" });
    expect(world.transcript().some((e) => e.kind === "player")).toBe(false);
  });

  it("recap: 최근 장면 요약과 그 뒤의 턴 요약을 모은다", () => {
    const world = createTestWorld("mcp");
    expect(world.recap()).toBe("");
    world.recordSummary("turn", "옛 일");
    world.executeTool("take_action", { ...NO_ACTION, intent: "걷는다" });
    world.recordSummary("scene", "막사에서 분대장을 만났다.");
    world.executeTool("take_action", { ...NO_ACTION, intent: "걷는다" });
    world.recordSummary("turn", "식당으로 갔다.");
    const recap = world.recap();
    expect(recap).toContain("막사에서 분대장을 만났다.");
    expect(recap).toContain("식당으로 갔다.");
    expect(recap).not.toContain("옛 일");
  });

  it("GM 지침은 시나리오 파일에서 읽고, MCP 모드에만 진행 규칙을 붙인다", () => {
    expect(createTestWorld("web").guide()).not.toContain("record_turn_summary");
    expect(createTestWorld("mcp").guide()).toContain("record_turn_summary");
  });
});

describe("WorldManager", () => {
  function manager(savesDir = mkdtempSync(join(tmpdir(), "trpg-saves-"))) {
    return new WorldManager({ savesDir, content: TEST_CONTENT, rngFactory: () => createSeededRng(3) });
  }

  it("세계를 만들고 목록에 보인다. 다시 열면 이어진다", () => {
    const m = manager();
    const world = m.create("web");
    world.executeTool("take_action", { ...NO_ACTION, intent: "걷는다" });
    world.saveSnapshot();
    const id = world.id;
    world.close();

    expect(m.listWorlds()).toMatchObject([{ id, scenarioId: TEST_SCENARIO.id, playerName: "신병", turn: 1, lockedBy: null }]);
    const reopened = m.open(id, "mcp");
    expect(reopened.state().turn).toBe(1);
    reopened.close();
  });

  it("열려 있는 세계는 다시 열 수 없고, 닫으면 열 수 있다", () => {
    const m = manager();
    const world = m.create("web");
    expect(() => m.open(world.id, "mcp")).toThrow(WorldLockedError);
    expect(m.listWorlds()[0]?.lockedBy).toMatchObject({ mode: "web", pid: process.pid });
    world.close();
    expect(existsSync(lockPathOf(world.path!))).toBe(false);
    m.open(world.id, "mcp").close();
  });

  it("죽은 프로세스가 남긴 잠금은 해제하고 연다", () => {
    const m = manager();
    const world = m.create("web");
    const { id, path } = world;
    world.close();
    writeFileSync(lockPathOf(path!), JSON.stringify({ pid: 2 ** 22 + 12345, mode: "mcp", startedAt: "x" }));
    m.open(id, "web").close();
  });

  it("openLatest: 가장 최근 세계를 열고, 없으면 만든다", () => {
    const m = manager();
    const first = m.openLatest("web");
    const id = first.id;
    first.close();
    const again = m.openLatest("mcp");
    expect(again.id).toBe(id);
    again.close();
  });

  it("예전 구조의 saves/world.db를 saves/worlds/로 옮긴다", () => {
    const savesDir = mkdtempSync(join(tmpdir(), "trpg-saves-"));
    const old = manager(savesDir).create("web");
    old.close();
    renameSync(old.path!, join(savesDir, "world.db"));
    const m = manager(savesDir);
    expect(existsSync(join(savesDir, "world.db"))).toBe(false);
    expect(m.listWorlds()).toHaveLength(1);
  });

  it("다른 시나리오의 세계는 openLatest가 건드리지 않는다", () => {
    const savesDir = mkdtempSync(join(tmpdir(), "trpg-saves-"));
    const other = SqliteRepository.open(join(savesDir, "worlds", "other.db"), { ...TEST_SCENARIO, id: "other" });
    other.close();
    const m = manager(savesDir);
    const world = m.openLatest("web");
    expect(world.id).not.toBe("other");
    world.close();
    expect(m.listWorlds().map((w) => w.scenarioId).sort()).toEqual(["other", TEST_SCENARIO.id].sort());
  });
});

describe("narration_summary", () => {
  it("웹 앱 모드에서는 무시한다 (GM 루프가 서술을 직접 저장)", () => {
    const world = createTestWorld("web");
    world.executeTool("take_action", { ...NO_ACTION, intent: "걷는다", narration_summary: "중복 요약" });
    expect(world.transcript().some((e) => e.kind === "note")).toBe(false);
    expect(world.summaries()).toEqual([]);
  });
});
