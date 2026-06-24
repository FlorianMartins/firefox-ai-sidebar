// Sidebar UI controller.
//
// Workspaces ("modes"): chat / translate / improve / image. A single unified model
// picker sits just above the composer and lists ONLY the models of connected
// providers (a key set, an OAuth account, or a running local server) — fetched
// live from each provider's /models endpoint so it reflects what is actually
// available. Comparison is done per-message (a "Comparer" button on the latest
// answer). Conversations are kept locally for privacy.

import { getSettings, setSettings, onSettingsChanged } from "../lib/storage.js";
import { makeProvider, listModels, listOpenRouterRich, generateImage } from "../lib/providers.js";
import { buildSystemPrompt, activeTools, runConversation } from "../lib/agent.js";
import { executeTool } from "../lib/tools.js";
import { configureMarkdown, renderMarkdown, enhanceArtifacts } from "../lib/markdown.js";
import { PROVIDERS, PROVIDER_ORDER, modelFor, keyFor, connectedProviders, defaultSearchModel, IMAGE_SIZES, WRITING_PRESETS } from "../lib/models.js";
import { connectOpenRouter } from "../lib/auth.js";
import { applyTheme } from "../lib/theme.js";
import { t, setLang, applyDom } from "../lib/i18n.js";
import {
  listConversations, getConversation, saveConversation, deleteConversation,
  newConversationId, titleFrom,
} from "../lib/history.js";

const $ = (id) => document.getElementById(id);
// Are we running as a standalone full-screen TAB (vs the docked sidebar)? The
// "open in a tab" button appends ?tab=1; we hide that button when already in a tab.
const IS_TAB = new URLSearchParams(location.search).get("tab") === "1";
const els = {
  modelInput: $("modelInput"),
  modelMenu: $("modelMenu"),
  modelWrap: $("modelWrap"),
  modelConnect: $("modelConnect"),
  expandTab: $("expandTab"),
  brand: $("brandToggle"),
  attachBtn: $("attachBtn"),
  composerMain: $("composerMain"),
  toolsLeft: $("toolsLeft"),
  attachInput: $("attachInput"),
  attachStrip: $("attachStrip"),
  dropOverlay: $("dropOverlay"),
  searchBtn: $("searchBtn"),
  searchBar: $("searchBar"),
  searchInput: $("searchInput"),
  searchCount: $("searchCount"),
  searchPrev: $("searchPrev"),
  searchNext: $("searchNext"),
  searchClose: $("searchClose"),
  modelFilterBtn: $("modelFilterBtn"),
  modelFilterPanel: $("modelFilterPanel"),
  filterProviders: $("filterProviders"),
  filterReset: $("filterReset"),
  filterClose: $("filterClose"),
  freeConnect: $("freeConnect"),
  emptyOptions: $("emptyOptions"),
  historyBtn: $("historyBtn"),
  newChat: $("newChat"),
  openOptions: $("openOptions"),
  historyPanel: $("historyPanel"),
  historyList: $("historyList"),
  clearHistory: $("clearHistory"),
  deleteSelected: $("deleteSelected"),
  closeHistory: $("closeHistory"),
  pageBar: $("pageBar"),
  pageTitle: $("pageTitle"),
  pickEl: $("pickEl"),
  captureRegion: $("captureRegion"),
  tabsBtn: $("tabsBtn"),
  tabsPanel: $("tabsPanel"),
  tabsList: $("tabsList"),
  tabsRefresh: $("tabsRefresh"),
  messages: $("messages"),
  empty: $("empty"),
  emptyOnboard: $("emptyOnboard"),
  emptyGreeting: $("emptyGreeting"),
  input: $("input"),
  stop: $("stop"),
  rail: $("rail"),
  codeView: $("codeView"),
  openCodeApp: $("openCodeApp"),
  codeAppUrlLabel: $("codeAppUrlLabel"),
  controls: $("controls"),
  chatControls: $("chatControls"),
  translateControls: $("translateControls"),
  improveControls: $("improveControls"),
  imageControls: $("imageControls"),
  pdfControls: $("pdfControls"),
  pdfLoad: $("pdfLoad"),
  pdfFile: $("pdfFile"),
  pdfInfo: $("pdfInfo"),
  pdfSummarize: $("pdfSummarize"),
  pdfImages: $("pdfImages"),
  pdfText: $("pdfText"),
  thinking: $("thinking"),
  webSearch: $("webSearch"),
  pageCtx: $("pageCtx"),
  translateLang: $("translateLang"),
  improvePreset: $("improvePreset"),
  imageSize: $("imageSize"),
  confirmBar: $("confirmBar"),
  confirmText: $("confirmText"),
  confirmAllow: $("confirmAllow"),
  confirmDeny: $("confirmDeny"),
};

let settings;
let history = [];        // provider-native message array (multi-turn continuation)
let transcript = [];     // UI transcript for local history
let convId = newConversationId();
let abortController = null;
let currentPage = null;
let busy = false;
let mode = "chat";
// OpenRouter models discovered to be inaccessible on this account (e.g. data-policy
// gated, no free endpoint). Session-only: removed from the picker as we hit them, and
// reset on reload — so after fixing the account they all come back.
const orUnavailable = new Set();

// PDF workspace state: the loaded document + its extracted text (used as context).
let pdfDoc = null;
let pdf = { name: "", text: "", pages: 0 };
let pdfWorkerSet = false;
const PDF_BUDGET = 24000; // chars of PDF text passed to the model as supporting context
// Last primary turn (to re-run on another model for the "compare" button).
let lastUserContent = "";
let lastRunMode = "chat";
let lastForceWeb = false;


// Composer attachments (files/images the AI gets as context). Transient — bound to
// the next message, cleared after a send or when switching workspace. Each entry:
//   image: { type:"image", name, dataUrl, mediaType }
//   text : { type:"text",  name, text, isPdf?, pages? }
let attachments = [];
const ATT_IMG_MAX_MB = 10;   // an image bigger than this is rejected (base64 bloat / API limits)
const ATT_TXT_MAX_MB = 25;   // a text/PDF file bigger than this is rejected
const ATT_TXT_BUDGET = 16000; // chars of EACH attached text file folded into the prompt

// Searchable model combobox (main picker). `mainValue` holds the selected
// "providerId|modelId"; `mainCombo` renders the floating, type-to-filter list.
// The price/provider filter persists in settings.
let mainValue = "";
let mainCombo = null;
let filterPersistTimer = null;

// Per-workspace isolation: Chat, Agent, Translate, Improve and Image each keep
// their OWN live conversation AND their own saved-conversation history (the two
// are distinct). Terminal and Code have dedicated panes and are not chat-area
// modes. We swap the live globals (history/transcript/convId/…) in and out of a
// per-mode session whenever the workspace changes.
const CHAT_MODES = ["chat", "agent", "translate", "improve", "image", "pdf"];
const sessions = {}; // mode -> { history, transcript, convId, lastUserContent, lastRunMode, lastForceWeb }
function blankSession(m) {
  return { history: [], transcript: [], convId: newConversationId(), lastUserContent: "", lastRunMode: m, lastForceWeb: false, nodes: null, pageCtxKeys: new Set(), customTitle: "", importedSources: [] };
}
// Visual persistence per tab: instead of re-deriving the DOM from `transcript`
// (which can drop streamed/enhanced content and the compare bars), we DETACH the
// actual message nodes when leaving a tab and RE-ATTACH them on return — nodes keep
// their event listeners, compare bars and live artifact iframes intact.
function stashMode(m) {
  if (!CHAT_MODES.includes(m)) return;
  const s = getSession(m);
  s.nodes = Array.from(els.messages.children).filter((n) => n.id !== "empty");
  s.nodes.forEach((n) => n.remove());
}
function restoreMode(m) {
  clearMessages();
  const s = getSession(m);
  if (s.nodes && s.nodes.length) {
    els.empty.classList.add("hidden");
    s.nodes.forEach((n) => els.messages.appendChild(n));
  } else {
    els.empty.classList.remove("hidden");
  }
  updateEmptyState();
}
function getSession(m) { return sessions[m] || (sessions[m] = blankSession(m)); }
// Copy the live globals into a mode's session (before leaving it, or after we
// reassign any global to a brand-new array — in-place .push keeps refs in sync).
function syncSessionFromGlobals(m) {
  if (!CHAT_MODES.includes(m)) return;
  const s = getSession(m);
  s.history = history; s.transcript = transcript; s.convId = convId;
  s.lastUserContent = lastUserContent; s.lastRunMode = lastRunMode; s.lastForceWeb = lastForceWeb;
}
// Load a mode's session into the live globals.
function loadSessionToGlobals(m) {
  const s = getSession(m);
  history = s.history; transcript = s.transcript; convId = s.convId;
  lastUserContent = s.lastUserContent; lastRunMode = s.lastRunMode; lastForceWeb = s.lastForceWeb;
}
// Re-render the chat area from the active session's transcript (used when the
// workspace changes), re-attaching the per-message "compare" bar on the last answer.
// Composer placeholder for a workspace — resolved live so it follows the UI language.
function placeholderFor(m) { return t("ph." + m) || t("ph.chat"); }

// The Agent workspace IS a dedicated tab now (no more "Agent" chip): being in it is
// what turns on tool-use. The page-context chips (Réflexion/Web/Page) stay available.
function agentActive() { return mode === "agent"; }

// Re-render the toolbar / sidebar action icon in the current theme's accent
// colours so the browser button and sidebar header follow the chosen theme.
// (Static manifest icons can't react to a runtime setting, but setIcon() can.)
async function updateActionIcon() {
  try {
    const cs = getComputedStyle(document.documentElement);
    const a1 = (cs.getPropertyValue("--accent") || "#2563eb").trim();   // base majority
    const a2 = (cs.getPropertyValue("--accent-2") || "#7c3aed").trim(); // end touch
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">' +
      '<defs><linearGradient id="g" x1="12" y1="10" x2="84" y2="86" gradientUnits="userSpaceOnUse">' +
      '<stop offset="0" stop-color="' + a1 + '"/><stop offset="0.55" stop-color="' + a1 + '"/><stop offset="1" stop-color="' + a2 + '"/>' +
      '</linearGradient></defs><g fill="url(#g)">' +
      '<rect x="17" y="9" width="62" height="14" rx="7"/>' +
      '<rect x="8" y="30" width="80" height="14" rx="7"/>' +
      '<rect x="12" y="51" width="72" height="14" rx="7"/>' +
      '<rect x="23" y="72" width="50" height="14" rx="7"/></g></svg>';
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/svg+xml;base64," + btoa(svg); });
    const imageData = {};
    for (const s of [16, 32]) {
      const cv = document.createElement("canvas"); cv.width = s; cv.height = s;
      const ctx = cv.getContext("2d"); ctx.clearRect(0, 0, s, s); ctx.drawImage(img, 0, 0, s, s);
      imageData[s] = ctx.getImageData(0, 0, s, s);
    }
    try { if (browser.sidebarAction && browser.sidebarAction.setIcon) await browser.sidebarAction.setIcon({ imageData }); } catch (_) {}
    const actionApi = (browser.action && browser.action.setIcon) ? browser.action
                    : (typeof chrome !== "undefined" && chrome.action && chrome.action.setIcon) ? chrome.action : null;
    try { if (actionApi) await actionApi.setIcon({ imageData }); } catch (_) {}
  } catch (_) {}
}

async function init() {
  configureMarkdown();
  settings = await getSettings();
  applyTheme(settings.theme || "dark", settings.themeColors); // colour theme + custom overrides
  updateActionIcon();                  // tint the toolbar/sidebar icon to match the theme
  setLang(settings.uiLang || "en");   // English by default; other languages chosen in Settings
  applyDom(document);                  // fill all data-i18n static markup
  document.documentElement.lang = settings.uiLang || "en";
  document.body.classList.toggle("rail-right", settings.railSide === "right");
  document.body.classList.toggle("rail-collapsed", !!settings.railHidden);
  populateModelSelector();
  populateImprovePresets();
  els.thinking.checked = settings.thinking;
  els.webSearch.checked = settings.webSearch;
  els.pageCtx.checked = settings.includePageContext;
  els.translateLang.value = settings.targetLang || "French";
  els.improvePreset.value = settings.improvePreset || "improve";
  populateImageSizes();
  els.imageSize.value = settings.imageSize || ""; // "" = "—" (custom / size in prompt)
  syncToggleVisibility();
  updateImageNote();
  wire();
  setMode(settings.mode || "chat");
  setupPageAwareness();
  autoListConnected();           // refresh available models in the background
  // Run a queued context-menu action whenever it appears — even if the sidebar was
  // already open when the user clicked the menu (that's the "right-click does nothing" fix).
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.pendingAction && changes.pendingAction.newValue) consumePendingAction();
  });
  await refreshCurrentPage();
  await consumePendingAction();
}

// ----- Unified model picker -------------------------------------------------
// Only providers the user is actually connected to (key / account / local server).
// Nothing connected => the picker is hidden and a Connect button is shown instead.
function providersToShow() {
  return connectedProviders(settings);
}

// Models for a provider: the live-fetched list when we have one (authoritative —
// only what the key/account can access), otherwise the catalogue defaults.
function modelsOf(providerId) {
  const fetched = (settings.modelLists && settings.modelLists[providerId]) || [];
  const ids = fetched.length ? fetched : PROVIDERS[providerId].models.map((m) => m[0]);
  const labels = new Map(PROVIDERS[providerId].models);
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push([id, labels.get(id) || id]);
  }
  return out;
}

// Fill the model <select> with your connected API providers' models (grouped),
// preceded by a neutral placeholder. (API mode only — sites have no model menu.)
function prettifyVendor(v) {
  return (v || "").split(/[-_]/).map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
}
function prettifyORName(m) {
  // OpenRouter "name" is usually "Vendor: Model Name" -> keep the model part.
  if (m.name && m.name.includes(": ")) return m.name.split(": ").slice(1).join(": ");
  return prettifyVendor(m.id.split("/")[1] || m.id);
}
function orCost(m) {
  if (!m.prompt && !m.completion) return t("cost.free");
  const inM = m.prompt * 1e6; // price per 1M prompt tokens
  return "$" + (inM >= 1 ? inM.toFixed(2) : inM.toFixed(3)) + "/M";
}
// Visual price tier for an OpenRouter model: a coloured dot (green → cheap, red →
// expensive) + a gift for free models, so cost is readable at a glance. Emoji are
// used (not CSS) because they render reliably inside native <option> dropdowns.
function priceTier(m) {
  if (!m.prompt && !m.completion) return { emoji: "🎁", color: "#34d399" }; // free
  const inM = m.prompt * 1e6;
  if (inM <= 1) return { emoji: "🟢", color: "#34d399" };   // pas cher
  if (inM <= 5) return { emoji: "🟡", color: "#fbbf24" };   // abordable
  if (inM <= 15) return { emoji: "🟠", color: "#fb923c" };  // modéré
  return { emoji: "🔴", color: "#f87171" };                  // cher
}
function orOptionLabel(m) {
  const t = priceTier(m);
  return t.emoji + " " + prettifyORName(m) + " — " + orCost(m);
}
// Canonical price-tier NAME (free/green/yellow/orange/red) for the filter — mirrors
// priceTier()'s thresholds. Used as data-tier on each <option>.
function priceTierName(m) {
  if (!m.prompt && !m.completion) return "free";
  const inM = m.prompt * 1e6;
  if (inM <= 1) return "green";
  if (inM <= 5) return "yellow";
  if (inM <= 15) return "orange";
  return "red";
}
// Stamp an <option> with the attributes the filter reads (provider / tier / free).
function tagOption(o, provider, tier) {
  o.dataset.provider = provider;
  if (tier) { o.dataset.tier = tier; o.dataset.free = tier === "free" ? "true" : "false"; }
}

