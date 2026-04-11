package scanner

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
)

// RunTfsec executes tfsec against a Terraform working directory.
// Returns combined stdout/stderr, whether the scan passed (exit 0), and a wrapped error for execution failures (e.g. binary missing).
func RunTfsec(ctx context.Context, dir string) (output string, pass bool, err error) {
	bin := strings.TrimSpace(os.Getenv("TFSEC_BIN"))
	if bin == "" {
		bin = "tfsec"
	}

	var buf bytes.Buffer
	cmd := exec.CommandContext(ctx, bin, dir, "--no-color")
	cmd.Stdout = &buf
	cmd.Stderr = &buf

	runErr := cmd.Run()
	out := buf.String()

	if runErr == nil {
		return out, true, nil
	}

	var ee *exec.ExitError
	if errors.As(runErr, &ee) {
		// Non-zero: findings or tfsec internal error — block apply; caller shows output.
		return out, false, nil
	}
	return out, false, runErr
}
