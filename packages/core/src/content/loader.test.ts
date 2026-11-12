import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { readFileSync } from "node:fs";
import { ContentError, loadContent } from "./loader.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const REAL_CONTENT = resolve(here, "../../../../content/scenarios/post_apoc");

/** 실제 시나리오 설정(scenario.yaml, 화법, 톤)만 복사한 임시 시나리오 폴더 (전투 설정 제외) */
function tempContent(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "trpg-content-"));
  for (const file of ["speech", "prompts"]) {
    cpSync(join(REAL_CONTENT, file), join(dir, file), { recursive: true });
  }
  // 전투 설정은 실제 아이템(폭약 등)을 참조하므로 뺀다 (아이템은 각 테스트가 정한다)
  const scenario = parse(readFileSync(join(REAL_CONTENT, "scenario.yaml"), "utf8")) as Record<string, unknown>;
  delete scenario.battle;
  delete scenario.recovery;
  writeFileSync(join(dir, "scenario.yaml"), stringify(scenario));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

const role = (inventory: string) => `
id: role_x
label: 테스트
faction: faction_a
rank: grunt
default_name: 테스트
age: 20
start_stats: { strength: 0, agility: 0, nerve: 0, senses: 0, persuasion: 0 }
opening_scene: 시작
start_inventory: [${inventory}]
`;

describe("loadContent", () => {
  it("저장소의 실제 콘텐츠가 검증을 통과한다", () => {
    const content = loadContent(REAL_CONTENT);
    expect(content.roles.role_a_grunt?.default_name).toBe("신병");
    expect(content.items.kitchen_knife?.name).toBe("부엌칼");
  });

  it("한 파일에 목록을 둘 수 있고, 없는 폴더는 빈 목록이다", () => {
    const dir = tempContent({ "items/a.yaml": "- { id: a, name: 가 }\n- { id: b, name: 나 }" });
    expect(Object.keys(loadContent(dir).items)).toEqual(["a", "b"]);
  });

  it("문제를 한 번에 모아서 보고한다", () => {
    const dir = tempContent({
      "items/a.yaml": "- { id: a, name: 가 }\n- { id: a, name: 중복 }\n- { id: Bad-Id, name: x }",
      "items/b.yaml": "id: [broken",
      "roles/x.yaml": role("ghost_item"),
    });
    try {
      loadContent(dir);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ContentError);
      const problems = (err as ContentError).problems.join("\n");
      expect(problems).toContain("id 중복");
      expect(problems).toContain("items/a.yaml[2]");
      expect(problems).toContain("YAML 문법 오류");
      expect(problems).toContain("알 수 없는 아이템 ghost_item");
    }
  });

  it("시나리오에 없는 능력치·등급은 거부한다 (ID는 시나리오가 정한다)", () => {
    const dir = tempContent({
      "roles/x.yaml": role("").replace("nerve: 0", "cool: 0").replace("rank: grunt", "rank: general"),
    });
    try {
      loadContent(dir);
      expect.unreachable();
    } catch (err) {
      const problems = (err as ContentError).problems.join("\n");
      expect(problems).toContain("cool");
      expect(problems).toContain("rank");
    }
  });

  it("scenario.yaml이 깨져 있으면 무엇이 문제인지 알려 준다", () => {
    const dir = tempContent({});
    writeFileSync(join(dir, "scenario.yaml"), "id: x\nname: 테스트\n");
    expect(() => loadContent(dir)).toThrow(/scenario\.yaml/);
  });

  it("스키마에 없는 필드와 범위를 벗어난 능력치를 거부한다", () => {
    const dir = tempContent({
      "items/a.yaml": "id: a\nname: 가\nprice: 3",
      "roles/x.yaml": role("").replace("strength: 0", "strength: 5"),
    });
    expect(() => loadContent(dir)).toThrow(ContentError);
  });
});

describe("전투 설정 참조", () => {
  it("전투 효과·준비물이 쓰는 아이템이 콘텐츠에 없으면 거부한다", () => {
    const dir = tempContent({ "items/a.yaml": "- { id: a, name: 가 }" });
    const scenario = parse(readFileSync(join(REAL_CONTENT, "scenario.yaml"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "scenario.yaml"), stringify(scenario));
    expect(() => loadContent(dir)).toThrow(/알 수 없는 아이템 explosive/);
  });
});

describe("스토리렛 참조", () => {
  it("배역·아이템·문장의 자리를 검사한다", () => {
    const dir = tempContent({
      "items/a.yaml": "- { id: a, name: 가 }",
      "storylets/s.yaml": `
id: s1
title: 테스트
cast: { friend: { known: true } }
setup: "{friend:이/가} {nobody}를 부른다"
choices:
  - id: c1
    label: 받는다
    effects: [ { give_item: { item: ghost } }, { relation: { who: stranger, axis: trust, delta: 1 } } ]
`,
    });
    try {
      loadContent(dir);
      expect.unreachable();
    } catch (err) {
      const problems = (err as ContentError).problems.join("\n");
      expect(problems).toContain("알 수 없는 자리 {nobody}");
      expect(problems).toContain("알 수 없는 아이템 ghost");
      expect(problems).toContain("알 수 없는 배역 stranger");
    }
  });
});
