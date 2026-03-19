import type {
  Env,
  FetchBatchRequest,
  FetchBatchResponse,
  LinkFetchResult,
} from "../types";
import { LEVINE_AVATAR_DATA_URI } from "../assets/levine-avatar";

const TRACKING_DOMAINS = [
  "links.message.bloomberg.com",
  "bloom.bg",
  "sli.bloomberg.com",
];

const BLOOMBERG_NEWSLETTER_PATTERN = /bloomberg\.com\/opinion\/newsletters\//i;
const LINK_CACHE_PREFIX = "cache:link:v1:";
const LINK_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;

const PAYWALLED_DOMAINS = [
  "wsj.com",
  "nytimes.com",
  "ft.com",
  "economist.com",
  "washingtonpost.com",
  "bloomberg.com",
  "barrons.com",
  "theatlantic.com",
  "newyorker.com",
  "hbr.org",
  "businessinsider.com",
  "reuters.com",
  "theinformation.com",
  "stratechery.com",
];

interface CachedLinkResult {
  resolvedUrl: string;
  favicon?: string;
  summary?: string;
  archiveUrl?: string;
  ogImage?: string;
}

export async function handleFetchBatch(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = (await request.json()) as FetchBatchRequest;
    const results = await processBatch(body, env);
    return Response.json(results);
  } catch (e) {
    console.error("Fetcher error:", e);
    return Response.json({ results: [], error: String(e) }, { status: 500 });
  }
}

async function processBatch(
  batch: FetchBatchRequest,
  env: Env
): Promise<FetchBatchResponse> {
  const results: LinkFetchResult[] = [];

  for (const item of batch.items) {
    const cachedByOriginal = await getCachedLinkResult(env, item.url);
    if (
      cachedByOriginal &&
      !isTrackingUrl(cachedByOriginal.resolvedUrl) &&
      (!item.fetchOgImage || cachedByOriginal.ogImage)
    ) {
      results.push(buildResultFromCache(item.url, cachedByOriginal));
      continue;
    }

    const result: LinkFetchResult = {
      originalUrl: item.url,
      resolvedUrl: item.url,
    };

    try {
      // Step 1: Resolve tracking URL
      result.resolvedUrl = await resolveTrackingUrl(item.url);

      if (
        result.resolvedUrl !== item.url &&
        !isTrackingUrl(result.resolvedUrl)
      ) {
        const cachedByResolved = await getCachedLinkResult(env, result.resolvedUrl);
        if (
          cachedByResolved &&
          !isTrackingUrl(cachedByResolved.resolvedUrl) &&
          (!item.fetchOgImage || cachedByResolved.ogImage)
        ) {
          await cacheLinkResult(env, item.url, cachedByResolved);
          results.push(buildResultFromCache(item.url, cachedByResolved));
          continue;
        }
      }

      result.favicon = getFaviconUrl(result.resolvedUrl);

      const isNewsletter = isBloombergNewsletterUrl(result.resolvedUrl);
      const isPaywalled = isPaywalledUrl(result.resolvedUrl);

      if (isPaywalled && !isNewsletter && batch.perplexityApiKey) {
        const [summary, archiveUrl] = await Promise.all([
          getPerplexitySummary(result.resolvedUrl, batch.perplexityApiKey, item.text),
          getArchiveUrl(result.resolvedUrl),
        ]);
        result.summary = summary;
        result.archiveUrl = archiveUrl;
      }

      // Step 3: Fetch OG image if requested
      if (item.fetchOgImage) {
        result.ogImage = await fetchOgImage(result.resolvedUrl);
      }

      await cacheResultAliases(env, result);
    } catch (e) {
      console.error(`Error processing ${item.url}:`, e);
    }

    results.push(result);
  }

  return { results };
}

