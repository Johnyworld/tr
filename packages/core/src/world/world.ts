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
import { runCommand } from "../commands/commands.ts";
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
  #closed = false;

  constructor(options: {
    content: Content;
    repo: GameRepository;
    mode: PlayMode;
    rng: Rng;
    path?: string;
    release?: () => void;
  }) {
    this.content = options.content;
    this.mode = options.mode;
    this.path = options.path ?? null;
    this.#repo = options.repo;
    this.#rng = options.rng;
    this.#release = options.release ?? (() => {});
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
    this.#repo.appendSummary({ kind, text: text.trim(), turn: state.turn, time: state.time, mode: this.mode });
  }

  summaries(options?: { kind?: TurnSummary["kind"]; limit?: number }): TurnSummary[] {
    return this.#repo.summaries(options);
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

  /** 정보 명령어 (읽기 전용, 시간을 쓰지 않는다) */
  runCommand(input: string): string {
    return runCommand(input, { state: this.state(), content: this.content, summaries: this.summaries() });
  }

  /** 빨리감기: 지정한 시간대가 될 때까지 기다린다 (끼어들기가 생기면 멈춤). take_action과 같은 경로다 */
  fastForward(until: TimeSegment): ReturnType<GameWorld["executeTool"]> {
    return this.executeTool("take_action", {
      intent: "기다린다",
      check: null,
      activity: { kind: "wait", until },
      deed: null,
      target: null,
      narration_summary: null,
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
    const role = this.content.roles[this.state().roleId];
    return { worldId: this.id, scenarioName: this.content.scenario.name, opening: role?.opening_scene ?? "" };
  }

  saveSnapshot(): void {
    this.#repo.saveSnapshot();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#repo.close();
    } finally {
      this.#release();
    }
  }
}
