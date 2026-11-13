import { applyBackground } from "../engine/background.ts";
import type { HistoryPart } from "../game/background.ts";
import { autoEquip } from "../engine/gear.ts";
import { addUnlocks, readUnlocks, type UnlockRecord } from "../persistence/unlocks.ts";
import { generateDynamicTies } from "../engine/people.ts";
import { roleOf } from "../game/state.ts";
import { addStartCompanions } from "../engine/companionTools.ts";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { createSeededRng, type Rng } from "../rng.ts";
import type { Content, RoleContent } from "../content/schemas.ts";
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
 * 세계(세이브) 목록과 열기·만들기 (기획서 11.5).
 * 세계 하나 = saves/worlds/<worldId>.db 하나. 세션들이 같은 폴더를 쓰고, 잠금으로 동시 접근만 막는다.
 * 월드 팩(content)은 여럿일 수 있다. 세이브는 만든 팩의 id(meta scenario_id)를 기억하고, 열 때 그 팩으로 연다
 */
export class WorldManager {
  readonly savesDir: string;
  readonly worldsDir: string;
  /** 월드 팩 (id → 콘텐츠). 순서는 고르기 목록 순서 */
  readonly packs: ReadonlyMap<string, Content>;
  #rngFactory: () => Rng;
  #lore: (packId: string) => LoreLibrary | null;
  readonly memoryEmbedder: Embedder | null;

