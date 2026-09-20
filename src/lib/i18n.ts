// i18n — tiny no-deps translation layer.
// Keys are flat dot-notation ("settings.title", "sidebar.tabs.chats").
// Core bundles (en/fr/es) ship here; plugins merge via registerPluginTranslations().
// Language stored in oc.settings.language (via useSettings) + mirrored to oc.language for non-React access.
// Falls back: plugin bundle -> core bundle -> en -> key.

export type Lang = "en" | "fr" | "es";
export const LANGUAGES: { id: Lang; label: string; native: string }[] = [
  { id: "en", label: "English", native: "English" },
  { id: "fr", label: "French", native: "Français" },
  { id: "es", label: "Spanish", native: "Español" },
];
export const DEFAULT_LANG: Lang = "en";

type Dict = Record<string, string>;

function isLang(v: unknown): v is Lang {
  return v === "en" || v === "fr" || v === "es";
}

function detectLang(): Lang {
  try {
    const raw = typeof navigator !== "undefined" ? navigator.language : "";
    const tag = raw.toLowerCase();
    if (tag.startsWith("fr")) return "fr";
    if (tag.startsWith("es")) return "es";
    return "en";
  } catch { return "en"; }
}

// ---------------------------------------------------------------------------
// persisted language — reads from oc.settings.language then fallback
// ---------------------------------------------------------------------------
export function getLang(): Lang {
  try {
    const raw = localStorage.getItem("oc.settings");
    if (raw) {
      const j = JSON.parse(raw);
      if (isLang(j.language)) return j.language;
    }
  } catch {}
  try {
    const raw2 = localStorage.getItem("oc.language");
    if (isLang(raw2 as string)) return raw2 as Lang;
  } catch {}
  // first run: use browser lang if fr/es, else en
  const d = detectLang();
  return d;
}

export function setLang(lang: Lang) {
  try {
    const raw = localStorage.getItem("oc.settings");
    const j = raw ? JSON.parse(raw) : {};
    j.language = lang;
    localStorage.setItem("oc.settings", JSON.stringify(j));
  } catch {}
  try { localStorage.setItem("oc.language", lang); } catch {}
  try { window.dispatchEvent(new CustomEvent("oc:language-changed", { detail: lang })); } catch {}
  // storage event doesn't fire in same tab — dispatch manually for hook
  try { window.dispatchEvent(new Event("storage")); } catch {}
}

