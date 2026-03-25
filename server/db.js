const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_DIR = __dirname;
const STATE_PATH = path.join(DB_DIR, 'db_state.json');
const DEFAULT_DB_NAME = 'invapp.db';

let currentDbName = loadCurrentDbName();
let currentDb = null;

function loadCurrentDbName(){
  try{
    if (!fs.existsSync(STATE_PATH)) return DEFAULT_DB_NAME;
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeDbName(parsed.current || DEFAULT_DB_NAME);
  }catch(_err){
    return DEFAULT_DB_NAME;
  }
}

function saveCurrentDbName(name){
  try{
    fs.writeFileSync(STATE_PATH, JSON.stringify({ current: name }, null, 2));
  }catch(err){
    console.warn('Failed to persist DB state:', err.message);
  }
}

function normalizeDbName(name){
  const raw = String(name || '').trim();
  if (!raw) throw new Error('Database name is required');
  const withExt = raw.toLowerCase().endsWith('.db') ? raw : `${raw}.db`;
  const base = path.basename(withExt);
  if (!/^[a-zA-Z0-9_-]+\.db$/.test(base)) {
    throw new Error('Database name may only include letters, numbers, underscore, and dash');
  }
  return base;
}

function dbPathFor(name){
  return path.join(DB_DIR, normalizeDbName(name));
}

function listDatabases(){
  try{
    return fs.readdirSync(DB_DIR)
      .filter(f => f.toLowerCase().endsWith('.db'))
      .sort((a,b) => a.localeCompare(b));
  }catch(_err){
    return [DEFAULT_DB_NAME];
  }
}

function getCurrentDatabaseName(){
  return currentDbName;
}

function openCurrentDb(){
  if (currentDb) return currentDb;
  const fullPath = dbPathFor(currentDbName);
  currentDb = new sqlite3.Database(fullPath);
  return currentDb;
}

function closeCurrentDb(){
  if (!currentDb) return;
  try { currentDb.close(); } catch(_err){}
  currentDb = null;
}

function ensureColumns(dbConn, tableName, alterStatements){
  alterStatements.forEach(sql => {
    dbConn.run(sql, err => {
      if (err && !String(err.message || '').toLowerCase().includes('duplicate column name')) {
        console.warn(`Failed to add ${tableName} column:`, err.message);
      }
    });
  });
}

