package g0bridge

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
)

type Device struct {
	Metrics    *DeviceMetrics `json:"metrics,omitempty"`
	ID         string         `json:"id"`
	NodeID     string         `json:"nodeId"`
	Name       string         `json:"name"`
	Platform   string         `json:"platform"`
	Role       string         `json:"role"`
	State      string         `json:"state"`
	ObservedAt string         `json:"observedAt"`
	PathLabel  string         `json:"pathLabel"`
	AgentID    int            `json:"agentId,omitempty"`
}

type Tunnel struct {
	NodeID   string
	TunnelID string
	Protocol int
	Cookie   string
	Control  *websocket.Conn
}

type MeshClient interface {
	Devices(context.Context) ([]Device, error)
	Snapshot(context.Context) ([]Device, error)
	OpenTunnel(context.Context, string, string, int) (*Tunnel, error)
	RelayURL(*Tunnel) string
	PublicAsset(context.Context, string) ([]byte, error)
}

type meshClient struct {
	baseURL          *url.URL
	username         string
	passwordFile     string
	fileUsername     string
	filePasswordFile string
	httpClient       *http.Client
	metrics          metricsCache
}

func NewMeshClient(rawURL, username, passwordFile string) (MeshClient, error) {
	return NewMeshClientWithFiles(rawURL, username, passwordFile, username, passwordFile)
}

func NewMeshClientWithFiles(rawURL, username, passwordFile, fileUsername, filePasswordFile string) (MeshClient, error) {
	baseURL, err := url.Parse(strings.TrimRight(rawURL, "/"))
	if err != nil || baseURL.Host == "" || (baseURL.Scheme != "https" && baseURL.Scheme != "http") {
		return nil, fmt.Errorf("invalid MeshCentral URL")
	}
	if username == "" || passwordFile == "" || fileUsername == "" || filePasswordFile == "" {
		return nil, errors.New("MeshCentral credentials are not configured")
	}
	return &meshClient{
		baseURL:          baseURL,
		username:         username,
		passwordFile:     passwordFile,
		fileUsername:     fileUsername,
		filePasswordFile: filePasswordFile,
		httpClient:       &http.Client{Timeout: 12 * time.Second},
	}, nil
}

func (c *meshClient) controlURL() string {
	u := *c.baseURL
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/control.ashx"
	u.RawQuery = ""
	return u.String()
}

func (c *meshClient) RelayURL(tunnel *Tunnel) string {
	u := *c.baseURL
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/meshrelay.ashx"
	query := u.Query()
	query.Set("browser", "1")
	query.Set("p", strconv.Itoa(tunnel.Protocol))
	query.Set("nodeid", tunnel.NodeID)
	query.Set("id", tunnel.TunnelID)
	query.Set("auth", tunnel.Cookie)
	u.RawQuery = query.Encode()
	return u.String()
}

func (c *meshClient) PublicAsset(ctx context.Context, name string) ([]byte, error) {
	u := *c.baseURL
	u.Path = strings.TrimRight(u.Path, "/") + "/scripts/" + name
	u.RawQuery = ""
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("fetch MeshCentral public asset: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch MeshCentral public asset: HTTP %d", response.StatusCode)
	}
	return io.ReadAll(io.LimitReader(response.Body, 2<<20))
}

func (c *meshClient) dialControl(ctx context.Context, protocol int) (*websocket.Conn, error) {
	username, passwordFile := c.username, c.passwordFile
	if protocol == 5 {
		username, passwordFile = c.fileUsername, c.filePasswordFile
	}
	password, err := os.ReadFile(passwordFile)
	if err != nil {
		return nil, fmt.Errorf("read MeshCentral credential: %w", err)
	}
	defer clear(password)
	password = bytes.TrimSpace(password)
	if len(password) == 0 {
		return nil, errors.New("MeshCentral credential is empty")
	}

	encodedUser := base64.StdEncoding.EncodeToString([]byte(username))
	encodedPassword := base64.StdEncoding.EncodeToString(password)
	header := http.Header{}
	header.Set("x-meshauth", encodedUser+","+encodedPassword)
	conn, response, err := websocket.Dial(ctx, c.controlURL(), &websocket.DialOptions{
		HTTPClient: c.httpClient,
		HTTPHeader: header,
	})
	header.Del("x-meshauth")
	encodedPassword = ""
	if err != nil {
		if response != nil {
			return nil, fmt.Errorf("connect MeshCentral control channel: HTTP %d", response.StatusCode)
		}
		return nil, fmt.Errorf("connect MeshCentral control channel: %w", err)
	}
	conn.SetReadLimit(16 << 20)
	return conn, nil
}

func writeJSON(ctx context.Context, conn *websocket.Conn, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, payload)
}