// ---------------------------------------------------------------------------
// core bundles
// ---------------------------------------------------------------------------
const en: Dict = {
  // common
  "common.close": "Close",
  "common.cancel": "Cancel",
  "common.confirm": "Confirm",
  "common.keep": "Keep",
  "common.delete": "Delete",
  "common.remove": "Remove",
  "common.rename": "Rename",
  "common.duplicate": "Duplicate",
  "common.copy": "Copy",
  "common.save": "Save",
  "common.search": "Search",
  "common.filter": "Filter",
  "common.refresh": "Refresh",
  "common.loading": "Loading…",
  "common.noResults": "No results",
  "common.expand": "Expand",
  "common.collapse": "Collapse",
  "common.yes": "Yes",
  "common.no": "No",
  "common.back": "Back",
  "common.next": "Next",
  "common.finish": "Finish",
  "common.skip": "Skip",
  "common.sure": "Sure?",
  "common.enabled": "enabled",
  "common.disabled": "disabled",
  "common.error": "Error",
  "common.copyPath": "Copy path",
  "common.copyId": "Copy ID",
  "common.copyTitle": "Copy Title",

  // settings
  "settings.title": "Settings",
  "settings.tip.runSetup": "Run setup again",
  "settings.tip.info": "Voice, commands & hotkeys",
  "settings.tip.close": "Close",
  "settings.language.title": "Language",
  "settings.language.name": "Language",
  "settings.language.desc": "Interface language",
  "settings.appearance.title": "Appearance",
  "settings.appearance.theme.name": "Theme",
  "settings.appearance.theme.desc": "Interface color scheme",
  "settings.appearance.theme.openConfig": "Open config folder",
  "settings.appearance.theme.reset": "Reset themes to defaults",
  "settings.appearance.theme.resetConfirm": "Click again to reset themes",
  "settings.appearance.mode.name": "Mode",
  "settings.appearance.mode.desc": "Dark or light variant of the theme",
  "settings.appearance.mode.dark": "Dark",
  "settings.appearance.mode.light": "Light",
  "settings.appearance.scale.name": "UI scale",
  "settings.appearance.scale.desc": "Zoom level of the whole interface",
  "settings.project.title": "Project & Models",
  "settings.project.workspace.name": "Workspace",
  "settings.project.workspace.home": "Home folder (no Git snapshots)",
  "settings.project.workspace.closeAll": "Close all workspaces",
  "settings.project.workspace.browse": "Browse…",
  "settings.project.workspace.browseTip": "Open workspace (Ctrl+O)",
  "settings.project.secondary.name": "Secondary model",
  "settings.project.secondary.desc": "Cheap model for secondary tasks — commit messages, debriefs & long-answer summaries (over 30 words)",
  "settings.project.commitBody.name": "Commit body",
  "settings.project.commitBody.desc": "AI commit messages include a bullet body",
  "settings.window.title": "Window & System",
  "settings.window.launch.name": "Launch on startup",
  "settings.window.launch.desc": "Start OpenCode when Windows boots",
  "settings.window.alwaysOnTop.name": "Always on top",
  "settings.window.alwaysOnTop.desc": "Keep the window above all others",
  "settings.window.keepSize.name": "Keep window size",
  "settings.window.keepSize.desc": "Don't reset window size when reopening from tray",
  "settings.window.closeOnX.name": "Close button quits",
  "settings.window.closeOnX.desc": "Clicking X exits the app instead of hiding to tray (hold Ctrl to invert)",
  "settings.terminal.title": "Terminal",
  "settings.terminal.defaultShell.name": "Default shell",
  "settings.terminal.defaultShell.desc": "New terminals use this shell · per-terminal picker in the dock",
  "settings.terminal.detectAgain": "Detect again",
  "settings.terminal.detectAgainTip": "Detect installed shells again",
  "settings.terminal.customShell.title": "Custom shell",
  "settings.terminal.customShell.desc": "Add any executable on PATH or absolute path · shown in both pickers",
  "settings.terminal.customShell.namePlaceholder": "Name (e.g. Nushell)",
  "settings.terminal.customShell.pathPlaceholder": "Path (C:\\tools\\nu.exe or nu)",
  "settings.terminal.customShell.argsPlaceholder": "Args (optional)",
  "settings.terminal.customShell.add": "Add",
  "settings.terminal.customShell.removeTip": "Remove custom shell",
  "settings.terminal.noShells": "No shells detected — check WSL/Windows Terminal install",
  "settings.voice.title": "Voice & Sound",
  "settings.voice.voiceSpeech.name": "Voice & speech",
  "settings.voice.voiceSpeech.desc": "Speech engine, mic sensitivity, neural voices & spoken replies",
  "settings.voice.voiceSpeech.open": "Open",
  "settings.voice.voiceSpeech.openTip": "Open voice settings",
  "settings.updates.title": "Updates",
  "settings.updates.name": "Updates",
  "settings.updates.checking": "Checking for releases…",
  "settings.updates.upToDate": "You're up to date · v{version}",
  "settings.updates.available": "Version {version} available · {notes}",
  "settings.updates.check": "Check",
  "settings.updates.updateAndRestart": "Update & restart",
  "settings.updates.downloading": "Downloading…",
  "settings.updates.notifications.name": "Update notifications",
  "settings.updates.notifications.desc": "Show a prompt on launch when a new version is available",
  "settings.updates.debugLocal.title": "Debug local build",
  "settings.updates.debugLocal.desc": "Folder containing opencode-gui.exe — stages it and restarts (tests swap/relaunch without GitHub)",
  "settings.updates.debugLocal.placeholder": "C:\\path\\to\\folder",
  "settings.updates.debugLocal.useLocal": "Use local",
  "settings.updates.debugLocal.useLocalTip": "Stage local opencode-gui.exe and restart",
  "settings.danger.title": "Danger Zone",
  "settings.danger.clean.name": "Clean state",
  "settings.danger.clean.desc": "Uninstall all voice engines & models and reset every preference — next launch runs the setup again",
  "settings.danger.clean.reset": "Reset",
  "settings.danger.clean.confirm": "Really? Click again",

  // sidebar
  "sidebar.tip.show": "Show session history",
  "sidebar.tip.hide": "Hide panel",
  "sidebar.tabs.chats": "Chats",
  "sidebar.tabs.files": "Files",
  "sidebar.attention.badge": "{count} session{plural} need{plural2} your attention — click to show",
  "sidebar.session.rename": "Rename",
  "sidebar.session.duplicate": "Duplicate",
  "sidebar.session.pin": "Pin",
  "sidebar.session.unpin": "Unpin",
  "sidebar.session.copyId": "Copy ID",
  "sidebar.session.copyTitle": "Copy Title",
  "sidebar.session.share": "Share (copy link)",
  "sidebar.session.close": "Close",

  // titlebar
  "titlebar.agents": "Agents",
  "titlebar.agentsTip": "Agents ({hotkey})",
  "titlebar.plugins.update": "Plugins — updates available",
  "titlebar.plugins.default": "Plugins",
  "titlebar.debriefing": "Debrief in progress — preparing summary",
  "titlebar.debriefingLabel": "Debriefing",
  "titlebar.speaking": "Speaking",
  "titlebar.speakingTip": "Stop speech",
  "titlebar.notSpeakingTip": "Not speaking",
  "titlebar.notSpeakingLabel": "Not speaking",
  "titlebar.settingsTip": "Settings",
  "titlebar.pinOn": "Unpin (always on top)",
  "titlebar.pinOff": "Pin to top (always on top)",
  "titlebar.minimize": "Minimize",
  "titlebar.maximize": "Maximize / restore",
  "titlebar.close.quit": "Quit OpenCode (Ctrl: hide to tray)",
  "titlebar.close.hide": "Hide to tray (Ctrl: quit)",

  // composer
  "composer.placeholder.needsModel": "Pick a model above to start chatting",
  "composer.placeholder.busy": "Waiting for reply…",
  "composer.placeholder.idle": "Ask anything (Enter to send, Shift+Enter for newline)",
  "composer.stop.tip": "Stop generating",
  "composer.stop.armed": "Press Esc again to stop",
  "composer.send.tip": "Send · Enter",

  // git
  "git.noRepo": "No git repository",
  "git.commit.staged": "Commit Staged",
  "git.commit.all": "Commit All",
  "git.commit.stagedPush": "Commit Staged + Push",
  "git.commit.allPush": "Commit All + Push",
  "git.commit.stagedSync": "Commit Staged + Sync",
  "git.commit.allSync": "Commit All + Sync",
  "git.tabs.hidden": "+{count} non-repo hidden",
  "git.loading": "Loading git status…",

  // chat / messages
  "chat.emptyNoSession": "Select or create a session\nto start.",
  "chat.rewind.banner": "Viewing an earlier version of this conversation.",
  "chat.rewind.undo": "Undo rewind",
  "chat.closeConfirm": "Press Ctrl+W again to close this session",
  "chat.closeWorkspaceConfirm": "Press Ctrl+Shift+W again to close this workspace",

  // permission & question
  "permission.title": "Permission required · {type}",
  "permission.allowOnce": "Allow once",
  "permission.alwaysAllow": "Always allow",
  "permission.deny": "Deny",
  "question.title": "AI question",
  "question.other": "Other…",
  "question.answer": "Answer",
  "question.dismiss": "Dismiss",
  "question.hint.instant": "↑↓ · Enter select · Esc dismiss",
  "question.hint.multi": "↑↓ · Enter answer · Esc dismiss",

  // browser
  "browser.back": "Back (mouse4)",
  "browser.forward": "Forward (mouse5)",
  "browser.reload": "Reload",
  "browser.urlPlaceholder": "Search or type a URL",
  "browser.openExternal": "Open in system browser",
  "browser.return": "Return to OpenCode",

  // file tree
  "fileTree.find.placeholder": "Find file",
  "fileTree.find.close": "Close (Esc)",
  "fileTree.newFile": "New File",
  "fileTree.newFolder": "New Folder",
  "fileTree.refresh": "Refresh",
  "fileTree.copyWorkspacePath": "Copy Workspace Path",
  "fileTree.open": "Open",
  "fileTree.openWithDefault": "Open With Default App",
  "fileTree.copyPath": "Copy Path",
  "fileTree.copyRelative": "Copy Relative Path",
  "fileTree.copyContent": "Copy Content",
  "fileTree.duplicate": "Duplicate",
  "fileTree.rename": "Rename",
  "fileTree.deleteFile": "Delete File",
  "fileTree.deleteFolder": "Delete Folder",
  "fileTree.setAsWorkspace": "Set as workspace",
  "fileTree.error.setWorkspace": "Already a workspace or invalid folder",

  // plugins
  "plugins.title": "Plugins",
  "plugins.tabs.installed": "Installed ({count})",
  "plugins.tabs.browse": "Browse",
  "plugins.openFolder": "Open folder",
  "plugins.openFolderTip": "Open plugin folder",
  "plugins.updates.checking": "Checking for updates…",
  "plugins.updates.available": "{count} update{plural} available",
  "plugins.updates.upToDate": "All plugins up to date",
  "plugins.updates.checkingCatalog": "Checking catalog…",
  "plugins.updateAll": "Update all",
  "plugins.autoUpdate": "Auto-update",
  "plugins.autoUpdateTip": "When on, plugins update automatically as soon as a newer version is found",
  "plugins.refresh": "Refresh",
  "plugins.refreshTip": "Force refresh catalog (bypass 12h cache)",
  "plugins.empty.title": "No plugins installed",
  "plugins.empty.desc": "Drop a folder with plugin.json + main.js into the plugins folder or browse the catalog.",
  "plugins.empty.openFolder": "Open plugin folder",
  "plugins.empty.browse": "Browse catalog",
  "plugins.list.noPlugins": "No plugins found — check connection and try refresh",
  "plugins.row.update": "Update",
  "plugins.row.updating": "Updating…",
  "plugins.row.updateTip": "Update {id} {from} → {to}",
  "plugins.row.disableTip": "Disable plugin",
  "plugins.row.enableTip": "Enable plugin",
  "plugins.row.settings": "Settings",
  "plugins.row.settingsDisabled": "Enable to configure",
  "plugins.row.reinstall": "Reinstall",
  "plugins.row.reinstallConfirm": "Click again to confirm reinstall",
  "plugins.row.reinstallTip": "Reinstall from catalog",
  "plugins.row.delete": "Delete",
  "plugins.row.deleteConfirm": "Click again to confirm delete",
  "plugins.row.deleteTip": "Delete plugin folder",
  "plugins.row.deleting": "…",
  "plugins.row.disabledBadge": "disabled",
  "plugins.row.updateBadge": "update",
  "plugins.browse.installFromUrl": "Install from URL",
  "plugins.browse.installFromUrlDesc": "Paste a GitHub folder or raw URL to plugin.json / main.js — e.g. https://github.com/Brainrot-Corp/Opencode-GUI/tree/main/default_plugins/tuya-lights-control",
  "plugins.browse.urlPlaceholder": "https://raw.githubusercontent.com/.../plugin.json",
  "plugins.browse.install": "Install",
  "plugins.browse.installing": "Installing…",
  "plugins.browse.filterPlaceholder": "Filter {count} available...",
  "plugins.browse.loading": "Loading catalog…",
  "plugins.browse.noMatch": "No plugins match",
  "plugins.browse.allInstalled": "All available plugins are installed",
  "plugins.browse.noPlugins": "No plugins in catalog",
  "plugins.browse.cached": "Catalog cached for 12h — force refresh to bypass. Sources from github.com/Brainrot-Corp/Opencode-GUI/default_plugins.",
  "plugins.browse.forceRefresh": "force refresh",
  "plugins.foot": "Plugins live in %USERPROFILE%\\.config\\.opencode-gui\\plugins\\ next to themes.json. Toggle disables without deleting — files stay on disk and hot-reload when you enable again. Delete removes the folder permanently.",
  "plugins.version.new": "→ {version}",

};

