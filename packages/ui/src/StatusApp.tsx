import { useEffect, useState } from "react";
import { CharacterSheet } from "./CharacterSheet.tsx";
import { ToolCard } from "./ToolCard.tsx";
import type { PlayerView, TranscriptView } from "./types.ts";

/** MCP 상태 API 응답 (packages/mcp/src/statusServer.ts 와 맞춘다) */
type StatusView =
  | { open: false; scenarioName: string }
  | { open: true; scenarioName: string; worldId: string; player: PlayerView; recent: TranscriptView[] };

const POLL_MS = 1500;

/**
 * MCP 모드의 상태 화면: Claude 앱 옆(브라우저 패널)에 띄워 두는 읽기 전용 캐릭터 시트.
 * 웹 앱과 같은 컴포넌트(CharacterSheet, ToolCard)를 쓰고, 지금 MCP 세션이 연 게임을 보여 준다
 */
export function StatusApp() {
  const [status, setStatus] = useState<StatusView | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let stop = false;
    let last = "";
    const poll = async () => {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        const text = await res.text();
        if (text !== last) {
          last = text;
          setStatus(JSON.parse(text) as StatusView);
        }
        setOffline(false);
      } catch {
        setOffline(true);
      }
      if (!stop) setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      stop = true;
    };
  }, []);

  return (
    <div className="status-page">
      <header className="header">
        <h1>{status?.scenarioName ?? "TRPG"}</h1>
        {status?.open && <span className="clock">{status.player.timeLabel}</span>}
        <span className="subtitle status-live">{offline ? "연결 끊김 (Claude 세션이 닫혔나요?)" : "Claude 세션과 연결됨"}</span>
      </header>
      {!status ? (
        <p className="muted">불러오는 중…</p>
      ) : !status.open ? (
        <p className="muted status-empty">열린 게임이 없다. Claude 세션에서 /play 로 게임을 열면 여기에 상태가 나온다.</p>
      ) : (
        <>
          <CharacterSheet player={status.player} />
          {status.recent.length > 0 && (
            <section className="status-recent">
              <h3>최근 결과</h3>
              {status.recent.map((entry, i) =>
                entry.kind === "tool" ? <ToolCard key={i} display={entry.display} /> : <p key={i} className="note">{entry.text}</p>,
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
