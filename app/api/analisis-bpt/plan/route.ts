import { NextRequest, NextResponse } from "next/server";

interface SubInvItem {
  loc: string;
  subinv: string;
  formato: string;
  lote: string;
  pallets: number;
}

interface LocInput {
  zona: string;
  localizador: string;
  disponible: number;
  capacidad: number;
  formato?: string;
}

interface Asignacion {
  loc: string;
  zona: string;
  palletsAsignados: number;
}

interface PlanEntry {
  formato: string;
  lote: string;
  palletsNeed: number;
  asignaciones: Asignacion[];
  palletsAsignados: number;
  palletsRestantes: number;
}

function computePlan(items: SubInvItem[], locs: LocInput[]): PlanEntry[] {
  const groups = new Map<string, { formato: string; lote: string; pallets: number }>();
  for (const item of items) {
    const fmt = (item.formato || "SIN FORMATO").trim().toUpperCase();
    const lot = (item.lote || "SIN LOTE").trim().toUpperCase();
    const key = `${fmt}|||${lot}`;
    const g = groups.get(key) ?? { formato: fmt, lote: lot, pallets: 0 };
    g.pallets += item.pallets;
    groups.set(key, g);
  }

  const pool = locs
    .filter((l) => (l.disponible ?? 0) > 0)
    .map((l) => ({
      loc: l.localizador.trim().toUpperCase(),
      zona: l.zona,
      formatoLoc: (l.formato || "").trim().toUpperCase(),
      freeSlots: l.disponible,
    }))
    .sort((a, b) => a.zona.localeCompare(b.zona) || b.freeSlots - a.freeSlots);

  const entries: PlanEntry[] = [];
  const sorted = [...groups.values()].sort((a, b) => b.pallets - a.pallets);

  for (const g of sorted) {
    const entry: PlanEntry = {
      formato: g.formato,
      lote: g.lote,
      palletsNeed: g.pallets,
      asignaciones: [],
      palletsAsignados: 0,
      palletsRestantes: g.pallets,
    };

    let remaining = g.pallets;

    for (const loc of pool) {
      if (remaining <= 0) break;
      if (loc.freeSlots <= 0) continue;
      if (loc.formatoLoc !== g.formato) continue;
      const take = Math.min(loc.freeSlots, remaining);
      entry.asignaciones.push({ loc: loc.loc, zona: loc.zona, palletsAsignados: take });
      loc.freeSlots -= take;
      remaining -= take;
    }

    for (const loc of pool) {
      if (remaining <= 0) break;
      if (loc.freeSlots <= 0) continue;
      if (entry.asignaciones.find((a) => a.loc === loc.loc)) continue;
      const take = Math.min(loc.freeSlots, remaining);
      entry.asignaciones.push({ loc: loc.loc, zona: loc.zona, palletsAsignados: take });
      loc.freeSlots -= take;
      remaining -= take;
    }

    entry.palletsAsignados = g.pallets - remaining;
    entry.palletsRestantes = remaining;
    entries.push(entry);
  }

  return entries.sort(
    (a, b) => a.formato.localeCompare(b.formato) || a.lote.localeCompare(b.lote)
  );
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { items, locations } = body as { items: unknown; locations: unknown };

    if (!Array.isArray(items) || !Array.isArray(locations)) {
      return NextResponse.json(
        { ok: false, error: "items y locations deben ser arrays" },
        { status: 400 }
      );
    }

    const plan = computePlan(items as SubInvItem[], locations as LocInput[]);

    return NextResponse.json(
      { ok: true, plan },
      {
        headers: {
          // Plan results are deterministic for the same input; cache for 30s on CDN
          "Cache-Control": "private, max-age=30",
        },
      }
    );
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
