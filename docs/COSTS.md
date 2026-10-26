# Pexa AWS costs

Prices checked on **2026-10-26** with the AWS Price List API for **eu-west-1 (Ireland)**, in US dollars, before tax.
Estimates are approximate; the budget alert (USD 30 a month by default) warns before a surprise.

Rule: any resource with a fixed monthly cost is listed here and needs the owner's approval before `terraform apply`.

## Unit prices used

| Service | Price (eu-west-1) |
| --- | --- |
| Aurora Serverless v2, PostgreSQL (Standard) | USD 0.14 per ACU-hour; 0 when paused (minimum 0 ACU) |
| Aurora storage | USD 0.11 per GB-month; I/O USD 0.22 per million requests |
| Aurora backups | Free up to the database size for the retention period (1 day staging, 7 days production) |
| Lambda (ARM64) | USD 0.20 per million requests; USD 0.0000133334 per GB-second (first 1 million requests and 400,000 GB-seconds a month are free) |
| API Gateway HTTP API | USD 1.11 per million requests (first 300 million) |
| CloudFront | Always free: 1 TB out and 10 million requests a month; then about USD 0.085 (Europe) to USD 0.110 (Africa) per GB |
| S3 Standard | About USD 0.023 per GB-month, plus requests (cents at this size) |
| SQS (standard) | USD 0.40 per million requests (first 1 million a month free) |
| Secrets Manager | **USD 0.40 per secret per month** (fixed) |
| CloudWatch Logs | USD 0.57 per GB ingested; USD 0.03 per GB-month stored (14-day retention) |
| CloudWatch alarms | **USD 0.10 per alarm per month** (fixed; the first 10 alarms in an account are free) |
| EventBridge Scheduler | First 14 million invocations a month free |
| CloudTrail | First management-events trail free; S3 storage of the logs only |
| GuardDuty | 30-day free trial; then USD 4.40 per million CloudTrail events, plus small amounts for VPC flow, DNS and Lambda network logs and Aurora sign-in monitoring |
| AWS Budgets | First two budgets free |
| KMS | AWS-managed keys only (free); no customer-managed key (USD 1 a month each) is created |
| NAT gateway, VPC interface endpoints, RDS Proxy | **Not used** (each would cost USD 8 to 35 or more a month even when idle) |

## Fixed monthly costs (need approval before apply)

| Item | Staging | Production | Note |
| --- | --- | --- | --- |
| Secrets Manager: 2 secrets (database, app) | USD 0.80 | USD 0.80 | |
| CloudWatch alarms: 6 per environment | USD 0 to 0.60 | USD 0.60 | 12 alarms in one account: 10 free, 2 paid |
| Aurora storage, about 1 GB | USD 0.11 | USD 0.11+ | grows with data |
| CloudTrail log storage | about USD 0.05 | (shared) | account-wide |
| GuardDuty after the free trial | about USD 1 to 3 | (shared) | account-wide, usage-based |
| **Total fixed** | **about USD 2 to 5 a month** | | |

Aurora compute is not fixed: with a minimum of **0 ACU** the database pauses after 5 idle minutes and costs nothing
while paused. Each scheduled job wakes it. Staging runs the balance check **hourly**, so the database is awake about
6 minutes an hour: about 73 hours at 0.5 ACU, **about USD 5 a month**. At the local worker's 5-minute schedule it
would never pause: about **USD 51 a month** at 0.5 ACU. Production defaults to every 15 minutes (about USD 20 to
25 a month on its own, since it rarely pauses). The schedule is the `reconciliation_schedule` setting.

## Monthly estimates

Assumptions: each active member makes about 50 visits a month with about 40 API calls each (about 2,000 requests
per member); API calls average 200 ms at 1 GB; each request logs about 1 KB.

| | Pilot (about 100 members) | 1,000 members | 10,000 members |
| --- | --- | --- | --- |
| API requests a month | about 0.2 million | about 2 million | about 20 million |
| Aurora compute | USD 5 to 10 (mostly paused) | about USD 67 (awake about 16 hours a day at about 1 ACU) | about USD 205 (always on, about 2 ACU average) |
| Aurora storage and I/O | under USD 1 | about USD 12 | about USD 115 (switch to I/O-Optimized at this point) |
| API Gateway | under USD 0.25 | about USD 2.20 | about USD 22 |
| Lambda | free tier | about USD 0.50 | about USD 52 |
| CloudFront, S3, SQS, Scheduler | free tier | free tier | under USD 5 |
| CloudWatch Logs | under USD 0.20 | about USD 1.20 | about USD 12 |
| Secrets, alarms, CloudTrail, GuardDuty | about USD 2 to 5 | about USD 3 to 6 | about USD 10 to 15 |
| **Estimated total** | **about USD 8 to 16 a month** | **about USD 85 to 95 a month** | **about USD 420 to 440 a month** |

At 10,000 members, consider Aurora I/O-Optimized (USD 0.19 per ACU-hour and USD 0.248 per GB-month, no I/O
charge), a Compute Savings Plan for Lambda, and raising `aurora_max_acu`.

## Not included

- A custom domain (Route 53 hosted zone USD 0.50 a month, plus the domain itself) and its certificate (free).
- Email delivery through Resend (their own pricing; free for low volume).
- Data transfer out of AWS beyond the CloudFront free tier.
- Taxes.
