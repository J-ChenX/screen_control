//go:build tools

// Package builddeps pins build-time Go module dependencies that are selected
// by the release manifest before their owning packages are implemented.
package builddeps

import (
	_ "github.com/mattn/go-sqlite3"
	_ "tailscale.com/client/local"
)

