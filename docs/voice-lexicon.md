# Voice Lexicon — Implementation Notes

How spoken commands are understood: a **lexicon-driven rewrite layer** turns natural,
multilingual, typo-ridden speech into canonical English vocabulary that a small set of
anchored patterns matches. One trigger concept becomes many accepted phrasings.

Files:

| File | Role |
|---|---|
| `src/lib/voiceLexicon.ts` | rewrites, fillers, typo tolerance |
| `src/lib/voiceRouter.ts` | pattern chain over canonical tokens + embedded scan |
| `src/pages/ChatPage.tsx` | dispatch, confirmation loop (trilingual yes/no) |

## Pipeline

```
whisper transcript
  ↓ normalize            lowercase, strip trailing punctuation, collapse spaces
  ↓ "one hundred" → "hundred"
  ↓ expandVoice()        deaccent → strip politeness → rewrite table
  ↓ matchChain()         direct hit → execute instantly
  ↓ fixTypos() retry     content words 1 edit off get corrected → matchChain again
  ↓ embedded scan        trigger-verb tails → wrapped {embedded} → spoken yes/no
  ↓ null                 ignored (unless it started with prompt/send)
```

## The rewrite table (`RULES` in voiceLexicon.ts)

Ordered `[RegExp, replacement]` pairs. **Order is load-bearing**: multi-word and specific
phrases before single words; the French/Spanish possessive swap before articles/devices.

Concepts covered (each with EN + FR + ES variants):

| Canonical | Variants (examples) |
|---|---|
| turn on / turn off | switch on/off · fire up · power up/down · allume(r) · éteins(dre) · enciende(r) · apaga(r) |
| light(s) / lamp(s) / bulbs | lumière(s) · lampe(s) · luz · luces · bombilla(s) · lamb(s) [typo] |
| colors | rouge/rojo→red · jaune/amarillo→yellow · vert/verde→green · bleu/azul→blue · violet/morado · rose/rosa→pink |
| tones | chaud→warm · froid/fraîche/frío→cool · neutre/neutro→neutral · "lumière du jour"/"luz del día"→daylight |
| numbers | vingt/veinte→twenty … cent/cien→hundred · demi/mitad→half |
| actions | ouvre/lance?→open* · ferme/cierra→close · arrête/detiene→stop · annule/cancela→cancel · exécute/ejecuta→run · efface→clear · borra→erase · mata→kill · minimiza→minimize |
| dictation prefixes | écris/dicte→prompt · envoie/envoyer→send |

\* `lance` intentionally maps to *open* (app launch), not *run*, to avoid ambiguity.

Special mechanics:

- **Deaccent first** (`NFD` strip): JS `\b` treats "é" as a non-word character, so accented
  patterns silently never match. Everything is written unaccented.
- **Possessive swap**: `lampe du bureau` → `bureau lampe`, so the device word lands last where
  the light patterns expect it. Applied before article/device rules.
- **Articles**: la/le/les/el/los/las → the · ma/mon/mes/mi/mis → my.
- **Politeness**: leading "can you / could you / est-ce que / peux-tu / puedes…", trailing
  "please / thanks / merci / gracias / s'il te plaît…" stripped.

## Typo tolerance

On a failed match, tokens ≥4 letters are corrected against a closed vocabulary of *content*
words only — devices, colors, tones (`LEX`). One edit = substitution, insertion/deletion, or
adjacent transposition (`lihgts`→lights). **Action verbs are never corrected** — a misheard
verb must miss, not misfire.

## Embedded command scan

When nothing matches whole-string, each occurrence of a `TRIGGERS` verb starts a candidate
suffix; the first suffix that fully matches the chain wins, returned as
`{type:"embedded", act}`. ChatPage reads the act back via `describeAct()` and waits for a
spoken yes/no (EN/FR/ES). Any other speech or 15 s cancels. If a command executed within the
last 25 s, the confirmation is skipped ("streak").

Sentence-final rule: the suffix must match to the end of the fragment — *"turn the lights off
when you leave"* never fires.

## Ceilings (deliberate)

- Word-order heavy sentences (French post-posed adjectives other than color/tone) don't parse.
- Wake-word-less scanning means chatter containing trigger verbs produces confirmation
  questions; the yes/no gate keeps them harmless but not silent.
- Spoken confirmations/read-backs remain English regardless of command language.
- Whisper mishearing a trigger verb just misses — no fuzzing by design.

## Adding a synonym

One line in `RULES`:

```ts
[/\bhallon?\b/g, "turn on"],   // e.g. a dialect variant
```

If it introduces a new device/color/tone word, also add it to `LEX` so typos resolve.
