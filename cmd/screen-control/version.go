// Command screen-control is the server composition root.
package main

import "fmt"

var (
	version   = "dev"
	commit    = "unknown"
	builtAt   = "unknown"
	toolchain = "unknown"
)

func main() {
	fmt.Printf("screen-control version=%s commit=%s builtAt=%s toolchain=%s\n", version, commit, builtAt, toolchain)
}