// Display label for a "providerId|modelId" value (used for the "current model"
// row that we pin at the top of the list — see fillModelSelect).
function labelForValue(value) {
  const { providerId, modelId } = parseSel(value);
  if (providerId === "openrouter" && settings.orModels) {
    const m = settings.orModels.find((x) => x.id === modelId);
    if (m) return orOptionLabel(m);
  }
  const map = new Map(modelsOf(providerId));
  return map.get(modelId) || modelId;
}

// OpenRouter hierarchy: one optgroup per vendor (OpenRouter › vendor › model+cost),
// each option prefixed with a price-tier dot (🎁 for free).
function orModelVisible(m) {
  if (orUnavailable.has(m.id)) return false;               // discovered as inaccessible this session
  if (settings.orFreeOnly && (m.prompt || m.completion)) return false; // free-only mode hides paid
  return true;
}
function fillOpenRouterGroups(sel) {
  const byVendor = {};
  for (const m of settings.orModels) {
    if (!orModelVisible(m)) continue;
    const vendor = (m.id.split("/")[0] || "autres");
    (byVendor[vendor] = byVendor[vendor] || []).push(m);
  }
  for (const vendor of Object.keys(byVendor).sort()) {
    const group = document.createElement("optgroup");
    group.label = "OpenRouter · " + prettifyVendor(vendor);
    for (const m of byVendor[vendor].sort((a, b) => prettifyORName(a).localeCompare(prettifyORName(b)))) {
      const o = document.createElement("option");
      o.value = "openrouter|" + m.id;
      o.textContent = orOptionLabel(m);
      o.style.color = priceTier(m).color;
      tagOption(o, "openrouter", priceTierName(m));
      o.dataset.subprovider = vendor;
      group.appendChild(o);
    }
    sel.appendChild(group);
  }
}

function fillModelSelect(sel, selectedValue) {
  sel.innerHTML = "";
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = t("model.choose");
  sel.appendChild(ph);
  // Pin the active model as the FIRST entry so the native dropdown opens at the TOP
  // showing it, instead of scrolling deep into a long list (the "list opens at the
  // end" glitch). A duplicate value lower down is harmless.
  if (selectedValue) {
    const cur = document.createElement("optgroup");
    cur.label = t("model.current");
    const o = document.createElement("option");
    o.value = selectedValue;
    o.textContent = labelForValue(selectedValue);
    cur.appendChild(o);
    sel.appendChild(cur);
  }
  for (const pid of providersToShow()) {
    if (pid === "openrouter" && settings.orModels && settings.orModels.length) {
      fillOpenRouterGroups(sel);
      continue;
    }
    const group = document.createElement("optgroup");
    const noKey = !(keyFor(pid, settings) || PROVIDERS[pid].local);
    group.label = PROVIDERS[pid].label + (noKey ? t("model.keyMissing") : "");
    for (const [mid, mlabel] of modelsOf(pid)) {
      const o = document.createElement("option");
      o.value = pid + "|" + mid;
      o.textContent = mlabel;
      tagOption(o, pid, null); // no per-token pricing for non-OpenRouter providers
      group.appendChild(o);
    }
    sel.appendChild(group);
  }
  sel.value = selectedValue || "";
}

// ----- Image model picker (Image tab only) ----------------------------------
// In the Image workspace the model dropdown lists ONLY image-generation models
// (from providers that support /images/generations and are connected). Choosing
// one sets the image provider + model used by runImage().
function imageModelChoices() {
  const out = [];
  for (const pid of PROVIDER_ORDER) {
    const meta = PROVIDERS[pid];
    if (currentKeyMissing(pid)) continue; // only connected providers
    // OpenRouter: list EVERY model that can output images (Gemini/Nano Banana, etc.),
    // pulled live from the account's model list — far more than a hard-coded handful.
    if (pid === "openrouter" && settings.orModels && settings.orModels.length) {
      const dyn = settings.orModels.filter((m) => m.image && !orUnavailable.has(m.id));
      if (dyn.length) {
        for (const m of dyn) out.push([pid, m.id, prettifyORName(m)]);
        continue;
      }
    }
    if (!meta.supportsImages || !meta.imageModels) continue;
    for (const [mid, mlabel] of meta.imageModels) out.push([pid, mid, mlabel]);
  }
  return out;
}
// Map an image tier emoji to a filter tier name (so price filtering works here too).
function imageTierName(emoji) {
  return emoji === "🎁" ? "free" : emoji === "🟢" ? "green" : emoji === "🟡" ? "yellow"
    : emoji === "🟠" ? "orange" : emoji === "🔴" ? "red" : null;
}
// Combobox items for the Image tab.
function imageComboItems() {
  const out = [];
  for (const [pid, mid, mlabel] of imageModelChoices()) {
    const tier = imagePriceTier(pid, mid);
    out.push({
      value: pid + "|" + mid,
      label: tier.emoji + " " + PROVIDERS[pid].label + " · " + mlabel + " — " + tier.note,
      provider: pid, subprovider: null, tier: imageTierName(tier.emoji), color: tier.color,
      group: PROVIDERS[pid].label,
    });
  }
  return out;
}
function populateImageModelSelector() {
  const list = imageModelChoices();
  const anyConnected = connectedProviders(settings).length > 0;
  els.modelWrap.classList.toggle("hidden", !anyConnected || !list.length);
  els.modelConnect.classList.toggle("hidden", anyConnected && list.length > 0);
  els.modelFilterBtn.classList.toggle("hidden", !anyConnected || !list.length);
  const cur = (settings.imageProvider || "openai") + "|" + (settings.imageModel || "");
  const exists = list.some(([pid, mid]) => pid + "|" + mid === cur);
  if (exists) {
    mainValue = cur;
  } else if (list.length) {
    // Stored image model not among CONNECTED ones (e.g. default OpenAI but only
    // OpenRouter connected) → fall back to the first available and persist it.
    mainValue = list[0][0] + "|" + list[0][1];
    const fb = parseSel(mainValue);
    settings.imageProvider = fb.providerId;
    settings.imageModel = fb.modelId;
    setSettings({ imageProvider: fb.providerId, imageModel: fb.modelId });
    updateImageNote();
  } else {
    mainValue = "";
  }
  if (mainCombo) mainCombo.refresh();
  els.modelFilterBtn.classList.toggle("active", filterIsActive());
  updateEmptyState();
}

// Approximate cost tier per image model (these endpoints don't expose token pricing
// the way chat models do, so we annotate from each model's published per-image price).
function imagePriceTier(pid, mid) {
  // OpenRouter image models: use the model's REAL pricing → 🎁 free / coloured tiers,
  // exactly like the chat lists in the other tabs.
  if (pid === "openrouter" && settings.orModels) {
    const om = settings.orModels.find((x) => x.id === mid);
    if (om) { const tt = priceTier(om); return { emoji: tt.emoji, color: tt.color, note: orCost(om) }; }
  }
  const m = (mid || "").toLowerCase();
  // Free first.
  if (m.includes("schnell-free") || m.includes("schnell_free")) return { emoji: "🎁", color: "#34d399", note: "free" };
  if (m.includes("dall-e-2")) return { emoji: "🟢", color: "#34d399", note: "~$0.02/image" };
  if (m.includes("schnell")) return { emoji: "🟢", color: "#34d399", note: "~$0.003/image" };
  if (m.includes("sd3") || m.includes("sd-3") || m.includes("stable")) return { emoji: "🟢", color: "#34d399", note: "~$0.01/image" };
  if (m.includes("flux") && m.includes("dev")) return { emoji: "🟡", color: "#fbbf24", note: "~$0.025/image" };
  if (m.includes("dall-e-3")) return { emoji: "🟡", color: "#fbbf24", note: "~$0.04–0.12/image" };
  if (m.includes("grok")) return { emoji: "🟡", color: "#fbbf24", note: "~$0.07/image" };
  if (m.includes("flux") && m.includes("pro")) return { emoji: "🟠", color: "#fb923c", note: "~$0.04/image" };
  if (m.includes("gpt-image")) return { emoji: "🟠", color: "#fb923c", note: "~$0.04–0.17/image" };
  return { emoji: "⚪", color: "#9aa0b4", note: t("image.tierDefault") };
}

// Refresh whichever model picker the active workspace needs.
function refreshModelUI() {
  if (mode === "image") populateImageModelSelector();
  else populateModelSelector();
}

// Combobox items for the chat-style pickers (Chat/Agent/Translate/Improve/PDF +
// Terminal). OpenRouter models are grouped by vendor so the list — and the vendor
// sub-filter — stay readable.
function chatComboItems() {
  const out = [];
  for (const pid of providersToShow()) {
    if (pid === "openrouter" && settings.orModels && settings.orModels.length) {
      const byVendor = {};
      for (const m of settings.orModels) {
        if (orUnavailable.has(m.id)) continue;
        const vendor = m.id.split("/")[0] || "other";
        (byVendor[vendor] = byVendor[vendor] || []).push(m);
      }
      for (const vendor of Object.keys(byVendor).sort()) {
        for (const m of byVendor[vendor].sort((a, b) => prettifyORName(a).localeCompare(prettifyORName(b)))) {
          out.push({
            value: "openrouter|" + m.id, label: orOptionLabel(m), provider: "openrouter",
            subprovider: vendor, tier: priceTierName(m), color: priceTier(m).color,
            group: "OpenRouter · " + prettifyVendor(vendor),
          });
        }
      }
      continue;
    }
    for (const [mid, mlabel] of modelsOf(pid)) {
      out.push({ value: pid + "|" + mid, label: mlabel, provider: pid, subprovider: null, tier: null, color: null, group: PROVIDERS[pid].label });
    }
  }
  return out;
}
function populateModelSelector() {
  const connected = connectedProviders(settings);
  const none = connected.length === 0;
  // Nothing connected yet → hide the picker and show ONLY the full-width "Connect a
  // provider" button. Once a provider is connected, show the searchable combobox.
  els.modelConnect.classList.toggle("hidden", !none);
  els.modelWrap.classList.toggle("hidden", none);
  els.modelFilterBtn.classList.toggle("hidden", none);
  if (connected.length) {
    const pid = connected.includes(settings.provider) ? settings.provider : connected[0];
    mainValue = pid + "|" + modelFor(pid, settings);
  } else {
    mainValue = "";
  }
  if (mainCombo) mainCombo.refresh();
  els.modelFilterBtn.classList.toggle("active", filterIsActive());
  updateEmptyState();
}

// Empty-screen content: onboarding when no provider is connected, a friendly
// greeting ("Comment puis-je vous aider ?") once one is — terminal-flavoured in
// the Terminal tab.
function updateEmptyState() {
  const connected = connectedProviders(settings).length > 0;
  els.emptyOnboard.classList.toggle("hidden", connected);
  els.emptyGreeting.classList.toggle("hidden", !connected);
  if (connected) {
    els.emptyGreeting.textContent =
      mode === "agent" ? t("greeting.agent") :
      mode === "pdf" ? t("greeting.pdf") :
      mode === "translate" ? t("greeting.translate") :
      mode === "improve" ? t("greeting.improve") :
      mode === "image" ? t("greeting.image") :
      t("greeting");
  }
}

function parseSel(value) {
  const i = (value || "").indexOf("|");
  if (i < 0) return { providerId: settings.provider, modelId: modelFor(settings.provider, settings) };
  return { providerId: value.slice(0, i), modelId: value.slice(i + 1) };
}
function currentSelection() {
  return parseSel(mainValue);
}

function syncToggleVisibility() {
  // No-op: the control chips (incl. Web) are always visible now. Kept as a hook
  // in case provider-specific UI tweaks are needed later.
}
function updateImageNote() {
  // The "via <provider>" note was removed from the Image tab UI. Kept as a no-op so
  // existing call sites stay valid.
}
function populateImprovePresets() {
  els.improvePreset.innerHTML = "";
  for (const [id] of WRITING_PRESETS) {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = t("preset." + id);
    els.improvePreset.appendChild(o);
  }
}
function populateImageSizes() {
  els.imageSize.innerHTML = "";
  // "—" (empty value): no fixed size — let the model use the dimensions described in
  // the prompt. Selected by default so users can ask for custom sizes freely.
  const none = document.createElement("option");
  none.value = "";
  none.textContent = t("size.none");
  els.imageSize.appendChild(none);
  for (const [value] of IMAGE_SIZES) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = t("size." + value);
    els.imageSize.appendChild(o);
  }
}

// Apply a "providerId|modelId" choice from a picker. Provider + model are written
// in ONE atomic storage write: two separate writes used to race the storage
// change-listener (which fired after the first), leaving the stale model selected
// — that was the Terminal picker "doesn't change / glitches" bug.
async function applyModelChoice(value) {
  const sel = parseSel(value);
  if (!sel.providerId) return null;
  settings.provider = sel.providerId;
  settings.models = { ...(settings.models || {}), [sel.providerId]: sel.modelId };
  await setSettings({ provider: sel.providerId, models: settings.models });
  return sel;
}

// A model was picked in the MAIN combobox.
async function onMainPick(value) {
  mainValue = value;
  // In the Image tab the picker selects an IMAGE model (provider + model used by
  // runImage), not the chat model.
  if (mode === "image") {
    const sel = parseSel(value);
    if (sel.providerId) {
      settings.imageProvider = sel.providerId;
      settings.imageModel = sel.modelId;
      await setSettings({ imageProvider: sel.providerId, imageModel: sel.modelId });
      updateImageNote();
    }
    return;
  }
  await applyModelChoice(value);
}

// One-click free onboarding: OAuth to OpenRouter (free models, no manual key).
async function doFreeConnect() {
  const prev = els.freeConnect.textContent;
  els.freeConnect.disabled = true;
  els.freeConnect.textContent = t("or.connecting");
  try {
    const key = await connectOpenRouter();
    settings.keys = { ...(settings.keys || {}), openrouter: key };
    settings.provider = "openrouter";
    // Atomic write of the full keys object + provider so the Settings page (which
    // reads keys.openrouter) reliably shows the key it just received.
    await setSettings({ keys: settings.keys, provider: "openrouter" });
    populateModelSelector();
    autoListConnected();
    addMessage("tool", t("or.connected"));
  } catch (e) {
    addMessage("error", t("or.connectErr", { msg: e && e.message ? e.message : e }));
  } finally {
    els.freeConnect.disabled = false;
    els.freeConnect.textContent = prev;
  }
}

// Choose the MOST POWERFUL free OpenRouter model that's actually available on the
// account, ranked by a curated preference (DeepSeek R1 first, then V3, Llama 70B…).
// Falls back to any free model, then any model.
function bestFreeOpenRouter(rich) {
  const free = rich.filter((m) => !m.prompt && !m.completion && !orUnavailable.has(m.id));
  if (!free.length) {
    const any = rich.filter((m) => !orUnavailable.has(m.id));
    return any.length ? any[0].id : "";
  }
  const PREF = [
    "gpt-oss-120b", "gpt-oss-20b",
    "deepseek-chat-v3", "deepseek/deepseek-chat", "deepseek-v3",
    "llama-4-maverick", "llama-4-scout", "qwen3",
    "nemotron", "deepseek-r1",
    "gemini-2.0-flash", "llama-3.3-70b", "70b",
  ];
  for (const p of PREF) {
    const hit = free.find((m) => m.id.toLowerCase().includes(p));
    if (hit) return hit.id;
  }
  return free[0].id;
}

