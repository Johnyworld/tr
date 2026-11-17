import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCharacterFromRole } from "../game/state.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { runDailyBody, useItem } from "./body.ts";

/** 골초 (12-129): 하루 한 갑을 저절로 피우고, 담배 없이 하루를 넘기면 안절부절 */
const content = loadRealContent();

function open(packs: number) {
  const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-habit-")), content, rngFactory: () => () => 0.99 }).create("mcp", "role_a_grunt");
  const me = () => w.state().characters[w.state().playerId]!;
  me().traits = [...me().traits, "chain_smoker"];
  me().inventory.cigarettes = packs;
  return { w, me, craving: () => me().conditions.craving ?? "satisfied" };
}

describe("골초", () => {
  it("하루가 지나면 담배 한 갑을 저절로 피운다", () => {
    const { w, me, craving } = open(2);
    runDailyBody(w.ctx());
    expect(me().inventory.cigarettes).toBe(1);
    expect(craving()).toBe("satisfied");
  });

  it("담배 없이 하루를 넘기면 안절부절, 다음 날 담배가 있으면 피우고 풀린다", () => {
    const { w, me, craving } = open(0);
    runDailyBody(w.ctx());
    expect(craving()).toBe("restless");
    me().inventory.cigarettes = 1;
    runDailyBody(w.ctx());
    expect(me().inventory.cigarettes ?? 0).toBe(0);
    expect(craving()).toBe("satisfied");
  });

  it("낮에 담배를 구하면 바로 피워 풀 수 있고, 안절부절이 아니면 피울 필요가 없다", () => {
    const { w, me, craving } = open(0);
    runDailyBody(w.ctx());
    me().inventory.cigarettes = 2;
    expect(useItem(w.ctx(), "cigarettes").ok).toBe(true);
    expect(craving()).toBe("satisfied");
    expect(me().inventory.cigarettes).toBe(1);
    expect(useItem(w.ctx(), "cigarettes").ok).toBe(false);
  });

  it("골초가 아니면 담배가 없어도 아무렇지 않다", () => {
    const { w, me, craving } = open(0);
    me().traits = me().traits.filter((t) => t !== "chain_smoker");
    runDailyBody(w.ctx());
    expect(craving()).toBe("satisfied");
  });

  it("골초로 만든 캐릭터는 담배 세 갑을 들고 시작한다", () => {
    const role = content.roles.role_a_grunt!;
    const c = createCharacterFromRole(content.scenario, role, "player", undefined, { name: "", traits: ["chain_smoker"] } as never);
    expect(c.inventory.cigarettes).toBe(3);
  });
});