const fr: Dict = {
  "common.close": "Fermer",
  "common.cancel": "Annuler",
  "common.confirm": "Confirmer",
  "common.keep": "Conserver",
  "common.delete": "Supprimer",
  "common.remove": "Retirer",
  "common.rename": "Renommer",
  "common.duplicate": "Dupliquer",
  "common.copy": "Copier",
  "common.save": "Enregistrer",
  "common.search": "Rechercher",
  "common.filter": "Filtrer",
  "common.refresh": "Actualiser",
  "common.loading": "Chargement…",
  "common.noResults": "Aucun résultat",
  "common.expand": "Déployer",
  "common.collapse": "Réduire",
  "common.yes": "Oui",
  "common.no": "Non",
  "common.back": "Retour",
  "common.next": "Suivant",
  "common.finish": "Terminer",
  "common.skip": "Passer",
  "common.sure": "Sûr ?",
  "common.enabled": "activé",
  "common.disabled": "désactivé",
  "common.error": "Erreur",
  "common.copyPath": "Copier le chemin",
  "common.copyId": "Copier l'ID",
  "common.copyTitle": "Copier le titre",
  "settings.title": "Paramètres",
  "settings.tip.runSetup": "Relancer l'assistant",
  "settings.tip.info": "Voix, commandes & raccourcis",
  "settings.tip.close": "Fermer",
  "settings.language.title": "Langue",
  "settings.language.name": "Langue",
  "settings.language.desc": "Langue de l'interface",
  "settings.appearance.title": "Apparence",
  "settings.appearance.theme.name": "Thème",
  "settings.appearance.theme.desc": "Palette de couleurs de l'interface",
  "settings.appearance.theme.openConfig": "Ouvrir le dossier de configuration",
  "settings.appearance.theme.reset": "Restaurer les thèmes par défaut",
  "settings.appearance.theme.resetConfirm": "Cliquez à nouveau pour réinitialiser",
  "settings.appearance.mode.name": "Mode",
  "settings.appearance.mode.desc": "Variante sombre ou claire du thème",
  "settings.appearance.mode.dark": "Sombre",
  "settings.appearance.mode.light": "Clair",
  "settings.appearance.scale.name": "Échelle de l'interface",
  "settings.appearance.scale.desc": "Niveau de zoom de toute l'interface",
  "settings.project.title": "Projet & Modèles",
  "settings.project.workspace.name": "Espace de travail",
  "settings.project.workspace.home": "Dossier d'accueil (pas d'instantanés Git)",
  "settings.project.workspace.closeAll": "Fermer tous les espaces de travail",
  "settings.project.workspace.browse": "Parcourir…",
  "settings.project.workspace.browseTip": "Ouvrir l'espace de travail (Ctrl+O)",
  "settings.project.secondary.name": "Modèle secondaire",
  "settings.project.secondary.desc": "Modèle économique pour les messages de commit, les débriefs et les résumés longs (plus de 30 mots)",
  "settings.project.commitBody.name": "Corps du commit",
  "settings.project.commitBody.desc": "Les messages de commit IA incluent un corps à puces",
  "settings.window.title": "Fenêtre & Système",
  "settings.window.launch.name": "Lancer au démarrage",
  "settings.window.launch.desc": "Démarrer OpenCode au lancement de Windows",
  "settings.window.alwaysOnTop.name": "Toujours au premier plan",
  "settings.window.alwaysOnTop.desc": "Garder la fenêtre au-dessus des autres",
  "settings.window.keepSize.name": "Conserver la taille",
  "settings.window.keepSize.desc": "Ne pas réinitialiser la taille à la réouverture depuis la barre d'état",
  "settings.window.closeOnX.name": "Le bouton Fermer quitte",
  "settings.window.closeOnX.desc": "Cliquer sur X quitte l'app au lieu de la masquer (maintenir Ctrl pour inverser)",
  "settings.terminal.title": "Terminal",
  "settings.terminal.defaultShell.name": "Shell par défaut",
  "settings.terminal.defaultShell.desc": "Les nouveaux terminaux utilisent ce shell · sélecteur par terminal dans le dock",
  "settings.terminal.detectAgain": "Détecter à nouveau",
  "settings.terminal.detectAgainTip": "Redétecter les shells installés",
  "settings.terminal.customShell.title": "Shell personnalisé",
  "settings.terminal.customShell.desc": "Ajoutez tout exécutable sur le PATH ou un chemin absolu · affiché dans les deux sélecteurs",
  "settings.terminal.customShell.namePlaceholder": "Nom (ex. Nushell)",
  "settings.terminal.customShell.pathPlaceholder": "Chemin (C:\\tools\\nu.exe ou nu)",
  "settings.terminal.customShell.argsPlaceholder": "Arguments (optionnel)",
  "settings.terminal.customShell.add": "Ajouter",
  "settings.terminal.customShell.removeTip": "Supprimer le shell personnalisé",
  "settings.terminal.noShells": "Aucun shell détecté — vérifiez WSL / Windows Terminal",
  "settings.voice.title": "Voix & Son",
  "settings.voice.voiceSpeech.name": "Voix & parole",
  "settings.voice.voiceSpeech.desc": "Moteur vocal, sensibilité du micro, voix neuronales & réponses parlées",
  "settings.voice.voiceSpeech.open": "Ouvrir",
  "settings.voice.voiceSpeech.openTip": "Ouvrir les paramètres vocaux",
  "settings.updates.title": "Mises à jour",
  "settings.updates.name": "Mises à jour",
  "settings.updates.checking": "Recherche de mises à jour…",
  "settings.updates.upToDate": "Vous êtes à jour · v{version}",
  "settings.updates.available": "Version {version} disponible · {notes}",
  "settings.updates.check": "Vérifier",
  "settings.updates.updateAndRestart": "Mettre à jour & redémarrer",
  "settings.updates.downloading": "Téléchargement…",
  "settings.updates.notifications.name": "Notifications de mise à jour",
  "settings.updates.notifications.desc": "Afficher une invite au lancement quand une nouvelle version est disponible",
  "settings.updates.debugLocal.title": "Build local de debug",
  "settings.updates.debugLocal.desc": "Dossier contenant opencode-gui.exe — le prépare et redémarre (test sans GitHub)",
  "settings.updates.debugLocal.placeholder": "C:\\chemin\\vers\\dossier",
  "settings.updates.debugLocal.useLocal": "Utiliser local",
  "settings.updates.debugLocal.useLocalTip": "Préparer l'exe local et redémarrer",
  "settings.danger.title": "Zone dangereuse",
  "settings.danger.clean.name": "Nettoyer l'état",
  "settings.danger.clean.desc": "Désinstaller tous les moteurs/voix et réinitialiser toutes les préférences — prochain lancement relance l'assistant",
  "settings.danger.clean.reset": "Réinitialiser",
  "settings.danger.clean.confirm": "Vraiment ? Cliquez à nouveau",
  "sidebar.tip.show": "Afficher l'historique",
  "sidebar.tip.hide": "Masquer le panneau",
  "sidebar.tabs.chats": "Discussions",
  "sidebar.tabs.files": "Fichiers",
  "sidebar.attention.badge": "{count} session{plural} nécessite{plural2} votre attention — cliquez pour afficher",
  "sidebar.session.rename": "Renommer",
  "sidebar.session.duplicate": "Dupliquer",
  "sidebar.session.pin": "Épingler",
  "sidebar.session.unpin": "Désépingler",
  "sidebar.session.copyId": "Copier l'ID",
  "sidebar.session.copyTitle": "Copier le titre",
  "sidebar.session.share": "Partager (copier le lien)",
  "sidebar.session.close": "Fermer",
  "titlebar.agents": "Agents",
  "titlebar.agentsTip": "Agents ({hotkey})",
  "titlebar.plugins.update": "Plugins — mises à jour disponibles",
  "titlebar.plugins.default": "Plugins",
  "titlebar.debriefing": "Débrief en cours — préparation du résumé",
  "titlebar.debriefingLabel": "Débrief",
  "titlebar.speaking": "En cours de parole",
  "titlebar.speakingTip": "Arrêter la parole",
  "titlebar.notSpeakingTip": "Pas en parole",
  "titlebar.notSpeakingLabel": "Silence",
  "titlebar.settingsTip": "Paramètres",
  "titlebar.pinOn": "Détacher (toujours au-dessus)",
  "titlebar.pinOff": "Épingler (toujours au-dessus)",
  "titlebar.minimize": "Réduire",
  "titlebar.maximize": "Agrandir / restaurer",
  "titlebar.close.quit": "Quitter OpenCode (Ctrl : masquer)",
  "titlebar.close.hide": "Masquer dans la barre (Ctrl : quitter)",
  "composer.placeholder.needsModel": "Choisissez un modèle ci-dessus pour discuter",
  "composer.placeholder.busy": "En attente de réponse…",
  "composer.placeholder.idle": "Demandez ce que vous voulez (Entrée pour envoyer, Maj+Entrée pour nouvelle ligne)",
  "composer.stop.tip": "Arrêter la génération",
  "composer.stop.armed": "Appuyez à nouveau sur Échap pour arrêter",
  "composer.send.tip": "Envoyer · Entrée",
  "git.noRepo": "Aucun dépôt git",
  "git.commit.staged": "Commit Staged",
  "git.commit.all": "Commit All",
  "git.commit.stagedPush": "Commit Staged + Push",
  "git.commit.allPush": "Commit All + Push",
  "git.commit.stagedSync": "Commit Staged + Sync",
  "git.commit.allSync": "Commit All + Sync",
  "git.tabs.hidden": "+{count} non-dépôt masqué",
  "git.loading": "Chargement du statut git…",
  "chat.emptyNoSession": "Sélectionnez ou créez une session\npour commencer.",
  "chat.rewind.banner": "Visualisation d'une version antérieure de la conversation.",
  "chat.rewind.undo": "Annuler le retour",
  "chat.closeConfirm": "Appuyez à nouveau sur Ctrl+W pour fermer cette session",
  "chat.closeWorkspaceConfirm": "Appuyez à nouveau sur Ctrl+Maj+W pour fermer cet espace de travail",
  "permission.title": "Permission requise · {type}",
  "permission.allowOnce": "Autoriser une fois",
  "permission.alwaysAllow": "Toujours autoriser",
  "permission.deny": "Refuser",
  "question.title": "Question IA",
  "question.other": "Autre…",
  "question.answer": "Répondre",
  "question.dismiss": "Rejeter",
  "question.hint.instant": "↑↓ · Entrée sélectionner · Échap rejeter",
  "question.hint.multi": "↑↓ · Entrée répondre · Échap rejeter",
  "browser.back": "Retour (souris 4)",
  "browser.forward": "Avancer (souris 5)",
  "browser.reload": "Recharger",
  "browser.urlPlaceholder": "Rechercher ou saisir une URL",
  "browser.openExternal": "Ouvrir dans le navigateur système",
  "browser.return": "Retour à OpenCode",
  "fileTree.find.placeholder": "Rechercher un fichier",
  "fileTree.find.close": "Fermer (Échap)",
  "fileTree.newFile": "Nouveau fichier",
  "fileTree.newFolder": "Nouveau dossier",
  "fileTree.refresh": "Actualiser",
  "fileTree.copyWorkspacePath": "Copier le chemin de l'espace",
  "fileTree.open": "Ouvrir",
  "fileTree.openWithDefault": "Ouvrir avec l'app par défaut",
  "fileTree.copyPath": "Copier le chemin",
  "fileTree.copyRelative": "Copier le chemin relatif",
  "fileTree.copyContent": "Copier le contenu",
  "fileTree.duplicate": "Dupliquer",
  "fileTree.rename": "Renommer",
  "fileTree.deleteFile": "Supprimer le fichier",
  "fileTree.deleteFolder": "Supprimer le dossier",
  "fileTree.setAsWorkspace": "Définir comme espace de travail",
  "fileTree.error.setWorkspace": "Déjà un espace de travail ou dossier invalide",
  "plugins.title": "Plugins",
  "plugins.tabs.installed": "Installés ({count})",
  "plugins.tabs.browse": "Parcourir",
  "plugins.openFolder": "Ouvrir le dossier",
  "plugins.openFolderTip": "Ouvrir le dossier des plugins",
  "plugins.updates.checking": "Vérification des mises à jour…",
  "plugins.updates.available": "{count} mise{plural} disponible{plural}",
  "plugins.updates.upToDate": "Tous les plugins sont à jour",
  "plugins.updates.checkingCatalog": "Vérification du catalogue…",
  "plugins.updateAll": "Tout mettre à jour",
  "plugins.autoUpdate": "Mise à jour auto",
  "plugins.autoUpdateTip": "Activé, les plugins se mettent à jour dès qu'une nouvelle version est trouvée",
  "plugins.refresh": "Actualiser",
  "plugins.refreshTip": "Forcer l'actualisation du catalogue (contourne le cache 12h)",
  "plugins.empty.title": "Aucun plugin installé",
  "plugins.empty.desc": "Déposez un dossier avec plugin.json + main.js dans le dossier plugins ou parcourez le catalogue.",
  "plugins.empty.openFolder": "Ouvrir le dossier des plugins",
  "plugins.empty.browse": "Parcourir le catalogue",
  "plugins.list.noPlugins": "Aucun plugin trouvé — vérifiez la connexion et réessayez",
  "plugins.row.update": "Mettre à jour",
  "plugins.row.updating": "Mise à jour…",
  "plugins.row.updateTip": "Mettre à jour {id} {from} → {to}",
  "plugins.row.disableTip": "Désactiver le plugin",
  "plugins.row.enableTip": "Activer le plugin",
  "plugins.row.settings": "Paramètres",
  "plugins.row.settingsDisabled": "Activer pour configurer",
  "plugins.row.reinstall": "Réinstaller",
  "plugins.row.reinstallConfirm": "Cliquez à nouveau pour confirmer",
  "plugins.row.reinstallTip": "Réinstaller depuis le catalogue",
  "plugins.row.delete": "Supprimer",
  "plugins.row.deleteConfirm": "Cliquez à nouveau pour confirmer",
  "plugins.row.deleteTip": "Supprimer le dossier du plugin",
  "plugins.row.deleting": "…",
  "plugins.row.disabledBadge": "désactivé",
  "plugins.row.updateBadge": "mise à jour",
  "plugins.browse.installFromUrl": "Installer depuis une URL",
  "plugins.browse.installFromUrlDesc": "Collez un dossier GitHub ou une URL brute vers plugin.json / main.js — ex. https://github.com/Brainrot-Corp/Opencode-GUI/tree/main/default_plugins/tuya-lights-control",
  "plugins.browse.urlPlaceholder": "https://raw.githubusercontent.com/.../plugin.json",
  "plugins.browse.install": "Installer",
  "plugins.browse.installing": "Installation…",
  "plugins.browse.filterPlaceholder": "Filtrer {count} disponibles...",
  "plugins.browse.loading": "Chargement du catalogue…",
  "plugins.browse.noMatch": "Aucun plugin correspondant",
  "plugins.browse.allInstalled": "Tous les plugins disponibles sont installés",
  "plugins.browse.noPlugins": "Aucun plugin dans le catalogue",
  "plugins.browse.cached": "Catalogue en cache 12h — forcez l'actualisation pour contourner. Source : github.com/Brainrot-Corp/Opencode-GUI/default_plugins.",
  "plugins.browse.forceRefresh": "forcer l'actualisation",
  "plugins.foot": "Les plugins vivent dans %USERPROFILE%\\.config\\.opencode-gui\\plugins\\ à côté de themes.json. Le toggle désactive sans supprimer — les fichiers restent et se rechargent à la réactivation. Supprimer retire le dossier définitivement.",
  "plugins.version.new": "→ {version}",
};

