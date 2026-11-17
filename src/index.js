// Issue Firehose: serves the static page and a cached /latest endpoint with the newest public GitHub issues.
const CACHE_SECONDS = 10;

const QUERY = `{ search(query: "is:issue sort:created-desc", type: ISSUE, first: 100) {
  nodes { ... on Issue { id title url repository { nameWithOwner } } }
} }`;

async function fetchLatest(env) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "issue-firehose",
    },
    body: JSON.stringify({ query: QUERY }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors || !json.data) throw new Error(`GitHub ${res.status}`);
  return json.data.search.nodes
    .filter((n) => n.id)
    .map((n) => ({ id: n.id, title: n.title, url: n.url, repo: n.repository.nameWithOwner }));
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
