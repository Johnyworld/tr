import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ChatTurn } from "@trpg/core";
import { OPENING_SCENE } from "@trpg/core/scene";
import { streamChat } from "./api.ts";

type Notice = { kind: "error" | "info"; text: string } | null;

export function App() {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const busy = streamingText !== null;

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [turns, streamingText]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || busy) return;

    const history = turns;
    const controller = new AbortController();
    abortRef.current = controller;
    setTurns([...history, { role: "player", text }]);
    setInput("");
    setNotice(null);
    setStreamingText("");

    let narration = "";
    try {
      for await (const event of streamChat(history, text, controller.signal)) {
        if (event.type === "text") {
          narration += event.text;
          setStreamingText(narration);
        } else if (event.type === "error") {
          setNotice({ kind: "error", text: event.message });
        } else if (event.stopReason === "refusal") {
          setNotice({ kind: "error", text: "GM이 이 장면의 서술을 거절했습니다. 다른 행동을 시도해 보세요." });
        } else if (event.stopReason === "max_tokens") {
          setNotice({ kind: "info", text: "서술이 길이 제한으로 잘렸습니다." });
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setNotice({ kind: "error", text: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      abortRef.current = null;
      setStreamingText(null);
      if (narration) {
        setTurns((prev) => [...prev, { role: "gm", text: narration }]);
      } else {
        // 서술이 하나도 안 왔으면 입력을 되돌려 다시 보낼 수 있게 한다
        setTurns(history);
        setInput(text);
      }
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="app">
      <header className="header">
        <h1>TRPG</h1>
        <span className="subtitle">세력 A · 하급 전투원</span>
      </header>

      <div className="log" ref={logRef} aria-live="polite">
        {turns.length === 0 && !busy && (
          <p className="empty">
            {OPENING_SCENE}
            <br />
            무엇을 하시겠습니까?
          </p>
        )}
        {turns.map((turn, i) => (
          <Turn key={i} turn={turn} />
        ))}
        {busy && (
          <div className="turn gm">
            <p>
              {streamingText}
              <span className="cursor" />
            </p>
          </div>
        )}
      </div>

      {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}

      <form className="composer" onSubmit={send}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="행동이나 대사를 입력하세요 (Enter 전송, Shift+Enter 줄바꿈)"
          rows={2}
          disabled={busy}
          autoFocus
        />
        {busy ? (
          <button type="button" onClick={stop} className="secondary">
            중단
          </button>
        ) : (
          <button type="submit" disabled={!input.trim()}>
            행동
          </button>
        )}
      </form>
    </div>
  );
}

function Turn({ turn }: { turn: ChatTurn }) {
  return (
    <div className={`turn ${turn.role}`}>
      {turn.text.split(/\n{2,}/).map((para, i) => (
        <p key={i}>{para}</p>
      ))}
    </div>
  );
}
