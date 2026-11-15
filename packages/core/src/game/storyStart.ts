import { z } from "zod";
import type { Content, RoleContent } from "../content/schemas.ts";
import { checkHistory, describeHistoryOptions, historyPartSchema, MAX_HISTORY } from "./background.ts";
import { checkCustomStart, MAX_BACKGROUND, MAX_BACKGROUND_LENGTH, MAX_OPENING_LENGTH, type CustomStartInput } from "./customStart.ts";

/**
 * 동기와 이야기 (기획서 12-77 2단계, 12-86): 떠돌이·준비된 시나리오·사망 뒤 새 캐릭터 모두, 플레이어가 동기를 고르고 지난 이야기를 쓴다 (건너뛸 수 있다).
 * GM은 그 글을 기억·배경 부품(떠돌이는 첫 장면도)으로만 옮긴다 (무리·계급·장소·소지품은 이미 정해져 있다).
 * 배경 부품은 세계의 역사로 남고, 나머지는 주인공의 기억(믿음)이다 (원칙 4, 5)
 */

export const MAX_STORY_TEXT = 1500;

export function storyStartSchema() {
  return z.strictObject({
    opening: z
      .string()
      .trim()
      .min(1)
      .max(MAX_OPENING_LENGTH)
      .optional()
      .describe("첫 장면 한두 문장 (2인칭, 시작 장소에서, 동기가 느껴지게). 떠돌이만: 준비된 시나리오와 새 캐릭터는 시나리오의 첫 장면을 그대로 쓰니 넣지 않는다"),
    background: z.array(z.string().trim().min(1).max(MAX_BACKGROUND_LENGTH)).max(MAX_BACKGROUND).describe("플레이어가 쓴 지난 삶을 캐릭터의 기억 몇 문장으로"),
    history: z.array(historyPartSchema()).max(MAX_HISTORY).describe("배경 부품: 글 중 세계의 사실이 되는 것 (글에 있을 때만, 없으면 빈 목록)"),
  });
}
export type StoryStartInput = z.infer<ReturnType<typeof storyStartSchema>>;

/** 주인공에게 남는 동기 (캐릭터의 motive) */
export type StartMotive = { id: string; label: string; summary: string };

export type Motive = NonNullable<Content["scenario"]["custom_start"]>["motives"][number];

export function motivesOf(content: Content): Motive[] {
  return content.scenario.custom_start?.motives ?? [];
}

/** 코드가 만든 시작에 옮긴 이야기를 얹은 것 */
export function withStory(base: CustomStartInput, story: StoryStartInput | null | undefined): CustomStartInput {
  return story ? { ...base, opening: story.opening ?? base.opening, background: story.background, history: story.history } : base;
}

/** 옮긴 이야기가 규칙에 맞는지 (떠돌이: 얹은 뒤 자유 시나리오와 같은 검증, 첫 장면은 꼭) */
export function checkStoryStart(content: Content, base: CustomStartInput, story: StoryStartInput): string[] {
  return [...(story.opening ? [] : ["opening: 떠돌이는 첫 장면을 옮긴다."]), ...checkCustomStart(content, withStory(base, story))];
}

/**
 * 준비된 시나리오(새 캐릭터 포함)에 얹는 이야기의 규칙 (12-86): 배경 부품은 무리원의 규칙으로(자기 무리 통째로 원수, 지금 무리에서 도망쳐 나온 것은 안 된다),
 * 그 시나리오의 상관·분대원·자기 무리의 지도부는 원수나 가족을 죽인 자로 둘 수 없다 (시나리오 이야기의 줄기가 그 사람들에게 걸려 있다).
 * 첫 장면은 시나리오의 것을 그대로 쓴다
 */
export function checkRoleStory(content: Content, role: RoleContent, story: StoryStartInput): string[] {
  const problems = checkHistory(content, story.history, role.faction || null);
  if (story.opening) problems.push("opening: 준비된 시나리오는 첫 장면을 그대로 쓴다 (opening을 넣지 않는다).");
  const guarded = guardedPeople(content, role);
  for (const p of story.history) {
    const who = p.kind === "enemy" ? p.target : p.kind === "loss" ? p.by : null;
    if (who && guarded.has(who)) problems.push(`${p.kind}: ${content.npcs[who]?.name ?? who}은(는) 이 시나리오의 상관·분대원·지도부라 원수나 가족을 죽인 자로 둘 수 없다.`);
  }
  return problems;
}

/** 이 시나리오의 줄기에 묶인 사람: 상관, 분대원, 자기 무리의 지도부 */
export function guardedPeople(content: Content, role: RoleContent): Set<string> {
  const top = content.scenario.rank_ladder.reduce((a, b) => (b.level > a.level ? b : a)).id;
  return new Set([
    ...(role.commander ? [role.commander] : []),
    ...(role.squad ?? []),
    ...Object.values(content.npcs)
      .filter((n) => role.faction && n.faction === role.faction && n.rank === top)
      .map((n) => n.id),
  ]);
}

/** GM이 이야기를 옮길 때 고를 수 있는 것 */
export function describeStoryOptions(content: Content): string {
  return [
    describeHistoryOptions(content),
    `첫 장면(opening)은 ${MAX_OPENING_LENGTH}자 안, 지난 삶(background)은 ${MAX_BACKGROUND}문장까지, 배경 부품(history)은 ${MAX_HISTORY}개까지.`,
  ].join("\n");
}
