const DB_NAME = "neptune-secure-v1";
const DB_VERSION = 1;
const KEY_STORE = "keys";
const SECRET_STORE = "secrets";
const MASTER_KEY_ID = "master";

type EncryptedRecord = {
  id: string;
  iv: number[];
  cipher: number[];
  updatedAt: string;
};

export async function saveSecret(id: string, value: string): Promise<void> {
  const clean = value.trim();
  if (!clean) {
    await deleteSecret(id);
    return;
  }
  const key = await getOrCreateMasterKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(clean);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const db = await openDatabase();
  await transactionPromise(db, SECRET_STORE, "readwrite", (store) => store.put({
    id,
    iv: Array.from(iv),
    cipher: Array.from(new Uint8Array(cipher)),
    updatedAt: new Date().toISOString()
  } satisfies EncryptedRecord));
}

export async function loadSecret(id: string): Promise<string> {
  const db = await openDatabase();
  const record = await transactionPromise<EncryptedRecord | undefined>(
    db,
    SECRET_STORE,
    "readonly",
    (store) => store.get(id)
  );
  if (!record) return "";
  try {
    const key = await getOrCreateMasterKey();
    const clear = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(record.iv) },
      key,
      new Uint8Array(record.cipher)
    );
    return new TextDecoder().decode(clear);
  } catch {
    return "";
  }
}

export async function deleteSecret(id: string): Promise<void> {
  const db = await openDatabase();
  await transactionPromise(db, SECRET_STORE, "readwrite", (store) => store.delete(id));
}

async function getOrCreateMasterKey(): Promise<CryptoKey> {
  const db = await openDatabase();
  const existing = await transactionPromise<CryptoKey | undefined>(
    db,
    KEY_STORE,
    "readonly",
    (store) => store.get(MASTER_KEY_ID)
  );
  if (existing) return existing;
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  await transactionPromise(db, KEY_STORE, "readwrite", (store) => store.put(key, MASTER_KEY_ID));
  return key;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE);
      if (!db.objectStoreNames.contains(SECRET_STORE)) db.createObjectStore(SECRET_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Stockage sécurisé indisponible"));
  });
}

function transactionPromise<T = unknown>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = operation(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Opération de stockage impossible"));
    transaction.onerror = () => reject(transaction.error ?? new Error("Transaction de stockage impossible"));
  });
}
