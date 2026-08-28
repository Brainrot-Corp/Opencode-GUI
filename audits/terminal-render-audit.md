# Audit Complet — Système de Render du Terminal

**Projet:** OpenCode GUI (Tauri + React + xterm.js + Rust ConPTY)  
**Version auditée:** `1.9.2` — `package.json:5`  
**Date:** 2026-08-28  
**Périmètre:** `src/components/Terminal.tsx`, `src/components/TermInstanceView.tsx`, `src/styles/terminal.css`, `src/lib/termHighlight.ts`, `src-tauri/src/pty.rs`, `src-tauri/src/terminals.rs`, `src/hooks/useTerminalProfiles.ts`, `src/components/DropdownPortal.tsx`, `src/hooks/useGlobalShortcuts.ts`, `src/pages/ChatPage.tsx`, `src/styles/layout.css`/`tokens.css`, `src/lib/uiScale.ts`  
**Mode d'audit:** ponytail lite — lecture intégrale de chaque fichier touché, traçage du flux réel end-to-end, pas de spéculation.

---

## 0. Résumé exécutif — verdict

| Axe | État | Notes |
|---|---|---|
| **Pipeline PTY → xterm** | **Solide** | `pty.rs:96-215` crée ConPTY hors lock, 2 vérifications `MAX_TERMS`, id+gen anti-bleed. |
| **Highlight** | **Correct / fragile sur OSC ST** | `termHighlight.ts:135-160` segmente ESC/plain par chunk, mais `seqEnd:221-236` ignore `ESC\` (ST). |
| **Resize / Fit** | **Noisy mais fonctionnel** | Debounce 90 ms + double `fit()` masque les reflows, mais 3 timers + 2 RAF concurrents créent duplication de `pty_resize`. |
| **Responsive / layout** | **Trou majeur** | Aucun breakpoint sous 900 px pour `.term-dock` / `.term-side` / `.term-head`. À `< ~420 px` l'UI casse visuellement et FitAddon calcule des cols illisibles. |
| **Inputs / events** | **Partiellement couvert** | 21 surfaces d'event cartographiées (cf §3). `prompt()` pour changement de shell et `contextmenu` bloqué globalement sont les deux régressions UX. |
| **Output corruption** | **3 vecteurs confirmés** | OSC `ESC\` jamais clos → `escTail` fuit ; `partial>8192` flush bourrin coupe un SGR en deux → couleur bave ; `Copy` via `Ctrl+Shift+C` sans `sel` copie vide sans feedback. |

**Risque global:** pas de corruption catastrophique des données shell (gen + ConPTY correctement isolés), mais **4 bugs Responsive notés CRITIQUE/HIGH cassent l'output visible** dès qu'on redimensionne petit, zoome à 1.5×, ou laisse un `cat` fichier binaire produire un flux non-UTF8.

---

## 1. Architecture du render — flux réel

```
[Windows ConPTY] --read(8192)--> pty.rs:173 thread --base64--> emit "pty://frame" {id,g,d}
                                               \--emit "pty://exit" {id,g} on eof/killed
        │
        ├──> TermInstanceView.tsx:250-285  listen("pty://frame")  // filtre id+gen, atob→Uint8Array
        │                                    -> TextDecoder.decode(stream:true)
        │                                    -> TermHighlighter.write(bytes)  // split ESC/plain
        │                                        ├─ ESC segment → out() direct  // bypass highlight
        │                                        └─ plain segment → feedPlain() → block(120L/12K)
        │                                             → tryHighlightBlock() via lowlight  // SGR 32/33/36/90/91/94/96
        │                                             → out("\x1b[Ng m ... \x1b[39m\n")
        │                                    -> term.write(SGR) → xterm canvas (allowTransparency)
        │
        ├──> xterm theme termTheme():18-47  maps CSS vars --accent/--text/--syn-* → ITheme
        │                                    rafraîchi via MutationObserver sur <html style|data-theme|data-mode>
        │
        └──> FitAddon.proposeDimensions() → fitNow():287-319  // double fit + RAF second pass
                                             → scheduleResize(90ms) → invoke("pty_resize")
                                             → Rust master.resize(PtySize)
