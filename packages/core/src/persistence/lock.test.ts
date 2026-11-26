import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock, isLockHeld, processStartedAt, readLock, WorldLockedError, type LockInfo } from "./lock.ts";

const lockOf = (pid: number, startedAt: string): LockInfo => ({ pid, mode: "mcp", startedAt });

describe("세계 잠금: 남은 잠금 가리기", () => {
  it("살아 있고 잠금보다 먼저 뜬 프로세스면 쥐고 있다", () => {
    const at = new Date("2026-11-21T16:19:14Z");
    expect(isLockHeld(lockOf(process.pid, at.toISOString()), () => new Date(at.getTime() - 5000))).toBe(true);
  });

  it("번호가 살아 있어도 잠금을 적은 뒤에 뜬 프로세스면 남은 잠금이다 (번호만 물려받았다)", () => {
    expect(isLockHeld(lockOf(process.pid, "2026-11-21T16:19:14Z"), () => new Date("2026-11-26T10:56:08Z"))).toBe(false);
  });

  it("초 단위 시작 시각은 조금 봐준다", () => {
    const at = new Date("2026-11-21T16:19:14.400Z");
    expect(isLockHeld(lockOf(process.pid, at.toISOString()), () => new Date(at.getTime() + 600))).toBe(true);
  });

  it("죽은 프로세스는 쥐고 있지 않다, 시작 시각을 못 읽으면 살아 있는지만 본다", () => {
    expect(isLockHeld(lockOf(2 ** 22 + 12345, new Date().toISOString()), () => null)).toBe(false);
    expect(isLockHeld(lockOf(process.pid, "2020-01-01T00:00:00Z"), () => null)).toBe(true);
  });

  it("지금 프로세스의 시작 시각을 읽는다 (ps가 있는 곳)", () => {
    if (process.platform === "win32") return;
    const at = processStartedAt(process.pid);
    expect(at).not.toBeNull();
    expect(at!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("번호만 물려받은 프로세스의 잠금은 풀고 새로 잡는다", () => {
    const save = join(mkdtempSync(join(tmpdir(), "lock-")), "w.db");
    // 지금 프로세스 번호로, 이 프로세스가 뜨기 전에 적힌 잠금
    writeFileSync(`${save}.lock`, JSON.stringify(lockOf(process.pid, "2000-01-01T00:00:00Z")));
    const release = acquireLock(save, "mcp");
    expect(Date.parse(readLock(save)!.startedAt)).toBeGreaterThan(Date.parse("2000-01-01T00:00:00Z"));
    // 방금 잡은 잠금은 쥐고 있다
    expect(() => acquireLock(save, "mcp")).toThrow(WorldLockedError);
    release();
    expect(readLock(save)).toBeNull();
  });
});
