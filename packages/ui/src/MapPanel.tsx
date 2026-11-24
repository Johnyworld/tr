import type { MapView, PlaceMapView } from "./types.ts";

/** 지도 탭 (12-201): 가 본 곳과 맞닿은 곳만. 지금 있는 곳은 강조, 맞닿기만 한 곳은 흐리게 */
/** 시트 폭(약 460px)에 1:1로 맞춘 좌표. 구역은 점, 이름은 점 아래 */
const W = 480;
const H = 440;
const PAD_X = 46;
const PAD_Y = 14;

export function MapPanel({ map, placeMap }: { map: MapView | null; placeMap?: PlaceMapView | null }) {
  if (!map || !map.nodes.length) return <p className="muted">아직 지도에 그릴 곳이 없습니다.</p>;
  const pos = new Map(map.nodes.map((n) => [n.id, { x: PAD_X + (n.x / 100) * (W - PAD_X * 2), y: PAD_Y + (n.y / 100) * (H - PAD_Y - 34) }]));
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  return (
    <>
    {placeMap && placeMap.nodes.length ? <PlaceMap view={placeMap} /> : null}
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
          return (
            <g key={n.id} className={`map-node ${n.state}${n.base ? " base" : ""}`}>
              <circle cx={p.x} cy={p.y} r={n.state === "here" ? 7 : 5} />
              {n.label && (
                <text x={p.x} y={p.y + 17} textAnchor="middle">
                  {n.label}
                </text>
              )}
              <title>{n.state === "here" ? `${n.name} (지금 여기)` : n.state === "seen" ? "가 보지 않은 곳" : n.name}</title>
            </g>
          );
        })}
      </svg>
      <p className="map-legend muted">
        <span className="map-key here" /> 지금 여기 <span className="map-key visited" /> 가 본 곳 <span className="map-key seen" /> 가 보지 않은 곳
      </p>
    </section>
    </>
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
      <h4 className="place-map-title">{view.zoneName} 안</h4>
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
