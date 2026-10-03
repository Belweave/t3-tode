# Changelog

## 0.1.5

- Extract Pixel on the installation filesystem, fixing EXDEV failures when `/tmp` and the home directory use different mounts.
- Print installation failure diagnostics once.

## 0.1.4

- Load PATH from existing Bash login profiles and show the exact command needed in an already-open SSH shell.
- Report failed installation explicitly, and prevent package installation from consuming the piped installer input.
- Explain automatic T3 pairing and first-run onboarding over SSH.

## 0.1.3

- Add `--with-t3` / `T3_TODE_INSTALL_T3=1` to install the official upstream T3 CLI when missing.
- Reuse working T3 installations and preserve upstream installer channel/version/path options.
- Windows opt-in invokes the official PowerShell installer and enables the Linux installer in WSL.

## 0.1.2

- Host shell and PowerShell bootstraps as tagged release assets, avoiding stale raw-branch installer caches.
- Include installer checksums with the application archive and verify the public release endpoints in CI.

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
