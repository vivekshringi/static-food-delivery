/**
 * Serialises read-modify-write cycles on a single file.
 *
 * Two writers in this app touch orders.json: `finalizeOrder` appends an order and the hourly
 * `backupOrders` cron reads then truncates it. Without a shared lock a payment captured while the
 * cron runs can be truncated away. Both writers live in the same process, so an in-process queue is
 * enough; this is not cross-process locking.
 */
const queues = new Map();

/**
 * Runs `task` after every previously queued task for `key` has settled.
 *
 * @param {string} key - Identifies the guarded file.
 * @param {() => Promise<T>} task - The read-modify-write cycle to run exclusively.
 * @returns {Promise<T>} The task's result.
 * @template T
 */
export function withFileLock(key, task) {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  queues.set(
    key,
    run.then(
      () => {},
      () => {}
    )
  );
  return run;
}
