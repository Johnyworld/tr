import { configDefaults, defineConfig } from "vitest/config";

/**
 * 기본 `pnpm test`는 빠른 단위 테스트만 돌린다.
 * 실제 콘텐츠로 수백 턴을 돌리는 자동 플레이(*.slow.test.ts)는 `pnpm test:slow`, 전부는 `pnpm test:all`.
 */
const slow = process.env.TEST_SLOW === "1";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    exclude: slow ? configDefaults.exclude : [...configDefaults.exclude, "**/*.slow.test.ts"],
  },
});
