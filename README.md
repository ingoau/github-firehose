# GitHub Firehose

Every new public issue and pull request on GitHub, sliding in as it's created. Live at https://firehose.ingo.au ([issues](https://firehose.ingo.au/), [pull requests](https://firehose.ingo.au/pulls)).

A Cloudflare Worker serves a static page and a `/latest?type=issues|pulls` endpoint. The endpoint runs two GitHub GraphQL searches in parallel (the newest 100, and the 100 before those) to get roughly the last 40-50 seconds of new issues or pull requests.

Each type of `/latest` is cached separately at the edge with stale-while-revalidate: a copy up to 10 seconds old is served as-is, and one up to 30 seconds old is still served instantly while a fresh one is fetched in the background. Only the first visitor to a quiet Cloudflare location waits on GitHub (~4 seconds); an open page polls every 8 seconds, which keeps its location warm.

The page picks the feed from its path (`/` or `/pulls`) and replays items at their real creation times, 25 seconds behind live, so there's always a buffer and no pauses between polls.

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

Use a fine-grained personal access token with no extra permissions; searching public issues and pull requests needs nothing more.
