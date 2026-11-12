import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { createSeededRng, type Rng } from "../rng.ts";
import type { Content } from "../content/schemas.ts";
import { createWorldEvent } from "../game/state.ts";
import type { PlayMode } from "../engine/log.ts";
import { runAfterTimeAdvance } from "../engine/turnStart.ts";
import { acquireLock, readLock, type LockInfo } from "../persistence/lock.ts";
import { archiveSave, SaveFormatError, SqliteRepository } from "../persistence/sqlite.ts";
import { formatTime } from "../rules/time.ts";
import { GameWorld } from "./world.ts";

export type WorldInfo = {
  id: string;
  path: string;
  scenarioId: string | null;
  playerName: string | null;
  timeLabel: string | null;
  turn: number | null;
  dead: boolean;
  updatedAt: string;
  /** 다른 곳에서 열려 있으면 그 정보 */
  lockedBy: LockInfo | null;
};

/**
 * 세계 목록과 열기·만들기 (기획서 11.5).
 * 세계 하나 = saves/worlds/<worldId>.db 하나. 두 모드가 같은 폴더를 쓰고, 잠금으로 동시 접근만 막는다.
 */
export class WorldManager {
  readonly savesDir: string;
  readonly worldsDir: string;
  readonly content: Content;
  #rngFactory: () => Rng;

  constructor(options: { savesDir: string; content: Content; rngFactory?: () => Rng }) {
    this.savesDir = options.savesDir;
    this.worldsDir = join(options.savesDir, "worlds");
    this.content = options.content;
    this.#rngFactory = options.rngFactory ?? (() => createSeededRng(randomBytes(4).readUInt32LE(0)));
    mkdirSync(this.worldsDir, { recursive: true });
    this.#migrateLegacySave();
  }

  pathOf(worldId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(worldId)) throw new Error(`올바르지 않은 세계 id: ${worldId}`);
    return join(this.worldsDir, `${worldId}.db`);
  }

  /** 세계 목록 (최근에 플레이한 것부터). 잠금 없이 읽기만 한다 */
  listWorlds(): WorldInfo[] {
    return readdirSync(this.worldsDir)
      .filter((name) => name.endsWith(".db"))
      .map((name) => readWorldInfo(join(this.worldsDir, name)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** 새 세계를 만들고 연다 */
  create(mode: PlayMode, roleId?: string): GameWorld {
    const role = roleId ?? Object.keys(this.content.roles)[0];
    if (!role || !this.content.roles[role]) throw new Error(`알 수 없는 시작 역할: ${role}`);
    const worldId = newWorldId();
    const world = this.#open(this.pathOf(worldId), mode);
    try {
      const ctx = world.ctx();
      ctx.store.append(createWorldEvent(this.content, role, worldId));
      runAfterTimeAdvance(ctx); // 첫날의 임무 후보, 소문 기준일
      world.saveSnapshot();
      return world;
    } catch (err) {
      world.close();
      throw err;
    }
  }

  /** 세계를 연다. 다른 곳에서 열려 있으면 WorldLockedError */
  open(worldId: string, mode: PlayMode): GameWorld {
    const path = this.pathOf(worldId);
    if (!existsSync(path)) throw new Error(`없는 세계: ${worldId}`);
    return this.#open(path, mode);
  }

  /**
   * 이 시나리오의 가장 최근 세계를 연다. 없으면 새로 만든다.
   * 형식이나 시나리오가 맞지 않는 세이브는 지우지 않고 saves/archive/로 옮긴다.
   */
  openLatest(mode: PlayMode): GameWorld {
    for (const info of this.listWorlds()) {
      if (info.scenarioId !== this.content.scenario.id) continue;
      try {
        return this.#open(info.path, mode);
      } catch (err) {
        if (!(err instanceof SaveFormatError)) throw err;
        const archived = archiveSave(info.path, new Date(), join(this.savesDir, "archive"));
        console.error(`[world] ${err.message} 보관함으로 옮겼습니다: ${archived}`);
      }
    }
    return this.create(mode);
  }

  #open(path: string, mode: PlayMode): GameWorld {
    const release = acquireLock(path, mode);
    try {
      const repo = SqliteRepository.open(path, this.content.scenario);
      return new GameWorld({ content: this.content, repo, mode, rng: this.#rngFactory(), path, release });
    } catch (err) {
      release();
      throw err;
    }
  }

  /** 예전 구조(saves/world.db 하나)를 saves/worlds/로 옮긴다 */
  #migrateLegacySave() {
    const legacy = join(this.savesDir, "world.db");
    if (!existsSync(legacy)) return;
    const target = this.pathOf(`legacy-${statSync(legacy).mtime.toISOString().slice(0, 10)}-${randomBytes(2).toString("hex")}`);
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(legacy + suffix)) renameSync(legacy + suffix, target + suffix);
    }
  }
}

function newWorldId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `w${stamp}-${randomBytes(2).toString("hex")}`;
}

/** 세이브 파일에서 목록용 정보만 읽는다 (스키마 검증 없이, 읽기 전용) */
function readWorldInfo(path: string): WorldInfo {
  const info: WorldInfo = {
    id: basename(path, ".db"),
    path,
    scenarioId: null,
    playerName: null,
    timeLabel: null,
    turn: null,
    dead: false,
    updatedAt: statSync(path).mtime.toISOString(),
    lockedBy: readLock(path),
  };
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const meta = db.prepare("SELECT value FROM meta WHERE key = 'scenario_id'").get() as { value: string } | undefined;
    info.scenarioId = meta?.value ?? null;
    const snap = db.prepare("SELECT state FROM snapshots ORDER BY seq DESC LIMIT 1").get() as { state: string } | undefined;
    if (snap) {
      const state = JSON.parse(snap.state) as {
        playerId?: string;
        time?: number;
        turn?: number;
        characters?: Record<string, { name?: string; dead?: boolean }>;
      };
      const player = state.playerId ? state.characters?.[state.playerId] : undefined;
      info.playerName = player?.name ?? null;
      info.dead = player?.dead === true;
      info.timeLabel = typeof state.time === "number" ? formatTime(state.time) : null;
      info.turn = state.turn ?? null;
    }
  } catch {
    // 읽을 수 없는 세이브도 목록에는 보인다 (열 때 형식 오류로 처리)
  } finally {
    db?.close();
  }
  return info;
}
