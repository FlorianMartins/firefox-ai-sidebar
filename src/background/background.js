// Background (event page non-persistant). Volontairement minimal : tout le
// travail (appels API, boucle agent) se fait dans la sidebar, qui a accès aux
// API browser.* et reste ouverte pendant l'usage.
//
// Rôle ici : menus contextuels « à la Sider » sur la sélection. Au clic, on
// dépose une action en attente (storage.local) et on ouvre la sidebar, qui la
// récupère et l'exécute.

const MENU = [
  { id: "ai-open", title: "Ouvrir AI Sidebar", contexts: ["all"] },
  { id: "ai-summarize", title: "Résumer la page", contexts: ["page", "selection"] },
  { id: "ai-explain", title: "Expliquer la sélection", contexts: ["selection"] },
  { id: "ai-translate", title: "Traduire la sélection", contexts: ["selection"] },
  { id: "ai-improve", title: "Améliorer le texte sélectionné", contexts: ["selection"] },
];

browser.runtime.onInstalled.addListener(() => {
  browser.contextMenus.removeAll().then(() => {
    for (const m of MENU) browser.contextMenus.create(m);
  });
});

const ACTION_BY_MENU = {
  "ai-summarize": "summarize",
  "ai-explain": "explain",
  "ai-translate": "translate",
  "ai-improve": "improve",
};

browser.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === "ai-open") {
    browser.sidebarAction.open();
    return;
  }
  const action = ACTION_BY_MENU[info.menuItemId];
  if (!action) return;
  await browser.storage.local.set({
    pendingAction: {
      action,
      text: info.selectionText || "",
      ts: Date.now(),
    },
  });
  try {
    await browser.sidebarAction.open();
  } catch (_) {
    // open() doit être appelé depuis un geste utilisateur ; le clic menu compte.
  }
});
