"""
N.E.X.U.S mem0-api — Phase 3b.

Wraps Mem0 with scoped add/search. LLM: OpenAI-compatible endpoint (vLLM
gemma). Embedder: HuggingFace local sentence-transformers. Vector store:
pgvector in the Nexus Postgres instance.
"""

from __future__ import annotations

import os
from typing import Any, Literal, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

# Mem0 import is lazy — on cold start this triggers HF model download
# (~90MB for all-MiniLM-L6-v2). Guard with try/except so /health stays up.
_memory: Optional[Any] = None
_init_error: Optional[str] = None


def _pg_dsn_parts() -> dict[str, Any]:
    url = os.environ["POSTGRES_URL"]
    # Parse "postgresql://user:pass@host:port/db" without extra deps.
    from urllib.parse import urlparse

    u = urlparse(url)
    return {
        "dbname": u.path.lstrip("/"),
        "user": u.username,
        "password": u.password,
        "host": u.hostname,
        "port": u.port or 5432,
    }


def _build_memory() -> Any:
    from mem0 import Memory  # type: ignore

    pg = _pg_dsn_parts()
    config = {
        "llm": {
            "provider": os.environ.get("MEM0_LLM_PROVIDER", "openai"),
            "config": {
                "model": os.environ["MEM0_LLM_MODEL"],
                "api_key": os.environ.get("MEM0_LLM_API_KEY", "dummy"),
                "openai_base_url": os.environ.get("MEM0_LLM_BASE_URL"),
                # vLLM rejects top_p=0.0; keep >0. temperature=0 stays
                # deterministic-ish on greedy decoder.
                "temperature": 0.0,
                "top_p": 1.0,
            },
        },
        "embedder": {
            "provider": os.environ.get("MEM0_EMBEDDER_PROVIDER", "huggingface"),
            "config": {
                "model": os.environ.get(
                    "MEM0_EMBEDDER_MODEL",
                    "sentence-transformers/all-MiniLM-L6-v2",
                ),
            },
        },
        "vector_store": {
            "provider": "pgvector",
            "config": {
                **pg,
                "collection_name": "nexus_memories",
                "embedding_model_dims": int(
                    os.environ.get("MEM0_EMBEDDING_DIMS", "384")
                ),
            },
        },
        "version": "v1.1",
    }
    return Memory.from_config(config)


def _get_memory() -> Any:
    global _memory, _init_error
    if _memory is not None:
        return _memory
    if _init_error is not None:
        raise HTTPException(status_code=503, detail=f"mem0 not ready: {_init_error}")
    try:
        _memory = _build_memory()
        return _memory
    except Exception as e:  # noqa: BLE001
        _init_error = repr(e)
        raise HTTPException(status_code=503, detail=f"mem0 init failed: {e!r}") from e


app = FastAPI(
    title="N.E.X.U.S mem0-api",
    version="0.3.0",
    description="Scoped memory service backed by Mem0 + Postgres/pgvector",
)


# ---- Schemas ----

class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    version: str
    mem0_ready: bool
    init_error: Optional[str] = None
    llm_model: Optional[str] = None
    embedder_model: Optional[str] = None


class Message(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str


class AddMemoryRequest(BaseModel):
    messages: list[Message] = Field(..., description="OpenAI-style chat messages")
    user_id: str = Field(..., description="Namespaced id (e.g. user uuid)")
    agent_id: Optional[str] = Field(None, description="Agent slug (claude, hermes)")
    run_id: Optional[str] = Field(None, description="Room/DM scope id")
    metadata: dict[str, Any] = Field(default_factory=dict)


class SearchMemoryRequest(BaseModel):
    query: str
    user_id: Optional[str] = None
    agent_id: Optional[str] = None
    run_id: Optional[str] = None
    filters: dict[str, Any] = Field(default_factory=dict)
    limit: int = 10


# ---- Endpoints ----

@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok" if _init_error is None else "degraded",
        version=app.version,
        mem0_ready=_memory is not None,
        init_error=_init_error,
        llm_model=os.environ.get("MEM0_LLM_MODEL"),
        embedder_model=os.environ.get("MEM0_EMBEDDER_MODEL"),
    )


@app.post("/memories")
def add_memory(req: AddMemoryRequest) -> dict[str, Any]:
    mem = _get_memory()
    try:
        result = mem.add(
            messages=[{"role": m.role, "content": m.content} for m in req.messages],
            user_id=req.user_id,
            agent_id=req.agent_id,
            run_id=req.run_id,
            metadata=req.metadata or None,
        )
        return {"ok": True, "result": result}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"mem0.add failed: {e!r}") from e


@app.post("/memories/search")
def search_memory(req: SearchMemoryRequest) -> dict[str, Any]:
    mem = _get_memory()
    # Mem0 2.x requires scope via `filters` dict instead of top-level kwargs.
    filters: dict[str, Any] = dict(req.filters or {})
    if req.user_id:
        filters["user_id"] = req.user_id
    if req.agent_id:
        filters["agent_id"] = req.agent_id
    if req.run_id:
        filters["run_id"] = req.run_id
    try:
        # Mem0 2.x: top_k (not limit), scoping via filters only.
        results = mem.search(
            query=req.query,
            top_k=req.limit,
            filters=filters or None,
        )
        return {"ok": True, "results": results}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"mem0.search failed: {e!r}") from e


@app.post("/admin/init")
def admin_init() -> dict[str, Any]:
    """Force init (useful to pre-download HF model at first boot)."""
    _get_memory()
    return {"ok": True, "ready": True}


@app.get("/")
def root() -> dict[str, str]:
    return {"service": "nexus-mem0-api", "docs": "/docs"}
