// CubeSandbox wire client — the transport for the `cubesandbox:bare` provider.
//
// Two planes:
//   - {@link CubeControlClient}: E2B-compatible REST lifecycle (create / getInfo
//     / kill / setTimeout / health).
//   - {@link CubeEnvdClient}: envd data plane over CubeProxy (exec, byte-file
//     read/write, unary filesystem RPCs) using Host-header vhost routing.
//   - connect-codec: the Connect envelope framing envd speaks (encode/decode +
//     streaming reader).

export * from "./types.js"
export * from "./connect-codec.js"
export { CubeControlClient } from "./control-client.js"
export { CubeEnvdClient } from "./envd-client.js"
