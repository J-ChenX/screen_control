package g0bridge

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
)

func favoritesHandler(store *FavoriteStore, identity string) http.Handler {
	s := NewServerWithIdentity(&fakeMesh{}, fakeIdentity(identity), nil)
	s.SetFavoriteStore(store)
	return s.Handler()
}
func favoriteRequest(handler http.Handler, method, device, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "/api/v1/files/favorites/"+device, strings.NewReader(body))
	r.Header.Set("Origin", "http://127.0.0.1:5173")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}
func favoritePaths(t *testing.T, w *httptest.ResponseRecorder) []string {
	t.Helper()
	if w.Code != 200 {
		t.Fatalf("状态 %d: %s", w.Code, w.Body.String())
	}
	var data struct {
		Data struct {
			Paths []string `json:"paths"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	return data.Data.Paths
}
func TestFavoritesSharedPersistentAndIsolatedByTarget(t *testing.T) {
	file := filepath.Join(t.TempDir(), "state", "favorites.json")
	store, err := NewFavoriteStore(file)
	if err != nil {
		t.Fatal(err)
	}
	a, b := favoritesHandler(store, "nix"), favoritesHandler(store, "xiaomi-15")
	favoritePaths(t, favoriteRequest(a, "POST", "echova", `{"action":"add","path":"home/demo/资料"}`))
	if got := favoritePaths(t, favoriteRequest(b, "GET", "echova", "")); !slices.Equal(got, []string{"home/demo/资料"}) {
		t.Fatal(got)
	}
	if got := favoritePaths(t, favoriteRequest(b, "GET", "nix", "")); len(got) != 0 {
		t.Fatal(got)
	}
	favoritePaths(t, favoriteRequest(b, "POST", "echova", `{"action":"move","path":"home/demo/代码","before":"home/demo/资料"}`))
	restarted, err := NewFavoriteStore(file)
	if err != nil {
		t.Fatal(err)
	}
	got := favoritePaths(t, favoriteRequest(favoritesHandler(restarted, "echova"), "GET", "echova", ""))
	if !slices.Equal(got, []string{"home/demo/代码", "home/demo/资料"}) {
		t.Fatal(got)
	}
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	// Windows 使用目录 ACL，POSIX 模式位只在支持的平台核对。
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatal("收藏文件权限应为 0600")
	}
}
func TestFavoritesConcurrentOperationsAndImportDoNotOverwrite(t *testing.T) {
	store, _ := NewFavoriteStore(filepath.Join(t.TempDir(), "favorites.json"))
	handler := favoritesHandler(store, "nix")
	var wg sync.WaitGroup
	for _, path := range []string{"home/a", "home/b", "home/c"} {
		wg.Go(func() {
			w := favoriteRequest(handler, "POST", "nix", `{"action":"add","path":"`+path+`"}`)
			if w.Code != 200 {
				t.Errorf("并发保存失败 %d", w.Code)
			}
		})
	}
	wg.Wait()
	if got := favoritePaths(t, favoriteRequest(handler, "GET", "nix", "")); len(got) != 3 {
		t.Fatal(got)
	}
	command := `{"action":"import","importId":"0123456789abcdef","paths":["home/a","home/d"]}`
	favoritePaths(t, favoriteRequest(handler, "POST", "nix", command))
	favoritePaths(t, favoriteRequest(handler, "POST", "nix", `{"action":"remove","path":"home/d"}`))
	got := favoritePaths(t, favoriteRequest(handler, "POST", "nix", command))
	if slices.Contains(got, "home/d") || len(got) != 3 {
		t.Fatal("重复迁移恢复了已取消收藏", got)
	}
}
func TestFavoritesRejectUntrustedAndInvalidRequests(t *testing.T) {
	store, _ := NewFavoriteStore(filepath.Join(t.TempDir(), "favorites.json"))
	if w := favoriteRequest(favoritesHandler(store, "unknown"), "GET", "nix", ""); w.Code != 403 {
		t.Fatal(w.Code)
	}
	handler := favoritesHandler(store, "nix")
	if w := favoriteRequest(handler, "GET", "xiaomi-15", ""); w.Code != 403 {
		t.Fatal(w.Code)
	}
	for _, body := range []string{`{"action":"add","path":"../private"}`, `{"action":"add","path":"C:"}`, `{"action":"add","path":""}`, `{"action":"add","path":"home/a","extra":true}`, `{} {}`} {
		if w := favoriteRequest(handler, "POST", "nix", body); w.Code != 400 {
			t.Fatalf("%s: %d", body, w.Code)
		}
	}
	r := httptest.NewRequest("POST", "/api/v1/files/favorites/nix", strings.NewReader(`{"action":"add","path":"home/a"}`))
	r.Header.Set("Origin", "https://untrusted.invalid")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
}
func TestFavoritesWriteFailurePreservesStateAndCorruptFileRejected(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "favorites.json")
	store, _ := NewFavoriteStore(file)
	handler := favoritesHandler(store, "nix")
	favoritePaths(t, favoriteRequest(handler, "POST", "nix", `{"action":"add","path":"home/a"}`))
	store.path = dir
	if w := favoriteRequest(handler, "POST", "nix", `{"action":"add","path":"home/b"}`); w.Code != 503 {
		t.Fatal(w.Code)
	}
	if got := favoritePaths(t, favoriteRequest(handler, "GET", "nix", "")); !slices.Equal(got, []string{"home/a"}) {
		t.Fatal(got)
	}
	if err := os.WriteFile(file, []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewFavoriteStore(file); err == nil {
		t.Fatal("损坏收藏未拒绝")
	}
}
