from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from core.config import settings
from routers import auth, lineas, localizadores, plan, upload

app = FastAPI(
    title="Logística BPT — API",
    version="1.0.0",
    description="Backend FastAPI para gestión de reubicación de inventario BPT",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(lineas.router)
app.include_router(localizadores.router)
app.include_router(plan.router)
app.include_router(upload.router)


@app.get("/")
async def root():
    return {"ok": True, "service": "Logística BPT API", "version": "1.0.0"}


@app.get("/health")
async def health():
    return {"ok": True, "status": "running"}
