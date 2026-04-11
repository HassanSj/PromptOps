package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"

	"promptops/engine/pkg/drift"
	"promptops/engine/pkg/events"
	"promptops/engine/pkg/pipeline"
	"promptops/engine/pkg/rediskeys"
	"promptops/engine/pkg/sandbox"
	"promptops/engine/pkg/terraformrunner"
	"promptops/engine/pkg/worker"
)

type jobRequest struct {
	HCL   string `json:"hcl"`
	Apply bool   `json:"apply"`
}

type jobResponse struct {
	PlanOutput  string `json:"plan_output,omitempty"`
	ApplyOutput string `json:"apply_output,omitempty"`
	Error       string `json:"error,omitempty"`
	WorkDirHint string `json:"work_dir,omitempty"` // only when ENGINE_DEBUG=1
}

var wsUpgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true // dev; tighten in production
	},
}

func main() {
	addr := os.Getenv("ENGINE_ADDR")
	if addr == "" {
		addr = ":8080"
	}

	rdb, err := newRedisClient()
	if err != nil {
		log.Fatalf("redis: %v", err)
	}
	if err := rdb.Ping(context.Background()).Err(); err != nil {
		log.Fatalf("redis ping: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go worker.StartRedisWorker(ctx, rdb)
	if os.Getenv("DRIFT_DISABLED") != "1" {
		go drift.StartWorker(ctx, rdb, drift.ParseIntervalFromEnv())
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "redis": true})
	})
	mux.HandleFunc("/v1/jobs", handleJob)
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) { handleWS(w, r, rdb) })

	srv := &http.Server{
		Addr:              addr,
		Handler:           withCORS(mux),
		ReadHeaderTimeout: 15 * time.Second,
		ReadTimeout:       0,
		WriteTimeout:      0,
	}

	go func() {
		log.Printf("engine listening on %s (ws /ws?job_id=…)", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server: %v", err)
		}
	}()

	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
	<-ch
	cancel()
	shctx, shcancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer shcancel()
	_ = srv.Shutdown(shctx)
}

func newRedisClient() (*redis.Client, error) {
	if u := strings.TrimSpace(os.Getenv("REDIS_URL")); u != "" {
		opt, err := redis.ParseURL(u)
		if err != nil {
			return nil, err
		}
		return redis.NewClient(opt), nil
	}
	addr := os.Getenv("REDIS_ADDR")
	if addr == "" {
		addr = "127.0.0.1:6379"
	}
	return redis.NewClient(&redis.Options{Addr: addr}), nil
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func handleWS(w http.ResponseWriter, r *http.Request, rdb *redis.Client) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	jobID := strings.TrimSpace(r.URL.Query().Get("job_id"))
	if jobID == "" {
		http.Error(w, "missing job_id", http.StatusBadRequest)
		return
	}

	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade: %v", err)
		return
	}
	defer conn.Close()

	_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error {
		_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	pubsub := rdb.Subscribe(ctx, rediskeys.LogChannel(jobID))
	defer pubsub.Close()

	ch := pubsub.Channel()
	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-done:
			return
		case <-ctx.Done():
			return
		case <-ping.C:
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case msg, ok := <-ch:
			if !ok {
				return
			}
			_ = conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
			if err := conn.WriteMessage(websocket.TextMessage, []byte(msg.Payload)); err != nil {
				return
			}
		}
	}
}

func handleJob(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req jobRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	req.HCL = strings.TrimSpace(req.HCL)
	if req.HCL == "" {
		http.Error(w, "missing hcl", http.StatusBadRequest)
		return
	}

	ctx := r.Context()
	dir, cleanup, err := sandbox.WriteMainTF(req.HCL)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, jobResponse{Error: err.Error()})
		return
	}
	defer cleanup()

	debug := os.Getenv("ENGINE_DEBUG") == "1"

	if !req.Apply {
		out, err := terraformrunner.RunInitPlan(ctx, dir)
		resp := jobResponse{PlanOutput: out}
		if debug {
			resp.WorkDirHint = dir
		}
		if err != nil {
			resp.Error = err.Error()
			writeJSON(w, http.StatusUnprocessableEntity, resp)
			return
		}
		writeJSON(w, http.StatusOK, resp)
		return
	}

	var out strings.Builder
	lineFn := func(line string) {
		out.WriteString(line)
		out.WriteByte('\n')
	}
	pubFn := func(ev events.Event) {
		if ev.Type == "status" && strings.TrimSpace(ev.Message) != "" {
			out.WriteString(ev.Message)
			out.WriteByte('\n')
		}
	}
	runErr := pipeline.RunInitPlanThenMaybeApply(ctx, dir, true, lineFn, pubFn)
	resp := jobResponse{ApplyOutput: out.String()}
	if debug {
		resp.WorkDirHint = dir
	}
	if runErr != nil {
		resp.Error = runErr.Error()
		writeJSON(w, http.StatusUnprocessableEntity, resp)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
