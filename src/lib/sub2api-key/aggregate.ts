export function selectSharedAccountBalance(
  keys: Array<{
    lastBalance: number | null;
    lastSuccessAt: Date | null;
  }>,
): number | null {
  return keys
    .filter((key) => key.lastBalance != null && key.lastSuccessAt != null)
    .sort((a, b) => b.lastSuccessAt!.getTime() - a.lastSuccessAt!.getTime())[0]
    ?.lastBalance ?? null;
}
