import { josa } from "../text.ts";
import { kindsOf, placeSaid, wordSaid } from "../rules/place.ts";
import { DEED_TAGS } from "../game/reputation.ts";
import { RESOLVE_TARGET } from "../scenario/schema.ts";
import { checkHistory } from "../game/background.ts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { occupationById } from "../game/occupation.ts";
import { checkSkills, layoutCost } from "../game/creation.ts";
import { join, relative } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { createContentSchemas, type Content, type StoryletEffect } from "./schemas.ts";
import { loadScenario, ScenarioError } from "../scenario/scenario.ts";
import { readLoreDocs } from "../rag/lore.ts";
import { LoreFormatError } from "../rag/chunk.ts";
import { itemSources } from "./sources.ts";
import { settingOf, unmetRequires } from "../game/settings.ts";
import { personaOf } from "../engine/persona.ts";

/** 성인·인신매매 이야기의 ai_direction에 꼭 있어야 하는 선 표시 (docs/mature-plan.md 6) */
export const LINE_MARK = "지킬 선";
/** 인신매매 줄기의 이야기 태그 */
export const TRAFFICKING_TAG = "trafficking";
/** 인육 이야기의 태그 (docs/cannibal-plan.md): 인신매매처럼 ai_direction에 지킬 선을 적는다 */
export const CANNIBAL_TAG = "cannibal";

export class ContentError extends Error {
  override name = "ContentError";
  constructor(readonly problems: string[]) {
    super(`콘텐츠 검증 실패 (${problems.length}건)\n${problems.map((p) => `- ${p}`).join("\n")}`);
  }
}

type Kind = "items" | "roles" | "npcs" | "beliefs" | "missions" | "factions" | "locations" | "storylets" | "extras" | "sagas";

/**
 * 시나리오 팩 폴더(content/scenarios/<id>/)를 읽어 검증한다.
 * - scenario.yaml을 먼저 읽고, 그 ID들로 콘텐츠 스키마를 만든다
 * - 한 파일에 객체 하나 또는 목록을 둘 수 있다. 종류별 폴더가 없으면 빈 목록으로 본다
 * - 문제는 한 번에 모아서 보고한다 (첫 오류에서 멈추지 않음)
 */
/**
 * 구역의 장소 그래프 (장소 개편): 길이 하나는 있고, 이웃 구역마다 그리로 가는 길이 있고, 길에서 모든 장소에 닿고,
 * 담 있는 구역(gate)에서 실내 장소가 담을 거치지 않고 닿지 않는다(담 구멍)
 */
