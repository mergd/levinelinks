export interface Env {
  DB: D1Database;
  NEWSLETTERS: KVNamespace;
  PERPLEXITY_API_KEY: string;
  RESEND_API_KEY: string;
  SITE_URL: string;
  SEED_EMAIL?: string;
  // Service binding for parallel link fetching (each fetch() call = new execution context)
  FETCHER: Fetcher;
}

// Fetcher batch request/response types
export interface FetchBatchItem {
  url: string;
  text?: string;
  fetchOgImage?: boolean;
}

export interface FetchBatchRequest {
  items: FetchBatchItem[];
  perplexityApiKey?: string;
}

export interface LinkFetchResult {
  originalUrl: string;
  resolvedUrl: string;
  favicon?: string;
  summary?: string;
  archiveUrl?: string;
  ogImage?: string;
}

export interface FetchBatchResponse {
  results: LinkFetchResult[];
  error?: string;
}

export interface ExtractedLink {
  url: string;
  text: string;
  context: string;
}

export interface EnrichedLink extends ExtractedLink {
  isPaywalled: boolean;
  summary?: string;
  archiveUrl?: string;
}

export interface ProcessedNewsletter {
  date: string;
  subject: string;
  originalHtml: string;
  links: EnrichedLink[];
}
