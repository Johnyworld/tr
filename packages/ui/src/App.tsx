import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { fetchCommands, fetchGame, playTurn, resetGame, runCommand, type CommandInfo } from "./api.ts";
import { CharacterSheet } from "./CharacterSheet.tsx";
import { ToolCard } from "./ToolCard.tsx";
import type { PlayerView, TranscriptView } from "./types.ts";

type Notice = { kind: "error" | "info"; text: string } | null;

export function App() {
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
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const busy = live !== null;

  useEffect(() => {
    fetchGame()
      .then((game) => {
        setPlayer(game.player);
        setTranscript(game.transcript);
        setIntro({ scenarioName: game.scenarioName, opening: game.opening });
      })
      .catch((err: unknown) => setNotice({ kind: "error", text: `서버에 연결하지 못했습니다: ${String(err)}` }));
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [transcript, live]);

  useEffect(() => {
    fetchCommands().then(setCommands).catch(() => undefined);
  }, []);

  async function syncGame() {
    const game = await fetchGame();
    setPlayer(game.player);
    setTranscript(game.transcript);
    setIntro({ scenarioName: game.scenarioName, opening: game.opening });
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || busy) return;

    // "!"로 시작하면 정보 명령어: GM에게 보내지 않고 시간도 흐르지 않는다
    if (text.startsWith("!")) {
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

  async function newGame() {
    if (!window.confirm("지금 게임을 버리고 새로 시작할까요?")) return;
    try {
      const game = await resetGame();
      setPlayer(game.player);
      setTranscript(game.transcript);
      setIntro({ scenarioName: game.scenarioName, opening: game.opening });
      setNotice(null);
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

  const entries = live ? [...transcript, ...live] : transcript;
  const dead = player?.dead ?? false;

  return (
    <div className="app">
      <header className="header">
        <h1>{intro?.scenarioName ?? "TRPG"}</h1>
        <span className="subtitle">{player?.roleLabel}</span>
        {player && <span className="clock">{player.timeLabel}</span>}
        <button type="button" className="link" onClick={newGame} disabled={busy}>
          새 게임
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

          {input.startsWith("!") && !busy && (
            <div className="command-palette">
              {commands
                .filter((c) => `!${c.name}`.startsWith(input.trim().split(/\s/)[0] ?? "!"))
                .map((c) => (
                  <button key={c.name} type="button" onClick={() => setInput(`!${c.name}${c.args ? " " : ""}`)} title={c.description}>
                    !{c.name}
                  </button>
                ))}
            </div>
          )}

          {dead ? (
            <div className="composer">
              <button type="button" onClick={newGame} className="wide">
                새 캐릭터로 다시 시작
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

        {player && <CharacterSheet player={player} />}
      </div>
    </div>
  );
}

function Entry({ entry }: { entry: TranscriptView }) {
  if (entry.kind === "tool") return <ToolCard display={entry.display} />;
  if (entry.kind === "note") {
    // MCP 모드에서 GM이 남긴 서술 요약 (서술 원문은 Claude 앱에만 있다)
    return <p className="note">{entry.text}</p>;
  }
  return (
    <div className={`turn ${entry.kind}`}>
      {entry.text.split(/\n{2,}/).map((para, i) => (
        <p key={i}>{para}</p>
      ))}
    </div>
  );
}
