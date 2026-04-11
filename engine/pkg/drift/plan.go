package drift

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
)

// PlanDetailedExitCode runs `terraform plan -detailed-exitcode` in workDir.
// Returns combined output, hasChanges (exit 2), and err for exit 1 (error) or invocation failure.
func PlanDetailedExitCode(ctx context.Context, workDir string) (output string, hasChanges bool, err error) {
	tf := terraformExecutable()
	cmd := exec.CommandContext(ctx, tf, "plan", "-input=false", "-no-color", "-detailed-exitcode")
	cmd.Dir = workDir

	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf

	runErr := cmd.Run()
	out := buf.String()
	if runErr == nil {
		return out, false, nil
	}

	var ee *exec.ExitError
	if !errors.As(runErr, &ee) {
		return out, false, runErr
	}

	code := ee.ExitCode()
	switch code {
	case 0:
		return out, false, nil
	case 2:
		return out, true, nil
	default:
		return out, false, runErr
	}
}

func terraformExecutable() string {
	if p := os.Getenv("TERRAFORM_BIN"); p != "" {
		return p
	}
	return "terraform"
}
