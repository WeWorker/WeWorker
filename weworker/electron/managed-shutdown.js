/** Browser ownership ends only after both task-producing services have stopped. */
export async function stopManagedServices({ stopExploration, stopBackend, stopBrowser }) {
  await Promise.allSettled([stopExploration(), stopBackend()]);
  await stopBrowser();
}
