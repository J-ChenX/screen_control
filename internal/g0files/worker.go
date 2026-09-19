// g0files 提供普通用户运行的 G0 文件协议，不接受任意命令、不修改文件属主。
package g0files

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// 压缩菜单保留独立的资源预算；文件传输本身没有固定大小上限。
const MaxCompressSize = 512 << 20
const MaxFrameSize = 1 << 20

// ReadFrame/WriteFrame 用于 SSH 标准流；文件字节不会经过文本编码。
func ReadFrame(r io.Reader) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}
	size := binary.BigEndian.Uint32(header[:])
	if size == 0 || size > MaxFrameSize {
		return nil, errors.New("文件协议帧大小无效")
	}
	data := make([]byte, size)
	_, err := io.ReadFull(r, data)
	return data, err
}
func WriteFrame(w io.Writer, data []byte) error {
	if len(data) == 0 || len(data) > MaxFrameSize {
		return errors.New("文件协议帧大小无效")
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(data)))
	if n, err := w.Write(header[:]); err != nil {
		return err
	} else if n != len(header) {
		return io.ErrShortWrite
	}
	n, err := w.Write(data)
	if err == nil && n != len(data) {
		return io.ErrShortWrite
	}
	return err
}

type command struct {
	Window      int      `json:"window"`
	Ack         int64    `json:"ack"`
	Paged       bool     `json:"paged"`
	Page        int      `json:"page"`
	Folder      bool     `json:"folder"`
	Names       []string `json:"names"`
	Action      string   `json:"action"`
	Sub         string   `json:"sub"`
	Path        string   `json:"path"`
	Name        string   `json:"name"`
	OldName     string   `json:"oldname"`
	NewName     string   `json:"newname"`
	DeleteFiles []string `json:"delfiles"`
	Size        int64    `json:"size"`
	RequestID   int64    `json:"reqid"`
	ID          int64    `json:"id"`
	Recursive   bool     `json:"rec"`
	Control     string   `json:"ctrlChannel"`
	Type        string   `json:"type"`
}
type upload struct {
	window             int
	chunks             int64
	folder             bool
	file               *os.File
	destination        string
	previous           os.FileInfo
	size, received, id int64
}
type worker struct {
	downloadWindow  int
	downloadSent    int64
	downloadAck     int64
	downloadStarted bool
	directory       *directoryListing
	out             io.Writer
	upload          *upload
	download        *os.File
	downloadID      int64
	downloadTemp    string
}

