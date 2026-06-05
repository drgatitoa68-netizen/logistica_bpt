-- ═══════════════════════════════════════════════════════
-- LOGISTICA BPT — Schema completo
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query
-- ═══════════════════════════════════════════════════════

-- ── MIGRACIONES (si las tablas ya existen) ──────────────
ALTER TABLE public.lineas_reubicacion
  ADD COLUMN IF NOT EXISTS metraje NUMERIC(12,2);

ALTER TABLE public.catalogo_metraje
  ADD COLUMN IF NOT EXISTS cajas_por_pallet NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS m2_x_caja        NUMERIC(8,4),
  ADD COLUMN IF NOT EXISTS linea_negocio    TEXT;
-- ────────────────────────────────────────────────────────

-- ── 1. TABLA: localizadores ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.localizadores (
  zona          TEXT        NOT NULL,
  localizador   TEXT        NOT NULL,
  formato       TEXT        NOT NULL DEFAULT 'Mezcla',
  capacidad     INTEGER     NOT NULL DEFAULT 0,
  ocupado       INTEGER     NOT NULL DEFAULT 0,
  disponible    INTEGER     NOT NULL DEFAULT 0,
  pct_ocupacion NUMERIC(7,4) NOT NULL DEFAULT 0,
  activo        BOOLEAN     NOT NULL DEFAULT TRUE,
  CONSTRAINT localizadores_pkey PRIMARY KEY (zona, localizador)
);

