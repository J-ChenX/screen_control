package g0files

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// packFolder 从受限目录句柄读取普通文件，临时包随下载结束或断线清理。
func packFolder(source string, progress ...func() error) (_ *os.File, err error) {
	tick := folderProgress(progress)
	info, err := os.Lstat(source)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("请选择普通文件夹，不支持目录链接")
	}
	root, err := os.OpenRoot(source)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	f, err := os.CreateTemp("", "screen-control-folder-*")
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			f.Close()
			os.Remove(f.Name())
		}
	}()
	// 交互复制优先减少等待；保留 gzip 格式与完整归档校验，避免默认级别
	// 在图片/视频等低可压缩内容上消耗过多 CPU。
	gz, err := gzip.NewWriterLevel(f, gzip.BestSpeed)
	if err != nil {
		return nil, err
	}
	tw := tar.NewWriter(gz)

	err = fs.WalkDir(root.FS(), ".", func(p string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if e = tick(); e != nil {
			return e
		}
		if p == "." {
			return nil
		}
		info, e := d.Info()
		if e != nil {
			return e
		}
		link := ""
		if info.Mode()&os.ModeSymlink != 0 {
			link, e = root.Readlink(p)
			if e != nil {
				return fmt.Errorf("读取链接 %s：%w", p, e)
			}
		} else if !info.IsDir() && !info.Mode().IsRegular() {
			return fmt.Errorf("无法复制 %s（%s）：运行时特殊文件不能作为普通文件传输", p, info.Mode().Type())
		}
		h, e := tar.FileInfoHeader(info, link)
		if e != nil {
			return e
		}
		h.Name = p
		if e = tw.WriteHeader(h); e != nil {
			return e
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		in, e := root.Open(p)
		if e != nil {
			return e
		}
		defer in.Close()
		current, e := in.Stat()
		if e != nil {
			return e
		}
		if !os.SameFile(info, current) || !current.Mode().IsRegular() {
			return errors.New("源文件在打包期间变化")
		}
		_, e = io.CopyN(progressWriter{tw, tick}, in, info.Size())
		return e
	})
	if err != nil {
		return nil, err
	}
	if err = tw.Close(); err != nil {
		return nil, err
	}
	if err = gz.Close(); err != nil {
		return nil, err
	}
	_, err = f.Seek(0, 0)
	return f, err
}

// unpackFolder 在隔离目录写入内容，最后创建符号链接，解压过程不沿链接写入。
func unpackFolder(archive, destination string, progress ...func() error) error {
	tick := folderProgress(progress)
	if _, err := os.Lstat(destination); !errors.Is(err, os.ErrNotExist) {
		return errors.New("目标已有同名项目，请改名后重新传输")
	}
	stage, err := os.MkdirTemp(filepath.Dir(destination), ".screen-control-folder-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	root, err := os.OpenRoot(stage)
	if err != nil {
		return err
	}
	defer root.Close()
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	var links []tar.Header
	for {
		if e := tick(); e != nil {
			return e
		}
		h, e := tr.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			return e
		}
		if h.Size < 0 {
			return errors.New("归档文件大小无效")
		}
		n := strings.TrimSuffix(h.Name, "/")
		if !fs.ValidPath(n) || strings.ContainsRune(n, 0) {
			return errors.New("压缩包包含无效路径")
		}
		if runtime.GOOS == "windows" {
			if strings.ContainsAny(n, "\\:") {
				return fmt.Errorf("目标 Windows 不支持文件名 %q", n)
			}
			for _, part := range strings.Split(n, "/") {
				base := strings.ToUpper(strings.SplitN(part, ".", 2)[0])
				if strings.TrimRight(part, " .") != part || strings.ContainsAny(part, "<>\"|?*") || base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" || (len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '0' && base[3] <= '9') {
					return fmt.Errorf("目标 Windows 不支持文件名 %q", n)
				}
			}
		}
		if h.Typeflag == tar.TypeSymlink {
			if strings.ContainsRune(h.Linkname, 0) {
				return fmt.Errorf("链接 %s 的目标无效", n)
			}
			h.Name = n
			links = append(links, *h)
			continue
		}
		if h.Typeflag == tar.TypeDir {
			if e = root.MkdirAll(n, 0700); e != nil {
				return e
			}
			continue
		}
		if h.Typeflag != tar.TypeReg {
			return fmt.Errorf("归档项目 %s 的类型 %d 无法还原", n, h.Typeflag)
		}
		if e = root.MkdirAll(path.Dir(n), 0700); e != nil {
			return e
		}
		out, e := root.OpenFile(n, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600|os.FileMode(h.Mode)&0100)
		if e != nil {
			return e
		}
		_, e = io.CopyN(progressWriter{out, tick}, tr, h.Size)
		closeErr := out.Close()
		if e != nil {
			return e
		}
		if closeErr != nil {
			return closeErr
		}
	}
	// 读到 gzip 尾部，确保校验和错误不会被当作成功。
	trailing, err := io.Copy(io.Discard, io.LimitReader(gz, 1<<20))
	if trailing >= 1<<20 {
		return errors.New("压缩包包含过多尾随数据")
	}
	if err != nil {
		return err
	}
	// 链接目标可以保留绝对路径、断链或目录外引用，但不能用作其他归档项目的父目录。
	for _, h := range links {
		if err = tick(); err != nil {
			return err
		}
		parent := path.Dir(h.Name)
		for p := parent; p != "."; p = path.Dir(p) {
			st, e := root.Lstat(p)
			if e == nil && !st.IsDir() {
				return fmt.Errorf("链接 %s 的父目录不是普通目录", h.Name)
			}
			if e != nil && !errors.Is(e, os.ErrNotExist) {
				return e
			}
		}
		if err = root.MkdirAll(parent, 0700); err != nil {
			return err
		}
		if err = root.Symlink(h.Linkname, h.Name); err != nil {
			return fmt.Errorf("创建符号链接 %s：%w", h.Name, err)
		}
	}
	if _, err = os.Lstat(destination); !errors.Is(err, os.ErrNotExist) {
		return errors.New("目标在传输期间出现同名项目")
	}
	root.Close()
	return os.Rename(stage, destination)
}

// 只在实际遍历或复制推进时回报，避免大目录打包和解包被当作空闲超时。
func folderProgress(callbacks []func() error) func() error {
	last := time.Time{}
	return func() error {
		if len(callbacks) == 0 || time.Since(last) < time.Second {
			return nil
		}
		last = time.Now()
		return callbacks[0]()
	}
}

type progressWriter struct {
	io.Writer
	tick func() error
}

func (w progressWriter) Write(p []byte) (int, error) {
	n, err := w.Writer.Write(p)
	if err == nil {
		err = w.tick()
	}
	return n, err
}
