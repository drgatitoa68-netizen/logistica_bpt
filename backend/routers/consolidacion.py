"""
Cerebro de Organización Extrema — BPT

Algoritmo de dos fases para organización óptima del almacén:
  - Fase 1 (LIBERAR): Para cada ubicación con mezcla de códigos,
    identifica el artículo dominante (más pallets) y mueve el resto
    a ubicaciones compatibles del mismo formato.
  - Fase 2 (CONSOLIDAR): Para cada código+lote fragmentado en varias
    ubicaciones, consolida todo en la ubicación con más stock de ese
    artículo (o en la seleccionada por el usuario).

El "cerebro" evalúa:
  - Compatibilidad de formato (R1: mismo formato o MEZCLA/vacío)
  - Eficiencia de espacio (minimizar desperdicio)
  - Prioridad de movimientos (liberar primero, consolidar después)
  - Fragmentación residual y alertas

Endpoint: POST /consolidacion/extrema
"""

from collections import defaultdict
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/consolidacion", tags=["consolidacion"])

# ── Formatos que aceptan cualquier producto ──────────────────────────────────
_FORMATOS_LIBRES = {"", "MEZCLA", "MIX", "MIXTO", "LIBRE", "GENERAL", "SIN FORMATO"}


def _norm(s: str) -> str:
    return (s or "").strip().upper()


def _formato_compatible(loc_formato: str, item_formato: str) -> bool:
    """¿El localizador puede alojar este formato de producto?"""
    lf = _norm(loc_formato)
    itf = _norm(item_formato)
    if lf in _FORMATOS_LIBRES:
        return True
    if not itf:
        return True
    return lf == itf


# ── Modelos ──────────────────────────────────────────────────────────────────

class ItemIn(BaseModel):
    loc: str
    codigo: str
    lote: str
    pallets: int
    formato: str = ""
    subinv: str = ""
    descripcion: str = ""


class LocationIn(BaseModel):
    zona: str
    localizador: str
    formato: str = ""
    capacidad: int = 0
    disponible: int = 0
    ocupado: int = 0
    activo: bool = True


class ConsolidacionRequest(BaseModel):
    items: list[ItemIn]
    locations: list[LocationIn]
    target_loc: Optional[str] = None  # localizador seleccionado por el usuario


class Movimiento(BaseModel):
    paso: int
    tipo: str          # "liberar" | "consolidar"
    codigo: str
    lote: str
    pallets: int
    formato: str
    loc_origen: str
    zona_origen: str
    loc_destino: str
    zona_destino: str
    razon: str


class SinEspacio(BaseModel):
    codigo: str
    lote: str
    pallets: int
    formato: str
    loc_origen: str
    motivo: str


class Resumen(BaseModel):
    total_movimientos: int
    locs_liberadas: list[str]
    locs_liberadas_count: int
    lotes_consolidados: int
    pallets_movidos: int
    fase_liberar: int
    fase_consolidar: int
    sin_espacio_count: int


class ConsolidacionResponse(BaseModel):
    ok: bool
    movimientos: list[Movimiento]
    resumen: Resumen
    sin_espacio: list[SinEspacio]


# ── Cerebro: scoring de ubicación destino ────────────────────────────────────

def _score_destino(
    loc_available: int,
    loc_formato: str,
    item_formato: str,
    pallets_needed: int,
) -> int:
    lf = _norm(loc_formato)
    itf = _norm(item_formato)

    score = 0
    if lf == itf and lf not in _FORMATOS_LIBRES:
        score += 2000
    elif lf in _FORMATOS_LIBRES:
        score += 500
    waste = loc_available - pallets_needed
    if waste >= 0:
        score += max(0, 800 - waste * 2)
    if loc_available > pallets_needed * 3:
        score -= 100

    return score


def _build_format_index(
    pool: dict[str, dict],
) -> tuple[dict[str, list[str]], list[str]]:
    """Índice formato → claves del pool para búsqueda rápida de destinos compatibles."""
    fmt_index: dict[str, list[str]] = defaultdict(list)
    free_keys: list[str] = []
    for key, loc in pool.items():
        fmt = loc["formato"]
        if fmt in _FORMATOS_LIBRES:
            free_keys.append(key)
        else:
            fmt_index[fmt].append(key)
    return fmt_index, free_keys


