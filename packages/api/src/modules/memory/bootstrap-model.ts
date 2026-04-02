import { closeDatabasePool } from '../../infrastructure/database/index.js';
import { shutdownRedisConnections } from '../../infrastructure/redis/index.js';
import { warmMemoryEmbeddingRuntime, shutdownMemoryEmbeddingRuntime } from './embedding-runtime.js';

async function main() {
  try {
    await warmMemoryEmbeddingRuntime({ allowRemoteModels: true });
    console.log('Memory embedding model bootstrapped successfully');
  } finally {
    await Promise.allSettled([
      shutdownMemoryEmbeddingRuntime(),
      shutdownRedisConnections(),
      closeDatabasePool(),
    ]);
  }
}

main().catch((error) => {
  console.error('Failed to bootstrap memory embedding model:', error);
  process.exit(1);
});
