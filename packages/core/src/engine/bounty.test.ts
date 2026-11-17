import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createContentSchemas } from "../content/schemas.ts";
import { conditionsMet, storyletVars } from "../story/storylets.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { changeCondition } from "./body.ts";
import { describePlayerState } from "./context.ts";
import { fireStorylet } from "./storyletTools.ts";
import { executeTool } from "./tools.ts";

/** 현상금 (12-136): 한 무리의 사람을 셋 죽였고 그 무리가 알게 되면 현상금이 걸린다 */
const content = loadRealContent();
const parse = createContentSchemas(content.scenario).storylet.parse;

function open(rng: number) {
  const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-bt-")), content, rngFactory: () => () => rng }).create("mcp", "role_a_grunt");
  const s = () => w.state();
  /** 그 틀의 엑스트라를 하나 만들어 주인공이 죽인다. witness면 다른 사람이 보고 있었다 */
  const killOne = (template: string, witness: boolean) => {
    executeTool("spawn_extra", { template, label: "사람" }, w.ctx());
    const id = Object.values(s().characters).filter((c) => c.extra?.template === template && !c.dead).at(-1)!.id;
    s().scene.present = witness ? [id, "a_chaewon"] : [id];
    changeCondition(w.ctx(), id, content.scenario.harm_track, 99, "attack", "주인공의 칼");
  };
  return { w, s, killOne };
}

describe("현상금", () => {
  it("다른 무리 사람을 셋 죽인 것이 알려지면 그 무리가 현상금을 걸고, 주인공은 소문으로 안다", () => {
    const { s, killOne } = open(0.99);
    killOne("c_absorbed", true);
    killOne("c_absorbed", true);
    expect(s().bounties).toEqual([]);
    killOne("c_absorbed", true);
    expect(s().bounties).toEqual(["faction_c"]);
    expect((s().beliefs[s().playerId] ?? []).some((b) => b.fact.includes("값을 걸었다"))).toBe(true);
    expect(describePlayerState(s(), content)).toContain("현상금:");
  });

  it("아무도 못 봤으면 흔적으로 알려질 때만 세고, 같은 무리 사람은 세지 않는다", () => {
    const { s, killOne } = open(0.99);
    for (let i = 0; i < 3; i++) killOne("c_absorbed", false);
    expect(s().killsKnown.faction_c ?? 0).toBe(0);
    for (let i = 0; i < 3; i++) killOne("a_scout", true);
    expect(s().killsKnown.faction_a ?? 0).toBe(0);
    expect(s().bounties).toEqual([]);
  });

  it("현상금 이야기: 우리 땅 밖에서만, {bounty_by}는 건 무리. clear_bounty로 거두면 셈도 처음부터", () => {
    const { w, s } = open(0.99);
    s().bounties = ["faction_c"];
    s().killsKnown = { faction_c: 3 };
    const poster = content.storylets.bt_poster!;
    const day = s().time - (s().time % 1440) + 1440 + 10 * 60;
    expect(conditionsMet(s(), content, poster, day)).toBe(false); // 거점(우리 땅)
    s().playerZone = "old_town";
    expect(conditionsMet(s(), content, poster, day)).toBe(true);
    expect(storyletVars(s(), content, {}).bounty_by).toBe(content.factions.faction_c!.name);
    const story = parse({ id: "t136", title: "t", setup: "x", choices: [{ id: "a", label: "a", effects: [{ clear_bounty: true }] }] });
    const ctx = { ...w.ctx(), content: { ...w.content, storylets: { ...w.content.storylets, t136: story } } };
    fireStorylet(ctx, story, {});
    expect(executeTool("resolve_storylet", { choice_id: "a" }, ctx).ok).toBe(true);
    expect(s().bounties).toEqual([]);
    expect(s().killsKnown.faction_c).toBe(0);
  });

  it("사냥꾼에게 붙잡히면 현상금을 건 무리에 넘겨진다", () => {
    const { w, s } = open(0.99);
    s().bounties = ["faction_c"];
    s().playerZone = "old_town";
    const story = parse({ id: "t136b", title: "t", setup: "x", choices: [{ id: "a", label: "a", effects: [{ capture_player: { by: "bounty" } }] }] });
    const ctx = { ...w.ctx(), content: { ...w.content, storylets: { ...w.content.storylets, t136b: story } } };
    fireStorylet(ctx, story, {});
    executeTool("resolve_storylet", { choice_id: "a" }, ctx);
    expect(s().characters[s().playerId]!.captive?.by).toBe("faction_c");
  });
});
