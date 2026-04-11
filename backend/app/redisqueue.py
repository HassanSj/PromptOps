import json
import os
import uuid

import redis

QUEUE_KEY = "promptops:jobs"

_redis: redis.Redis | None = None


def _client() -> redis.Redis:
    global _redis
    if _redis is None:
        url = os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0")
        _redis = redis.from_url(url, decode_responses=True)
    return _redis


def enqueue_terraform_job(hcl: str, *, apply: bool = False) -> str:
    """Push a job for the Go engine. Returns job_id."""
    job_id = str(uuid.uuid4())
    payload = json.dumps({"job_id": job_id, "hcl": hcl, "apply": apply})
    _client().lpush(QUEUE_KEY, payload)
    return job_id
