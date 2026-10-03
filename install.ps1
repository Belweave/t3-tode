# Windows bootstrap: Pixel runs inside WSL, not as a native Windows binary.
$ErrorActionPreference = 'Stop'
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw 'WSL is required. Run wsl --install -d Ubuntu in an administrator PowerShell, reboot if requested, create your Linux user, then rerun this installer.'
}
& wsl.exe --exec bash -lc 'test "$(uname -s)" = Linux && test "$(id -u)" != 0' 2>$null
if ($LASTEXITCODE -ne 0) {
    throw 'Set up a WSL2 Linux distribution and a non-root user first: wsl --install -d Ubuntu. Then rerun this installer.'
}
$Manager = if ($env:T3_TODE_PACKAGE_MANAGER) { $env:T3_TODE_PACKAGE_MANAGER } else { 'auto' }
if ($Manager -notin @('auto', 'npm', 'pnpm', 'bun')) { throw 'T3_TODE_PACKAGE_MANAGER must be npm, pnpm, or bun.' }
Write-Host 'Installing t3-tode in your default WSL distribution…'
& wsl.exe --exec bash -lc "set -e; command -v curl >/dev/null || { sudo apt-get update && sudo apt-get install -y curl; }; curl -fsSL https://github.com/Belweave/t3-tode/releases/latest/download/install.sh | T3_TODE_PACKAGE_MANAGER=$Manager bash"
if ($LASTEXITCODE -ne 0) { throw 'The WSL installer failed. See the output above.' }
Write-Host ''
Write-Host 'Installed in WSL. Open Kitty or Ghostty inside WSLg and run ~/.local/bin/t3-tode.'
Write-Host 'Windows Terminal does not support the required Kitty graphics protocol.'
Write-Host 'Your WSL T3 environment uses ~/.t3; native Windows desktop data is not automatically shared.'
