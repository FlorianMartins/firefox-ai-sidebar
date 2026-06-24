# AI Sidebar — IA multi-fournisseurs pour Firefox & Chromium

Une extension Firefox **open-source** qui ajoute une **sidebar IA** à la manière de
[sider.ai](https://sider.ai), mais où **vous branchez votre propre IA** (BYOK) et
qui **interagit réellement avec la page et les onglets** — ce que la sidebar native
de Firefox ne permet pas. Un équivalent libre n'existait pas.

- 🎨 **Interface moderne & personnalisable** : plusieurs **thèmes** (Default, Pro,
  Gamer, Modern, Sunset, Light) avec **personnalisation des couleurs par-dessus**
  (accent, fond, surface, texte) et une **pipette** pour capturer une couleur à
  l'écran. Zone de saisie unifiée façon Claude/Gemini, et un **sélecteur de modèle
  unifié** au-dessus du chat (une seule liste groupée par fournisseur connecté).
- 🌍 **Interface multilingue** : anglais, français, espagnol, allemand, italien,
  portugais (réglable dans les paramètres).
- 🔌 **Tous les fournisseurs** : **Claude**, **OpenAI**, **Gemini**, **Mistral**,
  **Groq**, **DeepSeek**, **xAI (Grok)**, **Perplexity**, **Together**, **Fireworks**,
  **DeepInfra**, **Cerebras**, **Cohere**, **OpenRouter**, et les **modèles locaux**
  **Ollama** / **LM Studio** (ou tout serveur compatible OpenAI via URL personnalisée).
- 📋 **Seulement les modèles disponibles** : la liste (unifiée, juste au-dessus du
  chat) n'affiche que les fournisseurs **connectés** (clé/compte/serveur local) et,
  pour chacun, les **modèles réellement accessibles** à votre clé (lus en direct via
  l'endpoint `/models`).
- 🔑 **Connexion par compte** : bouton **« Se connecter avec OpenRouter »** (OAuth
  PKCE — login Google / GitHub / email côté OpenRouter) qui débloque tous les
  modèles. Les autres fournisseurs utilisent une clé API (ils n'offrent pas d'OAuth).
- ⚖️ **Comparaison de modèles** : sur **la dernière réponse**, un bouton
  **« Comparer »** rejoue votre demande sur **un autre modèle**, directement dans le chat.
- 🧩 **Artifacts interactifs (façon Claude)** : demandez une app, un outil ou un
  **jeu** → l'IA renvoie un document HTML/JS (ou un composant **React/JSX**) qui
  s'exécute dans un aperçu sandboxé **et avec lequel vous interagissez/jouez**
  directement. (Mermaid/SVG pour les diagrammes.)
- 🕘 **Historique local** : vos conversations sont enregistrées **uniquement dans
  ce navigateur** (privacy) ; liste, rechargement, et « tout effacer ».
- 🗂 **7 espaces de travail** via une **barre latérale d'activité** à gauche
  (convention « activity bar » façon VS Code / Slack — scale mieux qu'une rangée
  d'onglets) : **💬 Chat**, **🤖 Agent**, **🌐 Traduire**, **✨ Améliorer**,
  **🎨 Image**, **📄 PDF**, **&lt;/&gt; Code**. Le mode Améliorer propose des
  **styles d'écriture** (Marketing, Newsletter, Email pro, LinkedIn, Tweet, Blog…) ;
  le mode **PDF** lit un document et répond à vos questions dessus ; le
  mode **Code** ouvre un atelier d'app IA complet (voir ci-dessous).
- 👁 **L'IA voit la page** : le contenu est lu automatiquement à l'ouverture d'un
  site **et à chaque navigation** (y compris changement de sous-domaine et
  navigations SPA), puis utilisé comme support pour répondre.
- 📑 **Lecture multi-onglets** : cochez plusieurs onglets ouverts pour les donner
  comme contexte à l'IA (comparer, synthétiser, recouper).
- ⚡ **Actions rapides** + **clic droit** : Résumer / Traduire la **page** ou la
  **sélection**, Expliquer, Améliorer, **Rédiger une réponse**.
- 🔍 **Recherche dans la conversation**, **glisser-déposer** de fichiers, et un
  **outil de capture de zone** (📸) qui ajoute une capture d'écran de la page au contexte.
- 💭 **Thinking** : le raisonnement du modèle (extended thinking de Claude,
  `reasoning` de DeepSeek / o-series) s'affiche dans un bloc repliable.
- 🎨 **Génération d'images** (endpoint compatible OpenAI `/images/generations`).
- 🤖 **Espace Agent** (onglet dédié) : l'IA peut lire la page/les onglets, naviguer,
  cliquer, remplir des champs. **Autorisations réglables** : *Autoriser* (par défaut —
  exécution automatique, mais les **actions sensibles** comme télécharger, réserver,
  supprimer, s'inscrire demandent quand même confirmation) ou *validation manuelle*
  (confirmation avant chaque action). Un **liseré lumineux** s'affiche sur la page
  pendant que l'agent travaille.
  Dans les deux cas, le **garde-fou anti-achat** s'applique : elle peut remplir un
  panier mais **ne peut jamais payer/commander**. Un **modèle d'agent** dédié est
  réglable (beaucoup de modèles rapides/gratuits ne savent pas appeler d'outils).
- 🛠 **Espace Code — atelier d'app IA** : ouvre, dans un **nouvel onglet isolé**, un
  builder d'apps web & mobiles (type **Bolt.diy** / Behivey) avec **génération de
  code par l'IA**, **aperçu live**, **terminal intégré** et **QR code Expo Go** pour
  tester sur mobile. L'URL de l'atelier est **configurable** dans les réglages (votre
  instance auto-hébergée ou l'instance publique). *Pourquoi un onglet et pas une
  iframe ?* le builder s'appuie sur **WebContainers**, qui exigent l'isolation
  cross-origine (COOP/COEP) impossible dans une iframe d'extension — le nouvel onglet
  préserve preview, terminal et Expo Go.
- 🔒 **100% BYOK, zéro rétention serveur** : aucune clé fournie, **aucun serveur**,
  aucune télémétrie. Vos clés et données restent **locales** (`storage.local`),
  jamais synchronisées, envoyées uniquement à l'API que vous choisissez.

## Capture

Sidebar — thème sombre + dégradé bleu/violet, **barre latérale d'activité** à
gauche (7 espaces : Chat / Agent / Traduire / Améliorer / Image / PDF / Code),
sélecteur de modèle juste au-dessus du chat, boutons à bascule, **bouton
« Comparer » sous la dernière réponse**, et un **artifact interactif jouable** (un
mini-jeu qui tourne dans l'aperçu sandboxé) — Firefox 152 :

![Sidebar](docs/screenshots/sidebar-v14.png)

> Capture générée via la page `demo/index.html` (reproduit la sidebar avec une
> réponse type), rendue dans Firefox sous Xvfb. Validé par `web-ext lint`
> (0 erreur ; les avertissements proviennent uniquement des libs vendorées).

## Installation

### Firefox (développement)

1. Ouvrir `about:debugging#/runtime/this-firefox`
2. **Charger un module complémentaire temporaire…**
3. Sélectionner `manifest.json` à la racine de ce dépôt
4. La sidebar s'ouvre via l'icône de la barre latérale ou `Ctrl+Shift+Y`
5. Cliquer ⚙ **Réglages** et renseigner **au moins une clé API** (ou pointer un
   modèle local Ollama / LM Studio, sans clé)

### Chromium (Chrome / Edge / Brave…)

L'extension est **cross-browser** : le même code tourne sur Chromium grâce à
[`browser-polyfill`](https://github.com/mozilla/webextension-polyfill) et à un
manifest dédié (`side_panel` + service worker au lieu de `sidebar_action`).

1. Construire le paquet : `bash scripts/build-chrome.sh` → `ai-sidebar-chrome-<version>.zip`
   (ou décompresser le zip fourni)
2. Ouvrir `chrome://extensions`, activer le **Mode développeur**
3. **« Charger l'extension non empaquetée »** → sélectionner le dossier `.build-chrome/`
   (ou le contenu décompressé du zip)
4. Cliquer l'icône de la barre d'outils pour ouvrir le **panneau latéral**

> Note : Chrome ne permet pas la distribution d'un `.crx` permanent hors
> **Chrome Web Store** (compte développeur payant). Le chargement « non empaqueté »
> ci-dessus est la voie sans store ; il nécessite de garder le Mode développeur actif.

## Fournisseurs

| Fournisseur | Type | Clé requise | Notes |
|---|---|---|---|
| Claude (Anthropic) | natif | ✅ | thinking + recherche web ; liste `/v1/models` |
| OpenAI | compatible OpenAI | ✅ | images (gpt-image-1 / DALL·E 3) |
| Google Gemini | compatible OpenAI | ✅ | endpoint `/v1beta/openai` |
| Mistral, Groq, DeepSeek | compatible OpenAI | ✅ | DeepSeek R1 = raisonnement |
| xAI (Grok), Perplexity | compatible OpenAI | ✅ | Grok / Sonar |
| Together, Fireworks, DeepInfra, Cerebras, Cohere | compatible OpenAI | ✅ | open-weights + listing `/models` |
| OpenRouter | compatible OpenAI | ✅ (ou OAuth) | catalogue géant, **connexion par compte** |
| Local (Ollama) | compatible OpenAI | ❌ | `http://localhost:11434/v1` |
| Local (LM Studio) | compatible OpenAI | ❌ | `http://localhost:1234/v1` |
| Personnalisé | compatible OpenAI | optionnel | n'importe quelle URL `/v1` |

> Les serveurs locaux fonctionnent sans configuration CORS : l'extension dispose
> des *host permissions* et n'est donc pas soumise au CORS du navigateur.

## Architecture

```
manifest.json            MV3 Firefox (sidebar_action, event page)
manifest.chrome.json     MV3 Chromium (side_panel, service worker)
scripts/build-chrome.sh  Assemble le paquet Chromium (.zip / dossier)
src/
  background/sw-chrome.js  Entrée service worker Chromium (importScripts)
  background/            Event page : menus contextuels (résumer/traduire/…)
  sidebar/               UI principale (chat, streaming, thinking, actions rapides)
  content/               Lecture page + actions DOM + notif. de navigation SPA
  options/               Réglages générés dynamiquement (clés BYOK par fournisseur)
  lib/
    models.js            Catalogue des fournisseurs + modèles + presets d'écriture
    providers.js         Client Anthropic natif + client générique OpenAI ; images
    agent.js             Boucle d'agent (tours modèle ↔ outils)
    tools.js             Outils navigateur (onglets, DOM) + exécuteur
    auth.js              Connexion OAuth (PKCE) OpenRouter via browser.identity
    history.js           Historique local des conversations (storage.local)
    storage.js           Réglages locaux (clés/modèles/URLs, autorisations agent, URL atelier Code)
    markdown.js          Rendu Markdown + artifacts interactifs (HTML/JS, React, SVG, Mermaid)
```

### Détails techniques

- **MV3 / Firefox** : `sidebar_action` (équivalent Chrome : `side_panel`).
  Le background est un *event page* (`background.scripts`).
- **Un seul client pour presque tout** : la majorité des fournisseurs parlent le
  dialecte OpenAI (`/chat/completions`, `/models`, `/images/generations`). Un
  client générique paramétré par `baseUrl` + `apiKey` les couvre tous ; seul
  Anthropic a son client natif (extended thinking, recherche web serveur).
- **Anthropic depuis le navigateur** : header
  `anthropic-dangerous-direct-browser-access: true` + `x-api-key` +
  `anthropic-version: 2023-06-01`.
- **Les « yeux »** : la sidebar écoute `tabs.onActivated` / `tabs.onUpdated` et les
  notifications SPA du content script ; à chaque navigation elle relit la page,
  l'affiche dans un chip et l'injecte (mode chat) ou la laisse à l'agent (mode agent).
- **Thinking** : blocs `thinking` d'Anthropic (avec signature conservée pour rester
  valide au tour suivant) et `reasoning`/`reasoning_content` côté OpenAI/DeepSeek.

## Sécurité & confidentialité

- **Zéro rétention serveur** : l'extension n'a **aucun backend**. Aucune donnée
  (clés, conversations, contenu des pages) ne transite par un serveur tiers — tout
  reste dans le navigateur et n'est envoyé qu'à l'API IA que **vous** choisissez.
  Pas d'analytique, pas de télémétrie.
- Les clés API sont stockées via `browser.storage.local` (jamais synchronisées).
  **Aucune clé n'est fournie** : le dépôt est livré vierge.
- **Garde-fou anti-transaction** : en mode agent, les actions de
  paiement/commande/saisie de carte sont **refusées dans le code** (content script),
  pas seulement dans le prompt — un prompt détourné ne peut pas les contourner.
  L'agent s'arrête au panier.
- **Anti prompt-injection** : le contenu des pages, onglets et sélections est traité
  comme une **donnée non fiable**. Le prompt système interdit d'obéir à des
  instructions trouvées dans une page et de divulguer les clés/réglages.
- **Autorisations de l'agent réglables** : en *Autoriser* (par défaut) l'agent
  s'exécute seul mais **confirme les actions très sensibles** (téléchargement,
  réservation, suppression, virement, inscription, installation…) ; en *validation
  manuelle* chaque action modifiant l'état est confirmée ; en *tout autoriser* l'agent enchaîne
  sans demande — mais le **garde-fou anti-achat reste actif dans les deux cas**
  (refus codé en dur, indépendant du prompt). Le défaut sûr est la validation manuelle.
- **Espace Code isolé** : l'atelier d'app IA s'ouvre dans un **onglet distinct**
  (origine séparée, protégé côté serveur). Aucune clé, aucun réglage et aucune donnée
  de la sidebar n'est partagé avec l'atelier ; l'URL cible est explicitement
  configurée par l'utilisateur (pas de redirection silencieuse). La séparation
  d'origine (WebContainers/COOP-COEP) qui empêche l'embarquement en iframe **renforce**
  aussi l'isolation : la sidebar et l'atelier ne partagent pas de contexte d'exécution.
- **CSP stricte** sur les pages d'extension (`script-src 'self'`) ; les artifacts
  (HTML/JS/React/SVG/Mermaid) s'exécutent en **iframe sandboxée** (origine opaque,
  sans `allow-same-origin`), isolés de l'extension, des pages et des clés.
- **Historique 100% local** : les conversations sont stockées dans
  `storage.local` (jamais synchronisées) ; désactivable et effaçable dans les réglages.
- **Note artifacts React** : un artifact `jsx`/`react` charge React + Babel depuis
  un CDN public (`unpkg`) **à l'intérieur de l'iframe sandboxée uniquement**, et
  seulement quand un tel artifact est affiché. Les artifacts **HTML/JS** (jeux, apps)
  ne dépendent d'aucun CDN. La connexion OpenRouter passe par `browser.identity`.
- `anthropic-dangerous-direct-browser-access` expose la clé Anthropic au contexte
  navigateur de l'utilisateur (BYOK assumé) — acceptable car chacun fournit la sienne.

## Rendu Markdown & artifacts

Réponses rendues en **Markdown** (marked + DOMPurify, vendorés dans `vendor/`).
Blocs de code avec barre d'outils (**Copier**), et des **artifacts interactifs**
(façon Claude) dans des **iframes sandboxées**, avec bascule **Aperçu / Code** et
bouton **Ouvrir** (plein écran) :

- ` ```html ` → **app / jeu / outil** autonome, exécuté et **jouable** dans l'aperçu
- ` ```jsx ` (ou `react`) → **composant React** (définir `App`), transpilé en direct
- ` ```svg ` → graphique vectoriel rendu
- ` ```mermaid ` → diagramme rendu automatiquement

## Feuille de route

- [x] Multi-fournisseurs + modèles locaux (Ollama / LM Studio / custom)
- [x] Lecture auto de la page à chaque navigation (sous-domaine, SPA)
- [x] Lecture multi-onglets (sélection des onglets à donner en contexte)
- [x] Espaces dédiés via barre d'activité : Chat / Agent / Traduire / Améliorer / Image / PDF / Code
- [x] Actions rapides + clic droit (page & sélection) + rédaction de réponse
- [x] Espace agent avec autorisations réglables (manuel / auto) + garde-fou anti-achat
- [x] Espace Code : atelier d'app IA (Bolt.diy / Behivey) en nouvel onglet (preview, Expo Go)
- [x] Thinking / raisonnement
- [x] Interface moderne (sombre + dégradé), sélecteur unifié, boutons à bascule
- [x] Connexion par compte (OAuth OpenRouter)
- [x] Comparaison de 2 modèles côte à côte
- [x] Artifacts interactifs façon Claude (HTML/JS jouable, React/JSX)
- [x] Historique de conversations local (privacy)
- [x] Styles d'écriture (marketing, newsletter, email, LinkedIn…)
- [ ] Capture d'écran d'onglet pour modèles vision
- [ ] Publication sur AMO — note aux relecteurs pour `vendor/mermaid.min.js`
      (lib minifiée ; son `Function` constructor ne s'exécute que dans l'iframe
      sandboxée, hors CSP de l'extension)

## Licence

MIT — voir [LICENSE](./LICENSE).

## Building / reviewers

The extension ships hand-written, non-minified source (only `vendor/` holds unmodified third-party libraries). To reproduce the exact packages: `bash scripts/build.sh`. Verify the third-party libs with `bash scripts/fetch-vendor.sh --check`. Full reviewer/build documentation: see [REVIEWERS.md](REVIEWERS.md).
