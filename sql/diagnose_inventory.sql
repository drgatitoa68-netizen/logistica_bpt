-- ════════════════════════════════════════════════════════════════════════════════
-- 🔍 DIAGNÓSTICO: ¿Por qué no se ven los datos en la app?
-- Ejecuta estos comandos en Supabase SQL Editor
-- ════════════════════════════════════════════════════════════════════════════════

-- 1️⃣ VER ESTRUCTURA DE LA TABLA (qué columnas tiene)
-- ────────────────────────────────────────────────────────────────────────────────
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'inventario'
ORDER BY ordinal_position;

-- 2️⃣ VER CUÁNTOS REGISTROS HAY
-- ────────────────────────────────────────────────────────────────────────────────
SELECT COUNT(*) as total_registros FROM inventario;

-- 3️⃣ VER PRIMEROS 5 REGISTROS
-- ────────────────────────────────────────────────────────────────────────────────
SELECT * FROM inventario LIMIT 5;

-- 4️⃣ VER POLITICAS RLS (Row Level Security)
-- ────────────────────────────────────────────────────────────────────────────────
SELECT * FROM pg_policies WHERE tablename = 'inventario';

-- ════════════════════════════════════════════════════════════════════════════════
-- ✅ SOLUCIÓN: Si faltan columnas, ejecuta esto:
-- ════════════════════════════════════════════════════════════════════════════════

-- Agregar columnas faltantes (si no existen)
ALTER TABLE inventario ADD COLUMN IF NOT EXISTS um TEXT DEFAULT 'PALLET';
ALTER TABLE inventario ADD COLUMN IF NOT EXISTS estado TEXT DEFAULT 'ACTIVO';
ALTER TABLE inventario ADD COLUMN IF NOT EXISTS lote_status TEXT DEFAULT 'OK';
ALTER TABLE inventario ADD COLUMN IF NOT EXISTS calidad TEXT;
ALTER TABLE inventario ADD COLUMN IF NOT EXISTS marca TEXT;
ALTER TABLE inventario ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

-- ════════════════════════════════════════════════════════════════════════════════
-- 🔐 Si la tabla NO tiene RLS, agrégalo:
-- ════════════════════════════════════════════════════════════════════════════════

ALTER TABLE inventario ENABLE ROW LEVEL SECURITY;

-- Permitir lectura pública (importante para la app que usa cliente anon)
CREATE POLICY IF NOT EXISTS "inventario_read_all" 
  ON inventario FOR SELECT TO anon 
  USING (true);

-- Permitir insert/update/delete si lo necesitas
CREATE POLICY IF NOT EXISTS "inventario_write_all" 
  ON inventario FOR ALL TO anon 
  USING (true) WITH CHECK (true);

-- ════════════════════════════════════════════════════════════════════════════════
-- ✅ VERIFICAR RESULTADO
-- ════════════════════════════════════════════════════════════════════════════════
SELECT 
  COUNT(*) as registros,
  COUNT(DISTINCT codigo) as productos_unicos,
  COUNT(DISTINCT localizador) as localizadores_ocupados
FROM inventario;

-- Ver primeros 10 registros con todos los campos
SELECT 
  id, codigo, descripcion, lote, localizador, subinventario,
  pallets, cajas, cantidad_fisica, formato, um, estado,
  lote_status, calidad, marca, updated_at
FROM inventario 
LIMIT 10;
