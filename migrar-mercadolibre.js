const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = new DatabaseSync(path.join(__dirname, 'cajaviva.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS mercadolibre_conexion (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    ml_user_id TEXT NOT NULL,
    ml_nickname TEXT,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expira_en TEXT NOT NULL,
    conectado_en TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

try { db.exec('ALTER TABLE productos ADD COLUMN ml_item_id TEXT;'); } catch (e) {}
try { db.exec('ALTER TABLE ventas ADD COLUMN ml_order_id TEXT;'); } catch (e) {}
try { db.exec('ALTER TABLE ventas ADD COLUMN ml_comprador TEXT;'); } catch (e) {}
try { db.exec('ALTER TABLE ventas ADD COLUMN ml_envio_estado TEXT;'); } catch (e) {}

console.log('Tabla mercadolibre_conexion, columna ml_item_id, ml_order_id, ml_comprador y ml_envio_estado listas.');
