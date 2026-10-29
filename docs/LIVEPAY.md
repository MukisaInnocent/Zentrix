# LivePay

How Pexerearn uses LivePay (livepay.me, API docs at docs.livepay.me) to collect activation fees and send withdrawals. Decision D29 in `docs/PLAN.md`; built on branch `feat/livepay`.

## What it does

- **Activation fee.** On the activation page the member picks the LivePay method, enters the MTN or Airtel number to pay from, and approves the prompt on that phone. When LivePay confirms, the account opens and referral rewards are paid, through the same steps staff use for a manual confirmation. The system account `zx_livepay` records it.
- **Withdrawals.** Staff approve as today. On an approved withdrawal, **Send with LivePay** sends the money; the result is recorded by itself (paid, or failed with the hold returned). **Pay by hand** is still there.
- **Manual methods stay** for countries LivePay does not cover, as a fallback, and when LivePay is busy.

## Safety rules built in

- Money moves only when Pexerearn reads the payment's status back from LivePay and the amount and currency match. A webhook only asks for that read, because LivePay's webhook signature does not cover the amount.
- A mismatch, a status word we do not know, a request with no answer after a day, or a success the ledger cannot record goes to **review**: an alert appears in the staff console and staff settle it with the usual buttons after checking the LivePay dashboard.
- While LivePay is handling a payment, staff cannot settle it by hand and the member cannot cancel it.
- Before a payout is sent, the ledger must show enough money held on the LivePay method.
- A payout is never failed automatically on "missing" or on a refusal alone (it might be a retry of one LivePay is paying): it goes to review. On AWS a collection or payout command older than 5 minutes is never sent. A result that contradicts a closed request (paid after we gave up) raises a critical alert.
- Prompts go only to the member's registered number, at most 5 failed prompts a day per member, and the rate budget is counted under a lock.
- LivePay's charge on each payment is recorded as `provider_charge` from platform revenue, so the ledger matches the LivePay wallet. `TODO(owner)`: should members pay it instead?
- Rate limits: Pexerearn stays within LivePay's 50 collections and status checks per 15 minutes and 5 payouts a minute. When the limit is reached, members see "busy, try again or use another method".

## Test mode

LivePay has **no sandbox**: its docs say every test uses live credentials and moves real money. So:

- Test mode uses a simulator (`PAYMENT_PROVIDER=simulator`, the default in test mode). A phone number ending in `000` is declined; any other number succeeds at once.
- LivePay's keys are named `LIVEPAY_LIVE_API_KEY` and `LIVEPAY_LIVE_WEBHOOK_SECRET`; test mode refuses to start while they are set.
- To try it locally: in the staff console, open Payment methods, Add method, choose **LivePay** for Uganda, then activate a member.

## Staging trial (owner, 2026-10-30)

The owner wants to try real LivePay on staging first. Staging stays in test mode, but `livepay_trial = true` (in `infra/terraform/envs/staging/main.tf`) lets LivePay's keys load there, so **LivePay payments on staging move real money**. The activation page shows a warning while the trial is on. No other live-only key is allowed, and live mode refuses the switch.

1. In the LivePay dashboard, set the webhook URL to exactly `https://staging.pexerearn.com/api/webhooks/livepay`. LivePay signs the URL, so any other address fails the signature check.
2. `aws sso login --profile Pexerearn`, then `.\infra\scripts\set-livepay-secret.ps1`. It asks for the account number, API key and webhook secret without showing them, and adds them to `pexa-staging/app`.
3. Deploy: push to the `staging` branch. Terraform stops with a clear message if the keys are missing.
4. On staging, staff console, Payment methods, Add method: Uganda, How members pay = LivePay, account number = your LivePay account number.
5. Register a member with **your own phone number** (prompts go only to the registered number), activate with a LivePay prompt, and watch it in the staff console. Then try a small payout.
6. To stop the trial: set `livepay_enabled` and `livepay_trial` to false and deploy again.

## Going live

1. In the LivePay dashboard: verify the business account, create the API key, and set the webhook URL to `https://pexerearn.com/api/webhooks/livepay` (or whatever site address production uses). Note the webhook secret and the account number (LP...).
2. IP whitelisting is not required (owner, 2026-10-30), so no NAT gateway is needed. Still ask LivePay (WhatsApp +256 763 233 480): what is the full list of status values? Can the rate limits be raised? What are the minimum and maximum amounts and the fees? Which licensed operator do they work with?
3. Put the secrets in the production secret (Secrets Manager): `LIVEPAY_LIVE_API_KEY`, `LIVEPAY_LIVE_WEBHOOK_SECRET`, `LIVEPAY_ACCOUNT_NUMBER`. Never in git or chat. A key that was ever pasted into a chat or email must be regenerated first.
4. Live mode itself needs the go-live checklist. Then set `livepay_enabled = true` in Terraform (its check refuses it until live mode can be deployed) and apply with the owner's approval. This creates the `paygate` function, its queue and alarm, and the `payments` polling schedule.
5. In the staff console, add the LivePay method for Uganda. Record the LivePay wallet balance as the method's statement on the Balances page, then make one small real payment and one small payout and check them on the LivePay dashboard. Check that the phone number format (+256...) is accepted.

## Where the code is

| Part | File |
|---|---|
| LivePay client, signature check, simulator, gateways | `server/src/providers/livepay.ts` |
| Start collections and payouts, apply results, webhook, polling | `server/src/modules/payments/provider.ts` |
| Tables `provider_requests`, `provider_calls`, `provider_webhook_events` | `server/migrations/0022_payment_provider.sql` |
| AWS function outside the VPC | `server/src/lambda/paygate.ts`, `infra/terraform/modules/pexa/paygate.tf` |
| Tests | `server/test/unit/livepay.test.ts`, `server/test/integration/livepay.test.ts` |

Not built yet: non-UGX currencies (LivePay needs the network for KES, GHS and XAF), reading the LivePay balance automatically into the balance check, and checking the registered name on a payout number (LivePay's validate-number).
