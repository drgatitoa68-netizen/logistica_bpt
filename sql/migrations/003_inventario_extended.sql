-- ════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 003 — Inventario extendido + RPC importar_subinventario
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query
-- ════════════════════════════════════════════════════════════════════════

-- ── 1. Crear tabla inventario si no existe ────────────────────────────
CREATE TABLE IF NOT EXISTS public.inventario (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo              TEXT         NOT NULL DEFAULT '',
  descripcion         TEXT,
  lote                TEXT,
  localizador         TEXT         NOT NULL,
  subinventario       TEXT,
  pallets             NUMERIC      NOT NULL DEFAULT 0,
  cajas               NUMERIC               DEFAULT 0,
  cantidad_fisica     NUMERIC,
  formato             TEXT,
  um                  TEXT         DEFAULT 'PALLET',
  estado              TEXT         DEFAULT 'ACTIVO',
  lote_status         TEXT         DEFAULT 'OK',
  calidad             TEXT,
  marca               TEXT,
  updated_at          TIMESTAMPTZ  DEFAULT NOW(),
  created_at          TIMESTAMPTZ  DEFAULT NOW()
);

-- ── 2. Añadir columnas extendidas (idempotente) ───────────────────────
ALTER TABLE public.inventario
  ADD COLUMN IF NOT EXISTS cod_org_inv         TEXT,
  ADD COLUMN IF NOT EXISTS nombre_org_inv      TEXT,
  ADD COLUMN IF NOT EXISTS nombre_subinv       TEXT,
  ADD COLUMN IF NOT EXISTS peso                NUMERIC(12,4),
  ADD COLUMN IF NOT EXISTS um_peso             TEXT,
  ADD COLUMN IF NOT EXISTS tipo_inventario     TEXT,
  ADD COLUMN IF NOT EXISTS estado_inventario   TEXT,
  ADD COLUMN IF NOT EXISTS m2_x_caja           NUMERIC(10,4),
  ADD COLUMN IF NOT EXISTS can_reservada       NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS dispo_reservar      NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS um_sec              TEXT,
  ADD COLUMN IF NOT EXISTS cantidad_fisica_sec NUMERIC(12,2);

-- ── 3. Eliminar CHECK restrictivo en estado (Excel envía valores libres) ──
ALTER TABLE public.inventario
  DROP CONSTRAINT IF EXISTS inventario_estado_check;

-- ── 4. Eliminar CHECK restrictivo en lote_status (igual motivo) ──────
ALTER TABLE public.inventario
  DROP CONSTRAINT IF EXISTS inventario_lote_status_check;

-- ── 5. Índices ────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_inv_cod_lote  ON public.inventario(codigo, lote);
CREATE INDEX IF NOT EXISTS idx_inv_loc       ON public.inventario(localizador);
CREATE INDEX IF NOT EXISTS idx_inv_subin     ON public.inventario(subinventario);
CREATE INDEX IF NOT EXISTS idx_inv_estado    ON public.inventario(estado);
CREATE INDEX IF NOT EXISTS idx_inv_updated   ON public.inventario(updated_at DESC);

-- ── 6. RLS ────────────────────────────────────────────────────────────
ALTER TABLE public.inventario ENABLE ROW LEVEL SECURITY;

-- Borrar políticas anteriores (en caso de re-ejecución)
DROP POLICY IF EXISTS "inventario_all_anon"  ON public.inventario;
DROP POLICY IF EXISTS "inventario_all_auth"  ON public.inventario;

