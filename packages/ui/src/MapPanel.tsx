import type { MapView } from "./types.ts";

/** 지도 탭 (12-201): 가 본 곳과 맞닿은 곳만. 지금 있는 곳은 강조, 맞닿기만 한 곳은 흐리게 */
/** 시트 폭(약 460px)에 1:1로 맞춘 좌표. 구역은 점, 이름은 점 아래 */
const W = 480;
const H = 440;
const PAD_X = 46;
const PAD_Y = 14;

export function MapPanel({ map }: { map: MapView | null }) {
  if (!map || !map.nodes.length) return <p className="muted">아직 지도에 그릴 곳이 없습니다.</p>;
  const pos = new Map(map.nodes.map((n) => [n.id, { x: PAD_X + (n.x / 100) * (W - PAD_X * 2), y: PAD_Y + (n.y / 100) * (H - PAD_Y - 34) }]));
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
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
  );
}