// Best-effort: fetch the real available model list for every connected provider.
// OpenRouter gets a richer fetch (vendor + display name + pricing) for the
// hierarchical menu.
async function autoListConnected() {
  const ids = connectedProviders(settings);
  if (!ids.length) return;
  settings.modelLists = settings.modelLists || {};
  await Promise.allSettled(
    ids.map(async (pid) => {
      try {
        if (pid === "openrouter") {
          const rich = await listOpenRouterRich(settings);
          if (rich && rich.length) {
            settings.orModels = rich;
            settings.modelLists[pid] = rich.map((m) => m.id);
            // FIX: the hard-coded default free model (e.g. llama-3.3-70b:free) is
            // often unavailable/renamed on a given account, so it silently fails.
            // Pick a free model that ACTUALLY exists in this account's live list
            // (falling back to the first model) whenever the current choice isn't
            // in the list. This makes the out-of-the-box free default just work.
            const chosen = settings.models && settings.models.openrouter;
            const inList = chosen && rich.some((m) => m.id === chosen);
            if (!inList) {
              const pick = bestFreeOpenRouter(rich);
              if (pick) {
                settings.models = { ...(settings.models || {}), openrouter: pick };
                await setSettings({ models: settings.models });
              }
            }
          }
        } else {
          const list = await listModels(pid, settings);
          if (list && list.length) settings.modelLists[pid] = list;
        }
      } catch (_) {}
    })
  );
  await setSettings({ modelLists: settings.modelLists, orModels: settings.orModels || [] });
  refreshModelUI();
}

// ----- Model picker: searchable combobox + price/provider filter -------------
const ALL_TIERS = ["free", "green", "yellow", "orange", "red"];
function filterState() {
  return settings.modelFilter || { tiers: [...ALL_TIERS], providers: [], subproviders: [] };
}
function filterIsActive() {
  const f = filterState();
  return (f.providers && f.providers.length > 0) || (f.subproviders && f.subproviders.length > 0) ||
    (f.tiers && f.tiers.length < ALL_TIERS.length);
}
// Does a combobox item pass the current price/provider filter + the typed query?
function comboPasses(it, q) {
  if (q) {
    const hay = (it.label + " " + it.value).toLowerCase();
    if (!hay.includes(q)) return false;
  }
  const f = filterState();
  if (it.tier && f.tiers && f.tiers.length && !f.tiers.includes(it.tier)) return false;
  if (f.providers && f.providers.length && !f.providers.includes(it.provider)) return false;
  if (it.provider === "openrouter" && it.subprovider && f.subproviders && f.subproviders.length && !f.subproviders.includes(it.subprovider)) return false;
  return true;
}

// Reusable searchable combobox. `input` shows the selected label and is type-to-filter;
// `menu` is a floating list. `items()` returns {value,label,provider,subprovider,tier,
// color,group}; `getValue()`/`onPick(value)` read & set the selection.
function makeCombo({ input, menu, items, getValue, onPick }) {
  let openState = false;
  function curLabel() {
    const v = getValue();
    const it = items().find((x) => x.value === v);
    if (it) return it.label;
    return v ? (v.split("|")[1] || v) : "";
  }
  function syncLabel() { if (!openState) input.value = curLabel(); }
  function render() {
    const q = openState ? input.value.trim().toLowerCase() : "";
    const list = items().filter((it) => comboPasses(it, q));
    menu.innerHTML = "";
    if (!list.length) {
      const d = document.createElement("div"); d.className = "combo-empty"; d.textContent = t("filter.noMatch"); menu.appendChild(d);
      return;
    }
    const cur = getValue();
    let lastG = null;
    for (const it of list) {
      if (it.group && it.group !== lastG) {
        lastG = it.group;
        const h = document.createElement("div"); h.className = "combo-group"; h.textContent = it.group; menu.appendChild(h);
      }
      const row = document.createElement("div");
      row.className = "combo-item" + (it.value === cur ? " sel" : "");
      row.textContent = it.label;
      row.title = it.label;
      if (it.color) row.style.color = it.color;
      row.addEventListener("mousedown", (e) => { e.preventDefault(); pick(it); });
      menu.appendChild(row);
    }
  }
  function position() {
    menu.classList.remove("hidden");
    const r = input.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8));
    let top = r.bottom + 4;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  }
  function open() { openState = true; input.value = ""; render(); position(); }
  function close() { openState = false; menu.classList.add("hidden"); syncLabel(); }
  function pick(it) { openState = false; menu.classList.add("hidden"); input.value = it.label; onPick(it.value); }
  input.addEventListener("focus", open);
  input.addEventListener("input", () => { openState = true; render(); position(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { close(); input.blur(); }
    else if (e.key === "Enter") { e.preventDefault(); const first = menu.querySelector(".combo-item"); if (first) first.dispatchEvent(new MouseEvent("mousedown")); }
  });
  return {
    refresh: () => { syncLabel(); if (openState) render(); },
    render: () => { if (openState) { render(); position(); } },
    close,
    isOpen: () => openState,
    input,
  };
}

// Filter applied to the per-message compare <select>s (native), which mirror the
// combobox filter. (The main + terminal pickers are comboboxes and filter internally.)
function applyModelFilter() {
  const f = filterState();
  const tiers = new Set(f.tiers || []);
  const provs = new Set(f.providers || []);
  const subs = new Set(f.subproviders || []);
  for (const sel of document.querySelectorAll(".cmp-select")) {
    const current = sel.value;
    for (const o of sel.querySelectorAll("option")) {
      if (!o.value || o.value === current) { o.hidden = false; continue; }
      let vis = true;
      if (provs.size && o.dataset.provider && !provs.has(o.dataset.provider)) vis = false;
      if (vis && o.dataset.tier && tiers.size && !tiers.has(o.dataset.tier)) vis = false;
      if (vis && o.dataset.provider === "openrouter" && o.dataset.subprovider && subs.size && !subs.has(o.dataset.subprovider)) vis = false;
      o.hidden = !vis;
    }
    for (const g of sel.querySelectorAll("optgroup")) g.hidden = !Array.from(g.querySelectorAll("option")).some((o) => !o.hidden);
  }
}
function buildFilterPanel() {
  const f = filterState();
  const tiers = new Set(f.tiers || []);
  els.modelFilterPanel.querySelectorAll(".ftier-cb").forEach((cb) => { cb.checked = tiers.has(cb.value); });
  els.filterProviders.innerHTML = "";
  const provs = new Set(f.providers || []);
  const subs = new Set(f.subproviders || []);
  const connected = connectedProviders(settings);
  for (const pid of connected) {
    const lab = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.value = pid; cb.checked = provs.size ? provs.has(pid) : true; cb.dataset.kind = "provider";
    cb.addEventListener("change", onProviderFilterChange);
    const sp = document.createElement("span");
    sp.textContent = PROVIDERS[pid] ? PROVIDERS[pid].label : pid;
    lab.appendChild(cb); lab.appendChild(sp);
    els.filterProviders.appendChild(lab);
    // OpenRouter: list its vendors as indented sub-providers so OpenRouter models can
    // be filtered by their origin (Google / OpenAI / Anthropic / Meta…).
    if (pid === "openrouter" && settings.orModels && settings.orModels.length) {
      const vendors = [...new Set(settings.orModels.filter((m) => !orUnavailable.has(m.id)).map((m) => m.id.split("/")[0] || "other"))].sort();
      for (const v of vendors) {
        const l2 = document.createElement("label"); l2.className = "subprov";
        const c2 = document.createElement("input");
        c2.type = "checkbox"; c2.value = v; c2.checked = subs.size ? subs.has(v) : true; c2.dataset.kind = "subprovider";
        c2.addEventListener("change", onSubproviderFilterChange);
        const s2 = document.createElement("span"); s2.textContent = prettifyVendor(v);
        l2.appendChild(c2); l2.appendChild(s2);
        els.filterProviders.appendChild(l2);
      }
    }
  }
}
function openFilterPanel(anchor) {
  buildFilterPanel();
  const p = els.modelFilterPanel;
  p.classList.remove("hidden");
  const r = anchor.getBoundingClientRect();
  const pw = p.offsetWidth, ph = p.offsetHeight;
  const left = Math.max(8, Math.min(r.right - pw, window.innerWidth - pw - 8));
  let top = r.bottom + 6;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
  p.style.left = left + "px";
  p.style.top = top + "px";
}
function toggleFilterPanel(anchor) {
  if (els.modelFilterPanel.classList.contains("hidden")) openFilterPanel(anchor);
  else els.modelFilterPanel.classList.add("hidden");
}
function persistFilter() {
  clearTimeout(filterPersistTimer);
  filterPersistTimer = setTimeout(() => setSettings({ modelFilter: settings.modelFilter }), 250);
}
// Re-render whatever is open after a filter change.
function afterFilterChange() {
  if (mainCombo) mainCombo.render();
  applyModelFilter();
  els.modelFilterBtn.classList.toggle("active", filterIsActive());
}
function onTierFilterChange() {
  const tiers = [];
  els.modelFilterPanel.querySelectorAll(".ftier-cb").forEach((cb) => { if (cb.checked) tiers.push(cb.value); });
  settings.modelFilter = { ...filterState(), tiers };
  persistFilter(); afterFilterChange();
}
function onProviderFilterChange() {
  const provs = [];
  els.filterProviders.querySelectorAll('input[data-kind="provider"]').forEach((cb) => { if (cb.checked) provs.push(cb.value); });
  const connected = connectedProviders(settings);
  settings.modelFilter = { ...filterState(), providers: provs.length === connected.length ? [] : provs };
  persistFilter(); afterFilterChange();
}
function onSubproviderFilterChange() {
  const all = els.filterProviders.querySelectorAll('input[data-kind="subprovider"]');
  const subs = [];
  all.forEach((cb) => { if (cb.checked) subs.push(cb.value); });
  settings.modelFilter = { ...filterState(), subproviders: subs.length === all.length ? [] : subs };
  persistFilter(); afterFilterChange();
}
function resetFilter() {
  settings.modelFilter = { tiers: [...ALL_TIERS], providers: [], subproviders: [] };
  persistFilter();
  buildFilterPanel();
  afterFilterChange();
}

// ----- Composer attachments (files / images as AI context) -------------------
async function addAttachmentFiles(fileList) {
  for (const file of Array.from(fileList || [])) {
    try { await readOneAttachment(file); }
    catch (_) { addMessage("error", t("attach.unsupported", { name: file.name })); }
  }
  renderAttachStrip();
}
async function readOneAttachment(file) {
  const isImage = (file.type || "").startsWith("image/");
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  const maxMB = isImage ? ATT_IMG_MAX_MB : ATT_TXT_MAX_MB;
  if (file.size > maxMB * 1024 * 1024) { addMessage("error", t("attach.tooBig", { name: file.name, mb: maxMB })); return; }
  if (isImage) {
    const dataUrl = await readFileAs(file, "dataURL");
    attachments.push({ type: "image", name: file.name, dataUrl, mediaType: file.type || "image/png" });
  } else if (isPdf) {
    const buf = await file.arrayBuffer();
    const { text, pages } = await extractPdfText(buf);
    attachments.push({ type: "text", name: file.name, text, isPdf: true, pages });
  } else {
    const text = await readFileAs(file, "text");
    attachments.push({ type: "text", name: file.name, text: text || "" });
  }
}
function readFileAs(file, how) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    if (how === "dataURL") r.readAsDataURL(file); else r.readAsText(file);
  });
}
async function extractPdfText(buf) {
  if (!window.pdfjsLib) throw new Error("pdf.js not loaded");
  if (!pdfWorkerSet) { window.pdfjsLib.GlobalWorkerOptions.workerSrc = browser.runtime.getURL("vendor/pdf.worker.min.js"); pdfWorkerSet = true; }
  const doc = await window.pdfjsLib.getDocument({ data: buf }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str || "").join(" ") + "\n\n";
  }
  return { text: text.trim(), pages: doc.numPages };
}
function renderAttachStrip() {
  els.attachStrip.innerHTML = "";
  els.attachStrip.classList.toggle("hidden", attachments.length === 0);
  attachments.forEach((a, i) => {
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    if (a.type === "image") {
      const img = document.createElement("img"); img.src = a.dataUrl; chip.appendChild(img);
    } else {
      const ic = document.createElement("span"); ic.textContent = a.isPdf ? "📄" : "📎"; chip.appendChild(ic);
    }
    const name = document.createElement("span"); name.className = "acn"; name.textContent = a.name; chip.appendChild(name);
    const x = document.createElement("button"); x.className = "ax"; x.textContent = "✕"; x.title = t("attach.remove");
    x.addEventListener("click", () => { attachments.splice(i, 1); renderAttachStrip(); });
    chip.appendChild(x);
    els.attachStrip.appendChild(chip);
  });
}
function clearAttachments() { attachments = []; renderAttachStrip(); }
// Split the pending attachments into the image list (for vision) + a folded text
// block (for any model) + render metadata for the user bubble.
function takeAttachments() {
  const imgs = attachments.filter((a) => a.type === "image");
  const texts = attachments.filter((a) => a.type === "text");
  let textBlock = "";
  for (const a of texts) {
    const head = a.isPdf ? `[Attached PDF: ${a.name} (${a.pages} pages)]` : `[Attached file: ${a.name}]`;
    textBlock += `${head}\n${(a.text || "").slice(0, ATT_TXT_BUDGET)}\n\n`;
  }
  const meta = attachments.map((a) => ({ type: a.type, name: a.name, dataUrl: a.type === "image" ? a.dataUrl : undefined, isPdf: a.isPdf }));
  return { imgs, textBlock, meta };
}
// Build the native per-turn user content. With image attachments we switch to the
// provider's multimodal content array (Anthropic image blocks / OpenAI image_url).
function buildUserContent(text, imgs, providerId) {
  if (!imgs || !imgs.length) return text;
  const kind = (PROVIDERS[providerId] && PROVIDERS[providerId].kind) || "openai";
  if (kind === "anthropic") {
    const parts = [{ type: "text", text }];
    for (const a of imgs) {
      const m = /^data:([^;]+);base64,(.*)$/.exec(a.dataUrl || "");
      if (m) parts.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
    }
    return parts;
  }
  const parts = [{ type: "text", text }];
  for (const a of imgs) parts.push({ type: "image_url", image_url: { url: a.dataUrl } });
  return parts;
}

// Clicking the brand (logo / "Hivey AI") shows/hides the workspace tabs rail.
function toggleRail() {
  settings.railHidden = !settings.railHidden;
  document.body.classList.toggle("rail-collapsed", settings.railHidden);
  setSettings({ railHidden: settings.railHidden });
}

// ----- Open in a full-screen tab --------------------------------------------
function openInTab() {
  const url = browser.runtime.getURL("src/sidebar/sidebar.html") + "?tab=1";
  try { browser.tabs.create({ url }); } catch (_) { window.open(url, "_blank", "noopener"); }
  // Close the docked sidebar so we don't show the same UI twice (Firefox only API).
  try { if (browser.sidebarAction && browser.sidebarAction.close) browser.sidebarAction.close(); } catch (_) {}
}

