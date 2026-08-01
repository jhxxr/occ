import { cn } from "@/lib/utils";

/** 收敛原先 4 处逐字重复的环形 spinner */
export function Spinner({
  className,
  size = "md",
  label = "加载中",
}: {
  className?: string;
  size?: "sm" | "md" | "lg";
  label?: string;
}) {
  const dim =
    size === "sm" ? "h-4 w-4" : size === "lg" ? "h-12 w-12" : "h-10 w-10";

  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        "inline-block animate-spin rounded-full border-2 border-border border-t-accent",
        dim,
        className,
      )}
    />
  );
}

/** 居中的整页/整卡加载态 */
export function LoadingBlock({
  className,
  hint,
}: {
  className?: string;
  hint?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 py-16",
        className,
      )}
    >
      <Spinner />
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}
