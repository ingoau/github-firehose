# Issue Firehose

Every new public issue on GitHub, sliding in as it's created. Live at https://firehose.ingo.au.

A Cloudflare Worker serves a static page and a `/latest` endpoint. The endpoint queries GitHub's GraphQL search for the 200 newest issues (two pages) and caches the result for 10 seconds, so GitHub gets at most two requests per 10 seconds per Cloudflare location, whatever the number of viewers. The page polls `/latest` and replays issues at their real creation times, 25 seconds behind live, so there's always a buffer and no pauses between polls.

## Run locally

```sh
npm install
echo "GITHUB_TOKEN=<token>" > .dev.vars
npm run dev
```

## Deploy

```sh
npx wrangler login
npx wrangler secret put GITHUB_TOKEN
npm run deploy
```

Use a fine-grained personal access token with no extra permissions; searching public issues needs nothing more.
