package logforward

import (
	"bytes"
	"strings"
	"sync"
)

// LineWriter implements io.Writer and emits complete lines (split on \n) via onLine.
type LineWriter struct {
	mu      sync.Mutex
	remnant []byte
	onLine  func(string)
}

func NewLineWriter(onLine func(string)) *LineWriter {
	return &LineWriter{onLine: onLine}
}

func (w *LineWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	data := append(w.remnant, p...)
	for {
		idx := bytes.IndexByte(data, '\n')
		if idx < 0 {
			w.remnant = data
			return len(p), nil
		}
		line := strings.TrimRight(string(data[:idx]), "\r")
		data = data[idx+1:]
		if strings.TrimSpace(line) != "" {
			w.onLine(line)
		}
	}
}

// Flush emits any trailing bytes without a newline as a final line.
func (w *LineWriter) Flush() {
	w.mu.Lock()
	defer w.mu.Unlock()

	if len(w.remnant) == 0 {
		return
	}
	line := strings.TrimSpace(string(w.remnant))
	w.remnant = nil
	if line != "" {
		w.onLine(line)
	}
}
