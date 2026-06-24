// API clients. Two families sharing one interface:
//   runTurn({ system, history, tools, onText, onThink, signal })
//     -> { message, toolCalls:[{id,name,input}], stopReason, text }
//   formatToolResults(results) -> native message(s) to push into the history
//
// `history` and `message` stay in each provider's NATIVE wire format (Anthropic
// vs OpenAI) to remain faithful to each API. The agent loop (agent.js) only ever
// touches the normalised `toolCalls` array.
//
// `onThink(delta)` receives reasoning text (Anthropic extended thinking,
// DeepSeek/o-series reasoning_content) so the UI can show it separately.

import { PROVIDERS, baseUrlFor, modelFor, keyFor } from "./models.js";

const MAX_TOKENS = 4096;
const THINKING_BUDGET = 6000;

// Generic SSE reader: yields the payloads of "data:" lines.
async function* sseData(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}

async function ensureOk(response) {
  if (response.ok) return;
  let detail = "";
  try {
    detail = await response.text();
  } catch (_) {}
  throw new Error(`HTTP ${response.status} — ${detail.slice(0, 500)}`);
}

// ---------------------------------------------------------------------------
// Anthropic (Claude) — native API, + extended thinking + server-side web search
// ---------------------------------------------------------------------------
function anthropicProvider({ apiKey, model, baseUrl, thinking, webSearch }) {
  const url = baseUrl.replace(/\/$/, "") + "/messages";
  return {
    id: "anthropic",

    async runTurn({ system, history, tools, onText, onThink, signal }) {
      const useThinking = !!thinking;
      const body = {
        model,
        max_tokens: useThinking ? MAX_TOKENS + THINKING_BUDGET : MAX_TOKENS,
        system,
        messages: history,
        stream: true,
      };
      if (useThinking) {
        body.thinking = { type: "enabled", budget_tokens: THINKING_BUDGET };
      }
      const toolList = [];
      if (tools && tools.length) {
        for (const t of tools)
          toolList.push({ name: t.name, description: t.description, input_schema: t.input_schema });
      }
      if (webSearch) {
        toolList.push({ type: "web_search_20250305", name: "web_search", max_uses: 5 });
      }
      if (toolList.length) body.tools = toolList;

      const response = await fetch(url, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify(body),
      });
      await ensureOk(response);

      const blocks = [];
      let stopReason = null;
      let text = "";

      for await (const data of sseData(response)) {
        if (data === "[DONE]") break;
        let ev;
        try {
          ev = JSON.parse(data);
        } catch (_) {
          continue;
        }
        switch (ev.type) {
          case "content_block_start":
            blocks[ev.index] = { ...ev.content_block, _partial: "" };
            break;
          case "content_block_delta": {
            const b = blocks[ev.index];
            if (!b) break;
            const d = ev.delta;
            if (d.type === "text_delta") {
              b.text = (b.text || "") + d.text;
              text += d.text;
              onText && onText(d.text);
            } else if (d.type === "thinking_delta") {
              b.thinking = (b.thinking || "") + d.thinking;
              onThink && onThink(d.thinking);
            } else if (d.type === "signature_delta") {
              b.signature = (b.signature || "") + d.signature;
            } else if (d.type === "input_json_delta") {
              b._partial += d.partial_json;
            }
            break;
          }
          case "content_block_stop": {
            const b = blocks[ev.index];
            if (b && b.type === "tool_use") {
              try {
                b.input = JSON.parse(b._partial || "{}");
              } catch (_) {
                b.input = {};
              }
            }
            if (b) delete b._partial;
            break;
          }
          case "message_delta":
            if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
            break;
        }
      }

      // Keep ALL blocks (including thinking with its signature, which the API
      // requires on the next turn) so the conversation stays valid.
      const content = blocks.filter(Boolean).map((b) => {
        if (b.type === "tool_use")
          return { type: "tool_use", id: b.id, name: b.name, input: b.input || {} };
        if (b.type === "text") return { type: "text", text: b.text || "" };
        if (b.type === "thinking")
          return { type: "thinking", thinking: b.thinking || "", signature: b.signature || "" };
        if (b.type === "redacted_thinking")
          return { type: "redacted_thinking", data: b.data };
        return b;
      });

      const toolCalls = content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));

      return { message: { role: "assistant", content }, toolCalls, stopReason, text };
    },

    formatToolResults(results) {
      return {
        role: "user",
        content: results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.id,
          content: r.content,
          is_error: !!r.isError,
        })),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Generic OpenAI-compatible (OpenAI, OpenRouter, Gemini, Mistral, Groq,
// DeepSeek, Ollama, LM Studio, self-hosted…)
// ---------------------------------------------------------------------------
function openaiProvider({ apiKey, model, baseUrl, webSearch, providerId, thinking }) {
  const url = baseUrl.replace(/\/$/, "") + "/chat/completions";
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  // OpenRouter attribution headers (ignored by other providers). They carry no
  // user data — just the app name/repo — and are sent only to the chosen endpoint.
  headers["HTTP-Referer"] = "https://github.com/FlorianMartins/firefox-ai-sidebar";
  headers["X-Title"] = "AI Sidebar";

  return {
    id: "openai",

    async runTurn({ system, history, tools, onText, onThink, signal }) {
      const messages = system ? [{ role: "system", content: system }, ...history] : [...history];
      const body = { model, messages, stream: true };
      // Web search: OpenRouter exposes a universal "web" plugin that works with
      // ANY model (including the free ones), so a fast free model can search the
      // web. Perplexity's Sonar models are online by default (nothing to add).
      if (webSearch && providerId === "openrouter") {
        body.plugins = [{ id: "web", max_results: 5 }];
      }
      // Reasoning / "thinking" for OpenAI-compatible providers. OpenRouter exposes a
      // universal `reasoning` switch that turns on a model's chain-of-thought (when it
      // supports one) and streams it back as `delta.reasoning` — which we surface in the
      // 💭 block. DeepSeek's reasoner models stream `reasoning_content` on their own.
      // We only send the param to OpenRouter; other strict APIs would reject an unknown
      // field, and models that don't reason simply ignore the toggle.
      //
      // IMPORTANT for speed/cost: many default models (gpt-oss, Nemotron, Qwen-thinking…)
      // REASON BY DEFAULT, which is slow and burns tokens. So when the Thinking toggle is
      // OFF we explicitly DISABLE reasoning for a fast, cheap, near-instant answer — and
      // only enable it when the user actually asks for it.
      if (providerId === "openrouter") {
        body.reasoning = thinking ? { effort: "medium" } : { enabled: false };
      }
      if (tools && tools.length) {
        body.tools = tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.input_schema },
        }));
      }

      const response = await fetch(url, {
        method: "POST",
        signal,
        headers,
        body: JSON.stringify(body),
      });
      await ensureOk(response);

      let text = "";
      let finishReason = null;
      const toolAcc = {};

      for await (const data of sseData(response)) {
        if (data === "[DONE]") break;
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch (_) {
          continue;
        }
        const choice = chunk.choices && chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        // Reasoning text (DeepSeek: reasoning_content ; OpenRouter: reasoning)
        const reason = delta.reasoning_content || delta.reasoning;
        if (reason) onThink && onThink(reason);
        if (delta.content) {
          text += delta.content;
          onText && onText(delta.content);
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            if (!toolAcc[i]) toolAcc[i] = { id: tc.id, name: "", args: "" };
            if (tc.id) toolAcc[i].id = tc.id;
            if (tc.function && tc.function.name) toolAcc[i].name = tc.function.name;
            if (tc.function && tc.function.arguments) toolAcc[i].args += tc.function.arguments;
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }

      const nativeToolCalls = Object.values(toolAcc).map((t) => ({
        id: t.id,
        type: "function",
        function: { name: t.name, arguments: t.args || "{}" },
      }));

      const message = { role: "assistant", content: text || null };
      if (nativeToolCalls.length) message.tool_calls = nativeToolCalls;

      const toolCalls = nativeToolCalls.map((t) => {
        let input = {};
        try {
          input = JSON.parse(t.function.arguments || "{}");
        } catch (_) {}
        return { id: t.id, name: t.function.name, input };
      });

      return {
        message,
        toolCalls,
        stopReason: finishReason === "tool_calls" ? "tool_use" : finishReason,
        text,
      };
    },

    formatToolResults(results) {
      return results.map((r) => ({
        role: "tool",
        tool_call_id: r.id,
        content: r.content,
      }));
    },
  };
}

