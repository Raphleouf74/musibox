// MongoDB connection (one shared client). Set MONGODB_URI in your environment.
import { MongoClient } from 'mongodb';

let ready = null;

async function connect() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const col = client.db(process.env.MONGODB_DB || 'musibox').collection('playlists');
  // MongoDB deletes a document automatically once its expiresAt date has passed.
  // Documents without expiresAt (the "forever" ones) are never deleted.
  await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  return col;
}

export function playlists() {
  ready ??= connect().catch((err) => {
    ready = null; // try again on the next request
    console.error('[DB] connection failed:', err.message);
    throw Object.assign(new Error('Sharing is temporarily unavailable'), { status: 503 });
  });
  return ready;
}
