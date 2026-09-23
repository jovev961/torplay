let queue = Promise.resolve();

export function serializeSettingsWrite(work) {
  const operation = queue.then(work);
  queue = operation.catch(() => {});
  return operation;
}