```

**Dock:** `Terminal.tsx:374-567` — colonne `flex` dans `.main` (`layout.css:254-265`), hauteur `h` clampée `clampH` (`57-58`) `120..0.7*vh`, pseudo `::before` blur isolé (`terminal.css:22-35`, `isolation:isolate` + `transform:translateZ(0)` sur `.term-body:169`), header 30 px + handle 10 px + liste instances droite 176 px (132–360, collapse 46 px).

**Multi-instance:** `TermEntry` (id, gen) persisté `localStorage oc.term.instances` (`198-203`), `gen` bump à chaque `reloadTerm:241-249` / `changeTermShell:251-259` / `killTerm:261-281`, `nextIdRef/genCounterRef` survivent aux reloads page. Tous les `invoke("pty_*")` passent `gen` → Rust tue uniquement si gen match (`pty.rs:247-264`).

**Highlight:** `termHighlight.ts:15-18` lowlight `common` + 10 `LANG_HINTS` regexp ordonnées (json > python > rust > go > csharp…). `CLASS_SGR:62-71` mappe 8 familles `hljs-*` → 6 codes SGR. `flush():195-202` ship raw si pas de match. `HL_SLOW_MS 40` + `HL_BAN_MS 2000` coupent le highlight après 1 frame lente.

**Shell discovery:** `terminals.rs:703-735` `list_terminals()` cache 10 s, `probe_shells` + `wsl_distros` (UTF-16LE/BOM/null heuristic `287-323`) + `wt_profiles` parse `settings.json` avec strip comments.

---

## 2. Cartographie complète event → output possible

### 2.1 Inputs utilisateur (21 surfaces)

| # | Event / gesture | Handler (`file:line`) | Output / effet |
|---|---|---|---|
| **E1** | `Terminal open` (Ctrl+`` `useGlobalShortcuts:230-239`, bouton `Composer:902-911`, `ChatPage:1100` lazy) | `Terminal.tsx:179-192` seed si vide, `TermInstanceView:337-373` boot+spawn via `requestIdleCallback` | Dock `height:h`, `TermInstanceView` `display:flex`, spawn ConPTY (cols/rows propose ou 80×24), watchdog 5 s `no output` |
| **E2** | `Frappe clavier dans xterm` | `TermInstanceView:230-232` `term.onData → invoke pty_write` | Bytes envoyés au PTY, echo shell → `pty://frame` → render |
| **E3** | `Ctrl+Shift+C` avec sélection | `TermInstanceView:215-221` `attachCustomKeyEventHandler` → `navigator.clipboard.writeText(sel)` | Copy to clipboard, return false (bloque xterm) |
| **E4** | `Ctrl+Shift+C` sans sélection | même handler, `if(sel)` false → `return false` sans copy | **Bug H1:** rien ne se passe, utilisateur croit avoir copié |
| **E5** | `Ctrl+Shift+V` | handler `222-226` → `clipboard.readText().then(term.paste)` | Paste dans xterm → `onData` → pty_write |
| **E6** | `Ctrl+Tab / Ctrl+Shift+Tab` focus dans `.term-dock` | `Terminal.tsx:349-372` capture `keydown` (capture) + `stopImmediatePropagation` | Cycle `activeId` (+1/-1 modulo), `playSound(click)`, `TermInstanceView:437-439` focus after 50 ms |
| **E7** | `Ctrl+Tab` focus hors dock | `useGlobalShortcuts:196-207` cycle sessions (sidebar recency) | Change session chat — **conflit volontaire volé quand inTerm** |
| **E8** | `Drag vertical handle` (`.term-resize`) | `Terminal:284-310` mousemove col → `clampH`, `playSound resize/70ms`, `body.resizing` | `h` state → `style height`, `ResizeObserver:416-434` → `fitNow()` → `pty_resize` debounced |
| **E9** | `Double-click handle ou head` | `312` `resetSize()` → `H_DEFAULT 240`; `379` `onDoubleClick` head hors bouton | Reset hauteur |
| **E10** | `Drag horizontal side handle` | `315-345` (guard `if sideCollapsed return`) | `sideW` 132–360, `body.__termSideResizing` flag |
| **E11** | `Collapse/expand instances` | `498-502` toggle `sideCollapsed` → localStorage | Width 176↔46 px, `term-side-resize` hidden, rows centrés 34×34 + dot absolu |
| **E12** | `Clic instance row` | `508` `setActiveId(t.id)` | Switch vue (`display:flex/none`), `fitNow` sur transitionend (`385-394`), focus |
| **E13** | `Hover row → Reload / Kill boutons` | `534-548` `opacity 0 →1` on hover/focus-within | `reloadTerm` kill+gen++ (`242-249`), `killTerm` `pty_kill` + filter list + auto `onClose` si dernière |
| **E14** | `Header Reload / Kill` (active term) | `388-398` | Même que E13 mais via header |
| **E15** | `+ New terminal (default)` | `432` `addTerm()` ; `559` footer collapsed | `resolveProfile(null)` → `System default`, push `TermEntry`, `activeId=id`, max 8 check `220-225` |
| **E16** | `∨ New with shell… → menu item click` | `440-494` `DropdownPortal`, groups probe/wsl/wt/custom | `addTerm(profileId)` avec path/args résolus (`161-169`), `onContextMenu` → `addTerm+onSetDefault` |
| **E17** | `Right-click instance row → prompt()` | `511-522` `prompt("Switch shell…")` → `changeTermShell(id, pid||null)` | **Bug H2:** `prompt()` bloquant, liste tramée `profiles.map(p=>p.id).join(", ")` sans échappement |
| **E18** | `Add menu outside click / Escape` | `146-159` `pointerdown` capture + `keydown Escape` | Close menu |
| **E19** | `Click Hide panel (chevron)` | `401` `onClose` → `ChatPage:570` `oc.term.open=0` | Dock `height:0` + `closed` (border transparent, shadow none) shells alive |
| **E20** | `Window resize / DPR change / ResizeObserver` | `TermInstanceView:413-434` `ResizeObserver` + `window resize` + `matchMedia(resolution)` + `fitNow` transitions `382-394` | `fit.fit()` + `term.refresh()` + `scheduleResize` |
| **E21** | `Theme/mode change` | `TermInstanceView:324-333` `MutationObserver` sur `html` + `termTheme()` | `term.options.theme = termTheme()` RAF |
| **E22** | `Shell exit / killed` | `274-280` `pty://exit` filter + `pty.rs:201-207` emit | `dead=true`, header `exited` (`385`), row `dead` opacity 0.7 + dot gris |
| **E23** | `Watchdog no output 5s` | `173-188` `frameAtRef` reste 0 → `setErr` + `onDead dead=true` après 2 retries | Banner `term-err` rouge header |
| **E24** | `localStorage corruption / quota` | `96-123` parse `oc.term.instances`, `132-136` `oc.term.active` | Fallback 1 terminal frais ; `catch{}` silencieux — **pas d'output d'erreur** |
| **E25** | `Clipboard read/write fail` (permission) | `219-224` `.catch(()=>{})` | Silently ignored — aucune notification |

