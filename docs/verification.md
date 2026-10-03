# Release verification

## v0.1.0

- **34 automated tests pass on macOS and Linux.** Tests cover startup failure, timeout, occupied ports, interruption, credential redaction, process-group escalation, descendant cleanup, bounded logs, existing environment discovery, CLI mismatch refusal, exclusive profiles, SSH transport fixtures, and installer integrity/updates.
- Installer fixtures test paths containing spaces, atomic replacement across repeated installs, idempotent PATH setup, checksum mismatch refusal, cleanup, and preservation of the previous installation.
- Native macOS arm64 renderer exercised through a PTY using the actual launcher. Direct Kitty frames decoded at **1600 × 1000**. Ctrl+Q exits with code 0.
- Owned backend checks cover startup, upstream pairing, rendering, clean quit, and released backend port.
- Attached backend checks cover pairing, rendering, and leaving the original server running. An existing desktop nightly environment displayed existing conversations across its projects; no conversation database was copied or manually edited.
- Persistent sessions were verified across launches. A live coding-provider response was previously verified through the official backend.
- `npm audit --omit=dev` reported no known npm vulnerabilities during release preparation. This does not audit the complete downloaded Chromium/Node distributions.
- [Release CI](https://github.com/Belweave/t3-tode/actions/runs/37145621758) passed unit/installer tests on macOS and Linux, shell/PowerShell syntax checks, and a real headless Linux Pixel render through a PTY. Linux direct pixel frames rendered at 1600×1000 and Ctrl+Q exited cleanly.
- Verified backend restoration handles npm skipping the upstream Linux archive because it bundles both libc variants. The official archive is restored only when missing, with its pinned SHA-512 integrity checked before extraction.

## Verification limits

These checks do not exhaustively exercise every upstream feature, provider, approval mode, file dialog, or desktop OS integration. The upstream UI is used directly; its behavior follows the upstream version and server capabilities.

The native PTY harness exercises direct pixel transport without filesystem/shared-memory assumptions. A real network SSH session and a Windows/WSL installation have not been exercised end to end. macOS Intel and Linux arm64 have not been tested locally. WSL is a Linux route, not native Windows support.

Screenshots and runtime state used during tests are not included in public release archives. Generated native frames live under ignored `artifacts/`, or as CI artifacts from synthetic environments.

## Official T3 installation option

Installer fixtures cover explicit opt-in, default omission, skipping a working CLI, official installer failure without replacing the current app, and persistent discovery of a custom T3 bin directory. The actual upstream Unix installer was exercised on macOS with isolated T3 home/bin directories, and its installed CLI responds to `--version`. CI additionally exercises the real native Windows PowerShell installer function and checks that a second invocation reuses its installed CLI. The published installer matrix enables `--with-t3` on macOS and Linux. Full WSL rendering remains outside the end-to-end checks.
