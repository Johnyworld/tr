import { describe, expect, it } from "vitest";
import { storyFits } from "./situation.ts";

const content = { scenario: { captivity: { tag: "captivity" }, condition_tracks: [], symptoms: [] } } as never;
const story = (x: Record<string, unknown>) => ({ tags: [], when: {}, ...x }) as never;
const state = (x: Record<string, unknown> = {}) => ({ lastActivity: null, ...x }) as never;

describe("공통 규칙 4: 이야기는 지금 처지에 맞을 때만", () => {
  it("갇힘 이야기는 갇혔을 때만, 다른 이야기는 갇혀 있으면 열리지 않는다", () => {
    expect(storyFits(story({ tags: ["captivity"] }), state(), content, "captive")).toBe(true);
    expect(storyFits(story({ tags: ["captivity"] }), state(), content, "awake")).toBe(false);
    expect(storyFits(story({}), state(), content, "captive")).toBe(false);
  });

  it("막 깬 때(누움)는 급한 이야기·침상 이야기·깨우는 이야기만", () => {
    expect(storyFits(story({}), state(), content, "lying")).toBe(false);
    expect(storyFits(story({ urgent: true }), state(), content, "lying")).toBe(true);
    expect(storyFits(story({ bedside: true }), state(), content, "lying")).toBe(true);
    expect(storyFits(story({ when: { activities: ["sleep"] } }), state(), content, "lying")).toBe(true);
  });

  it("깨어 있으면 보통 이야기가 열리고, 침상 이야기는 쉬는 중에만", () => {
    expect(storyFits(story({}), state(), content, "awake")).toBe(true);
    expect(storyFits(story({ bedside: true }), state({ lastActivity: "guard_duty" }), content, "awake")).toBe(false);
    expect(storyFits(story({ bedside: true }), state({ lastActivity: "rest" }), content, "awake")).toBe(true);
  });

  it("탐험·위협 앞에서는 그 처지를 적은 이야기만", () => {
    expect(storyFits(story({ urgent: true }), state(), content, "exploring")).toBe(false);
    expect(storyFits(story({}), state(), content, "threatened")).toBe(false);
    expect(storyFits(story({ situations: ["exploring"] }), state(), content, "exploring")).toBe(true);
  });
});