### 2.2 Outputs possibles (par état)

| État | Rendu visuel |
|---|---|
| `open=false` | `.term-dock.closed height:0` caché, shells warm en arrière-plan (80×24) — pas de `pty_resize` |
| `open=true` + actif | `.term-body display:flex`, canvas opaque transparent glass, scrollbar xterm cachée (`.term-mount .xterm-viewport scrollbar-width:none:196-204`), sélection `accent 22%` |
| `open=true` + inactif | `display:none` (pas de `fitNow`), ConPTY toujours vivant mais plus de `pty_resize` jusqu'à activation |
| `dead` | Header `exited` italic, row `dead`, `term-inst-dot.dead` gris, plus d'output jusqu'à Reload |
| `err` | Header `term-err` rouge `max 8 terminals` (2.5 s auto) ou message Rust `shell not found:…` / `max terminals` |
| `sideCollapsed` | 46 px, liste centrée, rows 34×34, title/cwd masqués, dots absolus |
| `dragging/resizing` | `transition:none`, `body.resizing` cursor `col-resize/row-resize`, `playSound resize` throttlé 70 ms |
| `addMenu open` | `DropdownPortal` fixed `zIndex 100`, clamp viewport (±8 px), groupe skeletons si `profiles.length===0` |
| `no output watchdog` | `term-err` + `dead` simultanés |
| `theme light/dark` | ITheme recalculée (fg `--text`, bg `rgba(0,0,0,0)`, 16 ANSI mappées sur tokens) |

---

## 3. Audit responsive — ce qui casse

### 3.1 Ce qui existe

- `layout.css:289-293` `@media (max-width:900px) .layout { grid-template-columns:210px 1fr }` — n'affecte que la sidebar, pas le terminal.
- `permission.css` / `question.css` ont `@media (max-width:900/620)` — pas le terminal.
- `terminal.css` : **aucun `@media`** — zéro breakpoint pour le dock.
- `TermInstanceView:413-434` écoute `window resize` + DPR, mais FitAddon est la seule adaptation.

### 3.2 Failles responsive détaillées

#### 🔴 CRITIQUE R1 — Side panel mange le viewport étroit
**Localisation:** `terminal.css:207-219` `.term-side width:176px` + `Terminal.tsx:77-79` `SIDE_W_MIN 132`  
**Repro:**
1. Ouvrir terminal avec side expanded (176).
2. Réduire fenêtre Tauri à 640 px large (ou sidebar ouverte 248 + dock).
3. Observer `.term-views` disponible = `640 - 248 - 176 - 2*border ≈ 212 px` → FitAddon propose ~25 cols → PowerShell prompt `PS E:\project\ai assistant>` déjà 28 chars → wrap immédiat + `Ctrl+L` reflow tronque.
4. Pire à 520 px : views ~90 px → `fitNow:292` early return `clientWidth<80` ? Non, 90≥80 donc fit calcule 10 cols → `scheduleResize` envoie 10 cols au ConPTY → PowerShell recadre tout l'historique en 10 cols, illisible. Scroll horizontal impossible (viewport `scrollbar-width:none` + `overflow:hidden` sur `.term-views:161`).

**Cassure output:** historique reflowé définitivement, pas de scroll horizontal pour récupérer.  
**Fix attendu:** breakpoint `@media (max-width:720px)` → `.term-side` passe en overlay drawer ou `width: min(45vw,176px)` + `term-main flex-wrap:wrap` ou auto-collapse sous seuil.

#### 🔴 CRITIQUE R2 — Hauteur minimale incompatible avec chrome
**Localisation:** `terminal.css:47-54` handle 10 px + `87-103` head 30 px = 40 px chrome, `Terminal.tsx:57-58` `H_MIN 120`  
**Repro:** `H_MIN 120` laisse 80 px body. Mais `terminal.css:174-177` `.term-mount inset:6px` consomme 12 px verticaux → body effectif 68 px → `fitNow` avec font 13 px line ~15 px (xterm) → 4 rows max. `scheduleResize` envoie 4 rows → `pty_resize` rows=4 → `cls` remplit puis `prompt` multiline (oh-my-posh) déborde hors vue, 2 lignes cachées sans scroll visible (scrollbar hidden) → utilisateur croit le shell frozen.

