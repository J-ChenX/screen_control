package g0files

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDirectoryToOpen(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "目录 ; & 空格")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	if got, err := directoryToOpen(directory); err != nil || got != directory {
		t.Fatalf("合法目录未保持原样: %q %v", got, err)
	}
	file := filepath.Join(root, "文件.txt")
	if err := os.WriteFile(file, []byte("测试"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{file, filepath.Join(root, "不存在"), "https://example.invalid/", "\x00"} {
		if _, err := directoryToOpen(path); err == nil {
			t.Fatalf("不应接受 %q", path)
		}
	}
}
