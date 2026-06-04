-- Run once in Supabase SQL editor (Dashboard → SQL Editor → New query)

-- ── localizadores ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_loc_activo_zona_loc ON localizadores(activo, zona, localizador);
CREATE INDEX IF NOT EXISTS idx_loc_localizador      ON localizadores(localizador);

-- ── lineas_reubicacion ───────────────────────────────────────────────────────
-- Filtro por estado + orden por fecha (pantalla supervisor y operador)
CREATE INDEX IF NOT EXISTS idx_lineas_estado_updated ON lineas_reubicacion(estado, updated_at DESC);
-- Orden por fecha de creación (carga inicial del supervisor)
CREATE INDEX IF NOT EXISTS idx_lineas_created_at     ON lineas_reubicacion(created_at DESC);
-- Filtro por responsable/operador (filtro en órdenes)
CREATE INDEX IF NOT EXISTS idx_lineas_responsable    ON lineas_reubicacion(responsable);
-- Búsqueda por código de producto
CREATE INDEX IF NOT EXISTS idx_lineas_codigo         ON lineas_reubicacion(codigo);

-- ── inventario ───────────────────────────────────────────────────────────────
-- Ya existentes: idx_inv_cod_lote (codigo, lote)  +  idx_inv_loc (localizador)
-- Filtros de la página de inventario
CREATE INDEX IF NOT EXISTS idx_inv_subinventario     ON inventario(subinventario);
CREATE INDEX IF NOT EXISTS idx_inv_um                ON inventario(um);
CREATE INDEX IF NOT EXISTS idx_inv_estado            ON inventario(estado);
-- Orden por defecto (subinventario + codigo)
CREATE INDEX IF NOT EXISTS idx_inv_subinv_codigo     ON inventario(subinventario, codigo);
-- Orden por pallets DESC (export / KPI)
CREATE INDEX IF NOT EXISTS idx_inv_pallets           ON inventario(pallets DESC);

-- ── catalogo_metraje ─────────────────────────────────────────────────────────
-- codigo es PK, ya tiene índice implícito
CREATE INDEX IF NOT EXISTS idx_cat_linea_negocio     ON catalogo_metraje(linea_negocio);

-- ── catalogo_productos (tabla nueva) ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_catprod_linea_negocio ON catalogo_productos(linea_negocio);
CREATE INDEX IF NOT EXISTS idx_catprod_formato       ON catalogo_productos(formato);