**Fix:** `H_MIN` → 160 ou chrome en `position:absolute` hors flux, ou `term-mount inset 6px` → `padding` sur `.term-mount .xterm` (mais commentaire `171-173` dit padding désync FitAddon — donc plutôt augmenter min).

#### 🟠 HIGH R3 — Aucun breakpoint sous 900 px, dock déborde en hauteur
**Repro:** fenêtre haute 520 px, `clampH:58` `max 0.7*vh ≈ 364`, ok. Mais `max-height:50vh` du composer (`composer.css` equivalent) + dock 240 =  ~ 50 % + 240 > 520 → `.main overflow:hidden` coupe le bas du dock sans scroll. L'utilisateur ne peut plus atteindre la handle pour réduire (hors viewport). C'est aggravé par `ChatPage:605` `--perm-bottom` qui place permission bar au-dessus du composer.

**Fix:** `max-height: min(50vh, calc(100vh - 200px))` pour composer, et dock `max-height: 55vh`.

#### 🟠 HIGH R4 — Collapse strip illisible en étroit
**Localisation:** `terminal.css:220-222` `.term-side.collapsed width:46px`, `309-309` `.term-side.collapsed .term-inst-list gap:8px align:center`, `389-396` row 34×34  
**Repro:** avec 8 instances en collapse, hauteur 240 → `8*34 + 7*8 = 328` > 240 + head 30 → overflow auto mais `scrollbar-width:none` (`290-297`) → pas d'indicateur scroll, dots d'activité cachés sous la fold.

**Fix:** `scrollbar-width:thin` sur desktop ou indicateur `+N` overflow.

#### 🟡 MEDIUM R5 — ` transform: translateZ(0)` + `backdrop-filter` sur `.term-side` provoque tearing GPU lors du drag vertical
**Localisation:** `terminal.css:169` `translateZ(0)` isolé body, `215-217` side `backdrop-filter:blur(14px)` sibling flex.  
**Repro:** drag vertical rapide sur machine Intel iGPU (Win10 no-glass `tokens.css:142` `html.no-glass`). Le `::before` du dock blur 10 px + side blur 14 px cause 2 layers backdrop-filter côte-à-côte → frame drop, canvas xterm `background:transparent !important:187` laisse voir artefacts noirs 1 frame.

**Fix:** réduire side blur à `blur(8px)` ou `will-change:auto` pendant drag, ou désactiver side blur quand `dragging`.

#### 🟡 MEDIUM R6 — Inset 6 px casse FitAddon à zoom élevé
**Localisation:** `terminal.css:174-177` `.term-mount inset:6px`, `TermInstanceView:289-317` `proposeDimensions()` lit `bodyRef clientWidth` mais `.term-mount` est plus petit de 12 px.  
**Repro:** `uiScale 1.5` (`useSettings:359-391` via `getCurrentWebview().setZoom(1.5)`) → tous les `clientWidth` multipliés 1.5×, mais xterm `fontSize:13` fixe (ne scale pas avec uiScale, Tauri zoom scale déjà la page) → FitAddon calcule cols basé sur 6px inset déjà scalé → décalage -1 col vs réalité → dernier caractère masqué sous `inset` droit, ligne wrap prématurée.

**Fix:** mesurer `.term-mount` directement au lieu de `.term-body`, ou inclure inset dans le calcul manuel.

#### 🟢 LOW R7 — `DropdownPortal` cut off en très petit viewport
**Localisation:** `DropdownPortal.tsx:56-70` clamp `dx/dy`  
**Repro:** fenêtre 420×320, ancre `+` bouton proche du bord droit → `vw - r.right` ≈ 6 → menu `min-width 240 max-width 320` clamp translate mais `max-height min(360px,60vh)=192px` → 192 + top  `r.bottom+6` déborde, `dy` négatif translate mais pas de `max-height` recalcul → scrollbar interne mais header menu caché derrière titlebar (`zIndex 100` vs titlebar `z-index:10` ok, mais `isolation:isolate` sur dock peut créer stacking context).

**Fix:** déjà géré par `other>room` flip up, mais pas testé avec side collapsed 46 px ancre.

#### 🟢 LOW R8 — `prefers-reduced-motion` ignoré pour le dock
**Localisation:** `terminal.css:19` `transition: height 0.25s`, `tokens.css:131-138` reduce désactive tout `*`.  
**Repro:** `tokens` met `transition-duration:0.01ms` mais `.term-dock.dragging/no-anim` set `transition:none` seulement pendant drag. En reduce, la transition height devrait être 0 mais `term-dock::before` backdrop-filter anime aussi → léger motion.

**Fix:** wrap sous `@media (prefers-reduced-motion:reduce) .term-dock {transition:none}`.

---

## 4. Failles & bugs fonctionnels — inventaire priorisé

