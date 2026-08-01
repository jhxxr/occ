import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { ButtonHTMLAttributes, forwardRef } from "react";

/*
 * iOS 26 的按钮是胶囊形，按下有轻微回弹缩放。active:scale 配合 --ease-spring
 * 提供触感反馈；reduced-motion 下 globals.css 会把过渡时长压到 0。
 */
export const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full text-sm font-semibold transition-all duration-200 ease-[var(--ease-spring)] active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        default:
          "bg-accent text-on-accent shadow-sm hover:bg-accent-strong hover:shadow-md",
        secondary:
          "glass text-text hover:bg-surface-2 hover:shadow-md",
        ghost: "text-secondary hover:bg-surface-2 hover:text-text",
        danger:
          "border border-coral/35 bg-coral/10 text-coral hover:bg-coral/20",
        outline:
          "border border-border bg-transparent text-secondary hover:border-glass-border hover:bg-surface-2 hover:text-text",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 px-3.5 text-xs",
        lg: "h-11 px-5",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";
