import { cn } from "@/lib/utils";
import { HTMLAttributes } from "react";

const variants: Record<string, string> = {
  default: "bg-surface-3 text-secondary border-border",
  cyan: "bg-cyan/10 text-cyan border-cyan/25",
  mint: "bg-mint/10 text-mint border-mint/25",
  amber: "bg-amber/10 text-amber border-amber/25",
  coral: "bg-coral/10 text-coral border-coral/25",
  violet: "bg-violet/10 text-violet border-violet/25",
};

export function Badge({
  className,
  variant = "default",
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: keyof typeof variants }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium tracking-wide uppercase",
        variants[variant] || variants.default,
        className,
      )}
      {...props}
    />
  );
}
