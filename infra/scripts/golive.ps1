# Go-live on AWS (docs/DEPLOYMENT.md, "Going live"). The live database is private, so these steps run through the
# migrate function. Run it yourself: it asks for passwords and codes without showing them, sends them only to the
# function (never on the command line or in logs) and deletes its temporary files.
#
#   aws sso login --profile Pexerearn
#   .\infra\scripts\golive.ps1 status                  # the checklist
#   .\infra\scripts\golive.ps1 admin                   # the first admin (once, on a fresh database)
#   .\infra\scripts\golive.ps1 sign provider_keys      # sign one item (admin password + authenticator code)
#   .\infra\scripts\golive.ps1 revoke provider_keys
param(
  [Parameter(Position = 0)][ValidateSet('status', 'admin', 'sign', 'revoke')][string]$Command = 'status',
  [Parameter(Position = 1)][string]$Item = '',
  [ValidateSet('staging', 'production')][string]$Environment = 'production'
)

$ErrorActionPreference = 'Stop'
$env:AWS_PROFILE = 'Pexerearn'
$function = "pexa-$Environment-migrate"

function Read-Hidden([string]$prompt) {
  $secure = Read-Host -Prompt $prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Invoke-Migrate([hashtable]$payload) {
  $in = [IO.Path]::GetTempFileName()
  $out = [IO.Path]::GetTempFileName()
  try {
    [IO.File]::WriteAllText($in, ($payload | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
    $meta = aws lambda invoke --function-name $function --region eu-west-1 --cli-read-timeout 300 --payload "fileb://$in" $out | ConvertFrom-Json
    if (-not $?) { throw "Could not run $function. Run: aws sso login --profile Pexerearn" }
    $result = Get-Content $out -Raw | ConvertFrom-Json
    if ($meta.FunctionError) { throw "Refused: $($result.errorMessage)" }
    return $result
  } finally {
    Remove-Item $in, $out -Force
  }
}

function Show-Items($result) {
  foreach ($i in $result.items) { Write-Host ("{0} {1,-18} {2}" -f $(if ($i.signed) { '[x]' } else { '[ ]' }), $i.key, $i.label) }
  if (@($result.items | Where-Object { -not $_.signed }).Count -eq 0) { Write-Host 'All items signed: live mode may start.' }
  else { Write-Host 'Live mode refuses to start until every item is signed.' }
}

switch ($Command) {
  'status' { Show-Items (Invoke-Migrate @{ action = 'golive-status' }) }
  'admin' {
    $username = (Read-Host -Prompt 'Admin username').Trim()
    $email = (Read-Host -Prompt 'Admin email').Trim()
    $phone = (Read-Host -Prompt 'Admin phone with country code (for example +2567...)').Trim()
    $country = (Read-Host -Prompt 'Country code (UG)').Trim()
    if (-not $country) { $country = 'UG' }
    $password = Read-Hidden 'Password (12 or more characters with letters, numbers and a symbol; hidden)'
    if ($password -ne (Read-Hidden 'Same password again (hidden)')) { throw 'The passwords do not match.' }
    $r = Invoke-Migrate @{ action = 'admin-create'; username = $username; email = $email; phone = $phone; country = $country; password = $password }
    Write-Host "Created admin $username."
    Write-Host 'Add this to your authenticator app NOW (Google Authenticator: + then Enter a setup key). It is not shown again:'
    Write-Host "  Key: $($r.totpSecret)"
  }
  default {
    if (-not $Item) { throw 'Name the item, for example: .\infra\scripts\golive.ps1 sign provider_keys' }
    $username = (Read-Host -Prompt 'Admin username').Trim()
    $password = Read-Hidden 'Admin password (hidden)'
    $code = (Read-Host -Prompt 'Authenticator code').Trim()
    $note = (Read-Host -Prompt 'Note (optional, for example what you checked)').Trim()
    $r = Invoke-Migrate @{ action = "golive-$Command"; item = $Item; username = $username; password = $password; code = $code; note = $note }
    Write-Host "$(if ($Command -eq 'sign') { 'Signed' } else { 'Revoked' }) $Item."
    Show-Items $r
  }
}
