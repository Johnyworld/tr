import type { Content } from "../content/schemas.ts";
import { PROMOTION } from "./missions.ts";

/**
 * 무리의 문화와 규율 (기획서 9.9). 규율 단계의 수치는 시나리오(discipline), 무리마다 고르는 것은 콘텐츠(culture).
 * 규율이 없거나 무리에 속하지 않으면 기본값(질서: 지금까지의 규칙)
 */
export type Discipline = {
  id: string;
  label: string;
  abandonMerit: number;
  expireMerit: number;
  countsDisobedience: boolean;
  maxDisobedience: number;
  deedSeverity: number;
  orderWord: string;
};

const DEFAULT: Discipline = {
  id: "orderly",
  label: "질서",
  abandonMerit: -2,
  expireMerit: -2,
  countsDisobedience: true,
  maxDisobedience: PROMOTION.maxDisobedience,
  deedSeverity: 2,
  orderWord: "명령",
};

export function disciplineOf(content: Content, factionId: string | null | undefined): Discipline {
  const id = factionId ? content.factions[factionId]?.culture?.discipline : undefined;
  const d = id ? content.scenario.discipline[id] : undefined;
  if (!id || !d) return DEFAULT;
  return {
    id,
    label: d.label,
    abandonMerit: d.abandon_merit,
    expireMerit: d.expire_merit,
    countsDisobedience: d.counts_disobedience,
    maxDisobedience: d.max_disobedience,
    deedSeverity: d.deed_severity,
    orderWord: d.order_word,
  };
}

/**
 * 역할의 권한 (roles/*.yaml access). core가 아는 것: ration(무리의 배급을 받는다), mission_board(상관이 그날의 임무를 내놓는다).
 * 나머지(예: treatment_room)는 GM이 보는 특권이다. 역할에 access가 비어 있으면 무리에 속한 사람은 배급·임무를 받는다
 */
export function hasAccess(content: Content, state: { roleId: string; playerId: string; characters: Record<string, { factionId: string }> }, key: string): boolean {
  const player = state.characters[state.playerId];
  if (!player?.factionId) return false;
  const access = content.roles[state.roleId]?.access ?? [];
  if (access.length === 0) return key === "ration" || key === "mission_board";
  return access.includes(key);
}

/** GM에게 보여 줄 권한 줄 */
export function describeAccess(content: Content, roleId: string): string {
  const access = content.roles[roleId]?.access ?? [];
  if (!access.length) return "";
  return `권한: ${access.map((a) => content.scenario.access_labels[a] ?? a).join(" · ")}`;
}

/** GM에게 줄 소속 무리의 문화 (연기와 판단에 쓴다) */
export function describeCultureForGm(content: Content, factionId: string): string {
  const f = content.factions[factionId];
  const c = f?.culture;
  if (!f || !c) return "";
  const d = disciplineOf(content, factionId);
  return [
    `${f.name}의 문화 (규율: ${d.label}): ${c.summary}`,
    ...(c.rules.length ? [`규칙: ${c.rules.join(" / ")}`] : []),
    ...(c.address ? [`호칭: ${c.address}`] : []),
    ...(c.punishment ? [`어기면: ${c.punishment}`] : []),
    `임무는 이 무리에서 "${d.orderWord}"이다. ${d.countsDisobedience ? `버리거나 기한을 넘기면 불복종으로 기록된다` : "버려도 불복종으로 치지 않는다"}. NPC는 이 문화대로 말하고 반응한다.`,
  ].join("\n");
}
