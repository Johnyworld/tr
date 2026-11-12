import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { createSeededRng, type Rng } from "../rng.ts";
import type { Content } from "../content/schemas.ts";
import { createWorldEvent, type CharacterChoice } from "../game/state.ts";
import { checkCharacterChoice, fillCharacterChoice } from "../game/creation.ts";

/** 캐릭터 생성에서 고른 것이 규칙에 맞지 않는다 */
export class CharacterChoiceError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(" "));
  }
}
import type { PlayMode } from "../engine/log.ts";
import { runAfterTimeAdvance } from "../engine/turnStart.ts";
import { acquireLock, isProcessAlive, readLock, WorldLockedError, type LockInfo } from "../persistence/lock.ts";
import { archiveSave, SaveFormatError, SqliteRepository } from "../persistence/sqlite.ts";
import { formatTime } from "../rules/time.ts";
import { GameWorld } from "./world.ts";
import { toSaveSlot, type SaveSlot } from "./slots.ts";
import type { LoreLibrary } from "../rag/library.ts";
import { MemoryStore } from "../rag/memory.ts";
import type { Embedder } from "../rag/embedder.ts";

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
  /** 마지막 스냅숏의 상태 (슬롯 요약용, 검증하지 않은 값) */
  raw: unknown;
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
  readonly lore: LoreLibrary | null;
  readonly memoryEmbedder: Embedder | null;

  constructor(options: {
    savesDir: string;
    content: Content;
    rngFactory?: () => Rng;
    lore?: LoreLibrary | null;
    /** memory 컬렉션에 쓸 임베더. 없으면 장기 기억 검색 없이 진행 */
    memoryEmbedder?: Embedder | null;
  }) {
    this.lore = options.lore ?? null;
    this.memoryEmbedder = options.memoryEmbedder ?? null;
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
      .filter((name) => name.endsWith(".db") && !name.endsWith(".memory.db"))
      .map((name) => readWorldInfo(join(this.worldsDir, name)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** 이 시나리오의 세이브 슬롯 (최근에 플레이한 것부터). 시작 화면과 MCP의 번호 목록이 같이 쓴다 */
  listSlots(): SaveSlot[] {
    return this.listWorlds()
      .filter((w) => w.scenarioId === this.content.scenario.id)
      // 죽은 프로세스가 남긴 잠금은 사용 중이 아니다
      .map((w) => toSaveSlot({ ...w, lockedBy: w.lockedBy && isProcessAlive(w.lockedBy.pid) ? w.lockedBy : null }, w.raw, this.content));
  }

  /** 새 세계를 만들고 연다 */
  create(mode: PlayMode, roleId?: string, choice?: CharacterChoice): GameWorld {
    const role = roleId ?? Object.keys(this.content.roles)[0];
    if (!role || !this.content.roles[role]) throw new Error(`알 수 없는 시작 역할: ${role}`);
    if (choice) {
      const problems = checkCharacterChoice(this.content.scenario, choice);
      if (problems.length) throw new CharacterChoiceError(problems);
    }
    const worldId = newWorldId();
    const world = this.#open(this.pathOf(worldId), mode);
    try {
      const ctx = world.ctx();
      // 능력을 고르지 않았으면(null) 포인트를 무작위로 배분한다
      const filled = choice ? fillCharacterChoice(this.content.scenario, choice, ctx.rng) : choice;
      ctx.store.append(createWorldEvent(this.content, role, worldId, ctx.rng, filled));
      runAfterTimeAdvance(ctx); // 첫날의 임무 후보, 소문 기준일
      world.saveSnapshot();
      return world;
    } catch (err) {
      // 캐릭터까지 다 만들어지지 않은 세이브는 남기지 않는다
      world.close();
      removeSaveFiles(this.pathOf(worldId));
      throw err;
    }
  }

  /**
   * 세이브를 지운다 (되돌릴 수 없다. 묻는 것은 화면·GM이 한다).
   * 어디서든 열려 있으면 지우지 않는다 (WorldLockedError). 세이브 옆의 memory 색인과 잠금 파일도 지운다
   */
  deleteWorld(worldId: string): void {
    const path = this.pathOf(worldId);
    if (!existsSync(path)) throw new Error(`없는 세이브: ${worldId}`);
    const holder = readLock(path);
    if (holder && isProcessAlive(holder.pid)) throw new WorldLockedError(holder);
    removeSaveFiles(path);
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
      // memory 색인은 세이브 옆의 파생 파일이다 (세이브로부터 다시 만들 수 있다)
      const memory = this.memoryEmbedder ? MemoryStore.open(path.replace(/\.db$/, ".memory.db"), this.memoryEmbedder) : null;
      const world = new GameWorld({ content: this.content, repo, mode, rng: this.#rngFactory(), path, release, lore: this.lore, memory });
      // 이미 있는 세계: 시간이 흐른 뒤의 처리를 한 번 맞춘다. 시간이 그대로라 보통은 아무 일도 없고,
      // 이전 단계의 세이브라면 새로 생긴 상태(세력 등)를 채운다
      if (world.state().worldId) runAfterTimeAdvance(world.ctx());
      return world;
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

/** 세이브 파일과 딸린 파일(WAL, 잠금, memory 색인)을 지운다 */
function removeSaveFiles(path: string) {
  const memory = path.replace(/\.db$/, ".memory.db");
  for (const p of [path, memory]) {
    for (const suffix of ["", "-wal", "-shm", ".lock"]) rmSync(p + suffix, { force: true });
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
    // 마지막 플레이 시각은 아래에서 마지막 이벤트 시각으로 바꾼다 (파일 시각은 열고 닫기만 해도 바뀐다)
    updatedAt: statSync(path).mtime.toISOString(),
    lockedBy: readLock(path),
    raw: null,
  };
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const meta = db.prepare("SELECT value FROM meta WHERE key = 'scenario_id'").get() as { value: string } | undefined;
    info.scenarioId = meta?.value ?? null;
    const last = db.prepare("SELECT MAX(created_at) AS at FROM events").get() as { at: string | null } | undefined;
    if (last?.at) info.updatedAt = last.at;
    const snap = db.prepare("SELECT state FROM snapshots ORDER BY seq DESC LIMIT 1").get() as { state: string } | undefined;
    if (snap) {
      const state = JSON.parse(snap.state) as {
        playerId?: string;
        time?: number;
        turn?: number;
        characters?: Record<string, { name?: string; dead?: boolean }>;
      };
      info.raw = state;
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
