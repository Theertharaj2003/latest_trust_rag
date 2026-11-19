import { pgTable, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

// Each browser gets an isolated workspace; all durable state lives in Postgres.
export const records = pgTable('trust_rag_records', {
  id: text('id').primaryKey(),
  workspace: text('workspace').notNull(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, table => [index('trust_rag_workspace_kind_idx').on(table.workspace, table.kind)]);
