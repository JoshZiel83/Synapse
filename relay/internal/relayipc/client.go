package relayipc

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
)

type notificationHandler func(json.RawMessage)

type Client struct {
	conn net.Conn

	encMu sync.Mutex

	handlersMu sync.RWMutex
	handlers   map[string][]notificationHandler

	pendingMu sync.Mutex
	pending   map[string]chan Message

	closed chan struct{}
	nextID atomic.Uint64
}

func Dial(ctx context.Context, address string, hello HelloParams) (*Client, error) {
	conn, err := dial(ctx, address)
	if err != nil {
		return nil, err
	}

	client := &Client{
		conn:     conn,
		handlers: make(map[string][]notificationHandler),
		pending:  make(map[string]chan Message),
		closed:   make(chan struct{}),
	}
	go client.readLoop()

	var helloResult HelloResult
	if err := client.Call(ctx, "hello", hello, &helloResult); err != nil {
		_ = client.Close()
		return nil, err
	}
	return client, nil
}

func (c *Client) Close() error {
	select {
	case <-c.closed:
	default:
		close(c.closed)
	}
	if c.conn != nil {
		return c.conn.Close()
	}
	return nil
}

func (c *Client) Call(ctx context.Context, method string, params interface{}, result interface{}) error {
	id := strconv.FormatUint(c.nextID.Add(1), 10)
	waitCh := make(chan Message, 1)

	c.pendingMu.Lock()
	c.pending[id] = waitCh
	c.pendingMu.Unlock()

	defer func() {
		c.pendingMu.Lock()
		delete(c.pending, id)
		c.pendingMu.Unlock()
	}()

	payload, err := json.Marshal(params)
	if err != nil {
		return err
	}

	if err := c.writeMessage(Message{
		JSONRPC: jsonRPCVersion,
		ID:      id,
		Method:  method,
		Params:  payload,
	}); err != nil {
		return err
	}

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-c.closed:
		return fmt.Errorf("relay IPC connection closed")
	case msg := <-waitCh:
		if msg.Error != nil {
			return msg.Error
		}
		if result == nil || len(msg.Result) == 0 {
			return nil
		}
		return json.Unmarshal(msg.Result, result)
	}
}

func (c *Client) OnNotification(method string, handler func(json.RawMessage)) {
	if handler == nil {
		return
	}
	c.handlersMu.Lock()
	c.handlers[method] = append(c.handlers[method], handler)
	c.handlersMu.Unlock()
}

func (c *Client) readLoop() {
	decoder := json.NewDecoder(c.conn)
	for {
		var msg Message
		if err := decoder.Decode(&msg); err != nil {
			_ = c.Close()
			return
		}

		if msg.ID != "" && (len(msg.Result) > 0 || msg.Error != nil) {
			c.pendingMu.Lock()
			waitCh := c.pending[msg.ID]
			c.pendingMu.Unlock()
			if waitCh != nil {
				waitCh <- msg
			}
			continue
		}

		if msg.Method == "" || msg.ID != "" {
			continue
		}

		c.handlersMu.RLock()
		handlers := append([]notificationHandler(nil), c.handlers[msg.Method]...)
		c.handlersMu.RUnlock()
		for _, handler := range handlers {
			handler(msg.Params)
		}
	}
}

func (c *Client) writeMessage(msg Message) error {
	c.encMu.Lock()
	defer c.encMu.Unlock()
	return json.NewEncoder(c.conn).Encode(msg)
}
