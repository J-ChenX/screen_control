package g0files

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestFolderTransferRoundTrip(t *testing.T) {
	source := t.TempDir()
	target := filepath.Join(t.TempDir(), "中文 文件夹")
	os.MkdirAll(filepath.Join(source, "空目录"), 0700)
	os.WriteFile(filepath.Join(source, "文本.txt"), []byte("跨设备文件夹传输\x00"), 0600)
	f, err := packFolder(source)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(f.Name())
	f.Close()
	if err = unpackFolder(f.Name(), target); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(target, "文本.txt"))
	if err != nil || string(b) != "跨设备文件夹传输\x00" {
		t.Fatalf("内容不符: %q %v", b, err)
	}
	if s, err := os.Stat(filepath.Join(target, "空目录")); err != nil || !s.IsDir() {
		t.Fatal("空目录丢失")
	}
	if err = unpackFolder(f.Name(), target); err == nil {
		t.Fatal("不能覆盖已有目录")
	}
}

func TestFolderRejectUnsafeArchives(t *testing.T) {
	for _, h := range []*tar.Header{
		{Name: "../escape", Typeflag: tar.TypeReg}, {Name: "/absolute", Typeflag: tar.TypeReg},
		{Name: "hard", Typeflag: tar.TypeLink, Linkname: "file"}, {Name: "huge", Typeflag: tar.TypeReg, Size: (512 << 20) + 1},
	} {
		t.Run(h.Name, func(t *testing.T) {
			var b bytes.Buffer
			gz := gzip.NewWriter(&b)
			tw := tar.NewWriter(gz)
			tw.WriteHeader(h)
			tw.Close()
			gz.Close()
			dir := t.TempDir()
			archive := filepath.Join(dir, "input.tar.gz")
			os.WriteFile(archive, b.Bytes(), 0600)
			dest := filepath.Join(dir, "result")
			if err := unpackFolder(archive, dest); err == nil {
				t.Fatal("接受了危险归档")
			}
			if _, err := os.Stat(dest); !os.IsNotExist(err) {
				t.Fatal("失败后发布了目录")
			}
		})
	}
}

func TestFolderWorkerProtocol(t *testing.T) {
	dir := t.TempDir()
	os.Mkdir(filepath.Join(dir, "source"), 0700)
	os.WriteFile(filepath.Join(dir, "source", "a"), []byte("payload"), 0600)
	var output bytes.Buffer
	w := worker{out: &output}
	defer w.close()
	if err := w.downloadCommand(command{Sub: "start", Path: filepath.Join(dir, "source"), Folder: true, ID: 1}); err != nil {
		t.Fatal(err)
	}
	// 大目录准备阶段会先发送进度消息。
	ReadFrame(&output)
	response, err := ReadFrame(&output)
	if err != nil {
		t.Fatal(err)
	}
	var ack map[string]any
	json.Unmarshal(response, &ack)
	if ack["sub"] != "start" || ack["size"].(float64) <= 0 {
		t.Fatal(string(response))
	}
	archive := w.downloadTemp
	data, err := os.ReadFile(archive)
	if err != nil {
		t.Fatal(err)
	}
	w.downloadCommand(command{Sub: "stop", ID: 1})
	if _, err = os.Stat(archive); !os.IsNotExist(err) {
		t.Fatal("临时包未清理")
	}
	output.Reset()
	c := command{Path: dir, Name: "target", Size: int64(len(data)), Folder: true, RequestID: 2}
	w.startUpload(c)
	if w.upload == nil {
		t.Fatal(output.String())
	}
	w.uploadData(append([]byte{0}, data...))
	w.finishUpload(c)
	result, err := os.ReadFile(filepath.Join(dir, "target", "a"))
	if err != nil || string(result) != "payload" {
		t.Fatalf("解压未完成: %v", err)
	}
}