def _find_best_target(
    pool: dict[str, dict],
    fmt_index: dict[str, list[str]],
    free_keys: list[str],
    item_formato: str,
    pallets_needed: int,
    exclude_locs: set[str],
) -> Optional[dict]:
    """
    Cerebro: encuentra la mejor ubicación destino respetando formato y espacio.
    Usa índice pre-computado para evitar escanear el pool completo.
    """
    itf = _norm(item_formato)
    # Empty item format → compatible with everything; else exact + free-format locs
    if not itf:
        candidate_keys: object = pool.keys()
    else:
        candidate_keys = list(fmt_index.get(itf, [])) + free_keys

    best = None
    best_score = -1

    for key in candidate_keys:
        if key in exclude_locs:
            continue
        loc = pool.get(key)
        if loc is None or loc["available"] < pallets_needed:
            continue
        score = _score_destino(loc["available"], loc["formato"], item_formato, pallets_needed)
        if score > best_score:
            best_score = score
            best = loc

    return best


# ── Algoritmo principal ──────────────────────────────────────────────────────

@router.post("/extrema", response_model=ConsolidacionResponse)
async def consolidacion_extrema(body: ConsolidacionRequest):
    """
    Organización extrema del almacén en dos fases:
    1. LIBERAR: limpia ubicaciones mezcladas
    2. CONSOLIDAR: junta mismo código+lote en la menor cantidad de ubicaciones
    """
    if not body.items:
        raise HTTPException(status_code=400, detail="Se requieren ítems de inventario")
    if not body.locations:
        raise HTTPException(status_code=400, detail="Se requieren localizadores")

    # ── SETUP ────────────────────────────────────────────────────────────────

    valid_items = [
        it for it in body.items
        if it.codigo and it.codigo.strip()
        and it.lote and it.lote.strip()
        and it.loc and it.loc.strip()
        and it.pallets > 0
    ]

    # Pool mutable de localizadores (clave = localizador en mayúsculas)
    pool: dict[str, dict] = {}
    loc_info_map: dict[str, LocationIn] = {}

    for loc in body.locations:
        if not loc.activo:
            continue
        key = _norm(loc.localizador)
        loc_info_map[key] = loc
        pool[key] = {
            "zona": loc.zona,
            "localizador": loc.localizador,
            "formato": _norm(loc.formato),
            "capacidad": loc.capacidad,
            "available": max(0, loc.disponible),
        }

    # Índice de formatos para búsqueda O(1) en _find_best_target
    fmt_index, free_keys = _build_format_index(pool)

    # Inventario por localizador: loc_key → {cod_lot_key → {pallets, items}}
    loc_inventory: dict[str, dict[str, dict]] = defaultdict(
        lambda: defaultdict(lambda: {"pallets": 0, "items": []})
    )

    # Índice global: cod_lot_key → {loc_key → total_pallets}
    global_index: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))

    # Muestra por código+lote para O(1) lookup del formato (evita next(...) lineal)
    sample_by_cod_lot: dict[str, ItemIn] = {}

    for it in valid_items:
        loc_key = _norm(it.loc)
        cod_lot_key = f"{it.codigo.strip()}|||{it.lote.strip()}"
        loc_inventory[loc_key][cod_lot_key]["pallets"] += it.pallets
        loc_inventory[loc_key][cod_lot_key]["items"].append(it)
        global_index[cod_lot_key][loc_key] += it.pallets
        if cod_lot_key not in sample_by_cod_lot:
            sample_by_cod_lot[cod_lot_key] = it

    movimientos: list[Movimiento] = []
    sin_espacio: list[SinEspacio] = []
    paso = 0

    # ── FASE 1: LIBERAR ──────────────────────────────────────────────────────

    # Pre-computar número de códigos únicos para sort O(n log n) sin recalcular
    locs_mezclados: list[tuple[str, dict, int]] = []
    for lk, inv in loc_inventory.items():
        n_codes = len({k.split("|||")[0] for k in inv})
        if n_codes > 1:
            locs_mezclados.append((lk, inv, n_codes))
    locs_mezclados.sort(key=lambda x: x[2], reverse=True)

    for loc_key, inv, _ in locs_mezclados:
        loc_info = loc_info_map.get(loc_key)
        if not loc_info:
            continue

        ancla_key = max(inv.keys(), key=lambda k: inv[k]["pallets"])
        ancla_codigo = ancla_key.split("|||")[0]
        ancla_pallets = inv[ancla_key]["pallets"]

        for cod_lot_key, data in inv.items():
            if cod_lot_key == ancla_key:
                continue

            codigo, lote = cod_lot_key.split("|||", 1)
            pallets = data["pallets"]
            item_fmt = data["items"][0].formato if data["items"] else ""
            exclude = {loc_key}

            target = _find_best_target(pool, fmt_index, free_keys, item_fmt, pallets, exclude)

            if target:
                paso += 1
                movimientos.append(Movimiento(
                    paso=paso,
                    tipo="liberar",
                    codigo=codigo,
                    lote=lote,
                    pallets=pallets,
                    formato=item_fmt,
                    loc_origen=loc_info.localizador,
                    zona_origen=loc_info.zona,
                    loc_destino=target["localizador"],
                    zona_destino=target["zona"],
                    razon=(
                        f"Liberar {loc_info.localizador}: "
                        f"mantener solo {ancla_codigo} ({ancla_pallets} plt). "
                        f"Mover {codigo}/{lote} → {target['localizador']}"
                    ),
                ))
                target["available"] -= pallets
                if loc_key in pool:
                    pool[loc_key]["available"] += pallets

            else:
                # Mover en fracciones usando índice de formato para candidatos parciales
                itf_partial = _norm(item_fmt)
                if not itf_partial:
                    partial_cands = list(pool.keys())
                else:
                    partial_cands = list(fmt_index.get(itf_partial, [])) + free_keys

                remaining = pallets
                exclude_partial = {loc_key}
                moved = 0

                while remaining > 0:
                    best_partial = None
                    best_partial_avail = 0
                    for pk in partial_cands:
                        if pk in exclude_partial:
                            continue
                        ploc = pool.get(pk)
                        if ploc is None or ploc["available"] <= 0:
                            continue
                        if ploc["available"] > best_partial_avail:
                            best_partial_avail = ploc["available"]
                            best_partial = ploc

                    if not best_partial:
                        break

                    take = min(best_partial["available"], remaining)
                    paso += 1
                    movimientos.append(Movimiento(
                        paso=paso,
                        tipo="liberar",
                        codigo=codigo,
                        lote=lote,
                        pallets=take,
                        formato=item_fmt,
                        loc_origen=loc_info.localizador,
                        zona_origen=loc_info.zona,
                        loc_destino=best_partial["localizador"],
                        zona_destino=best_partial["zona"],
                        razon=(
                            f"Liberar {loc_info.localizador} (fracción {take}/{pallets}): "
                            f"mover {codigo}/{lote} → {best_partial['localizador']}"
                        ),
                    ))
                    best_partial["available"] -= take
                    if loc_key in pool:
                        pool[loc_key]["available"] += take
                    exclude_partial.add(_norm(best_partial["localizador"]))
                    moved += take
                    remaining -= take

                if remaining > 0:
                    sin_espacio.append(SinEspacio(
                        codigo=codigo,
                        lote=lote,
                        pallets=remaining,
                        formato=item_fmt,
                        loc_origen=loc_info.localizador,
                        motivo=(
                            f'Sin ubicación con formato "{item_fmt or "—"}" '
                            f"para mover {remaining} plt de {loc_info.localizador}. "
                            f"Se movieron {pallets - remaining} plt."
                        ),
                    ))

    # ── FASE 2: CONSOLIDAR ───────────────────────────────────────────────────

    # Pre-computar suma de pallets para sort O(n log n) sin recalcular en cada comparación
    to_consolidate: list[tuple[str, dict[str, int], int]] = [
        (k, locs, sum(locs.values()))
        for k, locs in global_index.items()
        if len(locs) > 1
    ]
    to_consolidate.sort(key=lambda x: x[2], reverse=True)

    for cod_lot_key, loc_pallets_map, _ in to_consolidate:
        codigo, lote = cod_lot_key.split("|||", 1)
        # O(1) lookup en lugar de next(...) lineal sobre valid_items
        sample = sample_by_cod_lot.get(cod_lot_key)
        item_fmt = sample.formato if sample else ""

        anchor_loc_key = ""
        anchor_pallets = 0

        if body.target_loc:
            tl_key = _norm(body.target_loc)
            if tl_key in loc_pallets_map:
                anchor_loc_key = tl_key
                anchor_pallets = loc_pallets_map[tl_key]

        if not anchor_loc_key:
            anchor_loc_key = max(loc_pallets_map.keys(), key=lambda k: loc_pallets_map[k])
            anchor_pallets = loc_pallets_map[anchor_loc_key]

        anchor_state = pool.get(anchor_loc_key)
        anchor_info = loc_info_map.get(anchor_loc_key)
        if not anchor_state or not anchor_info:
            continue

        for lk, pallets in loc_pallets_map.items():
            if lk == anchor_loc_key:
                continue

            src_info = loc_info_map.get(lk)
            if not src_info:
                continue
            src_state = pool.get(lk)

            if anchor_state["available"] >= pallets:
                paso += 1
                movimientos.append(Movimiento(
                    paso=paso,
                    tipo="consolidar",
                    codigo=codigo,
                    lote=lote,
                    pallets=pallets,
                    formato=item_fmt,
                    loc_origen=src_info.localizador,
                    zona_origen=src_info.zona,
                    loc_destino=anchor_info.localizador,
                    zona_destino=anchor_info.zona,
                    razon=(
                        f"Consolidar {codigo} / Lote {lote}: "
                        f"{pallets} plt de {src_info.localizador} → "
                        f"{anchor_info.localizador} (ancla: {anchor_pallets} plt)"
                    ),
                ))
                anchor_state["available"] -= pallets
                if src_state:
                    src_state["available"] += pallets

            elif anchor_state["available"] > 0:
                take = anchor_state["available"]
                paso += 1
                movimientos.append(Movimiento(
                    paso=paso,
                    tipo="consolidar",
                    codigo=codigo,
                    lote=lote,
                    pallets=take,
                    formato=item_fmt,
                    loc_origen=src_info.localizador,
                    zona_origen=src_info.zona,
                    loc_destino=anchor_info.localizador,
                    zona_destino=anchor_info.zona,
                    razon=(
                        f"Consolidar parcial {codigo}/{lote}: "
                        f"{take}/{pallets} plt → {anchor_info.localizador} "
                        f"(espacio agotado)"
                    ),
                ))
                anchor_state["available"] -= take
                if src_state:
                    src_state["available"] += take

                sin_espacio.append(SinEspacio(
                    codigo=codigo,
                    lote=lote,
                    pallets=pallets - take,
                    formato=item_fmt,
                    loc_origen=src_info.localizador,
                    motivo=(
                        f"Espacio insuficiente en {anchor_info.localizador}: "
                        f"faltan {pallets - take} plt para consolidar completamente"
                    ),
                ))
            else:
                sin_espacio.append(SinEspacio(
                    codigo=codigo,
                    lote=lote,
                    pallets=pallets,
                    formato=item_fmt,
                    loc_origen=src_info.localizador,
                    motivo=(
                        f"{anchor_info.localizador} sin espacio disponible. "
                        f"No se pueden consolidar {pallets} plt de {codigo}/{lote}"
                    ),
                ))

    # ── ORDENAR: liberar → consolidar, dentro de c/fase por pallets desc ──────
    liberar_mvs = sorted(
        [m for m in movimientos if m.tipo == "liberar"],
        key=lambda m: -m.pallets
    )
    consolidar_mvs = sorted(
        [m for m in movimientos if m.tipo == "consolidar"],
        key=lambda m: -m.pallets
    )
    ordered = liberar_mvs + consolidar_mvs
    for i, m in enumerate(ordered):
        m.paso = i + 1

    locs_liberadas = list({m.loc_origen for m in liberar_mvs})
    lotes_consolidados = len({f"{m.codigo}|||{m.lote}" for m in consolidar_mvs})
    pallets_totales = sum(m.pallets for m in ordered)

    return ConsolidacionResponse(
        ok=True,
        movimientos=ordered,
        resumen=Resumen(
            total_movimientos=len(ordered),
            locs_liberadas=locs_liberadas,
            locs_liberadas_count=len(locs_liberadas),
            lotes_consolidados=lotes_consolidados,
            pallets_movidos=pallets_totales,
            fase_liberar=len(liberar_mvs),
            fase_consolidar=len(consolidar_mvs),
            sin_espacio_count=len(sin_espacio),
        ),
        sin_espacio=sin_espacio,
    )


