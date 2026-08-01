import { cn } from "@/lib/utils";
import { HTMLAttributes } from "react";

const variants: Record<string, string> = {
  default: "bg-surface-3 text-secondary border-transparent",
  cyan: "bg-cyan/12 text-cyan border-cyan/25",
  mint: "bg-mint/12 text-mint border-mint/25",
  amber: "bg-amber/12 text-amber border-amber/25",
  coral: "bg-coral/12 text-coral border-coral/25",
  violet: "bg-violet/12 text-violet border-violet/25",
};

export function Badge({
  className,
  variant = "default",
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: keyof typeof variants }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
        variants[variant] || variants.default,
        className,
      )}
      {...props}
    />
  );
}
