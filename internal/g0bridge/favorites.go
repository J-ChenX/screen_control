package g0bridge

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
)

// FavoriteStore 由同一进程的私网及网关入口共享，收藏只记录路径，不授予文件权限。
type FavoriteStore struct {
	mu   sync.Mutex
	path string
	data favoriteData
}
type favoriteData struct {
	Devices map[string][]string `json:"devices"`
	Imports map[string]bool     `json:"imports"`
}
type favoriteCommand struct {
	Action   string   `json:"action"`
	Path     string   `json:"path,omitempty"`
	Before   string   `json:"before,omitempty"`
	Paths    []string `json:"paths,omitempty"`
	ImportID string   `json:"importId,omitempty"`
}

// NewFavoriteStore 加载持久收藏。损坏数据拒绝启动，避免静默覆盖。
func NewFavoriteStore(path string) (*FavoriteStore, error) {
	if path == "" {
		return nil, errors.New("未配置收藏存储路径")
	}
	store := &FavoriteStore{path: path, data: favoriteData{Devices: map[string][]string{}, Imports: map[string]bool{}}}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(raw, &store.data); err != nil {
		return nil, err
	}
	if store.data.Devices == nil || store.data.Imports == nil {
		return nil, errors.New("收藏存储格式无效")
	}
	for device, paths := range store.data.Devices {
		if !remoteTargetDeviceID(device) || len(paths) > 512 {
			return nil, errors.New("收藏存储内容无效")
		}
		for _, path := range paths {
			if !validFavoritePath(path) {
				return nil, errors.New("收藏路径无效")
			}
		}
	}
	return store, nil
}

func (s *Server) SetFavoriteStore(store *FavoriteStore) { s.favorites = store }

func validFavoritePath(path string) bool {
	if path == "" || len(path) > 4096 || strings.ContainsAny(path, "\x00\\") || strings.HasPrefix(path, "/") || strings.HasSuffix(path, "/") || (len(path) == 2 && path[1] == ':') {
		return false
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

// 写临时文件并原子替换；写入失败时保留原文件和内存快照。
func (s *FavoriteStore) save(data favoriteData) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return err
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(s.path), ".favorites-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(raw); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(f.Name(), s.path); err != nil {
		return err
	}
	s.data = data
	return nil
}

func (s *Server) handleFavorites(w http.ResponseWriter, r *http.Request) {
	reqID := requestID()
	if _, ok := s.resolveDevice(w, r, reqID); !ok {
		return
	}
	device := r.PathValue("deviceID")
	if !remoteTargetDeviceID(device) {
		s.writeError(w, 403, reqID, "TARGET_NOT_SUPPORTED", "该设备不支持文件夹收藏")
		return
	}
	if s.favorites == nil {
		s.writeError(w, 503, reqID, "FAVORITES_UNAVAILABLE", "收藏同步尚未配置")
		return
	}
	store := s.favorites
	var input favoriteCommand
	if r.Method == http.MethodPost {
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 3<<20))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&input); err != nil {
			s.writeError(w, 400, reqID, "INVALID_REQUEST", "收藏请求无效")
			return
		}
		var extra any
		if decoder.Decode(&extra) != io.EOF {
			s.writeError(w, 400, reqID, "INVALID_REQUEST", "收藏请求无效")
			return
		}
		valid := false
		switch input.Action {
		case "add", "remove", "move":
			valid = validFavoritePath(input.Path) && (input.Before == "" || validFavoritePath(input.Before))
		case "import":
			valid = len(input.ImportID) >= 16 && len(input.ImportID) <= 128 && len(input.Paths) <= 512
			for _, path := range input.Paths {
				valid = valid && validFavoritePath(path)
			}
		}
		if !valid {
			s.writeError(w, 400, reqID, "INVALID_REQUEST", "收藏路径或操作无效")
			return
		}
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	paths := append([]string{}, store.data.Devices[device]...)
	if r.Method == http.MethodPost {
		imports := make(map[string]bool, len(store.data.Imports))
		for k, v := range store.data.Imports {
			imports[k] = v
		}
		switch input.Action {
		case "remove":
			paths = slices.DeleteFunc(paths, func(path string) bool { return path == input.Path })
		case "add":
			if !slices.Contains(paths, input.Path) {
				paths = append(paths, input.Path)
			}
		case "move":
			if input.Before != input.Path {
				paths = slices.DeleteFunc(paths, func(path string) bool { return path == input.Path })
				index := slices.Index(paths, input.Before)
				if index < 0 {
					index = len(paths)
				}
				paths = slices.Insert(paths, index, input.Path)
			}
		case "import":
			key := device + ":" + input.ImportID
			if !imports[key] {
				if len(imports) >= 4096 {
					s.writeError(w, 409, reqID, "FAVORITES_LIMIT", "收藏迁移记录已达上限")
					return
				}
				for _, path := range input.Paths {
					if !slices.Contains(paths, path) {
						paths = append(paths, path)
					}
				}
				imports[key] = true
			}
		}
		if len(paths) > 512 {
			s.writeError(w, 409, reqID, "FAVORITES_LIMIT", "每台设备最多收藏 512 个文件夹")
			return
		}
		devices := make(map[string][]string, len(store.data.Devices))
		for k, v := range store.data.Devices {
			devices[k] = v
		}
		devices[device] = paths
		if err := store.save(favoriteData{Devices: devices, Imports: imports}); err != nil {
			s.writeError(w, 503, reqID, "FAVORITES_SAVE_FAILED", "收藏保存失败，请稍后重试")
			return
		}
	}
	s.writeJSON(w, 200, reqID, map[string]any{"paths": paths}, nil)
}
