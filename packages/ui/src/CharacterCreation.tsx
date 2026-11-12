import { useEffect, useRef, useState } from "react";
import { fetchCreation, fetchRandomAbilities, newGame } from "./api.ts";
import { Portrait, PORTRAIT_IDS } from "./Portrait.tsx";
import { signed } from "./ToolCard.tsx";
import type { CreationRulesView, GameView } from "./types.ts";

/** 캐릭터 생성: 이름, 성별, 능력(포인트 구매), 초상화. 규칙 검증은 서버(core)가 한다 */
export function CharacterCreation({ onStart, onBack }: { onStart: (game: GameView) => void; onBack: () => void }) {
  const [rules, setRules] = useState<CreationRulesView | null>(null);
  const [name, setName] = useState("");
  const [gender, setGender] = useState<string | null>(null);
  const [abilities, setAbilities] = useState<Record<string, number>>({});
  // 모든 값을 플레이어가 직접 고른다 (기본값으로 채워 시작하지 않는다)
  const [portrait, setPortrait] = useState<string | null>(null);
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

  const missing = [
    name.trim() ? null : "이름",
    gender ? null : "성별",
    portrait ? null : "초상화",
    left === 0 ? null : `능력 포인트 ${left}`,
  ].filter((x): x is string => x !== null);

  async function start() {
    if (missing.length) return;
    setStarting(true);
    setError(null);
    try {
      onStart(await newGame({ name: name.trim(), gender, abilities, portrait }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStarting(false);
    }
  }

  return (
    <div className="title-screen creation">
      <button type="button" className="link back" onClick={onBack}>
        ← 돌아가기
      </button>
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
      <p className="muted small">시작 훈련: {rules.startSkills.map((s) => `${s.label} ${signed(s.value)}`).join(", ")}</p>

      {error && <div className="notice error">{error}</div>}
      {missing.length > 0 && <p className="muted small">아직 정하지 않은 것: {missing.join(", ")}</p>}
      <button type="button" className="new-game" onClick={() => void start()} disabled={starting || missing.length > 0}>
        {starting ? "세계를 만드는 중…" : "시작"}
      </button>
    </div>
  );
}
