// Content script: reads the page and performs the DOM actions requested by the
// agent. Injected on every page (document_idle) and re-injected on demand by
// tools.js. Also powers the page element picker and region screenshot capture.
(function () {
  if (window.__aiSidebarInjected) return;
  window.__aiSidebarInjected = true;

  const refMap = new Map(); // ref -> element
  let refCounter = 0;

  // --- Safety: payment / checkout guardrail --------------------------------
  // The agent may browse and fill a cart, but never transact. We refuse clicks
  // on payment/checkout controls and typing into card fields. Matching is
  // intentionally broad (EN + FR) and errs on the side of refusing.
  const PAY_WORDS = [
    "pay now", "pay ", "payment", "checkout", "check out", "place order",
    "place your order", "buy now", "buy ", "purchase", "complete purchase",
    "confirm order", "confirm and pay", "proceed to payment", "proceed to checkout",
    "subscribe", "complete order", "order now",
    // French
    "payer", "paiement", "payez", "régler", "passer commande", "passer la commande",
    "valider la commande", "valider le paiement", "confirmer la commande",
    "confirmer l'achat", "acheter", "procéder au paiement", "finaliser la commande",
    "finaliser l'achat",
  ];
  const CARD_FIELD = /(card.?number|cardnum|cc.?num|cvv|cvc|cryptogramme|num(é|e)ro.?de.?carte|expir|exp.?date|securitycode|card.?code)/i;

  function textOf(el) {
    return (
      (el.innerText || el.value || "") + " " +
      (el.getAttribute && (
        (el.getAttribute("aria-label") || "") + " " +
        (el.getAttribute("name") || "") + " " +
        (el.getAttribute("id") || "") + " " +
        (el.getAttribute("title") || "") + " " +
        (el.getAttribute("value") || "")
      ) || "")
    ).toLowerCase();
  }

  function looksLikePaymentControl(el) {
    const hay = textOf(el);
    return PAY_WORDS.some((w) => hay.includes(w));
  }

  function looksLikeCardField(el) {
    const ac = (el.getAttribute && el.getAttribute("autocomplete")) || "";
    if (/cc-(number|csc|exp)/i.test(ac)) return true;
    const hay =
      (el.getAttribute && (
        (el.getAttribute("name") || "") + " " +
        (el.getAttribute("id") || "") + " " +
        (el.getAttribute("placeholder") || "") + " " +
        (el.getAttribute("aria-label") || "")
      )) || "";
    return CARD_FIELD.test(hay);
  }

  // --- Very sensitive (non-payment) actions: ALWAYS confirmed, even in "Allow" mode.
  // Downloading, reserving/booking, deleting, transferring, signing up, installing… The
  // agent must get the user's OK before doing these. Payments stay hard-blocked above.
  const SENSITIVE_WORDS = [
    "download", "télécharger", "telecharger",
    "reserve", "reservation", "réserver", "reserver", "réservation",
    "book now", "book ticket", "booking",
    "delete", "supprimer", "remove account", "delete account", "supprimer le compte",
    "transfer", "transférer", "transferer", "virement", "wire ",
    "sign up", "signup", "register", "create account", "s'inscrire", "inscrire", "créer un compte", "creer un compte",
    "apply now", "postuler", "submit application",
    "install", "installer",
    "send email", "send message", "envoyer le message", "envoyer un message",
    "unsubscribe", "se désabonner", "se desabonner",
    "publish", "publier", "post publicly",
  ];
  function looksLikeSensitiveControl(el) {
    // A real download link/button (download attribute or a file href).
    if (el.tagName === "A" &&
        ((el.hasAttribute && el.hasAttribute("download")) ||
         /\.(zip|exe|dmg|msi|pkg|apk|iso|deb|rpm|7z|rar|tar|gz|jar|bin|app|csv|xlsx?)(\?|#|$)/i.test((el.getAttribute && el.getAttribute("href")) || ""))) {
      return "download";
    }
    const hay = textOf(el);
    for (const w of SENSITIVE_WORDS) if (hay.includes(w)) return w.trim();
    return null;
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  }

  function labelOf(el) {
    const txt =
      (el.innerText || "").trim() ||
      (el.value || "").trim() ||
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      el.getAttribute("name") ||
      "";
    return txt.replace(/\s+/g, " ").slice(0, 120);
  }

  function metaDescription() {
    const m =
      document.querySelector('meta[name="description"]') ||
      document.querySelector('meta[property="og:description"]');
    return (m && m.getAttribute("content")) || "";
  }

  function readPage() {
    const main = document.querySelector("main, article, [role=main]") || document.body;
    const text = (main.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 20000);
    return {
      title: document.title,
      url: location.href,
      description: metaDescription(),
      text,
    };
  }

  function readSelection() {
    return { selection: (window.getSelection() || "").toString().slice(0, 8000) };
  }

  function findElements(query) {
    refMap.clear();
    refCounter = 0;
    const q = (query || "").toLowerCase().trim();
    const selector =
      "a[href], button, input:not([type=hidden]), textarea, select, [role=button], [onclick]";
    const out = [];
    const nodes = document.querySelectorAll(selector);
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const label = labelOf(el);
      const hay = (label + " " + (el.getAttribute("href") || "")).toLowerCase();
      if (q && !hay.includes(q)) continue;
      const ref = "e" + ++refCounter;
      refMap.set(ref, el);
      out.push({
        ref,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || undefined,
        text: label,
        href: el.getAttribute("href") || undefined,
        // Hint so the model can avoid even proposing a payment action.
        payment: looksLikePaymentControl(el) || undefined,
      });
      if (out.length >= 60) break;
    }
    return { count: out.length, elements: out };
  }

  function clickElement(ref, guard, confirmed) {
    const el = refMap.get(ref);
    if (!el) return { error: `ref not found: ${ref} (re-run find_elements)` };
    if (guard && guard.blockPayments && looksLikePaymentControl(el)) {
      return { error: "Blocked by safety guardrail: payment/checkout action is not allowed.", blocked: true };
    }
    // Very sensitive action → ask the user to confirm (even in "Allow" mode).
    if (!confirmed) {
      const reason = looksLikeSensitiveControl(el);
      if (reason) return { confirm: true, action: reason, label: labelOf(el) };
    }
    el.scrollIntoView({ block: "center" });
    el.click();
    return { ok: true, clicked: labelOf(el) };
  }

  function fillInput(ref, value, submit, guard, confirmed) {
    const el = refMap.get(ref);
    if (!el) return { error: `ref not found: ${ref} (re-run find_elements)` };
    if (guard && guard.blockPayments && looksLikeCardField(el)) {
      return { error: "Blocked by safety guardrail: card/payment field is not allowed.", blocked: true };
    }
    // If submitting a form that triggers a very sensitive action, confirm first.
    if (submit && !confirmed) {
      const reason = (el.form && looksLikeSensitiveControl(el.form)) || looksLikeSensitiveControl(el);
      if (reason) return { confirm: true, action: reason, label: labelOf(el) };
    }
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (submit) {
      // Refuse to submit a form that looks like a payment form.
      if (guard && guard.blockPayments && el.form && looksLikePaymentControl(el.form)) {
        return { ok: true, filled: labelOf(el), note: "Filled but submit blocked (payment form)." };
      }
      const form = el.form;
      if (form) {
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.submit();
      } else {
        el.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })
        );
      }
    }
    return { ok: true, filled: labelOf(el) };
  }

  function scrollPage(direction) {
    const h = window.innerHeight;
    if (direction === "top") window.scrollTo({ top: 0, behavior: "smooth" });
    else if (direction === "bottom")
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    else window.scrollBy({ top: direction === "up" ? -h * 0.9 : h * 0.9, behavior: "smooth" });
    return { ok: true };
  }

  // --- Element picker ------------------------------------------------------
  // Lets the user point at any element on the page (a table, an image, a menu…) and
  // "ask the AI about it". Hover outlines the element; a single click captures it;
  // holding the left button and dragging across several elements selects them all
  // (each captured). Esc, or a pick_cancel message from the sidebar, aborts cleanly.
  let pickResolve = null;
  let pickHoverBox = null;
  let pickHover = null;
  let pickPainting = false;
  let pickSelected = [];
  let pickBoxes = [];
  function mkBox(color, bg, z) {
    const d = document.createElement("div");
    Object.assign(d.style, {
      position: "fixed", zIndex: z, top: 0, left: 0, width: 0, height: 0,
      border: "2px solid " + color, background: bg, borderRadius: "3px", pointerEvents: "none",
    });
    document.documentElement.appendChild(d);
    return d;
  }
  function placeBox(d, r) {
    Object.assign(d.style, { top: r.top + "px", left: r.left + "px", width: r.width + "px", height: r.height + "px" });
  }
  function addSelected(el) {
    if (!el || pickSelected.includes(el)) return;
    pickSelected.push(el);
    const b = mkBox("#8b5cf6", "rgba(139,92,246,.22)", 2147483646);
    placeBox(b, el.getBoundingClientRect());
    pickBoxes.push(b);
  }
  function pickMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    if (pickPainting) { addSelected(el); }
    else { pickHover = el; placeBox(pickHoverBox, el.getBoundingClientRect()); }
  }
  function pickDown(e) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    pickPainting = true;
    if (pickHoverBox) pickHoverBox.style.display = "none";
    addSelected(pickHover || document.elementFromPoint(e.clientX, e.clientY));
  }
  function pickUp(e) {
    if (!pickPainting) return;
    e.preventDefault(); e.stopPropagation();
    endPick(false);
  }
  function pickSwallow(e) { e.preventDefault(); e.stopPropagation(); } // don't trigger page links/buttons
  function pickKey(e) { if (e.key === "Escape") { e.preventDefault(); endPick(true); } }
  function describeElement(el) {
    const rect = el.getBoundingClientRect();
    const text = (el.innerText || el.textContent || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 8000);
    let imgSrc = "";
    if (el.tagName === "IMG") imgSrc = el.currentSrc || el.src || "";
    return { tag: el.tagName.toLowerCase(), text, imgSrc, rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height } };
  }
  function endPick(cancelled) {
    document.removeEventListener("mousemove", pickMove, true);
    document.removeEventListener("mousedown", pickDown, true);
    document.removeEventListener("mouseup", pickUp, true);
    document.removeEventListener("click", pickSwallow, true);
    document.removeEventListener("keydown", pickKey, true);
    document.documentElement.style.cursor = "";
    if (pickHoverBox) { pickHoverBox.remove(); pickHoverBox = null; }
    pickBoxes.forEach((b) => b.remove());
    const els = pickSelected;
    pickBoxes = []; pickSelected = []; pickPainting = false;
    const r = pickResolve; pickResolve = null;
    if (!r) return;
    if (cancelled || !els.length) { r({ cancelled: true }); return; }
    r({ elements: els.slice(0, 8).map(describeElement), dpr: window.devicePixelRatio || 1, url: location.href, title: document.title });
  }
  function startPick() {
    if (pickResolve) endPick(true); // restart cleanly
    return new Promise((resolve) => {
      pickResolve = resolve; pickSelected = []; pickBoxes = []; pickPainting = false; pickHover = null;
      pickHoverBox = mkBox("#a855f7", "rgba(168,85,247,.14)", 2147483647);
      document.documentElement.style.cursor = "crosshair";
      document.addEventListener("mousemove", pickMove, true);
      document.addEventListener("mousedown", pickDown, true);
      document.addEventListener("mouseup", pickUp, true);
      document.addEventListener("click", pickSwallow, true);
      document.addEventListener("keydown", pickKey, true);
    });
  }

  // --- Region capture (screenshot tool) -----------------------------------
  // Lets the user draw a free rectangle over the page (like a screenshot selection);
  // we return the rect so the sidebar can crop the visible-tab screenshot and attach
  // that IMAGE to the context. Esc or right-click cancels.
  let regResolve = null, regBox = null, regStart = null, regDragging = false;
  function regRect(e) {
    const left = Math.min(e.clientX, regStart.x), top = Math.min(e.clientY, regStart.y);
    return { x: left, y: top, w: Math.abs(e.clientX - regStart.x), h: Math.abs(e.clientY - regStart.y) };
  }
  function regDown(e) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    regDragging = true; regStart = { x: e.clientX, y: e.clientY };
    placeBox(regBox, { left: e.clientX, top: e.clientY, width: 0, height: 0 });
  }
  function regMove(e) {
    if (!regDragging || !regStart) return;
    const r = regRect(e);
    placeBox(regBox, { left: r.x, top: r.y, width: r.w, height: r.h });
  }
  function regUp(e) {
    if (!regDragging) return;
    e.preventDefault(); e.stopPropagation();
    endRegion(false, regRect(e));
  }
  function regSwallow(e) { e.preventDefault(); e.stopPropagation(); }
  function regKey(e) { if (e.key === "Escape") { e.preventDefault(); endRegion(true); } }
  function endRegion(cancelled, rect) {
    document.removeEventListener("mousedown", regDown, true);
    document.removeEventListener("mousemove", regMove, true);
    document.removeEventListener("mouseup", regUp, true);
    document.removeEventListener("click", regSwallow, true);
    document.removeEventListener("keydown", regKey, true);
    document.documentElement.style.cursor = "";
    if (regBox) { regBox.remove(); regBox = null; }
    regDragging = false; regStart = null;
    const r = regResolve; regResolve = null;
    if (!r) return;
    if (cancelled || !rect || rect.w < 5 || rect.h < 5) { r({ cancelled: true }); return; }
    r({ rect, dpr: window.devicePixelRatio || 1, url: location.href, title: document.title });
  }
  function startRegion() {
    if (regResolve) endRegion(true);
    return new Promise((resolve) => {
      regResolve = resolve; regDragging = false; regStart = null;
      regBox = mkBox("#a855f7", "rgba(168,85,247,.14)", 2147483647);
      document.documentElement.style.cursor = "crosshair";
      document.addEventListener("mousedown", regDown, true);
      document.addEventListener("mousemove", regMove, true);
      document.addEventListener("mouseup", regUp, true);
      document.addEventListener("click", regSwallow, true);
      document.addEventListener("keydown", regKey, true);
    });
  }

  // --- Agent activity glow -------------------------------------------------
  // A soft pulsing border around the viewport (à la Perplexity) shown while the agent
  // is acting on this page. pointer-events:none so it never blocks the page.
  let glowEl = null;
  function setAgentGlow(on) {
    if (on) {
      if (glowEl && document.documentElement.contains(glowEl)) return;
      if (!document.getElementById("__ai_agent_glow_style")) {
        const st = document.createElement("style");
        st.id = "__ai_agent_glow_style";
        st.textContent =
          "@keyframes aiAgentGlow{0%,100%{box-shadow:inset 0 0 16px 3px rgba(139,92,246,.55),inset 0 0 4px 1px rgba(168,85,247,.85)}50%{box-shadow:inset 0 0 36px 9px rgba(99,102,241,.8),inset 0 0 9px 2px rgba(168,85,247,1)}}" +
          "#__ai_agent_glow{position:fixed;inset:0;z-index:2147483646;pointer-events:none;border-radius:2px;animation:aiAgentGlow 1.8s ease-in-out infinite}";
        (document.head || document.documentElement).appendChild(st);
      }
      glowEl = document.createElement("div");
      glowEl.id = "__ai_agent_glow";
      document.documentElement.appendChild(glowEl);
    } else if (glowEl) {
      glowEl.remove();
      glowEl = null;
    }
  }

  browser.runtime.onMessage.addListener((msg) => {
    switch (msg && msg.type) {
      case "agent_glow":
        setAgentGlow(!!msg.on);
        return Promise.resolve({ ok: true });
      case "read_page":
        return Promise.resolve(readPage());
      case "read_selection":
        return Promise.resolve(readSelection());
      case "pick_element":
        return startPick();
      case "pick_cancel":
        if (pickResolve) endPick(true);
        return Promise.resolve({ ok: true });
      case "capture_region":
        return startRegion();
      case "region_cancel":
        if (regResolve) endRegion(true);
        return Promise.resolve({ ok: true });
      case "find_elements":
        return Promise.resolve(findElements(msg.query));
      case "click_element":
        return Promise.resolve(clickElement(msg.ref, msg.guard, msg.confirmed));
      case "fill_input":
        return Promise.resolve(fillInput(msg.ref, msg.value, msg.submit, msg.guard, msg.confirmed));
      case "scroll_page":
        return Promise.resolve(scrollPage(msg.direction));
      case "ping":
        return Promise.resolve({ ok: true });
    }
    return false;
  });

  // --- SPA navigation notifier ---------------------------------------------
  // Tell the sidebar when the URL changes via the History API (pushState /
  // popstate), which does not always fire tabs.onUpdated. Classic navigations
  // (new site, subdomain) are caught by the sidebar via tab events instead.
  let lastUrl = location.href;
  const notifyNav = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    try {
      browser.runtime.sendMessage({ type: "page_changed", url: location.href });
    } catch (_) {}
  };
  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    history[m] = function () {
      const r = orig.apply(this, arguments);
      setTimeout(notifyNav, 50);
      return r;
    };
  }
  window.addEventListener("popstate", () => setTimeout(notifyNav, 50));

})();
