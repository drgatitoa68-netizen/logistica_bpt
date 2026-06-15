import { NextRequest, NextResponse } from "next/server";

// ── Tipos ─────────────────────────────────────────────────────────────────────
interface ItemInput {
  loc: string;
  codigo: string;
  lote: string;
  pallets: number;
  formato: string;
  subinv?: string;
  descripcion?: string;
}

interface LocationInput {
  zona: string;
  localizador: string;
  formato?: string;
  capacidad: number;
  disponible: number;
  ocupado: number;
  activo?: boolean;
}

export interface Movimiento {
  paso: number;
  tipo: "liberar" | "consolidar";
  codigo: string;
  lote: string;
  pallets: number;
  formato: string;
  loc_origen: string;
  zona_origen: string;
  loc_destino: string;
  zona_destino: string;
  razon: string;
}

interface SinEspacio {
  codigo: string;
  lote: string;
  pallets: number;
  formato: string;
  loc_origen: string;
  motivo: string;
}

// ── Formatos comodín ──────────────────────────────────────────────────────────
const FORMATOS_LIBRES = new Set(["", "MEZCLA", "MIX", "MIXTO", "LIBRE", "GENERAL", "SIN FORMATO"]);

function formatoCompatible(locFormato: string, itemFormato: string): boolean {
  const lf = (locFormato || "").toUpperCase().trim();
  const itf = (itemFormato || "").toUpperCase().trim();
  if (FORMATOS_LIBRES.has(lf)) return true;
  if (!itf) return true;
  return lf === itf;
}

// ── Cerebro TS (fallback si el backend Python no está disponible) ─────────────
function scoreDest(locAvail: number, locFmt: string, itemFmt: string, needed: number): number {
  const lf = (locFmt || "").toUpperCase().trim();
  const itf = (itemFmt || "").toUpperCase().trim();
  let score = 0;
  if (lf === itf && !FORMATOS_LIBRES.has(lf)) score += 2000;
  else if (FORMATOS_LIBRES.has(lf)) score += 500;
  const waste = locAvail - needed;
  if (waste >= 0) score += Math.max(0, 800 - waste * 2);
  if (locAvail > needed * 3) score -= 100;
  return score;
}

type LocEntry = { zona: string; localizador: string; formato: string; available: number };

function findBestTarget(
  pool: Map<string, LocEntry>,
  itemFmt: string,
  needed: number,
  exclude: Set<string>,
): LocEntry | null {
  let best: LocEntry | null = null;
  let bestScore = -Infinity;
  for (const [key, loc] of pool) {
    if (exclude.has(key)) continue;
    if (loc.available < needed) continue;
    if (!formatoCompatible(loc.formato, itemFmt)) continue;
    const score = scoreDest(loc.available, loc.formato, itemFmt, needed);
    if (score > bestScore) { bestScore = score; best = loc; }
  }
  return best;
}

