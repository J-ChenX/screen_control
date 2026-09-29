package g0bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"screencontrol.local/screen-control/internal/g0files"
)

type fileChannel interface {
	Relay(context.Context, *websocket.Conn) error
	Close()
}
type fileOpener func(context.Context, Device) (fileChannel, error)

// 现有浏览器适配器会在协议号之前发送 RTT 控制消息，数字和字符串形式均可。
func fileControlMessage(data []byte) bool {
	var control struct {
		Channel json.RawMessage `json:"ctrlChannel"`
	}
	return json.Unmarshal(data, &control) == nil && (string(control.Channel) == "102938" || string(control.Channel) == `"102938"`)
}

var fileTargetPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+@[A-Za-z0-9_.:-]+$`)

// ConfigureFiles 固定设备到普通 SSH 账号的映射；文件操作永不回退到高权限 MeshAgent。
func (s *Server) ConfigureFiles(value string) error {
	targets := map[string]string{}
	for _, entry := range strings.Split(value, ",") {
		if strings.TrimSpace(entry) == "" {
			continue
		}
		id, target, ok := strings.Cut(strings.TrimSpace(entry), "=")
		if !ok || !remoteTargetDeviceID(id) || !fileTargetPattern.MatchString(target) || strings.EqualFold(strings.SplitN(target, "@", 2)[0], "root") || targets[id] != "" {
			return errors.New("文件 SSH 配置无效：必须使用登记设备及非 root 账号")
		}
		targets[id] = target
	}
	s.fileOpen = func(ctx context.Context, device Device) (fileChannel, error) {
		target := targets[device.ID]
		if target == "" {
			return nil, errors.New("未配置该设备的普通用户文件通道")
		}
		return openFileProcess(ctx, target, device.ID == "jiang-chenx")
	}
	return nil
}

type fileProcess struct {
	input  io.WriteCloser
	output io.ReadCloser
	cancel context.CancelFunc
	done   chan struct{}
	once   sync.Once
}

func openFileProcess(ctx context.Context, target string, windows bool) (fileChannel, error) {
	command := `exec "$HOME/.local/lib/screen-control-files/current/screen-control-files"`
	if windows {
		command = `"%USERPROFILE%\.local\lib\screen-control-files\current\screen-control-files.exe"`
	}
	lifetime, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(lifetime, "ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ClearAllForwardings=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "--", target, command)
	input, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		cancel()
		return nil, err
	}
	// 不将 SSH 的账号、目标地址或命令行输出到浏览器和业务日志。
	cmd.Stderr = io.Discard
	if err = cmd.Start(); err != nil {
		input.Close()
		output.Close()
		cancel()
		return nil, errors.New("无法启动普通用户文件通道")
	}
	process := &fileProcess{input: input, output: output, cancel: cancel, done: make(chan struct{})}
	go func() { _ = cmd.Wait(); close(process.done) }()
	ready := make(chan error, 1)
	go func() {
		data, e := g0files.ReadFrame(output)
		if e == nil {
			var hello struct {
				Action  string `json:"action"`
				Version int    `json:"version"`
				UID     string `json:"uid"`
			}
			e = json.Unmarshal(data, &hello)
			if e == nil && (hello.Action != "workerReady" || hello.Version != 1 || hello.UID == "" || hello.UID == "0" || (strings.EqualFold(hello.UID, "S-1-5-18") || strings.EqualFold(hello.UID, "S-1-5-19") || strings.EqualFold(hello.UID, "S-1-5-20"))) {
				e = errors.New("文件进程身份或版本无效")
			}
		}
		ready <- e
	}()
	timer := time.NewTimer(12 * time.Second)
	defer timer.Stop()
	select {
	case err = <-ready:
	case <-ctx.Done():
		err = ctx.Err()
	case <-timer.C:
		err = errors.New("文件通道启动超时")
	}
	if err != nil {
		process.Close()
		return nil, errors.New("普通用户文件通道不可用，请检查账号、主机密钥及文件进程安装")
	}
	return process, nil
}
func (p *fileProcess) Close() {
	p.once.Do(func() {
		_ = p.input.Close()
		// 先让 EOF 触发远端临时文件清理，再终止未退出的 SSH 子进程。
		timer := time.NewTimer(time.Second)
		select {
		case <-p.done:
		case <-timer.C:
		}
		timer.Stop()
		p.cancel()
		_ = p.output.Close()
		<-p.done
	})
}
func (p *fileProcess) Relay(ctx context.Context, client *websocket.Conn) error {
	// 在桥接入口即应用文件协议帧限，避免先按桌面上限分配再被工作进程拒绝。
	client.SetReadLimit(g0files.MaxFrameSize)
	if err := client.Write(ctx, websocket.MessageText, []byte("c")); err != nil {
		return err
	}
	handshake, cancel := context.WithTimeout(ctx, 10*time.Second)
	var data []byte
	var err error
	for {
		_, data, err = client.Read(handshake)
		if err != nil || !fileControlMessage(data) {
			break
		}
	}
	cancel()
	if err != nil {
		return err
	}
	if string(data) != "5" {
		return errors.New("只允许文件协议")
	}
	results := make(chan error, 3)
	go func() {
		for {
			_, data, e := client.Read(ctx)
			if e == nil && fileControlMessage(data) {
				continue
			}
			if e == nil {
				e = g0files.WriteFrame(p.input, data)
			}
			if e != nil {
				results <- e
				return
			}
		}
	}()
	go func() {
		reader := g0files.NewFrameReader(p.output)
		for {
			data, e := reader.Read()
			if e == nil {
				// Write 返回后才读取下一帧，避免复用仍在发送中的字节。
				e = client.Write(ctx, websocket.MessageBinary, data)
			}
			if e != nil {
				results <- e
				return
			}
		}
	}()
	go func() {
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				ping, cancel := context.WithTimeout(ctx, 10*time.Second)
				e := client.Ping(ping)
				cancel()
				if e != nil {
					results <- fmt.Errorf("文件客户端断开: %w", e)
					return
				}
			}
		}
	}()
	return <-results
}
