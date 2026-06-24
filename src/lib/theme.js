// Colour themes + per-user custom-colour overrides.
//
// A theme is just a palette; applyTheme() writes it onto CSS custom properties on
// :root, so BOTH the sidebar and the options page restyle live. Users can pick a
// theme AND override individual colours on top of it (stored in settings.themeColors).

export const THEMES = {
  hive:   { label: "Hivey (yellow/orange)", bg: "#131519", panel: "#1b1e24", panel2: "#23272e", border: "#333843", borderSoft: "#23262d", text: "#ececf1", muted: "#9aa0ad", accent: "#f59e0b", accent2: "#fbbf24", accent3: "#f97316" },
  violet: { label: "Violet (blue/purple)",  bg: "#0f1117", panel: "#161922", panel2: "#1c2030", border: "#272c3b", borderSoft: "#1f2330", text: "#e7e8ef", muted: "#9aa0b4", accent: "#8b5cf6", accent2: "#6366f1", accent3: "#a855f7" },
  dark:   { label: "Default (dark)", bg: "#0f1117", panel: "#161922", panel2: "#1c2030", border: "#272c3b", borderSoft: "#1f2330", text: "#e7e8ef", muted: "#9aa0b4", accent: "#8b5cf6", accent2: "#6366f1", accent3: "#a855f7" },
  pro:    { label: "Pro (blue)",     bg: "#0d1117", panel: "#161b22", panel2: "#1c232c", border: "#2a313c", borderSoft: "#21272f", text: "#e6edf3", muted: "#8b949e", accent: "#2f81f7", accent2: "#1f6feb", accent3: "#58a6ff" },
  gamer:  { label: "Gamer (neon)",   bg: "#08080f", panel: "#11111d", panel2: "#191929", border: "#2b2b48", borderSoft: "#20203a", text: "#e9e9ff", muted: "#9a9ac4", accent: "#00e5ff", accent2: "#7c4dff", accent3: "#ff2bd6" },
  modern: { label: "Modern (teal)",  bg: "#0f1417", panel: "#161c21", panel2: "#1e262c", border: "#2a333b", borderSoft: "#222a31", text: "#e8eef2", muted: "#90a0ad", accent: "#10b981", accent2: "#06b6d4", accent3: "#34d399" },
  sunset: { label: "Sunset",         bg: "#15100f", panel: "#1f1715", panel2: "#2a1f1c", border: "#3c2c28", borderSoft: "#2f2320", text: "#f4ebe7", muted: "#c0a69d", accent: "#fb7185", accent2: "#f97316", accent3: "#fbbf24" },
  light:  { label: "Light",          bg: "#f6f7fb", panel: "#ffffff", panel2: "#eceef5", border: "#d7dbe6", borderSoft: "#e6e8f0", text: "#1b1e28", muted: "#5c6478", accent: "#7c3aed", accent2: "#4f46e5", accent3: "#9333ea" },
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
  set("--accent-3", c.accent3);
  set("--grad", `linear-gradient(135deg, ${c.accent2} 0%, ${c.accent} 55%, ${c.accent3} 100%)`);
  set("--grad-soft", `linear-gradient(135deg, ${hexToRgba(c.accent2, 0.16)}, ${hexToRgba(c.accent3, 0.16)})`);
  set("--user", `linear-gradient(135deg, ${c.accent2}, ${c.accent})`);
  if (document.body) document.body.classList.toggle("theme-light", themeKey === "light" && !(custom && custom.bg));
}
