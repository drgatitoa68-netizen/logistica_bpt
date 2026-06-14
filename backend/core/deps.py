from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from supabase import Client
from .supabase import get_supabase

security = HTTPBearer()


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Client = Depends(get_supabase),
) -> dict:
    """Validate the Supabase JWT and return the authenticated user."""
    token = credentials.credentials
    try:
        response = db.auth.get_user(token)
        user = response.user
        if user is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token inválido")
        return {"id": user.id, "email": user.email}
    except Exception:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No autenticado")


async def get_authed_client(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> Client:
    """Return a Supabase client with the user's JWT set (respects RLS)."""
    from .supabase import get_supabase_admin
    client = get_supabase_admin()
    client.auth.set_session(credentials.credentials, "")
    return client
