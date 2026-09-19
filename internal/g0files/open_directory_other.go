//go:build !windows

package g0files

import "errors"

func launchWindowsDirectory(string) error { return errors.New("此系统不是 Windows") }
