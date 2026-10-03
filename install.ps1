param([switch]$WithT3)

function Install-OfficialT3 {
    function Test-T3Cli {
        $cli = Get-Command t3 -ErrorAction SilentlyContinue
        if (-not $cli) { return $false }
        try {
            $null = & $cli.Source --version 2>$null
            return ($LASTEXITCODE -eq 0)
        } catch { return $false }
    }
    function Add-T3UserPath {
        $directory = Split-Path (Get-Command t3).Source -Parent
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
        if (($userPath -split ';') -notcontains $directory -and ($machinePath -split ';') -notcontains $directory) {
            $updated = if ($userPath) { "$directory;$userPath" } else { $directory }
            [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
        }
    }
    $t3Bin = if ($env:T3CODE_INSTALL_BIN_DIR) { $env:T3CODE_INSTALL_BIN_DIR } else { Join-Path $HOME '.local\bin' }
    if (-not (Test-T3Cli)) { $env:PATH = "$t3Bin;$env:PATH" }
    if (Test-T3Cli) {
        Add-T3UserPath
        Write-Host 'Reusing installed T3 Code on Windows.'
        return
    }
    Write-Host 'Installing the official T3 Code CLI on Windows…'
    Invoke-RestMethod https://t3.codes/install.ps1 | Invoke-Expression
    $env:PATH = "$t3Bin;$env:PATH"
    if (-not (Test-T3Cli)) { throw 'The official T3 installer completed, but t3 --version failed.' }
    Add-T3UserPath
}

# Windows bootstrap: Pixel runs inside WSL, not as a native Windows binary.
$ErrorActionPreference = 'Stop'
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw 'WSL is required. Run wsl --install -d Ubuntu in an administrator PowerShell, reboot if requested, create your Linux user, then rerun this installer.'
}
& wsl.exe --exec bash -lc 'test "$(uname -s)" = Linux && test "$(id -u)" != 0' 2>$null
if ($LASTEXITCODE -ne 0) {
    throw 'Set up a WSL2 Linux distribution and a non-root user first: wsl --install -d Ubuntu. Then rerun this installer.'
}
$InstallT3 = if ($WithT3 -or $env:T3_TODE_INSTALL_T3 -eq '1') { '1' } else { '0' }
if ($env:T3_TODE_INSTALL_T3 -and $env:T3_TODE_INSTALL_T3 -notin @('0','1')) { throw 'T3_TODE_INSTALL_T3 must be 0 or 1.' }
if ($InstallT3 -eq '1') { Install-OfficialT3 }
$Manager = if ($env:T3_TODE_PACKAGE_MANAGER) { $env:T3_TODE_PACKAGE_MANAGER } else { 'auto' }
if ($Manager -notin @('auto', 'npm', 'pnpm', 'bun')) { throw 'T3_TODE_PACKAGE_MANAGER must be npm, pnpm, or bun.' }
Write-Host 'Installing t3-tode in your default WSL distribution…'
& wsl.exe --exec bash -lc "set -e; command -v curl >/dev/null || { sudo apt-get update && sudo apt-get install -y curl; }; curl -fsSL https://github.com/Belweave/t3-tode/releases/latest/download/install.sh | T3_TODE_PACKAGE_MANAGER=$Manager T3_TODE_INSTALL_T3=$InstallT3 bash"
if ($LASTEXITCODE -ne 0) { throw 'The WSL installer failed. See the output above.' }
Write-Host ''
Write-Host 'Installed in WSL. Open Kitty or Ghostty inside WSLg and run ~/.local/bin/t3-tode.'
Write-Host 'Windows Terminal does not support the required Kitty graphics protocol.'
Write-Host 'Your WSL T3 environment uses ~/.t3; native Windows desktop data is not automatically shared.'
