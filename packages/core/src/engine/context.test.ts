import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { applyEvent, createWorldEvent, EMPTY_STATE, type GameState } from "../game/state.ts";
import { TEST_CONTENT } from "../testing.ts";
import { describePlayerState } from "./context.ts";
import { buildGmGuide } from "./prompt.ts";
import { gmToolSpecs } from "./tools.ts";

const REAL_CONTENT = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));

/** 모든 NPC가 장면에 있는 상태 (가장 많은 정보가 프롬프트에 들어가는 경우) */
function everyoneHere(content = REAL_CONTENT, roleId = "role_a_grunt"): GameState {
  let state = applyEvent(EMPTY_STATE, createWorldEvent(content, roleId, "w"));
  for (const id of Object.keys(content.npcs)) state = applyEvent(state, { type: "npc_entered", npcId: id });
  return state;
}

describe("정보 필터", () => {
  it("NPC의 비밀과 모르는 것(세계의 진실)은 GM 프롬프트에 들어가지 않는다", () => {
    const prompt = [
      buildGmGuide(REAL_CONTENT, "role_a_grunt", "mcp"),
      JSON.stringify(gmToolSpecs(REAL_CONTENT.scenario)),
      describePlayerState(everyoneHere(), REAL_CONTENT),
    ].join(
      "\n",
    );
    for (const npc of Object.values(REAL_CONTENT.npcs)) {
      if (npc.secret) {
        expect(prompt, `${npc.id}의 비밀`).not.toContain(npc.secret.content);
        expect(prompt, `${npc.id}의 비밀 공개 조건`).not.toContain(npc.secret.reveal_when);
      }
      for (const truth of npc.doesnt_know) expect(prompt, `${npc.id}의 doesnt_know`).not.toContain(truth);
    }
  });

  it("믿음의 진짜 정확도는 넣지 않는다 (틀린 소문도 그냥 소문으로 보인다)", () => {
    const prompt = describePlayerState(everyoneHere(TEST_CONTENT, "role_test"), TEST_CONTENT);
    expect(prompt).toContain("[소문] 정찰조는 감염체에게 당했다는 소문");
    expect(prompt).not.toMatch(/accuracy|approximate|정확도/);
  });

  it("장면에 있는 NPC는 연기용 프로필과 화법을, 없는 NPC는 공개 정보만 보인다", () => {
    let state = applyEvent(EMPTY_STATE, createWorldEvent(TEST_CONTENT, "role_test", "w"));
    const away = describePlayerState(state, TEST_CONTENT);
    expect(away).toContain("강분대 (npc_leader) · 분대장");
    expect(away).toContain("엄한 분대장");
    expect(away).not.toContain("분대원을 지키는 것"); // want는 장면에 있을 때만
    expect(away).not.toContain("동쪽 초소 교대 시간"); // NPC가 아는 것도

    state = applyEvent(state, { type: "npc_entered", npcId: "npc_leader" });
    const here = describePlayerState(state, TEST_CONTENT);
    expect(here).toContain("원하는 것: 분대원을 지키는 것");
    expect(here).toContain("말투 설명이 우선. 설명에 없는 경우의 기본: 이 인물은 당신에게 반말, 당신은 이 인물에게 존댓말");
    expect(here).toContain("동쪽 초소 교대 시간");
    expect(here).toContain("무전기(radio)");
  });

  it("모르는 인물은 프롬프트에 나오지 않는다", () => {
    const state = applyEvent(EMPTY_STATE, createWorldEvent(TEST_CONTENT, "role_test", "w"));
    expect(describePlayerState(state, TEST_CONTENT)).not.toContain("낯선이");
  });
});

describe("정보 필터: 평판", () => {
  function withDeed(hiddenWitness: string) {
    let state = applyEvent(EMPTY_STATE, createWorldEvent(TEST_CONTENT, "role_test", "w"));
    state = applyEvent(state, {
      type: "deed_recorded",
      deed: {
        id: "d_1",
        actorId: "player",
        summary: "창고에서 통조림을 훔쳤다",
        tags: ["theft"],
        severity: 2,
        at: 330,
        witnesses: [{ npcId: hiddenWitness, hidden: true }],
        searched: false,
      },
    });
    return applyEvent(state, {
      type: "deed_learned",
      deedId: "d_1",
      npcId: hiddenWitness,
      source: "seen",
      delta: { trust: -2, affection: 0, respect: 0 },
    });
  }

  it("숨은 목격자는 장면에 없으면 프롬프트에 드러나지 않는다", () => {
    const prompt = describePlayerState(withDeed("npc_leader"), TEST_CONTENT);
    // 플레이어 자신의 행적은 보이지만, 누가 그걸 아는지와 그로 인한 태도 변화는 보이지 않는다
    expect(prompt).toContain("- d_1: 창고에서 통조림을 훔쳤다");
    expect(prompt).not.toContain("통조림을 훔쳤다 (직접 봄)");
    expect(prompt).not.toContain("신뢰 -2");
  });

  it("목격자가 장면에 들어오면 그 인물의 지식과 태도로 반영된다", () => {
    const state = applyEvent(withDeed("npc_leader"), { type: "npc_entered", npcId: "npc_leader" });
    const prompt = describePlayerState(state, TEST_CONTENT);
    expect(prompt).toContain("신뢰 -2(냉담)");
    expect(prompt).toContain("창고에서 통조림을 훔쳤다 (직접 봄)");
  });

  it("비밀은 신뢰가 조건을 넘어야 '털어놓을 수 있다'만 보이고 내용은 보이지 않는다", () => {
    let state = applyEvent(EMPTY_STATE, createWorldEvent(TEST_CONTENT, "role_test", "w"));
    state = applyEvent(state, { type: "npc_entered", npcId: "npc_leader" });
    expect(describePlayerState(state, TEST_CONTENT)).not.toContain("비밀을 털어놓을 수 있는");
    state.relations.npc_leader = { player: { trust: 4, affection: 0, respect: 0 } };
    const ready = describePlayerState(state, TEST_CONTENT);
    expect(ready).toContain("비밀을 털어놓을 수 있는 관계");
    expect(ready).not.toContain("정찰조를 버리고 후퇴했다");
  });
});

describe("이미 기록된 행적", () => {
  it("GM이 같은 행동을 다시 기록하지 않도록 최근 행적을 보여 주되 목격자는 넣지 않는다", () => {
    let state = applyEvent(EMPTY_STATE, createWorldEvent(TEST_CONTENT, "role_test", "w"));
    state = applyEvent(state, {
      type: "deed_recorded",
      deed: {
        id: "d_1",
        actorId: "player",
        summary: "상자를 뒤졌다",
        tags: ["theft"],
        severity: 1,
        at: 330,
        witnesses: [{ npcId: "npc_leader", hidden: true }],
        searched: false,
      },
    });
    const prompt = describePlayerState(state, TEST_CONTENT);
    expect(prompt).toContain("- d_1: 상자를 뒤졌다");
    expect(prompt).not.toContain("npc_leader, hidden");
  });
});
