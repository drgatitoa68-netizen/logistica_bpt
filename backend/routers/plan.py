"""
Algoritmos de organización de bodega BPT.

Endpoints:
  POST /analisis-bpt/plan            — Plan de distribución (backward-compatible, mejorado)
  POST /analisis-bpt/analisis-completo — Análisis integral + sugerencias de consolidación
"""
import math
import re
from collections import defaultdict
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from supabase import Client

from core.supabase import get_supabase

router = APIRouter(prefix="/analisis-bpt", tags=["analisis-bpt"])


# ── Modelos de entrada ──────────────────────────────────────────────────────

class SubInvItem(BaseModel):
    loc: str
    subinv: str
    formato: str
    lote: str
    pallets: int
    codigo: Optional[str] = None
    descripcion: Optional[str] = None


class LocInput(BaseModel):
    zona: str
    localizador: str
    disponible: int
    capacidad: int
    formato: Optional[str] = None


class PlanRequest(BaseModel):
    items: list[SubInvItem]
    locations: list[LocInput]


class AnalisisRequest(BaseModel):
    items: list[SubInvItem]
    locations: list[LocInput]


# ── Modelos de salida ───────────────────────────────────────────────────────

class Asignacion(BaseModel):
    loc: str
    zona: str
    palletsAsignados: int
    prioridad: str  # "formato_exacto" | "formato_libre" | "cualquiera"


class PlanEntry(BaseModel):
    formato: str
    lote: str
    palletsNeed: int
    asignaciones: list[Asignacion]
    palletsAsignados: int
    palletsRestantes: int
    cobertura_pct: float  # % asignado en locs de mismo formato


class FragmentacionItem(BaseModel):
    formato: str
    total_pallets: int
    num_localizadores: int
    num_zonas: int
    zonas: list[str]
    indice: float          # 0=concentrado, 1=muy fragmentado
    nivel: str             # "optimo" | "aceptable" | "fragmentado" | "critico"


class Consolidacion(BaseModel):
    formato: str
    lote: str
    locs_origen: list[str]
    loc_destino: str
    zona_destino: str
    pallets_a_mover: int
    beneficio: str


class AlertaBodega(BaseModel):
    nivel: str             # "info" | "warning" | "critico"
    mensaje: str
    detalle: Optional[str] = None


class ResumenFormato(BaseModel):
    formato: str
    total_pallets: int
    m2_estimado: Optional[float]
    locs_propios: int      # localizadores con ese formato asignado
    locs_ocupados: int     # localizadores que tienen stock de ese formato
    cobertura_pct: float   # % pallets en locs del mismo formato


class AnalisisResponse(BaseModel):
    plan: list[PlanEntry]
    fragmentacion: list[FragmentacionItem]
    consolidaciones: list[Consolidacion]
    resumen_formatos: list[ResumenFormato]
    alertas: list[AlertaBodega]
    metricas: dict


# ── Helpers ─────────────────────────────────────────────────────────────────

_FMT_RE = re.compile(r'\b(\d{1,3}(?:[.,]\d+)?[Xx×]\d{1,3}(?:[.,]\d+)?)\b')

def _norm(s: str) -> str:
    return (s or "").strip().upper()


def _formato_de_descripcion(desc: str) -> str:
    """Extrae el formato (ej. 60X120, 45X45, 51.2X51.2) de la descripción del producto."""
    m = _FMT_RE.search(desc or "")
    return m.group(1).upper().replace("×", "X") if m else ""


def _fetch_catalog(db: Client, codigos: list[str]) -> dict[str, dict]:
    """Batch-fetch catalogo_productos. Retorna dict keyed by codigo."""
    if not codigos:
        return {}
    resp = db.from_("catalogo_productos") \
             .select("codigo,formato,cajas_por_pallet,m2_x_pe") \
             .in_("codigo", list(set(codigos))) \
             .execute()
    return {r["codigo"]: r for r in (resp.data or [])}


def _enrich_formato(items: list[SubInvItem], catalog: dict[str, dict]) -> list[SubInvItem]:
    """
    Rellena formato vacío en tres pasos:
      1. Usa item.formato si ya está presente
      2. Busca en catalogo_productos por codigo
      3. Extrae el patrón dimensional de la descripción (ej. 60X120, 45X45)
    """
    enriched = []
    for it in items:
        fmt = _norm(it.formato)
        if not fmt and it.codigo and it.codigo in catalog:
            fmt = _norm(catalog[it.codigo].get("formato") or "")
        if not fmt and it.descripcion:
            fmt = _formato_de_descripcion(it.descripcion)
        enriched.append(it.model_copy(update={"formato": fmt or "SIN FORMATO"}))
    return enriched


