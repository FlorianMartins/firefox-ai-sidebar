import { getSettings, setSettings, setNested, onSettingsChanged } from "../lib/storage.js";
import { makeProvider, listModels, generateImage } from "../lib/providers.js";
import { buildSystemPrompt, activeTools, runConversation } from "../lib/agent.js";
import { executeTool } from "../lib/tools.js";
import { configureMarkdown, renderMarkdown, enhanceArtifacts } from "../lib/markdown.js";
import {
  PROVIDERS,
  PROVIDER_ORDER,
  modelFor,
  keyFor,
} from "../lib/models.js";

const $ = (id) => document.getElementById(id);
const els = {
  provider: $("provider"),
  model: $("model"),
  refreshModels: $("refreshModels"),
  thinking: $("thinking"),
  webSearch: $("webSearch"),
  agentMode: $("agentMode"),
  pageCtx: $("pageCtx"),
  pageBar: $("pageBar"),
  pageTitle: $("pageTitle"),
  messages: $("messages"),
  empty: $("empty"),
  input: $("input"),
  send: $("send"),
  stop: $("stop"),
  newChat: $("newChat"),
  openOptions: $("openOptions"),
  quickbar: $("quickbar"),
  confirmBar: $("confirmBar"),
  confirmText: $("confirmText"),
  confirmAllow: $("confirmAllow"),
  confirmDeny: $("confirmDeny"),
};

let settings;
let history = [];
let abortController = null;
let currentPage = null; // { title, url, text, description }
let busy = false;

async function init() {
  configureMarkdown();
  settings = await getSettings();
  populateProviders();
  populateModels();
  els.thinking.checked = settings.thinking;
  els.webSearch.checked = settings.webSearch;
  els.agentMode.checked = settings.agentMode;
  els.pageCtx.checked = settings.includePageContext;
  syncToggleVisibility();
  wire();
  setupPageAwareness();
  await refreshCurrentPage();
  await consumePendingAction();
}

// ----- Fournisseurs & modèles ----------------------------------------------
function populateProviders() {
  els.provider.innerHTML = "";
  for (const id of PROVIDER_ORDER) {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = PROVIDERS[id].label;
    els.provider.appendChild(o);
  }
  els.provider.value = settings.provider in PROVIDERS ? settings.provider : "anthropic";
}

function modelOptions(providerId) {
  // Modèles par défaut du catalogue + ceux récupérés dynamiquement (settings.modelLists).
  const base = PROVIDERS[providerId].models.map((m) => m[0]);
  const fetched = (settings.modelLists && settings.modelLists[providerId]) || [];
  const seen = new Set();
  const out = [];
  for (const id of [...base, ...fetched]) {
    if (seen.has(id)) continue;
    seen.add(id);
    const label = (PROVIDERS[providerId].models.find((m) => m[0] === id) || [])[1] || id;
    out.push([id, label]);
  }
  return out;
}

function populateModels() {
  const providerId = els.provider.value;
  const list = modelOptions(providerId);
  els.model.innerHTML = "";
  for (const [val, label] of list) {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = label;
    els.model.appendChild(o);
  }
  const chosen = modelFor(providerId, settings);
  if (chosen && list.some((m) => m[0] === chosen)) els.model.value = chosen;
  else if (list.length) els.model.value = list[0][0];
}

function syncToggleVisibility() {
  const meta = PROVIDERS[els.provider.value] || {};
  els.webSearch.closest(".toggle").style.display = meta.supportsWebSearch ? "" : "none";
}

async function refreshModelsFromApi() {
  const providerId = els.provider.value;
  els.refreshModels.classList.add("spin");
  try {
    const ids = await listModels(providerId, settings);
    settings.modelLists = settings.modelLists || {};
    settings.modelLists[providerId] = ids;
    await setSettings({ modelLists: settings.modelLists });
    populateModels();
  } catch (e) {
    addMessage("error", "Impossible de lister les modèles : " + (e.message || e));
  } finally {
    els.refreshModels.classList.remove("spin");
  }
}

// ----- Conscience de la page (les « yeux ») --------------------------------
function setupPageAwareness() {
  const onChange = () => debouncedRefresh();
  browser.tabs.onActivated.addListener(onChange);
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab && tab.active && (changeInfo.status === "complete" || changeInfo.url)) onChange();
  });
  // Navigations SPA signalées par le content script.
  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "page_changed") onChange();
  });
}

let refreshTimer = null;
function debouncedRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshCurrentPage, 350);
}

async function refreshCurrentPage() {
  try {
    const page = await executeTool("read_page", {}, {});
    if (page && !page.error && page.url) {
      currentPage = page;
      els.pageTitle.textContent = page.title || page.url;
      els.pageBar.classList.toggle("hidden", !els.pageCtx.checked);
      return;
    }
  } catch (_) {}
  currentPage = null;
  els.pageBar.classList.add("hidden");
}