// ----- Element picker -------------------------------------------------------
// "Ask about this element": the user points at a table / image / menu on the page;
// we capture its text + a cropped screenshot (vision) and stage them as attachments,
// so the next message can ask a question grounded in that exact element.
let picking = false;
let pickTabId = null;
async function getActiveTab() {
  // Robust across window setups: the sidebar's currentWindow can be ambiguous, so
  // fall back to the last-focused window, then any active tab.
  try {
    let tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tabs || !tabs[0]) tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tabs || !tabs[0]) tabs = await browser.tabs.query({ active: true });
    return tabs && tabs[0] ? tabs[0] : null;
  } catch (_) { return null; }
}
async function getActiveTabId() {
  const t = await getActiveTab();
  return t ? t.id : null;
}
// Only genuinely privileged browser pages can't host a content script. Everything
// else — http(s) on any host/port, intranet, self-signed, deep-web services — must work.
function isRestrictedUrl(url) {
  return !url
    || /^(about:|moz-extension:|chrome:|chrome-extension:|resource:|view-source:|data:|javascript:|edge:|opera:|vivaldi:|brave:)/i.test(url)
    || /^https:\/\/(addons\.mozilla\.org|chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url);
}
// captureVisibleTab needs the `<all_urls>` host permission to be GRANTED. In an
// installed MV3 build that permission is optional and not granted at install (unlike
// a temporary add-on), which is why the screenshot fails with "Missing activeTab
// permission". `<all_urls>` is declared in `optional_host_permissions`, so we can
// request it here — and this MUST run synchronously inside the click gesture, so call
// it FIRST in the handler. Resolves true once granted; false if denied/failed (so the
// caller shows a clear message instead of trying to capture without permission).
async function ensurePagePermission() {
  try {
    if (!browser.permissions || !browser.permissions.request) return true;
    const granted = await browser.permissions.request({ origins: ["<all_urls>"] });
    return !!granted;
  } catch (_) {
    return false;
  }
}

// Send a message to the tab's content script. If it isn't there yet (the page was
// open before the extension loaded / before host access was granted), inject it on
// demand and retry. Designed to work on EVERY scriptable page — http(s) on any host
// or port, intranet, self-signed, deep-web web services. Throws only if the page is
// truly unscriptable (a privileged browser page) or injection keeps failing.
const CONTENT_FILES = ["vendor/browser-polyfill.min.js", "src/content/content.js"];
async function sendToTab(tabId, msg) {
  // 1) Fast path: the content script is already present.
  try { return await browser.tabs.sendMessage(tabId, msg); } catch (_) {}
  // 2) Inject on demand. Try the top frame first, then all frames (some apps live
  //    inside a child frame), tolerating "already injected" errors.
  let injected = false;
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
    injected = true;
  } catch (_) {
    try {
      await browser.scripting.executeScript({ target: { tabId, allFrames: true }, files: CONTENT_FILES });
      injected = true;
    } catch (_) {}
  }
  if (!injected) throw new Error("cannot inject content script on this page");
  // 3) The freshly-registered listener may need a tick — retry a few times.
  for (let i = 0; i < 5; i++) {
    try { return await browser.tabs.sendMessage(tabId, msg); }
    catch (_) { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error("content script unreachable after injection");
}
// ----- Agent activity glow --------------------------------------------------
// A pulsing border on the page the agent is acting on (à la Perplexity). We glow the
// ACTIVE tab and re-assert it as the agent navigates/switches; cleared when it stops.
const glowedTabs = new Set();
async function agentGlowActiveTab() {
  try {
    const id = await getActiveTabId();
    if (id == null) return;
    glowedTabs.add(id);
    try { await sendToTab(id, { type: "agent_glow", on: true }); } catch (_) {}
  } catch (_) {}
}
async function clearAgentGlow() {
  for (const id of Array.from(glowedTabs)) {
    try { await browser.tabs.sendMessage(id, { type: "agent_glow", on: false }); } catch (_) {}
  }
  glowedTabs.clear();
}
function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}
function cropFromShot(img, rect, dpr) {
  const sx = Math.max(0, rect.x * dpr), sy = Math.max(0, rect.y * dpr);
  const sw = Math.min(img.width - sx, rect.w * dpr), sh = Math.min(img.height - sy, rect.h * dpr);
  if (sw <= 4 || sh <= 4) return null; // off-screen / tiny → no usable crop
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sw); canvas.height = Math.round(sh);
  canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}
function finishPicking() { picking = false; pickTabId = null; els.pickEl.classList.remove("active"); }
// Cancel an in-progress pick (re-click the button, click in the sidebar, or Esc).
function cancelPicking() {
  if (!picking) return;
  const id = pickTabId;
  if (id != null) { try { browser.tabs.sendMessage(id, { type: "pick_cancel" }); } catch (_) {} }
}
async function pickElement() {
  if (picking || capturing) return;
  const tab = await getActiveTab();
  if (!tab) { addMessage("error", t("pick.error")); return; }
  if (isRestrictedUrl(tab.url)) { addMessage("error", t("pick.restricted")); return; }
  const tabId = tab.id;
  if (mode !== "chat" && mode !== "agent") setMode("chat");
  picking = true; pickTabId = tabId; els.pickEl.classList.add("active");
  const note = addMessage("tool", t("pick.start"));
  let res;
  try {
    res = await sendToTab(tabId, { type: "pick_element" });
  } catch (_) {
    note.remove(); finishPicking();
    addMessage("error", t("region.reload"));
    return;
  }
  note.remove(); finishPicking();
  if (res === undefined) { addMessage("error", t("region.reload")); return; } // stale content script
  const list = (res && res.elements) || [];
  if (!res || res.cancelled || !list.length) return;
  // One screenshot of the current viewport; crop each selected element from it.
  let img = null;
  try {
    await new Promise((r) => setTimeout(r, 140));
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const winId = tabs && tabs[0] ? tabs[0].windowId : undefined;
    img = await loadImage(await browser.tabs.captureVisibleTab(winId, { format: "png" }));
  } catch (_) {}
  for (const el of list) {
    if (img) { const crop = cropFromShot(img, el.rect, res.dpr || 1); if (crop) attachments.push({ type: "image", name: t("pick.imgName", { tag: el.tag }), dataUrl: crop, mediaType: "image/png" }); }
    if (el.text) attachments.push({ type: "text", name: t("pick.attName", { tag: el.tag }), text: `[Selected <${el.tag}> on ${res.title} — ${res.url}]\n${el.text}` });
  }
  renderAttachStrip();
  addMessage("tool", list.length > 1 ? t("pick.addedN", { n: list.length }) : t("pick.added", { tag: list[0].tag }));
  els.input.focus();
}

// ----- Region capture (screenshot tool) -------------------------------------
// "Capture an area": the user draws a rectangle over the page; we crop that region
// from a screenshot and stage it as an IMAGE attachment (vision), so the next message
// can ask about exactly what's on screen — like the Program Generator capture tool.
let capturing = false;
function finishCapture() { capturing = false; pickTabId = null; els.captureRegion.classList.remove("active"); }
function cancelCapture() {
  if (!capturing) return;
  const id = pickTabId;
  if (id != null) { try { browser.tabs.sendMessage(id, { type: "region_cancel" }); } catch (_) {} }
}
async function captureRegion() {
  if (capturing || picking) return;
  const tab = await getActiveTab();
  if (!tab) { addMessage("error", t("pick.error")); return; }
  if (isRestrictedUrl(tab.url)) { addMessage("error", t("pick.restricted")); return; }
  const tabId = tab.id;
  if (mode !== "chat" && mode !== "agent") setMode("chat");
  capturing = true; pickTabId = tabId; els.captureRegion.classList.add("active");
  const note = addMessage("tool", t("region.start"));
  let res;
  try {
    res = await sendToTab(tabId, { type: "capture_region" });
  } catch (_) {
    note.remove(); finishCapture();
    addMessage("error", t("region.reload"));
    return;
  }
  note.remove(); finishCapture();
  // A stale content script (page loaded before this update) ignores the message and
  // returns undefined — tell the user to refresh the page once.
  if (res === undefined) { addMessage("error", t("region.reload")); return; }
  if (!res || res.cancelled || !res.rect) return;
  // Screenshot the viewport (overlay already removed), then crop the chosen rectangle.
  let img = null, capErr = "";
  try {
    await new Promise((r) => setTimeout(r, 140));
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const winId = tabs && tabs[0] ? tabs[0].windowId : undefined;
    img = await loadImage(await browser.tabs.captureVisibleTab(winId, { format: "png" }));
  } catch (e) { capErr = (e && e.message) || String(e); }
  if (!img) { addMessage("error", t("region.error") + (capErr ? " — " + capErr : "")); return; }
  const crop = cropFromShot(img, res.rect, res.dpr || 1);
  if (!crop) { addMessage("error", t("region.error")); return; }
  attachments.push({ type: "image", name: t("region.imgName"), dataUrl: crop, mediaType: "image/png" });
  renderAttachStrip();
  addMessage("tool", t("region.added"));
  els.input.focus();
}

// ----- Workspace modes ------------------------------------------------------
function setMode(next) {
  const prev = mode;
  if (prev !== next && els.searchBar && !els.searchBar.classList.contains("hidden")) closeSearch();
  // Save the conversation we're leaving (data + DOM nodes), then point the globals
  // at the target workspace's own conversation.
  if (prev !== next && CHAT_MODES.includes(prev)) { syncSessionFromGlobals(prev); stashMode(prev); }
  mode = next;
  settings.mode = next;
  setSettings({ mode: next });
  if (CHAT_MODES.includes(next)) loadSessionToGlobals(next);
  els.rail.querySelectorAll(".railtab").forEach((b) => b.classList.toggle("active", b.dataset.mode === next));
  // The Thinking/Web/Page toggles (now inside the composer) belong to Chat only.
  els.chatControls.classList.toggle("hidden", next !== "chat");
  els.translateControls.classList.toggle("hidden", next !== "translate");
  els.improveControls.classList.toggle("hidden", next !== "improve");
  els.imageControls.classList.toggle("hidden", next !== "image");
  els.pdfControls.classList.toggle("hidden", next !== "pdf");
  // The per-mode controls row is only useful for translate/improve/image/pdf; hide it
  // entirely on Chat/Agent/Code so there's no empty bar.
  els.controls.hidden = !["translate", "improve", "image", "pdf"].includes(next);
  // Attach (+) is offered on Chat/Agent/Translate/Improve/Image only.
  const composeExtras = ["chat", "agent", "translate", "improve", "image"].includes(next);
  els.attachBtn.hidden = !composeExtras;
  if (!composeExtras && attachments.length) clearAttachments();
  // On the Chat tab the "+" sits at the bottom-left (beside the toggles); on every other
  // tab it sits next to the text in the first row.
  if (next === "chat") els.toolsLeft.appendChild(els.attachBtn);
  else els.composerMain.insertBefore(els.attachBtn, els.input);
  els.modelFilterPanel.classList.add("hidden");
  if (mainCombo) mainCombo.close();
  document.body.classList.toggle("mode-code", next === "code");
  els.codeView.classList.toggle("hidden", next !== "code");
  els.input.placeholder = placeholderFor(next);
  refreshModelUI(); // Image tab lists image models; others list chat models.
  if (CHAT_MODES.includes(next)) restoreMode(next); // re-attach this tab's own message nodes
  if (next === "code") updateCodeLauncher();
  updatePageBar(); // Page bar is Chat-only — hide it (and its popup) on other tabs
  updateEmptyState();
  // If the history panel is open, refresh it to show THIS workspace's conversations.
  if (!els.historyPanel.classList.contains("hidden")) renderHistoryList();
}

// ----- Code workspace (AI app builder launcher) -----------------------------
// The builder (Bolt.diy / Program Generator) runs WebContainers, which require cross-origin
// isolation (COOP/COEP) and therefore cannot live inside an extension iframe — we
// open it in a dedicated browser tab where preview / terminal / Expo Go all work.
function updateCodeLauncher() {
  const url = (settings.codeAppUrl || "").trim();
  if (url) {
    els.openCodeApp.disabled = false;
    els.openCodeApp.textContent = t("code.open");
    els.codeAppUrlLabel.textContent = url;
  } else {
    els.openCodeApp.disabled = true;
    els.openCodeApp.textContent = t("code.notConfigured");
    els.codeAppUrlLabel.textContent = t("code.setUrl");
  }
}
// Program Generator and the sidebar are ONE service: hand the builder this sidebar's
// OpenRouter key via the URL fragment (#sk=). The fragment is never sent to the
// server; Program Generator's bridge copies it into its own cookie then strips it.
function codeAppLaunchUrl() {
  const url = (settings.codeAppUrl || "").trim();
  if (!url) return "";
  const orKey = (settings.keys && settings.keys.openrouter) || "";
  if (!orKey) return url; // no key to share yet — open it blank
  return url + (url.includes("#") ? "&" : "#") + "sk=" + encodeURIComponent(orKey);
}
async function openCodeApp() {
  if (!(settings.codeAppUrl || "").trim()) return browser.runtime.openOptionsPage();
  const url = codeAppLaunchUrl();
  try { await browser.tabs.create({ url }); } catch (_) { window.open(url, "_blank", "noopener"); }
}

// ----- Page awareness -------------------------------------------------------
function setupPageAwareness() {
  const onChange = () => debouncedRefresh();
  browser.tabs.onActivated.addListener(onChange);
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab && tab.active && (changeInfo.status === "complete" || changeInfo.url)) onChange();
  });
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "page_changed") onChange();
  });
}
let refreshTimer = null;
function debouncedRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshCurrentPage, 350);
}
async function refreshCurrentPage() {
  let ok = false;
  try {
    const page = await executeTool("read_page", {}, {});
    if (page && !page.error && page.url) {
      currentPage = page;
      els.pageTitle.textContent = page.title || page.url;
      ok = true;
    }
  } catch (_) {}
  if (!ok) {
    currentPage = null;
    els.pageTitle.textContent = t("page.none");
  }
  updatePageBar();
}

// The Page bar (page seen by the AI + element/region tools + 📑 tab picker) is a
// CHAT-ONLY feature. Show it only on the Chat tab when the Page toggle is on; hide it
// — and close its tab-picker popup — everywhere else (that's the "Page popup stays open
// after switching workspace" fix).
function updatePageBar() {
  const show = mode === "chat" && els.pageCtx.checked;
  els.pageBar.classList.toggle("hidden", !show);
  if (!show) els.tabsPanel.classList.add("hidden");
}

// ----- Multi-tab context ----------------------------------------------------
async function buildTabsList() {
  const res = await executeTool("list_tabs", {}, {});
  els.tabsList.innerHTML = "";
  const selected = new Set(settings.selectedTabs || []);
  for (const t of (res && res.tabs) || []) {
    if (!t.url || /^about:/.test(t.url)) continue;
    const li = document.createElement("li");
    const lab = document.createElement("label");
    lab.className = "tabrow";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selected.has(t.id);
    cb.dataset.tabId = String(t.id);
    const span = document.createElement("span");
    span.className = "tabtitle";
    span.textContent = t.title || t.url;
    span.title = t.url;
    lab.appendChild(cb);
    lab.appendChild(span);
    li.appendChild(lab);
    els.tabsList.appendChild(li);
  }
}
async function persistSelectedTabs() {
  const ids = [];
  els.tabsList.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    if (cb.checked) ids.push(parseInt(cb.dataset.tabId, 10));
  });
  settings.selectedTabs = ids;
  await setSettings({ selectedTabs: ids });
}
async function selectedTabsContext() {
  // Any tab the user has ticked is always added to the context (no extra toggle).
  if (!(settings.selectedTabs || []).length) return "";
  const parts = [];
  for (const tabId of settings.selectedTabs) {
    try {
      const p = await executeTool("read_tab", { tabId }, {});
      if (p && !p.error && p.text) {
        parts.push(`[Tab] ${p.title || ""} (${p.url})\n` + cleanText(p.text).slice(0, Math.floor(settings.maxPageChars / 2)));
      }
    } catch (_) {}
  }
  return parts.length ? `[Multi-tab context]\n${parts.join("\n\n")}\n\n` : "";
}

