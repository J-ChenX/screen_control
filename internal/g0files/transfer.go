package g0files

import "os"

const transferChunkSize = 256 << 10
const maxTransferWindow = 8

func transferWindow(requested int) int {
	if requested <= 1 {
		return 1
	}
	return min(requested, maxTransferWindow)
}

// 标准流和 WebSocket 保序，确认号表示已消费的累计块数。
// 窗口只释放已确认的空间，重复确认不重发正文；非法确认终止读取。
func (w *worker) advanceDownload(c command) error {
	valid := c.Ack >= 0 && c.Ack <= w.downloadSent
	if !w.downloadStarted {
		valid = valid && c.Sub == "startack" && c.Ack == 0
	} else if c.Sub != "ack" {
		valid = false
	}
	if !valid {
		w.download.Close()
		w.download = nil
		if w.downloadTemp != "" {
			os.Remove(w.downloadTemp)
			w.downloadTemp = ""
		}
		return w.json(map[string]any{"action": "download", "sub": "cancel", "id": c.ID, "message": "下载累计确认无效"})
	}
	if w.downloadStarted && c.Ack <= w.downloadAck {
		return nil
	}
	w.downloadStarted = true
	w.downloadAck = c.Ack
	for w.download != nil && w.downloadSent-w.downloadAck < int64(w.downloadWindow) {
		if err := w.sendDownloadBlock(c.ID, transferChunkSize); err != nil {
			return err
		}
	}
	return nil
}
