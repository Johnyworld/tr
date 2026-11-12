import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ContentError, loadContent } from "./loader.ts";
import type { Content } from "./schemas.ts";

/**
 * 월드 팩 목록 (기획서 12.3). `content/scenarios/<id>/scenario.yaml`이 있는 폴더 하나가 월드 하나다.
 * 코드의 "scenario 팩" = 플레이어에게 보이는 "월드", 팩 안의 role = 플레이어에게 보이는 "시나리오".
 * only를 주면 그 팩만 읽는다 (SCENARIO 환경 변수). 하나라도 깨져 있으면 모두 모아 ContentError
 */
export function loadContentPacks(root: string, only?: string): Content[] {
  const ids = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "scenario.yaml")))
    .map((d) => d.name)
    .filter((id) => !only || id === only)
    .sort();
  if (ids.length === 0) throw new ContentError([only ? `월드 팩이 없다: ${join(root, only)}` : `월드 팩이 하나도 없다: ${root}`]);
  const packs: Content[] = [];
  const problems: string[] = [];
  for (const id of ids) {
    try {
      const content = loadContent(join(root, id));
      if (content.scenario.id !== id) problems.push(`${id}: scenario.yaml의 id(${content.scenario.id})가 폴더 이름과 다르다`);
      packs.push(content);
    } catch (err) {
      if (err instanceof ContentError) problems.push(...err.problems.map((p) => `${id}: ${p}`));
      else throw err;
    }
  }
  if (problems.length) throw new ContentError(problems);
  return packs;
}

/** 월드 고르기에 보이는 것 */
export function worldInfo(content: Content): { id: string; title: string; tagline: string; description: string } {
  const s = content.scenario;
  return { id: s.id, title: s.world?.title ?? s.name, tagline: s.world?.tagline ?? "", description: s.world?.description ?? "" };
}

/** 시나리오(시작 역할) 고르기에 보이는 것 */
export function scenarioInfos(content: Content): { id: string; title: string; pitch: string }[] {
  return Object.values(content.roles).map((r) => ({ id: r.id, title: r.scenario?.title ?? r.label, pitch: r.scenario?.pitch ?? "" }));
}
