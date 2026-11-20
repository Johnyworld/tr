import type { Content } from "../content/schemas.ts";
import type { Rng } from "../rng.ts";
import { generateName } from "./names.ts";

/**
 * 주인공의 가족·연고를 코드가 만든다 (튜토리얼의 찾는 가족, 기획서 12.4.1). 관계는 주인공 기준이고,
 * 이름·나이·성별은 무작위, 능력·소지품·성격은 세계를 만들 때 엑스트라 틀에서 무작위로.
 * 규칙: 부모·자식은 parent_gap살 이상 차이, 배우자는 주인공과 다른 성별, 관계마다 인원 상한 (월드 팩 custom_start.group)
 */

export type GroupMember = { relation: string; name: string; age: number; gender: string };
export type StartGroup = { me: { age: number; gender: string }; members: GroupMember[] };

type GroupRules = NonNullable<NonNullable<Content["scenario"]["custom_start"]>["group"]>;
type Relation = GroupRules["relations"][number];

export function groupRules(content: Content): GroupRules | null {
  return content.scenario.custom_start?.group ?? null;
}

const genderIds = (content: Content) => content.scenario.creation?.genders.map((g) => g.id) ?? [];
const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
const between = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

/** 이 관계로 가질 수 있는 나이 범위 (주인공 나이와 관계 규칙을 함께 본다). 없으면 null */
function ageRange(rules: GroupRules, rel: Relation, me: StartGroup["me"]): [number, number] | null {
  if (rel.min_me_age !== undefined && me.age < rel.min_me_age) return null;
  let [lo, hi] = rel.age;
  if (rel.kind === "parent") lo = Math.max(lo, me.age + rules.parent_gap);
  if (rel.kind === "child") hi = Math.min(hi, me.age - rules.parent_gap);
  return lo <= hi ? [lo, hi] : null;
}

/** 배우자가 될 수 있는 성별 (주인공과 다른 성별) */
const spouseGenders = (content: Content, me: StartGroup["me"]) => genderIds(content).filter((g) => g !== me.gender);

/** 무작위로 한 사람 (관계 상한과 나이 규칙을 지킨다). 더할 수 없으면 null */
export function randomMember(
  content: Content,
  group: Pick<StartGroup, "me" | "members">,
  rng: Rng,
  used: ReadonlySet<string> = new Set(),
  /** 이 관계 종류만 (가족만 만들 때: parent, sibling, spouse, child) */
  kinds?: readonly string[],
): GroupMember | null {
  const rules = groupRules(content);
  if (!rules || group.members.length >= rules.max) return null;
  const open = rules.relations.filter((r) => {
    if (kinds && !kinds.includes(r.kind)) return false;
    const count = group.members.filter((m) => m.relation === r.id).length;
    if (r.max !== undefined && count >= r.max) return false;
    if (r.kind === "spouse" && spouseGenders(content, group.me).length === 0) return false;
    return ageRange(rules, r, group.me) !== null;
  });
  if (!open.length) return null;
  const rel = pick(rng, open);
  const [lo, hi] = ageRange(rules, rel, group.me)!;
  // 두 번째 부모는 첫 부모와 다른 성별로 (플레이 테스트 12: 어머니가 둘이었다)
  const otherParent = rel.kind === "parent" ? group.members.find((m) => rules.relations.find((r) => r.id === m.relation)?.kind === "parent") : undefined;
  const parentGenders = otherParent ? genderIds(content).filter((g) => g !== otherParent.gender) : [];
  const gender = rel.kind === "spouse" ? pick(rng, spouseGenders(content, group.me)) : parentGenders.length ? pick(rng, parentGenders) : pick(rng, genderIds(content));
  // 배우자는 주인공 나이 근처, 형제자매도 비슷한 또래로 (범위 안에서)
  const near = rel.kind === "spouse" || rel.kind === "sibling";
  const age = near ? Math.min(hi, Math.max(lo, group.me.age + between(rng, -8, 8))) : between(rng, lo, hi);
  const taken = new Set([...used, ...group.members.map((m) => m.name)]);
  // 한 가족 안에서 이름(성 뺀)이 겹치지 않게 (플레이 테스트 12: 언니 한소영, 어머니 서소영)
  const given = new Set(group.members.map((m) => m.name.slice(1)));
  let name = generateName(rng, content.scenario.names, gender, taken) ?? rel.label;
  for (let i = 0; i < 8 && given.has(name.slice(1)); i++) name = generateName(rng, content.scenario.names, gender, new Set([...taken, name])) ?? name;
  return { relation: rel.id, name, age, gender };
}

/** 이 사람을 부르는 말 (예: 아내, 아들, 누나, 길동무) */
export function memberLabel(content: Content, group: Pick<StartGroup, "me">, m: GroupMember): string {
  const rules = groupRules(content);
  const rel = rules?.relations.find((r) => r.id === m.relation);
  if (!rules || !rel) return m.relation;
  if (rel.kind === "sibling" && rules.sibling_labels) {
    const s = rules.sibling_labels;
    const label = m.age > group.me.age ? s.older[m.gender]?.[group.me.gender] : m.age < group.me.age ? s.younger[m.gender] : undefined;
    if (label) return label;
  }
  return rel.labels[m.gender] ?? rel.label;
}

/** 이 사람을 세계에 만들 때 쓰는 엑스트라 틀 */
export function memberTemplate(content: Content, m: GroupMember): string {
  const rules = groupRules(content)!;
  const rel = rules.relations.find((r) => r.id === m.relation);
  const t = rules.templates;
  if (m.age < rules.young_below) return t.young;
  if (m.age >= rules.elder_from) return t.elder;
  if (rel?.kind === "spouse") return t.partner;
  if (rel?.kind === "other") return t.other;
  return t.adult;
}

/** 가족 관계 종류 (길동무는 빼고) */
export const FAMILY_KINDS = ["parent", "sibling", "spouse", "child"] as const;

/**
 * 주인공의 가족 count명 (주인공 나이에 맞는 관계만). 형제자매·자식과 부모 중 한 사람은 주인공의 성을 따른다 (다른 부모와 배우자는 제 성).
 * surname: 주인공의 성 (한 글자). 없으면 이름 그대로
 */
export function makeFamily(content: Content, me: StartGroup["me"], count: number, rng: Rng, surname: string | null, used: ReadonlySet<string> = new Set()): GroupMember[] {
  const group: StartGroup = { me, members: [] };
  const taken = new Set(used);
  // 부모·형제가 기본이고, 결혼·자식은 나이가 되면 확률로 (12-195)
  const kinds = FAMILY_KINDS.filter((k) => {
    const rel = groupRules(content)!.relations.find((r) => r.kind === k);
    return !rel || rel.chance === undefined || rng() < rel.chance;
  });
  for (let i = 0; i < count; i++) {
    const m = randomMember(content, group, rng, taken, kinds);
    if (!m) break;
    const kind = groupRules(content)!.relations.find((r) => r.id === m.relation)?.kind;
    const keeps = kind === "spouse" || (kind === "parent" && group.members.some((x) => x.relation === m.relation));
    if (surname && !keeps && m.name.length >= 2) m.name = surname + m.name.slice(1);
    taken.add(m.name);
    group.members.push(m);
  }
  return group.members;
}
