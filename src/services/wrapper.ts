import type {
  Env,
  FetchBatchRequest,
  FetchBatchResponse,
  LinkFetchResult,
} from "../types";
import { renderFootnoteRef } from "./footnote-markup";

interface EnrichedLinkData {
  originalUrl: string;
  resolvedUrl: string;
  summary?: string;
  archiveUrl?: string;
  favicon?: string;
}

const SKIP_DOMAINS = [
  "twitter.com",
  "x.com",
  "youtube.com",
  "youtu.be",
  "bloomberg.com/account",
  "bloomberg.com/email-settings",
  "bloomberg.com/help",
  "bloomberg.com/subscriptions",
  "bloomberg.com/privacy",
  "bloomberg.com/tos",
  "bloombergmedia.com",
  "unsubscribe",
  "mail.bloombergbusiness.com",
  "link.mail.bloombergbusiness.com",
  "liveintent.com",
  "assets.bwbx.io",
  "spmailtechnolo.com",
];

const SKIP_EXACT_URLS = [
  "http://bloomberg.com/",
  "https://bloomberg.com/",
  "http://www.bloomberg.com/",
  "https://www.bloomberg.com/",
];

const SKIP_URL_PATTERNS = [
  /bloomberg\.com\/.*\/newsletters\/\d{4}-\d{2}-\d{2}/,
];
const SKIP_PATTERNS = [/^mailto:/, /^#/, /\.(jpg|jpeg|png|gif|webp|svg|pdf)$/i];
const SKIP_LINK_TEXT_PATTERNS = [
  /^view in browser$/i,
  /^view enhanced version$/i,
  /^get the newsletter$/i,
  /^subscribe to bloomberg\.com$/i,
  /^subscribe at this link$/i,
];
const FOOTER_START_PATTERNS = [
  />\s*If you(?:'|'|&#x27;|&#39;|&rsquo;)?d like to get Money Stuff in handy email form/i,
  /subscribe(?:\s|&nbsp;|<[^>]+>)+at(?:\s|&nbsp;|<[^>]+>)+<a[^>]*>\s*this link\s*<\/a>/i,
  /If you(?:'|'|&#x27;|&#39;|&rsquo;)?d like to get Money Stuff[\s\S]{0,500}?subscribe(?:\s|&nbsp;|<[^>]+>)+at(?:\s|&nbsp;|<[^>]+>)+<a[^>]*>\s*this link\s*<\/a>/i,
  /subscribe at this link/i,
  /Money Stuff and other great Bloomberg newsletters/i,
  />\s*Follow Us\s*</i,
  />\s*Get the newsletter\s*</i,
  /Like getting this newsletter\?/i,
  /You received this message because you are subscribed to Bloomberg(?:'|&#x27;|&#39;|&rsquo;)?s Money Stuff newsletter/i,
];

function shouldSkipUrl(url: string): boolean {
  if (SKIP_PATTERNS.some((p) => p.test(url))) return true;
  if (SKIP_URL_PATTERNS.some((p) => p.test(url))) return true;
  if (SKIP_EXACT_URLS.includes(url.toLowerCase())) return true;

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const fullUrl = url.toLowerCase();
    return SKIP_DOMAINS.some(
      (d) => hostname.includes(d) || fullUrl.includes(d)
    );
  } catch {
    return true;
  }
}

function fixMojibake(text: string): string {
  return text
    .replace(/â€œ/g, '"')
    .replace(/â€/g, '"')
    .replace(/â€™/g, "'")
    .replace(/â€˜/g, "'")
    .replace(/â€"/g, "—")
    .replace(/â€"/g, "–")
    .replace(/â€¦/g, "…")
    .replace(/Â /g, " ")
    .replace(/Â/g, "");
}

function stripForwardingWrapper(html: string): string {
  let cleaned = html.replace(
    />\s*Begin forwarded message:\s*<\/\w+>[\s\S]*?<blockquote[^>]*>/i,
    ">"
  );
  cleaned = cleaned.replace(
    /<blockquote[^>]*>[\s\S]*?<b>From:<\/b>[\s\S]*?<b>To:<\/b>[\s\S]*?<\/blockquote>/gi,
    ""
  );
  cleaned = cleaned.replace(
    /-{5,}\s*Forwarded message\s*-{5,}[\s\S]*?(?=<table|<div[^>]*class)/i,
    ""
  );
  cleaned = cleaned.replace(
    /<div[^>]*>[\s\S]*?<b>From:<\/b>[^<]*Matt Levine[\s\S]*?<b>Subject:<\/b>[\s\S]*?<\/div>/gi,
    ""
  );
  return cleaned;
}

export interface WrapResult {
  html: string;
  preview: string;
  ogImage?: string;
}

interface WrapNewsletterOptions {
  issueUrl?: string;
}

// Split array into N chunks
function chunkArray<T>(arr: T[], numChunks: number): T[][] {
  const chunks: T[][] = [];
  const chunkSize = Math.ceil(arr.length / numChunks);
  for (let i = 0; i < arr.length; i += chunkSize) {
    chunks.push(arr.slice(i, i + chunkSize));
  }
  return chunks;
}

// Call a fetcher worker via service binding
async function callFetcher(
  fetcher: Fetcher,
  items: {
    url: string;
    text?: string;
    summaryContext?: string;
    forceSummary?: boolean;
    fetchOgImage?: boolean;
  }[],
  keys: {
    perplexityApiKey?: string;
    openRouterApiKey?: string;
  }
): Promise<LinkFetchResult[]> {
  if (items.length === 0) return [];

  const request: FetchBatchRequest = {
    items,
    perplexityApiKey: keys.perplexityApiKey,
    openRouterApiKey: keys.openRouterApiKey,
  };

  try {
    const response = await fetcher.fetch("https://internal/_fetch-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      console.error(`Fetcher returned ${response.status}`);
      return [];
    }

    const data = (await response.json()) as FetchBatchResponse;
    return data.results;
  } catch (e) {
    console.error("Fetcher call failed:", e);
    return [];
  }
}

export async function wrapNewsletter(
  html: string,
  env: Env,
  options: WrapNewsletterOptions = {}
): Promise<WrapResult> {
  let processedHtml = stripForwardingWrapper(html);
  processedHtml = fixMojibake(processedHtml);

  processedHtml = processedHtml
    .replace(/background-color:\s*rgb\(204,\s*204,\s*204\);?/gi, "")
    .replace(/x-msg:\/\/\d+\//gi, "")
    .replace(/<span class="Apple-converted-space">[^<]*<\/span>/gi, " ");

  processedHtml = processedHtml.replace(
    /<img[^>]*alt=["']Listen to the money stuff podcast["'][^>]*>/gi,
    ""
  );

  processedHtml = processedHtml
    .replace(
      /You received this message because you are subscribed to Bloomberg[^<]*<\/\w+>/gi,
      ""
    )
    .replace(/Ads Powered By Liveintent[^<]*Ad Choices/gi, "")
    .replace(/Bloomberg L\.P\.\s*731 Lexington[^<]*10022/gi, "")
    .replace(/<a[^>]*>Unsubscribe<\/a>/gi, "")
    .replace(/<a[^>]*>Contact Us<\/a>/gi, "");

  // Extract all links
  const linkRegex = /<a\s+([^>]*href=["']([^"']+)["'][^>]*)>([\s\S]*?)<\/a>/gi;
  const linksToProcess: Array<{
    match: string;
    url: string;
    text: string;
    fullMatch: string;
    summaryContext?: string;
    forceSummary?: boolean;
  }> = [];
  const footerStartIndex = findFooterStartIndex(processedHtml);
  const thingsHappenStartIndex = findSectionStartIndex(
    processedHtml,
    "Things happen"
  );

  let match;
  while ((match = linkRegex.exec(processedHtml)) !== null) {
    const url = match[2];
    const text = match[3].replace(/<[^>]+>/g, "").trim();
    if (!url || shouldSkipUrl(url)) continue;
    if (footerStartIndex !== -1 && match.index >= footerStartIndex) continue;
    if (SKIP_LINK_TEXT_PATTERNS.some((pattern) => pattern.test(text))) continue;

    const isInThingsHappen =
      thingsHappenStartIndex !== -1 &&
      match.index >= thingsHappenStartIndex &&
      (footerStartIndex === -1 || match.index < footerStartIndex);

    linksToProcess.push({
      match: match[0],
      url,
      text: text || "",
      fullMatch: match[0],
      summaryContext: isInThingsHappen
        ? extractThingsHappenItemContext(
            processedHtml,
            match.index,
            match[0],
            thingsHappenStartIndex,
            footerStartIndex
          ) ?? extractLinkSummaryContext(processedHtml, match.index, match[0])
        : undefined,
      forceSummary: isInThingsHappen,
    });
  }

  // Get unique URLs to process (reversed - important links at end first)
  const uniqueUrls = [...new Set(linksToProcess.map((l) => l.url))].reverse();

  console.log(`Processing ${uniqueUrls.length} links via 3 fetcher workers...`);

  // Prepare items for fetchers
  const fetchItems = uniqueUrls.map((url) => {
    const link = [...linksToProcess].reverse().find((item) => item.url === url);
    return {
      url,
      text: link?.text,
      summaryContext: link?.summaryContext,
      forceSummary: link?.forceSummary,
      fetchOgImage: false,
    };
  });

  // Split into 3 chunks and fan out (each fetch() = new execution with own subrequest budget)
  const chunks = chunkArray(fetchItems, 3);

  const fetchPromises = chunks.map((chunk) =>
    callFetcher(env.FETCHER, chunk, {
      perplexityApiKey: env.PERPLEXITY_API_KEY,
      openRouterApiKey: env.OPENROUTER_API_KEY,
    })
  );

  const results = await Promise.all(fetchPromises);
  const allResults = results.flat();

  console.log(`  ✓ Got ${allResults.length} results from fetchers`);

  // Build lookup map
  const enrichedData = new Map<string, EnrichedLinkData>();
  for (const result of allResults) {
    enrichedData.set(result.originalUrl, {
      originalUrl: result.originalUrl,
      resolvedUrl: result.resolvedUrl,
      summary: result.summary,
      archiveUrl: result.archiveUrl,
      favicon: result.favicon,
    });
  }

  // Apply enrichments to HTML
  for (const link of linksToProcess) {
    const data = enrichedData.get(link.url);
    if (!data) continue;

    const newLinkHtml = generateEnrichedLink(link.fullMatch, link.text, data);
    processedHtml = processedHtml.replace(link.fullMatch, newLinkHtml);
  }

  processedHtml = processedHtml.replace(
    /<a([^>]*href=["'])([^"']+)(["'][^>]*)>\s*View (?:in browser|enhanced version)\s*<\/a>/gi,
    (
      _,
      beforeHref: string,
      currentHref: string,
      afterHref: string
    ) => {
      const href = escapeHtml(options.issueUrl ?? currentHref);
      return `<a${beforeHref}${href}${afterHref}>View enhanced version</a>`;
    }
  );

  processedHtml = processFootnotes(processedHtml);

  // Extract preview
  const textContent = processedHtml
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const preview = textContent.slice(0, 200).trim();

  // Fetch OG images via fetcher (pick first 5 non-paywalled URLs)
  const ogCandidates = allResults
    .filter(
      (r) =>
        r.resolvedUrl &&
        !r.resolvedUrl.includes("bloomberg.com/opinion/newsletters")
    )
    .slice(0, 5)
    .map((r) => ({ url: r.resolvedUrl, fetchOgImage: true }));

  let ogImage: string | undefined;
  if (ogCandidates.length > 0) {
    console.log(`🖼️ Fetching OG images from ${ogCandidates.length} URLs...`);
    const ogResults = await callFetcher(
      env.FETCHER,
      ogCandidates,
      {
        perplexityApiKey: env.PERPLEXITY_API_KEY,
        openRouterApiKey: env.OPENROUTER_API_KEY,
      }
    );
    ogImage = ogResults.find((r) => r.ogImage)?.ogImage;
    if (ogImage) {
      console.log(`📸 Got OG image`);
    }
  }

  return { html: processedHtml, preview, ogImage };
}

function processFootnotes(html: string): string {
  const footnoteContents = new Map<string, string>();
  const footnoteDefRegex =
    /<div\s+id="footnote-(\d+)"[^>]*>[\s\S]*?<p[^>]*>\[?\d+\]?\s*([\s\S]*?)<\/p>[\s\S]*?<\/div>/gi;
  let match;
  while ((match = footnoteDefRegex.exec(html)) !== null) {
    const num = match[1];
    const content = match[2]
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    footnoteContents.set(num, content);
  }

  let result = html;
  for (const [num, content] of footnoteContents) {
    const refPattern = new RegExp(
      `<a\\s+href="#footnote-${num}"[^>]*>\\s*<span>\\[${num}\\]</span>\\s*</a>`,
      "gi"
    );
    const footnoteHtml = renderInlineRichText(content);
    const replacement = renderFootnoteRef(num, footnoteHtml);
    result = result.replace(refPattern, replacement);
  }

  result = result.replace(
    /<div\s+id="footnote-\d+"[^>]*>[\s\S]*?<\/div>/gi,
    ""
  );
  return result;
}

function generateEnrichedLink(
  originalLinkHtml: string,
  linkText: string,
  data: EnrichedLinkData
): string {
  const hasText = linkText && linkText.length >= 3;

  const faviconHtml =
    data.favicon && hasText
      ? `<img src="${data.favicon}" style="width:20px;height:20px;vertical-align:middle;margin-right:6px;border:0;border-radius:50%;object-fit:cover;" alt="">`
      : "";

  let updatedLink = originalLinkHtml
    .replace(/href=(["'])([^"']+)\1/, `href=$1${data.resolvedUrl}$1`)
    .replace(/target=["'][^"']*["']/gi, "")
    .replace(/<a\s+/, '<a target="_blank" rel="noopener" ');

  if (hasText && faviconHtml) {
    const linkTextEscaped = linkText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    updatedLink = updatedLink.replace(
      new RegExp(`>\\s*(${linkTextEscaped})`),
      `>${faviconHtml}$1`
    );
  }

  let result = updatedLink;

  if (data.summary && hasText) {
    const summaryHtml = renderInlineRichText(data.summary);

    const archiveLink = data.archiveUrl
      ? `<a href="${data.archiveUrl}" target="_blank" rel="noopener" style="text-decoration:none;font-size:13px;vertical-align:middle;margin-right:4px;" title="Read archived (no paywall)">📰</a>`
      : "";

    result += `${archiveLink}<button type="button" data-summary-toggle="true" aria-expanded="false" onclick="var s=this.nextElementSibling;var expanded=this.getAttribute('aria-expanded')==='true';s.hidden=expanded;this.setAttribute('aria-expanded',expanded?'false':'true');this.textContent=expanded?'▸ AI summary':'▾ AI summary';this.title=expanded?'Show AI summary':'Hide AI summary';" style="cursor:pointer;font-size:11px;vertical-align:middle;margin-left:4px;user-select:none;border:none;background:none;padding:0;color:#777;font-family:inherit;" title="Show AI summary">▸ AI summary</button>`;
    result += `<span data-summary-body="true" hidden style="font-size:13px;color:#555;margin-left:4px;"> ${summaryHtml}`;
    result += ` <a href="${data.resolvedUrl}" target="_blank" rel="noopener" style="color:#1976d2;font-size:11px;text-decoration:none;">[read]</a>`;
    if (data.archiveUrl) {
      result += ` <a href="${data.archiveUrl}" target="_blank" rel="noopener" style="color:#2e7d32;font-size:11px;text-decoration:none;">[archive]</a>`;
    }
    result += `</span>`;
  } else if (data.archiveUrl && hasText) {
    result += ` <a href="${data.archiveUrl}" target="_blank" rel="noopener" style="text-decoration:none;font-size:13px;" title="Read archived (no paywall)">📰</a>`;
  }

  return result;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function findFooterStartIndex(html: string): number {
  let earliestIndex = -1;

  for (const pattern of FOOTER_START_PATTERNS) {
    const index = html.search(pattern);
    if (index === -1) continue;
    if (earliestIndex === -1 || index < earliestIndex) {
      earliestIndex = index;
    }
  }

  return earliestIndex;
}

function findSectionStartIndex(html: string, label: string): number {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionPattern = new RegExp(`>\\s*${escapedLabel}\\s*<`, "i");
  const matchedIndex = html.search(sectionPattern);
  if (matchedIndex !== -1) return matchedIndex;

  return html.toLowerCase().indexOf(label.toLowerCase());
}

function extractLinkSummaryContext(
  html: string,
  linkIndex: number,
  fullMatch: string
): string | undefined {
  const contextStart = Math.max(0, linkIndex - 140);
  const contextEnd = Math.min(html.length, linkIndex + fullMatch.length + 180);
  const snippet = html
    .slice(contextStart, contextEnd)
    .replace(fullMatch, ` ${extractPlainText(fullMatch)} `);
  const text = extractPlainText(snippet);

  return text.length >= 12 ? text : undefined;
}

function extractThingsHappenItemContext(
  html: string,
  linkIndex: number,
  fullMatch: string,
  sectionStartIndex: number,
  footerStartIndex: number
): string | undefined {
  const sectionEndIndex = footerStartIndex !== -1 ? footerStartIndex : html.length;
  if (
    sectionStartIndex === -1 ||
    linkIndex < sectionStartIndex ||
    linkIndex >= sectionEndIndex
  ) {
    return undefined;
  }

  const localLinkIndex = linkIndex - sectionStartIndex;
  const sectionHtml = html.slice(sectionStartIndex, sectionEndIndex);
  const marker = "__LEVINE_LINK_MARKER__";
  const markedHtml =
    sectionHtml.slice(0, localLinkIndex) +
    `${marker}${extractPlainText(fullMatch)}${marker}` +
    sectionHtml.slice(localLinkIndex + fullMatch.length);
  const text = extractPlainText(markedHtml);
  const markerStart = text.indexOf(marker);

  if (markerStart === -1) {
    return undefined;
  }

  const markerEnd = text.indexOf(marker, markerStart + marker.length);
  const sentenceStart = findSentenceBoundary(text, markerStart, -1);
  const sentenceEnd = findSentenceBoundary(
    text,
    markerEnd === -1 ? markerStart + marker.length : markerEnd,
    1
  );
  const context = text
    .slice(sentenceStart, sentenceEnd)
    .replaceAll(marker, "")
    .replace(/\s+/g, " ")
    .trim();

  return context.length >= 12 ? context : undefined;
}

function findSentenceBoundary(
  text: string,
  startIndex: number,
  direction: -1 | 1
): number {
  if (direction === -1) {
    for (let index = startIndex - 1; index >= 0; index -= 1) {
      if (isSentenceBoundary(text, index)) {
        return index + 1;
      }
    }
    return 0;
  }

  for (let index = startIndex; index < text.length; index += 1) {
    if (isSentenceBoundary(text, index)) {
      return index + 1;
    }
  }

  return text.length;
}

function isSentenceBoundary(text: string, index: number): boolean {
  const char = text[index];
  if (char !== "." && char !== "!" && char !== "?") {
    return false;
  }

  const next = text[index + 1];
  return next === undefined || /\s/.test(next);
}

function extractPlainText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x27;|&#39;|&rsquo;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeInlineText(text: string): string {
  return text
    .replace(/\[web:\d+\]/gi, "")
    .replace(/\[\d+\]/g, "")
    .replace(/\[more\]/gi, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function renderInlineRichText(text: string): string {
  const linkTokens: string[] = [];
  let normalized = normalizeInlineText(text).replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label: string, url: string) => {
      const token = `@@LINK_${linkTokens.length}@@`;
      linkTokens.push(
        `<a href="${escapeHtml(
          url
        )}" target="_blank" rel="noopener" style="color:#1976d2;text-decoration:none;">${escapeHtml(
          label
        )}</a>`
      );
      return token;
    }
  );

  let html = escapeHtml(normalized)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, '<code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.95em;">$1</code>')
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/_([^_\n]+)_/g, "<em>$1</em>");

  for (const [index, tokenHtml] of linkTokens.entries()) {
    html = html.replace(`@@LINK_${index}@@`, tokenHtml);
  }

  return html;
}
