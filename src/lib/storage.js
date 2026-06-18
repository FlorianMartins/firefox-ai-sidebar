// Stockage local des réglages (BYOK). Rien ne quitte le navigateur sauf vers
// les API choisies par l'utilisateur (Anthropic / OpenRouter).
// On utilise browser.storage.local : les clés ne sont PAS synchronisées.

const DEFAULTS = {
  provider: "anthropic",            // "anthropic" | "openrouter"
  anthropicKey: "",
  openrouterKey: "",
  anthropicModel: "claude-opus-4-8",
  openrouterModel: "anthropic/claude-3.7-sonnet",
  agentMode: false,                 // mode agent (actions navigateur) activé ?
  confirmActions: true,             // demander confirmation avant chaque action d'écriture
  includePageContext: true,         // injecter automatiquement le contenu de la page active
  maxPageChars: 12000,              // troncature du contexte de page
};

export async function getSettings() {
  const stored = await browser.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

export async function setSettings(patch) {
  await browser.storage.local.set(patch);
}

export function onSettingsChanged(callback) {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local") callback(changes);
  });
}

export { DEFAULTS };
