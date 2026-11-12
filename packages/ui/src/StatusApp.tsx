import { useEffect, useRef, useState } from "react";
import { CharacterSheet } from "./CharacterSheet.tsx";
import { Entry } from "./Entry.tsx";
import type { PlayerView, TranscriptView } from "./types.ts";

/** MCP 상태 API 응답 (packages/mcp/src/statusServer.ts 와 맞춘다) */
type StatusView =
  | { open: false; scenarioName: string }
  | {
      open: true;
      scenarioName: string;
      worldId: string;
      opening?: string;
      player: PlayerView;
      log?: TranscriptView[];
      /** 이전 버전 MCP 서버 (최근 결과만, 최신 먼저) */
      recent?: TranscriptView[];
    };

type Tab = "story" | "sheet";

/**
 * MCP 모드의 상태 화면: Claude 앱 옆(브라우저 패널)에 띄워 두는 읽기 전용 화면.
 * 웹 앱과 같은 컴포넌트(Entry, ToolCard, CharacterSheet)로 이야기와 시트를 보여 준다.
 * SSE로 바뀔 때마다 받는다 (연결돼 있는 동안 GM은 서술을 여기로 보낸다). 끊기면 다시 붙는다
 */
export function StatusApp() {
  const [status, setStatus] = useState<StatusView | null>(null);
  const [connected, setConnected] = useState(false);
  const [tab, setTab] = useState<Tab>("story");
  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    let stop = false;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let received = false;
    // SSE를 못 쓰면 (이전 버전의 MCP 서버 등) 1.5초 폴링으로 읽는다
    const poll = async () => {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        setStatus((await res.json()) as StatusView);
        setConnected(true);
      } catch {
        setConnected(false);
      }
      if (!stop) timer = setTimeout(() => void poll(), 1500);
    };
    es = new EventSource("/api/status/stream");
    es.onopen = () => setConnected(true);
    es.onmessage = (e) => {
      received = true;
      setConnected(true);
      setStatus(JSON.parse(e.data as string) as StatusView);
    };
    es.onerror = () => {
      setConnected(false);
      if (!received) {
        // 한 번도 받지 못했으면 SSE가 없는 서버다
        es?.close();
        es = null;
        void poll();
      }
    };
    return () => {
      stop = true;
      es?.close();
      if (timer) clearTimeout(timer);
    };
  }, []);

  // 맨 아래를 보고 있었으면 새 기록이 올 때 따라 내려간다.
  // 플레이어가 새로 말했으면(새 player 기록) 위로 올려 읽던 중이라도 맨 아래로 간다
  const seen = useRef(0);
  useEffect(() => {
    const el = logRef.current;
    const log = status?.open ? (status.log ?? []) : [];
    if (log.length < seen.current) seen.current = 0; // 다른 게임
    if (log.slice(seen.current).some((e) => e.kind === "player")) stick.current = true;
    seen.current = log.length;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight });
  }, [status, tab]);

  const onScroll = () => {
    const el = logRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  return (
    <div className="status-page">
      <header className="header">
        <h1>{status?.scenarioName ?? "TRPG"}</h1>
        {status?.open && <span className="clock">{status.player.timeLabel}</span>}
        <span className={connected ? "status-live" : "status-live off"} title={connected ? "Claude 세션과 연결됨" : "연결 끊김 (Claude 세션이 닫혔나요?)"}>
          {connected ? "●" : "○ 연결 끊김"}
        </span>
      </header>
      {!status ? (
        <p className="muted status-empty">불러오는 중…</p>
      ) : !status.open ? (
        <p className="muted status-empty">열린 게임이 없다. Claude 세션에서 /play 로 게임을 열면 여기에 이야기와 상태가 나온다.</p>
      ) : (
        <>
          <nav className="status-tabs" aria-label="보기">
            <button type="button" className={tab === "story" ? "on" : ""} onClick={() => setTab("story")}>
              이야기
            </button>
            <button type="button" className={tab === "sheet" ? "on" : ""} onClick={() => setTab("sheet")}>
              시트
            </button>
          </nav>
          <div className={`status-body tab-${tab}`}>
            <div className="log status-log" ref={logRef} onScroll={onScroll} aria-live="polite">
              {status.opening && <p className="opening">{status.opening}</p>}
              {(status.log ?? [...(status.recent ?? [])].reverse()).map((entry, i) => (
                <Entry key={i} entry={entry} />
              ))}
              {status.player.dead && <p className="death">당신의 이야기는 여기서 끝났다.</p>}
            </div>
            <div className="status-sheet">
              <CharacterSheet player={status.player} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
