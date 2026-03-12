import type { Worker } from 'bullmq';

const workers = new Set<Worker>();

export function registerWorker(worker: Worker) {
  workers.add(worker);
  worker.on('closed', () => {
    workers.delete(worker);
  });
}

export async function shutdownAllWorkers() {
  const currentWorkers = Array.from(workers);
  workers.clear();
  await Promise.allSettled(currentWorkers.map((worker) => worker.close()));
}
