/**
 * On-brand campaign hero art (SVG). This is the visual the Image Generation /
 * Claude Design flow produces for previews — a jobsite-at-dawn scene with the
 * campaign headline. Deterministic (no randomness), parameterised so refined
 * variants look genuinely different.
 */

export interface HeroArtOptions {
  headline?: string;
  subline?: string;
  /** Sky accent hue: "dawn" (amber) | "dusk" (red) | "steel" (blue). */
  mood?: "dawn" | "dusk" | "steel";
}

const MOODS = {
  dawn: { skyTop: "#0b1d33", skyMid: "#7a4a2b", skyLow: "#e8a54b", sun: "#ffd98a", glow: "#f2b45f" },
  dusk: { skyTop: "#160f22", skyMid: "#6e2436", skyLow: "#d2543a", sun: "#ffc07a", glow: "#e07a4d" },
  steel: { skyTop: "#0a1424", skyMid: "#2a4a66", skyLow: "#7fa8c4", sun: "#eef4f8", glow: "#9dc0d8" },
} as const;

export function heroArtSvg(opts: HeroArtOptions = {}): string {
  const headline = escapeXml(opts.headline ?? "No downtime, no compromise.");
  const subline = escapeXml(opts.subline ?? "The new cordless platform. One battery. Every job.");
  const m = MOODS[opts.mood ?? "dawn"];

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 750" role="img" aria-label="${headline}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${m.skyTop}"/><stop offset=".55" stop-color="${m.skyMid}"/><stop offset="1" stop-color="${m.skyLow}"/>
    </linearGradient>
    <radialGradient id="sunGlow" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="${m.glow}" stop-opacity=".85"/><stop offset="1" stop-color="${m.glow}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="1200" height="750" fill="url(#sky)"/>
  <circle cx="880" cy="470" r="300" fill="url(#sunGlow)"/>
  <circle cx="880" cy="470" r="86" fill="${m.sun}"/>

  <!-- distant skyline + tower cranes -->
  <g fill="#0d1626" opacity=".88">
    <rect x="0" y="470" width="150" height="120"/><rect x="140" y="430" width="90" height="160"/>
    <rect x="250" y="500" width="130" height="90"/><rect x="1010" y="450" width="80" height="140"/>
    <rect x="1100" y="490" width="100" height="100"/>
    <!-- crane 1 -->
    <rect x="420" y="255" width="10" height="335"/><rect x="330" y="250" width="330" height="9"/>
    <rect x="322" y="242" width="26" height="26"/><path d="M425 259 L520 300 L425 300 Z" opacity=".9"/>
    <rect x="646" y="259" width="3" height="60"/><rect x="636" y="318" width="22" height="16"/>
    <!-- crane 2 -->
    <rect x="905" y="330" width="8" height="260"/><rect x="845" y="326" width="220" height="7"/>
    <rect x="1052" y="333" width="2" height="42"/><rect x="1044" y="374" width="18" height="13"/>
  </g>

  <!-- scaffolding + crew silhouettes -->
  <g fill="#0a111e">
    <rect x="0" y="588" width="1200" height="162"/>
    <rect x="60" y="500" width="14" height="98"/><rect x="180" y="500" width="14" height="98"/>
    <rect x="48" y="498" width="160" height="10"/><rect x="48" y="546" width="160" height="8"/>
    <!-- worker: carrying tool case -->
    <g transform="translate(300,506)">
      <circle cx="22" cy="12" r="11"/><path d="M10 24 h24 l6 34 -8 40 h-9 l5 -38 h-12 l-7 38 h-9 l4 -42 Z"/>
      <rect x="34" y="40" width="26" height="18" rx="2"/><path d="M4 30 l-14 26 6 4 14 -22 Z"/>
    </g>
    <!-- worker: drill raised -->
    <g transform="translate(700,498)">
      <circle cx="20" cy="14" r="11"/><path d="M8 26 h24 l5 36 -6 40 h-9 l3 -36 h-11 l-6 36 h-9 l4 -44 Z"/>
      <path d="M32 30 l30 -14 4 8 -28 14 Z"/><rect x="60" y="8" width="20" height="12" rx="2"/>
    </g>
  </g>

  <!-- headline block -->
  <rect x="64" y="96" width="10" height="118" fill="#d2051e"/>
  <text x="96" y="150" font-family="Segoe UI, Arial, sans-serif" font-size="58" font-weight="700" fill="#ffffff">${headline}</text>
  <text x="96" y="198" font-family="Segoe UI, Arial, sans-serif" font-size="26" font-weight="400" fill="#f3e9d8">${subline}</text>
</svg>`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}
