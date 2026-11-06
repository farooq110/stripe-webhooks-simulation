// MongoDB replica-set bootstrap + transaction smoke test (run once manually)
import { MongoClient } from 'mongodb';

const URI_DIRECT = 'mongodb://127.0.0.1:27017/?directConnection=true&serverSelectionTimeoutMS=5000';
const URI_RS = 'mongodb://127.0.0.1:27017/stripepulse?replicaSet=rs0&serverSelectionTimeoutMS=5000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1. Connect directly and initiate the replica set if needed
  const direct = new MongoClient(URI_DIRECT);
  await direct.connect();
  try {
    const status = await direct.db('admin').command({ replSetGetStatus: 1 });
    console.log('replSet status:', status.set, 'myState:', status.myState);
  } catch (e) {
    if (e.codeName === 'NotYetInitialized' || e.code === 94) {
      console.log('Initiating replica set rs0...');
      await direct.db('admin').command({
        replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27017' }] },
      });
      console.log('replSetInitiate sent');
    } else {
      throw e;
    }
  }
  await direct.close();

  // 2. Wait until a PRIMARY is elected
  let primary = false;
  for (let i = 0; i < 30; i++) {
    try {
      const c = new MongoClient(URI_RS);
      await c.connect();
      const hello = await c.db('admin').command({ hello: 1 });
      await c.close();
      if (hello.isWritablePrimary) { primary = true; break; }
    } catch { /* retry */ }
    await sleep(500);
  }
  if (!primary) throw new Error('Replica set never became primary');
  console.log('PRIMARY elected ✓');

  // 3. Transaction smoke test — real multi-document ACID transaction
  const client = new MongoClient(URI_RS);
  await client.connect();
  const db = client.db('stripepulse');
  const a = db.collection('_smoke_a');
  const b = db.collection('_smoke_b');
  await a.deleteMany({}); await b.deleteMany({});

  const session = client.startSession();
  try {
    session.startTransaction();
    await a.insertOne({ v: 1, tag: 'tx' }, { session });
    await b.insertOne({ v: 2, tag: 'tx' }, { session });
    // abort test first: prove rollback works
    await session.abortTransaction();
    const countAfterAbort = await a.countDocuments({ tag: 'tx' });
    if (countAfterAbort !== 0) throw new Error('Transaction rollback failed');
    console.log('Abort/rollback semantics ✓ (0 docs after abort)');

    session.startTransaction();
    await a.insertOne({ v: 1, tag: 'tx' }, { session });
    await b.insertOne({ v: 2, tag: 'tx' }, { session });
    await session.commitTransaction();
    const countAfterCommit = await a.countDocuments({ tag: 'tx' });
    if (countAfterCommit !== 1) throw new Error('Transaction commit failed');
    console.log('Commit ✓ (1 doc after commit)');
  } finally {
    await session.endSession();
  }

  // 4. Create the demo database collections + indexes
  await db.createCollection('runs');
  await db.collection('run_steps').createIndex({ runId: 1, idx: 1 });
  await db.collection('webhook_events').createIndex({ eventId: 1 }, { unique: true });
  await db.collection('webhook_events').createIndex({ status: 1, nextRetryAt: 1 });
  await db.collection('subscriptions').createIndex({ subscriptionId: 1 }, { unique: true });
  await db.collection('customers').createIndex({ customerId: 1 }, { unique: true });
  await db.collection('api_logs').createIndex({ runId: 1, createdAt: 1 });
  await db.collection('db_logs').createIndex({ runId: 1, createdAt: 1 });
  await db.collection('payment_attempts').createIndex({ runId: 1, createdAt: 1 });
  console.log('Collections + indexes created ✓');

  await a.deleteMany({}); await b.deleteMany({});
  await client.close();
  console.log('SMOKE TEST PASSED');
}

main().then(() => process.exit(0)).catch((e) => { console.error('SMOKE FAILED:', e); process.exit(1); });
