# Pexa on pexerearn.com (DNS at Cloudflare)

Staging runs on **https://staging.pexerearn.com**, still in test mode with fake money. The API also answers on
**https://api-staging.pexerearn.com** for direct clients (scripts, a future payment provider callback). The root
domain and `www` come later, for production. The temporary links (`https://d2f55xhr5rcirb.cloudfront.net` and the
API Gateway link) keep working until you decide to remove them.

DNS stays at Cloudflare: no Route 53 hosted zone is created.

## How the addresses work

- The browser uses **only** `staging.pexerearn.com`. Pages and `/api/*` both come from there through CloudFront,
  so the app's same-origin design is unchanged: no CORS, host-only `__Host-` session cookies (they can never carry
  a cookie domain, by browser rule), `Secure`, `HttpOnly`, `SameSite`, and the CSRF token. Nothing in the browser
  calls `api-staging.pexerearn.com`, which is why no CORS origins or cookie domain are configured.
- `PUBLIC_ORIGIN` (used for the Origin check and in email links such as password reset) becomes
  `https://staging.pexerearn.com`. `EXTRA_ORIGINS` keeps the CloudFront link accepted, so both work.
  `keep_temporary_links = false` in Terraform stops accepting it later.
- `api-staging.pexerearn.com` is an API Gateway custom domain mapped to the same API (TLS 1.2 or newer).
- **SMS forwarder:** there is none. SMS forwarding and the Android forwarder were removed by the owner (the old
  source is in commit `237980b`), so there is no forwarder contract, no webhook URL and nothing to change on an
  Android phone. If it is ever restored, its webhook would be `https://api-staging.pexerearn.com/...`.

## Cloudflare settings

| Record | Proxy status | Why |
| --- | --- | --- |
| Certificate validation CNAMEs (`_...`) | **DNS only (grey cloud)** | AWS must see the record exactly as published; proxying breaks validation. |
| `staging` CNAME to CloudFront | **DNS only (grey cloud)**, recommended | CloudFront already gives HTTPS (TLS 1.2+), caching and DDoS protection. With the orange cloud, Cloudflare would sit in front of CloudFront: two CDNs caching the same pages, a second TLS hop, and the visitor's real IP address hidden behind Cloudflare's, which would make the app's per-IP sign-in and rate limits count the wrong address (the app trusts exactly two proxies: CloudFront and API Gateway). |
| `api-staging` CNAME to API Gateway | **DNS only (grey cloud)**, recommended | Same reasons; API responses must never be cached. |

**SSL/TLS > Overview: set the encryption mode to Full (strict).** With grey-cloud records the setting does not
touch this traffic (it goes straight to AWS), but it is the safe zone-wide choice: if anyone later switches a record
to the orange cloud, Cloudflare then connects to AWS over HTTPS and checks the certificate. With **Flexible**,
Cloudflare would call AWS over plain HTTP, CloudFront would answer with a redirect to HTTPS, and the browser would
loop forever. If a record is ever proxied, also add a Cloudflare cache rule to bypass the cache for `/api/*` and
`/admin/*`.

If the zone has **CAA** records (DNS > Records, type CAA), add one allowing `amazon.com`, or the certificates
cannot be issued. With no CAA records, nothing is needed.

## Step 1: certificates (first apply)

```powershell
aws sso login --profile Pexerearn
$env:AWS_PROFILE = "Pexerearn"
npm run build; node infra\scripts\package-lambda.mjs
Set-Location infra\terraform\envs\staging
terraform plan -out tfplan        # 2 to add (the certificates), 4 to change (function settings), 0 to destroy
terraform apply tfplan
Remove-Item tfplan
terraform output -raw cloudflare_dns_table
```

**Now add the records.** In Cloudflare, open pexerearn.com > **DNS > Records > Add record** and add each
`Certificate check` row from the table: Type `CNAME`, Name = the NAME column, Target = the VALUE column, Proxy
status **DNS only**, TTL Auto. (Cloudflare shortens the name to the part before `.pexerearn.com`; that is fine.)
Do not add the Site and API rows yet.

**Check that validation passed** (usually 5 to 30 minutes after the records are added):

```powershell
$certs = terraform output -json certificate_status | ConvertFrom-Json
aws acm describe-certificate --region us-east-1 --certificate-arn $certs.site --query Certificate.Status --output text
aws acm describe-certificate --region eu-west-1 --certificate-arn $certs.api  --query Certificate.Status --output text
```

Both must print `ISSUED` (`PENDING_VALIDATION` means wait or check the records). To see the record from the
internet: `Resolve-DnsName <NAME from the table> -Type CNAME -Server 1.1.1.1`.

## Step 2: attach the domains (second apply)

1. In `infra/terraform/envs/staging/main.tf` set `custom_domain_live = true` and commit it (the pipeline reads the
   same file, so it keeps the domains on).
2. Apply:

```powershell
Set-Location infra\terraform\envs\staging
terraform plan -out tfplan        # adds the validations, the API custom domain and mapping; updates CloudFront and the functions
terraform apply tfplan            # CloudFront takes a few minutes
Remove-Item tfplan
terraform output -raw cloudflare_dns_table
```

3. In Cloudflare add the two remaining rows, both **DNS only**:
   - Name `staging`, Type `CNAME`, Target `d2f55xhr5rcirb.cloudfront.net`
   - Name `api-staging`, Type `CNAME`, Target the API row's VALUE (`d-xxxxxxxxxx.execute-api.eu-west-1.amazonaws.com`)

## Test on the new addresses (fake money)

```powershell
Invoke-RestMethod https://staging.pexerearn.com/readyz          # {"status":"ready","mode":"test"}
Invoke-RestMethod https://api-staging.pexerearn.com/healthz     # {"status":"ok"}
Invoke-RestMethod https://api-staging.pexerearn.com/api/meta    # testMode: true
Start-Process https://staging.pexerearn.com
```

Then in the browser: register in Uganda, activate with **Test payment**, invite two members with your link
(`https://staging.pexerearn.com/register.html?ref=<username>`), activate them, check the UGX 20,000 balance and
withdraw UGX 15,000 (paid at once, fake). Ask for a password reset: the link in the email (or the staff Email
outbox) now starts with `https://staging.pexerearn.com`. The CloudFront link still works for all of this.

## Removing the temporary links later

Set `keep_temporary_links = false` on the module in `envs/staging/main.tf` and apply: the app then refuses
state-changing requests from the CloudFront link (pages there still load, but sign-in does not). The API Gateway
link can be switched off with `disable_execute_api_endpoint` once nothing uses it.
