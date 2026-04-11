package terraform

import (
	"context"

	"promptops/engine/pkg/sandbox"
	"promptops/engine/pkg/terraformrunner"
)

// PlanFromHCL writes Terraform code to a unique temporary directory as main.tf,
// runs terraform init and terraform plan via hashicorp/terraform-exec, and returns
// the combined plan output (stdout/stderr) as a string.
func PlanFromHCL(ctx context.Context, hcl string) (planOutput string, err error) {
	dir, cleanup, err := sandbox.WriteMainTF(hcl)
	if err != nil {
		return "", err
	}
	defer cleanup()

	return terraformrunner.RunInitPlan(ctx, dir)
}
