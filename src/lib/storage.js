// Stockage local des réglages (BYOK). Rien ne quitte le navigateur sauf vers
// l'API choisie par l'utilisateur. On utilise browser.storage.local : les clés
// ne sont JAMAIS synchronisées ni envoyées ailleurs.
//
// Le projet est livré 100% vierge : toutes les clés sont vides par défaut, c'est
// à l'utilisateur de renseigner les siennes (ou de pointer un modèle local).

const DEFAULTS = {
  provider: "anthropic", // id dans models.js (PROVIDERS)
  keys: {}, // { anthropic:"", openai:"", openrouter:"", ... }
  models: {}, // modèle choisi par fournisseur { anthropic:"claude-opus-4-8", ... }
  baseUrls: {}, // surcharges d'URL (ollama, lmstudio, custom)

  // Génération d'images
  imageProvider: "openai",
  imageModel: "gpt-image-1",

  // Comportement
  thinking: false, // afficher le raisonnement (modèles compatibles)
  webSearch: false, // recherche web (Anthropic)
  agentMode: false, // le modèle peut agir dans le navigateur
  confirmActions: true, // confirmer chaque action d'écriture
  includePageContext: true, // injecter la page active dans le chat
  autoReadPage: true, // relire la page à chaque navigation (y c. sous-domaine)
  maxPageChars: 12000, // troncature du contexte de page
  targetLang: "Français", // langue cible des traductions
};

// Migration depuis l'ancien schéma (anthropicKey / openrouterKey / *Model).
function migrate(s) {
  s.keys = s.keys || {};
  s.models = s.models || {};
  s.baseUrls = s.baseUrls || {};
  if (s.anthropicKey && !s.keys.anthropic) s.keys.anthropic = s.anthropicKey;
  if (s.openrouterKey && !s.keys.openrouter) s.keys.openrouter = s.openrouterKey;
  if (s.anthropicModel && !s.models.anthropic) s.models.anthropic = s.anthropicModel;
  if (s.openrouterModel && !s.models.openrouter) s.models.openrouter = s.openrouterModel;
  delete s.anthropicKey;
  delete s.openrouterKey;
  delete s.anthropicModel;
  delete s.openrouterModel;
  return s;
}

export async function getSettings() {
  const stored = await browser.storage.local.get(null);
  return migrate({ ...DEFAULTS, ...stored });
}

export async function setSettings(patch) {
  await browser.storage.local.set(patch);
}

// Met à jour une entrée dans un objet imbriqué (keys/models/baseUrls) sans
// écraser les autres entrées.
export async function setNested(field, key, value) {
  const cur = (await browser.storage.local.get(field))[field] || {};
  cur[key] = value;
  await browser.storage.local.set({ [field]: cur });
}

export function onSettingsChanged(callback) {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local") callback(changes);
  });
}

export { DEFAULTS };
