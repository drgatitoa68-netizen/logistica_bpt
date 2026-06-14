from typing import Optional
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from supabase import Client
from core.supabase import get_supabase_admin
from core.deps import get_current_user

router = APIRouter(prefix="/localizadores", tags=["localizadores"])
TABLE = "localizadores"


class LocalizadorUpsert(BaseModel):
    zona: str
    localizador: str
    formato: Optional[str] = "Mezcla"
    capacidad: int = 0
    ocupado: int = 0
    disponible: int = 0
    pct_ocupacion: float = 0.0
    activo: bool = True


class BulkUpsertBody(BaseModel):
    records: list[LocalizadorUpsert]


@router.get("/")
async def list_localizadores(
    zona: Optional[str] = Query(None),
    activo: Optional[bool] = Query(None),
    user: dict = Depends(get_current_user),
    db: Client = Depends(get_supabase_admin),
):
    q = (
        db.from_(TABLE)
        .select("zona,localizador,formato,pct_ocupacion,capacidad,ocupado,disponible,activo")
        .order("zona")
        .order("localizador")
    )
    if zona:
        q = q.eq("zona", zona)
    if activo is not None:
        q = q.eq("activo", activo)
    resp = q.execute()
    return {"ok": True, "data": resp.data}


@router.post("/upsert")
async def upsert_localizadores(
    body: BulkUpsertBody,
    user: dict = Depends(get_current_user),
    db: Client = Depends(get_supabase_admin),
):
    records = [r.model_dump() for r in body.records]
    BATCH = 200
    total = 0
    for i in range(0, len(records), BATCH):
        batch = records[i : i + BATCH]
        db.from_(TABLE).upsert(batch, on_conflict="zona,localizador").execute()
        total += len(batch)
    return {"ok": True, "upserted": total}
