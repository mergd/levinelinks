import { handleEmail } from "./handlers/email";
import { handleFetch } from "./handlers/web";
import { handleFetchBatch } from "./handlers/fetcher";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Internal fetcher endpoint (called via service bindings)
    if (url.pathname === "/_fetch-batch" && request.method === "POST") {
      return handleFetchBatch(request);
    }

    return handleFetch(request, env, ctx);
  },

  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    console.log("📨 EMAIL EVENT RECEIVED");
    try {
      await handleEmail(message, env, ctx);
    } catch (e) {
      console.error("❌ EMAIL HANDLER ERROR:", e);
      throw e;
    }
  },
};

