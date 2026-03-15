package chrome

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type initializeRequest struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      int         `json:"id"`
	Method  string      `json:"method"`
	Params  interface{} `json:"params"`
}

type initializeResult struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      int         `json:"id"`
	Result  interface{} `json:"result"`
	Error   *rpcError   `json:"error,omitempty"`
}

type toolsListRequest struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      int         `json:"id"`
	Method  string      `json:"method"`
	Params  interface{} `json:"params,omitempty"`
}

type toolDefinition struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	Parameters  interface{} `json:"parameters,omitempty"`
	InputSchema interface{} `json:"inputSchema,omitempty"`
}

type toolsListResult struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Result  struct {
		Tools []toolDefinition `json:"tools"`
	} `json:"result"`
	Error *rpcError `json:"error,omitempty"`
}

type toolCallRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  struct {
		Name      string                 `json:"name"`
		Arguments map[string]interface{} `json:"arguments,omitempty"`
	} `json:"params"`
}

type toolCallResult struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Result  struct {
		Content           []interface{} `json:"content"`
		StructuredContent interface{}   `json:"structuredContent,omitempty"`
		IsError           bool          `json:"isError,omitempty"`
	} `json:"result"`
	Error *rpcError `json:"error,omitempty"`
}

type notificationMessage struct {
	JSONRPC string      `json:"jsonrpc"`
	Method  string      `json:"method"`
	Params  interface{} `json:"params,omitempty"`
}
