param([Security.SecureString]$ApiKey)

$ErrorActionPreference = 'Stop'
if ($null -eq $ApiKey) { $ApiKey = Read-Host 'DECISION_API_KEY' -AsSecureString }
Add-Type -AssemblyName System.Security
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ApiKey)
try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if ([string]::IsNullOrWhiteSpace($plain) -or $plain -match '\s') { throw 'Invalid decision API key' }
    $bytes = [Text.Encoding]::UTF8.GetBytes($plain)
    $encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $directory = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.webcli\credentials'
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $file = Join-Path $directory 'decision-api-key.dpapi'
    [IO.File]::WriteAllText($file, [Convert]::ToBase64String($encrypted))
    $acl = [Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
    Set-Acl -LiteralPath $file -AclObject $acl
    Write-Output 'Protected decision credential saved for the current Windows user.'
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    $plain = $null
}
