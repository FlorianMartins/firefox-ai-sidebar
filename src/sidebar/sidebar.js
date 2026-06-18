import { getSettings, setSettings } from "../lib/storage.js";
import { makeProvider } from "../lib/providers.js";
import { buildSystemPrompt, activeTools, runConversation } from "../lib/agent.js";
import { executeTool } from "../lib/tools.js";

const MODELS = {
  anthropic: [
    ["claude-opus-4-8", "Claude Opus 4.8"],
    ["claude-sonnet-4-6", "Claude Sonnet 4.6"],
    ["claude-haiku-4-5", "Claude Haiku 4.5"],
  ],
  openrouter: [
    ["anthropic/claude-3.7-sonnet", "Claude 3.7 Sonnet"],
    ["openai/gpt-4o", "GPT-4o"],
    ["google/gemini-2.0-flash-001", "Gemini 2.0 Flash"],
    ["meta-llama/llama-3.3-70b-instruct", "Llama 3.3 70B"],
    ["deepseek/deepseek-chat", "DeepSeek Chat"],
  ],
};

const $ = (id) => document.getElementById(id);
const els = {
  provider: $("provider"),
  model: $("model"),
  agentMode: $("agentMode"),
  pageCtx: $("pageCtx"),
  messages: $("messages"),
  empty: $("empty"),
  input: $("input"),
  send: $("send"),
  stop: $("stop"),
  newChat: $("newChat"),
  openOptions: $("openOptions"),
  confirmBar: $("confirmBar"),
  confirmText: $("confirmText"),
  confirmAllow: $("confirmAllow"),
  confirmDeny: $("confirmDeny"),
};

let settings;
let history = [];
let abortController = null;

async function init() {
  settings = await getSettings();
  els.provider.value = settings.provider;
  populateModels();
  els.agentMode.checked = settings.agentMode;
  els.pageCtx.checked = settings.includePageContext;
  wire();
}

function populateModels() {
  const provider = els.provider.value;
  const list = MODELS[provider] || [];
  els.model.innerHTML = "";
  for (const [val, label] of list) {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = label;
    els.model.appendChild(o);
  }
  const stored = provider === "anthropic" ? settings.anthropicModel : settings.openrouterModel;
  if (stored && list.some((m) => m[0] === stored)) els.model.value = stored;
}

function wire() {
  els.provider.addEventListener("change", async () => {
    settings.provider = els.provider.value;
    await setSettings({ provider: settings.provider });
    populateModels();
    await persistModel();
    resetConversation();
  });
  els.model.addEventListener("change", persistModel);
  els.agentMode.addEventListener("change", async () => {
    settings.agentMode = els.agentMode.checked;
    await setSettings({ agentMode: settings.agentMode });
  });
  els.pageCtx.addEventListener("change", async () => {
    settings.includePageContext = els.pageCtx.checked;
    await setSettings({ includePageContext: settings.includePageContext });
  });
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
}

async function persistModel() {
  const provider = els.provider.value;
  if (provider === "anthropic") {
    settings.anthropicModel = els.model.value;
    await setSettings({ anthropicModel: settings.anthropicModel });
  } else {
    settings.openrouterModel = els.model.value;
    await setSettings({ openrouterModel: settings.openrouterModel });
  }
}

function resetConversation() {
  history = [];
  els.messages.querySelectorAll(".msg").forEach((n) => n.remove());
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

function currentKeyMissing() {
  const provider = els.provider.value;
  if (provider === "anthropic") return !settings.anthropicKey;
  return !settings.openrouterKey;
}

// Confirmation des actions d'écriture (mode agent)
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

async function buildUserContent(text) {
  // En mode chat, on injecte le contenu de la page si demandé.
  // En mode agent, le modèle appelle read_page lui-même.
  if (els.pageCtx.checked && !els.agentMode.checked) {
    try {
      const page = await executeTool("read_page", {}, {});
      if (page && !page.error) {
        const ctx = page.text.slice(0, settings.maxPageChars);
        return (
          `[Contexte de la page active]\nTitre: ${page.title}\nURL: ${page.url}\n${ctx}\n\n` +
          `[Message de l'utilisateur]\n${text}`
        );
      }
    } catch (_) {}
  }
  return text;
}

async function onSend() {
  const text = els.input.value.trim();
  if (!text) return;
  if (currentKeyMissing()) {
    addMessage("error", "Aucune clé API pour ce fournisseur. Ouvrez ⚙ Réglages.");
    return;
  }

  els.input.value = "";
  addMessage("user", text);

  const userContent = await buildUserContent(text);
  history.push({ role: "user", content: userContent });

  const provider = makeProvider({
    ...settings,
    provider: els.provider.value,
    anthropicModel: els.model.value,
    openrouterModel: els.model.value,
  });
  const agentMode = els.agentMode.checked;
  const system = buildSystemPrompt({ agentMode });
  const tools = activeTools({ agentMode });

  els.send.classList.add("hidden");
  els.stop.classList.remove("hidden");
  abortController = new AbortController();

  let assistantEl = null;
  const onText = (delta) => {
    if (!assistantEl) assistantEl = addMessage("assistant", "");
    assistantEl.textContent += delta;
    els.messages.scrollTop = els.messages.scrollHeight;
  };
  const onToolStart = (call) => {
    addMessage("tool", `→ ${call.name}(${JSON.stringify(call.input).slice(0, 100)})`);
    assistantEl = null; // les prochains deltas créeront un nouveau bloc
  };
  const onToolEnd = (call, out) => {
    const summary = out && out.error ? `✗ ${out.error}` : "✓ ok";
    addMessage("tool", `   ${summary}`);
  };

  try {
    await runConversation({
      provider,
      system,
      history,
      tools,
      onText,
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
    els.send.classList.remove("hidden");
    els.stop.classList.add("hidden");
    abortController = null;
  }
}

init();
