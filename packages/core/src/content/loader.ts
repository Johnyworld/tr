import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  beliefPresetSchema,
  itemContentSchema,
  npcContentSchema,
  roleContentSchema,
  type Content,
} from "./schemas.ts";

export class ContentError extends Error {
  override name = "ContentError";
  constructor(readonly problems: string[]) {
    super(`콘텐츠 검증 실패 (${problems.length}건)\n${problems.map((p) => `- ${p}`).join("\n")}`);
  }
}

/** 종류별 하위 폴더와 스키마. 폴더가 아직 없으면 빈 목록으로 본다 */
const KINDS = {
  items: itemContentSchema,
  roles: roleContentSchema,
  npcs: npcContentSchema,
  beliefs: beliefPresetSchema,
} as const;

/**
 * content/ 폴더의 YAML을 읽어 검증한다.
 * - 한 파일에 객체 하나 또는 목록을 둘 수 있다
 * - 문제는 한 번에 모아서 보고한다 (첫 오류에서 멈추지 않음)
 */
export function loadContent(contentDir: string): Content {
  const problems: string[] = [];
  const content: Content = { items: {}, roles: {}, npcs: {}, beliefs: {} };

  for (const [kind, schema] of Object.entries(KINDS) as [keyof typeof KINDS, z.ZodType][]) {
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
    if (role.beliefs_preset && !content.beliefs[role.beliefs_preset]) {
      problems.push(`roles.${role.id}: 알 수 없는 시작 지식 ${role.beliefs_preset}`);
    }
  }
  for (const npc of Object.values(content.npcs)) {
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
