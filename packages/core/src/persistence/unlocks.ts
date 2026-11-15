import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 모든 판에 남는 해금 (기획서 9.12). 세이브 폴더의 unlocks.json에 월드(팩)별로 적는다.
 * 세계 하나의 세이브가 아니라 플레이어의 기록이라 세이브 DB 밖에 둔다. 파일이 깨졌으면 빈 기록으로 본다
 */
export type UnlockRecord = Record<string, string[]>;

const FILE = "unlocks.json";

export function readUnlocks(savesDir: string): UnlockRecord {
  return readRecord(savesDir, FILE);
}

/** 새 해금을 더한다 (이미 있으면 그대로). 쓰다가 끊겨도 깨지지 않게 임시 파일로 쓰고 옮긴다 */
export function addUnlocks(savesDir: string, pack: string, ids: readonly string[]): void {
  const record = readRecord(savesDir, FILE);
  const have = new Set(record[pack] ?? []);
  const fresh = ids.filter((id) => !have.has(id));
  if (!fresh.length) return;
  record[pack] = [...have, ...fresh];
  writeRecord(savesDir, FILE, record);
}

/**
 * 아직 닫지 않은 해금 알림 (상태 화면 위의 토스트, 기획서 12.4.1). 플레이어가 ×를 누를 때까지 남는다.
 * 해금 기록과 같은 꼴(월드별 시나리오 id 목록)이고, 따로 unlock-notices.json에 둔다
 */
const NOTICE_FILE = "unlock-notices.json";

function writeRecord(savesDir: string, file: string, record: UnlockRecord): void {
  mkdirSync(savesDir, { recursive: true });
  const path = join(savesDir, file);
  writeFileSync(`${path}.tmp`, JSON.stringify(record, null, 2));
  renameSync(`${path}.tmp`, path);
}

function readRecord(savesDir: string, file: string): UnlockRecord {
  const path = join(savesDir, file);
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

export function readUnlockNotices(savesDir: string): UnlockRecord {
  return readRecord(savesDir, NOTICE_FILE);
}

export function addUnlockNotices(savesDir: string, pack: string, ids: readonly string[]): void {
  const record = readRecord(savesDir, NOTICE_FILE);
  const have = new Set(record[pack] ?? []);
  const fresh = ids.filter((id) => !have.has(id));
  if (!fresh.length) return;
  record[pack] = [...have, ...fresh];
  writeRecord(savesDir, NOTICE_FILE, record);
}

/** 알림 하나를 닫는다. 없으면 false */
export function dismissUnlockNotice(savesDir: string, pack: string, id: string): boolean {
  const record = readRecord(savesDir, NOTICE_FILE);
  if (!(record[pack] ?? []).includes(id)) return false;
  record[pack] = record[pack]!.filter((x) => x !== id);
  writeRecord(savesDir, NOTICE_FILE, record);
  return true;
}
