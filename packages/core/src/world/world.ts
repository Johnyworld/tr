import { checkResolve } from "../engine/resolve.ts";
import { choosePortrait } from "../game/portrait.ts";
import { dayOf } from "../rules/time.ts";
import { moveStash } from "../engine/stash.ts";
import { parseMemoCommand, writeMemo, type MemoResult } from "../game/memo.ts";
import { basename } from "node:path";
import { runCheat } from "../debug/cheats.ts";
import type { CharacterChoice } from "../game/state.ts";
import type { Rng } from "../rng.ts";
import type { Content } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import { gameOptionsPatchSchema, setGameOptions } from "../engine/storyletTools.ts";
import type { GameRepository } from "../persistence/repository.ts";
import { formatTime } from "../rules/time.ts";
import { describePlayerSections, type SceneSection } from "../engine/context.ts";
import type { PlayMode, TranscriptEntry, TurnSummary } from "../engine/log.ts";
import { buildGmGuide } from "../engine/prompt.ts";
import { executeTool, gmToolSpecs } from "../engine/tools.ts";
import type { ToolContext, ToolOutcome, ToolSpec } from "../engine/toolkit.ts";
import { checkScenarioProgress, describeProgressNotices, type ProgressNotice } from "../engine/scenarioProgress.ts";
import type { GameEvent } from "../game/state.ts";
import type { GameStore } from "../game/store.ts";
import { buildPlayerView, type PlayerView } from "../views/player.ts";
import { commandPrefixFor, runCommand, stripCommandPrefix } from "../commands/commands.ts";
import type { LoreLibrary, LoreSearch } from "../rag/library.ts";
import { memoryItemsOf, type MemoryStore } from "../rag/memory.ts";
import type { SearchOptions } from "../rag/index.ts";
import { COMMANDS } from "../commands/commands.ts";
import { formatChronicle, storyEnded, storyEndedText, successionOptions, switchCharacter, type SuccessionOption } from "../engine/succession.ts";
import { runAfterTimeAdvance } from "../engine/turnStart.ts";
import type { Viewer } from "../rag/index.ts";
import type { RetrievalRecord } from "../engine/log.ts";
import type { TimeSegment } from "../rules/time.ts";

/** 새 세션의 GM이 이어 갈 때 돌려줄 최근 요약 수 */

/** 턴마다가 아니라 이벤트가 이만큼 쌓이면 스냅숏 (닫을 때는 늘) */
const SNAPSHOT_EVERY = 150;
/** 상태 화면 일지 탭에 싣는 요약 수 */
const SHEET_JOURNAL = 30;
export const RECAP_TURNS = 5;

/** 바뀐 것만 보내다가도 이만큼 턴이 지나면 장면 전체를 다시 보낸다 (기획서 11.6 토큰) */
export const SCENE_FULL_EVERY = 8;

/** 다시 싣지 않은 덩어리를 GM에게 알릴 때의 이름 */
const SCENE_SECTION_LABELS: Record<string, string> = {
  status: "캐릭터 상태",
  resolve: "주인공의 다짐",
  disaster: "재난",
  facilities: "시설",
  sheet: "능력·스킬·트레잇",
  culture: "무리의 문화·권한",
  battle: "전투·매복·포로",
  romance: "눈길·연인",
  diplomacy: "외교",
  storylet: "진행 중인 이야기",
  missions: "복무·임무",
  squad: "분대",
  factions: "세력",
  deeds: "최근 행적",
  present: "함께 있는 인물",
  known: "알고 있는 인물",
  zone_people: "이 구역의 낯선 사람",
  zone_extras: "이 구역에서 엮인 인물",
  templates: "엑스트라 틀",
  beliefs: "알고 있다고 믿는 것",
};

/**
 * 열린 세계 하나. 두 플레이 모드(웹 앱, MCP)가 같은 이 클래스를 쓴다.
 * 게임 규칙·정보 필터는 모두 여기(core)를 거치고, 어댑터는 이것을 호출만 한다 (원칙 9).
 */
