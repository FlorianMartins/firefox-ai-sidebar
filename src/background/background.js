// Background (event page non-persistant). Volontairement minimal : tout le
// travail (appels API, boucle agent) se fait dans la sidebar, qui a accès aux
// API browser.* et reste ouverte pendant l'usage.

browser.runtime.onInstalled.addListener(() => {
  browser.contextMenus.create({
    id: "open-ai-sidebar",
    title: "Ouvrir AI Sidebar",
    contexts: ["all"],
  });
});

browser.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "open-ai-sidebar") {
    browser.sidebarAction.open();
  }
});
