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
    // 실제 월드 팩을 읽는 테스트가 많아, 기기가 바쁘면 기본 5초를 넘긴다
    testTimeout: 15_000,
  },
});
