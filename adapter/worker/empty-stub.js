// Stub for packages referenced by the compiled Catalyst bundle but never installed
// (OpenTelemetry / gRPC). Those code paths are guarded and never execute on the Worker;
// this just lets the bundler resolve the specifiers.
export default {}
