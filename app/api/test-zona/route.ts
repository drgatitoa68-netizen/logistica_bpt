import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Endpoint temporal de diagnóstico — devuelve plan de consolidación para una ubicación específica
// Uso: GET /api/test-zona?loc=09.18.00.00&zona=ZONA09
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const targetLoc = searchParams.get("loc") || "09.18.00.00";
    const targetZona = searchParams.get("zona") || "ZONA09";

    const sb = await createClient();

    // 1. Obtener TODOS los localizadores activos (para encontrar dónde mover)
    const { data: allLocs, error: locErr } = await sb
      .from("localizadores")
      .select("zona,localizador,formato,capacidad,ocupado,disponible,pct_ocupacion,activo")
      .eq("activo", true)
      .order("zona").order("localizador");

    if (locErr) throw new Error("localizadores: " + locErr.message);

    // 2. Obtener inventario de la zona objetivo + la ubicación específica
    const { data: invZona, error: invErr } = await sb
      .from("inventario")
      .select("localizador,codigo,lote,pallets,cajas,formato,descripcion,subinventario")
      .eq("zona", targetZona);

    // 3. También buscar en tabla lineas_reubicacion como fallback
    let invItems: {loc: string; codigo: string; lote: string; pallets: number; formato: string; descripcion?: string}[] = [];

    if (!invErr && invZona && invZona.length > 0) {
      invItems = invZona.map((r) => ({
        loc: r.localizador,
        codigo: r.codigo || "",
        lote: r.lote || "",
        pallets: Number(r.pallets) || 0,
        formato: r.formato || "",
        descripcion: r.descripcion || "",
      })).filter(it => it.codigo && it.pallets > 0);
    }

    // 4. Datos de la ubicación objetivo desde localizadores
    const locObj = (allLocs || []).find(l => l.localizador.toUpperCase() === targetLoc.toUpperCase());

    // 5. Información de lo que hay en esa ubicación (inventario de esa loc)
    const itemsEnLoc = invItems.filter(it => it.loc.toUpperCase() === targetLoc.toUpperCase());

    // 6. Llamar al algoritmo de consolidación extrema
    const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8000";
    let planResult = null;

    try {
      const pyResp = await fetch(`${BACKEND}/consolidacion/extrema`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: invItems,
          locations: allLocs || [],
          target_loc: targetLoc,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (pyResp.ok) planResult = await pyResp.json();
    } catch {
      // backend Python no disponible
    }

    // 7. Si no hay inventario en la tabla inventario, buscar en la info del localizador
    const response = {
      diagnostico: {
        localizador: targetLoc,
        zona: targetZona,
        info_loc: locObj ?? null,
        total_locs_zona: (allLocs || []).filter(l => l.zona === targetZona).length,
        total_items_zona: invItems.length,
        items_en_localizador: itemsEnLoc,
        nota: invItems.length === 0
          ? "La tabla 'inventario' está vacía o no tiene datos de esta zona. El plan se basa en los datos de la tabla 'localizadores' (ocupación)."
          : `Se encontraron ${invItems.length} ítems en ZONA09`,
      },
      plan_consolidacion: planResult,
      // También sugerir destinos libres en base a la info de localizadores
      destinos_disponibles_zona: (allLocs || [])
        .filter(l =>
          l.zona === targetZona &&
          l.localizador.toUpperCase() !== targetLoc.toUpperCase() &&
          (l.disponible ?? 0) > 0 &&
          (locObj ? (l.formato === locObj.formato || !l.formato || l.formato === "MEZCLA") : true)
        )
        .sort((a, b) => (b.disponible ?? 0) - (a.disponible ?? 0))
        .slice(0, 10)
        .map(l => ({
          localizador: l.localizador,
          formato: l.formato,
          disponible: l.disponible,
          capacidad: l.capacidad,
          pct: ((l.pct_ocupacion ?? 0) * 100).toFixed(1) + "%",
        })),
    };

    return NextResponse.json(response, {
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });

  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
