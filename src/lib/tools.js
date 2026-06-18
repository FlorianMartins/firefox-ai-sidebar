// Définition des outils du mode agent + exécuteur côté navigateur.
// Les définitions sont neutres (JSON Schema) ; providers.js les adapte au
// format Anthropic ou OpenAI.

export const TOOLS = [
  {
    name: "read_page",
    description:
      "Lit le contenu textuel visible de l'onglet actif (titre, URL, texte). À utiliser pour répondre à des questions sur la page consultée.",
    write: false,
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_selection",
    description:
      "Récupère le texte actuellement sélectionné par l'utilisateur dans l'onglet actif.",
    write: false,
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_tabs",
    description:
      "Liste les onglets ouverts de la fenêtre courante (id, titre, URL, actif).",
    write: false,
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "find_elements",
    description:
      "Liste les éléments interactifs de la page (liens, boutons, champs de saisie) avec une référence 'ref' à utiliser pour click_element / fill_input. Filtrer avec 'query' (texte recherché) pour réduire la liste.",
    write: false,
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Texte/label à rechercher pour filtrer les éléments (optionnel).",
        },
      },
      required: [],
    },
  },
  {
    name: "open_tab",
    description: "Ouvre un nouvel onglet sur l'URL donnée.",
    write: true,
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL complète (https://...)" },
        active: { type: "boolean", description: "Mettre l'onglet au premier plan (défaut true)." },
      },
      required: ["url"],
    },
  },
  {
    name: "switch_tab",
    description: "Active (met au premier plan) l'onglet d'id donné.",
    write: true,
    input_schema: {
      type: "object",
      properties: { tabId: { type: "integer" } },
      required: ["tabId"],
    },
  },
  {
    name: "close_tab",
    description: "Ferme l'onglet d'id donné.",
    write: true,
    input_schema: {
      type: "object",
      properties: { tabId: { type: "integer" } },
      required: ["tabId"],
    },
  },
  {
    name: "navigate",
    description: "Navigue l'onglet actif vers l'URL donnée.",
    write: true,
    input_schema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "click_element",
    description:
      "Clique sur un élément identifié par sa 'ref' (obtenue via find_elements).",
    write: true,
    input_schema: {
      type: "object",
      properties: { ref: { type: "string" } },
      required: ["ref"],
    },
  },
  {
    name: "fill_input",
    description:
      "Saisit du texte dans un champ identifié par sa 'ref'. submit=true valide le formulaire ensuite.",
    write: true,
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        value: { type: "string" },
        submit: { type: "boolean" },
      },
      required: ["ref", "value"],
    },
  },
  {
    name: "scroll_page",
    description: "Fait défiler l'onglet actif : 'up', 'down', 'top' ou 'bottom'.",
    write: true,
    input_schema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "top", "bottom"] },
      },
      required: ["direction"],
    },
  },
];

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("Aucun onglet actif.");
  return tab;
}

// Envoie un message au content script de l'onglet actif (avec injection de
// secours si le script n'est pas encore présent).
async function sendToActiveTab(message) {
  const tab = await getActiveTab();
  try {
    return await browser.tabs.sendMessage(tab.id, message);
  } catch (e) {
    // content script absent (page nouvellement chargée / restreinte) → tenter injection
    try {
      await browser.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["src/content/content.js"],
      });
      return await browser.tabs.sendMessage(tab.id, message);
    } catch (e2) {
      throw new Error(
        "Impossible d'accéder à cette page (page protégée ou non chargée)."
      );
    }
  }
}

// Exécute un appel d'outil. `confirmFn(name, input)` est appelée pour les
// actions d'écriture quand la confirmation est activée ; doit renvoyer un booléen.
export async function executeTool(name, input, { confirmActions, confirmFn } = {}) {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) return { error: `Outil inconnu : ${name}` };

  if (def.write && confirmActions && confirmFn) {
    const ok = await confirmFn(name, input);
    if (!ok) return { error: "Action refusée par l'utilisateur." };
  }

  try {
    switch (name) {
      case "read_page":
        return await sendToActiveTab({ type: "read_page" });
      case "read_selection":
        return await sendToActiveTab({ type: "read_selection" });
      case "find_elements":
        return await sendToActiveTab({ type: "find_elements", query: input.query || "" });
      case "click_element":
        return await sendToActiveTab({ type: "click_element", ref: input.ref });
      case "fill_input":
        return await sendToActiveTab({
          type: "fill_input",
          ref: input.ref,
          value: input.value,
          submit: !!input.submit,
        });
      case "scroll_page":
        return await sendToActiveTab({ type: "scroll_page", direction: input.direction });

      case "list_tabs": {
        const tabs = await browser.tabs.query({ currentWindow: true });
        return {
          tabs: tabs.map((t) => ({
            id: t.id,
            title: t.title,
            url: t.url,
            active: t.active,
          })),
        };
      }
      case "open_tab": {
        const tab = await browser.tabs.create({
          url: input.url,
          active: input.active !== false,
        });
        return { ok: true, tabId: tab.id };
      }
      case "switch_tab": {
        await browser.tabs.update(input.tabId, { active: true });
        return { ok: true };
      }
      case "close_tab": {
        await browser.tabs.remove(input.tabId);
        return { ok: true };
      }
      case "navigate": {
        const tab = await getActiveTab();
        await browser.tabs.update(tab.id, { url: input.url });
        return { ok: true };
      }
      default:
        return { error: `Outil non implémenté : ${name}` };
    }
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}
