package g0files

import (
	"errors"
	"io"
	"os"
	"runtime"
)

const directoryPageSize = 256

// 每个会话至多持有一个目录句柄；按页读取避免大目录占满协议帧或堆内存。
// 游标只在该连接、路径与请求内有效，不支持断线重放。
type directoryListing struct {
	file      *os.File
	path      string
	requestID int64
	page      int
}

func (w *worker) closeDirectory() {
	if w.directory != nil {
		w.directory.file.Close()
		w.directory = nil
	}
}

func (w *worker) directoryFailure(c command, err error) error {
	w.closeDirectory()
	return w.json(map[string]any{"path": c.Path, "reqid": c.RequestID, "dir": nil, "message": err.Error()})
}

func (w *worker) listPage(c command) error {
	if c.Page < 0 {
		return w.directoryFailure(c, errors.New("目录分页游标无效"))
	}
	if c.Page == 0 {
		w.closeDirectory()
		// 卷根数量有界，沿用单帧响应供新旧门户共同读取。
		if runtime.GOOS == "windows" && c.Path == "" {
			c.Paged = false
			return w.list(c)
		}
		p, err := nativePath(c.Path)
		if err != nil {
			return w.directoryFailure(c, err)
		}
		f, err := openDirectoryStream(p)
		if err != nil {
			return w.directoryFailure(c, err)
		}
		w.directory = &directoryListing{file: f, path: c.Path, requestID: c.RequestID}
	}
	listing := w.directory
	if listing == nil || listing.path != c.Path || listing.requestID != c.RequestID || listing.page != c.Page {
		return w.directoryFailure(c, errors.New("目录分页已失效，请重新打开目录"))
	}
	items, err := listing.file.ReadDir(directoryPageSize)
	if err != nil && !errors.Is(err, io.EOF) {
		return w.directoryFailure(c, err)
	}
	entries := make([]map[string]any, 0, len(items))
	for _, entry := range items {
		info, err := entry.Info()
		if err != nil {
			continue
		}
		kind := 3
		if info.IsDir() {
			kind = 2
		}
		entries = append(entries, map[string]any{"n": entry.Name(), "t": kind, "s": info.Size(), "d": info.ModTime().Unix()})
	}
	more := len(items) == directoryPageSize && err == nil
	listing.page++
	if !more {
		w.closeDirectory()
	}
	return w.json(map[string]any{"path": c.Path, "reqid": c.RequestID, "dir": entries, "page": c.Page, "more": more, "folderTransfer": true})
}

// 使用目录句柄打开，避免误传命名管道等特殊文件路径时阻塞。
func openDirectoryStream(p string) (*os.File, error) {
	root, err := os.OpenRoot(p)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	return root.Open(".")
}
