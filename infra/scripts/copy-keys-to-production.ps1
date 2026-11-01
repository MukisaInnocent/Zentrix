# Copies the Resend and LivePay keys from the staging app secret into the production one (docs/DEPLOYMENT.md,
# "Going live"). Both use the same Resend and LivePay accounts. Run it yourself; it keeps every other key in the
# production secret and shows key names only, never values.
#
#   aws sso login --profile Pexerearn
#   .\infra\scripts\copy-keys-to-production.ps1
$ErrorActionPreference = 'Stop'
$env:AWS_PROFILE = 'Pexerearn'
$keys = @('RESEND_API_KEY', 'LIVEPAY_ACCOUNT_NUMBER', 'LIVEPAY_LIVE_API_KEY', 'LIVEPAY_LIVE_WEBHOOK_SECRET')

function Read-AppSecret([string]$id) {
  $text = aws secretsmanager get-secret-value --secret-id $id --region eu-west-1 --query SecretString --output text
  if (-not $?) { throw "Could not read $id. Run: aws sso login --profile Pexerearn" }
  return $text | ConvertFrom-Json
}

$staging = Read-AppSecret 'pexa-staging/app'
$production = Read-AppSecret 'pexa-production/app'
$missing = @($keys | Where-Object { -not $staging.$_ })
if ($missing.Count -gt 0) { throw "Staging has no value for: $($missing -join ', ')" }
foreach ($k in $keys) { $production | Add-Member -NotePropertyName $k -NotePropertyValue $staging.$k -Force }

# Through a temporary file (not the command line, which other programs can see), deleted straight after.
$tmp = [IO.Path]::GetTempFileName()
try {
  [IO.File]::WriteAllText($tmp, ($production | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
  aws secretsmanager put-secret-value --secret-id 'pexa-production/app' --region eu-west-1 --secret-string "file://$tmp" | Out-Null
  if (-not $?) { throw 'Could not update pexa-production/app.' }
} finally {
  Remove-Item $tmp -Force
}
Write-Host "Copied $($keys -join ', ') into pexa-production/app."
Write-Host "Keys now in the production secret: $(($production.PSObject.Properties.Name) -join ', ')"
