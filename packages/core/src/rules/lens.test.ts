import { describe, expect, it } from "vitest";
import type { Content, StoryletContent } from "../content/schemas.ts";
import { checkMatureLines } from "../content/loader.ts";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { runAfterTimeAdvance } from "../engine/turnStart.ts";
import { romanceAllowed } from "../engine/romance.ts";
import { choiceAvailable } from "../story/storylets.ts";
import { loadRealContent } from "../testing.ts";
import { beliefText, deedText, shownOccupationTitle, toneDownLine } from "./lens.ts";

/** 공통 규칙 21: 보여 주기 (성인 옵션은 세계를 바꾸지 않고 보이는 것만) */
const real = loadRealContent();

function withMatureJob(): Content {
  const content = structuredClone(real);
  content.scenario.occupations.push({ id: "t_night", label: "밤일꾼", summary: "진짜 일", skills: [], kit: [], missions: [], mature: true, cover: { label: "술집 일꾼", summary: "술을 나른다" } });
  return content;
}

function setup(content: Content = real) {
  const store = new InMemoryGameStore([createWorldEvent(content, "role_a_grunt", "world_lens", () => 0.5)]);
  runAfterTimeAdvance({ store, rng: () => 0.5, content });
  return store;
}

describe("보여 주기", () => {
  it("성인 직업은 꺼져 있으면 겉 직업으로 보이고, 사람과 직업은 그대로다", () => {
    const content = withMatureJob();
    const store = setup(content);
    const s = store.getState();
    const id = Object.keys(s.characters).find((x) => x !== s.playerId && content.npcs[x])!;
    s.characters[id]!.occupation = { id: "t_night", standing: 0 };
    expect(shownOccupationTitle(store.getState(), content, s.characters[id])).toBe("술집 일꾼");
    expect(store.getState().characters[id]!.occupation?.id).toBe("t_night");
    store.append({ type: "content_options_set", mature: true });
    expect(shownOccupationTitle(store.getState(), content, store.getState().characters[id])).toBe("밤일꾼");
    // 이 사람만의 겉 직업
    content.npcs[id]!.occupation_cover = "여관 일꾼";
    store.append({ type: "content_options_set", mature: false });
    expect(shownOccupationTitle(store.getState(), content, store.getState().characters[id])).toBe("여관 일꾼");
  });

  it("믿음·행적은 성인 글이 있으면 켜져 있을 때만 그것으로", () => {
    const off = { options: { mature: false, dialogue: "novel" as const } };
    const on = { options: { mature: true, dialogue: "novel" as const } };
    const b = { fact: "노예상에게 팔려 갔다.", mature: "성노예로 팔려 갔다." };
    expect(beliefText(off, b)).toBe("노예상에게 팔려 갔다.");
    expect(beliefText(on, b)).toBe("성노예로 팔려 갔다.");
    expect(beliefText(on, { fact: "그냥 사실" })).toBe("그냥 사실");
    expect(deedText(off, { summary: "겉", mature: "속" })).toBe("겉");
    expect(toneDownLine(off, true)).toContain("수위를 낮춰");
    expect(toneDownLine(on, true)).toBeNull();
  });

  it("성인 선택지는 꺼져 있으면 숨는다", () => {
    const store = setup();
    const choice = { id: "c", label: "x", mature: true, effects: [] } as unknown as StoryletContent["choices"][number];
    expect(choiceAvailable(store.getState(), choice)).toBe(false);
    store.append({ type: "content_options_set", mature: true });
    expect(choiceAvailable(store.getState(), choice)).toBe(true);
  });

  it("연애는 다른 성별끼리만", () => {
    const store = setup();
    const s = store.getState();
    const me = s.characters[s.playerId]!;
    me.gender ??= real.scenario.creation!.genders[0]!.id;
    const other = Object.values(s.characters).find((c) => c.id !== me.id && content(c) && c.gender && c.gender !== me.gender && (c.age ?? 0) >= 20)!;
    const same = Object.values(s.characters).find((c) => c.id !== me.id && content(c) && c.gender === me.gender && (c.age ?? 0) >= 20)!;
    expect(romanceAllowed(s, real, me.id, other.id)).toBe(true);
    expect(romanceAllowed(s, real, me.id, same.id)).toBe(false);
  });

  it("검사: 겉 직업 없는 성인 직업, 선이 빠진 성인 이야기", () => {
    const content = withMatureJob();
    expect(checkMatureLines(content)).toEqual([]);
    delete content.scenario.occupations.at(-1)!.cover;
    expect(checkMatureLines(content).join(" ")).toContain("겉 직업(cover)이 없다");
    const story = Object.values(content.storylets).find((x) => x.tags.includes("mature"))!;
    story.ai_direction = "아무 안내 없음";
    expect(checkMatureLines(content).join(" ")).toContain(`storylets.${story.id}.ai_direction`);
  });
});

function content(c: { id: string }) {
  return !!real.npcs[c.id];
}
