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
import { t, setLang, applyDom } from "../lib/i18n.js";
import {
  listConversations, getConversation, saveConversation, deleteConversation,
  newConversationId, titleFrom,
} from "../lib/history.js";

const $ = (id) => document.getElementById(id);
const els = {
  modelSelect: $("modelSelect"),
  modelWrap: $("modelWrap"),
  modelConnect: $("modelConnect"),
  freeConnect: $("freeConnect"),
  emptyOptions: $("emptyOptions"),
  historyBtn: $("historyBtn"),
  newChat: $("newChat"),
  openOptions: $("openOptions"),
  historyPanel: $("historyPanel"),
  historyList: $("historyList"),
  clearHistory: $("clearHistory"),
  closeHistory: $("closeHistory"),
  pageBar: $("pageBar"),
  pageTitle: $("pageTitle"),
  tabsBtn: $("tabsBtn"),
  tabsPanel: $("tabsPanel"),
  tabsList: $("tabsList"),
  tabsRefresh: $("tabsRefresh"),
  useTabs: $("useTabs"),
  messages: $("messages"),
  empty: $("empty"),
  emptyOnboard: $("emptyOnboard"),
  emptyGreeting: $("emptyGreeting"),
  input: $("input"),
  send: $("send"),
  stop: $("stop"),
  rail: $("rail"),
  codeView: $("codeView"),
  openCodeApp: $("openCodeApp"),
  codeAppUrlLabel: $("codeAppUrlLabel"),
  terminalView: $("terminalView"),
  termLog: $("termLog"),
  termInput: $("termInput"),
  termModel: $("termModel"),
  termClear: $("termClear"),
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
  imageProviderNote: $("imageProviderNote"),
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

// Terminal workspace (OpenClaude): its own native message history + persisted
// scrollback, independent from the chat. `cmds`/`cmdIdx` drive ↑/↓ recall.
const term = { native: [], lines: [], cmds: [], cmdIdx: 0, booted: false };

// Per-workspace isolation: Chat, Agent, Translate, Improve and Image each keep
// their OWN live conversation AND their own saved-conversation history (the two
// are distinct). Terminal and Code have dedicated panes and are not chat-area
// modes. We swap the live globals (history/transcript/convId/…) in and out of a
// per-mode session whenever the workspace changes.
const CHAT_MODES = ["chat", "agent", "translate", "improve", "image", "pdf"];
const sessions = {}; // mode -> { history, transcript, convId, lastUserContent, lastRunMode, lastForceWeb }
function blankSession(m) {
  return { history: [], transcript: [], convId: newConversationId(), lastUserContent: "", lastRunMode: m, lastForceWeb: false, nodes: null };
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

async function init() {
  configureMarkdown();
  settings = await getSettings();
  setLang(settings.uiLang || "en");   // English by default; French chosen in Settings
  applyDom(document);                  // fill all data-i18n static markup
  document.documentElement.lang = settings.uiLang === "fr" ? "fr" : "en";
  populateModelSelector();
  populateImprovePresets();
  els.thinking.checked = settings.thinking;
  els.webSearch.checked = settings.webSearch;
  els.pageCtx.checked = settings.includePageContext;
  els.useTabs.checked = settings.includeSelectedTabs;
  els.translateLang.value = settings.targetLang || "French";
  els.improvePreset.value = settings.improvePreset || "improve";
  populateImageSizes();
  els.imageSize.value = settings.imageSize || "1024x1024";
  syncToggleVisibility();
  updateImageNote();
  wire();
  setMode(settings.mode || "chat");
  setupPageAwareness();
  autoListConnected();           // refresh available models in the background
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
function populateImageModelSelector() {
  const sel = els.modelSelect;
  sel.innerHTML = "";
  const list = imageModelChoices();
  // Same rule as the chat picker: with NOTHING connected, hide the list and show
  // only the full-width Connect button. With a provider connected, show the list.
  const anyConnected = connectedProviders(settings).length > 0;
  els.modelWrap.classList.toggle("hidden", !anyConnected);
  els.modelConnect.classList.toggle("hidden", anyConnected || list.length > 0);
  if (!list.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = anyConnected
      ? t("image.connectOpenAI")
      : t("image.connectAny");
    sel.appendChild(o);
    updateEmptyState();
    return;
  }
  const cur = (settings.imageProvider || "openai") + "|" + (settings.imageModel || "");
  for (const [pid, mid, mlabel] of list) {
    const o = document.createElement("option");
    const t = imagePriceTier(pid, mid); // P6: price colour code in the image list too
    o.value = pid + "|" + mid;
    o.textContent = t.emoji + " " + PROVIDERS[pid].label + " · " + mlabel + " — " + t.note;
    o.style.color = t.color;
    sel.appendChild(o);
  }
  sel.value = cur;
  // If the stored image provider/model isn't among the CONNECTED image models
  // (e.g. default is OpenAI but the user only connected OpenRouter), fall back to
  // the first available one AND persist it, so "Generate" doesn't fail with a
  // "key missing for OpenAI" against an unselected provider.
  if (!sel.value) {
    sel.value = list[0][0] + "|" + list[0][1];
    const fb = parseSel(sel.value);
    settings.imageProvider = fb.providerId;
    settings.imageModel = fb.modelId;
    setSettings({ imageProvider: fb.providerId, imageModel: fb.modelId });
    updateImageNote();
  }
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

function populateModelSelector() {
  const connected = connectedProviders(settings);
  const none = connected.length === 0;
  // Nothing connected yet → hide the model list entirely and show ONLY the
  // full-width "Connect a provider" button. Once at least one provider is
  // connected, show the (full-width) model list and hide the button. (All tabs.)
  els.modelConnect.classList.toggle("hidden", !none);
  els.modelWrap.classList.toggle("hidden", none);
  let val = "";
  if (connected.length) {
    const pid = connected.includes(settings.provider) ? settings.provider : connected[0];
    val = pid + "|" + modelFor(pid, settings);
  }
  fillModelSelect(els.modelSelect, val);
  if (els.termModel) fillModelSelect(els.termModel, val);
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
      mode === "terminal" ? t("greeting.terminal") :
      mode === "agent" ? t("greeting.agent") :
      mode === "pdf" ? t("greeting.pdf") :
      t("greeting");
  }
}

function parseSel(value) {
  const i = (value || "").indexOf("|");
  if (i < 0) return { providerId: settings.provider, modelId: modelFor(settings.provider, settings) };
  return { providerId: value.slice(0, i), modelId: value.slice(i + 1) };
}
function currentSelection() {
  return parseSel(els.modelSelect.value);
}

function syncToggleVisibility() {
  // No-op: the control chips (incl. Web) are always visible now. Kept as a hook
  // in case provider-specific UI tweaks are needed later.
}
function updateImageNote() {
  const meta = PROVIDERS[settings.imageProvider || "openai"];
  els.imageProviderNote.textContent = meta ? "via " + meta.label : "";
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

async function onModelChange() {
  // In the Image tab the picker selects an IMAGE model (provider + model used by
  // runImage), not the chat model.
  if (mode === "image") {
    const sel = parseSel(els.modelSelect.value);
    if (sel.providerId) {
      settings.imageProvider = sel.providerId;
      settings.imageModel = sel.modelId;
      await setSettings({ imageProvider: sel.providerId, imageModel: sel.modelId });
      updateImageNote();
    }
    return;
  }
  await applyModelChoice(els.modelSelect.value);
  // Keep the Terminal picker in sync with the same choice.
  if (els.termModel) els.termModel.value = els.modelSelect.value;
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

// ----- Workspace modes ------------------------------------------------------
function setMode(next) {
  const prev = mode;
  // Save the conversation we're leaving (data + DOM nodes), then point the globals
  // at the target workspace's own conversation.
  if (prev !== next && CHAT_MODES.includes(prev)) { syncSessionFromGlobals(prev); stashMode(prev); }
  mode = next;
  settings.mode = next;
  setSettings({ mode: next });
  if (CHAT_MODES.includes(next)) loadSessionToGlobals(next);
  els.rail.querySelectorAll(".railtab").forEach((b) => b.classList.toggle("active", b.dataset.mode === next));
  // Chat + Agent share the chat composer & the Réflexion/Web/Page chips.
  els.chatControls.classList.toggle("hidden", !(next === "chat" || next === "agent"));
  els.translateControls.classList.toggle("hidden", next !== "translate");
  els.improveControls.classList.toggle("hidden", next !== "improve");
  els.imageControls.classList.toggle("hidden", next !== "image");
  els.pdfControls.classList.toggle("hidden", next !== "pdf");
  document.body.classList.toggle("mode-terminal", next === "terminal");
  document.body.classList.toggle("mode-code", next === "code");
  els.terminalView.classList.toggle("hidden", next !== "terminal");
  els.codeView.classList.toggle("hidden", next !== "code");
  els.input.placeholder = placeholderFor(next);
  refreshModelUI(); // Image tab lists image models; others list chat models.
  if (CHAT_MODES.includes(next)) restoreMode(next); // re-attach this tab's own message nodes
  if (next === "terminal") {
    termBoot();
    setTimeout(() => els.termInput.focus(), 0);
  }
  if (next === "code") updateCodeLauncher();
  updateEmptyState();
}

// ----- Code workspace (AI app builder launcher) -----------------------------
// The builder (Bolt.diy / Behivey) runs WebContainers, which require cross-origin
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

// ----- Terminal workspace (OpenClaude) --------------------------------------
function termModelLabel() {
  const sel = parseSel(els.termModel && els.termModel.value);
  if (!sel.providerId) return t("term.noModel");
  return sel.modelId;
}
// Append a line/block to the terminal scrollback. `kind`: banner | sys | cmd | out | err.
function termAppend(kind, text) {
  const div = document.createElement("div");
  if (kind === "cmd") {
    div.className = "term-cmd";
    const p = document.createElement("span"); p.className = "term-prompt"; p.textContent = "claude>";
    const t = document.createElement("span"); t.textContent = " " + text;
    div.appendChild(p); div.appendChild(t);
  } else if (kind === "out") {
    div.className = "term-out";
    div.innerHTML = renderMarkdown(text || "");
    enhanceArtifacts(div);
  } else if (kind === "err") {
    div.className = "term-line term-err"; div.textContent = text;
  } else if (kind === "banner") {
    div.className = "term-line banner"; div.textContent = text;
  } else {
    div.className = "term-line sys"; div.textContent = text;
  }
  els.termLog.appendChild(div);
  els.termLog.scrollTop = els.termLog.scrollHeight;
  return div;
}
function termPrintBanner() {
  termAppend("banner", t("term.banner"));
  termAppend("sys", "$ claude");
  termAppend("sys", t("term.sessionStarted", { model: termModelLabel() }));
  termAppend("sys", t("term.describeTask"));
}
// Boot once per page load: print banner, then replay any locally-saved session.
function termBoot() {
  if (term.booted) return;
  term.booted = true;
  termPrintBanner();
  const s = settings.terminalSession;
  if (s && Array.isArray(s.lines) && s.lines.length) {
    term.native = Array.isArray(s.native) ? s.native : [];
    for (const ln of s.lines) {
      termAppend(ln.kind, ln.text);
      term.lines.push(ln);
      if (ln.kind === "cmd") term.cmds.push(ln.text);
    }
    term.cmdIdx = term.cmds.length;
    termAppend("sys", t("term.restored"));
  }
}
async function termPersist() {
  await setSettings({ terminalSession: { lines: term.lines, native: term.native } });
}
function termClearAll() {
  els.termLog.innerHTML = "";
  term.lines = []; term.native = []; term.cmds = []; term.cmdIdx = 0;
  termPrintBanner();
  termPersist();
}
function autoGrowTerm() {
  els.termInput.style.height = "auto";
  els.termInput.style.height = Math.min(els.termInput.scrollHeight, 120) + "px";
}
async function termSend(rawText) {
  const text = (rawText || "").trim();
  if (!text || busy) return;
  els.termInput.value = "";
  autoGrowTerm();
  const lower = text.toLowerCase();
  if (lower === "clear" || lower === "cls") return termClearAll();
  if (lower === "help") {
    termAppend("sys", t("term.help"));
    return;
  }
  const sel = parseSel(els.termModel.value);
  if (!sel.providerId || currentKeyMissing(sel.providerId)) {
    termAppend("err", t("term.noModelConnected"));
    return;
  }
  term.cmds.push(text); term.cmdIdx = term.cmds.length;
  termAppend("cmd", text);
  term.lines.push({ kind: "cmd", text });

  startBusy();
  term.native.push({ role: "user", content: text });
  const provider = makeProvider(
    { ...settings, provider: sel.providerId, models: { ...settings.models, [sel.providerId]: sel.modelId } },
    { thinking: false, webSearch: false }
  );
  const system = buildSystemPrompt({
    agentMode: false, targetLang: settings.targetLang, responseLang: settings.responseLang,
    mode: "terminal", blockPayments: settings.blockPayments,
  });
  const out = termAppend("out", "");
  let raw = "";
  try {
    await runConversation({
      provider, system, history: term.native, tools: [],
      onText: (d) => { raw += d; out.innerHTML = renderMarkdown(raw); els.termLog.scrollTop = els.termLog.scrollHeight; },
      onThink: () => {},
      signal: abortController.signal,
    });
    out.innerHTML = renderMarkdown(raw); enhanceArtifacts(out);
    term.lines.push({ kind: "out", text: raw });
  } catch (e) {
    out.remove();
    if (e && e.name === "AbortError") termAppend("err", t("term.interrupted"));
    else termAppend("err", "✗ " + (e && e.message ? e.message : String(e)));
  } finally {
    endBusy();
    await termPersist();
  }
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
    else if (msg.type === "draft_reply") runQuickAction("reply", msg.thread || "");
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
  // Keep the page bar visible whenever the Page toggle is ON — even when the active
  // tab isn't readable — so the page chip AND the 📑 multi-tab picker stay reachable
  // (that's the "page/tab selection popup disappeared" fix).
  els.pageBar.classList.toggle("hidden", !els.pageCtx.checked);
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
  if (!els.useTabs.checked || !(settings.selectedTabs || []).length) return "";
  const parts = [];
  for (const tabId of settings.selectedTabs) {
    try {
      const p = await executeTool("read_tab", { tabId }, {});
      if (p && !p.error && p.text) {
        parts.push(`[Tab] ${p.title || ""} (${p.url})\n` + p.text.slice(0, Math.floor(settings.maxPageChars / 2)));
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
async function renderHistoryList() {
  // Each workspace shows ONLY its own saved conversations (legacy entries with no
  // mode are treated as Chat).
  const all = await listConversations();
  const list = all.filter((c) => (c.mode || "chat") === mode);
  els.historyList.innerHTML = "";
  if (!list.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = t("history.empty");
    els.historyList.appendChild(li);
    return;
  }
  for (const c of list) {
    const li = document.createElement("li");
    li.className = "histrow";
    const title = document.createElement("span");
    title.className = "htitle";
    title.textContent = c.title || t("history.untitled");
    const meta = document.createElement("span");
    meta.className = "hmeta";
    meta.textContent = timeAgo(c.updatedAt || Date.now());
    const del = document.createElement("button");
    del.className = "hdel";
    del.textContent = "✕";
    del.title = t("delete.title");
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      await deleteConversation(c.id);
      // If the deleted conversation is the one open, switch to a fresh new chat.
      if (c.id === convId) startFreshChat();
      renderHistoryList();
    });
    li.addEventListener("click", () => loadConversation(c.id));
    li.appendChild(title);
    li.appendChild(meta);
    li.appendChild(del);
    els.historyList.appendChild(li);
  }
}
// Persist a SPECIFIC session (bound to its own convId/mode) so an answer that
// finishes after the user has switched tabs is still saved to the right place.
async function saveSession(sess, m, sel) {
  if (!settings.saveHistory || !sess.transcript.length) return;
  await saveConversation({
    id: sess.convId, title: titleFrom(sess.transcript), updatedAt: Date.now(), mode: m,
    providerId: sel.providerId, model: sel.modelId, transcript: sess.transcript, nativeHistory: sess.history,
  });
}
async function saveCurrent() {
  return saveSession(getSession(mode), mode, currentSelection());
}
function renderTranscriptItem(item) {
  if (item.role === "user") {
    return addMessage("user", item.text);
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
  syncSessionFromGlobals(mode); // the fresh arrays are this tab's live session
  clearMessages();
  els.empty.classList.remove("hidden");
  updateEmptyState();
}
async function newChat() {
  await saveCurrent();
  startFreshChat();
}

// ----- Pending actions ------------------------------------------------------
async function consumePendingAction() {
  const { pendingAction } = await browser.storage.local.get("pendingAction");
  if (!pendingAction || Date.now() - pendingAction.ts > 60000) return;
  await browser.storage.local.remove("pendingAction");
  runQuickAction(pendingAction.action, pendingAction.text);
}

// ----- Wiring ---------------------------------------------------------------
function wire() {
  els.modelSelect.addEventListener("change", onModelChange);

  const bindToggle = (el, key, after) =>
    el.addEventListener("change", async () => {
      settings[key] = el.checked;
      await setSettings({ [key]: el.checked });
      if (after) after();
    });
  bindToggle(els.thinking, "thinking");
  bindToggle(els.webSearch, "webSearch");
  bindToggle(els.pageCtx, "includePageContext", () =>
    els.pageBar.classList.toggle("hidden", !els.pageCtx.checked)
  );
  bindToggle(els.useTabs, "includeSelectedTabs");

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

  els.historyBtn.addEventListener("click", async () => {
    const show = els.historyPanel.classList.contains("hidden");
    if (show) await renderHistoryList();
    els.historyPanel.classList.toggle("hidden");
  });
  els.clearHistory.addEventListener("click", async () => {
    // Per-tab: clear only THIS workspace's saved conversations (the panel is filtered).
    const all = await listConversations();
    for (const c of all.filter((c) => (c.mode || "chat") === mode)) await deleteConversation(c.id);
    startFreshChat(); // the open one is gone too — start clean
    renderHistoryList();
  });
  els.closeHistory.addEventListener("click", () => els.historyPanel.classList.add("hidden"));

  els.tabsBtn.addEventListener("click", async () => {
    const show = els.tabsPanel.classList.contains("hidden");
    if (show) await buildTabsList();
    els.tabsPanel.classList.toggle("hidden");
  });
  els.tabsRefresh.addEventListener("click", buildTabsList);
  els.tabsList.addEventListener("change", persistSelectedTabs);

  els.send.addEventListener("click", onSend);
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); }
  });
  els.input.addEventListener("input", autoGrow);
  els.stop.addEventListener("click", () => abortController && abortController.abort());
  els.newChat.addEventListener("click", newChat);

  // Terminal workspace events (dedicated input line, model picker, clear).
  els.termInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); termSend(els.termInput.value); return; }
    if (e.key === "ArrowUp" && !e.shiftKey && term.cmds.length) {
      e.preventDefault();
      term.cmdIdx = Math.max(0, term.cmdIdx - 1);
      els.termInput.value = term.cmds[term.cmdIdx] || "";
      autoGrowTerm();
    } else if (e.key === "ArrowDown" && !e.shiftKey && term.cmds.length) {
      e.preventDefault();
      term.cmdIdx = Math.min(term.cmds.length, term.cmdIdx + 1);
      els.termInput.value = term.cmds[term.cmdIdx] || "";
      autoGrowTerm();
    }
  });
  els.termInput.addEventListener("input", autoGrowTerm);
  els.termClear.addEventListener("click", termClearAll);
  els.termModel.addEventListener("change", async () => {
    const sel = await applyModelChoice(els.termModel.value);
    if (sel) {
      termAppend("sys", t("term.modelLine", { model: sel.modelId }));
      if (els.modelSelect) els.modelSelect.value = els.termModel.value;
    }
  });

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
  els.input.style.height = Math.min(els.input.scrollHeight, 150) + "px";
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

// Streaming sink: owns one assistant card (+ optional model badge) and its
// thinking block. Used for a normal turn and for each compare run.
function makeSink(badgeLabel, showThink = true) {
  let el = null, contentEl = null, raw = "", think = null;
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
      if (!think) think = addThinkBlock();
      think.textContent += delta;
      els.messages.scrollTop = els.messages.scrollHeight;
    },
    finalize() {
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
    els.confirmText.textContent = t("confirm.prompt", { name, input: JSON.stringify(input).slice(0, 120) });
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
function pageContextBlock() {
  if (!currentPage) return "";
  const ctx = (currentPage.text || "").slice(0, settings.maxPageChars);
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
  els.send.classList.add("hidden");
  els.stop.classList.remove("hidden");
  abortController = new AbortController();
}
function endBusy() {
  els.send.classList.remove("hidden");
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
    if (opt.value && opt.value !== els.modelSelect.value) { sel.value = opt.value; break; }
  }
  const btn = document.createElement("button");
  btn.className = "cmp-btn";
  btn.textContent = t("compare.btn");
  btn.addEventListener("click", () => compareLast(parseSel(sel.value), btn));
  bar.appendChild(lbl);
  bar.appendChild(sel);
  bar.appendChild(btn);
  el.appendChild(bar);
}

async function compareLast(second, btn) {
  if (busy || !lastUserContent) return;
  if (currentKeyMissing(second.providerId)) {
    addMessage("error", t("err.keyMissingFor", { label: PROVIDERS[second.providerId].label }));
    return;
  }
  btn.disabled = true;
  startBusy();
  const badge = `${PROVIDERS[second.providerId].label} · ${second.modelId}`;
  try {
    const provider = makeProvider(
      { ...settings, provider: second.providerId, models: { ...settings.models, [second.providerId]: second.modelId } },
      { thinking: els.thinking.checked, webSearch: els.webSearch.checked || lastForceWeb }
    );
    const system = buildSystemPrompt({ agentMode: false, targetLang: settings.targetLang, responseLang: settings.responseLang, mode: lastRunMode, blockPayments: settings.blockPayments });
    const sink = makeSink(badge, els.thinking.checked);
    await runConversation({ provider, system, history: [{ role: "user", content: lastUserContent }], tools: [], onText: sink.onText, onThink: sink.onThink, signal: abortController.signal });
    sink.finalize();
    if (sink.getRaw()) transcript.push({ role: "assistant", text: `**${badge}**\n\n${sink.getRaw()}` });
    attachCompareBar(sink.getEl()); // allow comparing again with yet another model
  } catch (e) {
    showRunError(second.providerId, e, second.modelId);
  } finally {
    endBusy();
    btn.disabled = false;
    await saveCurrent();
  }
}

// ----- Core send ------------------------------------------------------------
async function sendToModel(displayText, modelContent, { forceWeb = false, runMode = "chat" } = {}) {
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
  addMessage("user", displayText);
  sess.transcript.push({ role: "user", text: displayText });
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

  let turnHistory;
  if (isolated) {
    turnHistory = [{ role: "user", content: modelContent }];
  } else {
    sess.history.push({ role: "user", content: modelContent });
    turnHistory = sess.history;
  }
  const provider = makeProvider(
    { ...settings, provider: turnSel.providerId, models: { ...settings.models, [turnSel.providerId]: turnSel.modelId } },
    { thinking: els.thinking.checked, webSearch: wantWeb }
  );
  const system = buildSystemPrompt({ agentMode, targetLang: settings.targetLang, responseLang: settings.responseLang, mode: runMode, blockPayments: settings.blockPayments });
  const tools = activeTools({ agentMode });
  const sink = makeSink(badge, els.thinking.checked);
  try {
    await runConversation({
      provider, system, history: turnHistory, tools,
      onText: sink.onText, onThink: sink.onThink,
      onToolStart: (call) => { sink.finalize(); addMessage("tool", `→ ${call.name}(${JSON.stringify(call.input).slice(0, 80)})`); },
      onToolEnd: (call, out) => addMessage("tool", out && out.blocked ? `   🛡 ${out.error}` : `   ${out && out.error ? "✗ " + out.error : "✓ ok"}`),
      // P2 — agent permission: "auto" runs every (non-payment) action without asking;
      // "manual" (default) confirms each one. The anti-purchase guard applies in BOTH.
      confirmActions: settings.agentPermission !== "auto",
      confirmFn: (agentMode && settings.agentPermission !== "auto") ? confirmAction : null,
      guard: { blockPayments: settings.blockPayments },
      signal: abortController.signal,
    });
    sink.finalize();
    if (sink.getRaw()) {
      sess.transcript.push({ role: "assistant", text: sink.getRaw() });
      if (mode === sessMode) attachCompareBar(sink.getEl()); // compare bar only if still on this tab
    }
  } catch (e) {
    showRunError(turnSel.providerId, e, turnSel.modelId);
  } finally {
    endBusy();
    await saveSession(sess, sessMode, sel);
  }
}

// ----- Send dispatch (per mode) ---------------------------------------------
async function onSend() {
  resetComposerHeight();
  if (mode === "translate") return runTranslateFromInput();
  if (mode === "improve") return runImproveFromInput();
  if (mode === "image") return runImageFromInput();
  if (mode === "pdf") return onPdfSend();
  if (mode === "terminal") return onTerminalSend();
  if (mode === "code") return; // Code workspace has no composer — use the launcher button.
  return onChatSend(); // chat + agent
}

// Terminal/dev mode: send the raw prompt with the dev persona, no page injection.
async function onTerminalSend() {
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = "";
  await sendToModel(text, text, { runMode: "terminal" });
}
async function onChatSend() {
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = "";
  let prefix = "";
  if (!agentActive()) {
    if (els.pageCtx.checked && currentPage) prefix += pageContextBlock();
    prefix += await selectedTabsContext();
  }
  const content = prefix ? prefix + `[Message]\n${text}` : text;
  await sendToModel(text, content);
}
async function runTranslateFromInput() {
  const lang = els.translateLang.value || "French";
  let txt = els.input.value.trim();
  // Show the actual user input as the message; only fall back to a short label when
  // translating the current page (where the "input" is the whole page text).
  let displayText = txt;
  if (!txt) {
    txt = currentPage ? (currentPage.text || "").slice(0, settings.maxPageChars) : "";
    displayText = t("label.translatePage");
  }
  if (!txt) return addMessage("error", t("err.nothingToTranslateInput"));
  els.input.value = "";
  await sendToModel(displayText, t("prompt.translate", { lang, text: txt }), { runMode: "translate" });
}
async function runImproveFromInput() {
  const presetId = els.improvePreset.value || "improve";
  let txt = els.input.value.trim();
  if (!txt) txt = await getSelection();
  if (!txt) return addMessage("error", t("err.typeOrSelect"));
  els.input.value = "";
  const instruction = t("presetPrompt." + presetId);
  // Show the user's own text as the message (not the preset label).
  await sendToModel(txt, `${instruction}\n${t("improve.only")}\n\n${t("improve.textLabel")}\n${txt}`, { runMode: "improve" });
}
async function runImageFromInput() {
  const prompt = els.input.value.trim();
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
    const urls = await generateImage(settings, { prompt, size: els.imageSize.value || settings.imageSize, signal: abortController.signal });
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
      { prompt: lastUserContent, size: els.imageSize.value || settings.imageSize, signal: abortController.signal }
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
