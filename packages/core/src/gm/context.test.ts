import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { applyEvent, createWorldEvent, EMPTY_STATE, type GameState } from "../game/state.ts";
import { TEST_CONTENT } from "../testing.ts";
import { describePlayerState } from "./context.ts";
import { GM_SYSTEM_PROMPT } from "./prompt.ts";
import { GM_TOOL_SPECS } from "./tools.ts";

const REAL_CONTENT = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content"));

/** 모든 NPC가 장면에 있는 상태 (가장 많은 정보가 프롬프트에 들어가는 경우) */
function everyoneHere(content = REAL_CONTENT, roleId = "role_a_grunt"): GameState {
  let state = applyEvent(EMPTY_STATE, createWorldEvent(content, roleId, "w"));
  for (const id of Object.keys(content.npcs)) state = applyEvent(state, { type: "npc_entered", npcId: id });
  return state;
}

describe("정보 필터", () => {
  it("NPC의 비밀과 모르는 것(세계의 진실)은 GM 프롬프트에 들어가지 않는다", () => {
    const prompt = [GM_SYSTEM_PROMPT, JSON.stringify(GM_TOOL_SPECS), describePlayerState(everyoneHere(), REAL_CONTENT)].join(
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
    expect(here).toContain("이 인물은 당신에게 기본적으로 반말, 당신은 이 인물에게 존댓말");
    expect(here).toContain("동쪽 초소 교대 시간");
    expect(here).toContain("무전기(radio)");
  });

  it("모르는 인물은 프롬프트에 나오지 않는다", () => {
    const state = applyEvent(EMPTY_STATE, createWorldEvent(TEST_CONTENT, "role_test", "w"));
    expect(describePlayerState(state, TEST_CONTENT)).not.toContain("낯선이");
  });
});
