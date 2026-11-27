/**
 * 가상 데이터로 상태 화면 띄우기 (UI 다듬기용, MCP 서버 없이).
 * `pnpm --filter @trpg/ui exec vite --port 5174` 뒤 http://localhost:5174/mock.html
 * /api/status·/api/status/stream·/api/skill만 흉내 낸다. 스킬 값·단계는 post_apoc 규칙(4.2.1)을 따른다
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StatusApp } from "./StatusApp.tsx";
import type { PlayerView } from "./types.ts";
import "./styles.css";

const STATS = { strength: "힘", agility: "민첩", vitality: "체력", senses: "감각", intellect: "지능", charm: "매력", nerve: "냉정" } as const;
type StatId = keyof typeof STATS;
const statValue: Record<StatId, number> = { strength: 1, agility: 2, vitality: 0, senses: 1, intellect: 0, charm: -1, nerve: 1 };

// [id, 이름, 분류, 종류, 능력, 배운 값(null = 못 함)]
const MOVES: [string, string, string, "common" | "expert", StatId[], number | null][] = [
  ["fight", "근접전", "전투", "common", ["strength", "agility"], 1],
  ["shoot", "사격", "전투", "common", ["agility", "senses"], 2],
  ["maintenance", "손질", "전투", "expert", ["intellect", "senses"], -1],
  ["stealth", "은밀", "몸", "common", ["agility", "nerve"], 0],
  ["endure", "버티기", "몸", "common", ["vitality", "nerve"], 0],
  ["athletics", "운동", "몸", "common", ["strength", "agility", "vitality"], 0],
  ["swim", "수영", "몸", "expert", ["vitality", "agility"], null],
  ["sense_danger", "경계", "감각", "common", ["senses"], 1],
  ["scavenge", "수색", "감각", "common", ["senses", "intellect"], 0],
  ["insight", "눈치", "감각", "common", ["senses", "intellect"], -1],
  ["persuade", "교섭", "사람", "common", ["charm", "intellect"], -1],
  ["deceive", "거짓말", "사람", "common", ["charm", "nerve"], -1],
  ["intimidate", "위협", "사람", "common", ["strength", "nerve"], 0],
  ["leadership", "통솔", "사람", "common", ["charm", "nerve"], -1],
  ["survival", "생존", "생존", "common", ["vitality", "senses"], 0],
  ["hunt", "사냥", "생존", "expert", ["senses", "agility"], null],
  ["fishing", "낚시", "생존", "expert", ["senses", "vitality"], null],
  ["taming", "조련", "생존", "expert", ["charm", "senses"], null],
  ["first_aid", "응급처치", "생존", "expert", ["intellect", "senses"], 0],
  ["surgery", "수술", "생존", "expert", ["intellect", "agility"], null],
  ["improvise", "급조", "생존", "expert", ["intellect", "agility"], -1],
  ["infected_lore", "감염체", "지식", "expert", ["intellect"], null],
  ["history", "역사", "지식", "expert", ["intellect"], null],
  ["mechanics", "차량정비", "지식", "expert", ["intellect", "agility"], null],
  ["carpentry", "목공", "지식", "expert", ["strength", "intellect"], null],
  ["tactics", "전략", "지식", "expert", ["intellect", "nerve"], null],
];
const MIN = -1;
const MAX = 2;
const COSTS = [1, 2, 3];
const learned: Record<string, number | null> = Object.fromEntries(MOVES.map((m) => [m[0], m[5]]));
let skillPoints = 4;
let armed = true;

const tierLabel = (kind: string, v: number | null) =>
  v === null ? "못 함" : v <= MIN ? (kind === "expert" ? "배움" : "미숙") : ({ 0: "할 수 있음", 1: "숙련", 2: "마스터" } as Record<number, string>)[v] ?? String(v);

function player(): PlayerView {
  return {
    name: "한*수",
    genderLabel: "남",
    portrait: null,
    portraitChoices: [{ style: "plain", label: "기본", numbered: true, faces: ["m01", "m02", "m03", "m04", "m05", "m06"] }],
    age: 34,
    roleLabel: "정찰병",
    occupationLabel: "정찰조",
    timeLabel: "3일째 오후",
    clock: { time: "오후 3시", hhmm: "15:10", minute: 910, segment: "afternoon", segmentLabel: "오후", date: "3일째", season: "늦가을", weather: { label: "흐림", icon: null, chill: 0 }, temperature: { outside: 8, feels: 6, detail: "쌀쌀하다" } },
    conditions: [],
    symptoms: [{ id: "tired", label: "피곤함", penalty: 0, tone: 1, fatal: false }],
    conditionPenalty: -1,
    dead: false,
    stats: (Object.keys(STATS) as StatId[]).map((id) => ({ id, label: STATS[id], value: statValue[id] })),
    statRange: { min: -1, max: 2 },
    traits: [
      { id: "keen_eye", label: "밝은 눈", kind: "positive", description: "멀리 있는 것을 먼저 본다" },
      { id: "insomnia", label: "불면", kind: "negative", description: "잠을 깊이 자지 못한다" },
    ],
    skills: MOVES.map(([id, label, category, kind, stats]) => {
      const l = learned[id] ?? null;
      const best = Math.max(...stats.map((s) => statValue[s]));
      return {
        id,
        label,
        category,
        kind,
        value: l === null ? 0 : Math.min(4, l + best),
        usable: l !== null,
        learned: l,
        tier: tierLabel(kind, l),
        raiseCost: l === null || l >= MAX ? null : (COSTS[l - MIN] ?? null),
        stats: stats.map((s) => STATS[s]),
      };
    }),
    growth: { level: 3, xp: 140, prev: 100, next: 220, skillPoints, skillMax: MAX, skillMin: MIN, skillCosts: COSTS },
    inventory: [
      { id: "canned_food", name: "통조림", quantity: 3 },
      { id: "bandage", name: "붕대", quantity: 2 },
    ],
    sceneItems: [],
    gear: {
      weapon: armed ? { id: "pipe", name: "쇠파이프", slot: "weapon", slotLabel: "손", detail: "근접 +1", durability: { left: 6, max: 10 }, ammo: null } : null,
      armor: [{ id: "jacket", name: "가죽 재킷", slot: "body", slotLabel: "몸", detail: "방어 1", durability: { left: 3, max: 8 }, ammo: null }],
      weight: 9,
      capacity: 20,
      burden: 0,
    },
    present: [],
    service: { merit: 4, disobedience: 0, daysServed: 3, promotionMissing: null },
    mission: null,
    faction: { name: "강변 정착지", moraleLabel: "보통", rationLabel: "넉넉함" },
    zone: { name: "무너진 고가도로", owner: "강변 정착지" },
    battle: null,
    relations: [
      { id: "npc_a", name: "박*호", trust: 2, affection: 1, respect: 0 },
      { id: "npc_b", name: "최*란", trust: -1, affection: 0, respect: 2 },
    ],
    ties: [{ key: "t1", text: "박*호와 최*란은 오랜 동료다" }],
    deeds: [{ id: "d1", summary: "고가도로 아래에서 낯선 사람을 도왔다", tagLabels: ["도움"], visibleWitnesses: ["박*호"] }],
    beliefs: [
      { id: "b1", fact: "강 건너 공장에 물자가 남아 있다", sourceLabel: "소문", learnedLabel: "2일째" },
      { id: "b2", fact: "밤에는 북쪽 다리에 감염체가 모인다", sourceLabel: "직접 봄", learnedLabel: "3일째" },
    ],
  };
}

// ?menu 이면 메인 메뉴 (세이브 둘)
const MENU = new URLSearchParams(location.search).has("menu");
const status = () =>
  MENU
    ? { open: false, scenarioName: "잿빛 강 (가상 데이터)", gm: { waiting: true } }
    : { open: true, scenarioName: "잿빛 강 (가상 데이터)", worldId: "mock", player: player(), gm: { waiting: false } };
const hero = (name: string, level: number, dead: boolean) => ({
  name, age: 30, genderLabel: "여", portrait: null, rankLabel: "정찰병", factionName: "강변 정착지", level,
  conditions: dead ? [] : ["피곤함"], zoneName: "무너진 고가도로", daysServed: 12, generation: 1, dead, ended: false,
});
const slots = [
  { id: "w1", packId: "post_apoc", worldTitle: "잿빛 강", hero: hero("김*나", 4, false), timeLabel: "12일째 오후", updatedAt: new Date().toISOString(), cheated: false, lockedBy: null },
  { id: "w2", packId: "post_apoc", worldTitle: "잿빛 강", hero: hero("이*준", 2, true), timeLabel: "5일째 밤", updatedAt: "2026-11-20T10:00:00Z", cheated: false, lockedBy: null },
];

// API 흉내
const listeners = new Set<(data: string) => void>();
const push = () => listeners.forEach((f) => f(JSON.stringify(status())));
class MockEventSource {
  static readonly CLOSED = 2;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  private f = (data: string) => this.onmessage?.({ data });
  constructor() {
    listeners.add(this.f);
    setTimeout(() => {
      this.onopen?.();
      this.f(JSON.stringify(status()));
    });
  }
  close() {
    this.readyState = 2;
    listeners.delete(this.f);
  }
}
(window as unknown as { EventSource: unknown }).EventSource = MockEventSource;
const json = (body: unknown, ok = true) => new Response(JSON.stringify(body), { status: ok ? 200 : 400, headers: { "content-type": "application/json" } });
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith("/api/status")) return json(status());
  if (url.endsWith("/api/skill")) {
    const { skill } = JSON.parse(String(init?.body)) as { skill: string };
    const l = learned[skill];
    if (l === null || l === undefined || l >= MAX) return json({ error: "올릴 수 없습니다" }, false);
    const cost = COSTS[l - MIN]!;
    if (skillPoints < cost) return json({ error: "스킬 포인트가 모자랍니다" }, false);
    learned[skill] = l + 1;
    skillPoints -= cost;
    setTimeout(push);
    return json({ status: status() });
  }
  if (url.endsWith("/api/worlds")) return json({ slots });
  if (url.endsWith("/api/menu")) return json({ ok: false, error: "목업에서는 열 수 없습니다" }, false);
  if (url.endsWith("/api/options")) return json({ open: true, options: { mature: false, dialogue: "novel" } });
  if (url.endsWith("/api/equip")) {
    armed = false;
    setTimeout(push);
    return json({ status: status() });
  }
  if (url.endsWith("/api/exit")) return json({ error: "목업에서는 끝낼 수 없습니다" }, false);
  if (url.includes("/api/")) return json({});
  return realFetch(input, init);
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StatusApp />
  </StrictMode>,
);
