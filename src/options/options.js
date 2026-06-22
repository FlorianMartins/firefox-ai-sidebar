import { getSettings, setSettings } from "../lib/storage.js";
import { PROVIDERS, PROVIDER_ORDER, IMAGE_SIZES, WRITING_PRESETS, isConnected } from "../lib/models.js";
import { connectOpenRouter } from "../lib/auth.js";
import { listModels } from "../lib/providers.js";
import { clearConversations } from "../lib/history.js";

const $ = (id) => document.getElementById(id);

// Providers with a free tier (free API key / free models).
const FREE_TIER = new Set(["google", "groq", "openrouter", "mistral", "cerebras"]);
// Providers with a real in-app account OAuth (the rest log in on the provider's
// own site to copy an API key).
const OAUTH = new Set(["openrouter"]);

// Direct sign-in (authentication) page for each provider, so "Se connecter"
// opens the account login — not the raw API-keys page.
const LOGIN_URL = {
  anthropic: "https://console.anthropic.com/login",
  openai: "https://auth.openai.com/log-in",
  google: "https://aistudio.google.com/",
  mistral: "https://console.mistral.ai/",
  groq: "https://console.groq.com/login",
  deepseek: "https://platform.deepseek.com/sign_in",
  xai: "https://accounts.x.ai/sign-in",
  perplexity: "https://www.perplexity.ai/settings/api",
  together: "https://api.together.ai/signin",
  fireworks: "https://fireworks.ai/login",
  deepinfra: "https://deepinfra.com/login",
  cerebras: "https://cloud.cerebras.ai/",
  cohere: "https://dashboard.cohere.com/welcome/login",
};

let settings;
let modelLists = {};

function category(id) {
  const meta = PROVIDERS[id];
  if (meta.local) return "local";
  if (meta.custom) return "custom";
  return "cloud";
}

function modelOptionsFor(id) {
  const fetched = modelLists[id] || [];
  const labels = new Map(PROVIDERS[id].models);
  const ids = fetched.length ? fetched : PROVIDERS[id].models.map((m) => m[0]);
  const seen = new Set();
  const out = [["", "(défaut automatique)"]];
  for (const m of ids) {
    if (seen.has(m)) continue;
    seen.add(m);
    out.push([m, labels.get(m) || m]);
  }
  return out;
}