function computeConsolidacion(
  items: ItemInput[],
  locations: LocationInput[],
  targetLoc?: string,
): { movimientos: Movimiento[]; sinEspacio: SinEspacio[] } {
  const validItems = items.filter(it => it.codigo && it.lote && it.loc && it.pallets > 0);

  // Pool mutable
  const pool = new Map<string, { zona: string; localizador: string; formato: string; available: number }>();
  const locInfoMap = new Map<string, LocationInput>();
  for (const loc of locations) {
    if (loc.activo === false) continue;
    const key = (loc.localizador || "").toUpperCase().trim();
    locInfoMap.set(key, loc);
    pool.set(key, {
      zona: loc.zona,
      localizador: loc.localizador,
      formato: (loc.formato || "").toUpperCase().trim(),
      available: Math.max(0, loc.disponible ?? 0),
    });
  }

  // Inventario por loc
  const locInventory = new Map<string, Map<string, { pallets: number; items: ItemInput[] }>>();
  for (const it of validItems) {
    const lk = it.loc.toUpperCase().trim();
    if (!locInventory.has(lk)) locInventory.set(lk, new Map());
    const clk = `${it.codigo.trim()}|||${it.lote.trim()}`;
    const inv = locInventory.get(lk)!;
    if (!inv.has(clk)) inv.set(clk, { pallets: 0, items: [] });
    inv.get(clk)!.pallets += it.pallets;
    inv.get(clk)!.items.push(it);
  }

  // Índice global: cod+lot → loc → pallets
  const globalIndex = new Map<string, Map<string, number>>();
  for (const it of validItems) {
    const key = `${it.codigo.trim()}|||${it.lote.trim()}`;
    const lk = it.loc.toUpperCase().trim();
    if (!globalIndex.has(key)) globalIndex.set(key, new Map());
    globalIndex.get(key)!.set(lk, (globalIndex.get(key)!.get(lk) ?? 0) + it.pallets);
  }

  const movimientos: Movimiento[] = [];
  const sinEspacio: SinEspacio[] = [];
  let paso = 0;

  // ── FASE 1: LIBERAR ─────────────────────────────────────────────────────────
  const locsMezclados = [...locInventory.entries()]
    .filter(([, inv]) => {
      const codes = new Set([...inv.keys()].map(k => k.split("|||")[0]));
      return codes.size > 1;
    })
    .sort((a, b) => {
      const cA = new Set([...a[1].keys()].map(k => k.split("|||")[0])).size;
      const cB = new Set([...b[1].keys()].map(k => k.split("|||")[0])).size;
      return cB - cA;
    });

  for (const [locKey, inv] of locsMezclados) {
    const locInfo = locInfoMap.get(locKey);
    if (!locInfo) continue;

    let anclaKey = "";
    let anclaPallets = 0;
    for (const [clk, { pallets }] of inv) {
      if (pallets > anclaPallets) { anclaPallets = pallets; anclaKey = clk; }
    }
    const anclaCodigo = anclaKey.split("|||")[0];

    for (const [clk, { pallets, items: clItems }] of inv) {
      if (clk === anclaKey) continue;
      const [codigo, lote] = clk.split("|||");
      const itemFmt = clItems[0]?.formato || "";
      const exc = new Set<string>([locKey]);
      const target = findBestTarget(pool, itemFmt, pallets, exc);

      if (target) {
        paso++;
        movimientos.push({ paso, tipo: "liberar", codigo, lote, pallets, formato: itemFmt, loc_origen: locInfo.localizador, zona_origen: locInfo.zona, loc_destino: target.localizador, zona_destino: target.zona, razon: `Liberar ${locInfo.localizador}: mantener solo ${anclaCodigo} (${anclaPallets} plt). Mover ${codigo}/${lote} → ${target.localizador}` });
        target.available -= pallets;
        const src = pool.get(locKey); if (src) src.available += pallets;
      } else {
        // Fraccionar
        let rem = pallets;
        const excP = new Set<string>([locKey]);
        while (rem > 0) {
          const t = findBestTarget(pool, itemFmt, 1, excP);
          if (!t) break;
          const take = Math.min(t.available, rem);
          paso++;
          movimientos.push({ paso, tipo: "liberar", codigo, lote, pallets: take, formato: itemFmt, loc_origen: locInfo.localizador, zona_origen: locInfo.zona, loc_destino: t.localizador, zona_destino: t.zona, razon: `Liberar ${locInfo.localizador} (fracción ${take}/${pallets}): mover ${codigo}/${lote} → ${t.localizador}` });
          t.available -= take;
          const src = pool.get(locKey); if (src) src.available += take;
          excP.add(t.localizador.toUpperCase());
          rem -= take;
        }
        if (rem > 0) sinEspacio.push({ codigo, lote, pallets: rem, formato: itemFmt, loc_origen: locInfo.localizador, motivo: `Sin ubicación con formato "${itemFmt || "—"}". Quedan ${rem} plt sin mover.` });
      }
    }
  }

  // ── FASE 2: CONSOLIDAR ───────────────────────────────────────────────────────
  const toConsolidate = [...globalIndex.entries()]
    .filter(([, locs]) => locs.size > 1)
    .sort((a, b) => {
      const totA = [...a[1].values()].reduce((s, v) => s + v, 0);
      const totB = [...b[1].values()].reduce((s, v) => s + v, 0);
      return totB - totA;
    });

  for (const [clk, locPallets] of toConsolidate) {
    const [codigo, lote] = clk.split("|||");
    const sample = validItems.find(it => it.codigo === codigo && it.lote === lote);
    const itemFmt = sample?.formato || "";

    let anchorLocKey = "";
    let anchorPallets = 0;
    if (targetLoc) {
      const tlk = targetLoc.toUpperCase().trim();
      if (locPallets.has(tlk)) { anchorLocKey = tlk; anchorPallets = locPallets.get(tlk)!; }
    }
    if (!anchorLocKey) {
      for (const [lk, p] of locPallets) { if (p > anchorPallets) { anchorPallets = p; anchorLocKey = lk; } }
    }

    const anchorState = pool.get(anchorLocKey);
    const anchorInfo = locInfoMap.get(anchorLocKey);
    if (!anchorState || !anchorInfo) continue;

    for (const [lk, pallets] of locPallets) {
      if (lk === anchorLocKey) continue;
      const srcInfo = locInfoMap.get(lk);
      if (!srcInfo) continue;
      const srcState = pool.get(lk);

      if (anchorState.available >= pallets) {
        paso++;
        movimientos.push({ paso, tipo: "consolidar", codigo, lote, pallets, formato: itemFmt, loc_origen: srcInfo.localizador, zona_origen: srcInfo.zona, loc_destino: anchorInfo.localizador, zona_destino: anchorInfo.zona, razon: `Consolidar ${codigo}/Lote ${lote}: ${pallets} plt de ${srcInfo.localizador} → ${anchorInfo.localizador} (ancla ${anchorPallets} plt)` });
        anchorState.available -= pallets;
        if (srcState) srcState.available += pallets;
      } else if (anchorState.available > 0) {
        const take = anchorState.available;
        paso++;
        movimientos.push({ paso, tipo: "consolidar", codigo, lote, pallets: take, formato: itemFmt, loc_origen: srcInfo.localizador, zona_origen: srcInfo.zona, loc_destino: anchorInfo.localizador, zona_destino: anchorInfo.zona, razon: `Consolidar parcial ${codigo}/${lote}: ${take}/${pallets} plt → ${anchorInfo.localizador} (espacio agotado)` });
        anchorState.available -= take;
        if (srcState) srcState.available += take;
        sinEspacio.push({ codigo, lote, pallets: pallets - take, formato: itemFmt, loc_origen: srcInfo.localizador, motivo: `Espacio insuficiente en ${anchorInfo.localizador}: faltan ${pallets - take} plt` });
      } else {
        sinEspacio.push({ codigo, lote, pallets, formato: itemFmt, loc_origen: srcInfo.localizador, motivo: `${anchorInfo.localizador} sin espacio disponible para ${pallets} plt de ${codigo}/${lote}` });
      }
    }
  }

  const liberar = movimientos.filter(m => m.tipo === "liberar").sort((a, b) => b.pallets - a.pallets);
  const consolidar = movimientos.filter(m => m.tipo === "consolidar").sort((a, b) => b.pallets - a.pallets);
  const ordered = [...liberar, ...consolidar];
  ordered.forEach((m, i) => { m.paso = i + 1; });

  return { movimientos: ordered, sinEspacio };
}

