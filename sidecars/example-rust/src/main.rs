use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{self, BufRead, Read, Write};

#[derive(Debug, Deserialize)]
struct Request {
    jsonrpc: String,
    id: Option<u64>,
    method: String,
    params: Option<Value>,
}

#[derive(Debug, Serialize)]
struct Response {
    jsonrpc: &'static str,
    id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorObject>,
}

#[derive(Debug, Serialize)]
struct ErrorObject {
    code: i32,
    message: String,
}

fn sha256_file(path: &str) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];

    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let raw = match line {
            Ok(v) => v,
            Err(_) => continue,
        };

        let request: Request = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("invalid request: {e}");
                continue;
            }
        };

        let id = request.id.unwrap_or(0);
        if request.jsonrpc != "2.0" {
            let response = Response {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(ErrorObject {
                    code: -32600,
                    message: "invalid jsonrpc version".to_string(),
                }),
            };
            let _ = writeln!(stdout, "{}", serde_json::to_string(&response).unwrap());
            let _ = stdout.flush();
            continue;
        }

        let response = match request.method.as_str() {
            "health" => Response {
                jsonrpc: "2.0",
                id,
                result: Some(json!({ "status": "ok" })),
                error: None,
            },
            "echo" => Response {
                jsonrpc: "2.0",
                id,
                result: Some(json!({ "echo": request.params.unwrap_or(json!({})) })),
                error: None,
            },
            "hash_file" => {
                let path = request
                    .params
                    .as_ref()
                    .and_then(|p| p.get("path"))
                    .and_then(|v| v.as_str());

                match path {
                    Some(p) => match sha256_file(p) {
                        Ok(hash) => Response {
                            jsonrpc: "2.0",
                            id,
                            result: Some(json!({ "sha256": hash })),
                            error: None,
                        },
                        Err(e) => Response {
                            jsonrpc: "2.0",
                            id,
                            result: None,
                            error: Some(ErrorObject {
                                code: -32000,
                                message: format!("hash_file failed: {e}"),
                            }),
                        },
                    },
                    None => Response {
                        jsonrpc: "2.0",
                        id,
                        result: None,
                        error: Some(ErrorObject {
                            code: -32602,
                            message: "missing path".to_string(),
                        }),
                    },
                }
            }
            "shutdown" => {
                let response = Response {
                    jsonrpc: "2.0",
                    id,
                    result: Some(json!({ "ok": true })),
                    error: None,
                };
                let _ = writeln!(stdout, "{}", serde_json::to_string(&response).unwrap());
                let _ = stdout.flush();
                break;
            }
            _ => Response {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(ErrorObject {
                    code: -32601,
                    message: "method not found".to_string(),
                }),
            },
        };

        let _ = writeln!(stdout, "{}", serde_json::to_string(&response).unwrap());
        let _ = stdout.flush();
    }
}
