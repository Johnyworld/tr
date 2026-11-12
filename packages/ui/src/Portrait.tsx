/**
 * 코드로 그린 초상화 (실루엣). 세이브에는 id만 남고 그림은 화면이 그린다.
 * 그림 파일이 생기면 이 목록을 이미지로 바꾸면 된다.
 */
type Hair = "short" | "buzz" | "long" | "ponytail" | "hood" | "cap" | "bald" | "bob";
type Gear = "none" | "goggles" | "scarf" | "eyepatch" | "scar" | "bandana" | "gasmask";
type Preset = { skin: string; hair: string; hairStyle: Hair; cloth: string; bg: string; gear: Gear };

const PRESETS: Record<string, Preset> = {
  p0: { skin: "#c9a27e", hair: "#2b2420", hairStyle: "short", cloth: "#4a5240", bg: "#2a2622", gear: "none" },
  p1: { skin: "#b98b64", hair: "#1d1a17", hairStyle: "buzz", cloth: "#5a4632", bg: "#26231f", gear: "scar" },
  p2: { skin: "#d8b494", hair: "#3b2a1e", hairStyle: "long", cloth: "#3f4a52", bg: "#22262a", gear: "none" },
  p3: { skin: "#c49572", hair: "#191614", hairStyle: "ponytail", cloth: "#5b3b34", bg: "#2a221f", gear: "goggles" },
  p4: { skin: "#a87756", hair: "#2e2a26", hairStyle: "hood", cloth: "#3c3a33", bg: "#201f1c", gear: "scarf" },
  p5: { skin: "#d2ab88", hair: "#5a4430", hairStyle: "cap", cloth: "#55573f", bg: "#272820", gear: "none" },
  p6: { skin: "#b5835e", hair: "#2a2622", hairStyle: "bald", cloth: "#4b4038", bg: "#25211d", gear: "eyepatch" },
  p7: { skin: "#cfa07a", hair: "#2d221b", hairStyle: "bob", cloth: "#46504a", bg: "#1f2422", gear: "bandana" },
  p8: { skin: "#9c6c4c", hair: "#141210", hairStyle: "short", cloth: "#5d4c36", bg: "#2a251d", gear: "goggles" },
  p9: { skin: "#d6b08f", hair: "#7a6a58", hairStyle: "long", cloth: "#3b3836", bg: "#232120", gear: "scar" },
  p10: { skin: "#ba8a66", hair: "#221d19", hairStyle: "hood", cloth: "#4f3b2c", bg: "#261f19", gear: "gasmask" },
  p11: { skin: "#c79b78", hair: "#4a3a2c", hairStyle: "bob", cloth: "#3e4651", bg: "#20232a", gear: "scarf" },
};

export const PORTRAIT_IDS = Object.keys(PRESETS);

