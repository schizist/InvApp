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
        packSize INTEGER,
        primaryVendorId INTEGER,
        altVendorId INTEGER
      )
    `);

    // Ensure new columns exist on older DBs (safe to run repeatedly).
    [
      `ALTER TABLE items ADD COLUMN reorderLevel INTEGER DEFAULT 0`,
      `ALTER TABLE items ADD COLUMN reorderQty INTEGER`,
      `ALTER TABLE items ADD COLUMN unit TEXT`,
      `ALTER TABLE items ADD COLUMN packSize INTEGER`,
      `ALTER TABLE items ADD COLUMN primaryVendorId INTEGER`,
      `ALTER TABLE items ADD COLUMN altVendorId INTEGER`
    ].forEach(sql => {
      db.run(sql, err => {
        if (err && !String(err.message || '').toLowerCase().includes('duplicate column name')) {
          console.warn('Failed to add items column:', err.message);
        }
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

    db.run(`
      CREATE TABLE IF NOT EXISTS vendors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company TEXT NOT NULL UNIQUE,
        contactName TEXT,
        contactEmail TEXT,
        onTimeScore REAL,
        updatedAt TEXT NOT NULL
      )
    `);

    db.run(`ALTER TABLE vendors ADD COLUMN onTimeScore REAL`, err => {
      if (err && !String(err.message || '').toLowerCase().includes('duplicate column name')) {
        console.warn('Failed to add vendors.onTimeScore:', err.message);
      }
    });

    db.run(`
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

    const now = new Date().toISOString();
    const baseVendors = [
      { company: 'Core Supply Co.', contactName: 'Jordan Rivera', contactEmail: 'jordan.rivera@coresupply.example', onTimeScore: 96 },
      { company: 'Alt Source Manufacturing', contactName: 'Sam Patel', contactEmail: 'sam.patel@altsource.example', onTimeScore: 91 }
    ];

    const vendorSeedStmt = db.prepare(`
      INSERT OR IGNORE INTO vendors (company, contactName, contactEmail, updatedAt)
      VALUES (?, ?, ?, ?)
    `);
    baseVendors.forEach(v => vendorSeedStmt.run(v.company, v.contactName, v.contactEmail, now));
    vendorSeedStmt.finalize();

    // Migrate legacy per-item vendor rows into the normalized model.
    db.run(`
      INSERT OR IGNORE INTO vendors (company, contactName, contactEmail, updatedAt)
      SELECT vendorCompany, MAX(contactName), MAX(contactEmail), COALESCE(MAX(updatedAt), ?)
      FROM vendor_options
      GROUP BY vendorCompany
    `, [now]);

    // Backfill vendor-level on-time score when the column exists.
    baseVendors.forEach(v => {
      db.run(
        `UPDATE vendors SET onTimeScore = COALESCE(onTimeScore, ?) WHERE company = ?`,
        [v.onTimeScore, v.company],
        err => { if (err) console.warn('Failed to set default vendor onTimeScore:', err.message); }
      );
    });
    db.run(
      `UPDATE vendors
       SET onTimeScore = COALESCE(
         onTimeScore,
         (SELECT MAX(vo.onTimeScore) FROM vendor_options vo WHERE vo.vendorCompany = vendors.company)
       )`,
      err => { if (err) console.warn('Failed to backfill vendor onTimeScore from legacy options:', err.message); }
    );

    db.run(`
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

    // Ensure each item has a default option row for seeded vendors.
    const optionSeedStmt = db.prepare(`
      INSERT OR IGNORE INTO item_vendor_options (
        itemId, vendorId, partNumber, price, shippingCost, moq, leadTimeDays, onTimeScore, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.all(`SELECT id, company FROM vendors ORDER BY id ASC`, (vendorErr, vendors) => {
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
          db.run(
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

module.exports = { db, init };