func (w *worker) json(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return WriteFrame(w.out, data)
}
func (w *worker) abortUpload() {
	if w.upload != nil {
		w.upload.file.Close()
		os.Remove(w.upload.file.Name())
		w.upload = nil
	}
}
func (w *worker) close() {
	w.closeDirectory()
	w.abortUpload()
	if w.download != nil {
		w.download.Close()
		if w.downloadTemp != "" {
			os.Remove(w.downloadTemp)
			w.downloadTemp = ""
		}
		w.download = nil
	}
}
func validName(s string) bool {
	return s != "" && s != "." && s != ".." && !strings.ContainsAny(s, "/\\\x00")
}
func nativePath(s string) (string, error) {
	if strings.ContainsRune(s, 0) {
		return "", errors.New("目录无效")
	}
	if runtime.GOOS == "windows" {
		s = filepath.FromSlash(s)
		if !filepath.IsAbs(s) {
			return "", errors.New("请选择磁盘中的目录")
		}
		return filepath.Clean(s), nil
	}
	return filepath.Clean("/" + strings.TrimLeft(s, "/")), nil
}
func (w *worker) failure(c command, err error) error {
	message := "文件操作失败，未自动重试"
	if errors.Is(err, os.ErrPermission) {
		message = "权限不足：请使用当前普通用户可读写的目录；不会提升权限或修改属主"
	} else if err != nil {
		message = err.Error()
	}
	return w.json(map[string]any{"action": "error", "reqid": c.RequestID, "message": message})
}
func (w *worker) list(c command) error {
	if c.Paged {
		return w.listPage(c)
	}
	w.closeDirectory()
	entries := []map[string]any{}
	if runtime.GOOS == "windows" && c.Path == "" {
		for drive := 'C'; drive <= 'Z'; drive++ {
			p := fmt.Sprintf("%c:/", drive)
			if s, err := os.Stat(p); err == nil && s.IsDir() {
				entries = append(entries, map[string]any{"n": p, "t": 1, "s": 0, "dt": "磁盘"})
			}
		}
		return w.json(map[string]any{"path": c.Path, "dir": entries, "reqid": c.RequestID, "folderTransfer": true})
	}
	p, err := nativePath(c.Path)
	if err == nil {
		var directory *os.File
		directory, err = openDirectoryStream(p)
		if err == nil {
			defer directory.Close()
			budget := 0
			for {
				var list []os.DirEntry
				list, err = directory.ReadDir(directoryPageSize)
				for _, entry := range list {
					info, e := entry.Info()
					if e != nil {
						continue
					}
					kind := 3
					if info.IsDir() {
						kind = 2
					}
					item := map[string]any{"n": entry.Name(), "t": kind, "s": info.Size(), "d": info.ModTime().Unix()}
					encoded, _ := json.Marshal(item)
					budget += len(encoded) + 1
					if budget > MaxFrameSize-(64<<10) {
						return w.directoryFailure(c, errors.New("目录项目过多，请刷新门户以启用分页浏览"))
					}
					entries = append(entries, item)
				}
				if errors.Is(err, io.EOF) {
					err = nil
					break
				}
				if err != nil {
					break
				}
			}
		}
	}
	if err != nil {
		return w.json(map[string]any{"path": c.Path, "dir": nil, "reqid": c.RequestID})
	}
	response := map[string]any{"path": c.Path, "dir": entries, "reqid": c.RequestID, "folderTransfer": true}
	data, err := json.Marshal(response)
	if err != nil {
		return err
	}
	if len(data) > MaxFrameSize {
		return w.directoryFailure(c, errors.New("目录项目过多，请刷新门户以启用分页浏览"))
	}
	return WriteFrame(w.out, data)
}
func (w *worker) startUpload(c command) error {
	if w.upload != nil || w.download != nil {
		return w.json(map[string]any{"action": "uploaderror", "reqid": c.RequestID, "message": "已有文件正在传输"})
	}
	dir, err := nativePath(c.Path)
	if err == nil && (!validName(c.Name) || (runtime.GOOS == "windows" && strings.Contains(c.Name, ":")) || c.Size < 0) {
		err = errors.New("文件名称或大小无效")
	}
	var previous os.FileInfo
	destination := filepath.Join(dir, c.Name)
	if err == nil {
		previous, err = os.Lstat(destination)
		if errors.Is(err, os.ErrNotExist) {
			previous = nil
			err = nil
		} else if err == nil {
			if c.Folder || !previous.Mode().IsRegular() {
				err = errors.New("不能覆盖目录、链接或特殊文件")
			} else {
				var f *os.File
				f, err = os.OpenFile(destination, os.O_WRONLY, 0)
				if err == nil {
					err = f.Close()
				}
			}
		}
	}
	var f *os.File
	if err == nil {
		f, err = os.CreateTemp(dir, ".screen-control-upload-*")
	}
	if err != nil {
		return w.json(map[string]any{"action": "uploaderror", "reqid": c.RequestID, "message": "无法写入目标目录或文件：" + err.Error()})
	}
	w.upload = &upload{folder: c.Folder, file: f, destination: destination, previous: previous, size: c.Size, id: c.RequestID, window: transferWindow(c.Window)}
	response := map[string]any{"action": "uploadstart", "reqid": c.RequestID}
	if w.upload.window > 1 {
		response["window"] = w.upload.window
		response["chunkSize"] = transferChunkSize
	}
	return w.json(response)
}
func (w *worker) uploadData(data []byte) error {
	u := w.upload
	if u == nil {
		return errors.New("没有正在进行的上传")
	}
	if data[0] == 0 {
		data = data[1:]
	}
	if u.window > 1 && (len(data) == 0 || len(data) > transferChunkSize) {
		w.abortUpload()
		return w.json(map[string]any{"action": "uploaderror", "reqid": u.id, "message": "上传分块大小无效"})
	}
	if u.received+int64(len(data)) > u.size {
		w.abortUpload()
		return w.json(map[string]any{"action": "uploaderror", "reqid": u.id, "message": "上传长度超过声明大小"})
	}
	n, err := u.file.Write(data)
	u.received += int64(n)
	if err != nil || n != len(data) {
		w.abortUpload()
		return w.json(map[string]any{"action": "uploaderror", "reqid": u.id, "message": "文件写入失败，原文件未改变"})
	}
	u.chunks++
	response := map[string]any{"action": "uploadack", "reqid": u.id}
	if u.window > 1 {
		response["ack"] = u.chunks
	}
	return w.json(response)
}
func (w *worker) finishUpload(c command) error {
	u := w.upload
	if u == nil || u.id != c.RequestID {
		return w.failure(c, errors.New("上传标识无效"))
	}
	var err error
	if u.received != u.size {
		err = errors.New("上传长度不完整")
	}
	current, statErr := os.Lstat(u.destination)
	if err == nil {
		if u.previous == nil {
			if !errors.Is(statErr, os.ErrNotExist) {
				err = errors.New("目标文件在传输期间出现，请重新确认覆盖")
			}
		} else if statErr != nil || !os.SameFile(u.previous, current) || u.previous.Size() != current.Size() || !u.previous.ModTime().Equal(current.ModTime()) {
			err = errors.New("目标文件在传输期间发生变化")
		}
	}
	if err == nil && u.previous != nil {
		err = u.file.Chmod(u.previous.Mode().Perm())
	}
	if err == nil {
		err = u.file.Sync()
	}
	closeErr := u.file.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		if u.folder {
			err = unpackFolder(u.file.Name(), u.destination, func() error {
				return w.json(map[string]any{"action": "uploadprogress", "reqid": u.id, "message": "正在解压文件夹"})
			})
			os.Remove(u.file.Name())
		} else {
			err = os.Rename(u.file.Name(), u.destination)
		}
	}
	if err != nil {
		w.abortUpload()
		return w.json(map[string]any{"action": "uploaderror", "reqid": u.id, "message": err.Error()})
	}
	w.upload = nil
	return w.json(map[string]any{"action": "uploaddone", "reqid": u.id})
}
func (w *worker) downloadCommand(c command) error {
	if c.Sub == "start" {
		if w.download != nil || w.upload != nil {
			return w.json(map[string]any{"action": "download", "sub": "cancel", "id": c.ID})
		}
		p, err := nativePath(c.Path)
		var f *os.File
		if err == nil && c.Folder {
			f, err = packFolder(p, func() error {
				return w.json(map[string]any{"action": "download", "sub": "progress", "id": c.ID, "message": "正在打包文件夹"})
			})
			if err == nil {
				w.downloadTemp = f.Name()
			}
		}
		if err == nil && !c.Folder {
			var s os.FileInfo
			s, err = os.Stat(p)
			if err == nil && (!s.Mode().IsRegular()) {
				err = errors.New("所选项目不是普通文件")
			}
		}
		if err == nil && !c.Folder {
			f, err = os.Open(p)
		}
		if err != nil {
			return w.json(map[string]any{"action": "download", "sub": "cancel", "id": c.ID, "message": err.Error()})
		}
		w.download = f
		w.downloadID = c.ID
		w.downloadWindow = transferWindow(c.Window)
		w.downloadSent, w.downloadAck, w.downloadStarted = 0, 0, false
		info, _ := f.Stat()
		response := map[string]any{"action": "download", "sub": "start", "id": c.ID, "size": info.Size()}
		if w.downloadWindow > 1 {
			response["window"] = w.downloadWindow
			response["chunkSize"] = transferChunkSize
		}
		return w.json(response)
	}
	// 结束帧或取消后的在途累计确认不触发新读取，也不污染后续操作结果。
	if w.download == nil && w.downloadID == c.ID && w.downloadWindow > 1 && (c.Sub == "ack" || c.Sub == "stop") {
		return nil
	}
	if w.download == nil || w.downloadID != c.ID {
		return w.failure(c, errors.New("下载标识无效"))
	}
	if c.Sub == "stop" {
		w.download.Close()
		if w.downloadTemp != "" {
			os.Remove(w.downloadTemp)
			w.downloadTemp = ""
		}
		w.download = nil
		return nil
	}
	if c.Sub != "ack" && c.Sub != "startack" {
		return w.failure(c, errors.New("下载操作无效"))
	}
	if w.downloadWindow > 1 {
		return w.advanceDownload(c)
	}
	return w.sendDownloadBlock(c.ID, 16380)
}

