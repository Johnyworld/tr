import { randomUUID } from "node:crypto";
import {
  createSeededRng,
  createWorldEvent,
  activeMissionOf,
  BELIEF_SOURCE_LABELS,
  checkPromotion,
  daysServed,
  describeRequirement,
  formatTime,
  INJURY_LABELS,
  RANK_LABELS,
  INJURY_PENALTY,
  isPlayerDead,
  runTurn,
  STAT_LABELS,
  STATS,
  type Content,
  type GameRepository,
  type LanguageModel,
  type Rng,
  type TranscriptEntry,
  type TurnEvent,
} from "@trpg/core";

/** UI에 보여 줄 플레이어 시트 */
export type PlayerView = {
  name: string;
  roleLabel: string;
  timeLabel: string;
  injury: string;
  injuryLabel: string;
  injuryPenalty: number;
  dead: boolean;
  stats: { id: string; label: string; value: number }[];
  inventory: { id: string; name: string; quantity: number }[];
  sceneItems: { id: string; name: string; quantity: number }[];
  present: { id: string; name: string; rankLabel: string; look: string; injuryLabel: string }[];
  service: {
    merit: number;
    disobedience: number;
    daysServed: number;
    /** 진급까지 남은 조건. 진급 대상이 아니면 null */
    promotionMissing: string[] | null;
  };
  mission: { title: string; briefing: string; deadlineLabel: string; requirements: string[] } | null;
  /** 최근 것부터 */
  beliefs: { id: string; fact: string; sourceLabel: string; learnedLabel: string }[];
};

/** UI에 보낼 대화 기록. 모델에 보낸 프롬프트 원문은 빼고 보낸다 */
export type TranscriptView =
  | { kind: "player"; text: string }
  | { kind: "gm"; text: string }
  | { kind: "tool"; display: Extract<TranscriptEntry, { kind: "tool" }>["display"] };

export class TurnInProgressError extends Error {}

export type GameSessionOptions = {
  model: LanguageModel;
  content: Content;
  /** 새 세계를 만들 때 쓸 시작 역할 (MVP: role_a_grunt 고정) */
  roleId: string;
  /** 세이브를 연다 (없으면 빈 세이브) */
  openRepository: () => GameRepository;
  /** 닫힌 세이브를 보관함으로 옮긴다 (새 게임) */
  archiveRepository?: () => void;
  rngFactory?: () => Rng;
};

/**
 * 1인용 로컬 게임이므로 서버에 세계 하나만 둔다.
 * 상태·대화 기록은 저장소(SQLite)에 있고, 서버를 다시 켜면 이어서 한다 (아이언맨: 자동 저장만).
 */
export class GameSession {
  #repo: GameRepository;
  #rng: Rng;
  #busy = false;

  constructor(private readonly options: GameSessionOptions) {
    if (!options.content.roles[options.roleId]) throw new Error(`알 수 없는 시작 역할: ${options.roleId}`);
    this.#repo = this.#open();
    this.#rng = this.#newRng();
  }

  get busy() {
    return this.#busy;
  }

  /** 지금 세계를 보관하고 새 세계를 시작한다 */
  reset() {
    if (this.#busy) throw new TurnInProgressError();
    this.#repo.close();
    this.options.archiveRepository?.();
    this.#repo = this.#open();
    this.#rng = this.#newRng();
  }

  close() {
    this.#repo.close();
  }

  isPlayerDead() {
    return isPlayerDead(this.#repo);
  }

  transcriptView(): TranscriptView[] {
    return this.#repo.transcript().map((e) => (e.kind === "player" ? { kind: "player", text: e.text } : e));
  }

  playerView(): PlayerView {
    const { content } = this.options;
    const state = this.#repo.getState();
    const player = state.characters[state.playerId]!;
    const items = (inv: Record<string, number>) =>
      Object.entries(inv).map(([id, quantity]) => ({ id, name: content.items[id]?.name ?? id, quantity }));
    return {
      name: player.name,
      roleLabel:
        content.roles[state.roleId]?.rank === player.rank
          ? (content.roles[state.roleId]?.label ?? RANK_LABELS[player.rank])
          : RANK_LABELS[player.rank],
      timeLabel: formatTime(state.time),
      injury: player.injury,
      injuryLabel: INJURY_LABELS[player.injury],
      injuryPenalty: INJURY_PENALTY[player.injury],
      dead: player.injury === "dead",
      stats: STATS.map((id) => ({ id, label: STAT_LABELS[id], value: player.stats[id] })),
      inventory: items(player.inventory),
      sceneItems: items(state.scene.items),
      present: state.scene.present.map((id) => {
        const npc = state.characters[id]!;
        return {
          id,
          name: npc.name,
          rankLabel: RANK_LABELS[npc.rank],
          look: content.npcs[id]?.look ?? "",
          injuryLabel: INJURY_LABELS[npc.injury],
        };
      }),
      service: {
        merit: player.merit,
        disobedience: player.disobedience,
        daysServed: daysServed(state.time, state.runStartedAt),
        promotionMissing:
          player.rank === "grunt" ? checkPromotion(player, state.time, state.runStartedAt).missing : null,
      },
      mission: (() => {
        const m = activeMissionOf(state.missions, player.id);
        if (!m) return null;
        return {
          title: m.title,
          briefing: m.briefing,
          deadlineLabel: formatTime(m.deadline),
          requirements: m.requirements.map((r, i) => describeRequirement(r, m.progress[i] ?? 0)),
        };
      })(),
      // 진짜 정확도(accuracy)는 UI에도 보내지 않는다
      beliefs: (state.beliefs[state.playerId] ?? [])
        .map((b) => ({
          id: b.id,
          fact: b.fact,
          sourceLabel: BELIEF_SOURCE_LABELS[b.source],
          learnedLabel: formatTime(b.learnedAt),
        }))
        .reverse(),
    };
  }

  /**
   * 턴을 실행한다. 이벤트를 흘려보내고, 끝나면 대화 기록과 스냅샷을 저장한다.
   * 소비자가 중간에 멈추면(연결 끊김) 모델 호출을 중단하고 그때까지의 기록을 남긴다.
   * 상태 이벤트는 이미 저장됐으므로 기록이 빠지면 안 된다.
   */
  async *playTurn(input: string, signal?: AbortSignal): AsyncGenerator<TurnEvent> {
    if (this.#busy) throw new TurnInProgressError();
    this.#busy = true;
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal?.addEventListener("abort", onAbort);

    const turn = runTurn({
      model: this.options.model,
      store: this.#repo,
      content: this.options.content,
      transcript: this.#repo.transcript(),
      input,
      rng: this.#rng,
      signal: abort.signal,
    });
    let step: IteratorResult<TurnEvent, TranscriptEntry[]> | undefined;
    try {
      step = await turn.next();
      while (!step.done) {
        yield step.value;
        step = await turn.next();
      }
    } finally {
      if (step && !step.done) {
        abort.abort();
        while (!step.done) step = await turn.next();
      }
      if (step?.done) {
        this.#repo.appendTranscript(step.value);
        this.#repo.saveSnapshot();
      }
      signal?.removeEventListener("abort", onAbort);
      this.#busy = false;
    }
  }

  #open(): GameRepository {
    const repo = this.options.openRepository();
    if (!repo.hasWorld()) {
      repo.append(createWorldEvent(this.options.content, this.options.roleId, randomUUID()));
      repo.saveSnapshot();
    }
    return repo;
  }

  #newRng(): Rng {
    return this.options.rngFactory?.() ?? createSeededRng(Math.floor(Math.random() * 2 ** 32));
  }
}