type meshNode struct {
	NodeID string `json:"_id"`
	Name   string `json:"name"`
	Conn   int    `json:"conn"`
	Agent  *struct {
		ID int `json:"id"`
	} `json:"agent"`
}

type controlMessage struct {
	Action     string          `json:"action"`
	NodeID     string          `json:"nodeid"`
	ResponseID string          `json:"responseid"`
	Nodes      json.RawMessage `json:"nodes"`
	Cookie     string          `json:"cookie"`
	RCookie    string          `json:"rcookie"`
}

func readUntil(ctx context.Context, conn *websocket.Conn, action string) (controlMessage, error) {
	for {
		_, payload, err := conn.Read(ctx)
		if err != nil {
			return controlMessage{}, err
		}
		var message controlMessage
		if json.Unmarshal(payload, &message) == nil && message.Action == action {
			return message, nil
		}
	}
}

func flattenNodes(raw json.RawMessage) ([]meshNode, error) {
	var groups map[string][]meshNode
	if err := json.Unmarshal(raw, &groups); err == nil {
		var nodes []meshNode
		for _, group := range groups {
			nodes = append(nodes, group...)
		}
		return nodes, nil
	}
	var nodes []meshNode
	if err := json.Unmarshal(raw, &nodes); err != nil {
		return nil, fmt.Errorf("decode MeshCentral nodes response: %w", err)
	}
	return nodes, nil
}

func normalizeDeviceID(name string) string {
	id := strings.ToLower(strings.TrimSpace(name))
	id = strings.ReplaceAll(id, "_", "-")
	return id
}

func (c *meshClient) Devices(ctx context.Context) ([]Device, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	conn, err := c.dialControl(ctx, 2)
	if err != nil {
		return nil, err
	}
	defer conn.Close(websocket.StatusNormalClosure, "snapshot complete")

	if err := writeJSON(ctx, conn, map[string]any{"action": "nodes", "responseid": "screen-control"}); err != nil {
		return nil, fmt.Errorf("request MeshCentral nodes: %w", err)
	}
	message, err := readUntil(ctx, conn, "nodes")
	if err != nil {
		return nil, fmt.Errorf("read MeshCentral nodes: %w", err)
	}
	nodes, err := flattenNodes(message.Nodes)
	if err != nil {
		return nil, err
	}

	devices := make([]Device, 0, len(nodes))
	for _, node := range nodes {
		id := normalizeDeviceID(node.Name)
		if !remoteTargetDeviceID(id) {
			continue
		}
		platform, role := "Ubuntu", "开发机"
		if id == "echova" {
			role = "常驻服务端"
		}
		if id == "jiang-chenx" {
			platform, role = "Windows", "个人电脑"
		}
		state := "offline"
		if node.Conn&1 != 0 {
			state = "online"
		}
		agentID := 0
		if node.Agent != nil {
			agentID = node.Agent.ID
		}
		devices = append(devices, Device{
			ID: id, NodeID: node.NodeID, Name: node.Name, Platform: platform,
			Role: role, State: state, ObservedAt: "刚刚", PathLabel: "Tailscale 受限中继", AgentID: agentID,
		})
	}
	return devices, nil
}

func (c *meshClient) OpenTunnel(ctx context.Context, nodeID, tunnelID string, protocol int) (*Tunnel, error) {
	if protocol != 2 && protocol != 5 {
		return nil, errors.New("unsupported relay protocol")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	conn, err := c.dialControl(ctx, protocol)
	if err != nil {
		return nil, err
	}
	closeOnError := true
	defer func() {
		if closeOnError {
			conn.Close(websocket.StatusInternalError, "tunnel setup failed")
		}
	}()

	if err := writeJSON(ctx, conn, map[string]any{"action": "authcookie"}); err != nil {
		return nil, fmt.Errorf("request relay credential: %w", err)
	}
	message, err := readUntil(ctx, conn, "authcookie")
	if err != nil {
		return nil, fmt.Errorf("read relay credential: %w", err)
	}
	if message.Cookie == "" || message.RCookie == "" {
		return nil, errors.New("MeshCentral returned an incomplete relay credential")
	}

	relayPath := "*/meshrelay.ashx?p=" + strconv.Itoa(protocol) + "&nodeid=" + url.QueryEscape(nodeID) + "&id=" + url.QueryEscape(tunnelID) + "&rauth=" + url.QueryEscape(message.RCookie)
	command := map[string]any{
		"action": "msg", "nodeid": nodeID, "type": "tunnel", "usage": protocol,
		"value": relayPath, "responseid": "screen-control",
	}
	if err := writeJSON(ctx, conn, command); err != nil {
		return nil, fmt.Errorf("request agent desktop tunnel: %w", err)
	}
	closeOnError = false
	return &Tunnel{NodeID: nodeID, TunnelID: tunnelID, Protocol: protocol, Cookie: message.Cookie, Control: conn}, nil
}
