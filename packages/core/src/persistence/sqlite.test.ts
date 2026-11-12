import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createWorldEvent } from "../game/state.ts";
import { TEST_CONTENT, TEST_SCENARIO } from "../testing.ts";
import { archiveSave, SaveFormatError, SqliteRepository } from "./sqlite.ts";

const world = () => createWorldEvent(TEST_CONTENT, "role_test", "world_test");

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), "trpg-save-")), "world.db");
}

function playSomeEvents(repo: SqliteRepository) {
  repo.append(world());
  repo.append({ type: "turn_started", turn: 1, input: "물병을 내려놓는다" });
  repo.append({ type: "item_transferred", from: "player", to: "scene", itemId: "water_bottle", quantity: 1 });
}

describe("SqliteRepository", () => {
  it("다시 열면 이벤트로 상태를 복원한다", () => {
    const path = tempPath();
    const repo = SqliteRepository.open(path, TEST_SCENARIO);
    expect(repo.hasWorld()).toBe(false);
    playSomeEvents(repo);
    repo.appendTranscript([{ kind: "player", text: "물병을 내려놓는다", prompt: "p" }]);
    const before = repo.getState();
    repo.close();

    const reopened = SqliteRepository.open(path, TEST_SCENARIO);
    expect(reopened.hasWorld()).toBe(true);
    expect(reopened.getState()).toEqual(before);
    expect(reopened.getState().scene.items.water_bottle).toBe(1);
    expect(reopened.events().map((e) => e.type)).toEqual(["world_created", "turn_started", "item_transferred"]);
    expect(reopened.transcript()).toEqual([{ kind: "player", text: "물병을 내려놓는다", prompt: "p" }]);
    reopened.close();
  });

  it("스냅샷 이후의 이벤트만 다시 적용한다", () => {
    const path = tempPath();
    const repo = SqliteRepository.open(path, TEST_SCENARIO);
    playSomeEvents(repo);
    repo.saveSnapshot();
    repo.append({ type: "turn_started", turn: 2, input: "줍는다" });
    repo.append({ type: "item_transferred", from: "scene", to: "player", itemId: "water_bottle", quantity: 1 });
    const before = repo.getState();
    repo.close();

    const reopened = SqliteRepository.open(path, TEST_SCENARIO);
    expect(reopened.getState()).toEqual(before);
    expect(reopened.getState().turn).toBe(2);
    reopened.close();
  });

  it("적용할 수 없는 이벤트는 기록하지 않는다", () => {
    const repo = SqliteRepository.open(":memory:", TEST_SCENARIO);
    expect(() =>
      repo.append({ type: "turn_started", turn: 1, input: "" }), // 세계가 만들어지기 전
    ).toThrow();
    repo.append(world());
    expect(() =>
      repo.append({ type: "item_transferred", from: "player", to: "scene", itemId: "water_bottle", quantity: 5 }),
    ).toThrow("수량 부족");
    expect(repo.events()).toHaveLength(1);
    repo.close();
  });

  it("이벤트와 대화 기록은 수정·삭제할 수 없다 (append-only)", () => {
    const path = tempPath();
    const repo = SqliteRepository.open(path, TEST_SCENARIO);
    playSomeEvents(repo);
    repo.appendTranscript([{ kind: "gm", text: "서술" }]);
    repo.close();

    const raw = new Database(path);
    expect(() => raw.prepare("DELETE FROM events").run()).toThrow("append-only");
    expect(() => raw.prepare("UPDATE events SET type = 'x'").run()).toThrow("append-only");
    expect(() => raw.prepare("DELETE FROM transcript").run()).toThrow("append-only");
    raw.close();
  });

  it("세이브 형식 버전이 다르면 열지 않는다", () => {
    const path = tempPath();
    SqliteRepository.open(path, TEST_SCENARIO).close();
    const raw = new Database(path);
    raw.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run();
    raw.close();
    expect(() => SqliteRepository.open(path, TEST_SCENARIO)).toThrow(SaveFormatError);
  });

  it("새 게임을 시작하면 이전 세이브를 지우지 않고 보관한다", () => {
    const path = tempPath();
    const repo = SqliteRepository.open(path, TEST_SCENARIO);
    playSomeEvents(repo);
    repo.close();

    const archived = archiveSave(path, new Date("2026-11-12T04:05:06Z"));
    expect(archived).toMatch(/archive\/world-2026-11-12T04-05-06\.db$/);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(join(path, "..", "archive"))).toContain("world-2026-11-12T04-05-06.db");

    const old = SqliteRepository.open(archived!, TEST_SCENARIO);
    expect(old.events()).toHaveLength(3);
    old.close();
    expect(SqliteRepository.open(path, TEST_SCENARIO).hasWorld()).toBe(false);
  });
});

describe("시나리오", () => {
  it("다른 시나리오의 세이브는 열지 않는다", () => {
    const path = tempPath();
    SqliteRepository.open(path, TEST_SCENARIO).close();
    expect(() => SqliteRepository.open(path, { ...TEST_SCENARIO, id: "other" })).toThrow(SaveFormatError);
  });

  it("시나리오에 없는 능력치가 든 이벤트는 기록하지 않는다", () => {
    const repo = SqliteRepository.open(":memory:", TEST_SCENARIO);
    const event = world();
    if (event.type !== "world_created") throw new Error("unreachable");
    expect(() => repo.append({ ...event, player: { ...event.player, stats: { ...event.player.stats, luck: 3 } } })).toThrow();
    repo.close();
  });
});