const es: Dict = {
  "common.close": "Cerrar",
  "common.cancel": "Cancelar",
  "common.confirm": "Confirmar",
  "common.keep": "Conservar",
  "common.delete": "Eliminar",
  "common.remove": "Quitar",
  "common.rename": "Renombrar",
  "common.duplicate": "Duplicar",
  "common.copy": "Copiar",
  "common.save": "Guardar",
  "common.search": "Buscar",
  "common.filter": "Filtrar",
  "common.refresh": "Actualizar",
  "common.loading": "Cargando…",
  "common.noResults": "Sin resultados",
  "common.expand": "Expandir",
  "common.collapse": "Contraer",
  "common.yes": "Sí",
  "common.no": "No",
  "common.back": "Atrás",
  "common.next": "Siguiente",
  "common.finish": "Finalizar",
  "common.skip": "Omitir",
  "common.sure": "¿Seguro?",
  "common.enabled": "activado",
  "common.disabled": "desactivado",
  "common.error": "Error",
  "common.copyPath": "Copiar ruta",
  "common.copyId": "Copiar ID",
  "common.copyTitle": "Copiar título",
  "settings.title": "Ajustes",
  "settings.tip.runSetup": "Repetir asistente",
  "settings.tip.info": "Voz, comandos y atajos",
  "settings.tip.close": "Cerrar",
  "settings.language.title": "Idioma",
  "settings.language.name": "Idioma",
  "settings.language.desc": "Idioma de la interfaz",
  "settings.appearance.title": "Apariencia",
  "settings.appearance.theme.name": "Tema",
  "settings.appearance.theme.desc": "Paleta de colores de la interfaz",
  "settings.appearance.theme.openConfig": "Abrir carpeta de configuración",
  "settings.appearance.theme.reset": "Restablecer temas por defecto",
  "settings.appearance.theme.resetConfirm": "Pulsa de nuevo para restablecer",
  "settings.appearance.mode.name": "Modo",
  "settings.appearance.mode.desc": "Variante oscura o clara del tema",
  "settings.appearance.mode.dark": "Oscuro",
  "settings.appearance.mode.light": "Claro",
  "settings.appearance.scale.name": "Escala de interfaz",
  "settings.appearance.scale.desc": "Nivel de zoom de toda la interfaz",
  "settings.project.title": "Proyecto & Modelos",
  "settings.project.workspace.name": "Espacio de trabajo",
  "settings.project.workspace.home": "Carpeta de inicio (sin instantáneas Git)",
  "settings.project.workspace.closeAll": "Cerrar todos los espacios de trabajo",
  "settings.project.workspace.browse": "Examinar…",
  "settings.project.workspace.browseTip": "Abrir espacio de trabajo (Ctrl+O)",
  "settings.project.secondary.name": "Modelo secundario",
  "settings.project.secondary.desc": "Modelo barato para mensajes de commit, informes y resúmenes largos (más de 30 palabras)",
  "settings.project.commitBody.name": "Cuerpo del commit",
  "settings.project.commitBody.desc": "Los mensajes de commit con IA incluyen cuerpo con viñetas",
  "settings.window.title": "Ventana y Sistema",
  "settings.window.launch.name": "Iniciar al arrancar",
  "settings.window.launch.desc": "Abrir OpenCode al iniciar Windows",
  "settings.window.alwaysOnTop.name": "Siempre encima",
  "settings.window.alwaysOnTop.desc": "Mantener la ventana por encima de las demás",
  "settings.window.keepSize.name": "Conservar tamaño",
  "settings.window.keepSize.desc": "No restablecer el tamaño al reabrir desde la bandeja",
  "settings.window.closeOnX.name": "El botón Cerrar sale",
  "settings.window.closeOnX.desc": "Pulsar X sale de la app en vez de ocultar en bandeja (mantén Ctrl para invertir)",
  "settings.terminal.title": "Terminal",
  "settings.terminal.defaultShell.name": "Shell por defecto",
  "settings.terminal.defaultShell.desc": "Los nuevos terminales usan este shell · selector por terminal en el dock",
  "settings.terminal.detectAgain": "Detectar de nuevo",
  "settings.terminal.detectAgainTip": "Volver a detectar shells instalados",
  "settings.terminal.customShell.title": "Shell personalizado",
  "settings.terminal.customShell.desc": "Añade cualquier ejecutable en el PATH o ruta absoluta · aparece en ambos selectores",
  "settings.terminal.customShell.namePlaceholder": "Nombre (ej. Nushell)",
  "settings.terminal.customShell.pathPlaceholder": "Ruta (C:\\tools\\nu.exe o nu)",
  "settings.terminal.customShell.argsPlaceholder": "Argumentos (opcional)",
  "settings.terminal.customShell.add": "Añadir",
  "settings.terminal.customShell.removeTip": "Eliminar shell personalizado",
  "settings.terminal.noShells": "No se detectaron shells — revisa WSL / Windows Terminal",
  "settings.voice.title": "Voz y Sonido",
  "settings.voice.voiceSpeech.name": "Voz y habla",
  "settings.voice.voiceSpeech.desc": "Motor de voz, sensibilidad del micrófono, voces neuronales y respuestas habladas",
  "settings.voice.voiceSpeech.open": "Abrir",
  "settings.voice.voiceSpeech.openTip": "Abrir ajustes de voz",
  "settings.updates.title": "Actualizaciones",
  "settings.updates.name": "Actualizaciones",
  "settings.updates.checking": "Buscando actualizaciones…",
  "settings.updates.upToDate": "Estás al día · v{version}",
  "settings.updates.available": "Versión {version} disponible · {notes}",
  "settings.updates.check": "Comprobar",
  "settings.updates.updateAndRestart": "Actualizar y reiniciar",
  "settings.updates.downloading": "Descargando…",
  "settings.updates.notifications.name": "Notificaciones de actualización",
  "settings.updates.notifications.desc": "Mostrar aviso al iniciar cuando haya una nueva versión",
  "settings.updates.debugLocal.title": "Build local de depuración",
  "settings.updates.debugLocal.desc": "Carpeta con opencode-gui.exe — la prepara y reinicia (prueba sin GitHub)",
  "settings.updates.debugLocal.placeholder": "C:\\ruta\\a\\carpeta",
  "settings.updates.debugLocal.useLocal": "Usar local",
  "settings.updates.debugLocal.useLocalTip": "Preparar exe local y reiniciar",
  "settings.danger.title": "Zona de peligro",
  "settings.danger.clean.name": "Limpiar estado",
  "settings.danger.clean.desc": "Desinstalar todos los motores/voces y restablecer preferencias — el próximo inicio relanza el asistente",
  "settings.danger.clean.reset": "Restablecer",
  "settings.danger.clean.confirm": "¿Seguro? Pulsa de nuevo",
  "sidebar.tip.show": "Mostrar historial",
  "sidebar.tip.hide": "Ocultar panel",
  "sidebar.tabs.chats": "Chats",
  "sidebar.tabs.files": "Archivos",
  "sidebar.attention.badge": "{count} sesión{plural} necesita{plural2} tu atención — clic para mostrar",
  "sidebar.session.rename": "Renombrar",
  "sidebar.session.duplicate": "Duplicar",
  "sidebar.session.pin": "Fijar",
  "sidebar.session.unpin": "Desfijar",
  "sidebar.session.copyId": "Copiar ID",
  "sidebar.session.copyTitle": "Copiar título",
  "sidebar.session.share": "Compartir (copiar enlace)",
  "sidebar.session.close": "Cerrar",
  "titlebar.agents": "Agentes",
  "titlebar.agentsTip": "Agentes ({hotkey})",
  "titlebar.plugins.update": "Plugins — actualizaciones disponibles",
  "titlebar.plugins.default": "Plugins",
  "titlebar.debriefing": "Informe en curso — preparando resumen",
  "titlebar.debriefingLabel": "Informe",
  "titlebar.speaking": "Hablando",
  "titlebar.speakingTip": "Detener voz",
  "titlebar.notSpeakingTip": "Sin voz",
  "titlebar.notSpeakingLabel": "En silencio",
  "titlebar.settingsTip": "Ajustes",
  "titlebar.pinOn": "Desfijar (siempre encima)",
  "titlebar.pinOff": "Fijar arriba (siempre encima)",
  "titlebar.minimize": "Minimizar",
  "titlebar.maximize": "Maximizar / restaurar",
  "titlebar.close.quit": "Salir de OpenCode (Ctrl: ocultar)",
  "titlebar.close.hide": "Ocultar en bandeja (Ctrl: salir)",
  "composer.placeholder.needsModel": "Elige un modelo arriba para chatear",
  "composer.placeholder.busy": "Esperando respuesta…",
  "composer.placeholder.idle": "Pregunta lo que quieras (Enter para enviar, Mayús+Enter para nueva línea)",
  "composer.stop.tip": "Detener generación",
  "composer.stop.armed": "Pulsa Esc de nuevo para detener",
  "composer.send.tip": "Enviar · Enter",
  "git.noRepo": "Sin repositorio git",
  "git.commit.staged": "Commit Staged",
  "git.commit.all": "Commit All",
  "git.commit.stagedPush": "Commit Staged + Push",
  "git.commit.allPush": "Commit All + Push",
  "git.commit.stagedSync": "Commit Staged + Sync",
  "git.commit.allSync": "Commit All + Sync",
  "git.tabs.hidden": "+{count} no-repo oculto",
  "git.loading": "Cargando estado git…",
  "chat.emptyNoSession": "Selecciona o crea una sesión\npara empezar.",
  "chat.rewind.banner": "Viendo una versión anterior de la conversación.",
  "chat.rewind.undo": "Deshacer retroceso",
  "chat.closeConfirm": "Pulsa Ctrl+W de nuevo para cerrar esta sesión",
  "chat.closeWorkspaceConfirm": "Pulsa Ctrl+Mayús+W de nuevo para cerrar este espacio de trabajo",
  "permission.title": "Permiso requerido · {type}",
  "permission.allowOnce": "Permitir una vez",
  "permission.alwaysAllow": "Permitir siempre",
  "permission.deny": "Denegar",
  "question.title": "Pregunta IA",
  "question.other": "Otro…",
  "question.answer": "Responder",
  "question.dismiss": "Descartar",
  "question.hint.instant": "↑↓ · Enter seleccionar · Esc descartar",
  "question.hint.multi": "↑↓ · Enter responder · Esc descartar",
  "browser.back": "Atrás (ratón 4)",
  "browser.forward": "Adelante (ratón 5)",
  "browser.reload": "Recargar",
  "browser.urlPlaceholder": "Buscar o escribir URL",
  "browser.openExternal": "Abrir en navegador del sistema",
  "browser.return": "Volver a OpenCode",
  "fileTree.find.placeholder": "Buscar archivo",
  "fileTree.find.close": "Cerrar (Esc)",
  "fileTree.newFile": "Nuevo archivo",
  "fileTree.newFolder": "Nueva carpeta",
  "fileTree.refresh": "Actualizar",
  "fileTree.copyWorkspacePath": "Copiar ruta del espacio",
  "fileTree.open": "Abrir",
  "fileTree.openWithDefault": "Abrir con app por defecto",
  "fileTree.copyPath": "Copiar ruta",
  "fileTree.copyRelative": "Copiar ruta relativa",
  "fileTree.copyContent": "Copiar contenido",
  "fileTree.duplicate": "Duplicar",
  "fileTree.rename": "Renombrar",
  "fileTree.deleteFile": "Eliminar archivo",
  "fileTree.deleteFolder": "Eliminar carpeta",
  "fileTree.setAsWorkspace": "Usar como espacio de trabajo",
  "fileTree.error.setWorkspace": "Ya es un espacio de trabajo o carpeta no válida",
  "plugins.title": "Plugins",
  "plugins.tabs.installed": "Instalados ({count})",
  "plugins.tabs.browse": "Explorar",
  "plugins.openFolder": "Abrir carpeta",
  "plugins.openFolderTip": "Abrir carpeta de plugins",
  "plugins.updates.checking": "Buscando actualizaciones…",
  "plugins.updates.available": "{count} actualización{plural} disponible{plural}",
  "plugins.updates.upToDate": "Todos los plugins al día",
  "plugins.updates.checkingCatalog": "Comprobando catálogo…",
  "plugins.updateAll": "Actualizar todo",
  "plugins.autoUpdate": "Auto-actualizar",
  "plugins.autoUpdateTip": "Activado, los plugins se actualizan en cuanto se encuentra una nueva versión",
  "plugins.refresh": "Actualizar",
  "plugins.refreshTip": "Forzar actualización del catálogo (evita caché 12h)",
  "plugins.empty.title": "Ningún plugin instalado",
  "plugins.empty.desc": "Suelta una carpeta con plugin.json + main.js en la carpeta de plugins o explora el catálogo.",
  "plugins.empty.openFolder": "Abrir carpeta de plugins",
  "plugins.empty.browse": "Explorar catálogo",
  "plugins.list.noPlugins": "Ningún plugin encontrado — revisa conexión y reintenta",
  "plugins.row.update": "Actualizar",
  "plugins.row.updating": "Actualizando…",
  "plugins.row.updateTip": "Actualizar {id} {from} → {to}",
  "plugins.row.disableTip": "Desactivar plugin",
  "plugins.row.enableTip": "Activar plugin",
  "plugins.row.settings": "Ajustes",
  "plugins.row.settingsDisabled": "Activar para configurar",
  "plugins.row.reinstall": "Reinstalar",
  "plugins.row.reinstallConfirm": "Pulsa de nuevo para confirmar",
  "plugins.row.reinstallTip": "Reinstalar desde catálogo",
  "plugins.row.delete": "Eliminar",
  "plugins.row.deleteConfirm": "Pulsa de nuevo para confirmar",
  "plugins.row.deleteTip": "Eliminar carpeta del plugin",
  "plugins.row.deleting": "…",
  "plugins.row.disabledBadge": "desactivado",
  "plugins.row.updateBadge": "actualización",
  "plugins.browse.installFromUrl": "Instalar desde URL",
  "plugins.browse.installFromUrlDesc": "Pega una carpeta GitHub o URL cruda a plugin.json / main.js — ej. https://github.com/Brainrot-Corp/Opencode-GUI/tree/main/default_plugins/tuya-lights-control",
  "plugins.browse.urlPlaceholder": "https://raw.githubusercontent.com/.../plugin.json",
  "plugins.browse.install": "Instalar",
  "plugins.browse.installing": "Instalando…",
  "plugins.browse.filterPlaceholder": "Filtrar {count} disponibles...",
  "plugins.browse.loading": "Cargando catálogo…",
  "plugins.browse.noMatch": "Ningún plugin coincide",
  "plugins.browse.allInstalled": "Todos los plugins disponibles están instalados",
  "plugins.browse.noPlugins": "Ningún plugin en el catálogo",
  "plugins.browse.cached": "Catálogo en caché 12h — fuerza actualización para evitar. Fuente: github.com/Brainrot-Corp/Opencode-GUI/default_plugins.",
  "plugins.browse.forceRefresh": "forzar actualización",
  "plugins.foot": "Los plugins viven en %USERPROFILE%\\.config\\.opencode-gui\\plugins\\ junto a themes.json. El toggle desactiva sin borrar — los archivos quedan y se recargan al reactivar. Eliminar quita la carpeta definitivamente.",
  "plugins.version.new": "→ {version}",
};

