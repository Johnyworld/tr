import type { Content } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import { neighbors } from "../sim/war.ts";
import { currentPlace, depthAt, directionTo, knowsPlace, knowsZone, placeCoord, placesIn, unknownDoors, doorNumber } from "../rules/place.ts";

/**
 * 지도 (12-201): 주인공이 아는 만큼만.
 * - 가 본 곳(visited): 이름과 종류(거점인지). 지금 있는 곳은 here
 * - 가 본 곳과 맞닿은 곳(seen): 길이 이어진 것만 안다. 이름도 모른다 (빈 점)
 * - 그 밖은 싣지 않는다 (원칙 4: 가 보지 않은 곳의 주인·사정은 모른다)
 * 좌표는 월드 팩 location.map (0~100). 좌표가 없는 구역은 그리지 않는다
 */
export type MapNode = { id: string; name: string; label: string; x: number; y: number; state: "here" | "visited" | "seen"; base: boolean; isolated: boolean };
export type MapView = { nodes: MapNode[]; edges: [string, string][] };

export function visitedZones(state: GameState): string[] {
  const seen = new Set(state.visited?.[state.playerId] ?? []);
  if (state.playerZone) seen.add(state.playerZone);
  return [...seen];
}

export function buildMapView(state: GameState, content: Content): MapView | null {
  const visited = new Set(visitedZones(state).filter((id) => content.locations[id]?.map));
  if (!visited.size) return null;
  const seen = new Set<string>();
  for (const id of visited) for (const n of neighbors(content, id)) if (!visited.has(n) && content.locations[n]?.map) seen.add(n);
  const nodes: MapNode[] = [...visited, ...seen].map((id) => {
    const l = content.locations[id]!;
    const known = visited.has(id);
    return {
      id,
      // 가 보지 않은 곳은 이름도 싣지 않는다
      name: known ? l.name : "",
      label: known ? (l.map!.label ?? l.name) : "",
      x: l.map!.x,
      y: l.map!.y,
      state: id === state.playerZone ? "here" : known ? "visited" : "seen",
      base: known && l.kind === "base",
      isolated: !!l.isolated,
    };
  });
  const edges: [string, string][] = [];
  const key = new Set<string>();
  for (const id of visited) {
    for (const n of neighbors(content, id)) {
      if (!visited.has(n) && !seen.has(n)) continue;
      const k = [id, n].sort().join("|");
      if (key.has(k)) continue;
      key.add(k);
      edges.push([id, n]);
    }
  }
  return { nodes, edges };
}

/**
 * 구역 안 지도 (12-304, docs/map-expansion-plan.md 3단계): 주인공이 아는 장소는 이름, 지금 자리 표시, 길에는 이어지는 구역(가 본 적 없으면 흐리게).
 * 모르는 장소는 지금 자리에서 이어지는 문만 "?"로 넣고 그 너머는 넣지 않는다 (원칙 4, 공통 규칙 15 knowsPlace). 사람·이야기는 넣지 않는다
 */
export type PlaceMapNode = {
  id: string;
  name: string;
  x: number;
  y: number;
  state: "here" | "known" | "door";
  indoor: boolean;
  /** 담 안 (담 있는 구역에서 깊이 1 이상) */
  inside: boolean;
  /** 길이면 이어지는 구역: 이름과 가 본 적 있는지 */
  roads: { name: string; known: boolean }[];
  /** 지금 자리에서 본 방향 */
  direction: string | null;
};
export type PlaceMapView = { zone: string; zoneName: string; nodes: PlaceMapNode[]; edges: [string, string][] };

export function buildPlaceMapView(state: GameState, content: Content): PlaceMapView | null {
  const zone = state.playerZone;
  if (!zone) return null;
  const all = placesIn(state, content, zone);
  if (!all.length) return null;
  const here = currentPlace(state, content);
  const walled = all.some((p) => p.gate);
  const known = all.filter((p) => knowsPlace(state, content, zone, p.id));
  const doors = unknownDoors(state, content);
  const node = (p: (typeof all)[number], kind: PlaceMapNode["state"]): PlaceMapNode => {
    const n = doorNumber(state, content, p.id);
    const c = placeCoord(state, content, p.id, zone) ?? { x: 50, y: 50 };
    return {
      id: kind === "door" ? `door${n}` : p.id,
      name: kind === "door" ? `문${n}` : p.name,
      x: c.x,
      y: c.y,
      state: kind,
      indoor: p.indoor,
      inside: walled && kind !== "door" && (depthAt(state, content, p.id, zone) ?? 0) >= 1,
      roads: kind === "door" || !p.road ? [] : p.to.map((z) => ({ name: content.locations[z]?.name ?? z, known: knowsZone(state, content, z) })),
      direction: here && p.id !== here.id ? directionTo(state, content, here.id, p.id, zone) : null,
    };
  };
  const nodes = [...known.map((p) => node(p, p.id === here?.id ? "here" : "known")), ...doors.map((p) => node(p, "door"))];
  const ids = new Map<string, string>([...known.map((p) => [p.id, p.id] as const), ...doors.map((p) => [p.id, `door${doorNumber(state, content, p.id)}`] as const)]);
  const edges: [string, string][] = [];
  const seen = new Set<string>();
  for (const p of known) {
    for (const n of p.near) {
      // 문은 지금 자리와만 잇는다 (그 너머는 그리지 않는다)
      if (!ids.has(n) || (doors.some((d) => d.id === n) && p.id !== here?.id)) continue;
      const a = ids.get(p.id)!;
      const b = ids.get(n)!;
      const k = [a, b].sort().join("|");
      if (seen.has(k)) continue;
      seen.add(k);
      edges.push([a, b]);
    }
  }
  return { zone, zoneName: content.locations[zone]?.name ?? zone, nodes, edges };
}

