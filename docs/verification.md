# Release verification

## v0.1.0

- Automated tests cover startup failure, timeout, occupied ports, interruption, credential redaction, process-group escalation, descendant cleanup, bounded logs, existing environment discovery, CLI mismatch refusal, exclusive profiles, SSH transport fixtures, and installer integrity/updates.
- Installer fixtures test paths containing spaces, atomic replacement across repeated installs, idempotent PATH setup, checksum mismatch refusal, cleanup, and preservation of the previous installation.
- Native macOS arm64 renderer exercised through a PTY using the actual launcher. Direct Kitty frames decoded at **1600 × 1000**. Ctrl+Q exits with code 0.
- Owned backend checks cover startup, upstream pairing, rendering, clean quit, and released backend port.
- Attached backend checks cover pairing, rendering, and leaving the original server running. An existing desktop nightly environment displayed existing conversations across its projects; no conversation database was copied or manually edited.
- Persistent sessions were verified across launches. A live coding-provider response was previously verified through the official backend.
- `npm audit --omit=dev` reported no known npm vulnerabilities during release preparation. This does not audit the complete downloaded Chromium/Node distributions.
- CI runs unit/installer tests on macOS and Linux, installer syntax/lint checks, and a real headless Linux Pixel render through a PTY.

## Verification limits

These checks do not exhaustively exercise every upstream feature, provider, approval mode, file dialog, or desktop OS integration. The upstream UI is used directly; its behavior follows the upstream version and server capabilities.

The native PTY harness exercises direct pixel transport without filesystem/shared-memory assumptions. A real network SSH session and a Windows/WSL installation have not been exercised end to end. macOS Intel and Linux arm64 have not been tested locally. WSL is a Linux route, not native Windows support.

Screenshots and runtime state used during tests are not included in public release archives. Generated native frames live under ignored `artifacts/`, or as CI artifacts from synthetic environments.
