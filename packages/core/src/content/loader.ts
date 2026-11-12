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

type Kind = "items" | "roles" | "npcs" | "beliefs" | "missions" | "factions" | "locations";

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
  };
  const problems: string[] = [];
  const content: Content = { scenario, items: {}, roles: {}, npcs: {}, beliefs: {}, missions: {}, factions: {}, locations: {} };

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
      if (!content.locations[plan.target]) problems.push(`factions.${faction.id}.plans.${plan.id}: 알 수 없는 구역 ${plan.target}`);
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
  const plans = Object.values(content.factions).flatMap((f) => f.plans.map((p) => p.id));
  if (new Set(plans).size !== plans.length) problems.push("factions: 세력 클락(plans) id가 겹친다");
  for (const npc of Object.values(content.npcs)) {
    factionRef(`npcs.${npc.id}`, npc.faction);
    for (const itemId of npc.start_inventory) {
      if (!content.items[itemId]) problems.push(`npcs.${npc.id}: 알 수 없는 아이템 ${itemId}`);
    }
    if (npc.id === "player") problems.push(`npcs.${npc.id}: player는 예약된 id다`);
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
