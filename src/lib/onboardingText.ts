// Wizard copy in a handful of languages, picked from the OS locale with an
// English fallback. Kept as one flat record per language so adding a language
// is one block — TypeScript flags any missing key against `en`.
export type ObCopy = {
  title: string;
  steps: [string, string, string, string];
  hello: string;
  body: string;
  hotkeys: string;
  lookTitle: string;
  lookDesc: string;
  themeDesc: string;
  modeDesc: string;
  systemTitle: string;
  systemDesc: string;
  startupName: string;
  startupDesc: string;
  scaleName: string;
  scaleDesc: string;
  secondaryName: string;
  secondaryDesc: string;
  loadingModels: string;
  voiceTitle: string;
  voiceDesc: string;
  handsFreeName: string;
  handsFreeDesc: string;
  multiName: string;
  multiDesc: string;
  speakName: string;
  speakDesc: string;
  needModel: string;
  needVoice: string;
  recoButton: string;
  recoBusy: string;
  recoDone: string;
  recoNote: string;
  back: string;
  next: string;
  finish: string;
  skip: string;
};

const en: ObCopy = {
  title: "Welcome",
  steps: ["Hello", "Look", "System", "Voice"],
  hello: "Hi! A few quick picks and you're ready to go.",
  body: "Everything here can be changed later in Settings.",
  hotkeys: "Alt+Space toggles the window anywhere · Ctrl+M mic · Ctrl+/ settings",
  lookTitle: "Make it yours",
  lookDesc: "Pick a color scheme — themes live in ~/.config/.opencode-gui/themes.json and hot-reload.",
  themeDesc: "Interface color scheme",
  modeDesc: "Dark or light variant of the theme",
  systemTitle: "How it behaves",
  systemDesc: "Window habits — all optional.",
  startupName: "Launch on startup",
  startupDesc: "Start OpenCode when Windows boots",
  scaleName: "UI scale",
  scaleDesc: "Zoom level of the whole interface",
  secondaryName: "Secondary model",
  secondaryDesc: "Cheap model for commit messages, debriefs & long-answer summaries",
  loadingModels: "loading models…",
  voiceTitle: "Voice & speech",
  voiceDesc:
    "Everything runs locally on your machine — speech is recognized and spoken offline once the models are downloaded. All features start off; flip what you want.",
  handsFreeName: "Hands-free dictation",
  handsFreeDesc:
    'Mic stays live and listens for commands — say "prompt …" to fill the composer, "send …" to fill and send at once',
  multiName: "Multilingual commands",
  multiDesc:
    "No English match? Re-runs the utterance through whisper's translate task before giving up to dictation",
  speakName: "Speak replies",
  speakDesc:
    "Read assistant answers aloud in a neural voice (code skipped) — needs the Secondary model and a downloaded voice",
  needModel: "Pick a Secondary model first",
  needVoice: "Download a voice first — run the recommended setup below",
  recoButton: "Recommended setup",
  recoBusy: "Downloading… keep this window open",
  recoDone: "All set — try saying something!",
  recoNote: "Recommended by the developers",
  back: "Back",
  next: "Next",
  finish: "Finish",
  skip: "Skip setup",
};

const de: ObCopy = {
  ...en,
  title: "Willkommen",
  steps: ["Hallo", "Aussehen", "System", "Sprache"],
  hello: "Hallo! Ein paar schnelle Auswahlen und du bist bereit.",
  body: "Alles hier lässt sich später in den Einstellungen ändern.",
  hotkeys: "Alt+Space blendet das Fenster ein/aus · Strg+M Mikrofon · Strg+/ Einstellungen",
  lookTitle: "Mach es zu deinem",
  lookDesc:
    "Wähle ein Farbschema — Themes liegen in ~/.config/.opencode-gui/themes.json und laden sofort neu.",
  themeDesc: "Farbschema der Oberfläche",
  modeDesc: "Dunkle oder helle Variante des Themas",
  systemTitle: "Wie es sich verhält",
  systemDesc: "Fensterverhalten — alles optional.",
  startupName: "Beim Start ausführen",
  startupDesc: "OpenCode beim Windows-Start starten",
  scaleName: "UI-Skalierung",
  scaleDesc: "Zoomstufe der gesamten Oberfläche",
  secondaryName: "Sekundärmodell",
  secondaryDesc:
    "Günstiges Modell für Commit-Messages, Debriefs & Zusammenfassungen langer Antworten",
  loadingModels: "Modelle werden geladen…",
  voiceTitle: "Sprache & Stimme",
  voiceDesc:
    "Läuft komplett lokal auf deinem Rechner — Spracherkennung und Ausgabe funktionieren offline, sobald die Modelle geladen sind. Alles startet aus; schalte ein, was du willst.",
  handsFreeName: "Freihändiges Diktieren",
  handsFreeDesc:
    'Das Mikrofon bleibt aktiv und lauscht auf Befehle — sag „Prompt …" zum Ausfüllen, „Senden …" zum Sofort-Absenden',
  multiName: "Mehrsprachige Befehle",
  multiDesc:
    "Kein englischer Treffer? Die Äußerung wird zusätzlich durch whispers Übersetzung geschickt, bevor sie zum Diktat wird",
  speakName: "Antworten vorlesen",
  speakDesc:
    "Liest Antworten mit einer neuronalen Stimme vor (Code ausgenommen) — benötigt das Sekundärmodell und eine heruntergeladene Stimme",
  needModel: "Zuerst ein Sekundärmodell wählen",
  needVoice: "Zuerst eine Stimme laden — unten die empfohlene Einrichtung starten",
  recoButton: "Empfohlene Einrichtung",
  recoBusy: "Wird geladen… Fenster offen lassen",
  recoDone: "Alles bereit — sag einfach etwas!",
  recoNote: "Von den Entwicklern empfohlen",
  back: "Zurück",
  next: "Weiter",
  finish: "Fertig",
  skip: "Überspringen",
};

