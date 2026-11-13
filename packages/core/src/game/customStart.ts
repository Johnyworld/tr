import { z } from "zod";
import type { Content, RoleContent } from "../content/schemas.ts";
import { MAX_NAME_LENGTH } from "./creation.ts";
import { CUSTOM_ROLE_ID } from "./state.ts";

/**
 * 자유 시나리오 (기획서 12.5): 플레이어가 "누구로, 어디서 시작하는지"를 글로 쓰면, GM이 그 글을 월드가 허락한
 * 부품(세력, 계급, 시작 장소, 소지품 꾸러미, 시작 훈련, 나이)으로 옮기고, 코드가 검증해 역할을 만든다.
 * - 고를 수 있는 범위는 월드 팩의 custom_start가 정한다 (한 자리뿐인 지도부는 빠진다)
 * - 아는 인물·상관·임무·배급 같은 엔진 값은 코드가 세력과 계급으로 정한다. GM은 목록에서 고르기만 한다 (원칙 2)
 * - 플레이어가 쓴 지난 삶은 캐릭터 자신의 기억(믿음)으로만 남는다. 세계의 사실이 되지 않는다 (원칙 4, 5)
 */

export const MAX_TITLE_LENGTH = 24;
export const MAX_OPENING_LENGTH = 300;
export const MAX_BACKGROUND = 4;
export const MAX_BACKGROUND_LENGTH = 200;
export const MAX_STORY_LENGTH = 1500;

export function customStartSchema() {
  return z.strictObject({
    faction: z.string().nullable().describe("세력 id. 무소속이면 null"),
    rank: z.string().describe("계급 id (고를 수 있는 것 중에서)"),
    title: z.string().trim().min(1).max(MAX_TITLE_LENGTH).describe("짧은 직함 (예: 청솔형제단 참모, 떠돌이 약초꾼)"),
    location: z.string().describe("시작 구역 id"),
    kit: z.string().describe("소지품 꾸러미 id"),
    skills: z.record(z.string(), z.number().int()).describe("시작 훈련: 스킬 id → 수준 (포인트 안에서)"),
    age: z.number().int().describe("나이 (플레이어가 쓴 대로, 범위 안에서)"),
    opening: z.string().trim().min(1).max(MAX_OPENING_LENGTH).describe("첫 장면 한두 문장 (2인칭, 시작 장소에서)"),
    background: z.array(z.string().trim().min(1).max(MAX_BACKGROUND_LENGTH)).max(MAX_BACKGROUND).describe("플레이어가 쓴 지난 삶을 캐릭터의 기억 몇 문장으로"),
  });
}
export type CustomStartInput = z.infer<ReturnType<typeof customStartSchema>>;

const rankLevel = (content: Content, rank: string) => content.scenario.rank_ladder.find((r) => r.id === rank)?.level ?? 0;

/** 세력이 차지한 구역 (그 세력으로 시작할 수 있는 곳) */
function factionLocations(content: Content, faction: string): string[] {
  return Object.values(content.locations)
    .filter((l) => l.owner === faction)
    .map((l) => l.id);
}

/** 고른 것이 규칙에 맞는지. 문제 목록 (비면 통과) */
export function checkCustomStart(content: Content, input: CustomStartInput): string[] {
  const c = content.scenario.custom_start;
  if (!c) return ["이 월드는 자유 시나리오를 열지 않는다."];
  const problems: string[] = [];
  const rankLabel = (id: string) => content.scenario.rank_ladder.find((r) => r.id === id)?.label ?? id;
  if (input.faction === null) {
    if (!c.free_rank) problems.push("이 월드에서는 무소속으로 시작할 수 없다. 세력을 고른다.");
    else if (input.rank !== c.free_rank) problems.push(`무소속의 계급은 ${rankLabel(c.free_rank)}(${c.free_rank})이다.`);
    if (!c.free_locations.includes(input.location)) problems.push(`무소속으로 시작할 수 있는 곳: ${c.free_locations.map((l) => `${content.locations[l]?.name ?? l}(${l})`).join(", ")}`);
  } else {
    if (!content.factions[input.faction]) problems.push(`알 수 없는 세력: ${input.faction}`);
    else {
      if (!c.ranks.includes(input.rank)) problems.push(`세력에 속해 고를 수 있는 계급: ${c.ranks.map((r) => `${rankLabel(r)}(${r})`).join(", ")} (지도부는 한 자리뿐이라 고를 수 없다)`);
      const places = factionLocations(content, input.faction);
      if (!places.includes(input.location)) problems.push(`${content.factions[input.faction]!.name}으로 시작할 수 있는 곳: ${places.map((l) => `${content.locations[l]?.name ?? l}(${l})`).join(", ")}`);
    }
  }
  if (!c.kits.some((k) => k.id === input.kit)) problems.push(`소지품 꾸러미는 ${c.kits.map((k) => `${k.label}(${k.id})`).join(", ")} 중 하나다.`);
  let spent = 0;
  for (const [move, v] of Object.entries(input.skills)) {
    if (!content.scenario.moves.some((m) => m.id === move)) problems.push(`알 수 없는 스킬: ${move}`);
    else if (v < 0 || v > c.skill_max) problems.push(`스킬 하나는 0~${c.skill_max}까지다 (${move} ${v}).`);
    spent += Math.max(0, v);
  }
  if (spent > c.skill_points) problems.push(`시작 훈련 포인트를 넘었다 (${spent}/${c.skill_points}).`);
  if (input.age < c.age.min || input.age > c.age.max) problems.push(`나이는 ${c.age.min}~${c.age.max}세다.`);
  return problems;
}

