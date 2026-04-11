package fsutil

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// CopyDir recursively copies src to dst (files + directories). Overwrites existing files in dst.
func CopyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return os.MkdirAll(dst, 0o755)
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, info.Mode()|0o700)
		}
		if !info.Mode().IsRegular() {
			return nil // skip symlinks / devices
		}
		return copyRegular(path, target, info.Mode())
	})
}

func copyRegular(srcPath, dstPath string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(dstPath), 0o755); err != nil {
		return err
	}
	in, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dstPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer out.Close()

	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Sync()
}

// EnsureDir creates dir if missing.
func EnsureDir(dir string) error {
	if dir == "" {
		return fmt.Errorf("empty dir")
	}
	return os.MkdirAll(dir, 0o755)
}