func (w *worker) sendDownloadBlock(id int64, chunkSize int) error {
	headerSize := 4
	if w.downloadWindow > 1 {
		headerSize = 12
	}
	data := make([]byte, chunkSize+headerSize)
	if headerSize == 12 {
		binary.BigEndian.PutUint64(data[4:12], uint64(id))
	}
	n, err := io.ReadFull(w.download, data[headerSize:])
	data[0] = 1
	if err != nil {
		if !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
			w.download.Close()
			if w.downloadTemp != "" {
				os.Remove(w.downloadTemp)
				w.downloadTemp = ""
			}
			w.download = nil
			return w.json(map[string]any{"action": "download", "sub": "cancel", "id": id})
		}
		data[3] = 1
		w.download.Close()
		if w.downloadTemp != "" {
			os.Remove(w.downloadTemp)
			w.downloadTemp = ""
		}
		w.download = nil
	}
	w.downloadSent++
	return WriteFrame(w.out, data[:headerSize+n])
}
func (w *worker) handle(data []byte) error {
	if data[0] != '{' {
		return w.uploadData(data)
	}
	var c command
	if err := json.Unmarshal(data, &c); err != nil {
		return w.failure(c, errors.New("文件请求无效"))
	}
	if c.Control == "102938" {
		return nil
	}
	switch c.Action {
	case "ls":
		return w.list(c)
	case "upload":
		return w.startUpload(c)
	case "uploaddone":
		return w.finishUpload(c)
	case "uploadcancel":
		w.abortUpload()
		return nil
	case "download":
		return w.downloadCommand(c)
	}
	if w.upload != nil || w.download != nil {
		return w.failure(c, errors.New("请等待当前文件传输完成"))
	}
	p, err := nativePath(c.Path)
	if err != nil {
		return w.failure(c, err)
	}
	switch c.Action {
	case "open-directory":
		if err = openDirectory(p); err != nil {
			return w.failure(c, err)
		}
		return w.json(map[string]any{"action": "directory-open-requested", "reqid": c.RequestID, "status": "unknown"})
	case "compress":
		if err = compressLocal(p, c.Name, c.Names); err != nil {
			return w.failure(c, err)
		}
		return w.json(map[string]any{"action": "compressed", "reqid": c.RequestID, "name": c.Name})
	case "mkdir":
		if p == filepath.VolumeName(p)+string(os.PathSeparator) {
			err = errors.New("不能创建根目录")
		} else {
			err = os.Mkdir(p, 0700)
		}
	case "rename":
		if !validName(c.OldName) || !validName(c.NewName) {
			err = errors.New("文件名称无效")
			break
		}
		dest := filepath.Join(p, c.NewName)
		if _, e := os.Lstat(dest); !errors.Is(e, os.ErrNotExist) {
			err = errors.New("目标名称已存在或不可访问")
			break
		}
		err = os.Rename(filepath.Join(p, c.OldName), dest)
	case "rm":
		if len(c.DeleteFiles) != 1 || !validName(c.DeleteFiles[0]) {
			err = errors.New("请选择一个有效删除目标")
			break
		}
		target := filepath.Join(p, c.DeleteFiles[0])
		if c.Recursive {
			err = os.RemoveAll(target)
		} else {
			err = os.Remove(target)
		}
	default:
		err = errors.New("不支持的文件操作")
	}
	if err != nil {
		return w.failure(c, err)
	}
	return w.json(map[string]any{"action": "refresh", "reqid": c.RequestID})
}

// Run 只处理文件消息。身份检查在进程入口执行，测试可使用隔离目录和普通流。
func Run(in io.Reader, out io.Writer) error {
	w := &worker{out: out}
	defer w.close()
	for {
		data, err := ReadFrame(in)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if err = w.handle(data); err != nil {
			return err
		}
	}
}
