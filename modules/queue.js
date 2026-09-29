import { getJob } from "./store.js";
import { parseConcurrency } from "./concurrency.js";

const jobQueue = [];
let runningCount = 0;

// 并发下载数：环境变量 DOWNLOAD_CONCURRENCY（1–16，默认 3）。
// 之前是单进程串行（一次只下一个），番剧/合集批量下载非常慢。
const MAX_CONCURRENT = parseConcurrency(process.env.DOWNLOAD_CONCURRENCY, 3);

// Handles enqueue job state in core application logic.
export function enqueueJob(jobId, fn) {
  jobQueue.push({ jobId, fn });
  runQueue();
}

// Returns queued job state ids used for core application logic.
export function getQueuedJobIds() {
  return jobQueue.map(j => j.jobId);
}

// Removes from queue from core application logic.
export function removeFromQueue(jobId) {
  for (let i = jobQueue.length - 1; i >= 0; i--) {
    if (jobQueue[i].jobId === jobId) {
      jobQueue.splice(i, 1);
    }
  }
}

// 当前并发下 Activity job 数（仅排队的，不含正在跑的）。
export function getQueuedJobCount() {
  return jobQueue.length;
}

// Runs queue: up to MAX_CONCURRENT jobs run in parallel; each drained job
// starts immediately while workers free up (no head-of-line blocking).
async function runQueue() {
  while (runningCount < MAX_CONCURRENT && jobQueue.length > 0) {
    const { jobId, fn } = jobQueue.shift();
    const job = getJob(jobId);
    if (!job || job.status === "canceled" || job.canceled) {
      continue;
    }
    runningCount += 1;
    // 一个 worker：跑完当前任务后继续领下一个（fire-and-forget）。
    (async () => {
      try {
        await fn();
      } catch (err) {
        console.error(`[queue] Job ${jobId} hata:`, err);
      } finally {
        runningCount -= 1;
        runQueue();
      }
    })();
  }
}
