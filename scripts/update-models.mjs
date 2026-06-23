#!/usr/bin/env node
// Daily model auto-updater.
//
// Goal: keep the curated OpenRouter model list in `src/lib/models.js` fresh —
// automatically ADD newly released models and DROP ones a provider has removed —
// without any human editing. The sidebar already fetches each account's LIVE list
// at runtime; this script maintains the committed FALLBACK / out-of-the-box default
// so a brand-new install (and the build) reflects what currently exists.
//
// How: fetch OpenRouter's public /models catalogue (no key needed), rank a bounded,
// readable subset (free models first, then notable paid flagships, plus image
// models), then splice it between the <models:openrouter:*> markers in models.js.
// Prints an ADDED/REMOVED diff. Run by .github/workflows/update-models.yml daily;
// the workflow commits the diff if anything changed.
//
// Usage:
//   node scripts/update-models.mjs            # update models.js in place
//   node scripts/update-models.mjs --check    # exit 1 if it WOULD change (CI dry-run)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_FILE = join(__dirname, "..", "src", "lib", "models.js");
const API = "https://openrouter.ai/api/v1/models";

const CHECK_ONLY = process.argv.includes("--check");

// Ranked preference for FREE models (most capable / dependable first). Anything
// free not listed here is still included afterwards (alphabetically), up to the cap.
const FREE_PREF = [
  "gpt-oss-120b", "gpt-oss-20b",
  "deepseek-chat-v3", "deepseek-v3", "deepseek-r1",
  "llama-4-maverick", "llama-4-scout",
  "qwen3", "qwen-2.5", "qwen2.5",
  "nemotron", "gemini-2.0-flash", "gemma-3", "gemma-2",
  "mistral", "llama-3.3-70b", "phi-4",
];
// Notable PAID flagships to surface in the fallback (when present in the live list).
const PAID_PREF = [
  "anthropic/claude-opus-4", "anthropic/claude-sonnet-4", "anthropic/claude-3.7",
  "openai/gpt-4o", "openai/o3", "openai/gpt-4.1",
  "google/gemini-2.5-pro", "google/gemini-2.5-flash",
  "deepseek/deepseek-r1", "deepseek/deepseek-chat",
  "x-ai/grok", "mistralai/mistral-large", "qwen/qwen-max",
];
const FREE_CAP = 18;
const PAID_CAP = 10;
const IMAGE_CAP = 8;

