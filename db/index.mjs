import { drizzle } from 'drizzle-orm/netlify-db';
import { and, eq, desc } from 'drizzle-orm';
import { records } from './schema.ts';

export function databaseStore() {
  const db = drizzle();
  const where = (workspace, kind) => and(eq(records.workspace, workspace), eq(records.kind, kind));
  return {
    async list(workspace, kind, limit = 1000) {
      return (await db.select().from(records).where(where(workspace, kind)).orderBy(desc(records.createdAt)).limit(limit)).map(r => r.payload);
    },
    async get(workspace, kind, id) {
      const [row] = await db.select().from(records).where(and(where(workspace, kind), eq(records.id, `${workspace}:${kind}:${id}`))).limit(1);
      return row?.payload;
    },
    async put(workspace, kind, id, payload) {
      await db.insert(records).values({ id: `${workspace}:${kind}:${id}`, workspace, kind, payload }).onConflictDoUpdate({ target: records.id, set: { payload } });
    },
    async remove(workspace, kind, id) {
      await db.delete(records).where(and(where(workspace, kind), eq(records.id, `${workspace}:${kind}:${id}`)));
    },
  };
}
