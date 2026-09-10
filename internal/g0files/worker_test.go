package g0files

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func result(t *testing.T, b *bytes.Buffer) map[string]any {
	t.Helper()
	data, err := ReadFrame(b)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err = json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}
func apply(t *testing.T, w *worker, v any) {
	t.Helper()
	data, _ := json.Marshal(v)
	if err := w.handle(data); err != nil {
		t.Fatal(err)
	}
}
func TestNewUploadBelongsToCurrentUserAndPreservesBinary(t *testing.T) {
	dir := t.TempDir()
	var out bytes.Buffer
	w := &worker{out: &out}
	defer w.close()
	payload := make([]byte, 150000)
	for i := range payload {
		payload[i] = byte(i * 17)
	}
	apply(t, w, map[string]any{"action": "upload", "path": dir, "name": "中文文档.md", "size": len(payload), "reqid": 1})
	if result(t, &out)["action"] != "uploadstart" {
		t.Fatal("上传未开始")
	}
	for offset := 0; offset < len(payload); offset += 65536 {
		end := min(offset+65536, len(payload))
		chunk := payload[offset:end]
		if chunk[0] == 0 || chunk[0] == '{' {
			chunk = append([]byte{0}, chunk...)
		}
		if err := w.handle(chunk); err != nil {
			t.Fatal(err)
		}
		result(t, &out)
	}
	if _, err := os.Stat(filepath.Join(dir, "中文文档.md")); !os.IsNotExist(err) {
		t.Fatal("确认完成前暴露目标文件")
	}
	apply(t, w, map[string]any{"action": "uploaddone", "reqid": 1})
	if result(t, &out)["action"] != "uploaddone" {
		t.Fatal("上传未确认")
	}
	actual, err := os.ReadFile(filepath.Join(dir, "中文文档.md"))
	if err != nil || !bytes.Equal(actual, payload) {
		t.Fatal("内容或普通用户读取失败")
	}
	info, _ := os.Stat(filepath.Join(dir, "中文文档.md"))
	if info.Mode().Perm() != 0600 {
		t.Fatalf("新文件权限 %v", info.Mode())
	}
}
func TestInterruptedAndChangedDestinationPreserveExistingFile(t *testing.T) {
	for _, scenario := range []string{"disconnect", "short", "changed"} {
		t.Run(scenario, func(t *testing.T) {
			dir := t.TempDir()
			dest := filepath.Join(dir, "原文.md")
			os.WriteFile(dest, []byte("原始内容"), 0640)
			var out bytes.Buffer
			w := &worker{out: &out}
			defer w.close()
			apply(t, w, map[string]any{"action": "upload", "path": dir, "name": "原文.md", "size": 4, "reqid": 1})
			result(t, &out)
			if err := w.handle([]byte("new")); err != nil {
				t.Fatal(err)
			}
			result(t, &out)
			expected := []byte("原始内容")
			if scenario == "changed" {
				expected = []byte("外部新内容")
				os.WriteFile(dest, expected, 0640)
				w.handle([]byte("!"))
				result(t, &out)
			}
			if scenario == "disconnect" {
				w.close()
			} else {
				apply(t, w, map[string]any{"action": "uploaddone", "reqid": 1})
				if result(t, &out)["action"] != "uploaderror" {
					t.Fatal("未拒绝未完成/变化的目标")
				}
			}
			got, _ := os.ReadFile(dest)
			if !bytes.Equal(got, expected) {
				t.Fatal("原文件被损坏")
			}
			entries, _ := os.ReadDir(dir)
			if len(entries) != 1 {
				t.Fatal("临时文件未清理")
			}
		})
	}
}
func TestOverwritePreservesModeAndRejectsReadonlyOrSymlink(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "file.md")
	os.WriteFile(dest, []byte("old"), 0640)
	var out bytes.Buffer
	w := &worker{out: &out}
	defer w.close()
	apply(t, w, map[string]any{"action": "upload", "path": dir, "name": "file.md", "size": 0, "reqid": 1})
	result(t, &out)
	apply(t, w, map[string]any{"action": "uploaddone", "reqid": 1})
	if result(t, &out)["action"] != "uploaddone" {
		t.Fatal("空文件覆盖失败")
	}
	info, _ := os.Stat(dest)
	if info.Mode().Perm() != 0640 || info.Size() != 0 {
		t.Fatal("覆盖未保留权限")
	}
	os.Chmod(dest, 0400)
	if os.Geteuid() != 0 {
		apply(t, w, map[string]any{"action": "upload", "path": dir, "name": "file.md", "size": 1, "reqid": 2})
		if result(t, &out)["action"] != "uploaderror" {
			t.Fatal("绕过只读权限")
		}
	}
	if err := os.Symlink(dest, filepath.Join(dir, "link")); err == nil {
		apply(t, w, map[string]any{"action": "upload", "path": dir, "name": "link", "size": 1, "reqid": 3})
		if result(t, &out)["action"] != "uploaderror" {
			t.Fatal("接受了链接覆盖")
		}
	}
}
func TestDownloadAndCommandBoundary(t *testing.T) {
	dir := t.TempDir()
	data := bytes.Repeat([]byte{0, 123, 255, 1, 2, 3}, 6000)
	name := filepath.Join(dir, "下载.bin")
	os.WriteFile(name, data, 0600)
	var out bytes.Buffer
	w := &worker{out: &out}
	defer w.close()
	apply(t, w, map[string]any{"action": "download", "sub": "start", "path": name, "id": 7})
	if result(t, &out)["sub"] != "start" {
		t.Fatal("下载未开始")
	}
	var got []byte
	for {
		apply(t, w, map[string]any{"action": "download", "sub": "ack", "id": 7})
		packet, err := ReadFrame(&out)
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, packet[4:]...)
		if packet[3] == 1 {
			break
		}
	}
	if !bytes.Equal(got, data) {
		t.Fatal("下载内容改变")
	}
	for _, cmd := range []map[string]any{{"action": "exec", "path": dir}, {"action": "rm", "path": dir, "delfiles": []string{".."}, "rec": true}, {"action": "rename", "path": dir, "oldname": "../x", "newname": "y"}} {
		apply(t, w, cmd)
		if result(t, &out)["action"] != "error" {
			t.Fatal("越界命令未拒绝")
		}
	}
}
func TestFramingAndDisconnect(t *testing.T) {
	var stream bytes.Buffer
	if err := WriteFrame(&stream, []byte("abc")); err != nil {
		t.Fatal(err)
	}
	got, err := ReadFrame(&stream)
	if err != nil || string(got) != "abc" {
		t.Fatal("帧损坏")
	}
	if _, err := ReadFrame(bytes.NewReader([]byte{255, 255, 255, 255})); err == nil {
		t.Fatal("未限制帧大小")
	}
	if err := Run(bytes.NewReader(nil), io.Discard); err != nil {
		t.Fatal(err)
	}
}
