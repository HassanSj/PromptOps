# PromptOps (Chat-to-Infrastructure)

Monorepo: **Next.js** UI → **FastAPI** (Gemini / LangChain) → **Redis** queue → **Go** engine (Terraform + tfsec + drift checks).

## Architecture (summary)

| Phase | Component | Role |
|------|-----------|------|
| 1 | `src/` (Next.js 14+ App Router) | Chat, Terraform tab, React Flow canvas, terminal |
| 2 | `backend/` (FastAPI) | `POST /generate` → `hcl_code`, `explanation`, optional `job_id` |
| 3 | `engine/` (Go) | Terraform init/plan/apply via `terraform-exec` |
| 4 | Redis + WebSocket | Job queue `promptops:jobs`; logs `promptops:log:{job_id}`; UI connects to `ws://…/ws?job_id=` |
| 5 | tfsec + drift | Before **apply**: **tfsec**; background **drift** checks on persisted workspaces |

## Prerequisites (what you must install)

### On your machine

1. **Node.js 18+** (for Next.js)
2. **Python 3.10+** (for FastAPI)
3. **Go 1.22+** (for the engine; run `go mod tidy` in `engine/`)
4. **Terraform CLI** on `PATH` (or set `TERRAFORM_BIN` for the engine)
5. **Redis** (optional) — only if you enable **`REDIS_ENABLED=1`** in `backend/.env` and run the Go engine. For LLM-only testing, skip Redis.
6. **An LLM** (pick one — **no paid Gemini required**):
   - **Groq** (free API key): set `GROQ_API_KEY` in `backend/.env`
   - **Ollama** (local, free): install Ollama, `ollama pull llama3.2`, set `LLM_PROVIDER=ollama`
   - **Gemini**: `LLM_PROVIDER=gemini` + `GEMINI_API_KEY` (needs quota/billing if free tier is exhausted)
7. **tfsec** on `PATH` (or `TFSEC_BIN`) if you run **`apply: true`** jobs — or use **`SKIP_TFSEC=1`** only for local dev

### Optional (Phase 5 drift persistence)

- Set **`DRIFT_DATA_DIR`** on the engine (e.g. `./data/drift`) so successful **apply** jobs from the Redis worker copy the workspace and register for periodic `terraform plan -detailed-exitcode` checks.

## Environment variables

### Next.js (repo root)

Copy `.env.example` → **`.env.local`** (Next reads this automatically).

| Variable | Required | Description |
|----------|----------|-------------|
| `BACKEND_URL` | Recommended | FastAPI base URL (default `http://127.0.0.1:8000`) |
| `NEXT_PUBLIC_ENGINE_WS_URL` | Recommended | WebSocket URL for logs (default `ws://127.0.0.1:8080/ws`) |

### Backend (`backend/.env` or shell)

| Variable | Required | Description |
|----------|----------|-------------|
| `GROQ_API_KEY` / `LLM_PROVIDER` | One LLM path | See [Prerequisites](#prerequisites-what-you-must-install); Groq or Ollama common for dev |
| `GEMINI_API_KEY` | If using Gemini | When `LLM_PROVIDER=gemini` |
| `REDIS_ENABLED` | Optional | Set `1` only when using Redis + Go engine queue |
| `REDIS_URL` | If Redis on | Default `redis://127.0.0.1:6379/0` when you enable Redis |

### Engine (`engine/` — shell or `.env` via your process manager)

See also `engine/.env.example`.

| Variable | Required | Description |
|----------|----------|-------------|
| `REDIS_URL` or `REDIS_ADDR` | **Yes** | Redis for queue + drift registry |
| `TERRAFORM_BIN` | Optional | Path to `terraform` if not on PATH |
| `ENGINE_ADDR` | Optional | Listen address (default `:8080`) |
| `TFSEC_BIN` | If apply + scan | Default `tfsec` |
| `SKIP_TFSEC` | Dev only | Set `1` to skip tfsec before apply |
| `DRIFT_DATA_DIR` | Optional | Persist workspaces after apply for drift |
| `DRIFT_INTERVAL` | Optional | e.g. `30m` (default), `1h` |
| `DRIFT_DISABLED` | Optional | Set `1` to disable drift ticker |
| `ENGINE_DEBUG` | Optional | Set `1` to include temp dir hints in some responses |

## Run everything (local)

**Terminal 1 — Redis**

```bash
docker compose up -d redis
```

**Terminal 2 — Go engine**

```bash
cd engine
go mod tidy
go run ./cmd/server
```

**Terminal 3 — Python API**

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate   # Windows
pip install -r requirements.txt
# set GEMINI_API_KEY (and REDIS_URL if needed)
uvicorn app.main:app --reload --port 8000
```

**Terminal 4 — Next.js**

```bash
npm install
npm run dev
```

Open **http://localhost:3000**. Chat triggers generate + Redis job + WebSocket logs (when all services are up).

## API quick reference

- **Frontend proxy:** `POST /api/generate` → FastAPI `/generate` (forwards `enqueue_execution`).
- **Backend:** `GET /healthz`, `POST /generate`
- **Engine:** `GET /healthz`, `POST /v1/jobs`, `GET /ws?job_id=…`
- **Redis keys:** `promptops:jobs`, `promptops:log:{job_id}`, `promptops:drift:workspaces`, channel `promptops:drift:broadcast`

## Docs per package

- `backend/README.md` — FastAPI
- `engine/README.md` — Go engine, tfsec, drift, WebSocket

## GitHub and copyright

- **Private GitHub repo:** push the full monorepo; never commit `.env` files or
  API keys (see `.gitignore`).
- **Public footprint without application source:** run `npm run distribution`
  and publish only the generated `distribution/out/` bundle (legal notices +
  short readme). Keep `LICENSE`, `NOTICE`, and `COPYRIGHT` accurate.
- Details: **`docs/GITHUB_AND_COPYRIGHT.md`**.

## Production notes (short)

- Do **not** use `SKIP_TFSEC=1` in production.
- Restrict **WebSocket** `CheckOrigin` and **CORS** on the engine.
- Run Terraform in a **locked-down** environment; **apply** is destructive.
- Use **remote state** and least-privilege cloud credentials (env / OIDC), never hardcoded keys.
