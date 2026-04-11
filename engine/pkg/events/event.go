package events

import "encoding/json"

// Event is published on Redis Pub/Sub for each log line and final status.
type Event struct {
	Type    string `json:"type"` // "log" | "status"
	Message string `json:"message,omitempty"`
	State   string `json:"state,omitempty"` // "running" | "done" | "failed"
	OK      bool   `json:"ok,omitempty"`
	Error   string `json:"error,omitempty"`
}

func Marshal(e Event) ([]byte, error) {
	return json.Marshal(e)
}
