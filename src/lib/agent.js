// Boucle d'agent : enchaîne tours de modèle et exécutions d'outils jusqu'à ce
// que le modèle n'appelle plus d'outil (ou que la limite d'étapes soit atteinte).

import { executeTool, TOOLS } from "./tools.js";

export function buildSystemPrompt({ agentMode }) {
  let p =
    "Tu es un assistant intégré en sidebar dans le navigateur Firefox de l'utilisateur. " +
    "Tu réponds de façon concise et utile, en français par défaut (ou dans la langue de l'utilisateur). " +
    "Tu peux recevoir le contenu de la page consultée comme contexte.\n\n" +
    "Formate tes réponses en Markdown. Pour les blocs de code, précise toujours le langage. " +
    "Pour un diagramme, utilise un bloc ```mermaid (il sera rendu visuellement). " +
    "Pour une maquette ou un composant web, utilise un bloc ```html ou ```svg (un bouton « Aperçu » l'affichera).";
  if (agentMode) {
    p +=
      "\n\nMODE AGENT ACTIF. Tu disposes d'outils pour lire et agir dans le navigateur " +
      "(lire la page, lister/ouvrir/fermer des onglets, cliquer, remplir des champs, naviguer). " +
      "Procède étape par étape : appelle find_elements avant click_element/fill_input pour obtenir les 'ref'. " +
      "Les actions qui modifient l'état (clic, saisie, navigation, onglets) peuvent demander une confirmation de l'utilisateur ; " +
      "explique brièvement ce que tu fais. N'invente jamais de 'ref' : utilise celles renvoyées par find_elements.";
  }
  return p;
}

// tools à exposer selon le mode
export function activeTools({ agentMode }) {
  if (!agentMode) return [];
  return TOOLS;
}

export async function runConversation({
  provider,
  system,
  history,
  tools,
  onText,
  onToolStart,
  onToolEnd,
  confirmActions,
  confirmFn,
  signal,
  maxSteps = 8,
}) {
  for (let step = 0; step < maxSteps; step++) {
    const turn = await provider.runTurn({ system, history, tools, onText, signal });
    history.push(turn.message);

    if (!turn.toolCalls.length || turn.stopReason !== "tool_use") {
      return { history, text: turn.text, done: true };
    }

    const results = [];
    for (const call of turn.toolCalls) {
      onToolStart && onToolStart(call);
      const out = await executeTool(call.name, call.input, { confirmActions, confirmFn });
      onToolEnd && onToolEnd(call, out);
      results.push({
        id: call.id,
        name: call.name,
        content: JSON.stringify(out).slice(0, 8000),
        isError: !!(out && out.error),
      });
    }

    const formatted = provider.formatToolResults(results);
    history.push(...[].concat(formatted));
  }
  return { history, done: false, text: "(Limite d'étapes du mode agent atteinte.)" };
}
