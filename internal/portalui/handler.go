// portalui 包在 G0 API 旁提供门户的生产构建页面。
package portalui

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// WithCanonicalRedirect 将兼容监听器收到的浏览器导航请求
// 重定向到可信的 Tailscale 直连 HTTPS 源站。
// API 和健康检查请求不会被重定向。
func WithCanonicalRedirect(next http.Handler, origin string) (http.Handler, error) {
	canonical, err := url.Parse(strings.TrimRight(strings.TrimSpace(origin), "/"))
	if err != nil || (canonical.Scheme != "https" && canonical.Scheme != "http") || canonical.Host == "" || canonical.Path != "" {
		return nil, fmt.Errorf("canonical origin must be an HTTP(S) origin")
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if (r.Method == http.MethodGet || r.Method == http.MethodHead) &&
			!strings.HasPrefix(r.URL.Path, "/api/") && strings.Contains(r.Header.Get("Accept"), "text/html") {
			destination := *canonical
			destination.Path = r.URL.Path
			destination.RawQuery = r.URL.RawQuery
			destination.Fragment = r.URL.Fragment
			http.Redirect(w, r, destination.String(), http.StatusPermanentRedirect)
			return
		}
		next.ServeHTTP(w, r)
	}), nil
}

// NewHandler 将 api 挂载到 /api/ 下，并从 directory 提供 Vite 单页应用。
// directory 为空时保留仅提供 API 的开发模式。
func NewHandler(api http.Handler, directory string) (http.Handler, error) {
	if strings.TrimSpace(directory) == "" {
		return api, nil
	}
	root, err := filepath.Abs(directory)
	if err != nil {
		return nil, fmt.Errorf("resolve Portal directory: %w", err)
	}
	indexPath := filepath.Join(root, "index.html")
	if info, err := os.Stat(indexPath); err != nil || info.IsDir() {
		return nil, fmt.Errorf("Portal build is missing index.html in %s", root)
	}

	files := http.FileServer(http.Dir(root))
	mux := http.NewServeMux()
	mux.Handle("/api/", api)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")

		relative := strings.TrimPrefix(filepath.Clean("/"+r.URL.Path), "/")
		candidate := filepath.Join(root, filepath.FromSlash(relative))
		if relative != "" {
			if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
				if strings.HasPrefix(relative, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				} else {
					w.Header().Set("Cache-Control", "no-cache")
				}
				files.ServeHTTP(w, r)
				return
			}
		}

		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, indexPath)
	})
	return mux, nil
}
