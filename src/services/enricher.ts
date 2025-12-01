import type { ExtractedLink, EnrichedLink } from "../types";
import { isPaywalledUrl, resolveTrackingUrl } from "./parser";

interface PerplexityResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

export async function getPerplexitySummary(
  url: string,
  _linkText: string,
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

    if (!response.ok) {
      console.log(`      API error: ${response.status}`);
      return undefined;
    }

    const data = (await response.json()) as PerplexityResponse;
    const content = data.choices[0]?.message?.content;

    if (!content || content.length < 30) {
      console.log(`      Empty/short response`);
      return undefined;
    }

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

    if (badPhrases.some((p) => lower.includes(p))) {
      console.log(`      Can't access`);
      return undefined;
    }

    // Clean up "The article discusses..." style intros
    let cleaned = content
      .replace(/^The (article|piece|report|story|post|blog)( from [^.]+)? (discusses|explains|covers|details|examines|explores|highlights|reports|describes|analyzes)/i, "")
      .replace(/^This (article|piece|report|story|post|blog) (discusses|explains|covers|details|examines|explores|highlights|reports|describes|analyzes)/i, "")
      .trim();

    // Capitalize first letter if needed
    if (cleaned.length > 0) {
      cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    }

    return cleaned;
  } catch (e) {
    console.log(`      Exception: ${e}`);
    return undefined;
  }
}

export async function getArchiveUrl(url: string): Promise<string | undefined> {
  try {
    const archiveSearchUrl = `https://archive.is/newest/${encodeURIComponent(url)}`;
    const response = await fetch(archiveSearchUrl, {
      method: "HEAD",
      redirect: "manual",
    });

    const location = response.headers.get("location");
    if (location && location.includes("archive.is")) {
      return location;
    }

    if (response.status === 200) {
      return archiveSearchUrl;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

export async function enrichLinks(
  links: ExtractedLink[],
  perplexityApiKey: string
): Promise<EnrichedLink[]> {
  const enriched: EnrichedLink[] = [];

  for (const link of links) {
    const resolvedUrl = await resolveTrackingUrl(link.url);
    const isPaywalled = isPaywalledUrl(resolvedUrl);

    if (isPaywalled) {
      const [summary, archiveUrl] = await Promise.all([
        getPerplexitySummary(resolvedUrl, link.text, perplexityApiKey),
        getArchiveUrl(resolvedUrl),
      ]);

      enriched.push({
        ...link,
        url: resolvedUrl,
        isPaywalled: true,
        summary,
        archiveUrl,
      });
    } else {
      enriched.push({
        ...link,
        url: resolvedUrl,
        isPaywalled: false,
      });
    }
  }

  return enriched;
}
