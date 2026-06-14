#!/usr/bin/env bash
# Inicia el servidor de desarrollo FastAPI
# Uso: ./start.sh [--port 8000] [--reload]
export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")"
.venv/bin/uvicorn main:app --reload --host 0.0.0.0 --port "${PORT:-8000}"
