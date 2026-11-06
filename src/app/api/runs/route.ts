import { collections, getDb } from '@/lib/stripepulse/mongo';

export const dynamic = 'force-dynamic';

export async function GET() {
  const db = await getDb();
  const runs = await collections(db).runs.find().sort({ createdAt: -1 }).limit(20).toArray();
  return Response.json({ runs });
}
