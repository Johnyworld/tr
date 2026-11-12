import { basename } from "node:path";
import type { Rng } from "../rng.ts";
import type { Content } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import type { GameRepository } from "../persistence/repository.ts";
import { formatTime } from "../rules/time.ts";
import { describePlayerState } from "../engine/context.ts";
import type { PlayMode, TranscriptEntry, TurnSummary } from "../engine/log.ts";
import { buildGmGuide } from "../engine/prompt.ts";
import { executeTool, gmToolSpecs } from "../engine/tools.ts";
import type { ToolContext, ToolOutcome, ToolSpec } from "../engine/toolkit.ts";
import { buildPlayerView, buildTranscriptView, type PlayerView, type TranscriptView } from "../views/player.ts";
import { commandPrefixFor, runCommand, stripCommandPrefix } from "../commands/commands.ts";
import type { LoreLibrary, LoreSearch } from "../rag/library.ts";
import { memoryItemsOf, type MemoryStore } from "../rag/memory.ts";
import type { SearchOptions } from "../rag/index.ts";
import { COMMANDS } from "../commands/commands.ts";
import { formatChronicle, successionOptions, switchCharacter, type SuccessionOption } from "../engine/succession.ts";
import { runAfterTimeAdvance } from "../engine/turnStart.ts";
import type { Viewer } from "../rag/index.ts";
import type { RetrievalRecord } from "../engine/log.ts";
import type { TimeSegment } from "../rules/time.ts";

/** 새 세션의 GM이 이어 갈 때 돌려줄 최근 요약 수 */
export const RECAP_TURNS = 5;

/**
 * 열린 세계 하나. 두 플레이 모드(웹 앱, MCP)가 같은 이 클래스를 쓴다.
 * 게임 규칙·정보 필터는 모두 여기(core)를 거치고, 어댑터는 이것을 호출만 한다 (원칙 9).
 */
export class GameWorld {
  readonly mode: PlayMode;
  readonly content: Content;
  readonly path: string | null;
  #repo: GameRepository;
  #rng: Rng;
  #release: () => void;
  #lore: LoreLibrary | null;
  #memory: MemoryStore | null;
  #closed = false;

  constructor(options: {
    content: Content;
    repo: GameRepository;
    mode: PlayMode;
    rng: Rng;
    path?: string;
    release?: () => void;
    /** 시나리오 lore 컬렉션 (없으면 lore 검색 없이 진행) */
    lore?: LoreLibrary | null;
    /** 이 세계의 memory 컬렉션 (없으면 장기 기억 검색 없이 진행) */
    memory?: MemoryStore | null;
  }) {
    this.#lore = options.lore ?? null;
    this.#memory = options.memory ?? null;
    this.content = options.content;
    this.mode = options.mode;
    this.path = options.path ?? null;
    this.#repo = options.repo;
    this.#rng = options.rng;
    this.#release = options.release ?? (() => {});
    // 세이브와 memory 색인을 맞춘다 (모델이 바뀌었거나 지난번에 못 맞춘 기억까지)
    if (this.state().worldId) this.#syncMemory();
  }

  /** 세이브의 기억(요약·행적·믿음)을 memory 색인에 맞춘다. 저장 시점에 바로, 백그라운드로 (기획서 11.4) */
  #syncMemory(): void {
    if (!this.#memory || this.#closed) return;
    void this.#memory.sync(memoryItemsOf(this.state(), this.summaries({ all: true })));
  }

  /** 세계 id = 세이브 파일 이름 (WorldManager.open에 그대로 쓸 수 있다). 파일이 없으면 상태의 worldId */
  get id(): string {
    return this.path ? basename(this.path, ".db") : this.#repo.getState().worldId;
  }

  state(): GameState {
    return this.#repo.getState();
  }