const fr: ObCopy = {
  ...en,
  title: "Bienvenue",
  steps: ["Bonjour", "Apparence", "Système", "Voix"],
  hello: "Salut ! Quelques choix rapides et vous êtes prêt.",
  body: "Tout est modifiable plus tard dans les paramètres.",
  hotkeys: "Alt+Espace affiche/cache la fenêtre · Ctrl+M micro · Ctrl+/ réglages",
  lookTitle: "Personnalisez-le",
  lookDesc:
    "Choisissez une palette — les thèmes vivent dans ~/.config/.opencode-gui/themes.json et se rechargent à chaud.",
  themeDesc: "Palette de couleurs de l'interface",
  modeDesc: "Variante sombre ou claire du thème",
  systemTitle: "Comportement",
  systemDesc: "Habitudes de fenêtre — tout est optionnel.",
  startupName: "Lancer au démarrage",
  startupDesc: "Démarrer OpenCode avec Windows",
  scaleName: "Échelle de l'interface",
  scaleDesc: "Niveau de zoom de toute l'interface",
  secondaryName: "Modèle secondaire",
  secondaryDesc:
    "Modèle économique pour les messages de commit, debriefs et résumés des longues réponses",
  loadingModels: "chargement des modèles…",
  voiceTitle: "Voix & parole",
  voiceDesc:
    "Tout tourne en local sur votre machine — reconnaissance et synthèse fonctionnent hors ligne une fois les modèles téléchargés. Tout est désactivé au départ ; activez ce que vous voulez.",
  handsFreeName: "Dictée mains libres",
  handsFreeDesc:
    "Le micro reste actif et écoute les commandes — dites « prompte … » pour remplir le champ, « envoie … » pour envoyer aussitôt",
  multiName: "Commandes multilingues",
  multiDesc:
    "Pas de correspondance en anglais ? L'énoncé repasse par la traduction de whisper avant de devenir dictée",
  speakName: "Lire les réponses",
  speakDesc:
    "Lit les réponses à voix haute avec une voix neuronale (code exclu) — nécessite le modèle secondaire et une voix téléchargée",
  needModel: "Choisissez d'abord un modèle secondaire",
  needVoice: "Téléchargez d'abord une voix — lancez la configuration recommandée ci-dessous",
  recoButton: "Configuration recommandée",
  recoBusy: "Téléchargement… laissez cette fenêtre ouverte",
  recoDone: "Tout est prêt — essayez de parler !",
  recoNote: "Recommandé par les développeurs",
  back: "Retour",
  next: "Suivant",
  finish: "Terminer",
  skip: "Passer",
};

