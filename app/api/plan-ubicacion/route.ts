import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

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
  formato?: string;      // campo explícito para R1 (viene de analisis-bpt o ubicacion-produccion)
}

export interface LocationIn {
  zona: string;
  localizador: string;
  formato?: string;
  capacidad: number;
  ocupado: number;
  disponible: number;
  activo?: boolean;
}

export interface AssignedLine extends StockItem {
  pallets_efectivos: number;
  subinventario_destino: string;
  localizador_destino: string;
  inv_pe: number;
  sin_espacio: boolean;
  is_fragment: boolean;
}

// ── Mutable location state ────────────────────────────────────────────────────
interface LocState {
  zona: string;
  localizador: string;
  formato: string;
  capacidad: number;
  originalOcupado: number;
  remaining: number;
  assignedHere: number;
}

// ── R1: formato del localizador acepta el formato del producto ────────────────
// VACIO / MEZCLA / MIX → acepta cualquier formato
function r1FormatoOk(locFormato: string, itemFormato: string): boolean {
  const lf  = locFormato.toUpperCase().trim();
  const itf = itemFormato.toUpperCase().trim();
  if (!lf || lf === "MEZCLA" || lf === "MIX") return true;   // localizador comodín
  if (!itf) return true;                                        // ítem sin formato → no filtrar
  return lf === itf;
}

// ── R4: score para elegir MAX ─────────────────────────────────────────────────
// +1000 si el localizador ya tiene este lote; minimiza espacio desperdiciado
function scoreR4(
  loc: LocState,
  pallets: number,
  locLoteKey: string,           // `${loc.localizador}|||${codigo}|||${lote}`
  existingLots: Set<string>,
): number {
  const hasLote = existingLots.has(locLoteKey) ? 1000 : 0;
  return hasLote - (loc.remaining - pallets);
}

