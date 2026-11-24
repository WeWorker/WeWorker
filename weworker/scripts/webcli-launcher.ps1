# PowerShell must launch the native runtime directly. A .cmd trampoline reparses
# metacharacters (notably & in URLs) after PowerShell has removed its quotes.
$cliEntry = Join-Path $PSScriptRoot 'webcli.cjs'
$runtime = $null
foreach ($candidate in @(
    '../../WeWorker.exe',
    '../../../WeWorker.exe',
    '../../node_modules/electron/dist/electron.exe'
)) {
    $candidatePath = Join-Path $PSScriptRoot $candidate
    if (Test-Path -LiteralPath $candidatePath -PathType Leaf) {
        $runtime = $candidatePath
        break
    }
}
$previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
try {
    if ($runtime) {
        $env:ELECTRON_RUN_AS_NODE = '1'
    } else {
        $runtime = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    }
    # Electron is a GUI-subsystem executable on Windows. A pipeline makes
    # PowerShell wait for it and capture stdout instead of returning early.
    & $runtime $cliEntry @args | ForEach-Object { $_ }
    $cliExitCode = $LASTEXITCODE
} finally {
    $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode
}
exit $cliExitCode
