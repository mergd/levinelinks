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

export const FREE_MODEL_NAME = "openrouter/free";
export const FALLBACK_MODEL_NAME = "qwen/qwen3.8-max";
export const SEARCH_MODEL_NAME = "perplexity/sonar";
const MIN_ARTICLE_TEXT_LENGTH = 600;
const MAX_ARTICLE_TEXT_LENGTH = 12000;
const BLOCKED_PAGE_PATTERNS = [
  /captcha/i,
  /verify you are human/i,
  /robot check/i,
  /access denied/i,
  /enable javascript/i,
  /subscribe to continue/i,
  /sign in to continue/i,
];
const BOILERPLATE_LINE_PATTERNS = [
  /^advertisement$/i,
  /^ad$/i,
  /^cookie policy$/i,
  /^privacy policy$/i,
  /^terms of service$/i,
  /^sign in$/i,
  /^subscribe$/i,
  /^skip to content$/i,
  /^continue reading$/i,
  /^all rights reserved$/i,
];

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
  const openRouterApiKey = batch.openRouterApiKey || env.OPENROUTER_API_KEY;

  for (const item of batch.items) {
    const result: LinkFetchResult = {
      originalUrl: item.url,
      resolvedUrl: item.url,
    };

    try {
      // Step 1: Resolve tracking URL
      result.resolvedUrl = await resolveTrackingUrl(item.url);

      result.favicon = getFaviconUrl(result.resolvedUrl);

      const isNewsletter = isBloombergNewsletterUrl(result.resolvedUrl);
      const isPaywalled = isPaywalledUrl(result.resolvedUrl);

      const shouldFetchSummary =
        !isNewsletter &&
        (isPaywalled || !!item.forceSummary) &&
        !!openRouterApiKey;

      if (shouldFetchSummary) {
        const [summary, archiveUrl] = await Promise.all([
          getPreferredSummary(
            result.resolvedUrl,
            openRouterApiKey,
            item.summaryContext || item.text,
            isPaywalled
          ),
          isPaywalled ? getArchiveUrl(result.resolvedUrl) : Promise.resolve(undefined),
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

async function getPreferredSummary(
  url: string,
  openRouterApiKey: string,
  articleHint?: string,
  isPaywalled?: boolean
): Promise<string | undefined> {
  const articleText = await fetchArticleText(url, isPaywalled);
  if (articleText) {
    const directSummary = await getOpenRouterSummary(
      url,
      articleText,
      openRouterApiKey,
      articleHint
    );
    if (directSummary) return directSummary;
  }

  return getOpenRouterSearchSummary(url, openRouterApiKey, articleHint);
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

async function fetchArticleText(
  url: string,
  isPaywalled?: boolean
): Promise<string | undefined> {
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

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      return undefined;
    }

    const html = await response.text();
    if (BLOCKED_PAGE_PATTERNS.some((pattern) => pattern.test(html))) {
      return undefined;
    }

    const articleText = extractArticleText(html);
    if (!articleText) return undefined;

    if (isPaywalled && articleText.length < MIN_ARTICLE_TEXT_LENGTH) {
      return undefined;
    }

    return articleText;
  } catch {
    return undefined;
  }
}

function extractArticleText(html: string): string | undefined {
  const jsonLdBody = extractJsonLdArticleBody(html);
  if (jsonLdBody && jsonLdBody.length >= MIN_ARTICLE_TEXT_LENGTH) {
    return jsonLdBody.slice(0, MAX_ARTICLE_TEXT_LENGTH);
  }

  const cleanedHtml = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(svg|iframe|footer|nav|aside|form|button)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const candidates = [
    ...extractCandidateTexts(cleanedHtml, /<article\b[^>]*>([\s\S]*?)<\/article>/gi),
    ...extractCandidateTexts(cleanedHtml, /<main\b[^>]*>([\s\S]*?)<\/main>/gi),
  ];

  const paragraphText = htmlToText((cleanedHtml.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || []).join("\n"));
  if (paragraphText) {
    candidates.push(paragraphText);
  }

  const bodyMatch = cleanedHtml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch?.[1]) {
    const bodyText = htmlToText(bodyMatch[1]);
    if (bodyText) {
      candidates.push(bodyText);
    }
  }

  const best = candidates
    .map(cleanArticleText)
    .filter((candidate) => candidate.length >= 300)
    .sort((a, b) => b.length - a.length)[0];

  if (!best) return undefined;
  return best.slice(0, MAX_ARTICLE_TEXT_LENGTH);
}

function extractCandidateTexts(html: string, pattern: RegExp): string[] {
  const matches = Array.from(html.matchAll(pattern));
  return matches
    .map((match) => htmlToText(match[1] || ""))
    .filter((text): text is string => !!text);
}

function htmlToText(html: string): string | undefined {
  const text = decodeHtmlEntities(
    html
      .replace(/<(br|\/p|\/div|\/section|\/article|\/main|\/li|\/h[1-6])>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return text || undefined;
}

function cleanArticleText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= 25)
    .filter((line) => !BOILERPLATE_LINE_PATTERNS.some((pattern) => pattern.test(line)))
    .filter((line) => !line.includes("{") && !line.includes("}"))
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x27;|&#39;|&rsquo;/gi, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&mdash;/gi, "-")
    .replace(/&ndash;/gi, "-")
    .replace(/&#(\d+);/g, (_, code: string) => {
      const numeric = Number.parseInt(code, 10);
      return Number.isFinite(numeric) ? String.fromCharCode(numeric) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => {
      const numeric = Number.parseInt(code, 16);
      return Number.isFinite(numeric) ? String.fromCharCode(numeric) : "";
    });
}

function extractJsonLdArticleBody(html: string): string | undefined {
  for (const match of html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    const parsed = tryParseJsonLd(match[1] || "");
    const articleBody = findArticleBody(parsed);
    if (articleBody && articleBody.length >= MIN_ARTICLE_TEXT_LENGTH) {
      return cleanArticleText(decodeHtmlEntities(articleBody));
    }
  }

  return undefined;
}

function tryParseJsonLd(raw: string): unknown {
  try {
    return JSON.parse(raw.trim());
  } catch {
    return undefined;
  }
}

function findArticleBody(value: unknown): string | undefined {
  if (!value) return undefined;

  if (typeof value === "string") {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const articleBody = findArticleBody(item);
      if (articleBody) return articleBody;
    }
    return undefined;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const direct = record.articleBody;
    if (typeof direct === "string" && direct.trim().length > 0) {
      return direct.trim();
    }

    for (const nestedValue of Object.values(record)) {
      const articleBody = findArticleBody(nestedValue);
      if (articleBody) return articleBody;
    }
  }

  return undefined;
}

async function getOpenRouterSummary(
  url: string,
  articleText: string,
  apiKey: string,
  articleHint?: string
): Promise<string | undefined> {
  const prompt = buildOpenRouterPrompt(url, articleText, articleHint);

  for (const model of [FREE_MODEL_NAME, FALLBACK_MODEL_NAME]) {
    const summary = await requestOpenRouterSummary({
      apiKey,
      model,
      prompt,
      system:
        "You summarize article text for a newsletter. Write 2-3 factual, concise sentences with no hype, no citations, and no preamble.",
    });
    if (summary) return summary;
  }

  return undefined;
}

async function getOpenRouterSearchSummary(
  url: string,
  apiKey: string,
  articleHint?: string
): Promise<string | undefined> {
  return requestOpenRouterSummary({
    apiKey,
    model: SEARCH_MODEL_NAME,
    prompt: buildSearchSummaryPrompt(url, articleHint),
    system:
      "You search the web to find and summarize news articles. Provide a 2-3 sentence summary of the key points. Be factual and concise. No hype, no citations, and no preamble.",
    maxTokens: 250,
  });
}

async function requestOpenRouterSummary(options: {
  apiKey: string;
  model: string;
  prompt: string;
  system: string;
  maxTokens?: number;
}): Promise<string | undefined> {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`,
        "HTTP-Referer": "https://levine.yet-to-be.com",
        "X-Title": "Levine Links",
      },
      body: JSON.stringify({
        model: options.model,
        messages: [
          {
            role: "system",
            content: options.system,
          },
          {
            role: "user",
            content: options.prompt,
          },
        ],
        max_tokens: options.maxTokens ?? 180,
        temperature: 0.1,
      }),
    });

    if (!response.ok) return undefined;

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return cleanSummaryContent(data.choices?.[0]?.message?.content);
  } catch {
    return undefined;
  }
}

function buildOpenRouterPrompt(
  url: string,
  articleText: string,
  articleHint?: string
): string {
  const parts = [
    `URL: ${url}`,
    articleHint ? `Context: ${articleHint}` : undefined,
    "",
    "Article text:",
    articleText.slice(0, MAX_ARTICLE_TEXT_LENGTH),
  ].filter(Boolean);

  return parts.join("\n");
}

function buildSearchSummaryPrompt(url: string, articleHint?: string): string {
  const safeTitle = articleHint?.trim();
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

function cleanSummaryContent(content?: string): string | undefined {
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

  if (badPhrases.some((phrase) => lower.includes(phrase))) return undefined;

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
    .replace(/^./, (char) => char.toUpperCase());
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

      return searchUrl;
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