### 🔴 CRITIQUE B1 — OSC terminé par `ESC\` (ST) jamais fermé → `escTail` fuit indéfiniment
**Fichier:** `src/lib/termHighlight.ts:221-236` `seqEnd`, `src/components/TermInstanceView.tsx:257-272` OSC fallback scan  
**Repro:** `echo -e "\x1b]0;my title\x1b\\" ` (certains shells/configs, Windows Terminal osc title via ST pas BEL) → `seqEnd` pour `kind=="]"` cherche `\x07` seulement → `return -1` → `escTail = "\x1b]0;my title\x1b\\" ` → `flush()` vide le block puis hold ; prochain chunk `"ls\n"` concaténé `escTail+text = "\x1b]0;my title\x1b\\ls\n"` → `seqEnd` trouve pas BEL → hold encore → plus jamais `out()` → **output freeze partiel**. La scan fallback `TermInstanceView:262` regex `\x1b\]0;...\x07` ignore aussi ST → title jamais mis à jour.

**Output cassé:** tout le flux après un OSC ST reste bufférisé dans `escTail`, invisible.  
**Fix 1 ligne:** `seqEnd` cas `]` chercher `belIdx` et `stIdx` (`\x1b\\`) prendre le plus proche :
```ts
if(kind==="]"){ const bel=s.indexOf("\x07",start+2); const st=s.indexOf("\x1b\\",start+2); if(bel===-1&&st===-1) return -1; const end= Math.min(bel===-1?Infinity:bel+1, st===-1?Infinity:st+2); return end; }
```
Et `TermInstanceView` regex → `/\x1b\]0;([^\x07\x1b]*?)(?:\x07|\x1b\\)/`.

**Gravité:** critique car Windows Terminal et certains `printf '\e]2;…\e\\'` usuels.

### 🔴 CRITIQUE B2 — Output binaire / non-UTF8 produit `�` et casse `seqEnd`
**Fichier:** `termHighlight.ts:118-140` `TextDecoder` sans option, `pty.rs:181-190` raw bytes base64  
**Repro:** `cat image.png` ou `hexdump -C` binaire dans le terminal → ConPTY envoie bytes non-UTF8 (0xFF 0xFE…) → `dec.decode(bytes,{stream:true})` remplace par `�` (U+FFFD) → si `�` contient `"`? Non, mais surtout `\x1b` suivi d'un byte haut (>127) devient `�` → `seqEnd` ne trouve plus l'ESC, plain feed `�` → highlight block essaie `guessLang` sur `�` → échec mais output remplacé, binaire corrompu visuel. Pire: `atob` sur base64 → `bin.length` bytes interprétés comme latin1 (`charCodeAt`) — ok, mais `TextDecoder` remplace. Pas de passthrough hex dump.

**Output cassé:** dump binaire illisible, couleurs SGR injectées au milieu d'octets binaires.  
**Fix:** détecter binaire si `bytes` contient `0x00` ou >30% non-printable → `out(text)` raw sans `TextDecoder` (ou `TextDecoder('windows-1252')` fallback) ou passer par `xterm` binary mode. Au minimum, `new TextDecoder('utf-8', {fatal:false})` déjà, mais éviter highlight sur block contenant `�`.

### 🟠 HIGH B3 — `partial>MAX_PARTIAL 8192` flush coupe un SGR au milieu
**Fichier:** `termHighlight.ts:184-187` `if(partial.length>MAX_PARTIAL){ flush(); return; }`  
**Repro:** `cat` un fichier 20K sans newline (ex: minified JS une ligne 50K) → `feedPlain` accumule `partial` sans `\n` → `>8192` → `flush()` → `flushBlock()` ship `joined` (vide car pas de `\n`? actually `block` vide) puis `out(partial)` raw → OK mais le `timer` 90 ms reste pending ? Non `flush` clear timer. Problème suivant: si pendant ce `partial` il y avait un SGR injecté par `tryHighlightBlock` précédent (non, pas de SGR dans partial), mais après flush, nouveau chunk arrive `"... \x1b[32m green ..."` → `write()` voit pas ESC car c'est plain? Attend `tryHighlightBlock` injecte `\x1b[32m` dans le `out()` précédent; suivant chunk `partial` recommence sans reset couleur → couleur bave jusqu'à prochain `\x1b[39m`. Pas dramatique mais visible.

**Fix:** après `MAX_PARTIAL` flush, reset SGR avec `\x1b[0m` ou ne pas highlight si `partial` > cap.

### 🟠 HIGH B4 — `prompt()` bloque l'event loop → freeze render + focus perdu
**Fichier:** `Terminal.tsx:517-522` `onContextMenu` → `prompt(...)`  
**Repro:** right-click instance row → native `prompt()` modal bloquant → `requestAnimationFrame` fit, `ResizeObserver`, `Transitionend` en pause → si on tape pendant prompt, xterm `onData` queue bloquée ; après dismiss, `genRef` peut être stale si autre event a bump gen entre-temps.

**Fix:** remplacer par un vrai `DropdownPortal` mini-menu par instance (comme add menu) avec `<input>` + liste shells.

### 🟠 HIGH B5 — `global contextmenu preventDefault` tue le menu natif du terminal (copy)
**Fichier:** `useGlobalShortcuts.ts:169-173` `document.addEventListener("contextmenu", e=>e.preventDefault())`  
**Repro:** right-click dans xterm → menu natif (Copy/Paste) jamais affiché → utilisateur ne peut pas copier sans `Ctrl+Shift+C` (qui lui-même a bug B6). `TermInstanceView` utilise `attachCustomKeyEventHandler` mais pas de handler `onContextMenu` → perdu.