// ----- Local history --------------------------------------------------------
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return t("time.now");
  if (s < 3600) return t("time.min", { n: Math.floor(s / 60) });
  if (s < 86400) return t("time.hour", { n: Math.floor(s / 3600) });
  return t("time.day", { n: Math.floor(s / 86400) });
}
// Display title for a saved (or synthetic current) conversation entry: a manual
// rename wins, then the auto-derived title, then the "New conversation" placeholder.
function displayTitleFor(c) {
  if (c.customTitle) return c.customTitle;
  if (c.title && c.title !== "Nouvelle conversation") return c.title;
  return t("history.newEntry");
}
async function renderHistoryList() {
  // Each workspace shows ONLY its own saved conversations (legacy entries with no
  // mode are treated as Chat).
  const all = await listConversations();
  const saved = all.filter((c) => (c.mode || "chat") === mode);
  // Always surface the conversation that is OPEN right now — even before its first
  // message is saved — as a "New conversation · Current" entry at the top, so opening
  // a fresh chat immediately shows up in the list (its name fills in from the prompt).
  const entries = saved.slice();
  if (!entries.some((c) => c.id === convId)) {
    const s = getSession(mode);
    entries.unshift({ id: convId, mode, updatedAt: Date.now(), customTitle: s.customTitle || "", title: "", _synthetic: true });
  }
  els.historyList.innerHTML = "";
  if (!entries.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = t("history.empty");
    els.historyList.appendChild(li);
    return;
  }
  for (const c of entries) {
    const li = document.createElement("li");
    li.className = "histrow";
    const isCurrent = c.id === convId;
    if (isCurrent) li.classList.add("current");
    // Selection checkbox (saved conversations only) for bulk delete.
    if (!c._synthetic) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "hsel";
      cb.dataset.id = c.id;
      cb.title = t("hist.selectTitle");
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", updateDeleteSelectedBtn);
      li.appendChild(cb);
    }
    const title = document.createElement("span");
    title.className = "htitle";
    title.textContent = displayTitleFor(c);
    li.appendChild(title);
    // Rename button (✏️) sits right after the title — i.e. just LEFT of the "Current"
    // tag — at the end of the title's available width.
    const ren = document.createElement("button");
    ren.className = "hact hren";
    ren.textContent = "✏️";
    ren.title = t("hist.renameTitle");
    ren.addEventListener("click", (e) => { e.stopPropagation(); startRename(c, li, title); });
    li.appendChild(ren);
    // The "Current" tag is a SEPARATE, non-shrinking element — only the title text
    // truncates, so the tag is always shown in full.
    if (isCurrent) {
      const tag = document.createElement("span");
      tag.className = "hcur";
      tag.textContent = t("history.current");
      li.appendChild(tag);
    }
    const meta = document.createElement("span");
    meta.className = "hmeta";
    meta.textContent = timeAgo(c.updatedAt || Date.now());
    li.appendChild(meta);
    // Actions: share (🔗, saved only) · delete (✕, saved only).
    if (!c._synthetic) {
      const share = document.createElement("button");
      share.className = "hact hshare";
      share.textContent = "🔗";
      share.title = t("hist.shareTitle");
      share.addEventListener("click", (e) => { e.stopPropagation(); openSharePicker(c); });
      const del = document.createElement("button");
      del.className = "hdel";
      del.textContent = "✕";
      del.title = t("delete.title");
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        await deleteConversation(c.id);
        if (c.id === convId) startFreshChat();
        renderHistoryList();
      });
      li.appendChild(share);
      li.appendChild(del);
    }
    if (!isCurrent) li.addEventListener("click", () => loadConversation(c.id));
    els.historyList.appendChild(li);
  }
  updateDeleteSelectedBtn();
}

// Reflect the number of ticked conversations on the "Delete selected" button.
function updateDeleteSelectedBtn() {
  if (!els.deleteSelected) return;
  const n = els.historyList.querySelectorAll(".hsel:checked").length;
  els.deleteSelected.classList.toggle("hidden", n === 0);
  els.deleteSelected.textContent = t("history.deleteSelected", { n });
}
// Delete every ticked conversation at once.
async function deleteSelectedConversations() {
  const ids = Array.from(els.historyList.querySelectorAll(".hsel:checked")).map((cb) => cb.dataset.id);
  if (!ids.length) return;
  for (const id of ids) await deleteConversation(id);
  if (ids.includes(convId)) startFreshChat();
  renderHistoryList();
}

// Inline rename: turn the title into an editable field. A manual title is persisted
// (customTitle) and no longer overwritten by the auto title derived from the prompt.
function startRename(c, li, titleSpan) {
  const input = document.createElement("input");
  input.className = "hrename";
  input.value = displayTitleFor(c);
  li.replaceChild(input, titleSpan);
  input.focus(); input.select();
  let done = false;
  const commit = async (save) => {
    if (done) return; done = true;
    const v = input.value.trim();
    if (save && v) await applyRename(c, v);
    renderHistoryList();
  };
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); commit(true); }
    else if (e.key === "Escape") { e.preventDefault(); commit(false); }
  });
  input.addEventListener("blur", () => commit(true));
}
async function applyRename(c, newTitle) {
  if (c.id === convId) getSession(mode).customTitle = newTitle;
  const conv = await getConversation(c.id);
  if (conv) {
    conv.customTitle = newTitle;
    conv.title = newTitle;
    await saveConversation(conv);
  }
  // An unsaved current conversation has no stored entry yet; its customTitle on the
  // session is enough and gets persisted when the first message is saved.
}

// Compress a conversation into a context note — LOCALLY and INSTANTLY (no API call,
// so the import is fast and spends zero tokens). We clean the text and, if it's long,
// keep the head + tail within a budget (the start sets up the topic, the end carries
// the latest state) so the gist survives.
function compressConversation(conv) {
  const items = conv.transcript || [];
  const raw = items
    .map((m) => `${m.role === "assistant" ? "Assistant" : m.kind === "note" ? "Note" : "User"}: ${m.text || (m.kind === "image" ? "[generated image]" : "")}`)
    .join("\n");
  const cleaned = cleanText(raw);
  if (!cleaned) return "(empty conversation)";
  const BUDGET = 4000;
  if (cleaned.length <= BUDGET) return cleaned;
  return cleaned.slice(0, Math.floor(BUDGET * 0.6)) + "\n…\n" + cleaned.slice(-Math.floor(BUDGET * 0.4));
}

// Share = inject one conversation's compressed context into ANOTHER conversation.
// Shows an inline "pick a target" list inside the history panel.
async function openSharePicker(source) {
  const all = await listConversations();
  const others = all.filter((c) => (c.mode || "chat") === mode && c.id !== source.id);
  // The conversation open right now is a valid target too — even if it's a brand-new
  // blank one not yet saved. Add it (as "New conversation") at the top.
  if (convId !== source.id && !others.some((c) => c.id === convId)) {
    const s = getSession(mode);
    others.unshift({ id: convId, mode, customTitle: s.customTitle || "", title: "", _synthetic: true });
  }
  els.historyList.innerHTML = "";
  const head = document.createElement("li");
  head.className = "share-head";
  head.textContent = t("share.pickTitle");
  els.historyList.appendChild(head);
  if (!others.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = t("share.none");
    els.historyList.appendChild(li);
  } else {
    for (const c of others) {
      const li = document.createElement("li");
      li.className = "histrow share-target";
      const title = document.createElement("span");
      title.className = "htitle";
      title.textContent = displayTitleFor(c);
      li.appendChild(title);
      li.addEventListener("click", () => injectContext(source, c));
      els.historyList.appendChild(li);
    }
  }
  const cancel = document.createElement("li");
  cancel.className = "share-cancel";
  cancel.textContent = t("share.cancel");
  cancel.addEventListener("click", () => renderHistoryList());
  els.historyList.appendChild(cancel);
}

// Replace the picker with a transient confirmation line, then return to the list —
// so the user gets clear feedback and can't click a target twice by accident.
let sharing = false;
function showShareLine(text, spinning) {
  els.historyList.innerHTML = "";
  const li = document.createElement("li");
  li.className = "share-result" + (spinning ? " spinning" : "");
  li.textContent = text;
  els.historyList.appendChild(li);
  return li;
}
function showShareResult(text) {
  showShareLine(text, false);
  setTimeout(() => { if (!els.historyPanel.classList.contains("hidden")) renderHistoryList(); }, 1500);
}

// Inject ONE conversation's compressed summary into another as background CONTEXT
// (a primed user→assistant pair in the model history), NOT as visible chat bubbles.
// The conversation shows a single discreet "📎 imported" note. Re-importing the same
// source is blocked, and concurrent clicks are ignored (no accidental loops).
async function injectContext(source, target) {
  if (sharing) return;
  sharing = true;
  showShareLine(t("share.importing"), true); // immediate "something is happening" signal
  try {
    const src = await getConversation(source.id);
    if (!src) { showShareResult(t("share.none")); return; }
    const srcTitle = displayTitleFor(src);
    const tgtTitleFor = (c) => displayTitleFor(c);
    const summary = compressConversation(src); // local + instant
    const modelNote = `[Imported context from a previous conversation titled "${srcTitle}"]\n${summary}\n[End of imported context]`;
    const ack = "Understood — I'll take that imported context into account in my answers.";
    const noteItem = { role: "note", kind: "note", text: t("share.injected", { title: srcTitle }) };

    if (target.id === convId) {
      const sess = getSession(mode);
      if ((sess.importedSources || []).includes(source.id)) { showShareResult(t("share.already")); return; }
      history.push({ role: "user", content: modelNote });
      history.push({ role: "assistant", content: ack });
      transcript.push(noteItem);
      sess.importedSources = [...(sess.importedSources || []), source.id];
      syncSessionFromGlobals(mode);
      renderTranscriptItem(noteItem);
      els.empty.classList.add("hidden");
      await saveCurrent();
      showShareResult(t("share.done", { title: srcTitle }));
    } else {
      const tgt = await getConversation(target.id);
      if (!tgt) { showShareResult(t("share.none")); return; }
      tgt.importedSources = tgt.importedSources || [];
      if (tgt.importedSources.includes(source.id)) { showShareResult(t("share.already")); return; }
      tgt.nativeHistory = tgt.nativeHistory || [];
      tgt.transcript = tgt.transcript || [];
      tgt.nativeHistory.push({ role: "user", content: modelNote });
      tgt.nativeHistory.push({ role: "assistant", content: ack });
      tgt.transcript.push(noteItem);
      tgt.importedSources.push(source.id);
      await saveConversation(tgt);
      showShareResult(t("share.addedTo", { title: tgtTitleFor(tgt) }));
    }
  } finally {
    sharing = false;
  }
}
// Persist a SPECIFIC session (bound to its own convId/mode) so an answer that
// finishes after the user has switched tabs is still saved to the right place.
async function saveSession(sess, m, sel) {
  if (!settings.saveHistory || !sess.transcript.length) return;
  // A manual rename (customTitle) is sticky; otherwise derive the title from the prompt.
  const title = sess.customTitle || titleFrom(sess.transcript);
  await saveConversation({
    id: sess.convId, title, customTitle: sess.customTitle || "", updatedAt: Date.now(), mode: m,
    providerId: sel.providerId, model: sel.modelId, transcript: sess.transcript, nativeHistory: sess.history,
    importedSources: sess.importedSources || [],
  });
}
async function saveCurrent() {
  return saveSession(getSession(mode), mode, currentSelection());
}
function renderTranscriptItem(item) {
  if (item.kind === "note") {
    return addMessage("tool", item.text); // discreet system note (e.g. imported context)
  } else if (item.role === "user") {
    const d = addMessage("user", item.text);
    if (item.atts) renderUserAttachments(d, item.atts);
    return d;
  } else if (item.kind === "image") {
    const wrap = addMessage("assistant", "");
    if (item.badge) {
      const b = document.createElement("div");
      b.className = "model-badge";
      b.textContent = item.badge;
      wrap.appendChild(b);
    }
    for (const u of item.urls || []) {
      const img = document.createElement("img");
      img.src = u; img.className = "gen-image"; wrap.appendChild(img);
    }
    return wrap;
  } else {
    const el = addMessage("assistant", "");
    el.innerHTML = renderMarkdown(item.text || "");
    enhanceArtifacts(el);
    return el;
  }
}
async function loadConversation(id) {
  const c = await getConversation(id);
  if (!c) return;
  clearMessages();
  transcript = c.transcript || [];
  history = c.nativeHistory || [];
  convId = c.id;
  lastUserContent = ""; // a loaded conversation has no pending "compare" target
  getSession(mode).pageCtxKeys = new Set(); // re-attach page context once for this thread
  getSession(mode).customTitle = c.customTitle || ""; // keep a manual rename
  getSession(mode).importedSources = c.importedSources || []; // keep dedup of imports
  syncSessionFromGlobals(mode); // these new arrays become this tab's live session
  for (const item of transcript) renderTranscriptItem(item);
  els.empty.classList.add("hidden");
  els.historyPanel.classList.add("hidden");
}
function clearMessages() {
  els.messages.querySelectorAll(".msg, .think").forEach((n) => n.remove());
}
// Reset the view to a brand-new empty conversation (no saving).
function startFreshChat() {
  history = [];
  transcript = [];
  convId = newConversationId();
  lastUserContent = "";
  getSession(mode).pageCtxKeys = new Set();
  getSession(mode).customTitle = "";
  getSession(mode).importedSources = [];
  syncSessionFromGlobals(mode); // the fresh arrays are this tab's live session
  clearMessages();
  els.empty.classList.remove("hidden");
  updateEmptyState();
}
async function newChat() {
  await saveCurrent();
  startFreshChat();
  // If the history panel is open, show the fresh conversation right away (it appears
  // as "New conversation · Current" until the first prompt names it).
  if (!els.historyPanel.classList.contains("hidden")) renderHistoryList();
}

// ----- In-conversation search -----------------------------------------------
// Find terms in the current conversation's messages and jump between matches,
// instead of re-prompting. Matches are wrapped in <mark> and navigated with
// prev/next (or Enter / Shift+Enter). Highlights are stripped on close.
let searchHits = [];
let searchIdx = -1;
function clearSearchHighlights() {
  els.messages.querySelectorAll("mark.search-hit").forEach((m) => m.replaceWith(document.createTextNode(m.textContent)));
  els.messages.normalize();
  searchHits = []; searchIdx = -1;
}
function wrapMatches(textNode, needle) {
  const text = textNode.nodeValue, lower = text.toLowerCase();
  let idx = lower.indexOf(needle);
  if (idx < 0) return;
  const frag = document.createDocumentFragment();
  let last = 0;
  while (idx >= 0) {
    if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
    const mark = document.createElement("mark");
    mark.className = "search-hit";
    mark.textContent = text.slice(idx, idx + needle.length);
    frag.appendChild(mark);
    last = idx + needle.length;
    idx = lower.indexOf(needle, last);
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  textNode.parentNode.replaceChild(frag, textNode);
}
function highlightIn(root, needle) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || !n.nodeValue.toLowerCase().includes(needle)) return NodeFilter.FILTER_REJECT;
      if (n.parentNode && n.parentNode.nodeName === "MARK") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  let n; while ((n = walker.nextNode())) targets.push(n);
  for (const node of targets) wrapMatches(node, needle);
}
function focusHit() {
  searchHits.forEach((m, i) => m.classList.toggle("current", i === searchIdx));
  const cur = searchHits[searchIdx];
  if (cur) cur.scrollIntoView({ block: "center", behavior: "smooth" });
}
function updateSearchCount() {
  if (searchHits.length) els.searchCount.textContent = t("search.count", { i: searchIdx + 1, n: searchHits.length });
  else els.searchCount.textContent = els.searchInput.value.trim() ? t("search.none") : "";
}
function runSearch(q) {
  clearSearchHighlights();
  const needle = (q || "").trim().toLowerCase();
  if (needle) els.messages.querySelectorAll(".msg").forEach((msg) => highlightIn(msg, needle));
  searchHits = Array.from(els.messages.querySelectorAll("mark.search-hit"));
  searchIdx = searchHits.length ? 0 : -1;
  focusHit();
  updateSearchCount();
}
function gotoHit(delta) {
  if (!searchHits.length) return;
  searchIdx = (searchIdx + delta + searchHits.length) % searchHits.length;
  focusHit();
  updateSearchCount();
}
function openSearch() {
  els.searchBar.classList.remove("hidden");
  els.searchInput.focus(); els.searchInput.select();
  if (els.searchInput.value.trim()) runSearch(els.searchInput.value);
}
function closeSearch() {
  els.searchBar.classList.add("hidden");
  clearSearchHighlights();
  updateSearchCount();
}
function toggleSearch() {
  if (els.searchBar.classList.contains("hidden")) openSearch(); else closeSearch();
}

