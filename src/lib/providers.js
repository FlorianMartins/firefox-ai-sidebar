// Clients API. Deux providers exposant une interface commune :
//   runTurn({ system, history, tools, onText, signal })
//     -> { message, toolCalls:[{id,name,input}], stopReason, text }
//   formatToolResults(results) -> message natif à pousser dans l'historique
//
// `history` et `message` sont au format NATIF du provider (Anthropic vs OpenAI),
// pour rester fidèle à chaque API. La boucle agent (agent.js) ne manipule que la
// liste normalisée `toolCalls`.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_TOKENS = 4096;

// Lecteur SSE générique : renvoie les charges utiles des lignes "data:".
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
// Anthropic (Claude)
// ---------------------------------------------------------------------------
function anthropicProvider({ apiKey, model }) {
  return {
    id: "anthropic",

    async runTurn({ system, history, tools, onText, signal }) {
      const body = {
        model,
        max_tokens: MAX_TOKENS,
        system,
        messages: history,
        stream: true,
      };
      if (tools && tools.length) {
        body.tools = tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema,
        }));
      }

      const response = await fetch(ANTHROPIC_URL, {
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
            if (ev.delta.type === "text_delta") {
              b.text = (b.text || "") + ev.delta.text;
              text += ev.delta.text;
              onText && onText(ev.delta.text);
            } else if (ev.delta.type === "input_json_delta") {
              b._partial += ev.delta.partial_json;
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

      const content = blocks.filter(Boolean).map((b) => {
        if (b.type === "tool_use")
          return { type: "tool_use", id: b.id, name: b.name, input: b.input || {} };
        if (b.type === "text") return { type: "text", text: b.text || "" };
        return b;
      });

      const toolCalls = content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));

      return {
        message: { role: "assistant", content },
        toolCalls,
        stopReason,
        text,
      };
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
// OpenRouter (format OpenAI)
// ---------------------------------------------------------------------------
function openrouterProvider({ apiKey, model }) {
  return {
    id: "openrouter",

    async runTurn({ system, history, tools, onText, signal }) {
      const messages = system ? [{ role: "system", content: system }, ...history] : [...history];
      const body = { model, messages, stream: true };
      if (tools && tools.length) {
        body.tools = tools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          },
        }));
      }

      const response = await fetch(OPENROUTER_URL, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://github.com/FlorianMartins/firefox-ai-sidebar",
          "X-Title": "AI Sidebar",
        },
        body: JSON.stringify(body),
      });
      await ensureOk(response);

      let text = "";
      let finishReason = null;
      const toolAcc = {}; // index -> { id, name, args }

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
      // OpenAI veut un message par résultat (role:"tool").
      return results.map((r) => ({
        role: "tool",
        tool_call_id: r.id,
        content: r.content,
      }));
    },
  };
}

export function makeProvider(settings) {
  if (settings.provider === "openrouter") {
    return openrouterProvider({
      apiKey: settings.openrouterKey,
      model: settings.openrouterModel,
    });
  }
  return anthropicProvider({
    apiKey: settings.anthropicKey,
    model: settings.anthropicModel,
  });
}
