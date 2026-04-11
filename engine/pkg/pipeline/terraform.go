package pipeline

import (
	"context"
	"fmt"
	"os"
	"strings"

	"promptops/engine/pkg/events"
	"promptops/engine/pkg/logforward"
	"promptops/engine/pkg/scanner"
	"promptops/engine/pkg/terraformrunner"
)

// Publish sends an engine event (e.g. to Redis).
type Publish func(events.Event)

// RunInitPlanThenMaybeApply runs init+plan, optionally tfsec+apply.
// publishLine emits type=log; publish emits full events for status.
func RunInitPlanThenMaybeApply(
	ctx context.Context,
	dir string,
	apply bool,
	publishLine func(string),
	publish Publish,
) error {
	lw := logforward.NewLineWriter(func(line string) {
		publishLine(line)
	})
	defer lw.Flush()

	if _, err := terraformrunner.RunInitAndPlanWithLog(ctx, dir, lw); err != nil {
		return err
	}
	lw.Flush()

	if !apply {
		return nil
	}

	skipTfsec := strings.TrimSpace(os.Getenv("SKIP_TFSEC")) == "1"
	if !skipTfsec {
		publish(events.Event{Type: "status", State: "running", Message: "Running tfsec security scan…"})
		out, pass, err := scanner.RunTfsec(ctx, dir)
		for _, line := range strings.Split(out, "\n") {
			line = strings.TrimSpace(line)
			if line != "" {
				publishLine("[tfsec] " + line)
			}
		}
		if err != nil {
			return fmt.Errorf("tfsec: %w (install tfsec or set SKIP_TFSEC=1)", err)
		}
		if !pass {
			return fmt.Errorf("tfsec reported findings; fix issues or set SKIP_TFSEC=1 to bypass (not recommended)")
		}
	}

	if _, err := terraformrunner.RunApplyWithLog(ctx, dir, lw); err != nil {
		return err
	}
	lw.Flush()
	return nil
}
