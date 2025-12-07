import type {
  FetchBatchRequest,
  FetchBatchResponse,
  LinkFetchResult,
} from "../types";

const TRACKING_DOMAINS = [
  "links.message.bloomberg.com",
  "bloom.bg",
  "sli.bloomberg.com",
];

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

export async function handleFetchBatch(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as FetchBatchRequest;
    const results = await processBatch(body);
    return Response.json(results);
  } catch (e) {
    console.error("Fetcher error:", e);
    return Response.json({ results: [], error: String(e) }, { status: 500 });
  }
}

async function processBatch(
  batch: FetchBatchRequest
): Promise<FetchBatchResponse> {
  const results: LinkFetchResult[] = [];

  for (const item of batch.items) {
    const result: LinkFetchResult = {
      originalUrl: item.url,
      resolvedUrl: item.url,
    };

    try {
      // Step 1: Resolve tracking URL
      result.resolvedUrl = await resolveTrackingUrl(item.url);
      result.favicon = getFaviconUrl(result.resolvedUrl);

      // Step 2: For paywalled URLs, fetch summary + archive in parallel
      const isPaywalled = isPaywalledUrl(result.resolvedUrl);
      if (isPaywalled && batch.perplexityApiKey) {
        const [summary, archiveUrl] = await Promise.all([
          getPerplexitySummary(result.resolvedUrl, batch.perplexityApiKey),
          getArchiveUrl(result.resolvedUrl),
        ]);
        result.summary = summary;
        result.archiveUrl = archiveUrl;
      }

      // Step 3: Fetch OG image if requested
      if (item.fetchOgImage) {
        result.ogImage = await fetchOgImage(result.resolvedUrl);
      }
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
    const hostname = new URL(url).hostname.toLowerCase();
    const isTracking = TRACKING_DOMAINS.some((d) => hostname.includes(d));
    if (!isTracking) return url;

    const response = await fetch(url, { method: "HEAD", redirect: "manual" });
    const location = response.headers.get("location");

    if (location) {
      const resolved = location.startsWith("/")
        ? new URL(location, url).href
        : location;
      return resolveTrackingUrl(resolved, depth + 1);
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

function getFaviconUrl(url: string): string {
  try {
    const domain = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
  } catch {
    return "";
  }
}

async function getPerplexitySummary(
  url: string,
  apiKey: string
): Promise<string | undefined> {
  try {
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
            content: `Search for and summarize the news article at this URL: ${url}`,
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
