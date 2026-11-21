import { useCallback, useEffect, useRef, useState } from "react";
import { CharacterSheet } from "./CharacterSheet.tsx";
import { SettingsButton } from "./Settings.tsx";
import { Icon } from "./Icon.tsx";
import { canGoBack, canGoMenu, CreatedToast, NewGame, newGameTitle, postCreation } from "./NewGame.tsx";
import { MainMenu } from "./MainMenu.tsx";
import type { CreationStatus, GmLink, PlayerView } from "./types.ts";

/** MCP 상태 API 응답 (packages/mcp/src/statusServer.ts 와 맞춘다) */
/** 아직 닫지 않은 시나리오 해금 알림 (기획서 12.4.1) */
type UnlockNotice = { pack: string; roleId: string; title: string; particle?: string };

type StatusView = (
  | { open: false; scenarioName: string; creating?: boolean; creation?: CreationStatus | null }
  | { open: true; scenarioName: string; worldId: string; player: PlayerView }
) & { unlockNotices?: UnlockNotice[]; gm?: GmLink };

/**
 * MCP 모드의 상태 화면: Claude 앱 옆(브라우저 패널)에 띄워 두는 화면. 세 화면으로 나뉜다 (12-214):
 * 메인 메뉴(열린 게임도 만드는 캐릭터도 없을 때) / 캐릭터 만들기(12-67, 채팅으로 만들어도 따라 그린다) / 캐릭터 시트.
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
  // 새 게임 고르기에서 답을 보내면 응답에 실린 화면을 바로 쓴다
  const applyStatus = useCallback((s: unknown) => setStatus(s as StatusView), []);

  useEffect(() => {
    let stop = false;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let received = false;
    const open = () => {
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
    };
    // 패널이 숨겨졌다 다시 보이거나 창이 앞으로 오면 한 번 새로 받는다. 연결이 끊겨 있었으면 다시 잇는다
    // (숨겨진 패널에서는 실시간 연결이 멈추거나 끊길 수 있다)
    const refresh = async () => {
      if (stop || document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        setStatus((await res.json()) as StatusView);
        setConnected(true);
      } catch {
        setConnected(false);
      }
      if (received && es?.readyState === EventSource.CLOSED) open();
    };
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
    open();
    const onVisible = () => void refresh();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      stop = true;
      es?.close();
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  // 메인 메뉴의 쪽 (메뉴 / 이어서 하기). 메뉴를 떠나면 처음으로
  const [menuPage, setMenuPage] = useState<"home" | "continue">("home");
  // 새 게임·새 캐릭터를 만드는 중 (화면에서든 채팅에서든)
  const creating = !!status && !status.open && !!status.creation;
  const inMenu = !!status && !status.open && !status.creation;
  useEffect(() => {
    if (!inMenu) setMenuPage("home");
  }, [inMenu]);
  const gm = status?.gm;
  const driver = creating ? (status.creation!.driver ?? "screen") : null;
  return (
    <div className="status-page">
      <header className="header status-header">
        {creating && driver === "screen" && (canGoBack(status.creation!.view) || canGoMenu(status.creation!)) && (
          <BackButton toMenu={!canGoBack(status.creation!.view)} version={status.creation!.version} onStatus={applyStatus} />
        )}
        <div className="hdr-left">
          {!creating && status?.open && status.player.zone ? (
            // 게임 중에는 주인공이 있는 곳. 그 구역의 주인과 월드 이름은 툴팁에 (제목은 긴 이름을 줄여 자르므로 툴팁은 바깥에서 감싼다)
            // 장소가 있으면 장소 이름, hover로 구역·주인·실내외·함께 있는 사람 (12-244)
            <div className="info-tip hdr-title-tip" tabIndex={0}>
              <h1 className="hdr-title">{status.player.place?.name ?? status.player.zone.name}</h1>
              <span className="info-tip-box" role="tooltip">
                {status.player.place ? `${status.player.place.name} · ${status.player.zone.name}` : status.player.zone.name}
                <div className="muted">{status.player.zone.owner}</div>
                {status.player.place && (
                  <div className="muted">
                    {status.player.place.indoor ? "실내" : "바깥"}
                    {status.player.place.spawned ? " · 즉흥 장소" : ""}
                  </div>
                )}
                {status.player.present.length > 0 && <div className="muted">함께 있는 사람: {status.player.present.map((p) => p.name).join(", ")}</div>}
                <div className="info-tip-sep" />
                <div className="muted">{status.scenarioName}</div>
              </span>
            </div>
          ) : (
            <h1 className="hdr-title">{creating ? newGameTitle(status.creation!.view) : inMenu ? "TRPG" : (status?.scenarioName ?? "TRPG")}</h1>
          )}
          {status?.open && <HeaderDate player={status.player} />}
        </div>
        {status?.open && status.player.clock?.minute !== undefined && (
          <div className="hdr-clock">
            <HeaderTemp clock={status.player.clock} />
            <SunDial clock={status.player.clock} />
          </div>
        )}
        <div className="hdr-right">
          <span className={connected ? "status-live" : "status-live off"} title={connected ? "Claude 세션과 연결됨" : "연결 끊김 (Claude 세션이 닫혔나요?)"}>
            <span className="live-dot" aria-hidden="true" />
            {connected ? "연결됨" : "연결 끊김"}
          </span>
          {/* 설정은 게임 중에만 (만들기는 한 번 고른 곳에서 끝까지 한다: 화면 ↔ 채팅으로 넘기는 단추는 없다, 12-214) */}
          {status?.open ? <SettingsButton enabled={connected} onStatus={applyStatus} /> : null}
        </div>
      </header>
      {!creating && status?.unlockNotices?.length ? <UnlockToasts notices={status.unlockNotices} onStatus={applyStatus} /> : null}
      {status && <GmBanner status={status} />}
      {!status ? (
        <p className="muted status-empty">불러오는 중…</p>
      ) : !status.open && status.creation ? (
        <div key="newgame" className="status-sheet">
          <NewGame creation={status.creation} readOnly={driver === "chat"} onStatus={applyStatus} />
        </div>
      ) : !status.open ? (
        <div key="menu" className="status-sheet">
          <MainMenu gm={gm} page={menuPage} onPage={setMenuPage} onStatus={applyStatus} />
        </div>
      ) : (
        <div key="sheet" className="status-sheet">
          {created && <CreatedToast onClose={closeToast} />}
          <CharacterSheet player={status.player} onStatus={applyStatus} />
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
/**
 * 시계 바로 위: 여기서 쉬면 체감 기온 (12-98). 점선 밑줄, 올리면 바깥 기온과 체감의 내역 (실내·불·젖은 옷·입은 옷·덮을 것).
 * 체감이 8° 아래면 노랑, 0° 아래면 빨강
 */
function HeaderTemp({ clock: c }: { clock: NonNullable<PlayerView["clock"]> }) {
  const t = c.temperature;
  if (!t) return null;
  // 시트의 다른 툴팁(info-tip)과 같다: 점선 밑줄, 올리거나 누르면(초점) 아래에 상자
  return (
    <span className={t.feels < 0 ? "info-tip hdr-temp bad" : t.feels < 8 ? "info-tip hdr-temp warn" : "info-tip hdr-temp"} tabIndex={0}>
      {t.feels}°C
      <span className="info-tip-box" role="tooltip">
        체감 {t.feels}°C (여기서 쉬면)
        <br />
        바깥 {t.outside}°C
        <div className="info-tip-sep" />
        {t.detail}
      </span>
    </span>
  );
}

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

/** 시나리오 해금 알림 (기획서 12.4.1): ×를 눌러야 닫힌다. 닫은 것은 세이브 폴더에 남아 다시 뜨지 않는다 */
function UnlockToasts({ notices, onStatus }: { notices: UnlockNotice[]; onStatus: (status: unknown) => void }) {
  const [closing, setClosing] = useState<string | null>(null);
  const close = (n: UnlockNotice) => {
    setClosing(`${n.pack}/${n.roleId}`);
    void fetch("/api/unlock-notice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pack: n.pack, roleId: n.roleId }) })
      .then((r) => r.json() as Promise<{ ok?: boolean; status?: unknown }>)
      .then((out) => {
        setClosing(null);
        if (out.status) onStatus(out.status);
      })
      .catch(() => setClosing(null));
  };
  return (
    <div className="unlock-toasts">
      {notices.map((n) => (
        <div key={`${n.pack}/${n.roleId}`} className="unlock-toast" role="status">
          <Icon name="key" size={16} />
          <span>
            시나리오 <strong>{n.title}</strong>
            {n.particle ?? "를"} 플레이할 수 있습니다.
          </span>
          <button type="button" aria-label="닫기" disabled={closing === `${n.pack}/${n.roleId}`} onClick={() => close(n)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * 만드는 중의 안내 띠 (12-214): 채팅으로 만드는 중이거나, 화면에서 만드는데 GM의 기다림이 끝났을 때.
 * MCP 서버는 채팅을 깨울 수 없어서 기다리는 GM이 없으면 플레이어가 채팅에 한 번 써야 이어진다
 */
function GmBanner({ status }: { status: StatusView }) {
  const gm = status.gm;
  if (!gm || status.open || !status.creation) return null;
  let message: string | null = null;
  if (status.creation.driver === "chat") message = "채팅에서 만드는 중입니다. 이 화면은 진행을 보여 주기만 합니다.";
  else if (!gm.waiting) message = "다 만든 뒤 채팅에 '다 했어'라고 입력하면 GM이 시작합니다.";
  if (!message) return null;
  return (
    <div className="gm-banner" role="status">
      {message}
    </div>
  );
}

/** 새 게임 고르기 중 머리 왼쪽: 한 단계 뒤로. 메인 메뉴에서 연 만들기의 첫 단계면 메인 메뉴로 */
function BackButton({ toMenu, version, onStatus }: { toMenu: boolean; version?: number; onStatus: (status: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="hdr-back"
      aria-label={toMenu ? "메인 메뉴로" : "뒤로"}
      title={toMenu ? "메인 메뉴로" : "한 단계 뒤로"}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void postCreation(toMenu ? { menu: true, version } : { back: true, version }).then((out) => {
          setBusy(false);
          if (out.status) onStatus(out.status);
        });
      }}
    >
      <Icon name="arrow-left" size={16} />
    </button>
  );
}
