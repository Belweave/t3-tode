# Security

Please report vulnerabilities privately using the repository's GitHub **Security → Report a vulnerability** action. Do not include active pairing tokens or provider credentials in public issues.

## Scope

This project owns installers, the launcher, server discovery, process lifecycle, and the Pixel shell configuration. T3 Code owns backend authorization, provider access, conversation storage, and the web client. Pixel owns the terminal transport and patched Chromium runtime. Report upstream issues to the appropriate upstream project as well.

Owned T3 servers bind to loopback. The launcher does not disable Chromium's sandbox. Pairing credentials are passed in memory to the upstream web client; persisted backend logs redact tokens and retain at most two 5 MiB files. Browser profiles retain authenticated session data and must be treated as private. `--serve` intentionally prints a pairing link; do not send it to public logging systems.

Only connect to trusted T3 servers. Upstream coding providers can read/write files and execute commands according to the permissions selected in T3. The browser client has the same granted authority as other upstream clients.

## Updates

Only the latest t3-tode release receives fixes. Installers pin the application, Node runtime, and dependency lockfile; updates require rerunning the installer. An existing T3 server remains responsible for its own updates. Exact CLI version matching is required when pairing with a discovered running backend.

SHA-256 verification protects against download corruption and inconsistent artifacts, not a compromised publisher or account. There is no separate Belweave signing key or signed installer distribution in v0.1.0.
