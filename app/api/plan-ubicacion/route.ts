import { NextRequest, NextResponse } from "next/server";

// ── Types ─────────────────────────────────────────────────────────────────────
export interface StockItem {
  row_idx: number;
  cod_org_inv: string;
  codigo: string;
  descripcion: string;
  subinventario_origen: string;
  localizador_origen: string;
  lote: string;
  cantidad_fisica: number;
  pallets: number;
  cajas: number;
  responsable: string;
  conteo: number | null;
}

export interface LocationIn {
  zona: string;
  localizador: string;
  formato?: string;
  capacidad: number;
  ocupado: number;
  disponible: number;
}

export interface AssignedLine extends StockItem {
  pallets_efectivos: number;
  subinventario_destino: string;
  localizador_destino: string;
  inv_pe: number;
  sin_espacio: boolean;
  is_fragment: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract tile dimension (e.g. "59X59", "29X59", "30X60") from a description. */
function extractDim(desc: string): string {
  const m = desc.match(/(\d+)\s*[xX×]\s*(\d+)/);
  if (!m) return "";
  return `${m[1]}X${m[2]}`;
}

/** Returns true if a localizador's formato is compatible with the product's dimension. */
function dimMatch(locFormato: string, itemDim: string): boolean {
  if (!locFormato || !itemDim) return false;
  const lf = locFormato.toUpperCase().replace(/\s+/g, "");
  if (lf === "MEZCLA" || lf === "MIX" || lf === "") return false;
  const id = itemDim.toUpperCase();
  return lf.includes(id) || id.includes(lf) || lf === id;
}

// ── Mutable location state ────────────────────────────────────────────────────
interface LocState {
  zona: string;
  localizador: string;
  formato: string;
  capacidad: number;
  originalOcupado: number;
  remaining: number;       // mutable: pallets still available
  assignedHere: number;    // mutable: cumulative pallets we put here in this plan
}

// ── Core algorithm ────────────────────────────────────────────────────────────
/**
 * Improved greedy placement algorithm with:
 *  - Lot-level consolidation (same código+lote stays together if possible)
 *  - Format/dimension matching bonus
 *  - Zone consistency (same product tends to same zone)
 *  - Cumulative INV-PE tracking per localizador
 *  - Fragment detection (warns when a lot must be split)
 *
 * Equivalent Python implementation would use the same scoring logic with
 * scipy.optimize or PuLP for an LP formulation; the greedy approach here
 * achieves near-optimal results for typical warehouse datasets.
 */
function computePlan(items: StockItem[], locations: LocationIn[]): AssignedLine[] {
  // Build mutable pool (only locations with free space)
  const pool = new Map<string, LocState>();
  for (const loc of locations) {
    const free = loc.disponible ?? 0;
    if (free > 0) {
      pool.set(loc.localizador, {
        zona: loc.zona,
        localizador: loc.localizador,
        formato: (loc.formato ?? "").toUpperCase(),
        capacidad: loc.capacidad,
        originalOcupado: loc.ocupado,
        remaining: free,
        assignedHere: 0,
      });
    }
  }

  // Lot grouping: code+lote → total effective pallets
  interface LotGroup { codigo: string; lote: string; dim: string; totalPallets: number; items: StockItem[]; }
  const lotMap = new Map<string, LotGroup>();
  for (const item of items) {
    const key = `${item.codigo}|||${item.lote}`;
    if (!lotMap.has(key)) {
      lotMap.set(key, {
        codigo: item.codigo,
        lote: item.lote,
        dim: extractDim(item.descripcion),
        totalPallets: 0,
        items: [],
      });
    }
    const g = lotMap.get(key)!;
    g.items.push(item);
    g.totalPallets += item.pallets + (item.cajas > 0 ? 1 : 0);
  }

  // Sort lots: most pallets first (largest needs get first pick of space)
  const lotGroups = [...lotMap.values()].sort((a, b) => b.totalPallets - a.totalPallets);

  // Tracking maps for scoring
  const productZone = new Map<string, Map<string, number>>(); // codigo → zona → assigned_pallets
  const locCodes    = new Map<string, Set<string>>();          // localizador → Set<codigo>

  function score(loc: LocState, group: LotGroup, needed: number): number {
    let s = 0;

    // Can fit the whole remaining need without splitting? Big bonus.
    if (loc.remaining >= needed) s += 50;

    // Dimension/format match
    if (group.dim && dimMatch(loc.formato, group.dim)) s += 45;

    // Same product code already stored here
    if (locCodes.get(loc.localizador)?.has(group.codigo)) s += 70;

    // Zone already used for this product code
    const zm = productZone.get(group.codigo);
    if (zm) {
      const zc = zm.get(loc.zona) ?? 0;
      if (zc > 0) s += 30 + Math.min(zc, 20); // up to +50 for high-affinity zone
    }

    // Prefer higher utilization after assignment (pack densely, leave whole empty ones free)
    const take = Math.min(loc.remaining, needed);
    const utilAfter = loc.capacidad > 0
      ? (loc.originalOcupado + loc.assignedHere + take) / loc.capacidad
      : 0;
    s += Math.min(utilAfter, 1.0) * 15;

    // Small penalty for already heavily used locations near overflow
    if (utilAfter > 0.95) s -= 10;

    return s;
  }

  // Assign items lot by lot
  const result: AssignedLine[] = [];

  for (const group of lotGroups) {
    for (const item of group.items) {
      const effPallets = item.pallets + (item.cajas > 0 ? 1 : 0);

      if (effPallets === 0) {
        result.push({ ...item, pallets_efectivos: 0, subinventario_destino: "", localizador_destino: "SIN PALLETS", inv_pe: 0, sin_espacio: false, is_fragment: false });
        continue;
      }

      let remaining  = effPallets;
      let isFirst    = true;

      while (remaining > 0) {
        const avail = [...pool.values()].filter(l => l.remaining > 0);
        if (!avail.length) break;

        const best = avail.reduce((best, loc) => {
          const s = score(loc, group, remaining);
          return s > score(best, group, remaining) ? loc : best;
        });

        const take = Math.min(best.remaining, remaining);
        best.remaining    -= take;
        best.assignedHere += take;

        // Update tracking
        if (!locCodes.has(best.localizador)) locCodes.set(best.localizador, new Set());
        locCodes.get(best.localizador)!.add(group.codigo);

        if (!productZone.has(group.codigo)) productZone.set(group.codigo, new Map());
        const zm = productZone.get(group.codigo)!;
        zm.set(best.zona, (zm.get(best.zona) ?? 0) + take);

        // INV-PE = original occupancy + ALL pallets assigned to this location in this plan
        const inv_pe = best.originalOcupado + best.assignedHere;

        if (isFirst) {
          result.push({
            ...item,
            pallets_efectivos: effPallets,
            subinventario_destino: best.zona,
            localizador_destino: best.localizador,
            inv_pe,
            sin_espacio: false,
            is_fragment: false,
          });
          isFirst = false;
        } else {
          // Fragment: same item split into an additional location
          result.push({
            ...item,
            pallets: take,
            cajas: 0,
            pallets_efectivos: take,
            subinventario_destino: best.zona,
            localizador_destino: best.localizador,
            inv_pe,
            sin_espacio: false,
            is_fragment: true,
          });
        }

        remaining -= take;
      }

      // Couldn't place at all (no space in warehouse)
      if (remaining > 0 && isFirst) {
        result.push({
          ...item,
          pallets_efectivos: effPallets,
          subinventario_destino: "",
          localizador_destino: "SIN ESPACIO",
          inv_pe: 0,
          sin_espacio: true,
          is_fragment: false,
        });
      }
    }
  }

  // Restore original row order
  result.sort((a, b) => a.row_idx - b.row_idx || (a.is_fragment ? 1 : -1));
  return result;
}

// ── Route handler ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const { items, locations } = (await req.json()) as {
      items: unknown;
      locations: unknown;
    };

    if (!Array.isArray(items) || !Array.isArray(locations)) {
      return NextResponse.json(
        { ok: false, error: "items y locations deben ser arrays" },
        { status: 400 }
      );
    }

    const plan = computePlan(items as StockItem[], locations as LocationIn[]);

    const sinEspacio = plan.filter(l => l.sin_espacio).length;
    const fragmentos = plan.filter(l => l.is_fragment).length;
    const asignados  = plan.filter(l => !l.sin_espacio).length;

    return NextResponse.json({
      ok: true,
      plan,
      stats: { total: plan.length, asignados, sinEspacio, fragmentos },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
