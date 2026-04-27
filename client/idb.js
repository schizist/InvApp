// Minimal IndexedDB helper
(function(global){
  const DB_NAME = 'invapp';
  const DB_VERSION = 4;
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
        if (!db.objectStoreNames.contains('orders')) {
          const store = db.createObjectStore('orders', { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt');
          store.createIndex('poNumber', 'poNumber');
        }
        if (!db.objectStoreNames.contains('orderLines')) {
          const store = db.createObjectStore('orderLines', { keyPath: 'id' });
          store.createIndex('orderId', 'orderId');
        }
        if (!db.objectStoreNames.contains('orderReceipts')) {
          const store = db.createObjectStore('orderReceipts', { keyPath: 'id' });
          store.createIndex('orderId', 'orderId');
          store.createIndex('orderLineId', 'orderLineId');
        }
        if (!db.objectStoreNames.contains('orderChanges')) {
          db.createObjectStore('orderChanges', { keyPath: 'id' });
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

  async function resetAll() {
    const db = await open();
    return new Promise((res, rej) => {
      const stores = ['events', 'remoteEvents', 'meta', 'orders', 'orderLines', 'orderReceipts', 'orderChanges'].filter(name => db.objectStoreNames.contains(name));
      const tx = db.transaction(stores, 'readwrite');
      tx.objectStore('events').clear();
      tx.objectStore('remoteEvents').clear();
      tx.objectStore('meta').clear();
      if (db.objectStoreNames.contains('orders')) tx.objectStore('orders').clear();
      if (db.objectStoreNames.contains('orderLines')) tx.objectStore('orderLines').clear();
      if (db.objectStoreNames.contains('orderReceipts')) tx.objectStore('orderReceipts').clear();
      if (db.objectStoreNames.contains('orderChanges')) tx.objectStore('orderChanges').clear();
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  async function putStore(storeName, value){
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  async function getStoreAll(storeName){
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
  }

  async function getStore(storeName, id){
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(id);
      req.onsuccess = () => res(req.result || null);
      req.onerror = () => rej(req.error);
    });
  }

  async function getByIndex(storeName, indexName, value){
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).index(indexName).getAll(value);
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
  }

  async function putOrder(order){ return putStore('orders', order); }
  async function putOrderLine(line){ return putStore('orderLines', line); }
  async function putOrderReceipt(receipt){ return putStore('orderReceipts', receipt); }
  async function getOrders(){ return getStoreAll('orders'); }
  async function getOrder(id){ return getStore('orders', id); }
  async function getOrderLines(orderId){ return getByIndex('orderLines', 'orderId', orderId); }
  async function getOrderReceipts(orderId){ return getByIndex('orderReceipts', 'orderId', orderId); }
  async function queueOrderChange(change){ return putStore('orderChanges', change); }
  async function getQueuedOrderChanges(){ return getStoreAll('orderChanges'); }
  async function clearOrderChanges(ids){
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction('orderChanges','readwrite');
      const store = tx.objectStore('orderChanges');
      ids.forEach(id => store.delete(id));
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  async function deleteOrderLine(id){
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction('orderLines','readwrite');
      tx.objectStore('orderLines').delete(id);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  async function storeOrderGraph(order){
    if (!order || !order.id) return;
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction(['orders', 'orderLines', 'orderReceipts'], 'readwrite');
      tx.objectStore('orders').put(Object.assign({}, order, { lines: undefined, receipts: undefined, progress: order.progress || null }));
      (order.lines || []).forEach(line => {
        tx.objectStore('orderLines').put(Object.assign({}, line, { receipts: undefined }));
        (line.receipts || []).forEach(receipt => tx.objectStore('orderReceipts').put(receipt));
      });
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
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
    getLastSyncTime,
    resetAll,
    putOrder,
    putOrderLine,
    putOrderReceipt,
    getOrders,
    getOrder,
    getOrderLines,
    getOrderReceipts,
    deleteOrderLine,
    queueOrderChange,
    getQueuedOrderChanges,
    clearOrderChanges,
    storeOrderGraph
  };
})(window);
