export interface Env {
  DB: D1Database;
  OPENROUTER_API_KEY?: string;
  RESEND_API_KEY: string;
  SITE_URL: string;
  EMAIL_DOMAIN: string;
  SEED_EMAIL?: string;
  // Service binding for parallel link fetching (each fetch() call = new execution context)
  FETCHER: Fetcher;
}

// Fetcher batch request/response types
export interface FetchBatchItem {
  url: string;
  text?: string;
  summaryContext?: string;
  forceSummary?: boolean;
  fetchOgImage?: boolean;
}

export interface FetchBatchRequest {
  items: FetchBatchItem[];
  openRouterApiKey?: string;
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
