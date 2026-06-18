import { getSettings, setSettings } from "../lib/storage.js";

const fields = [
  "anthropicKey",
  "openrouterKey",
  "agentMode",
  "confirmActions",
  "includePageContext",
  "maxPageChars",
];

const $ = (id) => document.getElementById(id);

async function load() {
  const s = await getSettings();
  $("anthropicKey").value = s.anthropicKey;
  $("openrouterKey").value = s.openrouterKey;
  $("agentMode").checked = s.agentMode;
  $("confirmActions").checked = s.confirmActions;
  $("includePageContext").checked = s.includePageContext;
  $("maxPageChars").value = s.maxPageChars;
}

async function save() {
  const patch = {
    anthropicKey: $("anthropicKey").value.trim(),
    openrouterKey: $("openrouterKey").value.trim(),
    agentMode: $("agentMode").checked,
    confirmActions: $("confirmActions").checked,
    includePageContext: $("includePageContext").checked,
    maxPageChars: parseInt($("maxPageChars").value, 10) || 12000,
  };
  await setSettings(patch);
  const st = $("status");
  st.textContent = "✓ Enregistré.";
  setTimeout(() => (st.textContent = ""), 2000);
}

$("save").addEventListener("click", save);
load();
