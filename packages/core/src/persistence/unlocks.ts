import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 모든 판에 남는 해금 (기획서 9.12). 세이브 폴더의 unlocks.json에 월드(팩)별로 적는다.
 * 세계 하나의 세이브가 아니라 플레이어의 기록이라 세이브 DB 밖에 둔다. 파일이 깨졌으면 빈 기록으로 본다
 */
export type UnlockRecord = Record<string, string[]>;

const FILE = "unlocks.json";

export function readUnlocks(savesDir: string): UnlockRecord {
  const path = join(savesDir, FILE);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: UnlockRecord = {};
    for (const [pack, ids] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(ids)) out[pack] = ids.filter((x): x is string => typeof x === "string");
    }
    return out;
  } catch {
    return {};
  }
}

/** 새 해금을 더한다 (이미 있으면 그대로). 쓰다가 끊겨도 깨지지 않게 임시 파일로 쓰고 옮긴다 */
export function addUnlocks(savesDir: string, pack: string, ids: readonly string[]): void {
  const record = readUnlocks(savesDir);
  const have = new Set(record[pack] ?? []);
  const fresh = ids.filter((id) => !have.has(id));
  if (!fresh.length) return;
  record[pack] = [...have, ...fresh];
  mkdirSync(savesDir, { recursive: true });
  const path = join(savesDir, FILE);
  writeFileSync(`${path}.tmp`, JSON.stringify(record, null, 2));
  renameSync(`${path}.tmp`, path);
}