function prettify(id) {
  const tail = id.split("/")[1] || id;
  return tail
    .replace(/:free$/, "")
    .split(/[-_]/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}
function isFree(m) {
  const p = parseFloat((m.pricing && m.pricing.prompt) || "0");
  const c = parseFloat((m.pricing && m.pricing.completion) || "0");
  return !p && !c;
}
function outMods(m) {
  const out = (m.architecture && m.architecture.output_modalities) || [];
  return Array.isArray(out) ? out : [];
}
function canImage(m) { return outMods(m).includes("image"); }
// A "chat" model produces text. Excludes image-only / audio (music) / safety models
// that share the catalogue so they don't pollute the chat dropdown.
function isChat(m) {
  const out = outMods(m);
  if (out.length && !out.includes("text")) return false;       // image/audio-only
  if (/lyria|whisper|tts|embedding|content-safety|moderation|image/i.test(m.id)) return false;
  return true;
}
// Prefer OpenRouter's own display name ("Vendor: Model") → keep the model part.
function niceName(m) {
  let n = m.name ? (m.name.includes(": ") ? m.name.split(": ").slice(1).join(": ") : m.name) : prettify(m.id);
  return n.replace(/\s*\(free\)\s*$/i, "").replace(/\s{2,}/g, " ").trim();
}
function isReasoning(id) {
  return /(^|[-/])(o3|o1|r1|reasoning|thinking|deepseek-r1)/i.test(id);
}
function rankBy(prefList, id) {
  const lid = id.toLowerCase();
  for (let i = 0; i < prefList.length; i++) if (lid.includes(prefList[i])) return i;
  return prefList.length + 1;
}
function esc(s) { return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }
function renderPairs(pairs, indent) {
  return pairs.map(([id, label]) => `${indent}["${esc(id)}", "${esc(label)}"],`).join("\n");
}

// Replace the lines BETWEEN two single-line markers (the marker lines stay intact).
// Both markers must each sit on their own line, directly bracketing the array.
function spliceMarkers(src, startMark, endMark, body) {
  const s = src.indexOf(startMark);
  const e = src.indexOf(endMark);
  if (s < 0 || e < 0 || e < s) throw new Error(`Markers not found: ${startMark} .. ${endMark}`);
  const afterStartLine = src.indexOf("\n", s) + 1;   // first char after the start-marker line
  const endLineStart = src.lastIndexOf("\n", e) + 1; // first char of the end-marker line
  return src.slice(0, afterStartLine) + body + "\n" + src.slice(endLineStart);
}
// Pull the existing ids inside a marker block, for the diff.
function idsInBlock(src, startMark, endMark) {
  const s = src.indexOf(startMark), e = src.indexOf(endMark);
  if (s < 0 || e < 0) return [];
  const block = src.slice(s, e);
  return [...block.matchAll(/\["([^"]+)",/g)].map((m) => m[1]);
}

async function main() {
  const res = await fetch(API, { headers: { "user-agent": "firefox-ai-sidebar-model-updater" } });
  if (!res.ok) throw new Error(`OpenRouter /models HTTP ${res.status}`);
  const json = await res.json();
  const all = (json.data || []).filter((m) => m && m.id);
  if (!all.length) throw new Error("OpenRouter returned an empty model list");

  // ----- Curate the chat list (text-producing models only) -----
  const chat = all.filter(isChat);
  const free = chat.filter(isFree);
  const paid = chat.filter((m) => !isFree(m));

  free.sort((a, b) => rankBy(FREE_PREF, a.id) - rankBy(FREE_PREF, b.id) || a.id.localeCompare(b.id));
  const freePick = free.slice(0, FREE_CAP);

  const paidPick = [];
  for (const pref of PAID_PREF) {
    const hit = paid.find((m) => m.id.toLowerCase().includes(pref) && !paidPick.includes(m));
    if (hit) paidPick.push(hit);
    if (paidPick.length >= PAID_CAP) break;
  }

  const chatPairs = [];
  freePick.forEach((m, i) => {
    const r = isReasoning(m.id) ? " (reasoning)" : "";
    const rec = i === 0 ? " (recommended)" : "";
    chatPairs.push([m.id, `${niceName(m)} — free${r}${rec}`]);
  });
  paidPick.forEach((m) => {
    const r = isReasoning(m.id) ? " (reasoning)" : "";
    chatPairs.push([m.id, `${niceName(m)}${r} (paid)`]);
  });

  // ----- Curate the image list -----
  const imgModels = all.filter(canImage);
  // Prefer Google "nano banana" / gemini image models first, then the rest.
  imgModels.sort((a, b) => rankBy(["gemini-2.5-flash-image", "gemini", "flux", "dall"], a.id)
    - rankBy(["gemini-2.5-flash-image", "gemini", "flux", "dall"], b.id) || a.id.localeCompare(b.id));
  const imagePairs = imgModels.slice(0, IMAGE_CAP).map((m) => [m.id, niceName(m)]);

  // ----- Splice into models.js -----
  let src = readFileSync(MODELS_FILE, "utf8");
  const beforeChatIds = idsInBlock(src, "<models:openrouter:start>", "<models:openrouter:end>");
  const beforeImgIds = idsInBlock(src, "<models:openrouter:image:start>", "<models:openrouter:image:end>");

  const chatBody = "    models: [\n" + renderPairs(chatPairs, "      ") + "\n    ],";
  const imageBody = "    imageModels: [\n" + renderPairs(imagePairs, "      ") + "\n    ],";

  let out = src;
  out = spliceMarkers(out, "<models:openrouter:image:start>", "<models:openrouter:image:end>", imageBody);
  out = spliceMarkers(out, "<models:openrouter:start>", "<models:openrouter:end>", chatBody);

  const changed = out !== src;
  const newChatIds = chatPairs.map((p) => p[0]);
  const newImgIds = imagePairs.map((p) => p[0]);
  const added = [...newChatIds, ...newImgIds].filter((id) => ![...beforeChatIds, ...beforeImgIds].includes(id));
  const removed = [...beforeChatIds, ...beforeImgIds].filter((id) => ![...newChatIds, ...newImgIds].includes(id));

  console.log(`OpenRouter catalogue: ${all.length} models (${free.length} free).`);
  console.log(`Curated: ${chatPairs.length} chat + ${imagePairs.length} image.`);
  if (added.length) console.log("ADDED:\n  " + added.join("\n  "));
  if (removed.length) console.log("REMOVED:\n  " + removed.join("\n  "));
  if (!added.length && !removed.length) console.log("No model changes.");

  if (CHECK_ONLY) {
    if (changed) { console.error("models.js is out of date (run without --check)."); process.exit(1); }
    return;
  }
  if (changed) { writeFileSync(MODELS_FILE, out); console.log("✓ models.js updated."); }
  else console.log("✓ models.js already up to date.");
}

main().catch((e) => { console.error("update-models failed:", e.message); process.exit(1); });