  /** core 규칙이 쓰는 실행 컨텍스트 */
  ctx(): ToolContext {
    return { store: this.#repo, rng: this.#rng, content: this.content };
  }

  isPlayerDead(): boolean {
    const state = this.state();
    return state.characters[state.playerId]?.dead === true;
  }

  /** GM 지침 (시나리오 톤 + 시작 장면 + 공통 규칙, MCP 모드면 진행 규칙 추가) */
  guide(): string {
    return buildGmGuide(this.content, this.state().roleId, this.mode);
  }

  /** GM에게 여는 tool 명세 (두 모드 공통) */
  toolSpecs(): ToolSpec[] {
    return gmToolSpecs(this.content.scenario);
  }

  /**
   * tool 실행. 결과 카드는 대화 기록에 남긴다.
   * take_action은 한 턴이므로 끝나면 스냅샷을 남기고, narration_summary가 있으면 턴 요약으로 저장한다.
   * MCP 모드에서는 플레이어 의도도 기록에 남긴다 (웹 앱 모드는 GM 루프가 원래 입력을 남긴다).
   */
  executeTool(name: string, input: unknown): ToolOutcome {
    if (name === "take_action" && input && typeof input === "object") {
      const { intent, narration_summary } = input as { intent?: unknown; narration_summary?: unknown };
      // 웹 앱 모드는 GM 루프가 서술을 직접 저장하므로 narration_summary는 MCP 모드에서만 쓴다
      if (this.mode === "mcp" && typeof narration_summary === "string" && narration_summary.trim()) {
        this.appendTranscript([{ kind: "note", text: narration_summary.trim() }]);
        this.recordSummary("turn", narration_summary.trim());
      }
      if (this.mode === "mcp" && typeof intent === "string" && intent.trim()) {
        this.appendTranscript([{ kind: "player", text: intent.trim() }]);
      }
    }
    const outcome = executeTool(name, input, this.ctx());
    if (outcome.ok && !outcome.silent) {
      this.appendTranscript([outcome.display, ...(outcome.extra ?? [])].map((display) => ({ kind: "tool", display })));
    } else if (outcome.ok && outcome.extra?.length) {
      this.appendTranscript(outcome.extra.map((display) => ({ kind: "tool", display })));
    }
    if (outcome.ok && name === "take_action") this.#repo.saveSnapshot();
    if (outcome.ok) this.#syncMemory();
    return outcome;
  }

  transcript(): readonly TranscriptEntry[] {
    return this.#repo.transcript();
  }

  appendTranscript(entries: readonly TranscriptEntry[]): void {
    this.#repo.appendTranscript(entries);
  }

  recordSummary(kind: TurnSummary["kind"], text: string): void {
    const state = this.state();
    this.#repo.appendSummary({
      kind,
      text: text.trim(),
      turn: state.turn,
      time: state.time,
      mode: this.mode,
      characterId: state.playerId,
    });
    this.#syncMemory();
  }

  /**
   * 요약 기록 (오래된 것부터). 기본은 현재 캐릭터의 것만 (새 캐릭터는 이전 캐릭터의 기억을 모른다).
   * all이면 모든 캐릭터의 것 (memory 색인은 knownBy로 거른다)
   */
  summaries(options: { kind?: TurnSummary["kind"]; limit?: number; all?: boolean } = {}): TurnSummary[] {
    const state = this.state();
    // 캐릭터 id가 없던 이전 요약은 첫 캐릭터의 것이다
    const first = state.chronicle[0]?.characterId ?? state.playerId;
    const list = this.#repo
      .summaries(options.kind ? { kind: options.kind } : {})
      .filter((s) => options.all || (s.characterId || first) === state.playerId);
    return options.limit === undefined ? list : list.slice(-options.limit);
  }

  /** 다음 캐릭터 후보 (사망한 뒤에만) */
  successionOptions(): SuccessionOption[] {
    return successionOptions(this.state(), this.content);
  }

  /**
   * 사망 뒤 다음 캐릭터로 이어 간다. 대화 기록에 경계를 남겨, GM이 이전 캐릭터의 서술을 이어받지 않게 한다
   */
  chooseNextCharacter(choice: string, name: string | null = null): { ok: true; text: string } | { ok: false; error: string } {
    const ctx = this.ctx();
    const result = switchCharacter(ctx, choice, name);
    if (!result.ok) return result;
    const heir = this.state().characters[this.state().playerId]!;
    this.appendTranscript([{ kind: "note", text: `— ${heir.name}의 이야기가 시작된다 —`, characterSwitch: true }]);
    runAfterTimeAdvance(ctx); // 구역, 오늘의 임무, 이야기
    this.#repo.saveSnapshot();
    this.#syncMemory();
    return { ok: true, text: `${result.text}

## 현재 장면
${this.sceneForGm()}` };
  }

  chronicleText(): string {
    return formatChronicle(this.state(), this.content).join("\n").trimEnd();
  }

  /** 새 세션의 GM이 이어 갈 수 있게: 최근 장면 요약 1개 + 그 뒤의 턴 요약들 */
  recap(): string {
    const scene = this.summaries({ kind: "scene", limit: 1 })[0];
    const turns = this.summaries({ kind: "turn", limit: RECAP_TURNS }).filter((t) => !scene || t.turn > scene.turn);
    if (!scene && turns.length === 0) return "";
    const lines: string[] = [];
    if (scene) lines.push(`최근 장면 요약 (${formatTime(scene.time)}): ${scene.text}`);
    for (const t of turns) lines.push(`- ${formatTime(t.time)}: ${t.text}`);
    return `지난 이야기:\n${lines.join("\n")}`;
  }

  /** GM에게 보여 줄 현재 장면 (정보 필터 적용) */
  sceneForGm(): string {
    return describePlayerState(this.state(), this.content);
  }

  /** 검색하는 캐릭터 (정보 필터 기준). 플래그는 시나리오 플래그 시스템이 생기면 채운다 */
  viewer(): Viewer {
    const state = this.state();
    const player = state.characters[state.playerId];
    // 시나리오 플래그(스토리렛이 세운다)가 secret:<flag> lore를 연다
    return { characterId: state.playerId, factionId: player?.factionId ?? "", flags: new Set(state.flags[state.playerId] ?? []) };
  }

  /**
   * memory 검색 (기획서 11.4): 현재 캐릭터가 보거나 전해 들은 기억만. 캐릭터가 바뀌면 이전 캐릭터의 기억은 나오지 않는다.
   */
  async searchMemory(query: string, purpose: RetrievalRecord["purpose"], options?: SearchOptions): Promise<LoreSearch> {
    if (!this.#memory) return { hits: [], trace: null, error: "memory 색인이 없다" };
    let result: LoreSearch;
    try {
      result = await this.#memory.search(query, this.viewer(), options);
    } catch (err) {
      return { hits: [], trace: null, error: err instanceof Error ? err.message : String(err) };
    }
    if (result.trace && !this.#closed) {
      const state = this.state();
      this.#repo.appendRetrieval({ turn: state.turn, time: state.time, mode: this.mode, collection: "memory", purpose, trace: result.trace });
    }
    return result;
  }

  /**
   * lore 검색 (기획서 11.4). 현재 캐릭터가 볼 수 있는 청크만 돌려주고, 무엇이 왜 들어갔는지 기록한다.
   * 기록은 게임 상태를 바꾸지 않는다.
   */
  async searchLore(query: string, purpose: RetrievalRecord["purpose"]): Promise<LoreSearch> {
    if (!this.#lore) return { hits: [], trace: null, error: "lore 색인이 없다" };
    const result = await this.#lore.search(query, this.viewer());
    if (result.trace && !this.#closed) {
      const state = this.state();
      this.#repo.appendRetrieval({ turn: state.turn, time: state.time, mode: this.mode, collection: "lore", purpose, trace: result.trace });
    }
    return result;
  }

  /**
   * GM 컨텍스트용 검색어: 플레이어 입력 + 현재 장면 요약(최근 턴 요약) + 함께 있는 인물 이름 (기획서 11.4)
   */
  contextQuery(input: string): string {
    const state = this.state();
    const lastTurn = this.summaries({ kind: "turn", limit: 1 })[0]?.text ?? "";
    const present = state.scene.present.map((id) => state.characters[id]?.name ?? id).join(" ");
    return [input, lastTurn.slice(0, 300), present].filter(Boolean).join("\n");
  }

  retrievals(limit?: number): RetrievalRecord[] {
    return this.#repo.retrievals(limit);
  }

  /**
   * 정보 명령어 (읽기 전용, 시간을 쓰지 않는다).
   * !일지에 검색어가 있으면 memory 컬렉션을 의미 검색한다 (현재 캐릭터의 기억만).
   */
  async runCommand(input: string): Promise<string> {
    const [word = "", ...rest] = stripCommandPrefix(input).split(/\s+/);
    const query = rest.join(" ").trim();
    const journal = COMMANDS.find((c) => c.id === "journal")!;
    let memoryHits: { text: string }[] | null = null;
    if (query && this.#memory && (journal.name === word || journal.aliases.includes(word))) {
      memoryHits = (await this.searchMemory(query, "recall", { topK: 8, charBudget: 4000 })).hits;
    }
    return runCommand(input, { state: this.state(), content: this.content, summaries: this.summaries(), memoryHits, prefix: commandPrefixFor(this.mode) });
  }

  /** 빨리감기: 지정한 시간대가 될 때까지 기다린다 (끼어들기가 생기면 멈춤). take_action과 같은 경로다 */
  fastForward(until: TimeSegment): ReturnType<GameWorld["executeTool"]> {
    return this.executeTool("take_action", {
      intent: "기다린다",
      check: null,
      activity: { kind: "wait", until },
      deed: null,
      target: null,
      narration_summary: null, for_mission: false,
    });
  }

  playerView(): PlayerView {
    return buildPlayerView(this.state(), this.content);
  }

  transcriptView(): TranscriptView[] {
    return buildTranscriptView(this.transcript());
  }

  /** 화면 머리: 시나리오 이름과 시작 장면 */
  intro(): { worldId: string; scenarioName: string; opening: string } {
    const state = this.state();
    const role = this.content.roles[state.roleId];
    // 계승한 캐릭터는 역할의 시작 장면 대신 짧은 안내
    const opening = state.chronicle.length === 0 ? (role?.opening_scene ?? "") : `${state.characters[state.playerId]?.name ?? ""}의 이야기가 이어진다.`;
    return { worldId: this.id, scenarioName: this.content.scenario.name, opening };
  }

  saveSnapshot(): void {
    this.#repo.saveSnapshot();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    void this.#memory?.close();
    try {
      this.#repo.close();
    } finally {
      this.#release();
    }
  }
}
