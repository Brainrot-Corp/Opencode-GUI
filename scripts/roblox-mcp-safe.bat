@echo off
REM roblox-mcp-safe.bat — guarded wrapper for Roblox Studio MCP
REM Guards: dynamic StudioMCP.exe lookup, graceful exit if Studio not installed/running, no crash propagation
REM Use in project-local opencode.jsonc (not global) with timeout guard
setlocal EnableDelayedExpansion

REM ponytail: naive latest-version scan, not registry-only — survives Roblox updates without hardcoded hash

REM 1. Find newest StudioMCP.exe under Versions (most reliable, avoids hardcoded hash in mcp.bat)
set "MCP_EXE="
for /f "delims=" %%F in ('dir /b /s "%LOCALAPPDATA%\Roblox\Versions\StudioMCP.exe" 2^>nul') do set "MCP_EXE=%%F"
if defined MCP_EXE goto :use_found

REM 2. Try registry ContentFolder -> ..\StudioMCP.exe
for /f "tokens=2*" %%A in ('reg query "HKEY_CURRENT_USER\Software\Roblox\RobloxStudio" /v ContentFolder 2^>nul') do set "REG_CONTENT=%%B"
if defined REG_CONTENT (
  if exist "%REG_CONTENT%\..\StudioMCP.exe" set "MCP_EXE=%REG_CONTENT%\..\StudioMCP.exe"
  if defined MCP_EXE goto :use_found
  if exist "%REG_CONTENT%/..\StudioMCP.exe" set "MCP_EXE=%REG_CONTENT%/..\StudioMCP.exe"
  if defined MCP_EXE goto :use_found
)

REM 3. Last resort: delegate to official mcp.bat (has hardcoded hash + registry fallback, but buggy when run standalone)
if exist "%LOCALAPPDATA%\Roblox\mcp.bat" goto :use_mcp_bat
goto :not_found

:use_mcp_bat
call "%LOCALAPPDATA%\Roblox\mcp.bat" %*
exit /b %ERRORLEVEL%

:use_found
"%MCP_EXE%" %*
exit /b %ERRORLEVEL%

:not_found

REM 4. Graceful no-op: Studio not installed or MCP not available — don't crash opencode
echo [roblox-mcp-safe] StudioMCP not found — skipping (install Studio or ignore if not a Roblox project) 1>&2
exit /b 0
