/**
 * 월드 팩의 세력 전쟁을 미리 돌려 본다 (기획서 12.4: 새 월드를 더할 때 산출·소모 균형 맞추기).
 * pnpm war:sim [팩 id] [--days N] [--seeds N] [--every N]
 * 무리마다 인원·전투원·식량·물·연료·사기와 구역 주인을 N일(기본 30)마다 찍는다. 연료는 겨울을 넘기는지 본다 (12-138). LLM 없음, 세이브 없음
 */
import { resolve } from "node:path";
import { baseInfestation, infestationDay, infestationOf } from "../game/infestation.ts";
import { seasonOfDay } from "./season.ts";
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
const every = flag("--every", 30);
const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios", pack);
const content = loadContent(root);

for (let seed = 1; seed <= seeds; seed++) {
  let world: WarWorld = initialWarWorld(content);
  const rng = createSeededRng(seed);
  let clashes = 0;
  // 움직이는 부대 (docs/war-parties-plan.md): 낸 부대 수
  let sent = 0;
  let before = 0;
  // 구역의 감염체 압력 (12-112·118): 교전의 시체로 오르고 날마다 돌아간다 (플레이어의 소음은 없다)
  const infested: Record<string, number> = {};
  for (let day = 1; day <= days; day++) {
    const r = simulateWarDay(world, content, rng, { season: seasonOfDay(content.scenario, day), infested, day });
    world = { factions: r.factions, zones: r.zones, clocks: r.clocks, parties: r.parties ?? [], nextPartyNo: r.nextPartyNo ?? 0, day };
    sent += (r.nextPartyNo ?? 0) - before;
    before = r.nextPartyNo ?? 0;
    clashes += r.clashes.length;
    for (const c of infestationDay(content, { infested, zoneNoise: {}, facilities: {} }, day, r.clashes, rng)) infested[c.zone] = c.level;
    if (day % every === 0 || day === days) {
      const factions = Object.entries(world.factions)
        .map(([id, f]) => `${content.factions[id]?.name ?? id} 인원 ${f.population} 전투원 ${f.combatants + (world.parties ?? []).filter((p) => p.faction === id).reduce((n, p) => n + p.size, 0)} 식량 ${f.resources.food ?? 0} 물 ${f.resources.water ?? 0} 연료 ${f.resources.fuel ?? 0} 사기 ${f.morale}`)
        .join(" | ");
      const zones = Object.entries(world.zones)
        .map(([z, o]) => `${content.locations[z]?.name ?? z}:${o.owner ? (content.factions[o.owner]?.name ?? o.owner) : "-"}`)
        .join(", ");
      const overrun = Object.keys(content.locations)
        .filter((z) => infestationOf(content, { infested }, z) > baseInfestation(content, z))
        .map((z) => `${content.locations[z]?.name ?? z} ${infestationOf(content, { infested }, z)}`)
        .join(", ");
      console.log(`[시드 ${seed} · ${day}일] ${factions}\n  구역 ${zones} · 교전 ${clashes}번${content.scenario.war?.parties ? ` · 부대 ${sent}번` : ""}${overrun ? `\n  감염체가 몰려든 곳: ${overrun}` : ""}`);
    }
  }
}