// Build the provider for the current conversation.
export function makeProvider(settings, opts = {}) {
  const id = settings.provider;
  const meta = PROVIDERS[id] || PROVIDERS.anthropic;
  const apiKey = keyFor(id, settings);
  const model = modelFor(id, settings);
  const baseUrl = baseUrlFor(id, settings);

  if (meta.kind === "anthropic") {
    return anthropicProvider({
      apiKey,
      model,
      baseUrl,
      thinking: !!opts.thinking && meta.supportsThinking,
      webSearch: !!opts.webSearch && meta.supportsWebSearch,
    });
  }
  return openaiProvider({
    apiKey,
    model,
    baseUrl,
    providerId: id,
    webSearch: !!opts.webSearch && !!meta.supportsWebSearch,
    thinking: !!opts.thinking,
  });
}

// OpenRouter: rich model list with vendor, display name and per-token pricing.
// Used to build the hierarchical menu (OpenRouter › vendor › model + cost).
export async function listOpenRouterRich(settings) {
  const baseUrl = baseUrlFor("openrouter", settings);
  const apiKey = keyFor("openrouter", settings);
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const res = await fetch(baseUrl.replace(/\/$/, "") + "/models", { headers });
  await ensureOk(res);
  const json = await res.json();
  return (json.data || []).map((m) => {
    const outMods = (m.architecture && m.architecture.output_modalities) || [];
    return {
      id: m.id,
      name: m.name || m.id,
      prompt: parseFloat((m.pricing && m.pricing.prompt) || "0"),
      completion: parseFloat((m.pricing && m.pricing.completion) || "0"),
      // Can this model OUTPUT images? (used to populate the Image tab dynamically)
      image: Array.isArray(outMods) && outMods.includes("image"),
    };
  });
}

