package rediskeys

const (
	// JobsQueue is a Redis LIST: LPUSH by producers, BRPOP by the engine worker.
	JobsQueue = "promptops:jobs"
	// LogChannelPrefix + jobID = PUB/SUB channel for streaming logs to WebSocket clients.
	LogChannelPrefix = "promptops:log:"
	// DriftWorkspacesHash maps job_id -> absolute path to a persisted Terraform working directory.
	DriftWorkspacesHash = "promptops:drift:workspaces"
	// DriftBroadcastChannel receives drift scan summaries (optional UI / ops).
	DriftBroadcastChannel = "promptops:drift:broadcast"
)

func LogChannel(jobID string) string {
	return LogChannelPrefix + jobID
}
