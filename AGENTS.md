# Project Rules

## Testing / API usage

- **NEVER test using the user's own API keys or paid quotas** (anything in
  `~/.local/share/opencode/auth.json` or provider keys in config).
- For any live-model test, use free models only:
  1. `opencode/x-preview-f-free` ("0x alpha free") if available, else
  2. Other OpenCode Zen free-tier models (`opencode/nemotron-3.5-lightning-free`,
     `opencode/mimo-v2.5-free`, etc. — check `/config/providers` → `opencode`
     provider for current free list).
- If no free model is available, ask the user before spending anything.

## Design rules (applied — keep new UI consistent)

- **Spacing unit: 6px.** All gaps between panels/elements use it (main padding,
  composer gap, sidebar padding, list rhythm). No ad-hoc margins.
- **Glass material**: translucent `rgba` surfaces + `backdrop-filter: blur(14px)`
  over the OS acrylic/mica layer. Titlebar and session sidebar share identical
  gradient tones (`rgba(20,28,35,.14) → rgba(12,17,22,.22)`); titlebar runs
  horizontally, sidebar vertically, so they match at the corner.
- **Main panels are square and flush**: chat stage + composer have no border
  radius and sit ~6px from window edges.
- **Accent system**: cyan `--accent:#7fd4d4`, glow via `--accent-glow`
  (`0 0 Npx` shadows), danger `--danger:#e08f8f`. Interactive hovers tint with
  accent; destructive hovers tint red.
- **Blocky chrome**: scrollbars square, accent-tinted thumb + glow on hover;
  buttons like the collapse toggle use small radius (4px) with a dim resting
  tint (darker version of their hover background).
- **Icons: Font Awesome only** (`fa-solid`; bundled via npm, imported once).
- **Fonts**: Inter for UI text, JetBrains Mono for chat content / mono labels.
- **Cursors**: native Windows cursors only (`col-resize` etc.), locked on body
  during drags.
- **State persistence** lives in localStorage under `oc.*` keys (`oc.sb.w`,
  `oc.sb.c`, `oc.lastSes`, `oc.lastModel`) and is validated before use.

## Frontend architecture

- Server talk → hooks (`src/hooks/useOpencode.ts`), visuals → components
  (`src/components/`, one CSS file each in `src/styles/`), screens → pages
  (`src/pages/`). See PLAN.md for the full tree.
