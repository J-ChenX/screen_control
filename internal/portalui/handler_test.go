package portalui

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHandlerServesAssetsSPARoutesAndAPI(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "index.html"), []byte("portal index"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(directory, "assets"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "assets", "app.js"), []byte("portal asset"), 0o600); err != nil {
		t.Fatal(err)
	}
	api := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("api response")) })
	handler, err := NewHandler(api, directory)
	if err != nil {
		t.Fatal(err)
	}

	for path, expected := range map[string]string{
		"/api/v1/health":       "api response",
		"/assets/app.js":       "portal asset",
		"/devices/nix/desktop": "portal index",
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), expected) {
			t.Fatalf("%s: status=%d body=%q", path, response.Code, response.Body.String())
		}
	}
}

func TestCanonicalRedirectOnlyMovesBrowserNavigations(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	handler, err := WithCanonicalRedirect(next, "https://echova.example.ts.net:8444")
	if err != nil {
		t.Fatal(err)
	}

	navigation := httptest.NewRequest(http.MethodGet, "/devices/nix/desktop?mode=full", nil)
	navigation.Header.Set("Accept", "text/html")
	navigationResponse := httptest.NewRecorder()
	handler.ServeHTTP(navigationResponse, navigation)
	if navigationResponse.Code != http.StatusPermanentRedirect || navigationResponse.Header().Get("Location") != "https://echova.example.ts.net:8444/devices/nix/desktop?mode=full" {
		t.Fatalf("navigation status=%d location=%q", navigationResponse.Code, navigationResponse.Header().Get("Location"))
	}

	apiRequest := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	apiResponse := httptest.NewRecorder()
	handler.ServeHTTP(apiResponse, apiRequest)
	if apiResponse.Code != http.StatusNoContent {
		t.Fatalf("API status = %d", apiResponse.Code)
	}
}

func TestHandlerRejectsMissingBuild(t *testing.T) {
	if _, err := NewHandler(http.NotFoundHandler(), t.TempDir()); err == nil {
		t.Fatal("expected missing index error")
	}
}