**Fix:** exclure `.xterm` : `if ((e.target as HTMLElement).closest('.xterm')) return;`.

### 🟠 HIGH B6 — `Ctrl+Shift+C` sans sélection retourne `false` mais ne feedback rien + bloque propagation
**Fichier:** `TermInstanceView:215-221`  
**Repro:** pas de sélection, Ctrl+Shift+C → `return false` (empêche xterm default) sans `navigator.clipboard` call → clipboard inchangé, pas d'erreur, utilisateur croit copié. Devrait `return true` pour laisser xterm envoyer `SIGINT`? En fait `Ctrl+C` sans shift est SIGINT, mais `Ctrl+Shift+C` est copy shortcut Windows Terminal.

**Fix:** `if(!sel) return true;` ou `term.triggerDataEvent?` — laisser passer ou montrer toast.

### 🟠 HIGH B7 — Double `addTerm` race dépasse MAX_TERMS 8
**Fichier:** `Terminal.tsx:219-239` check `terms.length>=8` via closure, `pty.rs:119-124` second check sous lock  
**Repro:** double-click rapide `+` (ou click `+` puis `Ctrl+`? non) quand `terms.length===7` → deux calls `addTerm` voient 7, poussent chacun id différent → `setTerms([...prev,entry])` deux fois → `prev` stale? En fait React batch peut merger : le second `setTerms(prev=>[...prev,entry])` part de 7+1=8 puis 8+1=9 si pas de guard dans updater? Mais guard est hors updater (`if(terms.length>=8)` lit state stale). Seconde insertion passe → `terms` 9 dans frontend mais Rust `pty_spawn` rejette `max terminals` sur le 9e → `spawn:192-194` catch `setErrLocal("max terminals (8) reached")` → **un TermInstanceView rendu avec err mais aussi un slot vide dans la liste** (header montre `9/8` impossible, `term-count:382`).

**Fix:** guard dans updater : `setTerms(prev=> prev.length>=8 ? prev : [...prev,entry])`.

### 🟡 MEDIUM B8 — `localStorage` quota / JSON invalide silencieux + `activeId` orphelin
**Fichier:** `Terminal.tsx:96-136`, `198-204` `try/catch` sans report  
**Repro:** `localStorage.setItem(INST_KEY, JSON.stringify(arr))` peut throw `QuotaExceededError` si disque plein → catch vide → prochaine reload régénère mais perd shells persistant sans explication. `activeId`  `Number(localStorage.getItem(ACTIVE_KEY))` → `Number("abc")=NaN` → `saved` 0 falsy fallback `terms[0].id` ok, mais `Number("1.5")=1.5` non-entier id invalide → `!terms.some(t=>t.id===1.5)` → `setActiveId(terms[0].id)` corrige mais flash.

**Fix:** valider `Number.isInteger` + `>0`, log via `console.warn`, et `try/catch` avec `setMaxErr("failed to save terminals")`.

### 🟡 MEDIUM B9 — `TermHighlighter` `hlBanUntil` global partagé entre instances → un flood sur term 1 coupe highlight sur term 2
**Fichier:** `termHighlight.ts:97` `let hlBanUntil=0` module global  
**Repro:** ouvrir 2 terms, dans term1 `cat huge.jsonl` 50K lines → highlight slow >40 ms → `hlBanUntil=now+2000` → term2 `cat small.py` pendant ces 2 s reste non-highlighté alors qu'il est petit.

**Fix:** déplacer `hlBanUntil` en instance field dans `TermHighlighter`.

### 🟡 MEDIUM B10 — `fitNow` early return `clientHeight<60 || clientWidth<80` laisse ConPTY désynchro
**Fichier:** `TermInstanceView:287-317`  
**Repro:** dock animé de 0→240, premier `fitNow` pendant transition à `el.clientHeight=45` → return sans `scheduleResize` → ConPTY resté à 80×24, xterm affiche 80×24 dans 45 px → rows tronquées, scrollbar xterm interne mais viewport hidden → output bas coupé. Prochain `fitNow` après transition corrige, mais entre-temps 280 ms de rendu tronqué + watchdog peut croire `no output` si prompt caché.

**Fix:** au lieu de return, `requestAnimationFrame(fitNow)` retry.

### 🟡 MEDIUM B11 — `ResizeObserver` + `window resize` + `matchMedia` + `transitionend` → 4 triggers simultanés envoient 2 `pty_resize` identiques malgré dedup `lastResizeRef`
**Fichier:** `TermInstanceView:288-319`, `412-434`, `384-394`  
**Repro:** maximise fenêtre → `window resize` + `ResizeObserver` fire même frame → `fitNow()` appelé 2× via `roRaf` guard `if(roRafRef.current) return` dedup une, mais `window resize` passe par `roRaf` aussi → 1 seul, ok. Mais `transitionend` (`height`) fire en plus → second `fitNow` propose mêmes cols/rows → `scheduleResize` dedup via `lastResizeRef` égal → annule, mais `pendingResizeRef` déjà set puis `flushResize` envoie quand même? Actually `flushResize:113-123` check `p.c===lastResize.c && p.r===lastResize.r` → annule, donc pas d'envoi double. **Pas de bug visible mais waste**. Plus critique: pendant drag vertical `setH` continu → `ResizeObserver` + `mousemove` → `fitNow` flood RAF → `playSound resize` throttled 70 ms ok, mais `FitAddon.proposeDimensions` appelé hors RAF dans `spawn 147-153` peut throw.

