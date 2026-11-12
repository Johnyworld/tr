import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { chooseNextCharacter, closeGame, runCheat, fetchCommands, fetchGame, fetchSlots, playTurn, runCommand, type CommandInfo } from "./api.ts";
import { TitleScreen } from "./TitleScreen.tsx";
import { CharacterCreation } from "./CharacterCreation.tsx";
import { CharacterSheet } from "./CharacterSheet.tsx";
import { Entry } from "./Entry.tsx";
import { DevPanel } from "./DevPanel.tsx";
import type { GameView, PlayerView, TranscriptView } from "./types.ts";

/** 정보 명령어 입력인지 (core COMMAND_PREFIXES와 같다. UI는 core 런타임을 번들하지 않는다) */
const isCommandInput = (text: string) => /^\s*[!?！？]/.test(text);

type Notice = { kind: "error" | "info"; text: string } | null;

/** 시작 화면(세이브 슬롯)과 게임 화면 */
export function App() {
  const [game, setGame] = useState<GameView | null>(null);
  const [checked, setChecked] = useState(false);
  const [creating, setCreating] = useState(false);

  // 새로고침: 이미 열린 세계가 있으면 그대로 이어서 보여 준다
  useEffect(() => {
    fetchSlots()
      .then(async (s) => {
        if (s.current) setGame(await fetchGame());
      })
      .catch(() => undefined)
      .finally(() => setChecked(true));
  }, []);

  if (!checked) return null;
  if (!game && creating) {
    return (
      <CharacterCreation
        onStart={(g) => {
          setCreating(false);
          setGame(g);
        }}
        onBack={() => setCreating(false)}
      />
    );
  }
  if (!game) return <TitleScreen onStart={setGame} onCreate={() => setCreating(true)} />;
  return <Game key={game.worldId} initial={game} onExit={() => setGame(null)} />;
}

