"use client";

import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** 激活时的强调色，默认 accent。用于「跑路核销」这类破坏性选项。 */
  tone?: "accent" | "coral";
}

/**
 * iOS 风格分段控件。收敛原先 2 处手搓实现（激活态写法还不一致）。
 *
 * 激活项用实心药丸 + 阴影浮起，这是 iOS segmented control 的标志；
 * 轨道本身半透明，跟随玻璃语言。
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
  size = "default",
  ariaLabel,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  size?: "sm" | "default";
  ariaLabel?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface-2 p-1",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        const tone = option.tone ?? "accent";
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-full font-semibold transition-all duration-200 ease-[var(--ease-spring)] active:scale-[0.97]",
              size === "sm" ? "h-7 px-3 text-xs" : "h-8 px-4 text-xs",
              active
                ? tone === "coral"
                  ? "bg-coral text-on-accent shadow-sm"
                  : "bg-accent text-on-accent shadow-sm"
                : "text-secondary hover:text-text",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
