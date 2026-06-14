import { NextRequest, NextResponse } from "next/server";

interface SubInvItem {
  loc: string;
  subinv: string;
  formato: string;
  lote: string;
  pallets: number;
  codigo?: string;
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
  prioridad?: string;
}

interface PlanEntry {
  formato: string;
  lote: string;
  palletsNeed: number;
  asignaciones: Asignacion[];
  palletsAsignados: number;
  palletsRestantes: number;
  cobertura_pct?: number;
}

// ── Algoritmo TS (fallback si el backend Python no está disponible) ──────────

const FORMATOS_LIBRES = new Set(["", "MEZCLA", "SIN FORMATO", "MIXTO", "LIBRE", "GENERAL"]);

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
      cobertura_pct: 0,
    };

    let remaining = g.pallets;
    let enFormato = 0;
    const assigned = new Set<string>();

    const take = (loc: typeof pool[0], prioridad: string) => {
      if (remaining <= 0 || loc.freeSlots <= 0) return;
      const t = Math.min(loc.freeSlots, remaining);
      entry.asignaciones.push({ loc: loc.loc, zona: loc.zona, palletsAsignados: t, prioridad });
      loc.freeSlots -= t;
      remaining -= t;
      assigned.add(loc.loc);
      if (prioridad === "formato_exacto") enFormato += t;
    };

    // P1: formato exacto
    for (const loc of pool) {
      if (remaining <= 0) break;
      if (!assigned.has(loc.loc) && loc.formatoLoc === g.formato) take(loc, "formato_exacto");
    }
    // P2: formato libre / mezcla
    for (const loc of pool) {
      if (remaining <= 0) break;
      if (!assigned.has(loc.loc) && FORMATOS_LIBRES.has(loc.formatoLoc)) take(loc, "formato_libre");
    }
    // P3: cualquiera
    for (const loc of pool) {
      if (remaining <= 0) break;
      if (!assigned.has(loc.loc)) take(loc, "cualquiera");
    }

    entry.palletsAsignados = g.pallets - remaining;
    entry.palletsRestantes = remaining;
    entry.cobertura_pct = entry.palletsAsignados > 0
      ? Math.round((enFormato / entry.palletsAsignados) * 1000) / 10
      : 0;
    entries.push(entry);
  }

  return entries.sort(
    (a, b) => a.formato.localeCompare(b.formato) || a.lote.localeCompare(b.lote)
  );
}

// ── Handler ──────────────────────────────────────────────────────────────────

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8000";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { items, locations, fullAnalysis } = body as {
      items: unknown;
      locations: unknown;
      fullAnalysis?: boolean;
    };

    if (!Array.isArray(items) || !Array.isArray(locations)) {
      return NextResponse.json(
        { ok: false, error: "items y locations deben ser arrays" },
        { status: 400 }
      );
    }

    // Intentar usar el backend Python para el algoritmo mejorado
    const endpoint = fullAnalysis ? "/analisis-bpt/analisis-completo" : "/analisis-bpt/plan";
    try {
      const pyResp = await fetch(`${BACKEND}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, locations }),
        signal: AbortSignal.timeout(10_000),
      });
      if (pyResp.ok) {
        const data = await pyResp.json();
        return NextResponse.json(data, {
          headers: { "Cache-Control": "private, max-age=30", "X-Source": "python" },
        });
      }
    } catch {
      // Backend Python no disponible — usar algoritmo TS de respaldo
    }

    // Fallback: algoritmo TypeScript
    const plan = computePlan(items as SubInvItem[], locations as LocInput[]);
    return NextResponse.json(
      { ok: true, plan, _source: "typescript-fallback" },
      { headers: { "Cache-Control": "private, max-age=30", "X-Source": "typescript" } }
    );
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
