# Audit Reports — Index

**Date:** 2026-08-30
**Project:** opencode-gui (Tauri v2 + React, Windows-only)
**Output:** \	emp-reports/\

| # | Report | File | Findings | Focus |
|---|--------|------|----------|-------|
| 1 | Hardcoded / Magic Values | [01-hardcoded.md](./01-hardcoded.md) | 98 (18 High, 41 Med, 39 Low) | Ports, timeouts, paths, colors, magic numbers, strings |
| 2 | Fragile / Bound-to-Break | [02-fragile.md](./02-fragile.md) | 38 (races, leaks, timing) | Race conditions, error gaps, brittle assumptions, resource leaks |
| 3 | Bad Practices | [03-bad-practices.md](./03-bad-practices.md) | 44 (5 Crit, 11 High) | God objects, duplication, type safety, coupling, CSS/Rust issues |
| 4 | Nonsensical / Confusing | [04-nonsensical.md](./04-nonsensical.md) | 38 (dead/contradictory/overeng.) | Dead code, contradictions, naming, overengineering, orphans |
| 5 | Security, Perf & Arch | [05-security-perf.md](./05-security-perf.md) | 30 (17 Sec, 9 Perf, 6 Arch) | Injection, XSS, sandbox, unbounded growth, SSE/memory |

**Total: ~248 findings across 5 reports.**

## Top 10 to fix first

Derived from cross-report critical/high overlap:

1. **No filesystem sandbox** — \write_file\/\ile_*\ accept arbitrary paths (05 S01/S02, 03). Add \canonicalize + starts_with(workspace)\ helper in \lib.rs\.
2. **\csp: null\ + 4 \dangerouslySetInnerHTML\ sinks** — XSS → RCE via \invoke\ (05 S03, 04). Restore CSP, sanitize markdown HTML, regression-test sinks.
3. **Stale Proxy \directory\ capture** — \src/api.ts:23-44\ wraps at creation, workspace switch hits wrong dir (02 RC-04, 01). Invalidate cache on \setDirectory\ or read live \directory\ per call.
4. **Unsandboxed plugin \import()\ + raw CSS inject** — full \invoke\ with no signature/allowlist (05 S05, 02). Add plugin capability allow-list + hash pinning.
5. **\http_json\ prefix bypass** — \starts_with("http://127.0.0.1")\ allows \127.0.0.1.evil.com\ (05 S04, 01). Parse URL, check hostname exactly.
6. **\// @ts-nocheck\ over 1778-line god hook** — \useOpencode.ts:1\ disables all types (03, 04). Remove, fix types incrementally.
7. **SSE boot stale closure + port race** — \useOpencode.ts:844-1066\ captures \ase\ at boot, retry changes port (02 RC-01). Re-subscribe SSE on \ase\ change.
8. **Unbounded \sessionStore\/\useFileCache\ growth** — OOM on long sessions (05 P01, 02). Cap entries, evict oldest.
9. **PTY arbitrary shell + leaked child on \MAX_TERMS\** — \pty.rs:134-160\ (05 S07, 02). Allow-list shells, kill on cap.
10. **Boot poll + \wait_for_port\ magic timeouts duplicated** — 50ms→30s scattered, no shared constants (01, 02). Centralize in \constants.ts\/\consts.rs\.

## How to use

Each report is standalone: open the one matching your concern. The master tables have \File:Line | Issue | Fix | Severity\ — sort by severity and work top-down. Fix #1–5 before shipping to untrusted content.