// ── Core algorithm (4 reglas) ─────────────────────────────────────────────────
function computePlan(
  items: StockItem[],
  locations: LocationIn[],
  existingLots: Set<string>,     // `${localizador}|||${codigo}|||${lote}`
): AssignedLine[] {

  // Pool: R3 — solo localizadores activos con espacio
  const pool = new Map<string, LocState>();
  for (const loc of locations) {
    if (loc.activo === false) continue;           // R3
    if ((loc.disponible ?? 0) <= 0) continue;
    pool.set(loc.localizador, {
      zona:            loc.zona,
      localizador:     loc.localizador,
      formato:         (loc.formato ?? "").toUpperCase().trim(),
      capacidad:       loc.capacidad,
      originalOcupado: loc.ocupado ?? 0,
      remaining:       loc.disponible,
      assignedHere:    0,
    });
  }

  // Agrupar ítems por código+lote para priorizar los más grandes
  interface LotGroup { codigo: string; lote: string; formato: string; totalPallets: number; items: StockItem[]; }
  const lotMap = new Map<string, LotGroup>();
  for (const item of items) {
    const key = `${item.codigo}|||${item.lote}`;
    if (!lotMap.has(key)) {
      lotMap.set(key, {
        codigo:       item.codigo,
        lote:         item.lote,
        formato:      (item.formato ?? "").toUpperCase().trim(),
        totalPallets: 0,
        items:        [],
      });
    }
    const g = lotMap.get(key)!;
    g.items.push(item);
    g.totalPallets += item.pallets + (item.cajas > 0 ? 1 : 0);
  }

  // Lotes más grandes primero
  const lotGroups = [...lotMap.values()].sort((a, b) => b.totalPallets - a.totalPallets);

  const result: AssignedLine[] = [];

  for (const group of lotGroups) {
    for (const item of group.items) {
      const effPallets  = item.pallets + (item.cajas > 0 ? 1 : 0);
      const itemFormato = group.formato;

      if (effPallets === 0) {
        result.push({ ...item, pallets_efectivos: 0, subinventario_destino: "", localizador_destino: "SIN PALLETS", inv_pe: 0, sin_espacio: false, is_fragment: false });
        continue;
      }

      // ── Intento sin fragmentar (R1 + R2 + R4) ────────────────────────────
      const fullFit = [...pool.values()].filter(loc =>
        r1FormatoOk(loc.formato, itemFormato) &&   // R1
        loc.remaining >= effPallets                  // R2: cabe entero
      );

      if (fullFit.length > 0) {
        const best = fullFit.reduce((best, loc) => {
          const lk = `${loc.localizador}|||${item.codigo}|||${item.lote}`;
          const bk = `${best.localizador}|||${item.codigo}|||${item.lote}`;
          return scoreR4(loc, effPallets, lk, existingLots) >
                 scoreR4(best, effPallets, bk, existingLots) ? loc : best;
        });

        best.remaining    -= effPallets;
        best.assignedHere += effPallets;

        result.push({
          ...item,
          pallets_efectivos:     effPallets,
          subinventario_destino: best.zona,
          localizador_destino:   best.localizador,
          inv_pe:                best.originalOcupado + best.assignedHere,
          sin_espacio:           false,
          is_fragment:           false,
        });
        continue;
      }

      // ── Fragmentación: R1 + cualquier espacio disponible ─────────────────
      let remaining = effPallets;
      let isFirst   = true;

      while (remaining > 0) {
        const fragPool = [...pool.values()].filter(loc =>
          r1FormatoOk(loc.formato, itemFormato) && loc.remaining > 0
        );
        if (!fragPool.length) break;

        const best = fragPool.reduce((best, loc) => {
          const take   = Math.min(loc.remaining, remaining);
          const bestTk = Math.min(best.remaining, remaining);
          const lk  = `${loc.localizador}|||${item.codigo}|||${item.lote}`;
          const bk  = `${best.localizador}|||${item.codigo}|||${item.lote}`;
          return scoreR4(loc, take, lk, existingLots) >
                 scoreR4(best, bestTk, bk, existingLots) ? loc : best;
        });

        const take     = Math.min(best.remaining, remaining);
        best.remaining    -= take;
        best.assignedHere += take;

        result.push({
          ...item,
          pallets:               isFirst ? item.pallets : take,
          cajas:                 isFirst ? item.cajas : 0,
          pallets_efectivos:     isFirst ? effPallets : take,
          subinventario_destino: best.zona,
          localizador_destino:   best.localizador,
          inv_pe:                best.originalOcupado + best.assignedHere,
          sin_espacio:           false,
          is_fragment:           !isFirst,
        });

        isFirst   = false;
        remaining -= take;
      }

      // Sin espacio en absoluto
      if (remaining > 0 && isFirst) {
        result.push({
          ...item,
          pallets_efectivos:     effPallets,
          subinventario_destino: "",
          localizador_destino:   "SIN ESPACIO",
          inv_pe:                0,
          sin_espacio:           true,
          is_fragment:           false,
        });
      }
    }
  }

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
        { status: 400 },
      );
    }

    // Consultar inventario actual para R4 (yaTieneLote)
    let existingLots = new Set<string>();
    try {
      const sb = await createClient();
      const { data: invRows } = await sb
        .from("inventario")
        .select("localizador,codigo,lote")
        .not("lote", "is", null);
      for (const row of invRows ?? []) {
        if (row.localizador && row.codigo && row.lote) {
          existingLots.add(`${row.localizador}|||${row.codigo}|||${row.lote}`);
        }
      }
    } catch {
      // inventario puede no existir aún; continuar sin bonus R4
    }

    const plan = computePlan(
      items as StockItem[],
      locations as LocationIn[],
      existingLots,
    );

    const sinEspacio = plan.filter(l => l.sin_espacio).length;
    const fragmentos = plan.filter(l => l.is_fragment).length;
    const asignados  = plan.filter(l => !l.sin_espacio && !l.is_fragment).length;

    return NextResponse.json({
      ok: true,
      plan,
      stats: { total: plan.length, asignados, sinEspacio, fragmentos },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
