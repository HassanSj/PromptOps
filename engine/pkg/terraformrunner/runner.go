package terraformrunner

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"

	"github.com/hashicorp/terraform-exec/tfexec"
)

// RunInitPlan expects workDir to contain main.tf.
// Returns combined stdout/stderr from init and plan.
func RunInitPlan(ctx context.Context, workDir string) (planOutput string, err error) {
	return runInitAndPlan(ctx, workDir, nil)
}

// RunInitPlanApply runs init, plan, then apply -auto-approve. Returns combined logs.
func RunInitPlanApply(ctx context.Context, workDir string) (output string, err error) {
	out, err := runInitAndPlan(ctx, workDir, nil)
	if err != nil {
		return out, err
	}
	applyOut, err := runApply(ctx, workDir, nil)
	return out + applyOut, err
}

// RunInitPlanWithLog streams Terraform stdout/stderr to logSink during init+plan.
// If doApply is true, runs apply after a successful plan (no tfsec gate here — orchestrate in worker).
func RunInitPlanWithLog(ctx context.Context, workDir string, doApply bool, logSink io.Writer) (fullOutput string, err error) {
	out, err := runInitAndPlan(ctx, workDir, logSink)
	if err != nil || !doApply {
		return out, err
	}
	applyOut, err := runApply(ctx, workDir, logSink)
	return out + applyOut, err
}

// RunInitAndPlanWithLog runs terraform init + plan only.
func RunInitAndPlanWithLog(ctx context.Context, workDir string, logSink io.Writer) (string, error) {
	return runInitAndPlan(ctx, workDir, logSink)
}

// RunApplyWithLog runs terraform apply in an already-initialized directory.
func RunApplyWithLog(ctx context.Context, workDir string, logSink io.Writer) (string, error) {
	return runApply(ctx, workDir, logSink)
}

func terraformBin() string {
	if p := os.Getenv("TERRAFORM_BIN"); p != "" {
		return p
	}
	return ""
}

func runInitAndPlan(ctx context.Context, workDir string, logSink io.Writer) (string, error) {
	tf, err := tfexec.NewTerraform(workDir, terraformBin())
	if err != nil {
		return "", fmt.Errorf("new terraform: %w", err)
	}

	var buf bytes.Buffer
	out := io.Writer(&buf)
	if logSink != nil {
		out = io.MultiWriter(&buf, logSink)
	}
	tf.SetStdout(out)
	tf.SetStderr(out)

	if err := tf.Init(ctx); err != nil {
		return buf.String(), fmt.Errorf("terraform init: %w", err)
	}

	_, err = tf.Plan(ctx)
	if err != nil {
		return buf.String(), fmt.Errorf("terraform plan: %w", err)
	}
	return buf.String(), nil
}

func runApply(ctx context.Context, workDir string, logSink io.Writer) (string, error) {
	tf, err := tfexec.NewTerraform(workDir, terraformBin())
	if err != nil {
		return "", fmt.Errorf("new terraform: %w", err)
	}

	var buf bytes.Buffer
	out := io.Writer(&buf)
	if logSink != nil {
		out = io.MultiWriter(&buf, logSink)
	}
	tf.SetStdout(out)
	tf.SetStderr(out)

	if err := tf.Apply(ctx); err != nil {
		return buf.String(), fmt.Errorf("terraform apply: %w", err)
	}
	return buf.String(), nil
}