function initializeSchema(dbConn){
  dbConn.serialize(() => {
    dbConn.run(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        category TEXT,
        reorderLevel INTEGER DEFAULT 0,
        reorderQty INTEGER,
        unit TEXT,
        packSize INTEGER,
        primaryVendorId INTEGER,
        altVendorId INTEGER
      )
    `);

    ensureColumns(dbConn, 'items', [
      `ALTER TABLE items ADD COLUMN reorderLevel INTEGER DEFAULT 0`,
      `ALTER TABLE items ADD COLUMN reorderQty INTEGER`,
      `ALTER TABLE items ADD COLUMN unit TEXT`,
      `ALTER TABLE items ADD COLUMN packSize INTEGER`,
      `ALTER TABLE items ADD COLUMN primaryVendorId INTEGER`,
      `ALTER TABLE items ADD COLUMN altVendorId INTEGER`
    ]);

    dbConn.run(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        itemId TEXT NOT NULL,
        type TEXT NOT NULL,
        qty INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        sessionId TEXT,
        note TEXT,
        source TEXT
      )
    `);

    dbConn.run(`
      CREATE TABLE IF NOT EXISTS vendor_options (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        itemId TEXT NOT NULL,
        vendorCompany TEXT NOT NULL,
        contactName TEXT,
        contactEmail TEXT,
        partNumber TEXT,
        price REAL,
        shippingCost REAL,
        moq INTEGER,
        leadTimeDays INTEGER,
        onTimeScore REAL,
        updatedAt TEXT NOT NULL,
        UNIQUE(itemId, vendorCompany, partNumber)
      )
    `);

    dbConn.run(`
      CREATE TABLE IF NOT EXISTS vendors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company TEXT NOT NULL UNIQUE,
        contactName TEXT,
        contactEmail TEXT,
        onTimeScore REAL,
        updatedAt TEXT NOT NULL
      )
    `);

    ensureColumns(dbConn, 'vendors', [
      `ALTER TABLE vendors ADD COLUMN onTimeScore REAL`
    ]);

    dbConn.run(`
      CREATE TABLE IF NOT EXISTS item_vendor_options (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        itemId TEXT NOT NULL,
        vendorId INTEGER NOT NULL,
        partNumber TEXT,
        price REAL,
        shippingCost REAL,
        moq INTEGER,
        leadTimeDays INTEGER,
        onTimeScore REAL,
        updatedAt TEXT NOT NULL,
        UNIQUE(itemId, vendorId)
      )
    `);

    const items = [
      ['mold_112','M-112','mold'],
      ['mold_157','M-157','mold'],
      ['mold_157-6','M-157-6','mold'],
      ['mold_157-8','M-157-8','mold'],
      ['mold_157-12','M-157-12','mold'],
      ['mold_157-16','M-157-16','mold'],
      ['mold_157-24','M-157-24','mold'],
      ['mold_159','M-159','mold'],
      ['mold_161','M-161','mold'],
      ['mold_161-16','M-161-16','mold'],
      ['mold_161-24','M-161-24','mold'],
      ['wire_10','#10 Wire','wire'],
      ['wire_8','#8 Wire','wire'],
      ['wire_6','#6 Wire','wire'],
      ['wire_4','#4 Wire','wire'],
      ['wire_2','#2 Wire','wire'],
      ['wire_8_nsf','#8 NSF Wire','wire'],
      ['shot_25_ci','25 CI','shot'],
      ['shot_25_cp','25 CP','shot'],
      ['shot_45_ci','45 CI','shot'],
      ['cap_pc','ThermoCap','cap'],
      ['enclosure_fink_blue','Blue Fink','enclosure'],
      ['enclosure_fink_blue_steel','Blue Steel Fink','enclosure'],
      ['enclosure_fink_purple','Purple Fink','enclosure'],
      ['enclosure_g05','G05','enclosure'],
      ['anode_hp_mag','HP Mag Anode','anode'],
      ['SRE-002','Stelth Cu-CuSO','refcell']
    ];

    const itemStmt = dbConn.prepare(`
      INSERT INTO items (id, label, category)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        category = excluded.category
    `);
    items.forEach(it => itemStmt.run(it[0], it[1], it[2]));
    itemStmt.finalize();

    const ids = items.map(it => it[0]);
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      dbConn.run(`DELETE FROM items WHERE id NOT IN (${placeholders})`, ids, err => {
        if (err) console.error('Failed to remove stale items:', err);
      });
    }

    const now = new Date().toISOString();
    const baseVendors = [
      { company: 'Core Supply Co.', contactName: 'Jordan Rivera', contactEmail: 'jordan.rivera@coresupply.example', onTimeScore: 96 },
      { company: 'Alt Source Manufacturing', contactName: 'Sam Patel', contactEmail: 'sam.patel@altsource.example', onTimeScore: 91 }
    ];

    const vendorSeedStmt = dbConn.prepare(`
      INSERT OR IGNORE INTO vendors (company, contactName, contactEmail, updatedAt)
      VALUES (?, ?, ?, ?)
    `);
    baseVendors.forEach(v => vendorSeedStmt.run(v.company, v.contactName, v.contactEmail, now));
    vendorSeedStmt.finalize();

    dbConn.run(`
      INSERT OR IGNORE INTO vendors (company, contactName, contactEmail, updatedAt)
      SELECT vendorCompany, MAX(contactName), MAX(contactEmail), COALESCE(MAX(updatedAt), ?)
      FROM vendor_options
      GROUP BY vendorCompany
    `, [now]);

    baseVendors.forEach(v => {
      dbConn.run(
        `UPDATE vendors SET onTimeScore = COALESCE(onTimeScore, ?) WHERE company = ?`,
        [v.onTimeScore, v.company],
        err => { if (err) console.warn('Failed to set default vendor onTimeScore:', err.message); }
      );
    });

    dbConn.run(
      `UPDATE vendors
       SET onTimeScore = COALESCE(
         onTimeScore,
         (SELECT MAX(vo.onTimeScore) FROM vendor_options vo WHERE vo.vendorCompany = vendors.company)
       )`,
      err => { if (err) console.warn('Failed to backfill vendor onTimeScore from legacy options:', err.message); }
    );

    dbConn.run(`
      INSERT OR IGNORE INTO item_vendor_options (
        itemId, vendorId, partNumber, price, shippingCost, moq, leadTimeDays, onTimeScore, updatedAt
      )
      SELECT
        vo.itemId,
        v.id,
        vo.partNumber,
        vo.price,
        vo.shippingCost,
        vo.moq,
        vo.leadTimeDays,
        vo.onTimeScore,
        COALESCE(vo.updatedAt, ?)
      FROM vendor_options vo
      JOIN vendors v ON v.company = vo.vendorCompany
    `, [now]);

    const optionSeedStmt = dbConn.prepare(`
      INSERT OR IGNORE INTO item_vendor_options (
        itemId, vendorId, partNumber, price, shippingCost, moq, leadTimeDays, onTimeScore, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    dbConn.all(`SELECT id, company FROM vendors ORDER BY id ASC`, (vendorErr, vendors) => {
      if (vendorErr) return console.error('Failed to seed vendor options:', vendorErr);
      const primaryDefaultId = vendors[0] ? vendors[0].id : null;
      const altDefaultId = vendors[1] ? vendors[1].id : primaryDefaultId;
      items.forEach(([itemId]) => {
        vendors.forEach(vendor => {
          const prefix = vendor.company === 'Core Supply Co.' ? 'CS' : 'ASM';
          const defaults = vendor.company === 'Core Supply Co.'
            ? { price: 100, shippingCost: 15, moq: 1, leadTimeDays: 14, onTimeScore: 96 }
            : { price: 108, shippingCost: 12, moq: 1, leadTimeDays: 21, onTimeScore: 91 };
          optionSeedStmt.run(
            itemId,
            vendor.id,
            `${prefix}-${itemId.toUpperCase()}`,
            defaults.price,
            defaults.shippingCost,
            defaults.moq,
            defaults.leadTimeDays,
            defaults.onTimeScore,
            now
          );
        });
        if (primaryDefaultId !== null) {
          dbConn.run(
            `UPDATE items
             SET primaryVendorId = COALESCE(primaryVendorId, ?),
                 altVendorId = COALESCE(altVendorId, ?)
             WHERE id = ?`,
            [primaryDefaultId, altDefaultId, itemId]
          );
        }
      });
      optionSeedStmt.finalize();
    });
  });
}

const dbProxy = new Proxy({}, {
  get(_target, prop){
    const dbConn = openCurrentDb();
    const value = dbConn[prop];
    if (typeof value === 'function') return value.bind(dbConn);
    return value;
  }
});

function init(){
  const dbConn = openCurrentDb();
  initializeSchema(dbConn);
}

function switchDatabase(name){
  const normalized = normalizeDbName(name);
  const fullPath = dbPathFor(normalized);
  if (!fs.existsSync(fullPath)) throw new Error('Database not found');
  closeCurrentDb();
  currentDbName = normalized;
  saveCurrentDbName(currentDbName);
  init();
  return currentDbName;
}

function createDatabase(name){
  const normalized = normalizeDbName(name);
  const fullPath = dbPathFor(normalized);
  if (fs.existsSync(fullPath)) throw new Error('Database already exists');
  const tmp = new sqlite3.Database(fullPath);
  tmp.close();
  return switchDatabase(normalized);
}

module.exports = {
  db: dbProxy,
  init,
  listDatabases,
  getCurrentDatabaseName,
  switchDatabase,
  createDatabase
};