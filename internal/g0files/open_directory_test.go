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
	got, err := directoryToOpen(directory)
	if err != nil {
		t.Fatal(err)
	}
	// Windows 可能规范化临时目录的大小写；核对实际目录身份。
	wantInfo, err := os.Stat(directory)
	if err != nil {
		t.Fatal(err)
	}
	gotInfo, err := os.Stat(got)
	if err != nil || !os.SameFile(wantInfo, gotInfo) {
		t.Fatalf("合法目录身份改变: %q %v", got, err)
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
