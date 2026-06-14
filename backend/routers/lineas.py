from datetime import datetime, timezone
from typing import Literal, Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from supabase import Client
from core.supabase import get_supabase_admin
from core.deps import get_current_user

router = APIRouter(prefix="/lineas", tags=["lineas"])
TABLE = "lineas_reubicacion"

EstadoLinea = Literal["pendiente", "aprobada", "rechazada", "en_proceso", "completada"]


class LineaCreate(BaseModel):
    numero_orden: Optional[str] = None
    cod_org_inv: Optional[str] = None
    codigo: Optional[str] = None
    descripcion: str
    subinventario_origen: Optional[str] = None
    localizador_origen: Optional[str] = None
    lote: Optional[str] = None
    cantidad_fisica: Optional[float] = 0
    pallets: int
    cajas: Optional[int] = 0
    subinventario_destino: Optional[str] = None
    localizador_destino: Optional[str] = None
    responsable: Optional[str] = None
    inv_pe: Optional[int] = None
    notas: Optional[str] = None


class NotasBody(BaseModel):
    notas: str = ""


class FraccionBody(BaseModel):
    class Fraccion(BaseModel):
        pallets: int
        cajas: int
        cantidad_fisica: float
        localizador_destino: str
        subinventario_destino: str

    f1: Fraccion
    f2: Fraccion


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get_user_email(user: dict) -> str:
    return user.get("email", "")


@router.get("/")
async def list_lineas(
    estado: Optional[str] = Query(None, description="Filtrar por estado"),
    estados: Optional[str] = Query(None, description="Múltiples estados separados por coma"),
    user: dict = Depends(get_current_user),
    db: Client = Depends(get_supabase_admin),
):
    q = db.from_(TABLE).select("*").order("created_at", desc=True)
    if estado:
        q = q.eq("estado", estado)
    elif estados:
        q = q.in_("estado", [e.strip() for e in estados.split(",")])
    resp = q.execute()
    return {"ok": True, "data": resp.data}


@router.post("/", status_code=201)
async def crear_linea(
    body: LineaCreate,
    user: dict = Depends(get_current_user),
    db: Client = Depends(get_supabase_admin),
):
    now = now_iso()
    row = body.model_dump()
    row.update(estado="pendiente", created_at=now, updated_at=now)
    resp = db.from_(TABLE).insert(row).execute()
    if not resp.data:
        raise HTTPException(status_code=400, detail="Error al crear la línea")
    return {"ok": True, "data": resp.data[0]}


@router.patch("/{id}/aprobar")
async def aprobar_linea(
    id: str,
    body: NotasBody,
    user: dict = Depends(get_current_user),
    db: Client = Depends(get_supabase_admin),
):
    resp = (
        db.from_(TABLE)
        .update({
            "estado": "aprobada",
            "supervisor_email": _get_user_email(user),
            "notas_supervisor": body.notas,
            "updated_at": now_iso(),
        })
        .eq("id", id)
        .execute()
    )
    if not resp.data:
        raise HTTPException(status_code=404, detail="Línea no encontrada")
    return {"ok": True, "data": resp.data[0]}


@router.patch("/{id}/rechazar")
async def rechazar_linea(
    id: str,
    body: NotasBody,
    user: dict = Depends(get_current_user),
    db: Client = Depends(get_supabase_admin),
):
    resp = (
        db.from_(TABLE)
        .update({
            "estado": "rechazada",
            "supervisor_email": _get_user_email(user),
            "notas_supervisor": body.notas,
            "updated_at": now_iso(),
        })
        .eq("id", id)
        .execute()
    )
    if not resp.data:
        raise HTTPException(status_code=404, detail="Línea no encontrada")
    return {"ok": True, "data": resp.data[0]}


@router.patch("/{id}/iniciar")
async def iniciar_linea(
    id: str,
    user: dict = Depends(get_current_user),
    db: Client = Depends(get_supabase_admin),
):
    now = now_iso()
    resp = (
        db.from_(TABLE)
        .update({
            "estado": "en_proceso",
            "operador_email": _get_user_email(user),
            "inicio_operador": now,
            "updated_at": now,
        })
        .eq("id", id)
        .execute()
    )
    if not resp.data:
        raise HTTPException(status_code=404, detail="Línea no encontrada")
    return {"ok": True, "data": resp.data[0]}


class FinalizarBody(BaseModel):
    inicio_iso: str


@router.patch("/{id}/finalizar")
async def finalizar_linea(
    id: str,
    body: FinalizarBody,
    user: dict = Depends(get_current_user),
    db: Client = Depends(get_supabase_admin),
):
    fin = datetime.now(timezone.utc)
    inicio = datetime.fromisoformat(body.inicio_iso.replace("Z", "+00:00"))
    duracion = round(((fin - inicio).total_seconds() / 60) * 100) / 100

    resp = (
        db.from_(TABLE)
        .update({
            "estado": "completada",
            "fin_operador": fin.isoformat(),
            "duracion_minutos": duracion,
            "updated_at": fin.isoformat(),
        })
        .eq("id", id)
        .execute()
    )
    if not resp.data:
        raise HTTPException(status_code=404, detail="Línea no encontrada")
    return {"ok": True, "duracion": duracion, "data": resp.data[0]}


@router.post("/{id}/fraccionar")
async def fraccionar_linea(
    id: str,
    body: FraccionBody,
    user: dict = Depends(get_current_user),
    db: Client = Depends(get_supabase_admin),
):
    original_resp = db.from_(TABLE).select("*").eq("id", id).single().execute()
    original = original_resp.data
    if not original:
        raise HTTPException(status_code=404, detail="Línea no encontrada")

    now = now_iso()
    base = {
        "numero_orden": original.get("numero_orden"),
        "cod_org_inv": original.get("cod_org_inv"),
        "codigo": original.get("codigo"),
        "descripcion": original.get("descripcion"),
        "subinventario_origen": original.get("subinventario_origen"),
        "localizador_origen": original.get("localizador_origen"),
        "lote": original.get("lote"),
        "responsable": original.get("responsable"),
        "inv_pe": original.get("inv_pe"),
        "estado": "aprobada",
        "supervisor_email": _get_user_email(user),
        "notas_supervisor": "Fracción de línea original",
        "linea_padre_id": id,
        "es_fraccion": True,
        "created_at": now,
        "updated_at": now,
    }

    ins_resp = db.from_(TABLE).insert([
        {**base, **body.f1.model_dump()},
        {**base, **body.f2.model_dump()},
    ]).execute()
    if not ins_resp.data:
        raise HTTPException(status_code=400, detail="Error al insertar fracciones")

    db.from_(TABLE).update({
        "estado": "rechazada",
        "notas_supervisor": f"Fraccionada en 2 líneas por {_get_user_email(user)}",
        "updated_at": now,
    }).eq("id", id).execute()

    return {"ok": True, "fracciones": ins_resp.data}
