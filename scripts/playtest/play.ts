// 플레이 테스트 하네스 (docs/playtests/README.md): MCP 서버를 새로 띄워 세계를 열고, 호출 목록을 차례로 실행해 결과 전체를 출력한다.
// 사용법: npx tsx scripts/playtest/play.ts <saves 폴더> <세계 id> <cN.json>  >  oN.txt
//   cN.json: [{"tool":"take_action","args":{...}}, ...]  (한 번에 1~4개. start_session은 자동, 결과 전체를 보려면 SHOW_START=1)
//   PLAYTEST_ROOT=<폴더>: 다른 작업 폴더(예: 특정 커밋을 꺼낸 git worktree)의 코드로 돌린다. 없으면 이 저장소
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const [savesDir, worldId, file] = process.argv.slice(2);
if (!savesDir || !worldId || !file) {
  console.error("사용법: npx tsx scripts/playtest/play.ts <saves 폴더> <세계 id> <cN.json>");
  process.exit(1);
}
const root = resolve(process.env.PLAYTEST_ROOT ?? resolve(import.meta.dirname, "../.."));
const calls: { tool: string; args: Record<string, unknown> }[] = JSON.parse(readFileSync(file, "utf8"));
const transport = new StdioClientTransport({
  command: "pnpm",
  args: ["--silent", "--filter", "@trpg/mcp", "start"],
  cwd: root,
  // 상태 화면·RAG는 끈다. 치트는 켜 두지만 테스트에서는 쓰지 않는다 (원하는 장면까지 빨리 가는 회귀 확인만)
  env: { ...process.env, SAVES_DIR: resolve(savesDir), TRPG_STATUS: "off", RAG: "off", TRPG_DEBUG: "1" } as Record<string, string>,
  stderr: "ignore",
});
const client = new Client({ name: "playtest", version: "0" });
await client.connect(transport);
const text = (r: unknown) => ((r as { content?: { type: string; text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
const first = await client.callTool({ name: "start_session", arguments: { world_id: worldId } });
// SHOW_START가 "1"일 때만 세션 시작 전체를 (PT26: "0"도 켜졌다)
if (process.env.SHOW_START === "1") console.log("=== start_session\n" + text(first));
else {
  // 세션을 열 때 처리한 일(쓰러진 동안의 돌봄 등)은 실제 플레이에서 GM이 먼저 받는 글이라 늘 보인다 (PT28 분대장: 돌봄 결과가 안 보여 6시간을 더 의식불명으로 넘겼다)
  const notes = /\n## 지난번 뒤에 일어난 일[^\n]*\n([\s\S]*?)\n## /.exec(text(first))?.[1];
  if (notes) console.log("=== start_session: 지난번 뒤에 일어난 일 (먼저 서술한다)\n" + notes);
}
for (const c of calls) {
  const r = await client.callTool({ name: c.tool, arguments: c.args });
  console.log(`\n=== ${c.tool} ${JSON.stringify(c.args).slice(0, 200)}${(r as { isError?: boolean }).isError ? " [ERROR]" : ""}\n` + text(r));
}
await client.close();
