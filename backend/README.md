# PromptOps Backend (FastAPI)

## Setup

1) Create and activate a virtualenv (recommended).

2) Install deps:

```bash
pip install -r requirements-app.txt
```

3) Set env vars (LLM — pick one):

- **Free (recommended if Gemini quota is 0):** `GROQ_API_KEY` from [Groq console](https://console.groq.com/) (optional `GROQ_MODEL`, default `llama-3.1-8b-instant`).
- **Free local:** install [Ollama](https://ollama.com/), run `ollama pull llama3.2`, set `LLM_PROVIDER=ollama`.
- **Gemini:** `LLM_PROVIDER=gemini`, `GEMINI_API_KEY`, optional `GEMINI_MODEL`.

Also (optional queue for Go engine):

- `REDIS_ENABLED` — set `1` only when Redis is running and you want `enqueue_execution` to push jobs.
- `REDIS_URL` — e.g. `redis://127.0.0.1:6379/0` (used only when `REDIS_ENABLED=1`).

4) Run:

```bash
uvicorn app.main:app --reload --port 8000
```

## API

- `POST /generate`
  - body: `{ "prompt": "...", "enqueue_execution": true }` (enqueue only if `REDIS_ENABLED=1`)
  - response: `{ "hcl_code": "...", "explanation": "...", "job_id": null | "..." }`

