// Catalogue of AI providers and their default models.
// The extension is 100% BYOK: no key is bundled, the user supplies their own
// (or points at a local server that needs none).
//
// `kind`:
//   "anthropic"  -> native Anthropic API (Claude)
//   "openai"     -> OpenAI-compatible API (/chat/completions, /models, /images)
//
// Most providers (OpenAI, Gemini, Mistral, Groq, DeepSeek, OpenRouter, Ollama,
// LM Studio, self-hosted servers…) speak the OpenAI dialect, so a single generic
// client covers them all, parameterised only by `baseUrl` + `apiKey`.

export const PROVIDERS = {
  anthropic: {
    label: "Claude (Anthropic)",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    needsKey: true,
    keysUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "sk-ant-...",
    supportsThinking: true,
    supportsWebSearch: true,
    supportsImages: false,
    models: [
      ["claude-opus-4-8", "Claude Opus 4.8"],
      ["claude-sonnet-4-6", "Claude Sonnet 4.6"],
      ["claude-haiku-4-5", "Claude Haiku 4.5"],
    ],
  },

  openai: {
    label: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    needsKey: true,
    keysUrl: "https://platform.openai.com/api-keys",
    keyHint: "sk-...",
    supportsImages: true,
    imageModels: [
      ["gpt-image-1", "GPT Image 1"],
      ["dall-e-3", "DALL·E 3"],
    ],
    models: [
      ["gpt-4o", "GPT-4o"],
      ["gpt-4o-mini", "GPT-4o mini"],
      ["o4-mini", "o4-mini (reasoning)"],
      ["o3", "o3 (reasoning)"],
    ],
  },

  openrouter: {
    label: "OpenRouter",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    needsKey: true,
    keysUrl: "https://openrouter.ai/keys",
    keyHint: "sk-or-...",
    canListModels: true,
    supportsWebSearch: true, // universal "web" plugin — works with any model, incl. free ones
    // Image generation on OpenRouter goes through /chat/completions with image
    // modalities (NOT /images/generations) — see providers.js. This is what lets an
    // OpenRouter-only user generate images (e.g. Google's "Nano Banana").
    supportsImages: true,
    imageVia: "chat",
    imageModels: [
      ["google/gemini-2.5-flash-image-preview", "Gemini 2.5 Flash Image · Nano Banana"],
      ["google/gemini-2.5-flash-image", "Gemini 2.5 Flash Image"],
    ],
    models: [
      // Strongest RELIABLE free models first. The out-of-the-box default picks the
      // best one actually available on the account (see sidebar.js bestFreeOpenRouter).
      // GPT-OSS 120B is currently the most capable + dependable free model; DeepSeek
      // V3 0324 and Llama 4 Maverick are solid alternates. (Free = rate-limited.)
      ["openai/gpt-oss-120b:free", "GPT-OSS 120B — free (recommended)"],
      ["openai/gpt-oss-20b:free", "GPT-OSS 20B — free"],
      ["deepseek/deepseek-chat-v3-0324:free", "DeepSeek V3 0324 — free"],
      ["meta-llama/llama-4-maverick:free", "Llama 4 Maverick — free"],
      ["deepseek/deepseek-r1:free", "DeepSeek R1 — free (reasoning)"],
      ["google/gemini-2.0-flash-exp:free", "Gemini 2.0 Flash — free"],
      ["anthropic/claude-opus-4.1", "Claude Opus 4.1 (paid)"],
      ["openai/gpt-4o", "GPT-4o (paid)"],
      ["deepseek/deepseek-r1", "DeepSeek R1 (paid)"],
    ],
  },

  google: {
    label: "Google Gemini",
    kind: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    needsKey: true,
    keysUrl: "https://aistudio.google.com/app/apikey",
    keyHint: "AIza...",
    models: [
      ["gemini-2.5-pro", "Gemini 2.5 Pro"],
      ["gemini-2.5-flash", "Gemini 2.5 Flash"],
      ["gemini-2.0-flash", "Gemini 2.0 Flash"],
    ],
  },

  mistral: {
    label: "Mistral AI",
    kind: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    needsKey: true,
    keysUrl: "https://console.mistral.ai/api-keys",
    canListModels: true,
    models: [
      ["mistral-large-latest", "Mistral Large"],
      ["mistral-small-latest", "Mistral Small"],
      ["pixtral-large-latest", "Pixtral Large (vision)"],
    ],
  },

  groq: {
    label: "Groq",
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    needsKey: true,
    keysUrl: "https://console.groq.com/keys",
    canListModels: true,
    models: [
      ["llama-3.3-70b-versatile", "Llama 3.3 70B"],
      ["deepseek-r1-distill-llama-70b", "DeepSeek R1 Distill 70B"],
      ["qwen-2.5-32b", "Qwen 2.5 32B"],
    ],
  },

  deepseek: {
    label: "DeepSeek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    needsKey: true,
    keysUrl: "https://platform.deepseek.com/api_keys",
    models: [
      ["deepseek-chat", "DeepSeek V3 (chat)"],
      ["deepseek-reasoner", "DeepSeek R1 (reasoning)"],
    ],
  },

  xai: {
    label: "xAI (Grok)",
    kind: "openai",
    baseUrl: "https://api.x.ai/v1",
    needsKey: true,
    keysUrl: "https://console.x.ai",
    keyHint: "xai-...",
    canListModels: true,
    supportsImages: true,
    imageModels: [
      ["grok-2-image-1212", "Grok 2 Image"],
    ],
    models: [
      ["grok-2-latest", "Grok 2"],
      ["grok-2-vision-latest", "Grok 2 Vision"],
      ["grok-beta", "Grok Beta"],
    ],
  },

  perplexity: {
    label: "Perplexity",
    kind: "openai",
    baseUrl: "https://api.perplexity.ai",
    needsKey: true,
    keysUrl: "https://www.perplexity.ai/settings/api",
    keyHint: "pplx-...",
    supportsWebSearch: true, // Sonar models are online (web-grounded) by default
    models: [
      ["sonar", "Sonar"],
      ["sonar-pro", "Sonar Pro"],
      ["sonar-reasoning", "Sonar Reasoning"],
    ],
  },

  together: {
    label: "Together AI",
    kind: "openai",
    baseUrl: "https://api.together.xyz/v1",
    needsKey: true,
    keysUrl: "https://api.together.ai/settings/api-keys",
    canListModels: true,
    supportsImages: true,
    imageModels: [
      ["black-forest-labs/FLUX.1-schnell-Free", "FLUX.1 schnell (free)"],
      ["black-forest-labs/FLUX.1-schnell", "FLUX.1 schnell"],
      ["black-forest-labs/FLUX.1-dev", "FLUX.1 dev"],
      ["black-forest-labs/FLUX.1.1-pro", "FLUX 1.1 Pro"],
    ],
    models: [
      ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Llama 3.3 70B Turbo"],
      ["deepseek-ai/DeepSeek-R1", "DeepSeek R1"],
      ["Qwen/Qwen2.5-72B-Instruct-Turbo", "Qwen2.5 72B"],
    ],
  },

  fireworks: {
    label: "Fireworks AI",
    kind: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    needsKey: true,
    keysUrl: "https://fireworks.ai/account/api-keys",
    canListModels: true,
    supportsImages: true,
    imageModels: [
      ["accounts/fireworks/models/flux-1-schnell-fp8", "FLUX.1 schnell"],
      ["accounts/fireworks/models/flux-1-dev-fp8", "FLUX.1 dev"],
    ],
    models: [
      ["accounts/fireworks/models/llama-v3p3-70b-instruct", "Llama 3.3 70B"],
      ["accounts/fireworks/models/deepseek-r1", "DeepSeek R1"],
      ["accounts/fireworks/models/qwen2p5-72b-instruct", "Qwen2.5 72B"],
    ],
  },

  deepinfra: {
    label: "DeepInfra",
    kind: "openai",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    needsKey: true,
    keysUrl: "https://deepinfra.com/dash/api_keys",
    canListModels: true,
    supportsImages: true,
    imageModels: [
      ["black-forest-labs/FLUX-1-schnell", "FLUX.1 schnell"],
      ["black-forest-labs/FLUX-1-dev", "FLUX.1 dev"],
    ],
    models: [
      ["meta-llama/Llama-3.3-70B-Instruct", "Llama 3.3 70B"],
      ["deepseek-ai/DeepSeek-R1", "DeepSeek R1"],
    ],
  },

  cerebras: {
    label: "Cerebras",
    kind: "openai",
    baseUrl: "https://api.cerebras.ai/v1",
    needsKey: true,
    keysUrl: "https://cloud.cerebras.ai",
    canListModels: true,
    models: [
      ["llama-3.3-70b", "Llama 3.3 70B"],
      ["llama3.1-8b", "Llama 3.1 8B"],
    ],
  },

  cohere: {
    label: "Cohere",
    kind: "openai",
    baseUrl: "https://api.cohere.ai/compatibility/v1",
    needsKey: true,
    keysUrl: "https://dashboard.cohere.com/api-keys",
    models: [
      ["command-r-plus", "Command R+"],
      ["command-r", "Command R"],
    ],
  },

  ollama: {
    label: "Local (Ollama)",
    kind: "openai",
    baseUrl: "http://localhost:11434/v1",
    needsKey: false,
    local: true,
    canListModels: true,
    keysUrl: "https://ollama.com",
    models: [
      ["llama3.2", "llama3.2"],
      ["qwen2.5", "qwen2.5"],
      ["deepseek-r1", "deepseek-r1"],
    ],
  },

  lmstudio: {
    label: "Local (LM Studio)",
    kind: "openai",
    baseUrl: "http://localhost:1234/v1",
    needsKey: false,
    local: true,
    canListModels: true,
    keysUrl: "https://lmstudio.ai",
    models: [["local-model", "(model loaded in LM Studio)"]],
  },

  custom: {
    label: "Custom (OpenAI-compatible)",
    kind: "openai",
    baseUrl: "",
    needsKey: false,
    custom: true,
    canListModels: true,
    models: [],
  },
};

