import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 서버 장부: 떠 있는 MCP 서버를 `<세이브 폴더>/servers/<pid>.json`에 적어 둔다.
 * 새 서버가 뜰 때 장부를 훑어, 주인(서버를 띄운 claude 프로세스)이 죽은 서버(고아)만 내린다.
 * 주인이 살아 있으면 쉬고 있는 세션이라도 건드리지 않는다. 시간 기준은 쓰지 않는다 (잠자기 오판 방지).
 * 판단을 못 하면 죽이지 않는 쪽으로 기운다. 게임 규칙이 아니라 프로세스 관리라 mcp에 둔다.
 */

export interface ServerEntry {
  pid: number;
  /** 서버 프로세스 시작 시각 (PID 재사용 구분용) */
  startedAt: string | null;
  /** 서버를 띄운 claude 프로세스. 못 찾으면 null (그러면 고아로 보지 않는다) */
  owner: number | null;
  ownerStartedAt: string | null;
  port: number | null;
}

/** 프로세스를 들여다보는 부분. 테스트에서 갈아 끼운다 */
export interface ProcessProbe {
  alive(pid: number): boolean;
  startedAt(pid: number): string | null;
  command(pid: number): string | null;
  parent(pid: number): number | null;
  kill(pid: number): void;
}

function ps(field: string, pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

export const systemProbe: ProcessProbe = {
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM"; // 있지만 권한이 없는 것도 살아 있는 것
    }
  },
  startedAt: (pid) => ps("lstart", pid),
  command: (pid) => ps("command", pid),
  parent(pid) {
    const n = Number(ps("ppid", pid));
    return Number.isInteger(n) && n > 0 ? n : null;
  },
  kill(pid) {
    process.kill(pid, "SIGTERM");
  },
};

/** claude 실행 파일의 명령줄인가 (`…/bin/claude --…`, `…/claude.app/Contents/MacOS/claude --…`) */
export function isClaudeCommand(command: string): boolean {
  return /\/claude( |$)/.test(command);
}

/** 조상 중 처음 만나는 claude 프로세스 */
export function findOwner(probe: ProcessProbe = systemProbe, from: number = process.pid): number | null {
  let pid = probe.parent(from);
  for (let depth = 0; pid && pid > 1 && depth < 12; depth++) {
    const command = probe.command(pid);
    if (command && isClaudeCommand(command)) return pid;
    pid = probe.parent(pid);
  }
  return null;
}

const dirOf = (savesDir: string) => join(savesDir, "servers");
const fileOf = (savesDir: string, pid: number) => join(dirOf(savesDir), `${pid}.json`);

/** 내 줄을 쓴다 (포트를 알게 되면 다시 부른다). 못 써도 게임은 그대로 한다 */
export function registerServer(savesDir: string, port: number | null = null, probe: ProcessProbe = systemProbe): void {
  try {
    const owner = findOwner(probe);
    const entry: ServerEntry = {
      pid: process.pid,
      startedAt: probe.startedAt(process.pid),
      owner,
      ownerStartedAt: owner ? probe.startedAt(owner) : null,
      port,
    };
    mkdirSync(dirOf(savesDir), { recursive: true });
    writeFileSync(fileOf(savesDir, process.pid), JSON.stringify(entry));
  } catch (err) {
    console.error(`[mcp] 서버 장부를 쓰지 못했습니다: ${String(err)}`);
  }
}

export function unregisterServer(savesDir: string): void {
  rmSync(fileOf(savesDir, process.pid), { force: true });
}

/** 장부를 훑어 고아를 내리고, 내린 서버의 pid를 돌려준다 */
export function sweepOrphans(savesDir: string, probe: ProcessProbe = systemProbe): number[] {
  const killed: number[] = [];
  let files: string[];
  try {
    files = readdirSync(dirOf(savesDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return killed;
  }
  for (const file of files) {
    const path = join(dirOf(savesDir), file);
    let entry: ServerEntry;
    try {
      entry = JSON.parse(readFileSync(path, "utf8")) as ServerEntry;
    } catch {
      rmSync(path, { force: true }); // 깨진 줄
      continue;
    }
    if (entry.pid === process.pid) continue;
    // 서버가 이미 없거나, 같은 번호를 다른 프로세스가 쓰고 있으면 줄만 지운다
    const same = probe.alive(entry.pid) && probe.startedAt(entry.pid) === entry.startedAt && (probe.command(entry.pid) ?? "").includes("packages/mcp");
    if (!same) {
      rmSync(path, { force: true });
      continue;
    }
    if (entry.owner === null) continue; // 주인을 몰랐다: 죽이지 않는다
    const ownerAlive = probe.alive(entry.owner) && probe.startedAt(entry.owner) === entry.ownerStartedAt;
    if (ownerAlive) continue;
    try {
      probe.kill(entry.pid);
      killed.push(entry.pid);
      console.error(`[mcp] 주인 없는 서버를 내렸습니다 (pid ${entry.pid}, 포트 ${entry.port ?? "?"})`);
    } catch (err) {
      console.error(`[mcp] 주인 없는 서버를 내리지 못했습니다 (pid ${entry.pid}): ${String(err)}`);
    }
    rmSync(path, { force: true });
  }
  return killed;
}
