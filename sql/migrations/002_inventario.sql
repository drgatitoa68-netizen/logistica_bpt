-- ── Tabla inventario ─────────────────────────────────────────────────────────
create table if not exists inventario (
  id            uuid        primary key default gen_random_uuid(),
  codigo        text        not null,
  descripcion   text,
  lote          text,
  localizador   text        not null,
  subinventario text,
  pallets       numeric     not null default 0,
  cajas         numeric     default 0,
  cantidad_fisica numeric,
  formato       text,
  um            text        default 'PALLET',
  estado        text        default 'ACTIVO' check (estado in ('ACTIVO', 'BLOQUEADO', 'OBSOLETO', 'DEFECTUOSO')),
  lote_status   text        default 'OK' check (lote_status in ('OK', 'RETENIDO', 'CUARENTENA', 'INSPECCIONAR')),
  calidad       text,
  marca         text,
  updated_at    timestamptz default now(),
  created_at    timestamptz default now()
);
create index if not exists idx_inv_cod_lote on inventario(codigo, lote);
create index if not exists idx_inv_loc      on inventario(localizador);
create index if not exists idx_inv_subin    on inventario(subinventario);
create index if not exists idx_inv_estado   on inventario(estado);

-- RLS: permitir acceso al rol anon (ajustar según políticas del proyecto)
alter table inventario enable row level security;
create policy "inventario_all_anon" on inventario
  for all to anon using (true) with check (true);

-- ── RPC: recalcular ocupación de localizadores desde inventario ───────────────
-- Llamar tras cada importación de stock.
create or replace function recalcular_ocupacion()
returns void
language sql
security definer
as $$
  -- 1. Reset localizadores sin registros en inventario
  update localizadores l set
    ocupado       = 0,
    disponible    = l.capacidad,
    pct_ocupacion = 0
  where not exists (
    select 1 from inventario i where i.localizador = l.localizador
  );

  -- 2. Actualizar desde inventario (SQL adjunto en el ticket)
  update localizadores l set
    ocupado       = coalesce(s.tot, 0),
    disponible    = greatest(0, l.capacidad - coalesce(s.tot, 0)),
    pct_ocupacion = case
                      when l.capacidad > 0
                      then coalesce(s.tot, 0)::numeric / l.capacidad
                      else 0
                    end
  from (
    select localizador, sum(pallets) tot
    from inventario
    group by localizador
  ) s
  where l.localizador = s.localizador;
$$;

grant execute on function recalcular_ocupacion() to anon;

-- ── M2 por defecto en catálogo (elimina magic number 1.2 del código) ──────────
insert into catalogo_metraje(codigo, metraje_por_pallet)
values ('__DEFAULT__', 1.2)
on conflict (codigo) do nothing;

-- ── Datos de ejemplo para INVENTARIO ──────────────────────────────────────────
-- Insertar solo si no hay datos (desarrollo)
INSERT INTO inventario (codigo, descripcion, lote, localizador, subinventario, pallets, cajas, cantidad_fisica, formato, um, estado, lote_status, calidad, marca)
SELECT 
  ('PRD-' || LPAD((ROW_NUMBER() OVER (ORDER BY z, l))::TEXT, 4, '0')) as codigo,
  'Producto ' || LPAD((ROW_NUMBER() OVER (ORDER BY z, l))::TEXT, 4, '0') as descripcion,
  'LOTE-' || TO_CHAR(NOW(), 'YYYYMM') || '-' || LPAD((ROW_NUMBER() OVER (ORDER BY z, l) % 10 + 1)::TEXT, 2, '0') as lote,
  l as localizador,
  CASE WHEN ROW_NUMBER() OVER (ORDER BY z, l) % 3 = 0 THEN 'ALMACEN'
       WHEN ROW_NUMBER() OVER (ORDER BY z, l) % 3 = 1 THEN 'PRODUCCION'
       ELSE 'DESPACHO' END as subinventario,
  (ROW_NUMBER() OVER (ORDER BY z, l) % 5 + 1)::numeric as pallets,
  ((ROW_NUMBER() OVER (ORDER BY z, l) % 10) * 5)::numeric as cajas,
  ((ROW_NUMBER() OVER (ORDER BY z, l) % 5 + 1) * 1.2 + (ROW_NUMBER() OVER (ORDER BY z, l) % 10) * 0.5)::numeric as cantidad_fisica,
  CASE WHEN ROW_NUMBER() OVER (ORDER BY z, l) % 4 = 0 THEN '45x45'
       WHEN ROW_NUMBER() OVER (ORDER BY z, l) % 4 = 1 THEN '30x60'
       WHEN ROW_NUMBER() OVER (ORDER BY z, l) % 4 = 2 THEN '29x59'
       ELSE 'MEZCLA' END as formato,
  'PALLET' as um,
  CASE WHEN ROW_NUMBER() OVER (ORDER BY z, l) % 20 = 0 THEN 'BLOQUEADO'
       WHEN ROW_NUMBER() OVER (ORDER BY z, l) % 20 = 1 THEN 'OBSOLETO'
       ELSE 'ACTIVO' END as estado,
  CASE WHEN ROW_NUMBER() OVER (ORDER BY z, l) % 15 = 0 THEN 'RETENIDO'
       WHEN ROW_NUMBER() OVER (ORDER BY z, l) % 15 = 1 THEN 'CUARENTENA'
       WHEN ROW_NUMBER() OVER (ORDER BY z, l) % 15 = 2 THEN 'INSPECCIONAR'
       ELSE 'OK' END as lote_status,
  CASE WHEN ROW_NUMBER() OVER (ORDER BY z, l) % 8 = 0 THEN 'DEFECTUOSA'
       ELSE 'BUENA' END as calidad,
  'MARCA-' || LPAD((ROW_NUMBER() OVER (ORDER BY z, l) % 5 + 1)::TEXT, 2, '0') as marca
FROM (
  SELECT DISTINCT zona as z, localizador as l
  FROM localizadores
  WHERE activo = TRUE
  LIMIT 50
) sub
WHERE NOT EXISTS (SELECT 1 FROM inventario LIMIT 1)
ON CONFLICT DO NOTHING;
