package localapi

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"time"
)

const DefaultPort = 21519

// SetupRequest is sent by the web UI to push config to the client
type SetupRequest struct {
	Endpoint string `json:"endpoint"`
	Token    string `json:"token"`
}

// SetupResponse is returned after the user confirms/rejects
type SetupResponse struct {
	Accepted bool   `json:"accepted"`
	Message  string `json:"message,omitempty"`
}

// StatusResponse is returned by GET /status
type StatusResponse struct {
	Status  string `json:"status"` // "ok"
	Version string `json:"version"`
	Relay   string `json:"relay,omitempty"` // relay state: "stopped","running",etc
}

// SetupHandler is called when a setup request arrives. It should present a
// confirmation dialog to the user and return true if accepted.
type SetupHandler func(endpoint, token string) bool

// StatusProvider returns the current relay state string.
type StatusProvider func() string

// Server runs a local HTTP API on localhost for web-to-client communication.
type Server struct {
	port           int
	version        string
	onSetup        SetupHandler
	statusProvider StatusProvider
	httpServer     *http.Server
	mu             sync.Mutex
}

// New creates a local API server.
func New(port int, version string, onSetup SetupHandler, statusProvider StatusProvider) *Server {
	return &Server{
		port:           port,
		version:        version,
		onSetup:        onSetup,
		statusProvider: statusProvider,
	}
}

// Start begins listening on localhost:port.
func (s *Server) Start() error {
	mux := http.NewServeMux()
	mux.HandleFunc("/ping", s.handlePing)
	mux.HandleFunc("/setup", s.handleSetup)
	mux.HandleFunc("/status", s.handleStatus)

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

// Stop gracefully shuts down the server.
func (s *Server) Stop() {
	if s.httpServer != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		s.httpServer.Shutdown(ctx)
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
	relayState := "unknown"
	if s.statusProvider != nil {
		relayState = s.statusProvider()
	}
	writeJSON(w, StatusResponse{
		Status:  "ok",
		Version: s.version,
		Relay:   relayState,
	})
}

func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req SetupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	if req.Endpoint == "" || req.Token == "" {
		writeJSON(w, SetupResponse{Accepted: false, Message: "endpoint and token are required"})
		return
	}

	// Serialize setup requests — only one confirmation dialog at a time
	s.mu.Lock()
	accepted := false
	if s.onSetup != nil {
		accepted = s.onSetup(req.Endpoint, req.Token)
	}
	s.mu.Unlock()

	if accepted {
		writeJSON(w, SetupResponse{Accepted: true, Message: "Configuration saved"})
	} else {
		writeJSON(w, SetupResponse{Accepted: false, Message: "User rejected the configuration"})
	}
}

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
