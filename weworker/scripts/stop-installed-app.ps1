param([Parameter(Mandatory = $true)][string]$InstallDirectory)

function Stop-WeWorkerInstallation {
    param(
        [Parameter(Mandatory = $true)][string]$InstallDirectory,
        [ValidateRange(0, 15)][int]$TimeoutSeconds = 12
    )

    $installRoot = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\', '/')
    $driveRoot = [IO.Path]::GetPathRoot($installRoot).TrimEnd('\', '/')
    if ($installRoot -eq $driveRoot) {
        throw 'An installation directory is required; refusing a drive root.'
    }
    $appPath = [IO.Path]::Combine($installRoot, 'WeWorker.exe')
    $runtimePrefix = [IO.Path]::Combine($installRoot, 'resources') + '\'

    function Get-InstalledProcesses {
        # Query failure must abort setup rather than imply that files are free.
        Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
            $executable = $_.ExecutablePath
            $executable -and (
                $executable.Equals($appPath, [StringComparison]::OrdinalIgnoreCase) -or
                $executable.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)
            )
        }
    }

    $timer = [Diagnostics.Stopwatch]::StartNew()
    $remaining = @(Get-InstalledProcesses)
    while ($remaining.Count -gt 0) {
        foreach ($installedProcess in $remaining) {
            # Closing the window alone can leave the app running in the tray.
            Stop-Process -Id $installedProcess.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 200
        $remaining = @(Get-InstalledProcesses)
        if ($remaining.Count -gt 0 -and $timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
            throw 'Installed WeWorker processes are still running.'
        }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        Stop-WeWorkerInstallation -InstallDirectory $InstallDirectory
        exit 0
    } catch {
        Write-Error 'Unable to stop the installed WeWorker processes. Close WeWorker and retry setup.'
        exit 2
    }
}
