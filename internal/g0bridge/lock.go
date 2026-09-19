package g0bridge

import (
	"context"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

// handleLockExit 仅向当前调用方已建立的桌面中继发送固定锁屏指令。
// MeshAgent 没有提供锁屏完成回执，写入成功也只能报告结果未知。
func (s *Server) handleLockExit(w http.ResponseWriter, r *http.Request) {
	reqID := requestID()
	deviceID, authorized := s.resolveDevice(w, r, reqID)
	if !authorized {
		return
	}
	sessionID := r.PathValue("sessionID")
	value, ok := s.sessions.Load(sessionID)
	if !ok {
		s.writeError(w, http.StatusGone, reqID, "SESSION_ENDED", "桌面连接已结束，未发送锁屏请求")
		return
	}
	session := value.(*desktopSession)
	if session.owner != sessionOwner(r, deviceID) {
		s.writeError(w, http.StatusForbidden, reqID, "SESSION_NOT_OWNED", "不能锁定其他登录会话的桌面")
		return
	}
	session.mu.Lock()
	if session.closed || session.lockRequested || session.files != nil || session.tunnel == nil || session.tunnel.Protocol != 2 || session.upstream == nil {
		session.mu.Unlock()
		s.writeError(w, http.StatusConflict, reqID, "DESKTOP_NOT_ACTIVE", "桌面中继不可用，未发送锁屏请求")
		return
	}
	session.lockRequested = true
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	err := session.upstream.Write(ctx, websocket.MessageText, []byte(`{"ctrlChannel":"102938","type":"lock"}`))
	cancel()
	session.mu.Unlock()
	s.sessions.Delete(sessionID)
	s.closeSession(session, websocket.StatusNormalClosure, "用户锁屏并结束连接")
	if err != nil {
		s.writeError(w, http.StatusBadGateway, reqID, "LOCK_RESULT_UNKNOWN", "无法确认锁屏请求是否送达")
		return
	}
	s.writeJSON(w, http.StatusOK, reqID, map[string]any{
		"desktopSessionId": sessionID, "state": "ended",
		"lock": map[string]string{"status": "unknown", "observedAt": time.Now().UTC().Format(time.RFC3339), "recoveryAction": "请检查目标电脑是否已锁屏"},
	}, nil)
}
