export interface Env {
  DB: D1Database;
  NEWSLETTERS: KVNamespace;
  PERPLEXITY_API_KEY: string;
  RESEND_API_KEY: string;
  SITE_URL: string;
  SEED_EMAIL?: string;
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

