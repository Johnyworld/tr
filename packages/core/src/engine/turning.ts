import { heldOf } from "../rules/held.ts";
import type { Character } from "../game/character.ts";
import { aliasOf, knowsName } from "../game/acquaintance.ts";
import { josa } from "../text.ts";
import { createExtraCharacter, enterScene } from "./extras.ts";
import type { ToolContext } from "./toolkit.ts";
import { zoneOf } from "../rules/place.ts";

/**
 * 변이 (기획서 7.5.3, 12-117): 감염으로 죽은 사람은 그 자리에 감염체로 남는다.
 * 틀은 body.infection.turns_into, 겉모습은 그 사람의 것, 생전의 짐을 그대로 지닌다.
 * 주인공이 변하면 다음 캐릭터가 그 구역에서 전 주인공을 마주칠 수 있다
 */

/** 그 사람이 죽은 곳: 주인공은 지금 구역, 갇힌 사람은 갇힌 곳, 콘텐츠 인물은 지금 있을 곳, 엑스트라는 마지막으로 본 곳 */
function placeOf(ctx: ToolContext, c: Character): string | null {
  const state = ctx.store.getState();
  // 인물은 어디에 (공통 규칙 15)
  return zoneOf(state, ctx.content, c.id);
}

/** 감염으로 죽은 사람을 감염체로 남긴다. 만든 감염체 id (규칙·틀·자리가 없으면 null) */
export function turnIntoInfected(ctx: ToolContext, characterId: string): string | null {
  const { store, content, rng } = ctx;
  const templateId = content.scenario.body?.infection?.turns_into;
  const template = templateId ? content.extras[templateId] : undefined;
  const state = store.getState();
  const dead = state.characters[characterId];
  if (!template || !dead) return null;
  const zone = placeOf(ctx, dead);
  if (!zone) return null;
  const wasPlayer = characterId === state.playerId;
  // 호칭은 보는 사람마다 정한다 (aliasOf: 그 사람 이름을 알면 "변이한 ○○", 모르면 그 사람의 호칭). 저장하는 이름·호칭에는 이름을 넣지 않는다
  const label = `변이한 ${aliasOf(state, content, characterId)}`;
  const before = dead.extra?.look ?? content.npcs[characterId]?.look ?? "";
  const id = `ex_${state.nextExtraNo}`;
  const character = createExtraCharacter(
    content,
    template,
    { id, label, zone, time: state.time, usedNames: new Set(), name: "변이한 사람", age: dead.age ?? undefined, gender: dead.gender ?? undefined },
    rng,
  );
  character.inventory = {};
  character.extra!.turnedFrom = characterId;
  character.extra!.look = `${before ? `${before.replace(/[.。]\s*$/, "")}. ` : ""}그 사람이었던 것이다. 눈이 허옇게 흐려졌고 입가에 검은 피가 말라붙었다`;
  // 그 자리에 있어 본 것이 아니면 장면에 넣지 않고 만난 것으로 치지 않는다 (원칙 4)
  const seen = !wasPlayer && state.playerZone === zone && (state.scene.present.includes(characterId) || state.companions.includes(characterId));
  store.append({ type: "extra_spawned", character, ...(seen ? {} : { unseen: true }) });
  // 생전의 짐을 그대로 지닌다 (쓰러뜨리면 뒤질 수 있다)
  for (const [itemId, quantity] of Object.entries(dead.inventory)) {
    if (quantity > 0) store.append({ type: "item_transferred", from: characterId, to: id, itemId, quantity });
  }
  if (seen) {
    // 눈앞에서 변했다: 장면에 들어온 것으로 다시 들인다 (공포·첫 만남)
    store.append({ type: "npc_left", npcId: id });
    enterScene(ctx, id);
    const who = knowsName(state, state.playerId, characterId) ? dead.name : aliasOf(state, content, characterId);
    const fact = `${josa(who, "이/가")} 숨이 멎었다가 다시 움직였다. 감염체가 되었다`;
    const s = store.getState();
    store.append({ type: "belief_added", characterId: s.playerId, belief: { id: `b_${s.nextBeliefNo}`, fact, source: "seen", accuracy: "exact", learnedAt: s.time } });
  }
  return id;
}