export function checkZonePlaces(content: Content, zoneId: string): string[] {
  const problems: string[] = [];
  const l = content.locations[zoneId]!;
  const where = `locations.${zoneId}.places`;
  const roads = l.places.filter((p) => p.road);
  if (!roads.length) return [`${where}: 길(road)이 없다. 구역에 들어오면 도착할 길을 하나 이상 둔다`];
  const linked = new Set<string>([...(l.adjacent ?? []), ...Object.values(content.locations).filter((o) => o.adjacent?.includes(zoneId)).map((o) => o.id), ...(l.crossing?.from ?? []), ...Object.values(content.locations).filter((o) => o.crossing?.from.includes(zoneId)).map((o) => o.id)]);
  for (const z of linked) if (!roads.some((r) => r.to.includes(z))) problems.push(`${where}: ${z}로 가는 길(to)이 없다`);
  for (const r of roads) for (const z of r.to) if (!linked.has(z)) problems.push(`${where}.${r.id}.to: 이어지지 않은 구역 ${z}`);
  const byId = new Map(l.places.map((p) => [p.id, p]));
  const seen = new Set(roads.map((r) => r.id));
  const queue = [...seen];
  while (queue.length) for (const n of byId.get(queue.shift()!)?.near ?? []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
  for (const p of l.places) if (!seen.has(p.id)) problems.push(`${where}.${p.id}: 길에서 닿지 않는다 (near로 잇는다)`);
  if (l.places.some((p) => p.gate)) {
    const outside = new Set(roads.map((r) => r.id));
    const q2 = [...outside];
    while (q2.length) for (const n of byId.get(q2.shift()!)?.near ?? []) if (!outside.has(n) && !byId.get(n)?.gate) { outside.add(n); q2.push(n); }
    for (const p of l.places) if (p.indoor && !p.road && outside.has(p.id)) problems.push(`${where}.${p.id}: 담(gate)을 거치지 않고 닿는 실내 장소다 (담 구멍)`);
    // 길끼리는 담 밖 칸으로 이어진다: 담 문·초소(gate 종류)를 지나지 않고 다른 길로 갈 수 있어야 한다
    // (12-307, PT29 붉은연합 거점 [막힘]·PT30 물류창고: 길을 바꾸려면 적 초소를 지나야 했다)
    const open = (id: string) => { const q = byId.get(id); return !!q && !q.gate && !kindsOf(q).includes("gate"); };
    // 이웃은 양쪽으로 센다 (linkPlaces가 맞추기 전에도)
    const nbr = (id: string) => [...(byId.get(id)?.near ?? []), ...l.places.filter((x) => x.near.includes(id)).map((x) => x.id)];
    const reach = new Set([roads[0]!.id]);
    const q3 = [roads[0]!.id];
    while (q3.length) for (const n of nbr(q3.shift()!)) if (!reach.has(n) && open(n)) { reach.add(n); q3.push(n); }
    for (const r of roads) if (!reach.has(r.id)) problems.push(`${where}.${r.id}: 다른 길(${roads[0]!.id})과 담 밖 칸으로 이어지지 않는다 (담 문·초소를 지나야 한다). 담 밖 둘레 칸으로 잇는다`);
  }
  return problems;
}

/**
 * 장소 종류 (12-300, 공통 규칙 15): 시나리오에 종류 목록이 있으면 장소마다 종류가 1~2개(길·가두는 곳은 표시로 저절로),
 * 이야기의 when.place_kinds는 아는 종류이고, 구역을 정한 이야기면 그 구역마다 그 종류의 장소가 있어야 한다
 */
export function checkPlaceKinds(content: Content): string[] {
  const problems: string[] = [];
  const known = new Set(content.scenario.place_kinds.map((k) => k.id));
  if (!known.size) return problems;
  for (const k of ["road", "jail"]) if (!known.has(k)) problems.push(`scenario.place_kinds: ${k}가 없다 (길·가두는 곳 표시로 저절로 붙는 종류)`);
  for (const l of Object.values(content.locations)) {
    for (const p of l.places) {
      const at = `locations.${l.id}.places.${p.id}.kinds`;
      for (const k of p.kinds) if (!known.has(k)) problems.push(`${at}: 알 수 없는 종류 ${k}`);
      if (!kindsOf(p).length) problems.push(`${at}: 종류가 없다 (1~2개, scenario.place_kinds에서)`);
    }
  }
  for (const s of Object.values(content.storylets)) {
    const kinds = s.when.place_kinds;
    if (!kinds) continue;
    const at = `storylets.${s.id}.when.place_kinds`;
    for (const k of kinds) if (!known.has(k)) problems.push(`${at}: 알 수 없는 종류 ${k}`);
    if (s.when.places) problems.push(`${at}: places와 함께 적지 않는다 (places가 먼저라 종류는 쓰이지 않는다)`);
    for (const z of s.when.zones ?? []) {
      const l = content.locations[z];
      if (l?.places.length && !l.places.some((p) => kindsOf(p).some((k) => kinds.includes(k)))) problems.push(`${at}: ${z}에 그 종류(${kinds.join("·")})의 장소가 없다`);
    }
    // 실내외를 정했으면 그 종류에 실내외가 맞는 장소가 있어야 열린다
    const indoor = s.when.indoor;
    if (typeof indoor === "boolean") {
      const pool = (s.when.zones ?? Object.keys(content.locations)).flatMap((z) => content.locations[z]?.places ?? []);
      if (!pool.some((p) => p.indoor === indoor && kindsOf(p).some((k) => kinds.includes(k)))) problems.push(`${at}: 그 종류에 ${indoor ? "실내" : "바깥"} 장소가 없다 (when.indoor와 맞지 않는다)`);
    }
  }
  return problems;
}

/**
 * 성을 뺀 이름만 날것으로 쓴 글 (12-300, PT27 [정보 누설] "미란은 더 조심하지만"·"그 애 이름? 연옥이.").
 * 실행 중에 가리면 "하나"·"소리"·"하늘" 같은 보통 낱말까지 가려져(PT28) 콘텐츠에서 잡는다: 이야기 글(setup·ai_direction·변형·선택지)에
 * 그 이야기 배역으로 정해 둔 사람(cast ids)의, 인물 예시 대사에 그 인물과 이어진 사람(ties)의 성 뺀 이름이 온이름 없이 나오면 배역 자리표시({배역})나 호칭으로 쓴다
 */
export function checkBareGivenNames(content: Content): string[] {
  const problems: string[] = [];
  const bare = (text: string, id: string): string | null => {
    const name = content.npcs[id]?.name ?? "";
    if (name.length < 3) return null;
    const given = name.slice(1);
    return wordSaid(text.split(name).join(""), given) ? given : null;
  };
  for (const s of Object.values(content.storylets)) {
    const text = [s.setup, s.ai_direction ?? "", ...(s.variants ?? []), ...s.choices.map((c) => c.label)].join("\n");
    for (const role of Object.values(s.cast)) for (const id of (role as { ids?: string[] }).ids ?? []) {
      const g = bare(text, id);
      if (g) problems.push(`storylets.${s.id}: 배역 ${id}의 이름을 성 없이 "${g}"로 쓴다 (모르는 사람이면 GM에게 이름이 샌다. {배역} 자리표시로)`);
    }
  }
  for (const npc of Object.values(content.npcs)) {
    const samples = npc.voice.samples.join("\n");
    for (const t of npc.ties ?? []) {
      const g = bare(samples, t.to);
      if (g) problems.push(`npcs.${npc.id}.voice.samples: 이어진 사람 ${t.to}의 이름을 성 없이 "${g}"로 쓴다 (모르는 사람이면 GM에게 이름이 샌다)`);
    }
  }
  return problems;
}

/** 이웃을 양쪽으로 맞춘다 (장소 개편): A가 B를 이웃으로 적으면 B도 A의 이웃 */
function linkPlaces(content: Content): void {
  for (const l of Object.values(content.locations)) {
    const byId = new Map(l.places.map((p) => [p.id, p]));
    for (const p of l.places) for (const n of p.near) {
      const other = byId.get(n);
      if (other && n !== p.id && !other.near.includes(p.id)) other.near = [...other.near, p.id];
    }
  }
}

export function loadContent(contentDir: string): Content {
  let scenario;
  try {
    scenario = loadScenario(contentDir);
  } catch (err) {
    if (err instanceof ScenarioError) throw new ContentError([err.message]);
    throw err;
  }
  const schemas = createContentSchemas(scenario);
  const KINDS: Record<Kind, z.ZodType> = {
    items: schemas.item,
    roles: schemas.role,
    npcs: schemas.npc,
    beliefs: schemas.beliefPreset,
    missions: schemas.mission,
    factions: schemas.faction,
    locations: schemas.location,
    storylets: schemas.storylet,
    extras: schemas.extra,
    sagas: schemas.saga,
  };
  const problems: string[] = [];
  const content: Content = { scenario, items: {}, roles: {}, npcs: {}, beliefs: {}, missions: {}, factions: {}, locations: {}, storylets: {}, extras: {}, sagas: {} };

  for (const [kind, schema] of Object.entries(KINDS) as [Kind, z.ZodType][]) {
    const dir = join(contentDir, kind);
    for (const file of listYamlFiles(dir)) {
      const where = relative(contentDir, file);
      let docs: unknown[];
      try {
        const parsed: unknown = parse(readFileSync(file, "utf8"));
        docs = Array.isArray(parsed) ? parsed : parsed == null ? [] : [parsed];
      } catch (err) {
        problems.push(`${where}: YAML 문법 오류: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      docs.forEach((doc, index) => {
        const label = docs.length > 1 ? `${where}[${index}]` : where;
        const result = schema.safeParse(doc);
        if (!result.success) {
          problems.push(`${label}: ${z.prettifyError(result.error).replaceAll("\n", " ")}`);
          return;
        }
        const entity = result.data as { id: string };
        const bucket = content[kind] as Record<string, unknown>;
        if (bucket[entity.id]) problems.push(`${label}: id 중복 (${kind}.${entity.id})`);
        else bucket[entity.id] = entity;
      });
    }
  }

  problems.push(...checkReferences(content));
  // 무리 소개는 월드 이야기(intro)의 "- 이름: 소개" 줄과 같아야 한다 (상태 화면 툴팁과 캐릭터 만들 때 본 말이 같게, 12-76)
  for (const line of (content.scenario.introText ?? "").split("\n")) {
    const m = /^- ([^:]+):\s*(.+)$/.exec(line.trim());
    const f = m && Object.values(content.factions).find((x) => x.name === m[1]!.trim());
    if (f && f.public !== m![2]!.trim()) problems.push(`factions.${f.id}.public: 월드 이야기의 소개와 다르다 ("${m![2]!.trim()}")`);
  }
  // lore 문서 앞머리 검사 (RAG 적재 전에 잡는다)
  try {
    readLoreDocs(join(contentDir, "lore"));
  } catch (err) {
    if (err instanceof LoreFormatError) problems.push(err.message);
    else throw err;
  }
  linkPlaces(content);
  if (problems.length > 0) throw new ContentError(problems);
  return content;
}

/** 콘텐츠끼리의 참조를 검사한다. 참조 대상 종류가 생기면 여기에 검사를 더한다 */
/** 배역 자리 바로 뒤에 직접 적은 조사 (받침에 맞춰야 하는 것만) */
const HARDCODED_PARTICLE = /\{([a-z_]+)\}(이다|이|가|을|를|은|는|과|와|다)(?=[\s.,!?"'…)\]]|$)/g;
const PAIR_HINT: Record<string, string> = { 이: "이/가", 가: "이/가", 을: "을/를", 를: "을/를", 은: "은/는", 는: "은/는", 과: "과/와", 와: "과/와", 다: "이다/다", 이다: "이다/다" };

function checkReferences(content: Content): string[] {
  const problems: string[] = [];
  // 눈에 띄는 겉모습 표지는 인물마다 하나: 같은 문장이 두 사람에게 붙지 않는다 (플레이 테스트 13: "안경 한쪽 다리를 철사로 감았다"가 셋)
  {
    const seen = new Map<string, string>();
    for (const npc of Object.values(content.npcs)) {
      for (const raw of npc.look.split(/[.。]/)) {
        const line = raw.trim();
        if (line.length < 8) continue;
        const other = seen.get(line);
        if (other && other !== npc.id) problems.push(`npcs.${npc.id}.look: "${line}"이 ${other}와 같다. 인물마다 다른 표지를 쓴다`);
        else seen.set(line, npc.id);
      }
    }
  }
  // 직분 (기획서 12.6)
  const occIds = new Set(content.scenario.occupations.map((o) => o.id));
  for (const o of content.scenario.occupations) {
    const at = `scenario.occupations.${o.id}`;
    for (const m of o.skills) if (!content.scenario.moves.some((x) => x.id === m)) problems.push(`${at}: 알 수 없는 스킬 ${m}`);
    for (const i of o.kit) if (!content.items[i]) problems.push(`${at}: 알 수 없는 아이템 ${i}`);
    for (const m of o.missions) if (!content.missions[m]) problems.push(`${at}: 알 수 없는 임무 ${m}`);
  }
  problems.push(...checkMatureLines(content));
  problems.push(...checkPlaceKinds(content));
  problems.push(...checkBareGivenNames(content));
  problems.push(...checkSettingsContent(content));
  // 계급이 요구하는 전문 기술 (4.2.1)과 최소 나이 (12-87)
  for (const [rank, skills] of Object.entries(content.scenario.creation?.rank_experts ?? {})) {
    if (!content.scenario.rank_ladder.some((r) => r.id === rank)) problems.push(`scenario.creation.rank_experts: 알 수 없는 계급 ${rank}`);
    for (const m of skills) if (content.scenario.moves.find((x) => x.id === m)?.kind !== "expert") problems.push(`scenario.creation.rank_experts.${rank}: 전문 기술이 아니다 ${m}`);
  }
  for (const rank of Object.keys(content.scenario.creation?.rank_min_age ?? {})) if (!content.scenario.rank_ladder.some((r) => r.id === rank)) problems.push(`scenario.creation.rank_min_age: 알 수 없는 계급 ${rank}`);
  // 과거 배경 (12-84): 능력 배치는 능력 배열과 같은 값들, 스킬은 스킬 포인트 규칙 안, 물건은 있는 것
  for (const p of content.scenario.creation?.pasts ?? []) {
    const at = `scenario.creation.pasts.${p.id}`;
    for (const m of Object.keys(p.skills)) if (!content.scenario.moves.some((x) => x.id === m)) problems.push(`${at}: 알 수 없는 스킬 ${m}`);
    for (const k of Object.keys(p.stats)) if (!content.scenario.stats.some((x) => x.id === k)) problems.push(`${at}: 알 수 없는 능력 ${k}`);
    for (const i of p.items) if (!content.items[i]) problems.push(`${at}: 알 수 없는 아이템 ${i}`);
    const arr = content.scenario.ability_array;
    if (arr) {
      const given = content.scenario.stats.map((x) => p.stats[x.id] ?? 0).sort((a, b) => a - b).join(",");
      if (given !== [...arr].sort((a, b) => a - b).join(",")) problems.push(`${at}: 능력 배치가 능력 배열(${arr.join(", ")})과 다르다`);
    }
    // 과거의 배치는 점수를 다 쓴다 (4.2.1). 배치의 전문 기술은 과거가 가르쳐 준 것이다
    for (const q of checkSkills(content.scenario, p.skills, Object.keys(p.skills))) problems.push(`${at}: ${q}`);
    const rule = content.scenario.creation?.skills;
    if (rule && layoutCost(content.scenario, p.skills) !== rule.points) problems.push(`${at}: 스킬 배치가 ${rule.points}점을 다 쓰지 않는다 (${layoutCost(content.scenario, p.skills)}점)`);
  }
  // 역할·인물의 직분
  for (const [at, x] of [...Object.values(content.roles).map((r) => [`roles.${r.id}`, r] as const), ...Object.values(content.npcs).map((n) => [`npcs.${n.id}`, n] as const)]) {
    if (x.occupation && !occIds.has(x.occupation)) problems.push(`${at}: 알 수 없는 직분 ${x.occupation}`);
  }
  for (const st of Object.values(content.storylets)) for (const o of [...(st.when.occupations ?? []), ...(st.when.occupations_not ?? [])]) if (o !== "none" && !occIds.has(o)) problems.push(`storylets.${st.id}.when.occupations: 알 수 없는 직분 ${o}`);
  for (const st of Object.values(content.storylets))
    for (const [k, r] of Object.entries(st.cast)) for (const o of r.occupations ?? []) if (o !== "same" && !occIds.has(o)) problems.push(`storylets.${st.id}.cast.${k}: 알 수 없는 직분 ${o}`);
  // 들어갈 자리 (12-309): 과거·직분·계급이 있는 것인지, 주인공이 맡을 수 없는 직분(성인 직업)은 아닌지
  const posts = content.scenario.admission?.posts;
  if (posts) {
    const at = "scenario.admission.posts";
    const rankIds = new Set(content.scenario.rank_ladder.map((r) => r.id));
    const pastIds = new Set((content.scenario.creation?.pasts ?? []).map((p) => p.id));
    const postOk = (o: string, where: string) => {
      if (!occIds.has(o)) problems.push(`${at}.${where}: 알 수 없는 직분 ${o}`);
      else if (content.scenario.occupations.find((x) => x.id === o)?.mature) problems.push(`${at}.${where}: 주인공이 맡을 수 없는 직분 ${o}`);
    };
    for (const [past, o] of Object.entries(posts.by_past)) {
      if (!pastIds.has(past)) problems.push(`${at}.by_past: 알 수 없는 과거 ${past}`);
      postOk(o, `by_past.${past}`);
    }
    postOk(posts.default, "default");
    for (const o of [...posts.ask, ...posts.squad, ...Object.keys(posts.ranks)]) postOk(o, "ask/squad/ranks");
    for (const r of [...Object.values(posts.ranks), posts.other_rank, posts.chief_rank]) if (!rankIds.has(r)) problems.push(`${at}: 알 수 없는 계급 ${r}`);
    const used = new Set(Object.values(content.missions).flatMap((m) => m.requirements.flatMap((r) => ("activity" in r ? [r.activity] : []))));
    for (const [o, acts] of Object.entries(posts.borrows)) {
      postOk(o, `borrows.${o}`);
      for (const a of acts) if (!used.has(a as never)) problems.push(`${at}.borrows.${o}: 일감 요건에 쓰이지 않는 활동 ${a}`);
    }
  }
  for (const st of Object.values(content.storylets)) {
    for (const c of st.choices) {
      if (c.when?.post_not && !occIds.has(c.when.post_not)) problems.push(`storylets.${st.id}.${c.id}.when.post_not: 알 수 없는 직분 ${c.when.post_not}`);
      for (const e of [...c.effects, ...Object.values(c.outcomes ?? {}).flat()]) {
        if ("join_faction" in e && e.join_faction.occupation && !occIds.has(e.join_faction.occupation)) problems.push(`storylets.${st.id}: 알 수 없는 직분 ${e.join_faction.occupation}`);
        if ("admission" in e && typeof e.admission === "object" && !(posts?.ask ?? []).includes(e.admission.ask)) problems.push(`storylets.${st.id}: 면담에서 청할 수 없는 자리 ${e.admission.ask} (scenario.admission.posts.ask)`);
      }
    }
  }
  for (const p of content.scenario.command?.policies ?? []) {
    for (const o of p.options) {
      for (const partner of [o.trade?.partner, o.trade?.fallback_partner]) if (partner && !content.factions[partner]) problems.push(`scenario.command.policies.${p.id}.${o.id}: 알 수 없는 교역 상대 ${partner}`);
      for (const who of o.opposed_by) if (!content.npcs[who]) problems.push(`scenario.command.policies.${p.id}.${o.id}: 알 수 없는 반대자 ${who}`);
    }
  }
  for (const npc of Object.values(content.npcs)) {
    for (const t of npc.ties ?? []) {
      if (!content.npcs[t.to]) problems.push(`npcs.${npc.id}.ties: 알 수 없는 인물 ${t.to}`);
      if (t.to === npc.id) problems.push(`npcs.${npc.id}.ties: 자기 자신과는 이을 수 없다`);
    }
    // 인물이 아는 것이 항목 이름이면 내용이 없다 (12-265, PT17·PT18 튜토리얼: "마지막 무전 위치"를 GM이 지어내야 했다)
    for (const k of npc.knows ?? []) {
      const end = (content.scenario.story_lint?.knows_endings ?? []).find((e) => k.trim().endsWith(e));
      if (end) problems.push(`npcs.${npc.id}.knows: "${k}"는 항목 이름이다 ("${end}"로 끝남). 들은 사람이 알게 되는 내용 그 자체로 쓴다`);
    }
  }
  for (const st of Object.values(content.storylets)) {
    const keys = Object.keys(st.cast);
    keys.forEach((key, i) => {
      const of = st.cast[key]!.tie?.of;
      if (of && !keys.slice(0, i).includes(of)) problems.push(`storylets.${st.id}.cast.${key}.tie: ${of}는 이 배역보다 앞에 있어야 한다`);
    });
  }
  // 물건 (기획서 4.8)
  {
    const moves = new Set(content.scenario.moves.map((m) => m.id));
    const itemRef = (at: string, id: string) => { if (!content.items[id]) problems.push(`${at}: 알 수 없는 아이템 ${id}`); };
    const moveRef = (at: string, id: string) => { if (!moves.has(id)) problems.push(`${at}: 알 수 없는 스킬 ${id}`); };
    for (const it of Object.values(content.items)) {
      for (const m of it.weapon?.moves ?? []) moveRef(`items.${it.id}.weapon`, m);
      if (it.weapon?.ammo) itemRef(`items.${it.id}.weapon.ammo`, it.weapon.ammo);
      // 시세가 따르는 자원 (12-155)
      if (it.resource && !content.scenario.resources.some((r) => r.id === it.resource)) problems.push(`items.${it.id}.resource: 알 수 없는 자원 ${it.resource}`);
      const distances = new Set((content.scenario.gear?.distances ?? []).map((d) => d.id));
      for (const [m, byDistance] of Object.entries(it.weapon?.range ?? {})) {
        moveRef(`items.${it.id}.weapon.range`, m);
        for (const d of Object.keys(byDistance)) if (!distances.has(d)) problems.push(`items.${it.id}.weapon.range.${m}: 알 수 없는 거리 ${d}`);
      }
      for (const [m, k] of Object.entries(it.weapon?.wound ?? {})) {
        moveRef(`items.${it.id}.weapon.wound`, m);
        if (!content.scenario.wounds?.kinds.some((x) => x.id === k)) problems.push(`items.${it.id}.weapon.wound: 알 수 없는 상처 종류 ${k}`);
      }
      for (const m of Object.keys(it.armor?.penalty ?? {})) moveRef(`items.${it.id}.armor.penalty`, m);
      for (const m of Object.keys(it.tool?.bonus ?? {})) moveRef(`items.${it.id}.tool`, m);
      if (it.breaks_into) itemRef(`items.${it.id}.breaks_into`, it.breaks_into);
      if (it.used_into) itemRef(`items.${it.id}.used_into`, it.used_into);
      if (it.breaks_into && !it.durability) problems.push(`items.${it.id}: breaks_into는 durability가 있을 때만`);
      if (it.repair) {
        moveRef(`items.${it.id}.repair`, it.repair.move);
        for (const m of [...Object.keys(it.repair.materials), ...it.repair.tools.flat()]) itemRef(`items.${it.id}.repair`, m);
        if (!it.durability) problems.push(`items.${it.id}: repair는 durability가 있을 때만`);
      }
    }
    const g = content.scenario.gear;
    if (g) for (const m of [...g.unarmed.moves, ...g.attack_moves, ...g.carry.encumbered_moves, ...g.haggle_moves]) moveRef("scenario.gear", m);
    for (const r of content.scenario.crafting?.recipes ?? []) {
      moveRef(`scenario.crafting.${r.id}`, r.move);
      for (const m of [...Object.keys(r.materials), ...r.tools.flat(), r.yields.item]) itemRef(`scenario.crafting.${r.id}`, m);
    }
    for (const npc of Object.values(content.npcs)) for (const m of [...Object.keys(npc.merchant?.restock ?? {}), ...Object.keys(npc.merchant?.rare ?? {})]) itemRef(`npcs.${npc.id}.merchant`, m);
    for (const f of Object.values(content.factions)) for (const m of Object.keys(f.armory?.items ?? {})) itemRef(`factions.${f.id}.armory`, m);
    for (const f of Object.values(content.factions)) for (const r of f.rewards?.items ?? []) itemRef(`factions.${f.id}.rewards`, r.id);
    // 부탁 (12-174)
    for (const n of Object.values(content.npcs)) for (const f of n.favors ?? []) {
      itemRef(`npcs.${n.id}.favors.${f.id}`, f.item.id);
      if (f.reward.item) itemRef(`npcs.${n.id}.favors.${f.id}.reward`, f.reward.item.id);
    }
  }
  for (const k of content.scenario.custom_start?.kin ?? []) {
    if (!content.extras[k]) problems.push(`scenario.custom_start.kin: 알 수 없는 엑스트라 틀 ${k}`);
  }
  for (const role of Object.values(content.roles)) {
    for (const itemId of role.start_inventory) {
      if (!content.items[itemId]) problems.push(`roles.${role.id}: 알 수 없는 아이템 ${itemId}`);
    }
    for (const npcId of role.known_npcs) {
      if (!content.npcs[npcId]) problems.push(`roles.${role.id}: 알 수 없는 NPC ${npcId}`);
    }
    if (role.commander && !content.npcs[role.commander]) {
      problems.push(`roles.${role.id}: 알 수 없는 상관 ${role.commander}`);
    }
    for (const sc of role.start_companions ?? []) {
      if (!content.extras[sc.template]) problems.push(`roles.${role.id}: 알 수 없는 동행 틀 ${sc.template}`);
    }
    for (const npcId of [...(role.squad ?? []), ...(role.squad_mates ?? [])]) {
      const npc = content.npcs[npcId];
      if (!npc) problems.push(`roles.${role.id}: 알 수 없는 분대원 ${npcId}`);
      else if (npc.faction !== role.faction) problems.push(`roles.${role.id}: 분대원 ${npcId}는 다른 무리 사람이다`);
    }
    for (const missionId of role.missions) {
      if (!content.missions[missionId]) problems.push(`roles.${role.id}: 알 수 없는 임무 ${missionId}`);
    }
    if (role.beliefs_preset && !content.beliefs[role.beliefs_preset]) {
      problems.push(`roles.${role.id}: 알 수 없는 시작 지식 ${role.beliefs_preset}`);
    }
  }
  const factionIds = new Set(Object.keys(content.factions));
  const hasFactions = factionIds.size > 0;
  const factionRef = (where: string, id: string) => {
    if (hasFactions && !factionIds.has(id)) problems.push(`${where}: 알 수 없는 세력 ${id}`);
  };
  for (const role of Object.values(content.roles)) {
    if (role.faction) factionRef(`roles.${role.id}`, role.faction);
    problems.push(...checkHistory(content, role.history, role.faction || null).map((p) => `roles.${role.id}.history: ${p}`));
    for (const id of role.start_bonds?.ids ?? []) if (!content.npcs[id]) problems.push(`roles.${role.id}.start_bonds: 알 수 없는 NPC ${id}`);
    if (role.start_bonds?.best && !role.start_bonds.ids.includes(role.start_bonds.best)) problems.push(`roles.${role.id}.start_bonds.best: ids 안의 사람이어야 한다`);
    if (role.family && !content.locations[role.family.zone]) problems.push(`roles.${role.id}.family: 알 수 없는 구역 ${role.family.zone}`);
    if (role.family && !content.scenario.custom_start?.group) problems.push(`roles.${role.id}.family: 가족을 만들려면 scenario.custom_start.group(관계 규칙)이 있어야 한다`);
    const sc = role.scenario;
    const conds = [...(sc?.unlock?.when ?? []).map((c) => ["unlock", c] as const), ...(sc?.goal?.when ?? []).map((c) => ["goal", c] as const)];
    for (const [where, c] of conds) {
      const at = `roles.${role.id}.scenario.${where}`;
      if ("scenario_ended" in c || "scenario_cleared" in c) {
        const id = "scenario_ended" in c ? c.scenario_ended : c.scenario_cleared;
        if (!content.roles[id]) problems.push(`${at}: 알 수 없는 시나리오 ${id}`);
      } else if ("enter" in c && !content.locations[c.enter]) problems.push(`${at}: 알 수 없는 구역 ${c.enter}`);
      else if ("fight" in c) factionRef(at, c.fight);
      else if ("join" in c) factionRef(at, c.join);
      else if ("reunite" in c && !role.family) problems.push(`${at}: reunite는 family가 있는 시나리오에서만 쓴다`);
      if (where === "unlock" && "reunite" in c) problems.push(`${at}: reunite는 클리어 목표에서만 쓴다`);
    }
    if (sc?.unlock && sc.order === undefined) problems.push(`roles.${role.id}.scenario: 목록에 없는(order 없는) 시나리오에 해금 조건을 둘 수 없다`);
  }
  for (const faction of Object.values(content.factions)) {
    for (const other of Object.keys(faction.disposition)) factionRef(`factions.${faction.id}.disposition`, other);
    for (const plan of faction.plans) {
      if (plan.target && !content.locations[plan.target]) problems.push(`factions.${faction.id}.plans.${plan.id}: 알 수 없는 구역 ${plan.target}`);
    }
  }
  for (const loc of Object.values(content.locations)) {
    if (loc.owner) factionRef(`locations.${loc.id}.owner`, loc.owner);
    for (const other of loc.adjacent) {
      if (!content.locations[other]) problems.push(`locations.${loc.id}: 알 수 없는 인접 구역 ${other}`);
      if (other === loc.id) problems.push(`locations.${loc.id}: 자기 자신과 인접할 수 없다`);
    }
    if (loc.kind === "base" && !loc.owner) problems.push(`locations.${loc.id}: 거점에는 소유 세력이 있어야 한다`);
  }
  // 기온 (12-98): 모닥불 연료, 계절·날씨 id
  const climate = content.scenario.body?.cold?.climate;
  if (climate) {
    for (const item of Object.keys(climate.fire?.items ?? {})) if (!content.items[item]) problems.push(`body.cold.climate.fire: 알 수 없는 아이템 ${item}`);
    for (const id of Object.keys(climate.season)) if (!content.scenario.seasons?.list.some((x) => x.id === id)) problems.push(`body.cold.climate.season: 알 수 없는 계절 ${id}`);
    for (const id of Object.keys(climate.weather)) if (!content.scenario.weather?.kinds.some((x) => x.id === id)) problems.push(`body.cold.climate.weather: 알 수 없는 날씨 ${id}`);
  }
  // 구역이 하나도 없는 팩(부분 팩·테스트)은 건너뛴다
  if (Object.keys(content.locations).length) for (const z of content.scenario.war?.talk?.rumor?.zones ?? []) if (!content.locations[z]) problems.push(`war.talk.rumor: 알 수 없는 구역 ${z}`);
  // 인물의 자기 일 (12-168)
  for (const npc of Object.values(content.npcs)) {
    for (const a of npc.agenda ?? []) {
      if (a.other && !content.npcs[a.other]) problems.push(`npcs.${npc.id}.agenda.${a.id}: 알 수 없는 인물 ${a.other}`);
      if (a.death === "other" && !a.other) problems.push(`npcs.${npc.id}.agenda.${a.id}: death other에는 other가 필요하다`);
    }
  }
  // 다짐 (12-164): 갈래와 대상
  const resolveTargetOk = (kindId: string, target: string | null, castKeys: Set<string>): string | null => {
    const kind = content.scenario.resolve?.kinds.find((k) => k.id === kindId);
    if (!kind) return `알 수 없는 다짐 갈래 ${kindId}`;
    const type = RESOLVE_TARGET[kind.check];
    if (!target || castKeys.has(target) || target === "zone" || target === "own" || target === "deceased") return null;
    const ok =
      type === "person" ? !!content.npcs[target] :
      type === "zone" ? !!content.locations[target] :
      type === "faction" ? !!content.factions[target] :
      type === "rank" ? content.scenario.rank_ladder.some((r) => r.id === target) :
      type === "trait" ? content.scenario.traits.some((t) => t.id === target) :
      type === "season" ? (content.scenario.seasons?.list ?? []).some((x) => x.id === target) : true;
    return ok ? null : `다짐 ${kindId}의 대상을 모른다: ${target}`;
  };
  // 대체 이름은 월드의 어느 인물 이름에도 들어 있지 않아야 한다 (12-260: 바꾼 이름이 다시 겹치지 않게)
  for (const g of Object.values(content.scenario.names?.stand_ins ?? {}).flat()) {
    const hit = Object.values(content.npcs).find((n) => n.name.includes(g));
    if (hit) problems.push(`names.stand_ins: 대체 이름 ${josa(g, "이/가")} 인물 이름 ${hit.name}(${hit.id})에 있다`);
  }
  // 성을 물려주는 부모의 성별은 시나리오의 성별이어야 한다 (12-259)
  {
    const from = content.scenario.custom_start?.group?.surname_from;
    const genders = content.scenario.creation?.genders.map((g) => g.id) ?? [];
    if (from && !genders.includes(from)) problems.push(`custom_start.group.surname_from: 없는 성별 ${from}`);
  }
  for (const role of Object.values(content.roles)) {
    if (!role.resolve) continue;
    const bad = resolveTargetOk(role.resolve.kind, role.resolve.target, new Set());
    if (bad) problems.push(`roles.${role.id}.resolve: ${bad}`);
  }
  for (const st of Object.values(content.storylets)) {
    const keys = new Set(Object.keys(st.cast));
    for (const c of st.choices) {
      for (const e of [...c.effects, ...(c.outcomes ? [...c.outcomes.success, ...c.outcomes.partial, ...c.outcomes.miss] : [])]) {
        if (!("resolve" in e)) continue;
        const bad = resolveTargetOk(e.resolve.kind, e.resolve.target, keys);
        if (bad) problems.push(`storylets.${st.id}.choices.${c.id}: ${bad}`);
      }
    }
  }
  // 거점 손보기 (12-167): 재료·텃밭 아이템·판정·자원
  for (const f of content.scenario.facilities ?? []) {
    for (const item of Object.keys(f.materials)) if (!content.items[item]) problems.push(`scenario.facilities.${f.id}: 알 수 없는 재료 ${item}`);
    if (!content.scenario.moves.some((m) => m.id === f.move)) problems.push(`scenario.facilities.${f.id}: 알 수 없는 판정 ${f.move}`);
    const g = f.effects.garden;
    if (g && !content.items[g.item]) problems.push(`scenario.facilities.${f.id}.garden: 알 수 없는 아이템 ${g.item}`);
    if (g?.resource && !content.scenario.resources.some((r) => r.id === g.resource)) problems.push(`scenario.facilities.${f.id}.garden: 알 수 없는 자원 ${g.resource}`);
  }
  // 탐험할 곳 (12-162): 구역·아이템·감염체 틀
  for (const r of content.scenario.exploration?.ruins ?? []) {
    if (!content.locations[r.zone]) problems.push(`scenario.exploration.ruins.${r.id}: 알 수 없는 구역 ${r.zone}`);
    for (const table of r.loot) for (const e of table) if (!content.items[e.item]) problems.push(`scenario.exploration.ruins.${r.id}: 알 수 없는 아이템 ${e.item}`);
  }
  for (const t of content.scenario.exploration?.wake ?? []) if (!content.extras[t]) problems.push(`scenario.exploration.wake: 알 수 없는 엑스트라 틀 ${t}`);
  for (const t of content.scenario.traits) for (const item of t.effects.habit?.items ?? []) if (!content.items[item]) problems.push(`scenario.traits.${t.id}.habit: 알 수 없는 아이템 ${item}`);
  // 이동 수단의 연료 (12-137)
  for (const item of Object.values(content.items)) if (item.vehicle?.fuel && !content.items[item.vehicle.fuel]) problems.push(`items.${item.id}.vehicle: 알 수 없는 연료 ${item.vehicle.fuel}`);
  // 먹을 것 구하기·덫·끓이지 않은 물이 가리키는 아이템 (12-131)
  const f = content.scenario.foraging;
  const refs = [
    ...(f?.kinds.flatMap((k) => k.items.map((i) => i.item)) ?? []),
    ...(f?.trap ? [f.trap.item, f.trap.catch.item] : []),
    ...Object.entries(content.scenario.body?.thirst?.dirty?.refill ?? {}).flat(),
  ];
  for (const item of refs) if (!content.items[item]) problems.push(`scenario: 알 수 없는 아이템 ${item} (foraging·thirst.dirty)`);
  for (const k of f?.kinds ?? []) for (const t of k.companions) if (!content.extras[t]) problems.push(`scenario.foraging.${k.id}: 알 수 없는 엑스트라 틀 ${t}`);
  // 즉흥 이야기의 보상 물건 (12-247)
  for (const tier of ["small", "medium"] as const) {
    for (const { item } of Object.values(content.scenario.improv?.rewards[tier].items ?? {}).flat()) if (!content.items[item]) problems.push(`scenario.improv.rewards.${tier}: 알 수 없는 아이템 ${item}`);
  }
  for (const item of Object.keys(content.scenario.consumables)) {
    if (!content.items[item]) problems.push(`scenario.consumables: 알 수 없는 아이템 ${item}`);
  }
  // 먹을 것은 먹을 수 있어야 한다 (플레이 테스트 11: 전투식량·달걀·염소젖이 효과가 없어 먹지 못했다)
  for (const item of Object.values(content.items)) {
    if (item.kind === "food" && !content.scenario.consumables[item.id]) problems.push(`items: 먹을 것 ${item.id}의 효과가 scenario.consumables에 없다`);
  }
  for (const item of [...(content.scenario.body?.infection?.slow ?? []), ...(content.scenario.body?.infection?.cure ?? [])]) {
    if (!content.items[item]) problems.push(`body.infection: 알 수 없는 아이템 ${item}`);
  }
  const battle = content.scenario.battle;
  if (battle) {
    for (const p of battle.preparations) {
      if (p.requires_item && !content.items[p.requires_item]) problems.push(`scenario.battle.preparations.${p.id}: 알 수 없는 아이템 ${p.requires_item}`);
      for (const m of Object.keys(p.materials ?? {})) if (!content.items[m]) problems.push(`scenario.battle.preparations.${p.id}: 알 수 없는 재료 ${m}`);
    }
    for (const e of battle.effects) {
      if (e.requires_item && !content.items[e.requires_item]) problems.push(`scenario.battle.effects.${e.id}: 알 수 없는 아이템 ${e.requires_item}`);
    }
  }
  for (const role of Object.values(content.roles)) {
    if (role.family?.place && !(content.locations[role.family.zone]?.places ?? []).some((p) => p.id === role.family!.place)) problems.push(`roles.${role.id}.family.place: ${role.family.zone}에 없는 장소 ${role.family.place}`);
    // 시작 장소 (12-259): 시작 구역의 장소여야 하고, 시작 장면 글이 장소를 여럿 말하면 적어 둔다
    if (role.start_location && content.locations[role.start_location]) {
      const places = content.locations[role.start_location]!.places;
      if (role.start_place && !places.some((p) => p.id === role.start_place)) problems.push(`roles.${role.id}.start_place: ${role.start_location}에 없는 장소 ${role.start_place}`);
      const named = places.filter((p) => [p.name, ...p.aliases].some((a) => role.opening_scene.includes(a)));
      if (!role.start_place && named.length > 1) problems.push(`roles.${role.id}: 시작 장면 글이 장소를 여럿 말한다 (${named.map((p) => p.id).join(", ")}). start_place로 시작 장소를 정한다`);
    }
    if (role.start_location && Object.keys(content.locations).length && !content.locations[role.start_location]) {
      problems.push(`roles.${role.id}: 알 수 없는 시작 구역 ${role.start_location}`);
    }
  }
  for (const loc of Object.values(content.locations)) {
    for (const l of loc.loot?.items ?? []) {
      if (!content.items[l.item]) problems.push(`locations.${loc.id}.loot: 알 수 없는 아이템 ${l.item}`);
      if (l.qty[0] > l.qty[1]) problems.push(`locations.${loc.id}.loot.${l.item}: qty의 앞이 뒤보다 크다`);
    }
  }
  // 스토리렛 효과의 참조: 세력 자원, 넘어갈 세력
  const resources = new Set(content.scenario.resources.map((r) => r.id));
  for (const st of Object.values(content.storylets)) {
    for (const [topic, options] of Object.entries(st.when.own_policy ?? {})) {
      const t = content.scenario.command?.policies.find((p) => p.id === topic);
      if (!t) problems.push(`storylets.${st.id}.when.own_policy: 알 수 없는 방침 주제 ${topic}`);
      else for (const o of options) if (!t.options.some((x) => x.id === o)) problems.push(`storylets.${st.id}.when.own_policy: 알 수 없는 선택지 ${o}`);
    }
    const all = st.choices.flatMap((c) => [...c.effects, ...Object.values(c.outcomes ?? {}).flat()]);
    for (const e of all) {
      if ("faction_resource" in e && !resources.has(e.faction_resource.resource)) problems.push(`storylets.${st.id}: 알 수 없는 자원 ${e.faction_resource.resource}`);
      if ("faction_resource" in e && !isFactionAlias(e.faction_resource.faction) && !content.factions[e.faction_resource.faction]) problems.push(`storylets.${st.id}: 알 수 없는 세력 ${e.faction_resource.faction}`);
      if ("npc_depart" in e && e.npc_depart.to_faction && !isFactionAlias(e.npc_depart.to_faction) && !content.factions[e.npc_depart.to_faction]) problems.push(`storylets.${st.id}: 알 수 없는 세력 ${e.npc_depart.to_faction}`);
      if ("faction_relation" in e) {
        for (const f of [e.faction_relation.from, e.faction_relation.to]) if (!isFactionAlias(f) && !content.factions[f]) problems.push(`storylets.${st.id}: 알 수 없는 세력 ${f}`);
      }
      if ("body" in e) {
        if (e.body.track === content.scenario.harm_track) problems.push(`storylets.${st.id}: body로 부상 트랙을 바꿀 수 없다 (원칙 3)`);
        // 마음이 흔들리는 일은 주인공이 마음 다잡기를 굴린다 (12-220): 숨은 확률을 적지 않는다
        if (e.body.track === content.scenario.body?.nerves?.track && e.body.delta > 0 && e.body.chance < 1) problems.push(`storylets.${st.id}: 마음이 오르는 body에는 chance를 적지 않는다 (마음 다잡기 판정이 정한다)`);
        else if (!content.scenario.condition_tracks.some((t) => t.id === e.body.track)) problems.push(`storylets.${st.id}: 알 수 없는 상태 트랙 ${e.body.track}`);
      }
      if ("send_to" in e && !content.locations[e.send_to]) problems.push(`storylets.${st.id}: 알 수 없는 구역 ${e.send_to}`);
      if ("join_faction" in e && !content.factions[e.join_faction.faction]) problems.push(`storylets.${st.id}: 알 수 없는 세력 ${e.join_faction.faction}`);
      if ("companion_join" in e && e.companion_join.until?.zone && !content.locations[e.companion_join.until.zone]) problems.push(`storylets.${st.id}: 알 수 없는 구역 ${e.companion_join.until.zone}`);
      if ("faction_policy" in e) {
        const t = content.scenario.command?.policies.find((p) => p.id === e.faction_policy.topic);
        if (!t) problems.push(`storylets.${st.id}: 알 수 없는 방침 주제 ${e.faction_policy.topic}`);
        else if (!t.options.some((o) => o.id === e.faction_policy.option)) problems.push(`storylets.${st.id}: 알 수 없는 방침 선택지 ${e.faction_policy.option}`);
        if (!isFactionAlias(e.faction_policy.faction) && !content.factions[e.faction_policy.faction]) problems.push(`storylets.${st.id}: 알 수 없는 세력 ${e.faction_policy.faction}`);
      }
      if ("npc_body" in e) {
        if (e.npc_body.track === content.scenario.harm_track) problems.push(`storylets.${st.id}: npc_body로 부상 트랙을 바꿀 수 없다`);
        else if (!content.scenario.condition_tracks.some((t) => t.id === e.npc_body.track)) problems.push(`storylets.${st.id}: 알 수 없는 상태 트랙 ${e.npc_body.track}`);
      }
      if ("debt" in e && !isFactionAlias(e.debt.faction) && !content.factions[e.debt.faction]) problems.push(`storylets.${st.id}: 알 수 없는 세력 ${e.debt.faction}`);
      if ("npc_capture" in e) {
        if (!isFactionAlias(e.npc_capture.by) && !content.factions[e.npc_capture.by]) problems.push(`storylets.${st.id}: 알 수 없는 세력 ${e.npc_capture.by}`);
        if (e.npc_capture.zone && !content.locations[e.npc_capture.zone]) problems.push(`storylets.${st.id}: 알 수 없는 구역 ${e.npc_capture.zone}`);
      }
    }
    for (const f of st.when.factions ?? []) if (f !== "none" && !content.factions[f]) problems.push(`storylets.${st.id}.when.factions: 알 수 없는 세력 ${f}`);
    // 개 기르기 (12-172)·가축 (12-175)
    if (st.when.companion_trick && !Object.values(content.extras).some((x) => x.tricks?.some((t) => t.id === st.when.companion_trick))) problems.push(`storylets.${st.id}.when.companion_trick: 알 수 없는 재주 ${st.when.companion_trick}`);
    if (st.when.facility_here && !(content.scenario.facilities ?? []).some((f) => f.id === st.when.facility_here)) problems.push(`storylets.${st.id}.when.facility_here: 알 수 없는 시설 ${st.when.facility_here}`);
    for (const [key, role] of Object.entries(st.cast)) {
      if (role.extra && !content.extras[role.extra]) problems.push(`storylets.${st.id}.cast.${key}: 알 수 없는 엑스트라 틀 ${role.extra}`);
    }
  }
  {
    const nm = content.scenario.war?.parties?.notice_move;
    if (nm && !content.scenario.moves.some((m) => m.id === nm)) problems.push(`scenario.war.parties.notice_move: 알 수 없는 판정 ${nm}`);
  }
  problems.push(...checkPartyStories(content));
  for (const f of Object.values(content.factions)) {
    if (f.party_extra && !content.extras[f.party_extra]) problems.push(`factions.${f.id}.party_extra: 알 수 없는 엑스트라 틀 ${f.party_extra}`);
    for (const p of f.plans) {
      for (const sh of p.shift ?? []) {
        if (sh.to !== "strongest" && !content.factions[sh.to]) problems.push(`factions.${f.id}.plans.${p.id}: 알 수 없는 세력 ${sh.to}`);
        if (sh.from && !content.factions[sh.from]) problems.push(`factions.${f.id}.plans.${p.id}: 알 수 없는 세력 ${sh.from}`);
      }
    }
  }
  {
    const kept = new Set(Object.values(content.storylets).flatMap((st) => Object.values(st.cast).flatMap((r) => (r.keep ? [r.keep] : []))));
    for (const st of Object.values(content.storylets)) {
      for (const [key, r] of Object.entries(st.cast)) if (r.recall && !kept.has(r.recall)) problems.push(`storylets.${st.id}.cast.${key}: recall을 keep하는 이야기가 없다: ${r.recall}`);
    }
  }
  for (const f of Object.values(content.factions)) {
    if (f.culture && !content.scenario.discipline[f.culture.discipline]) problems.push(`factions.${f.id}.culture: 알 수 없는 규율 ${f.culture.discipline} (scenario.discipline)`);
  }
  for (const r of Object.values(content.roles)) {
    for (const f of Object.keys(r.start_debt ?? {})) if (!content.factions[f]) problems.push(`roles.${r.id}.start_debt: 알 수 없는 세력 ${f}`);
  }
  for (const n of Object.values(content.npcs)) {
    if (n.start_captive && !content.factions[n.start_captive.by]) problems.push(`npcs.${n.id}.start_captive: 알 수 없는 세력 ${n.start_captive.by}`);
    if (n.start_captive && !content.locations[n.start_captive.zone]) problems.push(`npcs.${n.id}.start_captive: 알 수 없는 구역 ${n.start_captive.zone}`);
  }
  const custom = content.scenario.custom_start;
  if (custom) {
    const ranks = new Set(content.scenario.rank_ladder.map((r) => r.id));
    for (const r of [...custom.ranks, ...(custom.free_rank ? [custom.free_rank] : [])]) {
      if (!ranks.has(r)) problems.push(`scenario.custom_start: 알 수 없는 계급 ${r}`);
    }
    for (const l of custom.free_locations) if (!content.locations[l]) problems.push(`scenario.custom_start.free_locations: 알 수 없는 구역 ${l}`);
    for (const k of custom.kits) {
      for (const i of k.items) if (!content.items[i]) problems.push(`scenario.custom_start.kits.${k.id}: 알 수 없는 아이템 ${i}`);
    }
    if (custom.age.min > custom.age.max) problems.push("scenario.custom_start.age: min이 max보다 크다");
    // 떠돌이의 소규모 무리 (12-77): 틀·꾸러미·연고가 있는지
    for (const id of [custom.pet, ...(custom.group ? Object.values(custom.group.templates) : [])]) {
      if (id && !content.extras[id]) problems.push(`scenario.custom_start: 알 수 없는 엑스트라 틀 ${id}`);
    }
    for (const id of [custom.free_kit]) if (id && !custom.kits.some((k) => k.id === id)) problems.push(`scenario.custom_start: 알 수 없는 꾸러미 ${id}`);
    if (custom.group) {
      const ids = custom.group.relations.map((r) => r.id);
      if (new Set(ids).size !== ids.length) problems.push("scenario.custom_start.group.relations: id가 겹친다");
      for (const r of custom.group.relations) if (r.age[0] > r.age[1]) problems.push(`scenario.custom_start.group.relations.${r.id}: 나이 범위가 거꾸로다`);
      if (custom.group.start > custom.group.max) problems.push("scenario.custom_start.group: start가 max보다 크다");
    }
  }
  problems.push(...checkStorylets(content));
  problems.push(...checkNpcBodies(content));
  problems.push(...checkNpcRoutines(content));
  problems.push(...checkNpcAliases(content));
  problems.push(...checkRuinPlaces(content));
  problems.push(...checkEmptyNews(content));
  problems.push(...checkCastFates(content));
  problems.push(...checkRequests(content));
  problems.push(...checkThreatPasses(content));
  problems.push(...checkStoryWhereWhen(content));
  problems.push(...checkResolveSpine(content));
  problems.push(...checkSagas(content));
  // 무리 안의 무거운 짓 태그는 행적 태그여야 한다 (12-257: 틀리면 규율 회의가 말없이 열리지 않는다)
  for (const t of content.scenario.offense?.excuse_tags ?? []) if (!(DEED_TAGS as readonly string[]).includes(t)) problems.push(`scenario.offense.excuse_tags: 행적 태그가 아니다: ${t}`);
  for (const t of content.scenario.offense?.tags ?? []) if (!(DEED_TAGS as readonly string[]).includes(t)) problems.push(`scenario.offense.tags: 행적 태그가 아니다: ${t} (있는 것: ${DEED_TAGS.join(", ")})`);
  // 장소마다 묘사 한 줄 (12-251)
  for (const loc of Object.values(content.locations)) for (const p of loc.places) if (!p.description) problems.push(`locations.${loc.id}.places.${p.id}: 묘사(description)가 없다`);
  const plans = Object.values(content.factions).flatMap((f) => f.plans.map((p) => p.id));
  for (const m of Object.values(content.missions)) {
    if (m.advances && !plans.includes(m.advances.clock)) problems.push(`missions.${m.id}.advances: 알 수 없는 세력 클락 ${m.advances.clock}`);
    if (m.target && !content.locations[m.target]) problems.push(`missions.${m.id}.target: 알 수 없는 구역 ${m.target}`);
    for (const w of Array.isArray(m.where) ? m.where : m.where ? [m.where] : []) if (w !== "outside" && w !== "near" && w !== "enemy" && !content.locations[w]) problems.push(`missions.${m.id}.where: 알 수 없는 구역 ${w}`);
  }
  if (new Set(plans).size !== plans.length) problems.push("factions: 세력 클락(plans) id가 겹친다");
  const turns = content.scenario.body?.infection?.turns_into;
  if (turns && Object.keys(content.extras).length > 0 && content.extras[turns]?.kind !== "infected") problems.push(`scenario.body.infection.turns_into: 감염체 틀(kind: infected)이 아니다: ${turns}`);
  for (const ex of Object.values(content.extras)) {
    if (ex.faction) factionRef(`extras.${ex.id}`, ex.faction);
    for (const i of ex.inventory) if (!content.items[i.item]) problems.push(`extras.${ex.id}: 알 수 없는 아이템 ${i.item}`);
    if (ex.age[0] > ex.age[1]) problems.push(`extras.${ex.id}: 나이 범위가 거꾸로다`);
    const exWounds = !ex.wound ? [] : typeof ex.wound === "string" ? [ex.wound] : [...Object.values(ex.wound.light), ...Object.values(ex.wound.heavy)];
    for (const w of exWounds) if (w && !content.scenario.wounds?.kinds.some((k) => k.id === w)) problems.push(`extras.${ex.id}.wound: 알 수 없는 상처 종류 ${w}`);
    if (ex.kind === "infected" && ex.profile) problems.push(`extras.${ex.id}: 감염체는 자라지 않는다 (profile을 뺀다)`);
  }
  for (const npc of Object.values(content.npcs)) {
    if (npc.faction) factionRef(`npcs.${npc.id}`, npc.faction);
    for (const z of npc.roams ?? []) if (Object.keys(content.locations).length && !content.locations[z]) problems.push(`npcs.${npc.id}.roams: 알 수 없는 구역 ${z}`);
    if (npc.zone && Object.keys(content.locations).length && !content.locations[npc.zone]) problems.push(`npcs.${npc.id}: 알 수 없는 구역 ${npc.zone}`);
    for (const itemId of npc.start_inventory) {
      if (!content.items[itemId]) problems.push(`npcs.${npc.id}: 알 수 없는 아이템 ${itemId}`);
    }
    if (npc.id === "player") problems.push(`npcs.${npc.id}: player는 예약된 id다`);
  }
  return problems;
}

/** 스토리렛이 가리키는 인물·아이템·구역·클락·배역이 있는지 */
/**
 * 인물의 시작 몸 상태 (플레이 테스트 14: 카드는 "정강이를 판자로 묶었다·열에 들뜬 눈"인데 부상 이상 없음).
 * starts의 트랙과 단계가 있어야 하고, 카드 글(alias·look)이 scenario.card_body_words의 낱말로 다쳤다·앓는다면 그 트랙의 시작 상태가 있어야 한다
 */
export function checkNpcBodies(content: Content): string[] {
  const problems: string[] = [];
  for (const n of Object.values(content.npcs)) {
    for (const [t, level] of Object.entries(n.starts ?? {})) {
      const track = content.scenario.condition_tracks.find((x) => x.id === t);
      if (!track) problems.push(`npcs.${n.id}.starts: 알 수 없는 상태 트랙 ${t}`);
      else if (!track.levels.some((l) => l.id === level && !l.fatal)) problems.push(`npcs.${n.id}.starts.${t}: 알 수 없거나 죽음인 단계 ${level}`);
    }
    for (const [t, words] of Object.entries(content.scenario.card_body_words ?? {})) {
      const hit = `${n.alias} ${n.look}`.match(new RegExp(words));
      if (hit && !n.starts?.[t]) problems.push(`npcs.${n.id}: 카드 글에 "${hit[0]}"인데 시작 상태(starts.${t})가 없다`);
    }
  }
  return problems;
}

/**
 * 인물 일과의 자리 (B① 2026-11-23, PT19: 일과 74줄이 장소로 정해지지 않아 "구역 어딘가"로 떴다).
 * 떠돌지 않는 인물의 일과 한 칸은 그 구역의 장소(이름·aliases, 가두는 곳 빼고)로 정해지거나, 구역 밖에 나간 시간이라는 말(story_lint.routine_away)이 있어야 한다.
 * 장소가 없는 구역과 떠도는 인물(roams)은 보지 않는다
 */
/**
 * 인물 별칭(이름 모를 때 부르는 말)에 가두는 곳·격리실 이름을 쓰지 않는다 (PT21 졸병: "수용소 담에 기댄 경비"가 아직 모르는 수용소를 드러냈다, 설계 목록 C-1)
 */
export function checkNpcAliases(content: Content): string[] {
  const words = new Set<string>();
  for (const l of Object.values(content.locations)) for (const p of l.places ?? []) if (p.jail || p.quarantine_room) for (const w of [p.name, ...(p.aliases ?? [])]) if (w.length >= 2) words.add(w);
  const problems: string[] = [];
  for (const n of Object.values(content.npcs)) {
    const hit = [...words].find((w) => n.alias?.includes(w));
    if (hit) problems.push(`npcs.${n.id}.alias: 가두는 곳 이름 "${hit}"이 들어 있다 (이름 모를 때 장소가 드러난다). 겉모습으로 쓴다`);
  }
  return problems;
}

/**
 * 탐험할 숨은 곳(ruins)은 구역의 장소와 이름이 겹치지 않는다: 장소는 누구나 아는 곳, 숨은 곳은 뒤져야 찾는 곳 (PT21 하얀매: "비상계단·지하 약제실"에 서서 "지하 약제실"을 새로 찾았다)
 */
export function checkRuinPlaces(content: Content): string[] {
  const problems: string[] = [];
  for (const r of content.scenario.exploration?.ruins ?? []) {
    for (const p of content.locations[r.zone]?.places ?? []) {
      const part = p.name.split("·").map((x) => x.trim()).find((x) => x.length >= 3 && r.label.includes(x));
      if (part) problems.push(`exploration.ruins.${r.id}: 숨은 곳 "${r.label}"이 장소 ${p.id}("${p.name}")와 겹친다. 장소는 입구까지만 적는다`);
    }
  }
  return problems;
}

/**
 * 감염체·짐승 배역이 장면에 들어오는 이야기에서, 결과 글이 위협을 지나 보냈다·피해 빠져나왔다고 하면 threat_passes(또는 put_down)를 둔다 (12-293).
 * 아니면 "지나갔다"는 믿음과 "곁에 서 있다"는 장면이 엇갈린다 (PT25 분대장)
 */
export function checkThreatPasses(content: Content): string[] {
  const problems: string[] = [];
  const passed = /지나갈 때까지|지나갔|지나가길|피해 (빠져|돌아)|따돌|떨쳐/;
  for (const s of Object.values(content.storylets)) {
    const creatures = Object.values(s.cast).some((r) => r.extra && r.enter !== false && ["infected", "animal"].includes(content.extras[r.extra]?.kind ?? "person"));
    if (!creatures) continue;
    for (const ch of s.choices) {
      for (const [label, list] of [["effects", ch.effects], ...Object.entries(ch.outcomes ?? {})] as const) {
        if (!list?.length) continue;
        const says = list.some((e) => "belief" in e && passed.test(e.belief.fact));
        const done = list.some((e) => "threat_passes" in e || "put_down" in e) || (ch.leaves?.length ?? 0) > 0 || (!ch.check && list.some((e) => "delay" in e));
        if (says && !done) problems.push(`storylets.${s.id}.${ch.id}.${label}: 위협이 지나갔다는 결과인데 감염체·짐승 배역이 장면에 남는다 (threat_passes: true)`);
      }
    }
  }
  return problems;
}

/**
 * 의뢰 표 (12-291): 목표 틀·찾아오기 물건·보수 물건이 콘텐츠에 있고, 사람을 죽이는 의뢰의 사람 틀은 무법자처럼 무리 없는 틀이다.
 * 목표 틀은 저절로 나타나지 않는다 (appears.zones: [])
 */
export function checkRequests(content: Content): string[] {
  const r = content.scenario.requests;
  if (!r) return [];
  const problems: string[] = [];
  for (const kind of ["find", "capture", "kill"] as const) {
    for (const t of r.kinds[kind].templates) {
      const x = content.extras[t];
      if (!x) { problems.push(`scenario.requests.kinds.${kind}: 없는 엑스트라 틀 ${t}`); continue; }
      if (kind !== "kill" && (x.kind ?? "person") !== "person") problems.push(`scenario.requests.kinds.${kind}: ${t}는 사람 틀이어야 한다`);
      if ((x.kind ?? "person") === "person" && x.faction) problems.push(`scenario.requests.kinds.${kind}: ${t}는 무리에 속한 틀이다 (의뢰 목표 사람은 무리 없는 틀만)`);
    }
  }
  for (const g of r.givers) for (const i of g.items ?? []) if (!content.items[i]) problems.push(`scenario.requests.givers.items: 없는 아이템 ${i}`);
  for (const p of r.reward.pay) if (!content.items[p.item]) problems.push(`scenario.requests.reward.pay: 없는 아이템 ${p.item}`);
  if (r.days[0] > r.days[1]) problems.push("scenario.requests.days: 범위가 거꾸로다");
  return problems;
}

/**
 * 소식 효과(overhear)와 함께 내용 없는 믿음("소식을 들었다")을 두지 않는다: 들은 내용은 overhear가 남긴다 (설계 목록 10-8, PT18·PT21: "알게 된 것"이 빈 줄이었다)
 */
export function checkEmptyNews(content: Content): string[] {
  const problems: string[] = [];
  const empty = /(소식|사정|본 것)을 들었다$/;
  for (const s of Object.values(content.storylets)) for (const ch of s.choices) {
    for (const list of [ch.effects, ...Object.values(ch.outcomes ?? {})]) {
      if (!list?.some((e) => "overhear" in e)) continue;
      for (const e of list) if ("belief" in e && empty.test(e.belief.fact.trim())) problems.push(`storylets.${s.id}.${ch.id}: overhear와 함께 내용 없는 믿음 "${e.belief.fact}" (들은 내용은 overhear가 남긴다)`);
    }
  }
  return problems;
}

/**
 * 연출 글이 배역의 처지가 바뀐다고 말하면(도망쳤다·떠났다·끌려갔다) 선택지 효과로 그 처지를 바꾼다: 아니면 일과대로 원래 자리에 돌아간다
 * (이동 기획 C, PT21 졸병: 투항한 정찰병이 세 시간 뒤 물류창고 담에 그대로 있었다)
 */
export function checkCastFates(content: Content): string[] {
  const problems: string[] = [];
  const re = /\{(\w+)[^}]*\}[^.\n]{0,40}?(도망쳤|도망친|탈영|떠났|떠난다|끌려갔|끌려간)/g;
  for (const s of Object.values(content.storylets)) {
    const effects = JSON.stringify(s.choices);
    for (const m of [s.ai_direction ?? "", s.setup].join(" ").matchAll(re)) {
      const key = m[1]!;
      if (!s.cast[key]) continue;
      if (!new RegExp(`"(npc_depart|npc_capture|npc_release|companion_join)":\\{"who":"${key}"`).test(effects)) problems.push(`storylets.${s.id}: 글은 {${key}}의 처지가 바뀐다고 하는데("${m[0].slice(0, 30)}…") 선택지에 npc_depart·npc_capture 같은 효과가 없다`);
    }
  }
  return problems;
}

export function checkNpcRoutines(content: Content): string[] {
  const problems: string[] = [];
  const away = content.scenario.story_lint?.routine_away ?? [];
  for (const n of Object.values(content.npcs)) {
    if (n.roams?.length || !n.zone) continue;
    const places = content.locations[n.zone]?.places ?? [];
    if (!places.length) continue;
    for (const [segment, said] of Object.entries(n.routine ?? {})) {
      if (!said || placeSaid(places, said) || away.some((w) => said.includes(w))) continue;
      problems.push(`npcs.${n.id}.routine.${segment}: "${said}"가 ${n.zone}의 장소로 정해지지 않는다 (장소 이름·aliases를 쓰거나, 구역 밖이면 story_lint.routine_away의 말로)`);
    }
  }
  return problems;
}

/**
 * 다짐의 줄기 이야기 (12-251, 플레이 테스트 14: 섬의 "의회 저장고"가 조건을 채운 밤에 이야기 간격에 막혀 열리지 않았다).
 * 시나리오의 다짐이 진실 알기(check beliefs)이면, 그 시나리오에만 있는 이야기 가운데 그 진실을 믿음으로 주는 것은 꼭 열리는 이야기(essential)여야 한다
 */
/**
 * 큰 이야기 (공통 규칙 24, docs/saga-plan.md 파트 3·13): 참조, 막마다 시계와 세계 쪽 사건, 길.
 * - 시작 사건(acts: [open])이 첫 막으로 넘기고 꼭 열리는 이야기다
 * - 마지막이 아닌 막마다 다음 막으로 넘기는 이야기가 둘 이상, 그중 하나는 사람을 정해 두지 않은 배역만 쓴다 (열쇠 인물이 죽어도 길이 남게)
 * - 마지막 막에는 결말로 끝내는 이야기가 있다
 */
export function checkSagas(content: Content): string[] {
  const problems: string[] = [];
  type Found = { kind: "advance" | "end"; id: string; to: string };
  const found = (v: unknown, out: Found[] = []): Found[] => {
    if (Array.isArray(v)) for (const x of v) found(x, out);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const adv = o.saga_advance as { id?: string; to?: string } | undefined;
      const end = o.saga_end as { id?: string; ending?: string } | undefined;
      if (adv?.id && adv.to) out.push({ kind: "advance", id: adv.id, to: adv.to });
      if (end?.id && end.ending) out.push({ kind: "end", id: end.id, to: end.ending });
      for (const x of Object.values(o)) found(x, out);
    }
    return out;
  };
  const RESERVED = ["open", "ended"];
  for (const saga of Object.values(content.sagas)) {
    const at = `sagas.${saga.id}`;
    const acts = saga.acts.map((a) => a.id);
    const endings = saga.endings.map((e) => e.id);
    if (new Set(acts).size !== acts.length) problems.push(`${at}.acts: 막 id가 겹친다`);
    if (new Set(endings).size !== endings.length) problems.push(`${at}.endings: 결말 id가 겹친다`);
    for (const a of saga.acts) {
      if (RESERVED.includes(a.id)) problems.push(`${at}.acts.${a.id}: open·ended는 막 id로 쓰지 않는다`);
      if (a.next && !acts.includes(a.next)) problems.push(`${at}.acts.${a.id}.next: 없는 막 ${a.next}`);
      if (a.lapse.ending && !endings.includes(a.lapse.ending)) problems.push(`${at}.acts.${a.id}.lapse.ending: 없는 결말 ${a.lapse.ending}`);
    }
    for (const [key, id] of Object.entries(saga.cast)) if (!content.npcs[id]) problems.push(`${at}.cast.${key}: 없는 인물 ${id}`);
    if (saga.mark && !acts.includes(saga.mark.at)) problems.push(`${at}.mark.at: 없는 막 ${saga.mark.at}`);
    for (const key of [...saga.arrive, ...saga.acts.flatMap((a) => a.arrive)]) if (key !== "marked" && !saga.cast[key]) problems.push(`${at}: arrive의 배역 ${key}가 cast에 없다`);
    for (const [key, id] of Object.entries(saga.cast)) if (content.npcs[id]?.offstage && !saga.arrive.includes(key) && !saga.acts.some((a) => a.arrive.includes(key))) problems.push(`${at}.cast.${key}: offstage인 사람은 arrive로 들인다`);
    if (saga.mark?.fallback && !saga.cast[saga.mark.fallback]) problems.push(`${at}.mark.fallback: cast에 없는 배역 ${saga.mark.fallback}`);
    for (const n of saga.notes) {
      if (n.zone && !content.locations[n.zone]) problems.push(`${at}.notes.${n.flag}: 없는 구역 ${n.zone}`);
      for (const a of n.acts ?? []) if (!acts.includes(a)) problems.push(`${at}.notes.${n.flag}: 없는 막 ${a}`);
    }
    if (saga.opens.saga_ended && !content.sagas[saga.opens.saga_ended.id]) problems.push(`${at}.opens.saga_ended: 없는 큰 이야기 ${saga.opens.saga_ended.id}`);
    for (const r of saga.opens.roles_none ?? []) if (!content.roles[r]) problems.push(`${at}.opens.roles_none: 없는 역할 ${r}`);
    const mine = Object.values(content.storylets).filter((st) => st.when.saga?.id === saga.id);
    for (const st of mine) if (!st.tags.includes("saga")) problems.push(`storylets.${st.id}: 큰 이야기의 이야기는 tags에 saga를 둔다`);
    const leads = (from: string, kind: Found["kind"], to: string) =>
      mine.filter((st) => (st.when.saga!.acts ?? []).includes(from) && found(st.choices).some((f) => f.id === saga.id && f.kind === kind && f.to === to));
    const starts = leads("open", "advance", acts[0]!);
    if (!starts.length) problems.push(`${at}: 시작 사건(when.saga.acts: [open])에서 첫 막 ${acts[0]}으로 넘기는 이야기가 없다`);
    for (const st of starts) if (!st.essential) problems.push(`storylets.${st.id}: 큰 이야기 ${saga.id}의 시작 사건이다. essential: true로 둔다`);
    for (const a of saga.acts) {
      const ways = a.next ? leads(a.id, "advance", a.next) : saga.endings.flatMap((e) => leads(a.id, "end", e.id));
      const need = a.next ? 2 : 1;
      if (ways.length < need) problems.push(`${at}.acts.${a.id}: ${a.next ? `다음 막 ${a.next}으로 넘기는` : "결말로 끝내는"} 이야기가 ${ways.length}편이다 (${need}편 이상)`);
      else if (!ways.some((st) => Object.values(st.cast).every((r) => !("ids" in r) || !r.ids))) problems.push(`${at}.acts.${a.id}: 넘기는 이야기가 모두 사람을 정해 둔 배역(ids)을 쓴다. 열쇠 인물이 죽어도 남는 길을 하나 둔다`);
    }
  }
  for (const st of Object.values(content.storylets)) {
    const w = st.when.saga;
    if (w) {
      const saga = content.sagas[w.id];
      if (!saga) problems.push(`storylets.${st.id}.when.saga: 없는 큰 이야기 ${w.id}`);
      for (const a of w.acts ?? []) if (saga && !RESERVED.includes(a) && !saga.acts.some((x) => x.id === a)) problems.push(`storylets.${st.id}.when.saga.acts: 없는 막 ${a}`);
      for (const e of w.ending ?? []) if (saga && !saga.endings.some((x) => x.id === e)) problems.push(`storylets.${st.id}.when.saga.ending: 없는 결말 ${e}`);
    }
    for (const f of found(st.choices)) {
      const saga = content.sagas[f.id];
      if (!saga) problems.push(`storylets.${st.id}: 없는 큰 이야기 ${f.id}`);
      else if (f.kind === "advance" && !saga.acts.some((x) => x.id === f.to)) problems.push(`storylets.${st.id}: 큰 이야기 ${f.id}에 없는 막 ${f.to}`);
      else if (f.kind === "end" && !saga.endings.some((x) => x.id === f.to)) problems.push(`storylets.${st.id}: 큰 이야기 ${f.id}에 없는 결말 ${f.to}`);
    }
  }
  return problems;
}

export function checkResolveSpine(content: Content): string[] {
  const problems: string[] = [];
  const flagsSet = (v: unknown, out: string[] = []): string[] => {
    if (Array.isArray(v)) for (const x of v) flagsSet(x, out);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.set_flag === "string") out.push(o.set_flag);
      for (const x of Object.values(o)) flagsSet(x, out);
    }
    return out;
  };
  const facts = (v: unknown, out: string[] = []): string[] => {
    if (Array.isArray(v)) for (const x of v) facts(x, out);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.belief && typeof o.belief === "object" && typeof (o.belief as { fact?: unknown }).fact === "string") out.push((o.belief as { fact: string }).fact);
      for (const x of Object.values(o)) facts(x, out);
    }
    return out;
  };
  for (const role of Object.values(content.roles)) {
    const r = role.resolve;
    const kind = r ? content.scenario.resolve?.kinds.find((k) => k.id === r.kind) : undefined;
    if (!r?.target || kind?.check !== "beliefs") continue;
    const words = r.target.split("|").filter(Boolean);
    // 그 시나리오에만 있는 이야기만 (여럿이 함께 쓰는 공통 이야기를 꼭 열리게 하면 다른 시나리오의 간격이 무너진다)
    const tags = new Set(role.storylet_tags.filter((t) => Object.values(content.roles).filter((o) => o.storylet_tags.includes(t)).length === 1));
    const mine = Object.values(content.storylets).filter((st) => st.tags.some((t) => tags.has(t)));
    const spine = mine.filter((st) => facts(st.choices).some((f) => words.some((w) => f.includes(w))));
    for (const st of spine) if (!st.essential) problems.push(`storylets.${st.id}: ${role.id}의 다짐(진실 알기)을 이루는 이야기다. essential: true로 둔다 (간격·하루 상한에 막히지 않게)`);
    // 줄기 이야기의 앞단 (12-254, PT15 섬: 장부의 조건 플래그를 주는 이야기가 이틀 동안 하나도 열리지 않았다): 조건 플래그를 주는 이야기 가운데 꼭 열리는 것이 있어야 한다
    const essentialSets = (flag: string) => mine.some((o) => o.essential && flagsSet(o.choices).includes(flag));
    const setBySomeStory = (flag: string) => mine.some((o) => flagsSet(o.choices).includes(flag));
    for (const st of spine) {
      const all = (st.when.flags_all ?? []).filter(setBySomeStory);
      const any = (st.when.flags_any ?? []).filter(setBySomeStory);
      for (const f of all) if (!essentialSets(f)) problems.push(`storylets.${st.id}: 줄기 이야기의 조건 ${f}를 주는 이야기 가운데 essential이 없다 (앞단이 간격에 막히면 줄기가 닫힌다)`);
      if (any.length && !any.some(essentialSets)) problems.push(`storylets.${st.id}: 줄기 이야기의 조건(flags_any: ${any.join(", ")})을 주는 이야기 가운데 essential이 하나도 없다`);
    }
  }
  return problems;
}

/**
 * 이야기의 자리·때 검사 (설계 목록 6-3·6-5): 모든 이야기는 실내외(when.indoor: true·false·"any")나 장소(when.places)를 적는다.
 * 글(제목·상황·변형)이 시간대 낱말(story_lint.segments)을 말하면 when.segments가 그 시간대 안이어야 한다
 */
export function checkStoryWhereWhen(content: Content): string[] {
  const problems: string[] = [];
  const words = content.scenario.story_lint?.segments ?? {};
  for (const s of Object.values(content.storylets)) {
    const where = `storylets.${s.id}`;
    if (s.when.indoor === undefined && !s.when.places && !s.when.place_kinds) problems.push(`${where}: when.indoor(true·false·"any")나 when.places·when.place_kinds를 적는다`);
    // 따옴표 안의 말은 다른 때를 가리킬 수 있어 보지 않는다 ("물때가 내일 새벽이야")
    const text = [s.title, s.setup, ...(s.variants ?? [])].join("\n").replace(/"[^"]*"|“[^”]*”|'[^']*'/g, "");
    const said = (Object.entries(words) as [string, string[]][]).filter(([, ws]) => ws.some((w) => text.includes(w)));
    if (!said.length) continue;
    const allowed = new Set(said.map(([seg]) => seg));
    const open = s.when.segments ?? [];
    if (!open.length || open.some((seg) => !allowed.has(seg))) {
      const hit = said.map(([seg, ws]) => `${seg}("${ws.find((w) => text.includes(w))}")`).join(", ");
      problems.push(`${where}: 글이 ${hit}를 말하는데 다른 시간대에도 열린다 (when.segments: [${[...allowed].join(", ")}] 또는 글을 고친다)`);
    }
  }
  return problems;
}

export function checkStorylets(content: Content): string[] {
  const problems: string[] = [];
  const clocks = new Set(Object.values(content.factions).flatMap((f) => f.plans.map((p) => p.id)));
  const harmLevels = new Set(content.scenario.condition_tracks.find((t) => t.id === content.scenario.harm_track)?.levels.map((l) => l.id) ?? []);
  for (const s of Object.values(content.storylets)) {
    const where = `storylets.${s.id}`;
    // 장소 조건과 앞 이야기 조건이 가리키는 것이 있는지 (12-251)
    if (s.when.places) {
      const known = new Set((s.when.zones ?? []).flatMap((z) => (content.locations[z]?.places ?? []).map((p) => p.id)));
      if (!s.when.zones?.length) problems.push(`${where}.when.places: 구역(when.zones)을 함께 적는다`);
      for (const p of s.when.places) if (s.when.zones?.length && !known.has(p)) problems.push(`${where}.when.places: ${s.when.zones.join("·")}에 없는 장소 ${p}`);
    }
    // 이야기 글이 자리·때를 말하면 조건도 맞춘다 (12-261)
    {
      const lint = content.scenario.story_lint;
      const text = [s.title, s.setup, ...(s.variants ?? [])].join("\n");
      const out = (lint?.outdoor ?? []).find((w) => text.includes(w));
      if (out && s.when.indoor !== false && !s.when.places && !s.when.place_kinds) problems.push(`${where}: 글이 바깥("${out}")을 말하는데 실내에서도 열린다. when.indoor: false 또는 when.places`);
      const wake = (lint?.waking ?? []).find((w) => text.includes(w));
      if (wake && !(s.when.activities?.length && s.when.activities.every((a) => a === "sleep" || a === "rest"))) problems.push(`${where}: 글이 잠에서 깨는 장면("${wake}")인데 깨어 있을 때도 열린다. when.activities: [sleep]`);
    }
    // 갇힌 사람이 배역인 이야기의 글이 가두는 곳이 아닌 장소를 말하면, 그 장소에서만 열린다 (12-259, PT15 튜토리얼: 포로 탈출 "창고 쪽"이 보급 창고)
    // 장소·종류를 적었으면 글자 맞추기를 쓰지 않는다 (12-300)
    if (Object.values(s.cast).some((role) => role.captive && role.enter !== false) && !s.when.places && !s.when.place_kinds) {
      const text = [s.title, s.setup, ...(s.variants ?? [])].join("\n");
      const zones = s.when.zones ?? Object.keys(content.locations);
      for (const z of zones) {
        const bad = (content.locations[z]?.places ?? []).filter((p) => !p.jail && [p.name, ...p.aliases].some((a) => wordSaid(text, a)));
        for (const p of bad) problems.push(`${where}: 갇힌 사람이 배역인데 글이 ${z}의 가두는 곳이 아닌 장소 "${p.name}"를 말한다 (그 장소에서만 열린다)`);
      }
    }
    if (s.when.after_storylet && !content.storylets[s.when.after_storylet.id]) problems.push(`${where}.when.after_storylet: 없는 이야기 ${s.when.after_storylet.id}`);
    const castKeys = new Set(Object.keys(s.cast));
    for (const c of s.choices) if (c.meets && !castKeys.has(c.meets)) problems.push(`${where}.choices.${c.id}.meets: 없는 배역 ${c.meets}`);
    for (const c of s.choices) for (const k of c.leaves ?? []) if (!castKeys.has(k)) problems.push(`${where}.choices.${c.id}.leaves: 없는 배역 ${k}`);
    for (const c of s.choices) if (c.goes_to && !(s.when.zones ?? []).some((z) => content.locations[z]?.places.some((p) => p.id === c.goes_to))) problems.push(`${where}.choices.${c.id}.goes_to: when.zones의 장소가 아니다 (${c.goes_to})`);
    // 배역 자리 뒤에 조사를 직접 적지 않는다: 받침에 따라 틀린다 (플레이 테스트 13: "늙은 그물꾼다", "{green}이"). {key:이/가}로 쓴다
    {
      const texts = [s.setup, ...(s.variants ?? []), s.ai_direction ?? "", ...s.choices.map((c) => c.label), JSON.stringify(s.choices)];
      for (const t of texts) {
        for (const m of t.matchAll(HARDCODED_PARTICLE)) problems.push(`${where}: {${m[1]}} 뒤에 조사 "${m[2]}"를 직접 적었다. {${m[1]}:${PAIR_HINT[m[2]!] ?? "이/가"}}로 쓴다`);
      }
    }
    // 믿음은 있었던 일의 기억이다 (12-310, 설계 목록 11): 엔진이 따로 갖고 있는 처지(손님인지, 어느 자리인지)나 "받아 주면 ~가 된다" 같은 앞날을 적으면
    // 처지가 바뀐 뒤에도 그대로 남는다 (손님 뒤 받아들여도 "나는 아직 손님이다"). story_lint.status_beliefs의 말을 쓰지 않는다
    {
      const words = content.scenario.story_lint?.status_beliefs ?? [];
      for (const c of s.choices) {
        const effects = [...c.effects, ...(c.outcomes ? [...c.outcomes.success, ...c.outcomes.partial, ...c.outcomes.miss] : [])];
        for (const e of effects) {
          if (!("belief" in e)) continue;
          const said = words.find((w) => e.belief.fact.includes(w));
          if (said) problems.push(`${where}.choices.${c.id}: 믿음에 지금 처지나 앞날("${said}")을 적었다. 있었던 일만 적는다 (처지는 상태 줄이 알린다)`);
        }
      }
    }
    // 성적 위협 배역을 쓰는 이야기는 성인 주제 태그가 있어야 한다 (12-59). 연애 자체는 성인 콘텐츠가 아니다
    const matureTag = content.scenario.content_rating?.tag;
    if (Object.values(s.cast).some((r) => r.menace) && (!matureTag || !s.tags.includes(matureTag))) problems.push(`${where}: 위협 배역(menace)을 쓰면 tags에 ${matureTag ?? "성인 주제 태그"}가 있어야 한다`);
    // 있으면 쓰는 배역: 상황·연출에는 못 쓰고, 쓰는 선택지는 when.cast에 적는다
    const optional = Object.entries(s.cast).filter(([, r]) => r.optional).map(([k]) => k);
    if (optional.length) {
      const refs = (text: string) => [...text.matchAll(/\{([a-z_]+)(?::[^}]+)?\}/g)].map((m) => m[1]!);
      for (const k of optional) if (refs(`${s.setup} ${s.ai_direction ?? ""}`).includes(k)) problems.push(`${where}: 있으면 쓰는 배역은 상황·연출에 쓸 수 없다: {${k}}`);
      for (const c of s.choices) {
        const effects = [...c.effects, ...(c.outcomes ? [...c.outcomes.success, ...c.outcomes.partial, ...c.outcomes.miss] : [])];
        const used = new Set([...refs(c.label), ...refs(JSON.stringify(effects).replace(/\\"/g, ""))]);
        for (const e of effects) for (const v of Object.values(e as Record<string, unknown>)) if (v && typeof v === "object") for (const f of ["who", "from", "to", "other"]) { const x = (v as Record<string, unknown>)[f]; if (typeof x === "string") used.add(x); }
        for (const k of optional) if (used.has(k) && !c.when?.cast?.includes(k)) problems.push(`${where}.choices.${c.id}: 있으면 쓰는 배역을 쓰면 when.cast에 적는다: ${k}`);
      }
    }
    for (const [key, role] of Object.entries(s.cast)) {
      for (const id of role.ids ?? []) if (!content.npcs[id]) problems.push(`${where}.cast.${key}: 알 수 없는 NPC ${id}`);
      if (role.faction && role.faction !== "other" && !isFactionAlias(role.faction) && Object.keys(content.factions).length && !content.factions[role.faction]) {
        problems.push(`${where}.cast.${key}: 알 수 없는 세력 ${role.faction}`);
      }
    }
    for (const id of s.when.zones ?? []) if (!content.locations[id]) problems.push(`${where}.when: 알 수 없는 구역 ${id}`);
    for (const [w, at] of [[s.when, `${where}.when`] as const, ...s.choices.flatMap((c) => (c.when ? [[c.when, `${where}.choices.${c.id}.when`] as const] : []))]) {
      for (const id of [...(w.has_items ?? []), ...(w.has_items_any ?? []), ...(w.equipped ?? [])]) if (!content.items[id]) problems.push(`${at}: 알 수 없는 아이템 ${id}`);
    }
    for (const id of [...Object.keys(s.when.clock_gte ?? {}), ...Object.keys(s.when.clock_lte ?? {})]) {
      if (!clocks.has(id)) problems.push(`${where}.when: 알 수 없는 세력 클락 ${id}`);
    }
    for (const [t, l] of Object.entries(s.when.conditions_at_least ?? {})) {
      if (!content.scenario.condition_tracks.find((x) => x.id === t)?.levels.some((x) => x.id === l)) problems.push(`${where}.when.conditions_at_least: 알 수 없는 트랙·단계 ${t}.${l}`);
    }
    if (s.when.harm_at_least && !harmLevels.has(s.when.harm_at_least)) problems.push(`${where}.when: 알 수 없는 부상 단계 ${s.when.harm_at_least}`);
    if (s.when.harm_at_most && !harmLevels.has(s.when.harm_at_most)) problems.push(`${where}.when: 알 수 없는 부상 단계 ${s.when.harm_at_most}`);
    const ids = s.choices.map((c) => c.id);
    if (new Set(ids).size !== ids.length) problems.push(`${where}: 선택지 id가 겹친다`);
    // 문장의 자리는 배역 이름이나 zone·scarce만 쓸 수 있다. victim은 복수 배역(vendetta)이 있을 때만 (12-135)
    const hasVendetta = Object.values(s.cast).some((r) => r.vendetta);
    const hasMourner = Object.values(s.cast).some((r) => r.mourner && !r.optional);
    const texts = [s.setup, ...(s.variants ?? []), s.ai_direction ?? "", ...s.choices.map((c) => c.label)];
    for (const c of s.choices) {
      for (const e of [...c.effects, ...(c.outcomes ? [...c.outcomes.success, ...c.outcomes.partial, ...c.outcomes.miss] : [])]) {
        if ("belief" in e) texts.push(e.belief.fact);
        if ("deed" in e) texts.push(e.deed.summary);
        if ("resolve" in e) texts.push(e.resolve.text);
        if ("resolve_step" in e) texts.push(e.resolve_step.text);
      }
    }
    for (const text of texts) {
      for (const [, key] of text.matchAll(/\{([a-z_]+)(?::[^}]+)?\}/g)) {
        if (key !== "zone" && key !== "scarce" && key !== "from" && key !== "to" && !(key === "victim" && hasVendetta) && !(key === "departed" && hasMourner) && !(key === "deceased" && s.when.funeral) && !(key === "bounty_by" && s.when.bounty) && !((key === "target" || key === "resolve") && s.when.resolve) && !(key === "agenda" && Object.values(s.cast).some((r) => r.agenda_half)) && !(key === "disaster_zone" && s.when.disaster) && !castKeys.has(key!)) problems.push(`${where}: 문장의 알 수 없는 자리 {${key}}`);
      }
    }
    for (const c of s.choices) {
      // 이야기가 주인공을 다치게 하는 것은 판정의 대가로만 (원칙 3)
      for (const e of [...c.effects, ...(c.outcomes?.success ?? [])]) if ("wound" in e) problems.push(`${where}.choices.${c.id}: wound는 판정의 partial·miss 결과에만 쓴다`);
    }
    // 구하러 간 쪽이 두고 간 쪽만큼 나쁘면 안 된다 (플레이 테스트 14: '꺼진 바닥'에서 구했는데 대가 있는 성공이 두고 가기와 같은 경상 → 치명상).
    // 판정 없는 갈래(두고 가기 등)가 배역을 다치게 하면: 판정 갈래의 성공은 그보다 덜, 대가 있는 성공은 그것을 넘지 않고 한 단계까지 (다친 만큼 - 나은 만큼)
    {
      const net = (effects: readonly StoryletEffect[], who: string) =>
        effects.reduce((n, e) => ("npc_hurt" in e && e.npc_hurt.who === who ? n + e.npc_hurt.steps : "npc_heal" in e && e.npc_heal.who === who ? n - e.npc_heal.steps : n), 0);
      for (const who of castKeys) {
        const leave = Math.max(0, ...s.choices.filter((c) => !c.check).map((c) => net(c.effects, who)));
        if (leave <= 0) continue;
        for (const c of s.choices) {
          if (!c.check || !c.outcomes) continue;
          if (net(c.outcomes.success, who) >= leave) problems.push(`${where}.choices.${c.id}.success: ${who}를 판정 없는 갈래(${leave}단계)만큼 다치게 한다. 구하러 간 판정이 이기면 덜 다쳐야 한다`);
          const partial = net(c.outcomes.partial, who);
          if (partial > Math.min(leave, 1)) problems.push(`${where}.choices.${c.id}.partial: ${who}를 ${partial}단계 다치게 한다. 대가 있는 성공은 판정 없는 갈래(${leave}단계)를 넘지 않고 한 단계까지`);
        }
      }
    }
    for (const c of s.choices) {
      const effects = [...c.effects, ...(c.outcomes ? [...c.outcomes.success, ...c.outcomes.partial, ...c.outcomes.miss] : [])];
      for (const e of effects) {
        const at = `${where}.choices.${c.id}`;
        if ("relation" in e && e.relation.who !== "commander" && !castKeys.has(e.relation.who)) problems.push(`${at}: 알 수 없는 배역 ${e.relation.who}`);
        const whos =
          "npc_relation" in e ? [e.npc_relation.from, e.npc_relation.to]
          : "npc_hurt" in e ? [e.npc_hurt.who]
          : "put_down" in e ? [e.put_down.who]
          : "npc_rank" in e ? [e.npc_rank.who]
          : "end_romance" in e ? [e.end_romance.who]
          : "npc_heal" in e ? [e.npc_heal.who]
          : "grudge" in e ? [e.grudge.who]
          : [];
        for (const who of whos) if (who !== "commander" && !castKeys.has(who)) problems.push(`${at}: 알 수 없는 배역 ${who}`);
        if ("give_item" in e) {
          if (!content.items[e.give_item.item]) problems.push(`${at}: 알 수 없는 아이템 ${e.give_item.item}`);
          if (e.give_item.from && e.give_item.from !== "commander" && !castKeys.has(e.give_item.from)) problems.push(`${at}: 알 수 없는 배역 ${e.give_item.from}`);
        }
        if ("take_item" in e && !content.items[e.take_item.item]) problems.push(`${at}: 알 수 없는 아이템 ${e.take_item.item}`);
        if ("light_fire" in e && !content.items[e.light_fire.item]) problems.push(`${at}: 알 수 없는 아이템 ${e.light_fire.item}`);
        if ("lose_item" in e && !content.items[e.lose_item.item]) problems.push(`${at}: 알 수 없는 아이템 ${e.lose_item.item}`);
        if ("capture_player" in e && !isFactionAlias(e.capture_player.by) && !content.factions[e.capture_player.by]) problems.push(`${at}: 알 수 없는 세력 ${e.capture_player.by}`);
        if ("train" in e && !content.scenario.moves.some((m) => m.id === e.train.skill)) problems.push(`${at}: 알 수 없는 스킬 ${e.train.skill}`);
        if ("cultivate" in e && !content.scenario.resources.some((r) => r.id === e.cultivate.resource)) problems.push(`${at}: 알 수 없는 자원 ${e.cultivate.resource}`);
        if ("clock" in e && !clocks.has(e.clock.id)) problems.push(`${at}: 알 수 없는 세력 클락 ${e.clock.id}`);
        if ("overhear" in e && !["other", "enemy", "captor", "zone_owner"].includes(e.overhear.faction) && !content.factions[e.overhear.faction]) problems.push(`${at}: 알 수 없는 세력 ${e.overhear.faction}`);
        if ("faction_morale" in e && !isFactionAlias(e.faction_morale.faction) && !content.factions[e.faction_morale.faction]) {
          problems.push(`${at}: 알 수 없는 세력 ${e.faction_morale.faction}`);
        }
      }
    }
  }
  // 결과 조건(goal)이 있는 임무는 그것을 채우는 이야기가 있어야 한다 (플레이 테스트 11)
  for (const m of Object.values(content.missions)) {
    if (!m.requirements.some((r) => "goal" in r)) continue;
    const filled = Object.values(content.storylets).some(
      (st) => st.when.mission?.includes(m.id) && st.choices.some((c) => [...(c.effects ?? []), ...Object.values(c.outcomes ?? {}).flat()].some((e) => "mission_goal" in e)),
    );
    if (!filled) problems.push(`임무 ${m.id}: 결과 조건(goal)을 채우는 이야기(when.mission + mission_goal)가 없다`);
  }
  for (const st of Object.values(content.storylets)) for (const id of st.when.mission ?? []) if (!content.missions[id]) problems.push(`이야기 ${st.id}: 알 수 없는 임무 ${id}`);
  // 배달 일감의 짐·받아 올 값 (F5, 12-237)
  for (const m of Object.values(content.missions)) {
    const ids = [...Object.keys(m.carries ?? {}), ...Object.keys(m.collects ?? {}), ...m.requirements.flatMap((r) => ("deliver" in r ? [r.deliver] : []))];
    for (const id of ids) if (!content.items[id]) problems.push(`임무 ${m.id}: 알 수 없는 아이템 ${id}`);
  }
  // 구역 안의 장소 id는 구역 안에서 하나씩 (12-244)
  for (const l of Object.values(content.locations)) {
    const ids = l.places.map((p) => p.id);
    for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) problems.push(`locations.${l.id}.places: 장소 id ${id}가 겹친다`);
    // 이웃과 길 (장소 개편): 없는 장소·구역, 길이 아닌데 to
    for (const p of l.places) {
      for (const n of p.near ?? []) if (!ids.includes(n) || n === p.id) problems.push(`locations.${l.id}.places.${p.id}.near: ${n === p.id ? "자기 자신" : `이 구역에 없는 장소 ${n}`}`);
      for (const z of p.to ?? []) if (!content.locations[z]) problems.push(`locations.${l.id}.places.${p.id}.to: 알 수 없는 구역 ${z}`);
      if (p.to?.length && !p.road) problems.push(`locations.${l.id}.places.${p.id}: 길이 아닌데 to가 있다 (road: true)`);
    }
    problems.push(...checkZonePlaces(content, l.id));
  }
  // 부탁 물건은 세계 어딘가에서 구할 수 있어야 한다: 장사꾼이 들여오거나 뒤져서 나온다 (12-239)
  for (const n of Object.values(content.npcs)) {
    for (const f of n.favors ?? []) if (content.items[f.item.id] && itemSources(content, f.item.id).length === 0) problems.push(`npcs.${n.id}.favors.${f.id}: 구할 곳이 없다: ${f.item.id} (장사꾼 restock·구역 loot)`);
  }
  // 임무 브리핑의 낌새 (12-237): 짝을 말하면 buddy, 알아 오라면 learns가 있어야 한다. 말은 시나리오 팩의 mission_hints
  {
    const hints = content.scenario.mission_hints;
    const buddyRe = hints.buddy.map((h) => new RegExp(h));
    const learnsRe = hints.learns.map((h) => new RegExp(h));
    for (const m of Object.values(content.missions)) {
      // 분대가 있는 역할만 받는 임무는 분대가 곁에 있다
      const roles = Object.values(content.roles).filter((r) => r.missions.includes(m.id));
      const squadOnly = roles.length > 0 && roles.every((r) => (r.squad?.length ?? 0) > 0);
      if (!m.buddy && !squadOnly && buddyRe.some((re) => re.test(m.briefing))) problems.push(`임무 ${m.id}: 브리핑이 짝을 말하는데 buddy가 없다`);
      if (!m.learns && learnsRe.some((re) => re.test(m.briefing))) problems.push(`임무 ${m.id}: 브리핑이 알아 오라는데 완수 때 알게 되는 것(learns)이 없다`);
    }
  }
  // 태그로 여는 이야기 (D5·D6): 그 태그의 이야기가 하나는 있어야 한다
  const hasStories = Object.keys(content.storylets).length > 0;
  for (const [what, tag] of [["infestation.arrival", content.scenario.infestation?.arrival?.tag], ["alarm", content.scenario.alarm?.tag]] as const) {
    if (hasStories && tag && !Object.values(content.storylets).some((st) => st.tags.includes(tag))) problems.push(`${what}: 태그 ${tag}인 이야기가 없다`);
  }
  for (const st of Object.values(content.storylets)) for (const f of [...(st.when.owners ?? []), ...(st.when.owners_not ?? [])]) if (!content.factions[f]) problems.push(`이야기 ${st.id}: 알 수 없는 세력 ${f}`);
  return problems;
}

function listYamlFiles(dir: string): string[] {
  let names: string[];
  try {
    if (!statSync(dir).isDirectory()) return [];
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort()
    .map((name) => join(dir, name));
}

/** 효과·배역의 무리 자리에 쓸 수 있는 별칭: own(주인공의 무리), zone_owner(지금 구역의 주인, 12-54) */
function isFactionAlias(x: string): boolean {
  return x === "own" || x === "zone_owner" || x === "captor" || x === "bounty";
}

/** 캐릭터 설정 (4.6.4): 칸·짝·트레잇·시나리오·무리·뒷받침의 참조, 성격 조건의 이름, NPC 설정의 조건 충족 */
function checkSettingsContent(content: Content): string[] {
  const problems: string[] = [];
  const s = content.scenario;
  const set = s.settings;
  const poles = new Set((s.persona?.axes ?? []).flatMap((a) => [a.high, a.low]));
  if (set) {
    const slots = new Set(set.slots.map((x) => x.id));
    const ids = new Set<string>();
    for (const x of set.items) {
      const at = `scenario.settings.${x.id}`;
      if (ids.has(x.id)) problems.push(`${at}: id 중복`);
      ids.add(x.id);
      if (!slots.has(x.slot)) problems.push(`${at}: 알 수 없는 칸 ${x.slot}`);
      for (const pole of Object.keys(x.requires)) if (!poles.has(pole)) problems.push(`${at}.requires: 성격 축에 없는 이름 ${pole}`);
      for (const t of x.trait_opposites) if (!s.traits.some((y) => y.id === t)) problems.push(`${at}.trait_opposites: 알 수 없는 트레잇 ${t}`);
      for (const r of [...x.roles_none, ...x.clashes_roles]) if (!content.roles[r]) problems.push(`${at}: 알 수 없는 시나리오 ${r}`);
      for (const f of x.factions_none) if (!content.factions[f]) problems.push(`${at}.factions_none: 알 수 없는 무리 ${f}`);
      const b = x.backing;
      if (b?.trait && !s.traits.some((y) => y.id === b.trait)) problems.push(`${at}.backing.trait: 알 수 없는 트레잇 ${b.trait}`);
      for (const item of [b?.stash?.item, b?.keepsake]) if (item && !content.items[item]) problems.push(`${at}.backing: 알 수 없는 아이템 ${item}`);
      if (b?.kin_enemy && !(s.custom_start?.kin ?? []).length) problems.push(`${at}.backing.kin_enemy: custom_start.kin(연고 틀)이 없다`);
    }
    for (const x of set.items) for (const o of x.opposites) if (!ids.has(o)) problems.push(`scenario.settings.${x.id}.opposites: 알 수 없는 설정 ${o}`);
  }
  for (const npc of Object.values(content.npcs)) {
    if (!npc.settings?.length) continue;
    const at = `npcs.${npc.id}.settings`;
    const persona = personaOf(content, { id: npc.id, traits: npc.traits ?? [], persona: null });
    for (const id of npc.settings) {
      const x = settingOf(s, id);
      if (!x) problems.push(`${at}: 알 수 없는 설정 ${id}`);
      else for (const q of unmetRequires(s, persona, x.requires)) problems.push(`${at}.${id}: 성격 조건을 채우지 못한다 (${q})`);
    }
  }
  return problems;
}

/**
 * 성인 콘텐츠의 선 (공통 규칙 21, docs/mature-plan.md 6): 성인 직업은 겉 직업이 있고 주인공이 맡지 않으며 사람은 성인만,
 * 성인 카드 줄도 성인만, 성인·인신매매 이야기의 ai_direction에는 행위를 그리지 않는다는 선(LINE_MARK)을 적는다
 */
export function checkMatureLines(content: Content): string[] {
  const problems: string[] = [];
  const adultAge = content.scenario.content_rating?.adult_age ?? 18;
  for (const o of content.scenario.occupations) {
    const at = `scenario.occupations.${o.id}`;
    if (o.mature && !o.cover) problems.push(`${at}: 성인 직업에 겉 직업(cover)이 없다`);
    if (!o.mature && o.cover) problems.push(`${at}: 성인 직업이 아닌데 cover가 있다`);
  }
  const matureOcc = new Set(content.scenario.occupations.filter((o) => o.mature).map((o) => o.id));
  for (const r of Object.values(content.roles)) if (r.occupation && matureOcc.has(r.occupation)) problems.push(`roles.${r.id}.occupation: 성인 직업은 주인공이 맡지 않는다 (${r.occupation})`);
  for (const n of Object.values(content.npcs)) {
    if (n.occupation && matureOcc.has(n.occupation) && !(n.age >= adultAge)) problems.push(`npcs.${n.id}: 성인 직업은 ${adultAge}세 이상만 (지금 ${n.age})`);
    if (n.occupation_cover && !(n.occupation && matureOcc.has(n.occupation))) problems.push(`npcs.${n.id}.occupation_cover: 성인 직업이 아닌데 겉 직업이 있다`);
    if (n.mature && !(n.age >= adultAge)) problems.push(`npcs.${n.id}.mature: 성인 카드 줄은 ${adultAge}세 이상만`);
  }
  const tag = content.scenario.content_rating?.tag;
  for (const s of Object.values(content.storylets)) {
    const lined = (!!tag && s.tags.includes(tag)) || s.tags.includes(TRAFFICKING_TAG) || s.tags.includes(CANNIBAL_TAG);
    if (lined && !(s.ai_direction ?? "").includes(LINE_MARK)) problems.push(`storylets.${s.id}.ai_direction: 성인·인신매매·인육 이야기는 "${LINE_MARK} — 행위는 그리지 않는다…"를 적는다`);
  }
  return problems;
}

/** 길 위의 일·야영 이야기가 다른 무리의 부대원(party_extra)을 배역으로 들이면 근처에 실제 그 무리 부대가 있어야 한다 (PT31: 부대가 하나도 없는데 매복·통행세가 열렸다) */
/** 다른 무리의 바깥 무리를 그리는 글 (party_story를 정해야 하는 이야기를 찾는 낌새) */
const PARTY_WORDS = /순찰|정찰대|정찰병|약탈조|추격|쫓는 사람|분대가 온다|무장한 (?:무리|사람들|일행)/;

export function checkPartyStories(content: Content): string[] {
  const problems: string[] = [];
  if (!content.scenario.war?.parties) return problems;
  // 바깥 무리를 그리는 이야기는 실제 부대에 묶을지(party_story: true + party_near) 아닌지(false) 정한다 (이야기 묶음 사용자 결정)
  for (const st of Object.values(content.storylets)) {
    if (st.party_story === true && !st.when.party_near) problems.push(`storylets.${st.id}: party_story: true면 when.party_near가 있어야 한다 (근처에 실제 부대가 있을 때만)`);
    if (st.party_story !== undefined || st.when.indoor === true || st.when.party_near) continue;
    const text = JSON.stringify([st.title, st.setup, st.variants ?? [], st.ai_direction ?? "", st.choices.map((c) => c.label)]);
    if (PARTY_WORDS.test(text)) problems.push(`storylets.${st.id}: 다른 무리의 바깥 무리(순찰·정찰·추격·약탈조)를 그리는 글이 있다. 실제 부대에 묶으려면 party_story: true와 when.party_near, 무리 부대가 아니면 party_story: false`);
  }
  const partyExtra = new Map(Object.values(content.factions).flatMap((f) => (f.party_extra ? [[f.party_extra, f.id] as const] : [])));
  for (const st of Object.values(content.storylets)) {
    if (!st.tags.some((t) => t === "road" || t === "camp")) continue;
    const only = st.when.factions;
    for (const [key, role] of Object.entries(st.cast)) {
      const f = role.extra ? partyExtra.get(role.extra) : undefined;
      if (!f || (only && only.every((x) => x === f))) continue;
      if (st.when.party_near?.faction !== f) problems.push(`storylets.${st.id}.cast.${key}: ${content.factions[f]?.name ?? f}의 부대원이 나오는 길 위·야영 이야기는 when.party_near { faction: ${f} } (근처에 실제 그 무리 부대)`);
    }
  }
  return problems;
}
