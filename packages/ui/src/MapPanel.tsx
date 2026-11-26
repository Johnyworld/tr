import { useState } from "react";
import type { MapNode, MapParty, MapView, PlaceMapView, WarMapView } from "./types.ts";
import { FACTION_COLORS, NO_OWNER, factionColorAt } from "./factionColors.ts";
import { WarMap } from "./WarMap.tsx";

/** 지도 탭 (12-201): 가 본 곳과 맞닿은 곳만. 지금 있는 곳은 강조, 맞닿기만 한 곳은 흐리게 */
/** 시트 폭(약 460px)에 1:1로 맞춘 좌표. 구역은 점, 이름은 점 아래 */
const W = 480;
const H = 440;
const PAD_X = 46;
const PAD_Y = 14;

const VIEW_KEY = "trpg.map.view";
type MapTab = "place" | "zone" | "war";

/**
 * 지도 탭의 서브 탭 (segmented control): [지금 구역 안 | 도시 전체 | 전황 (디버그)].
 * 구역 안 지도가 없는 구역이면 첫 칸이, 디버그가 아니면 전황 칸이 빠진다. 고른 것은 이 브라우저에만 기억한다
 */
export function MapPanel({ map, placeMap, war }: { map: MapView | null; placeMap?: PlaceMapView | null; war?: WarMapView | null }) {
  const [chosen, setChosen] = useState<MapTab>(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      return v === "place" || v === "zone" || v === "war" ? v : "place";
    } catch {
      return "place";
    }
  });
  const hasPlace = !!placeMap && placeMap.nodes.length > 0;
  const tabs: { id: MapTab; label: string }[] = [
    ...(hasPlace ? [{ id: "place" as const, label: placeMap!.zoneName }] : []),
    { id: "zone", label: map?.title ? `${map.title} 전체` : "전체 지도" },
    ...(war ? [{ id: "war" as const, label: "전황 (디버그)" }] : []),
  ];
  const tab = tabs.some((t) => t.id === chosen) ? chosen : tabs[0]!.id;
  const pick = (v: MapTab) => {
    setChosen(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* 저장 못 해도 고른 것은 이번에만 */
    }
  };
  return (
    <div className="map-tabs">
      {tabs.length > 1 && (
        <div className="segmented" role="tablist" aria-label="지도 고르기">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => pick(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      )}
      {tab === "war" && war ? <WarMap war={war} /> : tab === "place" && hasPlace ? <PlaceMap view={placeMap!} /> : <PlayerMap map={map} />}
    </div>
  );
}

/**
 * 내 지도: 가 본 곳과 맞닿은 곳. 가 본 곳은 주인공이 아는 주인의 색으로 (12-336).
 * 지금 것이 아닐 수 있는 주인(마지막으로 보거나 들은 때)은 흐리게, 본·전해 들은 부대는 그곳에 마름모로 하루 동안
 */
