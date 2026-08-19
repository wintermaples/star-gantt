// docs/specs/plugins/data-sync.md §4.1
/**
 * A tiny async key/value store for persisted documents, over one IndexedDB database. Hostless —
 * the `IDBFactory` is injected, so tests substitute an in-memory stand-in.
 */

/** The single object store name inside the plugin's database. */
const STORE = "documents";
/** Schema version of the database (one keyed object store). */
const VERSION = 1;

export interface DocumentStore {
  read(key: string): Promise<unknown>;
  write(key: string, doc: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  /** Closes the underlying database connection; later operations reject (idempotent, terminal). */
  close(): void;
}

/**
 * Runs `fn` inside one object-store transaction and resolves only once the *transaction* commits
 * (`tx.oncomplete`), not merely once the individual request inside it succeeds — IndexedDB quota
 * errors and other failures can surface on the transaction (`tx.onerror`/`tx.onabort`) even after
 * the request itself reported success.
 */
function runTransaction<T>(
  connection: IDBDatabase,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | undefined,
): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = connection.transaction(STORE, mode);
    let result: T | undefined;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? new Error("stargantt: IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("stargantt: IndexedDB transaction aborted"));
    const store = tx.objectStore(STORE);
    const request = fn(store);
    if (request !== undefined) {
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => {
        // Left unhandled here; the transaction's own onerror/onabort carries the error and rejects
        // the promise — this handler only stops it bubbling as an unhandled error.
      };
    }
  });
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      const db = request.result;
      // A version-change request from another tab/connection must not be silently ignored: close
      // this connection so the other side's upgrade can proceed and later operations reopen.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("stargantt: IndexedDB open failed"));
    // A blocked upgrade must not hang forever or silently succeed later — fail the open outright.
    request.onblocked = () => reject(new Error("stargantt: IndexedDB open blocked by another connection"));
  });
}

/**
 * Creates a `DocumentStore` over one IndexedDB database (§4.1). The connection opens lazily on
 * the first operation and is reused afterwards; a failed open is not cached, so a later operation
 * retries.
 */
export function idbDocumentStore(factory: IDBFactory, databaseName: string): DocumentStore {
  let dbPromise: Promise<IDBDatabase> | undefined;
  // Terminal flag: after `close()` no operation may reopen a connection — the plugin's `ctx.own()`
  // disposable has already run and a new connection would have no owner.
  let closed = false;

  const db = (): Promise<IDBDatabase> => {
    if (closed) {
      return Promise.reject(new Error("stargantt: data-sync offline document store is closed"));
    }
    if (dbPromise === undefined) {
      dbPromise = openDatabase(factory, databaseName).catch((error: unknown) => {
        dbPromise = undefined;
        throw error;
      });
    }
    return dbPromise;
  };

  return {
    async read(key: string): Promise<unknown> {
      const connection = await db();
      return runTransaction(connection, "readonly", (store) => store.get(key));
    },
    async write(key: string, doc: unknown): Promise<void> {
      const connection = await db();
      await runTransaction(connection, "readwrite", (store) => store.put(doc, key));
    },
    async remove(key: string): Promise<void> {
      const connection = await db();
      await runTransaction(connection, "readwrite", (store) => store.delete(key));
    },
    close(): void {
      closed = true;
      const settled = dbPromise;
      dbPromise = undefined;
      // Close only a connection that actually opened; a pending/failed open has nothing to close.
      void settled?.then((connection) => connection.close()).catch(() => {});
    },
  };
}
