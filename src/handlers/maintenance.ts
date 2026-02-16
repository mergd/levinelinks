import { and, eq, lte } from "drizzle-orm";
import { getDb } from "../db";
import { subscribers } from "../db/schema";
import type { Env } from "../types";

export async function pruneExpiredUnverified(env: Env): Promise<void> {
  const db = getDb(env.DB);
  const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000);

  await db
    .delete(subscribers)
    .where(and(eq(subscribers.verified, false), lte(subscribers.createdAt, cutoff)));
}
