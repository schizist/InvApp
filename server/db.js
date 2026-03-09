const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(__dirname, 'invapp.db');

const db = new sqlite3.Database(DB_PATH);

function init() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        category TEXT,
        reorderLevel INTEGER DEFAULT 0,
        reorderQty INTEGER,
        unit TEXT,
        packSize INTEGER
      )
    `);

    // Ensure new columns exist on older DBs (add if missing)
    db.all(`PRAGMA table_info(items)`, (err, cols) => {
      if (err) return console.error('PRAGMA table_info failed', err);
      const names = (cols || []).map(c => c.name);
      const toAdd = [];
      if (!names.includes('reorderLevel')) toAdd.push(`ALTER TABLE items ADD COLUMN reorderLevel INTEGER DEFAULT 0`);
      if (!names.includes('reorderQty')) toAdd.push(`ALTER TABLE items ADD COLUMN reorderQty INTEGER`);
      if (!names.includes('unit')) toAdd.push(`ALTER TABLE items ADD COLUMN unit TEXT`);
      if (!names.includes('packSize')) toAdd.push(`ALTER TABLE items ADD COLUMN packSize INTEGER`);
      toAdd.forEach(sql => {
        db.run(sql, err2 => { if (err2) console.warn('Failed to add column:', err2.message); });
      });
    });

    db.run(`
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

    db.run(`
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

    // Preload items (insert or ignore) machine id, human readable name, catagory
    const items = [
      // Molds
      ["mold_112","M-112","mold"],
      ["mold_157","M-157","mold"],
      ["mold_157-6","M-157-6","mold"],
      ["mold_157-8","M-157-8","mold"],
      ["mold_157-12","M-157-12","mold"],
      ["mold_157-16","M-157-16","mold"],
      ["mold_157-24","M-157-24","mold"],
      ["mold_159","M-159","mold"],
      ["mold_161","M-161","mold"],
      ["mold_161-16","M-161-16","mold"],
      ["mold_161-20","M-161-20","mold"],
      ["mold_161-24","M-161-24","mold"],
      // Wire
      ["wire_10","#10 Wire","wire"],
      ["wire_8","#8 Wire","wire"],
      ["wire_6","#6 Wire","wire"],
      ["wire_4","#4 Wire","wire"],
      ["wire_2","#2 Wire","wire"],
      ["wire_8_nsf","#8 NSF Wire","wire"],
      // Shots
      ["shot_25_ci","25 CI","shot"],
      ["shot_25_cp","25 CP","shot"],
      ["shot_45_ci","45 CI","shot"],
      // Caps
      ["cap_pc","ThermoCap","cap"],
      // Enclosures
      ["enclosure_fink_blue","Blue Fink","enclosure"],
      ["enclosure_fink_blue_steel","Blue Steel Fink","enclosure"],
      ["enclosure_fink_purple","Purple Fink","enclosure"],
      ["enclosure_g05","G05","enclosure"],
      // Anodes
      ["anode_hp_mag","HP Mag Anode","anode"],
      // Ref Cells
      ["SRE-002","Stelth Cu-CuSO", "refcell"],
    ];

    const stmt = db.prepare(`
        INSERT INTO items (id, label, category)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          label = excluded.label,
          category = excluded.category
      `);
      items.forEach(it => stmt.run(it[0], it[1], it[2]));
      stmt.finalize();

    // Remove stale items that are not in the current seeded list
    const ids = items.map(it => it[0]);
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      db.run(`DELETE FROM items WHERE id NOT IN (${placeholders})`, ids, function(err){
        if (err) console.error('Failed to remove stale items:', err);
      });
    }

    const vendorStmt = db.prepare(`
      INSERT OR IGNORE INTO vendor_options (
        itemId, vendorCompany, contactName, contactEmail, partNumber,
        price, shippingCost, moq, leadTimeDays, onTimeScore, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    items.forEach(([itemId]) => {
      vendorStmt.run(
        itemId,
        'Core Supply Co.',
        'Jordan Rivera',
        'jordan.rivera@coresupply.example',
        `CS-${itemId.toUpperCase()}`,
        100,
        15,
        1,
        14,
        96,
        now
      );
      vendorStmt.run(
        itemId,
        'Alt Source Manufacturing',
        'Sam Patel',
        'sam.patel@altsource.example',
        `ASM-${itemId.toUpperCase()}`,
        108,
        12,
        1,
        21,
        91,
        now
      );
    });
    vendorStmt.finalize();
  });
}

module.exports = { db, init };