// ----- Actions en attente (menus contextuels) ------------------------------
async function consumePendingAction() {
  const { pendingAction } = await browser.storage.local.get("pendingAction");
  if (!pendingAction || Date.now() - pendingAction.ts > 60000) return;
  await browser.storage.local.remove("pendingAction");
  runQuickAction(pendingAction.action, pendingAction.text);
}

// ----- UI helpers ----------------------------------------------------------
function wire() {
  els.provider.addEventListener("change", async () => {
    settings.provider = els.provider.value;
    await setSettings({ provider: settings.provider });
    populateModels();
    syncToggleVisibility();
    await persistModel();
  });
  els.model.addEventListener("change", persistModel);
  els.refreshModels.addEventListener("click", refreshModelsFromApi);

  const bindToggle = (el, key, after) =>
    el.addEventListener("change", async () => {
      settings[key] = el.checked;
      await setSettings({ [key]: el.checked });
      if (after) after();
    });
  bindToggle(els.thinking, "thinking");
  bindToggle(els.webSearch, "webSearch");
  bindToggle(els.agentMode, "agentMode");
  bindToggle(els.pageCtx, "includePageContext", () =>
    els.pageBar.classList.toggle("hidden", !(els.pageCtx.checked && currentPage))
  );

  els.send.addEventListener("click", onSend);
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  });
  els.stop.addEventListener("click", () => abortController && abortController.abort());
  els.newChat.addEventListener("click", resetConversation);
  els.openOptions.addEventListener("click", () => browser.runtime.openOptionsPage());
  const eo = $("emptyOptions");
  if (eo) eo.addEventListener("click", (e) => { e.preventDefault(); browser.runtime.openOptionsPage(); });

  els.quickbar.querySelectorAll(".quick").forEach((b) =>
    b.addEventListener("click", () => runQuickAction(b.dataset.action))
  );

  // Garde l'UI en phase si les réglages changent ailleurs (options).
  onSettingsChanged(async () => {
    settings = await getSettings();
  });
}

async function persistModel() {
  const providerId = els.provider.value;
  settings.models = settings.models || {};
  settings.models[providerId] = els.model.value;
  await setNested("models", providerId, els.model.value);
}

function resetConversation() {
  history = [];
  els.messages.querySelectorAll(".msg, .think").forEach((n) => n.remove());
  els.empty.classList.remove("hidden");
}

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
  s.textContent = "💭 Réflexion";
  const body = document.createElement("div");
  body.className = "think-body";
  d.appendChild(s);
  d.appendChild(body);
  els.messages.appendChild(d);
  els.messages.scrollTop = els.messages.scrollHeight;
  return body;
}

function currentKeyMissing() {
  const meta = PROVIDERS[els.provider.value];
  if (!meta.needsKey) return false;
  return !keyFor(els.provider.value, settings);
}

