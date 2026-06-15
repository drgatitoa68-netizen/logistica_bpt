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

interface ZonaCriticidad {
  zona: string;
  num_locs_mezcladas: number;
  num_codigos_fragmentados: number;
  pallets_en_mezcla: number;
  pallets_fragmentados: number;
  score_criticidad: number;
  nivel: "CRITICO" | "ALTO" | "MEDIO" | "OK";
}

interface Movimiento {
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

// ── Utilidades ────────────────────────────────────────────────────────────────
const FORMATOS_LIBRES = new Set(["", "MEZCLA", "MIX", "MIXTO", "LIBRE", "GENERAL", "SIN FORMATO"]);

function norm(s: string) { return (s || "").trim().toUpperCase(); }

function formatoCompatible(locFmt: string, itemFmt: string): boolean {
  const lf = norm(locFmt);
  const itf = norm(itemFmt);
  if (FORMATOS_LIBRES.has(lf)) return true;
  if (!itf) return true;
  return lf === itf;
}

function scoreDest(avail: number, locFmt: string, itemFmt: string, needed: number): number {
  const lf = norm(locFmt);
  const itf = norm(itemFmt);
  let s = 0;
  if (lf === itf && !FORMATOS_LIBRES.has(lf)) s += 2000;
  else if (FORMATOS_LIBRES.has(lf)) s += 500;
  const waste = avail - needed;
  if (waste >= 0) s += Math.max(0, 800 - waste * 2);
  if (avail > needed * 3) s -= 100;
  return s;
}

type LocEntry = { zona: string; localizador: string; formato: string; available: number };

function findBest(
  pool: Map<string, LocEntry>,
  itemFmt: string,
  needed: number,
  exclude: Set<string>,
): LocEntry | null {
  let best: LocEntry | null = null;
  let bestScore = -Infinity;
  for (const [k, loc] of pool) {
    if (exclude.has(k)) continue;
    if (loc.available < needed) continue;
    if (!formatoCompatible(loc.formato, itemFmt)) continue;
    const s = scoreDest(loc.available, loc.formato, itemFmt, needed);
    if (s > bestScore) { bestScore = s; best = loc; }
  }
  return best;
}

// ── Evaluación de criticidad por zona ────────────────────────────────────────
function evaluateZones(
  items: ItemInput[],
  locMap: Map<string, { zona: string }>,
): { zonas: ZonaCriticidad[]; sinMapa: string[] } {
  const byZona = new Map<string, ItemInput[]>();
  const sinMapa: string[] = [];

  for (const it of items) {
    const lk = norm(it.loc);
    const info = locMap.get(lk);
    if (!info) { sinMapa.push(it.loc); continue; }
    if (!byZona.has(info.zona)) byZona.set(info.zona, []);
    byZona.get(info.zona)!.push(it);
  }

  const zonas: ZonaCriticidad[] = [];

  for (const [zona, zonaItems] of byZona) {
    // Mezclas por ubicación
    const byLoc = new Map<string, Map<string, number>>();
    for (const it of zonaItems) {
      const lk = norm(it.loc);
      const clk = `${it.codigo.trim()}|||${it.lote.trim()}`;
      if (!byLoc.has(lk)) byLoc.set(lk, new Map());
      byLoc.get(lk)!.set(clk, (byLoc.get(lk)!.get(clk) ?? 0) + it.pallets);
    }

    let numMezclas = 0, palletsEnMezcla = 0;
    for (const [, clMap] of byLoc) {
      const codes = new Set([...clMap.keys()].map(k => k.split("|||")[0]));
      if (codes.size > 1) {
        numMezclas++;
        palletsEnMezcla += [...clMap.values()].reduce((s, v) => s + v, 0);
      }
    }

    // Fragmentación: mismo código+lote en >1 ubicación
    const clLocs = new Map<string, Set<string>>();
    const clPallets = new Map<string, number>();
    for (const it of zonaItems) {
      const clk = `${it.codigo.trim()}|||${it.lote.trim()}`;
      if (!clLocs.has(clk)) clLocs.set(clk, new Set());
      clLocs.get(clk)!.add(norm(it.loc));
      clPallets.set(clk, (clPallets.get(clk) ?? 0) + it.pallets);
    }

    let numFrag = 0, palletsFrag = 0;
    for (const [clk, locs] of clLocs) {
      if (locs.size > 1) { numFrag++; palletsFrag += clPallets.get(clk) ?? 0; }
    }

    const score = numMezclas * 100 + numFrag * 20 + palletsEnMezcla * 2 + palletsFrag;
    const nivel = score >= 300 ? "CRITICO" : score >= 100 ? "ALTO" : score >= 30 ? "MEDIO" : "OK";

    zonas.push({
      zona,
      num_locs_mezcladas: numMezclas,
      num_codigos_fragmentados: numFrag,
      pallets_en_mezcla: palletsEnMezcla,
      pallets_fragmentados: palletsFrag,
      score_criticidad: score,
      nivel,
    });
  }

  zonas.sort((a, b) => b.score_criticidad - a.score_criticidad);
  return { zonas, sinMapa: [...new Set(sinMapa)] };
}

// ── Algoritmo de consolidación (2 fases) ─────────────────────────────────────
function computeConsolidacion(
  items: ItemInput[],
  locations: LocationInput[],
): { movimientos: Movimiento[]; sinEspacio: SinEspacio[] } {
  const validItems = items.filter(it => it.codigo && it.lote && it.loc && it.pallets > 0);

  const pool = new Map<string, LocEntry>();
  const locInfoMap = new Map<string, LocationInput>();
  for (const loc of locations) {
    if (loc.activo === false) continue;
    const key = norm(loc.localizador);
    locInfoMap.set(key, loc);
    pool.set(key, {
      zona: loc.zona,
      localizador: loc.localizador,
      formato: norm(loc.formato ?? ""),
      available: Math.max(0, loc.disponible ?? 0),
    });
  }

  const locInventory = new Map<string, Map<string, { pallets: number; items: ItemInput[] }>>();
  for (const it of validItems) {
    const lk = norm(it.loc);
    if (!locInventory.has(lk)) locInventory.set(lk, new Map());
    const clk = `${it.codigo.trim()}|||${it.lote.trim()}`;
    const inv = locInventory.get(lk)!;
    if (!inv.has(clk)) inv.set(clk, { pallets: 0, items: [] });
    inv.get(clk)!.pallets += it.pallets;
    inv.get(clk)!.items.push(it);
  }

  const globalIndex = new Map<string, Map<string, number>>();
  for (const it of validItems) {
    const key = `${it.codigo.trim()}|||${it.lote.trim()}`;
    const lk = norm(it.loc);
    if (!globalIndex.has(key)) globalIndex.set(key, new Map());
    globalIndex.get(key)!.set(lk, (globalIndex.get(key)!.get(lk) ?? 0) + it.pallets);
  }

  const movimientos: Movimiento[] = [];
  const sinEspacio: SinEspacio[] = [];
  let paso = 0;

  // Fase 1: LIBERAR mezclas
  const locsMezclados = [...locInventory.entries()]
    .filter(([, inv]) => new Set([...inv.keys()].map(k => k.split("|||")[0])).size > 1)
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
      const target = findBest(pool, itemFmt, pallets, exc);

      if (target) {
        paso++;
        movimientos.push({ paso, tipo: "liberar", codigo, lote, pallets, formato: itemFmt, loc_origen: locInfo.localizador, zona_origen: locInfo.zona, loc_destino: target.localizador, zona_destino: target.zona, razon: `Liberar ${locInfo.localizador}: mantener ${anclaCodigo} (${anclaPallets} plt). Mover ${codigo}/${lote} → ${target.localizador}` });
        target.available -= pallets;
        const src = pool.get(locKey); if (src) src.available += pallets;
      } else {
        let rem = pallets;
        const excP = new Set<string>([locKey]);
        while (rem > 0) {
          const t = findBest(pool, itemFmt, 1, excP);
          if (!t) break;
          const take = Math.min(t.available, rem);
          paso++;
          movimientos.push({ paso, tipo: "liberar", codigo, lote, pallets: take, formato: itemFmt, loc_origen: locInfo.localizador, zona_origen: locInfo.zona, loc_destino: t.localizador, zona_destino: t.zona, razon: `Liberar ${locInfo.localizador} (fracción ${take}/${pallets}): ${codigo}/${lote} → ${t.localizador}` });
          t.available -= take;
          const src = pool.get(locKey); if (src) src.available += take;
          excP.add(norm(t.localizador));
          rem -= take;
        }
        if (rem > 0) sinEspacio.push({ codigo, lote, pallets: rem, formato: itemFmt, loc_origen: locInfo.localizador, motivo: `Sin ubicación formato "${itemFmt || "—"}". Quedan ${rem} plt.` });
      }
    }
  }

  // Fase 2: CONSOLIDAR fragmentados
  const toConsolidate = [...globalIndex.entries()]
    .filter(([, locs]) => locs.size > 1)
    .sort((a, b) => [...b[1].values()].reduce((s, v) => s + v, 0) - [...a[1].values()].reduce((s, v) => s + v, 0));

  for (const [clk, locPallets] of toConsolidate) {
    const [codigo, lote] = clk.split("|||");
    const sample = validItems.find(it => it.codigo === codigo && it.lote === lote);
    const itemFmt = sample?.formato || "";
    let anchorLocKey = "";
    let anchorPallets = 0;
    for (const [lk, p] of locPallets) { if (p > anchorPallets) { anchorPallets = p; anchorLocKey = lk; } }

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
        movimientos.push({ paso, tipo: "consolidar", codigo, lote, pallets, formato: itemFmt, loc_origen: srcInfo.localizador, zona_origen: srcInfo.zona, loc_destino: anchorInfo.localizador, zona_destino: anchorInfo.zona, razon: `Consolidar ${codigo}/L:${lote}: ${pallets} plt de ${srcInfo.localizador} → ${anchorInfo.localizador} (ancla ${anchorPallets} plt)` });
        anchorState.available -= pallets;
        if (srcState) srcState.available += pallets;
      } else if (anchorState.available > 0) {
        const take = anchorState.available;
        paso++;
        movimientos.push({ paso, tipo: "consolidar", codigo, lote, pallets: take, formato: itemFmt, loc_origen: srcInfo.localizador, zona_origen: srcInfo.zona, loc_destino: anchorInfo.localizador, zona_destino: anchorInfo.zona, razon: `Consolidar parcial ${codigo}/${lote}: ${take}/${pallets} plt → ${anchorInfo.localizador}` });
        anchorState.available -= take;
        if (srcState) srcState.available += take;
        sinEspacio.push({ codigo, lote, pallets: pallets - take, formato: itemFmt, loc_origen: srcInfo.localizador, motivo: `Espacio insuficiente en ${anchorInfo.localizador}: faltan ${pallets - take} plt` });
      } else {
        sinEspacio.push({ codigo, lote, pallets, formato: itemFmt, loc_origen: srcInfo.localizador, motivo: `${anchorInfo.localizador} sin espacio para ${pallets} plt de ${codigo}/${lote}` });
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
    const body = await req.json() as { items: ItemInput[]; locations: LocationInput[] };

    if (!Array.isArray(body.items) || !Array.isArray(body.locations)) {
      return NextResponse.json({ ok: false, error: "items y locations deben ser arrays" }, { status: 400 });
    }

    // Intentar cerebro Python primero
    try {
      const pyResp = await fetch(`${BACKEND}/consolidacion/diaria`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: body.items, locations: body.locations }),
        signal: AbortSignal.timeout(30_000),
      });
      if (pyResp.ok) {
        const data = await pyResp.json();
        return NextResponse.json(data, { headers: { "X-Source": "python" } });
      }
    } catch {
      // Python no disponible — fallback TS
    }

    // Fallback TypeScript
    const locMap = new Map<string, { zona: string }>();
    for (const loc of body.locations) {
      if (loc.activo !== false) locMap.set(norm(loc.localizador), { zona: loc.zona });
    }

    // Filtrar ítems con mapa
    const itemsConMapa = body.items.filter(it => locMap.has(norm(it.loc)));

    const { zonas, sinMapa } = evaluateZones(body.items, locMap);
    const { movimientos, sinEspacio } = computeConsolidacion(itemsConMapa, body.locations);

    const liberar = movimientos.filter(m => m.tipo === "liberar");
    const consolidar = movimientos.filter(m => m.tipo === "consolidar");
    const locsLiberadas = [...new Set(liberar.map(m => m.loc_origen))];

    const plan = {
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
    };

    return NextResponse.json({
      ok: true,
      zonas_ordenadas: zonas,
      zonas_sin_mapa: sinMapa,
      total_mezclas: zonas.reduce((s, z) => s + z.num_locs_mezcladas, 0),
      total_fragmentados: zonas.reduce((s, z) => s + z.num_codigos_fragmentados, 0),
      plan,
    }, { headers: { "X-Source": "typescript-fallback" } });

  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
