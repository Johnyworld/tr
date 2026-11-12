import { useEffect, useState } from "react";
import { fetchSlots, openSlot } from "./api.ts";
import { Portrait } from "./Portrait.tsx";
import type { GameView, SaveSlotView, SlotsView } from "./types.ts";

/** 시작 화면: 세이브 슬롯을 고르거나 새 게임을 시작한다 */
export function TitleScreen({ onStart, onCreate }: { onStart: (game: GameView) => void; onCreate: () => void }) {
  const [data, setData] = useState<SlotsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const load = () =>
    fetchSlots()
      .then(setData)
      .catch((err: unknown) => setError(`서버에 연결하지 못했습니다: ${String(err)}`));

  useEffect(() => {
    void load();
  }, []);

  async function start(id: string | null) {
    if (!id) return onCreate();
    setOpening(id);
    setError(null);
    try {
      if (id) onStart(await openSlot(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setOpening(null);
      void load();
    }
  }

  return (
    <div className="title-screen">
      <h1>{data?.scenarioName ?? "TRPG"}</h1>
      <p className="muted">1인용 TRPG · 진행은 행동마다 자동 저장된다</p>

      <button type="button" className="new-game" onClick={() => void start(null)} disabled={opening !== null}>
        {opening === "new" ? "세계를 만드는 중…" : "새 게임"}
      </button>

      {error && <div className="notice error">{error}</div>}

      <h2>저장된 게임</h2>
      {data && data.slots.length === 0 && <p className="muted">아직 저장된 게임이 없다.</p>}
      <ul className="slots">
        {data?.slots.map((slot) => (
          <li key={slot.id}>
            <SlotCard slot={slot} busy={opening !== null} onOpen={() => void start(slot.id)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function SlotCard({ slot, busy, onOpen }: { slot: SaveSlotView; busy: boolean; onOpen: () => void }) {
  const h = slot.hero;
  const locked = slot.lockedBy !== null;
  return (
    <button type="button" className={`slot ${h?.dead ? "dead" : ""}`} onClick={onOpen} disabled={busy || locked}>
      <Portrait id={h?.portrait ?? null} size={64} />
      <div className="slot-body">
      <div className="slot-head">
        <strong>{h?.name ?? "읽을 수 없는 세이브"}</strong>
        {(h?.genderLabel || h?.age) && <span className="muted">{[h.genderLabel, h.age ? `${h.age}세` : null].filter(Boolean).join(" · ")}</span>}
        {h && <span className="slot-level">Lv {h.level}</span>}
        {h && h.generation > 1 && <span className="badge">{h.generation}대째</span>}
        {h?.dead && <span className="badge dead">사망</span>}
      </div>
      {h && (
        <div className="slot-line">
          {[h.factionName, h.rankLabel].filter(Boolean).join(" ")} · 복무 {h.daysServed}일째
        </div>
      )}
      <div className="slot-line muted">{[slot.timeLabel, h?.zoneName].filter(Boolean).join(" · ")}</div>
      {h && (
        <div className={`slot-line ${h.conditions.length ? "condition-worse" : "muted"}`}>
          {h.dead ? "다음 주인공을 고를 차례" : h.conditions.length ? h.conditions.join(", ") : "몸 성함"}
        </div>
      )}
      <div className="slot-foot muted small">
        {locked ? `지금 ${slot.lockedBy === "mcp" ? "Claude 세션(MCP)" : "다른 웹 앱"}에서 플레이 중` : `마지막 플레이 ${playedAt(slot.updatedAt)}`}
      </div>
      </div>
    </button>
  );
}

function playedAt(iso: string) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
