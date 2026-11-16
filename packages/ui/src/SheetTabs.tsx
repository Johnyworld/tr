import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PlayerView } from "./types.ts";

/** 시트 탭 (12-65). HUD 아래를 나눈다 */
const TABS = [
  { id: "ability", label: "능력" },
  { id: "items", label: "아이템" },
  { id: "people", label: "인물" },
  { id: "journal", label: "일지" },
  // 메모장과 펜·연필이 있을 때만 (12-75)
  { id: "memo", label: "메모" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const STORAGE_KEY = "trpg.sheetTab";

/** 탭마다 "새로 생긴 것"을 알아보는 지문. 보고 있지 않은 탭의 지문이 바뀌면 배지를 띄운다 */
function fingerprints(p: PlayerView): Record<TabId, string> {
  return {
    ability: JSON.stringify([p.stats, p.skills, p.traits.map((t) => t.id), p.persona?.map((x) => x.label), p.growth?.skillPoints, p.service.promotionMissing]),
    items: JSON.stringify([p.gear?.weapon?.id, p.gear?.armor.map((a) => a.id), p.inventory.map((i) => [i.id, i.quantity]), p.sceneItems.map((i) => [i.id, i.quantity])]),
    people: JSON.stringify([p.companions?.map((c) => [c.id, c.note]), p.squad?.map((m) => m.report), p.relations.map((r) => r.id), p.ties?.length]),
    journal: JSON.stringify([p.journal?.length ?? 0, p.deeds.length, p.beliefs.length]),
    // 메모는 플레이어가 쓰는 것이라 배지를 띄우지 않는다
    memo: "",
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

/** head: 탭 위에 늘 보이는 HUD. HUD와 탭 줄을 한 덩어리로 위에 고정한다 (높이를 잴 필요가 없다) */
export function SheetTabs({ player, head, children }: { player: PlayerView; head: ReactNode; children: Record<TabId, ReactNode> }) {
  const [chosen, setTab] = useState<TabId>(readTab);
  // 메모 탭은 메모장과 펜·연필이 있을 때만 열린다. 없어지면 능력 탭으로
  const visible = TABS.filter((t) => t.id !== "memo" || !!player.memo);
  const tab: TabId = visible.some((t) => t.id === chosen) ? chosen : "ability";
  const [fresh, setFresh] = useState<Set<TabId>>(new Set());
  const seen = useRef<Record<TabId, string> | null>(null);
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

  // 다른 곳(Lv UP 등)에서 탭을 바꾸라고 하면 따른다
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (TABS.some((t) => t.id === id)) choose(id as TabId);
    };
    window.addEventListener("trpg:tab", on);
    return () => window.removeEventListener("trpg:tab", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      <div className="sheet-sticky">
        {head}
        <div className="sheet-tabs" role="tablist" aria-label="시트">
          {visible.map((t) => (
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
      </div>
      <div className="sheet-panel" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {children[tab]}
      </div>
    </>
  );
}
