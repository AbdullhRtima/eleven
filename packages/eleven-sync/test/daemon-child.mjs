// A daemon in its own process, so a test can kill -9 it. Usage: node daemon-child.mjs <project> <stateDir> <root> [ackDelayMs]
const { startDaemon } = await import("../src/start.js");
const [project, stateDir, root, ackDelayMs] = process.argv.slice(2);
await startDaemon({ dir: project, stateDir, cwd: root, err: process.stderr, debounceMs: 30, poll: true, pollMs: 40, recheckMs: 0, backoff: { baseMs: 20, maxMs: 100 }, pingMs: 0, ...(ackDelayMs ? { ackDelayMs: Number(ackDelayMs) } : {}) });
process.stdout.write("UP\n");
setInterval(() => {}, 1000);
