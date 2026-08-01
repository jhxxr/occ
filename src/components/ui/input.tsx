import { cn } from "@/lib/utils";
import { InputHTMLAttributes, forwardRef } from "react";

/*
 * 表单控件用 --surface-2（比卡片更凹陷），聚焦时描边转 accent 并加光环。
 * 圆角走 --r-md，比按钮的胶囊小一档 —— 输入框内是左对齐长文本，胶囊会浪费首字空间。
 */
const fieldBase =
  "w-full rounded-[var(--r-md)] border border-border bg-surface-2 px-3.5 text-sm text-text transition-all duration-200 " +
  "focus-visible:border-accent focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)]/25 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(fieldBase, "h-10 py-1 placeholder:text-muted", className)}
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
    className={cn(fieldBase, "h-10 py-1", className)}
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
      fieldBase,
      "min-h-[88px] py-2.5 placeholder:text-muted",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

/** 复选框：统一尺寸与配色，替代散落各处的裸 input[type=checkbox] */
export const Checkbox = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, "type">
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    type="checkbox"
    className={cn(
      "h-4 w-4 shrink-0 cursor-pointer rounded-[5px] border-border accent-[var(--accent)]",
      className,
    )}
    {...props}
  />
));
Checkbox.displayName = "Checkbox";
