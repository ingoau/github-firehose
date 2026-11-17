// GitHub Firehose: serves the static page and a cached /latest endpoint with the newest public GitHub
// issues (?type=issues, the default) or pull requests (?type=pulls).

// Stale-while-revalidate: responses younger than FRESH_MS are served as-is; older ones (up to MAX_STALE_MS)
// are still served instantly while a background refresh runs. MAX_STALE_MS stays well below the ~40-50s a
// response covers, so the page's playback buffer never has a gap. Only a cold location waits on GitHub.
const FRESH_MS = 10_000;
const MAX_STALE_MS = 30_000;
// The second search starts where the newest-100 search is expected to end, so both can run in parallel.
// That depends on how busy GitHub is, so it's learned from the previous refresh (with a little overlap).
const TYPES = {
  issues: { qualifier: "is:issue", olderThanMs: 25_000, refreshing: null },
  pulls: { qualifier: "is:pr", olderThanMs: 25_000, refreshing: null },
};

const QUERY = `query ($q: String!) {
  search(query: $q, type: ISSUE, first: 100) {
    nodes {
      ... on Issue { id title url createdAt repository { nameWithOwner } }
      ... on PullRequest { id title url createdAt repository { nameWithOwner } }
    }
  }
}`;

async function search(env, q) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "issue-firehose",
    },
    body: JSON.stringify({ query: QUERY, variables: { q } }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors || !json.data) throw new Error(`GitHub ${res.status}`);
  return json.data.search.nodes;
}

// ~200 newest items: the newest 100, plus 100 created before where the first 100 should end, in parallel.
async function fetchLatest(env, type) {
  const t = TYPES[type];
  const now = Date.now();
  const before = new Date(now - t.olderThanMs).toISOString().replace(/\.\d+Z$/, "Z");
  const pages = await Promise.all([
    search(env, `${t.qualifier} sort:created-desc`),
    search(env, `${t.qualifier} sort:created-desc created:<=${before}`),
  ]);
  const firstOldest = Math.min(...pages[0].map((n) => Date.parse(n.createdAt)).filter(Number.isFinite));
  if (Number.isFinite(firstOldest)) t.olderThanMs = Math.min(120_000, Math.max(5_000, now - firstOldest - 2_000));
  const byId = new Map();
  for (const n of pages.flat()) {
    if (n.id) byId.set(n.id, { id: n.id, title: n.title, url: n.url, repo: n.repository.nameWithOwner, createdAt: n.createdAt });
  }
  return [...byId.values()];
}

const cacheKey = (origin, type) => new Request(new URL(`/latest?type=${type}`, origin));

// One in-flight refresh per type (resolves to the JSON body), shared within this isolate.
function refresh(env, origin, type) {
  const t = TYPES[type];
  t.refreshing ??= (async () => {
    const body = JSON.stringify({ issues: await fetchLatest(env, type) });
    // Kept in the edge cache past MAX_STALE_MS; freshness is judged by X-Fetched-At, not max-age.
    await caches.default.put(
      cacheKey(origin, type),
      new Response(body, {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", "X-Fetched-At": String(Date.now()) },
      }),
    );
    return body;
  })().finally(() => (t.refreshing = null));
  return t.refreshing;
}

const json = (body, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== "/latest") return env.ASSETS.fetch(request);

    const type = url.searchParams.get("type") === "pulls" ? "pulls" : "issues";
    const hit = await caches.default.match(cacheKey(url.origin, type));
    const age = hit ? Date.now() - Number(hit.headers.get("X-Fetched-At") || 0) : Infinity;

    if (hit && age < MAX_STALE_MS) {
      if (age >= FRESH_MS) ctx.waitUntil(refresh(env, url.origin, type).catch(() => {}));
      return json(await hit.text());
    }

    try {
      return json(await refresh(env, url.origin, type));
    } catch (e) {
      // GitHub failed: an old copy beats an error.
      if (hit) return json(await hit.text());
      return json(JSON.stringify({ error: e.message }), 502);
    }
  },
};