async function resolveTrackingUrl(url: string, depth = 0): Promise<string> {
  if (depth > 5) return url;

  try {
    const isTracking = isTrackingUrl(url);
    if (!isTracking && depth === 0) return url;

    const response = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
    });
    const location = response.headers.get("location");

    if (location) {
      const resolved = absolutizeUrl(location, url);
      return resolveTrackingUrl(resolved, depth + 1);
    }

    if (isTracking && !location) {
      const directTarget = extractDirectTarget(url);
      if (directTarget) {
        return resolveTrackingUrl(directTarget, depth + 1);
      }

      const getResponse = await fetch(url, {
        redirect: "manual",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          Accept: "text/html,application/xhtml+xml",
        },
      });
      const getLocation = getResponse.headers.get("location");
      if (getLocation) {
        const resolved = absolutizeUrl(getLocation, url);
        return resolveTrackingUrl(resolved, depth + 1);
      }

      const body = await getResponse.text();
      const extractedTarget = extractUrlFromHtml(body, url);
      if (extractedTarget) {
        return resolveTrackingUrl(extractedTarget, depth + 1);
      }
    }

    return url;
  } catch {
    return url;
  }
}

function isPaywalledUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return PAYWALLED_DOMAINS.some((d) => hostname.includes(d));
  } catch {
    return false;
  }
}

function isTrackingUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return TRACKING_DOMAINS.some((d) => hostname.includes(d));
  } catch {
    return false;
  }
}

function isBloombergNewsletterUrl(url: string): boolean {
  return BLOOMBERG_NEWSLETTER_PATTERN.test(url);
}

function absolutizeUrl(url: string, baseUrl: string): string {
  return url.startsWith("/") ? new URL(url, baseUrl).href : url;
}

function extractDirectTarget(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const candidates = ["url", "u", "target", "dest", "destination", "redirect"];

    for (const key of candidates) {
      const value = parsed.searchParams.get(key);
      if (value?.startsWith("http://") || value?.startsWith("https://")) {
        return value;
      }
    }
  } catch {
    return undefined;
  }
}

function extractUrlFromHtml(html: string, baseUrl: string): string | undefined {
  const metaRefreshMatch = html.match(
    /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"';>]+)["']/i
  );
  if (metaRefreshMatch?.[1]) {
    return absolutizeUrl(metaRefreshMatch[1], baseUrl);
  }

  const canonicalMatch =
    html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i);
  if (canonicalMatch?.[1]) {
    return absolutizeUrl(canonicalMatch[1], baseUrl);
  }

  const locationMatch = html.match(
    /(?:window\.location(?:\.href)?|location\.replace)\s*=\s*["']([^"']+)["']/i
  );
  if (locationMatch?.[1]) {
    return absolutizeUrl(locationMatch[1], baseUrl);
  }
}

function getFaviconUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (isBloombergNewsletterUrl(url)) {
      return LEVINE_AVATAR_DATA_URI;
    }
    const domain = parsed.hostname;
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
  } catch {
    return "";
  }
}

function buildResultFromCache(
  originalUrl: string,
  cached: CachedLinkResult
): LinkFetchResult {
  return {
    originalUrl,
    resolvedUrl: cached.resolvedUrl,
    favicon: cached.favicon,
    summary: cached.summary,
    archiveUrl: cached.archiveUrl,
    ogImage: cached.ogImage,
  };
}

async function getCachedLinkResult(
  env: Env,
  url: string
): Promise<CachedLinkResult | null> {
  try {
    const cacheKey = await getLinkCacheKey(url);
    const cached = await env.NEWSLETTERS.get(cacheKey, "json");
    return (cached as CachedLinkResult | null) ?? null;
  } catch {
    return null;
  }
}

async function cacheResultAliases(env: Env, result: LinkFetchResult): Promise<void> {
  const cached: CachedLinkResult = {
    resolvedUrl: result.resolvedUrl,
    favicon: result.favicon,
    summary: result.summary,
    archiveUrl: result.archiveUrl,
    ogImage: result.ogImage,
  };

  await Promise.all([
    cacheLinkResult(env, result.originalUrl, cached),
    result.resolvedUrl !== result.originalUrl
      ? cacheLinkResult(env, result.resolvedUrl, cached)
      : Promise.resolve(),
  ]);
}

async function cacheLinkResult(
  env: Env,
  url: string,
  cached: CachedLinkResult
): Promise<void> {
  try {
    const cacheKey = await getLinkCacheKey(url);
    await env.NEWSLETTERS.put(cacheKey, JSON.stringify(cached), {
      expirationTtl: LINK_CACHE_TTL_SECONDS,
    });
  } catch {
    // Cache failures should never block newsletter processing.
  }
}