// ----- Pending actions (from the right-click context menu) ------------------
// The background script writes a `pendingAction` to storage when a context-menu item
// is clicked, then tries to open the sidebar. We consume it on load AND whenever it
// changes — so it works whether the sidebar was closed (opens → init) or ALREADY OPEN
// (the storage listener catches it). The ts guard prevents a double-run.
let lastPendingTs = 0;
async function consumePendingAction() {
  const { pendingAction } = await browser.storage.local.get("pendingAction");
  if (!pendingAction || Date.now() - pendingAction.ts > 60000) return;
  if (pendingAction.ts === lastPendingTs) return; // already handled
  lastPendingTs = pendingAction.ts;
  await browser.storage.local.remove("pendingAction");
  if (mode !== "chat" && mode !== "agent") setMode("chat"); // quick actions render in the chat area
  runQuickAction(pendingAction.action, pendingAction.text);
}

// ----- Wiring ---------------------------------------------------------------
function wire() {
  // Searchable model combobox (main picker).
  mainCombo = makeCombo({
    input: els.modelInput, menu: els.modelMenu,
    items: () => (mode === "image" ? imageComboItems() : chatComboItems()),
    getValue: () => mainValue, onPick: onMainPick,
  });
  // Close the combo menu when clicking outside it; also cancel element-pick mode when
  // the user clicks back in the sidebar (anywhere but the pick button).
  document.addEventListener("mousedown", (e) => {
    if (mainCombo.isOpen() && e.target !== els.modelInput && !els.modelMenu.contains(e.target)) mainCombo.close();
    if (picking && !els.pickEl.contains(e.target)) cancelPicking();
    if (capturing && !els.captureRegion.contains(e.target)) cancelCapture();
  });
  // Esc cancels element-pick / region-capture mode even when focus is in the sidebar.
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { if (picking) cancelPicking(); if (capturing) cancelCapture(); } });

  // Open the sidebar as a full-screen browser tab (hidden when already in a tab).
  if (IS_TAB) els.expandTab.hidden = true;
  else els.expandTab.addEventListener("click", openInTab);

  // Click the brand/logo to show or hide the workspace tabs rail.
  els.brand.addEventListener("click", toggleRail);

  // Composer: attachments (+).
  els.attachBtn.addEventListener("click", () => els.attachInput.click());
  els.attachInput.addEventListener("change", async (e) => {
    await addAttachmentFiles(e.target.files);
    e.target.value = ""; // allow re-selecting the same file
  });

  // Paste (Ctrl+V) an image / screenshot directly into the input → attach it.
  // Plain-text pastes fall through to the textarea's default behaviour.
  els.input.addEventListener("paste", async (e) => {
    const dt = e.clipboardData;
    if (!dt) return;
    let files = Array.from(dt.files || []);
    if (!files.length) {
      files = Array.from(dt.items || [])
        .filter((it) => it.kind === "file")
        .map((it) => it.getAsFile())
        .filter(Boolean);
    }
    if (!files.length) return; // nothing but text — let the browser paste it
    e.preventDefault();
    if (mode === "code" || mode === "image") setMode("chat");
    await addAttachmentFiles(files);
    els.input.focus();
  });

  // Drag & drop files anywhere on the sidebar to attach them (in addition to +).
  let dragDepth = 0;
  const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  const showDrop = (on) => els.dropOverlay.classList.toggle("hidden", !on);
  window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; showDrop(true); });
  window.addEventListener("dragover", (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; showDrop(false); } });
  window.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; showDrop(false);
    const files = e.dataTransfer.files;
    if (!files || !files.length) return;
    if (mode === "code") setMode("chat");          // Code/Image have no attachment context
    if (mode === "pdf" && files[0] && /\.pdf$/i.test(files[0].name)) { loadPdfFile(files[0]); return; }
    if (mode === "image") setMode("chat");
    await addAttachmentFiles(files);
    els.input.focus();
  });

  // Model filter popover (price tiers + providers / OpenRouter sub-vendors).
  els.modelFilterBtn.addEventListener("click", () => toggleFilterPanel(els.modelFilterBtn));
  els.modelFilterPanel.querySelectorAll(".ftier-cb").forEach((cb) => cb.addEventListener("change", onTierFilterChange));
  els.filterReset.addEventListener("click", resetFilter);
  els.filterClose.addEventListener("click", () => els.modelFilterPanel.classList.add("hidden"));
  document.addEventListener("click", (e) => {
    if (els.modelFilterPanel.classList.contains("hidden")) return;
    if (els.modelFilterPanel.contains(e.target) || els.modelFilterBtn.contains(e.target)) return;
    els.modelFilterPanel.classList.add("hidden");
  });

  const bindToggle = (el, key, after) =>
    el.addEventListener("change", async () => {
      settings[key] = el.checked;
      await setSettings({ [key]: el.checked });
      if (after) after();
    });
  bindToggle(els.thinking, "thinking");
  bindToggle(els.webSearch, "webSearch");
  bindToggle(els.pageCtx, "includePageContext", updatePageBar);

  els.rail.querySelectorAll(".railtab").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  els.openCodeApp.addEventListener("click", openCodeApp);

  // PDF workspace controls
  els.pdfLoad.addEventListener("click", () => els.pdfFile.click());
  els.pdfFile.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) loadPdfFile(f);
    e.target.value = ""; // allow re-loading the same file
  });
  els.pdfSummarize.addEventListener("click", pdfSummarizeAction);
  els.pdfImages.addEventListener("click", pdfExtractImages);
  els.pdfText.addEventListener("click", pdfExtractTextAction);

  els.translateLang.addEventListener("change", async () => {
    settings.targetLang = els.translateLang.value;
    await setSettings({ targetLang: settings.targetLang });
  });
  els.improvePreset.addEventListener("change", async () => {
    settings.improvePreset = els.improvePreset.value;
    await setSettings({ improvePreset: settings.improvePreset });
  });
  els.imageSize.addEventListener("change", async () => {
    settings.imageSize = els.imageSize.value;
    await setSettings({ imageSize: settings.imageSize });
  });

  // In-conversation search (🔍 in the top bar).
  els.searchBtn.addEventListener("click", toggleSearch);
  els.searchInput.addEventListener("input", () => runSearch(els.searchInput.value));
  els.searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); gotoHit(e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
  });
  els.searchPrev.addEventListener("click", () => gotoHit(-1));
  els.searchNext.addEventListener("click", () => gotoHit(1));
  els.searchClose.addEventListener("click", closeSearch);

  els.historyBtn.addEventListener("click", async () => {
    const show = els.historyPanel.classList.contains("hidden");
    if (show) await renderHistoryList();
    els.historyPanel.classList.toggle("hidden");
  });
  els.deleteSelected.addEventListener("click", deleteSelectedConversations);
  els.clearHistory.addEventListener("click", async () => {
    // Per-tab: clear only THIS workspace's saved conversations (the panel is filtered).
    const all = await listConversations();
    for (const c of all.filter((c) => (c.mode || "chat") === mode)) await deleteConversation(c.id);
    startFreshChat(); // the open one is gone too — start clean
    renderHistoryList();
  });
  els.closeHistory.addEventListener("click", () => els.historyPanel.classList.add("hidden"));

  // Clicking ANYWHERE on the page bar expands/collapses the tabs panel — except the
  // 🖱 pick button, which launches element capture instead.
  els.pageBar.addEventListener("click", async (e) => {
    if (els.pickEl.contains(e.target) || els.captureRegion.contains(e.target)) return;
    const show = els.tabsPanel.classList.contains("hidden");
    if (show) await buildTabsList();
    els.tabsPanel.classList.toggle("hidden");
  });
  els.pickEl.addEventListener("click", (e) => {
    e.stopPropagation();
    if (picking) return cancelPicking();
    ensurePagePermission().then((ok) => (ok ? pickElement() : addMessage("error", t("region.perm"))));
  });
  els.captureRegion.addEventListener("click", (e) => {
    e.stopPropagation();
    if (capturing) return cancelCapture();
    ensurePagePermission().then((ok) => (ok ? captureRegion() : addMessage("error", t("region.perm"))));
  });
  els.tabsRefresh.addEventListener("click", (e) => { e.stopPropagation(); buildTabsList(); });
  els.tabsList.addEventListener("change", persistSelectedTabs);

  // No Send button — Enter sends (Shift+Enter = newline).
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); }
  });
  els.input.addEventListener("input", autoGrow);
  els.stop.addEventListener("click", () => abortController && abortController.abort());
  els.newChat.addEventListener("click", newChat);

  els.openOptions.addEventListener("click", () => browser.runtime.openOptionsPage());
  els.modelConnect.addEventListener("click", () => browser.runtime.openOptionsPage());
  if (els.emptyOptions) els.emptyOptions.addEventListener("click", () => browser.runtime.openOptionsPage());
  if (els.freeConnect) els.freeConnect.addEventListener("click", doFreeConnect);

  // React only to connection/model changes. Ignoring churn from our own frequent
  // writes (terminalSession on every terminal message, mode, selectedTabs…) avoids
  // rebuilding the pickers mid-stream and re-fetching model lists in a loop — that
  // feedback was what glitched the sidebar when switching the Terminal model.
  onSettingsChanged(async (changes) => {
    // A UI-language switch in Settings: reload so every static + dynamic string is
    // rebuilt in the new language (simplest and fully consistent).
    if (changes.uiLang) { location.reload(); return; }
    if (changes.railSide) document.body.classList.toggle("rail-right", changes.railSide.newValue === "right");
    if (changes.railHidden) document.body.classList.toggle("rail-collapsed", !!changes.railHidden.newValue);
    if (changes.theme || changes.themeColors) {
      const s2 = await getSettings();
      applyTheme(s2.theme || "dark", s2.themeColors);
      updateActionIcon();              // keep the browser icon in sync with the theme
    }
    const connChanged = !!(changes.keys || changes.baseUrls || changes.localEnabled);
    if (!connChanged && !changes.modelLists && !changes.orModels && !changes.codeAppUrl && !changes.orFreeOnly) return;
    settings = await getSettings();
    updateImageNote();
    refreshModelUI();
    if (changes.codeAppUrl) updateCodeLauncher();
    if (connChanged) autoListConnected();
  });
}

function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 200) + "px";
}
function resetComposerHeight() { els.input.style.height = "auto"; }

// ----- Message rendering ----------------------------------------------------
function addMessage(role, text) {
  els.empty.classList.add("hidden");
  const div = document.createElement("div");
  div.className = "msg " + role;
  div.textContent = text || "";
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  return div;
}
// Render attachment thumbnails/chips inside a user message bubble.
function renderUserAttachments(div, meta) {
  if (!meta || !meta.length) return;
  const box = document.createElement("div");
  box.className = "att-thumbs";
  for (const a of meta) {
    if (a.type === "image" && a.dataUrl) {
      const img = document.createElement("img"); img.src = a.dataUrl; img.alt = a.name || ""; box.appendChild(img);
    } else {
      const f = document.createElement("span"); f.className = "att-file"; f.textContent = (a.isPdf ? "📄 " : "📎 ") + (a.name || "file"); box.appendChild(f);
    }
  }
  div.appendChild(box);
}
function addThinkBlock() {
  els.empty.classList.add("hidden");
  const d = document.createElement("details");
  d.className = "think";
  d.open = true;
  const s = document.createElement("summary");
  s.textContent = t("chip.thinking");
  const body = document.createElement("div");
  body.className = "think-body";
  d.appendChild(s);
  d.appendChild(body);
  els.messages.appendChild(d);
  els.messages.scrollTop = els.messages.scrollHeight;
  return body;
}

// Animated "the model is working" indicator, shown from the moment we send until
// the first token (or reasoning) streams back — so the response area is never blank
// while we wait. Cycles a few phrases with a pulsing-dots animation.
function addPendingIndicator() {
  els.empty.classList.add("hidden");
  const wrap = addMessage("assistant", "");
  wrap.classList.add("pending-msg");
  const ind = document.createElement("div");
  ind.className = "typing";
  const dots = document.createElement("span");
  dots.className = "typing-dots";
  for (let k = 0; k < 3; k++) dots.appendChild(document.createElement("i"));
  const label = document.createElement("span");
  label.className = "typing-label";
  const phrases = [t("think.working"), t("think.reading"), t("think.reasoning"), t("think.almost")];
  let pi = 0;
  label.textContent = phrases[0] + "…";
  ind.appendChild(dots); ind.appendChild(label);
  wrap.appendChild(ind);
  els.messages.scrollTop = els.messages.scrollHeight;
  wrap._iv = setInterval(() => { pi = (pi + 1) % phrases.length; label.textContent = phrases[pi] + "…"; }, 1800);
  return wrap;
}
function removePending(node) {
  if (!node) return;
  if (node._iv) { clearInterval(node._iv); node._iv = null; }
  node.remove();
}

// Streaming sink: owns one assistant card (+ optional model badge) and its
// thinking block. Used for a normal turn and for each compare run. `pendingEl` is
// the animated waiting indicator, removed as soon as the first content arrives.
function makeSink(badgeLabel, showThink = true, pendingEl = null) {
  let el = null, contentEl = null, raw = "", think = null;
  const dropPending = () => { if (pendingEl) { removePending(pendingEl); pendingEl = null; } };
  const ensure = () => {
    if (el) return;
    el = addMessage("assistant", "");
    if (badgeLabel) {
      const b = document.createElement("div");
      b.className = "model-badge";
      b.textContent = badgeLabel;
      el.appendChild(b);
    }
    contentEl = document.createElement("div");
    el.appendChild(contentEl);
  };
  return {
    onText(delta) {
      dropPending();
      ensure();
      raw += delta;
      contentEl.innerHTML = renderMarkdown(raw);
      els.messages.scrollTop = els.messages.scrollHeight;
    },
    onThink(delta) {
      // Only surface reasoning when the 💭 toggle is ON. Some models (DeepSeek R1,
      // o-series, OpenRouter reasoning models) stream reasoning regardless of the
      // request, so we gate the DISPLAY here — that's the "reasoning shows even when
      // unchecked" fix.
      if (!showThink) return;
      dropPending();
      if (!think) think = addThinkBlock();
      think.textContent += delta;
      els.messages.scrollTop = els.messages.scrollHeight;
    },
    finalize() {
      dropPending();
      if (contentEl) { contentEl.innerHTML = renderMarkdown(raw); enhanceArtifacts(contentEl); }
    },
    getRaw: () => raw,
    getEl: () => el,
  };
}