const es: ObCopy = {
  ...en,
  title: "Bienvenido",
  steps: ["Hola", "Apariencia", "Sistema", "Voz"],
  hello: "¡Hola! Unas pocas elecciones rápidas y listo.",
  body: "Todo se puede cambiar después en Ajustes.",
  hotkeys: "Alt+Espacio muestra/oculta la ventana · Ctrl+M micrófono · Ctrl+/ ajustes",
  lookTitle: "Hazlo tuyo",
  lookDesc:
    "Elige una paleta — los temas viven en ~/.config/.opencode-gui/themes.json y se recargan al instante.",
  themeDesc: "Paleta de colores de la interfaz",
  modeDesc: "Variante oscura o clara del tema",
  systemTitle: "Comportamiento",
  systemDesc: "Costumbres de ventana — todo opcional.",
  startupName: "Iniciar con el sistema",
  startupDesc: "Abrir OpenCode al arrancar Windows",
  scaleName: "Escala de la interfaz",
  scaleDesc: "Nivel de zoom de toda la interfaz",
  secondaryName: "Modelo secundario",
  secondaryDesc:
    "Modelo barato para mensajes de commit, informes y resúmenes de respuestas largas",
  loadingModels: "cargando modelos…",
  voiceTitle: "Voz y habla",
  voiceDesc:
    "Todo funciona en local en tu equipo — el reconocimiento y la voz operan sin conexión tras descargar los modelos. Todo empieza apagado; activa lo que quieras.",
  handsFreeName: "Dictado manos libres",
  handsFreeDesc:
    "El micrófono queda activo escuchando órdenes — di «prompt…» para rellenar el compositor, «enviar…» para enviar al instante",
  multiName: "Órdenes multilingües",
  multiDesc:
    "¿Sin coincidencia en inglés? El audio vuelve a pasar por la traducción de whisper antes de dictarse",
  speakName: "Leer respuestas",
  speakDesc:
    "Lee las respuestas en voz alta con voz neuronal (sin código) — necesita el modelo secundario y una voz descargada",
  needModel: "Elige antes un modelo secundario",
  needVoice: "Descarga antes una voz — lanza la configuración recomendada abajo",
  recoButton: "Configuración recomendada",
  recoBusy: "Descargando… deja esta ventana abierta",
  recoDone: "¡Listo — prueba a decir algo!",
  recoNote: "Recomendado por los desarrolladores",
  back: "Atrás",
  next: "Siguiente",
  finish: "Finalizar",
  skip: "Omitir",
};

const zh: ObCopy = {
  ...en,
  title: "欢迎",
  steps: ["你好", "外观", "系统", "语音"],
  hello: "你好！几个快速选择就可以开始使用了。",
  body: "这里的所有内容以后都可以在设置中修改。",
  hotkeys: "Alt+空格 切换窗口 · Ctrl+M 麦克风 · Ctrl+/ 设置",
  lookTitle: "个性化",
  lookDesc:
    "选择配色方案 — 主题位于 ~/.config/.opencode-gui/themes.json，改动即时生效。",
  themeDesc: "界面配色方案",
  modeDesc: "主题的深色或浅色变体",
  systemTitle: "行为习惯",
  systemDesc: "窗口偏好 — 均为可选。",
  startupName: "开机自启",
  startupDesc: "Windows 启动时运行 OpenCode",
  scaleName: "界面缩放",
  scaleDesc: "整个界面的缩放级别",
  secondaryName: "辅助模型",
  secondaryDesc: "用于提交信息、总结与长回答摘要的廉价模型",
  loadingModels: "正在加载模型…",
  voiceTitle: "语音功能",
  voiceDesc:
    "一切都在本机运行 — 模型下载完成后语音识别与合成均可离线使用。所有功能默认关闭；按需开启即可。",
  handsFreeName: "免提听写",
  handsFreeDesc:
    "麦克风保持监听命令状态 — 说“prompt …”填入输入框，“send …”填入并直接发送",
  multiName: "多语言指令",
  multiDesc: "没有匹配到英语？会先经 whisper 翻译重试，再降级为听写",
  speakName: "朗读回复",
  speakDesc: "用神经网络语音读出回答（跳过代码）— 需要辅助模型和已下载的语音",
  needModel: "请先选择辅助模型",
  needVoice: "请先下载语音 — 点击下方的推荐设置",
  recoButton: "推荐设置",
  recoBusy: "下载中… 请保持窗口打开",
  recoDone: "一切就绪 — 说句话试试！",
  recoNote: "开发者推荐",
  back: "上一步",
  next: "下一步",
  finish: "完成",
  skip: "跳过设置",
};

const LANGS: Record<string, ObCopy> = { en, de, fr, es, zh };

// pure resolver — node tests exercise this directly
export function resolveObCopy(tag: string | undefined): ObCopy {
  const base = (tag ?? "").toLowerCase();
  if (base.startsWith("zh")) return LANGS.zh;
  const two = base.slice(0, 2);
  return LANGS[two] ?? LANGS.en!;
}

export function obCopy(): ObCopy {
  return resolveObCopy(typeof navigator === "undefined" ? "en" : navigator.language);
}
