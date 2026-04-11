import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .llm import build_generator
from .redisqueue import enqueue_terraform_job
from .schemas import GenerateRequest, GenerateResponse, TerraformAIResult

# Load env from CWD first, then from backend/.env (so it works no matter where uvicorn is started).
load_dotenv()
load_dotenv(dotenv_path=Path(__file__).resolve().parents[1] / ".env")

app = FastAPI(title="PromptOps AI Service", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/healthz")
def healthz():
    return {"ok": True}


def _redis_enqueue_enabled() -> bool:
    """Off by default so local / zero-cost testing works without Redis."""
    return os.getenv("REDIS_ENABLED", "false").strip().lower() in ("1", "true", "yes")


@app.post("/generate", response_model=GenerateResponse)
def generate(req: GenerateRequest) -> GenerateResponse:
    try:
        invoke = build_generator()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(e)) from e

    try:
        result: TerraformAIResult = invoke(req.prompt)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"LLM generation failed: {e}") from e

    job_id = None
    if req.enqueue_execution and _redis_enqueue_enabled():
        try:
            job_id = enqueue_terraform_job(result.hcl_code, apply=False)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(
                status_code=503,
                detail=f"Failed to enqueue job in Redis (is Redis running?): {e}",
            ) from e

    return GenerateResponse(**result.model_dump(), job_id=job_id)

