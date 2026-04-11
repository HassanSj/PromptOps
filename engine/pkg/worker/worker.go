package worker

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"promptops/engine/pkg/events"
	"promptops/engine/pkg/fsutil"
	"promptops/engine/pkg/pipeline"
	"promptops/engine/pkg/rediskeys"
	"promptops/engine/pkg/sandbox"
)

// QueuedJob is JSON pushed by the Python service (LPUSH).
type QueuedJob struct {
	JobID string `json:"job_id"`
	HCL   string `json:"hcl"`
	Apply bool   `json:"apply"`
}

// StartRedisWorker blocks on BRPOP and executes Terraform jobs until ctx is cancelled.
func StartRedisWorker(ctx context.Context, rdb *redis.Client) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		res, err := rdb.BRPop(ctx, 30*time.Second, rediskeys.JobsQueue).Result()
		if err == redis.Nil {
			continue
		}
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("worker: BRPop: %v", err)
			time.Sleep(time.Second)
			continue
		}
		if len(res) < 2 {
			continue
		}
		payload := res[1]

		var job QueuedJob
		if err := json.Unmarshal([]byte(payload), &job); err != nil {
			log.Printf("worker: bad job json: %v", err)
			continue
		}
		if job.JobID == "" || job.HCL == "" {
			log.Printf("worker: missing job_id or hcl")
			continue
		}

		jobCtx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		runJob(jobCtx, rdb, job)
		cancel()
	}
}

func runJob(ctx context.Context, rdb *redis.Client, job QueuedJob) {
	ch := rediskeys.LogChannel(job.JobID)
	publish := func(ev events.Event) {
		b, err := events.Marshal(ev)
		if err != nil {
			return
		}
		_ = rdb.Publish(ctx, ch, b).Err()
	}

	publish(events.Event{Type: "status", State: "running", Message: "Starting Terraform…"})

	dir, cleanup, err := sandbox.WriteMainTF(job.HCL)
	if err != nil {
		publish(events.Event{Type: "status", State: "failed", OK: false, Error: err.Error()})
		return
	}
	defer cleanup()

	publishLine := func(line string) {
		publish(events.Event{Type: "log", Message: line})
	}

	err = pipeline.RunInitPlanThenMaybeApply(ctx, dir, job.Apply, publishLine, publish)
	if err != nil {
		publish(events.Event{
			Type:    "status",
			State:   "failed",
			OK:      false,
			Error:   err.Error(),
			Message: err.Error(),
		})
		return
	}

	if job.Apply {
		if root := strings.TrimSpace(os.Getenv("DRIFT_DATA_DIR")); root != "" {
			dest := filepath.Join(root, job.JobID)
			if mkErr := fsutil.EnsureDir(root); mkErr != nil {
				log.Printf("drift: mkdir: %v", mkErr)
			} else {
				_ = os.RemoveAll(dest)
				if cpErr := fsutil.CopyDir(dir, dest); cpErr != nil {
					log.Printf("drift: copy workspace: %v", cpErr)
					publishLine("[drift] failed to persist workspace: " + cpErr.Error())
				} else {
					_ = rdb.HSet(ctx, rediskeys.DriftWorkspacesHash, job.JobID, dest).Err()
					publishLine("[drift] registered workspace for periodic drift checks: " + dest)
				}
			}
		}
	}

	publish(events.Event{Type: "status", State: "done", OK: true, Message: "Terraform finished successfully."})
}
