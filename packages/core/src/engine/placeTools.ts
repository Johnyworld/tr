/**
 * 장소 도구 (12-244, 공통 규칙 15): GM이 즉흥 장소를 만든다 (개인 거처, 화장실, 뒷골목 등).
 * 이름·실내외·주인만 정하고, 그곳의 물건·위험은 지어내지 못한다 (원칙 2). 세이브에 남아 다시 쓴다.
 * 장소를 옮기는 것은 플레이어의 행동이라 take_action.place_to로 한다
 */
import { z } from "zod";
import { josa } from "../text.ts";
import { nextPlaceId, placesIn } from "../rules/place.ts";
import { defineTool } from "./toolkit.ts";

const spawnPlace = defineTool({
  name: "spawn_place",
  description:
    "지금 구역 안에 즉흥 장소를 만든다 (콘텐츠에 없는 곳: 누구의 집·방·자리, 화장실, 뒷골목, 경비실 등). 이름과 실내(지붕 아래)인지, 주인(그 사람의 거처면 인물 id)만 정한다. " +
    "그곳의 물건·위험·사람은 지어내지 않는다. 같은 이름이 이미 있으면 그것을 돌려준다. 옮겨 가려면 take_action의 place_to에 돌려받은 id를 넣는다.",
  schema: z.strictObject({
    name: z.string().min(1).max(30).describe("장소 이름 (예: 102동 304호, 막사의 강태호 자리, 화장실)"),
    indoor: z.boolean().describe("지붕 아래(실내)면 true"),
    owner: z.string().nullable().default(null).describe("그 사람의 거처면 인물 id (밤 일과가 그곳이 된다). 아니면 null"),
  }),
  run(input, ctx) {
    const state = ctx.store.getState();
    const zone = state.playerZone;
    if (!zone) return { ok: false, error: "지금 구역이 없다." };
    if (input.owner && !state.characters[input.owner]) return { ok: false, error: `알 수 없는 인물: ${input.owner}` };
    const same = placesIn(state, ctx.content, zone).find((p) => p.name === input.name.trim());
    if (same) return { ok: true, resultText: `${josa(same.name, "은/는")} 이미 있다: ${same.id} (${same.indoor ? "실내" : "바깥"}). 옮겨 가려면 take_action place_to: "${same.id}".`, display: { type: "time", activityLabel: "장소", durationLabel: "", fromLabel: "", toLabel: "" }, silent: true };
    const id = nextPlaceId(state);
    ctx.store.append({ type: "place_spawned", id, zone, name: input.name.trim(), indoor: input.indoor, owner: input.owner });
    return {
      ok: true,
      resultText: `장소를 만들었다: ${id} (${input.name.trim()}, ${input.indoor ? "실내" : "바깥"}${input.owner ? `, ${input.owner}의 거처` : ""}). 옮겨 가려면 take_action place_to: "${id}".`,
      display: { type: "time", activityLabel: "장소", durationLabel: "", fromLabel: "", toLabel: "" },
      silent: true,
    };
  },
});

export const PLACE_TOOLS = [spawnPlace] as const;
