import type { Content, RoleContent } from "../content/schemas.ts";
import { buildCustomRole, checkCustomStart, type CustomStartInput } from "./customStart.ts";
import { occupationById } from "./occupation.ts";
import { rankName } from "./ranks.ts";
import { josa } from "../text.ts";
import { memberLabel, memberTemplate, type StartGroup } from "./startGroup.ts";

/**
 * 시작 고르기 (기획서 12-77, 12-84): 소속 → 계급. 무리·계급마다 준비된 시나리오(roles/*.yaml)가 하나씩 있다.
 * 무리에 속하면 그 무리의 시나리오 중에서 고른다 (첫 장면, 이야기, 분대, 아는 사람 모두 그대로).
 * 떠돌이는 시나리오 없이 동행을 고르고, 코드가 역할을 만든다 (buildCustomRole). 숫자와 엔진 값은 코드가 정한다
 */

export const LONER = "loner";

export type FactionChoice = { id: string; name: string; about: string };
/** 이 무리의 계급과 그 자리의 시나리오. rankLabel: 무리에서 부르는 이름, gains: 계급 기본 훈련과 지니고 시작하는 물건 */
export type RolePreset = { roleId: string; rank: string; rankLabel: string; occupation: string | null; title: string; pitch: string; gains: string };

const unlockedRole = (r: RoleContent, unlocked: readonly string[]) => !r.unlock || unlocked.includes(r.unlock);

/** 고를 수 있는 무리: 고를 수 있는 시나리오가 있는 무리 (시작할 수 없는 무리는 해금된 시나리오가 있을 때만) */
export function factionChoices(content: Content, unlocked: readonly string[]): FactionChoice[] {
  const withRoles = new Set(Object.values(content.roles).filter((r) => unlockedRole(r, unlocked) && r.faction).map((r) => r.faction));
  return Object.values(content.factions)
    .filter((f) => withRoles.has(f.id))
    .map((f) => ({ id: f.id, name: f.name, about: f.public }));
}

/** 떠돌이로 시작할 수 있는지 */
export function lonerAllowed(content: Content): boolean {
  return !!content.scenario.custom_start?.free_rank;
}

/** 이 무리에서 고를 수 있는 계급과 그 자리의 시나리오 (계급 낮은 순, 12-84: 무리·계급마다 시나리오 하나) */
export function roleChoices(content: Content, faction: string, unlocked: readonly string[]): RolePreset[] {
  const ladder = content.scenario.rank_ladder;
  const level = (id: string) => ladder.find((r) => r.id === id)?.level ?? 0;
  const itemName = (id: string) => content.items[id]?.name ?? id;
  return Object.values(content.roles)
    .filter((r) => unlockedRole(r, unlocked) && r.faction === faction)
    .sort((a, b) => level(a.rank) - level(b.rank))
    .map((r) => ({
      roleId: r.id,
      rank: r.rank,
      rankLabel: rankName(content, faction, r.rank),
      occupation: occupationById(content, r.occupation)?.label ?? null,
      title: r.scenario?.title ?? r.label,
      pitch: r.scenario?.pitch ?? "",
      // 계급 기본 훈련(12-87)과 시나리오의 물건. 나머지 스킬은 과거 배경에서 (12-84)
      gains: [
        ...Object.entries(content.scenario.creation?.rank_skills[r.rank] ?? {}).map(([m, v]) => `${content.scenario.moves.find((x) => x.id === m)?.label ?? m} +${v}`),
        ...[...new Set(r.start_inventory)].map(itemName),
      ].join(" · "),
    }));
}

/** 떠돌이의 고르기: 반려견, 소규모 무리 (스킬은 과거 배경에서, 12-84) */
export type LonerPick = { pet: boolean; group?: StartGroup | null };

/** 떠돌이의 역할 고르기 (자유 시나리오와 같은 검증을 거친다). 장소·꾸러미·첫 장면은 코드가 정한다. 나이는 뒤의 캐릭터 만들기에서 정한다 */
export function lonerStart(content: Content, pick: LonerPick): { ok: true; input: CustomStartInput } | { ok: false; error: string } {
  const c = content.scenario.custom_start;
  if (!c?.free_rank) return { ok: false, error: "이 월드에서는 떠돌이로 시작할 수 없다." };
  const title = "떠돌이";
  const location = c.free_locations[0];
  const place = location ? (content.locations[location]?.name ?? location) : "";
  const input: CustomStartInput = {
    faction: null,
    rank: c.free_rank,
    occupation: null,
    title,
    location: location ?? "",
    kit: c.free_kit ?? c.kits[0]!.id,
    skills: {},
    age: pick.group?.me.age ?? Math.round((c.age.min + c.age.max) / 2),
    opening: `${place}. 당신은 ${josa(title, "으로/로")} 오늘을 시작한다.`,
    background: [],
    history: [],
    kin: pick.pet && c.pet ? { template: c.pet, label: content.extras[c.pet]?.label ?? "개" } : null,
  };
  const problems = checkCustomStart(content, input);
  return problems.length ? { ok: false, error: problems.join(" ") } : { ok: true, input };
}

/** 떠돌이의 역할을 만든다 */
export function buildLonerRole(content: Content, pick: LonerPick): { ok: true; role: RoleContent; input: CustomStartInput } | { ok: false; error: string } {
  const s = lonerStart(content, pick);
  if (!s.ok) return s;
  const role = buildCustomRole(content, s.input);
  // 소규모 무리: 플레이어가 정한 사람들이 처음부터 함께 다닌다 (능력·소지품은 틀에서 무작위)
  if (pick.group?.members.length) {
    role.start_companions = pick.group.members.map((m) => ({
      template: memberTemplate(content, m),
      label: memberLabel(content, pick.group!, m),
      kind: "kin" as const,
      name: m.name.trim(),
      age: m.age,
      gender: m.gender,
    }));
  }
  return { ok: true, role, input: s.input };
}