export const PROVIDER_ORDER = [
  "anthropic",
  "openai",
  "openrouter",
  "google",
  "mistral",
  "groq",
  "deepseek",
  "xai",
  "perplexity",
  "together",
  "fireworks",
  "deepinfra",
  "cerebras",
  "cohere",
  "ollama",
  "lmstudio",
  "custom",
];

// Image sizes for the OpenAI-compatible /images/generations endpoint, labelled by
// use-case. NOTE: the accepted sizes depend on the MODEL — gpt-image-1: 1024²,
// 1536×1024, 1024×1536 ; DALL·E 3: 1024², 1792×1024, 1024×1792 ; DALL·E 2: 256²,
// 512², 1024². True 4K / 1440p is not produced natively by current image models
// (upscale the result afterwards). [value, label] pairs.
export const IMAGE_SIZES = [
  ["256x256", "Favicon — carré 256² (DALL·E 2)"],
  ["512x512", "Petite icône — carré 512² (DALL·E 2)"],
  ["1024x1024", "Logo / carré HD — 1024² (tous modèles)"],
  ["1536x1024", "Paysage 3:2 — 1536×1024 (gpt-image-1)"],
  ["1024x1536", "Portrait 2:3 — 1024×1536 (gpt-image-1)"],
  ["1792x1024", "Paysage 16:9 « HD » — 1792×1024 (DALL·E 3)"],
  ["1024x1792", "Portrait 9:16 « HD » — 1024×1792 (DALL·E 3)"],
];

