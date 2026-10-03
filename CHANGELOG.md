# Changelog

## 0.1.1

- Canonicalize the imported npm lock before Bun's frozen installation, fixing fresh Linux installs with Bun.
- Report the actual installed application version from package metadata.
- Public installation checks cover npm, pnpm, Bun, Node reuse, and private Node fallback.

## 0.1.0

First public release.

- Render the real T3 Code web client at terminal pixel resolution with mouse and keyboard input.
- Discover and pair with an existing T3 environment, loading its projects and threads.
- Start fresh or explicitly isolated official backends with loopback binding and owned process cleanup.
- Support headless Linux rendering and the plain SSH → `t3-tode` workflow.
- Persist browser sessions, guard profiles, scale UI, and retain bounded redacted backend logs.
- Add checksum-verified macOS/Linux installer with Node reuse, npm/pnpm/Bun support, and a private Node LTS fallback and atomic updates.
- Add a PowerShell bootstrap into an existing WSL2 distribution; no native Windows renderer.
- Add automated lifecycle, discovery, profile, installer, and transport checks plus native pixel smoke tooling.

Known limits: Kitty graphics terminal required; native Windows unsupported; WSL end-to-end and real remote SSH sessions remain unverified. Feature availability follows the upstream server. Intel Mac requires a compatible upstream CLI/build rather than the pinned T3 binary.
