export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  if (process.env.USAGE_RETENTION_ENABLED !== "false") {
    const { startUsageRetentionScheduler } = await import(
      "@/lib/usage-retention"
    );
    startUsageRetentionScheduler();
  }

  // 自动同步默认关（配置在数据库里），这里只是把定时检查挂上；
  // AUTO_SYNC_ENABLED=false 时 startAutoSyncScheduler 自己会直接返回。
  const { startAutoSyncScheduler } = await import("@/lib/auto-sync");
  startAutoSyncScheduler();
}