export function Portrait({ id, size = 64, title }: { id: string | null; size?: number; title?: string }) {
  const p = (id && PRESETS[id]) || null;
  if (!p) {
    return (
      <svg className="portrait" width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={title ?? "초상화 없음"}>
        <rect width="100" height="100" fill="#24211e" />
        <path d="M14 100 Q18 72 50 70 Q82 72 86 100 Z" fill="#33302b" />
        <ellipse cx="50" cy="44" rx="17" ry="20" fill="#33302b" />
      </svg>
    );
  }
  return (
    <svg className="portrait" width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={title ?? "초상화"}>
      <rect width="100" height="100" fill={p.bg} />
      {/* 뒤로 넘어가는 머리 */}
      {p.hairStyle === "ponytail" && <ellipse cx="68" cy="50" rx="7" ry="13" fill={p.hair} />}
      {p.hairStyle === "long" && <path d="M30 44 Q29 20 50 20 Q71 20 70 44 L73 70 Q64 64 63 48 L37 48 Q36 64 27 70 Z" fill={p.hair} />}
      {p.hairStyle === "hood" && <path d="M22 78 Q20 20 50 16 Q80 20 78 78 Z" fill={shade(p.cloth, -12)} />}
      {/* 몸 */}
      <path d="M10 100 Q14 72 50 69 Q86 72 90 100 Z" fill={p.cloth} />
      <path d="M38 71 L50 84 L62 71" fill="none" stroke={shade(p.cloth, -18)} strokeWidth="3" />
      <rect x="43" y="57" width="14" height="15" rx="4" fill={shade(p.skin, -14)} />
      {/* 얼굴 */}
      <ellipse cx="50" cy="44" rx="16.5" ry="19.5" fill={p.skin} />
      <ellipse cx="43.5" cy="45" rx="2.2" ry="1.6" fill="#1b1714" />
      <ellipse cx="56.5" cy="45" rx="2.2" ry="1.6" fill="#1b1714" />
      <path d="M45 55 Q50 57 55 55" fill="none" stroke={shade(p.skin, -30)} strokeWidth="1.4" strokeLinecap="round" />
      {/* 머리 */}
      {(p.hairStyle === "short" || p.hairStyle === "ponytail" || p.hairStyle === "long") && (
        <path d="M33 43 Q31 22 50 21 Q69 22 67 43 Q63 31 50 31 Q37 31 33 43 Z" fill={p.hair} />
      )}
      {p.hairStyle === "buzz" && <path d="M34 38 Q34 24 50 24 Q66 24 66 38 Q60 30 50 30 Q40 30 34 38 Z" fill={p.hair} />}
      {p.hairStyle === "bob" && <path d="M31 52 Q28 21 50 21 Q72 21 69 52 Q66 40 63 33 Q50 36 37 33 Q34 40 31 52 Z" fill={p.hair} />}
      {p.hairStyle === "cap" && (
        <>
          <path d="M33 38 Q33 22 50 22 Q67 22 67 38 Z" fill={shade(p.cloth, 8)} />
          <path d="M31 38 L72 38 Q72 42 62 41 L31 41 Z" fill={shade(p.cloth, -10)} />
        </>
      )}
      {p.hairStyle === "hood" && <path d="M30 60 Q28 26 50 24 Q72 26 70 60 Q68 40 64 34 Q50 28 36 34 Q32 40 30 60 Z" fill={shade(p.cloth, -4)} />}
      {/* 장비 */}
      {p.gear === "goggles" && (
        <>
          <rect x="33" y="31" width="34" height="3" fill="#2a2420" />
          <circle cx="43" cy="33" r="5" fill="#5f6b6a" stroke="#2a2420" strokeWidth="2" />
          <circle cx="57" cy="33" r="5" fill="#5f6b6a" stroke="#2a2420" strokeWidth="2" />
        </>
      )}
      {p.gear === "scarf" && <path d="M33 52 Q50 60 67 52 L67 62 Q50 70 33 62 Z" fill={shade(p.cloth, 14)} />}
      {p.gear === "eyepatch" && (
        <>
          <path d="M34 38 L66 48" stroke="#141210" strokeWidth="1.5" />
          <ellipse cx="56.5" cy="45" rx="4.5" ry="3.6" fill="#141210" />
        </>
      )}
      {p.gear === "scar" && <path d="M40 38 L47 52" stroke={shade(p.skin, -40)} strokeWidth="1.6" strokeLinecap="round" />}
      {p.gear === "bandana" && <path d="M33 34 Q50 28 67 34 L67 38 Q50 33 33 38 Z" fill="#7a3b30" />}
      {p.gear === "gasmask" && (
        <>
          <path d="M36 48 Q50 44 64 48 L62 60 Q50 66 38 60 Z" fill="#2f312d" />
          <circle cx="50" cy="59" r="4.5" fill="#4a4d47" stroke="#22231f" strokeWidth="1.5" />
        </>
      )}
    </svg>
  );
}

/** 색을 밝게(+)/어둡게(-) */
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, v + amount)).toString(16).padStart(2, "0");
  return `#${c((n >> 16) & 255)}${c((n >> 8) & 255)}${c(n & 255)}`;
}