function Game({ initial, onExit }: { initial: GameView; onExit: () => void }) {
  const [player, setPlayer] = useState<PlayerView | null>(null);
  const [intro, setIntro] = useState<{ scenarioName: string; opening: string } | null>(null);
  const [transcript, setTranscript] = useState<TranscriptView[]>([]);
  /** 진행 중인 턴의 기록. null이면 진행 중이 아님 */
  const [live, setLive] = useState<TranscriptView[] | null>(null);
  const [input, setInput] = useState("");
  /** 정보 명령어 결과 (읽기 전용이라 세이브에 남기지 않고 화면에만 보여 준다) */
  const [commandOutput, setCommandOutput] = useState<{ input: string; output: string } | null>(null);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [notice, setNotice] = useState<Notice>(null);
  /** 사망했을 때: 연대기와 다음 캐릭터 후보 */
  const [succession, setSuccession] = useState<GameView["succession"]>(null);
  /** 사망 뒤 새 캐릭터를 생성 화면에서 만드는 중 */
  const [creatingHeir, setCreatingHeir] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const busy = live !== null;

  useEffect(() => {
    applyGame(initial);
  }, [initial]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [transcript, live]);

  useEffect(() => {
    fetchCommands().then(setCommands).catch(() => undefined);
  }, []);

  function applyGame(game: GameView) {
    setPlayer(game.player);
    setTranscript(game.transcript);
    setIntro({ scenarioName: game.scenarioName, opening: game.opening });
    setSuccession(game.succession);
  }

  async function syncGame() {
    applyGame(await fetchGame());
  }

  async function pickHeir(id: string) {
    // 새 캐릭터는 새 게임과 같은 생성 화면에서 만든다
    if (id === "new") {
      setCreatingHeir(true);
      return;
    }
    try {
      applyGame(await chooseNextCharacter(id, null));
      setNotice(null);
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    }
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || busy) return;

    // "~"로 시작하면 치트 (개발 모드): GM에게 보내지 않는다
    if (text.startsWith("~")) {
      try {
        const r = await runCheat(text);
        applyGame(r.game);
        setCommandOutput({ input: text, output: r.output });
        setInput("");
      } catch (err) {
        setNotice({ kind: "error", text: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // "!"(또는 "?")로 시작하면 정보 명령어: GM에게 보내지 않고 시간도 흐르지 않는다
    if (isCommandInput(text)) {
      try {
        setCommandOutput({ input: text, output: await runCommand(text) });
        setInput("");
      } catch (err) {
        setNotice({ kind: "error", text: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setInput("");
    setNotice(null);
    let turn: TranscriptView[] = [{ kind: "player", text }];
    setLive(turn);
    let narrated = false;

    try {
      for await (const event of playTurn(text, controller.signal)) {
        switch (event.type) {
          case "text": {
            narrated = true;
            const last = turn.at(-1);
            turn =
              last?.kind === "gm"
                ? [...turn.slice(0, -1), { kind: "gm", text: last.text + event.text }]
                : [...turn, { kind: "gm", text: event.text }];
            setLive(turn);
            break;
          }
          case "tool":
            turn = [...turn, { kind: "tool", display: event.display }];
            setLive(turn);
            break;
          case "player":
            setPlayer(event.player);
            break;
          case "error":
            setNotice({ kind: "error", text: event.message });
            break;
          case "done":
            if (event.stopReason === "refusal") {
              setNotice({ kind: "error", text: "GM이 이 장면의 서술을 거절했습니다. 다른 행동을 시도해 보세요." });
            } else if (event.stopReason === "max_tokens") {
              setNotice({ kind: "info", text: "서술이 길이 제한으로 잘렸습니다." });
            }
            break;
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setNotice({ kind: "error", text: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      abortRef.current = null;
      // 서버가 진짜 기록을 들고 있으므로 끝나면 다시 받아 온다
      await syncGame().catch(() => undefined);
      setLive(null);
      if (!narrated && turn.length === 1) setInput(text);
    }
  }

  /** 게임을 닫고 시작 화면으로. 진행은 행동마다 자동 저장돼 있다 */
  async function exitToTitle() {
    try {
      await closeGame();
      onExit();
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  if (creatingHeir) {
    return (
      <CharacterCreation
        title="새 캐릭터로 이어 가기"
        note="같은 세계에서 새로 시작한다. 이전 캐릭터의 기억은 모른다."
        submit={(choice) => chooseNextCharacter("new", null, choice)}
        onStart={(g) => {
          setCreatingHeir(false);
          applyGame(g);
          setNotice(null);
        }}
        onBack={() => setCreatingHeir(false)}
      />
    );
  }

  const entries = live ? [...transcript, ...live] : transcript;
  const dead = player?.dead ?? false;

  return (
    <div className="app">
      <header className="header">
        <h1>{intro?.scenarioName ?? "TRPG"}</h1>
        <span className="subtitle">{player?.roleLabel}</span>
        {player && <span className="clock">{player.timeLabel}</span>}
        <button type="button" className="link" onClick={exitToTitle} disabled={busy} title="진행은 자동 저장돼 있다">
          메인 화면
        </button>
      </header>

      <div className="body">
        <main className="main">
          <div className="log" ref={logRef} aria-live="polite">
            {intro && <p className="opening">{intro.opening}</p>}
            {entries.map((entry, i) => (
              <Entry key={i} entry={entry} />
            ))}
            {busy && <span className="cursor" />}
            {dead && !busy && <p className="death">당신의 이야기는 여기서 끝났다.</p>}
          </div>

          {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}

          {commandOutput && (
            <div className="command-output">
              <div className="command-head">
                <span>{commandOutput.input}</span>
                <button type="button" className="link" onClick={() => setCommandOutput(null)}>
                  닫기
                </button>
              </div>
              <pre>{commandOutput.output}</pre>
            </div>
          )}

          {isCommandInput(input) && !busy && (
            <div className="command-palette">
              {commands
                .filter((c) => c.name.startsWith(input.trim().slice(1).split(/\s/)[0] ?? ""))
                .map((c) => (
                  <button key={c.name} type="button" onClick={() => setInput(`!${c.name}${c.args ? " " : ""}`)} title={c.description}>
                    !{c.name}
                  </button>
                ))}
            </div>
          )}

          {dead ? (
            <div className="succession">
              {succession && (
                <>
                  <h3>연대기</h3>
                  <pre>{succession.chronicle}</pre>
                  <h3>누구로 이어 갈까</h3>
                  <ul>
                    {succession.options.map((o) => (
                      <li key={o.id}>
                        <button type="button" onClick={() => void pickHeir(o.id)} disabled={busy}>
                          {o.label}
                        </button>
                        <span className="muted small"> {o.detail}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <button type="button" onClick={exitToTitle} className="link">
                메인 화면으로 (이 세계는 저장된 채로 남는다)
              </button>
            </div>
          ) : (
            <form className="composer" onSubmit={send}>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="행동이나 대사를 입력하세요. !도움말 로 정보 명령어 (Enter 전송, Shift+Enter 줄바꿈)"
                rows={2}
                disabled={busy}
                autoFocus
              />
              {busy ? (
                <button type="button" onClick={() => abortRef.current?.abort()} className="secondary">
                  중단
                </button>
              ) : (
                <button type="submit" disabled={!input.trim()}>
                  행동
                </button>
              )}
            </form>
          )}
        </main>

        {player && (
          <div className="side">
            <CharacterSheet player={player} />
            <DevPanel refreshKey={transcript} />
          </div>
        )}
      </div>
    </div>
  );
}
