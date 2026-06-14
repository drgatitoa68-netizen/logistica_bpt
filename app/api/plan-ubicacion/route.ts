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
  cajas_por_pallet?: number;
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

export interface LocationSuggestion {
  localizador: string;
  zona: string;
  score: number;
  reason: string;
  capacidad_disponible: number;
  es_consolidacion: boolean;
}

export interface AssignedLine extends StockItem {
  pallets_efectivos: number;
  subinventario_destino: string;
  localizador_destino: string;
  inv_pe: number;
  sin_espacio: boolean;
  is_fragment: boolean;
  sugerencias?: LocationSuggestion[];
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

// ── R4: score mejorado para elegir MAX ───────────────────────────────────────
// Considera múltiples factores: consolidación de lote, eficiencia de espacio,
// minimización de fragmentación y carga de zona
interface ScoreResult {
  score: number;
  reasons: string[];
}

function scoreR4(
  loc: LocState,
  pallets: number,
  locLoteKey: string,           // `${loc.localizador}|||${codigo}|||${lote}`
  existingLots: Set<string>,
  zoneLoads: Map<string, number>, // carga actual por zona (suma de pallets asignados)
  maxZoneCapacity: number,        // capacidad máxima de zona para balance
): ScoreResult {
  let score = 0;
  const reasons: string[] = [];

  // 1. Bonus consolidación: +2000 si el lote ya existe en este localizador
  if (existingLots.has(locLoteKey)) {
    score += 2000;
    reasons.push("Consolidación de lote");
  }

  // 2. Bonus eficiencia de espacio: minimizar desperdicio (espacio restante después de asignar)
  const wasteAfter = Math.max(0, loc.remaining - pallets);
  const wasteScore = 500 - wasteAfter; // Penaliza desperdicio >0
  score += wasteScore;
  if (wasteScore > 300) reasons.push("Uso eficiente de espacio");

  // 3. Bonus de utilización: localizadores más llenos se completan primero (cohesión)
  const utilizationRatio = (loc.originalOcupado + loc.assignedHere) / loc.capacidad;
  const utilizationScore = Math.round(utilizationRatio * 300);
  score += utilizationScore;
  if (utilizationRatio > 0.7) reasons.push("Alto nivel de ocupación");

  // 4. Penalidad por fragmentación: evitar dejar <20% de espacio sin usar
  if (wasteAfter > 0 && wasteAfter < Math.max(1, loc.capacidad * 0.2)) {
    score -= 150; // Penalizar fragmentación
    reasons.push("Fragmentación minimizada");
  }

  // 5. Balance de zonas: evitar sobrecargar una zona
  const zoneLoad = zoneLoads.get(loc.zona) ?? 0;
  const zoneUtilRatio = zoneLoad / maxZoneCapacity;
  if (zoneUtilRatio > 0.8) {
    score -= 200; // Penalizar zonas muy cargadas
    reasons.push("Zona con alta carga");
  } else if (zoneUtilRatio < 0.5) {
    score += 50; // Bonus para balancear carga
    reasons.push("Zona con baja carga");
  }

  return { score, reasons: reasons.length > 0 ? reasons : ["Ubicación estándar"] };
}

// ── Generar sugerencias: Top 3 ubicaciones ────────────────────────────────────
function generateSuggestions(
  pool: Map<string, LocState>,
  effPallets: number,
  itemFormato: string,
  itemCodigo: string,
  itemLote: string,
  existingLots: Set<string>,
  zoneLoads: Map<string, number>,
  maxZoneCapacity: number,
  excludeNoSpace: boolean = false,
): LocationSuggestion[] {
  const candidates = [...pool.values()]
    .filter(loc => r1FormatoOk(loc.formato, itemFormato))
    .filter(loc => !excludeNoSpace || loc.remaining >= effPallets);

  if (candidates.length === 0) return [];

  // Calcular scores
  const scored = candidates.map(loc => {
    const lk = `${loc.localizador}|||${itemCodigo}|||${itemLote}`;
    const { score, reasons } = scoreR4(
      loc,
      effPallets,
      lk,
      existingLots,
      zoneLoads,
      maxZoneCapacity
    );
    const isConsolidacion = existingLots.has(lk);
    return {
      loc,
      score,
      reasons,
      isConsolidacion,
    };
  });

  // Top 3 ordenados por score
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(s => ({
      localizador: s.loc.localizador,
      zona: s.loc.zona,
      score: s.score,
      reason: s.reasons.join(" · "),
      capacidad_disponible: s.loc.remaining,
      es_consolidacion: s.isConsolidacion,
    }));
}

// ── Core algorithm: Razonamiento Humano para Ubicación ──────────────────────
function computePlan(
  items: StockItem[],
  locations: LocationIn[],
  existingLots: Set<string>,
  cajasPerPallet: Map<string, number> = new Map(),
): AssignedLine[] {

  const calcEffPallets = (item: StockItem): number => {
    if (item.cajas <= 0) return item.pallets;
    const cpp = item.cajas_por_pallet || cajasPerPallet.get(item.codigo) || 0;
    const cajasAsPallets = cpp > 0 ? Math.ceil(item.cajas / cpp) : 1;
    return item.pallets + cajasAsPallets;
  };

  // Pool: R3 — solo localizadores activos con espacio
  const pool = new Map<string, LocState>();
  const zoneToLocations = new Map<string, LocState[]>();
  let maxZoneCapacity = 0;

  for (const loc of locations) {
    if (loc.activo === false) continue;
    if ((loc.disponible ?? 0) <= 0) continue;
    const locState: LocState = {
      zona:            loc.zona,
      localizador:     loc.localizador,
      formato:         (loc.formato ?? "").toUpperCase().trim(),
      capacidad:       loc.capacidad,
      originalOcupado: loc.ocupado ?? 0,
      remaining:       loc.disponible,
      assignedHere:    0,
    };
    pool.set(loc.localizador, locState);
    
    if (!zoneToLocations.has(loc.zona)) {
      zoneToLocations.set(loc.zona, []);
    }
    zoneToLocations.get(loc.zona)!.push(locState);
    maxZoneCapacity = Math.max(maxZoneCapacity, loc.capacidad);
  }

  // ── Agrupación inteligente: Código → Lotes → Items ───────────────────────
  interface CodeGroup {
    codigo: string;
    descripcion: string;
    formato: string;
    lotes: Map<string, {
      lote: string;
      totalPallets: number;
      items: StockItem[];
    }>;
    totalPalletsCode: number;
  }

  const codeMap = new Map<string, CodeGroup>();
  for (const item of items) {
    if (!codeMap.has(item.codigo)) {
      codeMap.set(item.codigo, {
        codigo: item.codigo,
        descripcion: item.descripcion,
        formato: (item.formato ?? "").toUpperCase().trim(),
        lotes: new Map(),
        totalPalletsCode: 0,
      });
    }

    const codeGroup = codeMap.get(item.codigo)!;
    const effPallets = calcEffPallets(item);
    codeGroup.totalPalletsCode += effPallets;

    if (!codeGroup.lotes.has(item.lote)) {
      codeGroup.lotes.set(item.lote, {
        lote: item.lote,
        totalPallets: 0,
        items: [],
      });
    }
    const lotGroup = codeGroup.lotes.get(item.lote)!;
    lotGroup.totalPallets += effPallets;
    lotGroup.items.push(item);
  }

  // ── Ordenar códigos por volumen (grandes primero) ─────────────────────────
  const codeGroups = [...codeMap.values()]
    .sort((a, b) => b.totalPalletsCode - a.totalPalletsCode);

  const result: AssignedLine[] = [];
  const zoneLoads = new Map<string, number>();
  const codigoLocalizadores = new Map<string, Set<string>>(); // Track códigos por localizador

  // ── Procesamiento por código ───────────────────────────────────────────────
  for (const codeGroup of codeGroups) {
    const codFormat = codeGroup.formato;

    // Ordenar lotes por tamaño (más grande primero)
    const sortedLotes = [...codeGroup.lotes.values()]
      .sort((a, b) => b.totalPallets - a.totalPallets);

    // Para cada lote de este código
    for (const lotGroup of sortedLotes) {
      for (const item of lotGroup.items) {
        const effPallets = calcEffPallets(item);
        
        if (effPallets === 0) {
          result.push({
            ...item,
            pallets_efectivos: 0,
            subinventario_destino: "",
            localizador_destino: "SIN PALLETS",
            inv_pe: 0,
            sin_espacio: false,
            is_fragment: false,
          });
          continue;
        }

        const lk = `${item.codigo}|||${item.lote}`;

        // ── Estrategia 1: Consolidación de lote (más importante) ────────────
        const consolidationLoc = [...pool.values()].find(loc =>
          r1FormatoOk(loc.formato, codFormat) &&
          loc.remaining >= effPallets &&
          existingLots.has(`${loc.localizador}|||${lk}`)
        );

        if (consolidationLoc) {
          consolidationLoc.remaining -= effPallets;
          consolidationLoc.assignedHere += effPallets;
          zoneLoads.set(consolidationLoc.zona, (zoneLoads.get(consolidationLoc.zona) ?? 0) + effPallets);
          
          if (!codigoLocalizadores.has(item.codigo)) codigoLocalizadores.set(item.codigo, new Set());
          codigoLocalizadores.get(item.codigo)!.add(consolidationLoc.localizador);

          result.push({
            ...item,
            pallets_efectivos: effPallets,
            subinventario_destino: consolidationLoc.zona,
            localizador_destino: consolidationLoc.localizador,
            inv_pe: consolidationLoc.originalOcupado + consolidationLoc.assignedHere,
            sin_espacio: false,
            is_fragment: false,
            sugerencias: generateSuggestions(pool, effPallets, codFormat, item.codigo, item.lote, existingLots, zoneLoads, maxZoneCapacity, true),
          });
          continue;
        }

        // ── Estrategia 2: Llenar localizador del mismo código (Eficiencia) ─
        const sameCodeLocs = [...pool.values()]
          .filter(loc =>
            r1FormatoOk(loc.formato, codFormat) &&
            loc.remaining >= effPallets &&
            codigoLocalizadores.get(item.codigo)?.has(loc.localizador)
          )
          .sort((a, b) => b.assignedHere - a.assignedHere); // Preferir el más lleno

        if (sameCodeLocs.length > 0) {
          const bestLoc = sameCodeLocs[0];
          bestLoc.remaining -= effPallets;
          bestLoc.assignedHere += effPallets;
          zoneLoads.set(bestLoc.zona, (zoneLoads.get(bestLoc.zona) ?? 0) + effPallets);

          result.push({
            ...item,
            pallets_efectivos: effPallets,
            subinventario_destino: bestLoc.zona,
            localizador_destino: bestLoc.localizador,
            inv_pe: bestLoc.originalOcupado + bestLoc.assignedHere,
            sin_espacio: false,
            is_fragment: false,
            sugerencias: generateSuggestions(pool, effPallets, codFormat, item.codigo, item.lote, existingLots, zoneLoads, maxZoneCapacity, true),
          });
          continue;
        }

        // ── Estrategia 3: Llenar completamente un localizador disponible ────
        const fullFitLocs = [...pool.values()]
          .filter(loc =>
            r1FormatoOk(loc.formato, codFormat) &&
            loc.remaining >= effPallets &&
            loc.assignedHere === 0 // Localizador vacío (nuevo para este código)
          )
          .sort((a, b) => {
            // Preferir exacto o cercano al tamaño que necesitamos (eficiencia)
            const wasteA = a.remaining - effPallets;
            const wasteB = b.remaining - effPallets;
            return Math.abs(wasteA) - Math.abs(wasteB);
          });

        if (fullFitLocs.length > 0) {
          const bestLoc = fullFitLocs[0];
          bestLoc.remaining -= effPallets;
          bestLoc.assignedHere += effPallets;
          zoneLoads.set(bestLoc.zona, (zoneLoads.get(bestLoc.zona) ?? 0) + effPallets);
          
          if (!codigoLocalizadores.has(item.codigo)) codigoLocalizadores.set(item.codigo, new Set());
          codigoLocalizadores.get(item.codigo)!.add(bestLoc.localizador);

          result.push({
            ...item,
            pallets_efectivos: effPallets,
            subinventario_destino: bestLoc.zona,
            localizador_destino: bestLoc.localizador,
            inv_pe: bestLoc.originalOcupado + bestLoc.assignedHere,
            sin_espacio: false,
            is_fragment: false,
            sugerencias: generateSuggestions(pool, effPallets, codFormat, item.codigo, item.lote, existingLots, zoneLoads, maxZoneCapacity, true),
          });
          continue;
        }

        // ── Estrategia 4: Fragmentación inteligente (último recurso) ────────
        let remaining = effPallets;
        let isFirst = true;

        while (remaining > 0) {
          const fragLocs = [...pool.values()]
            .filter(loc =>
              r1FormatoOk(loc.formato, codFormat) &&
              loc.remaining > 0
            )
            .sort((a, b) => {
              // Preferir localizadores con espacio más cercano al que necesitamos
              const wasteA = Math.abs(a.remaining - remaining);
              const wasteB = Math.abs(b.remaining - remaining);
              return wasteA - wasteB;
            });

          if (!fragLocs.length) break;

          const bestLoc = fragLocs[0];
          const take = Math.min(bestLoc.remaining, remaining);
          bestLoc.remaining -= take;
          bestLoc.assignedHere += take;
          zoneLoads.set(bestLoc.zona, (zoneLoads.get(bestLoc.zona) ?? 0) + take);
          
          if (!codigoLocalizadores.has(item.codigo)) codigoLocalizadores.set(item.codigo, new Set());
          codigoLocalizadores.get(item.codigo)!.add(bestLoc.localizador);

          result.push({
            ...item,
            pallets: isFirst ? item.pallets : take,
            cajas: isFirst ? item.cajas : 0,
            pallets_efectivos: isFirst ? effPallets : take,
            subinventario_destino: bestLoc.zona,
            localizador_destino: bestLoc.localizador,
            inv_pe: bestLoc.originalOcupado + bestLoc.assignedHere,
            sin_espacio: false,
            is_fragment: !isFirst,
            sugerencias: isFirst ? generateSuggestions(pool, Math.min(remaining, 5), codFormat, item.codigo, item.lote, existingLots, zoneLoads, maxZoneCapacity, false) : undefined,
          });

          isFirst = false;
          remaining -= take;
        }

        // ── Sin espacio (total o parcial) ─────────────────────────────────
        if (remaining > 0) {
          result.push({
            ...item,
            pallets: remaining,
            cajas: isFirst ? item.cajas : 0,
            pallets_efectivos: isFirst ? effPallets : remaining,
            subinventario_destino: "",
            localizador_destino: "SIN ESPACIO",
            inv_pe: 0,
            sin_espacio: true,
            is_fragment: !isFirst,
          });
        }
      }
    }
  }

  // ── Ordenar resultado por índice y estado ──────────────────────────────────
  result.sort((a, b) => {
    if (a.row_idx !== b.row_idx) return a.row_idx - b.row_idx;
    return (a.is_fragment ? 1 : 0) - (b.is_fragment ? 1 : 0);
  });

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

    const sb = await createClient();

    // Consultar inventario actual para R4 (yaTieneLote)
    let existingLots = new Set<string>();
    try {
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

    // Consultar cajas_por_pallet del catálogo para calcular pallets efectivos correctamente
    const cajasPerPallet = new Map<string, number>();
    try {
      const codigos = [...new Set((items as StockItem[]).map(i => i.codigo).filter(Boolean))];
      if (codigos.length > 0) {
        const { data: catRows } = await sb
          .from("catalogo_productos")
          .select("codigo,cajas_por_pallet")
          .in("codigo", codigos);
        for (const row of catRows ?? []) {
          if (row.codigo && row.cajas_por_pallet) {
            cajasPerPallet.set(row.codigo, Number(row.cajas_por_pallet));
          }
        }
      }
    } catch {
      // catálogo no disponible; se usará fallback de 1 pallet por grupo de cajas
    }

    const plan = computePlan(
      items as StockItem[],
      locations as LocationIn[],
      existingLots,
      cajasPerPallet,
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