// -------- Dynamic model listing (OpenAI /models format) ---------------------
export async function listModels(providerId, settings) {
  const meta = PROVIDERS[providerId];
  if (!meta) throw new Error("Fournisseur inconnu");
  const baseUrl = baseUrlFor(providerId, settings);
  if (!baseUrl) throw new Error("Base URL manquante.");
  const apiKey = keyFor(providerId, settings);
  const url = baseUrl.replace(/\/$/, "") + "/models";

  // Anthropic uses its own auth headers (no Bearer) for GET /v1/models.
  const headers =
    meta.kind === "anthropic"
      ? {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        }
      : apiKey
        ? { authorization: `Bearer ${apiKey}` }
        : {};

  const res = await fetch(url, { headers });
  await ensureOk(res);
  const json = await res.json();
  const data = json.data || json.models || [];
  return data
    .map((m) => m.id || m.name)
    .filter(Boolean)
    .sort();
}

// -------- Audio transcription (Whisper-style /audio/transcriptions) ----------
// Powers the composer's voice-dictation fallback when the browser has no Web Speech
// API (e.g. Firefox). Posts the recorded audio to a connected OpenAI- or Groq-
// compatible endpoint and returns the recognised text. 100% BYOK — uses the user's
// own key and goes straight to the provider they chose.
export async function transcribeAudio(settings, blob) {
  const providerId = settings.provider;
  const meta = PROVIDERS[providerId];
  if (!meta) throw new Error("No transcription provider connected.");
  const baseUrl = baseUrlFor(providerId, settings);
  const apiKey = keyFor(providerId, settings);
  if (meta.needsKey && !apiKey) throw new Error(`API key missing for ${meta.label}.`);
  const model = providerId === "groq" ? "whisper-large-v3" : "whisper-1";
  const ext = (blob.type || "").includes("ogg") ? "ogg" : (blob.type || "").includes("mp4") ? "mp4" : "webm";
  const fd = new FormData();
  fd.append("file", blob, `audio.${ext}`);
  fd.append("model", model);
  const headers = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(baseUrl.replace(/\/$/, "") + "/audio/transcriptions", { method: "POST", headers, body: fd });
  await ensureOk(res);
  const json = await res.json();
  return (json && (json.text || (json.results && json.results[0] && json.results[0].text))) || "";
}