function PlayerMap({ map }: { map: MapView | null }) {
  if (!map || !map.nodes.length) return <p className="muted">아직 지도에 그릴 곳이 없습니다.</p>;
  const pos = new Map(map.nodes.map((n) => [n.id, { x: PAD_X + (n.x / 100) * (W - PAD_X * 2), y: PAD_Y + (n.y / 100) * (H - PAD_Y - 34) }]));
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const factions = map.factions ?? [];
  const parties = map.parties ?? [];
  const fcolor = new Map(factions.map((f) => [f.id, factionColorAt(f.color)]));
  const fname = new Map(factions.map((f) => [f.id, f.name]));
  const ownerColor = (owner: string | null | undefined) => (owner ? (fcolor.get(owner) ?? NO_OWNER) : NO_OWNER);
  const ownerText = (n: MapNode) => (n.owner === undefined ? "" : ` · ${n.owner ? (fname.get(n.owner) ?? "") : "주인 없음"}${n.ownerNow ? "" : " (마지막으로 보거나 들은 때)"}`);
  const zoneParties = new Map<string, MapParty[]>();
  for (const p of parties) zoneParties.set(p.zone, [...(zoneParties.get(p.zone) ?? []), p]);
  const partyPos = (p: MapParty) => {
    const at = pos.get(p.zone)!;
    const list = zoneParties.get(p.zone)!;
    const a = -Math.PI / 4 + (list.indexOf(p) * 2 * Math.PI) / list.length;
    return { x: at.x + Math.cos(a) * 14, y: at.y + Math.sin(a) * 14 };
  };
  const stale = map.nodes.some((n) => n.owner !== undefined && !n.ownerNow);
  return (
    <section className="map-panel">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="가 본 곳의 지도">
        {map.edges.map(([a, b]) => {
          const p = pos.get(a);
          const q = pos.get(b);
          if (!p || !q) return null;
          const faint = byId.get(a)?.state === "seen" || byId.get(b)?.state === "seen";
          const sea = byId.get(a)?.isolated || byId.get(b)?.isolated;
          return <line key={`${a}|${b}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} className={faint ? "map-edge faint" : "map-edge"} strokeDasharray={sea ? "4 4" : undefined} />;
        })}
        {map.nodes.map((n) => {
          const p = pos.get(n.id)!;
          const known = n.owner !== undefined;
          const fill = known ? ownerColor(n.owner) : undefined;
          const cls = `map-node ${n.state}${n.base ? " base" : ""}${known && !n.ownerNow ? " stale" : ""}`;
          const r = n.state === "here" ? 7 : 6;
          return (
            <g key={n.id} className={cls}>
              {known && n.base ? (
                <rect x={p.x - r} y={p.y - r} width={r * 2} height={r * 2} rx={2} style={{ fill }} />
              ) : (
                <circle cx={p.x} cy={p.y} r={known ? r : 5} style={fill ? { fill } : undefined} />
              )}
              {n.label && (
                <text x={p.x} y={p.y + 19} textAnchor="middle">
                  {n.label}
                </text>
              )}
              <title>{n.state === "seen" ? "가 보지 않은 곳" : `${n.name}${n.state === "here" ? " (지금 여기)" : ""}${ownerText(n)}`}</title>
            </g>
          );
        })}
        {parties.map((p) => {
          const at = partyPos(p);
          return (
            <g key={p.key} className="map-party">
              <rect x={at.x - 5} y={at.y - 5} width={10} height={10} transform={`rotate(45 ${at.x} ${at.y})`} style={{ fill: ownerColor(p.faction) }} />
              <title>{`${fname.get(p.faction) ?? ""} ${p.label} ${p.force} · ${p.timeLabel}께 보거나 들었다`}</title>
            </g>
          );
        })}
      </svg>
      <ul className="war-legend">
        <li>
          <svg viewBox="0 0 28 18" width={28} height={18} aria-hidden="true"><circle cx={14} cy={9} r={6} className="map-legend-here" style={{ fill: NO_OWNER }} /></svg>지금 여기
        </li>
        <li>
          <svg viewBox="0 0 28 18" width={28} height={18} aria-hidden="true"><rect x={8} y={3} width={12} height={12} rx={2} style={{ fill: FACTION_COLORS[0] }} /></svg>거점 (색은 아는 주인)
        </li>
        <li>
          <svg viewBox="0 0 28 18" width={28} height={18} aria-hidden="true"><circle cx={14} cy={9} r={6} style={{ fill: NO_OWNER }} /></svg>주인 없는 땅
        </li>
        {stale && (
          <li>
            <svg viewBox="0 0 28 18" width={28} height={18} aria-hidden="true"><g className="map-node stale"><circle cx={14} cy={9} r={6} style={{ fill: FACTION_COLORS[0] }} /></g></svg>예전에 본 주인 (지금은 다를 수 있다)
          </li>
        )}
        <li>
          <svg viewBox="0 0 28 18" width={28} height={18} aria-hidden="true"><circle cx={14} cy={9} r={4} className="map-legend-seen" /></svg>가 보지 않은 곳
        </li>
        {parties.length > 0 && (
          <li>
            <svg viewBox="0 0 28 18" width={28} height={18} aria-hidden="true"><rect x={9} y={4} width={10} height={10} transform="rotate(45 14 9)" style={{ fill: FACTION_COLORS[2] }} /></svg>보거나 들은 부대 (하루)
          </li>
        )}
      </ul>
      {factions.length > 0 && (
        <ul className="war-factions">
          {factions.map((f) => (
            <li key={f.id}>
              <span className="map-key" style={{ background: factionColorAt(f.color) }} /> {f.name}
            </li>
          ))}
        </ul>
      )}
      {parties.length > 0 && (
        <>
          <h4 className="war-h">보거나 들은 부대</h4>
          <ul className="war-list">
            {parties.map((p) => (
              <li key={p.key}>
                <span style={{ color: ownerColor(p.faction) }}>◆</span> {fname.get(p.faction) ?? ""} {p.label} {p.force} · {byId.get(p.zone)?.name || "모르는 곳"} <span className="muted">({p.timeLabel}께)</span>
              </li>
            ))}
          </ul>
          <p className="map-legend muted">본 그때의 모습입니다. 지금은 다른 곳에 있을 수 있습니다.</p>
        </>
      )}
    </section>
  );
}

/**
 * 구역 안 지도 (12-304): 아는 장소는 이름, 지금 자리는 강조, 지금 자리의 모르는 문은 "?".
 * 길 옆에는 이어지는 구역 이름(가 본 적 없으면 흐리게), 담 안은 옅은 테두리. 사람·이야기는 그리지 않는다
 */
function PlaceMap({ view }: { view: PlaceMapView }) {
  const PW = 480;
  // 길 옆 구역 이름이 점 아래로 두세 줄 붙는다: 아래 여백을 넉넉히
  const PH = 340;
  const pos = new Map(view.nodes.map((n) => [n.id, { x: PAD_X + (n.x / 100) * (PW - PAD_X * 2), y: PAD_Y + 10 + (n.y / 100) * (PH - PAD_Y - 64) }]));
  const inside = view.nodes.filter((n) => n.inside).map((n) => pos.get(n.id)!);
  const box = inside.length
    ? { x: Math.min(...inside.map((p) => p.x)) - 26, y: Math.min(...inside.map((p) => p.y)) - 18, x2: Math.max(...inside.map((p) => p.x)) + 26, y2: Math.max(...inside.map((p) => p.y)) + 26 }
    : null;
  return (
    <section className="map-panel place-map">
      <svg viewBox={`0 0 ${PW} ${PH}`} width="100%" role="img" aria-label={`${view.zoneName} 안의 지도`}>
        {box && <rect className="place-wall" x={box.x} y={box.y} width={box.x2 - box.x} height={box.y2 - box.y} rx={10} />}
        {view.edges.map(([a, b]) => {
          const p = pos.get(a);
          const q = pos.get(b);
          if (!p || !q) return null;
          const door = a.startsWith("door") || b.startsWith("door");
          return <line key={`${a}|${b}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} className={door ? "map-edge faint" : "map-edge"} />;
        })}
        {view.nodes.map((n) => {
          const p = pos.get(n.id)!;
          return (
            <g key={n.id} className={`map-node place ${n.state === "here" ? "here" : n.state === "door" ? "seen" : "visited"}`}>
              {n.indoor ? <rect x={p.x - 5} y={p.y - 5} width={10} height={10} /> : <circle cx={p.x} cy={p.y} r={n.state === "here" ? 7 : 5} />}
              <text x={p.x} y={p.y + 17} textAnchor="middle">
                {n.state === "door" ? "?" : n.name}
              </text>
              {n.roads.map((r, i) => (
                <text key={r.name} x={p.x} y={p.y + 31 + i * 13} textAnchor="middle" className={r.known ? "place-road" : "place-road faint"}>
                  → {r.name}
                </text>
              ))}
              <title>{n.state === "door" ? `${n.name} (알 수 없는 곳)` : n.state === "here" ? `${n.name} (지금 여기)` : `${n.name}${n.direction ? ` · ${n.direction}` : ""}`}</title>
            </g>
          );
        })}
      </svg>
      <p className="map-legend muted">
        <span className="map-key here" /> 지금 자리 <span className="map-key visited" /> 아는 곳 (네모는 실내) <span className="map-key seen" /> 이어지는 모르는 곳
      </p>
    </section>
  );
}
