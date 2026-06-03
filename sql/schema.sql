-- ═══════════════════════════════════════════════════════
-- LOGISTICA BPT — Schema completo
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query
-- ═══════════════════════════════════════════════════════

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

-- ── 3. ÍNDICES (performance) ─────────────────────────────
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

-- ── 5. REALTIME ──────────────────────────────────────────
-- Habilitar realtime en lineas_reubicacion (para el operador)
ALTER PUBLICATION supabase_realtime ADD TABLE public.lineas_reubicacion;
