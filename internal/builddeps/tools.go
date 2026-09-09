//go:build tools

// builddeps 包固定发布清单选定的构建期 Go 模块依赖，
// 供所属功能包尚未实现时使用。
package builddeps

import (
	_ "github.com/mattn/go-sqlite3"
	_ "tailscale.com/client/local"
)