export class GameWorld {
  readonly mode: PlayMode;
  #content: Content;
  /** 자유 시나리오의 역할을 넣은 콘텐츠 (역할이 바뀔 때만 다시 만든다) */
  #withRole: { role: unknown; content: Content } | null = null;
  readonly path: string | null;
  #repo: GameRepository;
  #rng: Rng;
  #release: () => void;
  #lore: LoreLibrary | null;
  #memory: MemoryStore | null;
  #closed = false;
  #onUnlock: ((ids: string[]) => void) | null = null;
  #reportedUnlocks = new Set<string>();
  /** tool 하나 동안 쌓인 이벤트 (시나리오 해금·클리어 판정용, 기획서 12.4.1). 기록 중이 아니면 null */
  #recording: GameEvent[] | null = null;
  #store: GameStore | null = null;

  /** 이벤트를 쌓으며 실행하고, 끝나면 시나리오 해금·클리어를 판정한다 */
  #tracked<T>(run: () => T): { value: T; notices: ProgressNotice[] } {
    const roleAt = this.state().scenarioRole;
    const outer = this.#recording;
    this.#recording = [];
    let value: T;
    try {
      value = run();
    } catch (err) {
      this.#recording = outer;
      throw err;
    }
    const events = this.#recording;
    this.#recording = outer;
    const notices = events.length && this.state().worldId ? checkScenarioProgress(this.ctx(), events, roleAt) : [];
    return { value, notices };
  }

  /** 이 세계에서 새로 얻은 해금을 바깥(모든 판의 기록)에 알린다 */
  #syncUnlocks(): void {
    const fresh = (this.state().unlocked ?? []).filter((id) => !this.#reportedUnlocks.has(id));
    if (!fresh.length) return;
    for (const id of fresh) this.#reportedUnlocks.add(id);
    this.#onUnlock?.(fresh);
  }

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
    /** 이 세계에서 새 해금을 얻으면 (모든 판에 남기려고, 기획서 9.12) */
    onUnlock?: (ids: string[]) => void;
  }) {
    this.#lore = options.lore ?? null;
    this.#memory = options.memory ?? null;
    this.#content = options.content;
    this.mode = options.mode;
    this.path = options.path ?? null;
    this.#repo = options.repo;
    this.#rng = options.rng;
    this.#release = options.release ?? (() => {});
    this.#onUnlock = options.onUnlock ?? null;
    this.#reportedUnlocks = new Set(this.#repo.getState().unlocked ?? []);
    // 세이브와 memory 색인을 맞춘다 (모델이 바뀌었거나 지난번에 못 맞춘 기억까지)
    if (this.state().worldId) this.#syncMemory();
  }

  /** 세이브의 기억(요약·행적·믿음)을 memory 색인에 맞춘다. 저장 시점에 바로, 백그라운드로 (기획서 11.4) */
  #syncMemory(): void {
    if (!this.#memory || this.#closed) return;
    void this.#memory.sync(memoryItemsOf(this.state(), this.content, this.summaries({ all: true })));
  }

  /** 세계 id = 세이브 파일 이름 (WorldManager.open에 그대로 쓸 수 있다). 파일이 없으면 상태의 worldId */
  /**
   * 이 세계의 월드 콘텐츠. 자유 시나리오로 시작했으면 그 역할(세이브의 customRole)이 roles에 들어 있어,
   * content.roles[state.roleId]를 쓰는 곳이 모두 그대로 동작한다 (기획서 12.5)
   */
  get content(): Content {
    const role = this.#repo.getState().customRole;
    if (!role) return this.#content;
    // 상태는 이벤트마다 새로 복제되므로 역할은 내용으로 비교한다 (무소속이 무리에 들어가면 역할이 바뀐다)
    const key = `${role.id}|${role.faction}|${role.rank}|${role.label}`;
    if (this.#withRole?.role !== key) this.#withRole = { role: key, content: { ...this.#content, roles: { ...this.#content.roles, [role.id]: role } } };
    return this.#withRole.content;
  }

  get id(): string {
    return this.path ? basename(this.path, ".db") : this.#repo.getState().worldId;
  }

  state(): GameState {
    return this.#repo.getState();
  }

  /** core 규칙이 쓰는 실행 컨텍스트 */
  ctx(): ToolContext {
    // 쓰는 이벤트를 판정용으로도 쌓는 저장소 (읽기는 그대로)
    this.#store ??= {
      getState: () => this.#repo.getState(),
      events: () => this.#repo.events(),
      append: (event) => {
        const next = this.#repo.append(event);
        this.#recording?.push(event);
        return next;
      },
    };
    return { store: this.#store, rng: this.#rng, content: this.content };
  }

  isPlayerDead(): boolean {
    const state = this.state();
    return state.characters[state.playerId]?.dead === true;
  }

  /** GM 지침 (시나리오 톤 + 시작 장면 + 공통 규칙, MCP 모드면 진행 규칙 추가) */
  guide(): string {
    return buildGmGuide(this.content, this.state().roleId, this.mode, this.state());
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
    const tracked = this.#tracked(() => executeTool(name, input, this.ctx()));
    let outcome = tracked.value;
    // 시나리오 해금·클리어는 tool 결과 뒤에 GM에게 알린다. 다짐(12-164)도 tool이 끝날 때마다 본다
    const resolved = outcome.ok ? checkResolve(this.ctx()) : { lines: [], displays: [] };
    const progress = [...describeProgressNotices(tracked.notices), ...resolved.lines];
    if (outcome.ok && resolved.displays.length) outcome = { ...outcome, extra: [...(outcome.extra ?? []), ...resolved.displays] };
    if (outcome.ok && progress.length) outcome = { ...outcome, resultText: [outcome.resultText, ...progress].filter(Boolean).join("\n") };
    if (outcome.ok && !outcome.silent) {
      this.appendTranscript([outcome.display, ...(outcome.extra ?? [])].map((display) => ({ kind: "tool", display })));
    } else if (outcome.ok && outcome.extra?.length) {
      this.appendTranscript(outcome.extra.map((display) => ({ kind: "tool", display })));
    }
    if (outcome.ok && name === "take_action") this.#repo.saveSnapshot({ every: SNAPSHOT_EVERY });
    if (outcome.ok) this.#syncUnlocks();
    if (outcome.ok) this.#syncMemory();
    return outcome;
  }

  /** 치트 (개발 모드). 켜는 것은 어댑터가 정한다. 바뀐 상태는 저장하고 기억 색인도 맞춘다 */
  runCheat(input: string): { ok: true; text: string } | { ok: false; error: string } {
    const tracked = this.#tracked(() => runCheat(input, this.ctx()));
    let result = tracked.value;
    const progress = describeProgressNotices(tracked.notices);
    if (result.ok && progress.length) result = { ...result, text: [result.text, ...progress].join("\n") };
    if (result.ok) {
      this.#syncUnlocks();
      this.#repo.saveSnapshot();
      this.#syncMemory();
    }
    return result;
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
  /** 이어 갈 수 없는 시나리오(튜토리얼)에서 주인공이 죽어 이 판이 끝났는지 */
  storyEnded(): boolean {
    return storyEnded(this.state(), this.content);
  }

  /** 판이 끝난 까닭과 GM 안내 */
  storyEndedText(): string {
    return storyEndedText(this.state(), this.content);
  }

  successionOptions(): SuccessionOption[] {
    return successionOptions(this.state(), this.content);
  }

  /**
   * 사망 뒤 다음 캐릭터로 이어 간다. 대화 기록에 경계를 남겨, GM이 이전 캐릭터의 서술을 이어받지 않게 한다
   */
  chooseNextCharacter(
    choice: string,
    name: string | null = null,
    character?: CharacterChoice,
  ): { ok: true; text: string } | { ok: false; error: string } {
    const ctx = this.ctx();
    const result = switchCharacter(ctx, choice, name, character);
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
  /** 장면 정보 전체. 이번 세션의 GM이 받은 것으로 기억한다 (다음부터 바뀐 것만 보낼 기준) */
  sceneForGm(): string {
    const sections = describePlayerSections(this.state(), this.content);
    this.#rememberScene(sections);
    return sections.map((s) => s.text).join("\n\n");
  }

  /**
   * 행동 뒤의 장면 정보 (기획서 11.6 토큰): 지난번 GM에게 보낸 뒤 바뀐 덩어리만 보낸다.
   * 처음, 날짜·전투·주인공이 바뀌었을 때, SCENE_FULL_EVERY턴마다는 전체를 보낸다.
   * 구역을 옮겨도 바뀐 덩어리만 보낸다 (12-62): 구역·이 구역의 사람·엑스트라 틀이 바뀐 덩어리로 실린다
   */
  sceneUpdate(): string {
    const state = this.state();
    const sent = this.#sent;
    const anchor = this.#sceneAnchor();
    if (!sent || sent.anchor !== anchor || state.turn - sent.turn >= SCENE_FULL_EVERY) return this.sceneForGm();
    const sections = describePlayerSections(state, this.content);
    const changed = sections.filter((s) => s.key === "status" || sent.sections.get(s.key) !== s.text);
    const gone = [...sent.sections.keys()].filter((k) => !sections.some((s) => s.key === k));
    for (const s of changed) sent.sections.set(s.key, s.text);
    for (const k of gone) sent.sections.delete(k);
    const same = sections.filter((s) => !changed.includes(s)).map((s) => SCENE_SECTION_LABELS[s.key] ?? s.key);
    return [
      ...changed.map((s) => s.text),
      ...(gone.length ? [`(이제 없음: ${gone.map((k) => SCENE_SECTION_LABELS[k] ?? k).join(", ")})`] : []),
      ...(same.length ? [`(그대로라 다시 싣지 않음: ${same.join(", ")}. 전체가 필요하면 get_scene)`] : []),
    ].join("\n\n");
  }

  #sent: { sections: Map<string, string>; turn: number; anchor: string } | null = null;

  /** 이것이 바뀌면 장면 전체를 다시 보낸다 */
  #sceneAnchor(): string {
    const s = this.state();
    // 이야기가 열리고 끝나는 것은 기준이 아니다: 이야기 덩어리와 등장인물 카드가 바뀐 덩어리로 실린다 (토큰, 12-42)
    return [dayOf(s.time), s.battle ? "battle" : "", s.playerId].join("|");
  }

  #rememberScene(sections: readonly SceneSection[]) {
    this.#sent = { sections: new Map(sections.map((s) => [s.key, s.text])), turn: this.state().turn, anchor: this.#sceneAnchor() };
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

  /**
   * 메모 (12-75): 상태 화면의 메모 탭과 ?메모가 쓴다. 게임 시간을 쓰지 않는다.
   * text: 통째로 바꾼다 (화면). 채팅의 "?메모 …" 적기는 memoCommand
   */
  setMemo(text: unknown): MemoResult {
    if (typeof text !== "string") return { ok: false, error: "메모는 글로 보낸다." };
    return writeMemo(this.ctx().store, this.content, "replace", text);
  }

  /**
   * 창고 (12-149): 상태 화면에서 물건 하나를 넣거나 꺼낸다. 게임 시간을 쓰지 않는다. 규칙은 core engine/stash.ts (GM의 stash tool과 같다).
   * 바뀐 것은 이벤트로 남아 GM은 다음 장면 정보에서 본다
   */
  moveStash(input: unknown): { ok: true; text: string } | { ok: false; error: string } {
    const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const { direction, itemId, quantity } = o;
    if ((direction !== "put" && direction !== "take") || typeof itemId !== "string" || !Number.isInteger(quantity) || (quantity as number) < 1) {
      return { ok: false, error: "direction(put·take), itemId, quantity(1 이상)로 보낸다." };
    }
    const tracked = this.#tracked(() => moveStash(this.ctx(), direction, [{ item_id: itemId, quantity: quantity as number }]));
    const r = tracked.value;
    if (!r.ok) return r;
    // 꺼낸 뒤 짐이 한도를 넘었으면 다음 tool 결과에서 GM이 알린다 (stashHint). 여기서는 화면만 바뀐다
    this.#repo.saveSnapshot();
    return { ok: true, text: r.lines.join(" ") };
  }

  /**
   * 장비 착용·해제 (12-139): 상태 화면에서 무기를 들거나 방어구를 입고 벗는다. GM의 equip tool과 같은 규칙으로 돌리고,
   * 결과는 대화 기록에 남아 GM이 다음 장면에서 본다. 시간은 거의 들지 않는다
   */
  equip(input: unknown): { ok: true; text: string } | { ok: false; error: string } {
    const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const itemId = typeof o.itemId === "string" ? o.itemId : null;
    const slot = typeof o.slot === "string" ? o.slot : null;
    if (!itemId && !slot) return { ok: false, error: "itemId(입기·들기) 또는 slot(벗기)으로 보낸다." };
    const out = this.executeTool("equip", { item_id: itemId, slot: itemId ? null : slot });
    if (!out.ok) return { ok: false, error: out.error };
    this.#repo.saveSnapshot();
    return { ok: true, text: out.resultText };
  }

  /**
   * 스킬 올리기 (12-139): 상태 화면에서 레벨업(스킬 포인트)으로 스킬 하나를 +1. GM의 learn_skill tool과 같은 규칙으로 돌리고,
   * 결과는 대화 기록에 남아 GM이 본다. 게임 시간을 쓰지 않는다
   */
  learnSkill(input: unknown): { ok: true; text: string } | { ok: false; error: string } {
    const skill = input && typeof input === "object" ? (input as { skill?: unknown }).skill : undefined;
    if (typeof skill !== "string") return { ok: false, error: "올릴 스킬(skill)을 보낸다." };
    const out = this.executeTool("learn_skill", { skill });
    if (!out.ok) return { ok: false, error: out.error };
    this.#repo.saveSnapshot();
    return { ok: true, text: out.resultText };
  }

  /** 얼굴 고르기 기회 (12-139): 얼굴 없는 주인공이 시트에서 한 번 고른다. 규칙은 core game/portrait.ts */
  choosePortrait(id: unknown): { ok: true } | { ok: false; error: string } {
    const r = choosePortrait(this.ctx().store, this.content, id);
    if (r.ok) this.#repo.saveSnapshot();
    return r;
  }

  /** "?메모 내용"(덧붙이기), "?메모 고침 내용", "?메모 지움"이면 메모를 적고 결과를 돌려준다. 메모 적기가 아니면 null (읽기는 runCommand) */
  memoCommand(input: string): string | null {
    const cmd = parseMemoCommand(input);
    if (!cmd) return null;
    const r = writeMemo(this.ctx().store, this.content, cmd.mode, cmd.text);
    if (!r.ok) return r.error;
    const done = cmd.mode === "clear" ? "메모를 지웠습니다." : cmd.mode === "replace" ? "메모를 고쳤습니다." : "메모에 적었습니다.";
    return `${done}\n\n${r.text || "(비어 있음)"}`;
  }

  /** 세계 설정 (수위, 대화 형식). 상태 화면의 설정 창이 읽는다 */
  options(): GameState["options"] {
    return this.state().options;
  }

  /**
   * 세계 설정을 바꾼다 (상태 화면의 설정 창, 12-63). GM은 다음 장면 정보에서 바뀐 설정을 받는다.
   * 게임 시간을 쓰지 않는다
   */
  setOptions(patch: unknown): { ok: true; options: GameState["options"]; changed: string[] } | { ok: false; error: string } {
    const parsed = gameOptionsPatchSchema.safeParse(patch);
    if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join(" ") };
    const changed = setGameOptions(this.ctx(), parsed.data);
    return { ok: true, options: this.options(), changed };
  }

  /** 상태 화면의 시트. 일지 탭에는 ?일지와 같은 현재 캐릭터의 요약 기록을 최근 것부터 */
  playerView(): PlayerView {
    const journal = this.summaries({ limit: SHEET_JOURNAL })
      .map((s, i) => ({ key: `${i}:${s.turn}:${s.kind}`, timeLabel: formatTime(s.time), scene: s.kind === "scene", text: s.text.replace(/\s+/g, " ") }))
      .reverse();
    return { ...buildPlayerView(this.state(), this.content), journal };
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
      this.#repo.saveSnapshot();
      this.#repo.close();
    } finally {
      this.#release();
    }
  }
}
