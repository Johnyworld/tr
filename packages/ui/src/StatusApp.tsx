import { useEffect, useState } from "react";
import { CharacterCreation } from "./CharacterCreation.tsx";
import { CharacterSheet } from "./CharacterSheet.tsx";
import type { PlayerView } from "./types.ts";

/** MCP 상태 API 응답 (packages/mcp/src/statusServer.ts 와 맞춘다) */
type StatusView =
  | { open: false; scenarioName: string; creating?: boolean; created?: boolean; name?: string }
  | { open: true; scenarioName: string; worldId: string; player: PlayerView };

/**
 * MCP 모드의 상태 화면: Claude 앱 옆(브라우저 패널)에 띄워 두는 읽기 전용 캐릭터 시트.
 * 웹 앱과 같은 CharacterSheet를 쓴다. 이야기(서술)는 Claude 세션의 채팅에 있다.
 * SSE로 바뀔 때마다 받고, SSE가 없는 서버면 1.5초 폴링으로 읽는다
 */
export function StatusApp() {
  const [status, setStatus] = useState<StatusView | null>(null);
  const [connected, setConnected] = useState(false);
  /** 브라우저에서 생성을 마쳤다 (Claude 세션이 이어 받을 때까지 잠깐) */
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    if (status?.open) setSubmitted(false);
    window.scrollTo({ top: 0 }); // 생성 화면에서 시트로 바뀌면 맨 위부터
  }, [status?.open]);

  useEffect(() => {
    let stop = false;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let received = false;
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
      ) : !status.open && status.creating && !submitted ? (
        // Claude 세션이 브라우저 생성을 기다리고 있다: 웹 앱과 같은 생성 화면
        <div className="status-creation">
          <CharacterCreation onStart={() => setSubmitted(true)} />
        </div>
      ) : !status.open && (submitted || status.created) ? (
        // 만들고 나서 GM이 첫 장면을 쓰는 동안: 세션으로 돌아가라는 안내. 첫 장면이 끝나면 시트가 열린다
        <div className="status-created">
          <h2>캐릭터를 만들었습니다</h2>
          <p>{status.created && status.name ? `${status.name}의 이야기가` : "이야기가"} Claude 세션에서 시작됩니다. 세션으로 돌아가 첫 장면을 확인하세요.</p>
          <p className="muted small">첫 장면이 나오면 이곳에 캐릭터 시트가 열립니다.</p>
        </div>
      ) : !status.open ? (
        <p className="muted status-empty">열린 게임이 없다. Claude 세션에서 /play 로 게임을 열면 여기에 캐릭터 시트가 나온다.</p>
      ) : (
        <div className="status-sheet">
          <CharacterSheet player={status.player} />
        </div>
      )}
    </div>
  );
}
