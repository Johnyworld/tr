import type { Content } from "../content/schemas.ts";
import type { PlayMode } from "./log.ts";
import type { GameState } from "../game/state.ts";

/**
 * GM 지침 = 시나리오 톤 + 시작 장면 + GM 공통 규칙 (+ MCP 모드 진행 규칙).
 * 원문은 시나리오 팩의 prompts/에 있고 두 플레이 모드가 같은 파일을 읽는다 (기획서 11.6).
 * 한 세계 안에서는 바뀌지 않는다.
 */
export function buildGmGuide(content: Content, roleId: string, mode: PlayMode, state?: Pick<GameState, "scenarioRole" | "cleared">): string {
  const scenario = content.scenario;
  const role = content.roles[roleId];
  // 지금 플레이하는 시나리오 (무리에 들어 역할이 바뀌어도 그대로, 기획서 12.4.1). 두 번째 주인공부터는 없다
  const playing = state ? content.roles[state.scenarioRole] : content.roles[roleId];
  const sc = playing?.scenario;
  const cleared = !!playing && !!state?.cleared.includes(playing.id);
  const scenarioGuide =
    sc && (sc.gm || sc.goal)
      ? [
          `## 시나리오: ${sc.title}`,
          sc.gm ?? "",
          sc.goal ? (cleared ? `클리어 목표(${sc.goal.text})는 이미 이뤘다. 이제는 이 세계에서 이어지는 삶이다. 주인공이 죽으면 끝난다.` : `클리어 목표: ${sc.goal.text}. 이루었는지는 코드가 판정해 tool 결과로 알린다. 그 전에 GM이 이뤘다고 서술하지 않는다.`) : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "";
  return [
    "너는 1인용 TRPG의 게임 마스터(GM)이자 연출가다. 게임 엔진(tool)이 판정과 상태를 맡고, 너는 해석하고 서술한다.",
    `# 월드: ${scenario.world?.title ?? scenario.name}\n\n${scenario.tone}`,
    scenarioGuide,
    role ? `## 시작 장면\n플레이어는 이미 다음 장면을 보았다. 첫 입력은 이 장면에서 이어진다.\n${role.opening_scene}` : "",
    scenario.rules,
    mode === "mcp" ? scenario.mcpGuide : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