func TestFolderLinksAndExecutable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 创建符号链接依赖系统权限，另做实机验证")
	}
	source := t.TempDir()
	os.MkdirAll(filepath.Join(source, "node_modules", ".bin"), 0700)
	os.WriteFile(filepath.Join(source, "tool"), []byte("#!/bin/sh\n"), 0700)
	links := map[string]string{"node_modules/.bin/tool": "../../tool", "outside": "../external", "absolute": "/does/not/exist", "broken": "missing", "loop": "loop"}
	for n, dest := range links {
		if err := os.Symlink(dest, filepath.Join(source, n)); err != nil {
			t.Fatal(err)
		}
	}
	f, err := packFolder(source)
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	defer os.Remove(f.Name())
	target := filepath.Join(t.TempDir(), "target")
	if err = unpackFolder(f.Name(), target); err != nil {
		t.Fatal(err)
	}
	for n, dest := range links {
		got, err := os.Readlink(filepath.Join(target, n))
		if err != nil || got != dest {
			t.Fatalf("链接 %s 未保留：%q %v", n, got, err)
		}
	}
	st, err := os.Stat(filepath.Join(target, "tool"))
	if err != nil || st.Mode().Perm()&0100 == 0 {
		t.Fatal("执行位丢失", err)
	}
}

func TestFolderLinkCannotRedirectWrites(t *testing.T) {
	outside := t.TempDir()
	for _, reverse := range []bool{false, true} {
		headers := []*tar.Header{{Name: "link", Typeflag: tar.TypeSymlink, Linkname: outside}, {Name: "link/escape", Typeflag: tar.TypeReg, Size: 1}}
		if reverse {
			headers[0], headers[1] = headers[1], headers[0]
		}
		var b bytes.Buffer
		gz := gzip.NewWriter(&b)
		tw := tar.NewWriter(gz)
		for _, h := range headers {
			tw.WriteHeader(h)
			if h.Size > 0 {
				tw.Write([]byte("x"))
			}
		}
		tw.Close()
		gz.Close()
		dir := t.TempDir()
		archive := filepath.Join(dir, "in.tar.gz")
		os.WriteFile(archive, b.Bytes(), 0600)
		if err := unpackFolder(archive, filepath.Join(dir, "out")); err == nil {
			t.Fatal("接受了链接父路径冲突")
		}
		if _, err := os.Stat(filepath.Join(outside, "escape")); !os.IsNotExist(err) {
			t.Fatal("越界写入")
		}
	}
}

func TestFolderLargeFile(t *testing.T) {
	if testing.Short() {
		t.Skip("大文件回归")
	}
	source := t.TempDir()
	f, err := os.Create(filepath.Join(source, "large"))
	if err != nil {
		t.Fatal(err)
	}
	const size = (512 << 20) + 1
	if err = f.Truncate(size); err != nil {
		t.Fatal(err)
	}
	f.Close()
	archive, err := packFolder(source)
	if err != nil {
		t.Fatal(err)
	}
	archive.Close()
	defer os.Remove(archive.Name())
	target := filepath.Join(t.TempDir(), "out")
	if err = unpackFolder(archive.Name(), target); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(filepath.Join(target, "large"))
	if err != nil || st.Size() != size {
		t.Fatal("大文件长度不符", err)
	}
}

func TestLargeFileWorkerStartsWithoutSizeCap(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "large")
	f, err := os.Create(source)
	if err != nil {
		t.Fatal(err)
	}
	const size = (512 << 20) + 1
	if err = f.Truncate(size); err != nil {
		t.Fatal(err)
	}
	f.Close()
	var output bytes.Buffer
	w := worker{out: &output}
	defer w.close()
	if err = w.downloadCommand(command{Sub: "start", Path: source, ID: 1}); err != nil {
		t.Fatal(err)
	}
	if w.download == nil {
		t.Fatal("大文件读取仍被拒绝")
	}
	w.downloadCommand(command{Sub: "stop", ID: 1})
	output.Reset()
	if err = w.startUpload(command{Path: dir, Name: "target", Size: size, RequestID: 2}); err != nil {
		t.Fatal(err)
	}
	if w.upload == nil {
		t.Fatal("大文件上传仍被拒绝")
	}
	temp := w.upload.file.Name()
	w.abortUpload()
	if _, err = os.Stat(temp); !os.IsNotExist(err) {
		t.Fatal("上传取消后临时文件未清理")
	}
}
