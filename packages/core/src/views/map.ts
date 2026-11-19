import type { Content } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import { neighbors } from "../sim/war.ts";

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
