import type { Content } from "../content/schemas.ts";
import type { Rng } from "../rng.ts";
import { checkName } from "./creation.ts";
import { generateName } from "./names.ts";

/**
 * 떠돌이의 소규모 무리 (기획서 12-77 3단계): 동행을 "소규모 무리"로 고르면 코드가 몇 사람을 무작위로 만들고,
 * 플레이어가 관계·이름·나이·성별을 고치거나 더하고 뺀다. 능력·소지품·성격은 세계를 만들 때 엑스트라 틀에서 무작위로.
 * 관계는 주인공 기준이라 주인공의 나이·성별도 여기서 정한다 (캐릭터 만들기에서 다시 묻지 않는다).
 * 규칙: 부모·자식은 parent_gap살 이상 차이, 배우자는 주인공과 다른 성별, 관계마다 인원 상한 (월드 팩 custom_start.group)
 */

export type GroupMember = { relation: string; name: string; age: number; gender: string };
export type StartGroup = { me: { age: number; gender: string }; members: GroupMember[]; confirmed: boolean };

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
  let [lo, hi] = rel.age;
  if (rel.kind === "parent") lo = Math.max(lo, me.age + rules.parent_gap);
  if (rel.kind === "child") hi = Math.min(hi, me.age - rules.parent_gap);
  return lo <= hi ? [lo, hi] : null;
}

/** 배우자가 될 수 있는 성별 (주인공과 다른 성별) */
const spouseGenders = (content: Content, me: StartGroup["me"]) => genderIds(content).filter((g) => g !== me.gender);

/** 무작위로 한 사람 (관계 상한과 나이 규칙을 지킨다). 더할 수 없으면 null */
export function randomMember(content: Content, group: Pick<StartGroup, "me" | "members">, rng: Rng, used: ReadonlySet<string> = new Set()): GroupMember | null {
  const rules = groupRules(content);
  if (!rules || group.members.length >= rules.max) return null;
  const open = rules.relations.filter((r) => {
    const count = group.members.filter((m) => m.relation === r.id).length;
    if (r.max !== undefined && count >= r.max) return false;
    if (r.kind === "spouse" && spouseGenders(content, group.me).length === 0) return false;
    return ageRange(rules, r, group.me) !== null;
  });
  if (!open.length) return null;
  const rel = pick(rng, open);
  const [lo, hi] = ageRange(rules, rel, group.me)!;
  const gender = rel.kind === "spouse" ? pick(rng, spouseGenders(content, group.me)) : pick(rng, genderIds(content));
  // 배우자는 주인공 나이 근처, 형제자매도 비슷한 또래로 (범위 안에서)
  const near = rel.kind === "spouse" || rel.kind === "sibling";
  const age = near ? Math.min(hi, Math.max(lo, group.me.age + between(rng, -8, 8))) : between(rng, lo, hi);
  const taken = new Set([...used, ...group.members.map((m) => m.name)]);
  const name = generateName(rng, content.scenario.names, gender, taken) ?? rel.label;
  return { relation: rel.id, name, age, gender };
}

