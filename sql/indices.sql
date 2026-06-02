-- Run once in Supabase SQL editor (Dashboard → SQL Editor → New query)

CREATE INDEX IF NOT EXISTS idx_loc_activo_zona_loc ON localizadores(activo, zona, localizador);
CREATE INDEX IF NOT EXISTS idx_loc_localizador ON localizadores(localizador);
CREATE INDEX IF NOT EXISTS idx_lineas_estado_updated ON lineas_reubicacion(estado, updated_at DESC);