function confirmAction(name, input) {
  return new Promise((resolve) => {
    els.confirmText.textContent = `Autoriser l'action « ${name} » ? ${JSON.stringify(input).slice(0, 120)}`;
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
    `[Contexte de la page active]\nTitre: ${currentPage.title}\nURL: ${currentPage.url}\n` +
    (currentPage.description ? `Description: ${currentPage.description}\n` : "") +
    `${ctx}\n\n`
  );
}

async function getSelection() {
  try {
    const sel = await executeTool("read_selection", {}, {});
    return (sel && sel.selection) || "";
  } catch (_) {
    return "";
  }
}

// ----- Envoi principal -----------------------------------------------------
// displayText : ce que voit l'utilisateur ; modelContent : ce qui part au modèle.
async function sendToModel(displayText, modelContent, { forceWeb = false } = {}) {
  if (busy) return;
  if (currentKeyMissing()) {
    addMessage("error", "Aucune clé API pour ce fournisseur. Ouvrez ⚙ Réglages.");
    return;
  }
  busy = true;
  addMessage("user", displayText);
  history.push({ role: "user", content: modelContent });

  const provider = makeProvider(
    { ...settings, provider: els.provider.value, models: { ...settings.models, [els.provider.value]: els.model.value } },
    { thinking: els.thinking.checked, webSearch: els.webSearch.checked || forceWeb }
  );
  const agentMode = els.agentMode.checked;
  const system = buildSystemPrompt({ agentMode, targetLang: settings.targetLang });
  const tools = activeTools({ agentMode });

  els.send.classList.add("hidden");
  els.stop.classList.remove("hidden");
  abortController = new AbortController();

  let assistantEl = null;
  let assistantRaw = "";
  let thinkBody = null;
  const finalizeAssistant = () => {
    if (assistantEl) {
      assistantEl.innerHTML = renderMarkdown(assistantRaw);
      enhanceArtifacts(assistantEl);
    }
    assistantEl = null;
    assistantRaw = "";
    thinkBody = null;
  };
  const onThink = (delta) => {
    if (!thinkBody) thinkBody = addThinkBlock();
    thinkBody.textContent += delta;
    els.messages.scrollTop = els.messages.scrollHeight;
  };
  const onText = (delta) => {
    if (!assistantEl) {
      assistantEl = addMessage("assistant", "");
      assistantRaw = "";
    }
    assistantRaw += delta;
    assistantEl.innerHTML = renderMarkdown(assistantRaw);
    els.messages.scrollTop = els.messages.scrollHeight;
  };
  const onToolStart = (call) => {
    finalizeAssistant();
    addMessage("tool", `→ ${call.name}(${JSON.stringify(call.input).slice(0, 100)})`);
  };
  const onToolEnd = (call, out) => {
    addMessage("tool", `   ${out && out.error ? "✗ " + out.error : "✓ ok"}`);
  };

  try {
    await runConversation({
      provider,
      system,
      history,
      tools,
      onText,
      onThink,
      onToolStart,
      onToolEnd,
      confirmActions: settings.confirmActions,
      confirmFn: agentMode ? confirmAction : null,
      signal: abortController.signal,
    });
  } catch (e) {
    if (e && e.name === "AbortError") addMessage("tool", "■ Interrompu.");
    else addMessage("error", "Erreur : " + (e && e.message ? e.message : String(e)));
  } finally {
    finalizeAssistant();
    els.send.classList.remove("hidden");
    els.stop.classList.add("hidden");
    abortController = null;
    busy = false;
  }
}

async function onSend() {
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = "";
  // En mode chat, on injecte la page si l'œil est actif. En mode agent, le
  // modèle lit la page lui-même via ses outils.
  const inject = els.pageCtx.checked && !els.agentMode.checked && currentPage;
  const content = inject ? pageContextBlock() + `[Message]\n${text}` : text;
  await sendToModel(text, content);
}

// ----- Actions rapides (façon Sider) ---------------------------------------
async function runQuickAction(action, providedText) {
  if (busy) return;
  const lang = settings.targetLang || "Français";

  if (action === "image") {
    const prompt = (providedText || els.input.value.trim());
    if (!prompt) {
      els.input.value = "Génère une image de ";
      els.input.focus();
      return;
    }
    els.input.value = "";
    await runImage(prompt);
    return;
  }

  if (action === "summarize") {
    if (!currentPage) await refreshCurrentPage();
    if (!currentPage) return addMessage("error", "Aucune page lisible à résumer.");
    const content =
      pageContextBlock() +
      "[Tâche]\nRésume cette page en points clés (titre, idées principales, conclusion).";
    return sendToModel("📝 Résumer la page", content);
  }

  if (action === "translate") {
    let txt = providedText || (await getSelection());
    let label = "🌐 Traduire la sélection";
    if (!txt && currentPage) {
      txt = (currentPage.text || "").slice(0, settings.maxPageChars);
      label = "🌐 Traduire la page";
    }
    if (!txt) return addMessage("error", "Rien à traduire (sélectionne du texte ou ouvre une page).");
    return sendToModel(label, `Traduis en ${lang}, en gardant la mise en forme :\n\n${txt}`);
  }

  if (action === "improve") {
    const txt = providedText || (await getSelection());
    if (!txt)
      return addMessage("error", "Sélectionne d'abord du texte dans la page à améliorer.");
    return sendToModel(
      "✨ Améliorer le texte",
      "Améliore ce texte (clarté, style, grammaire), garde la langue d'origine, " +
        "et renvoie uniquement le texte réécrit :\n\n" + txt
    );
  }

  if (action === "explain") {
    const txt = providedText || (await getSelection());
    if (!txt) return addMessage("error", "Rien à expliquer.");
    return sendToModel("💡 Expliquer", "Explique simplement et clairement :\n\n" + txt);
  }

  if (action === "research") {
    const q = els.input.value.trim() || providedText;
    if (!q) {
      els.input.value = "Recherche : ";
      els.input.focus();
      return;
    }
    els.input.value = "";
    const meta = PROVIDERS[els.provider.value];
    const note = meta.supportsWebSearch
      ? ""
      : "\n(Astuce : la recherche web temps réel n'est dispo qu'avec Claude ; ici, réponse sur la base des connaissances du modèle.)";
    return sendToModel(
      "🔍 " + q,
      `Fais une recherche d'informations à jour et synthétise une réponse sourcée sur : ${q}${note}`,
      { forceWeb: true }
    );
  }
}

// ----- Génération d'image --------------------------------------------------
async function runImage(prompt) {
  busy = true;
  addMessage("user", "🎨 " + prompt);
  const status = addMessage("tool", "Génération de l'image…");
  els.send.classList.add("hidden");
  els.stop.classList.remove("hidden");
  abortController = new AbortController();
  try {
    const urls = await generateImage(settings, { prompt, signal: abortController.signal });
    status.remove();
    const wrap = addMessage("assistant", "");
    for (const u of urls) {
      const img = document.createElement("img");
      img.src = u;
      img.alt = prompt;
      img.className = "gen-image";
      wrap.appendChild(img);
    }
  } catch (e) {
    status.remove();
    addMessage("error", "Image : " + (e && e.message ? e.message : String(e)));
  } finally {
    els.send.classList.remove("hidden");
    els.stop.classList.add("hidden");
    abortController = null;
    busy = false;
  }
}

init();
