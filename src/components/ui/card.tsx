import { cn } from "@/lib/utils";
import { HTMLAttributes } from "react";

/**
 * 玻璃卡片。`solid` 用于需要压住背景色晕的场合（如浮层内的嵌套卡片），
 * 避免玻璃叠玻璃导致对比度连续衰减。
 */
export function Card({
  className,
  solid = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & { solid?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-[var(--r-lg)]",
        solid
          ? "border border-border-subtle bg-surface-solid shadow-sm"
          : "glass",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("flex flex-col gap-1 p-5 pb-3", className)} {...props} />
  );
}

export function CardTitle({
  className,
  ...props
}: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn(
        "text-sm font-semibold tracking-[-0.01em] text-text",
        className,
      )}
      {...props}
    />
  );
}

export function CardContent({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5 pt-0", className)} {...props} />;
}