-- ── 2. TABLA: lineas_reubicacion ─────────────────────────
CREATE TABLE IF NOT EXISTS public.lineas_reubicacion (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  numero_orden          TEXT,
  cod_org_inv           TEXT,
  codigo                TEXT,
  descripcion           TEXT         NOT NULL,
  subinventario_origen  TEXT,
  localizador_origen    TEXT,
  lote                  TEXT,
  cantidad_fisica       NUMERIC(12,2) DEFAULT 0,
  pallets               INTEGER      NOT NULL DEFAULT 0,
  cajas                 INTEGER      NOT NULL DEFAULT 0,
  subinventario_destino TEXT,
  localizador_destino   TEXT,
  responsable           TEXT,
  inv_pe                NUMERIC(12,2),
  conteo                INTEGER,
  estado                TEXT         NOT NULL DEFAULT 'pendiente'
                          CHECK (estado IN ('pendiente','aprobada','rechazada','en_proceso','completada')),
  supervisor_email      TEXT,
  notas_supervisor      TEXT,
  operador_email        TEXT,
  inicio_operador       TIMESTAMPTZ,
  fin_operador          TIMESTAMPTZ,
  duracion_minutos      NUMERIC(10,2),
  es_fraccion           BOOLEAN      DEFAULT FALSE,
  linea_padre_id        UUID         REFERENCES public.lineas_reubicacion(id) ON DELETE SET NULL,
  notas                 TEXT,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── 3. TABLA: usuarios_bodega ──────────────────────────
CREATE TABLE IF NOT EXISTS public.usuarios_bodega (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT,
  nombre      TEXT    NOT NULL,
  rol         TEXT,            -- OPERADOR | SUPERVISOR | JEFATURA
  bodega_cedi TEXT,
  activo      BOOLEAN NOT NULL DEFAULT TRUE
);

ALTER TABLE public.usuarios_bodega ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all_op_bodega" ON public.usuarios_bodega
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Datos iniciales (desde proyecto de referencia)
INSERT INTO public.usuarios_bodega (id, email, nombre, rol, bodega_cedi) VALUES
  ('327e4140-60da-49bd-851e-8fbd9b413c0c','drgatito_a68@outlook.com','DARWIN RODRIGUEZ','JEFATURA','GR103'),
  ('49cb562f-3a95-4bbc-9e9b-9258c719613e','acumbe@graiman.com','ANDRES CUMBE FAICAN','OPERADOR','GR103'),
  ('62b14dbb-800d-491b-add3-c3ad7f6516b2','fpangol@graiman.com','NELSON FABIAN PANGOL GORDILLO','SUPERVISOR','GR103'),
  ('8fd17b9f-d228-4c6d-be23-144534400889','arodriguez@graiman.com','DARWIN ANDRES RODRIGUEZ MERINO','OPERADOR','GR103')
ON CONFLICT (id) DO NOTHING;

-- ── 4. TABLA: catalogo_metraje ───────────────────────────
CREATE TABLE IF NOT EXISTS public.catalogo_metraje (
  codigo             TEXT         PRIMARY KEY,
  descripcion        TEXT,
  linea_negocio      TEXT,
  cajas_por_pallet   NUMERIC(8,2),
  m2_x_caja          NUMERIC(8,4),
  m2_x_pe            NUMERIC(8,4),
  formato            TEXT,
  metraje_por_pallet NUMERIC(8,4) NOT NULL DEFAULT 1.2
);

ALTER TABLE public.catalogo_metraje ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_select_catalogo" ON public.catalogo_metraje
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_insert_catalogo" ON public.catalogo_metraje
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_update_catalogo" ON public.catalogo_metraje
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- ── 4. ÍNDICES (performance) ─────────────────────────────
CREATE INDEX IF NOT EXISTS idx_loc_activo_zona_loc
  ON public.localizadores(activo, zona, localizador);

CREATE INDEX IF NOT EXISTS idx_loc_localizador
  ON public.localizadores(localizador);

CREATE INDEX IF NOT EXISTS idx_lineas_estado_updated
  ON public.lineas_reubicacion(estado, updated_at DESC);

-- ── 4. ROW LEVEL SECURITY ────────────────────────────────
-- Habilitar RLS
ALTER TABLE public.localizadores      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lineas_reubicacion ENABLE ROW LEVEL SECURITY;

-- Políticas: solo usuarios autenticados pueden leer/escribir
CREATE POLICY "auth_select_localizadores" ON public.localizadores
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_insert_localizadores" ON public.localizadores
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "auth_update_localizadores" ON public.localizadores
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "auth_select_lineas" ON public.lineas_reubicacion
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_insert_lineas" ON public.lineas_reubicacion
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "auth_update_lineas" ON public.lineas_reubicacion
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- ── 5. TABLA: inventario ─────────────────────────────────
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
  -- Columnas extendidas (del Excel de stock de Oracle EBS)
  cod_org_inv         TEXT,
  nombre_org_inv      TEXT,
  nombre_subinv       TEXT,
  peso                NUMERIC(12,4),
  um_peso             TEXT,
  tipo_inventario     TEXT,
  estado_inventario   TEXT,
  m2_x_caja           NUMERIC(10,4),
  can_reservada       NUMERIC(12,2),
  dispo_reservar      NUMERIC(12,2),
  um_sec              TEXT,
  cantidad_fisica_sec NUMERIC(12,2),
  updated_at          TIMESTAMPTZ  DEFAULT NOW(),
  created_at          TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inv_cod_lote ON public.inventario(codigo, lote);
CREATE INDEX IF NOT EXISTS idx_inv_loc      ON public.inventario(localizador);
CREATE INDEX IF NOT EXISTS idx_inv_subin    ON public.inventario(subinventario);
CREATE INDEX IF NOT EXISTS idx_inv_estado   ON public.inventario(estado);
CREATE INDEX IF NOT EXISTS idx_inv_updated  ON public.inventario(updated_at DESC);

ALTER TABLE public.inventario ENABLE ROW LEVEL SECURITY;
CREATE POLICY "inventario_all_auth" ON public.inventario
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── 6. RPC: importar_subinventario ───────────────────────
-- Reemplaza la data de un subinventario completo y recalcula ocupación.
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
  DELETE FROM public.inventario WHERE subinventario = p_subinventario;

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

  PERFORM public.recalcular_ocupacion();
EXCEPTION WHEN others THEN
  RAISE EXCEPTION 'importar_subinventario(%): %', p_subinventario, SQLERRM;
END;
$$;

GRANT EXECUTE ON FUNCTION public.importar_subinventario(TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.importar_subinventario(TEXT, JSONB) TO anon;

-- ── 7. RPC: recalcular_ocupacion ─────────────────────────
CREATE OR REPLACE FUNCTION public.recalcular_ocupacion()
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE public.localizadores l SET
    ocupado       = 0,
    disponible    = l.capacidad,
    pct_ocupacion = 0
  WHERE NOT EXISTS (
    SELECT 1 FROM public.inventario i WHERE i.localizador = l.localizador
  );

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

-- ── 8. REALTIME ───────────────────────────────────────────
-- Habilitar realtime en lineas_reubicacion (para el operador)
ALTER PUBLICATION supabase_realtime ADD TABLE public.lineas_reubicacion;
