package g0files

import (
	"bytes"
	"crypto/sha256"
	"os"
	"path/filepath"
	"testing"
)

func TestWindowDownloadIntegrityAndBound(t *testing.T) {
	for _, size := range []int{0, 1, transferChunkSize, transferChunkSize*19 + 7} {
		data := make([]byte, size)
		for i := range data {
			data[i] = byte(i * 17)
		}
		path := filepath.Join(t.TempDir(), "source")
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		var out, received bytes.Buffer
		w := &worker{out: &out}
		defer w.close()
		apply(t, w, command{Action: "download", Sub: "start", ID: 1, Path: path, Window: 999})
		if response := result(t, &out); response["window"] != float64(maxTransferWindow) {
			t.Fatal("窗口未限幅")
		}
		apply(t, w, command{Action: "download", Sub: "startack", ID: 1})
		var count int64
		last := false
		for !last {
			for out.Len() > 0 {
				frame, err := ReadFrame(&out)
				if err != nil {
					t.Fatal(err)
				}
				if len(frame) > transferChunkSize+12 {
					t.Fatal("分块超过上限")
				}
				count++
				received.Write(frame[12:])
				last = frame[3]&1 != 0
			}
			if w.downloadSent-w.downloadAck > maxTransferWindow {
				t.Fatal("未确认数据超过窗口")
			}
			if !last {
				apply(t, w, command{Action: "download", Sub: "ack", ID: 1, Ack: count})
			}
		}
		if sha256.Sum256(received.Bytes()) != sha256.Sum256(data) {
			t.Fatal("下载哈希不符")
		}
		apply(t, w, command{Action: "download", Sub: "ack", ID: 1, Ack: count})
		if out.Len() != 0 {
			t.Fatal("末帧后的确认污染后续操作")
		}
	}
}

func TestDownloadDuplicateAndInvalidAcknowledgements(t *testing.T) {
	p := filepath.Join(t.TempDir(), "source")
	if err := os.WriteFile(p, make([]byte, transferChunkSize*20), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	w := &worker{out: &out}
	defer w.close()
	apply(t, w, command{Action: "download", Sub: "start", ID: 1, Path: p, Window: 8})
	result(t, &out)
	apply(t, w, command{Action: "download", Sub: "startack", ID: 1})
	out.Reset()
	apply(t, w, command{Action: "download", Sub: "ack", ID: 1, Ack: 0})
	if out.Len() != 0 || w.downloadSent != 8 {
		t.Fatal("重复确认触发额外正文")
	}
	apply(t, w, command{Action: "download", Sub: "ack", ID: 1, Ack: 1})
	if w.downloadSent != 9 {
		t.Fatal("未按释放额度补充窗口")
	}
	out.Reset()
	apply(t, w, command{Action: "download", Sub: "ack", ID: 1, Ack: 10})
	if response := result(t, &out); response["sub"] != "cancel" || w.download != nil {
		t.Fatal("越界确认未关闭下载")
	}
}

func TestWindowUploadAcknowledgesWritesBeforeCommit(t *testing.T) {
	dir := t.TempDir()
	var out bytes.Buffer
	w := &worker{out: &out}
	defer w.close()
	apply(t, w, command{Action: "upload", Path: dir, Name: "target", Size: 2, RequestID: 1, Window: 8})
	if result(t, &out)["window"] != float64(8) {
		t.Fatal("未协商上传窗口")
	}
	for i := int64(1); i <= 2; i++ {
		if err := w.uploadData([]byte{'a'}); err != nil {
			t.Fatal(err)
		}
		if result(t, &out)["ack"] != float64(i) {
			t.Fatal("累计确认错误")
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "target")); !os.IsNotExist(err) {
		t.Fatal("提交前暴露文件")
	}
	apply(t, w, command{Action: "uploaddone", RequestID: 1})
	result(t, &out)
	data, err := os.ReadFile(filepath.Join(dir, "target"))
	if err != nil || string(data) != "aa" {
		t.Fatal("提交内容错误")
	}
	apply(t, w, command{Action: "upload", Path: dir, Name: "rejected", Size: transferChunkSize * 2, RequestID: 2, Window: 8})
	result(t, &out)
	if err := w.uploadData(make([]byte, transferChunkSize+2)); err != nil {
		t.Fatal(err)
	}
	if result(t, &out)["action"] != "uploaderror" || w.upload != nil {
		t.Fatal("超限块未清理")
	}
	items, _ := os.ReadDir(dir)
	if len(items) != 1 {
		t.Fatal("遗留未完成上传文件")
	}
}
