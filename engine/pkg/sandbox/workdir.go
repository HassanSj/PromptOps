package sandbox

import (
	"os"
	"path/filepath"
)

// WriteMainTF creates a unique temp directory and writes main.tf with the given HCL.
// cleanup removes the directory; callers should defer cleanup() after use.
func WriteMainTF(hcl string) (dir string, cleanup func(), err error) {
	dir, err = os.MkdirTemp("", "promptops-tf-*")
	if err != nil {
		return "", nil, err
	}
	cleanup = func() { _ = os.RemoveAll(dir) }

	path := filepath.Join(dir, "main.tf")
	if err = os.WriteFile(path, []byte(hcl), 0o600); err != nil {
		cleanup()
		return "", nil, err
	}
	return dir, cleanup, nil
}