// Effective base URL (honours the user's override for local / custom servers).
export function baseUrlFor(providerId, settings) {
  const override = settings && settings.baseUrls && settings.baseUrls[providerId];
  return (override && override.trim()) || PROVIDERS[providerId].baseUrl;
}

// Selected model for this provider (falls back to the first default).
export function modelFor(providerId, settings) {
  const chosen = settings && settings.models && settings.models[providerId];
  if (chosen) return chosen;
  const def = PROVIDERS[providerId].models[0];
  return def ? def[0] : "";
}

export function keyFor(providerId, settings) {
  return (settings && settings.keys && settings.keys[providerId]) || "";
}

// A provider is "connected" (usable) if it has a key, is a local server, or is a
// custom endpoint with a base URL. Used to build the single unified model picker.
export function isConnected(providerId, settings) {
  const meta = PROVIDERS[providerId];
  if (!meta) return false;
  // Local servers require an explicit opt-in (enabled in settings or a custom URL),
  // so a brand-new install shows no default models — only a "connect" button.
  if (meta.local) {
    return !!(
      (settings && settings.localEnabled && settings.localEnabled[providerId]) ||
      (settings && settings.baseUrls && settings.baseUrls[providerId])
    );
  }
  if (meta.custom) return !!(settings && settings.baseUrls && settings.baseUrls[providerId]);
  return !!keyFor(providerId, settings);
}