CREATE POLICY "inventario_all_auth" ON public.inventario
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── 7. RPC: importar_subinventario ───────────────────────────────────
-- Reemplaza toda la data de un subinventario con el array recibido.
-- Llamado desde analisis-bpt/page.tsx tras cada importación de Excel.
-- p_subinventario : nombre del subinventario (ej. 'ALMACEN')
-- p_rows          : JSONB array de objetos con los campos del inventario
CREATE OR REPLACE FUNCTION public.importar_subinventario(
  p_subinventario TEXT,
  p_rows          JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  r JSONB;
BEGIN
  -- 1. Borrar registros anteriores del subinventario
  DELETE FROM public.inventario WHERE subinventario = p_subinventario;

  -- 2. Insertar nuevos registros
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    INSERT INTO public.inventario (
      codigo, descripcion, lote, localizador, subinventario,
      pallets, cajas, cantidad_fisica, formato,
      cod_org_inv, nombre_org_inv, nombre_subinv,
      um, peso, um_peso, tipo_inventario, calidad, marca,
      estado_inventario, estado, m2_x_caja,
      can_reservada, dispo_reservar, um_sec, cantidad_fisica_sec,
      lote_status, updated_at
    ) VALUES (
      COALESCE(r->>'codigo',              ''),
      r->>'descripcion',
      NULLIF(r->>'lote',                  ''),
      COALESCE(r->>'localizador',         ''),
      p_subinventario,
      COALESCE((r->>'pallets')::NUMERIC,  0),
      COALESCE((r->>'cajas')::NUMERIC,    0),
      (r->>'cantidad_fisica')::NUMERIC,
      NULLIF(r->>'formato',               ''),
      NULLIF(r->>'cod_org_inv',           ''),
      NULLIF(r->>'nombre_org_inv',        ''),
      NULLIF(r->>'nombre_subinv',         ''),
      NULLIF(r->>'um',                    ''),
      (r->>'peso')::NUMERIC,
      NULLIF(r->>'um_peso',               ''),
      NULLIF(r->>'tipo_inventario',       ''),
      NULLIF(r->>'calidad',               ''),
      NULLIF(r->>'marca',                 ''),
      NULLIF(r->>'estado_inventario',     ''),
      NULLIF(r->>'estado',                ''),
      (r->>'m2_x_caja')::NUMERIC,
      (r->>'can_reservada')::NUMERIC,
      (r->>'dispo_reservar')::NUMERIC,
      NULLIF(r->>'um_sec',                ''),
      (r->>'cantidad_fisica_sec')::NUMERIC,
      NULLIF(r->>'lote_status',           ''),
      NOW()
    );
  END LOOP;

  -- 3. Recalcular ocupación de localizadores desde inventario
  PERFORM public.recalcular_ocupacion();

EXCEPTION WHEN others THEN
  RAISE EXCEPTION 'importar_subinventario(%): %', p_subinventario, SQLERRM;
END;
$$;

GRANT EXECUTE ON FUNCTION public.importar_subinventario(TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.importar_subinventario(TEXT, JSONB) TO anon;

-- ── 8. RPC: recalcular_ocupacion (idempotente) ────────────────────────
CREATE OR REPLACE FUNCTION public.recalcular_ocupacion()
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
AS $$
  -- Reset localizadores sin stock
  UPDATE public.localizadores l SET
    ocupado       = 0,
    disponible    = l.capacidad,
    pct_ocupacion = 0
  WHERE NOT EXISTS (
    SELECT 1 FROM public.inventario i WHERE i.localizador = l.localizador
  );

  -- Actualizar desde inventario
  UPDATE public.localizadores l SET
    ocupado       = COALESCE(s.tot, 0),
    disponible    = GREATEST(0, l.capacidad - COALESCE(s.tot, 0)),
    pct_ocupacion = CASE
                      WHEN l.capacidad > 0
                      THEN LEAST(9.9999, COALESCE(s.tot, 0)::NUMERIC / l.capacidad)
                      ELSE 0
                    END
  FROM (
    SELECT localizador, SUM(pallets) AS tot
    FROM public.inventario
    GROUP BY localizador
  ) s
  WHERE l.localizador = s.localizador;
$$;

GRANT EXECUTE ON FUNCTION public.recalcular_ocupacion() TO authenticated;
GRANT EXECUTE ON FUNCTION public.recalcular_ocupacion() TO anon;