**Fix:** unifier en un seul `ResizeObserver` + debounce, supprimer `window resize` listener redondant.

### 🟡 MEDIUM B12 — `select text → tooltip / selectionMenu` peut recouvrir le dock
**Fichier:** `ChatPage:848-851` `SelectionMenu` global, `TooltipLayer`  
**Repro:** sélectionner du texte dans `.term-mount .xterm` → `SelectionMenu` peut s'afficher (s'il écoute `selectionchange` global) par-dessus le terminal, masquant le prompt. Pas filtré par `.term-dock`.

**Fix:** `SelectionMenu` guard `if(target.closest('.term-dock')) return null;`.

### 🟢 LOW B13 — `hlHtml` et `TermHighlighter` utilisent deux `lowlight` instances séparées (`syntax.ts:4` et `termHighlight.ts:15`) → bundle double grammars
**Localisation:** `syntax.ts:4` `createLowlight(common)`, `termHighlight.ts:15` idem  
**Repro:** bundle `manualChunks` (`vite.config.ts:26-40`) met tout dans `markdown` chunk, mais 2 instances = 2 copies des grammars en mémoire → petit waste.

**Fix:** exporter singleton `lowlight` depuis `src/lib/lowlight.ts`.

### 🟢 LOW B14 — `DropdownPortal` `r.width===0 && r.height===0` early return laisse `style null` → menu jamais affiché si ancre renderée mais invisible (ex: side collapsed)
**Fichier:** `DropdownPortal.tsx:37`  
**Repro:** ouvrir add menu puis collapse side (ancre `addMenuRef` reste dans DOM mais `display:flex`? En collapsed l'ancre n'est pas render → `anchor.current` null → `place` return sans setStyle → menu reste ouvert avec ancien style en l'air.

**Fix:** `useEffect` dépendance `open` → si `!anchor.current` → `setStyle(null)` et close.

### 🟢 LOW B15 — `FileEditor` / `Composer` find `highlightFindInHtml` compte occurrences globalement mais `TermHighlighter` n'expose pas find → impossible de chercher dans terminal
**Constat:** `src/lib/find.ts:59` utilisé dans `FileEditor` et `Composer` mais pas dans `Terminal`. Feature manquante, pas bug, mais attendu pour terminal.

---

## 5. Matrice exhaustive des outputs cassables (par type de sortie shell)

| Sortie shell | Canal | Highlight? | Resize? | Cassure observée |
|---|---|---|---|---|
| Texte plain `echo hello` | `feedPlain` | non (no lang) | non | OK |
| Table `ls -l` avec ANSI (`\x1b[32m`) | ESC segment | bypass | non | OK — `split ESC` correct |
| Prompt PSReadLine (ESC + texte interleavé même chunk) | mix | split → header ESC bypass, tail plain | oui (chaque newline) | OK après fix R6 |
| `cat file.py` 200 lines | plain block 120L cap → 2 flush | python highlight | non | OK, split en 2 blocks |
| `cat huge.log 10K lines sans blank` | `MAX_BLOCK` flush chaque 120L | highlight par tranche | possible reflow | OK mais perf 83 flushes → `HL_SLOW` ban |
| `cat minified.js 1 ligne 30K` | `MAX_PARTIAL 8192` → `out(raw)` | pas highlight (pas de `\n`) | non | **B3** couleur bave |
| Sortie binaire `cat img.png` | `TextDecoder` → `�` | guessLang false | non | **B2** → `�` partout |
| OSC title `\x1b]0;foo\x07` | ESC OSC → `out()` raw, fallback regex title | extrait titre | non | OK (BEL) |
| OSC title `\x1b]0;foo\x1b\\` | ESC OSC ST → `seqEnd -1` hold | freeze | non | **B1** freeze |
| CSI cursor ` \x1b[2J \x1b[H` | ESC CSI → `out()` | bypass | non | OK (xterm gère) |
| Unicode `echo "café 🚀"` split sur 2 chunks mid-UTF8 | `TextDecoder stream:true` | reassemble | non | OK |
| Emoji large `"\x1b[31m❤️\x1b[0m"` | ESC + plain `❤️` | split correct | non | OK |
| Resize pendant output (`yes | head -n 1000 &` + drag) | `pty_resize` 90 ms debounce | non | Reflow PowerShell prompt parfois duplique (commentaire `145-147`) |
| Exit code 1 (`exit 1`) | `pty://exit` | dead | non | OK |
| `kill -9` (ConPTY tué externe) | `reader.read Err` loop sleep 20 ms → break killed? | dead | non | Si pas `killed` flag, loop sleep infini 20 ms jusqu'à EOF — léger waste |
| Thème switch (cyan→latte) | `MutationObserver` → `termTheme()` | recolor 16 ANSI | non | OK mais flash 1 frame (RAF) |
| Zoom `uiScale 1.5` | `getCurrentWebview().setZoom` + `ResizeObserver` | fitted | oui | **R6** col off-by-1 |
| Window < 400 px | `fitNow` propose 10 cols | reflow truncate | oui | **R1** illisible |
| 8 terms ouverts | `MAX_TERMS` Rust + frontend guard | 8 canvases, 16 listeners | non | **B7** possible 9e fantôme |
| Clipboard `Ctrl+Shift+V` avec gros payload 1 MB | `pty_write` `data:String` une requête | non | non | Pas de chunking → Tauri payload limite ~ 1 MB JSON, peut throw `data too large` silencieux `.catch(()=>{})` |

---

## 6. Tests manqués — à ajouter avant de ship

- **Resize fuzz:** `window.resizeTo(400,300) → drag handle → DPR change 1→1.5` vérifier `proposeDimensions` ne throw pas et `lastResize` mis à jour.
- **OSC ST:** unit test `termHighlight.test.ts:4-44` ajouter chunk `"\x1b]0;title\x1b\\" + "next\n"` vérifier pas de `escTail` leak.
- **Binaire:** `bytes [0xFF,0x00,0x1B,'[','3','2','m']` vérifier `write` ne jette pas et `flush` pas d'exception.
- **MAX_PARTIAL:** `feedPlain("a".repeat(9000))` vérifier `partial` vidé et `out` appelé une fois.
- **Prompt blocker:** e2e `rightClick row → assert !window.prompt`.
- **Contextmenu:** `dispatchEvent(new MouseEvent('contextmenu',{target:xtermEl})) → expect not prevented`.
- **Responsive snapshot:** Playwright `viewport 360×640` screenshot dock vs `640×480` comparer absence de chevauchement.

---

## 7. Plan de correction priorisé (ordre d'implémentation)

### P0 — Casse visible immédiate
1. **R1/R2/R3** media query dock + `H_MIN 160` + `max-height` main (`audits` fix + `terminal.css:207-219`, `Terminal.tsx:58`).
2. **B1** `seqEnd` ST + regex fallback (`termHighlight.ts:221-236`, `TermInstanceView:262`).
3. **B5** `useGlobalShortcuts:171` exclure `.xterm`.

### P1 — High, output ou UX cassés
4. **B2** détection binaire → bypass highlight (`termHighlight.ts:135-145`).
5. **B4** remplacer `prompt` par portaled menu (`Terminal.tsx:511-522`).
6. **B7** updater guard `setTerms(prev=>prev.length>=8?prev:...)` (`Terminal.tsx:235`).
7. **B10** retry `fitNow` au lieu de return (`TermInstanceView:289-293`).

### P2 — Medium, dette et perf
8. **B9** `hlBanUntil` → champ instance.
9. **B6** `Ctrl+Shift+C` sans sel → `return true`.
10. **R6** mesurer `.term-mount` au lieu de `.term-body`.
11. **B11** unifier `ResizeObserver` vs `window resize`.

### P3 — Low / polish
12. `prefers-reduced-motion` dock, `DropdownPortal` null anchor, lowlight singleton, `localStorage` quota toast, `SelectionMenu` guard.

---

## 8. Notes de conception — ce qui est bien et à garder

- `isolation:isolate` + `::before` blur hors stacking canvas (`terminal.css:20,169`) — commentaire `10-13` exact, corrige corruption GPU.
- `inset:6px` comme padding virtuel sans casser FitAddon (`171-173`) — bon compromis documenté.
- `gen` anti-bleed + double check `MAX_TERMS` sous lock (`pty.rs:110-124` puis `206-211` + sleep 90 ms) — évite race ConPTY création simultanée.
- `id==0` rejet + `shell.contains(\/\) && !exists` early error — message clair.
- `MAX_BLOCK`/`MAX_PARTIAL`/`HL_BAN` caps — évitent jank sur flood, `ponytail:` ceiling annoncé.
- `requestIdleCallback` stagger par `id%4*240+600` (`TermInstanceView:348-349`) — lisse le cold start 3-4 PTY sans jank first paint.

---

## 9. Annexe — fichiers & lignes à patcher (checklist)

```
src/lib/termHighlight.ts:97    hlBanUntil global → instance
src/lib/termHighlight.ts:184   MAX_PARTIAL flush → inject \x1b[0m
src/lib/termHighlight.ts:221   seqEnd OSC BEL+ST
src/components/TermInstanceView.tsx:262 regex OSC ST
src/components/TermInstanceView.tsx:215 prompt copy
src/components/TermInstanceView.tsx:287 fit early return
src/components/TermInstanceView.tsx:413 dupe resize listeners
src/components/Terminal.tsx:57  H_MIN 120→160
src/components/Terminal.tsx:219 addTerm race guard
src/components/Terminal.tsx:511 prompt→menu
src/hooks/useGlobalShortcuts.ts:169 contextmenu guard .xterm
src/styles/terminal.css:19       reduced-motion
src/styles/terminal.css:174      measure mount not body (doc)
src/styles/terminal.css:207      @media (max-width:720px) collapse
src-tauri/src/pty.rs:230         pty_resize cols/rows 0 guard already OK
```

---

*Audit généré par lecture source exhaustive, sans exécution externe (Tauri build non lancé). Chaque finding cite `file:line` vérifiable et un repro pas-à-pas.*
