// Short share links: create and open playlists stored in MongoDB.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { playlists } from '../db.js';
import * as music from './deezer.js';

const scrypt = promisify(crypto.scrypt);
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes (0/O, 1/l/I)
const DURATIONS = { '1h': 3600e3, '1d': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3, never: null };

export const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, extra });
const newId = (len = 7) => Array.from({ length: len }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
async function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const test = await scrypt(pw, Buffer.from(salt, 'hex'), 32);
  const real = Buffer.from(hash, 'hex');
  return test.length === real.length && crypto.timingSafeEqual(test, real);
}

export async function createShare({ name, trackIds, expiresIn = 'never', password }) {
  if (!Array.isArray(trackIds)) throw fail(400, 'trackIds must be a list');
  const ids = [...new Set(trackIds.map(String))];
  if (!ids.length || ids.length > 100 || !ids.every((x) => /^\d+$/.test(x))) throw fail(400, 'A playlist needs 1 to 100 valid songs');
  if (!Object.hasOwn(DURATIONS, expiresIn)) throw fail(400, 'Invalid expiry');
  if (password && (typeof password !== 'string' || password.length < 4 || password.length > 64)) throw fail(400, 'Password must be 4 to 64 characters');

  const doc = { name: String(name || '').trim().slice(0, 40) || 'Shared playlist', trackIds: ids, createdAt: new Date() };
  if (DURATIONS[expiresIn]) doc.expiresAt = new Date(Date.now() + DURATIONS[expiresIn]);
  if (password) doc.pw = await hashPassword(password); // only a salted hash is stored

  const col = await playlists();
  for (let i = 0; i < 5; i++) {
    doc._id = newId();
    try {
      await col.insertOne(doc);
      return { id: doc._id, expiresAt: doc.expiresAt || null, protected: !!doc.pw };
    } catch (err) {
      if (err.code !== 11000) throw err; // 11000 = id already taken, so try another
    }
  }
  throw fail(500, 'Could not create a link, please try again');
}

export async function openShare(id, password = '') {
  const gone = () => fail(404, 'Playlist not found or expired');
  if (!/^[A-Za-z0-9]{4,16}$/.test(id)) throw gone();
  const doc = await (await playlists()).findOne({ _id: id });
  // MongoDB removes expired documents about once a minute, so also check here
  if (!doc || (doc.expiresAt && doc.expiresAt < new Date())) throw gone();
  if (doc.pw) {
    if (!password) throw fail(401, 'This playlist is password protected', { locked: true });
    if (!(await checkPassword(password, doc.pw))) throw fail(403, 'Wrong password');
  }
  return { name: doc.name, tracks: await music.tracks(doc.trackIds), expiresAt: doc.expiresAt || null };
}
