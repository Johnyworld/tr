import {
  createInitialState,
  createSeededRng,
  InMemoryGameStore,
  INJURY_LABELS,
  INJURY_PENALTY,
  isPlayerDead,
  runTurn,
  STAT_LABELS,
  STATS,
  type GameStore,
  type LanguageModel,
  type Rng,
  type TranscriptEntry,
  type TurnEvent,
} from "@trpg/core";

/** UI에 보여 줄 플레이어 시트 */
export type PlayerView = {
  name: string;
  injury: string;
  injuryLabel: string;
  injuryPenalty: number;
  dead: boolean;
  stats: { id: string; label: string; value: number }[];
  inventory: { id: string; name: string; quantity: number }[];
  sceneItems: { id: string; name: string; quantity: number }[];
};

/** UI에 보낼 대화 기록. 모델에 보낸 프롬프트 원문은 빼고 보낸다 */
export type TranscriptView =
  | { kind: "player"; text: string }
  | { kind: "gm"; text: string }
  | { kind: "tool"; display: Extract<TranscriptEntry, { kind: "tool" }>["display"] };

export class TurnInProgressError extends Error {}

/**
 * 1인용 로컬 게임이므로 서버에 게임 하나만 둔다.
 * 4단계에서 GameStore와 대화 기록을 SQLite로 옮긴다.
 */
export class GameSession {
  #store: GameStore;
  #transcript: TranscriptEntry[] = [];
  #rng: Rng;
  #busy = false;

  constructor(
    private readonly model: LanguageModel,
    private readonly rngFactory: () => Rng = () => createSeededRng(Math.floor(Math.random() * 2 ** 32)),
  ) {
    this.#store = new InMemoryGameStore(createInitialState());
    this.#rng = rngFactory();
  }

  get busy() {
    return this.#busy;
  }

  reset() {
    if (this.#busy) throw new TurnInProgressError();
    this.#store = new InMemoryGameStore(createInitialState());
    this.#transcript = [];
    this.#rng = this.rngFactory();
  }

  isPlayerDead() {
    return isPlayerDead(this.#store);
  }

  transcriptView(): TranscriptView[] {
    return this.#transcript.map((e) => (e.kind === "player" ? { kind: "player", text: e.text } : e));
  }

  playerView(): PlayerView {
    const state = this.#store.getState();
    const player = state.characters[state.playerId]!;
    const items = (inv: Record<string, number>) =>
      Object.entries(inv).map(([id, quantity]) => ({ id, name: state.items[id]?.name ?? id, quantity }));
    return {
      name: player.name,
      injury: player.injury,
      injuryLabel: INJURY_LABELS[player.injury],
      injuryPenalty: INJURY_PENALTY[player.injury],
      dead: player.injury === "dead",
      stats: STATS.map((id) => ({ id, label: STAT_LABELS[id], value: player.stats[id] })),
      inventory: items(player.inventory),
      sceneItems: items(state.scene.items),
    };
  }

  /**
   * 턴을 실행한다. 이벤트를 흘려보내고, 끝나면 대화 기록에 붙인다.
   * 소비자가 중간에 멈추면(연결 끊김) 모델 호출을 중단하고 그때까지의 기록을 남긴다.
   * 상태 이벤트는 이미 적용됐으므로 기록이 빠지면 안 된다.
   */
  async *playTurn(input: string, signal?: AbortSignal): AsyncGenerator<TurnEvent> {
    if (this.#busy) throw new TurnInProgressError();
    this.#busy = true;
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal?.addEventListener("abort", onAbort);

    const turn = runTurn({
      model: this.model,
      store: this.#store,
      transcript: this.#transcript,
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
      if (step?.done) this.#transcript.push(...step.value);
      signal?.removeEventListener("abort", onAbort);
      this.#busy = false;
    }
  }
}
