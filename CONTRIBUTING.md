# Contributing

Changes should preserve the actual upstream T3 web client and official pairing flow. Keep backend state owned by T3; do not query or mutate its SQLite database directly. Never stop an attached server, disable Chromium's sandbox, or store unredacted pairing credentials in logs.

## Local checks

Use a supported Node version and a Kitty graphics terminal:

```sh
npm ci
npm test
bash -n install.sh
shellcheck install.sh
npm pack --dry-run
```

The automated suite uses local fixtures rather than your provider credentials. Installer tests use checksum-verified fixture archives without network access. Test native changes against an isolated environment:

```sh
T3_TODE_SMOKE_OWNED=1 python3 scripts/native-smoke.py 4785 /tmp/t3-tode-native-test
```

The smoke test creates a PTY, responds to terminal queries, decodes direct Kitty pixel frames, and sends Ctrl+Q to check clean exit. Generated screenshots live in ignored `artifacts/`. This checks rendering/lifecycle; visually inspect the screenshot before claiming a successful UI flow.

## Pull requests

Describe the user-visible problem, final behavior, and relevant checks. Include screenshots for rendering changes using synthetic projects and messages. Do not include tokens, user profile data, personal machine identifiers, or private conversations. Discuss upstream UI behavior in the upstream T3 repository; this project owns the terminal shell, installation, discovery, and lifecycle.

## Release

1. Update the version in `package.json`, the lockfile, and the default release in `install.sh`; update `CHANGELOG.md`.
2. Run CI, native smoke checks, and installer fixtures. Verify pinned runtime downloads still exist.
3. Commit and tag `v<version>`. Run `npm run release:pack` from a clean checkout.
4. Publish the archive, `install.sh`, `install.ps1`, and `SHA256SUMS` as GitHub release assets. Keep the tag immutable.
5. Verify the public installation commands on macOS and Linux and the PowerShell syntax/WSL route. Document any untested platforms accurately.

The installer downloads a pinned tagged archive, verifies SHA-256 checksums over HTTPS, reuses compatible Node and installed npm/pnpm/Bun, and installs dependencies from `package-lock.json`. It is not signed or notarized by Belweave; Pixel provides the underlying patched Chromium runtime. Release archives exclude runtime downloads, vendor checkouts, generated artifacts, and user state.
