import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PlayerView } from "./types.ts";

/** 시트 탭 (12-65). HUD 아래를 나눈다 */
const TABS = [
  { id: "ability", label: "능력" },
  { id: "items", label: "아이템" },
  { id: "people", label: "사람" },
  { id: "journal", label: "일지" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const STORAGE_KEY = "trpg.sheetTab";

/** 탭마다 "새로 생긴 것"을 알아보는 지문. 보고 있지 않은 탭의 지문이 바뀌면 배지를 띄운다 */
function fingerprints(p: PlayerView): Record<TabId, string> {
  return {
    ability: JSON.stringify([p.stats, p.skills, p.traits.map((t) => t.id), p.growth?.skillPoints, p.service.promotionMissing]),
    items: JSON.stringify([p.gear?.weapon?.id, p.gear?.armor.map((a) => a.id), p.inventory.map((i) => [i.id, i.quantity]), p.sceneItems.map((i) => [i.id, i.quantity])]),
    people: JSON.stringify([p.companions?.map((c) => [c.id, c.note]), p.squad?.map((m) => m.report), p.relations.map((r) => r.id), p.ties?.length]),
    journal: JSON.stringify([p.journal?.length ?? 0, p.deeds.length, p.beliefs.length]),
  };
}

function readTab(): TabId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return TABS.some((t) => t.id === v) ? (v as TabId) : "ability";
  } catch {
    return "ability";
  }
}

export function SheetTabs({ player, children }: { player: PlayerView; children: Record<TabId, ReactNode> }) {
  const [tab, setTab] = useState<TabId>(readTab);
  const [fresh, setFresh] = useState<Set<TabId>>(new Set());
  const seen = useRef<Record<TabId, string> | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // 탭 줄은 고정 HUD 바로 아래에 붙는다 (HUD 높이는 임무·전투에 따라 바뀐다)
  const [hudHeight, setHudHeight] = useState(0);
  useEffect(() => {
    const hud = barRef.current?.parentElement?.querySelector(".hud");
    if (!hud) return;
    const measure = () => setHudHeight((hud as HTMLElement).offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(hud);
    return () => ro.disconnect();
  }, []);
  const now = fingerprints(player);
  const nowKey = JSON.stringify(now);

  // 처음 본 모습은 새것이 아니다. 그 뒤로 보고 있지 않은 탭이 바뀌면 배지
  useEffect(() => {
    if (!seen.current) {
      seen.current = now;
      return;
    }
    const changed = TABS.map((t) => t.id).filter((id) => id !== tab && seen.current![id] !== now[id]);
    seen.current = { ...now };
    if (changed.length) setFresh((s) => new Set([...s, ...changed]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowKey]);

  const choose = (id: TabId) => {
    setTab(id);
    setFresh((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // 저장이 막혀 있으면 이번만 기억한다
    }
  };

  return (
    <>
      <div className="sheet-tabs" role="tablist" aria-label="시트" ref={barRef} style={{ top: hudHeight }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            className={tab === t.id ? "sheet-tab on" : "sheet-tab"}
            onClick={() => choose(t.id)}
          >
            {t.label}
            {fresh.has(t.id) && <span className="tab-dot" aria-label="새로 생긴 것" />}
          </button>
        ))}
      </div>
      <div className="sheet-panel" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {children[tab]}
      </div>
    </>
  );
}
