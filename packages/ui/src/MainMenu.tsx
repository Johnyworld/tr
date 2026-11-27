import { useCallback, useEffect, useState } from "react";
import { Portrait } from "./Portrait.tsx";
import { Icon } from "./Icon.tsx";
import { ConfirmDialog } from "./Dialog.tsx";
import type { GmLink, SaveSlot } from "./types.ts";

/**
 * 메인 메뉴 (12-214): 열린 세계도 만드는 초안도 없을 때. "새로운 게임"과 "이어서 하기" 둘.
 * 고른 것은 MCP 서버가 처리하고(세계 열기·만들기 시작·삭제), 기다리던 GM이 채팅을 이어 간다.
 * 게임을 열거나 새로 시작하는 것은 GM이 기다릴 때만 된다 (채팅에 /play). 삭제는 언제든.
 * 설정은 두지 않는다 (수위·서술 방식은 게임마다라서 새 게임 만들기와 시트에서)
 */
export async function postMenu(body: { action: "new" | "open" | "delete"; id?: string }): Promise<{ ok: boolean; error?: string; status?: unknown }> {
  try {
    const res = await fetch("/api/menu", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = (await res.json()) as { ok?: boolean; error?: string; status?: unknown };
    return res.ok && out.ok ? { ok: true, status: out.status } : { ok: false, error: out.error ?? "보내지 못했습니다." };
  } catch {
    return { ok: false, error: "Claude 세션과 연결이 끊겼습니다." };
  }
}

export function MainMenu({ gm, page, onPage, onStatus }: { gm: GmLink | undefined; page: "home" | "continue"; onPage: (p: "home" | "continue") => void; onStatus: (status: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (body: Parameters<typeof postMenu>[0]) => {
    setBusy(true);
    setError(null);
    const out = await postMenu(body);
    setBusy(false);
    if (out.status) onStatus(out.status);
    if (!out.ok) setError(out.error ?? "보내지 못했습니다.");
    return out.ok;
  };

  // 세이브 수: 없으면 이어서 하기를 막는다. 메뉴로 돌아올 때마다 다시 센다 (이어서 하기에서 지웠을 수 있다)
  const [saveCount, setSaveCount] = useState<number | null>(null);
  useEffect(() => {
    if (page !== "home") return;
    let stop = false;
    void fetch("/api/worlds", { cache: "no-store" })
      .then((r) => r.json() as Promise<{ slots?: unknown[] }>)
      .then((b) => !stop && setSaveCount(b.slots?.length ?? null))
      .catch(() => !stop && setSaveCount(null));
    return () => {
      stop = true;
    };
  }, [page]);

  const ready = gm?.waiting === true;
  if (page === "continue") return <ContinueList busy={busy} ready={ready} run={run} error={error} onBack={() => onPage("home")} />;
  return (
    <div className={busy ? "newgame mainmenu busy" : "newgame mainmenu"}>
      <div className="mainmenu-title">
        <h1>가람</h1>
        <p>생존자들의 도시</p>
      </div>
      {ready ? (
        <div className="mainmenu-buttons">
          <button type="button" className="mainmenu-button primary" disabled={busy} onClick={() => void run({ action: "new" })}>
            새로운 게임
          </button>
          <button type="button" className="mainmenu-button" disabled={busy || saveCount === 0} title={saveCount === 0 ? "저장된 게임이 없습니다" : undefined} onClick={() => onPage("continue")}>
            이어서 하기
          </button>
        </div>
      ) : (
        <PlayHint />
      )}
      <p className="mainmenu-desc">도망. 생존. 전쟁.<br/>멸망한 도시에서 누군가의 마지막을 경험하세요.</p>
      {error && (
        <p className="newgame-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** GM이 기다리고 있지 않을 때: 단추 자리에 보이는 안내 상자 (게임을 열거나 시작하려면 채팅에 /play) */
function PlayHint() {
  return (
    <div className="mainmenu-hint">
      게임을 열거나 시작하려면 Claude 채팅에 <code>/play</code> 를 입력해 주세요.
    </div>
  );
}

/** 이어서 하기: 세이브 목록. 줄마다 열기(GM이 기다릴 때만)와 삭제(확인 창) */
function ContinueList({ busy, ready, run, error, onBack }: { busy: boolean; ready: boolean; run: (body: Parameters<typeof postMenu>[0]) => Promise<boolean>; error: string | null; onBack: () => void }) {
  const [slots, setSlots] = useState<SaveSlot[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<SaveSlot | null>(null);
  const load = useCallback(() => {
    setLoadError(null);
    void fetch("/api/worlds", { cache: "no-store" })
      .then((r) => r.json() as Promise<{ slots?: SaveSlot[]; error?: string }>)
      .then((b) => (b.slots ? setSlots(b.slots) : setLoadError(b.error ?? "목록을 읽지 못했습니다.")))
      .catch(() => setLoadError("목록을 읽지 못했습니다 (연결 끊김)."));
  }, []);
  useEffect(load, [load]);

  const remove = async (slot: SaveSlot) => {
    setConfirm(null);
    if (await run({ action: "delete", id: slot.id })) load();
  };

  return (
    <div className={busy ? "newgame mainmenu busy" : "newgame mainmenu"}>
      <div className="continue-top">
        <button type="button" className="newgame-back" disabled={busy} onClick={onBack}>
          <Icon name="arrow-left" size={14} /> 메인 메뉴
        </button>
        <h2 className="newgame-title">이어서 하기</h2>
      </div>
      {!slots && !loadError && <p className="muted">불러오는 중…</p>}
      {loadError && <p className="newgame-error">{loadError}</p>}
      {slots && slots.length === 0 && <p className="muted">저장된 게임이 없습니다.</p>}
      {slots && slots.length > 0 && (
        <ul className="save-list">
          {slots.map((slot) => (
            <SaveRow key={slot.id} slot={slot} busy={busy} canOpen={ready} onOpen={() => void run({ action: "open", id: slot.id })} onDelete={() => setConfirm(slot)} />
          ))}
        </ul>
      )}
      {slots && slots.length > 0 && !ready && <PlayHint />}
      {error && (
        <p className="newgame-error" role="alert">
          {error}
        </p>
      )}
      {confirm && <ConfirmDelete slot={confirm} onCancel={() => setConfirm(null)} onConfirm={() => void remove(confirm)} />}
    </div>
  );
}

function SaveRow({ slot, busy, canOpen, onOpen, onDelete }: { slot: SaveSlot; busy: boolean; canOpen: boolean; onOpen: () => void; onDelete: () => void }) {
  const h = slot.hero;
  const locked = slot.lockedBy !== null;
  // 줄 전체가 열기 단추다 (GM이 기다리고 있고, 다른 세션이 쓰고 있지 않을 때)
  const openable = !busy && !locked && canOpen;
  return (
    <li
      className={["save-row", locked && "locked", openable && "openable"].filter(Boolean).join(" ")}
      role="button"
      tabIndex={openable ? 0 : -1}
      aria-disabled={!openable}
      aria-label={`${h?.name ?? "세이브"} 열기`}
      onClick={() => openable && onOpen()}
      onKeyDown={(e) => {
        if (!openable || e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        onOpen();
      }}
    >
      <Portrait id={h?.portrait ?? null} pack={slot.packId} size={52} />
      <div className="save-info">
        <div className="save-name">
          <strong>{h?.name ?? "읽을 수 없는 세이브"}</strong>
          {h && (
            <span className="save-meta">
              {[h.factionName, h.rankLabel].filter(Boolean).join(" ")} · Lv {h.level}
            </span>
          )}
        </div>
        <div className="save-line">
          {slot.worldTitle}
          {h?.zoneName ? ` · ${h.zoneName}` : ""}
          {slot.timeLabel ? ` · ${slot.timeLabel}` : ""}
        </div>
        <div className="save-line muted">
          {h ? `${h.generation}대째 · 복무 ${h.daysServed}일` : ""}
          {h?.dead ? (h.ended ? " · 끝난 판" : " · 사망") : ""}
          {h?.conditions.length ? ` · ${h.conditions.join(", ")}` : ""}
          {` · 마지막 플레이 ${playedAt(slot.updatedAt)}`}
          {locked ? " · 다른 세션에서 하는 중" : ""}
        </div>
      </div>
      {/* 삭제는 줄의 열기로 번지지 않게 막는다 (클릭·키 모두. 막힌 단추를 누른 클릭도 줄로 올라가지 않게 감싼 칸에서 한 번 더) */}
      <div className="save-actions" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="save-delete"
          aria-label={`${h?.name ?? "세이브"} 삭제`}
          title="삭제"
          disabled={busy || locked}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
    </li>
  );
}

/** 삭제 확인 창: 되돌릴 수 없다 */
function ConfirmDelete({ slot, onCancel, onConfirm }: { slot: SaveSlot; onCancel: () => void; onConfirm: () => void }) {
  return (
    <ConfirmDialog title="세이브를 삭제할까요?" confirmLabel="삭제" onCancel={onCancel} onConfirm={onConfirm}>
      <p>
        <strong>{slot.hero?.name ?? slot.id}</strong> ({slot.worldTitle})의 이야기가 모두 지워집니다. 되돌릴 수 없습니다.
      </p>
    </ConfirmDialog>
  );
}

/** 마지막 플레이 (ISO 시각 → "오늘 14:05", "11월 3일") */
function playedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "?";
  const now = new Date();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return `오늘 ${hhmm}`;
  return d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}월 ${d.getDate()}일` : `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
}

/** 게임 종료 확인 창 (시트의 설정 창에서) */
export function ConfirmExit({ busy, error, onCancel, onConfirm }: { busy: boolean; error: string | null; onCancel: () => void; onConfirm: () => void }) {
  return (
    <ConfirmDialog title="게임을 끝낼까요?" confirmLabel="게임 종료" busy={busy} error={error} onCancel={onCancel} onConfirm={onConfirm}>
      <p>진행은 자동으로 저장돼 있습니다. 메인 메뉴로 돌아가고, 이어서 하기에서 다시 열 수 있습니다.</p>
    </ConfirmDialog>
  );
}