/** ?지도의 구역 안 글 목록 (12-304): ★ 지금 자리 — 이웃들, 담 깊이 이름(GM 장소 줄과 같게), 길은 이어지는 구역. 글자 그림은 쓰지 않는다 */
export function placeListLines(state: GameState, content: Content): string[] {
  const view = buildPlaceMapView(state, content);
  if (!view) return [];
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const neighborsOf = (id: string) => view.edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => byId.get(a === id ? b : a)!).filter(Boolean);
  const walled = placesIn(state, content, state.playerZone).some((p) => p.gate);
  const depthNames = content.scenario.infiltration?.depths ?? [];
  return view.nodes
    .filter((n) => n.state !== "door")
    .sort((a, b) => Number(b.state === "here") - Number(a.state === "here"))
    .map((n) => {
      // 깊이 이름은 GM 장소 줄과 같게 (12-305, PT29 두 판: ?지도 "[담 안]", 장소 줄 "[깊은 곳]")
      const depth = depthNames.length ? depthNames[depthAt(state, content, n.id, state.playerZone) ?? 0] : undefined;
      const wall = walled ? ` [${depth ?? (n.inside ? "담 안" : "담 밖")}]` : "";
      const road = n.roads.length ? ` · 길: ${n.roads.map((r) => (r.known ? r.name : `${r.name}(처음)`)).join("·")} 쪽` : "";
      const near = neighborsOf(n.id).map((m) => (m.state === "door" ? `?${m.name}` : m.name));
      const where = n.state === "here" ? "★ " : n.direction ? `${n.direction} ` : "";
      return `  ${where}${n.name}${wall}${road}${near.length ? ` — ${near.join(", ")}` : ""}`;
    });
}

/** 글자 하나의 화면 폭: 한글·전각은 2칸 */
const cellWidth = (ch: string) => (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1);

/**
 * ?지도용 글자 지도 (12-201). 한글은 2칸으로 세어 줄을 맞춘다
 * @ 지금 여기, # 가 본 거점, o 가 본 곳, ? 가 보지 않은 곳(이름 없음), 길은 - | / \\ (겹치면 +)
 */
export function renderMapAscii(view: MapView, cols = 60, rows = 37): string {
  const grid: string[][] = Array.from({ length: rows }, () => Array<string>(cols).fill(" "));
  const used: boolean[][] = Array.from({ length: rows }, () => Array<boolean>(cols).fill(false));
  const at = (n: MapNode) => ({ c: Math.round((n.x / 100) * (cols - 1)), r: Math.round((n.y / 100) * (rows - 1)) });
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  for (const [a, b] of view.edges) {
    const p = byId.get(a);
    const q = byId.get(b);
    if (!p || !q) continue;
    const s = at(p);
    const e = at(q);
    // 한 칸씩 따라가며 기울기로 글자를 고른다: - | / \. 다른 길과 겹치면 +
    const steps = Math.max(Math.abs(e.c - s.c), Math.abs(e.r - s.r), 1);
    let prev = s;
    const cells: { c: number; r: number; ch: string }[] = [];
    for (let i = 1; i <= steps; i++) {
      const cur = { c: Math.round(s.c + ((e.c - s.c) * i) / steps), r: Math.round(s.r + ((e.r - s.r) * i) / steps) };
      const dc = cur.c - prev.c;
      const dr = cur.r - prev.r;
      const ch = dr === 0 ? "-" : dc === 0 ? "|" : dc * dr > 0 ? "\\" : "/";
      if (i < steps) cells.push({ ...cur, ch });
      prev = cur;
    }
    for (const { c, r, ch } of cells) {
      const old = grid[r]![c]!;
      grid[r]![c] = old === " " || old === ch ? ch : "+";
    }
  }
  const mark = (n: MapNode) => (n.state === "here" ? "@" : n.state === "seen" ? "?" : n.base ? "#" : "o");
  for (const n of view.nodes) {
    const { c, r } = at(n);
    grid[r]![c] = mark(n);
    used[r]![c] = true;
  }
  // 이름은 점 오른쪽, 자리가 없으면 왼쪽. 그래도 겹치면 뺀다
  const place = (r: number, start: number, chars: string[]) => {
    const width = chars.reduce((w, ch) => w + cellWidth(ch), 0);
    if (start < 0 || start + width > cols) return false;
    for (let c = start; c < start + width; c++) if (used[r]![c]) return false;
    let c = start;
    for (const ch of chars) {
      grid[r]![c] = ch;
      used[r]![c] = true;
      if (cellWidth(ch) === 2) {
        grid[r]![c + 1] = "";
        used[r]![c + 1] = true;
      }
      c += cellWidth(ch);
    }
    return true;
  };
  const order = [...view.nodes].sort((a, b) => (a.state === "here" ? -1 : b.state === "here" ? 1 : 0));
  for (const n of order) {
    if (!n.label) continue;
    const { c, r } = at(n);
    const chars = [...n.label];
    const width = chars.reduce((w, ch) => w + cellWidth(ch), 0);
    const mid = c - Math.floor(width / 2);
    // 오른쪽 → 왼쪽 → 아래 → 위
    if (!place(r, c + 1, chars) && !place(r, c - width, chars) && !(r + 1 < rows && place(r + 1, mid, chars))) if (r > 0) place(r - 1, mid, chars);
  }
  const lines = grid.map((row) => row.join("").replace(/\s+$/, ""));
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return [...lines, "", "@ 지금 여기  # 가 본 거점  o 가 본 곳  ? 가 보지 않은 곳"].join("\n");
}
