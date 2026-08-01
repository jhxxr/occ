"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

export type ThemeChoice = "light" | "dark" | "auto";

const STORAGE_KEY = "orbit-theme";

/*
 * 主题偏好存在 localStorage —— 一个 React 之外的系统，所以用
 * useSyncExternalStore 读取，而不是 effect + setState（后者会触发级联渲染）。
 * 服务端快照固定为 auto，客户端 hydration 后 React 自动切到真实值。
 */
const listeners = new Set<() => void>();

function readChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "auto") {
      return stored;
    }
  } catch {
    // localStorage 被禁用（隐私模式 / 三方 cookie 拦截）：跟随系统
  }
  return "auto";
}

function getServerChoice(): ThemeChoice {
  return "auto";
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // 另一个标签页改了偏好，这边也要跟上
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/**
 * 把选择落到 <html> 上。
 *
 * auto 不写死明暗，而是读系统偏好 —— 这样 macOS 日落自动切换时无需刷新即可跟随。
 */
function applyTheme(choice: ThemeChoice) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle(
    "dark",
    choice === "dark" || (choice === "auto" && prefersDark),
  );
}

function selectTheme(next: ThemeChoice) {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // 存不下就只作用于本次会话
  }
  for (const listener of listeners) listener();
}

const OPTIONS: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "auto", label: "自动", icon: Monitor },
];

export function ThemeToggle() {
  const choice = useSyncExternalStore(subscribe, readChoice, getServerChoice);

  /*
   * DOM class 的唯一写入点：首次挂载（与内联脚本结果一致，幂等）、用户切换、
   * 跨标签页同步，以及 auto 模式下的系统主题变化。
   */
  useEffect(() => {
    applyTheme(choice);

    if (choice !== "auto") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("auto");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [choice]);

  return (
    <div
      role="radiogroup"
      aria-label="主题外观"
      className="flex items-center gap-0.5 rounded-full border border-border-subtle bg-surface-2 p-0.5"
    >
      {OPTIONS.map((option) => {
        const Icon = option.icon;
        const active = choice === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={option.label}
            title={option.label}
            onClick={() => selectTheme(option.value)}
            className={cn(
              "flex h-7 flex-1 cursor-pointer items-center justify-center rounded-full transition-all duration-200",
              active
                ? "bg-surface-solid text-text shadow-sm"
                : "text-sidebar-muted hover:text-text",
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
