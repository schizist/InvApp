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
        category TEXT
      )
    `);

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

    // Preload items (insert or ignore) machine id, human readable name, catagory
    const items = [
      ["wire_10","#10 Wire","wire"],
      ["wire_8","#8 Wire","wire"],
      ["wire_6","#6 Wire","wire"],
      ["wire_4","#4 Wire","wire"],
      ["wire_2","#2 Wire","wire"],
      ["wire_8_nsf","#8 NSF Wire","wire"],
      ["mold_161","M-161","mold"],
      ["mold_161-16","M-161-16","mold"],
      ["mold_161-20","M-161-20","mold"],
      ["mold_161-24","M-161-24","mold"],
      ["mold_157","M-157","mold"],
      ["mold_157-16","M-157-16","mold"],
      ["mold_157-20","M-157-20","mold"],
      ["mold_157-24","M-157-24","mold"],
      ["mold_112","M-112","mold"],
      ["cap_pc","ThermoCap","cap"],
      ["shot_25_ci","25 CI","shot"],
      ["shot_25_cp","25 CP","shot"],
      ["shot_45_ci","45 CI","shot"],
      ["shot_45_cp","45 CP","shot"],
      ["enclosure_fink_blue","Blue Fink","enclosure"],
      ["enclosure_fink_purple","Purple Fink","enclosure"],
      ["enclosure_g05","G05","enclosure"],
      ["anode_hp_mag","HP Mag Anode","anode"]
    ];

    const stmt = db.prepare(`INSERT OR IGNORE INTO items(id,label,category) VALUES(?,?,?)`);
    items.forEach(it => stmt.run(it[0], it[1], it[2]));
    stmt.finalize();
  });
}

module.exports = { db, init };
