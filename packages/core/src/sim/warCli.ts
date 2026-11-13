/**
 * 월드 팩의 세력 전쟁을 미리 돌려 본다 (기획서 12.4: 새 월드를 더할 때 산출·소모 균형 맞추기).
 * pnpm war:sim [팩 id] [--days N] [--seeds N]
 * 무리마다 인원·전투원·식량·물·사기와 구역 주인을 30일마다 찍는다. LLM 없음, 세이브 없음
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadContent } from "../content/loader.ts";
import { createSeededRng } from "../rng.ts";
import { initialWarWorld, simulateWarDay, type WarWorld } from "./war.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const pack = args.find((a) => !a.startsWith("--") && Number.isNaN(Number(a))) ?? process.env.SCENARIO ?? "post_apoc";
const days = flag("--days", 90);
const seeds = flag("--seeds", 3);
const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios", pack);
const content = loadContent(root);

for (let seed = 1; seed <= seeds; seed++) {
  let world: WarWorld = initialWarWorld(content);
  const rng = createSeededRng(seed);
  let clashes = 0;
  for (let day = 1; day <= days; day++) {
    const r = simulateWarDay(world, content, rng);
    world = { factions: r.factions, zones: r.zones, clocks: r.clocks };
    clashes += r.clashes.length;
    if (day % 30 === 0 || day === days) {
      const factions = Object.entries(world.factions)
        .map(([id, f]) => `${content.factions[id]?.name ?? id} 인원 ${f.population} 전투원 ${f.combatants} 식량 ${f.resources.food ?? 0} 물 ${f.resources.water ?? 0} 사기 ${f.morale}`)
        .join(" | ");
      const zones = Object.entries(world.zones)
        .map(([z, o]) => `${content.locations[z]?.name ?? z}:${o.owner ? (content.factions[o.owner]?.name ?? o.owner) : "-"}`)
        .join(", ");
      console.log(`[시드 ${seed} · ${day}일] ${factions}\n  구역 ${zones} · 교전 ${clashes}번`);
    }
  }
}
