import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ContentError, loadContent } from "./loader.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const REAL_CONTENT = resolve(here, "../../../../content");

function tempContent(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "trpg-content-"));
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
start_stats: { strength: 0, agility: 0, cool: 0, sense: 0, persuasion: 0 }
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

  it("스키마에 없는 필드와 범위를 벗어난 능력치를 거부한다", () => {
    const dir = tempContent({
      "items/a.yaml": "id: a\nname: 가\nprice: 3",
      "roles/x.yaml": role("").replace("strength: 0", "strength: 5"),
    });
    expect(() => loadContent(dir)).toThrow(ContentError);
  });
});
