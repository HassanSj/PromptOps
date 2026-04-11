# PromptOps Engine (Go + terraform-exec)

Runs Terraform in an isolated temporary directory per request.

## Requirements

- [Terraform CLI](https://developer.hashicorp.com/terraform/install) on `PATH`, or set `TERRAFORM_BIN` to the full path of the `terraform` executable.
- **Redis** (Phase 4): default `127.0.0.1:6379`, or set `REDIS_URL` (e.g. `redis://127.0.0.1:6379/0`).
- **[tfsec](https://github.com/aquasecurity/tfsec)** on `PATH` for **`apply`** jobs (or set `TFSEC_BIN`). Dev bypass: `SKIP_TFSEC=1` (not for production).

## Run

```bash
cd engine
go mod tidy
go run ./cmd/server
```

Server listens on `:8080` by default (`ENGINE_ADDR` to override).

Start Redis from repo root:

```bash
docker compose up -d redis
```

## API

### `POST /v1/jobs`

Body:

```json
{
  "hcl": "terraform { ... }\nresource \"null_resource\" \"x\" {}",
  "apply": false
}
```

- `apply: false` (default): `terraform init` + `terraform plan`, returns plan text in `plan_output`.
- `apply: true`: after a successful plan, runs **tfsec** on the workspace; if it fails, returns **422** with `error` and scan output in `apply_output`. Otherwise runs `terraform apply -auto-approve` (trusted environments only).

### `GET /healthz`

Returns `{ "ok": true, "redis": true }`.

### Phase 4 — Redis queue + WebSocket logs

- **Queue**: list key `promptops:jobs` (JSON payloads: `{ "job_id", "hcl", "apply" }`).
- **Logs**: Pub/Sub channel `promptops:log:{job_id}` with JSON events:
  - `{ "type": "log", "message": "..." }`
  - `{ "type": "status", "state": "running|done|failed", "ok": true/false, ... }`

### `GET /ws?job_id=<uuid>`

WebSocket; subscribes to `promptops:log:{job_id}` and forwards each Redis message as a text frame (JSON).

## Phase 5 — Governance & drift

### tfsec before apply

For queued jobs and `POST /v1/jobs` with `"apply": true`, the engine runs `tfsec <dir> --no-color` after `terraform plan` and **before** `terraform apply`. Findings block apply; lines are streamed to Redis / WebSocket as `[tfsec] …`.

### Drift worker

- Set **`DRIFT_DATA_DIR`** (e.g. `./data/drift`) so that after a **successful apply** from the Redis worker, the workspace is copied to `DRIFT_DATA_DIR/<job_id>` and registered in Redis hash **`promptops:drift:workspaces`**.
- A background ticker (default **every 30 minutes**, override with **`DRIFT_INTERVAL`**, e.g. `30m`, `1h`) runs `terraform plan -detailed-exitcode` in each registered directory. Results are logged and published on **`promptops:drift:broadcast`** as JSON `{ "type":"drift_summary", "job_id", "has_drift", "message", "ts" }`.
- Disable the ticker with **`DRIFT_DISABLED=1`**.

Checkov can be wired similarly later (separate step from tfsec).
