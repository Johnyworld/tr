import { useEffect, useRef, useState } from "react";
import { fetchCreation, fetchRandomAbilities, fetchRandomTraits, newGame } from "./api.ts";
import { Portrait, PORTRAIT_IDS } from "./Portrait.tsx";
import { signed } from "./ToolCard.tsx";
import type { CreationRulesView, GameView } from "./types.ts";

/** 캐릭터 생성: 이름, 성별, 능력(포인트 구매), 초상화. 규칙 검증은 서버(core)가 한다 */
export function CharacterCreation({ onStart, onBack }: { onStart: (game: GameView) => void; onBack?: () => void }) {
  const [rules, setRules] = useState<CreationRulesView | null>(null);
  const [name, setName] = useState("");
  const [gender, setGender] = useState<string | null>(null);
  const [abilities, setAbilities] = useState<Record<string, number>>({});
  // 모든 값을 플레이어가 직접 고른다 (기본값으로 채워 시작하지 않는다)
  const [portrait, setPortrait] = useState<string | null>(null);
  const [traits, setTraits] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const autoStarted = useRef(false);

  useEffect(() => {
    fetchCreation()
      .then((r) => {
        setRules(r);
        // 생성 규칙이 없는 시나리오는 역할이 정한 캐릭터로 바로 시작한다
        if (!r && !autoStarted.current) {
          autoStarted.current = true;
          void newGame(null).then(onStart, (err: unknown) => setError(String(err)));
        }
      })
      .finally(() => setLoaded(true))
      .catch((err: unknown) => setError(String(err)));
  }, []);

  if (!rules) {
    return (
      <div className="title-screen">
        {error ? <div className="notice error">{error}</div> : <p className="muted">{loaded ? "세계를 만드는 중…" : "불러오는 중…"}</p>}
      </div>
    );
  }

  const costOf = (v: number) => rules.cost.find((c) => c.value === v)?.cost;
  const values = rules.cost.map((c) => c.value);
  const valueOf = (id: string) => abilities[id] ?? 0;
  const spent = rules.abilities.reduce((n, a) => n + (costOf(valueOf(a.id)) ?? 0), 0);
  const low = rules.abilities.filter((a) => valueOf(a.id) < 0).length;
  const left = rules.points - spent;

  const step = (id: string, dir: 1 | -1) => {
    const now = valueOf(id);
    const next = values[values.indexOf(now) + dir];
    if (next === undefined) return null;
    const delta = (costOf(next) ?? 0) - (costOf(now) ?? 0);
    if (delta > left) return null;
    if (next < 0 && now >= 0 && low >= rules.maxLow) return null;
    return next;
  };

  // 트레잇 포인트: 긍정 비용 합 ≤ 부정 보상 합 (검증은 서버의 core가 다시 한다)
  const traitDef = (id: string) => rules.traits.find((t) => t.id === id);
  const chosen = traits.map(traitDef).filter((t) => t !== undefined);
  const traitSpent = chosen.filter((t) => t.kind === "positive").reduce((n, t) => n + t.cost, 0);
  const traitEarned = chosen.filter((t) => t.kind === "negative").reduce((n, t) => n + t.cost, 0);
  const countOf = (kind: string) => chosen.filter((t) => t.kind === kind).length;
  const limitOf = { positive: rules.traitLimits.max_positive, negative: rules.traitLimits.max_negative, personality: rules.traitLimits.max_personality };
  const canAdd = (t: CreationRulesView["traits"][number]) =>
    !traits.includes(t.id) &&
    !t.opposites.some((o) => traits.includes(o)) &&
    !chosen.some((c) => c.opposites.includes(t.id)) &&
    countOf(t.kind) < limitOf[t.kind] &&
    (t.kind !== "positive" || traitSpent + t.cost <= traitEarned);
  const toggleTrait = (t: CreationRulesView["traits"][number]) =>
    setTraits(traits.includes(t.id) ? traits.filter((x) => x !== t.id) : canAdd(t) ? [...traits, t.id] : traits);

  const missing = [
    name.trim() ? null : "이름",
    gender ? null : "성별",
    portrait ? null : "초상화",
    left === 0 ? null : `능력 포인트 ${left}`,
    traitSpent <= traitEarned ? null : `트레잇 포인트 ${traitSpent - traitEarned} 모자람 (긍정을 빼거나 부정을 더 고른다)`,
  ].filter((x): x is string => x !== null);

  async function start() {
    if (missing.length) return;
    setStarting(true);
    setError(null);
    try {
      onStart(await newGame({ name: name.trim(), gender, abilities, portrait, traits }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStarting(false);
    }
  }

  return (
    <div className="title-screen creation">
      {onBack && (
        <button type="button" className="link back" onClick={onBack}>
          ← 돌아가기
        </button>
      )}
      <h1>새 캐릭터</h1>
      <p className="muted">시작 역할: {rules.roleLabel}. 직업·출신은 아직 고를 수 없다.</p>

      <section className="creation-top">
        <Portrait id={portrait} size={112} />
        <div className="creation-fields">
          <label>
            <span>이름</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="이름을 입력하세요" maxLength={20} autoFocus />
          </label>
          <div>
            <span className="field-label">성별</span>
            <div className="choice-row">
              {rules.genders.map((g) => (
                <button key={g.id} type="button" className={gender === g.id ? "chip on" : "chip"} onClick={() => setGender(g.id)}>
                  {g.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <h2>초상화</h2>
      <div className="portrait-grid">
        {PORTRAIT_IDS.map((id) => (
          <button key={id} type="button" className={portrait === id ? "portrait-pick on" : "portrait-pick"} onClick={() => setPortrait(id)} aria-label={`초상화 ${id}`}>
            <Portrait id={id} size={56} />
          </button>
        ))}
      </div>

      <h2>
        능력 <span className={left === 0 ? "muted" : "points-left"}>남은 포인트 {left}/{rules.points}</span>
      </h2>
      <p className="muted small">
        모두 0에서 시작한다. {rules.cost.map((c) => `${signed(c.value)}는 ${c.cost}`).join(", ")}포인트 (낮추면 돌려받는다, {rules.maxLow}개까지). 능력은 타고난 것이라 나중에 오르지 않는다.
      </p>
      <ul className="ability-list">
        {rules.abilities.map((a) => {
          const v = valueOf(a.id);
          const down = step(a.id, -1);
          const up = step(a.id, 1);
          return (
            <li key={a.id}>
              <div>
                <strong>{a.label}</strong> <span className="muted small">{a.description}</span>
              </div>
              <div className="stepper">
                <button type="button" disabled={down === null} onClick={() => down !== null && setAbilities({ ...abilities, [a.id]: down })} aria-label={`${a.label} 낮추기`}>
                  −
                </button>
                <span className={v > 0 ? "value up" : v < 0 ? "value down" : "value"}>{signed(v)}</span>
                <button type="button" disabled={up === null} onClick={() => up !== null && setAbilities({ ...abilities, [a.id]: up })} aria-label={`${a.label} 올리기`}>
                  +
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="choice-row">
        <button type="button" className="chip" onClick={() => void fetchRandomAbilities().then(setAbilities)}>
          무작위
        </button>
        <button type="button" className="chip" onClick={() => setAbilities({})}>
          초기화
        </button>
      </div>
      <h2>
        트레잇{" "}
        <span className={traitSpent > traitEarned ? "points-left" : "muted"}>
          포인트 {traitEarned - traitSpent} (부정 +{traitEarned} / 긍정 −{traitSpent})
        </span>
      </h2>
      <p className="muted small">
        긍정 트레잇은 부정 트레잇으로 얻은 포인트만큼 고른다. 긍정 {limitOf.positive}개·부정 {limitOf.negative}개·성격 {limitOf.personality}개까지, 반대끼리는 함께 고를 수 없다. 고르지 않아도 된다.
      </p>
      {(["positive", "negative", "personality"] as const).map((kind) => (
        <div key={kind} className="trait-group">
          <div className="field-label">
            {{ positive: "긍정 (포인트를 쓴다)", negative: "부정 (포인트를 얻는다)", personality: "성격" }[kind]} {countOf(kind)}/{limitOf[kind]}
          </div>
          <div className="choice-row">
            {rules.traits
              .filter((t) => t.kind === kind)
              .map((t) => {
                const on = traits.includes(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={`chip trait ${kind} ${on ? "on" : ""}`}
                    disabled={!on && !canAdd(t)}
                    onClick={() => toggleTrait(t)}
                    title={t.description}
                  >
                    {t.label}
                    {kind !== "personality" && <span className="trait-cost">{kind === "positive" ? `−${t.cost}` : `+${t.cost}`}</span>}
                  </button>
                );
              })}
          </div>
        </div>
      ))}
      {chosen.length > 0 && (
        <ul className="trait-picked muted small">
          {chosen.map((t) => (
            <li key={t.id}>
              <strong>{t.label}</strong> {t.description}
            </li>
          ))}
        </ul>
      )}
      <div className="choice-row">
        <button type="button" className="chip" onClick={() => void fetchRandomTraits().then(setTraits)}>
          트레잇 무작위
        </button>
        <button type="button" className="chip" onClick={() => setTraits([])}>
          트레잇 비우기
        </button>
      </div>

      <p className="muted small">시작 훈련: {rules.startSkills.map((s) => `${s.label} ${signed(s.value)}`).join(", ")}</p>

      {error && <div className="notice error">{error}</div>}
      {missing.length > 0 && <p className="muted small">아직 정하지 않은 것: {missing.join(", ")}</p>}
      <button type="button" className="new-game" onClick={() => void start()} disabled={starting || missing.length > 0}>
        {starting ? "세계를 만드는 중…" : "시작"}
      </button>
    </div>
  );
}
