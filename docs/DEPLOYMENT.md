# Deploying Pexa to AWS

Pexa (the project was previously called Zentrix; some files still use that name) runs on AWS in **eu-west-1
(Ireland)**, in **test mode only** (fake money). Real-money mode stays locked behind the go-live checklist.
Costs are in [COSTS.md](COSTS.md).

## How it fits together

```
Browser ──HTTPS──> CloudFront ──> S3 (private, Origin Access Control): static pages, CSS, JS
                       │
                       └── /api/*, /admin/*, /healthz, /readyz ──> API Gateway (HTTP API) ──> Lambda "api"
                                                                                                  │
   Private VPC (no internet gateway, no NAT) ─────────────────────────────────────────────────────┤
     Lambda api, jobs, migrate ──> Aurora Serverless v2 PostgreSQL (0 to 2 ACU, pauses when idle)│
     Lambda api ──(free S3 gateway endpoint)──> S3 mail outbox ──> SQS ──> Lambda "mailer" ──> Resend
                                                                    └── dead-letter queue + alarm (mailer is outside the VPC)
   EventBridge Scheduler ──> Lambda jobs (balance check hourly, clean-up daily, exchange rates when new ones arrive)
   EventBridge Scheduler ──> Lambda "fxfetch" (outside the VPC) ──> open.er-api.com, snapshot to S3 fx/latest.json
   CloudFront access logs (v2) ──> S3 access-logs bucket ──> Lambda "visits" hourly (outside the VPC) ──> S3 stats/visits/
```

- One code package, six functions (ARM64): `api` (the Express app through serverless-http), `jobs`,
  `migrate` (migrations and test seed, run by the pipeline), `mailer`, `fxfetch` and `visits`. Locally the same app still runs with
  `npm run dev` as a normal Node server.
- All money data stays in Aurora PostgreSQL (no DynamoDB).
- Secrets live in Secrets Manager (`pexa-<env>/database`, `pexa-<env>/app`). The functions in the VPC have no route
  to Secrets Manager (no NAT or paid endpoints, by decision), so Terraform reads the values at deploy time and sets
  them as Lambda environment variables, which Lambda encrypts at rest. **Changing a secret needs a redeploy.**
- Without a Resend key, emails (sign-in codes, reset links) are kept on the staff **Email outbox** page.
- Exchange rates for referral rewards across countries: `fxfetch` checks every 5 minutes and asks the provider only
  after its announced daily update. When the rates are new it writes them to the outbox bucket under `fx/`, and that
  write starts the `fxrates` job (S3 notification; a daily backup schedule too), which stores them in `fx_rates`. A
  reward uses the latest stored rate however old, so it is paid at once; only a currency with no rate yet waits.
