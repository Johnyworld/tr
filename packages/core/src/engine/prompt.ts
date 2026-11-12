import type { Content } from "../content/schemas.ts";
import type { PlayMode } from "./log.ts";

/**
 * GM 지침 = 시나리오 톤 + 시작 장면 + GM 공통 규칙 (+ MCP 모드 진행 규칙).
 * 원문은 시나리오 팩의 prompts/에 있고 두 플레이 모드가 같은 파일을 읽는다 (기획서 11.6).
 * 한 세계 안에서는 바뀌지 않는다.
 */
export function buildGmGuide(content: Content, roleId: string, mode: PlayMode): string {
  const scenario = content.scenario;
  const role = content.roles[roleId];
  return [
    "너는 1인용 TRPG의 게임 마스터(GM)이자 연출가다. 게임 엔진(tool)이 판정과 상태를 맡고, 너는 해석하고 서술한다.",
    `# 시나리오: ${scenario.name}\n\n${scenario.tone}`,
    role ? `## 시작 장면\n플레이어는 이미 다음 장면을 보았다. 첫 입력은 이 장면에서 이어진다.\n${role.opening_scene}` : "",
    scenario.rules,
    mode === "mcp" ? scenario.mcpGuide : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
