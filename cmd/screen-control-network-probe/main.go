// 一次性只读探针通过标准流接收登记节点，不监听端口、不运行外部命令。
package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"time"

	"screencontrol.local/screen-control/internal/g0network"
)

func main() {
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 4097))
	decoder.DisallowUnknownFields()
	var request g0network.Request
	if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF || request.Validate() != nil {
		os.Exit(1)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 9*time.Second)
	defer cancel()
	out, err := g0network.Probe(ctx, request)
	if err != nil {
		os.Exit(1)
	}
	if json.NewEncoder(os.Stdout).Encode(out) != nil {
		os.Exit(1)
	}
}
