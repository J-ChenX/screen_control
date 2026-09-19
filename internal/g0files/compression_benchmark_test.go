package g0files

import (
	"bytes"
	"compress/gzip"
	"io"
	"math/rand"
	"testing"
)

// 隔离 CPU 压缩成本，实际磁盘与传输仍须另行测量。
func BenchmarkFolderCompression(b *testing.B) {
	binary := make([]byte, 8<<20)
	rand.New(rand.NewSource(1)).Read(binary)
	text := bytes.Repeat([]byte("{\"path\":\"src/example.ts\",\"message\":\"文件夹性能验证\",\"state\":\"ready\"}\n"), 100000)
	for name, payload := range map[string][]byte{"binary": binary, "text": text} {
		for label, level := range map[string]int{"default": gzip.DefaultCompression, "speed": gzip.BestSpeed} {
			b.Run(name+"/"+label, func(b *testing.B) {
				var compressed bytes.Buffer
				writer, _ := gzip.NewWriterLevel(&compressed, level)
				writer.Write(payload)
				writer.Close()
				b.SetBytes(int64(len(payload)))
				b.ReportAllocs()
				b.ResetTimer()
				for range b.N {
					writer, _ := gzip.NewWriterLevel(io.Discard, level)
					if _, err := writer.Write(payload); err != nil {
						b.Fatal(err)
					}
					if err := writer.Close(); err != nil {
						b.Fatal(err)
					}
				}
				b.StopTimer()
				b.ReportMetric(float64(compressed.Len())/float64(len(payload))*100, "compressed-%")
			})
		}
	}
}
