# FormKeeper

Simple form backend for static sites. Submit forms, store data in D1, get email notifications, block spam with Turnstile.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/TheForgivenOne/formkeeper)

## Deploy in Seconds

Click the button above to deploy FormKeeper to your own Cloudflare account — free tier, no credit card required.

Self-hosted: you control the data, the API keys, the domain.

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

## Need Help Deploying?

Want FormKeeper deployed on your own Cloudflare account with a custom domain, Turnstile, and email notifications? I'll set it up for **$20** — email: successmove000@gmail.com

## Self-Host (Manual)

```bash
git clone https://github.com/TheForgivenOne/formkeeper
cd formkeeper
npm install
npx wrangler d1 create formkeeper-db
npx wrangler d1 execute formkeeper-db --file=./schema.sql --remote
npx wrangler kv:namespace create FORMS_KV
npx wrangler deploy
```

## Architecture

```
Browser → POST → Cloudflare Worker → D1 (storage)
                                   → Email (notifications)
                                   → Turnstile (validation)
```

Built with Cloudflare Workers, D1, KV, and itty-router.
