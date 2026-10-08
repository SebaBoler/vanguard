// Per-project identity color. Ported from model-box `stringToHslColor` (standalone — Vanguard has no
// cross-repo deps), but emits hex so it round-trips through a `<input type="color">` and the config's
// hex `color` field. Saturation/lightness tuned for a visible accent on both light and dark themes.

/** Deterministic hue from a string (same seed → same hue), à la stringToHslColor. */
function seedHue(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = text.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash % 360);
}

/** HSL (h 0-360, s/l 0-100) → `#rrggbb`. Standard conversion. */
export function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): string => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Auto identity color for a seed string (a project path), as `#rrggbb`. */
export function autoColor(seed: string): string {
  return hslToHex(seedHue(seed), 70, 52);
}

export function isValidHexColor(hex: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(hex);
}

/** Black or white, whichever reads better on `hex`. Ported from model-box `contrastingColor`
 * (perceived-luminance threshold at 128). */
export function contrastColor(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 >= 128 ? '#000000' : '#ffffff';
}

/** A project's effective color: the configured override, else the auto color from its path. */
export function projectColor(p: { path: string; color?: string }): string {
  return p.color && isValidHexColor(p.color) ? p.color : autoColor(p.path);
}