# ── Algoritmo de plan (3 prioridades) ───────────────────────────────────────

def compute_plan(
    items: list[SubInvItem],
    locs: list[LocInput],
    catalog: dict[str, dict] | None = None,
) -> list[PlanEntry]:
    """
    Greedy con 3 prioridades de asignación:
      P1 — Localizador con formato exactamente igual al producto
      P2 — Localizador sin formato asignado o con formato "MEZCLA" / vacío
      P3 — Cualquier localizador disponible

    Dentro de cada prioridad, se prefieren localizadores con más espacio libre
    (mejor utilización y menos fragmentación).
    """
    items = _enrich_formato(items, catalog or {})

    # Agrupar por (formato, lote)
    groups: dict[str, dict] = {}
    for item in items:
        fmt = _norm(item.formato) or "SIN FORMATO"
        lot = _norm(item.lote) or "SIN LOTE"
        key = f"{fmt}|||{lot}"
        if key not in groups:
            groups[key] = {"formato": fmt, "lote": lot, "pallets": 0}
        groups[key]["pallets"] += item.pallets

    # Pool mutable de localizadores
    FORMATOS_LIBRES = {"", "MEZCLA", "SIN FORMATO", "MIXTO", "LIBRE", "GENERAL"}

    pool = [
        {
            "loc": _norm(loc.localizador),
            "zona": loc.zona,
            "formatoLoc": _norm(loc.formato or ""),
            "freeSlots": max(0, loc.disponible or 0),
        }
        for loc in locs
        if (loc.disponible or 0) > 0
    ]
    # Ordenar pool: zonas alfab., dentro de cada zona más espacio primero
    pool.sort(key=lambda x: (x["zona"], -x["freeSlots"]))

    entries: list[PlanEntry] = []
    sorted_groups = sorted(groups.values(), key=lambda g: -g["pallets"])

    for g in sorted_groups:
        asignaciones: list[Asignacion] = []
        remaining = g["pallets"]
        pallets_en_formato_exacto = 0
        assigned_locs: set[str] = set()

        def _assign(loc_entry: dict, prioridad: str) -> None:
            nonlocal remaining, pallets_en_formato_exacto
            if remaining <= 0 or loc_entry["freeSlots"] <= 0:
                return
            take = min(loc_entry["freeSlots"], remaining)
            asignaciones.append(Asignacion(
                loc=loc_entry["loc"],
                zona=loc_entry["zona"],
                palletsAsignados=take,
                prioridad=prioridad,
            ))
            loc_entry["freeSlots"] -= take
            remaining -= take
            assigned_locs.add(loc_entry["loc"])
            if prioridad == "formato_exacto":
                pallets_en_formato_exacto += take

        # P1: mismo formato exacto
        for loc in pool:
            if remaining <= 0:
                break
            if loc["loc"] in assigned_locs:
                continue
            if loc["formatoLoc"] == g["formato"]:
                _assign(loc, "formato_exacto")

        # P2: formato libre / mezcla
        for loc in pool:
            if remaining <= 0:
                break
            if loc["loc"] in assigned_locs:
                continue
            if loc["formatoLoc"] in FORMATOS_LIBRES:
                _assign(loc, "formato_libre")

        # P3: cualquier localizador
        for loc in pool:
            if remaining <= 0:
                break
            if loc["loc"] in assigned_locs:
                continue
            _assign(loc, "cualquiera")

        asignados = g["pallets"] - remaining
        cobertura = (pallets_en_formato_exacto / asignados * 100) if asignados > 0 else 0.0

        entries.append(PlanEntry(
            formato=g["formato"],
            lote=g["lote"],
            palletsNeed=g["pallets"],
            asignaciones=asignaciones,
            palletsAsignados=asignados,
            palletsRestantes=remaining,
            cobertura_pct=round(cobertura, 1),
        ))

    entries.sort(key=lambda e: (e.formato, e.lote))
    return entries


# ── Análisis de fragmentación ────────────────────────────────────────────────