/** 처음 고를 때의 무리: 주인공은 월드 나이 범위의 가운데쯤, 사람은 start명 */
export function newGroup(content: Content, rng: Rng): StartGroup {
  const rules = groupRules(content);
  const range = content.scenario.custom_start?.age ?? { min: 20, max: 50 };
  const me = { age: Math.min(range.max, Math.max(range.min, between(rng, 30, 44))), gender: pick(rng, genderIds(content)) };
  const group: StartGroup = { me, members: [], confirmed: false };
  for (let i = 0; i < (rules?.start ?? 0); i++) {
    const m = randomMember(content, group, rng);
    if (m) group.members.push(m);
  }
  return group;
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

/** 규칙 확인. at: 문제가 있는 사람의 번호(0부터, 주인공이면 -1) */
export function checkGroup(content: Content, group: Pick<StartGroup, "me" | "members">): { at: number; problem: string }[] {
  const rules = groupRules(content);
  if (!rules) return [{ at: -1, problem: "이 월드는 소규모 무리로 시작할 수 없다." }];
  const out: { at: number; problem: string }[] = [];
  const genders = genderIds(content);
  const range = content.scenario.custom_start?.age;
  if (range && (group.me.age < range.min || group.me.age > range.max)) out.push({ at: -1, problem: `주인공의 나이는 ${range.min}~${range.max}세다.` });
  if (!genders.includes(group.me.gender)) out.push({ at: -1, problem: "주인공의 성별을 고른다." });
  if (group.members.length > rules.max) out.push({ at: -1, problem: `무리는 ${rules.max}명까지다.` });
  group.members.forEach((m, i) => {
    const rel = rules.relations.find((r) => r.id === m.relation);
    if (!rel) return out.push({ at: i, problem: `관계는 ${rules.relations.map((r) => r.label).join(", ")} 중 하나다.` });
    const nameProblem = checkName(m.name) ?? (/\s/.test(m.name.trim()) ? "이름에는 띄어쓰기를 넣지 않는다." : null);
    if (nameProblem) out.push({ at: i, problem: nameProblem });
    if (!genders.includes(m.gender)) out.push({ at: i, problem: "성별을 고른다." });
    if (m.age < rel.age[0] || m.age > rel.age[1]) out.push({ at: i, problem: `${rel.label}의 나이는 ${rel.age[0]}~${rel.age[1]}세다.` });
    if (rel.kind === "parent" && m.age - group.me.age < rules.parent_gap) out.push({ at: i, problem: `부모는 주인공보다 ${rules.parent_gap}살 이상 많다.` });
    if (rel.kind === "child" && group.me.age - m.age < rules.parent_gap) out.push({ at: i, problem: `자식은 주인공보다 ${rules.parent_gap}살 이상 어리다.` });
    if (rel.kind === "spouse" && m.gender === group.me.gender) out.push({ at: i, problem: "배우자는 주인공과 다른 성별이다." });
  });
  for (const rel of rules.relations) {
    const count = group.members.filter((m) => m.relation === rel.id).length;
    if (rel.max !== undefined && count > rel.max) out.push({ at: -1, problem: `${rel.label}는 ${rel.max}명까지다.` });
  }
  const names = group.members.map((m) => m.name.trim());
  names.forEach((n, i) => {
    if (n && names.indexOf(n) !== i) out.push({ at: i, problem: "이름이 겹친다." });
  });
  return out;
}

const KEYS: Record<string, "relation" | "name" | "age" | "gender"> = {
  relation: "relation",
  관계: "relation",
  name: "name",
  이름: "name",
  age: "age",
  나이: "age",
  gender: "gender",
  성별: "gender",
};

/**
 * 무리 고치기 (채팅과 상태 화면이 같은 말을 쓴다):
 * add(더하기) / remove N(빼기 N) / edit N 관계=.. 이름=.. 나이=.. 성별=.. / me 나이=.. 성별=.. (주인공). N은 1부터.
 * 값은 id나 이름으로. 고친 결과의 규칙 위반은 막지 않고 보여 준다 (다 고친 뒤 확인할 때 막는다)
 */
export function editGroup(content: Content, group: StartGroup, command: string, rng: Rng): { ok: true; group: StartGroup } | { ok: false; error: string } {
  const rules = groupRules(content);
  if (!rules) return { ok: false, error: "이 월드는 소규모 무리로 시작할 수 없다." };
  const words = command.trim().split(/\s+/);
  const verb = (words[0] ?? "").toLowerCase();
  if (["add", "더하기", "추가"].includes(verb)) {
    const m = randomMember(content, group, rng);
    if (!m) return { ok: false, error: group.members.length >= rules.max ? `무리는 ${rules.max}명까지다.` : "더할 수 있는 사람이 없다." };
    return { ok: true, group: { ...group, members: [...group.members, m] } };
  }
  const index = (w: string | undefined) => {
    const n = Number(w);
    return Number.isInteger(n) && n >= 1 && n <= group.members.length ? n - 1 : null;
  };
  if (["remove", "빼기", "삭제"].includes(verb)) {
    const i = index(words[1]);
    if (i === null) return { ok: false, error: `뺄 사람의 번호(1~${group.members.length})를 준다.` };
    return { ok: true, group: { ...group, members: group.members.filter((_, j) => j !== i) } };
  }
  const isMe = ["me", "나"].includes(verb);
  if (!isMe && !["edit", "고치기"].includes(verb)) return { ok: false, error: "add, remove N, edit N 관계=.. 이름=.. 나이=.. 성별=.., me 나이=.. 성별=.., done, alone 중 하나다." };
  const i = isMe ? -1 : index(words[1]);
  if (!isMe && i === null) return { ok: false, error: `고칠 사람의 번호(1~${group.members.length})를 준다.` };
  const pairs = words.slice(isMe ? 1 : 2).map((w) => w.split("="));
  const genders = content.scenario.creation?.genders ?? [];
  const patch: Partial<GroupMember> = {};
  for (const [k, v] of pairs) {
    const key = KEYS[(k ?? "").toLowerCase()];
    if (!key || v === undefined || v === "") return { ok: false, error: `알 수 없는 값: ${k}` };
    if (key === "age") {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 120) return { ok: false, error: "나이는 숫자로 준다." };
      patch.age = n;
    } else if (key === "gender") {
      const g = genders.find((x) => x.id === v || x.label === v);
      if (!g) return { ok: false, error: `성별은 ${genders.map((x) => x.label).join(", ")} 중 하나다.` };
      patch.gender = g.id;
    } else if (key === "relation") {
      if (isMe) return { ok: false, error: "주인공은 나이와 성별만 고친다." };
      const r = rules.relations.find((x) => x.id === v || x.label === v);
      if (!r) return { ok: false, error: `관계는 ${rules.relations.map((x) => x.label).join(", ")} 중 하나다.` };
      patch.relation = r.id;
    } else {
      if (isMe) return { ok: false, error: "주인공의 이름은 캐릭터 만들기에서 정한다." };
      patch.name = v;
    }
  }
  if (isMe) return { ok: true, group: { ...group, me: { age: patch.age ?? group.me.age, gender: patch.gender ?? group.me.gender } } };
  return { ok: true, group: { ...group, members: group.members.map((m, j) => (j === i ? { ...m, ...patch } : m)) } };
}

/** GM과 화면에 보여 줄 한 줄 (예: 1. 아내 김수연 (34세, 여성)) */
export function describeGroup(content: Content, group: StartGroup): string[] {
  const g = (id: string) => content.scenario.creation?.genders.find((x) => x.id === id)?.label ?? id;
  return [
    `나 (주인공): ${group.me.age}세, ${g(group.me.gender)}`,
    ...group.members.map((m, i) => `${i + 1}. ${memberLabel(content, group, m)} ${m.name} (${m.age}세, ${g(m.gender)})`),
  ];
}
