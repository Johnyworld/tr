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
      <header className="header status-header">
        <div className="hdr-left">
          <h1 className="hdr-title">{status?.scenarioName ?? "TRPG"}</h1>
          {status?.open && <HeaderDate player={status.player} />}
        </div>
        {status?.open && status.player.clock?.minute !== undefined && <SunDial clock={status.player.clock} />}
        <div className="hdr-right">
          <span className={connected ? "status-live" : "status-live off"} title={connected ? "Claude 세션과 연결됨" : "연결 끊김 (Claude 세션이 닫혔나요?)"}>
            <span className="live-dot" aria-hidden="true" />
            {connected ? "연결됨" : "연결 끊김"}
          </span>
          <SettingsButton enabled={connected && status?.open === true} />
        </div>
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
        <p className="muted status-empty">열린 게임이 없습니다. Claude 세션에서 /play로 게임을 열면 여기에 캐릭터 시트가 나옵니다.</p>
      ) : (
        <div key="sheet" className="status-sheet">
          {created && <CreatedToast onClose={closeToast} />}
          <CharacterSheet player={status.player} />
        </div>
      )}
    </div>
  );
}

/** 날씨 아이콘 색 (아이콘 이름별). 모르는 이름은 흐린 글자색 */
const SKY = "#7fc8ff";
const GRAY = "#9aa3b2";
const WEATHER_TONE: Record<string, string> = {
  sun: "#f5b82e", // 맑음: 노랑
  cloud: GRAY, // 흐림
  fog: GRAY, // 안개
  rain: SKY, // 비: 하늘색
  snow: "#ffffff", // 눈: 흰색
  cold: SKY, // 한파: 하늘색
};

/** 머리 왼쪽 아래 줄: 달력 날짜 · 계절, 날씨 아이콘 (며칠째인지는 일지에서) */
function HeaderDate({ player }: { player: PlayerView }) {
  const c = player.clock;
  if (!c) return <div className="hdr-date">{player.timeLabel}</div>;
  const w = c.weather;
  return (
    <div className="hdr-date">
      <span>{[c.date, c.season].filter(Boolean).join(" · ")}</span>
      {w && (
        <span
          className={w.chill >= 2 ? "hdr-weather bad" : w.chill === 1 ? "hdr-weather warn" : "hdr-weather"}
          style={{ color: WEATHER_TONE[w.icon ?? ""] }}
          title={w.chill ? `${w.label} · 추위가 스며드는 날씨` : w.label}
          aria-label={w.label}
        >
          <Icon name={w.icon ?? "cloud"} size={16} />
        </span>
      )}
    </div>
  );
}

/** 해·달 반원 (12-71): 낮(6~18시)은 해가, 밤은 달이 반원을 따라 움직인다. 가운데 아래에 시각 */
const DIAL = { w: 62, h: 36, r: 28 };
function SunDial({ clock }: { clock: NonNullable<PlayerView["clock"]> }) {
  const minute = clock.minute ?? 0;
  const day = minute >= 360 && minute < 1080;
  const p = day ? (minute - 360) / 720 : (((minute - 1080 + 1440) % 1440) / 720);
  const cx = DIAL.w / 2;
  const cy = DIAL.h - 2;
  const x = cx - DIAL.r * Math.cos(p * Math.PI);
  const y = cy - DIAL.r * Math.sin(p * Math.PI);
  return (
    <div className="sun-dial" title={`${clock.hhmm} (${clock.segmentLabel})`}>
      <svg width={DIAL.w} height={DIAL.h} viewBox={`0 0 ${DIAL.w} ${DIAL.h}`} aria-hidden="true">
        <path d={`M${cx - DIAL.r} ${cy} A${DIAL.r} ${DIAL.r} 0 0 1 ${cx + DIAL.r} ${cy}`} fill="none" stroke="var(--border)" strokeWidth={2} strokeLinecap="round" />
      </svg>
      <span className={day ? "dial-body sun" : "dial-body moon"} style={{ left: x, top: y }}>
        <Icon name={day ? "sun" : "moon"} size={14} />
      </span>
      <span className="dial-time">{clock.hhmm ?? clock.time}</span>
    </div>
  );
}
