-- ── Tabla inventario ─────────────────────────────────────────────────────────
create table if not exists inventario (
  id            uuid        primary key default gen_random_uuid(),
  codigo        text        not null,
  lote          text,
  localizador   text        not null references localizadores(localizador),
  subinventario text,
  descripcion   text,
  pallets       numeric     not null default 0,
  cajas         numeric     default 0,
  cantidad_fisica numeric,
  formato       text,
  updated_at    timestamptz default now()
);
create index if not exists idx_inv_cod_lote on inventario(codigo, lote);
create index if not exists idx_inv_loc      on inventario(localizador);

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
