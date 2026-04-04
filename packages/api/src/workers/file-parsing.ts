import { Worker } from "bullmq";
import { QUEUE_NAMES } from "@synapse/shared";
import { redis } from "../infrastructure/redis/index.js";
import { registerWorker } from "./registry.js";
import { processFileParseRun } from "../modules/files/parse-service.js";

const DEFAULT_FILE_PARSE_CONCURRENCY = Math.max(
  1,
  Number(process.env.FILE_PARSE_QUEUE_CONCURRENCY || 2),
);

export function startFileParsingWorker() {
  const worker = new Worker(
    QUEUE_NAMES.FILE_PARSING,
    async (job) => {
      const runId =
        typeof job.data?.runId === "string" ? job.data.runId.trim() : "";
      if (!runId) {
        return;
      }

      await processFileParseRun(runId);
    },
    {
      connection: redis,
      concurrency: DEFAULT_FILE_PARSE_CONCURRENCY,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`File parsing job ${job?.id} failed:`, err.message);
  });

  registerWorker(worker);
}
