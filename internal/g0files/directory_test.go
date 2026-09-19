package g0files

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDirectoryPagingAndLegacyOverflowPreserveSession(t *testing.T) {
	dir := t.TempDir()
	// 长文件名以较少文件复现超过一兆的目录响应，降低跨平台测试开销。
	const count = 5000
	for i := range count {
		name := fmt.Sprintf("%06d-%s", i, strings.Repeat("a", 220))
		f, err := os.Create(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		f.Close()
	}
	var out bytes.Buffer
	w := &worker{out: &out}
	defer w.close()
	apply(t, w, command{Action: "ls", Path: dir, RequestID: 1})
	if got := result(t, &out); got["dir"] != nil || got["message"] == nil {
		t.Fatal("旧协议应返回可恢复错误")
	}
	seen := make(map[string]bool)
	for page := 0; ; page++ {
		apply(t, w, command{Action: "ls", Path: dir, RequestID: 2, Paged: true, Page: page})
		got := result(t, &out)
		items, ok := got["dir"].([]any)
		if !ok || len(items) > directoryPageSize || got["page"] != float64(page) {
			t.Fatalf("无效分页：%v", got)
		}
		for _, item := range items {
			name := item.(map[string]any)["n"].(string)
			if seen[name] {
				t.Fatal("分页项目重复")
			}
			seen[name] = true
		}
		if got["more"] != true {
			break
		}
	}
	if len(seen) != count || w.directory != nil {
		t.Fatalf("目录不完整或句柄泄漏：%d", len(seen))
	}
	apply(t, w, command{Action: "ls", Path: dir, RequestID: 2, Paged: true, Page: 1})
	if result(t, &out)["dir"] != nil {
		t.Fatal("已完成的游标被重放")
	}
}

func TestDirectoryCursorCannotCrossRequestOrPath(t *testing.T) {
	dir := t.TempDir()
	for i := range directoryPageSize + 1 {
		f, err := os.Create(filepath.Join(dir, fmt.Sprint(i)))
		if err != nil {
			t.Fatal(err)
		}
		f.Close()
	}
	for _, change := range []string{"request", "path", "page"} {
		t.Run(change, func(t *testing.T) {
			var out bytes.Buffer
			w := &worker{out: &out}
			defer w.close()
			c := command{Action: "ls", Path: dir, RequestID: 1, Paged: true}
			apply(t, w, c)
			result(t, &out)
			c.Page = 1
			switch change {
			case "request":
				c.RequestID = 2
			case "path":
				c.Path = t.TempDir()
			case "page":
				c.Page = 3
			}
			apply(t, w, c)
			if result(t, &out)["dir"] != nil || w.directory != nil {
				t.Fatal("无效游标未关闭")
			}
			apply(t, w, command{Action: "ls", Path: dir, RequestID: 3, Paged: true})
			result(t, &out)
			w.close()
			if w.directory != nil {
				t.Fatal("断开后遗留目录句柄")
			}
		})
	}
}
