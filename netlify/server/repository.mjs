import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/index.mjs';
import { documents, queries, datasets } from '../../db/schema.ts';

export const repository = {
  async listDocuments(workspace) {
    return db.select().from(documents).where(eq(documents.workspace, workspace)).orderBy(desc(documents.createdAt));
  },
  async addDocument(workspace, report, cleanedText) {
    await db.insert(documents).values({ id: report.scan_id, workspace, report, cleanedText });
  },
  async deleteDocument(workspace, id) {
    await db.delete(documents).where(and(eq(documents.workspace, workspace), eq(documents.id, id)));
  },
  async getDocument(workspace, id) {
    const [row] = await db.select().from(documents).where(and(eq(documents.workspace, workspace), eq(documents.id, id)));
    return row;
  },
  async listQueries(workspace, limit = 20) {
    const rows = await db.select({ result: queries.result }).from(queries).where(eq(queries.workspace, workspace)).orderBy(desc(queries.createdAt)).limit(limit);
    return rows.map(r => r.result);
  },
  async addQuery(workspace, result) {
    await db.insert(queries).values({ id: result.query_id, workspace, result });
  },
  async getDataset(workspace) {
    const [row] = await db.select().from(datasets).where(eq(datasets.workspace, workspace));
    return row;
  },
  async saveDataset(workspace, info, passages) {
    await db.insert(datasets).values({ workspace, info, passages, evaluation: null }).onConflictDoUpdate({ target: datasets.workspace, set: { info, passages, evaluation: null } });
  },
  async deleteDataset(workspace) { await db.delete(datasets).where(eq(datasets.workspace, workspace)); },
  async saveEvaluation(workspace, datasetId, evaluation) {
    const updated = await db.update(datasets).set({ evaluation }).where(and(eq(datasets.workspace, workspace), sql`${datasets.info}->>'dataset_id' = ${datasetId}`)).returning({ workspace: datasets.workspace });
    return updated.length > 0;
  },
};