export const bundles: Record<Lang, Dict> = { en, fr, es };

// plugin bundles: Map<pluginId, Partial<Record<Lang, Dict>>>
const pluginBundles = new Map<string, Partial<Record<Lang, Dict>>>();

export function registerPluginTranslations(pluginId: string, dict: Partial<Record<Lang, Dict>>) {
  if (!pluginId || !dict || typeof dict !== "object") return;
  const cur = pluginBundles.get(pluginId) ?? {};
  for (const lang of Object.keys(dict) as Lang[]) {
    if (!isLang(lang)) continue;
    const incoming = dict[lang];
    if (!incoming || typeof incoming !== "object") continue;
    // sanitize keys/values: strings only, cap size
    const sanitized: Dict = {};
    for (const [k, v] of Object.entries(incoming)) {
      if (typeof k !== "string" || typeof v !== "string") continue;
      if (!k || k.length > 200 || v.length > 2000) continue;
      sanitized[k] = v;
    }
    cur[lang] = { ...(cur[lang] ?? {}), ...sanitized };
  }
  pluginBundles.set(pluginId, cur);
  // notify React
  try { window.dispatchEvent(new CustomEvent("oc:language-changed", { detail: getLang() })); } catch {}
}

// lookup with plugin overlay + interpolation
export function translate(lang: Lang, key: string, params?: Record<string, string | number>): string {
  const l = isLang(lang) ? lang : DEFAULT_LANG;
  // 1) plugin bundles (check exact key, then dot-prefixed fallback)
  // plugins register flat keys; we check all plugins for key match — last registered wins
  // For namespaced keys like "tuya.key", plugins own that namespace.
  for (const [, bundle] of pluginBundles) {
    const dict = bundle[l] ?? bundle.en;
    if (dict && key in dict) {
      let val = dict[key]!;
      if (params) for (const [k, v] of Object.entries(params)) val = val.split(`{${k}}`).join(String(v));
      return val;
    }
  }
  // also check plugin bundles with pluginId prefix: key may be "myplugin.title"
  // if key contains dot, try suffix after first dot against plugin bundles
  if (key.includes(".")) {
    const dot = key.indexOf(".");
    const pluginId = key.slice(0, dot);
    const sub = key.slice(dot + 1);
    const pb = pluginBundles.get(pluginId);
    if (pb) {
      const d = pb[l] ?? pb.en;
      if (d && sub in d) {
        let val = d[sub]!;
        if (params) for (const [k, v] of Object.entries(params)) val = val.split(`{${k}}`).join(String(v));
        return val;
      }
    }
  }

  // 2) core bundles
  let val = bundles[l]?.[key] ?? bundles.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) val = val.split(`{${k}}`).join(String(v));
  }
  return val;
}

