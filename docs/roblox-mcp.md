# Roblox Studio MCP — project-local setup

> Global MCP was removed (`~/.config/opencode/opencode.jsonc`) to avoid slowdown/crash in non-Roblox workspaces like `ai assistant`.
> Use this **project-local** config only inside your Roblox place folder.

## 1. Enable Studio side (once)

Studio → Assistant → `…` → Manage MCP Servers → **Enable Studio as MCP server** (green dot = connected).
Keep Studio open with your `.rbxl`/Rojo project when using MCP tools.

## 2. Add to your Roblox project's `opencode.jsonc` (not global)

Create `opencode.jsonc` next to your place file (safe wrapper is global, works from any workspace):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "Roblox_Studio": {
      "type": "local",
      "command": ["cmd.exe", "/c", "%USERPROFILE%\\.config\\opencode\\roblox-mcp-safe.bat"],
      // Guards: timeout prevents hang if Studio not running; enabled:true only in Roblox projects
      "enabled": true,
      "timeout": 5000
    }
  }
}
```

`%USERPROFILE%\.config\opencode\roblox-mcp-safe.bat` is installed globally (copied from `scripts/roblox-mcp-safe.bat` in this repo) — no per-project copy needed.

### Alternatives

- Direct official (no guard for hash changes): `["cmd.exe","/c","%LOCALAPPDATA%\\Roblox\\mcp.bat"]` — has hardcoded `version-xxxx`, breaks after Studio updates.
- Portable copy: copy `scripts/roblox-mcp-safe.bat` into your Roblox project's `scripts/` and use `["cmd.exe","/c","scripts\\roblox-mcp-safe.bat"]` — useful for teams sharing the repo.

`roblox-mcp-safe.bat` guards:
- Scans `Versions/*/StudioMCP.exe` for newest (avoids hardcoded hash)
- Falls back to `reg query HKCU\Software\Roblox\RobloxStudio /v ContentFolder`
- Last resort delegates to `mcp.bat`
- If nothing found, exits `0` with warning on stderr — **opencode does not crash or hang**

## 3. Verify

```ps
opencode mcp list
# should show: ✓ Roblox_Studio connected (when Studio is open & enabled)
# or: disconnected / warning but no crash (when Studio closed — expected)
```

If Studio closed, `opencode run` still works; Roblox tools just return “No instances connected”.

## Why project-local?

Global `mcp` loads for every workspace (including non-Roblox ones) and makes the model eagerly call `list_roblox_studios` on every prompt, adding latency. Keeping it project-local scopes cost to where it’s useful.

See: https://create.roblox.com/docs/studio/mcp
