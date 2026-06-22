// Runs inside the embedded provider chat sites (ChatGPT, Claude, Gemini…) when
// they are framed in the sidebar's "Account / site" mode. It listens for a
// postMessage from the sidebar and drops the given text into the chat's input
// box, so features like "read the open tab" keep working even though the page is
// the provider's own website (using the user's account/subscription).
(function () {
  if (window.__aiSiteInject) return;
  window.__aiSiteInject = true;

  function findInput() {
    // Most chat UIs use a <textarea> or a contenteditable composer.
    const candidates = [
      'textarea:not([readonly])',
      'div[contenteditable="true"]',
      '[role="textbox"]',
    ];
    for (const sel of candidates) {
      const list = [...document.querySelectorAll(sel)].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 80 && r.height > 0;
      });
      if (list.length) return list[list.length - 1]; // the main composer is usually last
    }
    return null;
  }

  function setValue(el, text) {
    el.focus();
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
      if (setter && setter.set) setter.set.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      // contenteditable
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
  }

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.__aiSiteInsert !== true) return;
    const el = findInput();
    if (!el) return;
    setValue(el, String(d.text || ""));
  });
})();
