/**
 * 상태 화면 아이콘 (12-64). 이름은 core `content/icons.ts`의 ICON_NAMES와 맞춘다.
 * 선으로 그린 24×24 그림. 모르는 이름은 상자로 그린다
 */
const PATHS: Record<string, string[]> = {
  blade: ["M4 20l4-4", "M8 16L18 4l2 2L10 18z"],
  club: ["M5 20l-1-1", "M6 18L16 6a2.6 2.6 0 0 1 3.7 3.7L8 20z"],
  gun: ["M3 8h16v4H10l-1 6H6l1-6H3z", "M11 12v2h2"],
  bow: ["M6 3c8 3 8 15 0 18", "M6 3v18", "M3 12h17", "M17 9l3 3-3 3"],
  fire: ["M12 3c3 4 6 6 6 10a6 6 0 0 1-12 0c0-3 2-4 3-6 1 2 2 3 3 3 0-3-1-5 0-7z"],
  bomb: ["M11 20a6 6 0 1 0 0-12 6 6 0 0 0 0 12z", "M15 9l2-2", "M18 4v1", "M20 6h-1", "M19.5 3.5l-.7.7"],
  ammo: ["M5 20V11l2-4 2 4v9z", "M10.5 20V11l2-4 2 4v9z", "M16 20V11l2-4 2 4v9z"],
  helmet: ["M4 16a8 8 0 0 1 16 0v3H4z", "M4 16h16", "M12 8v4"],
  vest: ["M8 3h8l1 4 3 2v12H4V9l3-2z", "M12 7v14", "M8 12h2", "M14 12h2"],
  food: ["M6 7h12v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z", "M6 7a6 2 0 0 1 12 0", "M6 11h12"],
  water: ["M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z"],
  medicine: ["M4 7h16v12H4z", "M9 7V4h6v3", "M12 10v6", "M9 13h6"],
  tool: ["M14 4l6 6-3 3-6-6z", "M11 10l-7 7 3 3 7-7"],
  light: ["M8 3h8l-2 6v11h-4V9z", "M12 13v2"],
  pen: ["M15 4l5 5L9 20H4v-5z", "M13 6l5 5"],
  paper: ["M6 3h9l4 4v14H6z", "M15 3v4h4", "M9 12h7", "M9 16h7"],
  key: ["M8 19a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M11 12l9-9", "M17 6l2 2", "M15 8l2 2"],
  bag: ["M5 8h14l-1 13H6z", "M9 8a3 3 0 0 1 6 0"],
  cloth: ["M4 6h16v5H4z", "M5 11h14v8H5z", "M9 11v8"],
  material: ["M3 7h18v3H3z", "M3 12h18v3H3z", "M6 17h12v3H6z"],
  box: ["M4 8l8-4 8 4v8l-8 4-8-4z", "M4 8l8 4 8-4", "M12 12v8"],
  heart: ["M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"],
  hunger: ["M4 11h16a8 8 0 0 1-16 0z", "M9 4v4", "M12 3v5", "M15 4v4"],
  virus: ["M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z", "M12 3v4", "M12 17v4", "M3 12h4", "M17 12h4", "M5.6 5.6l2.9 2.9", "M15.5 15.5l2.9 2.9", "M5.6 18.4l2.9-2.9", "M15.5 8.5l2.9-2.9"],
  cold: ["M12 3v18", "M4.2 7.5l15.6 9", "M4.2 16.5l15.6-9", "M9.5 4.5L12 7l2.5-2.5", "M9.5 19.5L12 17l2.5 2.5"],
  fever: ["M10 4a2 2 0 0 1 4 0v10a4 4 0 1 1-4 0z", "M12 10v7"],
  sun: ["M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M12 2v2", "M12 20v2", "M4.9 4.9l1.4 1.4", "M17.7 17.7l1.4 1.4", "M2 12h2", "M20 12h2", "M4.9 19.1l1.4-1.4", "M17.7 6.3l1.4-1.4"],
  cloud: ["M7 18a4 4 0 0 1-.6-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"],
  rain: ["M7 14a4 4 0 0 1-.6-8A6 6 0 0 1 18 5a4.5 4.5 0 0 1-.5 9z", "M8 17l-1 3", "M12 17l-1 3", "M16 17l-1 3"],
  fog: ["M4 8h16", "M3 12h14", "M6 16h15", "M5 20h10"],
  snow: ["M7 13a4 4 0 0 1-.6-8A6 6 0 0 1 18 4a4.5 4.5 0 0 1-.5 9z", "M8 17h.01", "M12 16h.01", "M16 17h.01", "M10 20h.01", "M14 20h.01"],
  moon: ["M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"],
  mind: ["M12 3a7 7 0 0 0-4 12.7V19h8v-3.3A7 7 0 0 0 12 3z", "M10 21h4", "M12 8v4", "M10 10h4"],
};

export function Icon({ name, size = 16, className }: { name: string | null | undefined; size?: number; className?: string }) {
  const paths = PATHS[name ?? ""] ?? PATHS.box!;
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
