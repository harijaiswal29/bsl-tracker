// IndexedDB storage. Everything lives on this device; use Backup in "More" to keep a copy.

const DB_NAME = 'bsl-tracker';
const VERSION = 1;
export const STORES = ['meals', 'glucose'];

let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' }).createIndex('ts', 'ts');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export async function getAll(store) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).index('ts').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putMany(store, items) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const item of items) os.put(item);
  return done(tx);
}

export const put = (store, item) => putMany(store, [item]);

export async function remove(store, id) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(id);
  return done(tx);
}

export async function getKV(key, fallback) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction('kv').objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : fallback);
    req.onerror = () => reject(req.error);
  });
}

export async function setKV(key, value) {
  const db = await open();
  const tx = db.transaction('kv', 'readwrite');
  tx.objectStore('kv').put({ key, value });
  return done(tx);
}

export async function clearAll() {
  const db = await open();
  const tx = db.transaction([...STORES, 'kv'], 'readwrite');
  for (const name of [...STORES, 'kv']) tx.objectStore(name).clear();
  return done(tx);
}

// Ask the browser not to evict our data under storage pressure.
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch { /* best effort */ }
}
