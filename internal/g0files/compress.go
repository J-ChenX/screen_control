package g0files

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// compressLocal 仅调用固定系统 tar，将当前目录的选中项压缩到同目录；不接受命令、参数或远端目的地。
func compressLocal(dir, name string, names []string) error {
	if !validName(name) || strings.Contains(name, ":") || !strings.HasSuffix(strings.ToLower(name), ".tar.gz") || len(names) == 0 || len(names) > 1000 {
		return errors.New("请选择文件并填写 .tar.gz 压缩包名称")
	}
	destination := filepath.Join(dir, name)
	if _, err := os.Lstat(destination); !errors.Is(err, os.ErrNotExist) {
		return errors.New("同名文件已存在或不可访问，请更换压缩包名称")
	}
	var total int64
	count := 0
	seen := map[string]bool{}
	args := []string{"-czf", "-", "--"}
	for _, entry := range names {
		if !validName(entry) || strings.Contains(entry, ":") || strings.EqualFold(entry, name) || seen[entry] {
			return errors.New("压缩选择无效")
		}
		seen[entry] = true
		err := filepath.WalkDir(filepath.Join(dir, entry), func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			count++
			if count > 100000 {
				return errors.New("压缩项目过多")
			}
			info, err := d.Info()
			if err != nil {
				return err
			}
			if !info.IsDir() && !info.Mode().IsRegular() {
				return errors.New("压缩不支持符号链接或特殊文件")
			}
			total += info.Size()
			if total > MaxFileSize {
				return errors.New("当前压缩输入总大小上限为 512 MB")
			}
			return nil
		})
		if err != nil {
			return err
		}
		args = append(args, "./"+entry)
	}
	program := "/usr/bin/tar"
	if runtime.GOOS == "windows" {
		program = filepath.Join(os.Getenv("SystemRoot"), "System32", "tar.exe")
	}
	if _, err := os.Stat(program); err != nil {
		return errors.New("当前设备未提供系统 tar 压缩工具")
	}
	temp, err := os.CreateTemp(dir, ".screen-control-compress-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	defer temp.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, program, args...)
	cmd.Dir = dir
	cmd.Stdout = temp
	for _, v := range os.Environ() {
		key, _, _ := strings.Cut(v, "=")
		if !strings.EqualFold(key, "TAR_OPTIONS") && !strings.EqualFold(key, "GZIP") {
			cmd.Env = append(cmd.Env, v)
		}
	}
	if err = cmd.Run(); err != nil {
		return errors.New("系统压缩失败或超时，请检查源文件权限及可用空间；未生成目标压缩包")
	}
	if err = temp.Sync(); err != nil {
		return err
	}
	if err = temp.Close(); err != nil {
		return err
	}
	// 硬链接发布具有排他语义，拒绝覆盖压缩期间新出现的同名文件。
	if err = os.Link(temp.Name(), destination); err != nil {
		return errors.New("无法保存压缩包：目标已存在或文件系统不支持安全发布")
	}
	return nil
}
