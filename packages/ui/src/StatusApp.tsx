import { useCallback, useEffect, useRef, useState } from "react";
import { CharacterSheet } from "./CharacterSheet.tsx";
import { SettingsButton } from "./Settings.tsx";
import { Icon } from "./Icon.tsx";
import { CreatedToast, NewGame } from "./NewGame.tsx";
import type { CreationStatus, PlayerView } from "./types.ts";

/** MCP 상태 API 응답 (packages/mcp/src/statusServer.ts 와 맞춘다) */
type StatusView =
  | { open: false; scenarioName: string; creating?: boolean; creation?: CreationStatus | null }
  | { open: true; scenarioName: string; worldId: string; player: PlayerView };

/**
 * MCP 모드의 상태 화면: Claude 앱 옆(브라우저 패널)에 띄워 두는 캐릭터 시트. 바꿀 수 있는 것은 설정(톱니바퀴)과,
 * Claude 세션이 화면 고르기를 열었을 때의 새 게임 고르기(12-67)뿐이다.
 * 이야기(서술)는 Claude 세션의 채팅에 있다.
 * SSE로 바뀔 때마다 받고, SSE가 없는 서버면 1.5초 폴링으로 읽는다
 */
export function StatusApp() {
  const [status, setStatus] = useState<StatusView | null>(null);
  const [connected, setConnected] = useState(false);
  // 화면에서 고르다가 세계가 열리면 "채팅으로 돌아가라"를 잠깐 띄운다
  const [created, setCreated] = useState(false);
  const wasCreating = useRef(false);
  useEffect(() => {
    if (!status) return;
    const creatingHere = !status.open && !!status.creation;
    if (wasCreating.current && status.open) setCreated(true);
    wasCreating.current = creatingHere;
  }, [status]);
  const closeToast = useCallback(() => setCreated(false), []);

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
        <div className="world-title">
          <h1>{status?.scenarioName ?? "TRPG"}</h1>
          {status?.open && <WorldTime player={status.player} />}
        </div>
        <span className={connected ? "status-live" : "status-live off"} title={connected ? "Claude 세션과 연결됨" : "연결 끊김 (Claude 세션이 닫혔나요?)"}>
          {connected ? "●" : "○ 연결 끊김"}
        </span>
        <SettingsButton enabled={connected && status?.open === true} />
      </header>
      {!status ? (
        <p className="muted status-empty">불러오는 중…</p>
      ) : !status.open && status.creation ? (
        <div key="newgame" className="status-sheet">
          <NewGame creation={status.creation} />
        </div>
      ) : !status.open && status.creating ? (
        // Claude 세션에서 대화로 캐릭터를 만드는 중. 다 만들면 첫 장면과 함께 시트가 열린다
        <div key="creating" className="status-created">
          <h2>캐릭터를 만드는 중</h2>
          <p>Claude 세션에서 한 단계씩 정하고 있습니다. 다 만들면 이곳에 캐릭터 시트가 열립니다.</p>
        </div>
      ) : !status.open ? (
        <p className="muted status-empty">열린 게임이 없다. Claude 세션에서 /play 로 게임을 열면 여기에 캐릭터 시트가 나온다.</p>
      ) : (
        <div key="sheet" className="status-sheet">
          {created && <CreatedToast onClose={closeToast} />}
          <CharacterSheet player={status.player} />
        </div>
      )}
    </div>
  );
}

/** 월드 이름 아래 시계 (12-66): 시간대마다 색이 바뀌고, 날씨는 아이콘. 추위를 부르는 날씨는 노랑, 많이 부르면 빨강 */
function WorldTime({ player }: { player: PlayerView }) {
  const c = player.clock;
  if (!c) return <div className="world-time">{player.timeLabel}</div>;
  const w = c.weather;
  return (
    <div className="world-time">
      <span className={`clock-time seg-${c.segment}`}>{c.time}</span>
      {c.season && <span className="clock-sep">{c.season}</span>}
      {w && (
        <span className={w.chill >= 2 ? "clock-weather bad" : w.chill === 1 ? "clock-weather warn" : "clock-weather"} title={w.chill ? "추위가 스며드는 날씨" : undefined}>
          {w.icon && <Icon name={w.icon} size={13} />}
          {w.label}
        </span>
      )}
    </div>
  );
}
