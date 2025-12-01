import type { ExtractedLink } from "../types";

const PAYWALLED_DOMAINS = [
  "wsj.com",
  "nytimes.com",
  "ft.com",
  "washingtonpost.com",
  "theathletic.com",
  "theinformation.com",
  "theatlantic.com",
  "economist.com",
  "barrons.com",
  "fortune.com",
  "businessinsider.com",
  "seekingalpha.com",
];

const TRACKING_DOMAINS = [
  "links.message.bloomberg.com",
  "bloom.bg",
  "sli.bloomberg.com",
];

export async function resolveTrackingUrl(url: string, depth = 0): Promise<string> {
  if (depth > 5) return url;

  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const isTrackingUrl = TRACKING_DOMAINS.some((d) => hostname.includes(d));

    if (!isTrackingUrl) {
      return url;
    }

    const response = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
    });

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

export function isPaywalledUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return PAYWALLED_DOMAINS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

export function extractLinksFromHtml(html: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const linkRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const url = match[1];
    const rawText = match[2];

    if (!url || url.startsWith("mailto:") || url.startsWith("#")) continue;

    const text = rawText.replace(/<[^>]+>/g, "").trim();
    if (!text) continue;

    const contextStart = Math.max(0, match.index - 100);
    const contextEnd = Math.min(html.length, match.index + match[0].length + 100);
    const context = html
      .slice(contextStart, contextEnd)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    links.push({ url, text, context });
  }

  return links;
}

export function extractSubjectFromEmail(rawEmail: string): string {
  const subjectMatch = rawEmail.match(/^Subject:\s*(.+)$/im);
  return subjectMatch?.[1]?.trim() ?? "Money Stuff";
}

export function stripForwardedHeaders(html: string): string {
  // Remove "Begin forwarded message:" block and its headers
  // This appears when someone forwards an email
  const patterns = [
    // HTML formatted forwarded header block
    /<div[^>]*>[\s\S]*?Begin forwarded message:[\s\S]*?Reply-To:[^<]*<\/div>/gi,
    // Plain text style with <br> tags
    /Begin forwarded message:[\s\S]*?(?:From:|Subject:|Date:|To:|Reply-To:)[^<]*(?:<br\s*\/?>[\s\S]*?){0,10}(?=<)/gi,
    // Blockquote wrapped version
    /<blockquote[^>]*>[\s\S]*?Begin forwarded message:[\s\S]*?<\/blockquote>/gi,
    // Simple text-based pattern for the header block
    /Begin forwarded message:\s*(?:<br\s*\/?>|\n|\r)+(?:[\s\S]*?(?:From|Subject|Date|To|Reply-To):[^\n<]+(?:<br\s*\/?>|\n|\r)*)+/gi,
    // Very loose match for the forwarded header section
    /<[^>]*>Begin forwarded message:<\/[^>]*>[\s\S]*?<[^>]*>Reply-To:[^<]*<\/[^>]*>/gi,
  ];

  let result = html;
  for (const pattern of patterns) {
    result = result.replace(pattern, "");
  }

  return result;
}

