package g0files

import (
	"bytes"
	"encoding/binary"
	"io"
	"os"
	"path/filepath"
	"testing"
)

var benchmarkFrameByte byte

func BenchmarkReadFrame256KiB(b *testing.B) {
	frame := make([]byte, transferChunkSize+4)
	binary.BigEndian.PutUint32(frame[:4], transferChunkSize)
	reader := bytes.NewReader(frame)
	b.SetBytes(transferChunkSize)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		reader.Reset(frame)
		data, err := ReadFrame(reader)
		if err != nil {
			b.Fatal(err)
		}
		benchmarkFrameByte ^= data[0]
	}
}

func BenchmarkReusableFrame256KiB(b *testing.B) {
	frame := make([]byte, transferChunkSize+4)
	binary.BigEndian.PutUint32(frame[:4], transferChunkSize)
	reader := bytes.NewReader(frame)
	var reuse []byte
	b.SetBytes(transferChunkSize)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		reader.Reset(frame)
		data, err := readFrameInto(reader, reuse)
		if err != nil {
			b.Fatal(err)
		}
		reuse = data
		benchmarkFrameByte ^= data[0]
	}
}

func BenchmarkDownloadBlock(b *testing.B) {
	path := filepath.Join(b.TempDir(), "source")
	file, err := os.Create(path)
	if err != nil {
		b.Fatal(err)
	}
	if err := file.Truncate(32 << 20); err != nil {
		b.Fatal(err)
	}
	w := &worker{out: io.Discard, download: file, downloadWindow: maxTransferWindow}
	defer w.close()
	b.SetBytes(transferChunkSize)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if i%128 == 0 {
			if _, err := file.Seek(0, io.SeekStart); err != nil {
				b.Fatal(err)
			}
		}
		if err := w.sendDownloadBlock(1, transferChunkSize); err != nil {
			b.Fatal(err)
		}
	}
}