def analizar_fragmentacion(items: list[SubInvItem]) -> list[FragmentacionItem]:
    """
    Para cada formato, evalúa qué tan fragmentado está el stock.
    Índice: (num_locs - 1) / max(num_locs - 1, 1) × (num_zonas - 1) / max(zonas, 1)
    """
    fmt_data: dict[str, dict] = {}
    for it in items:
        fmt = _norm(it.formato) or "SIN FORMATO"
        if fmt not in fmt_data:
            fmt_data[fmt] = {"pallets": 0, "locs": set(), "zonas": set()}
        fmt_data[fmt]["pallets"] += it.pallets
        fmt_data[fmt]["locs"].add(_norm(it.loc))

    # Para zonas necesitamos mapear loc → zona desde los items (no tenemos locs aquí)
    # Se agrega zona si el caller lo provee; por ahora usamos solo locs
    result = []
    for fmt, d in fmt_data.items():
        n = len(d["locs"])
        idx = min(1.0, (n - 1) / 10)  # normalizado a 0-1, >10 locs = crítico
        nivel = (
            "optimo"     if n == 1  else
            "aceptable"  if n <= 3  else
            "fragmentado" if n <= 7 else
            "critico"
        )
        result.append(FragmentacionItem(
            formato=fmt,
            total_pallets=d["pallets"],
            num_localizadores=n,
            num_zonas=len(d["zonas"]) or n,
            zonas=sorted(d["zonas"]) if d["zonas"] else [],
            indice=round(idx, 3),
            nivel=nivel,
        ))

    result.sort(key=lambda x: (-x.indice, -x.total_pallets))
    return result


# ── Sugerencias de consolidación ─────────────────────────────────────────────

def sugerir_consolidaciones(
    items: list[SubInvItem],
    locs: list[LocInput],
    max_sugerencias: int = 10,
) -> list[Consolidacion]:
    """
    Para cada (formato, lote) fragmentado en >1 localizador,
    sugiere mover todo a la ubicación destino con mayor espacio libre del mismo formato.
    """
    # Construir mapa de disponibilidad por formato
    loc_info: dict[str, dict] = {}
    for loc in locs:
        key = _norm(loc.localizador)
        loc_info[key] = {
            "zona": loc.zona,
            "formato": _norm(loc.formato or ""),
            "disponible": max(0, loc.disponible or 0),
        }

    # Agrupar items por (formato, lote)
    grupos: dict[str, list] = defaultdict(list)
    for it in items:
        fmt = _norm(it.formato) or "SIN FORMATO"
        lot = _norm(it.lote) or "SIN LOTE"
        grupos[f"{fmt}|||{lot}"].append(it)

    FORMATOS_LIBRES = {"", "MEZCLA", "SIN FORMATO", "MIXTO", "LIBRE", "GENERAL"}
    sugerencias: list[Consolidacion] = []

    for key, group_items in grupos.items():
        fmt, lot = key.split("|||", 1)
        locs_origen = list({_norm(it.loc) for it in group_items})
        if len(locs_origen) <= 1:
            continue  # ya consolidado

        total_pallets = sum(it.pallets for it in group_items)

        # Buscar mejor destino: mismo formato, mayor espacio libre, no origen
        candidatos = [
            (lk, li)
            for lk, li in loc_info.items()
            if lk not in set(locs_origen)
            and (li["formato"] == fmt or li["formato"] in FORMATOS_LIBRES)
            and li["disponible"] >= total_pallets
        ]
        if not candidatos:
            continue

        # Preferir mismo formato; dentro de eso, mayor espacio
        candidatos.sort(key=lambda x: (x[1]["formato"] != fmt, -x[1]["disponible"]))
        dest_key, dest_info = candidatos[0]

        sugerencias.append(Consolidacion(
            formato=fmt,
            lote=lot,
            locs_origen=locs_origen,
            loc_destino=dest_key,
            zona_destino=dest_info["zona"],
            pallets_a_mover=total_pallets,
            beneficio=f"Reduce de {len(locs_origen)} a 1 ubicación — "
                      f"libera {len(locs_origen) - 1} localizadores",
        ))

        if len(sugerencias) >= max_sugerencias:
            break

    sugerencias.sort(key=lambda s: -s.pallets_a_mover)
    return sugerencias


# ── Resumen por formato ──────────────────────────────────────────────────────

