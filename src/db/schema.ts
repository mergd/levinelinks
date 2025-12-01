import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const subscribers = sqliteTable("subscribers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  verified: integer("verified", { mode: "boolean" }).notNull().default(false),
  verifyToken: text("verify_token"),
  unsubscribeToken: text("unsubscribe_token").notNull(),
});

export const newsletters = sqliteTable("newsletters", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull().unique(), // YYYY-MM-DD
  subject: text("subject").notNull(),
  linkCount: integer("link_count").default(0),
  summaryCount: integer("summary_count").default(0),
  archiveCount: integer("archive_count").default(0),
  processedAt: integer("processed_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type Subscriber = typeof subscribers.$inferSelect;
export type NewSubscriber = typeof subscribers.$inferInsert;
export type Newsletter = typeof newsletters.$inferSelect;
export type NewNewsletter = typeof newsletters.$inferInsert;

