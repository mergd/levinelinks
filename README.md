# Levine Links

Matt Levine's Money Stuff newsletter, enhanced with AI summaries for article links.

**Live at [levine.yet-to-be.com](https://levine.yet-to-be.com)**

## What it does

1. Receives Matt Levine's newsletter via email
2. Extracts all links and resolves tracking URLs
3. Fetches article pages directly, strips boilerplate, and summarizes them with a cheap OpenRouter model
4. Falls back to Perplexity when direct extraction fails or the page is blocked
5. Finds archived versions on archive.is
6. Injects summaries inline with expandable previews
7. Sends enhanced version to subscribers
8. Hosts web archive of all issues

## Stack

- **Cloudflare Workers** - Edge compute
- **Cloudflare D1** - SQLite database (subscribers + newsletter archive)
- **Cloudflare Email Workers** - Inbound email handling
- **Resend** - Outbound email delivery
- **OpenRouter** - Low-cost article summarization from fetched page content
- **Perplexity API** - Fallback summarization for blocked/paywalled pages

## Setup

### 1. Clone and install

```bash
git clone https://github.com/fldr-zip/levinelinks
cd levinelinks
bun install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your API keys
```

For deployed Workers, also set runtime secrets/vars:

```bash
wrangler secret put RESEND_API_KEY
wrangler secret put OPENROUTER_API_KEY
wrangler secret put PERPLEXITY_API_KEY
wrangler secret put SEED_EMAIL
```

### 3. Create Cloudflare resources

```bash
# Create D1 database
wrangler d1 create levinelinks-db

# Update wrangler.toml with the IDs from above
```

### 4. Run migrations

```bash
bun run db:migrate:local   # Local dev
bun run db:migrate:prod    # Production
```

### 5. Deploy

```bash
wrangler deploy
```

### 6. Configure email routing

In Cloudflare Dashboard:

1. Go to **Email** → **Email Routing**
2. Add your domain (e.g., `yet-to-be.com`)
3. Create a **Catch-all** rule → Route to **Worker** → `levinelinks`

### 7. Configure Resend

1. Add your domain in Resend dashboard
2. Set up DNS records (SPF, DKIM, DMARC)
3. Verify domain

## Seeding the archive

To backfill with previous newsletters:

1. Set `SEED_EMAIL` in `.env` to your email
2. Forward old Money Stuff emails to `inbox@yet-to-be.com`
3. They'll be processed and stored without sending to subscribers

## Local development

```bash
bun run dev
```

This starts the worker locally at `http://localhost:8787`

## Scripts

```bash
bun run test-parser     # Test link extraction
bun run test-wrap       # Test newsletter wrapping (uses LIMIT env var)
```

## Environment variables

| Variable               | Description                          |
| ---------------------- | ------------------------------------ |
| `OPENROUTER_API_KEY`   | OpenRouter API key for direct summaries |
| `PERPLEXITY_API_KEY`   | Perplexity fallback for blocked articles |
| `RESEND_API_KEY`       | Resend API key for sending emails    |
| `CLOUDFLARE_API_TOKEN` | CF API token (for wrangler)          |
| `SEED_EMAIL`           | Your email for forwarding old issues |
| `SITE_URL`             | Public site URL (set in `wrangler.toml`) |
| `EMAIL_DOMAIN`         | Sender domain for Resend (set in `wrangler.toml`) |

## License

MIT