  constructor(options: {
    savesDir: string;
    /** 월드 팩 하나 또는 여럿 */
    content: Content | readonly Content[];
    rngFactory?: () => Rng;
    /** lore 컬렉션 (팩 하나면 그대로, 여럿이면 팩 id로 고른다) */
    lore?: LoreLibrary | null | ((packId: string) => LoreLibrary | null);
    /** memory 컬렉션에 쓸 임베더. 없으면 장기 기억 검색 없이 진행 */
    memoryEmbedder?: Embedder | null;
  }) {
    const lore = options.lore ?? null;
    this.#lore = typeof lore === "function" ? lore : () => lore;
    this.memoryEmbedder = options.memoryEmbedder ?? null;
    this.savesDir = options.savesDir;
    this.worldsDir = join(options.savesDir, "worlds");
    const list = Array.isArray(options.content) ? options.content : [options.content as Content];
    if (list.length === 0) throw new Error("월드 팩이 없다");
    this.packs = new Map(list.map((c) => [c.scenario.id, c]));
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

  /** 기본 월드 팩 (목록의 첫 번째). 팩이 하나뿐인 곳(테스트 등)에서 쓴다 */
  get content(): Content {
    return this.packs.values().next().value!;
  }

  /** 월드 팩. 없으면 오류 */
  pack(packId: string): Content {
    const content = this.packs.get(packId);
    if (!content) throw new Error(`없는 월드: ${packId}`);
    return content;
  }

  /** 아는 월드의 세이브 슬롯 (최근에 플레이한 것부터). MCP의 번호 목록이 쓴다 */
  listSlots(): SaveSlot[] {
    return this.listWorlds()
      .filter((w) => w.scenarioId !== null && this.packs.has(w.scenarioId))
      // 죽은 프로세스가 남긴 잠금은 사용 중이 아니다
      .map((w) => toSaveSlot({ ...w, lockedBy: w.lockedBy && isProcessAlive(w.lockedBy.pid) ? w.lockedBy : null }, w.raw, this.packs.get(w.scenarioId!)!));
  }

  /**
   * 새 세계를 만들고 연다. packId를 주지 않으면 기본 월드.
   * custom을 주면 자유 시나리오: 콘텐츠의 역할 대신 그 역할로, background는 주인공의 지난 삶 기억 (기획서 12.5)
   */
  create(
    mode: PlayMode,
    roleId?: string,
    choice?: CharacterChoice,
    packId?: string,
    custom?: { role: RoleContent; background: string[]; history?: HistoryPart[] },
  ): GameWorld {
    const content = packId ? this.pack(packId) : this.content;
    const role = custom ? custom.role.id : (roleId ?? Object.keys(content.roles)[0]);
    if (!custom && (!role || !content.roles[role])) throw new Error(`알 수 없는 시작 역할: ${role}`);
    if (choice) {
      const problems = checkCharacterChoice(content.scenario, choice);
      if (problems.length) throw new CharacterChoiceError(problems);
    }
    const worldId = newWorldId();
    const world = this.#open(this.pathOf(worldId), mode, content);
    try {
      const ctx = world.ctx();
      // 능력을 고르지 않았으면(null) 포인트를 무작위로 배분한다
      const filled = choice ? fillCharacterChoice(content.scenario, choice, ctx.rng) : choice;
      ctx.store.append(createWorldEvent(content, role!, worldId, ctx.rng, filled, custom?.role, custom?.background));
      // 첫날의 임무 후보, 소문 기준일, 시작 구역. 자유 시나리오의 역할은 이벤트를 넣은 뒤에야 콘텐츠에 보이므로 새로 받는다
      // 다른 판에서 얻은 해금을 이 세계에도 (기획서 9.12)
      this.#inheritUnlocks(world);
      // 배경 부품: 플레이어가 쓴 지난 일 중 세계의 사실이 되는 것 (기획서 12.6)
      applyBackground(world.ctx(), custom?.history ?? []);
      // 처음부터 함께 다니는 사람·동물 (떠돌이의 가족 등, 기획서 7.9)
      addStartCompanions(world.ctx(), roleOf(world.content, world.state()));
      // 판마다 다른 인물 사이의 관계 (기획서 7.10)
      generateDynamicTies(world.ctx());
      // 가진 무기를 손에 든다 (기획서 4.8)
      autoEquip(world.ctx(), world.state().playerId);
      runAfterTimeAdvance(world.ctx());
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

  /** 세계를 연다 (세이브를 만든 월드 팩으로). 다른 곳에서 열려 있으면 WorldLockedError */
  open(worldId: string, mode: PlayMode): GameWorld {
    const path = this.pathOf(worldId);
    if (!existsSync(path)) throw new Error(`없는 세계: ${worldId}`);
    const packId = readWorldInfo(path).scenarioId;
    const content = packId ? this.packs.get(packId) : undefined;
    if (!content) throw new Error(`이 세이브의 월드(${packId ?? "알 수 없음"})가 설치돼 있지 않다.`);
    return this.#open(path, mode, content);
  }

  /**
   * 아는 월드의 가장 최근 세계를 연다. 없으면 기본 월드로 새로 만든다.
   * 형식이나 월드가 맞지 않는 세이브는 지우지 않고 saves/archive/로 옮긴다.
   */
  openLatest(mode: PlayMode): GameWorld {
    for (const info of this.listWorlds()) {
      const content = info.scenarioId ? this.packs.get(info.scenarioId) : undefined;
      if (!content) continue;
      try {
        return this.#open(info.path, mode, content);
      } catch (err) {
        if (!(err instanceof SaveFormatError)) throw err;
        const archived = archiveSave(info.path, new Date(), join(this.savesDir, "archive"));
        console.error(`[world] ${err.message} 보관함으로 옮겼습니다: ${archived}`);
      }
    }
    return this.create(mode);
  }

  /** 모든 판에 남는 해금 (월드별, 기획서 9.12) */
  unlocks(): UnlockRecord {
    return readUnlocks(this.savesDir);
  }

  /** 다른 판에서 얻은 해금을 이 세계의 상태로 옮긴다 (계승·시나리오 고르기가 상태만 보면 되게) */
  #inheritUnlocks(world: GameWorld): void {
    const have = new Set(world.state().unlocked ?? []);
    for (const id of readUnlocks(this.savesDir)[world.content.scenario.id] ?? []) {
      if (!have.has(id)) world.ctx().store.append({ type: "unlock_earned", id, inherited: true });
    }
  }

  #open(path: string, mode: PlayMode, content: Content): GameWorld {
    const release = acquireLock(path, mode);
    try {
      const repo = SqliteRepository.open(path, content.scenario);
      // memory 색인은 세이브 옆의 파생 파일이다 (세이브로부터 다시 만들 수 있다)
      const memory = this.memoryEmbedder ? MemoryStore.open(path.replace(/\.db$/, ".memory.db"), this.memoryEmbedder) : null;
      const pack = content.scenario.id;
      const world = new GameWorld({
        content,
        repo,
        mode,
        rng: this.#rngFactory(),
        path,
        release,
        lore: this.#lore(pack),
        memory,
        onUnlock: (ids) => addUnlocks(this.savesDir, pack, ids),
      });
      if (world.state().worldId) this.#inheritUnlocks(world);
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
