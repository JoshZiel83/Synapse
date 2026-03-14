package localapi

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const DefaultPort = 21519

type PairingRequest struct {
	ServerBaseURL string `json:"serverBaseUrl"`
	PairingCode   string `json:"pairingCode"`
	DisplayName   string `json:"displayName,omitempty"`
}

type PairingResponse struct {
	Accepted bool   `json:"accepted"`
	Message  string `json:"message,omitempty"`
}

type StatusSnapshot struct {
	Relay                 string `json:"relay,omitempty"`
	Paired                bool   `json:"paired"`
	ServerIdentityPinned  bool   `json:"serverIdentityPinned,omitempty"`
	AuthFailureCode       string `json:"authFailureCode,omitempty"`
	AuthFailureMessage    string `json:"authFailureMessage,omitempty"`
	AuthFailurePermanent  bool   `json:"authFailurePermanent,omitempty"`
	DeviceID              string `json:"deviceId,omitempty"`
	DisplayName           string `json:"displayName,omitempty"`
	ServerBaseURL         string `json:"serverBaseUrl,omitempty"`
	WebSocketURL          string `json:"websocketUrl,omitempty"`
	PublicKeyFingerprint  string `json:"publicKeyFingerprint,omitempty"`
	ServerTLSPublicKeyPin string `json:"serverTlsPublicKeyPin,omitempty"`
}

type StatusResponse struct {
	Status  string `json:"status"`
	Version string `json:"version"`
	StatusSnapshot
}

type PairingHandler func(serverBaseURL, pairingCode, displayName string) bool
type StatusProvider func() StatusSnapshot

type Server struct {
	port           int
	version        string
	onPairing      PairingHandler
	statusProvider StatusProvider
	httpServer     *http.Server
	mu             sync.Mutex
}

func New(port int, version string, onPairing PairingHandler, statusProvider StatusProvider) *Server {
	return &Server{
		port:           port,
		version:        version,
		onPairing:      onPairing,
		statusProvider: statusProvider,
	}
}

func (s *Server) Start() error {
	mux := http.NewServeMux()
	mux.HandleFunc("/ping", s.handlePing)
	mux.HandleFunc("/status", s.handleStatus)
	mux.HandleFunc("/pairing", s.handlePairing)

	s.httpServer = &http.Server{
		Addr:    fmt.Sprintf("127.0.0.1:%d", s.port),
		Handler: corsMiddleware(mux),
	}

	ln, err := net.Listen("tcp", s.httpServer.Addr)
	if err != nil {
		return fmt.Errorf("local API listen: %w", err)
	}

	go func() {
		log.Printf("Local API listening on http://127.0.0.1:%d", s.port)
		if err := s.httpServer.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("Local API server error: %v", err)
		}
	}()

	return nil
}

func (s *Server) Stop() {
	if s.httpServer != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = s.httpServer.Shutdown(ctx)
	}
}

func (s *Server) handlePing(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	writeJSON(w, StatusResponse{
		Status:  "ok",
		Version: s.version,
	})
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	snapshot := StatusSnapshot{Relay: "unknown"}
	if s.statusProvider != nil {
		snapshot = s.statusProvider()
	}
	if !allowTrustedStatusOrigin(strings.TrimSpace(r.Header.Get("Origin")), snapshot.ServerBaseURL) {
		snapshot = publicStatusSnapshot(snapshot)
	}

	writeJSON(w, StatusResponse{
		Status:         "ok",
		Version:        s.version,
		StatusSnapshot: snapshot,
	})
}

func (s *Server) handlePairing(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req PairingRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	if strings.TrimSpace(req.ServerBaseURL) == "" || strings.TrimSpace(req.PairingCode) == "" {
		writeJSON(w, PairingResponse{Accepted: false, Message: "serverBaseUrl and pairingCode are required"})
		return
	}
	if !allowPairingOrigin(strings.TrimSpace(r.Header.Get("Origin")), req.ServerBaseURL) {
		writeJSONStatus(w, http.StatusForbidden, PairingResponse{
			Accepted: false,
			Message:  "pairing origin must match serverBaseUrl",
		})
		return
	}

	s.mu.Lock()
	accepted := false
	if s.onPairing != nil {
		accepted = s.onPairing(req.ServerBaseURL, req.PairingCode, req.DisplayName)
	}
	s.mu.Unlock()

	if accepted {
		writeJSON(w, PairingResponse{Accepted: true, Message: "Pairing accepted"})
		return
	}

	writeJSON(w, PairingResponse{Accepted: false, Message: "User rejected the pairing"})
}

func writeJSON(w http.ResponseWriter, v interface{}) {
	writeJSONStatus(w, http.StatusOK, v)
}

func writeJSONStatus(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := strings.TrimSpace(r.Header.Get("Origin")); allowOrigin(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func allowOrigin(origin string) bool {
	_, ok := parseAllowedOrigin(origin)
	return ok
}

func allowPairingOrigin(origin, serverBaseURL string) bool {
	if origin == "" {
		return true
	}

	parsedOrigin, ok := parseAllowedOrigin(origin)
	if !ok {
		return false
	}
	if isLoopbackHost(parsedOrigin.Hostname()) {
		return true
	}
	return sameOrigin(parsedOrigin, serverBaseURL)
}

func allowTrustedStatusOrigin(origin, serverBaseURL string) bool {
	if origin == "" {
		return false
	}

	parsedOrigin, ok := parseAllowedOrigin(origin)
	if !ok {
		return false
	}
	if isLoopbackHost(parsedOrigin.Hostname()) {
		return true
	}
	return sameOrigin(parsedOrigin, serverBaseURL)
}

func publicStatusSnapshot(snapshot StatusSnapshot) StatusSnapshot {
	return StatusSnapshot{
		Relay:                snapshot.Relay,
		Paired:               snapshot.Paired,
		ServerIdentityPinned: snapshot.ServerIdentityPinned,
		AuthFailureCode:      snapshot.AuthFailureCode,
		AuthFailureMessage:   snapshot.AuthFailureMessage,
		AuthFailurePermanent: snapshot.AuthFailurePermanent,
		DisplayName:          snapshot.DisplayName,
		ServerBaseURL:        snapshot.ServerBaseURL,
	}
}

func parseAllowedOrigin(origin string) (*url.URL, bool) {
	if origin == "" {
		return nil, false
	}

	parsed, err := url.Parse(origin)
	if err != nil {
		return nil, false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, false
	}
	if parsed.Host == "" {
		return nil, false
	}
	return parsed, true
}

func sameOrigin(origin *url.URL, serverBaseURL string) bool {
	serverURL, err := url.Parse(strings.TrimSpace(serverBaseURL))
	if err != nil || serverURL.Scheme == "" || serverURL.Host == "" {
		return false
	}
	return strings.EqualFold(origin.Scheme, serverURL.Scheme) &&
		strings.EqualFold(origin.Hostname(), serverURL.Hostname()) &&
		effectivePort(origin) == effectivePort(serverURL)
}

func effectivePort(u *url.URL) string {
	if port := u.Port(); port != "" {
		return port
	}
	if strings.EqualFold(u.Scheme, "https") {
		return "443"
	}
	if strings.EqualFold(u.Scheme, "http") {
		return "80"
	}
	return ""
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
