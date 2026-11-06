// Child process for the lock race test: wait for the common start time, try to take the lock, report GOT or NO, hold it a while.
const { acquireLock } = await import("../src/lock.js");
const [file, goAt, holdMs] = process.argv.slice(2);
while (Date.now() < Number(goAt)) { /* spin to line the starts up */ }
try {
  const release = acquireLock(file);
  process.stdout.write("GOT\n");
  await new Promise((r) => setTimeout(r, Number(holdMs ?? 300)));
  release();
} catch (e) { process.stdout.write("NO " + String(e.message).slice(0, 40) + "\n"); }
