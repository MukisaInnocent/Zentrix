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
   EventBridge Scheduler ──> Lambda jobs (balance check hourly, clean-up daily)
```

- One code package, four functions (ARM64): `api` (the Express app through serverless-http), `jobs`,
  `migrate` (migrations and test seed, run by the pipeline) and `mailer`. Locally the same app still runs with
  `npm run dev` as a normal Node server.
- All money data stays in Aurora PostgreSQL (no DynamoDB).
- Secrets live in Secrets Manager (`pexa-<env>/database`, `pexa-<env>/app`). The functions in the VPC have no route
  to Secrets Manager (no NAT or paid endpoints, by decision), so Terraform reads the values at deploy time and sets
  them as Lambda environment variables, which Lambda encrypts at rest. **Changing a secret needs a redeploy.**
- Without a Resend key, emails (sign-in codes, reset links) are kept on the staff **Email outbox** page.
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
shows `resend` once it is on. Without a verified Resend domain, mail goes only to your Resend account's address.

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

## Production (later)

Production uses the same code in `infra/terraform/envs/production` (separate state file; deletion protection, 7-day
backups, the balance check every 15 minutes). It is still test mode. To create it, set `PEXA_PRODUCTION_ENABLED=true`
and approve the production job, or run steps 4 to 6 from `infra\terraform\envs\production`. A separate AWS account
for production later needs only a new state bucket and the global stack applied there.

## Removing staging

```powershell
Set-Location infra\terraform\envs\staging
terraform destroy                 # deletes the database and every staging resource
```
