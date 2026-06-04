import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET /api/analisis-bpt/consolidacion?umbral=2
// Detecta código+lote disperso (≥2 ubicaciones distintas, algún saldo ≤ umbral)
// y devuelve movimientos origen→destino (destino = ubicación con MAX pallets).
export async function GET(req: NextRequest) {
  try {
    const url    = new URL(req.url);
    const umbral = parseFloat(url.searchParams.get("umbral") ?? "2");

    const sb = await createClient();

    const { data, error } = await sb
      .from("inventario")
      .select("codigo,lote,localizador,subinventario,pallets")
      .not("lote", "is", null)
      .gt("pallets", 0);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    // Agrupar por (codigo, lote); deduplicar por localizador sumando pallets
    // (mismo producto+lote puede aparecer en varios subinventarios en la misma ubicación)
    type Entry = { localizador: string; subinventario: string; pallets: number };
    const groups = new Map<string, { codigo: string; lote: string; byLoc: Map<string, Entry> }>();

    for (const row of data ?? []) {
      const groupKey = `${row.codigo}|||${row.lote}`;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, { codigo: row.codigo, lote: row.lote, byLoc: new Map() });
      }
      const g   = groups.get(groupKey)!;
      const loc = row.localizador;
      if (!g.byLoc.has(loc)) {
        g.byLoc.set(loc, { localizador: loc, subinventario: row.subinventario, pallets: 0 });
      }
      g.byLoc.get(loc)!.pallets += Number(row.pallets);
    }

    type Movimiento = {
      codigo: string; lote: string;
      origen_localizador: string; origen_subinventario: string; origen_pallets: number;
      destino_localizador: string; destino_subinventario: string; destino_pallets: number;
    };
    const movimientos: Movimiento[] = [];

    for (const g of groups.values()) {
      const entries = [...g.byLoc.values()];
      if (entries.length < 2) continue;

      const hasSmall = entries.some(e => e.pallets <= umbral);
      if (!hasSmall) continue;

      // Destino: ubicación con más pallets
      const destino = entries.reduce((best, e) => (e.pallets > best.pallets ? e : best));

      // Orígenes: todas las demás con saldo ≤ umbral
      for (const origen of entries) {
        if (origen.localizador === destino.localizador) continue;
        if (origen.pallets > umbral) continue;
        movimientos.push({
          codigo:                g.codigo,
          lote:                  g.lote,
          origen_localizador:    origen.localizador,
          origen_subinventario:  origen.subinventario,
          origen_pallets:        origen.pallets,
          destino_localizador:   destino.localizador,
          destino_subinventario: destino.subinventario,
          destino_pallets:       destino.pallets,
        });
      }
    }

    // Ordenar: más pallets a mover primero
    movimientos.sort((a, b) => b.origen_pallets - a.origen_pallets || a.codigo.localeCompare(b.codigo));

    return NextResponse.json({ ok: true, movimientos, total: movimientos.length });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
