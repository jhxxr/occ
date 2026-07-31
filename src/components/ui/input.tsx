import { cn } from "@/lib/utils";
import { InputHTMLAttributes, forwardRef } from "react";

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "flex h-10 w-full rounded-md border border-border bg-surface px-3 py-1 text-sm text-text shadow-[0_1px_1px_rgba(17,24,28,0.03)] placeholder:text-muted",
      "focus-visible:border-cyan focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-cyan/10",
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
    className={cn("text-xs font-semibold text-secondary", className)}
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
      "flex h-10 w-full rounded-md border border-border bg-surface px-3 py-1 text-sm text-text shadow-[0_1px_1px_rgba(17,24,28,0.03)]",
      "focus-visible:border-cyan focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-cyan/10",
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
      "flex min-h-[88px] w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text shadow-[0_1px_1px_rgba(17,24,28,0.03)] placeholder:text-muted",
      "focus-visible:border-cyan focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-cyan/10",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";
