import type { Content } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import { neighbors } from "../sim/war.ts";
import { partyLabel, partyZoneAt } from "../sim/parties.ts";
import { factionColor } from "../views/map.ts";

/**
 * 전황 지도 (디버그 전용, TRPG_DEBUG=1): 세계의 진짜 전쟁 상태를 그대로 보여 준다.
 * 정보 필터를 거치지 않으므로 상태 화면의 디버그 모드에만 싣고, GM 프롬프트·tool 결과에는 절대 넣지 않는다 (원칙 4)
 */
export type WarZoneView = {
  id: string;
  name: string;
  label: string;
  x: number;
  y: number;
  owner: string | null;
  base: boolean;
  isolated: boolean;
  fort: number;
  /** 다가오는 부대를 알아 더 지키는 중 */
  alerted: boolean;
  here: boolean;
};
export type WarPartyView = {
  id: string;
  faction: string;
  kind: string;
  label: string;
  size: number;
  zone: string;
  goal: string;
  /** 할 일 (clash:raid, occupy, watch, intercept, trade) */
  task: string;
  /** 할 일을 마치고 돌아가는 길 */
  returning: boolean;
  leader: string | null;
};
export type WarFactionView = { id: string; name: string; color: number; combatants: number; population: number; morale: number; zones: number };
export type WarPlanView = { id: string; faction: string; label: string; target: string; filled: number; max: number };
export type WarClashView = { zone: string; kind: string; attacker: string; defender: string | null; success: boolean; at: number };
export type WarMapView = {
  time: number;
  factions: WarFactionView[];
  zones: WarZoneView[];
  edges: [string, string][];
  parties: WarPartyView[];
  plans: WarPlanView[];
  /** 하루 안의 교전 */
  clashes: WarClashView[];
};

const DAY = 24 * 60;

export function buildWarMapView(state: GameState, content: Content): WarMapView {
  const located = Object.values(content.locations).filter((l) => l.map);
  const zones: WarZoneView[] = located.map((l) => {
    const z = state.zones[l.id];
    return {
      id: l.id,
      name: l.map!.label ?? l.name,
      label: l.map!.label ?? l.name,
      x: l.map!.x,
      y: l.map!.y,
      owner: z?.owner ?? null,
      base: l.kind === "base",
      isolated: !!l.isolated,
      fort: z?.fort ?? 0,
      alerted: !!z?.alerted,
      here: l.id === state.playerZone,
    };
  });
  const ids = new Set(zones.map((z) => z.id));
  const edges: [string, string][] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    for (const n of neighbors(content, id)) {
      if (!ids.has(n)) continue;
      const k = [id, n].sort().join("|");
      if (seen.has(k)) continue;
      seen.add(k);
      edges.push([id, n]);
    }
  }
  const parties: WarPartyView[] = [];
  for (const p of state.parties) {
    const zone = partyZoneAt(p, state.time);
    if (!zone || p.size <= 0) continue;
    parties.push({
      id: p.id,
      faction: p.faction,
      kind: p.kind,
      label: partyLabel(content, p),
      size: p.size,
      zone,
      goal: p.goal,
      task: p.task.kind === "clash" ? `clash:${p.task.clash}` : p.task.kind,
      returning: p.done,
      leader: p.leader ? (state.characters[p.leader]?.name ?? p.leader) : null,
    });
  }
  const factions: WarFactionView[] = Object.entries(state.factions).map(([id, f]) => ({
    id,
    name: content.factions[id]?.name ?? id,
    color: factionColor(content, id),
    combatants: f.combatants,
    population: f.population,
    morale: f.morale,
    zones: zones.filter((z) => z.owner === id).length,
  }));
  const plans: WarPlanView[] = Object.entries(state.clocks)
    .filter(([, c]) => c.filled > 0)
    .map(([id, c]) => ({ id, faction: c.factionId, label: c.label, target: c.target, filled: c.filled, max: c.max }));
  const clashes: WarClashView[] = state.recentClashes
    .filter((r) => state.time - r.at <= DAY)
    .map((r) => ({ zone: r.clash.zone, kind: r.clash.kind, attacker: r.clash.attacker, defender: r.clash.defender, success: r.clash.success, at: r.at }));
  return { time: state.time, factions, zones, edges, parties, plans, clashes };
}
