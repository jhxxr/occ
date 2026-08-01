import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { HTMLAttributes, ReactNode } from "react";

type Tone = "error" | "warn" | "success" | "info" | "neutral";

const toneStyles: Record<Tone, string> = {
  error: "border-coral/30 bg-coral/10 text-coral",
  warn: "border-warn/30 bg-warn/10 text-warn",
  success: "border-mint/30 bg-mint/10 text-mint",
  info: "border-cyan/30 bg-cyan/10 text-cyan",
  neutral: "border-border-subtle bg-surface-2 text-secondary",
};

const toneIcons: Record<Tone, LucideIcon> = {
  error: XCircle,
  warn: AlertTriangle,
  success: CheckCircle2,
  info: Info,
  neutral: Info,
};

/**
 * 语义状态面板。收敛原先散落 8 处的 `border-X/30 bg-X/5 p-N` 手写组合。
 *
 * 标题用语义色，正文用 --secondary —— 大段说明文字保持中性色才好读，
 * 整块染色会在玻璃背景上糊成一片。
 */
export function Callout({
  tone = "neutral",
  title,
  icon = true,
  children,
  className,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  tone?: Tone;
  title?: ReactNode;
  icon?: boolean;
}) {
  const Icon = toneIcons[tone];

  return (
    <div
      className={cn(
        "rounded-[var(--r-lg)] border px-4 py-3",
        toneStyles[tone],
        className,
      )}
      {...props}
    >
      <div className="flex items-start gap-2.5">
        {icon && <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
        <div className="min-w-0 flex-1">
          {title && <p className="text-sm font-semibold">{title}</p>}
          {children && (
            <div
              className={cn(
                "text-xs leading-5 text-secondary",
                title && "mt-1",
              )}
            >
              {children}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
