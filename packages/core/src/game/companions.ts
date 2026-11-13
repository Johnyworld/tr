import type { Content } from "../content/schemas.ts";
import type { Bond, BondKind, GameState } from "./state.ts";
import { formatTime } from "../rules/time.ts";

/**
 * 동행 (기획서 7.8, 7.9): 주인공과 함께 다니는 인물·동물과 함께 다니는 이유.
 * 곁에 있는 사람은 companions, 잠시 떨어져 있는 사람은 bonds의 apart. 살아 있고 떠나지 않았고 붙잡히지 않은 사람만 곁에 있다
 */
export function activeCompanions(state: GameState): string[] {
  return state.companions.filter((id) => {
    const c = state.characters[id];
    return c && !c.dead && !c.away && !c.captive;
  });
}

export const BOND_LABELS: Record<BondKind, string> = {
  animal: "동물",
  buddy: "임무 짝",
  squad: "분대원",
  purpose: "같은 목적",
  kin: "연고",
};

/** 함께 다니는 이유. 이전 세이브(이유가 없는 동행)는 틀로 정한다: 동물이면 animal, 아니면 kin */
export function bondOf(state: GameState, content: Content, id: string): Bond | null {
  const bond = state.bonds?.[id];
  if (bond) return bond;
  if (!state.companions.includes(id)) return null;
  const template = state.characters[id]?.extra?.template;
  return { kind: template && content.extras[template]?.animal ? "animal" : "kin", since: 0 };
}

/** 잠시 떨어져 있는 동행 */
export function apartCompanions(state: GameState): string[] {
  return Object.entries(state.bonds ?? {})
    .filter(([id, b]) => b.apart && !state.characters[id]?.dead)
    .map(([id]) => id)
    .sort();
}

/** 동행이 주는 스킬 보정 (엑스트라 틀의 companion_bonus). 같은 스킬은 가장 큰 것 하나만 */
export function companionSkillMod(state: GameState, content: Content, move: string): number {
  let best = 0;
  for (const id of activeCompanions(state)) {
    const template = state.characters[id]?.extra?.template;
    const bonus = template ? (content.extras[template]?.companion_bonus?.[move] ?? 0) : 0;
    if (bonus > best) best = bonus;
  }
  return best;
}

/** 목적 동행의 끝나는 조건을 사람이 읽는 말로 */
export function describeUntil(content: Content, until: Bond["until"]): string {
  if (!until) return "";
  const parts: string[] = [];
  if (until.zone) parts.push(`${content.locations[until.zone]?.name ?? until.zone}에 닿을 때까지`);
  if (until.at !== undefined) parts.push(`${formatTime(until.at)}까지`);
  if (until.flag) parts.push("함께 하기로 한 일을 마칠 때까지");
  return parts.join(" 또는 ");
}

/** GM에게 보여 줄 동행 줄 (곁에 있는 사람, 떨어져 있는 사람, 갈림길) */
export function describeCompanions(state: GameState, content: Content): string {
  const name = (id: string) => {
    const c = state.characters[id]!;
    return c.extra?.label && !(state.known[state.playerId] ?? []).includes(id) ? c.extra.label : c.name;
  };
  const lines: string[] = [];
  const list = activeCompanions(state);
  if (list.length) {
    const items = list.map((id) => {
      const c = state.characters[id]!;
      const template = c.extra?.template ? content.extras[c.extra.template] : undefined;
      const bonus = Object.entries(template?.companion_bonus ?? {})
        .map(([m, v]) => `${content.scenario.moves.find((x) => x.id === m)?.label ?? m} +${v}`)
        .join(", ");
      const bond = bondOf(state, content, id);
      const why = bond ? BOND_LABELS[bond.kind] + (bond.kind === "purpose" && bond.until ? ` (${describeUntil(content, bond.until)})` : "") : "";
      return `${name(id)} (${id})${why ? ` · ${why}` : ""}${bonus ? ` · 함께 있으면 ${bonus}` : ""}`;
    });
    lines.push(`동행 (구역을 옮겨도 따라온다. 잠시 떼어 놓거나 헤어지면 companion_part): ${items.join(", ")}`);
  }
  for (const id of apartCompanions(state)) {
    const b = state.bonds[id]!;
    const where = b.apart!.zone
      ? `${content.locations[b.apart!.zone]?.name ?? b.apart!.zone}에서 기다린다 (그 구역에 가면 다시 합류한다)`
      : `볼일을 보러 갔다 (${formatTime(b.apart!.until ?? state.time)}쯤 돌아온다)`;
    lines.push(`떨어져 있는 동행: ${name(id)} (${id}) · ${BOND_LABELS[b.kind]} · ${where}`);
  }
  for (const id of list) {
    const b = state.bonds?.[id];
    if (!b?.crossroads) continue;
    lines.push(
      `갈림길: ${name(id)}와 함께 하기로 한 일이 끝났다. ${b.crossroads.lean === "stay" ? "더 함께 가고 싶어 하는 눈치다" : "자기 길을 가려는 눈치다"}. ` +
        `플레이어가 정하면 companion_crossroads (let_go 보낸다 / ask_stay 붙잡는다). ${formatTime(b.crossroads.decideBy)}까지 정하지 않으면 그 사람 뜻대로 된다`,
    );
  }
  return lines.join("\n");
}