# ── EVALUACIÓN DIARIA ─────────────────────────────────────────────────────────

class ZonaCriticidad(BaseModel):
    zona: str
    num_locs_mezcladas: int
    num_codigos_fragmentados: int
    pallets_en_mezcla: int
    pallets_fragmentados: int
    score_criticidad: int
    nivel: str  # "CRITICO" | "ALTO" | "MEDIO" | "OK"


class EvaluacionDiariaRequest(BaseModel):
    items: list[ItemIn]
    locations: list[LocationIn]


class EvaluacionDiariaResponse(BaseModel):
    ok: bool
    zonas_ordenadas: list[ZonaCriticidad]
    zonas_sin_mapa: list[str]
    total_mezclas: int
    total_fragmentados: int
    plan: ConsolidacionResponse


@router.post("/diaria", response_model=EvaluacionDiariaResponse)
async def evaluacion_diaria(body: EvaluacionDiariaRequest):
    """
    Evaluación diaria del almacén:
    1. Clasifica cada zona por criticidad (mezclas + fragmentación)
    2. Ordena de mayor a menor urgencia
    3. Genera el plan completo de consolidación sobre todos los ítems
    """
    if not body.items:
        raise HTTPException(status_code=400, detail="Se requieren ítems")
    if not body.locations:
        raise HTTPException(status_code=400, detail="Se requieren localizadores")

    # Mapa loc → zona (solo locs en BD)
    loc_to_zona: dict[str, str] = {}
    for loc in body.locations:
        if loc.activo:
            loc_to_zona[_norm(loc.localizador)] = loc.zona

    # Separar ítems con mapa vs sin mapa
    items_con_mapa: list[ItemIn] = []
    locs_sin_mapa: set[str] = set()

    for it in body.items:
        if _norm(it.loc) in loc_to_zona:
            items_con_mapa.append(it)
        else:
            locs_sin_mapa.add(it.loc)

    # Agrupar por zona
    by_zona: dict[str, list[ItemIn]] = defaultdict(list)
    for it in items_con_mapa:
        by_zona[loc_to_zona[_norm(it.loc)]].append(it)

    # Evaluar criticidad por zona — pase único sobre zona_items
    zonas_criticidad: list[ZonaCriticidad] = []

    for zona, zona_items in by_zona.items():
        by_loc: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        cl_locs: dict[str, set[str]] = defaultdict(set)
        cl_pallets: dict[str, int] = defaultdict(int)

        for it in zona_items:
            lk = _norm(it.loc)
            clk = f"{it.codigo.strip()}|||{it.lote.strip()}"
            by_loc[lk][clk] += it.pallets
            cl_locs[clk].add(lk)
            cl_pallets[clk] += it.pallets

        num_locs_mezcladas = 0
        pallets_en_mezcla = 0
        for lk, cl_map in by_loc.items():
            codes = {k.split("|||")[0] for k in cl_map}
            if len(codes) > 1:
                num_locs_mezcladas += 1
                pallets_en_mezcla += sum(cl_map.values())

        num_fragmentados = sum(1 for locs in cl_locs.values() if len(locs) > 1)
        pallets_fragmentados = sum(
            cl_pallets[clk] for clk, locs in cl_locs.items() if len(locs) > 1
        )

        score = (
            num_locs_mezcladas * 100
            + num_fragmentados * 20
            + pallets_en_mezcla * 2
            + pallets_fragmentados
        )
        nivel = (
            "CRITICO" if score >= 300
            else "ALTO" if score >= 100
            else "MEDIO" if score >= 30
            else "OK"
        )

        zonas_criticidad.append(ZonaCriticidad(
            zona=zona,
            num_locs_mezcladas=num_locs_mezcladas,
            num_codigos_fragmentados=num_fragmentados,
            pallets_en_mezcla=pallets_en_mezcla,
            pallets_fragmentados=pallets_fragmentados,
            score_criticidad=score,
            nivel=nivel,
        ))

    zonas_criticidad.sort(key=lambda z: -z.score_criticidad)

    total_mezclas = sum(z.num_locs_mezcladas for z in zonas_criticidad)
    total_fragmentados = sum(z.num_codigos_fragmentados for z in zonas_criticidad)

    plan = await consolidacion_extrema(ConsolidacionRequest(
        items=items_con_mapa,
        locations=body.locations,
        target_loc=None,
    ))

    return EvaluacionDiariaResponse(
        ok=True,
        zonas_ordenadas=zonas_criticidad,
        zonas_sin_mapa=sorted(locs_sin_mapa),
        total_mezclas=total_mezclas,
        total_fragmentados=total_fragmentados,
        plan=plan,
    )
