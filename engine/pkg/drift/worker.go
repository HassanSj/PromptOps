package drift

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"promptops/engine/pkg/rediskeys"
)

// BroadcastEvent is published on DriftBroadcastChannel for ops / future UI.
type BroadcastEvent struct {
	Type      string `json:"type"` // "drift_summary"
	JobID     string `json:"job_id"`
	HasDrift  bool   `json:"has_drift"`
	Message   string `json:"message"`
	Timestamp int64  `json:"ts"`
}

// StartWorker runs a drift check on all registered workspaces every interval.
func StartWorker(ctx context.Context, rdb *redis.Client, interval time.Duration) {
	if interval <= 0 {
		interval = 30 * time.Minute
	}

	t := time.NewTicker(interval)
	defer t.Stop()

	log.Printf("drift worker: interval %v", interval)

	run := func() {
		ws, err := rdb.HGetAll(ctx, rediskeys.DriftWorkspacesHash).Result()
		if err != nil {
			log.Printf("drift: HGetAll: %v", err)
			return
		}
		if len(ws) == 0 {
			return
		}

		for jobID, path := range ws {
			if path == "" {
				continue
			}
			if _, statErr := os.Stat(path); statErr != nil {
				log.Printf("drift: workspace missing for job %s: %v", jobID, statErr)
				continue
			}

			checkCtx, cancel := context.WithTimeout(ctx, 15*time.Minute)
			out, hasDrift, err := PlanDetailedExitCode(checkCtx, path)
			cancel()

			msg := "no changes"
			if err != nil {
				msg = "plan error: " + err.Error()
				log.Printf("drift: job %s: %s\n%s", jobID, msg, out)
			} else if hasDrift {
				msg = "changes detected (drift or pending updates)"
				log.Printf("drift: job %s: %s", jobID, msg)
			} else {
				log.Printf("drift: job %s: ok (no changes)", jobID)
			}

			ev := BroadcastEvent{
				Type:      "drift_summary",
				JobID:     jobID,
				HasDrift:  hasDrift,
				Message:   msg,
				Timestamp: time.Now().Unix(),
			}
			b, _ := json.Marshal(ev)
			_ = rdb.Publish(ctx, rediskeys.DriftBroadcastChannel, b).Err()
		}
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			run()
		}
	}
}

// ParseIntervalFromEnv reads DRIFT_INTERVAL (e.g. "30m", "1h"). Empty defaults to 30m.
func ParseIntervalFromEnv() time.Duration {
	s := strings.TrimSpace(os.Getenv("DRIFT_INTERVAL"))
	if s == "" {
		return 30 * time.Minute
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		log.Printf("drift: bad DRIFT_INTERVAL %q, using 30m", s)
		return 30 * time.Minute
	}
	if d < time.Minute {
		return time.Minute
	}
	return d
}
