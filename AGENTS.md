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
