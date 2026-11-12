import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { PlayMode } from "../engine/log.ts";

/**
 * 세계 잠금 (기획서 11.5). 두 모드가 같은 세이브를 쓰되, 동시에 같은 세계를 여는 것만 막는다.
 * 잠금 파일: <세이브>.lock = { pid, mode, startedAt }
 */
export type LockInfo = { pid: number; mode: PlayMode; startedAt: string };

export class WorldLockedError extends Error {
  override name = "WorldLockedError";
  constructor(readonly holder: LockInfo) {
    super(
      `이 세계는 다른 곳에서 열려 있습니다 (${holder.mode === "web" ? "웹 앱" : "MCP"} 모드, PID ${holder.pid}, ${holder.startedAt}). ` +
        "그쪽을 닫은 뒤 다시 시도하세요.",
    );
  }
}

export function lockPathOf(savePath: string): string {
  return `${savePath}.lock`;
}

/** 프로세스가 살아 있는지 (신호 0은 확인만 한다) */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: 살아 있지만 권한이 없다
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLock(savePath: string): LockInfo | null {
  const path = lockPathOf(savePath);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LockInfo;
  } catch {
    return null;
  }
}

/**
 * 잠금을 잡는다. 살아 있는 프로세스가 잡고 있으면 WorldLockedError (같은 프로세스가 두 번 여는 것도 막는다).
 * 죽은 프로세스가 남긴 잠금은 해제하고 새로 잡는다. 해제 함수를 돌려준다.
 */
export function acquireLock(savePath: string, mode: PlayMode, pid = process.pid): () => void {
  const path = lockPathOf(savePath);
  const holder = readLock(savePath);
  if (holder && isProcessAlive(holder.pid)) throw new WorldLockedError(holder);
  const info: LockInfo = { pid, mode, startedAt: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(info));
  return () => {
    const current = readLock(savePath);
    if (current?.pid === pid) rmSync(path, { force: true });
  };
}
