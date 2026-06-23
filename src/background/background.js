// Background (non-persistent event page). Deliberately minimal: all the real
// work (API calls, agent loop) happens in the sidebar, which holds the browser.*
// APIs and stays open during use.
//
// Responsibilities here:
//   1. Sider-style right-click menus on the page / selection.
//   2. Relaying the webmail "draft reply" request to the sidebar.
// In both cases we drop a pending action into storage.local and open the
// sidebar, which picks it up and runs it.

// Context-menu items. Contexts are fixed; titles are localised (English default,
// French when the user picks uiLang="fr" in Settings).
const MENU_ITEMS = [
  { id: "ai-open", contexts: ["all"] },
  { id: "ai-summarize-page", contexts: ["page"] },
  { id: "ai-translate-page", contexts: ["page"] },
  { id: "ai-summarize-sel", contexts: ["selection"] },
  { id: "ai-explain", contexts: ["selection"] },
  { id: "ai-translate-sel", contexts: ["selection"] },
  { id: "ai-improve", contexts: ["selection"] },
  { id: "ai-reply", contexts: ["selection", "editable"] },
];
const MENU_TITLES = {
  en: {
    "ai-open": "Open AI Sidebar",
    "ai-summarize-page": "Summarize the page",
    "ai-translate-page": "Translate the page",
    "ai-summarize-sel": "Summarize the selection",
    "ai-explain": "Explain the selection",
    "ai-translate-sel": "Translate the selection",
    "ai-improve": "Improve the selected text",
    "ai-reply": "Draft a reply to this text",
  },
  fr: {
    "ai-open": "Ouvrir AI Sidebar",
    "ai-summarize-page": "Résumer la page",
    "ai-translate-page": "Traduire la page",
    "ai-summarize-sel": "Résumer la sélection",
    "ai-explain": "Expliquer la sélection",
    "ai-translate-sel": "Traduire la sélection",
    "ai-improve": "Améliorer le texte sélectionné",
    "ai-reply": "Rédiger une réponse à ce texte",
  },
};

async function buildMenus() {
  let lang = "en";
  try {
    const { uiLang } = await browser.storage.local.get("uiLang");
    lang = uiLang === "fr" ? "fr" : "en";
  } catch (_) {}
  const titles = MENU_TITLES[lang] || MENU_TITLES.en;
  await browser.contextMenus.removeAll();
  for (const m of MENU_ITEMS) {
    browser.contextMenus.create({ id: m.id, title: titles[m.id], contexts: m.contexts });
  }
}

// Map a menu id to a sidebar quick-action name. Page-level items pass no text,
// so the sidebar falls back to the current page.
const MENU_ACTION = {
  "ai-summarize-page": "summarize",
  "ai-translate-page": "translate",
  "ai-summarize-sel": "summarize-selection",
  "ai-explain": "explain",
  "ai-translate-sel": "translate",
  "ai-improve": "improve",
  "ai-reply": "reply",
};

// Cross-browser sidebar open: Firefox exposes sidebarAction; Chromium uses
// sidePanel. We call it synchronously inside the click handler so the user
// gesture is preserved (Chromium requires it).
function openSidebar(tab) {
  try {
    if (typeof browser !== "undefined" && browser.sidebarAction && browser.sidebarAction.open) {
      return browser.sidebarAction.open();
    }
  } catch (_) {}
  try {
    if (typeof chrome !== "undefined" && chrome.sidePanel && chrome.sidePanel.open) {
      return chrome.sidePanel.open({ windowId: tab && tab.windowId });
    }
  } catch (_) {}
}

browser.runtime.onInstalled.addListener(() => {
  buildMenus();
  // Chromium: make the toolbar action open the side panel.
  try {
    if (typeof chrome !== "undefined" && chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    }
  } catch (_) {}
});
// Rebuild context menus also on browser startup and whenever the UI language changes.
if (browser.runtime.onStartup) browser.runtime.onStartup.addListener(() => buildMenus());
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.uiLang) buildMenus();
});

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "ai-open") {
    openSidebar(tab);
    return;
  }
  const action = MENU_ACTION[info.menuItemId];
  if (!action) return;
  // Fire-and-forget the storage write, then open synchronously (keep the gesture).
  browser.storage.local.set({
    pendingAction: { action, text: info.selectionText || "", ts: Date.now() },
  });
  openSidebar(tab);
});

// Webmail helper: the content-script button forwards the email thread here.
// If the sidebar is already open it also receives this message directly and acts
// live; this handler is the fallback that queues the draft and tries to open.
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === "draft_reply") {
    browser.storage.local.set({
      pendingAction: { action: "reply", text: msg.thread || "", ts: Date.now() },
    });
    openSidebar(sender && sender.tab);
  }
});
