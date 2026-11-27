import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findOwner, isClaudeCommand, sweepOrphans, type ProcessProbe, type ServerEntry } from "./serverRegistry.ts";

interface FakeProc {
  ppid?: number;
  command: string;
  started: string;
}

function fakeProbe(procs: Record<number, FakeProc>, killed: number[] = []): ProcessProbe {
  return {
    alive: (pid) => pid in procs,
    startedAt: (pid) => procs[pid]?.started ?? null,
    command: (pid) => procs[pid]?.command ?? null,
    parent: (pid) => procs[pid]?.ppid ?? null,
    kill: (pid) => {
      killed.push(pid);
      delete procs[pid];
    },
  };
}

const SERVER_CMD = "node --require tsx /x/packages/mcp/src/index.ts";

function setup(entries: ServerEntry[]): string {
  const dir = mkdtempSync(join(tmpdir(), "trpg-registry-"));
  mkdirSync(join(dir, "servers"));
  for (const e of entries) writeFileSync(join(dir, "servers", `${e.pid}.json`), JSON.stringify(e));
  return dir;
}
const has = (dir: string, pid: number) => existsSync(join(dir, "servers", `${pid}.json`));

describe("isClaudeCommand", () => {
  it("claude 실행 파일만 잡는다", () => {
    expect(isClaudeCommand("/Users/a/.nvm/bin/claude --session-id x")).toBe(true);
    expect(isClaudeCommand("/A B/claude.app/Contents/MacOS/claude --output-format")).toBe(true);
    expect(isClaudeCommand("node /repo/.claude/worktrees/w/packages/mcp/src/index.ts")).toBe(false);
    expect(isClaudeCommand("/Applications/Claude.app/Contents/MacOS/Claude")).toBe(false);
  });
});

describe("findOwner", () => {
  it("tsx·pnpm 래퍼를 건너뛰고 claude를 찾는다", () => {
    const probe = fakeProbe({
      1: { command: "launchd", started: "t" },
      10: { ppid: 1, command: "/bin/claude --x", started: "t" },
      11: { ppid: 10, command: "node pnpm --silent mcp", started: "t" },
      12: { ppid: 11, command: "node tsx cli.mjs", started: "t" },
      13: { ppid: 12, command: SERVER_CMD, started: "t" },
    });
    expect(findOwner(probe, 13)).toBe(10);
  });

  it("claude가 없으면 null", () => {
    const probe = fakeProbe({ 11: { ppid: 1, command: "node", started: "t" }, 12: { ppid: 11, command: "node", started: "t" } });
    expect(findOwner(probe, 12)).toBeNull();
  });
});

describe("sweepOrphans", () => {
  const entry = (pid: number, owner: number | null): ServerEntry => ({ pid, startedAt: "s", owner, ownerStartedAt: owner ? "o" : null, port: 8790 });

  it("주인이 죽은 서버만 내리고, 산 주인의 서버는 둔다", () => {
    const killed: number[] = [];
    const probe = fakeProbe(
      {
        100: { command: SERVER_CMD, started: "s" }, // 주인 200 없음
        101: { command: SERVER_CMD, started: "s" }, // 주인 201 살아 있음
        201: { command: "/bin/claude", started: "o" },
      },
      killed,
    );
    const dir = setup([entry(100, 200), entry(101, 201)]);
    expect(sweepOrphans(dir, probe)).toEqual([100]);
    expect(killed).toEqual([100]);
    expect(has(dir, 100)).toBe(false);
    expect(has(dir, 101)).toBe(true);
  });

  it("주인 PID를 다른 프로세스가 재사용했으면 고아로 본다", () => {
    const killed: number[] = [];
    const probe = fakeProbe({ 100: { command: SERVER_CMD, started: "s" }, 200: { command: "/bin/claude", started: "다른 시각" } }, killed);
    expect(sweepOrphans(setup([entry(100, 200)]), probe)).toEqual([100]);
  });

  it("서버 PID가 다른 프로그램에 재사용됐으면 죽이지 않고 줄만 지운다", () => {
    const killed: number[] = [];
    const probe = fakeProbe({ 100: { command: "/usr/bin/vim", started: "s" } }, killed);
    const dir = setup([entry(100, 200)]);
    expect(sweepOrphans(dir, probe)).toEqual([]);
    expect(killed).toEqual([]);
    expect(has(dir, 100)).toBe(false);
  });

  it("이미 없는 서버는 줄만 지운다", () => {
    const dir = setup([entry(100, 200)]);
    expect(sweepOrphans(dir, fakeProbe({}))).toEqual([]);
    expect(has(dir, 100)).toBe(false);
  });

  it("주인을 모르는 서버는 죽이지 않는다", () => {
    const killed: number[] = [];
    const dir = setup([entry(100, null)]);
    expect(sweepOrphans(dir, fakeProbe({ 100: { command: SERVER_CMD, started: "s" } }, killed))).toEqual([]);
    expect(has(dir, 100)).toBe(true);
  });

  it("장부 폴더가 없어도 된다", () => {
    expect(sweepOrphans(mkdtempSync(join(tmpdir(), "trpg-registry-")), fakeProbe({}))).toEqual([]);
  });
});