// ── Handler ───────────────────────────────────────────────────────────────────
const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8000";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      items: ItemInput[];
      locations: LocationInput[];
      targetLoc?: string;
    };

    if (!Array.isArray(body.items) || !Array.isArray(body.locations)) {
      return NextResponse.json({ ok: false, error: "items y locations deben ser arrays" }, { status: 400 });
    }

    // Intentar cerebro Python primero
    try {
      const pyResp = await fetch(`${BACKEND}/consolidacion/extrema`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: body.items,
          locations: body.locations,
          target_loc: body.targetLoc ?? null,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (pyResp.ok) {
        const data = await pyResp.json();
        return NextResponse.json(data, { headers: { "X-Source": "python" } });
      }
    } catch {
      // Backend Python no disponible — usar fallback TS
    }

    // Fallback TypeScript
    const { movimientos, sinEspacio } = computeConsolidacion(body.items, body.locations, body.targetLoc);
    const liberar = movimientos.filter(m => m.tipo === "liberar");
    const consolidar = movimientos.filter(m => m.tipo === "consolidar");
    const locsLiberadas = [...new Set(liberar.map(m => m.loc_origen))];

    return NextResponse.json({
      ok: true,
      movimientos,
      resumen: {
        total_movimientos: movimientos.length,
        locs_liberadas: locsLiberadas,
        locs_liberadas_count: locsLiberadas.length,
        lotes_consolidados: new Set(consolidar.map(m => `${m.codigo}|||${m.lote}`)).size,
        pallets_movidos: movimientos.reduce((s, m) => s + m.pallets, 0),
        fase_liberar: liberar.length,
        fase_consolidar: consolidar.length,
        sin_espacio_count: sinEspacio.length,
      },
      sin_espacio: sinEspacio,
    }, { headers: { "X-Source": "typescript-fallback" } });

  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
