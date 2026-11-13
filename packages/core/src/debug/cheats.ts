import type { Character } from "../game/character.ts";
import { pickCast } from "../story/storylets.ts";
import { dayOf, MINUTES_PER_DAY, nextSegmentStart, timeSegmentSchema } from "../rules/time.ts";
import { harmTrack, trackOf } from "../scenario/scenario.ts";
import { startBattle } from "../sim/battle.ts";
import { changeCondition } from "../engine/body.ts";
import { endActiveStorylet, fireStorylet } from "../engine/storyletTools.ts";
import { enterScene, EXTRA_TOOLS } from "../engine/extras.ts";
import { levelForXp } from "../engine/growth.ts";
import { runAfterTimeAdvance } from "../engine/turnStart.ts";
import type { ToolContext, ToolOutcome } from "../engine/toolkit.ts";

/**
 * 치트 (개발 모드, 기획서 17.2): 테스트를 위해 상태를 강제로 바꾼다. `~명령 인자…`
 * - 플레이어가 직접 친 명령만 (GM이 쓰지 않는다). 켜는 것은 어댑터가 정한다 (.env의 TRPG_DEBUG=1)
 * - 모든 변경은 이벤트로 남고, cheat_used가 이 세이브에 치트를 썼다는 표시를 남긴다
 */

export const CHEAT_PREFIX = "~";

export function isCheat(input: string): boolean {
  return input.trim().startsWith(CHEAT_PREFIX);
}

type Result = { ok: true; text: string } | { ok: false; error: string };

const HELP = [
  "치트 (개발 모드)",
  "~kill me|인물          죽인다",
  "~harm 인물 단계        부상 단계를 정한다 (예: ~harm me serious)",
  "~set 트랙 단계 [인물]  몸 상태를 정한다 (예: ~set hunger starving)",
  "~heal [인물]           몸 상태를 모두 처음으로",
  "~stat 능력 값 [인물]   능력 값 (예: ~stat strength 2)",
  "~skill 스킬 값 [인물]  스킬 값",
  "~trait add|remove 트레잇 [인물]",
  "~xp 양                 경험치 (레벨업도 따라온다)",
  "~give 아이템 [수량]    아이템을 준다",
  "~summon 인물           인물을 장면에 부른다",
  "~summon extra 틀 [호칭] 엑스트라를 만든다",
  "~goto 구역             구역을 옮긴다",
  "~time +2d|+5h|시간대   시간을 보낸다 (그 사이 세계도 돌아간다)",
  "~weather 날씨          오늘 날씨",
  "~storylet 이야기       그 이야기를 지금 시작한다",
  "~battle                지금 구역에서 전투 장면을 연다",
  "~relation 인물 축 ±값  그 인물의 나에 대한 관계 (축: trust, affection, respect)",
  "~faction 세력 자원|morale 값  세력 자원·사기",
].join("\n");

/** "me", "나", 캐릭터 id, 이름(앞부분 일치)으로 캐릭터를 찾는다 */
function findCharacter(ctx: ToolContext, query: string | undefined): Character | undefined {
  const state = ctx.store.getState();
  if (!query || query === "me" || query === "나") return state.characters[state.playerId];
  if (state.characters[query]) return state.characters[query];
  const all = Object.values(state.characters);
  return all.find((c) => c.name === query) ?? all.find((c) => c.name.startsWith(query) || c.extra?.label === query);
}

/** 상태 트랙을 그 단계로 (단계 id 또는 이름) */
function setLevel(ctx: ToolContext, c: Character, trackId: string, level: string): Result {
  const track = trackOf(ctx.content.scenario, trackId);
  const to = track.levels.findIndex((l) => l.id === level || l.label === level);
  if (to < 0) return { ok: false, error: `${track.label}의 단계: ${track.levels.map((l) => `${l.id}(${l.label})`).join(", ")}` };
  const from = Math.max(0, track.levels.findIndex((l) => l.id === c.conditions[track.id]));
  if (c.dead) return { ok: false, error: `${c.name}은(는) 이미 죽었다.` };
  if (to === from) return { ok: true, text: `${c.name}의 ${track.label}은(는) 이미 ${track.levels[to]!.label}.` };
  const change = changeCondition(ctx, c.id, track.id, to - from, "cheat", "치트");
  return { ok: true, text: change?.line || `${c.name}의 ${track.label}: ${track.levels[to]!.label}` };
}

