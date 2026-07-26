# FormKeeper

Simple form backend for static sites. Submit forms, store data in D1, get email notifications, block spam with Turnstile.

```
POST → https://formkeeper.successmove000.workers.dev/api/forms/YOUR_SLUG/submit
```

## Features

- **POST any form data** — JSON or form-encoded, any fields
- **Stored in D1** — all submissions saved with timestamps and IP
- **Dashboard** — view and manage submissions in the browser
- **Turnstile protection** — built-in Cloudflare Turnstile spam filtering
- **Email notifications** — get an email for every submission (requires Cloudflare Email Sending)

## Live Demo

Landing page: https://formkeeper.successmove000.workers.dev
Dashboard: https://formkeeper.successmove000.workers.dev/dashboard

## Quick Start

```bash
# Create a form
curl -X POST https://formkeeper.successmove000.workers.dev/api/forms \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"name":"My Form","slug":"my-form"}'

# Submit data
curl -X POST https://formkeeper.successmove000.workers.dev/api/forms/my-form/submit \
  -H "Content-Type: application/json" \
  -d '{"name":"John","email":"john@example.com","message":"Hello!"}'

# View submissions
curl https://formkeeper.successmove000.workers.dev/api/forms/my-form/submissions \
  -H "x-api-key: YOUR_API_KEY"
```

## Deployment ($20 setup)

Want FormKeeper deployed on your own Cloudflare account? I'll set it up for $20:

- Deploy the Worker on your Cloudflare account
- Create D1 database + KV namespace
- Configure Turnstile + Email Sending
- Set up your custom domain

Payment: USDC / BTC / ETH

## Self-Host

```bash
git clone <repo>
cd formkeeper
npm install
npx wrangler d1 create formkeeper-db
npx wrangler d1 execute formkeeper-db --file=./schema.sql --remote
npx wrangler deploy src/index.ts
```

## Architecture

```
Browser → POST → Cloudflare Worker → D1 (storage)
                                   → Email (notifications)
                                   → Turnstile (validation)
```

Built with Cloudflare Workers, D1, and itty-router.
