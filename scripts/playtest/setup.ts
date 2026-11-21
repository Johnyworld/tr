// 플레이 테스트 세계 만들기 (docs/playtests/README.md). 해금과 상관없이 시나리오를 바로 고른다 (사용자의 saves/unlocks.json을 건드리지 않는다).
// 사용법: npx tsx scripts/playtest/setup.ts <saves 폴더> <시나리오(역할) id> [캐릭터 JSON] [시드]
//   캐릭터 JSON 예: '{"name":"한별","gender":"female","past":"soldier","persona":{"temper":2,"talk":-1},"settings":["ideal_obedience","secret_deserter"]}'
//   지난 하네스의 빈칸(성격 없음, 설정 없음)을 메우려고 성격·설정·출신을 넣을 수 있다. 빠진 칸은 기본값
import { resolve } from "node:path";
import { WorldManager } from "../../packages/core/src/world/manager.ts";
import { loadRealContent } from "../../packages/core/src/testing.ts";
import { createSeededRng } from "../../packages/core/src/rng.ts";

const [savesDir, role, json, seed] = process.argv.slice(2);
if (!savesDir || !role) {
  console.error("사용법: npx tsx scripts/playtest/setup.ts <saves 폴더> <역할 id> [캐릭터 JSON] [시드]");
  process.exit(1);
}
const choice = { name: "한별", gender: "female", abilities: null, portrait: null, traits: [], ...(json ? JSON.parse(json) : {}) };
const m = new WorldManager({ savesDir: resolve(savesDir), content: loadRealContent(), rngFactory: () => createSeededRng(Number(seed ?? 7)) });
const w = m.create("mcp", role, choice as never);
const me = w.state().characters[w.state().playerId]!;
console.log(w.id);
console.error(`주인공 ${me.name} · 출신 ${me.past?.label ?? "-"} · 성격 ${JSON.stringify(me.persona)} · 설정 ${me.settings.join(", ") || "-"}`);
w.close();