/**
 * 검증된 고르기로 역할을 만든다. 엔진 값은 코드가 정한다:
 * - 아는 인물: 같은 세력의 인물 모두 (무소속이면 없음)
 * - 상관: 같은 세력에서 계급이 바로 위인 인물 (없으면 없음)
 * - 임무·배급·시작 지식·스토리렛 태그: 같은 세력의 콘텐츠 역할에서. 시작 지식은 계급이 같을 때만 (분대원의 지식을 참모에게 주지 않는다)
 */
export function buildCustomRole(content: Content, input: CustomStartInput): RoleContent {
  const kit = content.scenario.custom_start!.kits.find((k) => k.id === input.kit)!;
  const faction = input.faction;
  // 같은 세력의 콘텐츠 역할 중 계급이 같은 것, 없으면 아무거나 (임무·배급·태그를 빌린다)
  const roles = faction ? Object.values(content.roles).filter((r) => r.faction === faction) : [];
  const same = roles.find((r) => r.rank === input.rank) ?? roles[0];
  const level = rankLevel(content, input.rank);
  const members = faction ? Object.values(content.npcs).filter((n) => n.faction === faction) : [];
  // 같은 계급의 콘텐츠 시나리오가 있으면 그 상관, 없으면 바로 위 계급 중 id 순으로 첫 사람 (파일 순서와 무관하게)
  const commander =
    (same?.rank === input.rank && same.commander ? content.npcs[same.commander] : undefined) ??
    members
      .filter((n) => rankLevel(content, n.rank) > level)
      .sort((a, b) => rankLevel(content, a.rank) - rankLevel(content, b.rank) || a.id.localeCompare(b.id))[0];
  const skills = Object.fromEntries(Object.entries(input.skills).filter(([, v]) => v > 0));
  return {
    id: CUSTOM_ROLE_ID,
    label: input.title,
    faction: faction ?? "",
    rank: input.rank,
    default_name: "이름 없는 사람",
    age: input.age,
    opening_scene: input.opening,
    scenario: { title: input.title, pitch: input.background.join(" ") || input.title, intro: input.opening },
    start_skills: skills,
    start_inventory: [...kit.items],
    start_location: input.location,
    access: same?.access ?? [],
    ...(same?.beliefs_preset && same.rank === input.rank ? { beliefs_preset: same.beliefs_preset } : {}),
    known_npcs: members.map((n) => n.id),
    ...(commander ? { commander: commander.id } : {}),
    missions: same?.missions ?? [],
    storylet_tags: same?.storylet_tags ?? [],
  } as RoleContent;
}

/**
 * 무소속 주인공이 무리에 들어갈 때의 역할 (스토리렛 효과 join_faction). 계급은 콘텐츠가 정하고(없으면 자유 시나리오의 가장 낮은 계급),
 * 상관·아는 사람·임무는 buildCustomRole과 같은 규칙으로 코드가 정한다. 시작 장면·소지품은 이미 지난 일이라 비워 둔다
 */