// convenience global t (reads current lang)
export function t(key: string, params?: Record<string, string | number>): string {
  return translate(getLang(), key, params);
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from "react";

export function useTranslation() {
  const [lang, setLangState] = useState<Lang>(() => getLang());
  useEffect(() => {
    const handler = () => setLangState(getLang());
    window.addEventListener("storage", handler);
    window.addEventListener("oc:language-changed", handler as EventListener);
    window.addEventListener("oc:workspaces-changed", handler as any);
    // also listen for direct settings change without language event
    const iv = window.setInterval(handler, 1000);
    return () => {
      window.removeEventListener("storage", handler);
      window.removeEventListener("oc:language-changed", handler as EventListener);
      window.removeEventListener("oc:workspaces-changed", handler as any);
      clearInterval(iv);
    };
  }, []);
  const tr = useCallback((key: string, params?: Record<string, string | number>) => translate(lang, key, params), [lang]);
  const set = useCallback((l: Lang) => {
    setLang(l);
    setLangState(l);
  }, []);
  return { lang, t: tr, setLang: set, trans: tr };
}

export function useT() { return useTranslation().t; }

// helpers for non-React plugin usage: bound t per plugin
export function createPluginT(pluginId: string) {
  return (key: string, params?: Record<string, string | number>) => {
    const lang = getLang();
    // try plugin namespace first
    const pb = pluginBundles.get(pluginId);
    if (pb) {
      const d = pb[lang] ?? pb.en;
      if (d && key in d) {
        let val = d[key]!;
        if (params) for (const [k, v] of Object.entries(params)) val = val.split(`{${k}}`).join(String(v));
        return val;
      }
    }
    // fallback to global with prefix: "pluginId.key"
    const prefixed = `${pluginId}.${key}`;
    const g = translate(lang, prefixed, params);
    if (g !== prefixed) return g;
    // final fallback: global key as-is
    return translate(lang, key, params);
  };
}