async function getLinkCacheKey(url: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(url)
  );
  const bytes = Array.from(new Uint8Array(digest));
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${LINK_CACHE_PREFIX}${hex}`;
}

async function getPerplexitySummary(
  url: string,
  apiKey: string,
  articleTitle?: string
): Promise<string | undefined> {
  try {
    const userPrompt = buildSummaryPrompt(url, articleTitle);

    const response = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          {
            role: "system",
            content:
              "You search the web to find and summarize news articles. Provide a 2-3 sentence summary of the key points. Be factual and concise.",
          },
          {
            role: "user",
            content: userPrompt,
          },
        ],
        max_tokens: 250,
      }),
    });

    if (!response.ok) return undefined;

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = data.choices[0]?.message?.content;

    if (!content || content.length < 30) return undefined;

    const lower = content.toLowerCase();
    const badPhrases = [
      "unable to",
      "cannot access",
      "i don't have",
      "no news article available",
      "i cannot",
      "i'm unable",
      "not available",
      "page not found",
      "access denied",
    ];

    if (badPhrases.some((p) => lower.includes(p))) return undefined;

    // Clean up intro phrases and citations
    return content
      .replace(
        /^The (article|piece|report|story|post|blog)( from [^.]+)? (discusses|explains|covers|details|examines|explores|highlights|reports|describes|analyzes)/i,
        ""
      )
      .replace(
        /^This (article|piece|report|story|post|blog) (discusses|explains|covers|details|examines|explores|highlights|reports|describes|analyzes)/i,
        ""
      )
      .replace(/\[\d+\]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^./, (c) => c.toUpperCase());
  } catch {
    return undefined;
  }
}

function buildSummaryPrompt(url: string, articleTitle?: string): string {
  const safeTitle = articleTitle?.trim();
  const slugHint = getArticleSlugHint(url);

  if (isBloombergArticleUrl(url)) {
    if (safeTitle && safeTitle.length >= 10) {
      return `Search for and summarize the Bloomberg article titled "${safeTitle}" (URL: ${url}). Bloomberg article pages may return a robot check, so do not rely on directly opening the page. Use the title${slugHint ? ` and URL slug "${slugHint}"` : ""} to identify the correct article and summarize it.`;
    }

    if (slugHint) {
      return `Search for and summarize the Bloomberg article matching this URL: ${url}. Bloomberg article pages may return a robot check, so use the URL slug "${slugHint}" to identify the correct article and summarize it.`;
    }
  }

  if (safeTitle && safeTitle.length >= 10) {
    return `Search for and summarize this news article titled "${safeTitle}" (URL: ${url}). Use the title to find the actual article content if the URL is paywalled.`;
  }

  return `Search for and summarize the news article at this URL: ${url}`;
}

function isBloombergArticleUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.includes("bloomberg.com") &&
      /\/(news|opinion|features|graphics|businessweek|quote|live)\//.test(
        parsed.pathname
      )
    );
  } catch {
    return false;
  }
}

function getArticleSlugHint(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const slug = segments.at(-1);
    if (!slug) return undefined;

    return slug
      .replace(/[-_]+/g, " ")
      .replace(/\.(html?)$/i, "")
      .trim();
  } catch {
    return undefined;
  }
}

async function getArchiveUrl(url: string): Promise<string | undefined> {
  try {
    const searchUrl = `https://archive.today/newest/${encodeURIComponent(url)}`;
    const response = await fetch(searchUrl, {
      method: "HEAD",
      redirect: "manual",
    });

    const location = response.headers.get("location");
    if (location && /archive\.(is|today|ph|md)\/\w+/.test(location)) {
      return location;
    }

    if (response.status === 200) {
      const finalUrl = response.url;
      if (
        /archive\.(is|today|ph|md)\/\w+/.test(finalUrl) &&
        !finalUrl.includes("/newest/")
      ) {
        return finalUrl;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function fetchOgImage(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });

    if (!response.ok) return undefined;

    const html = await response.text();

    const ogMatch =
      html.match(
        /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i
      ) ||
      html.match(
        /<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i
      );

    if (ogMatch?.[1]) return ogMatch[1];

    const twMatch =
      html.match(
        /<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i
      ) ||
      html.match(
        /<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i
      );

    return twMatch?.[1];
  } catch {
    return undefined;
  }
}


