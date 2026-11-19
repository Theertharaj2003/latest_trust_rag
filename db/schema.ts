import { pgTable, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

export const documents = pgTable('documents', {
  id: text().primaryKey(),
  workspace: text().notNull(),
  report: jsonb().notNull(),
  cleanedText: text('cleaned_text').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, table => [index('documents_workspace_idx').on(table.workspace)]);

export const queries = pgTable('queries', {
  id: text().primaryKey(),
  workspace: text().notNull(),
  result: jsonb().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, table => [index('queries_workspace_idx').on(table.workspace)]);

export const datasets = pgTable('datasets', {
  workspace: text().primaryKey(),
  info: jsonb().notNull(),
  passages: jsonb().notNull(),
  evaluation: jsonb(),
});
