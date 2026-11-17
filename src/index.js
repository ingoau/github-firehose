// Issue Firehose: serves the static page and a cached /latest endpoint with the newest public GitHub issues.
const CACHE_SECONDS = 10;
const PAGES = 2; // 2 x 100 issues ≈ 50s of history, enough for an intro screenful plus a playback buffer

const QUERY = `query ($after: String) {
  search(query: "is:issue sort:created-desc", type: ISSUE, first: 100, after: $after) {
    pageInfo { endCursor hasNextPage }
    nodes { ... on Issue { id title url createdAt repository { nameWithOwner } } }
  }
}`;

async function fetchPage(env, after) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "issue-firehose",
    },
    body: JSON.stringify({ query: QUERY, variables: { after } }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors || !json.data) throw new Error(`GitHub ${res.status}`);
  return json.data.search;
}

async function fetchLatest(env) {
  const byId = new Map();
  let after = null;
  for (let page = 0; page < PAGES; page++) {
    const { nodes, pageInfo } = await fetchPage(env, after);
    for (const n of nodes) {
      if (n.id) byId.set(n.id, { id: n.id, title: n.title, url: n.url, repo: n.repository.nameWithOwner, createdAt: n.createdAt });
    }
    if (!pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
  }
  return [...byId.values()];
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== "/latest") return env.ASSETS.fetch(request);

    // One GitHub request per cache window (per Cloudflare location), however many viewers there are.
    const cache = caches.default;
    const key = new Request(new URL("/latest", url.origin));
    const hit = await cache.match(key);
    if (hit) return hit;

    try {
      const issues = await fetchLatest(env);
      const res = new Response(JSON.stringify({ issues }), {
        headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_SECONDS}` },
      });
      ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
  },
};
