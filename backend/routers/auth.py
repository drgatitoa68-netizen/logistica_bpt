from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, EmailStr
from supabase import Client
from core.supabase import get_supabase

router = APIRouter(prefix="/auth", tags=["auth"])
security = HTTPBearer()


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class LoginResponse(BaseModel):
    access_token: str
    refresh_token: str
    user: dict


@router.post("/login", response_model=LoginResponse)
async def login(body: LoginRequest, db: Client = Depends(get_supabase)):
    try:
        resp = db.auth.sign_in_with_password({"email": body.email, "password": body.password})
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(e))

    if resp.user is None or resp.session is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Credenciales incorrectas")

    return LoginResponse(
        access_token=resp.session.access_token,
        refresh_token=resp.session.refresh_token,
        user={"id": resp.user.id, "email": resp.user.email},
    )


@router.post("/logout")
async def logout(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Client = Depends(get_supabase),
):
    try:
        db.auth.sign_out()
    except Exception:
        pass
    return {"ok": True}


@router.get("/me")
async def me(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Client = Depends(get_supabase),
):
    try:
        resp = db.auth.get_user(credentials.credentials)
        user = resp.user
        if user is None:
            raise HTTPException(status_code=401, detail="No autenticado")
        return {"id": user.id, "email": user.email}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Token inválido")
