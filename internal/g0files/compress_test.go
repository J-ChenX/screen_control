package g0files

import (
	"archive/tar"
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestCompressLocalNativeTool(t *testing.T) {
	if runtime.GOOS != "windows" {
		if _, err := os.Stat("/usr/bin/tar"); err != nil {
			t.Skip("系统 tar 不可用")
		}
	}
	dir := t.TempDir()
	for _, name := range []string{"中文文件.md", "-选项.txt", "a'$.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("中文内容"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := compressLocal(dir, "本地包.tar.gz", []string{"中文文件.md", "-选项.txt", "a'$.txt"}); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(filepath.Join(dir, "本地包.tar.gz"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	gz, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	defer gz.Close()
	reader := tar.NewReader(gz)
	count := 0
	for {
		_, err = reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(reader)
		if err != nil || string(data) != "中文内容" {
			t.Fatal("压缩内容不一致")
		}
		count++
	}
	if count != 3 {
		t.Fatal("多选条目缺失")
	}
	before, _ := os.ReadFile(filepath.Join(dir, "本地包.tar.gz"))
	if compressLocal(dir, "本地包.tar.gz", []string{"中文文件.md"}) == nil {
		t.Fatal("覆盖了既有压缩包")
	}
	after, _ := os.ReadFile(filepath.Join(dir, "本地包.tar.gz"))
	if string(before) != string(after) {
		t.Fatal("原文被改变")
	}
	for _, names := range [][]string{{"../越界"}, {"不存在"}, {"中文文件.md", "中文文件.md"}} {
		if compressLocal(dir, "失败.tar.gz", names) == nil {
			t.Fatal("应拒绝无效选择")
		}
	}
	if err := os.Symlink(filepath.Join(dir, "中文文件.md"), filepath.Join(dir, "链接")); err == nil {
		if compressLocal(dir, "失败.tar.gz", []string{"链接"}) == nil {
			t.Fatal("不应跟随链接")
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "失败.tar.gz")); !os.IsNotExist(err) {
		t.Fatal("失败后残留目标包")
	}
}
