import { RESOLVE_TARGET } from "../scenario/schema.ts";
import { checkHistory } from "../game/background.ts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { occupationById } from "../game/occupation.ts";
import { checkSkills, layoutCost } from "../game/creation.ts";
import { join, relative } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { createContentSchemas, type Content } from "./schemas.ts";
import { loadScenario, ScenarioError } from "../scenario/scenario.ts";
import { readLoreDocs } from "../rag/lore.ts";
import { LoreFormatError } from "../rag/chunk.ts";
import { itemSources } from "./sources.ts";
import { settingOf, unmetRequires } from "../game/settings.ts";
import { personaOf } from "../engine/persona.ts";

export class ContentError extends Error {
  override name = "ContentError";
  constructor(readonly problems: string[]) {
    super(`콘텐츠 검증 실패 (${problems.length}건)\n${problems.map((p) => `- ${p}`).join("\n")}`);
  }
}

type Kind = "items" | "roles" | "npcs" | "beliefs" | "missions" | "factions" | "locations" | "storylets" | "extras";

/**
 * 시나리오 팩 폴더(content/scenarios/<id>/)를 읽어 검증한다.
 * - scenario.yaml을 먼저 읽고, 그 ID들로 콘텐츠 스키마를 만든다
 * - 한 파일에 객체 하나 또는 목록을 둘 수 있다. 종류별 폴더가 없으면 빈 목록으로 본다
 * - 문제는 한 번에 모아서 보고한다 (첫 오류에서 멈추지 않음)
 */
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
  };
  const problems: string[] = [];
  const content: Content = { scenario, items: {}, roles: {}, npcs: {}, beliefs: {}, missions: {}, factions: {}, locations: {}, storylets: {}, extras: {} };

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
    return ok ? null : `다짐 ${kindId}의 대상 ${target}을(를) 모른다`;
  };
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
  for (const f of Object.values(content.factions)) {
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
      for (const [key, r] of Object.entries(st.cast)) if (r.recall && !kept.has(r.recall)) problems.push(`storylets.${st.id}.cast.${key}: recall ${r.recall}을(를) keep하는 이야기가 없다`);
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
  const plans = Object.values(content.factions).flatMap((f) => f.plans.map((p) => p.id));
  for (const m of Object.values(content.missions)) {
    if (m.advances && !plans.includes(m.advances.clock)) problems.push(`missions.${m.id}.advances: 알 수 없는 세력 클락 ${m.advances.clock}`);
    if (m.where && m.where !== "outside" && m.where !== "near" && m.where !== "enemy" && !content.locations[m.where]) problems.push(`missions.${m.id}.where: 알 수 없는 구역 ${m.where}`);
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
export function checkStorylets(content: Content): string[] {
  const problems: string[] = [];
  const clocks = new Set(Object.values(content.factions).flatMap((f) => f.plans.map((p) => p.id)));
  const harmLevels = new Set(content.scenario.condition_tracks.find((t) => t.id === content.scenario.harm_track)?.levels.map((l) => l.id) ?? []);
  for (const s of Object.values(content.storylets)) {
    const where = `storylets.${s.id}`;
    const castKeys = new Set(Object.keys(s.cast));
    // 배역 자리 뒤에 조사를 직접 적지 않는다: 받침에 따라 틀린다 (플레이 테스트 13: "늙은 그물꾼다", "{green}이"). {key:이/가}로 쓴다
    {
      const texts = [s.setup, ...(s.variants ?? []), s.ai_direction ?? "", ...s.choices.map((c) => c.label), JSON.stringify(s.choices)];
      for (const t of texts) {
        for (const m of t.matchAll(HARDCODED_PARTICLE)) problems.push(`${where}: {${m[1]}} 뒤에 조사 "${m[2]}"를 직접 적었다. {${m[1]}:${PAIR_HINT[m[2]!] ?? "이/가"}}로 쓴다`);
      }
    }
    // 성적 위협 배역을 쓰는 이야기는 성인 주제 태그가 있어야 한다 (12-59). 연애 자체는 성인 콘텐츠가 아니다
    const matureTag = content.scenario.content_rating?.tag;
    if (Object.values(s.cast).some((r) => r.menace) && (!matureTag || !s.tags.includes(matureTag))) problems.push(`${where}: 위협 배역(menace)을 쓰면 tags에 ${matureTag ?? "성인 주제 태그"}가 있어야 한다`);
    // 있으면 쓰는 배역: 상황·연출에는 못 쓰고, 쓰는 선택지는 when.cast에 적는다
    const optional = Object.entries(s.cast).filter(([, r]) => r.optional).map(([k]) => k);
    if (optional.length) {
      const refs = (text: string) => [...text.matchAll(/\{([a-z_]+)(?::[^}]+)?\}/g)].map((m) => m[1]!);
      for (const k of optional) if (refs(`${s.setup} ${s.ai_direction ?? ""}`).includes(k)) problems.push(`${where}: 있으면 쓰는 배역 {${k}}은(는) 상황·연출에 쓸 수 없다`);
      for (const c of s.choices) {
        const effects = [...c.effects, ...(c.outcomes ? [...c.outcomes.success, ...c.outcomes.partial, ...c.outcomes.miss] : [])];
        const used = new Set([...refs(c.label), ...refs(JSON.stringify(effects).replace(/\\"/g, ""))]);
        for (const e of effects) for (const v of Object.values(e as Record<string, unknown>)) if (v && typeof v === "object") for (const f of ["who", "from", "to", "other"]) { const x = (v as Record<string, unknown>)[f]; if (typeof x === "string") used.add(x); }
        for (const k of optional) if (used.has(k) && !c.when?.cast?.includes(k)) problems.push(`${where}.choices.${c.id}: 있으면 쓰는 배역 ${k}을(를) 쓰면 when.cast에 적는다`);
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
  }
  // 부탁 물건은 세계 어딘가에서 구할 수 있어야 한다: 장사꾼이 들여오거나 뒤져서 나온다 (12-239)
  for (const n of Object.values(content.npcs)) {
    for (const f of n.favors ?? []) if (content.items[f.item.id] && itemSources(content, f.item.id).length === 0) problems.push(`npcs.${n.id}.favors.${f.id}: ${f.item.id}을(를) 구할 곳이 없다 (장사꾼 restock·구역 loot)`);
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
  for (const st of Object.values(content.storylets)) for (const f of st.when.owners ?? []) if (!content.factions[f]) problems.push(`이야기 ${st.id}: 알 수 없는 세력 ${f}`);
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
