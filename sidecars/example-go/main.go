package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int            `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type errorObject struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type response struct {
	JSONRPC string       `json:"jsonrpc"`
	ID      int          `json:"id"`
	Result  interface{}  `json:"result,omitempty"`
	Error   *errorObject `json:"error,omitempty"`
}

func writeResponse(w *bufio.Writer, resp response) {
	payload, err := json.Marshal(resp)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to marshal response: %v\n", err)
		return
	}
	_, _ = w.WriteString(string(payload) + "\n")
	_ = w.Flush()
}

func countWords(path string) (int, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	parts := strings.Fields(string(data))
	return len(parts), nil
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	writer := bufio.NewWriter(os.Stdout)

	for scanner.Scan() {
		line := scanner.Text()
		var req request
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			fmt.Fprintf(os.Stderr, "invalid request: %v\n", err)
			continue
		}

		id := 0
		if req.ID != nil {
			id = *req.ID
		}

		if req.JSONRPC != "2.0" {
			writeResponse(writer, response{
				JSONRPC: "2.0",
				ID:      id,
				Error: &errorObject{
					Code:    -32600,
					Message: "invalid jsonrpc version",
				},
			})
			continue
		}

		switch req.Method {
		case "health":
			writeResponse(writer, response{JSONRPC: "2.0", ID: id, Result: map[string]string{"status": "ok"}})
		case "echo":
			var params map[string]interface{}
			if err := json.Unmarshal(req.Params, &params); err != nil {
				params = map[string]interface{}{}
			}
			writeResponse(writer, response{JSONRPC: "2.0", ID: id, Result: map[string]interface{}{"echo": params}})
		case "count_words":
			var params struct {
				Path string `json:"path"`
			}
			if err := json.Unmarshal(req.Params, &params); err != nil || params.Path == "" {
				writeResponse(writer, response{
					JSONRPC: "2.0",
					ID:      id,
					Error:   &errorObject{Code: -32602, Message: "missing path"},
				})
				continue
			}

			count, err := countWords(params.Path)
			if err != nil {
				writeResponse(writer, response{
					JSONRPC: "2.0",
					ID:      id,
					Error:   &errorObject{Code: -32000, Message: err.Error()},
				})
				continue
			}

			writeResponse(writer, response{JSONRPC: "2.0", ID: id, Result: map[string]int{"count": count}})
		case "shutdown":
			writeResponse(writer, response{JSONRPC: "2.0", ID: id, Result: map[string]bool{"ok": true}})
			return
		default:
			writeResponse(writer, response{
				JSONRPC: "2.0",
				ID:      id,
				Error:   &errorObject{Code: -32601, Message: "method not found"},
			})
		}
	}

	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "scanner error: %v\n", err)
	}
}