function fillModelSelect(sel, id) {
  const chosen = (settings.models && settings.models[id]) || "";
  sel.innerHTML = "";
  for (const [val, label] of modelOptionsFor(id)) {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = chosen;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function buildCard(id) {
  const meta = PROVIDERS[id];
  const sec = el("section", "provider-card");

  const head = el("div", "provider-head");
  head.appendChild(el("h3", null, meta.label + (meta.local ? "  (local)" : "")));
  const connected = isConnected(id, settings);
  head.appendChild(el("span", "badge " + (connected ? "ok" : "off"), connected ? "✅ Connecté" : "○ Non connecté"));
  if (FREE_TIER.has(id)) head.appendChild(el("span", "badge free", "gratuit dispo"));
  sec.appendChild(head);

  // Connect affordance on EVERY cloud provider.
  if (category(id) === "cloud") {
    const btn = el("button", "grad small connect", OAUTH.has(id) ? "🔐 Se connecter avec mon compte" : "🔐 Se connecter à mon compte " + meta.label);
    btn.addEventListener("click", () => connectAccount(id));
    sec.appendChild(btn);
    sec.appendChild(el("p", "muted hint", OAUTH.has(id)
      ? "Compte (Google / GitHub / email) → débloque tous les modèles, y compris gratuits."
      : "Ouvre la page de connexion du fournisseur : identifiez-vous avec VOTRE compte, créez une clé API, puis collez-la ci-dessous. (Un abonnement type ChatGPT Plus / Claude Pro ne donne pas accès à l'API — il faut une clé.)"));
  }

  // Local server: explicit opt-in.
  if (meta.local) {
    const lab = el("label", "switch");
    const inp = el("input");
    inp.type = "checkbox";
    inp.id = `local_${id}`;
    inp.checked = !!(settings.localEnabled && settings.localEnabled[id]);
    lab.appendChild(inp);
    lab.appendChild(el("span", "track"));
    lab.appendChild(el("span", "lbl", "Activer ce serveur local (lancé sur ma machine)"));
    sec.appendChild(lab);
  }

  // API key.
  if (meta.needsKey || id === "custom") {
    const lab = el("label", null, meta.needsKey ? "Clé API" : "Clé API (optionnelle)");
    const inp = el("input");
    inp.type = "password";
    inp.id = `key_${id}`;
    inp.placeholder = meta.keyHint || "clé…";
    inp.value = (settings.keys && settings.keys[id]) || "";
    lab.appendChild(inp);
    sec.appendChild(lab);
    if (meta.keysUrl) {
      const p = el("p", "muted");
      const tag = FREE_TIER.has(id) ? "Obtenir une clé (offre gratuite) : " : "Console du fournisseur : ";
      p.innerHTML = `${tag}<a href="${meta.keysUrl}" target="_blank" rel="noreferrer">${meta.keysUrl.replace(/^https?:\/\//, "")}</a>`;
      sec.appendChild(p);
    }
  }

  // Base URL (local / custom).
  if (meta.local || meta.custom) {
    const lab = el("label", null, "URL de base");
    const inp = el("input");
    inp.type = "text";
    inp.id = `url_${id}`;
    inp.placeholder = meta.baseUrl || "https://votre-serveur/v1";
    inp.value = (settings.baseUrls && settings.baseUrls[id]) || "";
    lab.appendChild(inp);
    sec.appendChild(lab);
  }

  // Default model — dropdown of currently available models.
  const lab = el("label", null, "Modèle par défaut");
  const sel = el("select");
  sel.id = `model_${id}`;
  lab.appendChild(sel);
  sec.appendChild(lab);
  fillModelSelect(sel, id);

  return sec;
}

const GROUP_TITLES = { cloud: "Fournisseurs (compte / clé API)", local: "Modèles locaux", custom: "Serveur personnalisé" };

function buildProviderFields() {
  const root = $("providers");
  root.innerHTML = "";
  let lastCat = null;
  for (const id of PROVIDER_ORDER) {
    const cat = category(id);
    if (cat !== lastCat) {
      root.appendChild(el("h2", "group-title", GROUP_TITLES[cat]));
      lastCat = cat;
    }
    root.appendChild(buildCard(id));
  }
}

function fillSelect(sel, items, value) {
  sel.innerHTML = "";
  for (const [val, label] of items) {
    const o = el("option", null, label);
    o.value = val;
    sel.appendChild(o);
  }
  if (value != null) sel.value = value;
}

function buildImageProvider() {
  const imgProviders = PROVIDER_ORDER.filter((id) => PROVIDERS[id].supportsImages).map((id) => [id, PROVIDERS[id].label]);
  fillSelect($("imageProvider"), imgProviders, settings.imageProvider || "openai");
  fillSelect($("imageSize"), IMAGE_SIZES.map((s) => [s, s]), settings.imageSize || "1024x1024");
}

// Fetch live model lists for connected providers, then refresh the dropdowns.
async function refreshModelLists() {
  const ids = PROVIDER_ORDER.filter((id) => isConnected(id, settings));
  await Promise.allSettled(
    ids.map(async (id) => {
      try {
        const list = await listModels(id, settings);
        if (list && list.length) modelLists[id] = list;
      } catch (_) {}
    })
  );
  for (const id of ids) {
    const sel = $(`model_${id}`);
    if (sel) fillModelSelect(sel, id);
  }
  await setSettings({ modelLists: { ...(settings.modelLists || {}), ...modelLists } });
}

async function load() {
  settings = await getSettings();
  modelLists = { ...(settings.modelLists || {}) };
  buildProviderFields();
  buildImageProvider();
  fillSelect($("improvePreset"), WRITING_PRESETS.map((p) => [p[0], p[1]]), settings.improvePreset || "improve");
  $("imageModel").value = settings.imageModel || "";
  $("targetLang").value = settings.targetLang || "Français";
  $("thinking").checked = settings.thinking;
  $("webSearch").checked = settings.webSearch;
  $("agentMode").checked = settings.agentMode;
  $("confirmActions").checked = settings.confirmActions;
  $("blockPayments").checked = settings.blockPayments;
  $("webmailAssist").checked = settings.webmailAssist;
  $("saveHistory").checked = settings.saveHistory;
  $("includePageContext").checked = settings.includePageContext;
  $("autoReadPage").checked = settings.autoReadPage;
  $("maxPageChars").value = settings.maxPageChars;
  refreshModelLists();
}

async function save() {
  const keys = {};
  const baseUrls = {};
  const models = {};
  const localEnabled = {};
  for (const id of PROVIDER_ORDER) {
    const k = $(`key_${id}`);
    if (k && k.value.trim()) keys[id] = k.value.trim();
    const u = $(`url_${id}`);
    if (u && u.value.trim()) baseUrls[id] = u.value.trim();
    const m = $(`model_${id}`);
    if (m && m.value) models[id] = m.value;
    const lc = $(`local_${id}`);
    if (lc && lc.checked) localEnabled[id] = true;
  }
  await setSettings({
    keys, baseUrls, models, localEnabled,
    imageProvider: $("imageProvider").value,
    imageModel: $("imageModel").value.trim() || "gpt-image-1",
    imageSize: $("imageSize").value,
    improvePreset: $("improvePreset").value,
    targetLang: $("targetLang").value.trim() || "Français",
    thinking: $("thinking").checked,
    webSearch: $("webSearch").checked,
    agentMode: $("agentMode").checked,
    confirmActions: $("confirmActions").checked,
    blockPayments: $("blockPayments").checked,
    webmailAssist: $("webmailAssist").checked,
    saveHistory: $("saveHistory").checked,
    includePageContext: $("includePageContext").checked,
    autoReadPage: $("autoReadPage").checked,
    maxPageChars: parseInt($("maxPageChars").value, 10) || 12000,
  });
  settings = await getSettings();
  modelLists = { ...(settings.modelLists || {}) };
  buildProviderFields();
  refreshModelLists();
  flash($("status"), "✓ Enregistré.");
}

function flash(node, text) {
  node.textContent = text;
  setTimeout(() => (node.textContent = ""), 2500);
}

// "Connect": OpenRouter via in-app OAuth; other providers open their own console
// (the user logs in with their account there, creates a key, and pastes it).
async function connectAccount(id) {
  const status = $("status");
  if (OAUTH.has(id)) {
    status.textContent = "Connexion…";
    try {
      const key = await connectOpenRouter();
      const cur = await getSettings();
      cur.keys = cur.keys || {};
      cur.keys[id] = key;
      await setSettings({ keys: cur.keys, provider: id });
      await load();
      flash(status, "✓ Connecté à " + PROVIDERS[id].label + ".");
    } catch (e) {
      flash(status, "Échec : " + (e && e.message ? e.message : e));
    }
    return;
  }
  // Non-OAuth: open the provider's LOGIN page directly (the user signs in with
  // their account), then focus the key field for the key they create there.
  const meta = PROVIDERS[id];
  const url = LOGIN_URL[id] || meta.keysUrl;
  if (url) window.open(url, "_blank", "noopener");
  const f = $(`key_${id}`);
  if (f) { f.focus(); f.scrollIntoView({ block: "center" }); }
  flash(status, "Identifiez-vous chez " + meta.label + ", créez une clé API, puis collez-la.");
}

$("save").addEventListener("click", save);
$("clearHistoryBtn").addEventListener("click", async () => {
  await clearConversations();
  flash($("status"), "✓ Historique effacé.");
});
load();