export function runCheat(input: string, ctx: ToolContext): Result {
  const { store, content } = ctx;
  const s = content.scenario;
  const [cmd = "", ...args] = input.trim().replace(/^~/, "").trim().split(/\s+/);
  if (!cmd || cmd === "help" || cmd === "도움말") return { ok: true, text: HELP };
  const state = store.getState();
  if (!state.worldId) return { ok: false, error: "열린 세계가 없다." };
  const result = ((): Result => {
    switch (cmd) {
      case "kill": {
        const c = findCharacter(ctx, args[0]);
        if (!c) return { ok: false, error: `없는 인물: ${args[0]}` };
        const fatal = harmTrack(s).levels.find((l) => l.fatal);
        return fatal ? setLevel(ctx, c, s.harm_track, fatal.id) : { ok: false, error: "사망 단계가 없다." };
      }
      case "harm": {
        const c = findCharacter(ctx, args[0]);
        if (!c || !args[1]) return { ok: false, error: "~harm 인물 단계" };
        return setLevel(ctx, c, s.harm_track, args[1]);
      }
      case "set": {
        const [track, level, who] = args;
        if (!track || !level || !s.condition_tracks.some((t) => t.id === track)) {
          return { ok: false, error: `~set 트랙 단계 [인물] — 트랙: ${s.condition_tracks.map((t) => t.id).join(", ")}` };
        }
        const c = findCharacter(ctx, who);
        return c ? setLevel(ctx, c, track, level) : { ok: false, error: `없는 인물: ${who}` };
      }
      case "heal": {
        const c = findCharacter(ctx, args[0]);
        if (!c || c.dead) return { ok: false, error: "살아 있는 인물만 낫는다." };
        const lines = s.condition_tracks.map((t) => setLevel(ctx, store.getState().characters[c.id]!, t.id, t.levels[0]!.id));
        return { ok: true, text: lines.map((r) => (r.ok ? r.text : r.error)).join("\n") };
      }
      case "stat":
      case "skill": {
        const [key, value, who] = args;
        const n = Number(value);
        const list = cmd === "stat" ? s.stats.map((x) => x.id) : s.moves.map((m) => m.id);
        if (!key || !list.includes(key) || !Number.isInteger(n)) return { ok: false, error: `~${cmd} ${cmd === "stat" ? "능력" : "스킬"} 값 [인물] — ${list.join(", ")}` };
        const range = cmd === "stat" ? s.ranges.ability : s.ranges.skill;
        if (n < range.min || n > range.max) return { ok: false, error: `값은 ${range.min}~${range.max}` };
        const c = findCharacter(ctx, who);
        if (!c) return { ok: false, error: `없는 인물: ${who}` };
        store.append({ type: "character_patched", characterId: c.id, [cmd === "stat" ? "stats" : "skills"]: { [key]: n } });
        return { ok: true, text: `${c.name}의 ${key}: ${n}` };
      }
      case "trait": {
        const [op, id, who] = args;
        if ((op !== "add" && op !== "remove") || !id || !s.traits.some((t) => t.id === id)) {
          return { ok: false, error: `~trait add|remove 트레잇 [인물] — ${s.traits.map((t) => t.id).join(", ")}` };
        }
        const c = findCharacter(ctx, who);
        if (!c) return { ok: false, error: `없는 인물: ${who}` };
        const current = c.traits.length ? c.traits : (content.npcs[c.id]?.traits ?? []);
        const traits = op === "add" ? [...new Set([...current, id])] : current.filter((t) => t !== id);
        store.append({ type: "character_patched", characterId: c.id, traits });
        return { ok: true, text: `${c.name}의 트레잇: ${traits.join(", ") || "없음"}` };
      }
      case "xp": {
        const n = Number(args[0]);
        const p = state.characters[state.playerId]!;
        if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "~xp 양 (양수)" };
        const level = levelForXp(s, p.xp + n);
        store.append({ type: "xp_gained", characterId: p.id, amount: n, source: "cheat", level });
        return { ok: true, text: `경험치 +${n} (레벨 ${level}${level > p.level ? `, 올릴 스킬 ${level - p.level}개` : ""})` };
      }
      case "give": {
        const [item, q] = args;
        const n = q ? Number(q) : 1;
        if (!item || !content.items[item] || !Number.isInteger(n) || n <= 0) return { ok: false, error: `~give 아이템 [수량] — ${Object.keys(content.items).join(", ")}` };
        store.append({ type: "item_granted", to: state.playerId, itemId: item, quantity: n });
        return { ok: true, text: `${content.items[item]!.name} ×${n}` };
      }
      case "summon": {
        if (args[0] === "extra") {
          const [, template, ...label] = args;
          const spawn = EXTRA_TOOLS.find((t) => t.name === "spawn_extra")!.run as (i: { template: string; label: string }, c: ToolContext) => ToolOutcome;
          const out = spawn({ template: template ?? "", label: label.join(" ") || content.extras[template ?? ""]?.label || "이름 없는 인물" }, ctx);
          return out.ok ? { ok: true, text: out.resultText } : out;
        }
        const c = findCharacter(ctx, args.join(" "));
        if (!c || c.id === state.playerId) return { ok: false, error: `없는 인물: ${args.join(" ")}` };
        if (c.dead) return { ok: false, error: `${c.name}은(는) 죽었다.` };
        if (state.scene.present.includes(c.id)) return { ok: true, text: `${c.name}은(는) 이미 장면에 있다.` };
        enterScene(ctx, c.id);
        return { ok: true, text: `${c.name}이(가) 장면에 들어왔다.` };
      }
      case "goto": {
        const zone = args[0];
        if (!zone || !content.locations[zone]) return { ok: false, error: `~goto 구역 — ${Object.keys(content.locations).join(", ")}` };
        if (state.battle) return { ok: false, error: "전투 중에는 옮길 수 없다." };
        store.append({ type: "zone_moved", from: state.playerZone, to: zone });
        return { ok: true, text: `${content.locations[zone]!.name}(으)로 옮겼다.` };
      }
      case "time": {
        const arg = args[0] ?? "";
        const m = /^\+(\d+)([dh])$/.exec(arg);
        const seg = timeSegmentSchema.safeParse(arg);
        const to = m ? state.time + Number(m[1]) * (m[2] === "d" ? MINUTES_PER_DAY : 60) : seg.success ? nextSegmentStart(state.time, seg.data) : null;
        if (to === null || to <= state.time) return { ok: false, error: "~time +2d | +5h | 시간대(dawn, morning, day, evening, night)" };
        store.append({ type: "time_advanced", activity: "wait", from: state.time, to });
        runAfterTimeAdvance(ctx);
        return { ok: true, text: `시간이 흘렀다 (${Math.round((to - state.time) / 60)}시간). 그 사이 세계도 진행됐다.` };
      }
      case "weather": {
        const w = args[0];
        if (!w || !s.weather?.kinds.some((k) => k.id === w)) return { ok: false, error: `~weather 날씨 — ${s.weather?.kinds.map((k) => k.id).join(", ") ?? "날씨 규칙 없음"}` };
        store.append({ type: "weather_set", day: dayOf(state.time), weatherId: w });
        return { ok: true, text: `오늘 날씨: ${w}` };
      }
      case "storylet": {
        const storylet = content.storylets[args[0] ?? ""];
        if (!storylet) return { ok: false, error: `없는 이야기: ${args[0]} — ${Object.keys(content.storylets).join(", ")}` };
        if (state.activeStorylet) endActiveStorylet(ctx, "치트로 다른 이야기를 열었다");
        const cast = pickCast(store.getState(), content, storylet, ctx.rng);
        if (!cast) return { ok: false, error: "배역을 채울 인물이 없다 (조건에 맞는 인물이 살아 있어야 한다)." };
        fireStorylet(ctx, storylet, cast);
        return { ok: true, text: `이야기 시작: ${storylet.title}` };
      }
      case "battle": {
        if (state.battle) return { ok: false, error: "이미 전투 중이다." };
        const zone = state.playerZone;
        const me = state.characters[state.playerId]!;
        if (!zone) return { ok: false, error: "구역이 없다." };
        const owner = state.zones[zone]?.owner ?? null;
        const own = content.factions[me.factionId];
        const enemy = Object.entries(own?.disposition ?? {}).sort((a, b) => a[1] - b[1])[0]?.[0];
        const defense = owner === me.factionId;
        const attacker = defense ? enemy : me.factionId;
        const defender = defense ? me.factionId : (owner ?? enemy);
        if (!attacker || !defender) return { ok: false, error: "맞붙을 세력이 없다." };
        const id = `cheat_${state.time}`;
        const battle = startBattle(content, state, { kind: "raid", attacker, defender, zone }, defense ? "defense" : "attack", { id, at: state.time });
        store.append({ type: "battle_started", pendingId: id, battle });
        return { ok: true, text: `전투 장면을 열었다 (${defense ? "방어" : "공격"}, ${content.factions[attacker]?.name} → ${content.factions[defender]?.name}).` };
      }
      case "relation": {
        const [who, axis, value] = args;
        const c = findCharacter(ctx, who);
        const n = Number(value);
        if (!c || c.id === state.playerId || !["trust", "affection", "respect"].includes(axis ?? "") || !Number.isInteger(n)) {
          return { ok: false, error: "~relation 인물 trust|affection|respect ±값" };
        }
        store.append({ type: "relation_changed", from: c.id, to: state.playerId, delta: { trust: 0, affection: 0, respect: 0, [axis!]: n }, reason: "치트" });
        return { ok: true, text: `${c.name}의 ${axis} ${n > 0 ? "+" : ""}${n}` };
      }
      case "faction": {
        const [fid, key, value] = args;
        const f = state.factions[fid ?? ""];
        const n = Number(value);
        if (!f || !key || !Number.isFinite(n)) return { ok: false, error: `~faction 세력 자원|morale 값 — ${Object.keys(state.factions).join(", ")}` };
        if (key === "morale") {
          store.append({ type: "faction_morale_changed", factionId: fid!, delta: Math.round(n) - f.morale });
          return { ok: true, text: `${fid} 사기: ${Math.max(-3, Math.min(3, Math.round(n)))}` };
        }
        if (!s.resources.some((r) => r.id === key)) return { ok: false, error: `자원: ${s.resources.map((r) => r.id).join(", ")}, morale` };
        store.append({ type: "faction_patched", factionId: fid!, resources: { [key]: Math.max(0, n) } });
        return { ok: true, text: `${fid} ${key}: ${Math.max(0, n)}` };
      }
      default:
        return { ok: false, error: `모르는 치트: ${cmd}. ~help` };
    }
  })();
  // 실제로 바꾼 명령만 기록한다 (세이브에 치트 표시)
  if (result.ok) store.append({ type: "cheat_used", command: input.trim().slice(0, 200) });
  return result;
}