export function joinRole(content: Content, faction: string, rank: string | undefined, player: { age: number | null; title?: string }): RoleContent {
  const c = content.scenario.custom_start;
  const levelOf = (id: string) => rankLevel(content, id);
  const lowest = [...(c?.ranks ?? [])].sort((a, b) => levelOf(a) - levelOf(b))[0] ?? content.scenario.rank_ladder[0]!.id;
  const chosen = rank ?? lowest;
  const base = Object.values(content.locations).find((l) => l.owner === faction && l.kind === "base")?.id ?? factionLocations(content, faction)[0] ?? "";
  const factionName = content.factions[faction]?.name ?? faction;
  const role = buildCustomRole(content, {
    faction,
    rank: chosen,
    title: player.title ?? `${factionName} ${content.scenario.rank_ladder.find((r) => r.id === chosen)?.label ?? ""}`.trim(),
    location: base,
    kit: c?.kits[0]?.id ?? "",
    skills: {},
    age: player.age ?? 30,
    opening: `${factionName}에 들어왔다.`,
    background: [],
  });
  return { ...role, start_inventory: [] };
}

/** 확인 단계에 보여 줄 요약 (코드가 만든 것) */
export function describeCustomRole(content: Content, role: RoleContent): string {
  const s = content.scenario;
  const faction = role.faction ? (content.factions[role.faction]?.name ?? role.faction) : "무소속";
  const commander = role.commander ? content.npcs[role.commander] : undefined;
  return [
    `직함: ${role.label} · ${faction} · ${s.rank_ladder.find((r) => r.id === role.rank)?.label ?? role.rank} · ${role.age}세`,
    `시작 장소: ${role.start_location ? (content.locations[role.start_location]?.name ?? role.start_location) : "-"}`,
    `소지품: ${role.start_inventory.map((i) => content.items[i]?.name ?? i).join(", ") || "없음"}`,
    `시작 훈련: ${Object.entries(role.start_skills).map(([m, v]) => `${s.moves.find((x) => x.id === m)?.label ?? m} +${v}`).join(", ") || "없음"}`,
    `상관: ${commander ? `${commander.name} (${s.rank_ladder.find((r) => r.id === commander.rank)?.label ?? commander.rank})` : "없음"} · 아는 사람 ${role.known_npcs.length}명${role.missions.length ? " · 임무를 받을 수 있다" : " · 정해진 임무 없음"}`,
    `첫 장면: ${role.opening_scene}`,
  ].join("\n");
}

/** GM이 플레이어의 글을 옮길 때 고를 수 있는 것 */
export function describeCustomStartOptions(content: Content): string {
  const s = content.scenario;
  const c = s.custom_start!;
  const rankLabel = (id: string) => s.rank_ladder.find((r) => r.id === id)?.label ?? id;
  const factions = Object.values(content.factions);
  return [
    `세력과 시작 장소:`,
    ...factions.map((f) => `- ${f.name}(${f.id}): ${factionLocations(content, f.id).map((l) => `${content.locations[l]?.name ?? l}(${l})`).join(", ") || "(시작할 구역 없음)"}`),
    ...(c.free_rank ? [`- 무소속(faction: null, rank: ${c.free_rank}): ${c.free_locations.map((l) => `${content.locations[l]?.name ?? l}(${l})`).join(", ")}`] : []),
    `계급 (세력에 속할 때): ${c.ranks.map((r) => `${rankLabel(r)}(${r})`).join(", ")}. 지도부는 한 자리뿐이라 고를 수 없다 (리더를 원하면 가장 가까운 계급으로 옮기고 알린다). 참모·간부는 간부(officer)`,
    `소지품 꾸러미: ${c.kits.map((k) => `${k.label}(${k.id}): ${k.items.map((i) => content.items[i]?.name ?? i).join(", ")}${k.description ? ` — ${k.description}` : ""}`).join(" / ")}`,
    `시작 훈련: ${c.skill_points}포인트, 스킬 하나에 최대 +${c.skill_max}. 스킬: ${s.moves.map((m) => `${m.label}(${m.id})`).join(", ")}`,
    `나이: ${c.age.min}~${c.age.max}세`,
    `직함은 ${MAX_TITLE_LENGTH}자 안, 첫 장면은 ${MAX_OPENING_LENGTH}자 안, 지난 삶(background)은 ${MAX_BACKGROUND}문장까지. 이름은 다음 단계에서 묻는다 (${MAX_NAME_LENGTH}자 안)`,
  ].join("\n");
}