def resumen_por_formato(
    items: list[SubInvItem],
    locs: list[LocInput],
    catalog: dict[str, dict],
) -> list[ResumenFormato]:
    """
    Por cada formato: pallets totales, m² estimado, cuántos locs propios existen,
    cuántos locs los ocupan y % de pallets en locs del mismo formato.
    """
    # m2_x_pe por formato (del catálogo)
    m2_por_fmt: dict[str, float] = {}
    for c in catalog.values():
        fmt = _norm(c.get("formato") or "")
        if fmt and c.get("m2_x_pe"):
            m2_por_fmt[fmt] = float(c["m2_x_pe"])

    # Locs con formato asignado
    locs_propios_por_fmt: dict[str, int] = defaultdict(int)
    for loc in locs:
        fmt = _norm(loc.formato or "")
        if fmt and fmt not in {"MEZCLA", "SIN FORMATO", "MIXTO", "LIBRE", "GENERAL"}:
            locs_propios_por_fmt[fmt] += 1

    # Pallets y locs ocupados por formato
    fmt_pallets: dict[str, int] = defaultdict(int)
    fmt_locs_ocup: dict[str, set] = defaultdict(set)
    # mapa loc → formato del loc (para calcular cobertura)
    loc_to_fmt: dict[str, str] = {_norm(loc.localizador): _norm(loc.formato or "") for loc in locs}

    pallets_en_fmt_propio: dict[str, int] = defaultdict(int)

    for it in items:
        fmt = _norm(it.formato) or "SIN FORMATO"
        fmt_pallets[fmt] += it.pallets
        fmt_locs_ocup[fmt].add(_norm(it.loc))
        loc_fmt = loc_to_fmt.get(_norm(it.loc), "")
        if loc_fmt == fmt:
            pallets_en_fmt_propio[fmt] += it.pallets

    result = []
    for fmt in fmt_pallets:
        total = fmt_pallets[fmt]
        en_propio = pallets_en_fmt_propio.get(fmt, 0)
        cobertura = (en_propio / total * 100) if total > 0 else 0.0
        m2_unit = m2_por_fmt.get(fmt)
        result.append(ResumenFormato(
            formato=fmt,
            total_pallets=total,
            m2_estimado=round(total * m2_unit, 2) if m2_unit else None,
            locs_propios=locs_propios_por_fmt.get(fmt, 0),
            locs_ocupados=len(fmt_locs_ocup[fmt]),
            cobertura_pct=round(cobertura, 1),
        ))

    result.sort(key=lambda x: -x.total_pallets)
    return result


# ── Generador de alertas ─────────────────────────────────────────────────────

def generar_alertas(
    items: list[SubInvItem],
    locs: list[LocInput],
    plan: list[PlanEntry],
    fragmentacion: list[FragmentacionItem],
) -> list[AlertaBodega]:
    alertas: list[AlertaBodega] = []

    # Pallets sin asignar
    sin_espacio = [(e.formato, e.lote, e.palletsRestantes) for e in plan if e.palletsRestantes > 0]
    for fmt, lot, restantes in sin_espacio:
        alertas.append(AlertaBodega(
            nivel="critico",
            mensaje=f"Sin espacio: {restantes} pallets de {fmt} / {lot} sin ubicación",
        ))

    # Formatos críticos por fragmentación
    for f in fragmentacion:
        if f.nivel == "critico":
            alertas.append(AlertaBodega(
                nivel="critico",
                mensaje=f"Fragmentación crítica: {f.formato}",
                detalle=f"{f.total_pallets} pallets repartidos en {f.num_localizadores} localizadores",
            ))
        elif f.nivel == "fragmentado":
            alertas.append(AlertaBodega(
                nivel="warning",
                mensaje=f"Fragmentación alta: {f.formato}",
                detalle=f"{f.num_localizadores} localizadores — considerar consolidar",
            ))

    # Cobertura baja en el plan (sólo cuando el formato es conocido)
    for e in plan:
        if e.palletsAsignados > 0 and e.cobertura_pct < 50 and e.formato != "SIN FORMATO":
            alertas.append(AlertaBodega(
                nivel="warning",
                mensaje=f"Baja cobertura de formato: {e.formato} / {e.lote}",
                detalle=f"Solo {e.cobertura_pct:.0f}% asignado en locs de mismo formato",
            ))

    # Capacidad global
    total_disp = sum(max(0, loc.disponible or 0) for loc in locs)
    total_need = sum(e.palletsNeed for e in plan)
    if total_disp < total_need * 0.1:
        alertas.append(AlertaBodega(
            nivel="critico",
            mensaje="Capacidad crítica de bodega",
            detalle=f"Solo {total_disp} pallets libres para {total_need} necesarios",
        ))
    elif total_disp < total_need * 0.3:
        alertas.append(AlertaBodega(
            nivel="warning",
            mensaje="Capacidad de bodega baja",
            detalle=f"{total_disp} pallets libres disponibles",
        ))

    return alertas


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/plan")
async def plan_distribucion(
    body: PlanRequest,
    db: Client = Depends(get_supabase),
):
    """Plan de distribución mejorado: 3 prioridades, soporte catálogo."""
    if not isinstance(body.items, list) or not isinstance(body.locations, list):
        raise HTTPException(status_code=400, detail="items y locations deben ser arrays")

    # Resolver formatos vacíos desde catálogo
    codigos = [it.codigo for it in body.items if it.codigo]
    catalog = _fetch_catalog(db, codigos) if codigos else {}

    plan = compute_plan(body.items, body.locations, catalog)
    return {
        "ok": True,
        "plan": [e.model_dump() for e in plan],
    }


