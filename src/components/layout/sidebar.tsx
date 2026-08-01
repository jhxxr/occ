"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Database,
  LayoutDashboard,
  LineChart,
  LoaderCircle,
  LogOut,
  Menu,
  Satellite,
  Server,
  Settings,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { cn } from "@/lib/utils";

const MOBILE_DRAWER_ID = "orbit-mobile-navigation";

const navGroups = [
  {
    label: "监控",
    items: [
      { href: "/", label: "总览", icon: LayoutDashboard },
      { href: "/reports", label: "收益报表", icon: LineChart },
    ],
  },
  {
    label: "资源",
    items: [
      { href: "/providers", label: "上游", icon: Server },
      { href: "/downstream", label: "下游", icon: ArrowDownToLine },
      { href: "/self-hosted", label: "自建", icon: Database },
    ],
  },
  {
    label: "系统",
    items: [{ href: "/settings", label: "设置", icon: Settings }],
  },
] as const;

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-[var(--r-md)] bg-accent text-on-accent shadow-sm",
          compact ? "h-8 w-8" : "h-9 w-9",
        )}
      >
        <Satellite className="h-4 w-4" aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold tracking-[-0.01em] text-sidebar-text">
          Orbit Control
        </div>
        {!compact && (
          <div className="mt-0.5 truncate text-xs text-sidebar-muted">
            运营控制台
          </div>
        )}
      </div>
    </div>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="主导航"
      className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-5"
    >
      {navGroups.map((group) => (
        <div key={group.label} role="group" aria-label={group.label}>
          <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-sidebar-muted">
            {group.label}
          </p>
          <ul className="space-y-1">
            {group.items.map((item) => {
              const active =
                item.href === "/"
                  ? pathname === "/"
                  : pathname === item.href ||
                    pathname.startsWith(`${item.href}/`);
              const Icon = item.icon;

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative flex h-10 items-center gap-3 rounded-[var(--r-md)] px-3 text-sm font-medium transition-all duration-200",
                      active
                        ? "bg-accent/12 font-semibold text-accent"
                        : "text-secondary hover:bg-surface-2 hover:text-text",
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="truncate">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

interface SidebarFooterProps {
  loggingOut: boolean;
  logoutError: string | null;
  onLogout: () => void;
}

function SidebarFooter({
  loggingOut,
  logoutError,
  onLogout,
}: SidebarFooterProps) {
  return (
    <div className="space-y-2 border-t border-border-subtle p-3">
      <ThemeToggle />
      {logoutError && (
        <p
          role="alert"
          className="break-words px-3 text-xs leading-5 text-coral"
        >
          {logoutError}
        </p>
      )}
      <Button
        type="button"
        variant="ghost"
        onClick={onLogout}
        disabled={loggingOut}
        className="w-full justify-start"
      >
        {loggingOut ? (
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <LogOut className="h-4 w-4" aria-hidden="true" />
        )}
        {loggingOut ? "正在退出…" : "退出登录"}
      </Button>
    </div>
  );
}

export function Sidebar() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;

    const menuButton = menuButtonRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled])',
      );
      if (!focusable?.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      menuButton?.focus();
    };
  }, [open]);

  async function handleLogout() {
    setLoggingOut(true);
    setLogoutError(null);

    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("退出失败，请稍后重试");

      setOpen(false);
      router.replace("/login");
      router.refresh();
    } catch (error) {
      setLogoutError(
        error instanceof Error ? error.message : "退出失败，请稍后重试",
      );
      setLoggingOut(false);
    }
  }

  return (
    <>
      <div className="glass fixed inset-x-0 top-0 z-40 flex h-16 items-center gap-3 rounded-none border-x-0 border-t-0 px-3 text-sidebar-text md:hidden">
        <Button
          ref={menuButtonRef}
          type="button"
          size="icon"
          variant="ghost"
          onClick={() => setOpen(true)}
          aria-label="打开主导航"
          aria-expanded={open}
          aria-controls={MOBILE_DRAWER_ID}
          className="shrink-0"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </Button>
        <Brand compact />
      </div>

      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-scrim backdrop-blur-sm"
            aria-hidden="true"
            onClick={() => setOpen(false)}
          />
          <aside
            ref={drawerRef}
            id={MOBILE_DRAWER_ID}
            role="dialog"
            aria-modal="true"
            aria-label="主导航菜单"
            className="glass-strong absolute inset-y-0 left-0 flex w-72 max-w-[calc(100vw-3rem)] flex-col rounded-none border-y-0 border-l-0"
          >
            <div className="flex h-16 shrink-0 items-center justify-between border-b border-border-subtle px-4">
              <Brand />
              <Button
                ref={closeButtonRef}
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => setOpen(false)}
                aria-label="关闭主导航"
                className="shrink-0"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </Button>
            </div>
            <NavLinks onNavigate={() => setOpen(false)} />
            <SidebarFooter
              loggingOut={loggingOut}
              logoutError={logoutError}
              onLogout={handleLogout}
            />
          </aside>
        </div>
      )}

      <aside className="glass fixed inset-y-0 left-0 z-40 hidden w-64 flex-col rounded-none border-y-0 border-l-0 md:flex">
        <div className="flex h-16 shrink-0 items-center border-b border-border-subtle px-4">
          <Brand />
        </div>
        <NavLinks />
        <SidebarFooter
          loggingOut={loggingOut}
          logoutError={logoutError}
          onLogout={handleLogout}
        />
      </aside>
    </>
  );
}
