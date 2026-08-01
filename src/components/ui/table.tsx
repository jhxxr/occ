import { cn } from "@/lib/utils";
import { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";

/*
 * 表格基础件。刻意做成基础件而非 columns 配置式 DataTable —— 14 处调用点的
 * 单元格渲染逻辑各不相同（合计行、内联按钮、条件着色），配置式会迫使每处重写。
 * 这里只收敛重复的默认样式，调用点保持原有 JSX 结构。
 */

/** 横向滚动容器。表格在窄屏必须能横滚，否则数字列会被压毁。 */
export function TableWrap({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("w-full overflow-x-auto", className)} {...props} />;
}

export function Table({
  className,
  ...props
}: HTMLAttributes<HTMLTableElement>) {
  return <table className={cn("w-full text-sm", className)} {...props} />;
}

export function THead({
  className,
  ...props
}: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={className} {...props} />;
}

export function TBody({
  className,
  ...props
}: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={className} {...props} />;
}

/** 表头行：统一小字号 + 字距 + 分隔线 */
export function HeadRow({
  className,
  ...props
}: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        "border-b border-border-subtle text-left text-[11px] uppercase tracking-wider text-muted",
        className,
      )}
      {...props}
    />
  );
}

export function TH({
  className,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cn("px-4 py-2.5 font-semibold", className)} {...props} />;
}

/**
 * 数据行。`tone` 用于状态底色 —— 走 --tint-* 令牌而非低 alpha 语义色，
 * 因为 3-4% 的着色叠在玻璃表面上会完全看不见。
 */
export function TR({
  className,
  tone,
  ...props
}: HTMLAttributes<HTMLTableRowElement> & { tone?: "warn" | "info" }) {
  return (
    <tr
      className={cn(
        "border-b border-border-subtle/60 transition-colors last:border-0 hover:bg-surface-2",
        tone === "warn" && "bg-tint-warn",
        tone === "info" && "bg-tint-info",
        className,
      )}
      {...props}
    />
  );
}

export function TD({
  className,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-4 py-2.5", className)} {...props} />;
}
