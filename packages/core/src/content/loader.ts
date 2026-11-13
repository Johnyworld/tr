import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { createContentSchemas, type Content } from "./schemas.ts";
import { loadScenario, ScenarioError } from "../scenario/scenario.ts";
import { readLoreDocs } from "../rag/lore.ts";
import { LoreFormatError } from "../rag/chunk.ts";

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
function checkReferences(content: Content): string[] {
  const problems: string[] = [];
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
  for (const role of Object.values(content.roles)) factionRef(`roles.${role.id}`, role.faction);
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
  for (const item of Object.keys(content.scenario.consumables)) {
    if (!content.items[item]) problems.push(`scenario.consumables: 알 수 없는 아이템 ${item}`);
  }
  const battle = content.scenario.battle;
  if (battle) {
    for (const p of battle.preparations) {
      if (p.requires_item && !content.items[p.requires_item]) problems.push(`scenario.battle.preparations.${p.id}: 알 수 없는 아이템 ${p.requires_item}`);
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
    const all = st.choices.flatMap((c) => [...c.effects, ...Object.values(c.outcomes ?? {}).flat()]);
    for (const e of all) {
      if ("faction_resource" in e && !resources.has(e.faction_resource.resource)) problems.push(`storylets.${st.id}: 알 수 없는 자원 ${e.faction_resource.resource}`);
      if ("faction_resource" in e && e.faction_resource.faction !== "own" && !content.factions[e.faction_resource.faction]) problems.push(`storylets.${st.id}: 알 수 없는 세력 ${e.faction_resource.faction}`);
      if ("npc_depart" in e && e.npc_depart.to_faction && !content.factions[e.npc_depart.to_faction]) problems.push(`storylets.${st.id}: 알 수 없는 세력 ${e.npc_depart.to_faction}`);
      if ("faction_relation" in e) {
        for (const f of [e.faction_relation.from, e.faction_relation.to]) if (f !== "own" && !content.factions[f]) problems.push(`storylets.${st.id}: 알 수 없는 세력 ${f}`);
      }
      if ("body" in e) {
        if (e.body.track === content.scenario.harm_track) problems.push(`storylets.${st.id}: body로 부상 트랙을 바꿀 수 없다 (원칙 3)`);
        else if (!content.scenario.condition_tracks.some((t) => t.id === e.body.track)) problems.push(`storylets.${st.id}: 알 수 없는 상태 트랙 ${e.body.track}`);
      }
      if ("join_faction" in e && !content.factions[e.join_faction.faction]) problems.push(`storylets.${st.id}: 알 수 없는 세력 ${e.join_faction.faction}`);
      if ("npc_body" in e) {
        if (e.npc_body.track === content.scenario.harm_track) problems.push(`storylets.${st.id}: npc_body로 부상 트랙을 바꿀 수 없다`);
        else if (!content.scenario.condition_tracks.some((t) => t.id === e.npc_body.track)) problems.push(`storylets.${st.id}: 알 수 없는 상태 트랙 ${e.npc_body.track}`);
      }
      if ("debt" in e && e.debt.faction !== "own" && !content.factions[e.debt.faction]) problems.push(`storylets.${st.id}: 알 수 없는 세력 ${e.debt.faction}`);
      if ("npc_capture" in e) {
        if (e.npc_capture.by !== "own" && !content.factions[e.npc_capture.by]) problems.push(`storylets.${st.id}: 알 수 없는 세력 ${e.npc_capture.by}`);
        if (e.npc_capture.zone && !content.locations[e.npc_capture.zone]) problems.push(`storylets.${st.id}: 알 수 없는 구역 ${e.npc_capture.zone}`);
      }
    }
    for (const f of st.when.factions ?? []) if (f !== "none" && !content.factions[f]) problems.push(`storylets.${st.id}.when.factions: 알 수 없는 세력 ${f}`);
    for (const [key, role] of Object.entries(st.cast)) {
      if (role.extra && !content.extras[role.extra]) problems.push(`storylets.${st.id}.cast.${key}: 알 수 없는 엑스트라 틀 ${role.extra}`);
      if (role.keep && !role.extra) problems.push(`storylets.${st.id}.cast.${key}: keep은 extra와 함께 쓴다`);
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
  }
  problems.push(...checkStorylets(content));
  const plans = Object.values(content.factions).flatMap((f) => f.plans.map((p) => p.id));
  for (const m of Object.values(content.missions)) {
    if (m.advances && !plans.includes(m.advances.clock)) problems.push(`missions.${m.id}.advances: 알 수 없는 세력 클락 ${m.advances.clock}`);
  }
  if (new Set(plans).size !== plans.length) problems.push("factions: 세력 클락(plans) id가 겹친다");
  for (const ex of Object.values(content.extras)) {
    if (ex.faction) factionRef(`extras.${ex.id}`, ex.faction);
    for (const i of ex.inventory) if (!content.items[i.item]) problems.push(`extras.${ex.id}: 알 수 없는 아이템 ${i.item}`);
    if (ex.age[0] > ex.age[1]) problems.push(`extras.${ex.id}: 나이 범위가 거꾸로다`);
  }
  for (const npc of Object.values(content.npcs)) {
    factionRef(`npcs.${npc.id}`, npc.faction);
    if (npc.zone && Object.keys(content.locations).length && !content.locations[npc.zone]) problems.push(`npcs.${npc.id}: 알 수 없는 구역 ${npc.zone}`);
    for (const itemId of npc.start_inventory) {
      if (!content.items[itemId]) problems.push(`npcs.${npc.id}: 알 수 없는 아이템 ${itemId}`);
    }
    if (npc.id === "player") problems.push(`npcs.${npc.id}: player는 예약된 id다`);
  }
  return problems;
}

/** 스토리렛이 가리키는 인물·아이템·구역·클락·배역이 있는지 */
function checkStorylets(content: Content): string[] {
  const problems: string[] = [];
  const clocks = new Set(Object.values(content.factions).flatMap((f) => f.plans.map((p) => p.id)));
  const harmLevels = new Set(content.scenario.condition_tracks.find((t) => t.id === content.scenario.harm_track)?.levels.map((l) => l.id) ?? []);
  for (const s of Object.values(content.storylets)) {
    const where = `storylets.${s.id}`;
    const castKeys = new Set(Object.keys(s.cast));
    for (const [key, role] of Object.entries(s.cast)) {
      for (const id of role.ids ?? []) if (!content.npcs[id]) problems.push(`${where}.cast.${key}: 알 수 없는 NPC ${id}`);
      if (role.faction && role.faction !== "own" && Object.keys(content.factions).length && !content.factions[role.faction]) {
        problems.push(`${where}.cast.${key}: 알 수 없는 세력 ${role.faction}`);
      }
    }
    for (const id of s.when.zones ?? []) if (!content.locations[id]) problems.push(`${where}.when: 알 수 없는 구역 ${id}`);
    for (const id of s.when.has_items ?? []) if (!content.items[id]) problems.push(`${where}.when: 알 수 없는 아이템 ${id}`);
    for (const id of [...Object.keys(s.when.clock_gte ?? {}), ...Object.keys(s.when.clock_lte ?? {})]) {
      if (!clocks.has(id)) problems.push(`${where}.when: 알 수 없는 세력 클락 ${id}`);
    }
    if (s.when.harm_at_least && !harmLevels.has(s.when.harm_at_least)) problems.push(`${where}.when: 알 수 없는 부상 단계 ${s.when.harm_at_least}`);
    const ids = s.choices.map((c) => c.id);
    if (new Set(ids).size !== ids.length) problems.push(`${where}: 선택지 id가 겹친다`);
    // 문장의 자리는 배역 이름이나 zone·scarce만 쓸 수 있다
    const texts = [s.setup, s.ai_direction ?? "", ...s.choices.map((c) => c.label)];
    for (const c of s.choices) {
      for (const e of [...c.effects, ...(c.outcomes ? [...c.outcomes.success, ...c.outcomes.partial, ...c.outcomes.miss] : [])]) {
        if ("belief" in e) texts.push(e.belief.fact);
        if ("deed" in e) texts.push(e.deed.summary);
      }
    }
    for (const text of texts) {
      for (const [, key] of text.matchAll(/\{([a-z_]+)(?::[^}]+)?\}/g)) {
        if (key !== "zone" && key !== "scarce" && !castKeys.has(key!)) problems.push(`${where}: 문장의 알 수 없는 자리 {${key}}`);
      }
    }
    for (const c of s.choices) {
      const effects = [...c.effects, ...(c.outcomes ? [...c.outcomes.success, ...c.outcomes.partial, ...c.outcomes.miss] : [])];
      for (const e of effects) {
        const at = `${where}.choices.${c.id}`;
        if ("relation" in e && e.relation.who !== "commander" && !castKeys.has(e.relation.who)) problems.push(`${at}: 알 수 없는 배역 ${e.relation.who}`);
        if ("give_item" in e) {
          if (!content.items[e.give_item.item]) problems.push(`${at}: 알 수 없는 아이템 ${e.give_item.item}`);
          if (e.give_item.from && e.give_item.from !== "commander" && !castKeys.has(e.give_item.from)) problems.push(`${at}: 알 수 없는 배역 ${e.give_item.from}`);
        }
        if ("take_item" in e && !content.items[e.take_item.item]) problems.push(`${at}: 알 수 없는 아이템 ${e.take_item.item}`);
        if ("clock" in e && !clocks.has(e.clock.id)) problems.push(`${at}: 알 수 없는 세력 클락 ${e.clock.id}`);
        if ("faction_morale" in e && e.faction_morale.faction !== "own" && !content.factions[e.faction_morale.faction]) {
          problems.push(`${at}: 알 수 없는 세력 ${e.faction_morale.faction}`);
        }
      }
    }
  }
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
