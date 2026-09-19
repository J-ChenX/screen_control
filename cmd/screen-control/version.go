// screen-control 命令是服务端的组装入口。
package main

import (
	"crypto/tls"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"screencontrol.local/screen-control/internal/identity/gateway"
	"strings"
	"time"

	"screencontrol.local/screen-control/internal/g0bridge"
	"screencontrol.local/screen-control/internal/identity/peer"
	"screencontrol.local/screen-control/internal/portalui"

	"tailscale.com/client/local"
)

var (
	version   = "dev"
	commit    = "unknown"
	builtAt   = "unknown"
	toolchain = "unknown"
)

func main() {
	serve := flag.Bool("serve", false, "serve the local G0 Portal bridge")
	listen := flag.String("listen", envOr("SCREEN_CONTROL_LISTEN", "127.0.0.1:8787"), "HTTP listen address")
	tailscaleListen := flag.String("tailscale-listen", envOr("SCREEN_CONTROL_TAILSCALE_LISTEN", ""), "direct Tailscale HTTP(S) listen address")
	tailscaleTLS := flag.Bool("tailscale-tls", envBool("SCREEN_CONTROL_TAILSCALE_TLS", false), "terminate TLS on the direct Tailscale listener")
	deviceNodes := flag.String("device-nodes", envOr("SCREEN_CONTROL_DEVICE_NODES", ""), "comma-separated device=stable-node-id registrations")
	canonicalOrigin := flag.String("canonical-origin", envOr("SCREEN_CONTROL_CANONICAL_ORIGIN", ""), "canonical browser origin used by the loopback compatibility entry")
	meshURL := flag.String("mesh-url", envOr("SCREEN_CONTROL_MESH_URL", ""), "MeshCentral base URL")
	meshUser := flag.String("mesh-user", envOr("SCREEN_CONTROL_MESH_USER", "g0-desktop"), "MeshCentral user")
	passwordFile := flag.String("mesh-password-file", envOr("SCREEN_CONTROL_MESH_PASSWORD_FILE", secretPath("meshcentral-g0-desktop")), "MeshCentral password file")
	meshFileUser := flag.String("mesh-file-user", envOr("SCREEN_CONTROL_MESH_FILE_USER", "g0-files"), "MeshCentral file user")
	filePasswordFile := flag.String("mesh-file-password-file", envOr("SCREEN_CONTROL_MESH_FILE_PASSWORD_FILE", secretPath("meshcentral-g0-files")), "MeshCentral file password file")
	allowedOrigins := flag.String("allowed-origins", envOr("SCREEN_CONTROL_ALLOWED_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:4173,http://localhost:4173"), "comma-separated Portal origins")
	portalDir := flag.String("portal-dir", envOr("SCREEN_CONTROL_PORTAL_DIR", ""), "directory containing the production Portal build")
	gatewayListen := flag.String("gateway-listen", envOr("SCREEN_CONTROL_GATEWAY_LISTEN", ""), "dedicated loopback listener behind an HTTPS tunnel")
	gatewayOrigin := flag.String("gateway-origin", envOr("SCREEN_CONTROL_GATEWAY_ORIGIN", ""), "exact public HTTPS origin")
	gatewayCredentials := flag.String("gateway-credentials", envOr("SCREEN_CONTROL_GATEWAY_CREDENTIALS", ""), "private JSON file of device access-key hashes")
	fileSSHTargets := flag.String("file-ssh-targets", envOr("SCREEN_CONTROL_FILE_SSH_TARGETS", ""), "登记设备的普通用户文件 SSH 目标")
	favoritesFile := flag.String("favorites-file", envOr("SCREEN_CONTROL_FAVORITES_FILE", statePath("favorites/folders.json")), "服务端共享文件夹收藏存储路径")
	flag.Parse()
	if *serve {
		mesh, err := g0bridge.NewMeshClientWithFiles(*meshURL, *meshUser, *passwordFile, *meshFileUser, *filePasswordFile)
		if err != nil {
			slog.Error("invalid G0 bridge configuration", "error", err)
			os.Exit(1)
		}
		var identityResolver *peer.Resolver
		if strings.TrimSpace(*deviceNodes) != "" {
			registrations, parseErr := peer.ParseRegistrations(*deviceNodes)
			if parseErr != nil {
				slog.Error("invalid Tailscale device registry", "error", parseErr)
				os.Exit(1)
			}
			identityResolver, err = peer.NewResolver(registrations)
			if err != nil {
				slog.Error("invalid Tailscale identity resolver", "error", err)
				os.Exit(1)
			}
		}
		bridge := g0bridge.NewServerWithIdentity(mesh, identityResolver, slog.Default(), splitValues(*allowedOrigins)...)
		if err := bridge.ConfigureFiles(*fileSSHTargets); err != nil {
			slog.Error("文件通道配置无效")
			os.Exit(1)
		}
		favorites, err := g0bridge.NewFavoriteStore(*favoritesFile)
		if err != nil {
			slog.Error("无法加载共享收藏存储")
			os.Exit(1)
		}
		bridge.SetFavoriteStore(favorites)
		api := bridge.Handler()
		handler, err := portalui.NewHandler(api, *portalDir)
		if err != nil {
			slog.Error("invalid Portal build", "error", err)
			os.Exit(1)
		}
		loopbackHandler := handler
		if strings.TrimSpace(*canonicalOrigin) != "" {
			loopbackHandler, err = portalui.WithCanonicalRedirect(handler, *canonicalOrigin)
			if err != nil {
				slog.Error("invalid canonical Portal origin", "error", err)
				os.Exit(1)
			}
		}
		server := &http.Server{
			Addr:              *listen,
			Handler:           loopbackHandler,
			ReadHeaderTimeout: 5 * time.Second,
			IdleTimeout:       60 * time.Second,
		}
		errors := make(chan error, 3)
		if *gatewayListen != "" {
			host, _, listenErr := net.SplitHostPort(*gatewayListen)
			ip := net.ParseIP(host)
			if listenErr != nil || ip == nil || !ip.IsLoopback() {
				slog.Error("gateway listener must use a loopback IP behind an HTTPS tunnel")
				os.Exit(1)
			}
			auth, authErr := gateway.Load(*gatewayOrigin, *gatewayCredentials)
			if authErr != nil {
				slog.Error("invalid gateway authentication", "error", authErr)
				os.Exit(1)
			}
			publicBridge := g0bridge.NewServerWithIdentity(mesh, gateway.Resolver{}, slog.Default(), *gatewayOrigin)
			if err := publicBridge.ConfigureFiles(*fileSSHTargets); err != nil {
				slog.Error("文件通道配置无效")
				os.Exit(1)
			}
			publicBridge.SetFavoriteStore(favorites)
			publicAPI := publicBridge.Handler()
			publicUI, uiErr := portalui.NewHandler(publicAPI, *portalDir)
			if uiErr != nil {
				slog.Error("invalid gateway Portal", "error", uiErr)
				os.Exit(1)
			}
			publicServer := &http.Server{Addr: *gatewayListen, Handler: auth.Handler(publicUI), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
			go func() {
				slog.Info("authenticated HTTPS tunnel origin listening", "address", *gatewayListen)
				errors <- publicServer.ListenAndServe()
			}()
		}
		go func() {
			slog.Info("Screen Control loopback listening", "address", *listen, "portalDir", *portalDir)
			errors <- server.ListenAndServe()
		}()
		if strings.TrimSpace(*tailscaleListen) != "" {
			if identityResolver == nil {
				slog.Error("direct Tailscale listener requires device registrations")
				os.Exit(1)
			}
			edgeServer := &http.Server{
				Addr:              *tailscaleListen,
				Handler:           handler,
				ReadHeaderTimeout: 5 * time.Second,
				IdleTimeout:       60 * time.Second,
			}
			go func() {
				if *tailscaleTLS {
					localClient := new(local.Client)
					edgeServer.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS13, GetCertificate: localClient.GetCertificate}
					slog.Info("Screen Control trusted Tailscale HTTPS listening", "address", *tailscaleListen)
					errors <- edgeServer.ListenAndServeTLS("", "")
					return
				}
				slog.Info("Screen Control trusted Tailscale HTTP listening", "address", *tailscaleListen, "transport", "WireGuard")
				errors <- edgeServer.ListenAndServe()
			}()
		}
		if err := <-errors; err != nil && err != http.ErrServerClosed {
			slog.Error("G0 bridge stopped", "error", err)
			os.Exit(1)
		}
		return
	}
	fmt.Printf("screen-control version=%s commit=%s builtAt=%s toolchain=%s\n", version, commit, builtAt, toolchain)
}

func splitValues(value string) []string {
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if part = strings.TrimSpace(part); part != "" {
			result = append(result, part)
		}
	}
	return result
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envBool(name string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return strings.EqualFold(value, "true") || value == "1" || strings.EqualFold(value, "yes")
}

// 这里只允许配置凭据文件的位置；密码始终保存在文件中。
func secretPath(name string) string {
	return statePath(filepath.Join("secrets", name))
}

func statePath(name string) string {
	state := os.Getenv("XDG_STATE_HOME")
	if state == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		state = filepath.Join(home, ".local", "state")
	}
	return filepath.Join(state, "screen-control", name)
}