// OpenRouter free-tier failures (data-policy gate / model unavailable / rate limit)
// deserve an actionable message instead of a raw HTTP error.
function isOpenRouterFreeError(providerId, msg) {
  if (providerId !== "openrouter") return false;
  return /no endpoints|data policy|privacy|404|not found|rate.?limit|429/i.test(msg || "");
}
function showRunError(providerId, e, modelId) {
  if (e && e.name === "AbortError") { addMessage("tool", t("msg.interrupted")); return; }
  const msg = e && e.message ? e.message : String(e);
  if (isOpenRouterFreeError(providerId, msg)) {
    if (modelId) handleOpenRouterUnavailable(modelId);
    addOpenRouterFreeError();
  } else {
    addMessage("error", t("err.generic", { msg }));
  }
}
// The OpenRouter free-tier error, with a one-click link straight to the privacy
// page where free model endpoints are enabled.
function addOpenRouterFreeError() {
  const div = addMessage("error", t("err.orFree"));
  div.appendChild(document.createElement("br"));
  const a = document.createElement("a");
  a.href = "https://openrouter.ai/settings/privacy";
  a.textContent = t("or.enableLink");
  a.style.color = "#b9a7ff";
  a.style.fontWeight = "700";
  a.addEventListener("click", (e) => {
    e.preventDefault();
    try { browser.tabs.create({ url: a.href }); } catch (_) { window.open(a.href, "_blank", "noopener"); }
  });
  div.appendChild(a);
}
// Drop an OpenRouter model that the account can't use from the picker, and switch
// the active selection to the next best free model so the user isn't stuck on it.
function handleOpenRouterUnavailable(modelId) {
  if (!modelId || orUnavailable.has(modelId)) return;
  orUnavailable.add(modelId);
  const list = (settings.orModels || []).filter((m) => !orUnavailable.has(m.id));
  if ((settings.models && settings.models.openrouter) === modelId) {
    const pick = bestFreeOpenRouter(settings.orModels || []);
    if (pick && pick !== modelId) {
      settings.models = { ...(settings.models || {}), openrouter: pick };
      setSettings({ models: settings.models });
      addMessage("tool", t("or.switched", { model: pick }));
    }
  }
  refreshModelUI();
}
function currentKeyMissing(providerId) {
  const meta = PROVIDERS[providerId];
  if (!meta || !meta.needsKey) return false;
  return !keyFor(providerId, settings);
}
function confirmAction(name, input) {
  return new Promise((resolve) => {
    // A sensitive action (download / reserve / delete / sign-up…) gets a clear warning
    // and shows what it's about to do; ordinary (manual-mode) actions use the generic text.
    if (input && input.sensitive) {
      const what = input.label || input.url || "";
      els.confirmText.textContent = t("confirm.sensitive", { action: input.sensitive, what: String(what).slice(0, 80) });
    } else {
      els.confirmText.textContent = t("confirm.prompt", { name, input: JSON.stringify(input).slice(0, 120) });
    }
    els.confirmBar.classList.remove("hidden");
    const cleanup = (v) => {
      els.confirmBar.classList.add("hidden");
      els.confirmAllow.removeEventListener("click", onAllow);
      els.confirmDeny.removeEventListener("click", onDeny);
      resolve(v);
    };
    const onAllow = () => cleanup(true);
    const onDeny = () => cleanup(false);
    els.confirmAllow.addEventListener("click", onAllow);
    els.confirmDeny.addEventListener("click", onDeny);
  });
}
// ----- Efficiency: context cleaning + cheap-model routing + compaction -------
// Trim boilerplate so the user pays only for meaningful tokens (and gets a faster
// first token from a smaller prompt). Lossless-ish: we collapse whitespace, drop
// blank/duplicate consecutive lines and obvious chrome ("cookie", "menu" one-liners
// repeated). Only runs when settings.cleanContext is on.
function cleanText(s) {
  if (!s) return "";
  if (!settings.cleanContext) return s;
  const lines = String(s).replace(/\r/g, "").split("\n");
  const out = [];
  let prev = null, blank = 0;
  for (let raw of lines) {
    const line = raw.replace(/[ \t ]+/g, " ").trim();
    if (!line) { if (++blank > 1) continue; out.push(""); prev = null; continue; }
    blank = 0;
    if (line === prev) continue;          // drop immediate duplicate lines
    out.push(line);
    prev = line;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
// Total characters across a native history (≈4 chars/token) — used only to decide
// WHEN to compact the conversation.
function historyChars(h) {
  let n = 0;
  for (const m of h || []) {
    const c = m && m.content;
    if (typeof c === "string") n += c.length;
    else if (Array.isArray(c)) for (const p of c) n += (p && p.text ? p.text.length : 0);
  }
  return n;
}

// The cheap "housekeeping" model used for summaries / compaction / auto-titles when
// smartRouting is on, so the premium model the user picked is spent only on answers.
// settings.utilityModel pins one; "" = auto-pick the cheapest FREE connected model
// (a free OpenRouter model, else the current selection as a last resort).
function utilitySelection() {
  if (settings.utilityModel) {
    const u = parseSel(settings.utilityModel);
    if (u.providerId && !currentKeyMissing(u.providerId)) return u;
  }
  if (isConnectedFree("openrouter") && settings.orModels && settings.orModels.length) {
    const free = settings.orModels
      .filter((m) => !m.prompt && !m.completion && !orUnavailable.has(m.id))
      .sort((a, b) => a.id.length - b.id.length); // shortest id ≈ smallest/fastest free model
    if (free.length) return { providerId: "openrouter", modelId: free[0].id };
  }
  return currentSelection();
}
function isConnectedFree(pid) { return !currentKeyMissing(pid) && providersToShow().includes(pid); }

// One-shot, non-streaming-ish completion on a given model. Returns plain text.
async function runUtilityCompletion(sel, system, userText, signal) {
  const provider = makeProvider(
    { ...settings, provider: sel.providerId, models: { ...settings.models, [sel.providerId]: sel.modelId } },
    { thinking: false, webSearch: false }
  );
  const turn = await provider.runTurn({
    system, history: [{ role: "user", content: userText }], tools: [],
    onText: null, onThink: null, signal,
  });
  return (turn && turn.text || "").trim();
}

// Compact a session's NATIVE history when it grows past the budget: summarise the
// OLD turns with the cheap model and keep only the recent ones verbatim. The UI
// transcript is untouched — the user still sees everything; only the model payload
// shrinks (that's the token saving). No-op for agent mode (tool messages) or when
// disabled. Returns true if it compacted.
const COMPRESS_TRIGGER_CHARS = 28000; // ~7k tokens of native history → start compacting
const COMPRESS_KEEP_TAIL = 6;         // recent native messages always kept verbatim
let compressing = false;
async function maybeCompressSession(sess, sessMode, signal) {
  if (!settings.compressHistory || compressing) return false;
  if (sessMode === "agent") return false; // keep tool-call sequences intact
  const h = sess.history;
  if (!Array.isArray(h) || h.length <= COMPRESS_KEEP_TAIL + 2) return false;
  if (historyChars(h) < COMPRESS_TRIGGER_CHARS) return false;
  // Find a cut point that keeps the tail starting on a USER message (valid for both
  // wire formats), so we never break role alternation.
  let cut = Math.max(1, h.length - COMPRESS_KEEP_TAIL);
  while (cut < h.length && h[cut].role !== "user") cut++;
  if (cut >= h.length) return false;
  const older = h.slice(0, cut);
  const olderText = older.map((m) => {
    const c = m.content;
    const txt = typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p && p.text || "").join(" ") : "";
    return `${m.role === "assistant" ? "Assistant" : "User"}: ${txt}`;
  }).join("\n").slice(0, 24000);
  if (!olderText.trim()) return false;
  let summary = "";
  try {
    compressing = true;
    const sel = settings.smartRouting ? utilitySelection() : currentSelection();
    summary = await runUtilityCompletion(
      sel,
      "You compress chat history. Produce a dense, faithful summary that preserves names, facts, decisions, code identifiers and open questions, so the assistant can continue seamlessly. No preamble.",
      `Summarise the earlier part of this conversation in under 200 words:\n\n${olderText}`,
      signal
    );
  } catch (_) {
    summary = ""; // on any failure, fall back to a local truncation below
  } finally {
    compressing = false;
  }
  if (!summary) summary = olderText.slice(0, 1500); // safe local fallback
  const note = `[Earlier conversation summary — older messages were compacted to save tokens]\n${summary}\n\n[End of summary]`;
  // Prepend the summary INTO the first kept (user) message so we don't introduce a
  // stray message that could break alternation on strict APIs.
  const tail = h.slice(cut);
  const first = tail[0];
  if (typeof first.content === "string") {
    first.content = note + "\n\n" + first.content;
  } else if (Array.isArray(first.content)) {
    const ti = first.content.findIndex((p) => p && p.type === "text");
    if (ti >= 0) first.content[ti] = { ...first.content[ti], text: note + "\n\n" + first.content[ti].text };
    else first.content.unshift({ type: "text", text: note });
  }
  sess.history = tail;
  if (mode === sessMode) history = sess.history; // keep the live global pointing at the compacted array
  if (mode === sessMode) addMessage("tool", t("ctx.compacted"));
  return true;
}

function pageContextBlock() {
  if (!currentPage) return "";
  const ctx = cleanText((currentPage.text || "")).slice(0, settings.maxPageChars);
  return (
    `[Active page context]\nTitle: ${currentPage.title}\nURL: ${currentPage.url}\n` +
    (currentPage.description ? `Description: ${currentPage.description}\n` : "") + `${ctx}\n\n`
  );
}
async function getSelection() {
  try {
    const sel = await executeTool("read_selection", {}, {});
    return (sel && sel.selection) || "";
  } catch (_) { return ""; }
}
function startBusy() {
  busy = true;
  els.stop.classList.remove("hidden"); // Stop button appears while streaming (no Send button — Enter sends)
  abortController = new AbortController();
}
function endBusy() {
  els.stop.classList.add("hidden");
  abortController = null;
  busy = false;
}

// ----- Per-message comparison ----------------------------------------------
// Add a "compare with another model" bar under the latest assistant answer.
function attachCompareBar(el) {
  els.messages.querySelectorAll(".msg-actions").forEach((n) => n.remove());
  if (!el || !lastUserContent) return;
  const bar = document.createElement("div");
  bar.className = "msg-actions";
  const lbl = document.createElement("span");
  lbl.className = "cmp-lbl";
  lbl.textContent = t("compare.with");
  const sel = document.createElement("select");
  sel.className = "cmp-select";
  fillModelSelect(sel, null);
  // Default to a model different from the current one.
  for (const opt of sel.options) {
    if (opt.value && opt.value !== mainValue) { sel.value = opt.value; break; }
  }
  const btn = document.createElement("button");
  btn.className = "cmp-btn";
  btn.textContent = t("compare.btn");
  btn.addEventListener("click", () => compareLast(parseSel(sel.value), btn));
  bar.appendChild(lbl);
  bar.appendChild(sel);
  bar.appendChild(btn);
  el.appendChild(bar);
  applyModelFilter(); // honour the active price/provider filter in the compare list
}

async function compareLast(second, btn) {
  if (busy || !lastUserContent) return;
  if (currentKeyMissing(second.providerId)) {
    addMessage("error", t("err.keyMissingFor", { label: PROVIDERS[second.providerId].label }));
    return;
  }
  btn.disabled = true;
  startBusy();
  let cmpPending = null;
  const badge = `${PROVIDERS[second.providerId].label} · ${second.modelId}`;
  try {
    const provider = makeProvider(
      { ...settings, provider: second.providerId, models: { ...settings.models, [second.providerId]: second.modelId } },
      { thinking: els.thinking.checked, webSearch: els.webSearch.checked || lastForceWeb }
    );
    const system = buildSystemPrompt({ agentMode: false, targetLang: settings.targetLang, responseLang: settings.responseLang, mode: lastRunMode, blockPayments: settings.blockPayments });
    cmpPending = addPendingIndicator();
    const sink = makeSink(badge, els.thinking.checked, cmpPending);
    await runConversation({ provider, system, history: [{ role: "user", content: lastUserContent }], tools: [], onText: sink.onText, onThink: sink.onThink, signal: abortController.signal });
    sink.finalize();
    if (sink.getRaw()) transcript.push({ role: "assistant", text: `**${badge}**\n\n${sink.getRaw()}` });
    attachCompareBar(sink.getEl()); // allow comparing again with yet another model
  } catch (e) {
    removePending(cmpPending);
    showRunError(second.providerId, e, second.modelId);
  } finally {
    removePending(cmpPending);
    endBusy();
    btn.disabled = false;
    await saveCurrent();
  }
}

// ----- Core send ------------------------------------------------------------
async function sendToModel(displayText, modelContent, { forceWeb = false, runMode = "chat", attImgs = [], attMeta = [] } = {}) {
  if (busy) return;
  const sel = currentSelection();
  if (currentKeyMissing(sel.providerId)) {
    addMessage("error", t("err.noKeyModel"));
    return;
  }
  // Remember the last-used provider + model as the default for next time
  // (single atomic write — see applyModelChoice).
  if (sel.providerId && sel.modelId) {
    settings.provider = sel.providerId;
    settings.models = { ...(settings.models || {}), [sel.providerId]: sel.modelId };
    setSettings({ provider: sel.providerId, models: settings.models });
  }
  // Bind this send to the conversation that is active RIGHT NOW. If the user
  // switches workspace/discussion while the answer is still streaming, the globals
  // get re-pointed — but we keep pushing into THIS session, so the AI's answer is
  // never lost or misrouted (that's the "Chat loses responses on switch" fix).
  const sess = getSession(mode);
  const sessMode = mode;
  const userDiv = addMessage("user", displayText);
  if (attMeta && attMeta.length) renderUserAttachments(userDiv, attMeta);
  sess.transcript.push({ role: "user", text: displayText, atts: attMeta && attMeta.length ? attMeta : undefined });
  lastUserContent = modelContent;
  lastRunMode = runMode;
  lastForceWeb = forceWeb;
  startBusy();

  const wantWeb = els.webSearch.checked || forceWeb;
  const agentMode = agentActive();

  // Web-search routing: send the turn to a dedicated web-capable model (Perplexity
  // Sonar, or a free OpenRouter model with the "web" plugin) instead of e.g. Claude.
  // When that model lives on a DIFFERENT provider we run it as an isolated single
  // turn, so two providers' native message formats never get mixed in the shared
  // history. (Skipped in agent mode, which keeps its tools on the chosen model.)
  let turnSel = sel;
  let isolated = false;
  let badge = null;
  if (wantWeb && !agentMode) {
    const ss = parseSel(settings.searchModel || defaultSearchModel(settings));
    if (ss.providerId && !currentKeyMissing(ss.providerId) &&
        (ss.providerId !== sel.providerId || ss.modelId !== sel.modelId)) {
      turnSel = ss;
      isolated = true;
      const lbl = PROVIDERS[ss.providerId] ? PROVIDERS[ss.providerId].label : ss.providerId;
      badge = t("badge.web", { label: lbl, model: ss.modelId });
    }
  }

  // Agent-model override: tool calling fails on many fast/free models (e.g. Llama),
  // so the user can pin a tool-capable model for agent mode in Settings. The agent
  // keeps the shared history (multi-turn tool loop), so it is NOT isolated.
  if (agentMode && settings.agentModel) {
    const as = parseSel(settings.agentModel);
    if (as.providerId && !currentKeyMissing(as.providerId)) {
      turnSel = as;
      if (as.providerId !== sel.providerId || as.modelId !== sel.modelId) {
        const lbl = PROVIDERS[as.providerId] ? PROVIDERS[as.providerId].label : as.providerId;
        badge = t("badge.agent", { label: lbl, model: as.modelId });
      }
    }
  }

  // With image attachments, switch the user turn to the provider's multimodal
  // content array (vision). Text-file attachments are already folded into modelContent.
  const userContent = buildUserContent(modelContent, attImgs, turnSel.providerId);
  let turnHistory;
  if (isolated) {
    turnHistory = [{ role: "user", content: userContent }];
  } else {
    // Token saving: summarise older turns before this one when the thread is long.
    await maybeCompressSession(sess, sessMode, abortController && abortController.signal);
    sess.history.push({ role: "user", content: userContent });
    turnHistory = sess.history;
  }
  const provider = makeProvider(
    { ...settings, provider: turnSel.providerId, models: { ...settings.models, [turnSel.providerId]: turnSel.modelId } },
    { thinking: els.thinking.checked, webSearch: wantWeb }
  );
  const system = buildSystemPrompt({ agentMode, targetLang: settings.targetLang, responseLang: settings.responseLang, mode: runMode, blockPayments: settings.blockPayments });
  const tools = activeTools({ agentMode });
  const pending = addPendingIndicator();
  const sink = makeSink(badge, els.thinking.checked, pending);
  if (agentMode) agentGlowActiveTab(); // glow the page border while the agent works
  try {
    await runConversation({
      provider, system, history: turnHistory, tools,
      onText: sink.onText, onThink: sink.onThink,
      onToolStart: (call) => { sink.finalize(); if (agentMode) agentGlowActiveTab(); addMessage("tool", `→ ${call.name}(${JSON.stringify(call.input).slice(0, 80)})`); },
      onToolEnd: (call, out) => { if (agentMode) agentGlowActiveTab(); addMessage("tool", out && out.blocked ? `   🛡 ${out.error}` : `   ${out && out.error ? "✗ " + out.error : "✓ ok"}`); },
      // Agent permission: "manual" confirms EVERY action; "auto" (Allow, default) runs
      // freely but still confirms VERY SENSITIVE actions (downloads, reserve/book,
      // delete, sign-up, install…). confirmFn is therefore available in BOTH modes; the
      // anti-purchase guard applies in both too.
      confirmActions: settings.agentPermission !== "auto",
      confirmFn: agentMode ? confirmAction : null,
      guard: { blockPayments: settings.blockPayments },
      signal: abortController.signal,
    });
    sink.finalize();
    if (sink.getRaw()) {
      sess.transcript.push({ role: "assistant", text: sink.getRaw() });
      if (mode === sessMode) attachCompareBar(sink.getEl()); // compare bar only if still on this tab
    }
  } catch (e) {
    removePending(pending);
    showRunError(turnSel.providerId, e, turnSel.modelId);
  } finally {
    removePending(pending);
    if (agentMode) clearAgentGlow(); // stop the page-border glow when the agent finishes
    endBusy();
    await saveSession(sess, sessMode, sel);
    // Keep an open history panel in sync (e.g. the new conversation gets its title).
    if (mode === sessMode && !els.historyPanel.classList.contains("hidden")) renderHistoryList();
  }
}

// ----- Send dispatch (per mode) ---------------------------------------------
async function onSend() {
  resetComposerHeight();
  if (mode === "translate") return runTranslateFromInput();
  if (mode === "improve") return runImproveFromInput();
  if (mode === "image") return runImageFromInput();
  if (mode === "pdf") return onPdfSend();
  if (mode === "code") return; // Code workspace has no composer — use the launcher button.
  return onChatSend(); // chat + agent
}
async function onChatSend() {
  const text = els.input.value.trim();
  const { imgs, textBlock, meta } = takeAttachments();
  if (!text && !meta.length) return;
  els.input.value = "";
  clearAttachments();
  let prefix = "";
  if (!agentActive()) {
    // Send a page's content only ONCE per conversation (it stays in history after
    // that), so follow-up questions don't re-pay for the same page text every turn.
    if (els.pageCtx.checked && currentPage) {
      const sess = getSession(mode);
      const key = currentPage.url || "";
      if (!settings.cleanContext || !sess.pageCtxKeys.has(key)) {
        prefix += pageContextBlock();
        sess.pageCtxKeys.add(key);
      }
    }
    prefix += await selectedTabsContext();
  }
  if (textBlock) prefix += textBlock; // attached files/PDFs folded in as context
  const body = text || (imgs.length ? "Please look at the attached image(s)." : "Please use the attached file(s).");
  const content = prefix ? prefix + `[Message]\n${body}` : body;
  await sendToModel(text, content, { attImgs: imgs, attMeta: meta });
}
async function runTranslateFromInput() {
  const lang = els.translateLang.value || "French";
  let txt = els.input.value.trim();
  const { imgs, textBlock, meta } = takeAttachments();
  // Show the actual user input as the message; only fall back to a short label when
  // translating the current page (where the "input" is the whole page text).
  let displayText = txt;
  if (!txt && textBlock) txt = textBlock; // translate an attached file's text
  if (!txt && !imgs.length) {
    txt = currentPage ? (currentPage.text || "").slice(0, settings.maxPageChars) : "";
    displayText = t("label.translatePage");
  } else if (textBlock && displayText) {
    txt = `${txt}\n\n${textBlock}`; // typed text + attached file together
  }
  if (!txt && !imgs.length) return addMessage("error", t("err.nothingToTranslateInput"));
  els.input.value = "";
  clearAttachments();
  await sendToModel(displayText, t("prompt.translate", { lang, text: txt || "(see attached image)" }), { runMode: "translate", attImgs: imgs, attMeta: meta });
}
async function runImproveFromInput() {
  const presetId = els.improvePreset.value || "improve";
  let txt = els.input.value.trim();
  const { imgs, textBlock, meta } = takeAttachments();
  if (!txt) txt = await getSelection();
  if (!txt && textBlock) txt = textBlock; // improve an attached file's text
  else if (textBlock) txt = `${txt}\n\n${textBlock}`;
  if (!txt && !imgs.length) return addMessage("error", t("err.typeOrSelect"));
  els.input.value = "";
  clearAttachments();
  const instruction = t("presetPrompt." + presetId);
  // Show the user's own text as the message (not the preset label).
  await sendToModel(txt, `${instruction}\n${t("improve.only")}\n\n${t("improve.textLabel")}\n${txt}`, { runMode: "improve", attImgs: imgs, attMeta: meta });
}
async function runImageFromInput() {
  const prompt = els.input.value.trim();
  // Image generation has no img2img path here, so any pending attachments are cleared.
  if (attachments.length) clearAttachments();
  if (!prompt) return addMessage("error", t("err.describeImage"));
  els.input.value = "";
  await runImage(prompt);
}

// ----- Quick actions / context menus ----------------------------------------
async function runQuickAction(action, providedText) {
  if (busy) return;
  const lang = settings.targetLang || "French";
  if (action === "image") {
    const prompt = providedText || els.input.value.trim();
    if (!prompt) { setMode("image"); els.input.focus(); return; }
    els.input.value = "";
    return runImage(prompt);
  }
  if (action === "summarize") {
    if (!currentPage) await refreshCurrentPage();
    if (!currentPage) return addMessage("error", t("err.noReadablePage"));
    return sendToModel(t("label.summarizePage"), pageContextBlock() + "[Task]\n" + t("prompt.summarizePage"));
  }
  if (action === "summarize-selection") {
    const txt = providedText || (await getSelection());
    if (!txt) return addMessage("error", t("err.nothingToSummarize"));
    return sendToModel(t("label.summarizeSel"), t("prompt.summarizeSel", { text: txt }));
  }
  if (action === "translate") {
    let txt = providedText || (await getSelection());
    let label = t("label.translateSel");
    if (!txt && currentPage) { txt = (currentPage.text || "").slice(0, settings.maxPageChars); label = t("label.translatePage"); }
    if (!txt) return addMessage("error", t("err.nothingToTranslate"));
    return sendToModel(label, t("prompt.translate", { lang, text: txt }), { runMode: "translate" });
  }
  if (action === "improve") {
    const txt = providedText || (await getSelection());
    if (!txt) return addMessage("error", t("err.selectToImprove"));
    return sendToModel(t("label.improve"), t("prompt.improve", { text: txt }), { runMode: "improve" });
  }
  if (action === "explain") {
    const txt = providedText || (await getSelection());
    if (!txt) return addMessage("error", t("err.nothingToExplain"));
    return sendToModel(t("label.explain"), t("prompt.explain", { text: txt }));
  }
  if (action === "reply") {
    const txt = providedText || (await getSelection());
    if (!txt) return addMessage("error", t("err.noMessageToReply"));
    return sendToModel(t("label.reply"), t("prompt.reply", { lang, text: txt }));
  }
}

// ----- Image generation -----------------------------------------------------
async function runImage(prompt) {
  if (currentKeyMissing(settings.imageProvider || "openai")) {
    return addMessage("error", t("err.imageKeyMissing", { label: PROVIDERS[settings.imageProvider || "openai"].label }));
  }
  addMessage("user", "🎨 " + prompt);
  transcript.push({ role: "user", text: "🎨 " + prompt });
  lastUserContent = prompt; // remember the prompt so we can regenerate on another model
  const status = addMessage("tool", t("image.generating"));
  startBusy();
  try {
    const urls = await generateImage(settings, { prompt, size: els.imageSize.value, signal: abortController.signal });
    status.remove();
    const wrap = addMessage("assistant", "");
    for (const u of urls) {
      const img = document.createElement("img");
      img.src = u; img.alt = prompt; img.className = "gen-image";
      wrap.appendChild(img);
    }
    transcript.push({ role: "assistant", kind: "image", urls });
    attachImageCompareBar(wrap); // ⚖ compare the result with another image model
  } catch (e) {
    status.remove();
    addMessage("error", t("err.image", { msg: e && e.message ? e.message : String(e) }));
  } finally {
    endBusy();
    await saveCurrent();
  }
}

// Image comparison: like the chat "compare" bar, but it regenerates the SAME
// prompt with another connected IMAGE model (cost colour-coded in the picker).
function attachImageCompareBar(el) {
  els.messages.querySelectorAll(".msg-actions").forEach((n) => n.remove());
  if (!el || !lastUserContent) return;
  const list = imageModelChoices();
  if (list.length < 2) return; // nothing to compare against
  const bar = document.createElement("div");
  bar.className = "msg-actions";
  const lbl = document.createElement("span");
  lbl.className = "cmp-lbl";
  lbl.textContent = t("compare.with");
  const sel = document.createElement("select");
  sel.className = "cmp-select";
  for (const [pid, mid, mlabel] of list) {
    const o = document.createElement("option");
    const tier = imagePriceTier(pid, mid);
    o.value = pid + "|" + mid;
    o.textContent = tier.emoji + " " + PROVIDERS[pid].label + " · " + mlabel;
    o.style.color = tier.color;
    sel.appendChild(o);
  }
  const cur = (settings.imageProvider || "openai") + "|" + (settings.imageModel || "");
  for (const opt of sel.options) {
    if (opt.value && opt.value !== cur) { sel.value = opt.value; break; }
  }
  const btn = document.createElement("button");
  btn.className = "cmp-btn";
  btn.textContent = t("compare.btn");
  btn.addEventListener("click", () => compareImage(parseSel(sel.value), btn));
  bar.appendChild(lbl);
  bar.appendChild(sel);
  bar.appendChild(btn);
  el.appendChild(bar);
}

async function compareImage(second, btn) {
  if (busy || !lastUserContent) return;
  if (currentKeyMissing(second.providerId)) {
    addMessage("error", t("err.keyMissingFor", { label: PROVIDERS[second.providerId].label }));
    return;
  }
  btn.disabled = true;
  startBusy();
  const badge = `${PROVIDERS[second.providerId].label} · ${second.modelId}`;
  const status = addMessage("tool", t("image.generating"));
  try {
    const urls = await generateImage(
      { ...settings, imageProvider: second.providerId, imageModel: second.modelId },
      { prompt: lastUserContent, size: els.imageSize.value, signal: abortController.signal }
    );
    status.remove();
    const wrap = addMessage("assistant", "");
    const b = document.createElement("div");
    b.className = "model-badge";
    b.textContent = badge;
    wrap.appendChild(b);
    for (const u of urls) {
      const img = document.createElement("img");
      img.src = u; img.alt = lastUserContent; img.className = "gen-image";
      wrap.appendChild(img);
    }
    transcript.push({ role: "assistant", kind: "image", urls, badge });
    attachImageCompareBar(wrap); // compare again with yet another model
  } catch (e) {
    status.remove();
    addMessage("error", t("err.image", { msg: e && e.message ? e.message : String(e) }));
  } finally {
    endBusy();
    btn.disabled = false;
    await saveCurrent();
  }
}

// ----- PDF workspace --------------------------------------------------------
function pdfContextBlock() {
  if (!pdf.text) return "";
  return `[PDF: ${pdf.name} (${pdf.pages} pages)]\n${pdf.text.slice(0, PDF_BUDGET)}\n\n`;
}
async function loadPdfFile(file) {
  if (!file) return;
  if (!window.pdfjsLib) { addMessage("error", t("err.pdf", { msg: "pdf.js not loaded" })); return; }
  els.pdfInfo.textContent = t("pdf.loading");
  try {
    if (!pdfWorkerSet) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = browser.runtime.getURL("vendor/pdf.worker.min.js");
      pdfWorkerSet = true;
    }
    const buf = await file.arrayBuffer();
    const doc = await window.pdfjsLib.getDocument({ data: buf }).promise;
    let text = "";
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map((it) => (it.str || "")).join(" ") + "\n\n";
    }
    pdfDoc = doc;
    pdf = { name: file.name, text: text.trim(), pages: doc.numPages };
    els.pdfInfo.textContent = t("pdf.info", { name: file.name, pages: doc.numPages });
    els.pdfSummarize.classList.remove("hidden");
    els.pdfImages.classList.remove("hidden");
    els.pdfText.classList.remove("hidden");
    addMessage("tool", t("pdf.loaded", { name: file.name, pages: doc.numPages }));
    els.input.focus();
  } catch (e) {
    els.pdfInfo.textContent = "";
    addMessage("error", t("err.pdf", { msg: e && e.message ? e.message : String(e) }));
  }
}
async function onPdfSend() {
  const text = els.input.value.trim();
  if (!text) return;
  if (!pdf.text) return addMessage("error", t("pdf.none"));
  els.input.value = "";
  await sendToModel(text, pdfContextBlock() + `[Question]\n${text}`, { runMode: "chat" });
}
async function pdfSummarizeAction() {
  if (!pdf.text) return addMessage("error", t("pdf.none"));
  await sendToModel(t("pdf.summLabel"), pdfContextBlock() + "[Task]\n" + t("pdf.summPrompt"), { runMode: "chat" });
}
function pdfExtractTextAction() {
  if (!pdf.text) return addMessage("error", t("pdf.none"));
  addMessage("user", t("pdf.textLabel"));
  const el = addMessage("assistant", "");
  el.innerHTML = renderMarkdown("```text\n" + pdf.text.slice(0, 100000) + "\n```");
  enhanceArtifacts(el);
}
async function pdfExtractImages() {
  if (!pdfDoc) return addMessage("error", t("pdf.none"));
  if (busy) return;
  addMessage("user", t("pdf.imagesLabel"));
  const status = addMessage("tool", t("pdf.extracting"));
  startBusy();
  try {
    const wrap = addMessage("assistant", "");
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      const img = document.createElement("img");
      img.src = canvas.toDataURL("image/png");
      img.alt = `page ${i}`;
      img.className = "gen-image";
      wrap.appendChild(img);
      els.messages.scrollTop = els.messages.scrollHeight;
    }
    status.remove();
  } catch (e) {
    status.remove();
    addMessage("error", t("err.pdf", { msg: e && e.message ? e.message : String(e) }));
  } finally {
    endBusy();
  }
}

init();