- Site visitors for the staff Events page (owner, 2026-11-05; `visits.tf`): CloudFront writes its access logs
  (standard logging v2, JSON, only the fields the count needs, including the visitor's country) to the private
  `access-logs` bucket under `cloudfront/yyyy/MM/dd/HH/`. The `visits` function counts yesterday and today (East Africa
  Time) every hour into `stats/visits/index.json` in the outbox bucket, which the API reads; no visit wakes the
  database. The raw logs hold IP addresses and expire after `access_log_retention_days` (14); the daily counts stay.
  The log delivery resources live in us-east-1 (CloudFront's log sources), the bucket in eu-west-1. Counts start from
  the day this is applied (no history). After the first apply, check that files appear under `cloudfront/` within an
  hour and that the visits function's log shows `files` above zero.
- The SMS forwarder's HMAC secret is not created: SMS forwarding was removed by the owner (see CLAUDE.md).
- Staff pages (`/admin/*`) are served by the API so it can check the staff session before sending them.

## One-time setup (PowerShell)

All commands run from the repository root unless a step says otherwise.

### 1. Tools and sign-in

```powershell
aws --version            # AWS CLI v2
terraform -version       # 1.16 or later
node --version           # 20.19 or later
aws sso login --profile Pexerearn
$env:AWS_PROFILE = "Pexerearn"
$env:AWS_REGION  = "eu-west-1"
aws sts get-caller-identity
```

Terraform finds the credentials through `AWS_PROFILE`. No access keys are stored anywhere.

### 2. Account-wide resources (GitHub OpenID Connect, deploy roles, CloudTrail, GuardDuty, budget)

```powershell
Set-Location infra\terraform\global
Copy-Item terraform.tfvars.example terraform.tfvars
notepad terraform.tfvars          # set budget_email
terraform init
terraform plan -out tfplan        # review: 20 resources, no fixed cost beyond CloudTrail storage and GuardDuty
terraform apply tfplan            # only after the owner approves
Remove-Item tfplan
terraform output github_deploy_role_arns
Set-Location ..\..\..
```

Confirm the budget email AWS sends.

### 3. GitHub settings (by hand, in the browser)

In **github.com/MukisaInnocent/Zentrix > Settings**:

1. **Environments > New environment** `staging`. Add the environment variables
   - `AWS_DEPLOY_ROLE_ARN` = the `staging` ARN from step 2
   - `ALARM_EMAIL` = the address for alarm emails
   - `PEXA_SEED` = `true` (adds the fake test accounts on deploy)
2. **Environments > New environment** `production`. Tick **Required reviewers** and add yourself (this is the manual
   approval). Optionally restrict **Deployment branches** to `staging` and `main`. Add `AWS_DEPLOY_ROLE_ARN` (the
   `production` ARN) and `ALARM_EMAIL`. Do not add `PEXA_SEED`.
3. **Secrets and variables > Actions > Variables**: add the repository variable `PEXA_PRODUCTION_ENABLED` = `false`
   (set it to `true` when production should be created).

No AWS secrets go into GitHub: the workflows sign in with OpenID Connect.

### 4. First staging deploy from your computer

```powershell
npm ci
npm run build
node infra\scripts\package-lambda.mjs

Set-Location infra\terraform\envs\staging
Copy-Item terraform.tfvars.example terraform.tfvars
notepad terraform.tfvars          # set alarm_email
terraform init
terraform plan -out tfplan        # review: 75 resources
terraform apply tfplan            # only after the owner approves; Aurora takes about 10 minutes
Remove-Item tfplan
$fn     = terraform output -raw migrate_function
$bucket = terraform output -raw web_bucket
$cdn    = terraform output -raw cloudfront_distribution_id
$site   = terraform output -raw site_url
Set-Location ..\..\..\..
```

Confirm the alarm email AWS sends.

### 5. Migrate the database and add the fake test data

```powershell
New-Item -ItemType Directory -Force .lambda | Out-Null
Set-Content -Encoding ascii .lambda\migrate.json '{"action":"migrate"}'
Set-Content -Encoding ascii .lambda\seed.json '{"action":"seed"}'
aws lambda invoke --function-name $fn --payload fileb://.lambda/migrate.json --cli-read-timeout 310 .lambda\migrate-out.json
Get-Content .lambda\migrate-out.json
aws lambda invoke --function-name $fn --payload fileb://.lambda/seed.json --cli-read-timeout 310 .lambda\seed-out.json
Get-Content .lambda\seed-out.json
```

The first call can take about 15 seconds while Aurora resumes. If the output shows `"errorMessage"`, check the
log group `/aws/lambda/pexa-staging-migrate` in CloudWatch.

### 6. Upload the pages

```powershell
aws s3 sync web/ "s3://$bucket/" --delete --exclude "admin/*" --cache-control "public, max-age=300"
aws cloudfront create-invalidation --distribution-id $cdn --paths "/*"
Invoke-RestMethod "$site/readyz"
Start-Process $site
```

### 7. Staging sign-in details (on your screen only)

```powershell
$app = aws secretsmanager get-secret-value --secret-id pexa-staging/app --query SecretString --output text | ConvertFrom-Json
"superadmin password: $($app.TEST_SUPERADMIN_PASSWORD)"
"seed staff password: $($app.SEED_STAFF_PASSWORD)    seed member password: $($app.SEED_MEMBER_PASSWORD)"
```

`superadmin` signs in with its password alone (test mode). The seeded members are `test_member_01` and onwards.

### 8. Optional: send real emails through Resend

```powershell
$app = aws secretsmanager get-secret-value --secret-id pexa-staging/app --query SecretString --output text | ConvertFrom-Json
$app.RESEND_API_KEY = Read-Host "Resend API key"
$app | ConvertTo-Json -Compress | Set-Content -Encoding ascii .lambda\app-secret.json
aws secretsmanager put-secret-value --secret-id pexa-staging/app --secret-string file://.lambda/app-secret.json
Remove-Item .lambda\app-secret.json
```

Then redeploy (step 4 from `terraform plan`, or push to the `staging` branch). `terraform output email_delivery`
shows `resend` once it is on. Mail goes out from `info@pexerearn.com`, which needs the domain verified in Resend
first (docs/DOMAIN.md, "Email from info@pexerearn.com").

## Custom domain

Staging runs on https://staging.pexerearn.com (DNS at Cloudflare) with the API also on
https://api-staging.pexerearn.com. The two-step certificate setup, the Cloudflare records and settings and the
tests are in [DOMAIN.md](DOMAIN.md).

## Everyday deploys (the pipeline)

```powershell
git push origin HEAD:staging
```

GitHub Actions then runs the checks, `terraform apply` for staging, the migrations (and the seed when
`PEXA_SEED=true`), uploads the pages and runs a smoke test. If `PEXA_PRODUCTION_ENABLED` is `true`, the production
job then waits until a reviewer approves it under **Actions > the run > Review deployments**. **Actions > Deploy > Run
workflow** deploys a chosen environment by hand (production still needs the approval).

During a deploy, the new API code can start a few seconds before its migrations finish; requests in that window
get an error and the next one works. A deploy with a breaking migration should be split in two.

## Testing the full flow with fake money

1. Open the site URL, **Register now**, pick Uganda, use any phone number with `+256`.
2. On **Activate**, choose **Test payment** and submit: with `TEST_AUTO_APPROVE` the account opens at once.
3. Register a second member with the first one's invite link (`/register.html?ref=<username>`), activate it, and
   check the first member's **Balance** shows the UGX 10,000 referral reward.
4. As the first member, **Withdraw** UGX 15,000 or more: it is approved and paid at once (fake payout).
5. Sign in as `superadmin` (step 7) at `/login.html`, open the staff console (`/admin/index.html`) and check the
   deposits, withdrawals, ledger and balance check pages, and the **Email outbox** for sign-in and reset emails.

## Production (live mode)

Owner, 2026-11-01: production runs in **live mode** (real money, LivePay with the fixed IP). Terraform blanks the
test switches (TEST_AUTO_APPROVE, TEST_SUPERADMIN_PASSWORD, the seed passwords) in live mode and refuses to build it
without RESEND_API_KEY and LivePay's keys in the app secret. The paragraph after these steps is the older note.

### Going live

Run from the repository root with `$env:AWS_PROFILE = "Pexerearn"` after `aws sso login --profile Pexerearn`.

1. Build: `npm run build`, then `node infra\scripts\package-lambda.mjs`.
2. Create the app secret only (the live guards need real keys before the rest is built), from
   `infra\terraform\envs\production`: `terraform plan -target=module.pexa.aws_secretsmanager_secret_version.app -out=secret.tfplan`,
   then `terraform apply secret.tfplan`.
3. Keys into `pexa-production/app`: `.\infra\scripts\set-livepay-secret.ps1 -Environment production` (LivePay) and
   RESEND_API_KEY (`aws secretsmanager put-secret-value`, keeping the other keys).
4. Everything else: `terraform plan -out=prod.tfplan`, check it, `terraform apply prod.tfplan`.
5. Pages and database: upload `web` to the `web_bucket` output, invalidate CloudFront, then invoke the migrate
   function with `{"action":"migrate"}`. That stamps the new database **live**, for good.
6. Add the `livepay_fixed_ip` output to LivePay's IP whitelist, and point LivePay's webhook at
   `https://pexerearn.com/api/webhooks/livepay` (a webhook only triggers a status read).
7. `.\infra\scripts\golive.ps1 admin` creates the first admin (once) and shows its authenticator key. Then
   `.\infra\scripts\golive.ps1 sign <item>` for each item of `.\infra\scripts\golive.ps1 status`. The API and jobs
   refuse to start until every item is signed.
8. Sign in to the staff console, set the support contact, payment methods and Uganda's `live_enabled` (every country
   starts closed in live mode).
9. Domain (docs/DOMAIN.md): turn the launch countdown's `domain_live` off, set `custom_domain_live = true` here, plan
   and apply, and point the Cloudflare records at production.

### Older note

Production uses the same code in `infra/terraform/envs/production` (separate state file; deletion protection, 7-day
backups, the balance check every 15 minutes). It is still test mode. To create it, set `PEXA_PRODUCTION_ENABLED=true`
and approve the production job, or run steps 4 to 6 from `infra\terraform\envs\production`. A separate AWS account
for production later needs only a new state bucket and the global stack applied there.

## Removing staging

```powershell
Set-Location infra\terraform\envs\staging
terraform destroy                 # deletes the database and every staging resource
```
