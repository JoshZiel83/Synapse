package relayipc

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"sync"
)

type Handler func(context.Context, string, json.RawMessage) (interface{}, *RPCError)

type Server struct {
	address      string
	expectedAuth HelloParams
	agentVersion string
	handler      Handler

	listener net.Listener

	mu    sync.RWMutex
	conns map[*serverConn]struct{}
}

type serverConn struct {
	conn net.Conn
	enc  *json.Encoder
	mu   sync.Mutex
}

func NewServer(address string, expectedAuth HelloParams, agentVersion string, handler Handler) *Server {
	return &Server{
		address:      address,
		expectedAuth: expectedAuth,
		agentVersion: agentVersion,
		handler:      handler,
		conns:        make(map[*serverConn]struct{}),
	}
}

func (s *Server) Start(ctx context.Context) error {
	ln, err := listen(s.address)
	if err != nil {
		return err
	}
	s.listener = ln

	go func() {
		<-ctx.Done()
		_ = s.Close()
	}()

	go s.acceptLoop(ctx)
	return nil
}

func (s *Server) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for conn := range s.conns {
		_ = conn.conn.Close()
		delete(s.conns, conn)
	}

	if s.listener != nil {
		err := s.listener.Close()
		s.listener = nil
		return err
	}
	return nil
}

func (s *Server) Notify(method string, params interface{}) {
	payload, err := json.Marshal(params)
	if err != nil {
		return
	}

	msg := Message{
		JSONRPC: jsonRPCVersion,
		Method:  method,
		Params:  payload,
	}

	s.mu.RLock()
	conns := make([]*serverConn, 0, len(s.conns))
	for conn := range s.conns {
		conns = append(conns, conn)
	}
	s.mu.RUnlock()

	for _, conn := range conns {
		_ = conn.writeMessage(msg)
	}
}

func (s *Server) acceptLoop(ctx context.Context) {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		go s.serveConn(ctx, conn)
	}
}

func (s *Server) serveConn(ctx context.Context, rawConn net.Conn) {
	conn := &serverConn{
		conn: rawConn,
		enc:  json.NewEncoder(rawConn),
	}
	decoder := json.NewDecoder(rawConn)

	var hello Message
	if err := decoder.Decode(&hello); err != nil {
		_ = rawConn.Close()
		return
	}
	if hello.Method != "hello" || hello.ID == "" {
		_ = rawConn.Close()
		return
	}

	var helloParams HelloParams
	if err := json.Unmarshal(hello.Params, &helloParams); err != nil {
		_ = conn.writeMessage(errorMessage(hello.ID, -32602, "invalid hello params"))
		_ = rawConn.Close()
		return
	}
	if strings.TrimSpace(helloParams.Token) != strings.TrimSpace(s.expectedAuth.Token) ||
		strings.TrimSpace(helloParams.ProfileID) != strings.TrimSpace(s.expectedAuth.ProfileID) {
		_ = conn.writeMessage(errorMessage(hello.ID, -32001, "unauthorized"))
		_ = rawConn.Close()
		return
	}

	_ = conn.writeMessage(resultMessage(hello.ID, HelloResult{
		AgentVersion: s.agentVersion,
		ProfileID:    s.expectedAuth.ProfileID,
	}))

	s.mu.Lock()
	s.conns[conn] = struct{}{}
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		delete(s.conns, conn)
		s.mu.Unlock()
		_ = rawConn.Close()
	}()

	for {
		var msg Message
		if err := decoder.Decode(&msg); err != nil {
			return
		}
		if msg.Method == "" || msg.ID == "" {
			continue
		}

		go func(msg Message) {
			result, rpcErr := s.handler(ctx, msg.Method, msg.Params)
			if rpcErr != nil {
				_ = conn.writeMessage(errorMessage(msg.ID, rpcErr.Code, rpcErr.Message))
				return
			}
			_ = conn.writeMessage(resultMessage(msg.ID, result))
		}(msg)
	}
}

func resultMessage(id string, result interface{}) Message {
	payload, _ := json.Marshal(result)
	return Message{
		JSONRPC: jsonRPCVersion,
		ID:      id,
		Result:  payload,
	}
}

func errorMessage(id string, code int, message string) Message {
	return Message{
		JSONRPC: jsonRPCVersion,
		ID:      id,
		Error: &RPCError{
			Code:    code,
			Message: message,
		},
	}
}

func (c *serverConn) writeMessage(msg Message) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.enc.Encode(msg); err != nil {
		return fmt.Errorf("write relay IPC message: %w", err)
	}
	return nil
}
