// In-memory ring buffer of the server's own output, served to the LOG tab.
// Lines are captured from the app's stdout/stderr writes.
const MAX_LINES = 1000;
const lines = [];

export function pushLogLine(raw, stream = "stdout") {
  let text = "";
  try { text = String(raw || ""); } catch { return; }
  for (const chunk of text.split("\n")) {
    if (chunk.trim() === "" && lines[lines.length - 1]?.text?.trim() === "") continue;
    lines.push({ at: Date.now(), stream, text: chunk });
    if (lines.length > MAX_LINES) lines.shift();
  }
}

const originalWrite = process.stdout.write.bind(process.stdout);
const originalWriteErr = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk, ...rest) => {
  pushLogLine(chunk, "stdout");
  return originalWrite(chunk, ...rest);
};
process.stderr.write = (chunk, ...rest) => {
  pushLogLine(chunk, "stderr");
  return originalWriteErr(chunk, ...rest);
};

export function getLogLines({ limit = 300, since = null } = {}) {
  const max = Math.max(10, Math.min(1000, Number(limit) || 300));
  let start = 0;
  if (since) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].at <= since) { start = i + 1; break; }
    }
  }
  return lines.slice(Math.max(start, lines.length - max)).map((l) => ({ ...l }));
}

export default { pushLogLine, getLogLines };