import type React from "react";
import type { WarMapView, WarPartyView } from "./types.ts";
import { FACTION_COLORS, NO_OWNER, factionColorAt } from "./factionColors.ts";

/**
 * 전황 지도 (디버그 전용, TRPG_DEBUG=1): 모든 구역의 주인, 움직이는 부대, 공세 계획, 하루 안의 교전.
 * 진짜 상태라 플레이어 지도와 따로 그린다. 좌표 계산은 지도 탭(MapPanel)과 같다
 */
const W = 480;
const H = 440;
const PAD_X = 46;
const PAD_Y = 14;
const COLORS = FACTION_COLORS;
const NONE = NO_OWNER;

const TASK: Record<string, string> = {
  "clash:raid": "습격",
  "clash:skirmish": "교전",
  "clash:assault": "공세",
  occupy: "차지",
  watch: "정찰",
  intercept: "가로막기",
  trade: "교역",
};

export function WarMap({ war }: { war: WarMapView }) {
  const color = new Map(war.factions.map((f) => [f.id, factionColorAt(f.color)]));
  const fname = new Map(war.factions.map((f) => [f.id, f.name]));
  const zname = new Map(war.zones.map((z) => [z.id, z.name]));
  const pos = new Map(war.zones.map((z) => [z.id, { x: PAD_X + (z.x / 100) * (W - PAD_X * 2), y: PAD_Y + (z.y / 100) * (H - PAD_Y - 34) }]));
  const colorOf = (id: string | null) => (id ? (color.get(id) ?? NONE) : NONE);
  // 한 구역에 부대가 여럿이면 점 둘레에 돌려 놓는다
  const byZone = new Map<string, WarPartyView[]>();
  for (const p of war.parties) byZone.set(p.zone, [...(byZone.get(p.zone) ?? []), p]);
  const partyPos = (p: WarPartyView) => {
    const at = pos.get(p.zone)!;
    const list = byZone.get(p.zone)!;
    const i = list.indexOf(p);
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(list.length, 1) + Math.PI / 4;
    return { x: at.x + Math.cos(a) * 15, y: at.y + Math.sin(a) * 15 };
  };
  const clashZones = new Map(war.clashes.map((c) => [c.zone, c]));
  return (
    <section className="map-panel war-map">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="전황 지도 (디버그)">
        <defs>
          <marker id="war-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M0,0 L6,3 L0,6 z" fill="context-stroke" />
          </marker>
        </defs>
        {war.edges.map(([a, b]) => {
          const p = pos.get(a)!;
          const q = pos.get(b)!;
          const sea = war.zones.find((z) => z.id === a)?.isolated || war.zones.find((z) => z.id === b)?.isolated;
          return <line key={`${a}|${b}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} className="map-edge" strokeDasharray={sea ? "4 4" : undefined} />;
        })}
        {/* 가는 길: 아직 할 일을 마치지 않은 부대의 지금 자리 → 목표 */}
        {war.parties
          .filter((p) => !p.returning && p.goal !== p.zone && pos.has(p.goal))
          .map((p) => {
            const a = partyPos(p);
            const b = pos.get(p.goal)!;
            return <line key={`go-${p.id}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={colorOf(p.faction)} className="war-route" markerEnd="url(#war-arrow)" />;
          })}
        {war.zones.map((z) => {
          const p = pos.get(z.id)!;
          const c = clashZones.get(z.id);
          return (
            <g key={z.id} className={`war-zone${z.here ? " here" : ""}`}>
              {z.base ? (
                <rect x={p.x - 7} y={p.y - 7} width={14} height={14} rx={2} fill={colorOf(z.owner)} />
              ) : (
                <circle cx={p.x} cy={p.y} r={6} fill={colorOf(z.owner)} />
              )}
              {z.fort > 0 && (
                <text x={p.x + 9} y={p.y - 6} className="war-fort">
                  {"▲".repeat(z.fort)}
                </text>
              )}
              {z.alerted && (
                <text x={p.x - 13} y={p.y - 6} className="war-alert">
                  !
                </text>
              )}
              <text x={p.x} y={p.y + 19} textAnchor="middle" className="war-label">
                {z.label}
              </text>
              <title>
                {`${z.name} · ${z.owner ? (fname.get(z.owner) ?? z.owner) : "주인 없음"}${z.fort ? ` · 보강 ${z.fort}` : ""}${z.alerted ? " · 경계 중" : ""}${z.here ? " · 주인공" : ""}${
                  c ? `\n교전: ${fname.get(c.attacker) ?? c.attacker} → ${c.defender ? (fname.get(c.defender) ?? c.defender) : "빈 땅"} (${c.kind}, ${c.success ? "성공" : "실패"})` : ""
                }`}
              </title>
            </g>
          );
        })}
        {war.parties.map((p) => {
          const at = partyPos(p);
          return (
            <g key={p.id} className={`war-party${p.returning ? " returning" : ""}`}>
              <circle cx={at.x} cy={at.y} r={7} stroke={colorOf(p.faction)} fill={p.returning ? "var(--bg)" : colorOf(p.faction)} />
              <text x={at.x} y={at.y + 3} textAnchor="middle">
                {p.size}
              </text>
              <title>{partyTitle(p, fname, zname)}</title>
            </g>
          );
        })}
        {/* 교전 표시는 부대 원에 가리지 않게 맨 위에 */}
        {war.clashes.map((c, i) => {
          const p = pos.get(c.zone);
          if (!p) return null;
          return (
            <text key={`clash-${i}`} x={p.x} y={p.y + 5} textAnchor="middle" className="war-clash">
              ✕
              <title>{`${zname.get(c.zone) ?? c.zone} 교전: ${fname.get(c.attacker) ?? c.attacker} → ${c.defender ? (fname.get(c.defender) ?? c.defender) : "빈 땅 차지"} (${c.success ? "성공" : "실패"})`}</title>
            </text>
          );
        })}
      </svg>
      <WarLegend />
      <ul className="war-factions">
        {war.factions.map((f) => (
          <li key={f.id}>
            <span className="map-key" style={{ background: colorOf(f.id) }} /> {f.name} <span className="muted">전투원 {f.combatants} · 인구 {f.population} · 사기 {f.morale > 0 ? `+${f.morale}` : f.morale} · 구역 {f.zones}</span>
          </li>
        ))}
      </ul>
      {war.plans.length > 0 && (
        <>
          <h4 className="war-h">공세 계획</h4>
          <ul className="war-list">
            {war.plans.map((c) => (
              <li key={c.id}>
                <span style={{ color: colorOf(c.faction) }}>■</span> {fname.get(c.faction) ?? c.faction}: {c.label}
                {c.target ? ` → ${zname.get(c.target) ?? fname.get(c.target) ?? c.target}` : ""} <span className="muted">(진행 {c.filled}/{c.max}, 다 차면 실행)</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {war.parties.length > 0 && (
        <>
          <h4 className="war-h">움직이는 부대 ({war.parties.length}) <span className="muted">임무를 마치고 거점에 돌아오면 해산</span></h4>
          <ul className="war-list">
            {war.parties.map((p) => (
              <li key={p.id}>
                <span style={{ color: colorOf(p.faction) }}>●</span> {partyTitle(p, fname, zname)}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function partyTitle(p: WarPartyView, fname: Map<string, string>, zname: Map<string, string>): string {
  const task = TASK[p.task] ?? p.task;
  const where = zname.get(p.zone) ?? p.zone;
  const goal = zname.get(p.goal) ?? p.goal;
  return `${fname.get(p.faction) ?? p.faction} ${p.label} ${p.size}명${p.leader ? ` (${p.leader})` : ""} · ${where}${p.returning ? " · 돌아가는 길" : ` → ${goal} ${task}`}`;
}

/** 범례: 지도에 쓰는 기호를 그대로 그려 보인다 */
function WarLegend() {
  const item = (svg: React.ReactNode, label: string) => (
    <li>
      <svg viewBox="0 0 28 18" width={28} height={18} aria-hidden="true">
        {svg}
      </svg>
      {label}
    </li>
  );
  return (
    <ul className="war-legend">
      {item(<rect x={7} y={2} width={14} height={14} rx={2} fill={COLORS[0]} />, "거점 (색은 주인 무리)")}
      {item(<circle cx={14} cy={9} r={6} fill={COLORS[0]} />, "구역 (색은 주인 무리)")}
      {item(<circle cx={14} cy={9} r={6} fill={NONE} />, "주인 없는 땅")}
      {item(<circle cx={14} cy={9} r={6} fill={NONE} className="war-legend-here" />, "주인공이 있는 곳")}
      {item(
        <g className="war-party">
          <circle cx={14} cy={9} r={7} stroke={COLORS[2]} fill={COLORS[2]} />
          <text x={14} y={12} textAnchor="middle">12</text>
        </g>,
        "가는 부대 (숫자는 인원)",
      )}
      {item(
        <g className="war-party returning">
          <circle cx={14} cy={9} r={7} stroke={COLORS[2]} fill="var(--bg)" />
          <text x={14} y={12} textAnchor="middle">12</text>
        </g>,
        "돌아가는 부대",
      )}
      {item(<line x1={2} y1={9} x2={24} y2={9} stroke={COLORS[2]} className="war-route" markerEnd="url(#war-arrow)" />, "부대의 목표")}
      {item(<text x={14} y={14} textAnchor="middle" className="war-clash">✕</text>, "하루 안에 교전")}
      {item(<text x={14} y={14} textAnchor="middle" className="war-alert">!</text>, "적이 오는 걸 알고 경계")}
      {item(<text x={14} y={12} textAnchor="middle" className="war-fort">▲▲</text>, "담·망루 보강 (개수 = 단계)")}
    </ul>
  );
}
