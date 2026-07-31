export async function register() {
  if (
    process.env.NEXT_RUNTIME !== "nodejs" ||
    process.env.USAGE_RETENTION_ENABLED === "false"
  ) {
    return;
  }

  const { startUsageRetentionScheduler } = await import(
    "@/lib/usage-retention"
  );
  startUsageRetentionScheduler();
}
