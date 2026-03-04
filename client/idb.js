// Minimal IndexedDB helper
(function(global){
  const DB_NAME = 'invapp';
  const DB_VERSION = 3;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('events')) {
          const store = db.createObjectStore('events', { keyPath: 'id' });
          store.createIndex('timestamp', 'timestamp');
          store.createIndex('itemId', 'itemId');
        }
        if (!db.objectStoreNames.contains('remoteEvents')) {
          db.createObjectStore('remoteEvents', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  async function addEvent(ev) {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction('events','readwrite');
      tx.objectStore('events').put(ev);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  async function getQueued() {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction('events','readonly');
      const req = tx.objectStore('events').getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
  }

  async function clearEvents(ids) {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction('events','readwrite');
      const store = tx.objectStore('events');
      ids.forEach(id => store.delete(id));
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  async function storeRemoteEvents(events) {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction('remoteEvents','readwrite');
      const store = tx.objectStore('remoteEvents');
      events.forEach(e => store.put(e));
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  async function setMeta(key, value) {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction('meta','readwrite');
      tx.objectStore('meta').put({ key, value });
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  async function getMeta(key) {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction('meta','readonly');
      const req = tx.objectStore('meta').get(key);
      req.onsuccess = () => res(req.result ? req.result.value : null);
      req.onerror = () => rej(req.error);
    });
  }

  async function setLastSynced(ts){ return setMeta('lastSynced', ts); }
  async function getLastSynced(){ return getMeta('lastSynced'); }
  async function setSession(sessionId){ return setMeta('sessionId', sessionId); }
  async function getSession(){ return getMeta('sessionId'); }
  async function setLastItems(items){ return setMeta('lastItems', items || []); }
  async function getLastItems(){ return getMeta('lastItems'); }
  async function setLastSyncTime(ts){ return setMeta('lastSyncTime', ts); }
  async function getLastSyncTime(){ return getMeta('lastSyncTime'); }

  async function getAllRemote() {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction('remoteEvents','readonly');
      const req = tx.objectStore('remoteEvents').getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
  }

  global.IDB = {
    addEvent,
    getQueued,
    clearEvents,
    storeRemoteEvents,
    getAllRemote,
    setLastSynced,
    getLastSynced,
    setSession,
    getSession,
    setLastItems,
    getLastItems,
    setLastSyncTime,
    getLastSyncTime
  };
})(window);
