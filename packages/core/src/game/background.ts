import { josa, sentence } from "../text.ts";
import { z } from "zod";
import type { Content } from "../content/schemas.ts";

/**
 * 배경 부품 (기획서 12.6): 플레이어가 쓴 지난 삶 중 세계의 사실이 되는 것.
 * GM은 글을 이 목록 안에서만 옮기고, 코드가 검증해 세이브의 역사로 남긴다 (원칙 2, 5).
 * 목록 밖의 이야기(그 밖의 기억)는 지금처럼 주인공의 기억(믿음)으로만 남는다
 */
export const MAX_HISTORY = 4;
const text = (max: number) => z.string().trim().min(1).max(max);

export function historyPartSchema() {
  return z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("loss"),
      who: text(40).describe("잃은 사람들 (예: 어머니와 마을 사람 열 명). 이름 없이 부르는 말"),
      by: z.string().nullable().describe("그 일을 한 세력 id 또는 인물 id. 모르거나 감염체면 null"),
      where: z.string().nullable().describe("그 일이 있었던 구역 id. 도시 밖이면 null"),
    }),
    z.strictObject({
      kind: z.literal("enemy"),
      target: z.string().describe("원수: 인물 id 또는 세력 id"),
      why: text(80).describe("왜 원수인지 한 문장"),
      knows_you: z.boolean().describe("원수도 주인공을 알아보는지 (쫓기는 사이)"),
    }),
    z.strictObject({
      kind: z.literal("kin_alive"),
      template: z.string().describe("연고 틀 id"),
      label: text(20).describe("부르는 말 (예: 동생)"),
      zone: z.string().describe("그 사람이 기다리는 구역 id"),
    }),
    z.strictObject({
      kind: z.literal("seeking"),
      template: z.string().describe("찾는 사람의 연고 틀 id"),
      label: text(20).describe("부르는 말 (예: 사라진 딸)"),
    }),
    z.strictObject({
      kind: z.literal("debt"),
      faction: z.string().describe("빚을 진 세력 id"),
      size: z.enum(["small", "large"]).describe("빚의 크기 (양은 월드가 정한다)"),
    }),
    z.strictObject({
      kind: z.literal("deserter"),
      faction: z.string().describe("도망쳐 나온 세력 id"),
    }),
  ]);
}
export type HistoryPart = z.infer<ReturnType<typeof historyPartSchema>>;
/** 세이브에 남는 배경 (코드가 만든 인물 id를 붙인다) */
export type BackgroundEntry = HistoryPart & { characterId?: string };

const isFaction = (content: Content, id: string | null | undefined) => !!id && !!content.factions[id];
const isNpc = (content: Content, id: string | null | undefined) => !!id && !!content.npcs[id];

/** 배경 부품이 규칙에 맞는지. own은 주인공의 세력 (무소속이면 null) */
export function checkHistory(content: Content, parts: readonly HistoryPart[], own: string | null): string[] {
  const problems: string[] = [];
  const kin = content.scenario.custom_start?.kin ?? [];
  if (parts.length > MAX_HISTORY) problems.push(`배경 부품은 ${MAX_HISTORY}개까지다.`);
  for (const p of parts) {
    if (p.kind === "loss") {
      if (p.by !== null && !isFaction(content, p.by) && !isNpc(content, p.by)) problems.push(`loss.by: 알 수 없는 세력·인물 ${p.by}`);
      if (p.where !== null && !content.locations[p.where]) problems.push(`loss.where: 알 수 없는 구역 ${p.where}`);
    } else if (p.kind === "enemy") {
      if (!isFaction(content, p.target) && !isNpc(content, p.target)) problems.push(`enemy.target: 알 수 없는 세력·인물 ${p.target}`);
      if (p.target === own) problems.push("enemy.target: 자기 무리를 통째로 원수로 둘 수는 없다 (그 안의 사람을 고른다).");
    } else if (p.kind === "kin_alive" || p.kind === "seeking") {
      if (!kin.includes(p.template) || content.extras[p.template]?.animal) problems.push(`${p.kind}.template: 사람 연고 틀은 ${kin.filter((k) => !content.extras[k]?.animal).join(", ")} 중 하나다.`);
      if (p.kind === "kin_alive" && (!content.locations[p.zone] || content.locations[p.zone]!.isolated)) problems.push(`kin_alive.zone: 갈 수 있는 구역이 아니다 ${p.zone}`);
    } else if (p.kind === "debt") {
      if (!isFaction(content, p.faction)) problems.push(`debt.faction: 알 수 없는 세력 ${p.faction}`);
    } else if (p.kind === "deserter") {
      if (!isFaction(content, p.faction)) problems.push(`deserter.faction: 알 수 없는 세력 ${p.faction}`);
      else if (p.faction === own) problems.push("deserter.faction: 지금 속한 무리에서 도망쳐 나왔을 수는 없다.");
    }
  }
  if (parts.filter((p) => p.kind === "seeking").length > 1) problems.push("찾는 사람은 하나만.");
  return problems;
}