// -------- Image generation (OpenAI-compatible /images/generations) ----------
// Returns a list of data: (or http) URLs to display.
export async function generateImage(settings, { prompt, size, signal }) {
  // size === "" (or unset) means: no fixed size — let the model use the dimensions
  // described in the prompt (and providers fall back to their own default).
  size = size != null ? size : (settings.imageSize || "");
  const providerId = settings.imageProvider || "openai";
  const meta = PROVIDERS[providerId];
  if (!meta || !meta.supportsImages) {
    throw new Error(
      `Le fournisseur d'images « ${providerId} » n'est pas supporté. Choisissez OpenAI dans les réglages.`
    );
  }
  const baseUrl = baseUrlFor(providerId, settings);
  const apiKey = keyFor(providerId, settings);
  if (meta.needsKey && !apiKey) throw new Error(`Clé API manquante pour ${meta.label}.`);

  // Some providers (OpenRouter, Google) generate images through the chat-completions
  // API with image "modalities" rather than /images/generations. Those models have
  // no size parameter, so — as requested — we pass the size to the model as a plain
  // INSTRUCTION inside the prompt.
  if (meta.imageVia === "chat") {
    return generateImageViaChat({ baseUrl, apiKey, providerId, model: settings.imageModel || (meta.imageModels && meta.imageModels[0][0]), prompt, size, signal });
  }

  const body = {
    model: settings.imageModel || (meta.imageModels && meta.imageModels[0][0]),
    prompt,
    n: 1,
  };
  if (size) body.size = size; // omit when "—" (custom): the provider uses its default
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const res = await fetch(baseUrl.replace(/\/$/, "") + "/images/generations", {
    method: "POST",
    signal,
    headers,
    body: JSON.stringify(body),
  });
  await ensureOk(res);
  const json = await res.json();
  const out = [];
  for (const item of json.data || []) {
    if (item.b64_json) out.push(`data:image/png;base64,${item.b64_json}`);
    else if (item.url) out.push(item.url);
  }
  if (!out.length) throw new Error("Aucune image renvoyée par l'API.");
  return out;
}

// Image generation through the chat-completions API with image modalities
// (OpenRouter, Google "Nano Banana", etc.). These models have no size parameter,
// so the requested size is appended to the prompt as an instruction. Returns a
// list of data: / http image URLs.
async function generateImageViaChat({ baseUrl, apiKey, providerId, model, prompt, size, signal }) {
  const url = baseUrl.replace(/\/$/, "") + "/chat/completions";
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (providerId === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/FlorianMartins/firefox-ai-sidebar";
    headers["X-Title"] = "AI Sidebar";
  }
  const sizeHint = size ? ` Target size/aspect: ${size} pixels.` : "";
  const body = {
    model,
    modalities: ["image", "text"],
    messages: [{ role: "user", content: `Generate an image: ${prompt}.${sizeHint}` }],
  };
  const res = await fetch(url, { method: "POST", signal, headers, body: JSON.stringify(body) });
  await ensureOk(res);
  const json = await res.json();
  const out = [];
  const msg = json.choices && json.choices[0] && json.choices[0].message;
  // OpenRouter/Gemini return generated images under message.images[].image_url.url
  for (const im of (msg && msg.images) || []) {
    const u = im && (im.image_url ? im.image_url.url : im.url);
    if (u) out.push(u);
  }
  // Some return a data URL directly in the content.
  if (!out.length && typeof (msg && msg.content) === "string") {
    const m = msg.content.match(/data:image\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]+/);
    if (m) out.push(m[0]);
  }
  if (!out.length) throw new Error("Aucune image renvoyée par le modèle (essayez un autre modèle d'image).");
  return out;
}