@router.post("/analisis-completo")
async def analisis_completo(
    body: AnalisisRequest,
    db: Client = Depends(get_supabase),
):
    """
    Análisis integral de la bodega:
    - Plan de distribución con 3 prioridades
    - Análisis de fragmentación por formato
    - Sugerencias de consolidación
    - Resumen por formato (con m² si hay catálogo)
    - Alertas de problemas detectados
    - Métricas globales
    """
    if not isinstance(body.items, list) or not isinstance(body.locations, list):
        raise HTTPException(status_code=400, detail="items y locations deben ser arrays")

    # Obtener catálogo completo de formatos presentes
    codigos = [it.codigo for it in body.items if it.codigo]
    catalog = _fetch_catalog(db, codigos) if codigos else {}

    # También obtener catálogo completo para m2_x_pe (todos los formatos)
    formatos_presentes = list({
        (it.formato or "").strip().upper() for it in body.items if it.formato
    })
    if formatos_presentes:
        resp = db.from_("catalogo_productos") \
                 .select("codigo,formato,cajas_por_pallet,m2_x_pe") \
                 .in_("formato", formatos_presentes) \
                 .execute()
        for r in (resp.data or []):
            if r["codigo"] not in catalog:
                catalog[r["codigo"]] = r

    # Enriquecer items con formato del catálogo cuando esté vacío
    items_enriq = _enrich_formato(body.items, catalog)

    # 1. Plan de distribución
    plan = compute_plan(items_enriq, body.locations, catalog)

    # 2. Fragmentación del stock actual
    frag = analizar_fragmentacion(items_enriq)

    # 3. Sugerencias de consolidación
    consolid = sugerir_consolidaciones(items_enriq, body.locations)

    # 4. Resumen por formato
    resumen = resumen_por_formato(items_enriq, body.locations, catalog)

    # 5. Alertas
    alertas = generar_alertas(items_enriq, body.locations, plan, frag)

    # 6. Métricas globales
    total_pallets = sum(it.pallets for it in items_enriq)
    total_cap = sum(loc.capacidad or 0 for loc in body.locations)
    total_disp = sum(max(0, loc.disponible or 0) for loc in body.locations)
    pallets_asignados = sum(e.palletsAsignados for e in plan)
    formatos_sin_locs_propios = [
        r.formato for r in resumen if r.locs_propios == 0 and r.formato != "SIN FORMATO"
    ]
    cobertura_global = (
        sum(e.palletsAsignados * e.cobertura_pct for e in plan)
        / max(pallets_asignados, 1)
    )

    metricas = {
        "total_pallets_stock": total_pallets,
        "total_pallets_libres": total_disp,
        "capacidad_total_bodega": total_cap,
        "pallets_plan_asignados": pallets_asignados,
        "pallets_plan_sin_espacio": total_pallets - pallets_asignados,
        "pct_cobertura_formato_global": round(cobertura_global, 1),
        "num_formatos": len(resumen),
        "num_formatos_sin_loc_propio": len(formatos_sin_locs_propios),
        "formatos_sin_loc_propio": formatos_sin_locs_propios,
        "formatos_criticos_fragmentacion": sum(1 for f in frag if f.nivel == "critico"),
        "sugerencias_consolidacion": len(consolid),
        "codigos_con_catalogo": len(catalog),
    }

    return AnalisisResponse(
        plan=plan,
        fragmentacion=frag,
        consolidaciones=consolid,
        resumen_formatos=resumen,
        alertas=alertas,
        metricas=metricas,
    ).model_dump()
