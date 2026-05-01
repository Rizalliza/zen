'use strict';

async function processInBatches(items, worker, options = {}) {
  const batchSize = Math.max(1, Number(options.batchSize || items.length || 1));
  const delayMs = Math.max(0, Number(options.delayMs || 0));
  const onBatchComplete = typeof options.onBatchComplete === 'function' ? options.onBatchComplete : null;
  const results = [];

  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);
    const batchResults = await Promise.all(batch.map((item, index) => worker(item, start + index)));
    results.push(...batchResults);

    if (onBatchComplete) {
      await onBatchComplete({
        batchStart: start,
        batchEnd: Math.min(start + batch.length, items.length),
        total: items.length,
        batchSize: batch.length,
        results: batchResults,
      });
    }

    if (delayMs > 0 && start + batchSize < items.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return results;
}

module.exports = {
  processInBatches,
};