/** 부르는 이름 (세력 이름 또는 인물 이름) */
export function whoName(content: Content, id: string | null): string {
  if (!id) return "누군지 모를 자들";
  return content.factions[id]?.name ?? content.npcs[id]?.name ?? id;
}

/** 배경 한 줄 (주인공이 아는 대로) */
export function describeHistoryPart(content: Content, p: HistoryPart): string {
  switch (p.kind) {
    case "loss":
      return `${josa(p.who, "을/를")} 잃었다. ${p.by ? `${whoName(content, p.by)}의 짓이다` : "누구 짓인지 모른다"}${p.where ? ` (${content.locations[p.where]?.name ?? p.where})` : ""}`;
    case "enemy":
      return `원수: ${whoName(content, p.target)}. ${sentence(p.why)}${p.knows_you ? " 저쪽도 나를 안다" : " 저쪽은 나를 모른다"}`;
    case "kin_alive":
      return `${josa(p.label, "이/가")} 살아 있다. ${content.locations[p.zone]?.name ?? p.zone}에서 기다린다`;
    case "seeking":
      return `${josa(p.label, "을/를")} 찾고 있다. 어디 있는지 모른다`;
    case "debt":
      return `${whoName(content, p.faction)}에 ${p.size === "large" ? "큰" : "작은"} 빚을 지고 있다`;
    case "deserter":
      return `${whoName(content, p.faction)}에서 도망쳐 나왔다`;
  }
}

/** 배경 부품이 세우는 플래그 (이야기가 이것으로 열린다) */
export function historyFlags(content: Content, p: HistoryPart): string[] {
  const factionOf = (id: string | null) => (id && content.factions[id] ? id : id && content.npcs[id]?.faction) || null;
  switch (p.kind) {
    case "loss": {
      const f = factionOf(p.by);
      return ["bg_loss", ...(f ? [`bg_loss_by_${f}`] : []), ...(p.by && content.npcs[p.by] ? ["bg_culprit_known"] : [])];
    }
    case "enemy": {
      const f = factionOf(p.target);
      return ["bg_enemy", ...(f ? [`bg_enemy_${f}`] : []), ...(content.npcs[p.target] ? ["bg_enemy_person"] : []), ...(p.knows_you ? ["bg_hunted"] : [])];
    }
    case "kin_alive":
      return ["bg_kin_alive"];
    case "seeking":
      return ["bg_seeking"];
    case "debt":
      return ["bg_debt", `bg_debt_${p.faction}`];
    case "deserter":
      return ["bg_deserter", `bg_deserter_${p.faction}`];
  }
}

/** GM에게 줄 고를 수 있는 것 (옮기기 단계) */
export function describeHistoryOptions(content: Content): string {
  const kin = (content.scenario.custom_start?.kin ?? []).filter((k) => !content.extras[k]?.animal);
  const npcs = Object.values(content.npcs)
    .filter((n) => n.faction && content.factions[n.faction]?.startable !== false)
    .map((n) => `${n.name}(${n.id}, ${content.factions[n.faction!]?.name})`);
  return [
    `배경 부품 (history, ${MAX_HISTORY}개까지, 글에 있을 때만): 지난 삶 중 세계의 사실이 되는 것. 나머지는 background(기억)로`,
    "- loss { who, by, where }: 잃은 사람들. by는 세력 id·인물 id·null",
    "- enemy { target, why, knows_you }: 원수 (세력 또는 인물). 인물이면 그 사람이 정말 그 일을 한 것이 된다",
    `- kin_alive { template, label, zone }: 살아서 다른 곳에서 기다리는 가족 (틀: ${kin.join(", ")})`,
    `- seeking { template, label }: 찾고 있는 사람 (어디 있는지는 코드가 정하고 아무도 모른다)`,
    "- debt { faction, size: small|large }: 진 빚",
    "- deserter { faction }: 도망쳐 나온 무리",
    `인물 (원수·가해자로 고를 수 있다): ${npcs.join(", ")}`,
  ].join("\n");
}