export function connectedProviders(settings) {
  return PROVIDER_ORDER.filter((id) => isConnected(id, settings));
}

// Pick a sensible model for WEB SEARCH mode, so we don't spend Claude on it.
// Prefers Perplexity Sonar (online by default), then OpenRouter (its "web" plugin
// works with any model, including the free ones), then any other connected
// web-capable provider. Returns "providerId|modelId" or "" if none is available.
export function defaultSearchModel(settings) {
  if (isConnected("perplexity", settings)) return "perplexity|" + modelFor("perplexity", settings);
  if (isConnected("openrouter", settings)) return "openrouter|" + modelFor("openrouter", settings);
  for (const id of connectedProviders(settings)) {
    if (PROVIDERS[id].supportsWebSearch) return id + "|" + modelFor(id, settings);
  }
  return "";
}

// Writing presets for the "Improve" workspace, Sider-style. Each maps to an
// instruction injected into the prompt. The label is shown in the UI (FR).
export const WRITING_PRESETS = [
  ["improve", "Améliorer (clarté & grammaire)", "Améliore ce texte : clarté, style, grammaire et fluidité, en gardant la langue et l'intention d'origine."],
  ["shorten", "Raccourcir", "Raccourcis ce texte en gardant l'essentiel et le sens."],
  ["expand", "Développer / détailler", "Développe et enrichis ce texte avec plus de détails et d'exemples pertinents."],
  ["simplify", "Simplifier", "Reformule ce texte de façon simple et accessible (niveau grand public)."],
  ["formal", "Plus formel", "Réécris ce texte dans un registre formel et professionnel."],
  ["friendly", "Plus amical", "Réécris ce texte sur un ton chaleureux, amical et accessible."],
  ["marketing", "Marketing / copywriting", "Réécris ce texte comme un copywriter : accrocheur, orienté bénéfices, avec un appel à l'action clair."],
  ["newsletter", "Newsletter", "Transforme ce texte en section de newsletter engageante : titre accrocheur, ton conversationnel, et une conclusion incitative."],
  ["email", "Email professionnel", "Rédige un email professionnel clair et poli à partir de ce contenu (objet + corps + formule de politesse)."],
  ["linkedin", "Post LinkedIn", "Transforme ce texte en post LinkedIn percutant : accroche forte, paragraphes courts, et quelques hashtags pertinents."],
  ["tweet", "Post X / Tweet", "Condense ce texte en un post X percutant (≤ 280 caractères), avec éventuellement 1–2 hashtags."],
  ["blog", "Article de blog", "Développe ce texte en article de blog structuré (titre, intertitres, intro, conclusion) au ton informatif."],
  ["academic", "Académique", "Réécris ce texte dans un style académique, précis et neutre, avec un vocabulaire soutenu."],
  ["storytelling", "Storytelling", "Réécris ce texte sous forme de narration immersive (storytelling) qui capte l'attention."],
];
