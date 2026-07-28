"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  LayoutDashboard,
  Server,
  Settings,
  Satellite,
  ArrowDownToLine,
  Database,
  Menu,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const nav = [
  { href: "/", label: "总览", icon: LayoutDashboard },
  { href: "/providers", label: "上游站点", icon: Server },
  { href: "/downstream", label: "下游站点", icon: ArrowDownToLine },
  { href: "/self-hosted", label: "自建上游", icon: Database },
  { href: "/settings", label: "设置", icon: Settings },
];

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-1 flex-col gap-1 p-3">
      {nav.map((item) => {
        const active =
          item.href === "/"
            ? pathname === "/"
            : pathname.startsWith(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
              active
                ? "bg-cyan/10 text-cyan border border-cyan/20"
                : "text-secondary hover:bg-surface-2 hover:text-text border border-transparent",
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function Sidebar() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Mobile top bar */}
      <div className="fixed inset-x-0 top-0 z-50 flex h-14 items-center gap-3 border-b border-border-subtle bg-void/95 px-4 backdrop-blur md:hidden">
        <Button
          size="icon"
          variant="ghost"
          onClick={() => setOpen(true)}
          aria-label="打开菜单"
        >
          <Menu className="h-5 w-5" />
        </Button>
        <div className="flex items-center gap-2">
          <Satellite className="h-4 w-4 text-cyan" />
          <span className="text-sm font-semibold">Orbit Control</span>
        </div>
      </div>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            className="absolute inset-0 bg-black/60"
            aria-label="关闭菜单"
            onClick={() => setOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-border-subtle bg-void">
            <div className="flex items-center justify-between border-b border-border-subtle px-4 py-4">
              <div className="flex items-center gap-2">
                <Satellite className="h-4 w-4 text-cyan" />
                <span className="text-sm font-semibold">Orbit Control</span>
              </div>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setOpen(false)}
                aria-label="关闭"
              >
                <X className="h-5 w-5" />
              </Button>
            </div>
            <NavLinks onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-56 flex-col border-r border-border-subtle bg-void/90 backdrop-blur-md md:flex">
        <div className="flex items-center gap-3 border-b border-border-subtle px-5 py-5">
          <div className="relative flex h-9 w-9 items-center justify-center">
            <span className="absolute inset-0 rounded-full border border-cyan/30" />
            <span className="absolute inset-1 rounded-full border border-cyan/20 border-dashed animate-[spin_12s_linear_infinite]" />
            <Satellite className="h-4 w-4 text-cyan" />
          </div>
          <div>
            <div className="text-sm font-semibold tracking-tight text-text">
              Orbit Control
            </div>
            <div className="text-[10px] uppercase tracking-[0.16em] text-muted">
              Cost · Profit · Risk
            </div>
          </div>
        </div>

        <NavLinks />

        <div className="border-t border-border-subtle p-4">
          <p className="text-[11px] leading-relaxed text-muted">
            上游余额 · 下游收益 · 真实毛利
            <br />
            本地 SQLite · 密钥加密存储
          </p>
        </div>
      </aside>
    </>
  );
}
