/**
 * 공통 규칙 9: 바뀐 것은 까닭과 함께 알린다 (docs/design.md "공통 규칙").
 *
 * 도구 하나가 끝날 때마다 주인공에게 보이는 상태를 앞뒤로 비교해, 바뀌었는데 결과 글에 없는 것을 한 줄씩 붙인다
 * (플레이 테스트 11~13: 공적·이야기·무기·재난·계승 뒤의 임무가 말없이 바뀐 것을 하나씩 고쳤다. 새 기능이 알림을 빠뜨려도 여기서 채운다).
 * 이미 결과 글에 나온 변화는 다시 알리지 않는다.
 */
import type { Content } from "../content/schemas.ts";
import { commanderOf, MISSION_STATUS_LABELS, missionStatusLabel } from "../game/missions.ts";
import type { GameState } from "../game/state.ts";
import { playerCalls } from "../game/acquaintance.ts";
import { josa } from "../text.ts";

/** 주인공에게 보이는 상태 (비교할 것만) */
export type Visible = {
  playerId: string;
  merit: number;
  rank: string;
  faction: string | null;
  commander: string | null;
  companions: string[];
  missions: Record<string, string>;
  debts: Record<string, number>;
};

export function visibleOf(state: GameState, content: Content): Visible {
  const me = state.characters[state.playerId];
  return {
    playerId: state.playerId,
    merit: me?.merit ?? 0,
    rank: me?.rank ?? "",
    faction: me?.factionId || null,
    commander: commanderOf(state, content),
    companions: [...state.companions],
    missions: Object.fromEntries(Object.values(state.missions).map((m) => [m.id, m.status])),
    debts: { ...(me?.debts ?? {}) },
  };
}

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

/** 앞뒤 상태를 비교해 결과 글(said)에 없는 변화를 한 줄씩 */
export function changeNotices(before: Visible, after: Visible, state: GameState, content: Content, said: string): string[] {
  const lines: string[] = [];
  const name = (id: string) => playerCalls(state, content, id);
  const samePlayer = before.playerId === after.playerId;
  if (samePlayer) {
    if (after.merit !== before.merit && !said.includes("공적")) lines.push(`공적 ${signed(after.merit - before.merit)} (지금 ${after.merit}).`);
    if (after.rank !== before.rank && !said.includes("진급")) {
      const label = (r: string) => content.scenario.rank_ladder.find((x) => x.id === r)?.label ?? r;
      lines.push(`계급이 바뀌었다: ${label(before.rank)} → ${label(after.rank)}.`);
    }
    if (after.faction !== before.faction && !said.includes("무리")) {
      const f = (id: string | null) => (id ? (content.factions[id]?.name ?? id) : "무소속");
      lines.push(`소속이 바뀌었다: ${f(before.faction)} → ${f(after.faction)}.`);
    }
    for (const [fid, n] of Object.entries({ ...before.debts, ...after.debts })) {
      const was = before.debts[fid] ?? 0;
      const now = after.debts[fid] ?? 0;
      if (was !== now && !said.includes("빚")) lines.push(`빚: ${content.factions[fid]?.name ?? fid} ${was} → ${now}.`);
      void n;
    }
  }
  if (after.commander !== before.commander && after.commander && !said.includes(name(after.commander))) lines.push(`상관이 바뀌었다: 이제 ${josa(name(after.commander), "이/가")} 상관이다.`);
  for (const id of after.companions) if (!before.companions.includes(id) && !said.includes(name(id))) lines.push(`${josa(name(id), "이/가")} 이제 함께 다닌다.`);
  for (const id of before.companions) if (!after.companions.includes(id) && state.characters[id] && !said.includes(name(id))) lines.push(`${josa(name(id), "은/는")} 더는 함께 다니지 않는다.`);
  for (const [mid, was] of Object.entries(before.missions)) {
    const m = state.missions[mid];
    if (!m || was !== "active" || m.status === "active" || said.includes(m.title)) continue;
    lines.push(m.assigneeId !== state.playerId ? `앞 주인공이 받았던 임무 "${m.title}"${josa(m.title, "은/는").slice(m.title.length)} 거둬들였다.` : `임무 "${m.title}": ${missionStatusLabel(m) ?? MISSION_STATUS_LABELS[m.status]}.`);
  }
  return lines;
}
