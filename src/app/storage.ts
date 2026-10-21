import type { FloorPlan } from '../data/schema';
import { normalizePlan, validatePlan } from '../data/validate';

/**
 * P6: the last built plan is kept on the device in IndexedDB so the start screen can offer
 * "Continue". Every call is wrapped; without storage the app simply has no Continue button.
 */
const DB = 'cad-tour';
const STORE = 'plans';
const LAST = 'last';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}

export async function saveLastPlan(plan: FloorPlan): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(JSON.stringify(plan), LAST);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // No storage: Continue is just not offered next time.
  }
}

export async function loadLastPlan(): Promise<FloorPlan | null> {
  try {
    const db = await open();
    const raw = await new Promise<string | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(LAST);
      req.onsuccess = () => resolve(req.result as string | undefined);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!raw) return null;
    const data = JSON.parse(raw);
    return validatePlan(data).ok ? normalizePlan(data as FloorPlan) : null;
  } catch {
    return null;
  }
}

export async function clearLastPlan(): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(LAST);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    // Ignore.
  }
}
