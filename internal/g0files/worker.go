// g0files 提供普通用户运行的 G0 文件协议，不执行命令或修改文件属主。
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

const MaxFileSize = 512 << 20
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
	file               *os.File
	destination        string
	previous           os.FileInfo
	size, received, id int64
}
type worker struct {
	out        io.Writer
	upload     *upload
	download   *os.File
	downloadID int64
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
	w.abortUpload()
	if w.download != nil {
		w.download.Close()
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
	entries := []map[string]any{}
	if runtime.GOOS == "windows" && c.Path == "" {
		for drive := 'C'; drive <= 'Z'; drive++ {
			p := fmt.Sprintf("%c:/", drive)
			if s, err := os.Stat(p); err == nil && s.IsDir() {
				entries = append(entries, map[string]any{"n": p, "t": 1, "s": 0, "dt": "磁盘"})
			}
		}
		return w.json(map[string]any{"path": c.Path, "dir": entries, "reqid": c.RequestID})
	}
	p, err := nativePath(c.Path)
	if err == nil {
		var list []os.DirEntry
		list, err = os.ReadDir(p)
		if err == nil {
			for _, entry := range list {
				info, e := entry.Info()
				if e != nil {
					continue
				}
				kind := 3
				if info.IsDir() {
					kind = 2
				}
				entries = append(entries, map[string]any{"n": entry.Name(), "t": kind, "s": info.Size(), "d": info.ModTime().Unix()})
			}
		}
	}
	if err != nil {
		return w.json(map[string]any{"path": c.Path, "dir": nil, "reqid": c.RequestID})
	}
	return w.json(map[string]any{"path": c.Path, "dir": entries, "reqid": c.RequestID})
}
func (w *worker) startUpload(c command) error {
	if w.upload != nil || w.download != nil {
		return w.json(map[string]any{"action": "uploaderror", "reqid": c.RequestID, "message": "已有文件正在传输"})
	}
	dir, err := nativePath(c.Path)
	if err == nil && (!validName(c.Name) || c.Size < 0 || c.Size > MaxFileSize) {
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
			if !previous.Mode().IsRegular() {
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
		return w.json(map[string]any{"action": "uploaderror", "reqid": c.RequestID, "message": "无法写入目标目录或文件；请检查普通用户权限"})
	}
	w.upload = &upload{file: f, destination: destination, previous: previous, size: c.Size, id: c.RequestID}
	return w.json(map[string]any{"action": "uploadstart", "reqid": c.RequestID})
}
func (w *worker) uploadData(data []byte) error {
	u := w.upload
	if u == nil {
		return errors.New("没有正在进行的上传")
	}
	if data[0] == 0 {
		data = data[1:]
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
	return w.json(map[string]any{"action": "uploadack", "reqid": u.id})
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
		err = os.Rename(u.file.Name(), u.destination)
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
		if err == nil {
			var s os.FileInfo
			s, err = os.Stat(p)
			if err == nil && (!s.Mode().IsRegular() || s.Size() > MaxFileSize) {
				err = errors.New("文件类型或大小不受支持")
			}
		}
		if err == nil {
			f, err = os.Open(p)
		}
		if err != nil {
			return w.json(map[string]any{"action": "download", "sub": "cancel", "id": c.ID})
		}
		w.download = f
		w.downloadID = c.ID
		return w.json(map[string]any{"action": "download", "sub": "start", "id": c.ID})
	}
	if w.download == nil || w.downloadID != c.ID {
		return w.failure(c, errors.New("下载标识无效"))
	}
	if c.Sub == "stop" {
		w.download.Close()
		w.download = nil
		return nil
	}
	if c.Sub != "ack" && c.Sub != "startack" {
		return w.failure(c, errors.New("下载操作无效"))
	}
	data := make([]byte, 16384)
	n, err := io.ReadFull(w.download, data[4:])
	data[0] = 1
	if err != nil {
		if !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
			w.download.Close()
			w.download = nil
			return w.json(map[string]any{"action": "download", "sub": "cancel", "id": c.ID})
		}
		data[3] = 1
		w.download.Close()
		w.download = nil
	}
	return WriteFrame(w.out, data[:4+n])
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
