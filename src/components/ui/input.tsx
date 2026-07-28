import { cn } from "@/lib/utils";
import { InputHTMLAttributes, forwardRef } from "react";

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "flex h-9 w-full rounded-lg border border-border bg-surface-2 px-3 py-1 text-sm text-text placeholder:text-muted",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/40 focus-visible:border-cyan/50",
      "disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";

export const Label = ({
  className,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>) => (
  <label
    className={cn("text-xs font-medium text-secondary tracking-wide", className)}
    {...props}
  />
);

export const Select = forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      "flex h-9 w-full rounded-lg border border-border bg-surface-2 px-3 py-1 text-sm text-text",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/40",
      className,
    )}
    {...props}
  >
    {children}
  </select>
));
Select.displayName = "Select";

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "flex min-h-[80px] w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text placeholder:text-muted",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/40",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";
