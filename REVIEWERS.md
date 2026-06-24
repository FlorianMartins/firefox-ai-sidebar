# Reviewer notes — build instructions (AMO / Chrome Web Store)

This document lets a reviewer reproduce an **exact copy** of the add-on from source.

## TL;DR — no build step for our code

The add-on's own code is **100% hand-written and human-readable**. It is **not**
transpiled, concatenated, minified, bundled or machine-generated. The "build" only
**copies** the source files into a `.zip` per browser.

The **only** minified files are the third-party open-source libraries in `vendor/`,
shipped **unmodified** from their official releases (verifiable by SHA-256, see below).

- Source repository: https://github.com/FlorianMartins/ai-sidebar-open-router
- The submitted package corresponds to the git tag matching its `version`
  (e.g. version `1.26.1` → tag `v1.26.1`).

---

## 1. Operating system & environment

Builds on any OS with a POSIX shell. Verified on:

- **Ubuntu 22.04 / 24.04 (Linux x86-64)**, bash.
- Also works on macOS (bash/zsh) and Windows via WSL or Git Bash.

Required command-line tools:

| Tool      | Version used | Notes                                   |
|-----------|--------------|-----------------------------------------|
| Node.js   | **18.19.1** (any 18 LTS or newer) | only to read the version from `manifest.json` |
| npm       | **9.2.0** (ships with Node)        | only to run `web-ext` via `npx` (signing/lint, optional) |
| rsync     | any          | copies the source tree                  |
| python3   | any 3.x      | zips the package (no external `zip` needed) |
| curl      | any          | only for `fetch-vendor.sh` (optional)   |

### Installing Node.js + npm

- **Recommended (nvm):**
  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  # reopen the shell, then:
  nvm install 18
  node --version   # v18.x
  npm --version
  ```
- **Ubuntu/Debian (apt):** `sudo apt-get update && sudo apt-get install -y nodejs npm rsync python3 curl`
- **macOS (Homebrew):** `brew install node rsync python3`
- **Windows:** install Node.js LTS from https://nodejs.org and use WSL or Git Bash.

No npm `install` is needed to build: there are **no runtime dependencies** and no
`node_modules` in the package. (`npx web-ext` is fetched on demand only for the
optional lint/sign steps.)

---

## 2. Step-by-step: reproduce the exact package

```bash
# 1. Get the exact source for this version
git clone https://github.com/FlorianMartins/ai-sidebar-open-router.git
cd ai-sidebar-open-router
git checkout v1.26.1            # use the tag matching the submitted version

# 2. (Optional) verify the third-party libs are the unmodified upstream releases
bash scripts/fetch-vendor.sh --check

# 3. Build both packages from source
bash scripts/build.sh
```

This produces, in the repository root:

- `ai-sidebar-1.26.1-firefox.zip`  (Firefox — built from `manifest.json`)
- `ai-sidebar-chrome-1.26.1.zip`   (Chromium — built from `manifest.chrome.json`)

The contents of `ai-sidebar-<version>-firefox.zip` are byte-for-byte the files under
`src/`, `icons/`, `vendor/`, plus `manifest.json`, `LICENSE` and `README.md` — i.e.
exactly what was submitted. Nothing is generated or transformed.

### What `scripts/build.sh` does (the whole "build")

1. Checks `node`, `rsync`, `python3` are present.
2. `rsync -a --delete src icons vendor .build/` — copies the source tree verbatim.
3. Copies `manifest.json`, `LICENSE`, `README.md` into `.build/`.
4. Zips `.build/` into `ai-sidebar-<version>-firefox.zip` (Python's `zipfile`).
5. Runs `scripts/build-chrome.sh`, which does the same with `manifest.chrome.json` to
   produce the Chromium zip.

There is no other step. You can inspect every file in `.build/` and confirm it equals
the corresponding source file.

---

## 3. Third-party libraries (the only minified files)

All are unmodified, official open-source releases. `scripts/fetch-vendor.sh` downloads
each from its official source and verifies it against the SHA-256 below.

| File (`vendor/`)            | Library                | Version    | Official source (npm via jsDelivr) | SHA-256 |
|-----------------------------|------------------------|------------|------------------------------------|---------|
| `marked.min.js`             | marked                 | 12.0.2     | `marked@12.0.2/marked.min.js` | `15fabce5…a847a894` |
| `purify.min.js`             | DOMPurify              | 3.1.6      | `dompurify@3.1.6/dist/purify.min.js` | `c0845096…f2dbe3a1` |
| `browser-polyfill.min.js`   | webextension-polyfill  | 0.12.0     | `webextension-polyfill@0.12.0/dist/browser-polyfill.min.js` | `918ed891…7572cc21` |
| `mermaid.min.js`            | Mermaid                | 10.9.1     | `mermaid@10.9.1/dist/mermaid.min.js` | `61b335a4…04a936d6` |
| `pdf.min.js`                | PDF.js (pdfjs-dist)    | 3.11.174   | `pdfjs-dist@3.11.174/legacy/build/pdf.min.js` | `978fd1b2…21a5aa6c` |
| `pdf.worker.min.js`         | PDF.js worker          | 3.11.174   | `pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js` | `38cde531…f00e96f2` |

Verify them at any time:

```bash
bash scripts/fetch-vendor.sh --check    # verifies existing files against the SHA-256
# or re-download from source and verify:
bash scripts/fetch-vendor.sh
```

(Full hashes are embedded in `scripts/fetch-vendor.sh`.)

---

## 4. Optional: lint and sign

- **Lint** (Mozilla's validator): `npx --yes web-ext@7.6.2 lint --source-dir=.build`
  → 0 errors. Warnings, if any, come only from the minified `vendor/` libraries.
- **Sign** (Firefox, requires an AMO API key): see the signing instructions in the
  project notes / `scripts/build.sh` output. Signing is **not** required to reproduce
  the package contents.

---

## 5. Permissions rationale (for the listing/review)

- `storage` — save the user's keys, settings and optional local history.
- `tabs`, `activeTab`, `scripting`, host access (`<all_urls>`) — read the page / tab /
  element the **user explicitly points at**, and let the optional Agent mode act on the
  page the user asks it to. No background reading.
- `identity` — optional one-click OpenRouter sign-in (OAuth).
- `contextMenus` — right-click actions (translate / summarize / improve…).
- `clipboardWrite` — copy AI output on request.
- `sidePanel` (Chromium) / `sidebar_action` (Firefox) — render the sidebar.

The extension is 100% BYOK: it makes network requests **only** to the AI provider
endpoint the user configured, with the user's own key. No analytics, no telemetry, no
remote code. See `privacy-policy.html`.
