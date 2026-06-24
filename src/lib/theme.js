// Colour themes + per-user custom-colour overrides.
//
// A theme is just a palette; applyTheme() writes it onto CSS custom properties on
// :root, so BOTH the sidebar and the options page restyle live. Users can pick a
// theme AND override individual colours on top of it (stored in settings.themeColors).

// Each theme defines a 5-colour palette (background, surface, accent, accent2, text);
// the rest (panel2 / borders / muted) is tuned per theme. `split` controls the brand
// gradient: `accent` is the base majority and `accent2` only the end touch, where
// `split` is the % of the gradient held solid by accent before it transitions
// (0 → a balanced accent↔accent2; 0.4 → ~70% accent / 30% accent2).
export const THEMES = {
  dark:   { label: "Default (dark)",   bg: "#0b0f19", panel: "#161f30", panel2: "#213049", border: "#2a3a54", borderSoft: "#1d2840", text: "#f8fafc", muted: "#94a3b8", accent: "#2563eb", accent2: "#7c3aed", split: 0.4 },
  hive:   { label: "Hivey (Brand)",    bg: "#0f1115", panel: "#1a1d24", panel2: "#242832", border: "#2c313c", borderSoft: "#20242d", text: "#f9fafb", muted: "#9ca3af", accent: "#d97706", accent2: "#f59e0b", split: 0.4 },
  modern: { label: "Modern (Teal)",    bg: "#090d16", panel: "#121b2c", panel2: "#1b2840", border: "#243349", borderSoft: "#182338", text: "#f4f4f5", muted: "#8b9bb0", accent: "#0d9488", accent2: "#14b8a6", split: 0.4 },
  neon:   { label: "Neon / Cyberpunk", bg: "#05050a", panel: "#0f0f1a", panel2: "#18182a", border: "#232342", borderSoft: "#1a1a30", text: "#ffffff", muted: "#9a9ac4", accent: "#06b6d4", accent2: "#d946ef", split: 0.0 },
  sunset: { label: "Midnight Sunset",  bg: "#110e18", panel: "#1d1827", panel2: "#2a2236", border: "#382c44", borderSoft: "#261e30", text: "#fafafa", muted: "#b5a6b8", accent: "#e11d48", accent2: "#ea580c", split: 0.2 },
  light:  { label: "Light (Premium)",  bg: "#f8fafc", panel: "#ffffff", panel2: "#eef1f6", border: "#d7dee8", borderSoft: "#e6eaf1", text: "#0f172a", muted: "#5c6b82", accent: "#3b82f6", accent2: "#6366f1", split: 0.4 },
};

// The colour keys a user can override (shown as pickers in Settings).
export const CUSTOM_KEYS = ["accent", "accent2", "bg", "panel", "text"];

function hexToRgba(hex, a) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec((hex || "").trim());
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

// Effective palette = theme defaults with the user's overrides applied on top.
export function effectivePalette(themeKey, custom) {
  const base = THEMES[themeKey] || THEMES.dark;
  return { ...base, ...(custom || {}) };
}

export function applyTheme(themeKey, custom) {
  const c = effectivePalette(themeKey, custom);
  const r = document.documentElement.style;
  const set = (k, v) => r.setProperty(k, v);
  set("--bg", c.bg);
  set("--panel", c.panel);
  set("--panel-2", c.panel2);
  set("--border", c.border);
  set("--border-soft", c.borderSoft);
  set("--text", c.text);
  set("--muted", c.muted);
  set("--accent", c.accent);
  set("--accent-2", c.accent2);
  set("--accent-3", c.accent2); // compat: legacy 3-stop gradients use accent-3 as the end touch
  // Brand gradient: accent is the base majority, accent2 only the end touch.
  const split = Math.round(((typeof c.split === "number") ? c.split : 0.4) * 100);
  set("--grad", `linear-gradient(135deg, ${c.accent} 0%, ${c.accent} ${split}%, ${c.accent2} 100%)`);
  set("--grad-soft", `linear-gradient(135deg, ${hexToRgba(c.accent, 0.16)}, ${hexToRgba(c.accent2, 0.16)})`);
  set("--user", `linear-gradient(135deg, ${c.accent}, ${c.accent2})`);
  if (document.body) document.body.classList.toggle("theme-light", themeKey === "light" && !(custom && custom.bg));
}
