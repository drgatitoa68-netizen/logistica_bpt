-- ════════════════════════════════════════════════════════════════════════════════
-- EJECUTAR EN: Supabase Dashboard → SQL Editor → New Query
-- ════════════════════════════════════════════════════════════════════════════════

-- 🔧 PASO 1: CREAR/ACTUALIZAR TABLA INVENTARIO
-- Ejecutar esto primero si la tabla no existe
ALTER TABLE IF EXISTS inventario ADD COLUMN IF NOT EXISTS um TEXT DEFAULT 'PALLET';
ALTER TABLE IF EXISTS inventario ADD COLUMN IF NOT EXISTS estado TEXT DEFAULT 'ACTIVO' 
  CHECK (estado in ('ACTIVO', 'BLOQUEADO', 'OBSOLETO', 'DEFECTUOSO'));
ALTER TABLE IF EXISTS inventario ADD COLUMN IF NOT EXISTS lote_status TEXT DEFAULT 'OK' 
  CHECK (lote_status in ('OK', 'RETENIDO', 'CUARENTENA', 'INSPECCIONAR'));
ALTER TABLE IF EXISTS inventario ADD COLUMN IF NOT EXISTS calidad TEXT;
ALTER TABLE IF EXISTS inventario ADD COLUMN IF NOT EXISTS marca TEXT;
ALTER TABLE IF EXISTS inventario ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

-- ════════════════════════════════════════════════════════════════════════════════
-- 🎯 PASO 2: GENERAR DATOS DE EJEMPLO (si la tabla está vacía)
-- ════════════════════════════════════════════════════════════════════════════════
INSERT INTO inventario (
  codigo, descripcion, lote, localizador, subinventario, 
  pallets, cajas, cantidad_fisica, formato, um, estado, 
  lote_status, calidad, marca
)
WITH datos AS (
  SELECT 
    ROW_NUMBER() OVER () as rn,
    'PRD-' || LPAD((ROW_NUMBER() OVER ())::TEXT, 5, '0') as codigo,
    'Producto ' || LPAD((ROW_NUMBER() OVER ())::TEXT, 5, '0') as descripcion,
    'LOTE-' || TO_CHAR(NOW(), 'YYYYMM') || '-' || LPAD((ROW_NUMBER() OVER () % 20 + 1)::TEXT, 2, '0') as lote,
    (SELECT localizador FROM localizadores WHERE activo = TRUE ORDER BY random() LIMIT 1) as localizador,
    CASE 
      WHEN (ROW_NUMBER() OVER ()) % 3 = 1 THEN 'ALMACEN'
      WHEN (ROW_NUMBER() OVER ()) % 3 = 2 THEN 'PRODUCCION'
      ELSE 'DESPACHO'
    END as subinventario,
    ((ROW_NUMBER() OVER ()) % 8 + 1)::numeric as pallets,
    ((ROW_NUMBER() OVER ()) % 12 * 5)::numeric as cajas,
    (((ROW_NUMBER() OVER ()) % 8 + 1) * 1.5 + ((ROW_NUMBER() OVER ()) % 10) * 0.3)::numeric as cantidad_fisica,
    CASE 
      WHEN (ROW_NUMBER() OVER ()) % 4 = 0 THEN '45x45'
      WHEN (ROW_NUMBER() OVER ()) % 4 = 1 THEN '30x60'
      WHEN (ROW_NUMBER() OVER ()) % 4 = 2 THEN '29x59'
      ELSE 'MEZCLA'
    END as formato,
    CASE 
      WHEN (ROW_NUMBER() OVER ()) % 3 = 0 THEN 'CAJA'
      WHEN (ROW_NUMBER() OVER ()) % 3 = 1 THEN 'PIEZA'
      ELSE 'PALLET'
    END as um,
    CASE 
      WHEN (ROW_NUMBER() OVER ()) % 50 = 0 THEN 'BLOQUEADO'
      WHEN (ROW_NUMBER() OVER ()) % 50 = 1 THEN 'OBSOLETO'
      WHEN (ROW_NUMBER() OVER ()) % 50 = 2 THEN 'DEFECTUOSO'
      ELSE 'ACTIVO'
    END as estado,
    CASE 
      WHEN (ROW_NUMBER() OVER ()) % 30 = 0 THEN 'RETENIDO'
      WHEN (ROW_NUMBER() OVER ()) % 30 = 1 THEN 'CUARENTENA'
      WHEN (ROW_NUMBER() OVER ()) % 30 = 2 THEN 'INSPECCIONAR'
      ELSE 'OK'
    END as lote_status,
    CASE 
      WHEN (ROW_NUMBER() OVER ()) % 20 = 0 THEN 'DEFECTUOSA'
      ELSE 'BUENA'
    END as calidad,
    'MARCA-' || LPAD(((ROW_NUMBER() OVER ()) % 12 + 1)::TEXT, 2, '0') as marca
  FROM generate_series(1, 150)
)
SELECT 
  codigo, descripcion, lote, localizador, subinventario,
  pallets, cajas, cantidad_fisica, formato, um, estado,
  lote_status, calidad, marca
FROM datos
WHERE localizador IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM inventario LIMIT 1)  -- Solo si tabla vacía
ON CONFLICT DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════════
-- ✅ VERIFICAR RESULTADO
-- ════════════════════════════════════════════════════════════════════════════════
SELECT 
  COUNT(*) as registros,
  COUNT(DISTINCT codigo) as productos_unicos,
  COUNT(DISTINCT lote) as lotes,
  COUNT(DISTINCT localizador) as localizadores,
  ROUND(SUM(pallets)::NUMERIC, 1) as pallets_totales,
  ROUND(SUM(cajas)::NUMERIC, 1) as cajas_totales
FROM inventario;

-- Ver primeros registros:
SELECT * FROM inventario ORDER BY created_at DESC LIMIT 10;
