# Adds LivePay's keys to an environment's app secret in AWS Secrets Manager (docs/LIVEPAY.md).
# Run it yourself; it asks for each value without showing it, keeps every other key in the secret, and never writes
# the values to disk or to the screen.
#
#   aws sso login --profile Pexerearn
#   .\infra\scripts\set-livepay-secret.ps1                 # staging
#   .\infra\scripts\set-livepay-secret.ps1 -Environment production
param([ValidateSet('staging', 'production')][string]$Environment = 'staging')

$ErrorActionPreference = 'Stop'
$env:AWS_PROFILE = 'Pexerearn'
$secretId = "pexa-$Environment/app"

function Read-Hidden([string]$prompt) {
  $secure = Read-Host -Prompt $prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

$current = aws secretsmanager get-secret-value --secret-id $secretId --region eu-west-1 --query SecretString --output text
if (-not $?) { throw "Could not read $secretId. Run: aws sso login --profile Pexerearn" }
$app = $current | ConvertFrom-Json

$account = (Read-Host -Prompt 'LivePay account number (LP...)').Trim()
if ($account -notmatch '^[A-Za-z0-9]{4,40}$') { throw 'That does not look like a LivePay account number.' }
$apiKey = Read-Hidden 'LivePay API key (hidden)'
$webhook = Read-Hidden 'LivePay webhook secret (hidden)'
if (-not $apiKey -or -not $webhook) { throw 'Both the API key and the webhook secret are needed.' }

foreach ($pair in @(@('LIVEPAY_ACCOUNT_NUMBER', $account), @('LIVEPAY_LIVE_API_KEY', $apiKey), @('LIVEPAY_LIVE_WEBHOOK_SECRET', $webhook))) {
  $app | Add-Member -NotePropertyName $pair[0] -NotePropertyValue $pair[1] -Force
}

# Through a temporary file (not the command line, which other programs can see), deleted straight after.
$tmp = [IO.Path]::GetTempFileName()
try {
  [IO.File]::WriteAllText($tmp, ($app | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
  aws secretsmanager put-secret-value --secret-id $secretId --region eu-west-1 --secret-string "file://$tmp" | Out-Null
  if (-not $?) { throw "Could not update $secretId." }
} finally {
  Remove-Item $tmp -Force
}
Write-Host "LivePay keys saved in $secretId. Keys now in the secret: $(($app.PSObject.Properties.Name) -join ', ')"
